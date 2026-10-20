import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EntityStore, linkNote, normName, NOTES_CAP, renderEntityPage } from "../src/core/entities.ts";
import { renderThreadNote } from "../src/core/render.ts";
import { writeNotes } from "../src/core/commit.ts";
import { rebuildEntities } from "../src/entities-rebuild.ts";
import { item, knowledge } from "./fixtures.ts";

const OWNER = { name: "Aisyah Rahman", emails: ["aisyah@example.com"], org: "Example Works" };
// Copied from GBrain src/core/timeline-citations.ts (TIMELINE_LINE_RE).
const TIMELINE_LINE_RE = /^\s*(?:-\s*)?\*\*(\d{4}-\d{2}-\d{2})\*\*\s*([|\-–—]+)\s*(.+?)\s*$/;

function vault() {
  const root = mkdtempSync(join(tmpdir(), "thirdbrain-entities-"));
  const put = (rel: string, content: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), content); };
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  return { root, put, read, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A note as the sync renders it today (plain people, no links). */
function plainNote(over: Parameters<typeof knowledge>[0] = {}, at = "2026-09-22T09:00:00Z") {
  const n = renderThreadNote({ id: `conv-${at}`, items: [item({ at })], existingNote: null }, knowledge(over), { today: "2026-09-25" });
  if ("blocked" in n) throw new Error(n.blocked);
  return n;
}

describe("person identity", () => {
  test("email is the key; name variants become aliases", () => {
    const s = new EntityStore(OWNER);
    const a = s.person({ name: "Jane Lim", email: "Jane@Acme.com" })!;
    const b = s.person({ name: "Jane L.", email: "jane@acme.com" })!;
    expect(b).toBe(a);
    expect(a.slug).toBe("jane-lim");
    expect(a.email).toBe("jane@acme.com");
    expect(a.aliases).toEqual(["Jane L."]);
  });

  test("name normalisation ignores case, accents and punctuation; name-only resolves to the known person", () => {
    expect(normName("  José  O'Neil (Acme) ")).toBe("jose o neil");
    const s = new EntityStore(OWNER);
    const a = s.person({ name: "Jane Lim", email: "jane@acme.com" })!;
    expect(s.person({ name: "jane LIM" })).toBe(a);
    expect(s.person({ name: "[[inbox/entities/people/jane-lim|Jane Lim]]" })).toBe(a); // echoed back from a linked note
  });

  test("the same name with a different address is a different person", () => {
    const s = new EntityStore(OWNER);
    const a = s.person({ name: "Jane Lim", email: "jane@acme.com" })!;
    const b = s.person({ name: "Jane Lim", email: "jane.lim@globex.test" })!;
    expect(b).not.toBe(a);
    expect(b.slug).toMatch(/^jane-lim-[0-9a-f]{6}$/);
  });

  test("owner (by address or name), no-reply, role addresses and bots get no page", () => {
    const s = new EntityStore(OWNER);
    expect(s.person({ name: "Someone", email: "AISYAH@example.com" })).toBeNull();
    expect(s.person({ name: "aisyah rahman" })).toBeNull();
    expect(s.person({ name: "Acme Billing", email: "no-reply@acme.com" })).toBeNull();
    expect(s.person({ name: "Acme Support", email: "support@acme.com" })).toBeNull();
    expect(s.person({ name: "Claude" })).toBeNull();
    expect(s.person({ name: "Deploy Bot" })).toBeNull();
    expect(s.person({ name: "" })).toBeNull();
    expect(s.all()).toEqual([]);
  });
});

describe("entity pages", () => {
  test("frontmatter GBrain reads (type, aliases, company) and a newest-first note list", () => {
    const s = new EntityStore(OWNER);
    const acme = s.company("Acme", "acme")!;
    const jane = s.person({ name: "Jane Lim", email: "jane@acme.com", role: "Procurement" })!;
    s.person({ name: "J. Lim", email: "jane@acme.com" });
    jane.company = acme.slug;
    s.addNote(jane, { slug: "inbox/email/threads/2026-09/2026-09-01-older", title: "Older", date: "2026-09-01" });
    s.addNote(jane, { slug: "inbox/email/threads/2026-10/2026-10-06-newer", title: "Newer", date: "2026-10-06" });
    const page = renderEntityPage(jane, s, "2026-10-18");
    expect(page).toContain('title: "Jane Lim"');
    expect(page).toContain("source: third-brain-sync");
    expect(page).toContain("type: person");
    expect(page).toContain('aliases: ["J. Lim"]');
    expect(page).toContain('email: "jane@acme.com"');
    expect(page).toContain('company: "inbox/entities/companies/acme"');
    expect(page).toContain("created: 2026-09-01");
    expect(page).toContain("- **Organisation:** [[inbox/entities/companies/acme|Acme]]");
    const list = page.split("## Notes\n")[1].trim().split("\n");
    expect(list).toEqual([
      "- 2026-10-06 · [[inbox/email/threads/2026-10/2026-10-06-newer|Newer]]",
      "- 2026-09-01 · [[inbox/email/threads/2026-09/2026-09-01-older|Older]]",
    ]);
    for (const line of list) expect(TIMELINE_LINE_RE.test(line)).toBe(false); // a listing is not an event
    expect(renderEntityPage(acme, s, "2026-10-18")).toContain("## People\n- [[inbox/entities/people/jane-lim|Jane Lim]] · Procurement");
  });

  test("the list is capped; the rest is counted", () => {
    const s = new EntityStore(OWNER);
    const p = s.project("Portal Migration")!;
    for (let i = 0; i < NOTES_CAP + 5; i++) s.addNote(p, { slug: `inbox/ai/claude/n-${String(i).padStart(3, "0")}`, title: `N${i}`, date: "2026-10-01" });
    const page = renderEntityPage(p, s, "2026-10-18");
    expect(page.split("\n").filter(l => l.startsWith("- 2026-10-01 · ")).length).toBe(NOTES_CAP);
    expect(page).toContain("- _and 5 more_");
    expect(page).toContain(`note_count: ${NOTES_CAP + 5}`);
  });

  test("a page holding a secret is not written", () => {
    const s = new EntityStore(OWNER);
    const p = s.person({ name: "Jane Lim", email: "jane@acme.com", role: "password is Hunter2222" })!;
    s.addNote(p, { slug: "inbox/email/threads/x", title: "X", date: "2026-10-01" });
    expect(s.pages("2026-10-18")).toEqual([]);
    expect(s.blocked).toBe(1);
  });

  test("pages accumulate notes across runs", () => {
    const v = vault();
    try {
      const run = (rel: string, title: string, date: string) => {
        const s = EntityStore.load(v.root, OWNER);
        const note = plainNote({ title }, `${date}T09:00:00Z`);
        const r = linkNote(s, rel, note.content, { people: knowledge().people, client: "Acme" });
        writeNotes(v.root, [{ relPath: rel, content: r.content }, ...s.pages("2026-10-18")]);
      };
      run("inbox/email/threads/2026-09/2026-09-22-a.md", "First", "2026-09-22");
      run("inbox/email/threads/2026-10/2026-10-02-b.md", "Second", "2026-10-02");
      const page = v.read("inbox/entities/people/jane-lim.md");
      expect(page).toContain("- 2026-10-02 · [[inbox/email/threads/2026-10/2026-10-02-b|Second]]\n- 2026-09-22 · [[inbox/email/threads/2026-09/2026-09-22-a|First]]");
      expect(page).toContain("note_count: 2");
      expect(v.read("inbox/entities/companies/acme.md")).toContain('title: "Acme"');
    } finally { v.cleanup(); }
  });
});

describe("linked notes", () => {
  test("people, client and project become wikilinks; related: lists them; re-linking changes nothing", () => {
    const s = new EntityStore(OWNER);
    const k = knowledge({ people: [{ name: "Jane Lim", email: "jane@acme.com", org: "Acme", role: "Procurement" },
      { name: "Aisyah Rahman", email: "aisyah@example.com", org: "Example Works", role: null }] });
    const note = renderThreadNote({ id: "c1", items: [item({ at: "2026-09-22T09:00:00Z", project: { id: "p1", name: "Portal Migration" } })], existingNote: null },
      k, { today: "2026-09-25" }) as { relPath: string; content: string };
    const r = linkNote(s, note.relPath, note.content, { people: k.people, client: k.client });
    expect(r.content).toContain("## People\n- [[inbox/entities/people/jane-lim|Jane Lim]] <jane@acme.com> · Procurement, [[inbox/entities/companies/acme|Acme]]\n- Aisyah Rahman <aisyah@example.com> · Example Works\n");
    expect(r.content).toContain("## Links\n- Client: [[inbox/entities/companies/acme|Acme]]\n- Project: [[inbox/entities/projects/portal-migration|Portal Migration]]\n- [Open in Outlook]");
    expect(r.content).toContain('aliases: []\nrelated: ["inbox/entities/companies/acme", "inbox/entities/projects/portal-migration", "inbox/entities/people/jane-lim"]\n');
    expect(r.content).toContain('client: "acme"'); // the portal still reads these
    expect(r.content).toContain('project: "Portal Migration"');
    expect(s.get("person", "jane-lim")!.company).toBe("acme");
    expect(linkNote(s, note.relPath, r.content).content).toBe(r.content);
  });

  test("meetings also get attendees: (GBrain's attended edge)", () => {
    const s = new EntityStore(OWNER);
    const note = renderThreadNote({ id: "m1", items: [item({ source: "meeting" })], existingNote: null }, knowledge(), { today: "2026-09-25" }) as { relPath: string; content: string };
    const r = linkNote(s, note.relPath, note.content);
    expect(r.content).toContain('attendees: ["inbox/entities/people/jane-lim"]');
  });

  test("old notes: plain people and old event lines are rewritten; personal notes are left alone", () => {
    const s = new EntityStore(OWNER);
    const old = plainNote().content.replace("_No decisions or commitments._", "x")
      .replace("## Why", "- **2026-09-30:** Contract signed\n\n## Why");
    const r = linkNote(s, "inbox/email/threads/2026-09/old.md", old);
    expect(r.migratedEvents).toBe(1);
    const line = r.content.split("\n").find(l => l.includes("Contract signed"))!;
    expect(line).toBe("- **2026-09-30** — Contract signed");
    expect(TIMELINE_LINE_RE.test(line)).toBe(true);
    expect(r.content).toContain("- [[inbox/entities/people/jane-lim|Jane Lim]] <jane@acme.com> · Procurement, [[inbox/entities/companies/acme|Acme]]");
    const personal = old.replace('tags: ["email"', 'tags: ["personal", "email"');
    expect(linkNote(s, "inbox/email/threads/p.md", personal).content).toBe(personal);
  });

  test("CRLF notes keep their line endings", () => {
    const s = new EntityStore(OWNER);
    const crlf = plainNote().content.replace(/\n/g, "\r\n");
    const r = linkNote(s, "inbox/email/threads/c.md", crlf);
    expect(r.content).toContain("[[inbox/entities/people/jane-lim|Jane Lim]]");
    expect(r.content.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("entities rebuild", () => {
  test("dry run counts only; a real run writes; a second run changes nothing; private folders untouched", () => {
    const v = vault();
    try {
      v.put("inbox/email/threads/2026-09/2026-09-22-a.md", plainNote().content);
      v.put("inbox/teams/chats/2026-09/2026-09-23-b.md", plainNote({ title: "Chat", client: null, people: [{ name: "Ravi Kumar", email: "", org: null, role: null }] }, "2026-09-23T09:00:00Z").content);
      const secret = plainNote({ title: "Client only", people: [{ name: "Hidden Person", email: "hidden@acme.com", org: null, role: null }] }).content;
      v.put("life/diary.md", secret);
      v.put("anchor/clients/acme/n.md", secret);

      const dry = rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: true });
      expect(dry.report).toEqual({ dryRun: true, notesScanned: 2, notesLinked: 2, eventLinesMigrated: 0,
        entities: { person: 2, company: 1, project: 0, topic: 0 }, pagesChanged: 3, pagesBlocked: 0, pagesMerged: 0 });
      expect(existsSync(join(v.root, "inbox/entities"))).toBe(false);
      expect(v.read("inbox/email/threads/2026-09/2026-09-22-a.md")).toBe(plainNote().content);

      const real = rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: false });
      expect(real.report.pagesChanged).toBe(3);
      expect(readdirSync(join(v.root, "inbox/entities/people")).sort()).toEqual(["jane-lim.md", "ravi-kumar.md"]);
      expect(v.read("inbox/teams/chats/2026-09/2026-09-23-b.md")).toContain("- [[inbox/entities/people/ravi-kumar|Ravi Kumar]]");
      expect(v.read("life/diary.md")).toBe(secret);
      expect(v.read("anchor/clients/acme/n.md")).toBe(secret);
      expect([...real.notes, ...real.pages].every(n => n.relPath.startsWith("inbox/"))).toBe(true);

      const again = rebuildEntities(v.root, OWNER, "2026-10-19", { dryRun: false });
      expect([again.report.notesLinked, again.report.pagesChanged]).toEqual([0, 0]);
    } finally { v.cleanup(); }
  });

  test("a client known only by its slug gets a guessed name that later runs keep (idempotent)", () => {
    const v = vault();
    try {
      v.put("inbox/email/threads/2026-09/g.md", plainNote({ client: "Globex Corp", people: [] }).content);
      rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: false });
      expect(v.read("inbox/entities/companies/globex-corp.md")).toContain("name_guessed: true");
      const again = rebuildEntities(v.root, OWNER, "2026-10-19", { dryRun: false });
      expect([again.report.notesLinked, again.report.pagesChanged]).toEqual([0, 0]);
      // A run that knows the real name replaces the guess.
      const s = EntityStore.load(v.root, OWNER);
      linkNote(s, "inbox/email/threads/2026-09/g.md", v.read("inbox/email/threads/2026-09/g.md"), { people: [], client: "GLOBEX corp" });
      expect(s.pages("2026-10-20")[0].content).toContain('title: "GLOBEX corp"');
    } finally { v.cleanup(); }
  });

  test("a linked People line cannot point a page outside inbox/entities", () => {
    const s = new EntityStore(OWNER);
    const evil = plainNote().content.replace("- Jane Lim <jane@acme.com>", "- [[inbox/entities/people/../../../x|Jane Lim]] <jane@acme.com>");
    linkNote(s, "inbox/email/threads/e.md", evil);
    const pages = s.pages("2026-10-18").map(p => p.relPath);
    expect(pages).toContain("inbox/entities/people/jane-lim.md");
    expect(pages.every(p => /^inbox\/entities\/(people|companies|projects)\/[a-z0-9-]+\.md$/.test(p))).toBe(true);
  });
});

describe("topics", () => {
  const chat = (title: string, tags: string[]) => `---\ntitle: ${JSON.stringify(title)}\ncreated: 2026-09-01\nsource: chatgpt-sync\ntags: ${JSON.stringify(tags)}\naliases: []\nkind: ai-conversation\nclient: null\nlast_message: 2026-09-01T10:00:00Z\n---\n\n# ${title}\n\n## Summary\nText.\n\n## Links\n- [Open in ChatGPT](https://chatgpt.com/c/x)\n`;

  test("names and slugs: source and scope tags are never topics; short words are acronyms", async () => {
    const { topicSlug, topicName } = await import("../src/core/entities.ts");
    expect(["ai-chat", "email", "account/aisyah", "client/acme", "project/x", "personal"].map(topicSlug)).toEqual([null, null, null, null, null, null]);
    expect(topicSlug("Platform Engineering")).toBe("platform-engineering");
    expect(["aws", "ai-agents", "platform-engineering", "seo"].map(topicName)).toEqual(["AWS", "AI agents", "Platform engineering", "SEO"]);
  });

  test("rebuild: a tag on 5+ notes gets a topic page and links; a rare tag does not; a tag that names a client links the client", () => {
    const v = vault();
    try {
      for (let i = 0; i < 5; i++) v.put(`inbox/ai/chatgpt/2026-09/n${i}.md`, chat(`Datadog note ${i}`, ["ai-chat", "datadog", i === 0 ? "rare" : "x"]));
      v.put("inbox/entities/companies/acme.md", "---\ntitle: \"Acme\"\nsource: third-brain-sync\ntype: company\nentity_keys: [\"company:acme\"]\n---\n\n# Acme\n");
      v.put("inbox/ai/chatgpt/2026-09/acme.md", chat("Acme pricing", ["acme"]));
      const r = rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: false });
      expect(r.report.entities.topic).toBe(1);
      const page = v.read("inbox/entities/topics/datadog.md");
      expect(page).toContain("type: topic");
      expect(page).toContain("note_count: 5");
      const n0 = v.read("inbox/ai/chatgpt/2026-09/n0.md");
      expect(n0).toContain("- Topics: [[inbox/entities/topics/datadog|Datadog]]");
      expect(n0).not.toContain("topics/rare");
      expect(n0).toMatch(/^related: \[.*"inbox\/entities\/topics\/datadog".*\]$/m);
      expect(existsSync(join(v.root, "inbox/entities/topics/rare.md"))).toBe(false);
      expect(v.read("inbox/ai/chatgpt/2026-09/acme.md")).toContain("- Topics: [[inbox/entities/companies/acme|Acme]]");
      // The sync links an existing topic page without counts; a second rebuild changes nothing.
      const store = EntityStore.load(v.root, OWNER);
      expect(linkNote(store, "inbox/ai/chatgpt/2026-09/new.md", chat("New", ["datadog"])).content).toContain("topics/datadog|Datadog]]");
      expect(rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: true }).report).toMatchObject({ notesLinked: 0, pagesChanged: 0 });
    } finally { v.cleanup(); }
  });
});

describe("merges", () => {
  const company = (slug: string, name: string, notes: string[]) => `---\ntitle: ${JSON.stringify(name)}\nsource: third-brain-sync\ntype: company\nentity_keys: [${JSON.stringify(`company:${slug}`)}]\nnote_count: ${notes.length}\n---\n\n# ${name}\n\n## Notes\n${notes.map(n => `- 2026-09-01 · [[${n}|${n}]]`).join("\n")}\n`;
  const chat = (title: string, client: string) => `---\ntitle: ${JSON.stringify(title)}\ncreated: 2026-09-01\nsource: chatgpt-sync\ntags: ["ai-chat"]\naliases: []\nkind: ai-conversation\nclient: ${client}\nlast_message: 2026-09-01T10:00:00Z\n---\n\n# ${title}\n\n## Summary\nText.\n\n## Links\n- [Open](https://x)\n`;

  test("auto: names equal without spaces or dashes merge into the page with more notes; the spelling never comes back", async () => {
    const { loadMerges } = await import("../src/core/entity-merges.ts");
    const v = vault();
    try {
      v.put("inbox/entities/companies/tail-spin.md", company("tail-spin", "Tail Spin", ["inbox/ai/chatgpt/a", "inbox/ai/chatgpt/b"]));
      v.put("inbox/entities/companies/tailspin.md", company("tailspin", "Tailspin", ["inbox/ai/chatgpt/c"]));
      v.put("inbox/ai/chatgpt/a.md", chat("A", "tail-spin")); v.put("inbox/ai/chatgpt/b.md", chat("B", "tail-spin"));
      v.put("inbox/ai/chatgpt/c.md", chat("C", "tailspin"));
      const r = rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: false });
      expect(r.report.pagesMerged).toBe(1);
      expect(existsSync(join(v.root, "inbox/entities/companies/tailspin.md"))).toBe(false);
      expect(v.read("inbox/ai/chatgpt/c.md")).toContain("- Client: [[inbox/entities/companies/tail-spin|Tail Spin]]");
      const page = v.read("inbox/entities/companies/tail-spin.md");
      expect(page).toContain("note_count: 3");
      expect(page).toContain('"Tailspin"');                                   // the other spelling is an alias
      expect(loadMerges(v.root).merges).toEqual([expect.objectContaining({ kind: "company", from: "tailspin", to: "tail-spin", by: "auto" })]);
      // The next sync: a note that names "TAILSPIN" links the kept page; no new page.
      const store = EntityStore.load(v.root, OWNER);
      expect(linkNote(store, "inbox/ai/chatgpt/d.md", chat("D", "tailspin")).content).toContain("companies/tail-spin|Tail Spin]]");
      expect(store.pages("2026-10-18").map(p => p.relPath)).toEqual(["inbox/entities/companies/tail-spin.md"]);
      expect(rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: true }).report).toMatchObject({ notesLinked: 0, pagesChanged: 0, pagesMerged: 0 });
    } finally { v.cleanup(); }
  });

  test("user merge from the list; 'not the same' blocks the automatic merge too", async () => {
    const { saveMerges } = await import("../src/core/entity-merges.ts");
    const v = vault();
    try {
      v.put("inbox/entities/companies/borealis.md", company("borealis", "Borealis", ["inbox/ai/chatgpt/a"]));
      v.put("inbox/entities/companies/borealis-malaysia.md", company("borealis-malaysia", "Borealis Malaysia", ["inbox/ai/chatgpt/b"]));
      v.put("inbox/entities/companies/z-steel.md", company("z-steel", "Z-Steel", ["inbox/ai/chatgpt/c"]));
      v.put("inbox/entities/companies/zsteel.md", company("zsteel", "Zsteel", ["inbox/ai/chatgpt/d"]));
      v.put("inbox/ai/chatgpt/a.md", chat("A", "borealis")); v.put("inbox/ai/chatgpt/b.md", chat("B", "borealis-malaysia"));
      v.put("inbox/ai/chatgpt/c.md", chat("C", "z-steel")); v.put("inbox/ai/chatgpt/d.md", chat("D", "zsteel"));
      saveMerges(v.root, { merges: [{ kind: "company", from: "borealis", to: "borealis-malaysia", name: "Borealis", keys: [], aliases: [], by: "user", at: "2026-10-18" }],
        distinct: [{ kind: "company", a: "z-steel", b: "zsteel", at: "2026-10-18" }] });
      const r = rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: false });
      expect(r.report.pagesMerged).toBe(1);
      expect(v.read("inbox/ai/chatgpt/a.md")).toContain("companies/borealis-malaysia|Borealis Malaysia]]");
      expect(existsSync(join(v.root, "inbox/entities/companies/zsteel.md"))).toBe(true);
    } finally { v.cleanup(); }
  });

  test("people: the same name with different addresses stays two people", () => {
    const v = vault();
    try {
      const person = (slug: string, name: string, email: string) => `---\ntitle: ${JSON.stringify(name)}\nsource: third-brain-sync\ntype: person\nentity_keys: [${JSON.stringify(`email:${email}`)}]\nemail: ${JSON.stringify(email)}\nnote_count: 1\n---\n\n# ${name}\n\n## Notes\n- 2026-09-01 · [[n/${slug}|x]]\n`;
      v.put("inbox/entities/people/mei-ling-tan.md", person("mei-ling-tan", "Mei Ling Tan", "a@x.com"));
      v.put("inbox/entities/people/meiling-tan.md", person("meiling-tan", "Meiling Tan", "b@y.com"));
      expect(EntityStore.load(v.root, OWNER).absorbed).toEqual([]);
    } finally { v.cleanup(); }
  });

  test("possible duplicates for review: prefixes, people only for a first name alone, decided pairs left out", async () => {
    const { duplicatePairs } = await import("../src/core/entity-merges.ts");
    const pages = [
      { kind: "company" as const, slug: "northwind", name: "Northwind", notes: 40 },
      { kind: "company" as const, slug: "northwind-group", name: "Northwind Group", notes: 29 },
      { kind: "person" as const, slug: "daniel", name: "Daniel", notes: 1 },
      { kind: "person" as const, slug: "daniel-tan", name: "Daniel Tan", notes: 5 },
      { kind: "person" as const, slug: "ravi-kumar", name: "Ravi Kumar", notes: 3 },
      { kind: "person" as const, slug: "ravi-kumar-kl", name: "Ravi Kumar KL", notes: 1 },
    ];
    const pairs = duplicatePairs(pages, { merges: [], distinct: [] });
    expect(pairs.map(p => `${p.keep.slug}<${p.merge.slug}`)).toEqual(["northwind<northwind-group", "daniel-tan<daniel"]);
    expect(duplicatePairs(pages, { merges: [], distinct: [{ kind: "company", a: "northwind-group", b: "northwind", at: "" }] })).toHaveLength(1);
    // A merge saved but not yet applied (the rebuild waits for a sync): the pair leaves the list at once.
    expect(duplicatePairs(pages, { merges: [{ kind: "person", from: "daniel", to: "daniel-tan", name: "Daniel", keys: [], aliases: [], by: "user", at: "" }], distinct: [] }).map(p => p.merge.slug)).toEqual(["northwind-group"]);
  });
});
