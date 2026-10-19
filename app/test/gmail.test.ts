import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentParts, enrichGmailThread, gmailError, gmailItem, gmailQuery, GmailError, MESSAGES, openGmail, pullGmail, threadUrl,
  type GmailSession, type ImapClient, type RawMessage } from "../src/adapters/gmail-imap.ts";
import { DEFAULT_SCOPE, scopeKey } from "../src/adapters/gmail-scope.ts";
import { createGmailService, gmailInput, identityEmails, ownerEmails, sampleGmail } from "../src/gmail.ts";
import { groupThreads } from "../src/core/group.ts";
import { classify } from "../src/core/filter.ts";
import { renderThreadNote } from "../src/core/render.ts";
import { dueFeeds, scheduleKey } from "../src/feed-schedule.ts";
import { envWindowDays, isWindowFeed } from "../src/backfill.ts";
import { createPortal, type PortalDeps } from "../src/portal.ts";
import type { Config, State } from "../src/state.ts";
import type { Knowledge } from "../src/types.ts";
import { freePort } from "./fixtures.ts";
import { catalogModel, connectorsModel, NOTE_SOURCES, noteSource, viewModel, windowDialogModel } from "../portal/view.js";

const ME = { name: "Sam Owner", email: "owner@example.com" };
const PASSWORD = "abcdefghijklmnop"; // a made-up app password (16 letters)
const tmp = () => mkdtempSync(join(tmpdir(), "gmail-test-"));

const mime = (from: string, to: string, subject: string, body: string) => new TextEncoder().encode(
  `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Mon, 05 Oct 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`);

function raw(uid: number, thread: string, opts: Partial<RawMessage> = {}): RawMessage {
  return { uid, emailId: String(1000 + uid), threadId: thread, labels: ["\\Inbox"], flags: [], internalDate: new Date(Date.UTC(2026, 9, uid)),
    envelope: { subject: `Quote ${thread}`, from: [{ name: "Client Person", address: "Client@Example.com" }], to: [{ name: "Sam Owner", address: "owner@example.com" }] },
    size: 1000, source: mime("Client Person <client@example.com>", "owner@example.com", `Quote ${thread}`, `Price is 100 for ${uid}.\n\nOn Mon, someone wrote:\n> old`), ...opts };
}

/** A fake All Mail: `messages` by uid; search returns every uid matching the optional `uid` range. */
function fakeSession(messages: RawMessage[], o: { uidValidity?: string; failFetchAfter?: number; downloads?: Record<string, Uint8Array> } = {}) {
  const calls = { searches: [] as any[], fetches: [] as number[][], closed: 0 };
  let fetched = 0;
  const session: GmailSession = {
    uidValidity: o.uidValidity ?? "7",
    async search(q) {
      calls.searches.push(q);
      const from = q.uid ? Number(q.uid.split(":")[0]) : 1, max = Math.max(...messages.map(m => m.uid));
      return messages.map(m => m.uid).filter(u => u >= from || u === max); // `n:*` always includes the highest uid
    },
    async fetch(uids) {
      if (o.failFetchAfter != null && fetched >= o.failFetchAfter) throw new GmailError("timeout");
      fetched++; calls.fetches.push(uids);
      return messages.filter(m => uids.includes(m.uid));
    },
    async structure(uid) { return messages.find(m => m.uid === uid)?.bodyStructure ?? null; },
    async download(_uid, part) { return o.downloads?.[part] ?? null; },
    async close() { calls.closed++; },
  };
  return { session, calls };
}

test("the search is Primary inbox + Sent, never spam, trash or chats, inside the window", () => {
  expect(gmailQuery("2025-10-19T00:00:00Z")).toBe("(category:primary OR in:sent OR (is:important -category:primary)) -in:spam -in:trash -in:chats after:2025/10/19");
});

test("a fetched message becomes an Item: Gmail ids, thread link in hex, quoted text cut, sent mail marked as the owner's", async () => {
  const item = (await gmailItem(raw(3, "1844674407370955"), ME, "7"))!;
  expect(item).toMatchObject({ id: "gmail:1003", threadId: "gmail:1844674407370955", source: "gmail", folder: "inbox", subject: "Quote 1844674407370955",
    from: { name: "Client Person", email: "client@example.com" }, to: [{ name: "Sam Owner", email: "owner@example.com" }], account: { id: "gmail", label: "owner@example.com" } });
  expect(item.url).toBe(`https://mail.google.com/mail/u/0/#all/${(1844674407370955n).toString(16)}`);
  expect(item.text).toBe("Price is 100 for 3.");
  expect(item.at).toBe("2026-10-03T00:00:00Z");
  expect(item.hasAttachments).toBeUndefined();
  const sent = (await gmailItem(raw(4, "9", { labels: ["\\Sent"], envelope: { from: [{ address: "owner@example.com" }] } }), ME, "7"))!;
  expect(sent.folder).toBe("sentitems");
  expect(await gmailItem(raw(5, "9", { labels: ["\\Draft"] }), ME, "7")).toBeNull();
  expect(threadUrl("not a number")).toBe("https://mail.google.com/mail/u/0/#all");
});

test("file attachments are found in the body structure (inline signature images are not) and remembered by uid", async () => {
  const bodyStructure = { type: "multipart/mixed", childNodes: [
    { part: "1", type: "text/plain" },
    { part: "2", type: "image/png", id: "<logo>", parameters: { name: "logo.png" }, size: 400 },
    { part: "3", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "quote.pdf" }, encoding: "base64", size: 4000 },
  ] };
  expect(attachmentParts(bodyStructure)).toEqual([{ part: "3", name: "quote.pdf", type: "application/pdf", size: 3000 }]);
  const item = (await gmailItem(raw(8, "9", { bodyStructure }), ME, "7"))!;
  expect(item).toMatchObject({ hasAttachments: true, ref: "7:8" });
});

test("messages are grouped into threads by X-GM-THRID", async () => {
  const items = await Promise.all([raw(1, "111"), raw(2, "222"), raw(3, "111")].map(m => gmailItem(m, ME, "7")));
  const threads = groupThreads(items.map(i => i!), () => null);
  expect(threads.map(t => [t.id, t.items.length]).sort()).toEqual([["gmail:111", 2], ["gmail:222", 1]]);
});

test("pull: oldest first up to the budget, the cursor moves past what was read, and the next run continues there", async () => {
  const msgs = [1, 2, 3, 4, 5].map(u => raw(u, String(u)));
  const { session, calls } = fakeSession(msgs);
  const first = await pullGmail(async () => session, undefined, "2025-10-19T00:00:00Z", ME, 3);
  expect(first.items.map(i => i.id)).toEqual(["gmail:1001", "gmail:1002", "gmail:1003"]);
  expect(JSON.parse(first.next)).toMatchObject({ address: "owner@example.com", uidValidity: "7", lastUid: 3 });
  expect(calls.searches[0]).toEqual({ gmraw: gmailQuery("2025-10-19T00:00:00Z") });
  const second = await pullGmail(async () => session, first.next, "2025-10-19T00:00:00Z", ME, 3);
  expect(calls.searches[1].uid).toBe("4:*");
  expect(second.items.map(i => i.id)).toEqual(["gmail:1004", "gmail:1005"]);
  const third = await pullGmail(async () => session, second.next, "2025-10-19T00:00:00Z", ME, 3);
  expect(third.items).toEqual([]); // `6:*` matches uid 5 again; it is not read twice
  expect(JSON.parse(third.next).lastUid).toBe(5);
  expect(calls.closed).toBe(3);
});

test("pull: a new UIDVALIDITY or another address starts again from the window", async () => {
  const msgs = [1, 2].map(u => raw(u, String(u)));
  const { session } = fakeSession(msgs, { uidValidity: "8" });
  const reset = await pullGmail(async () => session, JSON.stringify({ address: "owner@example.com", uidValidity: "7", lastUid: 2, scopeKey: scopeKey(DEFAULT_SCOPE) }), "2025-10-19T00:00:00Z", ME);
  expect(reset.items).toHaveLength(2);
  expect(JSON.parse(reset.next)).toMatchObject({ uidValidity: "8", lastUid: 2 });
  const other = await pullGmail(async () => session, JSON.stringify({ address: "someone@example.com", uidValidity: "8", lastUid: 2, scopeKey: scopeKey(DEFAULT_SCOPE) }), "2025-10-19T00:00:00Z", ME);
  expect(other.items).toHaveLength(2);
  const garbage = await pullGmail(async () => session, "{not json", "2025-10-19T00:00:00Z", ME);
  expect(garbage.items).toHaveLength(2);
});

test("pull: a failure after some messages keeps them; a failure before any read throws and keeps the cursor", async () => {
  const msgs = Array.from({ length: 120 }, (_, i) => raw(i + 1, String(i + 1)));
  const partly = fakeSession(msgs, { failFetchAfter: 1 });
  const r = await pullGmail(async () => partly.session, undefined, "2025-10-19T00:00:00Z", ME);
  expect(r.items).toHaveLength(50); // one chunk of 50 read, then the server stopped
  expect(JSON.parse(r.next).lastUid).toBe(50);
  const none = fakeSession(msgs, { failFetchAfter: 0 });
  expect(pullGmail(async () => none.session, undefined, "2025-10-19T00:00:00Z", ME)).rejects.toThrow(MESSAGES.timeout);
  expect(none.calls.closed).toBe(1);
});

test("error mapping: fixed messages pointing at the right step, never the server's text", () => {
  const auth = gmailError({ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED", responseText: "Invalid credentials (Failure) for owner@example.com" });
  expect(auth.message).toBe(MESSAGES.auth);
  expect(auth.message).toContain("step 2");
  expect(auth.message).not.toContain("owner@example.com");
  expect(gmailError({ responseText: "[ALERT] Application-specific password required: https://support.example.com" }).message).toBe(MESSAGES.auth);
  expect(gmailError({ responseText: "[ALERT] Please log in via your web browser" }).message).toContain("step 1");
  expect(gmailError({ responseText: "[ALERT] Your account is not enabled for IMAP use." }).message).toContain("step 4");
  expect(gmailError({ code: "CONNECT_TIMEOUT" }).message).toBe(MESSAGES.timeout);
  expect(gmailError({ code: "ENOTFOUND" }).message).toBe(MESSAGES.network);
  expect(gmailError(new Error("boom with private text")).message).toBe(MESSAGES.other);
  for (const m of Object.values(MESSAGES)) for (const url of m.match(/https:\/\/\S+/g) ?? []) expect(url).toMatch(/^https:\/\/(myaccount\.google\.com|mail\.google\.com)\//);
});

function fakeClient(over: Partial<ImapClient> = {}) {
  const log: string[] = [];
  const client: ImapClient = {
    connect: async () => { log.push("connect"); },
    list: async () => [{ path: "INBOX" }, { path: "[Gmail]/Alle Nachrichten", specialUse: "\\All" }],
    mailboxOpen: async (path, o) => { log.push(`open ${path} ${o.readOnly}`); return { uidValidity: 42n }; },
    search: async () => [], fetchAll: async () => [], download: async () => ({}),
    logout: async () => { log.push("logout"); }, close: () => { log.push("close"); },
    ...over,
  };
  return { client, log };
}

test("open: LOGIN, then the \\All mailbox found by its flag (any language), read-only", async () => {
  const { client, log } = fakeClient();
  const s = await openGmail({ address: "owner@example.com", password: PASSWORD }, { create: () => client });
  expect(s.uidValidity).toBe("42");
  expect(log).toEqual(["connect", "open [Gmail]/Alle Nachrichten true"]);
  await s.close();
  expect(log.at(-1)).toBe("logout");
  const none = fakeClient({ list: async () => [{ path: "INBOX" }] });
  expect(openGmail({ address: "owner@example.com", password: PASSWORD }, { create: () => none.client })).rejects.toThrow(MESSAGES.noAllMail);
});

test("open: a wrong password gives the fixed message; a silent server times out and the connection is closed", async () => {
  const refused = fakeClient({ connect: async () => { throw Object.assign(new Error("Command failed"), { authenticationFailed: true, responseText: "Invalid credentials (Failure)" }); } });
  const e = await openGmail({ address: "owner@example.com", password: PASSWORD }, { create: () => refused.client }).catch(x => x);
  expect(e).toBeInstanceOf(GmailError);
  expect(e.message).toBe(MESSAGES.auth);
  expect(e.message).not.toContain("Invalid credentials");
  const silent = fakeClient({ connect: () => new Promise(() => {}) });
  const started = Date.now();
  const t = await openGmail({ address: "owner@example.com", password: PASSWORD }, { create: () => silent.client, limits: { connectMs: 50, commandMs: 50, fetchMs: 50 } }).catch(x => x);
  expect(t.message).toBe(MESSAGES.timeout);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(silent.log).toContain("close");
  const slowSearch = fakeClient({ search: () => new Promise(() => {}) });
  const s = await openGmail({ address: "owner@example.com", password: PASSWORD }, { create: () => slowSearch.client, limits: { connectMs: 50, commandMs: 50, fetchMs: 50 } });
  expect(s.search({ gmraw: "x" })).rejects.toThrow(MESSAGES.timeout);
});

test("open: fetch reads metadata, then the source; labels come back as a list", async () => {
  const { client } = fakeClient({
    fetchAll: async (_range, q) => q.source ? [{ uid: 5, source: new Uint8Array([65]) }]
      : [{ uid: 5, emailId: "1", threadId: "2", labels: new Set(["\\Sent"]), flags: new Set(), size: 10, envelope: {} }],
  });
  const s = await openGmail({ address: "owner@example.com", password: PASSWORD }, { create: () => client });
  const [m] = await s.fetch([5]);
  expect(m).toMatchObject({ uid: 5, emailId: "1", threadId: "2", labels: ["\\Sent"], flags: [] });
  expect(m.source).toEqual(new Uint8Array([65]));
});

test("enrich: attachment text with the Outlook limits, read only for the thread being extracted", async () => {
  const bodyStructure = { type: "multipart/mixed", childNodes: [{ part: "1", type: "text/plain" },
    { part: "2", type: "text/plain", disposition: "attachment", dispositionParameters: { filename: "terms.txt" }, size: 40 },
    { part: "3", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "huge.pdf" }, size: 40 * 1024 * 1024 }] };
  const m = raw(9, "9", { bodyStructure });
  const { session } = fakeSession([m], { downloads: { "2": new TextEncoder().encode("Payment in 30 days.") } });
  const item = (await gmailItem(m, ME, "7"))!;
  await enrichGmailThread(async () => session, { id: item.threadId, items: [item], existingNote: null });
  expect(item.attachments).toEqual([
    { name: "terms.txt", type: "text/plain", size: 19, status: "read", text: "Payment in 30 days." },
    { name: "huge.pdf", type: "application/pdf", size: 40 * 1024 * 1024, status: "skipped", reason: "too large to read" }]);
  const stale = (await gmailItem(m, ME, "6"))!; // the mailbox was rebuilt since the pull
  await enrichGmailThread(async () => session, { id: stale.threadId, items: [stale], existingNote: null });
  expect(stale.attachments?.[0].reason).toBe("could not be listed");
});

test("Gmail mail drops notification services, and its note goes to inbox/email/gmail with the Gmail link", async () => {
  const item = (await gmailItem(raw(2, "77"), ME, "7"))!;
  expect(classify({ ...item, from: { name: "", email: "notifications@github.com" } }, { muted: [] })).toBe("noise:sender"); // Gmail: notification services only
  expect(classify(item, { muted: [] })).toBeNull();
  const k: Knowledge = { keep: true, reason: "", title: "Quote agreed", summary: "Price 100.", client: null, tags: [], decisions: [], commitments: [], people: [], events: [], why: null };
  const note = renderThreadNote({ id: item.threadId, items: [item], existingNote: null }, k, { today: "2026-10-19" });
  if ("blocked" in note) throw new Error("blocked");
  expect(note.relPath).toBe("inbox/email/gmail/2026-10/2026-10-02-quote-agreed.md");
  expect(note.content).toContain("source: gmail-sync");
  expect(note.content).toContain("kind: email-thread");
  expect(note.content).toContain('tags: ["email", "account/owner-example-com"]');
  expect(note.content).toContain(`- [Open in Gmail](${threadUrl("77")})`);
});

test("schedule and window: feed gmail, 15 minutes by default, 1 year history, due on its own", () => {
  expect(scheduleKey("gmail")).toBe("gmail");
  expect(isWindowFeed("gmail")).toBe(true);
  expect(envWindowDays("gmail", { aiSinceDays: 30 } as any)).toBe(365);
  const now = Date.parse("2026-10-19T10:00:00Z");
  expect(dueFeeds({ email: ["inbox"], teams: [], mail: ["gmail"], chats: [], all: false, pulledAt: { outlook: "2026-10-19T09:59:00Z", gmail: "2026-10-19T09:40:00Z" }, saved: {}, now })).toEqual(["gmail"]);
  expect(dueFeeds({ email: [], teams: [], mail: ["gmail"], chats: [], all: false, pulledAt: { gmail: "2026-10-19T09:59:00Z" }, saved: {}, now })).toEqual([]);
  expect(dueFeeds({ email: [], teams: [], mail: ["gmail"], chats: [], all: true, pulledAt: { gmail: "2026-10-19T09:59:00Z" }, saved: {}, now })).toEqual(["gmail"]);
});

test("account: the password is stored encrypted, spaces are stripped, the address joins the owner's identity once", async () => {
  const dir = tmp(), file = join(dir, "gmail.json"), identityFile = join(dir, "owner-identity.json");
  expect(gmailInput(" Owner@Example.com ", "abcd efgh ijkl mnop")).toEqual({ address: "owner@example.com", password: PASSWORD });
  expect(() => gmailInput("not an address", PASSWORD)).toThrow(/Gmail address/);
  expect(() => gmailInput("owner@example.com", "short")).toThrow(/step 2/);
  let opened = 0;
  const svc = createGmailService({ file, identityFile, settingsFile: join(dir, "gmail-settings.json"), open: async a => { opened++; expect(a.password).toBe(PASSWORD); return fakeSession([]).session; }, ownerEmails: () => ["boss@example.com"] });
  expect(svc.status()).toMatchObject({ connected: false, address: null, passwordSaved: false, connectedAt: null, countsAsOwner: false, scopeChosen: false });
  expect(await svc.connect("owner@example.com", "abcd efgh ijkl mnop")).toEqual({ address: "owner@example.com", identityAdded: true });
  expect(opened).toBe(1);
  expect(readFileSync(file, "utf8")).not.toContain(PASSWORD);
  expect(svc.status()).toMatchObject({ connected: true, address: "owner@example.com", passwordSaved: true, countsAsOwner: true });
  expect(JSON.stringify(svc.status())).not.toContain(PASSWORD);
  expect((await svc.connect("owner@example.com", PASSWORD)).identityAdded).toBe(false); // already known
  expect(ownerEmails(["Boss@example.com"], identityFile)).toEqual(["boss@example.com", "owner@example.com"]);
  svc.disconnect();
  expect(existsSync(file)).toBe(false);
  expect(identityEmails(identityFile)).toEqual(["owner@example.com"]); // stays: old notes keep treating it as the owner
  // A refused login saves nothing.
  const refused = createGmailService({ file, identityFile, open: async () => { throw new GmailError("auth"); } });
  expect(refused.connect("owner@example.com", PASSWORD)).rejects.toThrow(MESSAGES.auth);
  expect(existsSync(file)).toBe(false);
});

test("estimate sample: newest date per thread, ids and dates only", async () => {
  const msgs = [raw(1, "a", { internalDate: new Date("2026-09-01T00:00:00Z") }), raw(2, "a", { internalDate: new Date("2026-10-01T00:00:00Z") }), raw(3, "b", { internalDate: new Date("2026-08-01T00:00:00Z") })];
  const { session } = fakeSession(msgs);
  expect(await sampleGmail(async () => session, "2024-10-19T00:00:00Z")).toEqual({ updated: ["2026-10-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"], complete: true });
});

// ── Portal routes ──
const cfg = { brainPath: "p", clientId: "c", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 30 } as Config;
const state: State = { cursors: {}, threads: {}, queue: [], muted: [], lastRun: null };
function portal(extra: Partial<PortalDeps> = {}) {
  const port = freePort(), base = `http://127.0.0.1:${port}`;
  const connects: unknown[][] = [], windows: [string, number][] = [];
  let connected = false;
  const services: PortalDeps = { config: () => cfg, state: () => state, connected: () => true, running: () => null,
    schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }), configure: () => {}, action: async () => {}, exchange: async () => {},
    gmail: {
      status: () => ({ connected, address: connected ? "owner@example.com" : null, passwordSaved: connected, connectedAt: null, countsAsOwner: connected }),
      connect: async (a, p) => { connects.push([a, p]); if (p !== PASSWORD) throw new GmailError("auth"); connected = true; return { address: String(a), identityAdded: true }; },
      disconnect: () => { connected = false; },
    },
    backfill: { windows: () => ({}), set: (f, d) => { windows.push([f, d]); return { widened: false, cursorReset: false, previous: 365 }; }, estimate: async () => ({}) },
    ...extra };
  const server = createPortal(port, services);
  let token = "";
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST",
    headers: { origin: base, "content-type": "application/json", "x-portal-token": token, ...headers }, body: JSON.stringify(body) });
  return { server, base, connects, windows, post, init: async (headers: Record<string, string> = {}) => { token = (await (await fetch(base, { headers })).text()).match(/name="portal-token" content="([^"]+)"/)![1]; } };
}

test("POST /api/gmail/connect tests the login, saves the window, and never echoes the password", async () => {
  const p = portal();
  try {
    await p.init();
    const bad = await p.post("/api/gmail/connect", { address: "owner@example.com", password: "zzzzzzzzzzzzzzzz" });
    expect(bad.status).toBe(400);
    const badText = await bad.text();
    expect(badText).toContain("step 2");
    expect(badText).not.toContain("zzzzzzzzzzzzzzzz");
    expect((await p.post("/api/gmail/connect", { address: "owner@example.com", password: PASSWORD, days: 12 })).status).toBe(400); // not a window choice
    const ok = await p.post("/api/gmail/connect", { address: "owner@example.com", password: PASSWORD, days: 730 });
    expect(ok.status).toBe(200);
    expect((await ok.json()).message).toContain("owner@example.com");
    expect(p.windows).toEqual([["gmail", 730]]);
    const status = await (await fetch(p.base + "/api/status")).text();
    expect(status).not.toContain(PASSWORD);
    expect(JSON.parse(status).gmail).toMatchObject({ connected: true, address: "owner@example.com", passwordSaved: true });
    expect(JSON.parse(status).feedSchedule.intervals.gmail).toBeUndefined(); // no feedSchedule service in this fixture
    expect((await p.post("/api/gmail/disconnect", {})).status).toBe(200);
    expect((await (await fetch(p.base + "/api/status")).json()).gmail.connected).toBe(false);
    expect((await p.post("/api/gmail/nope", {})).status).toBe(404);
    const big = await p.post("/api/gmail/connect", { address: "x".repeat(9000), password: PASSWORD });
    expect(big.status).toBe(413);
  } finally { p.server.stop(true); }
});

test("Gmail connect and disconnect are laptop-only: a remote session is refused", async () => {
  const port = freePort(), base = `http://127.0.0.1:${port}`;
  // The tunnel's public address is this same host; Cloudflare's header makes the request remote (a device session).
  const services: PortalDeps = { config: () => cfg, state: () => state, connected: () => true, running: () => null,
    schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }), configure: () => {}, action: async () => {}, exchange: async () => {},
    gmail: { status: () => ({ connected: false, address: null, passwordSaved: false, connectedAt: null, countsAsOwner: false }), connect: async () => { throw new Error("must not be called"); }, disconnect: () => { throw new Error("must not be called"); } },
    remote: { gbrainOrigin: "http://127.0.0.1:1", status: () => ({ url: base, mcpUrl: base + "/mcp" }), configure: () => {} } as any,
    sessions: { valid: () => true, linkValid: () => false, redeem: () => null, createLink: () => ({ token: "" }), revokeAll: () => {}, count: () => 1 } as any };
  const server = createPortal(port, services);
  try {
    const remote = { "cf-ray": "1", cookie: "x=1" };
    const token = (await (await fetch(base, { headers: remote })).text()).match(/name="portal-token" content="([^"]+)"/)![1];
    for (const path of ["/api/gmail/connect", "/api/gmail/disconnect"]) {
      const r = await fetch(base + path, { method: "POST", headers: { ...remote, origin: base, "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify({ address: "owner@example.com", password: PASSWORD }) });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatch(/laptop/);
    }
  } finally { server.stop(true); }
});

// ── View model ──
const base = {
  busy: false, needsLogin: false, connected: true, configured: true, indexPending: false, lastRun: null, lastSuccessAt: null,
  counts: { processed: 1, queued: 0, notes: 1, scannedFolders: 1, totalFolders: 1 },
  settings: { lookbackDays: 30, appliedDays: 30, threadsPerRun: 25, extractor: "Codex", model: "CLI default", provider: "codex" },
  schedule: { state: "Ready", enabled: true, backend: "docker", nextRun: null, lastRun: null },
};

test("view: Gmail is in Add connector until connected; then it has a card and a detail page with its facts", () => {
  const off = { ...base, gmail: { connected: false, address: null, passwordSaved: false } };
  expect(catalogModel(off).find((k: any) => k.id === "gmail")).toMatchObject({ name: "Gmail", icon: "at", action: "gmailAdd", laptopOnly: true, href: null });
  expect(connectorsModel(off).some((c: any) => c.id === "gmail")).toBe(false);
  const on = { ...base, gmail: { connected: true, address: "owner@example.com", passwordSaved: true }, backfill: { gmail: { days: 365, chosen: false } },
    feedSchedule: { intervals: { gmail: 30 }, lastPulledAt: {} } };
  expect(catalogModel(on).find((k: any) => k.id === "gmail")).toMatchObject({ href: "#/connectors/gmail", action: null, accounts: [{ email: "owner@example.com" }] });
  const card = connectorsModel(on, { gmail: 4 }).find((c: any) => c.id === "gmail");
  expect(card).toMatchObject({ ident: "owner@example.com", pill: { text: "Connected", tone: "ok" }, stat: ["4", "notes"], actions: ["gmailDisconnect"],
    schedule: { key: "gmail", minutes: 30 }, window: { feed: "gmail", days: 365, label: "1 year" } });
  expect(card.facts).toContainEqual(["App password", "Saved, encrypted on this computer"]);
  expect(card.about).toContain("every 30 minutes");
  const refused = { ...on, lastRun: { error: null, feedErrors: { gmail: MESSAGES.auth } } };
  expect(connectorsModel(refused).find((c: any) => c.id === "gmail")).toMatchObject({ pill: { tone: "warn" }, primary: "gmailAdd", actions: ["gmailDisconnect", "gmailAdd"] });
  expect(JSON.stringify(viewModel(on))).not.toContain(PASSWORD);
  expect(viewModel(on).controls.gmailDisconnect).toEqual({ label: "Disconnect", disabled: false });
});

test("view: a Gmail notes tab; Outlook's Email tab only covers inbox/email/threads", () => {
  expect(NOTE_SOURCES.find((s: any) => s.id === "gmail")).toEqual({ id: "gmail", label: "Gmail", tag: "Gmail", prefix: "inbox/email/gmail/" });
  expect(noteSource("inbox/email/gmail/2026-10/x.md").id).toBe("gmail");
  expect(noteSource("inbox/email/threads/2026-10/x.md").id).toBe("email");
});

test("view: the history window dialog speaks of Gmail threads and starts at 1 year", () => {
  const m = windowDialogModel({ est: null, status: base, feed: "gmail", mode: "add", current: undefined, claude: false });
  expect(m.title).toBe("How far back should Gmail mail go?");
  expect(m.selected).toBe(365);
  expect(m.choices[0].line).toBe("Counting threads…");
});
