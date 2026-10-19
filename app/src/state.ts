// Settings (the key=value settings file named by config.json, see config.ts) and connector state (the state dir,
// default ~/.brain-mailsync). State never lives in the vault.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, openSync, closeSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Item } from "./types.ts";
import { configPath, loadAppConfig, patchConfigFile, readConfigFile, readSettings, resolveStateDir } from "./config.ts";

export const STATE_DIR = resolveStateDir();

export interface Config {
  brainPath: string;
  clientId: string;
  tenantId: string;
  /** The Microsoft 365 mailbox this install reads (config.json microsoft.account); empty = not pinned yet. */
  account?: string;
  model: string;
  maxThreadsPerRun: number;
  initialSinceDays: number;
  maxPagesPerFolder?: number;
  maxFoldersPerRun?: number;
  maxQueue?: number;
  extractTimeoutMs?: number;
  /** The vault backup pushes to every git remote unless BACKUP_PUSH=false. */
  backupPush?: boolean;
  /** How far back Teams chats, channels and meetings are read on the first sync (MAILSYNC_TEAMS_SINCE_DAYS). */
  teamsSinceDays?: number;
  /** How far back Claude.ai chats are read on the first sync (MAILSYNC_AI_SINCE_DAYS). */
  aiSinceDays?: number;
  /** How far back ChatGPT chats are read (MAILSYNC_CHATGPT_SINCE_DAYS; defaults to the Claude.ai window). */
  chatgptSinceDays?: number;
  /** Local port of the shared GBrain HTTP server (BRAIN_PORT). */
  brainPort?: number;
  /** Which AI writes the notes: Codex on the ChatGPT subscription, or the OpenAI / Claude API with a key. */
  provider?: "codex" | "openai" | "anthropic";
  openaiModel?: string;
  anthropicModel?: string;
  /** Decision model for narrow typed questions (docs/decision-model.md). "off" until set up. */
  decisionProvider?: "off" | "typesafe";
  decisionModel?: string;
}

export function loadConfig(): Config {
  const app = loadAppConfig();
  const env = readSettings(app.settingsFile);
  const get = (k: string, d = "") => process.env[k] ?? env[k] ?? d;
  return {
    brainPath: app.vault.path,
    clientId: app.microsoft.clientId,
    tenantId: app.microsoft.tenantId,
    account: app.microsoft.account,
    model: get("MAILSYNC_MODEL"),
    maxThreadsPerRun: Number(get("MAILSYNC_MAX_THREADS", "25")),
    initialSinceDays: Number(get("MAILSYNC_SINCE_DAYS", "10")),
    maxPagesPerFolder: Number(get("MAILSYNC_MAX_PAGES", "2")),
    maxFoldersPerRun: Number(get("MAILSYNC_MAX_FOLDERS", "3")),
    maxQueue: Number(get("MAILSYNC_MAX_QUEUE", "1000")),
    extractTimeoutMs: Number(get("MAILSYNC_EXTRACT_TIMEOUT_SECONDS", "180")) * 1000,
    backupPush: get("BACKUP_PUSH", "true") !== "false",
    brainPort: Number(get("BRAIN_PORT", "3131")),
    teamsSinceDays: Number(get("MAILSYNC_TEAMS_SINCE_DAYS", "30")),
    aiSinceDays: Number(get("MAILSYNC_AI_SINCE_DAYS", "30")),
    chatgptSinceDays: Number(get("MAILSYNC_CHATGPT_SINCE_DAYS", get("MAILSYNC_AI_SINCE_DAYS", "30"))),
    provider: (["codex", "openai", "anthropic"].includes(get("MAILSYNC_PROVIDER")) ? get("MAILSYNC_PROVIDER") : "codex") as Config["provider"],
    openaiModel: get("MAILSYNC_OPENAI_MODEL"),
    anthropicModel: get("MAILSYNC_ANTHROPIC_MODEL"),
    decisionProvider: get("MAILSYNC_DECISION_PROVIDER") === "typesafe" ? "typesafe" : "off",
    decisionModel: get("MAILSYNC_DECISION_MODEL"),
  };
}

export interface ThreadState { relPath: string; lastMessageAt: string }

export function validateConfig(cfg: Config): void {
  for (const [name, value] of Object.entries({ MAILSYNC_SINCE_DAYS: cfg.initialSinceDays,
    MAILSYNC_MAX_THREADS: cfg.maxThreadsPerRun, MAILSYNC_MAX_PAGES: cfg.maxPagesPerFolder ?? 2,
    MAILSYNC_MAX_FOLDERS: cfg.maxFoldersPerRun ?? 3, MAILSYNC_MAX_QUEUE: cfg.maxQueue ?? 1000 })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
}

/** Preserve unrelated local configuration; never persist invalid settings. */
export function saveConfig(updates: Record<string, string>): void {
  const allowed = ["MAILSYNC_SINCE_DAYS", "MAILSYNC_MAX_THREADS", "MAILSYNC_CLIENT_ID", "MAILSYNC_TENANT_ID", "MAILSYNC_MODEL", "BACKUP_PUSH",
    "MAILSYNC_PROVIDER", "MAILSYNC_OPENAI_MODEL", "MAILSYNC_ANTHROPIC_MODEL", "MAILSYNC_DECISION_PROVIDER", "MAILSYNC_DECISION_MODEL"];
  for (const [key, value] of Object.entries(updates)) {
    if (!allowed.includes(key) || /[\r\n]/.test(value)) throw new Error("Invalid configuration setting");
    if (key === "MAILSYNC_DECISION_PROVIDER" && !["off", "typesafe"].includes(value)) throw new Error("MAILSYNC_DECISION_PROVIDER must be off or typesafe");    if (key === "MAILSYNC_PROVIDER" && !["codex", "openai", "anthropic"].includes(value)) throw new Error("MAILSYNC_PROVIDER must be codex, openai or anthropic");
    if (/_MODEL$/.test(key) && !/^[\w.:-]{0,100}$/.test(value)) throw new Error("Model names use letters, digits, dots, dashes and colons only");
    if (key === "BACKUP_PUSH" && !["true", "false"].includes(value)) throw new Error("BACKUP_PUSH must be true or false");
    if (["MAILSYNC_CLIENT_ID", "MAILSYNC_TENANT_ID"].includes(key) && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${key} must be a UUID`);
  }
  const cfg = loadConfig();
  validateConfig({ ...cfg,
    initialSinceDays: updates.MAILSYNC_SINCE_DAYS === undefined ? cfg.initialSinceDays : Number(updates.MAILSYNC_SINCE_DAYS),
    maxThreadsPerRun: updates.MAILSYNC_MAX_THREADS === undefined ? cfg.maxThreadsPerRun : Number(updates.MAILSYNC_MAX_THREADS) });
  const app = loadAppConfig(), file = app.settingsFile;
  // config.json wins over the settings file for these two: keep it in step when it sets them.
  const ms = (readConfigFile(configPath())["microsoft"] ?? {}) as Record<string, unknown>;
  const pinned: Record<string, string> = {};
  if (updates.MAILSYNC_CLIENT_ID !== undefined && ms.clientId) pinned.clientId = updates.MAILSYNC_CLIENT_ID;
  if (updates.MAILSYNC_TENANT_ID !== undefined && ms.tenantId) pinned.tenantId = updates.MAILSYNC_TENANT_ID;
  mkdirSync(dirname(file), { recursive: true });
  let body = existsSync(file) ? readFileSync(file, "utf8") : "";
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^\\s*${key}\\s*=.*$`, "gm");
    body = re.test(body) ? body.replace(re, () => `${key}=${value}`) : body.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(`${file}.tmp`, body);
  renameSync(`${file}.tmp`, file);
  if (Object.keys(pinned).length) patchConfigFile({ microsoft: pinned });
}

export interface State {
  cursors: Record<string, string>;          // folder -> Graph deltaLink
  threads: Record<string, ThreadState>;     // conversationId -> note it owns
  queue: Item[];                             // kept items not yet extracted (cap hit or error)
  muted: string[];
  processed?: Record<string, { fingerprint: string; outcome: string; at: string }>;
  lookbackDays?: number;
  folderOffset?: number;
  scannedFolders?: Record<string, string>;
  folderNames?: Record<string, string>;
  lastSuccessAt?: string;
  indexPending?: boolean;
  /** Connector id (feed-schedule.ts scheduleKey) -> when its last pull finished (also set after a rate limit). */
  feedPulledAt?: Record<string, string>;
  lastRun: { at: string; finishedAt?: string; pulled: number; kept: number; dropped: Record<string, number>; written: number; skipped: number; blocked: number; queued: number; costUsd: number; error: string | null; duplicates?: number; notes?: string[]; feedErrors?: Record<string, string> } | null;
}

const STATE_FILE = () => join(STATE_DIR, "state.json");

export function loadState(): State {
  const f = STATE_FILE();
  const empty: State = { cursors: {}, threads: {}, queue: [], muted: [], lastRun: null };
  if (!existsSync(f)) return empty;
  return { ...empty, ...JSON.parse(readFileSync(f, "utf8")) };
}

/** Atomic write: a crash mid-write never leaves a half-written state file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export const saveState = (s: State) => writeJsonAtomic(STATE_FILE(), s);

export function log(event: Record<string, unknown>): void {
  mkdirSync(join(STATE_DIR, "logs"), { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(join(STATE_DIR, "logs", `${day}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
}

/** Single-instance lock; a live owner is never displaced by a later run. */
export function acquireLock(): (() => void) | null {
  mkdirSync(STATE_DIR, { recursive: true });
  const f = join(STATE_DIR, "run.lock");
  if (existsSync(f)) {
    let stale = false;
    try {
      const owner = JSON.parse(readFileSync(f, "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("invalid lock");
      try { process.kill(owner.pid, 0); } catch (e: any) { stale = e.code === "ESRCH"; }
    } catch { stale = Date.now() - statSync(f).mtimeMs > 2 * 3600_000; }
    if (stale) rmSync(f);
  }
  try {
    const fd = openSync(f, "wx");
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(fd);
  } catch {
    return null;
  }
  return () => rmSync(f, { force: true });
}
