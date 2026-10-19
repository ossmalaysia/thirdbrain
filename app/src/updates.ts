// Updates: is a newer Third Brain release on GitHub, and (on a clean git checkout) update the install from the portal.
// The GitHub answer is untrusted data: only plain fields are kept, links must point at GitHub, and nothing that
// is downloaded is ever run. The self-update only runs git and bun in this repository's folder.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { STATE_DIR } from "./state.ts";
import { atomicJson, readJson } from "../docker/scheduler.mjs";
import { DEFAULT_UPDATE_REPO } from "./config.ts";

export const UPDATES_FILE = join(STATE_DIR, "updates.json");
export const APP_DIR = resolve(import.meta.dir, "..");
export const REPO_DIR = resolve(APP_DIR, "..");
export const CHECK_EVERY_MS = 6 * 3600_000;
export const RETRY_AFTER_ERROR_MS = 3600_000;
export const IDLE_WAIT_MS = 30 * 60_000;
export const NOTES_MAX = 4000;

// ── Commands ────────────────────────────────────────────────────────────────────────────────────
export interface ExecResult { code: number; out: string; err: string }
/** Runs one program with an argument array (never a shell string). code -1: the program could not start. */
export type Exec = (argv: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<ExecResult>;
export const defaultExec: Exec = async (argv, { cwd, timeoutMs = 120_000 }) => {
  let child;
  try { child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); }
  catch (e) { return { code: -1, out: "", err: e instanceof Error ? e.message : String(e) }; }
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out, err };
  } finally { clearTimeout(timer); }
};
const firstLine = (r: ExecResult) => (r.err || r.out).trim().split(/\r?\n/)[0]?.slice(0, 300) ?? "";

// ── Versions ────────────────────────────────────────────────────────────────────────────────────
type Semver = { core: number[]; pre: string[] };
export function parseSemver(v: unknown): Semver | null {
  const m = typeof v === "string" ? v.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/) : null;
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] } : null;
}
/** -1, 0 or 1 like a sort comparator (semver 2.0 precedence: a pre-release is older than its release). Invalid versions throw. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
export const isNewer = (latest: string | undefined | null, current: string) => {
  try { return !!latest && compareSemver(latest, current) > 0; } catch { return false; }
};

export function packageVersion(appDir = APP_DIR): string {
  try { const v = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version; return parseSemver(v) ? v : "0.0.0"; }
  catch { return "0.0.0"; }
}
/** app/package.json's version, plus the short commit when the install is a git checkout. */
export async function currentVersion(opts: { exec?: Exec; appDir?: string; repoDir?: string } = {}): Promise<{ version: string; commit: string | null }> {
  const exec = opts.exec ?? defaultExec, repoDir = opts.repoDir ?? REPO_DIR;
  const r = existsSync(join(repoDir, ".git")) ? await exec(["git", "rev-parse", "--short", "HEAD"], { cwd: repoDir, timeoutMs: 15_000 }) : null;
  const commit = r?.code === 0 && /^[0-9a-f]{4,40}$/.test(r.out.trim()) ? r.out.trim() : null;
  return { version: packageVersion(opts.appDir ?? APP_DIR), commit };
}

// ── The latest release ──────────────────────────────────────────────────────────────────────────
export interface Release { version: string; tag: string; name: string; publishedAt: string | null; notesUrl: string | null; notes: string; installerUrl: string | null }
const httpsOn = (url: unknown, hosts: string[]) => {
  if (typeof url !== "string") return false;
  try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password && !u.port && hosts.includes(u.hostname.toLowerCase()); } catch { return false; }
};
/** Release pages: https://github.com only. Installer downloads: github.com or GitHub's download host. */
export const safeNotesUrl = (url: unknown) => httpsOn(url, ["github.com"]);
export const safeAssetUrl = (url: unknown) => httpsOn(url, ["github.com", "objects.githubusercontent.com"]);
const plain = (v: unknown, max: number) => typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : "";

/** The fields we keep from a GitHub release (REST JSON; `gh api` returns the same shape). Throws when it is not a release. */
export function parseRelease(json: unknown): Release {
  const r = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const tag = typeof r.tag_name === "string" ? r.tag_name.trim() : "";
  if (!/^[\w.+-]+$/.test(tag) || tag.startsWith("-") || !parseSemver(tag)) throw new Error("GitHub's latest release has no version tag (like v0.2.0).");
  const assets = Array.isArray(r.assets) ? r.assets as Record<string, unknown>[] : [];
  const exe = assets.find(a => typeof a?.name === "string" && /\.exe$/i.test(a.name) && safeAssetUrl(a.browser_download_url));
  const body = plain(r.body, NOTES_MAX + 1);
  return {
    version: tag.replace(/^v/i, ""), tag, name: plain(r.name, 200).trim() || tag,
    publishedAt: typeof r.published_at === "string" && Number.isFinite(Date.parse(r.published_at)) ? new Date(r.published_at).toISOString() : null,
    notesUrl: safeNotesUrl(r.html_url) ? r.html_url as string : null,
    notes: body.length > NOTES_MAX ? `${body.slice(0, NOTES_MAX).trimEnd()}\n…` : body.trim(),
    installerUrl: exe ? exe.browser_download_url as string : null,
  };
}

/** The latest release of `repo`. A private repo answers 404 to anonymous calls, so the GitHub CLI (when installed and
 *  signed in) is asked first; otherwise the public API without a token. */
export async function latestRelease(repo: string, opts: { exec?: Exec; fetch?: typeof fetch } = {}): Promise<Release> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("The update repository must be a GitHub owner/name.");
  const exec = opts.exec ?? defaultExec, get = opts.fetch ?? fetch;
  const gh = await exec(["gh", "api", `repos/${repo}/releases/latest`], { cwd: REPO_DIR, timeoutMs: 30_000 }).catch(() => null);
  if (gh?.code === 0) { try { return parseRelease(JSON.parse(gh.out)); } catch (e) { if (e instanceof SyntaxError) { /* not JSON: try the API */ } else throw e; } }
  // gh is signed in and can see the repo (private ones too), but there is no release: the public API would only say 404 too.
  if (gh && gh.code > 0 && /HTTP 404/.test(gh.err + gh.out)) {
    const repoSeen = await exec(["gh", "api", `repos/${repo}`, "--jq", ".full_name"], { cwd: REPO_DIR, timeoutMs: 30_000 }).catch(() => null);
    if (repoSeen?.code === 0) throw new Error(`No release has been published for ${repo} yet.`);
  }
  let res: Response;
  try {
    res = await get(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "thirdbrain-update-check" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch (e) { throw new Error(`Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)); }
  if (res.status === 404) throw new Error(`No release found for ${repo}. The repository may be private: sign in with the GitHub CLI (gh auth login), or it has no release yet.`);
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}${res.status === 403 ? " (rate limit; the next check retries)" : ""}.`);
  if (Number(res.headers.get("content-length") ?? 0) > 2_000_000) throw new Error("GitHub's answer was too large.");
  return parseRelease(await res.json());
}

// ── May this install update itself? ─────────────────────────────────────────────────────────────
export interface SelfUpdateCheck { ok: boolean; reason: string | null; branch?: string }
/** github.com/<repo> over https or ssh, with or without .git. */
export function originMatches(url: string, repo: string): boolean {
  const m = url.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return !!m && m[1]!.toLowerCase() === repo.toLowerCase();
}
const samePath = (a: string, b: string) => resolve(a).replace(/[\\/]+$/, "").toLowerCase() === resolve(b).replace(/[\\/]+$/, "").toLowerCase();
export async function selfUpdateCheck(opts: { exec?: Exec; repoDir?: string; repo?: string; platform?: string } = {}): Promise<SelfUpdateCheck> {
  const exec = opts.exec ?? defaultExec, cwd = opts.repoDir ?? REPO_DIR, repo = opts.repo ?? DEFAULT_UPDATE_REPO;
  if ((opts.platform ?? process.platform) !== "win32") return { ok: false, reason: "Updating from the portal works on Windows (the BrainPortal task) only: update with git and restart the portal yourself." };
  const top = await exec(["git", "rev-parse", "--show-toplevel"], { cwd, timeoutMs: 15_000 });
  if (top.code === -1) return { ok: false, reason: "Git is not installed: download the new version from the release page." };
  if (top.code !== 0 || !samePath(top.out.trim(), cwd)) return { ok: false, reason: "Not a git checkout: download the new version from the release page." };
  const origin = await exec(["git", "remote", "get-url", "origin"], { cwd, timeoutMs: 15_000 });
  if (origin.code !== 0 || !originMatches(origin.out, repo)) return { ok: false, reason: `The git remote origin is not github.com/${repo}: update this checkout with git yourself.` };
  const branch = (await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 15_000 })).out.trim();
  if (branch !== "main") return { ok: false, reason: `This checkout is on ${branch && branch !== "HEAD" ? `branch ${branch}` : "a detached commit"}: switch to main to update from the portal.`, branch };
  const st = await exec(["git", "status", "--porcelain"], { cwd, timeoutMs: 30_000 });
  if (st.code !== 0) return { ok: false, reason: `git status failed: ${firstLine(st)}` };
  if (st.out.trim()) return { ok: false, reason: "Local changes: commit or stash them first.", branch };
  return { ok: true, reason: null, branch };
}

// ── State, status and the update itself ─────────────────────────────────────────────────────────
export interface LastUpdate { at: string; from: string; to: string | null; commitBefore: string | null; commitAfter: string | null; error: string | null }
export interface UpdatesFile { checkedAt: string | null; errorAt: string | null; error: string | null; repo: string | null; release: Release | null; lastUpdate: LastUpdate | null }
const EMPTY: UpdatesFile = { checkedAt: null, errorAt: null, error: null, repo: null, release: null, lastUpdate: null };
export const loadUpdates = (file = UPDATES_FILE): UpdatesFile => ({ ...EMPTY, ...(readJson(file, {}) ?? {}) });

export interface UpdateStatus {
  current: { version: string; commit: string | null };
  latest: { version: string; name: string; publishedAt: string | null } | null;
  available: boolean; checkedAt: string | null; checking: boolean; error: string | null;
  notesUrl: string | null; notes: string; installerUrl: string | null;
  canSelfUpdate: boolean; reason: string | null;
  applying: { step: string; startedAt: string } | null;
  lastUpdate: LastUpdate | null;
}

export interface UpdateDeps {
  file?: string; repo?: () => string; exec?: Exec; fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>;
  appDir?: string; repoDir?: string; platform?: string;
  /** The portal's Pause/Resume (enabled) and whether a sync run or Dream is busy. */
  runner?: { status(): Promise<{ enabled: boolean; busy: boolean }>; enable(on: boolean): Promise<void> };
  /** Restarts the portal after the answer is sent (default: a detached PowerShell helper, see restartPortal). */
  restart?: () => void;
}

/** A detached helper (its parent exits at once, so it is not in the portal's process tree): wait 5 s, end the
 *  portal's process tree by PID, wait for the BrainPortal task to stop, start it again. Only an integer goes in. */
export function restartScript(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Bad process id");
  return `Start-Sleep -Seconds 5; & taskkill.exe /PID ${pid} /T /F | Out-Null; `
    + `for ($i = 0; $i -lt 30 -and (Get-ScheduledTask -TaskName BrainPortal).State -eq 'Running'; $i++) { Start-Sleep -Seconds 1 }; `
    + `Start-ScheduledTask -TaskName BrainPortal`;
}
export function restartPortal(pid = process.pid) {
  const encoded = Buffer.from(restartScript(pid), "utf16le").toString("base64");
  const launcher = `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`;
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", launcher], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, detached: true });
  child.unref();
}

export class UpdateRefused extends Error {}

export function createUpdates(deps: UpdateDeps = {}) {
  const file = deps.file ?? UPDATES_FILE, exec = deps.exec ?? defaultExec, now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const repoDir = deps.repoDir ?? REPO_DIR, appDir = deps.appDir ?? APP_DIR;
  const repo = () => { try { return deps.repo?.() || DEFAULT_UPDATE_REPO; } catch { return DEFAULT_UPDATE_REPO; } };
  let local: { version: string; commit: string | null } = { version: packageVersion(appDir), commit: null };
  let self: SelfUpdateCheck = { ok: false, reason: "Checking this install…" };
  let checking: Promise<void> | null = null, applying: { step: string; startedAt: string } | null = null;
  let saved = loadUpdates(file);
  const save = (patch: Partial<UpdatesFile>) => {
    saved = { ...saved, ...patch };
    try { atomicJson(file, saved); } catch { /* best effort: the memory copy still answers the status */ }
  };

  async function refreshLocal() {
    try { local = await currentVersion({ exec, appDir, repoDir }); } catch { /* keep the last answer */ }
    try { self = await selfUpdateCheck({ exec, repoDir, repo: repo(), platform: deps.platform }); }
    catch (e) { self = { ok: false, reason: e instanceof Error ? e.message : "This install could not be checked." }; }
  }

  const due = () => {
    const t = now(), last = Date.parse(saved.checkedAt ?? ""), err = Date.parse(saved.errorAt ?? "");
    if (saved.repo && saved.repo !== repo()) return true;
    return !(t - last < CHECK_EVERY_MS) && !(t - err < RETRY_AFTER_ERROR_MS);
  };
  /** Asks GitHub (and checks this install). Never throws: a failure keeps the last good answer and records the error. */
  function check(force = false): Promise<void> {
    if (checking) return checking;
    if (!force && !due()) return Promise.resolve();
    return checking = (async () => {
      const r = repo();
      try {
        const release = await latestRelease(r, { exec, fetch: deps.fetch });
        save({ release, repo: r, checkedAt: new Date(now()).toISOString(), error: null, errorAt: null });
      } catch (e) {
        save({ error: (e instanceof Error ? e.message : String(e)).slice(0, 300), errorAt: new Date(now()).toISOString(), ...(saved.repo && saved.repo !== r ? { release: null, repo: r } : {}) });
      }
      await refreshLocal();
    })().finally(() => { checking = null; });
  }

  function status(): UpdateStatus {
    const rel = saved.release, available = !!rel && isNewer(rel.version, local.version);
    const reason = applying ? "An update is running." : self.reason;
    return {
      current: local,
      latest: rel ? { version: rel.version, name: rel.name, publishedAt: rel.publishedAt } : null,
      available, checkedAt: saved.checkedAt, checking: !!checking, error: saved.error,
      notesUrl: rel?.notesUrl ?? null, notes: rel?.notes ?? "", installerUrl: rel?.installerUrl ?? null,
      canSelfUpdate: available && self.ok && !applying, reason,
      applying, lastUpdate: saved.lastUpdate,
    };
  }

  const git = async (args: string[], what: string, timeoutMs = 120_000) => {
    const r = await exec(["git", ...args], { cwd: repoDir, timeoutMs });
    if (r.code !== 0) throw new Error(`${what} failed: ${firstLine(r) || `exit code ${r.code}`}`);
    return r.out.trim();
  };

  /** The update. Resolves when it is done (the restart is scheduled) or failed (recorded; the sync is resumed). */
  async function run(release: Release): Promise<LastUpdate> {
    const startedAt = new Date(now()).toISOString(), from = local.version;
    const step = (name: string) => { applying = { step: name, startedAt }; };
    const runner = deps.runner;
    let wasEnabled = false, before: string | null = null, after: string | null = null, restart = false;
    try {
      step("Checking this install");
      const ok = await selfUpdateCheck({ exec, repoDir, repo: repo(), platform: deps.platform });
      if (!ok.ok) throw new Error(ok.reason ?? "This install cannot update itself.");
      if (runner) {
        step("Pausing the automatic sync");
        wasEnabled = (await runner.status()).enabled;
        if (wasEnabled) await runner.enable(false); // no new run starts; a current one finishes
        step("Waiting for the current sync run to finish");
        for (const start = now(); (await runner.status()).busy; await sleep(15_000))
          if (now() - start > IDLE_WAIT_MS) throw new Error("A sync run (or Dream) was still busy after 30 minutes. Try the update again later.");
      }
      step("Fetching the release");
      before = await git(["rev-parse", "HEAD"], "git rev-parse");
      await git(["fetch", "--tags", "origin"], "git fetch", 5 * 60_000);
      const tagCommit = await git(["rev-parse", "--verify", "--quiet", `refs/tags/${release.tag}^{commit}`], `Finding tag ${release.tag}`);
      const onMain = await exec(["git", "merge-base", "--is-ancestor", tagCommit, "refs/remotes/origin/main"], { cwd: repoDir, timeoutMs: 60_000 });
      if (onMain.code !== 0) throw new Error(`The release tag ${release.tag} is not on origin/main: update this checkout with git yourself.`);
      step("Updating the code");
      await git(["merge", "--ff-only", "refs/remotes/origin/main"], "git merge --ff-only", 5 * 60_000); // fast-forward only: never a merge commit, reset or force
      after = await git(["rev-parse", "HEAD"], "git rev-parse");
      const changed = before === after ? [] : (await git(["diff", "--name-only", before, after], "git diff")).split(/\r?\n/);
      step("Installing packages");
      const app = await exec([process.execPath, "install"], { cwd: appDir, timeoutMs: 10 * 60_000 });
      if (app.code !== 0) throw new Error(`bun install failed in app/: ${firstLine(app)}. The code is updated: run bun install in app/ and restart BrainPortal.`);
      if (changed.includes("desktop/package.json") && existsSync(join(repoDir, "desktop", "package.json")))
        await exec([process.execPath, "install"], { cwd: join(repoDir, "desktop"), timeoutMs: 10 * 60_000 }); // optional: the desktop app is rebuilt by its installer
      restart = true;
      const done: LastUpdate = { at: new Date(now()).toISOString(), from, to: packageVersion(appDir), commitBefore: before.slice(0, 12), commitAfter: after.slice(0, 12), error: null };
      save({ lastUpdate: done });
      return done;
    } catch (e) {
      const failed: LastUpdate = { at: new Date(now()).toISOString(), from, to: null, commitBefore: before?.slice(0, 12) ?? null, commitAfter: after?.slice(0, 12) ?? null, error: (e instanceof Error ? e.message : String(e)).slice(0, 400) };
      save({ lastUpdate: failed });
      return failed;
    } finally {
      if (wasEnabled && runner) { step("Resuming the automatic sync"); await runner.enable(true).catch(() => save({ lastUpdate: { ...saved.lastUpdate!, error: [saved.lastUpdate?.error, "Could not turn automatic sync back on: use Resume on the portal."].filter(Boolean).join(" ") } })); }
      if (restart) { step("Restarting the portal"); (deps.restart ?? restartPortal)(); } // applying stays set: this process ends in ~5 s
      else { applying = null; await refreshLocal(); }
    }
  }

  /** Starts the update after the same checks the card shows. Throws UpdateRefused with the reason; else the run's promise. */
  async function apply(): Promise<{ done: Promise<LastUpdate>; version: string }> {
    if (applying) throw new UpdateRefused("An update is already running.");
    await refreshLocal();
    const s = status();
    if (!s.available || !saved.release) throw new UpdateRefused("No newer release is available. Use Check now first.");
    if (!self.ok) throw new UpdateRefused(self.reason ?? "This install cannot update itself.");
    applying = { step: "Starting", startedAt: new Date(now()).toISOString() };
    return { done: run(saved.release), version: saved.release.version };
  }

  let timer: ReturnType<typeof setInterval> | null = null, first: ReturnType<typeof setTimeout> | null = null;
  return {
    status, check, apply, refreshLocal,
    /** Background: this install's facts now, GitHub 60 s after start, then every 10 minutes when due (6-hourly). */
    start() {
      void refreshLocal();
      first = setTimeout(() => void check(), 60_000);
      timer = setInterval(() => void check(), 10 * 60_000);
    },
    stop() { if (first) clearTimeout(first); if (timer) clearInterval(timer); },
  };
}
export type Updates = ReturnType<typeof createUpdates>;
