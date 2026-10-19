// One-off reprocessing: re-extract old emails that have attachments (so their documents reach the notes)
// and re-read Teams chats from scratch. Existing notes are updated in place: the pipeline finds each
// thread's note through state.threads.
import type { Config, State } from "./state.ts";
import type { Item } from "./types.ts";
import { normalizeOutlook } from "./adapters/outlook-normalize.ts";
import { HEADERS } from "./adapters/outlook.ts";
import { FEEDS } from "./adapters/teams.ts";

type Get = (url: string, headers?: Record<string, string>) => Promise<any>;

/** Emails with attachments received since `sinceIso` (newest first, up to `max`). */
export async function emailsWithAttachments(get: Get, sinceIso: string, max = 500): Promise<Item[]> {
  const sent = (await get("/me/mailFolders/sentitems?$select=id", HEADERS))?.id;
  const select = "id,conversationId,receivedDateTime,sentDateTime,from,sender,toRecipients,ccRecipients,subject,body,bodyPreview,webLink,isDraft,hasAttachments,parentFolderId";
  // Graph requires the $orderby property to appear in the $filter when filtering on another property.
  let url: string | undefined = `/me/messages?${new URLSearchParams({ $select: select, $filter: `receivedDateTime ge ${sinceIso} and hasAttachments eq true`, $orderby: "receivedDateTime desc", $top: "50" })}`;
  const items: Item[] = [];
  while (url && items.length < max) {
    const page = await get(url, HEADERS);
    for (const raw of page?.value ?? []) if (raw.id && !raw.isDraft) items.push(normalizeOutlook(raw, raw.parentFolderId === sent ? "sentitems" : "inbox"));
    url = page?.["@odata.nextLink"];
  }
  return items.slice(0, max);
}

/** Returns the state with those emails queued again and (optionally) Teams chats reset to re-read. Pure. */
export function planReprocess(state: State, opts: { emails: Item[]; chats: boolean }): { state: State; emails: number; chatMessages: number } {
  const processed = { ...state.processed };
  for (const e of opts.emails) delete processed[e.id];
  let chatMessages = 0;
  if (opts.chats) for (const id of Object.keys(processed)) if (id.startsWith("teams-chat:")) { delete processed[id]; chatMessages++; }
  const queued = new Set(state.queue.map(i => i.id));
  const queue = [...opts.emails.filter(e => !queued.has(e.id)), ...state.queue]; // reprocessed mail goes first
  const cursors = { ...state.cursors };
  if (opts.chats) delete cursors[FEEDS.chats]; // next run reads the full Teams window again
  return { state: { ...state, processed, queue, cursors }, emails: opts.emails.length, chatMessages };
}

export const reprocessSince = (cfg: Config, now = Date.now()) => new Date(now - cfg.initialSinceDays * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
