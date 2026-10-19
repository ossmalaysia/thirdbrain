// Portal Entities page: the entity pages (inbox/entities/) as a list, one page with its notes, the possible duplicates
// to review, and the owner's decisions (merge / not the same) written to the vault's merge list. A merge takes effect
// with an entities rebuild (createMergeApplier), which waits for a running sync because both write notes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENTITY_DIR, KIND_DIR, parseEntityPage, type EntityKind } from "./core/entities.ts";
import { duplicatePairs, loadMerges, saveMerges, type DuplicatePair } from "./core/entity-merges.ts";

export const ENTITY_KINDS = Object.keys(KIND_DIR) as EntityKind[];
const SAFE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export interface EntityRow { kind: EntityKind; slug: string; name: string; detail: string; org: string; notes: number; last: string | null; aliases: string[]; email?: string }
export interface EntityNote { date: string; path: string; title: string }

export function readKind(root: string, kind: EntityKind): { row: EntityRow; notes: EntityNote[] }[] {
  const dir = join(root, ENTITY_DIR, KIND_DIR[kind]);
  if (!existsSync(dir)) return [];
  const out: { row: EntityRow; notes: EntityNote[] }[] = [];
  for (const f of readdirSync(dir)) {
    const slug = f.slice(0, -3);
    if (!f.endsWith(".md") || !SAFE.test(slug)) continue;
    const e = parseEntityPage(kind, slug, readFileSync(join(dir, f), "utf8"));
    if (!e) continue;
    const notes = [...e.notes.values()].sort((a, b) => b.date.localeCompare(a.date)).map(n => ({ date: n.date, path: `${n.slug}.md`, title: n.title }));
    const org = e.org ?? (e.company ? e.company.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ") : "");
    const detail = [...new Set([e.role, org].filter(Boolean))].join(", "); // role and organisation can be the same text
    out.push({ row: { kind, slug, name: e.name, detail, org, notes: e.notes.size + e.extraCount, last: notes[0]?.date ?? null, aliases: e.aliases, ...(e.email ? { email: e.email } : {}) }, notes });
  }
  return out;
}

/** Entity pages, read again when a folder changes (a page added, removed or replaced) or after 30 seconds. */
export function createEntityIndex(root: () => string, ttlMs = 30_000) {
  let hit: { key: string; at: number; data: Map<EntityKind, { row: EntityRow; notes: EntityNote[] }[]> } | null = null;
  const load = () => {
    const r = root();
    const key = r + ENTITY_KINDS.map(k => { try { return statSync(join(r, ENTITY_DIR, KIND_DIR[k])).mtimeMs; } catch { return 0; } }).join("|");
    if (!hit || hit.key !== key || Date.now() - hit.at > ttlMs) hit = { key, at: Date.now(), data: new Map(ENTITY_KINDS.map(k => [k, readKind(r, k)])) };
    return hit.data;
  };
  return {
    list(kind: EntityKind) {
      const data = load();
      return { counts: Object.fromEntries(ENTITY_KINDS.map(k => [k, data.get(k)!.length])), items: data.get(kind)!.map(x => x.row) };
    },
    detail(kind: EntityKind, slug: string) { return load().get(kind)?.find(x => x.row.slug === slug) ?? null; },
    duplicates(): DuplicatePair[] {
      const pages = ENTITY_KINDS.flatMap(k => load().get(k)!.map(({ row }) => ({ kind: k, slug: row.slug, name: row.name, notes: row.notes, ...(row.email ? { email: row.email } : {}) })));
      return duplicatePairs(pages, loadMerges(root()));
    },
    reset() { hit = null; },
  };
}
export type EntityIndex = ReturnType<typeof createEntityIndex>;

const pagePath = (root: string, kind: EntityKind, slug: string) => join(root, ENTITY_DIR, KIND_DIR[kind], `${slug}.md`);
function checkPair(root: string, kind: unknown, a: unknown, b: unknown): asserts kind is EntityKind {
  if (!ENTITY_KINDS.includes(kind as EntityKind)) throw new Error("Unknown entity type.");
  if (typeof a !== "string" || typeof b !== "string" || !SAFE.test(a) || !SAFE.test(b) || a === b) throw new Error("Choose two different entity pages.");
  if (!existsSync(pagePath(root, kind as EntityKind, a)) || !existsSync(pagePath(root, kind as EntityKind, b))) throw new Error("One of these pages no longer exists. Reload the page.");
}

/** Records "merge `from` into `to`" (the owner's decision). The pages change at the next entities rebuild. */
export function recordMerge(root: string, input: { kind?: unknown; from?: unknown; to?: unknown }): { from: string; to: string } {
  checkPair(root, input.kind, input.from, input.to);
  const kind = input.kind, from = input.from as string, to = input.to as string;
  const page = parseEntityPage(kind, from, readFileSync(pagePath(root, kind, from), "utf8"));
  if (!page) throw new Error("That page is not one Third Brain keeps.");
  const m = loadMerges(root);
  m.merges = m.merges.filter(x => !(x.kind === kind && x.from === from));
  m.merges.push({ kind, from, to, name: page.name, keys: page.keys, aliases: page.aliases, by: "user", at: new Date().toISOString().slice(0, 10) });
  m.distinct = m.distinct.filter(d => !(d.kind === kind && ((d.a === from && d.b === to) || (d.a === to && d.b === from))));
  m.strip = m.strip?.filter(x => !(x.kind === kind && x.from === from));
  saveMerges(root, m);
  return { from, to };
}

/** Records "these two are not the same": never suggested or merged automatically again. */
export function recordDistinct(root: string, input: { kind?: unknown; a?: unknown; b?: unknown }): void {
  checkPair(root, input.kind, input.a, input.b);
  const m = loadMerges(root), kind = input.kind, a = input.a as string, b = input.b as string;
  if (!m.distinct.some(d => d.kind === kind && ((d.a === a && d.b === b) || (d.a === b && d.b === a)))) m.distinct.push({ kind, a, b, at: new Date().toISOString().slice(0, 10) });
  saveMerges(root, m);
}

/** Runs `entities rebuild` after merges; a running sync holds the lock, so it tries again every minute (up to 3 hours). */
export function createMergeApplier(run: (opts: { judge?: boolean }) => Promise<{ code: number; out: string }>, sleep = (ms: number) => Bun.sleep(ms), tries = 180) {
  let state: { pending: boolean; running: boolean; lastResult: string | null; lastAt: string | null } = { pending: false, running: false, lastResult: null, lastAt: null };
  let judge = false;
  async function loop() {
    state.running = true;
    try {
      for (let i = 0; state.pending && i < tries; i++) {
        state.pending = false;
        const withJudge = judge; judge = false;
        state.lastResult = withJudge ? "Checking duplicates with the model." : "Applying merges.";
        const r = await run({ judge: withJudge }).catch(e => ({ code: -1, out: String(e) }));
        if (r.code === 0) { state.lastResult = "Merges applied."; state.lastAt = new Date().toISOString(); continue; }
        state.pending = true;
        state.lastResult = /sync is running/i.test(r.out) ? "Waiting for the current sync run to finish." : "The rebuild failed; it tries again in a minute.";
        await sleep(60_000);
      }
    } finally { state.running = false; }
  }
  return {
    status: () => ({ ...state }),
    request(opts: { judge?: boolean } = {}) { if (opts.judge) judge = true; state.pending = true; if (!state.running) void loop(); },
  };
}

/** Undoes a merge (usually one the model made): the pair becomes "not the same" and the other page is built again
 *  from its notes at the next rebuild (its names and keys leave the page that stayed). */
export function undoMerge(root: string, input: { kind?: unknown; from?: unknown; to?: unknown }): void {
  if (!ENTITY_KINDS.includes(input.kind as EntityKind) || typeof input.from !== "string" || typeof input.to !== "string") throw new Error("Choose a merge to undo.");
  const kind = input.kind as EntityKind, m = loadMerges(root);
  const entry = m.merges.find(x => x.kind === kind && x.from === input.from && x.to === input.to);
  if (!entry) throw new Error("That merge is not in the list any more.");
  m.merges = m.merges.filter(x => x !== entry);
  m.strip = [...(m.strip ?? []).filter(x => !(x.kind === kind && x.from === entry.from)), { kind, from: entry.from, to: entry.to, name: entry.name, keys: entry.keys, aliases: entry.aliases }];
  if (!m.distinct.some(d => d.kind === kind && ((d.a === entry.from && d.b === entry.to) || (d.a === entry.to && d.b === entry.from)))) m.distinct.push({ kind, a: entry.to, b: entry.from, at: new Date().toISOString().slice(0, 10), by: "user" });
  saveMerges(root, m);
}

/** Merges and "not the same" decisions made automatically (model and same-name rule), newest first, for review. */
export function automaticDecisions(root: string) {
  const m = loadMerges(root);
  return [
    ...m.merges.filter(x => x.by !== "user").map(x => ({ type: "merge" as const, kind: x.kind, from: x.from, to: x.to, name: x.name, by: x.by, p: x.p ?? null, at: x.at })),
    ...m.distinct.filter(x => x.by === "model").map(x => ({ type: "distinct" as const, kind: x.kind, from: x.b, to: x.a, name: x.b, by: "model" as const, p: x.p ?? null, at: x.at })),
  ].sort((a, b) => b.at.localeCompare(a.at) || a.from.localeCompare(b.from));
}
