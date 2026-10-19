// Decision model: a fast model that answers narrow, typed questions (keep or skip, which client, related or not)
// so the note writer (an LLM) only runs on what is worth keeping. First provider: TypeSafe Jev (System One model).
// API: POST https://api.typesafe.ai/v1/systemone, Bearer key, { state, model, questions } -> { model, answers, usage }.
// Design: docs/decision-model.md.

export type DecisionProvider = "off" | "typesafe";
export const DECISION_PROVIDERS: DecisionProvider[] = ["off", "typesafe"];
export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };
export interface DecisionResult { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number }; ms: number }

/** One call: every question is answered against the same state, in parallel. */
export async function typesafeAsk(key: string, state: string | object, questions: Record<string, Question>, model = TYPESAFE_DEFAULT_MODEL, fetchImpl: typeof fetch = fetch): Promise<DecisionResult> {
  const started = performance.now();
  let r: Response;
  try {
    r = await fetchImpl(TYPESAFE_URL, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ state, model: model || TYPESAFE_DEFAULT_MODEL, questions }), signal: AbortSignal.timeout(30_000) });
  } catch (e) { throw new Error(`TypeSafe did not answer (${e instanceof Error ? e.name : "network error"}).`); }
  if (r.status === 401 || r.status === 403) throw new Error("TypeSafe rejected the API key. Check the key in the TypeSafe console.");
  if (r.status === 429) throw new Error("TypeSafe rate limit reached. Try again in a minute.");
  if (!r.ok) {
    const detail = await r.text().then(t => t.slice(0, 200)).catch(() => "");
    throw new Error(`TypeSafe request failed (HTTP ${r.status})${detail ? `: ${detail.replace(/\s+/g, " ")}` : ""}`);
  }
  const body = await r.json() as Partial<DecisionResult>;
  if (!body.answers || typeof body.answers !== "object") throw new Error("TypeSafe returned an unexpected response.");
  return { model: String(body.model ?? model), answers: body.answers, usage: body.usage ?? { input_tokens: 0, output_tokens: 0 }, ms: Math.round(performance.now() - started) };
}

/** Shadow-test questions: the note writer's keep/skip rule and its personal-matter rule, as two yes/no questions. */
export const TRIAGE_QUESTIONS: Record<string, Question> = {
  keep: { type: "noul", instructions: "This conversation holds a decision, commitment, plan, price, deadline, or other fact that the owner would want to remember in a month (not automated or bulk mail, a receipt, a one-line acknowledgement, scheduling with no outcome, a quick lookup or trivia)" },
  personal: { type: "noul", instructions: "This conversation is about a personal or family matter (health, children, family finances, relationships, private life)" },
};
export const MAX_SHADOW_STATE = 12_000; // characters of conversation sent per thread

export interface ShadowAnswer { pKeep: number; pPersonal: number; ms: number; inputTokens: number; model: string }

/** Skip thresholds. Conservative on purpose: a wrong skip loses a note, a wrong keep only costs tokens.
 *  The setup test returned P(keep) = 0.40 for an obvious receipt, so Jev is cautious; only clear cases skip. */
export const SKIP_BELOW_KEEP = 0.15, SKIP_ABOVE_PERSONAL = 0.85;

/** Triage decision from the two answers. Missing answers never skip. */
export function triageDecision(a: Pick<ShadowAnswer, "pKeep" | "pPersonal">, skipBelow = SKIP_BELOW_KEEP, personalAbove = SKIP_ABOVE_PERSONAL): { skip: boolean; reason: string } {
  if (Number.isFinite(a.pPersonal) && a.pPersonal >= personalAbove) return { skip: true, reason: "personal" };
  if (Number.isFinite(a.pKeep) && a.pKeep < skipBelow) return { skip: true, reason: "not-worth-keeping" };
  return { skip: false, reason: Number.isFinite(a.pKeep) ? "uncertain-or-keep" : "no-answer" };
}

/** Asks the triage questions about one conversation. `state` is the same text the note writer reads. */
export async function shadowTriage(key: string, state: string, model = TYPESAFE_DEFAULT_MODEL, fetchImpl: typeof fetch = fetch): Promise<ShadowAnswer> {
  const r = await typesafeAsk(key, state.length > MAX_SHADOW_STATE ? `${state.slice(0, MAX_SHADOW_STATE)}\n[truncated]` : state, TRIAGE_QUESTIONS, model, fetchImpl);
  const p = (id: string) => { const a = r.answers[id]; return a?.type === "noul" && Number.isFinite(a.noul) ? a.noul : NaN; };
  return { pKeep: p("keep"), pPersonal: p("personal"), ms: r.ms, inputTokens: r.usage.input_tokens, model: r.model };
}

/** Setup check: one harmless question with a known answer. No user data is sent. */
export async function testTypesafe(key: string, model = TYPESAFE_DEFAULT_MODEL, fetchImpl: typeof fetch = fetch): Promise<{ message: string; result: DecisionResult }> {
  const result = await typesafeAsk(key, "Subject: Your receipt for order #1042. Thank you for your purchase. This email is an automated receipt.",
    { worth_keeping: { type: "noul", instructions: "This message holds a decision, commitment or fact worth remembering in a month" } }, model, fetchImpl);
  const a = result.answers.worth_keeping;
  const p = a && a.type === "noul" ? a.noul : NaN;
  const verdict = Number.isFinite(p) ? (p < 0.5 ? "correct: an automated receipt is not worth keeping" : "unexpected: it marked a receipt as worth keeping") : "no answer";
  return { result, message: `Connected to ${result.model} in ${result.ms} ms. Test question: P(worth keeping) = ${Number.isFinite(p) ? p.toFixed(2) : "?"} (${verdict}). ${result.usage.input_tokens} tokens in.` };
}
