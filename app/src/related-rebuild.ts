// `related rebuild [--dry-run]`: links every connector note to its related notes (core/related.ts). The nightly Dream
// runs it, so old notes also link to notes written after them. Reads and writes only the connector's notes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeNotes } from "./core/commit.ts";
import { linkRelated, loadVectors, noteDoc, ollamaEmbed, refreshVectors, saveVectors, type Embed, type NoteDoc } from "./core/related.ts";
import type { Note } from "./types.ts";
import { connectorNotes } from "./entities-rebuild.ts";
import { STATE_DIR } from "./state.ts";

export const VECTORS_FILE = () => join(STATE_DIR, "related-vectors.json");

export interface RelatedReport { dryRun: boolean; notes: number; embedded: number; withRelated: number; links: number; notesChanged: number }

export async function rebuildRelated(root: string, opts: { dryRun: boolean; embed?: Embed; cacheFile?: string }): Promise<RelatedReport> {
  const cacheFile = opts.cacheFile ?? VECTORS_FILE();
  const files = connectorNotes(root).filter(f => !f.startsWith("inbox/entities/"));
  const notes = files.map(relPath => ({ relPath, content: readFileSync(join(root, relPath), "utf8") }));
  const docs = new Map<string, NoteDoc>();
  for (const n of notes) { const d = noteDoc(n.relPath, n.content); if (d) docs.set(d.slug, d); }
  const cache = loadVectors(cacheFile);
  const embedded = await refreshVectors(cache, [...docs.values()], opts.embed ?? ollamaEmbed(), { all: true });
  if (!opts.dryRun) saveVectors(cacheFile, cache);
  const linked = linkRelated(notes, cache);
  const before = new Map(notes.map(n => [n.relPath, n.content]));
  const changed = linked.filter(l => l.content !== before.get(l.relPath));
  if (!opts.dryRun) writeNotes(root, changed.map(({ relPath, content }) => ({ relPath, content })));
  return { dryRun: opts.dryRun, notes: docs.size, embedded, withRelated: linked.filter(l => l.links).length,
    links: linked.reduce((n, l) => n + l.links, 0), notesChanged: changed.length };
}

/** The sync's step: this run's notes link the closest notes already known (older notes link back at the nightly
 *  Dream). Throws when Ollama does not answer; the caller keeps the notes as they are. */
export async function relatedForRun(notes: Note[], opts: { embed?: Embed; cacheFile?: string } = {}): Promise<Note[]> {
  const cacheFile = opts.cacheFile ?? VECTORS_FILE();
  const docs = notes.map(n => noteDoc(n.relPath, n.content)).filter((d): d is NoteDoc => !!d);
  if (!docs.length) return notes;
  const cache = loadVectors(cacheFile);
  await refreshVectors(cache, docs, opts.embed ?? ollamaEmbed(), { all: false });
  saveVectors(cacheFile, cache);
  const byPath = new Map(linkRelated(notes, cache).map(l => [l.relPath, l.content]));
  return notes.map(n => ({ ...n, content: byPath.get(n.relPath) ?? n.content }));
}
