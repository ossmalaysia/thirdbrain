import { expect, test } from "bun:test";
import { branch, chatDocuments, chatItems, enrichChatThread, messageText, pullClaudeChats, MAX_DOC_TEXT_PER_CHAT, type ChatDetail } from "../src/adapters/claude-web.ts";
import { renderThreadNote } from "../src/core/render.ts";
import { buildPrompt } from "../src/core/extract.ts";
import type { Knowledge, Thread } from "../src/types.ts";
import { browserApi, claudeUrl, ClaudeAuthError, ClaudeBlockedError, FETCH_IN_TAB, signedIn } from "../src/claude-web/session.ts";
import { findBrowser, launchArgs, onOrigin, pickTab } from "../src/claude-web/cdp.ts";

const ME = { name: "Aisyah Rahman", email: "aisyah@example.com" };
const msg = (uuid: string, parent: string | undefined, sender: string, text: string, at = "2026-10-15T10:00:00Z", index = 0) =>
  ({ uuid, parent_message_uuid: parent, sender, text, created_at: at, index });

test("branch follows the conversation shown on screen, ignoring abandoned edits (claude-sync migrate.Branch)", () => {
  const c: ChatDetail = { uuid: "c1", current_leaf_message_uuid: "a2", chat_messages: [
    msg("h1", undefined, "human", "Price for 12 seats?", undefined, 0), msg("a1-old", "h1", "assistant", "old answer", undefined, 1),
    msg("a1", "h1", "assistant", "RM 1,089 each", undefined, 1), msg("h2", "a1", "human", "Make it a quote", undefined, 2), msg("a2", "h2", "assistant", "Quote drafted", undefined, 3)] };
  expect(branch(c).map(m => m.uuid)).toEqual(["h1", "a1", "h2", "a2"]);
  expect(branch({ uuid: "c2", chat_messages: [msg("b", undefined, "assistant", "two", undefined, 1), msg("a", undefined, "human", "one", undefined, 0)] }).map(m => m.uuid)).toEqual(["a", "b"]);
});

test("message text: flat text, text blocks, tool calls and attachments", () => {
  expect(messageText({ uuid: "1", text: "hello" })).toBe("hello");
  expect(messageText({ uuid: "1", text: "", content: [{ type: "text", text: "Here is the plan" }, { type: "tool_use", name: "web_search" }, { type: "tool_result" }],
    files_v2: [{ file_name: "brief.pdf" }] })).toBe("Here is the plan\n[used tool: web_search]\n[attached: brief.pdf]");
});

test("chat items: one per on-screen message, Aisyah vs Claude, link to the chat", () => {
  const items = chatItems({ uuid: "c1", name: "IIB pricing", current_leaf_message_uuid: "a1",
    chat_messages: [msg("h1", undefined, "human", "Price?"), msg("a1", "h1", "assistant", "RM 1,089")] }, ME, "2026-09-15T00:00:00Z");
  expect(items.map(i => [i.id, i.from.name, i.folder, i.source])).toEqual([["ai-chat:c1:h1", "Aisyah Rahman", "sentitems", "ai-chat"], ["ai-chat:c1:a1", "Claude", "received", "ai-chat"]]);
  expect(items[0]).toMatchObject({ threadId: "ai-claude:c1", subject: "IIB pricing", url: "https://claude.ai/chat/c1" });
});

test("pull: only chats changed since the watermark, every organisation, watermark advances", async () => {
  const asked: string[] = [];
  const detail = (uuid: string) => ({ uuid, current_leaf_message_uuid: `${uuid}-m`, chat_messages: [msg(`${uuid}-m`, undefined, "human", `text ${uuid}`)] });
  const api = { get: async (path: string): Promise<any> => {
    asked.push(path);
    if (path === "/api/organizations") return [{ uuid: "personal" }, { uuid: "team" }];
    if (path.startsWith("/api/organizations/personal/chat_conversations_v2")) return { data: [
      { uuid: "new2", updated_at: "2026-10-15T12:00:00Z" }, { uuid: "new1", updated_at: "2026-10-15T09:00:00Z" }, { uuid: "old", updated_at: "2026-10-14T00:00:00Z" }], has_more: true };
    if (path.startsWith("/api/organizations/team/chat_conversations_v2")) return { data: [], has_more: false };
    return detail(path.split("/chat_conversations/")[1].split("?")[0]);
  } };
  const r = await pullClaudeChats(api, JSON.stringify({ personal: "2026-10-14T12:00:00Z" }), "2026-09-15T00:00:00Z", ME);
  expect(r.items.map(i => i.threadId)).toEqual(["ai-claude:new1", "ai-claude:new2"]); // oldest change first
  expect(asked.some(p => p.includes("/chat_conversations/old"))).toBe(false); // unchanged chat never fetched
  expect(asked.filter(p => p.includes("chat_conversations_v2?limit=50&offset=50"))).toHaveLength(0); // stopped at the watermark
  expect(asked.some(p => p.includes("/team/chat_conversations_v2"))).toBe(true); // every organisation
  expect(JSON.parse(r.next)).toEqual({ personal: "2026-10-15T12:00:00Z", team: "2026-09-15T00:00:00Z" });
});

test("pull: a backfill bigger than the per-run budget reads oldest first and finishes over several runs", async () => {
  const rows = ["c5", "c4", "c3", "c2", "c1"].map((uuid, i) => ({ uuid, updated_at: `2026-10-0${5 - i}T00:00:00Z` })); // newest first
  const api = { get: async (path: string): Promise<any> => {
    if (path === "/api/organizations") return [{ uuid: "o" }];
    if (path.includes("chat_conversations_v2")) { const off = Number(path.match(/offset=(\d+)/)![1]); return { data: rows.slice(off, off + 50), has_more: false }; }
    const id = path.split("/chat_conversations/")[1].split("?")[0];
    return { uuid: id, current_leaf_message_uuid: `${id}-m`, chat_messages: [msg(`${id}-m`, undefined, "human", id, "2026-10-01T00:00:00Z")] };
  } };
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let run = 0; run < 3; run++) {
    const r = await pullClaudeChats(api, cursor, "2026-09-01T00:00:00Z", ME, 2);
    seen.push(...r.items.map(i => i.threadId.replace("ai-claude:", "")));
    cursor = r.next;
  }
  expect(seen).toEqual(["c1", "c2", "c3", "c4", "c5"]);
});

test("pull: API-only organisations are skipped (they answer 403, which would read as signed out)", async () => {
  const asked: string[] = [];
  const api = { get: async (path: string): Promise<any> => {
    asked.push(path);
    if (path === "/api/organizations") return [{ uuid: "max", capabilities: ["claude_max", "chat"] }, { uuid: "console", capabilities: ["api", "api_individual"] }];
    if (path.includes("/console/")) throw new Error("403");
    return { data: [], has_more: false };
  } };
  const r = await pullClaudeChats(api, undefined, "2026-09-15T00:00:00Z", ME);
  expect(asked.some(p => p.includes("/console/"))).toBe(false);
  expect(Object.keys(JSON.parse(r.next))).toEqual(["max"]);
});

const K: Knowledge = { keep: true, reason: "", title: "Portal quote drafted", summary: "Quote drafted.", client: null, tags: [], decisions: [], commitments: [], people: [], events: [], why: null };

test("project: carried on items, tagged and linked in the note, named in the prompt", () => {
  const items = chatItems({ uuid: "c1", name: "Quote", project: { uuid: "p-1", name: "Portal Migration" }, current_leaf_message_uuid: "h1",
    chat_messages: [msg("h1", undefined, "human", "Draft the quote")] }, ME, "2026-09-15T00:00:00Z");
  expect(items[0].project).toEqual({ id: "p-1", name: "Portal Migration" });
  const thread: Thread = { id: "ai-claude:c1", items, existingNote: null };
  const note = renderThreadNote(thread, K, { today: "2026-10-17" }) as { content: string };
  expect(note.content).toContain('tags: ["ai-chat", "project/portal-migration"]');
  expect(note.content).toContain('project: "Portal Migration"');
  expect(note.content).toContain("- [Project: Portal Migration](https://claude.ai/project/p-1)");
  expect(buildPrompt(thread)).toContain("Claude project: Portal Migration");
  const loose = chatItems({ uuid: "c2", current_leaf_message_uuid: "h1", chat_messages: [msg("h1", undefined, "human", "hi")] }, ME, "2026-09-15T00:00:00Z");
  expect("project" in loose[0]).toBe(false);
});

test("documents: uploads (extracted text), documents Claude wrote (latest wins), shared files by name", () => {
  const tool = (name: string, input: object) => ({ type: "tool_use", name, input });
  const c: ChatDetail = { uuid: "c1", current_leaf_message_uuid: "a2", chat_messages: [
    { ...msg("h1", undefined, "human", "Here is the PO", "2026-10-01T00:00:00Z"), attachments: [{ file_name: "po.pdf", file_type: "pdf", file_size: 900, extracted_content: "PO 123 total RM 5,000" }],
      files: [{ file_name: "logo.png", file_kind: "image", size_bytes: 10 }] },
    { ...msg("a1", "h1", "assistant", "", "2026-10-01T00:01:00Z"), content: [
      tool("Write", { file_path: "/mnt/out/quote.html", content: "<style>.x{}</style><h1>Quote</h1><p>12 seats &amp; RM 1,089</p>" }),
      tool("create_file", { path: "/tmp/build.py", file_text: "print(1)" }),
      tool("artifacts", { command: "create", id: "plan", title: "Rollout plan", type: "text/markdown", content: "# Plan\nWeek 1" })] },
    { ...msg("h2", "a1", "human", "Update it", "2026-10-02T00:00:00Z") },
    { ...msg("a2", "h2", "assistant", "", "2026-10-02T00:01:00Z"), content: [
      tool("Write", { file_path: "/mnt/out/quote.html", content: "<p>12 seats, RM 1,050 each</p>" }),
      tool("present_files", { filepaths: ["/mnt/out/quote.pdf"] })] },
  ] };
  const docs = chatDocuments(c, "2026-09-01T00:00:00Z");
  const by = Object.fromEntries(docs.map(d => [d.name, d]));
  expect(by["po.pdf"]).toMatchObject({ status: "read", text: "PO 123 total RM 5,000" });
  expect(by["logo.png"]).toMatchObject({ status: "skipped", reason: "image" });
  expect(by["quote.html"]).toMatchObject({ status: "read", text: "12 seats, RM 1,050 each" }); // later version, tags stripped
  expect(by["build.py"]).toMatchObject({ status: "skipped", reason: "code or data file" });
  expect(by["Rollout plan.md"]).toMatchObject({ status: "read", text: "# Plan\nWeek 1" });
  expect(by["quote.pdf"]).toMatchObject({ status: "skipped", reason: "made by Claude; the file stays in Claude" });
  expect(chatDocuments(c, "2026-10-02T00:00:00Z").map(d => d.name)).toEqual(["quote.html", "quote.pdf"]); // only new messages
});

test("documents: credentials withheld, per-chat text limit", () => {
  const big = "x ".repeat(MAX_DOC_TEXT_PER_CHAT);
  const c: ChatDetail = { uuid: "c1", chat_messages: [{ ...msg("h1", undefined, "human", "files"), attachments: [
    { file_name: "env.txt", extracted_content: "password: hunter2hunter2" }, { file_name: "a.txt", extracted_content: "small" }, { file_name: "b.txt", extracted_content: big }, { file_name: "c.txt", extracted_content: big }] }] };
  const by = Object.fromEntries(chatDocuments(c, "2026-01-01T00:00:00Z").map(d => [d.name, d]));
  expect(by["env.txt"]).toMatchObject({ status: "skipped", reason: "withheld: looks like it contains credentials" });
  expect(by["a.txt"].status).toBe("read");
  expect(by["b.txt"].status).toBe("read"); // capped at 20k by textAttachment
  expect([by["b.txt"], by["c.txt"]].reduce((n, d) => n + (d.text?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_DOC_TEXT_PER_CHAT);
});

test("enrich: re-reads the chat from a chat-capable organisation and attaches documents to the last item", async () => {
  const items = chatItems({ uuid: "c1", current_leaf_message_uuid: "h1", chat_messages: [msg("h1", undefined, "human", "see file", "2026-10-15T10:00:00Z")] }, ME, "2026-09-15T00:00:00Z");
  const asked: string[] = [];
  const api = { get: async (path: string): Promise<any> => {
    asked.push(path);
    if (path === "/api/organizations") return [{ uuid: "console", capabilities: ["api"] }, { uuid: "max", capabilities: ["chat"] }];
    return { uuid: "c1", current_leaf_message_uuid: "h1", chat_messages: [{ ...msg("h1", undefined, "human", "see file", "2026-10-15T10:00:00Z"), attachments: [{ file_name: "brief.txt", extracted_content: "Scope: 3 sites" }] }] };
  } };
  const thread: Thread = { id: "ai-claude:c1", items, existingNote: null };
  await enrichChatThread(api, thread);
  expect(asked).toContain("/api/organizations/max/chat_conversations/c1?tree=True&rendering_mode=messages&render_all_tools=true");
  expect(asked.some(p => p.includes("/console/"))).toBe(false);
  expect(thread.items.at(-1)!.attachments).toEqual([expect.objectContaining({ name: "brief.txt", status: "read", text: "Scope: 3 sites" })]);
  expect(buildPrompt(thread)).toContain("#### Attachment: brief.txt\nScope: 3 sites");
});

test("accounts: first account keeps the original paths and feed; added ones get their own profile, port and feed", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { addAccount, listAccounts, removeAccount, createClaudeAccounts } = await import("../src/claude-web/accounts.ts");
  const dir = mkdtempSync(join(tmpdir(), "claude-accounts-"));
  try {
    writeFileSync(join(dir, "claude-browser.json"), JSON.stringify({ connected: true, port: 9333, email: "me@gmail.com" }));
    expect(listAccounts(dir)).toEqual([{ id: "personal", label: "Personal", file: join(dir, "claude-browser.json"), profileDir: join(dir, "claude-browser"), feed: "ai:claude" }]);
    const company = addAccount("  Company ", dir);
    expect(company).toMatchObject({ id: "company", label: "Company", feed: "ai:claude:company", profileDir: join(dir, "claude-browser-company") });
    expect(JSON.parse(require("node:fs").readFileSync(company.file, "utf8"))).toEqual({ connected: false, port: 9334, email: null });
    expect(addAccount("Lab", dir).id).toBe("lab");
    expect(JSON.parse(require("node:fs").readFileSync(join(dir, "claude-browser-lab.json"), "utf8")).port).toBe(9335);
    expect(() => addAccount("company", dir)).toThrow("already");
    // No name needed (accounts are shown by login email): the id is generated.
    const unnamed = addAccount("", dir);
    expect(unnamed).toMatchObject({ id: "account-4", label: "", feed: "ai:claude:account-4" });
    removeAccount(unnamed.id, dir);
    removeAccount("personal", dir); // the first account is never removed
    removeAccount("lab", dir);
    expect(listAccounts(dir).map(a => a.id)).toEqual(["personal", "company"]);

    const calls: string[] = [];
    const make = (o: { file?: string }) => { const id = o.file!.match(/claude-browser-(.+)\.json$/)?.[1] ?? "personal";
      return { status: () => ({ connected: id === "personal", email: null, signingIn: false, lastError: null, browserFound: true }),
        connect: async () => { calls.push(`connect ${id}`); }, disconnect: (f = false) => { calls.push(`disconnect ${id} ${f}`); },
        start: () => { calls.push(`start ${id}`); }, stop: () => { calls.push(`stop ${id}`); } } as any; };
    const accounts = createClaudeAccounts({ dir, make });
    accounts.start();
    expect(accounts.list().map(a => [a.id, a.feed, a.connected])).toEqual([["personal", "ai:claude", true], ["company", "ai:claude:company", false]]);
    await accounts.connect("company");
    const added = await accounts.add("Side project");
    expect(added).toEqual({ id: "side-project", label: "Side project" });
    accounts.disconnect("side-project");
    accounts.disconnect();
    expect(calls).toEqual(["start personal", "start company", "connect company", "start side-project", "connect side-project",
      "disconnect side-project true", "stop side-project", "disconnect personal true"]);
    expect(listAccounts(dir).map(a => a.id)).toEqual(["personal", "company"]);
    await expect(accounts.connect("nope")).rejects.toThrow("not set up");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("account: carried on items, tagged in the note and named in the prompt", () => {
  const items = chatItems({ uuid: "c1", current_leaf_message_uuid: "h1", chat_messages: [msg("h1", undefined, "human", "Plan Q4")] }, ME, "2026-09-15T00:00:00Z", { id: "account-2", label: "aisyah@example.com" });
  const thread: Thread = { id: "ai-claude:c1", items, existingNote: null };
  const note = renderThreadNote(thread, K, { today: "2026-10-17" }) as { content: string };
  expect(note.content).toContain('tags: ["ai-chat", "account/aisyah-example-com"]'); // by login email, not internal id
  expect(note.content).toContain('account: "aisyah@example.com"');
  expect(buildPrompt(thread)).toContain("Claude account: aisyah@example.com");
});

test("in-tab requests: host guard, signed out, Cloudflare challenge", async () => {
  expect(FETCH_IN_TAB).toContain('if (location.host !== "claude.ai")');
  const api = (r: object) => browserApi(9333, async () => r as never);
  await expect(api({ status: 0, host: "login.microsoftonline.com" }).get("/api/x")).rejects.toBeInstanceOf(ClaudeAuthError);
  await expect(api({ status: 403, body: "<title>Just a moment...</title>" }).get("/api/x")).rejects.toBeInstanceOf(ClaudeBlockedError);
  await expect(api({ status: 401, body: "{}" }).get("/api/x")).rejects.toBeInstanceOf(ClaudeAuthError);
  expect(await api({ status: 200, body: '[{"uuid":"o"}]' }).get("/api/organizations")).toEqual([{ uuid: "o" }]);
  expect(await signedIn(api({ status: 200, body: "[]" }))).toBe(false);
  expect(await signedIn(api({ status: 200, body: '[{"uuid":"o"}]' }))).toBe(true);
});

test("browser launch: headed with automation markers off and its own profile (claude-sync flags)", () => {
  const args = launchArgs("C:\\p", 9333, "https://claude.ai/");
  expect(args).toEqual(expect.arrayContaining(["--remote-debugging-port=9333", "--user-data-dir=C:\\p", "--disable-blink-features=AutomationControlled"]));
  expect(args.some(a => a.includes("headless"))).toBe(false);
  expect(findBrowser({})).toBeNull();
});

test("in-tab requests: the URL is an argument of a fixed function, never code", async () => {
  const calls: { fn: string; args: unknown[] }[] = [];
  const api = browserApi(9333, async (_port, fn, args) => { calls.push({ fn, args }); return { status: 200, body: "[]" } as never; });
  await api.get('/api/x?q=");alert(1);//');
  expect(calls[0].fn).toBe(FETCH_IN_TAB);
  expect(calls[0].args).toEqual(["https://claude.ai/api/x?q=%22);alert(1);//"]);
  // A path that would leave claude.ai is refused before anything runs in the tab.
  for (const bad of ["@evil.example/x", ".evil.example/x", ":443@evil.example/", "evil.example"]) {
    await expect(api.get(bad)).rejects.toThrow("not a Claude.ai path");
  }
  expect(calls.length).toBe(1);
  expect(claudeUrl("/api/organizations")).toBe("https://claude.ai/api/organizations");
});

test("claude.ai tab: exact origin, look-alike hosts are not it", () => {
  for (const url of ["https://claude.ai", "https://claude.ai/", "https://claude.ai/new", "https://CLAUDE.ai/chat/1"]) expect(onOrigin(url, "https://claude.ai")).toBe(true);
  for (const url of ["https://claude.ai.evil.com/", "https://evilclaude.ai/", "https://claude.ai:8443/", "http://claude.ai/",
    "https://claude.ai@evil.com/", "javascript:location='https://claude.ai'", "not a url", ""]) expect(onOrigin(url, "https://claude.ai")).toBe(false);
  const page = (id: string, url: string) => ({ id, type: "page", url });
  expect(pickTab([page("a", "https://claude.ai.evil.com/"), page("b", "https://evilclaude.ai/"), page("c", "https://claude.ai/new")], "https://claude.ai")?.id).toBe("c");
  expect(pickTab([page("a", "https://claude.ai.evil.com/")], "https://claude.ai")).toBeUndefined();
  expect(pickTab([page("a", "https://login.microsoftonline.com/x"), page("b", "https://claude.ai/")], "https://claude.ai")?.id).toBe("b");
  expect(pickTab([{ id: "w", type: "service_worker", url: "https://claude.ai/sw.js" }], "https://claude.ai")).toBeUndefined();
});
