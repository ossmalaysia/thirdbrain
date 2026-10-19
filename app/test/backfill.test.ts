import { expect, test } from "bun:test";
import { pendingChatGpt } from "../src/backfill-live.ts";

test("ChatGPT estimate after the first listing: exact chats still to read, from the cursor", () => {
  const cursor = JSON.stringify({ top: "2026-10-17T00:00:00Z", pending: [{ id: "a", u: "2025-01-02T00:00:00Z" }, { id: "b", u: "2026-09-01T00:00:00Z" }] });
  expect(pendingChatGpt(cursor)).toEqual({ updated: ["2026-09-01T00:00:00Z", "2025-01-02T00:00:00Z"], complete: true });
  expect(pendingChatGpt(undefined)).toBeNull();
  expect(pendingChatGpt("2026-10-01T00:00:00Z")).toBeNull(); // old plain-date cursor: fall back to sampling
});
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countWindows, createEstimator, envWindowDays, feedSince, feedWindowDays, isWindowFeed, perChatFromLogs, readLogLines, readWindows,
  sampleUpdates, setWindow, sinceIso, WindowBusyError, windowCost, WINDOW_CHOICES } from "../src/backfill.ts";
import { sampleChatGpt, sampleClaude } from "../src/backfill-live.ts";
import type { Config, State } from "../src/state.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "backfill-"));
const cfg = { aiSinceDays: 730, chatgptSinceDays: 730 } as Pick<Config, "aiSinceDays" | "chatgptSinceDays">;
const DAY = 86400_000, NOW = Date.parse("2026-10-17T12:00:00Z");
const ago = (d: number) => new Date(NOW - d * DAY).toISOString();

test("windows: stored per feed; unknown feeds, bad days and broken files are ignored; env fallback keeps today's behaviour", () => {
  const dir = tmp(), file = join(dir, "backfill.json");
  expect(readWindows(file)).toEqual({});
  writeFileSync(file, JSON.stringify({ "ai:chatgpt": { days: 182, chosenAt: "x" }, "ai:claude": { days: 45 }, "inbox": { days: 30 }, "ai:claude:company": { days: 30 } }));
  expect(readWindows(file)).toEqual({ "ai:chatgpt": { days: 182, chosenAt: "x" }, "ai:claude:company": { days: 30, chosenAt: "" } });
  writeFileSync(file, "{not json");
  expect(readWindows(file)).toEqual({});
  // Fallback: ChatGPT uses its own env value, else the Claude.ai one; Claude feeds use the AI window.
  expect(envWindowDays("ai:chatgpt", { aiSinceDays: 730 })).toBe(730);
  expect(envWindowDays("ai:chatgpt", { aiSinceDays: 730, chatgptSinceDays: 90 })).toBe(90);
  expect(envWindowDays("ai:claude:x", { aiSinceDays: 365, chatgptSinceDays: 90 })).toBe(365);
  expect(envWindowDays("ai:claude", {})).toBe(30);
  expect(isWindowFeed("ai:claude")).toBe(true); expect(isWindowFeed("ai:claude:company-2")).toBe(true);
  expect(isWindowFeed("teams:chats")).toBe(false); expect(isWindowFeed("ai:claude:../x")).toBe(false);
});

test("cli feed -> window resolution: chosen window per feed, env otherwise", () => {
  const windows = { "ai:claude:company": { days: 30, chosenAt: "" } };
  expect(feedWindowDays("ai:claude:company", cfg, windows)).toBe(30);
  expect(feedWindowDays("ai:claude", cfg, windows)).toBe(730);
  expect(feedSince("ai:claude:company", cfg, windows, NOW)).toBe("2026-09-17T12:00:00Z");
  expect(feedSince("ai:chatgpt", cfg, {}, NOW)).toBe(sinceIso(730, NOW));
});

function stateStore(cursors: Record<string, string>) {
  let state = { cursors, threads: {}, queue: [], muted: [], lastRun: null } as State;
  return { load: () => structuredClone(state), save: (s: State) => { state = s; }, get: () => state };
}

test("narrowing only stores the window; widening resets only that feed's cursor, under the run lock", () => {
  const file = join(tmp(), "backfill.json");
  const store = stateStore({ "ai:chatgpt": '{"top":"t","pending":[]}', "ai:claude": '{"org":"w"}', "inbox": "delta" });
  let locked = 0, released = 0;
  const lock = () => { locked++; return () => { released++; }; };
  const narrow = setWindow("ai:chatgpt", 182, cfg, { file, lock, ...store });
  expect(narrow).toEqual({ widened: false, cursorReset: false, previous: 730 });
  expect(locked).toBe(0);
  expect(store.get().cursors["ai:chatgpt"]).toBeDefined();
  expect(readWindows(file)["ai:chatgpt"].days).toBe(182);
  const widen = setWindow("ai:chatgpt", 365, cfg, { file, lock, ...store });
  expect(widen).toEqual({ widened: true, cursorReset: true, previous: 182 });
  expect([locked, released]).toEqual([1, 1]);
  expect(store.get().cursors).toEqual({ "ai:claude": '{"org":"w"}', inbox: "delta" });
  expect(readWindows(file)["ai:chatgpt"].days).toBe(365);
});

test("widening while a sync holds the lock is refused and changes nothing; a feed without a cursor needs no lock", () => {
  const file = join(tmp(), "backfill.json");
  const store = stateStore({ "ai:claude": '{"org":"w"}' });
  setWindow("ai:claude", 30, cfg, { file, lock: () => null, ...store }); // narrowing: no lock needed
  expect(() => setWindow("ai:claude", 730, cfg, { file, lock: () => null, ...store })).toThrow(WindowBusyError);
  expect(readWindows(file)["ai:claude"].days).toBe(30);
  expect(store.get().cursors["ai:claude"]).toBe('{"org":"w"}');
  // New account: nothing to re-read, so it is stored without the lock.
  expect(setWindow("ai:claude:new-one", 730, { aiSinceDays: 30 }, { file, lock: () => null, ...store }).cursorReset).toBe(false);
  expect(() => setWindow("ai:claude", 90, cfg, { file, ...store })).toThrow(/Choose/);
  expect(() => setWindow("inbox", 30, cfg, { file, ...store })).toThrow(/chat connector/);
});

test("per-chat usage from logs: median of runs with >= 5 threads; dry runs and small runs ignored; default without data", () => {
  expect(perChatFromLogs([])).toEqual({ in: 7600, out: 420, runs: 0, source: "default" });
  const run = (n: number, inp: number, out: number, extra = {}) => ({ stage: "run", written: n, skipped: 0, blocked: 0, inputTokens: inp, outputTokens: out, ...extra });
  const lines = [run(10, 70_000, 4000), run(5, 50_000, 2500), run(20, 160_000, 8000), run(2, 900_000, 1), run(10, 900_000, 1, { dryRun: true }), { stage: "tokens", inputTokens: 5 }];
  expect(perChatFromLogs(lines)).toEqual({ in: 8000, out: 400, runs: 3, source: "logs" });
  expect(perChatFromLogs([run(4, 1000, 10)])).toMatchObject({ source: "default" });
});

test("readLogLines keeps run and tokens lines from day files on or after a day, skipping broken lines", () => {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-10-01.jsonl"), '{"stage":"run","inputTokens":1}\n');
  writeFileSync(join(dir, "2026-10-16.jsonl"), '{"stage":"run","inputTokens":2}\n{"stage":"extract","skip":true}\n{"stage":"tokens","thread":"t"}\n{"stage":"run",broken\n');
  writeFileSync(join(dir, "notes.txt"), '{"stage":"run"}\n');
  expect(readLogLines(dir, "2026-10-10")).toEqual([{ stage: "run", inputTokens: 2 }, { stage: "tokens", thread: "t" }]);
  expect(readLogLines(dir).length).toBe(3);
  expect(readLogLines(join(dir, "missing"))).toEqual([]);
});

test("count per window: exact when the sample covers the window, density-extrapolated (approximate) when it does not", () => {
  // 100 chats, one every day for the last 100 days, list not finished.
  const updated = Array.from({ length: 100 }, (_, i) => ago(i + 0.5));
  const r = countWindows(updated, false, WINDOW_CHOICES, NOW);
  expect(r[0]).toEqual({ days: 30, chats: 30, approximate: false });
  expect(r[1].approximate).toBe(true);
  expect(r[1].chats).toBeGreaterThan(175); expect(r[1].chats).toBeLessThan(190); // ~1 per day over 182 days
  expect(r[3].chats).toBeGreaterThan(720); expect(r[3].chats).toBeLessThan(745);
  // The list ended: every count is exact.
  expect(countWindows(updated, true, WINDOW_CHOICES, NOW).map(c => [c.chats, c.approximate])).toEqual([[30, false], [100, false], [100, false], [100, false]]);
  expect(countWindows([], false, [30], NOW)).toEqual([{ days: 30, chats: 0, approximate: false }]);
});

test("token and hour math at the current pace", () => {
  expect(windowCost(100, { in: 7600, out: 420 }, 25)).toEqual({ inputTokens: 760_000, outputTokens: 42_000, hours: 1 });
  expect(windowCost(101, { in: 1, out: 1 }, 25).hours).toBe(1.3); // 5 runs x 15 min
  expect(windowCost(null, { in: 1, out: 1 }, 25)).toEqual({ inputTokens: null, outputTokens: null, hours: null });
});

test("sampling stops at the window or the page cap; ChatGPT reads at most two pages, never the fake total", async () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, update_time: ago(i), title: "PRIVATE" }));
  const paths: string[] = [];
  const api = { get: async (p: string) => { paths.push(p); const o = Number(new URL("http://x" + p).searchParams.get("offset")); return { items: rows.slice(o, o + 50), total: 51 } as any; } };
  const s = await sampleChatGpt(api, sinceIso(730, NOW));
  expect(paths.length).toBe(2); expect(s).toMatchObject({ complete: false }); expect(s.updated.length).toBe(100);
  expect(JSON.stringify(s)).not.toContain("PRIVATE");
  const early = await sampleUpdates(async o => ({ rows: rows.slice(o, o + 50).map(r => r.update_time), more: true }), ago(60), 10);
  expect(early).toMatchObject({ complete: true }); expect(early.updated.length).toBe(100);
  // Claude: per organisation, newest first, with a total page budget.
  const claudeCalls: string[] = [];
  const claude = { get: async (p: string) => { claudeCalls.push(p);
    if (p === "/api/organizations") return [{ uuid: "a", capabilities: ["chat"] }, { uuid: "api", capabilities: ["api"] }, { uuid: "b" }];
    const o = Number(new URL("http://x" + p).searchParams.get("offset"));
    return { data: rows.slice(o, o + 50).map(r => ({ uuid: r.id, updated_at: r.update_time })), has_more: true }; } };
  const c = await sampleClaude(claude as any, sinceIso(730, NOW), 4);
  expect(claudeCalls.filter(p => p.includes("/api/organizations/api/")).length).toBe(0);
  expect(claudeCalls.length).toBe(5); // organisations + 2 pages for each chat organisation
  expect(c.complete).toBe(false); expect(c.updated.length).toBe(200);
});

test("estimator: caches per feed, counts only signed-in feeds, and a new account gets per-chat figures only", async () => {
  let samples = 0;
  const est = createEstimator({ config: () => ({ ...cfg, maxThreadsPerRun: 25, provider: "codex", model: "" } as Config), logs: () => [],
    windows: () => ({}), now: () => NOW,
    sample: async feed => { samples++; return feed === "ai:chatgpt" ? { updated: [ago(1), ago(2)], complete: true } : null; } });
  const a = await est.estimate("ai:chatgpt") as any;
  expect(a.counted).toBe(true); expect(a.choices[0]).toMatchObject({ days: 30, chats: 2, inputTokens: 15_200, hours: 0.3 });
  expect(a.writer).toEqual({ provider: "codex", extractor: "Codex", model: "default model", billing: "subscription" });
  expect(a.current).toEqual({ days: 730, chosen: false });
  await est.estimate("ai:chatgpt"); expect(samples).toBe(1);
  const b = await est.estimate("ai:claude") as any;
  expect(b.counted).toBe(false); expect(b.choices.every((c: any) => c.chats === null)).toBe(true); expect(b.perChat.in).toBe(7600);
  const n = await est.estimate("ai:claude:new") as any;
  expect(n.current).toBeNull(); expect(samples).toBe(2);
});
