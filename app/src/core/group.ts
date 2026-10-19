// Stage 4: group kept items into threads. Pure; the caller supplies existing notes.
import type { Item, Thread } from "../types.ts";

export function groupThreads(items: Item[], existingNote: (threadId: string) => string | null): Thread[] {
  const byThread = new Map<string, Item[]>();
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue; // same message can appear in two deltas
    seen.add(item.id);
    const list = byThread.get(item.threadId) ?? [];
    list.push(item);
    byThread.set(item.threadId, list);
  }
  const threads: Thread[] = [];
  for (const [id, list] of byThread) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    threads.push({ id, items: list, existingNote: existingNote(id) });
  }
  // Newest activity first, so a capped run handles what matters now.
  threads.sort((a, b) => b.items[b.items.length - 1].at.localeCompare(a.items[a.items.length - 1].at));
  return threads;
}
