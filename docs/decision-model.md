# Decision model provider (design, 2026-10-18)

Third Brain uses an LLM ("note writer") both to **decide** (keep or skip a conversation, which client/project, is it
personal) and to **write** (title, summary, decisions, commitments). Deciding is the expensive part for skipped
conversations: the writer reads the whole thread to answer `keep: false`. A **decision model** answers narrow typed
questions fast and cheaply, so the writer only runs on what is worth keeping.

First provider: **TypeSafe Jev** (System One model: state + typed questions in, typed answers with calibrated
probabilities and confidence out; no text generation; question types Choice, Score, Noul; JS SDK `TypeSafeClient`;
API keys from console.typesafe.ai). Docs: https://docs.typesafe.ai (index: /llms.txt).

## Interface

```ts
interface DecisionModel {
  id: "rules" | "llm" | "typesafe";
  /** One call per thread: all questions are evaluated against the same state, in parallel. */
  decide(state: DecisionState, questions: Question[]): Promise<Answer[]>;
}
type Question =
  | { kind: "noul"; id: string; instruction: string }                         // P(yes)
  | { kind: "choice"; id: string; instruction: string; options: string[] }     // choice + probabilities + confidence
  | { kind: "score"; id: string; instruction: string; levels: string[] };      // ordered rubric
```

Implementations: `rules` (today's filters, free), `llm` (existing providers asked for a JSON answer only),
`typesafe` (Jev). Selected in Settings as **Decision model**, next to **Note writer**; key stored like the other
API keys (outside the vault, never logged).

## Where it is used (each behind a confidence threshold)

| Step | Questions | Acts when |
|---|---|---|
| Triage before extraction | Noul "worth remembering in a month?", Noul "personal/family matter?", Choice source kind | skip only if P(keep) < 0.1 with high confidence; otherwise the writer decides as today |
| Classification | Choice client (from known clients + "other"), Choice project | prefill/verify the writer's client/project |
| Related links | Noul "are these two notes about the same deal/topic?" per candidate pair | link if P >= 0.8 |
| Newest wins | Noul "does note B's figure replace note A's?" | annotate when P >= 0.85 |
| Search re-rank (later) | Score relevance of each candidate to the query | sort |

Uncertain answers (low confidence or middle probabilities) always fall back to the LLM, so quality can only improve
or stay the same.

## Evaluation before switching

The sync's `processed` ledger holds every past keep/skip outcome (~14k messages in the owner's install). Offline A/B:
sample threads with known outcomes, ask Jev the triage questions, report agreement, false skips (the costly error),
latency, cost, and projected token savings; shown on the Usage page. Switch the triage on only when false skips are
below an agreed threshold.

## Privacy

Opt-in per connector. Thread text goes to the decision provider (TypeSafe is a US-hosted service): check its data
retention/training terms before enabling. Credential check and personal-matter rules run locally first.
