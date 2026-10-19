import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateUsage, backlog, DEFAULT_PRICES, projection, rangeStart, readPrices, savePrices, sourceOf, usageReport, usd } from "../src/usage.ts";
import type { Config } from "../src/state.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const run = (at: string, n: number, inp: number, out: number, extra: Record<string, unknown> = {}) =>
  ({ at, stage: "run", written: n, skipped: 0, blocked: 0, inputTokens: inp, outputTokens: out, costUsd: 0, ...extra });

test("ranges: UTC day starts, all time is open", () => {
  expect(rangeStart("7d", NOW)).toBe("2026-10-11");
  expect(rangeStart("30d", NOW)).toBe("2026-09-18");
  expect(rangeStart("all", NOW)).toBeNull();
});

test("old run lines are attributed to Codex as assumed; new lines by their provider and model", () => {
  const lines = [
    run("2026-10-16T01:00:00Z", 10, 76_000, 4_200),
    run("2026-10-17T01:00:00Z", 5, 40_000, 2_000, { provider: "codex", model: "gpt-5.5" }),
    run("2026-10-17T02:00:00Z", 4, 1_000_000, 100_000, { provider: "anthropic", model: "claude-opus-5-5" }),
    run("2026-10-17T03:00:00Z", 9, 9e9, 9e9, { dryRun: true }),
    run("2026-10-17T04:00:00Z", 0, 0, 0), // a run that summarised nothing
    { at: "2026-10-17T05:00:00Z", stage: "run", error: "NEEDS_LOGIN" },
  ];
  const r = aggregateUsage(lines, { range: "7d", now: NOW });
  expect(r.providers.map(p => [p.provider, p.model, p.assumed, p.threads])).toEqual([
    ["anthropic", "claude-opus-5-5", false, 4], ["codex", "default model", true, 10], ["codex", "gpt-5.5", false, 5]]);
  const claude = r.providers[0], old = r.providers[1];
  expect(claude.spendSource).toBe("estimate"); expect(claude.spendUsd).toBeCloseTo(4 + 2, 6); // $4 in, $20 out per 1M
  expect(old.billing).toBe("subscription"); expect(old.spendUsd).toBe(0);
  expect(old.apiEquivalentUsd).toBeCloseTo((76_000 * 1.25 + 4_200 * 10) / 1e6, 9);
  expect(old.perChat).toEqual({ in: 7600, out: 420 });
  expect(r.totals.threads).toBe(19); expect(r.totals.spendUsd).toBeCloseTo(6, 6);
  expect(r.days.length).toBe(7); expect(r.days.at(-1)).toMatchObject({ day: "2026-10-17", threads: 9 }); expect(r.days[0].threads).toBe(0);
});

test("logged provider cost wins over the price table; ranges drop older runs", () => {
  const lines = [run("2026-10-17T01:00:00Z", 5, 1_000_000, 0, { provider: "openai", model: "gpt-5", costUsd: 0.5 }), run("2026-08-01T01:00:00Z", 5, 50_000, 0)];
  const r = aggregateUsage(lines, { range: "30d", now: NOW });
  expect(r.providers).toHaveLength(1);
  expect(r.providers[0]).toMatchObject({ spendUsd: 0.5, spendSource: "logged", apiEquivalentUsd: 1.25 });
  const all = aggregateUsage(lines, { range: "all", now: NOW });
  expect(all.providers.map(p => p.provider).sort()).toEqual(["codex", "openai"]);
  expect(all.from).toBe("2026-08-01"); expect(all.days.length).toBe(78);
});

test("per-source rows come from per-thread token lines, with the day they start", () => {
  const lines = [
    { at: "2026-10-17T01:00:00Z", stage: "tokens", thread: "ai-chatgpt:1", source: "chatgpt-chat", inputTokens: 5000, outputTokens: 300 },
    { at: "2026-10-17T01:00:00Z", stage: "tokens", thread: "ai-claude:2", inputTokens: 8000, outputTokens: 400 },
    { at: "2026-10-17T01:00:00Z", stage: "tokens", thread: "AAMkAD=", inputTokens: 1000, outputTokens: 100 },
    { at: "2026-10-16T01:00:00Z", stage: "tokens", thread: "meeting:x", source: "meeting", inputTokens: 2000, outputTokens: 50 },
  ];
  const r = aggregateUsage(lines, { range: "7d", now: NOW });
  expect(r.sources.map(s => [s.source, s.threads, s.inputTokens])).toEqual([["ai-chat", 1, 8000], ["chatgpt-chat", 1, 5000], ["meeting", 1, 2000], ["email", 1, 1000]]);
  expect(r.sourcesFrom).toBe("2026-10-16");
  expect(sourceOf({ thread: "chat:19:abc" })).toBe("teams-chat"); expect(sourceOf({ thread: "channel:1:2" })).toBe("teams-channel");
  expect(aggregateUsage([], { range: "7d", now: NOW }).sourcesFrom).toBeNull();
});

test("price table: defaults, validated edits, and the dollar math", () => {
  const file = join(mkdtempSync(join(tmpdir(), "prices-")), "prices.json");
  expect(readPrices(file)).toEqual({ prices: DEFAULT_PRICES, edited: false });
  expect(() => savePrices({ codex: { in: 1, out: 2 } }, file)).toThrow(/dollars/);
  expect(() => savePrices({ codex: { in: -1, out: 2 }, openai: { in: 1, out: 1 }, anthropic: { in: 1, out: 1 } }, file)).toThrow();
  expect(() => savePrices({ codex: { in: "1", out: 2 }, openai: { in: 1, out: 1 }, anthropic: { in: 1, out: 1 } }, file)).toThrow();
  savePrices({ codex: { in: 2, out: 8 }, openai: { in: 1, out: 1 }, anthropic: { in: 3, out: 15 } }, file);
  expect(readPrices(file)).toEqual({ prices: { codex: { in: 2, out: 8 }, openai: { in: 1, out: 1 }, anthropic: { in: 3, out: 15 } }, edited: true });
  writeFileSync(file, JSON.stringify({ openai: { in: "x" } }));
  expect(readPrices(file).prices.openai).toEqual(DEFAULT_PRICES.openai);
  expect(usd(2_000_000, 500_000, { in: 3, out: 15 })).toBe(13.5);
});

test("projection: queued threads plus ChatGPT pending chats at the current pace", () => {
  const state = { queue: [{ threadId: "a" }, { threadId: "a" }, { threadId: "b" }] as any, cursors: { "ai:chatgpt": JSON.stringify({ top: "t", pending: [{ id: "1" }, { id: "2" }, { id: "3" }] }), "ai:claude": "{}" } };
  expect(backlog(state)).toEqual({ queuedThreads: 2, chatgptPending: 3, threads: 5 });
  expect(projection(state, { in: 7600, out: 420 }, 2)).toMatchObject({ threads: 5, inputTokens: 38_000, outputTokens: 2100, hours: 0.8 });
  expect(backlog({ queue: [], cursors: { "ai:chatgpt": "garbage" } })).toEqual({ queuedThreads: 0, chatgptPending: 0, threads: 0 });
  const report = usageReport([], { queue: [], cursors: {} }, { maxThreadsPerRun: 25, provider: "anthropic" } as Config, "7d", { now: NOW, pricesFile: join(mkdtempSync(join(tmpdir(), "p-")), "x.json") });
  expect(report.writer).toEqual({ provider: "anthropic", label: "Claude API" });
  expect(report.projection.perChat.source).toBe("default");
});
