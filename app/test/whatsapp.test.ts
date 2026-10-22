import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteWhatsAppStore, openWhatsAppStore, type WaMessage } from "../src/adapters/whatsapp-store.ts";
import { messageText, parseLinkLine, skipChat, storeAuthState, toWaMessage } from "../src/adapters/whatsapp-link.ts";
import { MAX_MESSAGES_PER_RUN, pullWhatsApp, waItems } from "../src/adapters/whatsapp-feed.ts";
import { createWhatsAppService, readChosen, saveChosen } from "../src/whatsapp.ts";
import { buildPrompt } from "../src/core/extract.ts";
import { notePath } from "../src/core/render.ts";
import { connectorsModel, catalogModel, waChatsModel } from "../portal/view.js";
import type { Supervisor } from "../src/remote/supervisor.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "wa-test-")), "whatsapp.db");
const GROUP = "120363000000000001@g.us", ALEX = "60100000001@s.whatsapp.net", SAM = "60100000002@s.whatsapp.net";
const msg = (jid: string, id: string, at: string, text: string, extra: Partial<WaMessage> = {}): WaMessage =>
  ({ jid, id, at, fromMe: false, sender: jid === GROUP ? SAM : jid, senderName: null, text, ...extra });
const owner = { name: "Pat Owner", email: "pat@example.com" };

describe("store", () => {
  test("messages are stored once, sealed, and counted per chat", () => {
    const file = tmp(), store = openWhatsAppStore(file);
    expect(store.addMessages([msg(ALEX, "a1", "2026-10-01T09:00:00.000Z", "Lunch on Friday?"), msg(ALEX, "a1", "2026-10-01T09:00:00.000Z", "Lunch on Friday?")])).toBe(1);
    store.addMessages([msg(GROUP, "g1", "2026-10-02T09:00:00.000Z", "Kickoff notes attached")]);
    store.nameChats([{ jid: GROUP, name: "Project Falcon" }]);
    store.nameContacts([{ jid: ALEX, name: "Alex Tan" }]);
    expect(store.chats()).toEqual([
      { jid: GROUP, name: "Project Falcon", kind: "group", lastAt: "2026-10-02T09:00:00.000Z", count: 1 },
      { jid: ALEX, name: "Alex Tan", kind: "direct", lastAt: "2026-10-01T09:00:00.000Z", count: 1 },
    ]);
    expect(store.messagesAfter(ALEX, 0).map(m => m.text)).toEqual(["Lunch on Friday?"]);
    store.close();
    const db = new Database(file, { readonly: true }), raw = db.query<{ text: string }, []>("SELECT text FROM messages").all();
    db.close();
    expect(raw.some(r => r.text.includes("Lunch"))).toBe(false);
    deleteWhatsAppStore(file);
    expect(existsSync(file)).toBe(false);
  });

  test("auth state survives a reopen; linked only once the phone approved", async () => {
    const file = tmp();
    let store = openWhatsAppStore(file);
    const a = storeAuthState(store);
    a.saveCreds();
    expect(store.auth.linked()).toBe(false); // keys for a QR code only
    await a.state.keys.set({ "pre-key": { "1": { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } } });
    (a.state.creds as { me?: { id: string } }).me = { id: "60100000009:1@s.whatsapp.net" };
    a.saveCreds();
    store.close();
    store = openWhatsAppStore(file);
    expect(store.auth.linked()).toBe(true);
    const b = storeAuthState(store);
    expect(b.state.creds.noiseKey.public).toEqual(a.state.creds.noiseKey.public);
    const keys = await b.state.keys.get("pre-key", ["1", "2"]);
    expect(Buffer.from(keys["1"].public)).toEqual(Buffer.from([1, 2, 3]));
    expect(keys["2"]).toBeUndefined();
    store.auth.clear();
    expect(store.auth.linked()).toBe(false);
    store.close();
  });
});

describe("link", () => {
  test("message text: words, media markers, nothing for reactions", () => {
    expect(messageText({ conversation: " hello " })).toBe("hello");
    expect(messageText({ extendedTextMessage: { text: "see link" } })).toBe("see link");
    expect(messageText({ ephemeralMessage: { message: { conversation: "disappearing" } } })).toBe("disappearing");
    expect(messageText({ imageMessage: { caption: "" } })).toBe("[photo]");
    expect(messageText({ documentMessage: { fileName: "quote.pdf" } })).toBe("[document: quote.pdf]");
    expect(messageText({ audioMessage: { ptt: true } })).toBe("[voice message]");
    expect(messageText({ reactionMessage: { text: "👍" } })).toBeNull();
  });

  test("status updates, channels and broadcast lists are skipped", () => {
    expect(skipChat("status@broadcast")).toBe(true);
    expect(skipChat("120363000000000002@newsletter")).toBe(true);
    expect(skipChat(GROUP)).toBe(false);
  });

  test("a WhatsApp message becomes a stored row; the owner's own has no sender", () => {
    const base = { messageTimestamp: 1791000000, message: { conversation: "Draft is ready" } };
    expect(toWaMessage({ key: { remoteJid: GROUP, id: "X1", participant: SAM, fromMe: false }, pushName: "Sam Lee", ...base } as never))
      .toEqual({ jid: GROUP, id: "X1", at: new Date(1791000000 * 1000).toISOString(), fromMe: false, sender: SAM, senderName: "Sam Lee", text: "Draft is ready" });
    expect(toWaMessage({ key: { remoteJid: ALEX, id: "X2", fromMe: true }, ...base } as never)).toMatchObject({ fromMe: true, sender: null, senderName: null });
    expect(toWaMessage({ key: { remoteJid: "status@broadcast", id: "X3" }, ...base } as never)).toBeNull();
  });

  test("status lines", () => {
    expect(parseLinkLine('WA {"state":"open","name":"Pat"}')).toEqual({ state: "open", name: "Pat" });
    expect(parseLinkLine("error: something")).toBeNull();
  });
});

describe("feed", () => {
  test("items: one thread per chat per month, names but never numbers", () => {
    const chat = { jid: GROUP, name: "Project Falcon", kind: "group" as const, lastAt: null, count: 2 };
    const items = waItems(chat, [
      { ...msg(GROUP, "g1", "2026-09-30T23:00:00.000Z", "Budget approved"), senderName: "Sam Lee" },
      { ...msg(GROUP, "g2", "2026-10-01T01:00:00.000Z", "Thanks", { fromMe: true, sender: null }) },
      { ...msg(GROUP, "g3", "2026-10-01T02:00:00.000Z", "Noted", { sender: "60100000003@s.whatsapp.net" }) },
    ], owner);
    expect(items.map(i => i.threadId)).toEqual([`whatsapp:${GROUP}:2026-09`, `whatsapp:${GROUP}:2026-10`, `whatsapp:${GROUP}:2026-10`]);
    expect(items.map(i => i.from.name)).toEqual(["Sam Lee", "Pat Owner", "Unknown member"]);
    expect(items[1].folder).toBe("sentitems");
    expect(JSON.stringify(items)).not.toContain("60100000003");
    expect(notePath({ id: items[0].threadId, items: [items[0]], existingNote: null }, "Falcon budget")).toBe("inbox/whatsapp/chats/2026-09/2026-09-30-falcon-budget.md");
    const prompt = buildPrompt({ id: items[0].threadId, items, existingNote: null }, { name: "Pat Owner" });
    expect(prompt).toContain("From: Sam Lee\n");
    expect(prompt).not.toContain("<>");
    expect(prompt).not.toContain("To: \n");
  });

  test("cursor per chat: a chat turned on later starts at its first message; the budget carries over", () => {
    const store = openWhatsAppStore(tmp());
    store.addMessages([msg(ALEX, "a1", "2026-10-01T09:00:00.000Z", "one"), msg(SAM, "s1", "2026-10-01T10:00:00.000Z", "two"), msg(ALEX, "a2", "2026-10-02T09:00:00.000Z", "three")]);
    const first = pullWhatsApp(store, undefined, [ALEX], owner);
    expect(first.items.map(i => i.text)).toEqual(["one", "three"]);
    const second = pullWhatsApp(store, first.next, [ALEX, SAM], owner);
    expect(second.items.map(i => i.text)).toEqual(["two"]);
    expect(pullWhatsApp(store, second.next, [ALEX, SAM], owner).items).toEqual([]);
    const limited = pullWhatsApp(store, undefined, [ALEX, SAM], owner, 1);
    expect(limited.items.map(i => i.text)).toEqual(["one"]);
    expect(pullWhatsApp(store, limited.next, [ALEX, SAM], owner).items.map(i => i.text)).toEqual(["three", "two"]);
    expect(MAX_MESSAGES_PER_RUN).toBeGreaterThan(100);
    store.close();
  });
});

describe("service", () => {
  test("chosen chats: only known chats are saved", () => {
    const file = join(mkdtempSync(join(tmpdir(), "wa-set-")), "s.json");
    expect(saveChosen([ALEX, "someone@else.com", GROUP], [ALEX, SAM], file)).toEqual([ALEX]);
    expect(readChosen(file)).toEqual([ALEX]);
    expect(() => saveChosen("all", [ALEX], file)).toThrow();
  });

  test("a linked device whose worker gave up is started again; an unlinked one is not", () => {
    let handler: (line: string) => boolean = () => false, runs = 0, state = "error";
    const fake = { run() { runs++; state = "starting"; }, stop() {}, status: () => ({ state, lastError: "WhatsApp link exited (code 1)", logTail: [] }) } as unknown as Supervisor;
    const dir = mkdtempSync(join(tmpdir(), "wa-retry-"));
    const svc = createWhatsAppService({ makeSupervisor: on => { handler = on; return fake; }, dbFile: join(dir, "w.db"), settingsFile: join(dir, "s.json") });
    svc.retryWhenStopped();
    expect(runs).toBe(0); // never linked
    svc.connect(); handler('WA {"state":"open","name":"Pat"}'); handler('WA {"state":"closed","reason":"code 408"}');
    expect(svc.status().phase).toBe("offline");
    state = "error"; // five quick failures: the supervisor gave up
    svc.retryWhenStopped();
    expect(runs).toBe(2);
    expect(svc.status().phase).toBe("connecting");
    state = "running"; svc.retryWhenStopped();
    expect(runs).toBe(2);
  });

  test("worker lines drive the phase: QR, open, history, signed out on the phone", async () => {
    let handler: (line: string) => boolean = () => false, stopped = 0, runs = 0;
    const fake = { run() { runs++; }, stop() { stopped++; }, status: () => ({ state: "running", lastError: null, logTail: [] }) } as unknown as Supervisor;
    const dir = mkdtempSync(join(tmpdir(), "wa-svc-"));
    const svc = createWhatsAppService({ makeSupervisor: on => { handler = on; return fake; }, dbFile: join(dir, "w.db"), settingsFile: join(dir, "s.json") });
    svc.connect();
    expect(runs).toBe(1);
    handler('WA {"state":"qr","qr":"2@abc,def"}');
    expect(svc.status()).toMatchObject({ added: true, phase: "linking", hasQr: true });
    expect(await svc.qrSvg()).toStartWith("<svg");
    expect(handler('WA {"state":"open","name":"Pat"}')).toBe(true);
    handler('WA {"state":"history","progress":40,"added":120}');
    handler('WA {"state":"history","progress":100,"added":30}');
    expect(svc.status()).toMatchObject({ phase: "connected", name: "Pat", hasQr: false, history: { progress: 100, added: 150 } });
    handler('WA {"state":"loggedOut"}');
    await Promise.resolve();
    expect(svc.status().phase).toBe("loggedOut");
    expect(stopped).toBeGreaterThan(0);
    await svc.disconnect();
    expect(svc.status()).toMatchObject({ added: false, phase: "off", chatsOn: 0 });
  });
});

describe("portal view", () => {
  const base = { busy: false, needsLogin: false, connected: true, lastRun: null, settings: { provider: "codex", extractor: "Codex", model: "default model", lookbackDays: 30 },
    counts: { scannedFolders: 0, totalFolders: 0 }, schedule: { state: "Ready", enabled: true, nextRun: null } };
  test("the WhatsApp card appears once added, and asks for chats when none is on", () => {
    const byId = (s: any) => Object.fromEntries(connectorsModel(s, {}).map((c: any) => [c.id, c]));
    expect(byId({ ...base, whatsapp: { added: false, phase: "off", chatsOn: 0 } }).whatsapp).toBeUndefined();
    expect(byId({ ...base, whatsapp: { added: true, phase: "connected", name: "Pat", chatsOn: 0 } }).whatsapp.pill).toEqual({ text: "Choose chats", tone: "warn" });
    expect(byId({ ...base, whatsapp: { added: true, phase: "connected", name: "Pat", chatsOn: 3 } }).whatsapp.pill.text).toBe("Connected");
    expect(byId({ ...base, whatsapp: { added: true, phase: "loggedOut", chatsOn: 3 } }).whatsapp).toMatchObject({ primary: "whatsappLink", pill: { text: "Signed out on the phone" } });
    const add = catalogModel({ ...base, whatsapp: { added: false, phase: "off" } }).find((c: any) => c.id === "whatsapp");
    expect(add).toMatchObject({ action: "whatsappLink", laptopOnly: true });
  });

  test("chat list: search, filters and unsaved changes", () => {
    const chats = [{ jid: GROUP, name: "Project Falcon", kind: "group", lastAt: "2026-10-02T09:00:00Z", count: 40, on: true },
      { jid: ALEX, name: "Alex Tan", kind: "direct", lastAt: "2026-10-01T09:00:00Z", count: 1, on: false }];
    expect(waChatsModel(chats).count).toBe("1 of 2 turned on");
    expect(waChatsModel(chats, { filter: "direct" }).rows.map((r: any) => r.name)).toEqual(["Alex Tan"]);
    expect(waChatsModel(chats, { q: "falc" }).rows[0].meta).toStartWith("Group · 40 messages");
    const m = waChatsModel(chats, { draft: new Set([ALEX]) });
    expect(m).toMatchObject({ dirty: "2 unsaved changes", save: { disabled: false }, count: "1 of 2 turned on" });
    expect(waChatsModel([], {}).empty).toContain("No chats yet");
  });
});
