// History window per chat feed (how far back a Claude.ai account or ChatGPT is read) and the usage estimate shown
// before a backfill starts. Chosen windows live in ~/.brain-mailsync/backfill.json; a feed without a choice keeps
// the window from the settings file, so feeds that were running before this existed behave exactly as before.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, acquireLock, loadState, saveState, type Config, type State } from "./state.ts";
import { atomicJson, readJson } from "../docker/scheduler.mjs";
import { AI_FEED } from "./adapters/claude-web.ts";
import { CHATGPT_FEED } from "./adapters/chatgpt-web.ts";
import { GMAIL_FEED } from "./adapters/gmail-imap.ts";
import { WHATSAPP_FEED } from "./adapters/whatsapp-feed.ts";

export const BACKFILL_FILE = join(STATE_DIR, "backfill.json");
export const WINDOW_CHOICES = [30, 182, 365, 730] as const;
export const DEFAULT_PER_CHAT = { in: 7600, out: 420 };
const DAY = 86400_000;

export type Windows = Record<string, { days: number; chosenAt: string }>;

/** Claude.ai feeds (`ai:claude`, `ai:claude:<id>`), ChatGPT, Gmail and WhatsApp: the feeds that take a history window. */
export const isWindowFeed = (feed: string) => feed === CHATGPT_FEED || feed === GMAIL_FEED || feed === WHATSAPP_FEED || feed === AI_FEED || /^ai:claude:[a-z0-9-]{1,40}$/.test(feed);
export const isWindowDays = (days: unknown): days is number => WINDOW_CHOICES.includes(days as any);

export function readWindows(file = BACKFILL_FILE): Windows {
  const raw = readJson(file, {}) as Record<string, any>;
  const out: Windows = {};
  for (const [feed, v] of Object.entries(raw ?? {})) if (isWindowFeed(feed) && isWindowDays(v?.days)) out[feed] = { days: v.days, chosenAt: String(v.chosenAt ?? "") };
  return out;
}

/** The env window a feed uses when nothing was chosen (the behaviour before history windows existed). */
/** Gmail has no settings-file window: 1 year until one is chosen. */
export const GMAIL_DEFAULT_DAYS = 365;
/** WhatsApp: 1 month until one is chosen, so turning on all chats does not summarise years of history at once. */
export const WHATSAPP_DEFAULT_DAYS = 30;
export const envWindowDays = (feed: string, cfg: Pick<Config, "aiSinceDays" | "chatgptSinceDays">) =>
  feed === GMAIL_FEED ? GMAIL_DEFAULT_DAYS : feed === WHATSAPP_FEED ? WHATSAPP_DEFAULT_DAYS :feed === CHATGPT_FEED ? cfg.chatgptSinceDays ?? cfg.aiSinceDays ?? 30 : cfg.aiSinceDays ?? 30;

/** Days back for a feed: the chosen window, else the env window. */
export const feedWindowDays = (feed: string, cfg: Pick<Config, "aiSinceDays" | "chatgptSinceDays">, windows: Windows) =>
  windows[feed]?.days ?? envWindowDays(feed, cfg);

export const sinceIso = (days: number, now = Date.now()) => new Date(now - days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

/** cli.ts: the `since` each chat feed is pulled with. */
export const feedSince = (feed: string, cfg: Pick<Config, "aiSinceDays" | "chatgptSinceDays">, windows: Windows, now = Date.now()) =>
  sinceIso(feedWindowDays(feed, cfg, windows), now);

export interface WindowDeps { file?: string; lock?: () => (() => void) | null; load?: () => State; save?: (s: State) => void }

/** Stores a feed's window. Shrinking only stores it (the adapters drop older chats). Widening also clears that
 *  feed's cursor so older chats are listed again; that needs the run lock, so it is refused while a sync runs.
 *  Already-imported messages are deduped by id + fingerprint, so nothing is summarised twice. */
export function setWindow(feed: string, days: number, cfg: Pick<Config, "aiSinceDays" | "chatgptSinceDays">, deps: WindowDeps = {}): { widened: boolean; cursorReset: boolean; previous: number } {
  if (!isWindowFeed(feed)) throw new Error("That is not a chat connector.");
  if (!isWindowDays(days)) throw new Error("Choose 1 month, 6 months, 1 year or 2 years.");
  const file = deps.file ?? BACKFILL_FILE, windows = readWindows(file);
  const previous = feedWindowDays(feed, cfg, windows), widened = days > previous;
  const store = () => atomicJson(file, { ...(readJson(file, {}) as object), [feed]: { days, chosenAt: new Date().toISOString() } });
  const load = deps.load ?? loadState, save = deps.save ?? saveState;
  if (!widened || !load().cursors?.[feed]) { store(); return { widened, cursorReset: false, previous }; }
  const release = (deps.lock ?? acquireLock)();
  if (!release) throw new WindowBusyError("Wait for the current sync to finish, then change the history window.");
  try {
    const state = load();
    const { [feed]: _dropped, ...cursors } = state.cursors;
    save({ ...state, cursors });
    store();
  } finally { release(); }
  return { widened, cursorReset: true, previous };
}
export class WindowBusyError extends Error {}

// ── Usage per summarised chat, from the sync logs ──

export interface RunLine { at: string; stage: string; dryRun?: boolean; written?: number; skipped?: number; blocked?: number; inputTokens?: number; outputTokens?: number; costUsd?: number; provider?: string; model?: string; error?: string | null }

/** Parsed lines of the newest `days` log files (YYYY-MM-DD.jsonl). Unreadable lines are skipped. */
export function readLogLines(dir = join(STATE_DIR, "logs"), sinceDay = ""): Record<string, any>[] {
  if (!existsSync(dir)) return [];
  const out: Record<string, any>[] = [];
  for (const name of readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= sinceDay).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.includes('"stage":"run"') && !line.includes('"stage":"tokens"')) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial line */ }
    }
  }
  return out;
}

export const threadsOf = (r: RunLine) => (r.written ?? 0) + (r.skipped ?? 0) + (r.blocked ?? 0);

/** Median tokens per summarised conversation over runs that summarised at least `min` threads; else the measured default. */
export function perChatFromLogs(lines: Record<string, any>[], min = 5): { in: number; out: number; runs: number; source: "logs" | "default" } {
  const runs = (lines as RunLine[]).filter(r => r.stage === "run" && !r.dryRun && threadsOf(r) >= min && (r.inputTokens ?? 0) > 0);
  if (!runs.length) return { ...DEFAULT_PER_CHAT, runs: 0, source: "default" };
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return { in: Math.round(median(runs.map(r => r.inputTokens! / threadsOf(r)))), out: Math.round(median(runs.map(r => (r.outputTokens ?? 0) / threadsOf(r)))), runs: runs.length, source: "logs" };
}

// ── Chat counts per window ──

/** Counts chats updated inside each window from a newest-first sample of update times. Exact when the sample reaches
 *  past the window start or the list ended; otherwise extrapolated from the sample's density (chats per day between
 *  its newest and oldest row) and marked approximate. */
export function countWindows(updated: string[], complete: boolean, windows: readonly number[], now = Date.now()): { days: number; chats: number; approximate: boolean }[] {
  const times = updated.map(u => Date.parse(u)).filter(Number.isFinite).sort((a, b) => b - a);
  const newest = times[0], oldest = times[times.length - 1];
  return windows.map(days => {
    const start = now - days * DAY, inside = times.filter(t => t > start).length;
    if (complete || !times.length || oldest <= start) return { days, chats: inside, approximate: false };
    const perDay = times.length / Math.max(1, (newest - oldest) / DAY);
    // The sampled rows are counted as they are; only the part of the window older than the sample is extrapolated.
    return { days, chats: Math.round(inside + perDay * Math.max(0, (oldest - start) / DAY)), approximate: true };
  });
}

/** Tokens and time for `chats` conversations at the current pace (threads per run, one run every `interval` minutes). */
export function windowCost(chats: number | null, perChat: { in: number; out: number }, threadsPerRun: number, intervalMinutes = 15) {
  if (chats == null) return { inputTokens: null, outputTokens: null, hours: null };
  const runs = Math.ceil(chats / Math.max(1, threadsPerRun));
  return { inputTokens: chats * perChat.in, outputTokens: chats * perChat.out, hours: Math.round(runs * intervalMinutes / 60 * 10) / 10 };
}

export interface Writer { provider: string; extractor: string; model: string; billing: "subscription" | "api-key" }
export const writerOf = (cfg: Config): Writer => {
  const provider = cfg.provider ?? "codex";
  return { provider, extractor: { codex: "Codex", openai: "OpenAI API", anthropic: "Claude API" }[provider],
    model: ({ codex: cfg.model, openai: cfg.openaiModel, anthropic: cfg.anthropicModel }[provider]) || "default model",
    billing: provider === "codex" ? "subscription" : "api-key" };
};

/** Lists update times, newest first, until `stopBefore` or `maxPages`. `page(offset)` returns rows and whether more exist. */
export async function sampleUpdates(page: (offset: number) => Promise<{ rows: string[]; more: boolean }>, stopBefore: string, maxPages: number, size = 50): Promise<{ updated: string[]; complete: boolean }> {
  const updated: string[] = [];
  for (let i = 0; i < maxPages; i++) {
    const { rows, more } = await page(i * size);
    updated.push(...rows);
    if (!more || rows.length < size) return { updated, complete: true };
    if (rows.some(u => u <= stopBefore)) return { updated, complete: true }; // newest first: the window is covered
  }
  return { updated, complete: false };
}

export interface EstimateDeps {
  config: () => Config;
  logs: () => Record<string, any>[];
  /** Update times for a feed (newest first) or null when that account is not signed in. */
  sample: (feed: string, stopBefore: string) => Promise<{ updated: string[]; complete: boolean } | null>;
  windows: () => Windows;
  now?: () => number;
}

export function createEstimator(deps: EstimateDeps, ttlMs = 10 * 60_000) {
  const cache = new Map<string, { at: number; value: Promise<any> }>();
  async function compute(feed: string) {
    const cfg = deps.config(), now = deps.now?.() ?? Date.now(), perChat = perChatFromLogs(deps.logs());
    const fresh = /^ai:claude:new$/.test(feed); // an account not created yet: nothing to count
    const sample = fresh ? null : await deps.sample(feed, sinceIso(Math.max(...WINDOW_CHOICES), now)).catch(() => null);
    const counts = sample ? countWindows(sample.updated, sample.complete, WINDOW_CHOICES, now) : null;
    const windows = deps.windows(), days = fresh ? null : feedWindowDays(feed, cfg, windows);
    return {
      feed, at: new Date(now).toISOString(), counted: !!counts,
      current: days == null ? null : { days, chosen: !!windows[feed] },
      perChat, writer: writerOf(cfg), threadsPerRun: cfg.maxThreadsPerRun, intervalMinutes: 15,
      choices: WINDOW_CHOICES.map((d, i) => ({ days: d, chats: counts?.[i].chats ?? null, approximate: counts?.[i].approximate ?? false,
        ...windowCost(counts?.[i].chats ?? null, perChat, cfg.maxThreadsPerRun) })),
    };
  }
  return {
    estimate(feed: string) {
      const hit = cache.get(feed), now = Date.now();
      if (hit && now - hit.at < ttlMs) return hit.value;
      const value = compute(feed);
      cache.set(feed, { at: now, value });
      value.catch(() => cache.delete(feed));
      return value;
    },
    reset(feed?: string) { feed ? cache.delete(feed) : cache.clear(); },
  };
}
