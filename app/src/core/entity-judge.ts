// Duplicate check: a model scores each possible duplicate pair (core/entity-merges.ts duplicatePairs) as
// P(same real-world entity), from both names, their aliases, addresses, organisations and the titles of their notes.
// Clear answers are applied without a question; only the unclear middle goes to the owner's review:
//   P >= SAME_AT (80%) -> merge ("by: model", undo on the Entities page)
//   P <= DIFFERENT_AT  -> not the same
// The decision model (TypeSafe Jev) answers when it is set up: it returns a calibrated probability. Otherwise the
// note writer LLM gives its own probability. No vault text beyond names and note titles is sent.
import { typesafeAsk } from "./decision.ts";
import type { JsonAsk } from "./providers.ts";

export const SAME_AT = 0.8, DIFFERENT_AT = 0.1; // owner's choice 2026-10-18: merge from 80%
const KIND_WORD: Record<string, string> = { person: "person", company: "company or organisation", project: "project", topic: "topic" };

export interface Side { slug: string; name: string; aliases: string[]; email?: string; org?: string; notes: number; titles: string[] }
export interface PairEvidence { kind: string; a: Side; b: Side; shared: number }
export interface Judgement { p: number; by: "decision-model" | "llm"; model: string; first?: number }
export type Judge = (e: PairEvidence) => Promise<Judgement>;

const side = (label: string, s: Side) => [
  `${label}: "${s.name}"${s.aliases.length ? ` (also written: ${s.aliases.slice(0, 5).map(a => `"${a}"`).join(", ")})` : ""}`,
  ...(s.email ? [`  e-mail: ${s.email}`] : []), ...(s.org ? [`  organisation: ${s.org}`] : []),
  `  ${s.notes} notes; newest titles:`, ...s.titles.slice(0, 6).map(t => `  - ${t}`),
].join("\n");

/** The text both judges see: the owner's notes name two entities; are they one? */
export function pairState(e: PairEvidence): string {
  return [`Two ${KIND_WORD[e.kind] ?? e.kind} pages in one person's work notes. The names were written by an AI note writer, so the same ${e.kind} can appear under a short name, a spelling variant or with a division or country added.`,
    side("A", e.a), side("B", e.b), `Notes that name both A and B: ${e.shared}.`].join("\n\n");
}

const question = (kind: string) => `A and B are the same real-world ${KIND_WORD[kind] ?? kind} (the same client, person or project under two names), not two different ones`;

export function typesafeJudge(key: string, model: string, fetchImpl: typeof fetch = fetch): Judge {
  return async e => {
    const r = await typesafeAsk(key, pairState(e), { same: { type: "noul", instructions: question(e.kind) } }, model, fetchImpl);
    const a = r.answers.same;
    if (a?.type !== "noul" || !Number.isFinite(a.noul)) throw new Error("The decision model gave no answer for this pair.");
    return { p: a.noul, by: "decision-model", model: r.model };
  };
}

const SCHEMA = { type: "object", additionalProperties: false, required: ["probability_same", "reason"],
  properties: { probability_same: { type: "number" }, reason: { type: "string" } } };

export function llmJudge(ask: JsonAsk): Judge {
  return async e => {
    const { value, model } = await ask(
      `You decide if two entity pages name the same thing. Answer with probability_same between 0 and 1: ${question(e.kind)}. Use about 0.5 when the evidence does not decide it. A first name alone and a full name are the same person only when the notes point to it. A company and a company with a different business line added can be two legal companies.`,
      pairState(e), SCHEMA, "same_entity");
    const p = Number((value as { probability_same?: unknown })?.probability_same);
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error("The LLM gave no probability for this pair.");
    return { p, by: "llm", model };
  };
}

export const verdict = (p: number): "merge" | "distinct" | "review" => p >= SAME_AT ? "merge" : p <= DIFFERENT_AT ? "distinct" : "review";

/** The decision model first (fast, cheap); when it is not sure, the LLM's answer decides (it keeps the first score). */
export function cascadeJudge(first: Judge, second: Judge): Judge {
  return async e => {
    const a = await first(e);
    if (verdict(a.p) !== "review") return a;
    const b = await second(e);
    return { ...b, first: a.p };
  };
}
