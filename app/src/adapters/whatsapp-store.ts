// The local WhatsApp store: one SQLite file in the state folder (never in the vault). The linked-device worker
// (whatsapp-worker.ts) writes it; the sync run reads the chats the owner turned on. Sign-in keys and message
// text are sealed with the state folder's secret.key (secret-box.ts); chat and contact names stay readable for
// the portal's chat list. Disconnect deletes the file.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "../state.ts";
import { sealer } from "../secret-box.ts";

export const WA_DB = join(STATE_DIR, "whatsapp", "whatsapp.db");

export interface WaMessage { jid: string; id: string; at: string; fromMe: boolean; sender: string | null; senderName: string | null; text: string }
export interface WaChat { jid: string; name: string | null; kind: "group" | "direct"; lastAt: string | null; count: number }

export const chatKind = (jid: string): WaChat["kind"] => jid.endsWith("@g.us") ? "group" : "direct";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_at TEXT, count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS contacts (jid TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, jid TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL,
  from_me INTEGER NOT NULL, sender TEXT, sender_name TEXT, text TEXT NOT NULL, UNIQUE (jid, id));
CREATE INDEX IF NOT EXISTS messages_chat ON messages (jid, seq);`;

export function openWhatsAppStore(file = WA_DB, opts: { readonly?: boolean } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, opts.readonly ? { readonly: true } : { create: true });
  db.exec("PRAGMA busy_timeout = 5000");
  if (!opts.readonly) { db.exec("PRAGMA journal_mode = WAL"); db.exec(SCHEMA); }
  const box = sealer(file);

  const insert = db.prepare("INSERT OR IGNORE INTO messages (jid, id, at, from_me, sender, sender_name, text) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const touch = db.prepare(`INSERT INTO chats (jid, last_at, count) VALUES (?1, ?2, 1)
    ON CONFLICT (jid) DO UPDATE SET count = count + 1, last_at = max(coalesce(last_at, ''), ?2)`);
  const chatName = db.prepare(`INSERT INTO chats (jid, name) VALUES (?1, ?2) ON CONFLICT (jid) DO UPDATE SET name = coalesce(?2, name)`);
  const contact = db.prepare(`INSERT INTO contacts (jid, name) VALUES (?, ?) ON CONFLICT (jid) DO UPDATE SET name = excluded.name`);

  return {
    /** Baileys auth state (creds and signal keys), sealed. */
    auth: {
      get: (k: string): string | null => { const row = db.query<{ v: string }, [string]>("SELECT v FROM auth WHERE k = ?").get(k); return row ? box.open(row.v) : null; },
      set: db.transaction((entries: [string, string | null][]) => {
        for (const [k, v] of entries) v === null ? db.run("DELETE FROM auth WHERE k = ?", [k]) : db.run("INSERT OR REPLACE INTO auth (k, v) VALUES (?, ?)", [k, box.seal(v)]);
      }),
      /** A phone approved this device (the creds name the account), not only keys made for a QR code. */
      linked(): boolean {
        const row = db.query<{ v: string }, []>("SELECT v FROM auth WHERE k = 'creds'").get(), creds = row && box.open(row.v);
        try { return !!creds && !!JSON.parse(creds).me?.id; } catch { return false; }
      },
      clear: () => { db.run("DELETE FROM auth"); },
    },
    /** Stores new messages (a known id is ignored); returns how many were new. */
    addMessages: db.transaction((list: WaMessage[]) => {
      let added = 0;
      for (const m of list) {
        if (insert.run(m.jid, m.id, m.at, m.fromMe ? 1 : 0, m.sender, m.senderName, box.seal(m.text)).changes) { touch.run(m.jid, m.at); added++; }
      }
      return added;
    }),
    nameChats: db.transaction((list: { jid: string; name: string | null }[]) => { for (const c of list) chatName.run(c.jid, c.name?.trim() || null); }),
    nameContacts: db.transaction((list: { jid: string; name: string }[]) => { for (const c of list) if (c.name.trim()) contact.run(c.jid, c.name.trim()); }),
    /** Chats with at least one stored message, newest first. A direct chat without its own name takes the contact name. */
    chats(): WaChat[] {
      return db.query<{ jid: string; name: string | null; last_at: string | null; count: number }, []>(
        `SELECT c.jid, coalesce(c.name, k.name) AS name, c.last_at, c.count FROM chats c LEFT JOIN contacts k ON k.jid = c.jid
         WHERE c.count > 0 ORDER BY c.last_at DESC`).all()
        .map(r => ({ jid: r.jid, name: r.name, kind: chatKind(r.jid), lastAt: r.last_at, count: r.count }));
    },
    contactName: (jid: string) => db.query<{ name: string }, [string]>("SELECT name FROM contacts WHERE jid = ?").get(jid)?.name ?? null,
    /** Messages of one chat stored after `afterSeq` and sent at or after `since` (the history window), in stored order. */
    messagesAfter(jid: string, afterSeq: number, limit = 2000, since = ""): (WaMessage & { seq: number })[] {
      return db.query<{ seq: number; jid: string; id: string; at: string; from_me: number; sender: string | null; sender_name: string | null; text: string }, [string, number, string, number]>(
        "SELECT * FROM messages WHERE jid = ? AND seq > ? AND at >= ? ORDER BY seq LIMIT ?").all(jid, afterSeq, since, limit)
        .map(r => ({ seq: r.seq, jid: r.jid, id: r.id, at: r.at, fromMe: !!r.from_me, sender: r.sender, senderName: r.sender_name, text: box.open(r.text) ?? "" }));
    },
    /** Notes-to-be for the backfill estimate: one row per chat and month since `since`, with its newest message time. */
    chatMonths(since: string): { jid: string; lastAt: string }[] {
      return db.query<{ jid: string; last_at: string }, [string]>(
        "SELECT jid, max(at) AS last_at FROM messages WHERE at >= ? GROUP BY jid, substr(at, 1, 7) ORDER BY last_at DESC").all(since)
        .map(r => ({ jid: r.jid, lastAt: r.last_at }));
    },
    /** Prepared statements first: on Windows an open statement keeps the file locked, and Disconnect deletes it. */
    close: () => { for (const s of [insert, touch, chatName, contact]) s.finalize(); db.close(); },
  };
}
export type WhatsAppStore = ReturnType<typeof openWhatsAppStore>;

/** Disconnect: the store, its WAL files, and nothing else in the state folder. Windows refuses to delete a file
 *  another process has open (a status read, a sync run), so it tries for up to 3 seconds. */
export function deleteWhatsAppStore(file = WA_DB): void {
  for (let attempt = 1; ; attempt++) {
    try { for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true }); return; }
    catch (e) { if (attempt >= 15 || (e as { code?: string }).code !== "EBUSY") throw e; Bun.sleepSync(200); }
  }
}
