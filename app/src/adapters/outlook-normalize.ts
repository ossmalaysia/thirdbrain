// Stage 2 (Outlook adapter): Graph message JSON -> Item. Pure, no I/O.
import type { Item, Person } from "../types.ts";

const MAX_TEXT = 8000;

// Lines that start the quoted part of a reply; everything from here down is history.
const QUOTE_START = [
  /^On .{4,200} wrote:\s*$/,                 // Gmail / Apple
  /^-{2,}\s*Original Message\s*-{2,}/i,      // Outlook classic
  /^From:\s.+$/,                             // Outlook reply header block (From:/Sent:/To:)
  /^_{10,}\s*$/,                             // Outlook mobile separator
];
// Signature openers; cut if they appear in the last part of the message.
const SIGNATURE_START = [/^--\s*$/, /^Sent from my /i, /^Get Outlook for /i];

function person(r: any): Person {
  const a = r?.emailAddress ?? {};
  return { name: String(a.name ?? a.address ?? "").trim(), email: String(a.address ?? "").trim().toLowerCase() };
}

export function stripQuotedAndSignature(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (QUOTE_START.some(re => re.test(l))) { end = i; break; }
  }
  let kept = lines.slice(0, end).filter(l => !l.trimStart().startsWith(">"));
  const tailStart = Math.floor(kept.length * 0.5);
  for (let i = tailStart; i < kept.length; i++) {
    if (SIGNATURE_START.some(re => re.test(kept[i].trim()))) { kept = kept.slice(0, i); break; }
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeOutlook(raw: any, folder: string): Item {
  const text = stripQuotedAndSignature(String(raw?.body?.content ?? raw?.bodyPreview ?? ""));
  return {
    id: String(raw.id),
    threadId: String(raw.conversationId ?? raw.id),
    at: String(raw.receivedDateTime ?? raw.sentDateTime ?? ""),
    from: person(raw.from ?? raw.sender),
    to: (raw.toRecipients ?? []).map(person),
    cc: (raw.ccRecipients ?? []).map(person),
    subject: String(raw.subject ?? "(no subject)").trim(),
    text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n[truncated]" : text,
    url: String(raw.webLink ?? ""),
    folder,
    ...(raw.hasAttachments ? { hasAttachments: true } : {}),
  };
}
