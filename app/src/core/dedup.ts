import { createHash } from "node:crypto";
import type { Item } from "../types.ts";

// Read flags, folders and links are not knowledge changes. Immutable Graph IDs
// identify messages; this fingerprint identifies their relevant content.
export function fingerprint(item: Item): string {
  return createHash("sha256").update(JSON.stringify({ threadId: item.threadId,
    at: item.at, from: item.from, to: item.to, cc: item.cc,
    subject: item.subject, text: item.text })).digest("hex");
}
