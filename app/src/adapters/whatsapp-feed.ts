// The WhatsApp feed of a sync run: messages the linked device stored (whatsapp-store.ts) in the chats the owner turned
// on, as pipeline items. One note per chat per month (threadId), so a busy group never grows one endless note.
// The cursor is the last stored message read per chat, so a chat turned on later still starts at its oldest message.
import type { Item, Person } from "../types.ts";
import type { WaChat, WaMessage, WhatsAppStore } from "./whatsapp-store.ts";

export const WHATSAPP_FEED = "whatsapp";
/** Messages per run over all chats; the rest follow in the next runs (the cursor stops where reading stopped). */
export const MAX_MESSAGES_PER_RUN = 3000;

const chatLabel = (chat: WaChat) => chat.name ?? (chat.kind === "group" ? "WhatsApp group" : "WhatsApp chat");

/** Stored messages -> items. Phone numbers never reach a note: people are named, or "Unknown member". */
export function waItems(chat: WaChat, rows: WaMessage[], owner: Person, nameOf: (jid: string) => string | null = () => null): Item[] {
  const other: Person = { name: chatLabel(chat), email: "" };
  return rows.filter(r => r.text.trim()).map(r => {
    const from: Person = r.fromMe ? owner : { name: r.senderName ?? (r.sender ? nameOf(r.sender) : null) ?? (chat.kind === "direct" ? chatLabel(chat) : "Unknown member"), email: "" };
    return {
      id: `whatsapp:${r.jid}:${r.id}`, threadId: `whatsapp:${r.jid}:${r.at.slice(0, 7)}`, at: r.at, from,
      to: chat.kind === "direct" ? [r.fromMe ? other : owner] : [], cc: [],
      subject: chat.kind === "group" ? `${chatLabel(chat)} (WhatsApp group)` : `${chatLabel(chat)} (WhatsApp chat)`,
      text: r.text, url: "", folder: r.fromMe ? "sentitems" : "inbox", source: "whatsapp" as const,
    };
  });
}

export function pullWhatsApp(store: WhatsAppStore, cursor: string | undefined, chosen: string[], owner: Person, budget = MAX_MESSAGES_PER_RUN): { items: Item[]; next: string } {
  let marks: Record<string, number> = {};
  try { marks = cursor ? JSON.parse(cursor) : {}; } catch { marks = {}; }
  const chats = new Map(store.chats().map(c => [c.jid, c]));
  const items: Item[] = [];
  for (const jid of chosen) {
    const chat = chats.get(jid);
    if (!chat || budget <= 0) continue;
    const rows = store.messagesAfter(jid, marks[jid] ?? 0, budget);
    if (!rows.length) continue;
    items.push(...waItems(chat, rows, owner, store.contactName));
    marks[jid] = rows[rows.length - 1].seq;
    budget -= rows.length;
  }
  return { items, next: JSON.stringify(marks) };
}
