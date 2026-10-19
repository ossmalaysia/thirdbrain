// Gmail -> Items over IMAP (imap.gmail.com:993, TLS) with the Gmail address and an app password. No Google Cloud
// project. Only the Primary inbox and Sent mail: one search in the special-use \All mailbox ("[Gmail]/All Mail"; the
// name is localized, so it is found by its flag) with Gmail's X-GM-RAW extension. Threads are Gmail's own
// (X-GM-THRID), message ids X-GM-MSGID, labels X-GM-LABELS.
// Cursor: { address, uidValidity, lastUid } of All Mail. UIDs only grow, so each run reads the matching UIDs above
// lastUid, OLDEST first, up to a budget: a large backfill finishes over several runs without skipping any. A new
// UIDVALIDITY (Gmail rebuilt the mailbox) starts again from the history window; known messages are deduplicated.
// Every network step has a time limit: a silent server ends the feed for this run with a clear error. Server text
// never reaches an error message (it can quote the account).
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Item, Person, Thread } from "../types.ts";
import { attachmentText, MAX_ATTACHMENT_BYTES, MAX_TEXT_PER_ITEM, type AttachmentInfo } from "../core/attachments.ts";
import { stripQuotedAndSignature } from "./outlook-normalize.ts";
import { DEFAULT_SCOPE, scopeKey, scopeQuery, type GmailScope } from "./gmail-scope.ts";

export const GMAIL_FEED = "gmail";
export const GMAIL_HOST = "imap.gmail.com", GMAIL_PORT = 993;
export const APP_PASSWORD_URL = "https://myaccount.google.com/apppasswords";
export const TWO_STEP_URL = "https://myaccount.google.com/signinoptions/twosv";
export const IMAP_SETTINGS_URL = "https://mail.google.com/mail/u/0/#settings/fwdandpop";
/** Messages read per run (the chat feeds read up to 150 chats); the rest wait for the next run. */
export const MAX_MESSAGES_PER_RUN = 200;
const FETCH_CHUNK = 50, MAX_TEXT = 8000;
/** Messages up to this size are read whole; larger ones only their first part (the text comes first; attachments
 *  are read separately, part by part, when the thread is turned into a note). */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024, PARTIAL_SOURCE_BYTES = 512 * 1024;

export const MESSAGES = {
  // Each sign-in failure points back to the step of the add form (and docs/configuration.md) that fixes it.
  auth: `Gmail refused the app password. Go back to step 2: create a new app password at ${APP_PASSWORD_URL} and paste it again.`,
  noAppPasswords: `Gmail does not accept app passwords for this account yet. Go back to step 1: turn on 2-Step Verification at ${TWO_STEP_URL}, then do step 2.`,
  imapOff: `Gmail has IMAP turned off for this account. Go back to step 4: turn on IMAP at ${IMAP_SETTINGS_URL} if your Gmail settings show the option.`,
  timeout: "Gmail did not answer in time. Gmail sync continues on the next run.",
  network: "Could not reach Gmail (imap.gmail.com). Check the internet connection; Gmail sync continues on the next run.",
  noAllMail: "Gmail's All Mail folder is not visible over IMAP. In Gmail settings, Labels, tick Show in IMAP for All Mail, then sync again.",
  other: "Gmail could not be read right now. Gmail sync continues on the next run.",
} as const;
export class GmailError extends Error {
  constructor(public kind: keyof typeof MESSAGES) { super(MESSAGES[kind]); }
}

/** Fixed messages only: the server's own words never leave this function. */
export function gmailError(e: unknown): GmailError {
  if (e instanceof GmailError) return e;
  const x = (e ?? {}) as { code?: string; authenticationFailed?: boolean; serverResponseCode?: string; responseText?: string; message?: string };
  const text = `${x.responseText ?? ""} ${x.message ?? ""}`;
  // The server text only picks the step; it is never shown.
  if (/not enabled for imap|imap access is disabled|imap is disabled/i.test(text)) return new GmailError("imapOff");
  if (/web ?login required|log ?in via your web browser|2-step|two-step/i.test(text)) return new GmailError("noAppPasswords");
  if (x.authenticationFailed || /^(AUTHENTICATIONFAILED|AUTHORIZATIONFAILED)$/i.test(x.serverResponseCode ?? "")
    || /invalid credentials|application-specific password|authentication failed/i.test(text)) return new GmailError("auth");
  if (/TIMEOUT/i.test(x.code ?? "")) return new GmailError("timeout");
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|NoConnection|EConnectionClosed|ClosedAfterConnectTLS|ClosedAfterConnectText)$/.test(x.code ?? "")) return new GmailError("network");
  return new GmailError("other");
}

export interface GmailAccount { address: string; password: string }

export interface RawMessage {
  uid: number;
  emailId?: string;            // X-GM-MSGID (decimal)
  threadId?: string;           // X-GM-THRID (decimal)
  labels?: string[];           // X-GM-LABELS, e.g. \Inbox, \Sent, \Important
  flags?: string[];
  internalDate?: string | Date;
  envelope?: { date?: string | Date; subject?: string; messageId?: string;
    from?: { name?: string; address?: string }[]; to?: { name?: string; address?: string }[]; cc?: { name?: string; address?: string }[] };
  size?: number;
  bodyStructure?: Structure;
  source?: Uint8Array;
}
export interface Structure { part?: string; type: string; parameters?: Record<string, string>; id?: string; encoding?: string; size?: number;
  disposition?: string; dispositionParameters?: Record<string, string>; childNodes?: Structure[] }

/** One signed-in IMAP connection with All Mail open read-only. Everything the pull and the attachment step need. */
export interface GmailSession {
  uidValidity: string;
  /** The account's own labels (from IMAP LIST; system folders left out). */
  labels?: string[];
  search(query: { gmraw: string; uid?: string }): Promise<number[]>;
  /** Metadata (and the message text) of these UIDs, in any order. `metaOnly`: thread id and date only (estimates). */
  fetch(uids: number[], opts?: { metaOnly?: boolean }): Promise<RawMessage[]>;
  structure(uid: number): Promise<Structure | null>;
  download(uid: number, part: string, maxBytes: number): Promise<Uint8Array | null>;
  close(): Promise<void>;
}
export type OpenGmail = () => Promise<GmailSession>;

/** The IMAP search: the kinds of mail chosen in What to include (gmail-scope.ts), never spam, trash or chats, inside the window. */
export const gmailQuery = (sinceIso: string, scope: GmailScope = DEFAULT_SCOPE): string => scopeQuery(scope, sinceIso);

/** Gmail web link for a thread: the X-GM-THRID in hexadecimal. */
export const threadUrl = (thrid: string) => {
  try { return `https://mail.google.com/mail/u/0/#all/${BigInt(thrid).toString(16)}`; } catch { return "https://mail.google.com/mail/u/0/#all"; }
};

const isoOf = (v: string | Date | undefined) => {
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") : "";
};
const people = (list: { name?: string; address?: string }[] | undefined): Person[] =>
  (list ?? []).filter(p => p?.address).map(p => ({ name: String(p.name || p.address || "").trim(), email: String(p.address).trim().toLowerCase() }));

/** File attachments in a body structure (inline images with a Content-ID, e.g. signature logos, are left out). */
export function attachmentParts(s: Structure | null | undefined): { part: string; name: string; type: string; size: number }[] {
  const out: { part: string; name: string; type: string; size: number }[] = [];
  const walk = (n: Structure) => {
    if (n.childNodes?.length) { for (const c of n.childNodes) walk(c); return; }
    const name = n.dispositionParameters?.filename ?? n.parameters?.name;
    const attachment = n.disposition?.toLowerCase() === "attachment" || (!!name && !(n.id && n.type.startsWith("image/")));
    if (!attachment || !n.part || n.type.startsWith("multipart/")) return;
    // The structure gives the encoded size; base64 is about 4/3 of the file.
    const size = Math.round((n.size ?? 0) * (n.encoding?.toLowerCase() === "base64" ? 0.75 : 1));
    out.push({ part: n.part, name: String(name ?? "attachment"), type: n.type, size });
  };
  if (s) walk(s);
  return out;
}

/** One fetched message -> Item (null for drafts and unreadable rows). `me` is the Gmail address (the owner). */
export async function gmailItem(m: RawMessage, me: Person, uidValidity: string): Promise<Item | null> {
  const labels = m.labels ?? [], flags = m.flags ?? [];
  if (!m.emailId || !m.threadId || labels.includes("\\Draft") || flags.includes("\\Draft")) return null;
  let text = "", from: Person | undefined;
  if (m.source?.length) {
    try {
      const parsed = await simpleParser(Buffer.from(m.source), { skipHtmlToText: false, skipImageLinks: true, skipTextLinks: true });
      text = String(parsed.text ?? "");
    } catch { text = ""; }
  }
  text = stripQuotedAndSignature(text);
  from = people(m.envelope?.from)[0] ?? { name: "", email: "" };
  const mine = labels.includes("\\Sent") || (!!me.email && from.email === me.email.toLowerCase());
  return {
    id: `gmail:${m.emailId}`,
    threadId: `gmail:${m.threadId}`,
    at: isoOf(m.internalDate) || isoOf(m.envelope?.date),
    from, to: people(m.envelope?.to), cc: people(m.envelope?.cc),
    subject: String(m.envelope?.subject ?? "").trim() || "(no subject)",
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[truncated]` : text,
    url: threadUrl(m.threadId),
    folder: mine ? "sentitems" : "inbox",
    source: "gmail",
    account: { id: "gmail", label: me.email },
    ...(attachmentParts(m.bodyStructure).length ? { hasAttachments: true, ref: `${uidValidity}:${m.uid}` } : {}),
  };
}

interface Cursor { address: string; uidValidity: string; lastUid: number; scopeKey: string }
export function readCursor(cursor: string | undefined): Cursor | null {
  try {
    const c = cursor ? JSON.parse(cursor) : null;
    return c && typeof c.uidValidity === "string" && Number.isSafeInteger(c.lastUid) && c.lastUid >= 0
      ? { address: String(c.address ?? ""), uidValidity: c.uidValidity, lastUid: c.lastUid, scopeKey: String(c.scopeKey ?? "") } : null;
  } catch { return null; }
}

/** The Gmail feed's pull. Reads the oldest `budget` matching messages above the cursor; a failure after some were
 *  read keeps them and moves the cursor only past what was read. */
export async function pullGmail(open: OpenGmail, cursor: string | undefined, sinceIso: string, me: Person, budget = MAX_MESSAGES_PER_RUN, scope: GmailScope = DEFAULT_SCOPE): Promise<{ items: Item[]; next: string }> {
  const session = await open();
  try {
    const saved = readCursor(cursor), key = scopeKey(scope);
    // Another address, a rebuilt mailbox (new UIDVALIDITY) or other choices in What to include (a cursor from before
    // the choices existed has no key): start again from the history window. Messages already read are recognised by
    // id and content in the pipeline and are not summarised again.
    const lastUid = saved && saved.uidValidity === session.uidValidity && saved.address === me.email && saved.scopeKey === key ? saved.lastUid : 0;
    const uids = await session.search({ gmraw: gmailQuery(sinceIso, scope), ...(lastUid ? { uid: `${lastUid + 1}:*` } : {}) });
    // `n:*` always matches the highest UID, even below n: keep only new ones. Oldest first.
    const batch = [...new Set(uids)].filter(u => u > lastUid).sort((a, b) => a - b).slice(0, budget);
    const items: Item[] = [];
    let done = lastUid;
    for (let i = 0; i < batch.length; i += FETCH_CHUNK) {
      const chunk = batch.slice(i, i + FETCH_CHUNK);
      let rows: RawMessage[];
      try { rows = await session.fetch(chunk); }
      catch (e) { if (done === lastUid) throw e; break; } // nothing read: report it; else keep what was read
      for (const m of rows.sort((a, b) => a.uid - b.uid)) { const item = await gmailItem(m, me, session.uidValidity); if (item) items.push(item); }
      done = chunk[chunk.length - 1];
    }
    return { items, next: JSON.stringify({ address: me.email, uidValidity: session.uidValidity, lastUid: done, scopeKey: key }) };
  } finally { await session.close(); }
}

/** Pipeline enrich step: attachment text for a Gmail thread's messages (in memory only, same limits as Outlook). */
export async function enrichGmailThread(open: OpenGmail, thread: Thread): Promise<void> {
  const items = thread.items.filter(i => i.source === "gmail" && i.hasAttachments && !i.attachments);
  if (!items.length) return;
  const unlisted = (item: Item) => { item.attachments = [{ name: "attachments", type: "", size: 0, status: "skipped", reason: "could not be listed" }]; };
  let session: GmailSession;
  try { session = await open(); } catch { items.forEach(unlisted); return; }
  try {
    for (const item of items) {
      const [validity, uidText] = String(item.ref ?? "").split(":"), uid = Number(uidText);
      if (validity !== session.uidValidity || !Number.isSafeInteger(uid)) { unlisted(item); continue; }
      try { item.attachments = await messageAttachments(session, uid); } catch { unlisted(item); }
    }
  } finally { await session.close(); }
}

async function messageAttachments(session: GmailSession, uid: number): Promise<AttachmentInfo[]> {
  const out: AttachmentInfo[] = [];
  let budget = MAX_TEXT_PER_ITEM;
  for (const a of attachmentParts(await session.structure(uid))) {
    const { name, type, size } = a;
    if (size > MAX_ATTACHMENT_BYTES) { out.push({ name, type, size, status: "skipped", reason: "too large to read" }); continue; }
    if (budget <= 0) { out.push({ name, type, size, status: "skipped", reason: "text limit for this email reached" }); continue; }
    let info: AttachmentInfo;
    try {
      const bytes = await session.download(uid, a.part, MAX_ATTACHMENT_BYTES + 1);
      info = bytes ? await attachmentText(name, type, bytes) : { name, type, size, status: "skipped", reason: "could not be downloaded" };
    } catch { info = { name, type, size, status: "skipped", reason: "could not be downloaded" }; }
    if (info.text) { info.text = info.text.slice(0, budget); budget -= info.text.length; }
    out.push(info);
  }
  return out;
}

// ── The real connection (imapflow) ──

/** The part of ImapFlow this adapter uses (tests pass a fake). */
export interface ImapClient {
  connect(): Promise<void>;
  list(): Promise<{ path: string; specialUse?: string; flags?: Set<string> }[]>;
  mailboxOpen(path: string, opts: { readOnly: boolean }): Promise<{ uidValidity: bigint | number | string }>;
  search(query: Record<string, unknown>, opts: { uid: true }): Promise<number[] | false | undefined>;
  fetchAll(range: string | number[], query: Record<string, unknown>, opts: { uid: true }): Promise<any[]>;
  download(range: string, part: string, opts: { uid: true; maxBytes: number }): Promise<{ content?: AsyncIterable<Uint8Array> & { destroy?: () => void } }>;
  logout(): Promise<void>;
  close(): void;
}

export interface Limits { connectMs: number; commandMs: number; fetchMs: number }
export const LIMITS: Limits = { connectMs: 30_000, commandMs: 30_000, fetchMs: 120_000 };

/** `p`, or a timeout that closes the connection (a silent server must never hang the run). */
async function within<T>(p: Promise<T>, ms: number, client: ImapClient): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { try { client.close(); } catch { /* already closed */ } reject(new GmailError("timeout")); }, ms); });
  p.catch(() => {}); // after a timeout the closed connection rejects too; nobody waits for that any more
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

export const createImapFlow = (account: GmailAccount, limits: Limits): ImapClient => new ImapFlow({
  host: GMAIL_HOST, port: GMAIL_PORT, secure: true, auth: { user: account.address, pass: account.password },
  logger: false, disableAutoIdle: true, connectionTimeout: limits.connectMs, greetingTimeout: Math.min(16_000, limits.connectMs),
  socketTimeout: Math.max(limits.fetchMs, limits.commandMs) + 5_000,
}) as unknown as ImapClient;

const META = { uid: true, emailId: true, threadId: true, labels: true, flags: true, internalDate: true, envelope: true, size: true, bodyStructure: true };
const asArray = (v: unknown): string[] => v instanceof Set ? [...v].map(String) : Array.isArray(v) ? v.map(String) : [];

/** The owner's labels: every listed folder except INBOX, Gmail's system folders and folders that cannot be opened. */
export const userLabels = (boxes: { path: string; specialUse?: string; flags?: Set<string> }[]) => boxes
  .filter(b => b.path && b.path.toUpperCase() !== "INBOX" && !b.specialUse && !/^\[(Gmail|Google Mail)\]/i.test(b.path) && !b.flags?.has("\\Noselect"))
  .map(b => b.path).sort((a, b) => a.localeCompare(b));

/** LOGIN, then SELECT (read-only) the \All mailbox. Throws a GmailError with a fixed message. */
export async function openGmail(account: GmailAccount, deps: { create?: (a: GmailAccount, l: Limits) => ImapClient; limits?: Limits } = {}): Promise<GmailSession> {
  const limits = deps.limits ?? LIMITS, client = (deps.create ?? createImapFlow)(account, limits);
  (client as unknown as { on?: (e: string, f: () => void) => void }).on?.("error", () => {}); // socket errors surface through the pending command
  const step = <T>(p: Promise<T>, ms = limits.commandMs) => within(p, ms, client).catch(e => { try { client.close(); } catch { /* closed */ } throw gmailError(e); });
  await step(client.connect(), limits.connectMs);
  const boxes = await step(client.list());
  const all = boxes.find(b => b.specialUse === "\\All") ?? boxes.find(b => b.flags?.has("\\All"));
  if (!all) { try { client.close(); } catch { /* closed */ } throw new GmailError("noAllMail"); }
  const box = await step(client.mailboxOpen(all.path, { readOnly: true }));
  const uidValidity = String(box.uidValidity);
  return {
    uidValidity,
    labels: userLabels(boxes),
    search: async query => { const r = await step(client.search(query, { uid: true })); return Array.isArray(r) ? r : []; },
    async fetch(uids, opts = {}) {
      if (!uids.length) return [];
      if (opts.metaOnly) return (await step(client.fetchAll(uids, { uid: true, emailId: true, threadId: true, internalDate: true }, { uid: true }), limits.fetchMs))
        .map(m => ({ uid: m.uid, emailId: m.emailId, threadId: m.threadId, internalDate: m.internalDate }));
      const meta = await step(client.fetchAll(uids, META, { uid: true }), limits.fetchMs);
      const small = meta.filter(m => (m.size ?? 0) <= MAX_SOURCE_BYTES).map(m => m.uid), large = meta.filter(m => (m.size ?? 0) > MAX_SOURCE_BYTES).map(m => m.uid);
      const sources = new Map<number, Uint8Array>();
      if (small.length) for (const m of await step(client.fetchAll(small, { uid: true, source: true }, { uid: true }), limits.fetchMs)) if (m.source) sources.set(m.uid, m.source);
      for (const uid of large) for (const m of await step(client.fetchAll([uid], { uid: true, source: { maxLength: PARTIAL_SOURCE_BYTES } }, { uid: true }), limits.fetchMs)) if (m.source) sources.set(m.uid, m.source);
      return meta.map(m => ({ uid: m.uid, emailId: m.emailId, threadId: m.threadId, labels: asArray(m.labels), flags: asArray(m.flags),
        internalDate: m.internalDate, envelope: m.envelope, size: m.size, bodyStructure: m.bodyStructure, source: sources.get(m.uid) }));
    },
    async structure(uid) { const [m] = await step(client.fetchAll([uid], { uid: true, bodyStructure: true }, { uid: true })); return m?.bodyStructure ?? null; },
    async download(uid, part, maxBytes) {
      const read = async () => {
        const d = await client.download(String(uid), part, { uid: true, maxBytes });
        if (!d?.content) return null;
        const chunks: Uint8Array[] = [];
        let n = 0;
        for await (const c of d.content) { chunks.push(c); n += c.byteLength; if (n > maxBytes) { d.content.destroy?.(); break; } }
        return new Uint8Array(Buffer.concat(chunks));
      };
      return step(read(), limits.fetchMs);
    },
    async close() { try { await within(client.logout(), 5_000, client); } catch { try { client.close(); } catch { /* closed */ } } },
  };
}
