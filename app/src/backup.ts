// Vault backup: the portal schedules it itself (no Windows task) and reads git counts.
// Only counts and times reach the browser: no file names, commit messages or remote URLs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, loadConfig } from "./state.ts";
import { loadAppConfig, readSettings } from "./config.ts";
import { readJson, atomicJson } from "../docker/scheduler.mjs";

export const BACKUP_FILE = join(STATE_DIR, "backup.json");
export const BACKUP_INTERVALS = [15, 30, 60, 180, 360, 1440];
export type BackupAction = "run" | "pause" | "resume" | { intervalMinutes: number };

export interface BackupConfig {
  enabled: boolean; intervalMinutes: number;
  nextRun: string | null; lastRun: string | null; lastFinishedAt: string | null; lastResult: number | null;
}
export interface BackupStatus {
  state: string; enabled: boolean; intervalMinutes: number | null;
  lastRun: string | null; nextRun: string | null; lastResult: number | null;
  push: boolean; remotes: number; uncommitted: number | null; unpushed: number | null; lastCommitAt: string | null;
}
const DEFAULTS: BackupConfig = { enabled: true, intervalMinutes: 60, nextRun: null, lastRun: null, lastFinishedAt: null, lastResult: null };
export const loadBackup = (file = BACKUP_FILE): BackupConfig => ({ ...DEFAULTS, ...readJson(file, {}) });

export async function powershell(command: string, failure = "Windows could not reach the scheduled task."): Promise<string> {
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${command}`], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [output, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(failure);
    return output.trim();
  } finally { clearTimeout(timer); }
}

export type Exec = (cmd: string[], cwd: string, env?: Record<string, string | undefined>) => Promise<number>;

/** Runs a command and returns its exit code. Output is drained, never stored: git can print paths. */
const exec: Exec = async (cmd, cwd, env) => {
  let child;
  try { child = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe", windowsHide: true }); } catch { return 127; } // not installed
  const timer = setTimeout(() => child.kill(), 15 * 60_000);
  try { const [, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return code; }
  finally { clearTimeout(timer); }
};

const stamp = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export interface VaultBackupOptions {
  vault: string;
  /** Push to every git remote of the vault (BACKUP_PUSH). Local-only repos are never pushed. */
  push: boolean;
  /** Nested repos (relative to the vault) committed locally only and never added to the vault repo. */
  localOnlyRepos: string[];
  /** The settings file's values: RESTIC_REPOSITORY (and restic's own variables) turn on the optional restic copy. */
  settings?: Record<string, string>;
  now?: Date;
}

/** One backup: commit the vault (all changes the vault's .gitignore allows, never a .env file or a local-only repo)
 *  and push it to every remote; commit each local-only repo without pushing; optional restic copy of everything.
 *  Returns 0 when every step worked, else 1 (the remaining steps still run). */
export async function runVaultBackup(opts: VaultBackupOptions, run: Exec = exec, remotesOf = (cwd: string) => gitOut(["remote"], cwd)): Promise<number> {
  const message = `backup: ${stamp(opts.now ?? new Date())}`;
  let failed = false;
  const step = async (cmd: string[], cwd: string, env?: Record<string, string | undefined>) => { const code = await run(cmd, cwd, env); if (code !== 0) failed = true; return code; };
  async function save(path: string, push: boolean, exclude: string[]) {
    // Exclude a local-only repo only when .gitignore does not already ignore it: naming an ignored path in
    // `git add` makes git exit 1 ("paths are ignored") although it staged everything, which stopped the backup
    // before the commit (found 2026-10-18 with life/ in .gitignore).
    const notIgnored: string[] = [];
    for (const r of exclude) if (await run(["git", "check-ignore", "-q", r], path) !== 0) notIgnored.push(r);
    if (await step(["git", "add", "-A", "--", ".", ":(exclude,glob)**/.env", ...notIgnored.map(r => `:(exclude)${r}`)], path) !== 0) return;
    // diff --cached exits 1 when something is staged
    if (await run(["git", "diff", "--cached", "--quiet"], path) === 1) await step(["git", "commit", "-q", "-m", message], path);
    if (!push) return;
    const remotes = await remotesOf(path);
    if (remotes === null) failed = true;
    for (const remote of (remotes ?? "").split(/\s+/).filter(Boolean)) await step(["git", "push", "-q", remote, "HEAD"], path);
  }
  const nested = opts.localOnlyRepos.filter(r => existsSync(join(opts.vault, r, ".git")));
  await save(opts.vault, opts.push, opts.localOnlyRepos);
  for (const repo of nested) await save(join(opts.vault, repo), false, []);
  const settings = opts.settings ?? {};
  if (settings.RESTIC_REPOSITORY || process.env.RESTIC_REPOSITORY) {
    const code = await run(["restic", "backup", opts.vault, "--exclude", join(opts.vault, ".gbrain"), "--tag", "brain"], opts.vault, { ...process.env, ...settings });
    if (code !== 0 && code !== 127) failed = true; // 127: restic not installed, which the old script skipped silently
  }
  return failed ? 1 : 0;
}

async function gitOut(args: string[], cwd: string): Promise<string | null> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return code === 0 ? out.trim() : null;
}

/** The scheduled backup with this install's settings. */
async function runConfiguredBackup(): Promise<number> {
  const app = loadAppConfig(), cfg = loadConfig();
  return runVaultBackup({ vault: app.vault.path, push: cfg.backupPush ?? true, localOnlyRepos: app.backup.localOnlyRepos, settings: readSettings(app.settingsFile) });
}

/** In-process scheduler. Missed runs (laptop asleep, portal restarted) run once on the next tick. */
export function createBackupScheduler(opts: { file?: string; execute?: () => Promise<number>; now?: () => number } = {}) {
  const file = opts.file ?? BACKUP_FILE, execute = opts.execute ?? runConfiguredBackup, now = opts.now ?? Date.now;
  let running = false;
  const save = (patch: Partial<BackupConfig>) => { const next = { ...loadBackup(file), ...patch }; atomicJson(file, next); return next; };
  const after = (minutes: number, from = now()) => new Date(from + minutes * 60_000).toISOString();

  async function run(): Promise<boolean> {
    if (running) return false;
    running = true;
    save({ lastRun: new Date(now()).toISOString(), lastResult: null });
    let result = 1;
    try { result = await execute(); } catch { result = 1; }
    finally { running = false; save({ lastFinishedAt: new Date(now()).toISOString(), lastResult: result, nextRun: after(loadBackup(file).intervalMinutes) }); }
    return true;
  }
  async function tick() {
    const c = loadBackup(file);
    if (!c.nextRun) { save({ nextRun: after(c.intervalMinutes) }); return; }
    if (c.enabled && now() >= Date.parse(c.nextRun)) await run();
  }
  function configure(action: Exclude<BackupAction, "run">) {
    if (typeof action === "object") {
      if (!BACKUP_INTERVALS.includes(action.intervalMinutes)) throw new Error("Unsupported backup interval");
      const c = loadBackup(file);
      save({ intervalMinutes: action.intervalMinutes, nextRun: after(action.intervalMinutes, c.lastFinishedAt ? Date.parse(c.lastFinishedAt) : now()) });
    } else save({ enabled: action === "resume" });
  }
  return {
    tick, running: () => running, config: () => loadBackup(file),
    action: async (action: BackupAction) => { if (action === "run") void run(); else configure(action); },
    start: () => { void tick(); const timer = setInterval(() => void tick().catch(() => console.error("Backup scheduler could not update backup.json.")), 30_000); return () => clearInterval(timer); },
  };
}

function git(args: string[], cwd: string): string | null {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}

export function repoStatus(brainPath: string) {
  const changes = git(["status", "--porcelain"], brainPath), ahead = git(["rev-list", "--count", "@{u}..HEAD"], brainPath);
  return {
    remotes: (git(["remote"], brainPath) ?? "").split(/\s+/).filter(Boolean).length,
    uncommitted: changes == null ? null : changes ? changes.split("\n").length : 0,
    unpushed: ahead == null ? null : Number(ahead),
    lastCommitAt: git(["log", "-1", "--format=%cI"], brainPath) || null,
  };
}

export function backupStatus(c: BackupConfig, running: boolean, brainPath: string, push: boolean, repo: ReturnType<typeof repoStatus> = repoStatus(brainPath)): BackupStatus {
  return { state: running ? "Running" : c.enabled ? "Ready" : "Disabled", enabled: c.enabled, intervalMinutes: c.intervalMinutes,
    lastRun: c.lastRun, nextRun: c.enabled ? c.nextRun : null, lastResult: c.lastResult, push, ...repo };
}

/** git without blocking the portal: `git status` on a large vault takes seconds, and a synchronous spawn would
 *  stall every other request (the Notes page waited behind it, measured 6.8 s on 2026-10-18). */
async function gitAsync(args: string[], cwd: string): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out.trim() : null;
  } catch { return null; }
}

export async function repoStatusAsync(brainPath: string): Promise<ReturnType<typeof repoStatus>> {
  const [changes, ahead, remotes, last] = await Promise.all([gitAsync(["status", "--porcelain"], brainPath), gitAsync(["rev-list", "--count", "@{u}..HEAD"], brainPath),
    gitAsync(["remote"], brainPath), gitAsync(["log", "-1", "--format=%cI"], brainPath)]);
  return { remotes: (remotes ?? "").split(/\s+/).filter(Boolean).length, uncommitted: changes == null ? null : changes ? changes.split("\n").length : 0,
    unpushed: ahead == null ? null : Number(ahead), lastCommitAt: last || null };
}

/** Stale-while-revalidate repo numbers: answer at once with the last result, refresh in the background at most
 *  every `maxAgeMs`. The first call starts the refresh and returns nulls ("unknown") instead of waiting. */
export function createRepoStatusCache(brainPath: () => string, maxAgeMs = 60_000, load = repoStatusAsync, now = Date.now) {
  let value: ReturnType<typeof repoStatus> = { remotes: 0, uncommitted: null, unpushed: null, lastCommitAt: null };
  let at = -Infinity, seen: string | undefined, flight: Promise<void> | null = null;
  const refresh = () => flight ??= load(brainPath()).then(v => { value = v; at = now(); }).catch(() => { at = now(); }).finally(() => { flight = null; });
  return {
    /** `key` names the last vault event (a sync or backup run): git runs again when it changes, else only after
     *  `maxAgeMs` (which covers edits made in Obsidian). */
    get: (key?: string) => {
      if (key !== undefined && key !== seen) { seen = key; at = -Infinity; }
      if (now() - at > maxAgeMs) void refresh();
      return value;
    },
    /** After a backup run: show fresh numbers soon. */
    invalidate: () => { at = -Infinity; },
    ready: () => flight ?? Promise.resolve(),
  };
}
