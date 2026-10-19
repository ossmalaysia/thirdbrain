// `entities rebuild [--dry-run]`: the one-off backfill. Scans every connector note in the vault, (re)writes all entity
// pages and rewrites people/client/project lines and old event lines in existing notes into the linked form. Reads
// only the connector's folders (never life/ or anchor/clients/); writes only those notes and inbox/entities/.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OWNED_DIRS, writeNotes } from "./core/commit.ts";
import { EntityStore, linkNote, MIN_TOPIC_NOTES, topicSlug, type EntityKind, type OwnerId } from "./core/entities.ts";
import { saveMerges } from "./core/entity-merges.ts";
import type { Note } from "./types.ts";

export interface RebuildReport {
  dryRun: boolean;
  notesScanned: number;
  notesLinked: number;     // notes that would change / changed
  eventLinesMigrated: number;
  entities: Record<EntityKind, number>;
  pagesChanged: number;    // entity pages that would be (re)written / were
  pagesBlocked: number;
  pagesMerged: number;     // duplicate pages merged into another page (and deleted)
}

/** Vault-relative paths (forward slashes) of the connector's notes, sorted. Symlinks are never followed. */
export function connectorNotes(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const dir = join(root, rel);
    if (!existsSync(dir)) return;
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.isSymbolicLink()) continue;
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(child);
      else if (d.isFile() && d.name.endsWith(".md")) out.push(child);
    }
  };
  for (const dir of OWNED_DIRS) walk(dir);
  return out.sort();
}

/** Topic slugs carried by at least MIN_TOPIC_NOTES notes (personal notes not counted; entity pages not notes). */
export function topicCandidates(root: string, files: string[], min = MIN_TOPIC_NOTES): Set<string> {
  const count = new Map<string, number>();
  for (const relPath of files) {
    const m = readFileSync(join(root, relPath), "utf8").match(/^tags:[ \t]*(\[.*\])[ \t]*\r?$/m);
    let tags: unknown = [];
    try { tags = m ? JSON.parse(m[1]) : []; } catch { /* unreadable tags: none */ }
    if (!Array.isArray(tags) || tags.some(t => t === "personal" || String(t).startsWith("personal/"))) continue;
    for (const s of new Set(tags.map(t => topicSlug(String(t))).filter((x): x is string => !!x))) count.set(s, (count.get(s) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n >= min).map(([s]) => s));
}

export function rebuildEntities(root: string, owner: OwnerId, today: string, opts: { dryRun: boolean }): { report: RebuildReport; notes: Note[]; pages: Note[] } {
  const store = EntityStore.load(root, owner);
  store.clearNotes();
  const files = connectorNotes(root);
  store.topicTags = topicCandidates(root, files);
  const notes: Note[] = [];
  let migrated = 0;
  for (const relPath of files) {
    const before = readFileSync(join(root, relPath), "utf8");
    const r = linkNote(store, relPath, before);
    migrated += r.migratedEvents;
    if (r.content !== before) notes.push({ relPath, content: r.content });
  }
  for (const e of store.all()) e.touched = e.notes.size > 0; // a rebuild rewrites every page that has notes
  const pages = store.pages(today);
  const current = (n: Note) => { const f = join(root, n.relPath); return existsSync(f) ? readFileSync(f, "utf8") : null; };
  const changedPages = pages.filter(p => current(p) !== p.content);
  const merged = store.absorbed.filter(rel => existsSync(join(root, rel)));
  if (!opts.dryRun) {
    writeNotes(root, notes); writeNotes(root, changedPages);
    if (store.newMerges.length) saveMerges(root, store.merges);
    for (const rel of merged) rmSync(join(root, rel), { force: true }); // generated pages; their notes now link the page that stays
  }
  const entities = { person: 0, company: 0, project: 0, topic: 0 } as Record<EntityKind, number>;
  for (const e of store.all()) if (e.notes.size) entities[e.kind]++;
  return {
    report: { dryRun: opts.dryRun, notesScanned: files.length, notesLinked: notes.length, eventLinesMigrated: migrated, entities,
      pagesChanged: changedPages.length, pagesBlocked: store.blocked, pagesMerged: merged.length },
    notes, pages: changedPages,
  };
}
