import { expect, test } from "bun:test";
import { claudeRows, connectorsModel, hoursText, money, tokens, usageModel, windowChangeNote, windowDialogModel, windowLabel, writerLine } from "../portal/view.js";

const status = { settings: { provider: "codex", extractor: "Codex", model: "default model", threadsPerRun: 25 } };
const est = { counted: true, perChat: { in: 8000, out: 400, source: "logs" }, threadsPerRun: 25,
  writer: { provider: "openai", extractor: "OpenAI API", model: "gpt-5", billing: "api-key" },
  choices: [{ days: 30, chats: 13, approximate: false, inputTokens: 104_000, hours: 0.3 }, { days: 182, chats: 136, approximate: true, inputTokens: 1_088_000, hours: 1.5 },
    { days: 365, chats: 273, approximate: true, inputTokens: 2_184_000, hours: 2.8 }, { days: 730, chats: 546, approximate: true, inputTokens: 4_368_000, hours: 5.5 }] };

test("formatting helpers", () => {
  expect(tokens(4_368_000)).toBe("4.4 M"); expect(tokens(104_000)).toBe("104 k"); expect(tokens(7600)).toBe("7.6 k"); expect(tokens(420)).toBe("420");
  expect(hoursText(0.3)).toBe("18 min"); expect(hoursText(5.5)).toBe("5.5 hours"); expect(hoursText(120)).toBe("5 days");
  expect(money(0.004)).toBe("< $0.01"); expect(money(12.5)).toBe("$12.50");
  expect(windowLabel(730)).toBe("2 years"); expect(windowLabel(45)).toBe("45 days");
});

test("dialog: counts when estimated, per-chat figures while loading or on an older portal build", () => {
  const loading = windowDialogModel({ est: null, status, feed: "ai:chatgpt", mode: "add" });
  expect(loading.choices[0].line).toBe("Counting chats…");
  expect(loading.selected).toBe(182);
  expect(loading.writer).toContain("ChatGPT subscription");
  const old = windowDialogModel({ est: "unavailable", status, feed: "ai:chatgpt", mode: "add", current: 730 });
  expect(old.choices[3].line).toBe("≈ 7.6 k tokens in and 420 out per chat");
  expect(old.selected).toBe(730);
  expect(old.notes.join(" ")).toContain("after the portal restarts");
  const loaded = windowDialogModel({ est, status, feed: "ai:chatgpt", mode: "add" });
  expect(loaded.choices[0].line).toBe("13 chats · ≈ 104 k tokens in · ≈ 18 min");
  expect(loaded.choices[3].line).toBe("≈ 546 chats · ≈ 4.4 M tokens in · ≈ 5.5 hours");
  expect(loaded.writer).toBe("Notes are written by OpenAI API · gpt-5, billed per token to your OpenAI API key.");
  expect(loaded.notes.join(" ")).toContain("estimated from your most recent chats");
  const claude = windowDialogModel({ est: { ...est, counted: false, choices: est.choices.map(c => ({ ...c, chats: null })) }, status, feed: "ai:claude:new", mode: "add", claude: true });
  expect(claude.notes[0]).toContain("once this account is signed in");
  expect(claude.confirm).toBe("Confirm and sign in");
  const change = windowDialogModel({ est, status, feed: "ai:chatgpt", mode: "change", current: 365 });
  expect(change.title).toBe("Change ChatGPT history window"); expect(change.lede).toContain("Currently 1 year");
});

test("change note: widening re-reads, narrowing stops, same window says nothing", () => {
  expect(windowChangeNote(730, 182)).toContain("skipped");
  expect(windowChangeNote(30, 182)).toContain("Narrowing");
  expect(windowChangeNote(182, 182)).toBe("");
  expect(writerLine({ provider: "anthropic", extractor: "Claude API", model: "" })).toContain("Anthropic API key");
});

test("connector models carry the window when the portal reports it, and nothing on an older build", () => {
  const s = { schedule: { state: "Ready" }, settings: { provider: "codex", extractor: "Codex", model: "x", lookbackDays: 10 }, counts: { scannedFolders: 0 },
    ai: { chatgpt: { signedIn: true, email: "a@b" } }, chatgptChats: { enabled: true }, claude: { connected: true, browserFound: true },
    claudeAccounts: [{ id: "personal", feed: "ai:claude", connected: true, email: "me@x" }],
    backfill: { "ai:claude": { days: 730, chosen: false }, "ai:chatgpt": { days: 182, chosen: true } } };
  expect(claudeRows(s)[0].window).toEqual({ feed: "ai:claude", days: 730, chosen: false, label: "2 years" });
  expect(connectorsModel(s).find(c => c.id === "chatgpt").window.label).toBe("6 months");
  expect(claudeRows({ ...s, backfill: undefined })[0].window).toBeNull();
});

test("usage model: totals, subscription vs API spend, chart shares, projection", () => {
  const r = { totals: { threads: 20, inputTokens: 152_000, outputTokens: 8_400, spendUsd: 1.5, apiEquivalentUsd: 0.27 }, perChat: { in: 7600, out: 420 },
    providers: [{ label: "Codex (ChatGPT subscription)", model: "default model", assumed: true, billing: "subscription", threads: 15, inputTokens: 114_000, outputTokens: 6300, perChat: { in: 7600, out: 420 }, spendUsd: 0, apiEquivalentUsd: 0.27, spendSource: "subscription" },
      { label: "Claude API", model: "claude-opus-5-5", assumed: false, billing: "api-key", threads: 5, inputTokens: 38_000, outputTokens: 2100, perChat: { in: 7600, out: 420 }, spendUsd: 1.5, apiEquivalentUsd: 1.5, spendSource: "estimate" }],
    days: [{ day: "2026-10-16", inputTokens: 0, outputTokens: 0, threads: 0 }, { day: "2026-10-17", inputTokens: 152_000, outputTokens: 8_400, threads: 20 }],
    sources: [], sourcesFrom: null, pricesEdited: false, projection: { threads: 5, queuedThreads: 2, chatgptPending: 3, inputTokens: 38_000, hours: 0.3 } };
  const m = usageModel(r);
  expect(m.totals.map(([k]) => k)).toEqual(["Conversations summarised", "Tokens in", "Tokens out", "Per conversation", "Spend on API keys", "Subscription, API-equivalent"]);
  expect(m.providers[0].spend).toBe("Included in subscription"); expect(m.providers[0].spendNote).toContain("API-equivalent ≈ $0.27");
  expect(m.providers[1]).toMatchObject({ spend: "$1.50", spendNote: "Estimate from the price table" });
  expect(m.days.map(d => d.share)).toEqual([0, 1]);
  expect(m.projection).toContain("5 conversations still to summarise");
  expect(m.sourcesNote).toContain("next sync run");
  expect(usageModel({ ...r, projection: { threads: 0 } }).projection).toContain("Nothing waiting");
});
