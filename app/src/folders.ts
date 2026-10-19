// Which Outlook folders one run reads. Inbox and Sent Items every run (new mail must not wait for the
// rotation; their delta cursors make an idle check cheap); the other folders rotate `perRun` at a time
// to backfill history. Before 2026-10-15 every folder shared one rotation, so the Inbox was read only
// once every ~14 runs (about 3.5 hours with 40 folders).
export interface FolderRef { id: string; kind: string }

export const PRIORITY_KINDS = ["inbox", "sentitems"];

export function planFolders<T extends FolderRef>(all: T[], offset: number, perRun: number): { folders: T[]; nextOffset: number } {
  const priority = PRIORITY_KINDS.flatMap(kind => all.filter(f => f.kind === kind));
  const others = all.filter(f => !PRIORITY_KINDS.includes(f.kind));
  if (!others.length) return { folders: priority, nextOffset: 0 };
  const start = ((offset % others.length) + others.length) % others.length;
  const count = Math.min(Math.max(perRun, 0), others.length);
  const rotating = Array.from({ length: count }, (_, i) => others[(start + i) % others.length]);
  return { folders: [...priority, ...rotating], nextOffset: (start + count) % others.length };
}
