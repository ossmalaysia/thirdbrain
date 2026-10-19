import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCOPE, labelTerm, parseScope, safeLabel, scopeKey, scopeQuery, termQuery, type GmailScope } from "../src/adapters/gmail-scope.ts";
import { gmailItem, GmailError, MESSAGES, pullGmail, userLabels, type GmailSession, type RawMessage } from "../src/adapters/gmail-imap.ts";
import { countScope, createGmailService, estimateScope, readScope, saveScope } from "../src/gmail.ts";
import { runOnce, type RunDeps } from "../src/pipeline.ts";
import { createPortal, type PortalDeps } from "../src/portal.ts";
import type { Config, State } from "../src/state.ts";
import { knowledge } from "./fixtures.ts";
import { freePort } from "./fixtures.ts";
import { gmailScopeModel, GMAIL_DEFAULT_SCOPE } from "../portal/view.js";

const SINCE = "2025-10-19T00:00:00Z", TAIL = "-in:spam -in:trash -in:chats after:2025/10/19";
const ME = { name: "Sam Owner", email: "owner@example.com" };
const tmp = () => mkdtempSync(join(tmpdir(), "gmail-scope-"));
const scope = (over: Partial<GmailScope>): GmailScope => ({ ...DEFAULT_SCOPE, primary: false, sent: false, important: false, ...over });

test("query: the default is Primary, Sent and Important mail from the other tabs", () => {
  expect(scopeQuery(DEFAULT_SCOPE, SINCE)).toBe(`(category:primary OR in:sent OR (is:important -category:primary)) ${TAIL}`);
});

test("query: each option on its own, and labels quoted", () => {
  const each: [Partial<GmailScope>, string][] = [[{ primary: true }, "category:primary"], [{ sent: true }, "in:sent"], [{ important: true }, "(is:important -category:primary)"],
    [{ updates: true }, "category:updates"], [{ promotions: true }, "category:promotions"], [{ social: true }, "category:social"], [{ forums: true }, "category:forums"],
    [{ labels: ["Clients/Big Project"] }, 'label:"Clients/Big Project"']];
  for (const [over, term] of each) expect(scopeQuery(scope(over), SINCE)).toBe(`(${term}) ${TAIL}`);
  expect(scopeQuery(scope({ sent: true, labels: ["B", "A"] }), SINCE)).toBe(`(in:sent OR label:"B" OR label:"A") ${TAIL}`);
  expect(termQuery("category:social", SINCE)).toBe(`category:social ${TAIL}`);
});

test("labels: names with quotes, backslashes or control characters are refused; at least one choice is required", () => {
  for (const bad of ['My "best" label', "back\\slash", "line\nbreak", "", " ", "x".repeat(201)]) {
    expect(safeLabel(bad)).toBe(false);
    expect(() => labelTerm(bad)).toThrow();
  }
  expect(() => parseScope({ primary: true, labels: ['a"b'] })).toThrow(/quotes or backslashes/);
  expect(() => parseScope({ primary: false, sent: false })).toThrow(/at least one/);
  expect(() => scopeQuery(scope({}), SINCE)).toThrow(/at least one/);
  expect(() => parseScope({ primary: "yes" })).toThrow();
  expect(() => parseScope({ primary: true, labels: Array.from({ length: 21 }, (_, i) => `L${i}`) })).toThrow(/at most 20/);
  expect(() => parseScope(null)).toThrow();
  expect(parseScope({ labels: ["Zeta", "Alpha", "Alpha"] })).toEqual(scope({ labels: ["Alpha", "Zeta"] }));
});

test("labels from IMAP LIST: system folders, INBOX and unselectable folders are left out", () => {
  expect(userLabels([{ path: "INBOX" }, { path: "[Gmail]/All Mail", specialUse: "\\All" }, { path: "[Gmail]" , flags: new Set(["\\Noselect"]) },
    { path: "[Google Mail]/Sent Mail" }, { path: "Receipts" }, { path: "Clients/Big Project" }, { path: "Old", flags: new Set(["\\Noselect"]) }]))
    .toEqual(["Clients/Big Project", "Receipts"]);
});

test("settings: missing or broken file means the default; saving reports whether the query changed", () => {
  const dir = tmp(), file = join(dir, "gmail-settings.json");
  try {
    expect(readScope(file)).toEqual({ scope: DEFAULT_SCOPE, chosen: false });
    expect(saveScope({ ...DEFAULT_SCOPE }, file).changed).toBe(false);
    expect(readScope(file).chosen).toBe(true);
    expect(saveScope({ ...DEFAULT_SCOPE, updates: true }, file)).toMatchObject({ changed: true, scope: { updates: true } });
    expect(() => saveScope({ primary: false }, file)).toThrow();
    expect(readScope(file).scope.updates).toBe(true); // a refused save keeps the last good one
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function raw(uid: number, thread: string): RawMessage {
  return { uid, emailId: String(5000 + uid), threadId: thread, labels: ["\\Inbox"], flags: [], internalDate: new Date(Date.UTC(2026, 8, uid)),
    envelope: { subject: `Order ${thread}`, from: [{ name: "Shop Person", address: "shop@example.com" }], to: [{ address: "owner@example.com" }] },
    source: new TextEncoder().encode(`From: shop@example.com\r\nSubject: Order ${thread}\r\nContent-Type: text/plain\r\n\r\nYour order ${uid} ships tomorrow.\r\n`) };
}
function session(messages: RawMessage[], o: { labels?: string[]; counts?: Record<string, number> } = {}) {
  const searches: string[] = [];
  const s: GmailSession = { uidValidity: "9", labels: o.labels,
    async search(q) { searches.push(q.gmraw + (q.uid ? ` uid ${q.uid}` : "")); const from = q.uid ? Number(q.uid.split(":")[0]) : 1;
      if (o.counts) { const hit = Object.entries(o.counts).find(([k]) => q.gmraw.startsWith(k)); return Array.from({ length: hit?.[1] ?? 0 }, (_, i) => i + 1); }
      return messages.map(m => m.uid).filter(u => u >= from); },
    async fetch(uids) { return messages.filter(m => uids.includes(m.uid)); },
    async structure() { return null; }, async download() { return null; }, async close() {} };
  return { s, searches };
}

test("cursor: another scope (or a cursor from before scopes) reads the window again, keeping UIDVALIDITY", async () => {
  const msgs = [1, 2, 3].map(u => raw(u, String(u)));
  const { s, searches } = session(msgs);
  const first = await pullGmail(async () => s, undefined, SINCE, ME, 200, DEFAULT_SCOPE);
  expect(JSON.parse(first.next)).toEqual({ address: "owner@example.com", uidValidity: "9", lastUid: 3, scopeKey: scopeKey(DEFAULT_SCOPE) });
  const same = await pullGmail(async () => s, first.next, SINCE, ME, 200, DEFAULT_SCOPE);
  expect(same.items).toEqual([]);
  expect(searches[1]).toContain("uid 4:*");
  const wider = { ...DEFAULT_SCOPE, updates: true };
  const again = await pullGmail(async () => s, first.next, SINCE, ME, 200, wider);
  expect(again.items).toHaveLength(3);
  expect(searches[2]).toBe(scopeQuery(wider, SINCE)); // from the start of the window
  expect(JSON.parse(again.next)).toMatchObject({ uidValidity: "9", scopeKey: scopeKey(wider) });
  const legacy = await pullGmail(async () => s, JSON.stringify({ address: "owner@example.com", uidValidity: "9", lastUid: 3 }), SINCE, ME, 200, DEFAULT_SCOPE);
  expect(legacy.items).toHaveLength(3); // the live account's cursor had no scope key: the default re-scans automatically
});

test("re-scan: messages already in the brain are duplicates, so no thread is summarised twice", async () => {
  const msgs = [1, 2, 3].map(u => raw(u, u === 3 ? "1" : String(u)));
  const { s } = session(msgs);
  const root = tmp();
  const cfg: Config = { brainPath: root, clientId: "x", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 7 };
  let scopeNow: GmailScope = DEFAULT_SCOPE, extracted = 0;
  const deps: RunDeps = { folders: ["gmail"], pull: (_f, cursor) => pullGmail(async () => s, cursor, SINCE, ME, 200, scopeNow),
    extract: async () => { extracted++; return { knowledge: knowledge(), costUsd: 0 }; },
    commit: () => ({ committed: true, indexed: true, detail: "ok" }), log: () => {}, today: "2026-10-19" };
  try {
    const state: State = { cursors: {}, threads: {}, queue: [], muted: [], lastRun: null };
    const r1 = await runOnce(cfg, state, deps, { dryRun: false, limit: 25, outRoot: root });
    expect(r1.report.written).toBe(2);
    expect(extracted).toBe(2);
    scopeNow = { ...DEFAULT_SCOPE, promotions: true };
    const r2 = await runOnce(cfg, r1.nextState, deps, { dryRun: false, limit: 25, outRoot: root });
    expect(r2.report.pulled).toBe(3); // the whole window was read again…
    expect(r2.report.duplicates).toBe(3); // …and every message was recognised
    expect(r2.report.written).toBe(0);
    expect(extracted).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("counts and estimate: one search per choice and label; new threads exclude mail already in the brain", async () => {
  const { s, searches } = session([], { labels: ["Receipts", 'Bad"Name'], counts: { "category:primary": 95, "in:sent": 30, "label:\"Receipts\"": 7 } });
  const c = await countScope(async () => s, SINCE);
  expect(c.options).toMatchObject({ primary: 95, sent: 30, updates: 0 });
  expect(c.labels).toEqual([{ name: "Receipts", count: 7 }]); // a name that cannot be quoted is not offered
  expect(searches.every(q => q.endsWith(TAIL))).toBe(true);
  const msgs = [raw(1, "a"), raw(2, "a"), raw(3, "b")];
  const est = await estimateScope(async () => session(msgs).s, DEFAULT_SCOPE, SINCE, id => id === "gmail:5001" || id === "gmail:5002");
  expect(est).toMatchObject({ messages: 3, threads: 2, newThreads: 1, complete: true });
});

test("service: counts are cached for an hour; a slow Gmail ends with the timeout message", async () => {
  const dir = tmp();
  try {
    const { secret } = { secret: join(dir, "gmail.json") };
    let opened = 0;
    const svc = createGmailService({ file: secret, settingsFile: join(dir, "s.json"), identityFile: join(dir, "i.json"), open: async () => { opened++; return session([], { labels: [] }).s; } });
    await svc.connect("owner@example.com", "abcdefghijklmnop");
    opened = 0;
    await svc.counts(SINCE); await svc.counts(SINCE);
    expect(opened).toBe(1);
    await svc.counts(SINCE, true);
    expect(opened).toBe(2);
    const slow = createGmailService({ file: secret, settingsFile: join(dir, "s.json"), timeoutMs: 30, open: () => new Promise(() => {}) });
    expect(slow.counts(SINCE)).rejects.toThrow(MESSAGES.timeout);
    expect(() => slow.estimate({ primary: false }, SINCE)).toThrow(/at least one/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Routes ──
const cfg = { brainPath: "p", clientId: "c", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 30 } as Config;
const st: State = { cursors: {}, threads: {}, queue: [], muted: [], lastRun: null };
function services(extra: Partial<PortalDeps> = {}) {
  const saved: unknown[] = [];
  const s: PortalDeps = { config: () => cfg, state: () => st, connected: () => true, running: () => null,
    schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }), configure: () => {}, action: async () => {}, exchange: async () => {},
    gmail: { status: () => ({ connected: true, address: "owner@example.com", passwordSaved: true, connectedAt: null, countsAsOwner: true, scope: DEFAULT_SCOPE, scopeChosen: false }),
      connect: async () => ({ address: "", identityAdded: false }), disconnect: () => {},
      setScope: raw => { const scope = parseScope(raw); saved.push(scope); return { scope, changed: scopeKey(scope) !== scopeKey(DEFAULT_SCOPE) }; },
      counts: async () => ({ at: "2026-10-19T00:00:00Z", sinceIso: SINCE, options: { primary: 95, sent: 30, important: 12, updates: 17183, promotions: 6012, social: 815, forums: 0 }, labels: [] }),
      estimate: async raw => { parseScope(raw); return { at: "", sinceIso: SINCE, messages: 125, threads: 80, newThreads: 40, complete: true }; } },
    ...extra };
  return { s, saved };
}
async function local(s: PortalDeps) {
  const port = freePort(), base = `http://127.0.0.1:${port}`, server = createPortal(port, s);
  const token = (await (await fetch(base)).text()).match(/name="portal-token" content="([^"]+)"/)![1];
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify(body) });
  return { server, post };
}

test("POST /api/gmail/scope saves valid choices and says the window is read again; bad input is refused", async () => {
  const { s, saved } = services(), p = await local(s);
  try {
    const ok = await p.post("/api/gmail/scope", { scope: { ...DEFAULT_SCOPE, social: true } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).message).toMatch(/reads the whole history window again.*skipped/);
    const same = await (await p.post("/api/gmail/scope", { scope: DEFAULT_SCOPE })).json();
    expect(same.message).toMatch(/Nothing changed/);
    for (const bad of [{}, { scope: { primary: false } }, { scope: { primary: true, labels: ['x"y'] } }, { scope: "all" }])
      expect((await p.post("/api/gmail/scope", bad)).status).toBe(400);
    expect(saved).toHaveLength(2);
    const counts = await (await p.post("/api/gmail/counts", {})).json();
    expect(counts.options.updates).toBe(17183);
    const est = await (await p.post("/api/gmail/estimate", { scope: DEFAULT_SCOPE })).json();
    expect(est).toMatchObject({ newThreads: 40, inputTokens: 40 * 7600, outputTokens: 40 * 420, writer: { provider: "codex" } });
    expect((await p.post("/api/gmail/estimate", { scope: { primary: false } })).status).toBe(400);
  } finally { p.server.stop(true); }
});

test("a slow or failing Gmail answers with a fixed message instead of hanging the page", async () => {
  const { s } = services();
  s.gmail!.counts = async () => { throw new GmailError("timeout"); };
  const p = await local(s);
  try {
    const r = await p.post("/api/gmail/counts", { refresh: true });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe(MESSAGES.timeout);
  } finally { p.server.stop(true); }
});

test("scope, counts and estimate are laptop-only: a remote session is refused", async () => {
  const port = freePort(), base = `http://127.0.0.1:${port}`;
  const { s, saved } = services({ remote: { gbrainOrigin: "http://127.0.0.1:1", status: () => ({ url: base, mcpUrl: base + "/mcp" }), configure: () => {} } as any,
    sessions: { valid: () => true, linkValid: () => false, redeem: () => null, createLink: () => ({ token: "" }), revokeAll: () => {}, count: () => 1 } as any });
  const server = createPortal(port, s);
  try {
    const remote = { "cf-ray": "1", cookie: "x=1" };
    const token = (await (await fetch(base, { headers: remote })).text()).match(/name="portal-token" content="([^"]+)"/)![1];
    for (const path of ["/api/gmail/scope", "/api/gmail/counts", "/api/gmail/estimate"]) {
      const r = await fetch(base + path, { method: "POST", headers: { ...remote, origin: base, "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify({ scope: DEFAULT_SCOPE }) });
      expect(r.status).toBe(403);
    }
    expect(saved).toEqual([]);
  } finally { server.stop(true); }
});

// ── View model ──
test("card: default choices, counts next to each, the estimate, Save only after a change", () => {
  expect(GMAIL_DEFAULT_SCOPE).toEqual(DEFAULT_SCOPE); // the browser copy matches the server's default
  const g = { connected: true, scope: DEFAULT_SCOPE, scopeChosen: false };
  const loading = gmailScopeModel(g);
  expect(loading.options.filter(o => o.checked).map(o => o.id)).toEqual(["primary", "sent", "important"]);
  expect(loading.summary).toBe("Primary, Sent and Important mail from other tabs (the default).");
  expect(loading.save.disabled).toBe(true);
  expect(loading.estimate).toMatch(/Estimating/);
  const counts = { at: "2026-10-19T00:00:00Z", options: { primary: 95, sent: 30, important: 12, updates: 17183, promotions: 6012, social: 815, forums: 0 }, labels: [{ name: "Receipts", count: 7 }] };
  const estimate = { messages: 125, threads: 80, newThreads: 40, inputTokens: 304000, outputTokens: 16800, hours: 0.5, writer: { provider: "codex", extractor: "Codex", model: "", billing: "subscription" }, decision: true };
  const m = gmailScopeModel(g, { counts, estimate, draft: { ...DEFAULT_SCOPE, updates: true, labels: ["Receipts"] } });
  expect(m.options.find(o => o.id === "updates")).toMatchObject({ checked: true, count: "about 17,183 messages" });
  expect(m.labels).toEqual([{ name: "Receipts", checked: true, count: "about 7 messages" }]);
  expect(m.estimate).toContain("40 new threads to summarise (125 messages, 80 threads in the window)");
  expect(m.writer).toMatch(/decision model checks each new thread/);
  expect(m.changeNote).toMatch(/reads the whole history window again/);
  expect(m.save.disabled).toBe(false);
  expect(m.scope).toEqual({ ...DEFAULT_SCOPE, updates: true, labels: ["Receipts"] });
  const none = gmailScopeModel(g, { draft: { ...DEFAULT_SCOPE, primary: false, sent: false, important: false } });
  expect(none).toMatchObject({ none: true, estimate: "Choose at least one kind of mail.", save: { disabled: true } });
  expect(gmailScopeModel(g, { countsError: "Counts appear after the portal restarts." }).countsNote).toBe("Counts appear after the portal restarts.");
});

test("an existing Gmail id is skipped by the pipeline whatever the scope (same id, same content)", async () => {
  const a = (await gmailItem(raw(1, "x"), ME, "9"))!, b = (await gmailItem(raw(1, "x"), ME, "9"))!;
  expect(a.id).toBe(b.id);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});
