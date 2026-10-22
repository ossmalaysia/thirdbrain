// WhatsApp as a linked device (WhatsApp Web protocol, Baileys). Unofficial: WhatsApp does not permit it, and an
// account can be banned for automation, so this link is READ-ONLY: it never sends messages, presence, typing or read
// receipts. It runs in its own process (`cli.ts whatsapp-worker`, started by the portal), stores text messages in the
// local store (whatsapp-store.ts) and prints one status line per change: `WA {"state":...}`.
import makeWASocket, { Browsers, BufferJSON, DisconnectReason, initAuthCreds, isJidBroadcast, isJidGroup, isJidNewsletter, isJidStatusBroadcast, isLidUser,
  jidNormalizedUser, makeCacheableSignalKeyStore, normalizeMessageContent, proto, toNumber,
  type AuthenticationCreds, type ILogger, type SignalDataSet, type SignalDataTypeMap, type WAMessage } from "baileys";
import type { WaMessage, WhatsAppStore } from "./whatsapp-store.ts";

export type LinkState = "qr" | "open" | "history" | "loggedOut" | "closed";
export interface LinkLine { state: LinkState; qr?: string; name?: string | null; progress?: number | null; added?: number; reason?: string }
export const LINE_PREFIX = "WA ";
export const parseLinkLine = (line: string): LinkLine | null => {
  if (!line.startsWith(LINE_PREFIX)) return null;
  try { const v = JSON.parse(line.slice(LINE_PREFIX.length)); return v && typeof v.state === "string" ? v : null; } catch { return null; }
};

/** Chats that are never people talking: status updates, channels (newsletters) and broadcast lists. */
export const skipChat = (jid: string) => !jid || !!isJidStatusBroadcast(jid) || !!isJidNewsletter(jid) || !!isJidBroadcast(jid);

/** The words of a message, or a short marker for media; null for reactions, stickers, edits and system messages. */
export function messageText(message: proto.IMessage | null | undefined): string | null {
  const c = normalizeMessageContent(message);
  if (!c) return null;
  const text = c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.videoMessage?.caption ?? c.documentMessage?.caption;
  if (text?.trim()) return text.trim();
  if (c.documentMessage) return `[document: ${c.documentMessage.fileName ?? "file"}]`;
  if (c.imageMessage) return "[photo]";
  if (c.videoMessage) return "[video]";
  if (c.audioMessage) return c.audioMessage.ptt ? "[voice message]" : "[audio]";
  if (c.locationMessage || c.liveLocationMessage) return "[location]";
  if (c.contactMessage) return `[contact card: ${c.contactMessage.displayName ?? "contact"}]`;
  const poll = c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3;
  if (poll) return `[poll: ${poll.name ?? ""} | ${(poll.options ?? []).map(o => o.optionName).join(" | ")}]`;
  return null;
}

/** Phone-number form of a chat id when WhatsApp sent the anonymous (@lid) form plus the number, so one person keeps one chat. */
const chatJid = (key: proto.IMessageKey) => jidNormalizedUser(key.remoteJid && isLidUser(key.remoteJid) && key.remoteJidAlt ? key.remoteJidAlt : key.remoteJid ?? "");

export function toWaMessage(m: WAMessage): WaMessage | null {
  const jid = chatJid(m.key);
  if (skipChat(jid) || !m.key.id || m.messageStubType) return null;
  const text = messageText(m.message);
  const seconds = toNumber(m.messageTimestamp as number);
  if (!text || !seconds) return null;
  const fromMe = !!m.key.fromMe;
  const senderRaw = fromMe ? null : isJidGroup(jid) ? (m.key.participantAlt ?? m.key.participant ?? null) : jid;
  return { jid, id: m.key.id, at: new Date(seconds * 1000).toISOString(), fromMe, sender: senderRaw ? jidNormalizedUser(senderRaw) : null,
    senderName: fromMe ? null : m.pushName?.trim() || null, text };
}

/** Baileys auth state kept in the store (sealed), instead of Baileys' folder of plain JSON files. */
export function storeAuthState(store: WhatsAppStore, logger?: ILogger) {
  const read = (k: string) => { const v = store.auth.get(k); return v === null ? null : JSON.parse(v, BufferJSON.reviver); };
  const creds: AuthenticationCreds = read("creds") ?? initAuthCreds();
  const keys = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        let value = read(`${type}-${id}`);
        if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        if (value) out[id] = value;
      }
      return out;
    },
    set: async (data: SignalDataSet) => {
      const entries: [string, string | null][] = [];
      for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[])
        for (const [id, value] of Object.entries(data[type] ?? {})) entries.push([`${type}-${id}`, value ? JSON.stringify(value, BufferJSON.replacer) : null]);
      store.auth.set(entries);
    },
  };
  return {
    state: { creds, keys: makeCacheableSignalKeyStore(keys, logger) },
    saveCreds: () => store.auth.set([["creds", JSON.stringify(creds, BufferJSON.replacer)]]),
  };
}

/** Baileys logs a lot; only errors reach the portal's log tail, one short line each. */
function quietLogger(print: (line: string) => void): ILogger {
  const say = (obj: unknown, msg?: string) => print(`error: ${(msg ?? (obj as { msg?: string })?.msg ?? (obj instanceof Error ? obj.message : "")).toString().slice(0, 300)}`);
  const logger: ILogger = { level: "error", child: () => logger, trace() {}, debug() {}, info() {}, warn() {}, error: say };
  return logger;
}

/** Read-only socket options (the "Chrome" client: WhatsApp refuses unofficial "Desktop" clients, code 428). */
const socketOptions = (auth: ReturnType<typeof storeAuthState>["state"], logger: ILogger) => ({
  auth, logger, browser: Browsers.windows("Chrome"), markOnlineOnConnect: false, syncFullHistory: true,
  shouldSyncHistoryMessage: () => true, getMessage: async () => undefined, emitOwnEvents: false,
});

/** The worker: connect, keep the store filled, exit when the connection ends (the portal restarts it with back-off).
 *  Exit 0 = signed out on the phone (do not restart). */
export async function runLinkWorker(store: WhatsAppStore, print: (line: string) => void = console.log): Promise<number> {
  const emit = (l: LinkLine) => print(LINE_PREFIX + JSON.stringify(l));
  const logger = quietLogger(print);
  const { state, saveCreds } = storeAuthState(store, logger);
  const sock = makeWASocket(socketOptions(state, logger));
  const save = (list: WAMessage[]) => store.addMessages(list.map(toWaMessage).filter((m): m is WaMessage => !!m));
  const names = (list: { id?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null; subject?: string | null }[]) =>
    store.nameContacts(list.filter(c => c.id && !isJidGroup(c.id)).map(c => ({ jid: jidNormalizedUser(c.id!), name: c.name || c.notify || c.verifiedName || "" })));

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messaging-history.set", h => {
    names(h.contacts);
    store.nameChats(h.chats.filter(c => c.id && !skipChat(c.id)).map(c => ({ jid: jidNormalizedUser(c.id), name: c.name ?? null })));
    emit({ state: "history", progress: h.progress ?? null, added: save(h.messages) });
  });
  sock.ev.on("messages.upsert", u => { save(u.messages); });
  sock.ev.on("contacts.upsert", names);
  sock.ev.on("contacts.update", c => names(c as never));
  sock.ev.on("groups.upsert", g => store.nameChats(g.map(x => ({ jid: x.id, name: x.subject ?? null }))));
  sock.ev.on("groups.update", g => store.nameChats(g.filter(x => x.id && x.subject).map(x => ({ jid: x.id!, name: x.subject! }))));

  return new Promise<number>(resolve => {
    sock.ev.on("connection.update", async u => {
      if (u.qr) emit({ state: "qr", qr: u.qr });
      if (u.connection === "open") {
        emit({ state: "open", name: sock.user?.name ?? null });
        // Group names for the chat list (one query; groups.update keeps them current).
        try { const groups = await sock.groupFetchAllParticipating(); store.nameChats(Object.values(groups).map(g => ({ jid: g.id, name: g.subject ?? null }))); }
        catch { /* names arrive later through history and group events */ }
      }
      if (u.connection === "close") {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) { store.auth.clear(); emit({ state: "loggedOut" }); resolve(0); return; }
        emit({ state: "closed", reason: code ? `code ${code}` : (u.lastDisconnect?.error?.message ?? "closed") });
        resolve(1);
      }
    });
  });
}

/** Disconnect: tell WhatsApp to remove this linked device (best effort, 20 s), so the phone's list is clean. */
export async function unlinkDevice(store: WhatsAppStore): Promise<boolean> {
  if (!store.auth.linked()) return false;
  const logger = quietLogger(() => {});
  const { state, saveCreds } = storeAuthState(store, logger);
  const sock = makeWASocket({ ...socketOptions(state, logger), syncFullHistory: false, shouldSyncHistoryMessage: () => false });
  sock.ev.on("creds.update", saveCreds);
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => { sock.end(undefined); resolve(false); }, 20_000);
    sock.ev.on("connection.update", async u => {
      if (u.connection === "open") { try { await sock.logout(); resolve(true); } catch { resolve(false); } finally { clearTimeout(timer); } }
      if (u.connection === "close") { clearTimeout(timer); resolve(false); }
    });
  });
}
