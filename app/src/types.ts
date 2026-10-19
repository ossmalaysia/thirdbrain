// Data passed between pipeline stages. See ../architecture.md §2.
import type { AttachmentInfo } from "./core/attachments.ts";

export interface Person {
  name: string;
  email: string;
}

/** Source-neutral item. Every stage after normalize works on this. */
export interface Item {
  id: string;        // Graph message id (dedup key)
  threadId: string;  // conversationId (grouping + note key)
  at: string;        // ISO received time
  from: Person;
  to: Person[];
  cc: Person[];
  subject: string;
  text: string;      // plain text, quoted replies stripped
  url: string;       // Outlook webLink, from Graph, never from the AI
  folder: string;    // "inbox" | "sentitems" ("sentitems" also marks the owner's own Teams messages)
  /** Where the item came from; decides note folder, wording and filters. Absent = email. */
  source?: Source;
  /** Email: Graph says it has file attachments (they're read only when the thread is extracted). */
  hasAttachments?: boolean;
  /** Filled in memory just before extraction; never stored in the queue or state. */
  attachments?: AttachmentInfo[];
  /** Claude.ai: the project the conversation belongs to (tagged on the note). */
  project?: { id: string; name: string };
  /** Claude.ai: which login the conversation came from (e.g. personal, company). */
  account?: { id: string; label: string };
  /** Gmail: `<uidValidity>:<uid>` of the message in All Mail, so its attachments can be read when the thread is extracted. */
  ref?: string;
}

export type Source = "email" | "teams-chat" | "teams-channel" | "meeting" | "ai-chat" | "chatgpt-chat" | "gmail";

export interface Dropped {
  item: Item;
  reason: string;    // e.g. "noise:sender", "secret:otp"
}

/** A conversation with new messages, plus the note it already has (if any). */
export interface Thread {
  id: string;
  items: Item[];
  existingNote: string | null; // current markdown body of this thread's note
}

/** What the extract stage must return. Mirrors KNOWLEDGE_SCHEMA in extract.ts. */
export interface Knowledge {
  keep: boolean;
  reason: string;
  title: string;
  summary: string;
  client: string | null;
  tags: string[];
  decisions: { what: string; when: string; who: string[] }[];
  commitments: { owner: string; to: string; what: string; due: string | null; status: "open" | "done" }[];
  people: { name: string; email: string; org: string | null; role: string | null }[];
  events: { date: string; what: string }[];
  why: string | null;
}

export interface Note {
  relPath: string;   // relative to the vault, forward slashes
  content: string;
}
