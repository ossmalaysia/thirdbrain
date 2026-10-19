import { describe, expect, test } from "bun:test";
import { normalizeOutlook, stripQuotedAndSignature } from "../src/adapters/outlook-normalize.ts";
import { groupThreads } from "../src/core/group.ts";
import { renderThreadNote, slugify } from "../src/core/render.ts";
import { buildPrompt, parseKnowledge } from "../src/core/extract.ts";
import { item, knowledge } from "./fixtures.ts";

describe("normalize", () => {
  test("strips Gmail-style quoted reply", () =>
    expect(stripQuotedAndSignature("Sounds good.\n\nOn Mon, 22 Sep 2026 at 10:00, Jane <jane@acme.com> wrote:\n> old stuff")).toBe("Sounds good."));
  test("strips Outlook reply header", () =>
    expect(stripQuotedAndSignature("Agreed.\r\n\r\nFrom: Jane Lim <jane@acme.com>\r\nSent: Monday\r\nSubject: x")).toBe("Agreed."));
  test("strips mobile signature", () =>
    expect(stripQuotedAndSignature("Line one\nLine two\nGet Outlook for Android")).toBe("Line one\nLine two"));
  test("Graph message -> Item", () => {
    const it = normalizeOutlook({
      id: "m1", conversationId: "c1", receivedDateTime: "2026-09-22T09:00:00Z",
      from: { emailAddress: { name: "Jane", address: "Jane@Acme.com" } },
      toRecipients: [{ emailAddress: { name: "Aisyah", address: "aisyah@example.com" } }],
      subject: " Re: Renewal ", body: { contentType: "text", content: "Yes.\nOn Mon 22 Sep, Jane wrote:\n> older" }, webLink: "https://outlook/x",
    }, "inbox");
    expect(it).toMatchObject({ id: "m1", threadId: "c1", subject: "Re: Renewal", text: "Yes.", url: "https://outlook/x" });
    expect(it.from.email).toBe("jane@acme.com");
  });
});

describe("group", () => {
  test("groups by thread, dedups, oldest-first inside, newest thread first", () => {
    const a1 = item({ id: "a1", threadId: "A", at: "2026-09-20T00:00:00Z" });
    const a2 = item({ id: "a2", threadId: "A", at: "2026-09-21T00:00:00Z" });
    const b1 = item({ id: "b1", threadId: "B", at: "2026-09-23T00:00:00Z" });
    const threads = groupThreads([a2, b1, a1, a1], id => (id === "A" ? "existing" : null));
    expect(threads.map(t => t.id)).toEqual(["B", "A"]);
    expect(threads[1].items.map(i => i.id)).toEqual(["a1", "a2"]);
    expect(threads[1].existingNote).toBe("existing");
  });
});

describe("render", () => {
  const thread = { id: "AAQkAGRi-conv", items: [item({ at: "2026-09-22T09:00:00Z" })], existingNote: null };

  test("path, frontmatter and sections follow the note template", () => {
    const note = renderThreadNote(thread, knowledge(), { today: "2026-09-25" });
    if ("blocked" in note) throw new Error(note.blocked);
    expect(note.relPath).toBe("inbox/email/threads/2026-09/2026-09-22-acme-renewal-pricing-agreed.md");
    expect(note.content).toContain('source: outlook-sync');
    expect(note.content).toContain('tags: ["email", "client/acme", "renewal"]');
    expect(note.content).toContain('conversation_id: "AAQkAGRi-conv"');
    for (const h of ["## Summary", "## Detail", "## Why", "## Links"]) expect(note.content).toContain(h);
    expect(note.content).toContain("**Commitment (Aisyah → Acme):** Send signed SOW, due 2026-10-01. Status: open");
    expect(note.content).toContain("[Open in Outlook](https://outlook.office365.com/");
  });

  test("same input renders identically (idempotent)", () => {
    const a = renderThreadNote(thread, knowledge(), { today: "2026-09-25" });
    const b = renderThreadNote(thread, knowledge(), { today: "2026-09-25" });
    expect(a).toEqual(b);
  });

  test("keeps the path of a note the thread already owns", () => {
    const note = renderThreadNote(thread, knowledge({ title: "New title" }), { relPath: "inbox/email/threads/x.md", today: "2026-09-25" });
    expect("relPath" in note && note.relPath).toBe("inbox/email/threads/x.md");
  });

  test("blocks a note if the AI leaked a secret into it", () => {
    const note = renderThreadNote(thread, knowledge({ summary: "Temporary password is Welcome123 for the portal" }), { today: "2026-09-25" });
    expect(note).toEqual({ blocked: "secret:password" });
  });

  test("backfill preserves the latest message timestamp and earliest created date", () => {
    const existingNote = "---\ncreated: 2026-09-20\nlast_message: 2026-09-25T09:00:00Z\n---\n# Existing";
    const note = renderThreadNote({ ...thread, existingNote }, knowledge(), { today: "2026-09-26" });
    expect("content" in note && note.content).toContain("created: 2026-09-20");
    expect("content" in note && note.content).toContain("last_message: 2026-09-25T09:00:00Z");
  });

  test("model-generated URLs are included in secret scanning", () => {
    const note = renderThreadNote(thread, knowledge({ summary: "See https://example.test/?token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123" }), { today: "2026-09-25" });
    expect(note).toEqual({ blocked: "secret:api-key" });
  });

  test("quotes in titles cannot break the YAML", () => {
    const note = renderThreadNote(thread, knowledge({ title: 'Plan: "phase 2": go' }), { today: "2026-09-25" });
    expect("content" in note && note.content).toContain('title: "Plan: \\"phase 2\\": go"');
  });

  test("events use GBrain's timeline line format", () => {
    // Copied from GBrain src/core/timeline-citations.ts (TIMELINE_LINE_RE).
    const TIMELINE_LINE_RE = /^\s*(?:-\s*)?\*\*(\d{4}-\d{2}-\d{2})\*\*\s*([|\-–—]+)\s*(.+?)\s*$/;
    const note = renderThreadNote(thread, knowledge({ events: [{ date: "2026-09-30", what: "Contract signed" }] }), { today: "2026-09-25" });
    const line = ("content" in note ? note.content : "").split("\n").find(l => l.includes("2026-09-30"))!;
    expect(line).toBe("- **2026-09-30** — Contract signed");
    expect(TIMELINE_LINE_RE.exec(line)?.slice(1)).toEqual(["2026-09-30", "—", "Contract signed"]);
  });

  test("slugify drops Re:/Fwd: and punctuation",() => expect(slugify("Re: Q3 Budget — Final!!")).toBe("q3-budget-final"));
});

describe("extract contract", () => {
  test("prompt marks who sent what", () => {
    const p = buildPrompt({ id: "A", items: [item(), item({ folder: "sentitems" })], existingNote: "# Old note" }, { name: "Aisyah Rahman" });
    expect(p).toContain("(received)");
    expect(buildPrompt({ id: "A", items: [item({ folder: "sentitems" })], existingNote: null })).toContain("(sent by the owner)"); // no owner configured
    expect(p).toContain("(sent by Aisyah)");
    expect(p).toContain("## Existing note for this thread");
  });
  test("keep=false is accepted with minimal fields", () => expect(parseKnowledge({ keep: false, reason: "newsletter" }).keep).toBe(false));
  test("malformed output is rejected", () => expect(() => parseKnowledge({ keep: true, title: "", summary: "x" })).toThrow());
});
