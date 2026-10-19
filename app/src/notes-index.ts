// Lists the connector's own notes by source for the portal's Notes page. Reads only the connector's
// folders (inbox/email/threads, inbox/teams/chats|channels, inbox/meetings, inbox/ai/claude), and only
// each file's head: front matter fields plus the first Summary paragraph.
// An in-memory index keyed by file path keeps those fields with the file's mtime and size, so a request
// re-reads only new or changed files and drops deleted ones; the first request after start does the scan.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_STYLE } from "./core/render.ts";
import type { Source } from "./types.ts";

export interface NoteRow {
  path: string; title: string; source: Source;
  date: string; // last activity as written (last_message, else created, else file mtime)
  day: string;  // YYYY-MM-DD of `date`, used by the date filter
  summary: string;
  client?: string; project?: string; account?: string;
}
export const NOTE_SOURCES = Object.keys(SOURCE_STYLE) as Source[];

const HEAD_BYTES = 8192; // front matter + Summary always fit; never read whole transcripts
const SUMMARY_SHOWN = 240, SUMMARY_SEARCHED = 1500;

/** Markdown files under one source folder. Skips symlinks so the index never leaves the folder. */
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function readHead(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally { closeSync(fd); }
}

/** Header field from YAML front matter (strings may be JSON-quoted; dates are plain). */
function field(frontMatter: string, key: string): string {
  const raw = frontMatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"))?.[1]?.trim() ?? "";
  try { return raw.startsWith('"') ? String(JSON.parse(raw)) : raw; } catch { return raw; }
}

interface Entry { mtimeMs: number; size: number; row: NoteRow; search: string }

/** Parses one note's head into a row (exported for tests). */
export function parseNoteHead(text: string, rel: string, source: Source, mtimeMs: number): Entry["row"] & { searchText: string } {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  // First Summary paragraph: lines up to the next blank line or heading.
  const para = text.match(/## Summary[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*\r?\n|\r?\n#|$)/)?.[1] ?? "";
  const summaryFull = para.replace(/\s+/g, " ").trim().slice(0, SUMMARY_SEARCHED);
  const firstLine = para.split(/\r?\n/)[0]?.trim() ?? "";
  const date = field(fm, "last_message") || field(fm, "created") || new Date(mtimeMs).toISOString();
  const day = /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : new Date(mtimeMs).toISOString().slice(0, 10);
  const title = field(fm, "title") || rel.split("/").pop()!.replace(/\.md$/, "");
  const row: NoteRow & { searchText: string } = { path: rel, title, source, date, day, summary: firstLine.slice(0, SUMMARY_SHOWN), searchText: `${title} ${summaryFull}`.toLowerCase() };
  for (const key of ["client", "project", "account"] as const) { const v = field(fm, key); if (v && !["null", "~", "[]"].includes(v)) row[key] = v.slice(0, 80); }
  return row;
}

export interface NotesIndex {
  /** Rows of one source, newest activity first. Re-reads only changed files. */
  rows(source: Source): NoteRow[];
  /** Note counts per source, for the tabs. */
  counts(): Record<Source, number>;
  /** Search text (lowercased title + summary) for a row, used by queryNotes. */
  searchText(path: string): string;
  /** Files read from disk since the index was created (tests and timing). */
  reads(): number;
}

export function createNotesIndex(brainPath: string, opts: { ttlMs?: number } = {}): NotesIndex {
  const ttl = opts.ttlMs ?? 2000; // rapid paging within 2 s reuses the last walk
  const entries = new Map<string, Entry>(); // key: vault-relative path
  const sorted = new Map<Source, { at: number; rows: NoteRow[] }>();
  let reads = 0;
  function refresh(source: Source): NoteRow[] {
    const hit = sorted.get(source);
    if (hit && Date.now() - hit.at < ttl) return hit.rows;
    const dir = SOURCE_STYLE[source].dir, seen = new Set<string>();
    for (const file of walk(join(brainPath, dir))) {
      const rel = `${dir}/${file.slice(join(brainPath, dir).length + 1).replace(/\\/g, "/")}`;
      seen.add(rel);
      let st; try { st = statSync(file); } catch { continue; }
      const old = entries.get(rel);
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
      try {
        const { searchText, ...row } = parseNoteHead(readHead(file), rel, source, st.mtimeMs);
        reads++;
        entries.set(rel, { mtimeMs: st.mtimeMs, size: st.size, row, search: searchText });
      } catch { /* unreadable mid-write; picked up next time */ }
    }
    const rows: NoteRow[] = [];
    for (const [rel, e] of entries) {
      if (e.row.source !== source) continue;
      if (!seen.has(rel)) entries.delete(rel); else rows.push(e.row);
    }
    rows.sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
    sorted.set(source, { at: Date.now(), rows });
    return rows;
  }
  return {
    rows: refresh,
    counts: () => Object.fromEntries(NOTE_SOURCES.map(s => [s, refresh(s).length])) as Record<Source, number>,
    searchText: path => entries.get(path)?.search ?? "",
    reads: () => reads,
  };
}

// ── Query: validated params -> one page of rows ──────────────────────────────────
export interface NotesQuery { source: Source; q: string; from: string; to: string; page: number; pageSize: number }
export const PAGE_SIZE = 25, MAX_PAGE_SIZE = 100, MAX_QUERY = 200;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (s: string) => DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** Validates /api/notes query params. Returns the query or a user-facing error. */
export function parseNotesQuery(params: URLSearchParams): { query: NotesQuery } | { error: string } {
  const source = params.get("source") as Source;
  if (!NOTE_SOURCES.includes(source)) return { error: "Unknown source" };
  const q = (params.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const from = params.get("from") ?? "", to = params.get("to") ?? "";
  if (from && !validDay(from)) return { error: "From must be a date (YYYY-MM-DD)." };
  if (to && !validDay(to)) return { error: "To must be a date (YYYY-MM-DD)." };
  if (from && to && from > to) return { error: "From must be on or before To." };
  const int = (name: string, fallback: number) => { const v = params.get(name); return v == null || v === "" ? fallback : /^\d{1,6}$/.test(v) ? Number(v) : NaN; };
  const page = int("page", 1), size = int("pageSize", PAGE_SIZE);
  if (!(page >= 1)) return { error: "Page must be a whole number from 1." };
  if (!(size >= 1)) return { error: "Page size must be a whole number from 1." };
  return { query: { source, q, from, to, page, pageSize: Math.min(size, MAX_PAGE_SIZE) } };
}

export interface NotesPage { notes: NoteRow[]; total: number; page: number; pageSize: number; pages: number; counts: Record<Source, number> }

/** Filters (search, inclusive date range on last activity), then pages. A page past the end shows the last page. */
export function queryNotes(index: NotesIndex, query: NotesQuery): NotesPage {
  const needle = query.q.toLowerCase();
  const matches = index.rows(query.source).filter(n =>
    (!query.from || n.day >= query.from) && (!query.to || n.day <= query.to) && (!needle || index.searchText(n.path).includes(needle)));
  const pages = Math.max(1, Math.ceil(matches.length / query.pageSize)), page = Math.min(query.page, pages);
  return { notes: matches.slice((page - 1) * query.pageSize, page * query.pageSize), total: matches.length, page, pageSize: query.pageSize, pages, counts: index.counts() };
}

// One shared index per vault path for the portal process.
const shared = new Map<string, NotesIndex>();
export const notesIndexFor = (brainPath: string) => { let i = shared.get(brainPath); if (!i) shared.set(brainPath, i = createNotesIndex(brainPath)); return i; };

/** Every note of one source, newest first (kept for callers that want the full list). */
export const listNotes = (brainPath: string, source: Source): NoteRow[] => createNotesIndex(brainPath, { ttlMs: 0 }).rows(source);
/** Note counts per source. */
export const countNotes = (brainPath: string) => createNotesIndex(brainPath, { ttlMs: 0 }).counts();
