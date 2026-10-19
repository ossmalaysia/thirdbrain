// One run: pull -> filter -> group -> extract -> render -> commit. Dependencies are injected so tests can fake them.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fingerprint } from "./core/dedup.ts";
import { RESCAN } from "./adapters/outlook.ts";
import { filterItems } from "./core/filter.ts";
import { groupThreads } from "./core/group.ts";
import type { Extractor } from "./core/extract.ts";
import { CodexExtractionError } from "./core/extract.ts";
import { renderThreadNote } from "./core/render.ts";
import { commitAndIndex, OWNED_DIRS, readNote, writeNotes } from "./core/commit.ts";
import { EntityStore, linkNote, type LinkHint, type OwnerId } from "./core/entities.ts";
import type { Config, State } from "./state.ts";
import type { Item, Note, Thread } from "./types.ts";

export interface RunDeps {
  pull: (folder: string, cursor: string | undefined) => Promise<{ items: Item[]; next: string }>;
  folders: readonly string[];
  extract: Extractor;
  commit: (notes: Note[]) => { committed: boolean; indexed: boolean; detail: string };
  log: (e: Record<string, unknown>) => void;
  today: string;
  checkpoint?: (state: State) => void;
  /** Adds attachment text to a thread's items just before extraction (email attachments). */
  enrich?: (thread: Thread) => Promise<void>;
  /** Feeds whose failure is reported instead of failing the run (Teams, channels, meetings). */
  optionalFeed?: (feed: string) => boolean;
  /** The vault owner: never gets a person page (docs/architecture.md, "Entities and links"). */
  owner?: OwnerId;
  /** Decision model triage before extraction (docs/decision-model.md). A thread it is sure about is skipped
   *  without calling the note writer; anything uncertain, or a triage error, goes to the note writer as before. */
  /** Related notes (core/related.ts): returns the notes with `## Related notes`; may throw (Ollama down). */
  relatedNotes?: (notes: Note[]) => Promise<Note[]>;
  /** Per-connector intervals (feed-schedule.ts): the key a feed's finished pull is recorded under (default: the feed). */
  pulledKey?: (feed: string) => string;
  /** A failed optional feed whose error still counts as a pull, so it waits a full interval (a rate limit). */
  waitAfter?: (error: string) => boolean;
  triage?: (thread: Thread) => Promise<{ skip: boolean; reason: string; pKeep: number; pPersonal: number; ms: number; inputTokens: number; model: string }>;
}

export interface RunOptions { dryRun: boolean; limit: number; outRoot: string }

export async function runOnce(cfg: Config, state: State, deps: RunDeps, opts: RunOptions) {
  const report = { at: new Date().toISOString(), pulled: 0, kept: 0, dropped: {} as Record<string, number>, written: 0, entityPages: 0, skipped: 0, blocked: 0, queued: 0, duplicates: 0, notes: [] as string[], feedErrors: {} as Record<string, string>, costUsd: 0, inputTokens: 0, outputTokens: 0, triageSkipped: 0, error: null as string | null };
  const rangeChanged = state.lookbackDays !== cfg.initialSinceDays;
  const nextCursors: Record<string, string> = rangeChanged ? {} : { ...state.cursors };
  const processed = { ...state.processed };
  const scannedFolders = rangeChanged ? {} : { ...state.scannedFolders };

  // 1-2. Pull + normalize (adapter)
  const fresh: Item[] = [];
  const feedPulledAt = { ...state.feedPulledAt };
  const pulled = (folder: string) => { feedPulledAt[deps.pulledKey?.(folder) ?? folder] = new Date().toISOString(); };
  for (const folder of deps.folders) {
    try {
      const { items, next } = await deps.pull(folder, nextCursors[folder]);
      fresh.push(...items);
      nextCursors[folder] = next;
      if (next === RESCAN) scannedFolders[folder] = report.at;
      pulled(folder);
    } catch (e) {
      // Teams/meetings problems (e.g. a permission not granted yet) are reported per feed; email carries on.
      if (!deps.optionalFeed?.(folder)) throw e;
      report.feedErrors[folder] = e instanceof Error ? e.message.slice(0, 300) : "Could not read this source.";
      if (deps.waitAfter?.(report.feedErrors[folder])) pulled(folder);
      deps.log({ stage: "pull", feed: folder, error: report.feedErrors[folder] });
    }
  }
  report.pulled = fresh.length;

  // 3. Deduplicate across runs, folder moves and overlapping backfills. Re-filter
  // queued items so a newly muted sender doesn't slip through a retry.
  const candidates = new Map<string, Item>();
  for (const item of [...state.queue, ...fresh]) {
    if (processed[item.id]?.fingerprint === fingerprint(item) ||
      (candidates.has(item.id) && fingerprint(candidates.get(item.id)!) === fingerprint(item))) {
      report.duplicates++;
      continue;
    }
    candidates.set(item.id, item);
  }
  const { kept, dropped } = filterItems([...candidates.values()], { muted: state.muted });
  const mark = (items: Item[], outcome: string) => {
    for (const item of items) processed[item.id] = { fingerprint: fingerprint(item), outcome, at: report.at };
  };
  for (const d of dropped) {
    report.dropped[d.reason] = (report.dropped[d.reason] ?? 0) + 1;
    mark([d.item], d.reason);
    deps.log({ stage: "filter", drop: d.reason, id: d.item.id });
  }
  report.kept = kept.length;
  let workingState: State = { ...state, cursors: nextCursors, processed, queue: kept,
    lookbackDays: cfg.initialSinceDays, scannedFolders, feedPulledAt };
  // Persist the queue and cursors BEFORE calling an AI. A killed process can resume.
  if (!opts.dryRun) deps.checkpoint?.(workingState);

  // 4. Group, attaching the note each thread already owns (if the owner hasn't moved it out)
  const ownedPath = (threadId: string) => {
    const t = state.threads[threadId];
    return t && OWNED_DIRS.some(dir => t.relPath.startsWith(`${dir}/`)) && !t.relPath.split(/[\\/]/).includes("..") && existsSync(join(cfg.brainPath, t.relPath)) ? t.relPath : undefined;
  };
  const threads = groupThreads(kept, id => {
    const p = ownedPath(id);
    return p ? readNote(cfg.brainPath, p) : null;
  });

  // 5-6. Extract + render, newest threads first, up to the per-run cap
  const notes: Note[] = [];
  const hints = new Map<string, LinkHint>(); // relPath -> the extracted people and client, for linking
  const queue: Item[] = [];
  const claimed = new Set(Object.values(state.threads).map(t => t.relPath));
  const belongsToThread = (path: string, id: string) => {
    const existing = readNote(cfg.brainPath, path);
    const field = existing?.match(/^conversation_id: ("[^\r\n]*")\s*$/m)?.[1];
    try { return !!field && JSON.parse(field) === id; } catch { return false; }
  };
  const threadUpdates: State["threads"] = {};
  for (const [i, thread] of threads.entries()) {
    if (i >= opts.limit) { queue.push(...thread.items); continue; }
    try {
      // Attachment text is read now, only for threads being extracted (a failure just means no attachment text).
      await deps.enrich?.(thread).catch(() => {});
      // Decision model first: a sure "not worth keeping" or "personal" skips the note writer (ids and numbers logged only).
      // Only new conversations: a thread that already has a note always goes to the note writer, so a short new
      // reply ("thanks") can never stop the update of an important note.
      const t = deps.triage && !thread.existingNote ? await deps.triage(thread).catch(e => { deps.log({ stage: "triage", thread: thread.id, error: e instanceof Error ? e.message.slice(0, 200) : "failed" }); return null; }) : null;
      if (t) deps.log({ stage: "triage", thread: thread.id, source: thread.items[0]?.source ?? "email", skip: t.skip, reason: t.reason,
        pKeep: t.pKeep, pPersonal: t.pPersonal, ms: t.ms, decisionTokens: t.inputTokens, model: t.model });
      if (t?.skip) {
        report.skipped++;
        report.triageSkipped++;
        mark(thread.items, `skipped:decision:${t.reason}`);
        continue;
      }
      const { knowledge, costUsd, usage } = await deps.extract(thread);
      report.costUsd += costUsd;
      report.inputTokens += usage?.inputTokens ?? 0;
      report.outputTokens += usage?.outputTokens ?? 0;
      // Per-thread tokens with the thread's source, for the portal's Usage page (no content, ids only).
      if (usage) deps.log({ stage: "tokens", thread: thread.id, source: thread.items[0]?.source ?? "email", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd });
      if (!knowledge.keep) {
        report.skipped++;
        mark(thread.items, "skipped");
        deps.log({ stage: "extract", skip: true, thread: thread.id });
        continue;
      }
      let relPath = ownedPath(thread.id);
      const rendered = renderThreadNote(thread, knowledge, { relPath, today: deps.today });
      if ("blocked" in rendered) {
        report.blocked++;
        mark(thread.items, rendered.blocked);
        deps.log({ stage: "render", blocked: rendered.blocked, thread: thread.id });
        continue;
      }
      // Never overwrite a note this thread doesn't own (same date + title from another thread).
      if (!relPath && (claimed.has(rendered.relPath) || existsSync(join(cfg.brainPath, rendered.relPath))) && !belongsToThread(rendered.relPath, thread.id)) {
        rendered.relPath = rendered.relPath.replace(/\.md$/, `-${createHash("sha256").update(thread.id).digest("hex").slice(0, 16)}.md`);
        if (existsSync(join(cfg.brainPath, rendered.relPath)) && !belongsToThread(rendered.relPath, thread.id)) throw new Error("Note ownership collision");
      }
      claimed.add(rendered.relPath);
      notes.push(rendered);
      hints.set(rendered.relPath, { people: knowledge.people, client: knowledge.client });
      mark(thread.items, "written");
      const lastMessageAt = [state.threads[thread.id]?.lastMessageAt ?? "", thread.items[thread.items.length - 1].at].sort().pop()!;
      threadUpdates[thread.id] = { relPath: rendered.relPath, lastMessageAt };
    } catch (e) {
      queue.push(...thread.items.map(({ attachments, ...item }) => item)); // attachment text is never persisted
      report.error = e instanceof CodexExtractionError ? e.message : "Extraction failed; queued for retry. Check the AI provider in portal Settings.";
      deps.log({ stage: "extract", error: report.error, errorCode: e instanceof CodexExtractionError ? e.code : "EXTRACTION_ERROR", thread: thread.id });
      // Provider-level failures (any provider) stop the batch; the rest of the queue waits for the next run.
      if (e instanceof CodexExtractionError && e.code !== "REFUSED") {
        queue.push(...threads.slice(i + 1).flatMap(t => t.items));
        break;
      }
    }
  }
  report.queued = queue.length;

  // 6b. Link notes to entity pages (people, client, project) and update those pages. A failure here only leaves
  // this run's notes unlinked; it never stops the run.
  let linked = notes, pages: Note[] = [];
  try {
    const store = EntityStore.load(cfg.brainPath, deps.owner);
    linked = notes.map(n => ({ ...n, content: linkNote(store, n.relPath, n.content, hints.get(n.relPath)).content }));
    pages = store.pages(deps.today);
    if (store.blocked) deps.log({ stage: "entities", blocked: store.blocked });
  } catch (e) {
    linked = notes; pages = [];
    deps.log({ stage: "entities", error: e instanceof Error ? e.message.slice(0, 200) : "failed" });
  }

  // 6c. Related notes: this run's notes link the closest notes by meaning. Ollama down: the notes stay as they are and
  // the nightly Dream links them later.
  if (deps.relatedNotes && linked.length) {
    try { linked = await deps.relatedNotes(linked); }
    catch (e) { deps.log({ stage: "related", error: e instanceof Error ? e.message.slice(0, 200) : "failed" }); }
  }

  // 7. Commit (or write to the dry-run folder only)
  const changed = writeNotes(opts.outRoot, linked);
  report.entityPages = writeNotes(opts.outRoot, pages).length;
  report.written = changed.length;
  report.notes = changed.map(n => n.relPath); // vault-relative paths, so the portal can link each run to its notes
  workingState = { ...workingState, processed, queue, threads: { ...state.threads, ...threadUpdates },
    lastRun: report, indexPending: true };
  if (!opts.dryRun) {
    deps.checkpoint?.(workingState);
    const result = deps.commit(changed);
    deps.log({ stage: "commit", ...result });
    const failed = !result.committed || !result.indexed;
    if (failed) report.error = result.detail;
    workingState.indexPending = failed;
  }

  const nextState: State = opts.dryRun ? state : workingState;
  return { report, notes: changed, nextState };
}

export { commitAndIndex };
