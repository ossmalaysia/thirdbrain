// ChatGPT chats -> Items, one thread per conversation, using the portal's own ChatGPT sign-in (the one the note
// writer uses). Plain HTTPS to chatgpt.com/backend-api with that bearer token works without a browser (checked
// 2026-10-17); it is not a public API, so a change pauses this feed with a clear error and never stops mail.
// Delta: conversations are listed newest-updated first down to the watermark; the OLDEST changed ones are read first
// (budget per run), so a large backfill finishes over several runs without skipping any.
import type { Item, Person, Thread } from "../types.ts";
import { textAttachment, type AttachmentInfo } from "../core/attachments.ts";
import { backendHeaders, type BackendAuth } from "../core/chatgpt.ts";
import { MAX_DOC_TEXT_PER_CHAT, MAX_MESSAGE_TEXT, MAX_MESSAGES } from "./claude-web.ts";

export const CHATGPT_FEED = "ai:chatgpt";
// The list's `total` is not a real count (it is page size + 1), so listing pages until a short page is the only way.
export const PAGE = 50, MAX_CHATS_PER_RUN = 150;
const ORIGIN = "https://chatgpt.com";

export interface ChatGptApi { get: <T = any>(path: string) => Promise<T> }

/** Requests with the portal's ChatGPT sign-in; one refresh-and-retry after a 401, and two retries (2 s, 5 s) after a
 *  server error or timeout (seen: an occasional HTTP 500 on the conversation list). HTTP 429 ends the request at
 *  once by default: chatgpt.com allows about one chat read a minute during a large import (2026-10-18), and waiting
 *  for it made one sync run last up to 150 minutes. The import keeps what it read; the rest waits for the next run.
 *  `limitWaits` (Retry-After, max 60 s) stays for callers that prefer to wait. */
export function chatgptApi(auth: { backendAuth(): Promise<BackendAuth>; refreshAfter401(a: BackendAuth): Promise<BackendAuth> }, fetchImpl: typeof fetch = fetch, waits = [2000, 5000], limitWaits: number[] = []): ChatGptApi {
  return {
    async get<T>(path: string): Promise<T> {
      let a = await auth.backendAuth();
      const once = () => fetchImpl(ORIGIN + path, { headers: { ...backendHeaders(a), accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
      const send = async () => {
        for (let i = 0; ; i++) {
          const r = await once().catch(e => { if (i >= waits.length) throw new Error(`ChatGPT did not answer (${e instanceof Error ? e.name : "network error"})`); return null; });
          const limited = r?.status === 429;
          if (r && ((r.status < 500 && !limited) || (limited ? i >= limitWaits.length : i >= waits.length))) return r;
          await new Promise(res => setTimeout(res, limited ? retryAfterMs(r!.headers.get("retry-after"), limitWaits[i]) : waits[i]));
        }
      };
      let r = await send();
      if (r.status === 401) { a = await auth.refreshAfter401(a); r = await send(); }
      if (r.headers.get("cf-mitigated")) throw new Error("ChatGPT is asking for a browser check; chat sync is paused until it clears.");
      if (r.status === 401 || r.status === 403) throw new Error("ChatGPT sign-in no longer works for chat history. Sign in again from portal Settings.");
      if (r.status === 429) throw new Error("ChatGPT rate limit (HTTP 429); chat sync continues on the next run.");
      if (!r.ok) throw new Error(`ChatGPT request failed (HTTP ${r.status})`);
      return await bodyWithin<T>(r, 45_000);
    },
  };
}

/** The JSON body, or an error when it does not arrive in time (the request signal does not cover a waiting body read). */
async function bodyWithin<T>(r: Response, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { void r.body?.cancel().catch(() => {}); reject(new Error("ChatGPT stopped sending the chat list; chat sync continues on the next run.")); }, ms); });
  try { return await Promise.race([r.json() as Promise<T>, late]); } finally { clearTimeout(timer); }
}

/** Retry-After in seconds or as an HTTP date -> ms, capped at 60 s; `fallback` when missing or unreadable. */
export function retryAfterMs(h: string | null, fallback: number): number {
  if (!h) return fallback;
  const ms = /^\d+$/.test(h.trim()) ? Number(h) * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 60_000) : fallback;
}

export interface ConvRow { id: string; title?: string | null; update_time?: string | number | null; create_time?: string | number | null; gizmo_id?: string | null }
interface Msg {
  id: string; author?: { role?: string; name?: string | null }; create_time?: number | null; recipient?: string;
  content?: { content_type?: string; parts?: unknown[]; text?: string };
  metadata?: { attachments?: { name?: string; size?: number; mime_type?: string }[] };
}
export interface ConvDetail { title?: string | null; create_time?: number | null; update_time?: number | null; current_node?: string; gizmo_id?: string | null; mapping?: Record<string, { id: string; parent?: string | null; message?: Msg | null }> }

/** Seconds (detail), ISO strings (list) or null -> ISO. */
export const iso = (t: string | number | null | undefined) =>
  t == null ? "" : typeof t === "number" ? new Date(t * 1000).toISOString() : new Date(t).toISOString();

/** The branch shown on screen: from the current node up through parents. */
export function branch(d: ConvDetail): Msg[] {
  const out: Msg[] = [], map = d.mapping ?? {};
  for (let id = d.current_node, n = 0; id && map[id] && n <= Object.keys(map).length; n++) {
    const m = map[id].message;
    if (m) out.push(m);
    id = map[id].parent ?? undefined;
  }
  return out.reverse();
}

/** Readable text of a user/assistant message; reasoning, tool chatter and canvas JSON are left out. */
export function messageText(m: Msg): string {
  const role = m.author?.role, type = m.content?.content_type;
  if ((role !== "user" && role !== "assistant") || (m.recipient && m.recipient !== "all")) return "";
  if (type !== "text" && type !== "multimodal_text") return "";
  const parts = (m.content?.parts ?? []).map(p => typeof p === "string" ? p.trim() : p && typeof p === "object" ? "[image]" : "").filter(Boolean);
  const files = (m.metadata?.attachments ?? []).map(a => a.name).filter(Boolean);
  return [parts.join("\n"), files.length ? `[attached: ${files.join(", ")}]` : ""].filter(Boolean).join("\n");
}

const TEXT_DOC = /\.(md|markdown|txt|html?|csv|xml)$/i;

/** Canvas documents ChatGPT wrote (latest version wins) and uploaded files (names only), from `fromIso` on. */
export function chatDocuments(d: ConvDetail, fromIso: string): AttachmentInfo[] {
  const docs = new Map<string, AttachmentInfo>();
  for (const m of branch(d)) {
    if (iso(m.create_time) && iso(m.create_time) < fromIso) continue;
    for (const a of m.metadata?.attachments ?? []) if (a.name && !docs.has(a.name))
      docs.set(a.name, { name: a.name, type: a.mime_type ?? "", size: a.size ?? 0, status: "skipped", reason: a.mime_type?.startsWith("image/") ? "image" : "file content not available" });
    if (m.recipient === "canmore.create_textdoc" || m.recipient === "canmore.update_textdoc") {
      try {
        const doc = JSON.parse(m.content?.text ?? (m.content?.parts?.[0] as string) ?? "{}") as { name?: string; type?: string; content?: string; updates?: { replacement?: string }[] };
        const text = doc.content ?? doc.updates?.map(u => u.replacement ?? "").join("\n") ?? "";
        const name = `${(doc.name || "Canvas document").replace(/[\\/]/g, "-")}${doc.type?.startsWith("code") ? ".code" : ".md"}`;
        if (text) docs.set(name, TEXT_DOC.test(name) ? textAttachment(name, doc.type ?? "", text) : { name, type: doc.type ?? "", size: text.length, status: "skipped", reason: "code or data file" });
      } catch { /* not a canvas payload */ }
    }
  }
  let budget = MAX_DOC_TEXT_PER_CHAT;
  return [...docs.values()].map(doc => {
    if (doc.status !== "read") return doc;
    if ((doc.text ?? "").length > budget) return { name: doc.name, type: doc.type, size: doc.size, status: "skipped" as const, reason: "over this chat's document text limit" };
    budget -= doc.text!.length;
    return doc;
  });
}

export function chatItems(id: string, d: ConvDetail, me: Person, sinceIso: string, extra: Pick<Item, "project" | "account"> = {}): Item[] {
  const at = (m: Msg) => iso(m.create_time) || iso(d.create_time);
  const messages = branch(d).filter(m => messageText(m) && at(m) >= sinceIso);
  const kept = messages.length > MAX_MESSAGES ? [...messages.slice(0, 10), ...messages.slice(-(MAX_MESSAGES - 10))] : messages;
  const gpt: Person = { name: "ChatGPT", email: "" };
  return kept.map(m => {
    const mine = m.author?.role === "user", text = messageText(m);
    return {
      id: `chatgpt:${id}:${m.id}`, threadId: `ai-chatgpt:${id}`, at: at(m),
      from: mine ? me : gpt, to: mine ? [gpt] : [me], cc: [], subject: d.title?.trim() || "Untitled ChatGPT chat",
      text: text.length > MAX_MESSAGE_TEXT ? `${text.slice(0, MAX_MESSAGE_TEXT)}\n[truncated]` : text,
      url: `${ORIGIN}/c/${id}`, folder: mine ? "sentitems" : "received", source: "chatgpt-chat" as const,
      ...(extra.project ? { project: extra.project } : {}), ...(extra.account ? { account: extra.account } : {}),
    };
  });
}

/** Project names (ChatGPT projects are "g-p-..." gizmos). Best effort: no names just means no project tag. */
async function projectNames(api: ChatGptApi): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: any = await api.get(`/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const it of page?.items ?? []) { const g = it?.gizmo?.gizmo ?? it?.gizmo; if (g?.id && g?.display?.name) names.set(g.id, String(g.display.name)); }
      cursor = page?.cursor ?? null;
      if (!cursor) break;
    }
  } catch { /* optional */ }
  return names;
}

/** Cursor (JSON): `top` = newest update_time ever listed; `pending` = changed chats not read yet, oldest first.
 *  Each run lists only chats changed after `top` (one page normally; the whole history only on the first run), adds
 *  them to `pending`, and reads the oldest `maxChats`. Listing the full history every run would take longer than the
 *  15-minute schedule for a large account. */
interface Cursor { top: string; pending: { id: string; u: string; g?: string | null }[] } // id, updated, project gizmo
export async function pullChatGptChats(api: ChatGptApi, cursor: string | undefined, sinceIso: string, me: Person, account?: Item["account"], maxChats = MAX_CHATS_PER_RUN): Promise<{ items: Item[]; next: string }> {
  let state: Cursor = { top: sinceIso, pending: [] };
  try { if (cursor) state = { ...state, ...JSON.parse(cursor) }; } catch { /* unreadable: start from sinceIso */ }
  const since = state.top > sinceIso ? state.top : sinceIso;
  const fresh: Cursor["pending"] = [];
  let done = false;
  for (let offset = 0; !done && offset < PAGE * 400; offset += PAGE) {
    const page = await api.get<{ items?: ConvRow[] }>(`/backend-api/conversations?offset=${offset}&limit=${PAGE}&order=updated`);
    const rows = page.items ?? [];
    for (const c of rows) {
      if (!c.id || iso(c.update_time) <= since) { done = true; break; }
      fresh.push({ id: c.id, u: iso(c.update_time), ...(c.gizmo_id ? { g: c.gizmo_id } : {}) });
    }
    if (rows.length < PAGE) done = true;
  }
  // Merge: a chat changed again replaces its older pending entry. Oldest change first.
  const byId = new Map(state.pending.map(p => [p.id, p]));
  for (const f of fresh) byId.set(f.id, f);
  // Outside the window (e.g. the window was shortened after a first listing): dropped, never read.
  const pending = [...byId.values()].filter(p => p.u > sinceIso).sort((a, b) => a.u.localeCompare(b.u));
  const top = [since, ...fresh.map(f => f.u)].sort().at(-1)!;
  const batch = pending.slice(0, maxChats);
  const projects = batch.some(c => c.g?.startsWith("g-p-")) ? await projectNames(api) : new Map<string, string>();
  const items: Item[] = [];
  let read = 0;
  try {
    for (const c of batch) {
      const d = await api.get<ConvDetail>(`/backend-api/conversation/${encodeURIComponent(c.id)}`);
      remember(c.id, d);
      const gizmo = c.g ?? d.gizmo_id;
      const project = gizmo?.startsWith("g-p-") && projects.get(gizmo) ? { id: gizmo, name: projects.get(gizmo)! } : undefined;
      items.push(...chatItems(c.id, d, me, sinceIso, { project, account }));
      read++;
    }
  } catch (e) {
    if (!read) throw e; // nothing read: report the problem; the cursor is unchanged so nothing is lost
  } // partly read: keep what was read; the rest stays pending for the next run
  return { items, next: JSON.stringify({ top, pending: pending.slice(read) }) };
}

/** Chats read in this run, so the enrich step does not read the same chat again (that second read was what hit the
 *  rate limit). Kept in memory for this process only. */
const readThisRun = new Map<string, ConvDetail>();
function remember(id: string, d: ConvDetail) {
  readThisRun.set(id, d);
  if (readThisRun.size > 300) readThisRun.delete(readThisRun.keys().next().value!);
}

/** Pipeline enrich step: the chat's documents, from this run's read or a new one (never kept in the queue). */
export async function enrichChatGptThread(api: ChatGptApi, thread: Thread): Promise<void> {
  const first = thread.items[0];
  if (first?.source !== "chatgpt-chat") return;
  const id = first.threadId.replace(/^ai-chatgpt:/, "");
  const d = readThisRun.get(id) ?? await api.get<ConvDetail>(`/backend-api/conversation/${encodeURIComponent(id)}`);
  readThisRun.delete(id);
  const docs = chatDocuments(d, thread.items.map(i => i.at).sort()[0]);
  if (docs.length) thread.items[thread.items.length - 1].attachments = docs;
}
