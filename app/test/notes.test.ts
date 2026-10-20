import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortal, type PortalDeps } from "../src/portal.ts";
import { noteTitle, obsidianUrl, parseNote } from "../portal/view.js";
import { freePort } from "./fixtures.ts";

const NOTE = "inbox/email/threads/2026-10/2026-10-08-fabrikam-q1-review-preparation.md";

test("note helpers derive a readable title, an Obsidian link and the body", () => {
  expect(noteTitle(NOTE)).toBe("Fabrikam q1 review preparation");
  expect(noteTitle("inbox/email/threads/2026-10/2026-10-08-sync-0123456789abcdef.md")).toBe("Sync");
  expect(obsidianUrl("brain", NOTE)).toBe("obsidian://open?vault=brain&file=inbox%2Femail%2Fthreads%2F2026-10%2F2026-10-08-fabrikam-q1-review-preparation");
  expect(parseNote(NOTE, '---\ntitle: "Fabrikam: Q1 review"\nsource: outlook-sync\n---\n\n# Summary\nAgreed.\n')).toEqual({ title: "Fabrikam: Q1 review", body: "# Summary\nAgreed." });
  expect(parseNote(NOTE, "No frontmatter").title).toBe("Fabrikam q1 review preparation");
});

test("note endpoint serves only notes in the connector folders", async () => {
  const brainPath = mkdtempSync(join(tmpdir(), "brain-"));
  mkdirSync(join(brainPath, "inbox/email/threads/2026-10"), { recursive: true });
  writeFileSync(join(brainPath, NOTE), "---\ntitle: x\n---\nbody");
  writeFileSync(join(brainPath, "inbox/email/threads/2026-10/unlisted.md"), "secret");
  const services = {
    config: () => ({ brainPath, clientId: "", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 10 }),
    state: () => ({ cursors: {}, threads: {}, queue: [], lookbackDays: 10, lastRun: null }),
    connected: () => true, running: () => null, schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }),
    configure: () => {}, action: async () => {}, exchange: async () => {},
    history: () => ({ total: 1, succeeded: 1, failed: 0, skipped: 0, entries: [{ id: "a", notes: [NOTE, "inbox/email/../../_setup/.env.md", "inbox/email/gone.md"] }] }),
  } as unknown as PortalDeps;
  const port = freePort(), server = createPortal(port, services), get = (path: string) => fetch(`http://127.0.0.1:${port}/api/note?path=${encodeURIComponent(path)}`);
  try {
    const ok = await get(NOTE);
    expect(ok.status).toBe(200); expect((await ok.json()).content).toContain("body");
    expect((await get("inbox/email/threads/2026-10/unlisted.md")).status).toBe(200); // any synced note can be previewed (Notes page)
    expect((await get("anchor/clients/acme/secret.md")).status).toBe(404); // never outside the connector folders
    expect((await get("inbox/email/../../_setup/.env.md")).status).toBe(404); // listed, but traversal
    expect((await get("inbox/email/gone.md")).status).toBe(404); // listed, but deleted since
    expect((await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).vault).toBe(brainPath.split(/[\\/]/).pop());
  } finally { server.stop(true); }
});

test("note preview Markdown: headings, lists, bold labels and safe links only", async () => {
  const { markdownBlocks, inlineMarkdown } = await import("../portal/view.js");
  const blocks = markdownBlocks("# Fabrikam: review\n\n## Summary\nLine one\nline two.\n\n## Detail\n- **Decision:** Renew\n- **Commitment (Aisyah → Acme):** Send PDF. Status: open\n\n## Links\n- [Open in Outlook](https://outlook.office365.com/owa/?ItemID=x)", "Fabrikam: review");
  expect(blocks.map(b => b.type)).toEqual(["h", "p", "h", "ul", "h", "ul"]); // the title heading is dropped (shown above)
  expect(blocks[1].inline).toEqual([{ t: "text", text: "Line one line two." }]);
  expect(blocks[3].items[0][0]).toEqual({ t: "b", text: "Decision:" });
  expect(blocks[5].items[0][0]).toEqual({ t: "link", text: "Open in Outlook", href: "https://outlook.office365.com/owa/?ItemID=x" });
  expect(inlineMarkdown("see [x](javascript:alert(1)) and https://a.example/b.")).toEqual([
    { t: "text", text: "see [x](javascript:alert(1)) and " }, { t: "link", text: "https://a.example/b", href: "https://a.example/b" }, { t: "text", text: "." }]);
  // Entity wikilinks show their name, not the vault path.
  expect(inlineMarkdown("[[inbox/entities/people/jane-lim|Jane Lim]] · [[Plain]]")).toEqual([
    { t: "text", text: "Jane Lim" }, { t: "text", text: " · " }, { t: "text", text: "Plain" }]);
});

test("notes index lists each source's notes, newest first, with title and summary", async () => {
  const { listNotes, countNotes } = await import("../src/notes-index.ts");
  const root = mkdtempSync(join(tmpdir(), "brain-notes-"));
  const write = (rel: string, title: string, last: string) => { mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), `---\ntitle: ${JSON.stringify(title)}\ncreated: 2026-10-01\nlast_message: ${last}\n---\n\n# ${title}\n\n## Summary\nWhat happened.\n`); };
  write("inbox/teams/chats/2026-10/a.md", "Chat A", "2026-10-14T09:00:00Z");
  write("inbox/teams/chats/2026-10/b.md", "Chat B", "2026-10-15T09:00:00Z");
  write("inbox/meetings/2026-10/m.md", "Kickoff", "2026-10-15T08:00:00Z");
  expect(listNotes(root, "teams-chat").map(n => n.title)).toEqual(["Chat B", "Chat A"]);
  expect(listNotes(root, "teams-chat")[0]).toMatchObject({ path: "inbox/teams/chats/2026-10/b.md", summary: "What happened.", source: "teams-chat" });
  expect(countNotes(root)).toEqual({ "email": 0, "teams-chat": 2, "teams-channel": 0, "meeting": 1, "ai-chat": 0, "chatgpt-chat": 0, "gmail": 0 });
  const { noteSource, matchesNote } = await import("../portal/view.js");
  expect(noteSource("inbox/meetings/2026-10/m.md").tag).toBe("Meeting");
  expect(matchesNote({ title: "IAQ workshop", summary: "RM 8,000" }, "rm 8")).toBe(true);
});
