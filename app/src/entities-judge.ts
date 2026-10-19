// `entities judge`: the decision model (or the note writer LLM) scores each possible duplicate pair; clear answers
// become merges or "not the same" in the vault's merge list (core/entity-judge.ts thresholds), the rest wait for the
// owner on the Entities page. Answers are cached per pair, so each pair costs one question. Writes only merges.json;
// the entities rebuild (next Dream step, or the portal) applies the merges to pages and notes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENTITY_DIR, KIND_DIR, parseEntityPage, type EntityKind } from "./core/entities.ts";
import { atomicJson, readJson } from "../docker/scheduler.mjs";
import { ENTITY_KINDS, readKind } from "./entities-view.ts";
import { duplicatePairs, loadMerges, saveMerges, type MergeKind } from "./core/entity-merges.ts";
import { verdict, type Judge, type Judgement, type PairEvidence, type Side } from "./core/entity-judge.ts";
import { STATE_DIR } from "./state.ts";

export const JUDGEMENTS_FILE = () => join(STATE_DIR, "entity-judgements.json");
export const MAX_QUESTIONS = 150;
export const pairKey = (kind: string, a: string, b: string) => `${kind}/${[a, b].sort().join("|")}`;
export type Judgements = Record<string, Judgement & { at: string }>;
export const loadJudgements = (file = JUDGEMENTS_FILE()): Judgements => readJson(file, {}) ?? {};

export interface JudgeReport { pairs: number; asked: number; cached: number; merged: number; distinct: number; review: number; failed: number; judge: string | null }

export async function judgeDuplicates(root: string, judge: Judge, opts: { file?: string; limit?: number; dryRun?: boolean } = {}): Promise<JudgeReport> {
  const file = opts.file ?? JUDGEMENTS_FILE(), cache = loadJudgements(file), today = new Date().toISOString().slice(0, 10);
  const pages = new Map<string, { side: Side; noteSlugs: Set<string> }>();
  for (const kind of ENTITY_KINDS) for (const { row, notes } of readKind(root, kind))
    pages.set(`${kind}/${row.slug}`, { side: { slug: row.slug, name: row.name, aliases: row.aliases, ...(row.email ? { email: row.email } : {}), ...(row.org ? { org: row.org } : {}), notes: row.notes, titles: notes.map(n => n.title) },
      noteSlugs: new Set(notes.map(n => n.path)) });
  const merges = loadMerges(root);
  const pairs = duplicatePairs([...pages.entries()].map(([k, v]) => ({ kind: k.split("/")[0] as MergeKind, slug: v.side.slug, name: v.side.name, notes: v.side.notes, ...(v.side.email ? { email: v.side.email } : {}) })), merges);
  const report: JudgeReport = { pairs: pairs.length, asked: 0, cached: 0, merged: 0, distinct: 0, review: 0, failed: 0, judge: null };
  const gone = new Set<string>(); // pages merged away in this run: their other pairs wait for the next run
  for (const pair of pairs) {
    const a = pages.get(`${pair.kind}/${pair.keep.slug}`)!, b = pages.get(`${pair.kind}/${pair.merge.slug}`)!;
    if (gone.has(`${pair.kind}/${pair.keep.slug}`) || gone.has(`${pair.kind}/${pair.merge.slug}`)) continue;
    const key = pairKey(pair.kind, pair.keep.slug, pair.merge.slug);
    let j: Judgement | undefined = cache[key];
    if (j) report.cached++;
    else {
      if (report.asked >= (opts.limit ?? MAX_QUESTIONS)) { report.review++; continue; }
      const evidence: PairEvidence = { kind: pair.kind, a: a.side, b: b.side, shared: [...a.noteSlugs].filter(n => b.noteSlugs.has(n)).length };
      try { j = await judge(evidence); report.asked++; cache[key] = { ...j, at: today }; }
      catch { report.failed++; continue; }
    }
    report.judge = j.first !== undefined ? `decision model, then LLM ${j.model}` : `${j.by === "decision-model" ? "decision model" : "LLM"} ${j.model}`;
    const v = verdict(j.p), judgeName = `${j.by}:${j.model}`;
    if (v === "merge") {
      let keys: string[] = [];
      try { keys = parseEntityPage(pair.kind as EntityKind, pair.merge.slug, readFileSync(join(root, ENTITY_DIR, KIND_DIR[pair.kind as EntityKind], `${pair.merge.slug}.md`), "utf8"))?.keys ?? []; } catch { /* no keys */ }
      merges.merges.push({ kind: pair.kind, from: pair.merge.slug, to: pair.keep.slug, name: b.side.name, keys, aliases: b.side.aliases, by: "model", at: today, p: j.p, judge: judgeName });
      merges.strip = merges.strip?.filter(x => !(x.kind === pair.kind && x.from === pair.merge.slug));
      gone.add(`${pair.kind}/${pair.merge.slug}`); report.merged++;
    } else if (v === "distinct") {
      merges.distinct.push({ kind: pair.kind, a: pair.keep.slug, b: pair.merge.slug, at: today, by: "model", p: j.p, judge: judgeName }); report.distinct++;
    } else report.review++;
  }
  if (!opts.dryRun) { atomicJson(file, cache); if (report.merged || report.distinct) saveMerges(root, merges); }
  return report;
}
