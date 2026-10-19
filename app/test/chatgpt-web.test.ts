import { expect, test } from "bun:test";
import { branch, chatDocuments, chatgptApi, retryAfterMs, chatItems, iso, messageText, pullChatGptChats, enrichChatGptThread, type ConvDetail } from "../src/adapters/chatgpt-web.ts";
import { renderThreadNote } from "../src/core/render.ts";
import { buildPrompt } from "../src/core/extract.ts";
import { catalogModel, connectorsModel } from "../portal/view.js";
import type { Knowledge, Thread } from "../src/types.ts";

const ME = { name: "Aisyah Rahman", email: "aisyah@example.com" };
const t = (s: string) => Date.parse(s) / 1000;
const node = (id: string, parent: string | null, role: string, text: string, at = "2026-10-15T10:00:00Z", extra: object = {}) =>
  ({ id, parent, message: { id, author: { role }, create_time: t(at), content: { content_type: "text", parts: [text] }, ...extra } });
const conv = (nodes: ReturnType<typeof node>[], current: string, extra: Partial<ConvDetail> = {}): ConvDetail =>
  ({ title: "Portal quote", create_time: t("2026-10-15T09:00:00Z"), current_node: current, mapping: Object.fromEntries(nodes.map(n => [n.id, n])), ...extra });

test("branch follows the current node; text skips system, tools, reasoning and canvas payloads", () => {
  const d = conv([
    { id: "root", parent: null, message: null } as any,
    node("sys", "root", "system", "You are ChatGPT"),
    node("u1", "sys", "user", "Price for 12 seats?"),
    node("a-old", "u1", "assistant", "old answer"),
    node("a1", "u1", "assistant", "RM 1,089 each"),
    { id: "think", parent: "a1", message: { id: "think", author: { role: "assistant" }, content: { content_type: "thoughts" } } } as any,
    node("canvas", "think", "assistant", "{}", undefined, { recipient: "canmore.create_textdoc" }),
    node("u2", "canvas", "user", "Make it a quote", "2026-10-15T11:00:00Z", { metadata: { attachments: [{ name: "po.pdf" }] } }),
  ], "u2");
  expect(branch(d).map(m => m.id)).toEqual(["sys", "u1", "a1", "think", "canvas", "u2"]);
  expect(branch(d).map(messageText).filter(Boolean)).toEqual(["Price for 12 seats?", "RM 1,089 each", "Make it a quote\n[attached: po.pdf]"]);
  expect(iso(t("2026-10-15T08:00:00Z"))).toBe("2026-10-15T08:00:00.000Z"); // detail times are epoch seconds
  expect(iso("2026-10-15T10:00:00.123456Z")).toBe("2026-10-15T10:00:00.123Z");
});

test("items: ChatGPT source, own folder and link, project and account carried; note and prompt name ChatGPT", () => {
  const d = conv([node("u1", null, "user", "Price?"), node("a1", "u1", "assistant", "RM 1,089")], "a1");
  const items = chatItems("c1", d, ME, "2026-09-01T00:00:00Z", { project: { id: "g-p-1", name: "Portal Migration" }, account: { id: "chatgpt", label: "aisyah.home@example.net" } });
  expect(items.map(i => [i.id, i.threadId, i.from.name, i.source])).toEqual([["chatgpt:c1:u1", "ai-chatgpt:c1", "Aisyah Rahman", "chatgpt-chat"], ["chatgpt:c1:a1", "ai-chatgpt:c1", "ChatGPT", "chatgpt-chat"]]);
  expect(items[0]).toMatchObject({ url: "https://chatgpt.com/c/c1", subject: "Portal quote", project: { name: "Portal Migration" } });
  const k: Knowledge = { keep: true, reason: "", title: "Portal quote", summary: "s", client: null, tags: [], decisions: [], commitments: [], people: [], events: [], why: null };
  const thread: Thread = { id: "ai-chatgpt:c1", items, existingNote: null };
  const note = renderThreadNote(thread, k, { today: "2026-10-17" }) as { relPath: string; content: string };
  expect(note.relPath).toBe("inbox/ai/chatgpt/2026-10/2026-10-15-portal-quote.md");
  expect(note.content).toContain("source: chatgpt-sync");
  expect(note.content).toContain("- [Open in ChatGPT](https://chatgpt.com/c/c1)");
  expect(buildPrompt(thread, { name: "Aisyah Rahman" })).toContain("conversation between Aisyah and ChatGPT");
  expect(buildPrompt(thread)).toContain("conversation between the owner and ChatGPT");
  expect(buildPrompt(thread)).toContain("ChatGPT project: Portal Migration");
});

test("documents: canvas text (latest version), uploads by name, only from the new messages on", () => {
  const canvas = (id: string, parent: string, at: string, content: string) =>
    ({ id, parent, message: { id, author: { role: "assistant" }, create_time: t(at), recipient: "canmore.create_textdoc", content: { content_type: "code", text: JSON.stringify({ name: "Quote", type: "document", content }) } } });
  const d = conv([
    node("u1", null, "user", "Here", "2026-10-15T10:00:00Z", { metadata: { attachments: [{ name: "brief.pdf", size: 900, mime_type: "application/pdf" }, { name: "logo.png", mime_type: "image/png" }] } }),
    canvas("c1", "u1", "2026-10-15T10:01:00Z", "# Quote\n12 seats"),
    canvas("c2", "c1", "2026-10-15T10:02:00Z", "# Quote\n12 seats, RM 1,050"),
  ] as any, "c2");
  const by = Object.fromEntries(chatDocuments(d, "2026-10-01T00:00:00Z").map(x => [x.name, x]));
  expect(by["Quote.md"]).toMatchObject({ status: "read", text: "# Quote\n12 seats, RM 1,050" });
  expect(by["brief.pdf"]).toMatchObject({ status: "skipped", reason: "file content not available" });
  expect(by["logo.png"]).toMatchObject({ status: "skipped", reason: "image" });
  expect(chatDocuments(d, "2026-10-15T10:01:30Z").map(x => x.name)).toEqual(["Quote.md"]);
});

test("pull: newest-updated listing down to the watermark, oldest read first, project names, finishes over runs", async () => {
  const rows = ["c4", "c3", "c2", "c1"].map((id, i) => ({ id, title: id, update_time: `2026-10-0${4 - i}T00:00:00Z`, gizmo_id: id === "c3" ? "g-p-9" : null }));
  const asked: string[] = [];
  const api = { get: async (path: string): Promise<any> => {
    asked.push(path);
    if (path.startsWith("/backend-api/conversations")) return { items: rows, total: rows.length };
    if (path.startsWith("/backend-api/gizmos/snorlax")) return { items: [{ gizmo: { gizmo: { id: "g-p-9", display: { name: "Contoh Portal" } } } }], cursor: null };
    const id = path.split("/conversation/")[1];
    return conv([node(`${id}-m`, null, "user", `text ${id}`, "2026-10-01T00:00:00Z")], `${id}-m`, { title: id });
  } };
  const seen: string[] = []; let cursor: string | undefined;
  const lists = () => asked.filter(p => p.startsWith("/backend-api/conversations")).length;
  for (let run = 0; run < 3; run++) {
    const r = await pullChatGptChats(api, cursor, "2026-09-01T00:00:00Z", ME, { id: "chatgpt", label: "me" }, 2);
    seen.push(...r.items.map(i => `${i.threadId}${i.project ? `@${i.project.name}` : ""}`));
    cursor = r.next;
  }
  expect(seen).toEqual(["ai-chatgpt:c1", "ai-chatgpt:c2", "ai-chatgpt:c3@Contoh Portal", "ai-chatgpt:c4"]);
  expect(JSON.parse(cursor!)).toEqual({ top: "2026-10-04T00:00:00.000Z", pending: [] });
  const before = lists();
  expect((await pullChatGptChats(api, cursor, "2026-09-01T00:00:00Z", ME)).items).toEqual([]); // nothing new
  expect(lists() - before).toBe(1); // one page listed, not the whole history
  // A chat changed again while still pending is read once, at its newer time.
  rows.unshift({ id: "c1", title: "c1", update_time: "2026-10-05T00:00:00Z", gizmo_id: null });
  const again = await pullChatGptChats(api, cursor, "2026-09-01T00:00:00Z", ME);
  expect(again.items.map(i => i.threadId)).toEqual(["ai-chatgpt:c1"]);
});

test("pull: a failing chat keeps the rest pending; nothing read means the error is reported and nothing is lost", async () => {
  const rows = ["c3", "c2", "c1"].map((id, i) => ({ id, update_time: `2026-10-0${3 - i}T00:00:00Z` }));
  const api = (bad: string) => ({ get: async (path: string): Promise<any> => {
    if (path.startsWith("/backend-api/conversations")) return { items: rows };
    const id = path.split("/conversation/")[1];
    if (id === bad) throw new Error("ChatGPT request failed (HTTP 500)");
    return conv([node(`${id}-m`, null, "user", id, "2026-10-01T00:00:00Z")], `${id}-m`);
  } });
  const partly = await pullChatGptChats(api("c2"), undefined, "2026-09-01T00:00:00Z", ME);
  expect(partly.items.map(i => i.threadId)).toEqual(["ai-chatgpt:c1"]);
  expect(JSON.parse(partly.next).pending.map((p: any) => p.id)).toEqual(["c2", "c3"]);
  await expect(pullChatGptChats(api("c1"), undefined, "2026-09-01T00:00:00Z", ME)).rejects.toThrow("HTTP 500");
});

test("api: one refresh after a 401, clear errors for a browser check or lost access", async () => {
  let calls = 0, refreshed = 0;
  const auth = { backendAuth: async () => ({ accessToken: "old", accountId: "a" }), refreshAfter401: async () => { refreshed++; return { accessToken: "new", accountId: "a" }; } };
  const ok = chatgptApi(auth, (async (_u: string, init: any) => { calls++; return init.headers.authorization === "Bearer new" ? new Response('{"x":1}') : new Response("", { status: 401 }); }) as any);
  expect(await ok.get("/backend-api/x")).toEqual({ x: 1 });
  expect([calls, refreshed]).toEqual([2, 1]);
  const cf = chatgptApi(auth, (async () => new Response("<html>", { status: 403, headers: { "cf-mitigated": "challenge" } })) as any);
  await expect(cf.get("/x")).rejects.toThrow("browser check");
  const gone = chatgptApi({ ...auth, refreshAfter401: async () => ({ accessToken: "old", accountId: "a" }) }, (async () => new Response("", { status: 401 })) as any);
  await expect(gone.get("/x")).rejects.toThrow("Sign in again");
  // A passing server error or timeout is retried; one that persists is reported.
  let n = 0;
  const flaky = chatgptApi(auth, (async () => { n++; if (n === 1) throw new Error("timeout"); return n === 2 ? new Response("", { status: 500 }) : new Response('{"ok":true}'); }) as any, [0, 0]);
  expect(await flaky.get("/x")).toEqual({ ok: true });
  const down = chatgptApi(auth, (async () => new Response("", { status: 502 })) as any, [0, 0]);
  await expect(down.get("/x")).rejects.toThrow("HTTP 502");
  // A rate limit waits and retries; one that persists is reported as a rate limit.
  let m = 0;
  const busy = chatgptApi(auth, (async () => ++m < 3 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response('{"ok":2}')) as any, [0, 0], [0, 0]);
  expect(await busy.get("/x")).toEqual({ ok: 2 });
  expect(m).toBe(3);
  const limited = chatgptApi(auth, (async () => new Response("", { status: 429 })) as any, [0, 0], [0, 0]);
  await expect(limited.get("/x")).rejects.toThrow("rate limit");
  // Default: a rate limit ends the request at once (one call, no wait), so a sync run never waits minutes for it.
  let k = 0;
  const atOnce = chatgptApi(auth, (async () => { k++; return new Response("", { status: 429 }); }) as any, [0, 0]);
  await expect(atOnce.get("/x")).rejects.toThrow("rate limit");
  expect(k).toBe(1);
});

test("retryAfterMs: seconds, HTTP date, cap and fallback", () => {
  expect(retryAfterMs("7", 1)).toBe(7000);
  expect(retryAfterMs("600", 1)).toBe(60_000);
  expect(retryAfterMs(null, 20_000)).toBe(20_000);
  expect(retryAfterMs("soon", 5)).toBe(5);
  const d = retryAfterMs(new Date(Date.now() + 10_000).toUTCString(), 1);
  expect(d).toBeGreaterThan(8000); expect(d).toBeLessThanOrEqual(10_000);
});

test("enrich: canvas documents re-read for the chat being written", async () => {
  const d = conv([{ id: "c", parent: null, message: { id: "c", author: { role: "assistant" }, create_time: t("2026-10-15T10:00:00Z"), recipient: "canmore.create_textdoc", content: { content_type: "code", text: '{"name":"Plan","type":"document","content":"Week 1"}' } } } as any], "c");
  const thread: Thread = { id: "ai-chatgpt:c9", existingNote: null, items: chatItems("c9", conv([node("u", null, "user", "plan please")], "u"), ME, "2026-01-01T00:00:00Z") };
  await enrichChatGptThread({ get: async () => d }, thread);
  expect(thread.items.at(-1)!.attachments).toEqual([expect.objectContaining({ name: "Plan.md", status: "read", text: "Week 1" })]);
});

test("portal: ChatGPT chats card only once added; catalog offers it when signed in", () => {
  const base: any = { connected: true, needsLogin: false, configured: true, busy: false, schedule: { enabled: true, state: "Ready", nextRun: null },
    settings: { lookbackDays: 10, threadsPerRun: 25, provider: "codex", extractor: "Codex", model: "CLI default" }, counts: { processed: 0, notes: 0, queued: 0, scannedFolders: 0, totalFolders: 0 },
    lastRun: { feedErrors: {} }, ai: { chatgpt: { signedIn: true, email: "aisyah.home@example.net" }, keys: {} } };
  expect(connectorsModel({ ...base, chatgptChats: { enabled: false } }).some((c: any) => c.id === "chatgpt")).toBe(false);
  const card = connectorsModel({ ...base, chatgptChats: { enabled: true } }).find((c: any) => c.id === "chatgpt");
  expect(card).toMatchObject({ ident: "aisyah.home@example.net", pill: { text: "Connected" }, href: "#/connectors/chatgpt" });
  expect(catalogModel({ ...base, chatgptChats: { enabled: false } }).find((c: any) => c.id === "chatgpt")).toMatchObject({ action: "chatgptChatsEnable", pill: { text: "Not added" } });
  expect(catalogModel({ ...base, ai: { chatgpt: { signedIn: false } }, chatgptChats: { enabled: false } }).find((c: any) => c.id === "chatgpt")).toMatchObject({ action: "chatgptLogin" });
  const failing = connectorsModel({ ...base, chatgptChats: { enabled: true }, lastRun: { feedErrors: { "ai:chatgpt": "ChatGPT request failed (HTTP 500)" } } }).find((c: any) => c.id === "chatgpt");
  expect(failing).toMatchObject({ pill: { text: "Error" }, error: "ChatGPT request failed (HTTP 500)" });
});
