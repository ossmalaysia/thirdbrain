// Entity merges: which entity pages are the same person, company or project. The note writer names the same client in
// different ways ("Acme Lux", "ACMELUX", "Acmelux Media"), and each spelling became its own page. Two kinds of merge:
//  - auto: names equal after removing spaces, dashes, dots and (companies/projects) a final "s". Safe; no question.
//  - user: chosen on the portal's Entities page ("Merge" / "Not the same"). "Acme Lux" vs "Acme Lux Trading" can be one
//    client or two legal companies; only the owner knows.
// The list lives in the vault next to the pages (committed and backed up with them), so every rebuild and every
// machine resolves names the same way, and a merged spelling never comes back as a new page.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type MergeKind = "person" | "company" | "project" | "topic";
export const MERGES_FILE = "inbox/entities/merges.json";

/** `by`: auto (same name without spaces/dashes), user (Entities page), model (decision model or LLM, with its `p`). */
export interface MergeEntry { kind: MergeKind; from: string; to: string; name: string; keys: string[]; aliases: string[]; by: "auto" | "user" | "model"; at: string; p?: number; judge?: string }
export interface DistinctEntry { kind: MergeKind; a: string; b: string; at: string; by?: "user" | "model"; p?: number; judge?: string }
/** An undone merge: these names and keys leave the page that stayed, so the other page is built again from its notes. */
export interface StripEntry { kind: MergeKind; from: string; to: string; name: string; keys: string[]; aliases: string[] }
export interface Merges { merges: MergeEntry[]; distinct: DistinctEntry[]; strip?: StripEntry[] }

const SAFE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const KINDS = new Set<MergeKind>(["person", "company", "project", "topic"]);

export function loadMerges(root: string): Merges {
  try {
    const raw = JSON.parse(readFileSync(join(root, MERGES_FILE), "utf8"));
    const merges = (Array.isArray(raw?.merges) ? raw.merges : []).filter((m: MergeEntry) => KINDS.has(m?.kind) && SAFE.test(m.from) && SAFE.test(m.to) && m.from !== m.to)
      .map((m: MergeEntry) => ({ ...m, keys: Array.isArray(m.keys) ? m.keys.filter(k => typeof k === "string") : [], aliases: Array.isArray(m.aliases) ? m.aliases.filter(a => typeof a === "string") : [], name: typeof m.name === "string" ? m.name : m.from }));
    const distinct = (Array.isArray(raw?.distinct) ? raw.distinct : []).filter((d: DistinctEntry) => KINDS.has(d?.kind) && SAFE.test(d.a) && SAFE.test(d.b));
    const strip = (Array.isArray(raw?.strip) ? raw.strip : []).filter((x: StripEntry) => KINDS.has(x?.kind) && SAFE.test(x.from) && SAFE.test(x.to))
      .map((x: StripEntry) => ({ ...x, keys: Array.isArray(x.keys) ? x.keys : [], aliases: Array.isArray(x.aliases) ? x.aliases : [] }));
    return { merges, distinct, ...(strip.length ? { strip } : {}) };
  } catch { return { merges: [], distinct: [] }; }
}

export function saveMerges(root: string, m: Merges): void {
  const file = join(root, MERGES_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const sorted = {
    merges: [...m.merges].sort((a, b) => a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from)),
    distinct: [...m.distinct].sort((a, b) => a.kind.localeCompare(b.kind) || a.a.localeCompare(b.a) || a.b.localeCompare(b.b)),
    ...(m.strip?.length ? { strip: [...m.strip].sort((a, b) => a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from)) } : {}),
  };
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
}

/** The page a slug ends up on after every merge (chains followed; a cycle stops at the first repeat). */
export function resolveMerge(m: Merges, kind: MergeKind, slug: string): string {
  const seen = new Set<string>();
  let s = slug;
  for (;;) {
    if (seen.has(s)) return s;
    seen.add(s);
    const next = m.merges.find(x => x.kind === kind && x.from === s)?.to;
    if (!next) return s;
    s = next;
  }
}

/** The name with spaces, dashes and dots removed (and a final "s" for companies and projects): equal = same entity. */
export function squashName(kind: MergeKind, name: string): string {
  let k = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, "");
  if (kind !== "person" && k.length > 4) k = k.replace(/s$/, "");
  return k;
}

export const isDistinct = (m: Merges, kind: MergeKind, a: string, b: string) =>
  m.distinct.some(d => d.kind === kind && ((d.a === a && d.b === b) || (d.a === b && d.b === a)));

export interface EntitySummary { kind: MergeKind; slug: string; name: string; notes: number; email?: string }
export interface DuplicatePair { kind: MergeKind; keep: EntitySummary; merge: EntitySummary; reason: string }

/** Possible duplicates for the owner to decide: one name is the start of the other ("Borealis" / "Borealis Malaysia"),
 *  word for word or letter for letter. People only when the shorter one has no other surname and the e-mail addresses
 *  do not differ ("Daniel" / "Daniel Tan", not "Ravi Kumar" / "Ravi Nair"). The page with more notes is kept. */
export function duplicatePairs(pages: EntitySummary[], m: Merges): DuplicatePair[] {
  const out: DuplicatePair[] = [];
  const merged = new Set(m.merges.map(x => `${x.kind}/${x.from}`));
  const byKind = new Map<MergeKind, EntitySummary[]>();
  for (const p of pages) if (p.kind !== "topic") byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]);
  for (const [kind, list] of byKind) {
    for (const a of list) for (const b of list) {
      if (a === b || a.slug.length >= b.slug.length) continue;
      const sa = squashName(kind, a.name), sb = squashName(kind, b.name);
      const wordPrefix = b.slug.startsWith(`${a.slug}-`);
      const letterPrefix = sa.length >= 4 && sb.startsWith(sa) && sa !== sb;
      if (!wordPrefix && !letterPrefix) continue;
      if (kind === "person" && (a.slug.includes("-") || (a.email && b.email && a.email !== b.email))) continue;
      if (isDistinct(m, kind, a.slug, b.slug)) continue;
      if (merged.has(`${kind}/${a.slug}`) || merged.has(`${kind}/${b.slug}`)) continue; // decided; the rebuild has not run yet
      const [keep, merge] = b.notes > a.notes ? [b, a] : [a, b];
      out.push({ kind, keep, merge, reason: wordPrefix ? `"${a.name}" is the start of "${b.name}"` : `"${a.name}" and "${b.name}" begin with the same letters` });
    }
  }
  return out.sort((x, y) => (y.keep.notes + y.merge.notes) - (x.keep.notes + x.merge.notes) || x.keep.slug.localeCompare(y.keep.slug));
}
