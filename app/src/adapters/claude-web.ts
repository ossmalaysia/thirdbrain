// Claude.ai chats -> Items, one thread per conversation, through the signed-in browser session.
// Delta per organisation: chats are listed newest first and listing stops at the last seen updated_at
// (claude-sync skips unchanged chats the same way). The pipeline's id + fingerprint dedupe means only
// new messages of a changed chat reach the AI.
import type { Item, Person, Thread } from "../types.ts";
import type { ClaudeApi } from "../claude-web/session.ts";
import { textAttachment, type AttachmentInfo } from "../core/attachments.ts";

export const AI_FEED = "ai:claude";
export const MAX_MESSAGE_TEXT = 4000, MAX_MESSAGES = 60, PAGE = 50, MAX_CHATS_PER_RUN = 150, MAX_DOC_TEXT_PER_CHAT = 60_000;

export interface ChatRow { uuid: string; name?: string; project_uuid?: string; project?: { uuid?: string; name?: string } | null; created_at?: string; updated_at?: string }
interface ChatFile { file_name?: string; file_type?: string; file_kind?: string; file_size?: number; size_bytes?: number; extracted_content?: string }
export interface ChatMessage {
  uuid: string; parent_message_uuid?: string; index?: number; sender?: string; text?: string; created_at?: string;
  content?: { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[];
  attachments?: ChatFile[]; files?: ChatFile[]; files_v2?: ChatFile[];
}
export interface ChatDetail extends ChatRow { current_leaf_message_uuid?: string; chat_messages?: ChatMessage[] }

/** The branch shown on screen: walk from the current leaf through parents (claude-sync migrate.Branch). */
export function branch(c: ChatDetail): ChatMessage[] {
  const all = c.chat_messages ?? [], byId = new Map(all.map(m => [m.uuid, m]));
  const out: ChatMessage[] = [];
  for (let id = c.current_leaf_message_uuid, seen = 0; id && seen <= all.length; seen++) {
    const m = byId.get(id);
    if (!m) break;
    out.push(m);
    id = m.parent_message_uuid;
  }
  return out.length ? out.reverse() : [...all].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

/** Readable message text: flat text (older), else text blocks; tool calls and files noted, not copied. */
export function messageText(m: ChatMessage): string {
  const blocks = (m.content ?? []).flatMap(b =>
    b.type === "text" && b.text?.trim() ? [b.text.trim()] : b.type === "tool_use" && b.name ? [`[used tool: ${b.name}]`] : []);
  const text = m.text?.trim() || blocks.join("\n");
  const files = [...(m.attachments ?? []), ...(m.files ?? []), ...(m.files_v2 ?? [])].map(f => f.file_name).filter(Boolean);
  return [text, files.length ? `[attached: ${files.join(", ")}]` : ""].filter(Boolean).join("\n");
}

export function chatItems(c: ChatDetail, me: Person, sinceIso: string, account?: Item["account"]): Item[] {
  const messages = branch(c).filter(m => m.uuid && messageText(m) && String(m.created_at ?? c.created_at) >= sinceIso);
  const kept = messages.length > MAX_MESSAGES ? [...messages.slice(0, 10), ...messages.slice(-(MAX_MESSAGES - 10))] : messages;
  const claude: Person = { name: "Claude", email: "" };
  const project = c.project?.uuid && c.project.name ? { id: c.project.uuid, name: c.project.name.trim() } : undefined;
  return kept.map(m => {
    const mine = m.sender === "human", text = messageText(m);
    return {
      id: `ai-chat:${c.uuid}:${m.uuid}`, threadId: `ai-claude:${c.uuid}`, at: String(m.created_at ?? c.created_at),
      from: mine ? me : claude, to: mine ? [claude] : [me], cc: [], subject: c.name?.trim() || "Untitled Claude chat",
      text: text.length > MAX_MESSAGE_TEXT ? `${text.slice(0, MAX_MESSAGE_TEXT)}\n[truncated]` : text,
      url: `https://claude.ai/chat/${c.uuid}`, folder: mine ? "sentitems" : "received", source: "ai-chat" as const,
      ...(project ? { project } : {}), ...(account ? { account } : {}),
    };
  });
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const TEXT_DOC = /\.(md|markdown|txt|html?|csv|xml|ics)$/i; // code and data files are listed by name only

/** A document Claude wrote in this tool call (its full text), or null. Edits only patch a file and are skipped. */
function writtenDocument(tool: string | undefined, input: Record<string, unknown> = {}): { name: string; type: string; text: string } | null {
  const s = (k: string) => typeof input[k] === "string" ? input[k] as string : "";
  if (tool === "Write" && s("file_path")) return { name: baseName(s("file_path")), type: "", text: s("content") };
  if (tool === "create_file" && s("path")) return { name: baseName(s("path")), type: "", text: s("file_text") };
  if (tool === "Projects" && s("path") && s("content")) return { name: baseName(s("path")), type: "", text: s("content") };
  if (tool === "artifacts" && ["create", "rewrite"].includes(s("command")) && s("content")) {
    const type = s("type"), ext = type.includes("markdown") ? ".md" : type.includes("html") ? ".html" : type.includes("code") ? ".code" : "";
    return { name: `${(s("title") || s("id") || "artifact").replace(/[\\/]/g, "-")}${ext}`, type, text: s("content") };
  }
  return null;
}

/** Files shown or sent to the owner (often PDFs/Word made in Claude's sandbox): names only, the file itself is not reachable. */
function sharedFiles(tool: string | undefined, input: Record<string, unknown> = {}): string[] {
  const list = tool === "present_files" ? input.filepaths : tool === "SendUserFile" ? input.files : null;
  return Array.isArray(list) ? list.map(f => typeof f === "string" ? f : String((f as { path?: string; file_path?: string })?.path ?? (f as { file_path?: string })?.file_path ?? "")).filter(Boolean).map(baseName) : [];
}

/** Documents in the on-screen branch from `fromIso` on: uploaded files (Claude.ai's extracted text), documents Claude
 *  wrote (latest version wins), and files handed to the owner (names only). Text is capped per chat. */
export function chatDocuments(c: ChatDetail, fromIso: string): AttachmentInfo[] {
  const docs = new Map<string, AttachmentInfo>();
  for (const m of branch(c)) {
    if (String(m.created_at ?? c.created_at ?? "") < fromIso) continue;
    for (const a of m.attachments ?? []) if (a.file_name) docs.set(a.file_name, a.extracted_content?.trim()
      ? textAttachment(a.file_name, a.file_type ?? "", a.extracted_content, a.file_size)
      : { name: a.file_name, type: a.file_type ?? "", size: a.file_size ?? 0, status: "skipped", reason: "no text" });
    for (const f of [...(m.files ?? []), ...(m.files_v2 ?? [])]) if (f.file_name && !docs.has(f.file_name))
      docs.set(f.file_name, { name: f.file_name, type: f.file_kind ?? "", size: f.size_bytes ?? f.file_size ?? 0, status: "skipped", reason: f.file_kind === "image" ? "image" : "file content not available" });
    for (const b of m.content ?? []) {
      if (b.type !== "tool_use") continue;
      const doc = writtenDocument(b.name, b.input);
      if (doc) docs.set(doc.name, TEXT_DOC.test(doc.name) ? textAttachment(doc.name, doc.type, doc.text)
        : { name: doc.name, type: doc.type, size: doc.text.length, status: "skipped", reason: "code or data file" });
      for (const name of sharedFiles(b.name, b.input)) if (!docs.has(name))
        docs.set(name, { name, type: "", size: 0, status: "skipped", reason: "made by Claude; the file stays in Claude" });
    }
  }
  let budget = MAX_DOC_TEXT_PER_CHAT;
  return [...docs.values()].map(d => {
    if (d.status !== "read") return d;
    if ((d.text ?? "").length > budget) return { name: d.name, type: d.type, size: d.size, status: "skipped" as const, reason: "over this chat's document text limit" };
    budget -= d.text!.length;
    return d;
  });
}

/** Pipeline enrich step for Claude.ai threads: re-reads the chat (documents are never kept in the queue). */
export async function enrichChatThread(api: ClaudeApi, thread: Thread): Promise<void> {
  const first = thread.items[0];
  if (first?.source !== "ai-chat") return;
  const conv = first.threadId.replace(/^ai-claude:/, "");
  const orgs = (await api.get<{ uuid?: string; capabilities?: string[] }[]>("/api/organizations"))
    .filter(o => o.uuid && (!o.capabilities || o.capabilities.includes("chat")));
  for (const org of orgs) {
    const detail = await api.get<ChatDetail>(`/api/organizations/${org.uuid}/chat_conversations/${conv}?tree=True&rendering_mode=messages&render_all_tools=true`).catch(() => null);
    if (!detail?.chat_messages) continue;
    const docs = chatDocuments(detail, thread.items.map(i => i.at).sort()[0]);
    if (docs.length) thread.items[thread.items.length - 1].attachments = docs;
    return;
  }
}

/** Cursor: JSON { orgId: newest updated_at seen }. First run reads chats updated since `sinceIso`. */
export async function pullClaudeChats(api: ClaudeApi, cursor: string | undefined, sinceIso: string, me: Person, maxChats = MAX_CHATS_PER_RUN, account?: Item["account"]): Promise<{ items: Item[]; next: string }> {
  let marks: Record<string, string> = {};
  try { marks = cursor ? JSON.parse(cursor) : {}; } catch { marks = {}; }
  const orgs = await api.get<{ uuid?: string; capabilities?: string[] }[]>("/api/organizations");
  const items: Item[] = [];
  let budget = maxChats;
  // API-only organisations (Console accounts) have no chats and answer 403, which reads as "signed out".
  for (const org of orgs.filter(o => o.uuid && (!o.capabilities || o.capabilities.includes("chat")))) {
    const since = marks[org.uuid!] && marks[org.uuid!] > sinceIso ? marks[org.uuid!] : sinceIso;
    const changed: ChatRow[] = [];
    let done = false;
    // List every changed chat (rows only, cheap): a backfill larger than the budget must process the OLDEST first,
    // so the watermark only moves past what was read and the next run continues from there.
    for (let offset = 0; !done && offset < PAGE * 200; offset += PAGE) {
      const page = await api.get<{ data?: ChatRow[]; has_more?: boolean }>(`/api/organizations/${org.uuid}/chat_conversations_v2?limit=${PAGE}&offset=${offset}`);
      for (const c of page.data ?? []) {
        if (!c.uuid || String(c.updated_at ?? "") <= since) { done = true; break; } // newest first: the rest are older
        changed.push(c);
      }
      if (!page.has_more) done = true;
    }
    // Oldest change first, so a run that hits the budget still advances the watermark correctly.
    changed.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
    let newest = since;
    for (const c of changed.slice(0, budget)) {
      const detail = await api.get<ChatDetail>(`/api/organizations/${org.uuid}/chat_conversations/${c.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`);
      items.push(...chatItems({ ...c, ...detail }, me, sinceIso, account));
      if (String(c.updated_at) > newest) newest = String(c.updated_at);
      budget--;
    }
    marks[org.uuid!] = newest;
  }
  return { items, next: JSON.stringify(marks) };
}
