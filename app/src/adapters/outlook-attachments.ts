// Email attachments -> AttachmentInfo (text for the AI, names for the note). Fetched only for threads
// being extracted this run, never at pull time, so re-scans don't re-download files.
import type { Config } from "../state.ts";
import type { Item } from "../types.ts";
import { attachmentText, MAX_ATTACHMENT_BYTES, MAX_TEXT_PER_ITEM, type AttachmentInfo } from "../core/attachments.ts";
import { graphGet, graphGetBytes } from "./graph.ts";
import { HEADERS } from "./outlook.ts";

type Get = (url: string) => Promise<any>;
type GetBytes = (url: string) => Promise<Uint8Array>;

export function outlookAttachmentDeps(cfg: Config): { get: Get; getBytes: GetBytes } {
  return { get: url => graphGet(cfg, url, HEADERS), getBytes: url => graphGetBytes(cfg, url, HEADERS) };
}

/** Reads a message's file attachments. Inline images (signatures, logos) are ignored. */
export async function emailAttachments(messageId: string, d: { get: Get; getBytes: GetBytes }): Promise<AttachmentInfo[]> {
  const base = `/me/messages/${encodeURIComponent(messageId)}/attachments`;
  const list = await d.get(`${base}?$select=id,name,contentType,size,isInline`);
  const out: AttachmentInfo[] = [];
  let budget = MAX_TEXT_PER_ITEM;
  for (const a of list?.value ?? []) {
    if (a.isInline) continue;
    const name = String(a.name ?? "attachment"), type = String(a.contentType ?? ""), size = Number(a.size ?? 0);
    if (a["@odata.type"] !== "#microsoft.graph.fileAttachment") { out.push({ name, type, size, status: "skipped", reason: "linked item, not a file" }); continue; }
    if (size > MAX_ATTACHMENT_BYTES) { out.push({ name, type, size, status: "skipped", reason: "too large to read" }); continue; }
    if (budget <= 0) { out.push({ name, type, size, status: "skipped", reason: "text limit for this email reached" }); continue; }
    let info: AttachmentInfo;
    try { info = await attachmentText(name, type, await d.getBytes(`${base}/${encodeURIComponent(a.id)}/$value`)); }
    catch { info = { name, type, size, status: "skipped", reason: "could not be downloaded" }; }
    if (info.text) { info.text = info.text.slice(0, budget); budget -= info.text.length; }
    out.push(info);
  }
  return out;
}

/** Adds attachment details to the email items of a thread (in memory only). */
export async function enrichThreadAttachments(items: Item[], d: { get: Get; getBytes: GetBytes }): Promise<void> {
  for (const item of items) {
    if ((item.source ?? "email") !== "email" || !item.hasAttachments || item.attachments) continue;
    try { item.attachments = await emailAttachments(item.id, d); }
    catch { item.attachments = [{ name: "attachments", type: "", size: 0, status: "skipped", reason: "could not be listed" }]; }
  }
}
