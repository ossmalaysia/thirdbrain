// Related notes: each connector note links the few other notes closest to it in meaning, as `## Related notes`
// wikilinks (Obsidian draws them; GBrain reads them as links). The vectors come from the same local Ollama model GBrain
// embeds with (nomic-embed-text), over the note's title and summary only. GBrain's own search does not return a score
// over MCP, so it cannot tell "similar" from "the best of nothing"; a fixed cosine floor can. Calibrated 2026-10-18 on
// 500 notes: pairs >= 0.85 were the same subject, 0.80-0.85 mostly the same client, < 0.80 often unrelated
// (1% of random pairs score >= 0.80). No AI tokens: Ollama runs on this computer.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicJson, readJson } from "../../docker/scheduler.mjs";

export const RELATED_MODEL = "nomic-embed-text";
export const RELATED_MIN = 0.82, RELATED_MAX = 3;
const SECTION = "Related notes";
const MAX_TEXT = 2000, BATCH = 32;

export interface NoteDoc { slug: string; title: string; text: string; personal: boolean }

/** Title and summary of a connector note (what it is about), or null for a file without frontmatter. */
export function noteDoc(relPath: string, content: string): NoteDoc | null {
  const text = content.replace(/\r\n/g, "\n");
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if (!fm || !relPath.endsWith(".md")) return null;
  let title = fm.match(/^title:[ \t]*(.*)$/m)?.[1]?.trim() ?? "";
  try { if (title.startsWith('"')) title = JSON.parse(title); } catch { /* keep as written */ }
  title ||= relPath.split("/").pop()!.slice(0, -3);
  const summary = text.match(/\n## Summary\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
  let tags: unknown = [];
  try { tags = JSON.parse(fm.match(/^tags:[ \t]*(\[.*\])[ \t]*$/m)?.[1] ?? "[]"); } catch { /* no tags */ }
  const personal = Array.isArray(tags) && tags.some(t => t === "personal" || String(t).startsWith("personal/"));
  return { slug: relPath.slice(0, -3), title, text: `${title}\n${summary}`.slice(0, MAX_TEXT), personal };
}

// ---------- vectors ----------

/** Per note: text hash, unit vector (base64 Float32), title, and `p` for personal notes (never linked). */
export interface VectorCache { model: string; items: Record<string, { h: string; v: string; t: string; p?: 1 }> }
export const loadVectors = (file: string): VectorCache => {
  const c = readJson(file, null) as VectorCache | null;
  return c?.model === RELATED_MODEL && c.items ? c : { model: RELATED_MODEL, items: {} };
};
export const saveVectors = (file: string, c: VectorCache) => atomicJson(file, c);
const textHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const encode = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
const decode = (s: string) => { const b = Buffer.from(s, "base64"); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };

/** Ollama's address: OLLAMA_BASE_URL, else GBrain's configured Ollama URL, else the default port. */
export function ollamaBaseUrl(): string {
  const fromEnv = process.env.OLLAMA_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  try {
    const f = join(homedir(), ".gbrain", "config.json");
    const url = existsSync(f) ? JSON.parse(readFileSync(f, "utf8"))?.provider_base_urls?.ollama : null;
    if (typeof url === "string" && url) return url.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  } catch { /* fall through */ }
  return "http://127.0.0.1:11434";
}

export type Embed = (texts: string[]) => Promise<Float32Array[]>;
/** Unit vectors from Ollama (`search_document:` is the model's prefix for stored texts). */
export function ollamaEmbed(baseUrl = ollamaBaseUrl(), fetchImpl: typeof fetch = fetch): Embed {
  return async texts => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const r = await fetchImpl(`${baseUrl}/api/embed`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: RELATED_MODEL, input: texts.slice(i, i + BATCH).map(t => `search_document: ${t}`) }), signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`Ollama embedding failed (HTTP ${r.status}). Check that Ollama runs and has ${RELATED_MODEL}.`);
      const j = await r.json() as { embeddings?: number[][] };
      if (!Array.isArray(j.embeddings) || j.embeddings.length !== Math.min(BATCH, texts.length - i)) throw new Error("Ollama gave an unexpected embedding response.");
      for (const e of j.embeddings) { const n = Math.hypot(...e) || 1; out.push(Float32Array.from(e, x => x / n)); }
    }
    return out;
  };
}

/** Embeds the docs whose text changed since the cache was written; drops notes that no longer exist when `all`. */
export async function refreshVectors(cache: VectorCache, docs: NoteDoc[], embed: Embed, opts: { all: boolean }): Promise<number> {
  const stale = docs.filter(d => cache.items[d.slug]?.h !== textHash(d.text));
  const vecs = stale.length ? await embed(stale.map(d => d.text)) : [];
  stale.forEach((d, i) => { cache.items[d.slug] = { h: textHash(d.text), v: encode(vecs[i]), t: d.title }; });
  for (const d of docs) { const it = cache.items[d.slug]; it.t = d.title; if (d.personal) it.p = 1; else delete it.p; }
  if (opts.all) { const keep = new Set(docs.map(d => d.slug)); for (const k of Object.keys(cache.items)) if (!keep.has(k)) delete cache.items[k]; }
  return stale.length;
}

export const vectorsOf = (cache: VectorCache) => new Map(Object.entries(cache.items).map(([k, x]) => [k, decode(x.v)] as const));

/** The closest other notes at or above `min`, best first. `skip`: notes never linked (personal ones). */
export function relatedFor(slug: string, vectors: Map<string, Float32Array>, skip: Set<string>, min = RELATED_MIN, max = RELATED_MAX): { slug: string; score: number }[] {
  const v = vectors.get(slug);
  if (!v) return [];
  const out: { slug: string; score: number }[] = [];
  for (const [other, w] of vectors) {
    if (other === slug || skip.has(other)) continue;
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * w[i];
    if (s >= min) out.push({ slug: other, score: s });
  }
  return out.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug)).slice(0, max);
}

// ---------- the note section ----------

const label = (s: string) => s.replace(/[[\]|\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/** Writes (or removes, for an empty list) the `## Related notes` section, just before `## Links`. Idempotent. */
export function applyRelated(content: string, related: { slug: string; title: string }[]): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex(l => l.trim() === `## ${SECTION}`);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^##? /.test(lines[end])) end++;
    lines.splice(start, end - start);
  }
  if (related.length) {
    const block = [`## ${SECTION}`, ...related.map(r => `- [[${r.slug}|${label(r.title) || r.slug.split("/").pop()}]]`), ""];
    const links = lines.findIndex(l => l.trim() === "## Links");
    if (links >= 0) lines.splice(links, 0, ...block);
    else { while (lines.length && lines.at(-1) === "") lines.pop(); lines.push("", ...block); }
  }
  const out = lines.join("\n");
  return eol === "\n" ? out : out.replace(/\n/g, eol);
}

/** Links every target note (already in the cache) to its related notes; returns each target's new content and its
 *  link count. Personal notes get no links and are never linked. */
export function linkRelated(targets: { relPath: string; content: string }[], cache: VectorCache): { relPath: string; content: string; links: number }[] {
  const vectors = vectorsOf(cache);
  const skip = new Set(Object.entries(cache.items).filter(([, x]) => x.p).map(([k]) => k));
  const out: { relPath: string; content: string; links: number }[] = [];
  for (const t of targets) {
    const slug = t.relPath.slice(0, -3), item = cache.items[slug];
    if (!item) continue;
    const list = item.p ? [] : relatedFor(slug, vectors, skip).map(r => ({ slug: r.slug, title: cache.items[r.slug]?.t || r.slug }));
    const content = applyRelated(t.content, list);
    out.push({ relPath: t.relPath, content, links: list.length });
  }
  return out;
}
