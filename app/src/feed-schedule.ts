// Per-connector sync interval. The worker still starts a run every 15 minutes (docker/scheduler.mjs INTERVAL_MS);
// in each run a feed takes part only when it is due. A manual "Sync now" runs every feed (`run --all`).
// Choices live in the state folder (feed-schedule.json, connector id -> minutes); a missing file means the defaults.
import { join } from "node:path";
import { STATE_DIR } from "./state.ts";
import { atomicJson, readJson } from "../docker/scheduler.mjs";
import { FEEDS } from "./adapters/teams.ts";
import { AI_FEED } from "./adapters/claude-web.ts";
import { CHATGPT_FEED } from "./adapters/chatgpt-web.ts";
import { GMAIL_FEED } from "./adapters/gmail-imap.ts";

export const SCHEDULE_FILE = join(STATE_DIR, "feed-schedule.json");
export const SYNC_INTERVALS = [15, 30, 60, 120, 180, 360, 720, 1440] as const;
/** chatgpt.com allows about one chat read a minute during a big import, so ChatGPT waits longest by default. */
export const DEFAULT_INTERVALS: Record<string, number> = { outlook: 15, "teams-chats": 15, "teams-channels": 15, meetings: 30, chatgpt: 120, gmail: 15 };
export const CLAUDE_DEFAULT = 60;
/** A pull finishes some minutes after its tick. Without this grace a 15-minute feed whose pull ended at :02 would
 *  not be due at :15 (13 minutes later). Less than one tick, so a feed never runs earlier than one tick before its time. */
export const GRACE_MS = 10 * 60_000;
const CLAUDE_KEY = /^claude:[a-z0-9-]{1,40}$/;

/** The connector id (as the portal names it) whose interval applies to a feed. Email folders are all `outlook`. */
export function scheduleKey(feed: string): string {
  if (feed === FEEDS.chats) return "teams-chats";
  if (feed === FEEDS.channels) return "teams-channels";
  if (feed === FEEDS.meetings) return "meetings";
  if (feed === CHATGPT_FEED) return "chatgpt";
  if (feed === GMAIL_FEED) return "gmail";
  if (feed === AI_FEED) return "claude:personal";
  if (feed.startsWith(`${AI_FEED}:`)) return `claude:${feed.slice(AI_FEED.length + 1)}`;
  return "outlook";
}

export const isInterval = (v: unknown): v is number => typeof v === "number" && (SYNC_INTERVALS as readonly number[]).includes(v);
export const isScheduleKey = (key: unknown): key is string => typeof key === "string" && (Object.hasOwn(DEFAULT_INTERVALS, key) || CLAUDE_KEY.test(key));
export const defaultInterval = (key: string) => DEFAULT_INTERVALS[key] ?? CLAUDE_DEFAULT;

/** Saved choices; anything unknown or not an allowed value is ignored (the default applies). */
export function readSchedule(file = SCHEDULE_FILE): Record<string, number> {
  const raw = readJson(file, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k, v]) => isScheduleKey(k) && isInterval(v))) as Record<string, number>;
}
export const intervalOf = (key: string, saved: Record<string, number>) => saved[key] ?? defaultInterval(key);

export function saveInterval(key: string, minutes: number, file = SCHEDULE_FILE): void {
  if (!isScheduleKey(key)) throw new Error("Unknown connector.");
  if (!isInterval(minutes)) throw new Error("Choose one of the listed intervals.");
  atomicJson(file, { ...readSchedule(file), [key]: minutes });
}

/** Every connector the portal shows, with its interval (saved or default). */
export function resolvedIntervals(saved: Record<string, number>, claudeIds: string[]): Record<string, number> {
  const keys = [...Object.keys(DEFAULT_INTERVALS), ...claudeIds.map(id => `claude:${id}`)];
  return Object.fromEntries(keys.map(k => [k, intervalOf(k, saved)]));
}

/** Due when never pulled, or when its interval (less the grace) has passed since the last finished pull. */
export function isDue(key: string, pulledAt: Record<string, string> | undefined, saved: Record<string, number>, now = Date.now()): boolean {
  const last = Date.parse(pulledAt?.[key] ?? "");
  return !Number.isFinite(last) || now - last >= intervalOf(key, saved) * 60_000 - GRACE_MS;
}

/** The feeds of this run, email first. `all` (a manual run) takes every feed. Email is decided on its own:
 *  another feed never removes it. `mail`: other mail feeds (Gmail), after Teams. */
export function dueFeeds(opts: { email: string[]; teams: string[]; mail?: string[]; chats: string[]; all: boolean; pulledAt?: Record<string, string>; saved: Record<string, number>; now?: number }): string[] {
  const due = (feed: string) => opts.all || isDue(scheduleKey(feed), opts.pulledAt, opts.saved, opts.now);
  return [...(opts.email.length && due(opts.email[0]) ? opts.email : []), ...opts.teams.filter(due), ...(opts.mail ?? []).filter(due), ...opts.chats.filter(due)];
}

/** The ChatGPT 429 message (adapters/chatgpt-web.ts): the feed waits a full interval, as after a finished pull. */
export const isRateLimit = (message: string) => /rate limit \(HTTP 429\)/i.test(message);
