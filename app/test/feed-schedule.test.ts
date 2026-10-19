import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_INTERVALS, dueFeeds, isDue, isRateLimit, readSchedule, resolvedIntervals, saveInterval, scheduleKey } from "../src/feed-schedule.ts";
import { collectorArgs } from "../src/runner.ts";
import { runOnce } from "../src/pipeline.ts";
import { item, knowledge } from "./fixtures.ts";

const NOW = Date.parse("2026-10-19T10:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const feeds = { email: ["inbox", "sentitems"], teams: ["teams:chats", "teams:channels", "meetings"], chats: ["ai:claude", "ai:claude:work", "ai:chatgpt"] };
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "sched-")), "feed-schedule.json");

test("defaults: mail and Teams 15 minutes, meetings 30, Claude.ai accounts 1 hour, ChatGPT 2 hours", () => {
  expect(DEFAULT_INTERVALS).toEqual({ outlook: 15, "teams-chats": 15, "teams-channels": 15, meetings: 30, chatgpt: 120, gmail: 15 });
  expect(resolvedIntervals({}, ["personal", "work"])).toMatchObject({ meetings: 30, chatgpt: 120, "claude:personal": 60, "claude:work": 60 });
  expect(["inbox", "teams:chats", "teams:channels", "meetings", "ai:claude", "ai:claude:work", "ai:chatgpt"].map(scheduleKey))
    .toEqual(["outlook", "teams-chats", "teams-channels", "meetings", "claude:personal", "claude:work", "chatgpt"]);
  // Pulled one tick ago (ended a minute after it): mail and Teams are due again; meetings, Claude.ai and ChatGPT wait.
  const pulledAt = Object.fromEntries(["outlook", "teams-chats", "teams-channels", "meetings", "claude:personal", "claude:work", "chatgpt"].map(k => [k, ago(14)]));
  expect(dueFeeds({ ...feeds, all: false, pulledAt, saved: {}, now: NOW })).toEqual(["inbox", "sentitems", "teams:chats", "teams:channels"]);
  // Never pulled: everything is due.
  expect(dueFeeds({ ...feeds, all: false, pulledAt: {}, saved: {}, now: NOW })).toEqual([...feeds.email, ...feeds.teams, ...feeds.chats]);
});

test("the due rule allows a pull that ended a few minutes after its tick, and no earlier than one tick", () => {
  expect(isDue("outlook", { outlook: ago(13) }, {}, NOW)).toBe(true); // pulled at :02, next tick :15
  expect(isDue("meetings", { meetings: ago(13) }, {}, NOW)).toBe(false);
  expect(isDue("meetings", { meetings: ago(28) }, {}, NOW)).toBe(true);
  expect(isDue("chatgpt", { chatgpt: ago(100) }, {}, NOW)).toBe(false);
  expect(isDue("chatgpt", { chatgpt: ago(115) }, {}, NOW)).toBe(true);
  expect(isDue("chatgpt", { chatgpt: "not a date" }, {}, NOW)).toBe(true);
});

test("a custom interval is stored in the state folder and read back; bad entries fall back to the default", () => {
  const file = tmpFile();
  expect(readSchedule(file)).toEqual({}); // missing file = defaults
  saveInterval("chatgpt", 1440, file);
  saveInterval("claude:work", 30, file);
  expect(readSchedule(file)).toEqual({ chatgpt: 1440, "claude:work": 30 });
  expect(() => saveInterval("chatgpt", 45, file)).toThrow();
  expect(() => saveInterval("dropbox", 60, file)).toThrow();
  const saved = readSchedule(file);
  expect(isDue("chatgpt", { chatgpt: ago(600) }, saved, NOW)).toBe(false);
  expect(isDue("claude:work", { "claude:work": ago(25) }, saved, NOW)).toBe(true);
  writeFileSync(file, JSON.stringify({ chatgpt: 7, outlook: "15", "claude:Bad Id": 60, meetings: 60 }));
  expect(readSchedule(file)).toEqual({ meetings: 60 });
});

test("a manual Sync now runs every feed; the schedule runs only the due ones", () => {
  const pulledAt = Object.fromEntries(["outlook", "teams-chats", "teams-channels", "meetings", "claude:personal", "claude:work", "chatgpt"].map(k => [k, ago(1)]));
  expect(dueFeeds({ ...feeds, all: true, pulledAt, saved: {}, now: NOW })).toEqual([...feeds.email, ...feeds.teams, ...feeds.chats]);
  expect(dueFeeds({ ...feeds, all: false, pulledAt, saved: {}, now: NOW })).toEqual([]);
  expect(collectorArgs({ source: "manual" })).toEqual(["run", "--all"]);
  expect(collectorArgs({ source: "automatic" })).toEqual(["run"]);
});

test("email is never skipped because of another feed", () => {
  // Every other feed was just pulled (and ChatGPT is rate limited); mail is due on its own interval.
  const pulledAt = { outlook: ago(15), "teams-chats": ago(1), "teams-channels": ago(1), meetings: ago(1), "claude:personal": ago(1), "claude:work": ago(1), chatgpt: ago(1) };
  expect(dueFeeds({ ...feeds, all: false, pulledAt, saved: {}, now: NOW })).toEqual(["inbox", "sentitems"]);
  // Mail first in the run, even when every feed is due.
  expect(dueFeeds({ ...feeds, all: false, pulledAt: {}, saved: {}, now: NOW }).slice(0, 2)).toEqual(["inbox", "sentitems"]);
});

test("a finished pull and a ChatGPT rate limit move lastPulledAt; another failure does not", async () => {
  const cfg = { brainPath: mkdtempSync(join(tmpdir(), "vault-")), clientId: "c", tenantId: "t", model: "", maxThreadsPerRun: 5, initialSinceDays: 10 };
  const before = new Date(Date.now() - 500 * 60_000).toISOString();
  const state = { cursors: {}, threads: {}, queue: [], muted: [], lastRun: null, lookbackDays: 10,
    feedPulledAt: { outlook: before, "teams-chats": before, chatgpt: before } } as never;
  const errors: Record<string, string> = { "teams:chats": "Teams needs permission", "ai:chatgpt": "ChatGPT rate limit (HTTP 429); chat sync continues on the next run." };
  const { report, nextState } = await runOnce(cfg, state, {
    folders: ["inbox", "teams:chats", "ai:chatgpt"], optionalFeed: f => f !== "inbox", pulledKey: scheduleKey, waitAfter: isRateLimit,
    pull: async f => { if (errors[f]) throw new Error(errors[f]); return { items: [item()], next: "cursor" }; },
    extract: async () => ({ knowledge: knowledge({ keep: false }), costUsd: 0 }), commit: () => ({ committed: true, indexed: true, detail: "" }),
    log: () => {}, today: "2026-10-19",
  }, { dryRun: false, limit: 5, outRoot: cfg.brainPath });
  expect(report.feedErrors["ai:chatgpt"]).toContain("HTTP 429");
  const pulled = nextState.feedPulledAt!;
  expect(Date.parse(pulled.outlook)).toBeGreaterThan(Date.parse(before));
  expect(Date.parse(pulled.chatgpt)).toBeGreaterThan(Date.parse(before)); // waits a full interval
  expect(pulled["teams-chats"]).toBe(before); // a real failure is retried at the next tick
});
