import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatKey, EZYCHAT_FEED, EzyChatError, ezychatApi, ezychatItems, MESSAGES, normalizeBase, pullEzyChat, type EzyChatChat } from "../src/adapters/ezychat.ts";
import { createEzyChatService, loadEzyChat } from "../src/ezychat.ts";
import { sampleEzyChat } from "../src/backfill-live.ts";
import { envWindowDays, isWindowFeed } from "../src/backfill.ts";
import { DEFAULT_INTERVALS, isRateLimit, scheduleKey } from "../src/feed-schedule.ts";
import { buildPrompt } from "../src/core/extract.ts";
import { renderThreadNote } from "../src/core/render.ts";
import { sourceOf } from "../src/usage.ts";
import { createPortal, type PortalDeps } from "../src/portal.ts";
import type { Config, State } from "../src/state.ts";
import type { Knowledge } from "../src/types.ts";
import { catalogModel, connectorsModel, NOTE_SOURCES, noteSource, viewModel, windowDialogModel } from "../portal/view.js";
import { fakeEzyChat, type FakeChat, type FakeEzyChat } from "./ezychat-fake.ts";
import { freePort } from "./fixtures.ts";

const OWNER = { name: "Pat Owner", email: "pat@example.com" };
const PHONE = "60123456789";
const tmp = () => mkdtempSync(join(tmpdir(), "ezychat-test-"));
const iso = (day: number, h = 9, m = 0) => new Date(Date.UTC(2026, 9, day, h, m)).toISOString();
const msgs = (n: number, startDay = 1, prefix = "m") => Array.from({ length: n }, (_, i) =>
  ({ id: `${prefix}${String(i).padStart(4, "0")}`, at: new Date(Date.UTC(2026, 9, startDay, 0, i)).toISOString(), from: (i % 2 ? "team" : "customer") as "team" | "customer", sender: i % 2 ? "phone" : "Aisyah Rahman", text: `message ${i}` }));
const chat = (n: number, extra: Partial<FakeChat> = {}): FakeChat => ({ jid: `601000000${String(n).padStart(2, "0")}@s.whatsapp.net`, name: `Customer ${n}`, phone: `+601000000${n}`,
  messages: [{ id: `c${n}`, at: iso(10, 9, n % 60), from: "customer", sender: `Customer ${n}`, text: `Hello from customer ${n}` }], ...extra });
const SINCE = "2026-09-01T00:00:00Z";

let fakes: FakeEzyChat[] = [];
const fake = (...a: Parameters<typeof fakeEzyChat>) => { const f = fakeEzyChat(...a); fakes.push(f); return f; };
afterEach(() => { for (const f of fakes) f.stop(); fakes = []; });
const api = (f: FakeEzyChat) => ezychatApi({ base: f.base, token: f.token });

describe("address", () => {
  test("the address is accepted with or without /mcp and a trailing slash, and stored as one base", () => {
    for (const raw of ["https://inbox.example.com", "https://inbox.example.com/", "https://inbox.example.com/mcp", "https://inbox.example.com/mcp/", " https://Inbox.Example.com/mcp ", "inbox.example.com/mcp"])
      expect(normalizeBase(raw)).toBe("https://inbox.example.com");
    expect(normalizeBase("https://example.com/ezy/mcp?x=1#y")).toBe("https://example.com/ezy");
    expect(normalizeBase("http://127.0.0.1:8080/mcp")).toBe("http://127.0.0.1:8080");
    expect(normalizeBase("http://localhost:3000/")).toBe("http://localhost:3000");
    for (const bad of ["", "not an address", "http://inbox.example.com", "ftp://inbox.example.com", "https://user:pw@inbox.example.com", 42])
      expect(() => normalizeBase(bad)).toThrow(EzyChatError);
  });
});

describe("MCP client", () => {
  test("one tools/call per POST, Accept for JSON and SSE, the bearer token; the result is the JSON in content[0].text", async () => {
    const f = fake([chat(1)]);
    const r = await api(f).call("list_chats", { limit: 10 });
    expect(r.chats[0]).toMatchObject({ jid: chat(1).jid, name: "Customer 1" });
    expect(f.state.lastHeaders.get("accept")).toContain("text/event-stream");
    expect(f.state.lastHeaders.get("content-type")).toBe("application/json");
    expect(f.calls).toEqual([{ tool: "list_chats", args: { limit: 10 } }]);
    expect((await api(f).call("get_stats", { days: 1 })).chats.open).toBe(1);
  });

  test("errors in plain words: 401 refused token, 404 access off, 403 tunnel only, 429 rate limit, network, tool error", async () => {
    const f = fake([chat(1)]);
    const fail = (p: Promise<unknown>) => p.then(() => { throw new Error("no error"); }, e => e as EzyChatError);
    const auth = await fail(ezychatApi({ base: f.base, token: "wrong" }).call("get_stats", {}));
    expect(auth).toBeInstanceOf(EzyChatError);
    expect(auth.code).toBe("auth");
    expect(auth.message).toBe(MESSAGES.auth);
    expect(auth.message).toContain("refused the token");
    f.state.mode = "off";
    expect((await fail(api(f).call("get_stats", {}))).message).toContain("Let AI assistants read this inbox");
    f.state.mode = "forbidden";
    expect((await fail(api(f).call("get_stats", {}))).message).toBe(MESSAGES.forbidden);
    f.state.mode = "rate";
    const rate = await fail(api(f).call("get_stats", {}));
    expect(rate.code).toBe("rate");
    expect(isRateLimit(rate.message)).toBe(true);
    f.state.mode = "on";
    const tool = await fail(api(f).call("get_messages", { jid: `${PHONE}@s.whatsapp.net` }));
    expect(tool.code).toBe("tool");
    expect(tool.message).not.toContain(PHONE); // the server's own words (which name the chat) are never repeated
    const base = f.base;
    f.stop();
    const net = await fail(ezychatApi({ base, token: "x" }).call("get_stats", {}, 2000));
    expect(net.code).toBe("network");
    expect(net.message).toContain(`not reachable at ${base}`);
  });
});

describe("items", () => {
  const c: EzyChatChat = { jid: `${PHONE}@s.whatsapp.net`, name: "Aisyah Rahman", phone: `+${PHONE}`, type: "direct", status: "open", assignedTo: "Daniel Tan", lastMessageAt: iso(31), tags: ["vip", "quote"] };
  const m = (extra: Record<string, unknown>) => ({ id: "x", at: iso(2), from: "customer", sender: "Aisyah Rahman", type: "text", text: "Hi", media: null, status: "read", ...extra });
  test("customer and team messages, owner on the phone, media markers, no phone numbers, one thread per chat per month", () => {
    const items = ezychatItems(c, [
      m({ id: "1", text: "Can I get a quote?" }),
      m({ id: "2", from: "team", sender: "phone", text: "Sure, sending today" }),
      m({ id: "3", from: "team", sender: "Daniel Tan", text: "Quote attached" }),
      m({ id: "4", type: "image", text: null, media: { mime: "image/jpeg", name: "photo.jpg", status: "ok" } }),
      m({ id: "5", type: "document", text: "Signed copy", media: { mime: "application/pdf", name: "po.pdf", status: "ok" } }),
      m({ id: "6", text: "   " }), m({ id: "7", type: "system", text: "Chat assigned" }),
      m({ id: "8", at: iso(31) + "", text: "Long", truncated: true }),
      m({ id: "9", at: "2026-11-01T01:00:00.000Z", text: "Next month" }),
    ], OWNER);
    expect(items.map(i => i.text)).toEqual(["Can I get a quote?", "Sure, sending today", "Quote attached", "[image: photo.jpg]", "Signed copy\n[document: po.pdf]", "Long […]", "Next month"]);
    expect(items[0]).toMatchObject({ from: { name: "Aisyah Rahman", email: "" }, folder: "inbox", source: "ezychat", subject: "Aisyah Rahman (EzyChat)", url: "" });
    expect(items[1]).toMatchObject({ from: OWNER, folder: "sentitems", to: [{ name: "Aisyah Rahman", email: "" }] });
    expect(items[2]).toMatchObject({ from: { name: "Daniel Tan", email: "" }, folder: "inbox" }); // a teammate, not the owner
    expect(items[0].ezychat).toEqual({ status: "open", assignedTo: "Daniel Tan", tags: ["vip", "quote"], inbox: null });
    const key = chatKey(c.jid);
    expect(items[0].id).toBe(`ezychat:${key}:1`);
    expect(items[0].threadId).toBe(`ezychat:${key}:2026-10`);
    expect(items[6].threadId).toBe(`ezychat:${key}:2026-11`);
    expect(JSON.stringify(items)).not.toContain(PHONE);
  });
  test("a chat without a name, or named by its number, is the EzyChat customer; several inboxes name the inbox", () => {
    for (const name of [null, `+${PHONE}`, "+60 12-345 6789"]) {
      const [i] = ezychatItems({ ...c, name }, [m({ sender: name })], OWNER);
      expect(i.from.name).toBe("EzyChat customer");
      expect(i.subject).toBe("EzyChat customer (EzyChat)");
    }
    const [i] = ezychatItems({ ...c, inboxId: 2, inboxName: "Sales" }, [m({})], OWNER);
    expect(i.subject).toBe("Aisyah Rahman (EzyChat, Sales)");
    expect(i.ezychat?.inbox).toBe("Sales");
  });
  test("the note goes to inbox/ezychat/chats with no link; the prompt carries the chat's status, assignee and labels", () => {
    const items = ezychatItems(c, [m({ id: "1", text: "Can I get a quote?" })], OWNER);
    const k: Knowledge = { keep: true, reason: "", title: "Quote for Aisyah", summary: "Asked for a quote.", client: null, tags: [], decisions: [], commitments: [], people: [], events: [], why: null };
    const note = renderThreadNote({ id: items[0].threadId, items, existingNote: null }, k, { today: "2026-10-31" });
    if ("blocked" in note) throw new Error("blocked");
    expect(note.relPath).toBe("inbox/ezychat/chats/2026-10/2026-10-02-quote-for-aisyah.md");
    expect(note.content).toContain("source: ezychat-sync");
    expect(note.content).toContain("kind: ezychat-chat");
    expect(note.content).toContain('tags: ["ezychat"]');
    expect(note.content).toContain("_No link available._");
    expect(note.content).not.toContain(PHONE);
    const prompt = buildPrompt({ id: items[0].threadId, items, existingNote: null }, { name: "Pat Owner" });
    expect(prompt).toContain("Source: EzyChat business chat");
    expect(prompt).toContain("EzyChat chat: status open; assigned to Daniel Tan; labels: vip, quote");
    expect(prompt).not.toContain(PHONE);
  });
});

describe("pull", () => {
  test("lists every page, reads each chat's messages page by page, and the next run reads only what is new", async () => {
    const big = chat(1, { messages: msgs(230, 2) });
    const chats = [big, ...Array.from({ length: 120 }, (_, i) => chat(i + 2))];
    const f = fake(chats);
    const first = await pullEzyChat(api(f), undefined, OWNER, SINCE, { chats: 200, calls: 200 });
    expect(first.items.length).toBe(230 + 120);
    expect(f.calls.filter(c => c.tool === "list_chats").length).toBe(2); // 121 chats, 100 a page
    expect(f.calls.filter(c => c.tool === "get_messages" && c.args.jid === big.jid).length).toBe(3); // 230 messages, 100 a page
    expect(f.calls.every(c => c.tool !== "list_chats" || c.args.limit === 100)).toBe(true);
    // Nothing new: one list call, no messages read.
    f.calls.length = 0;
    const idle = await pullEzyChat(api(f), first.next, OWNER, SINCE, { chats: 200, calls: 200 });
    expect(idle.items).toEqual([]);
    expect(f.calls.map(c => c.tool)).toEqual(["list_chats"]);
    // A new message in one chat: only that chat is read, and only its new message comes back.
    big.messages.push({ id: "new1", at: iso(20), from: "customer", sender: "Customer 1", text: "Any update?" });
    f.calls.length = 0;
    const next = await pullEzyChat(api(f), idle.next, OWNER, SINCE, { chats: 200, calls: 200 });
    expect(next.items.map(i => i.text)).toEqual(["Any update?"]);
    expect(f.calls.filter(c => c.tool === "get_messages").map(c => c.args.jid)).toEqual([big.jid]);
  });

  test("budget: at most 40 chats a run; the rest follow in the next runs, nothing read twice", async () => {
    const f = fake(Array.from({ length: 45 }, (_, i) => chat(i + 1)));
    const one = await pullEzyChat(api(f), undefined, OWNER, SINCE);
    expect(one.items.length).toBe(40);
    const two = await pullEzyChat(api(f), one.next, OWNER, SINCE);
    expect(two.items.length).toBe(5);
    expect(new Set([...one.items, ...two.items].map(i => i.id)).size).toBe(45);
    expect((await pullEzyChat(api(f), two.next, OWNER, SINCE)).items).toEqual([]);
  });

  test("budget: a chat longer than the call budget is read over several runs without gaps", async () => {
    const long = chat(1, { messages: msgs(450, 1) });
    const f = fake([long]);
    let cursor: string | undefined, all: string[] = [], runs = 0;
    do {
      const r = await pullEzyChat(api(f), cursor, OWNER, SINCE, { chats: 40, calls: 3 });
      all.push(...r.items.map(i => i.id)); cursor = r.next; runs++;
      if (runs > 10) throw new Error("does not finish");
    } while (all.length < 450);
    expect(new Set(all).size).toBe(450);
    expect(runs).toBeGreaterThan(1);
    expect((await pullEzyChat(api(f), cursor, OWNER, SINCE, { chats: 40, calls: 3 })).items).toEqual([]);
  });

  test("history window: older messages are passed over, and a chat quiet since before the window is not opened", async () => {
    const old = chat(1, { messages: [{ id: "o1", at: "2026-08-01T09:00:00.000Z", from: "customer", sender: null, text: "Old" }] });
    const mixed = chat(2, { messages: [{ id: "a", at: "2026-08-15T09:00:00.000Z", from: "customer", sender: null, text: "Before" }, { id: "b", at: iso(3), from: "customer", sender: null, text: "Inside" }] });
    const f = fake([old, mixed]);
    const r = await pullEzyChat(api(f), undefined, OWNER, SINCE);
    expect(r.items.map(i => i.text)).toEqual(["Inside"]);
    expect(f.calls.filter(c => c.tool === "get_messages").map(c => c.args.jid)).toEqual([mixed.jid]);
    expect(f.calls[0].args.since).toBe(Date.parse(SINCE));
  });

  test("429: what was read is kept and the next run continues; a 429 before anything was read ends the feed", async () => {
    const f = fake(Array.from({ length: 5 }, (_, i) => chat(i + 1)));
    f.state.rateAfter = 3; // list + 2 chats
    const part = await pullEzyChat(api(f), undefined, OWNER, SINCE);
    expect(part.items.length).toBe(2);
    f.calls.length = 0; f.state.rateAfter = Infinity;
    const rest = await pullEzyChat(api(f), part.next, OWNER, SINCE);
    expect(rest.items.length).toBe(3);
    expect(new Set([...part.items, ...rest.items].map(i => i.id)).size).toBe(5);
    f.state.mode = "rate";
    const e = await pullEzyChat(api(f), rest.next, OWNER, SINCE).then(() => null, err => err as Error);
    expect(isRateLimit(e!.message)).toBe(true);
  });

  test("a refused token fails the feed with the plain message, so the portal can offer Reconnect", async () => {
    const f = fake([chat(1)]);
    const e = await pullEzyChat(ezychatApi({ base: f.base, token: "revoked" }), undefined, OWNER, SINCE).then(() => null, err => err as Error);
    expect(e!.message).toBe(MESSAGES.auth);
  });

  test("estimate sample: the newest message time of each chat month in the window, from the chat list", async () => {
    const f = fake([chat(1), chat(2, { messages: [{ id: "x", at: "2026-08-01T00:00:00.000Z", from: "customer", sender: null, text: "old" }] })]);
    expect(await sampleEzyChat(api(f), SINCE)).toEqual({ updated: [new Date(Date.parse(iso(10, 9, 1))).toISOString()], complete: true });
  });
});

describe("feed settings", () => {
  test("feed ezychat: 15 minutes by default, a history window of 1 month until one is chosen, its own usage row", () => {
    expect(EZYCHAT_FEED).toBe("ezychat");
    expect(scheduleKey("ezychat")).toBe("ezychat");
    expect(DEFAULT_INTERVALS.ezychat).toBe(15);
    expect(isWindowFeed("ezychat")).toBe(true);
    expect(envWindowDays("ezychat", { aiSinceDays: 365 } as any)).toBe(30);
    expect(sourceOf({ thread: "ezychat:abc:2026-10" })).toBe("ezychat");
    expect(sourceOf({ source: "ezychat" })).toBe("ezychat");
  });
});

describe("sign-in", () => {
  /** Follows the approval page's redirect back to the portal callback, like the browser does. */
  async function approve(url: string) {
    const r = await fetch(url, { redirect: "manual" });
    expect(r.status).toBe(302);
    return new URL(r.headers.get("location")!);
  }

  test("OAuth: discovery, one registration, PKCE + state, code for a token stored encrypted; get_stats shows it works", async () => {
    const f = fake([chat(1), chat(2, { status: "resolved" })]), dir = tmp(), file = join(dir, "ezychat.json");
    const svc = createEzyChatService({ file });
    expect(svc.status()).toMatchObject({ connected: false, address: null });
    const redirect = "http://localhost:4321/ezychat/callback";
    const { url } = await svc.begin(`${f.base}/mcp/`, redirect);
    const auth = new URL(url);
    expect(auth.origin + auth.pathname).toBe(`${f.base}/oauth/authorize`);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("resource")).toBe(`${f.base}/mcp`);
    expect(auth.searchParams.get("redirect_uri")).toBe(redirect);
    expect(auth.searchParams.get("state")!.length).toBeGreaterThan(20);
    const back = await approve(url);
    expect(back.origin + back.pathname).toBe(redirect);
    const done = await svc.finish(back.searchParams);
    expect(done.message).toContain("EzyChat connected");
    expect(done.message).toContain("2 chats");
    expect(f.state.tokenForms[0]).toMatchObject({ grant_type: "authorization_code", redirect_uri: redirect, resource: `${f.base}/mcp` });
    expect(f.state.tokenForms[0].code_verifier.length).toBeGreaterThanOrEqual(43);
    expect(readFileSync(file, "utf8")).not.toContain(f.token);
    expect(loadEzyChat(file)).toMatchObject({ base: f.base, token: f.token });
    const status = svc.status();
    expect(status).toMatchObject({ connected: true, address: f.base, test: { ok: true } });
    expect(JSON.stringify(status)).not.toContain(f.token);
    // The same code or state cannot be used twice.
    await expect(svc.finish(back.searchParams)).rejects.toThrow(/expired or did not match/);
    // Reconnect keeps the registered app (EzyChat then replaces that app's token instead of adding one).
    const again = await svc.begin(f.base, redirect);
    expect(f.state.registrations).toBe(1);
    await svc.finish((await approve(again.url)).searchParams);
    expect((await svc.test()).message).toContain("2 chats");
    svc.disconnect();
    expect(existsSync(file)).toBe(false);
    await svc.begin(f.base, redirect); // forgotten on Disconnect: registers again
    expect(f.state.registrations).toBe(2);
  });

  test("OAuth: a wrong state, a denied approval or another issuer saves nothing", async () => {
    const f = fake([chat(1)]), file = join(tmp(), "ezychat.json"), svc = createEzyChatService({ file });
    const redirect = "http://localhost:4321/ezychat/callback";
    const { url } = await svc.begin(f.base, redirect);
    const back = await approve(url);
    const forged = new URLSearchParams(back.searchParams); forged.set("state", "forged");
    await expect(svc.finish(forged)).rejects.toThrow(/did not match/);
    const other = new URLSearchParams(back.searchParams); other.set("iss", "https://elsewhere.example.com");
    await expect(svc.finish(other)).rejects.toThrow(/did not match/);
    const denied = await approve(`${(await svc.begin(f.base, redirect)).url}&deny=1`);
    await expect(svc.finish(denied.searchParams)).rejects.toThrow(/cancelled or denied/);
    expect(existsSync(file)).toBe(false);
  });

  test("OAuth: access off in EzyChat or an unreachable address is told in plain words before the browser opens", async () => {
    const f = fake([]), svc = createEzyChatService({ file: join(tmp(), "ezychat.json") });
    f.state.mode = "off";
    await expect(svc.begin(f.base, "http://localhost:1/ezychat/callback")).rejects.toThrow(/Let AI assistants read this inbox/);
    await expect(svc.begin("https://user:pw@inbox.example.com", "http://localhost:1/ezychat/callback")).rejects.toThrow(/EzyChat address/);
  });
});

describe("portal", () => {
  const cfg = { brainPath: "p", clientId: "c", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 30 } as Config;
  const state: State = { cursors: {}, threads: {}, queue: [], muted: [], lastRun: null };
  function portal(f: FakeEzyChat, extra: Partial<PortalDeps> = {}) {
    const port = freePort(), base = `http://127.0.0.1:${port}`, windows: [string, number][] = [];
    const services: PortalDeps = { config: () => cfg, state: () => state, connected: () => true, running: () => null,
      schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }), configure: () => {}, action: async () => {}, exchange: async () => {},
      ezychat: createEzyChatService({ file: join(tmp(), "ezychat.json") }),
      backfill: { windows: () => ({}), set: (feed, days) => { windows.push([feed, days]); return { widened: false, cursorReset: false, previous: 30 }; }, estimate: async () => ({}) },
      ...extra };
    const server = createPortal(port, services);
    let token = "";
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST",
      headers: { origin: base, "content-type": "application/json", "x-portal-token": token, ...headers }, body: JSON.stringify(body) });
    return { server, base, port, windows, post, init: async (headers: Record<string, string> = {}) => { token = (await (await fetch(base, { headers })).text()).match(/name="portal-token" content="([^"]+)"/)![1]; } };
  }

  test("Connect sends the browser to EzyChat; the callback stores the token, clears the code and never shows the token", async () => {
    const f = fake([chat(1)]), p = portal(f);
    try {
      await p.init();
      expect((await p.post("/api/ezychat/connect", { address: f.base, days: 12 })).status).toBe(400); // not a window choice
      const bad = await p.post("/api/ezychat/connect", { address: "http://inbox.example.com" });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toContain("EzyChat address");
      const r = await p.post("/api/ezychat/connect", { address: `${f.base}/mcp`, days: 182 });
      expect(r.status).toBe(200);
      const { url } = await r.json() as { url: string };
      expect(new URL(url).searchParams.get("redirect_uri")).toBe(`http://localhost:${p.port}/ezychat/callback`);
      expect(p.windows).toEqual([["ezychat", 182]]);
      const approved = await fetch(url, { redirect: "manual" });
      const callback = new URL(approved.headers.get("location")!);
      callback.hostname = "127.0.0.1"; // the browser's localhost
      const done = await fetch(callback, { redirect: "manual" });
      expect(done.status).toBe(302);
      expect(done.headers.get("location")).toBe("/#/connectors/ezychat"); // the code leaves the address bar
      const status = await (await fetch(p.base + "/api/status")).text();
      expect(status).not.toContain(f.token);
      expect(JSON.parse(status).ezychat).toMatchObject({ connected: true, address: f.base });
      expect(JSON.parse(status).notice).toContain("EzyChat connected");
      expect(JSON.parse(status).backfill.ezychat).toEqual({ days: 30, chosen: false });
      // A replayed callback is refused.
      expect((await fetch(callback, { redirect: "manual" })).status).toBe(400);
      const tested = await p.post("/api/ezychat/test", {});
      expect((await tested.json()).message).toContain("1 chat");
      f.state.mode = "forbidden";
      const refused = await p.post("/api/ezychat/test", {});
      expect(refused.status).toBe(502);
      expect((await refused.json()).error).toBe(MESSAGES.forbidden);
      expect((await p.post("/api/ezychat/disconnect", {})).status).toBe(200);
      expect((await (await fetch(p.base + "/api/status")).json()).ezychat.connected).toBe(false);
      expect((await p.post("/api/ezychat/nope", {})).status).toBe(404);
    } finally { p.server.stop(true); }
  });

  test("EzyChat sign-in is laptop-only: a remote session cannot start it or use the callback", async () => {
    const port = freePort(), base = `http://127.0.0.1:${port}`;
    const services: PortalDeps = { config: () => cfg, state: () => state, connected: () => true, running: () => null,
      schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }), configure: () => {}, action: async () => {}, exchange: async () => {},
      ezychat: { status: () => ({ connected: false, address: null, connectedAt: null, test: null }), begin: async () => { throw new Error("must not be called"); },
        finish: async () => { throw new Error("must not be called"); }, test: async () => { throw new Error("must not be called"); }, disconnect: () => { throw new Error("must not be called"); } },
      remote: { gbrainOrigin: "http://127.0.0.1:1", status: () => ({ url: base, mcpUrl: base + "/mcp" }), configure: () => {} } as any,
      sessions: { valid: () => true, linkValid: () => false, redeem: () => null, createLink: () => ({ token: "" }), revokeAll: () => {}, count: () => 1 } as any };
    const server = createPortal(port, services);
    try {
      const remote = { "cf-ray": "1", cookie: "x=1" };
      const token = (await (await fetch(base, { headers: remote })).text()).match(/name="portal-token" content="([^"]+)"/)![1];
      for (const path of ["/api/ezychat/connect", "/api/ezychat/test", "/api/ezychat/disconnect"]) {
        const r = await fetch(base + path, { method: "POST", headers: { ...remote, origin: base, "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify({ address: "https://inbox.example.com" }) });
        expect(r.status).toBe(403);
      }
      expect((await fetch(`${base}/ezychat/callback?code=x&state=y`, { headers: remote, redirect: "manual" })).status).toBe(404);
    } finally { server.stop(true); }
  });
});

describe("view", () => {
  const base = {
    busy: false, needsLogin: false, connected: true, configured: true, indexPending: false, lastRun: null, lastSuccessAt: null,
    counts: { processed: 1, queued: 0, notes: 1, scannedFolders: 1, totalFolders: 1 },
    settings: { lookbackDays: 30, appliedDays: 30, threadsPerRun: 25, extractor: "Codex", model: "CLI default", provider: "codex" },
    schedule: { state: "Ready", enabled: true, backend: "docker", nextRun: null, lastRun: null },
  };
  test("EzyChat is in Add connector until connected; then a card with its address, Reconnect after a refused token", () => {
    const off = { ...base, ezychat: { connected: false, address: null, connectedAt: null, test: null } };
    expect(catalogModel(off).find((k: any) => k.id === "ezychat")).toMatchObject({ name: "EzyChat", action: "ezychatAdd", laptopOnly: true, href: null });
    expect(connectorsModel(off).some((c: any) => c.id === "ezychat")).toBe(false);
    const on = { ...base, ezychat: { connected: true, address: "https://inbox.example.com", connectedAt: "2026-10-30T00:00:00Z", test: { ok: true, at: "2026-10-30T00:00:00Z", summary: "12 chats" } },
      backfill: { ezychat: { days: 30, chosen: false } }, feedSchedule: { intervals: { ezychat: 15 }, lastPulledAt: {} } };
    expect(catalogModel(on).find((k: any) => k.id === "ezychat")).toMatchObject({ href: "#/connectors/ezychat", action: null, accounts: [{ email: "https://inbox.example.com" }] });
    const card = connectorsModel(on, { ezychat: 3 }).find((c: any) => c.id === "ezychat");
    expect(card).toMatchObject({ ident: "https://inbox.example.com", pill: { text: "Connected", tone: "ok" }, stat: ["3", "notes"], actions: ["ezychatTest", "ezychatDisconnect"],
      schedule: { key: "ezychat", minutes: 15 }, window: { feed: "ezychat", days: 30, label: "1 month" } });
    expect(card.facts).toContainEqual(["Last check", "12 chats"]);
    const refused = { ...on, lastRun: { error: null, feedErrors: { ezychat: MESSAGES.auth } } };
    expect(connectorsModel(refused).find((c: any) => c.id === "ezychat")).toMatchObject({ pill: { tone: "warn" }, primary: "ezychatAdd", actions: ["ezychatTest", "ezychatDisconnect", "ezychatAdd"] });
    expect(viewModel(refused).controls.ezychatAdd).toEqual({ label: "Reconnect", disabled: false });
    expect(viewModel(on).controls.ezychatDisconnect).toEqual({ label: "Disconnect", disabled: false });
  });
  test("an EzyChat notes tab and history window wording", () => {
    expect(NOTE_SOURCES.find((s: any) => s.id === "ezychat")).toEqual({ id: "ezychat", label: "EzyChat", tag: "EzyChat", prefix: "inbox/ezychat/" });
    expect(noteSource("inbox/ezychat/chats/2026-10/x.md").id).toBe("ezychat");
    const m = windowDialogModel({ est: null, status: base, feed: "ezychat", mode: "add", current: undefined, claude: false });
    expect(m.title).toBe("How far back should EzyChat chats go?");
    expect(m.selected).toBe(30);
    expect(m.choices[0].line).toBe("Counting chats…");
  });
});
