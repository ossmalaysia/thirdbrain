// The EzyChat feed: customer chats of an EzyChat team inbox (Lite or Enterprise), read through EzyChat's own MCP server.
// EzyChat answers `POST <base>/mcp` in the MCP SDK's stateless JSON mode (packages/server/src/mcp/transport.ts:
// WebStandardStreamableHTTPServerTransport, no session id, enableJsonResponse): one JSON-RPC `tools/call` per POST, no
// `initialize` first (without a session the SDK skips that check), and the Accept header must list both
// application/json and text/event-stream or the SDK answers 406. A tool's result is JSON text in
// `result.content[0].text` (server.ts textResult; no structuredContent); a failed tool sets `isError` with plain text.
// Errors before the SDK (route.ts) are Fastify JSON `{ error: { code, message } }`: 404 when AI access is off, 403 off the
// EzyChat computer or its tunnel, 401 for a bad token, 429 over 60 calls a minute per token.
// One note per chat per month (threadId), like WhatsApp. Ids use a hash of the chat id: a WhatsApp chat id holds the
// customer's phone number, and the thread id is written into the note.
import { createHash } from "node:crypto";
import type { Item, Person } from "../types.ts";

export const EZYCHAT_FEED = "ezychat";
/** Per run; the rest follow in the next runs (the cursor stops where reading stopped). 60 calls a minute is EzyChat's limit. */
export const MAX_CHATS_PER_RUN = 40, MAX_CALLS_PER_RUN = 50;
const PAGE = 100; // the largest page both tools allow

export const MESSAGES = {
  address: "Enter the EzyChat address, e.g. https://inbox.example.com (EzyChat Settings -> Integrations shows it).",
  auth: "EzyChat refused the token. Reconnect EzyChat here; if that fails, check Third Brain under EzyChat Settings -> Integrations.",
  off: "AI assistant access is off in EzyChat. Turn on Let AI assistants read this inbox (EzyChat Settings -> Integrations).",
  forbidden: "EzyChat accepts this only on its own computer or through its tunnel address.",
  rate: "EzyChat rate limit (HTTP 429); chat sync continues on the next run.",
  network: (base: string) => `EzyChat is not reachable at ${base}. Is the EzyChat computer on?`,
  server: "EzyChat could not answer right now. Try again later.",
  tool: "EzyChat could not read that chat list or chat. Sync tries again on the next run.",
  signin: "EzyChat sign-in is not available at this address. Update EzyChat, or check the address.",
} as const;
export type EzyChatErrorCode = "address" | "auth" | "off" | "forbidden" | "rate" | "network" | "server" | "tool" | "signin";

/** Fixed messages only: the server's own words can name a chat (its id holds a phone number), so they are never shown. */
export class EzyChatError extends Error {
  constructor(public code: EzyChatErrorCode, base = "") { super(code === "network" ? MESSAGES.network(base) : MESSAGES[code] as string); }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The EzyChat address as one base without `/mcp`: EzyChat Settings shows the connector address with `/mcp`, people
 *  also paste the plain address. https, or http on this computer only (EzyChat answers only locally or via its tunnel). */
export function normalizeBase(raw: unknown): string {
  let text = typeof raw === "string" ? raw.trim() : "";
  if (text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let u: URL;
  try { u = new URL(text); } catch { throw new EzyChatError("address"); }
  if (!u.hostname || u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname)))) throw new EzyChatError("address");
  const parts = u.pathname.split("/").filter(Boolean); // segments, so no backtracking regex on a pasted path
  if (parts.at(-1)?.toLowerCase() === "mcp") parts.pop();
  return `${u.origin}${parts.length ? `/${parts.join("/")}` : ""}`;
}

export interface EzyChatConnection { base: string; token: string }
export type EzyChatApi = { call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<any> };

/** HTTP status -> plain words. 401 carries `WWW-Authenticate: Bearer ... error="invalid_token"`. */
export function statusError(status: number, base: string): EzyChatError {
  return new EzyChatError(status === 401 ? "auth" : status === 404 ? "off" : status === 403 ? "forbidden" : status === 429 ? "rate" : "server", base);
}

/** The JSON-RPC message of an SSE reply (a server not in JSON mode sends `data: {...}` lines). */
const fromSse = (text: string) => { const line = text.split(/\r?\n/).filter(l => l.startsWith("data:")).pop(); return line ? JSON.parse(line.slice(5)) : null; };

/** Plain fetch JSON-RPC, no MCP SDK: one request, one answer. */
export function ezychatApi(conn: EzyChatConnection, fetchImpl: typeof fetch = fetch): EzyChatApi {
  let id = 0;
  return {
    async call(tool, args, timeoutMs = 60_000) {
      let res: Response;
      try {
        res = await fetchImpl(`${conn.base}/mcp`, { method: "POST", signal: AbortSignal.timeout(timeoutMs), redirect: "error",
          headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: args } }) });
      } catch { throw new EzyChatError("network", conn.base); }
      if (!res.ok) { await res.body?.cancel().catch(() => {}); throw statusError(res.status, conn.base); }
      let msg: any;
      try { const text = await res.text(); msg = res.headers.get("content-type")?.includes("text/event-stream") ? fromSse(text) : JSON.parse(text); }
      catch { throw new EzyChatError("server"); }
      if (!msg || msg.error || !msg.result) throw new EzyChatError("server");
      const r = msg.result, text = r.content?.find((c: { type?: string }) => c?.type === "text")?.text;
      // A token revoked between the HTTP check and the tool (server.ts runTool) is a refused token too.
      if (r.isError) throw new EzyChatError(/no longer valid/i.test(String(text ?? "")) ? "auth" : "tool");
      if (r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
      try { return JSON.parse(String(text)); } catch { throw new EzyChatError("server"); }
    },
  };
}

// ── Items ──

export interface EzyChatChat { jid: string; inboxId?: number; inboxName?: string; type?: string; name: string | null; phone?: string | null; status?: string | null;
  assignedTo?: string | null; lastMessageAt: string | null; tags?: string[] }
export interface EzyChatMessage { id: string; at: string; from: "team" | "customer" | string; sender: string | null; type?: string; text: string | null;
  truncated?: boolean; isVoiceTranscript?: boolean; media?: { mime?: string | null; name?: string | null } | null }

/** A short stable key for a chat: its id holds a phone number, which never reaches a note. */
export const chatKey = (jid: string) => createHash("sha256").update(jid).digest("hex").slice(0, 16);
/** A name that is only a phone number counts as no name. */
const named = (s: string | null | undefined) => s && s.trim() && !/^[+\d\s().-]{6,}$/.test(s.trim()) ? s.trim() : null;
const CUSTOMER = "EzyChat customer";

/** Text, caption or voice transcript; media is described by type and file name ("[image: photo.jpg]"). */
function messageText(m: EzyChatMessage): string {
  const text = (m.text ?? "").trim(), type = m.type && m.type !== "text" ? m.type : "";
  const media = m.media && type ? `[${type}${m.media.name ? `: ${m.media.name}` : ""}]` : "";
  const body = text ? `${m.isVoiceTranscript ? "(voice message) " : ""}${text}${m.truncated ? " […]" : ""}` : "";
  return [body, media].filter(Boolean).join("\n");
}

/** Messages -> items. The customer is named by the chat name; team messages by the team member, or the owner when sent
 *  from the phone (or by the owner's own name). Only the owner's messages are `sentitems` (the prompt says "sent by"). */
export function ezychatItems(chat: EzyChatChat, messages: EzyChatMessage[], owner: Person): Item[] {
  const name = named(chat.name) ?? CUSTOMER, group = chat.type === "group", key = chatKey(chat.jid);
  const customer: Person = { name, email: "" };
  const meta = { status: chat.status ?? null, assignedTo: chat.assignedTo ?? null, tags: chat.tags ?? [], inbox: chat.inboxName ?? null };
  return messages.filter(m => m.type !== "system").flatMap(m => {
    const text = messageText(m);
    if (!text) return [];
    const team = m.from === "team", mine = team && (m.sender === "phone" || (!!owner.name && m.sender?.toLowerCase() === owner.name.toLowerCase()));
    const from: Person = mine ? owner : team ? { name: named(m.sender) ?? "EzyChat team", email: "" } : { name: group ? named(m.sender) ?? "Unknown member" : name, email: "" };
    return [{
      id: `ezychat:${key}:${m.id}`, threadId: `ezychat:${key}:${m.at.slice(0, 7)}`, at: m.at, from,
      to: team ? [customer] : [], cc: [], subject: chat.inboxName ? `${name} (EzyChat, ${chat.inboxName})` : `${name} (EzyChat)`,
      text, url: "", folder: mine ? "sentitems" : "inbox", source: "ezychat" as const, ezychat: meta,
    }];
  });
}

// ── Pull ──

/** Per chat: the newest message read (`at`, `id`), and `back` while an older part is still being read (a chat longer
 *  than one run's budget): the page to continue from and the newest message, which becomes the mark when done. */
interface Mark { at: string | null; id?: string; back?: { before: string; top: { at: string; id: string } } }
/** `since`: chats changed after it were all read. `scan`: a pass over the chat list in progress (newest first, EzyChat's
 *  only order): its lower bound, the newest message time seen, and the list page to resume (absent = the first page). */
interface Cursor { since?: number; scan?: { from: number; top: number; list?: string }; chats: Record<string, Mark> }

function readCursor(raw: string | undefined): Cursor {
  try { const c = raw ? JSON.parse(raw) : null; if (c && typeof c === "object" && c.chats && typeof c.chats === "object") return c; } catch { /* a new start */ }
  return { chats: {} };
}

class OutOfBudget extends Error {}
export interface Budget { chats: number; calls: number }
const RUN_BUDGET: Readonly<Budget> = Object.freeze({ chats: MAX_CHATS_PER_RUN, calls: MAX_CALLS_PER_RUN });

/** One run: the chat list since the last finished pass, each changed chat's messages back to its mark (or the history
 *  window), at most `budget` chats and calls. Marks move only past what was read, so a stopped run continues next time;
 *  a chat whose newest message is not newer than its mark is passed over without a call. A 429 after some progress
 *  keeps that progress; before any, it fails the feed (the portal shows the wait). */
export async function pullEzyChat(api: EzyChatApi, cursor: string | undefined, owner: Person, since = "",
  budget: Budget = RUN_BUDGET): Promise<{ items: Item[]; next: string }> {
  const c = readCursor(cursor), windowStart = Date.parse(since) || 0, items: Item[] = [];
  // EzyChat lists chats changed strictly after `since`: 1 ms earlier lists a chat at exactly the watermark again
  // (passed over by its mark) rather than missing another chat with the same time.
  const scan = c.scan ?? { from: Math.max((c.since ?? 1) - 1, windowStart), top: c.since ?? 0 };
  let calls = 0, chats = 0, progress = false, list = scan.list;
  const call = async (tool: string, args: Record<string, unknown>) => {
    if (calls >= budget.calls) throw new OutOfBudget();
    calls++;
    return api.call(tool, args);
  };
  try {
    for (;;) {
      const page = await call("list_chats", { since: scan.from, limit: PAGE, ...(list ? { cursor: list } : {}) }) as { chats?: EzyChatChat[]; nextCursor?: string | null };
      let older = false;
      for (const chat of page.chats ?? []) {
        const at = Date.parse(chat.lastMessageAt ?? "");
        if (!Number.isFinite(at)) continue;
        if (at < windowStart) { older = true; break; } // newest first: the rest is older than the window
        scan.top = Math.max(scan.top, at);
        const key = chatKey(chat.jid), mark = c.chats[key];
        if (mark && !mark.back && mark.at && at <= Date.parse(mark.at)) continue; // nothing new (or listed for another change)
        if (chats >= budget.chats) throw new OutOfBudget();
        const r = await readChat(call, chat, mark, windowStart);
        chats++;
        items.push(...ezychatItems(chat, r.messages, owner));
        c.chats[key] = r.mark; progress = true;
        if (r.mark.back) throw new OutOfBudget();
      }
      if (older || !page.nextCursor) break;
      list = page.nextCursor;
    }
    // A full pass: the next one lists only chats changed since its newest message.
    c.since = scan.top;
    delete c.scan;
  } catch (e) {
    if (!(e instanceof OutOfBudget) && !(e instanceof EzyChatError && e.code === "rate" && progress)) throw e;
    c.scan = { ...scan, ...(list ? { list } : {}) };
    if (!list) delete c.scan.list;
  }
  // Marks older than the window add nothing (paging stops at the window anyway).
  for (const [k, m] of Object.entries(c.chats)) if (!m.back && m.at && Date.parse(m.at) < windowStart) delete c.chats[k];
  return { items, next: JSON.stringify(c) };
}

/** Pages back from the newest message (or where the last run stopped) to the mark or the window start. */
async function readChat(call: (tool: string, args: Record<string, unknown>) => Promise<any>, chat: EzyChatChat, mark: Mark | undefined, windowStart: number) {
  const lower = Math.max(windowStart, Date.parse(mark?.at ?? "") || 0), messages: EzyChatMessage[] = [];
  let before = mark?.back?.before, top = mark?.back?.top ?? null;
  for (;;) {
    let page: { messages?: EzyChatMessage[]; nextBefore?: string | null };
    try { page = await call("get_messages", { jid: chat.jid, limit: PAGE, ...(before ? { before } : {}) }); }
    catch (e) {
      // Out of calls with part of this chat read: keep it, continue from here next run.
      if (e instanceof OutOfBudget && top && before) return { messages, mark: { at: mark?.at ?? null, ...(mark?.id ? { id: mark.id } : {}), back: { before, top } } };
      throw e;
    }
    const rows = page.messages ?? [];
    if (!top && rows.length) top = { at: rows[rows.length - 1].at, id: rows[rows.length - 1].id };
    // From the mark on (a message at the same time but another id is new); the marked message itself was read.
    messages.unshift(...rows.filter(m => Date.parse(m.at) > lower || (Date.parse(m.at) === lower && m.id !== mark?.id)));
    if (!page.nextBefore || !rows.length || Date.parse(rows[0].at) < lower) break;
    before = page.nextBefore;
  }
  return { messages, mark: top ? { at: top.at, id: top.id } as Mark : { at: chat.lastMessageAt } as Mark };
}

/** Backfill estimate: the newest message time of each chat changed since `stopBefore` (dates only, never content). */
export async function sampleEzyChat(api: EzyChatApi, stopBefore: string, maxPages = 20): Promise<{ updated: string[]; complete: boolean }> {
  const updated: string[] = [], since = Date.parse(stopBefore) || 0;
  let list: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await api.call("list_chats", { since, limit: PAGE, ...(list ? { cursor: list } : {}) }) as { chats?: EzyChatChat[]; nextCursor?: string | null };
    for (const chat of page.chats ?? []) {
      const at = Date.parse(chat.lastMessageAt ?? "");
      if (!Number.isFinite(at)) continue;
      if (at < since) return { updated, complete: true };
      updated.push(new Date(at).toISOString());
    }
    if (!page.nextCursor) return { updated, complete: true };
    list = page.nextCursor;
  }
  return { updated, complete: false };
}
