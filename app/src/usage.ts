// Usage page: tokens and estimated spend per AI provider + model, per day and per source, from the sync logs.
// Run lines carry provider/model since 2026-10-17; older lines are attributed to Codex (the only provider before)
// and marked "assumed". Per-source figures need the per-thread `tokens` lines, which start on the same day.
import { join } from "node:path";
import { STATE_DIR, type Config, type State } from "./state.ts";
import { atomicJson, readJson } from "../docker/scheduler.mjs";
import { perChatFromLogs, threadsOf, type RunLine } from "./backfill.ts";
import { CHATGPT_FEED } from "./adapters/chatgpt-web.ts";

export const PRICES_FILE = join(STATE_DIR, "prices.json");
export const RANGES = { "7d": 7, "30d": 30, "90d": 90, all: null } as const;
export type Range = keyof typeof RANGES;
export type Provider = "codex" | "openai" | "anthropic";
export const PROVIDER_LABEL: Record<Provider, string> = { codex: "Codex (ChatGPT subscription)", openai: "OpenAI API", anthropic: "Claude API" };

/** USD per 1M tokens. Estimates only: the page says to edit them to your plan's prices. Codex is priced as the
 *  OpenAI API would charge for a comparable model ("API-equivalent"); the subscription itself has no per-token bill. */
export const DEFAULT_PRICES: Record<Provider, { in: number; out: number }> = {
  codex: { in: 1.25, out: 10 }, openai: { in: 1.25, out: 10 }, anthropic: { in: 4, out: 20 },
};
export type Prices = typeof DEFAULT_PRICES;

const isPrice = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 10_000;
export function readPrices(file = PRICES_FILE): { prices: Prices; edited: boolean } {
  const saved = readJson(file, {}) as Partial<Record<Provider, { in?: unknown; out?: unknown }>>;
  const prices = { ...DEFAULT_PRICES };
  let edited = false;
  for (const p of Object.keys(DEFAULT_PRICES) as Provider[]) {
    const v = saved?.[p];
    if (v && isPrice(v.in) && isPrice(v.out)) { prices[p] = { in: v.in as number, out: v.out as number }; edited = true; }
  }
  return { prices, edited };
}
export function savePrices(input: unknown, file = PRICES_FILE): Prices {
  const body = input as Record<string, { in?: unknown; out?: unknown }>;
  const out = {} as Prices;
  for (const p of Object.keys(DEFAULT_PRICES) as Provider[]) {
    const v = body?.[p];
    if (!v || !isPrice(v.in) || !isPrice(v.out)) throw new Error("Enter prices as numbers of US dollars per million tokens (0 to 10,000).");
    out[p] = { in: v.in as number, out: v.out as number };
  }
  atomicJson(file, out);
  return out;
}

export const usd = (tokensIn: number, tokensOut: number, price: { in: number; out: number }) => (tokensIn * price.in + tokensOut * price.out) / 1e6;

/** Thread id / item source -> the Usage page's source rows (same ids as the Notes page). */
export function sourceOf(line: { source?: string; thread?: string }): string {
  const s = line.source, t = line.thread ?? "";
  if (s === "ai-chat" || t.startsWith("ai-claude:")) return "ai-chat";
  if (s === "chatgpt-chat" || t.startsWith("ai-chatgpt:")) return "chatgpt-chat";
  if (s === "teams-chat" || t.startsWith("chat:")) return "teams-chat";
  if (s === "teams-channel" || t.startsWith("channel:")) return "teams-channel";
  if (s === "meeting" || t.startsWith("meeting:")) return "meeting";
  if (s === "gmail" || t.startsWith("gmail:")) return "gmail";
  if (s === "whatsapp" || t.startsWith("whatsapp:")) return "whatsapp";
  return "email";
}
export const SOURCE_LABEL: Record<string, string> = { email: "Email", "teams-chat": "Teams chats", "teams-channel": "Teams channels", meeting: "Meetings", "ai-chat": "Claude chats", "chatgpt-chat": "ChatGPT chats", gmail: "Gmail", whatsapp: "WhatsApp" };

const dayOf = (at: string) => String(at).slice(0, 10);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** First day of a range (UTC days, as the log files are named); null = all time. */
export const rangeStart = (range: Range, now = Date.now()) => RANGES[range] == null ? null : addDays(new Date(now).toISOString().slice(0, 10), -(RANGES[range]! - 1));

export function aggregateUsage(lines: Record<string, any>[], opts: { range: Range; now?: number; prices?: Prices }) {
  const now = opts.now ?? Date.now(), prices = opts.prices ?? DEFAULT_PRICES;
  const from = rangeStart(opts.range, now), today = new Date(now).toISOString().slice(0, 10);
  const inRange = (at: string) => !!at && (!from || dayOf(at) >= from) && dayOf(at) <= today;
  const runs = (lines as RunLine[]).filter(r => r.stage === "run" && !r.dryRun && inRange(r.at) && ((r.inputTokens ?? 0) > 0 || threadsOf(r) > 0));
  const byKey = new Map<string, any>(), byDay = new Map<string, { inputTokens: number; outputTokens: number; threads: number }>();
  for (const r of runs) {
    const provider = (["codex", "openai", "anthropic"].includes(r.provider ?? "") ? r.provider : "codex") as Provider;
    const assumed = !r.provider, model = r.model || "default model", key = `${provider}|${model}|${assumed}`;
    const row = byKey.get(key) ?? { provider, model, assumed, label: PROVIDER_LABEL[provider], billing: provider === "codex" ? "subscription" : "api-key",
      runs: 0, threads: 0, inputTokens: 0, outputTokens: 0, loggedUsd: 0 };
    row.runs++; row.threads += threadsOf(r); row.inputTokens += r.inputTokens ?? 0; row.outputTokens += r.outputTokens ?? 0; row.loggedUsd += r.costUsd ?? 0;
    byKey.set(key, row);
    const d = byDay.get(dayOf(r.at)) ?? { inputTokens: 0, outputTokens: 0, threads: 0 };
    d.inputTokens += r.inputTokens ?? 0; d.outputTokens += r.outputTokens ?? 0; d.threads += threadsOf(r);
    byDay.set(dayOf(r.at), d);
  }
  const providers = [...byKey.values()].map(p => {
    const estimate = usd(p.inputTokens, p.outputTokens, prices[p.provider as Provider]);
    // API keys: the provider's own logged cost when there is one, else the price table. Subscription: included,
    // shown with what the same tokens would cost on the API.
    const spendUsd = p.billing === "subscription" ? 0 : p.loggedUsd > 0 ? p.loggedUsd : estimate;
    return { ...p, perChat: p.threads ? { in: Math.round(p.inputTokens / p.threads), out: Math.round(p.outputTokens / p.threads) } : null,
      price: prices[p.provider as Provider], spendUsd, spendSource: p.billing === "subscription" ? "subscription" : p.loggedUsd > 0 ? "logged" : "estimate",
      apiEquivalentUsd: estimate };
  }).sort((a, b) => b.inputTokens - a.inputTokens);

  // Every day of the range, zeros included, so the chart's gaps are real gaps.
  const first = from ?? [...byDay.keys()].sort()[0] ?? today;
  const days: { day: string; inputTokens: number; outputTokens: number; threads: number }[] = [];
  for (let d = first; d <= today && days.length < 400; d = addDays(d, 1)) days.push({ day: d, ...(byDay.get(d) ?? { inputTokens: 0, outputTokens: 0, threads: 0 }) });

  const tokenLines = lines.filter(l => l.stage === "tokens" && !l.dryRun && inRange(l.at));
  const allTokenLines = lines.filter(l => l.stage === "tokens" && !l.dryRun);
  const bySource = new Map<string, { source: string; label: string; threads: number; inputTokens: number; outputTokens: number }>();
  for (const l of tokenLines) {
    const id = sourceOf(l), row = bySource.get(id) ?? { source: id, label: SOURCE_LABEL[id], threads: 0, inputTokens: 0, outputTokens: 0 };
    row.threads++; row.inputTokens += Number(l.inputTokens ?? 0); row.outputTokens += Number(l.outputTokens ?? 0);
    bySource.set(id, row);
  }
  const totals = providers.reduce((t, p) => ({ runs: t.runs + p.runs, threads: t.threads + p.threads, inputTokens: t.inputTokens + p.inputTokens,
    outputTokens: t.outputTokens + p.outputTokens, spendUsd: t.spendUsd + p.spendUsd, apiEquivalentUsd: t.apiEquivalentUsd + (p.billing === "subscription" ? p.apiEquivalentUsd : 0) }),
    { runs: 0, threads: 0, inputTokens: 0, outputTokens: 0, spendUsd: 0, apiEquivalentUsd: 0 });
  return {
    range: opts.range, from: from ?? first, to: today, totals,
    perChat: totals.threads ? { in: Math.round(totals.inputTokens / totals.threads), out: Math.round(totals.outputTokens / totals.threads) } : null,
    providers, days,
    sources: [...bySource.values()].sort((a, b) => b.inputTokens - a.inputTokens),
    sourcesFrom: allTokenLines.length ? dayOf(allTokenLines.map(l => l.at).sort()[0]) : null,
  };
}

/** Work still waiting: distinct threads in the queue plus ChatGPT chats listed but not read yet. */
export function backlog(state: Pick<State, "queue" | "cursors">) {
  const queuedThreads = new Set(state.queue.map(i => i.threadId)).size;
  let chatgptPending = 0;
  try { chatgptPending = (JSON.parse(state.cursors[CHATGPT_FEED] ?? "{}").pending ?? []).length; } catch { /* not a ChatGPT cursor */ }
  return { queuedThreads, chatgptPending, threads: queuedThreads + chatgptPending };
}

/** "≈ X M tokens / ≈ Y hours left" for the backlog at the current pace. */
export function projection(state: Pick<State, "queue" | "cursors">, perChat: { in: number; out: number }, threadsPerRun: number, intervalMinutes = 15) {
  const b = backlog(state);
  return { ...b, inputTokens: b.threads * perChat.in, outputTokens: b.threads * perChat.out,
    hours: Math.round(Math.ceil(b.threads / Math.max(1, threadsPerRun)) * intervalMinutes / 60 * 10) / 10 };
}

export function usageReport(lines: Record<string, any>[], state: Pick<State, "queue" | "cursors">, cfg: Config, range: Range, opts: { now?: number; pricesFile?: string } = {}) {
  const { prices, edited } = readPrices(opts.pricesFile);
  const perChat = perChatFromLogs(lines);
  return { ...aggregateUsage(lines, { range, now: opts.now, prices }), prices, pricesEdited: edited, defaults: DEFAULT_PRICES,
    writer: { provider: cfg.provider ?? "codex", label: PROVIDER_LABEL[(cfg.provider ?? "codex") as Provider] },
    projection: { ...projection(state, perChat, cfg.maxThreadsPerRun), perChat } };
}
