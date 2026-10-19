import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotesIndex, parseNotesQuery, queryNotes } from "../src/notes-index.ts";
import { createPortal, type PortalDeps } from "../src/portal.ts";
import { freePort } from "./fixtures.ts";

function vault() {
  const root = mkdtempSync(join(tmpdir(), "brain-page-"));
  const write = (rel: string, fm: Record<string, string>, summary = "What happened.") => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    const head = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
    writeFileSync(join(root, rel), `---\n${head}\n---\n\n# x\n\n## Summary\n${summary}\n\n## Detail\n- secret detail words\n`);
  };
  return { root, write };
}
const q = (s: string) => { const r = parseNotesQuery(new URLSearchParams(s)); if ("error" in r) throw new Error(r.error); return r.query; };

test("query params are validated: source, dates, page numbers, query length", () => {
  expect(q("source=ai-chat")).toEqual({ source: "ai-chat", q: "", from: "", to: "", page: 1, pageSize: 25 });
  expect(q("source=email&page=3&pageSize=500&q=%20hi%20")).toMatchObject({ page: 3, pageSize: 100, q: "hi" }); // size capped
  expect(q(`source=email&q=${"a".repeat(1000)}`).q.length).toBe(200);
  for (const bad of ["source=life", "source=", "source=email&from=2026-1-1", "source=email&to=2026-02-30", "source=email&from=yesterday",
    "source=email&from=2026-10-10&to=2026-10-01", "source=email&page=0", "source=email&page=-1", "source=email&page=1.5", "source=email&pageSize=abc", "source=email&page=1e3"])
    expect("error" in parseNotesQuery(new URLSearchParams(bad))).toBe(true);
});

test("paging, date range (inclusive, on last activity) and search", () => {
  const { root, write } = vault();
  for (let d = 1; d <= 30; d++) {
    const day = `2026-09-${String(d).padStart(2, "0")}`;
    write(`inbox/ai/claude/2026-09/n${d}.md`, { title: JSON.stringify(`Note ${d}`), created: "2026-01-01", last_message: `${day}T10:00:00Z`, client: '"acme"', project: '"Portal"', account: '"work"' },
      d === 7 ? "Budget for the IAQ workshop is RM 8,000." : "Routine.");
  }
  write("inbox/ai/claude/2026-08/created-only.md", { title: '"Created only"', created: "2026-08-15", client: "null" });
  const idx = createNotesIndex(root, { ttlMs: 0 }), run = (s: string) => queryNotes(idx, q(s));
  const first = run("source=ai-chat");
  expect(first).toMatchObject({ total: 31, page: 1, pageSize: 25, pages: 2 });
  expect(first.notes.map(n => n.title).slice(0, 2)).toEqual(["Note 30", "Note 29"]); // newest activity first
  expect(first.notes[0]).toMatchObject({ client: "acme", project: "Portal", account: "work", day: "2026-09-30", summary: "Routine." });
  expect(run("source=ai-chat&page=2").notes.map(n => n.title)).toEqual(["Note 5", "Note 4", "Note 3", "Note 2", "Note 1", "Created only"]);
  expect(run("source=ai-chat&page=99").page).toBe(2); // past the end shows the last page
  expect(run("source=ai-chat&pageSize=10&page=3").notes[0].title).toBe("Note 10");
  expect(run("source=ai-chat&from=2026-09-10&to=2026-09-12").notes.map(n => n.title)).toEqual(["Note 12", "Note 11", "Note 10"]);
  expect(run("source=ai-chat&to=2026-08-31").notes.map(n => n.title)).toEqual(["Created only"]); // falls back to created
  expect(run("source=ai-chat&to=2026-08-31").notes[0].client).toBeUndefined(); // YAML null is no client
  expect(run("source=ai-chat&q=rm%208").notes.map(n => n.title)).toEqual(["Note 7"]); // summary, case-insensitive
  expect(run("source=ai-chat&q=NOTE%2012").total).toBe(1); // title
  expect(run("source=ai-chat&q=secret%20detail").total).toBe(0); // only title + summary are searched
  expect(run("source=ai-chat&q=zzz")).toMatchObject({ total: 0, page: 1, pages: 1, notes: [] });
  expect(first.counts["ai-chat"]).toBe(31);
});

test("index re-reads only changed files, picks up new ones and drops deleted ones", () => {
  const { root, write } = vault();
  write("inbox/meetings/2026-10/a.md", { title: '"A"', created: "2026-10-01" });
  write("inbox/meetings/2026-10/b.md", { title: '"B"', created: "2026-10-02" });
  const idx = createNotesIndex(root, { ttlMs: 0 });
  expect(idx.rows("meeting").map(n => n.title)).toEqual(["B", "A"]);
  expect(idx.reads()).toBe(2);
  idx.rows("meeting"); expect(idx.reads()).toBe(2); // nothing changed: no reads
  write("inbox/meetings/2026-10/a.md", { title: '"A renamed"', created: "2026-10-05" });
  utimesSync(join(root, "inbox/meetings/2026-10/a.md"), new Date(), new Date(Date.now() + 5000));
  write("inbox/meetings/2026-10/c.md", { title: '"C"', created: "2026-10-03" });
  expect(idx.rows("meeting").map(n => n.title)).toEqual(["A renamed", "C", "B"]);
  expect(idx.reads()).toBe(4); // just the changed file and the new one
  rmSync(join(root, "inbox/meetings/2026-10/b.md"));
  expect(idx.rows("meeting").map(n => n.title)).toEqual(["A renamed", "C"]);
  expect(idx.counts().meeting).toBe(2);
});

test("the index covers only the connector folders: never life/, anchor/clients or symlinked folders", () => {
  const { root, write } = vault();
  write("inbox/email/threads/2026-10/ok.md", { title: '"Mail"', created: "2026-10-01" });
  write("life/inbox/email/threads/x.md", { title: '"Private"', created: "2026-10-01" });
  write("anchor/clients/acme/inbox/email/threads/y.md", { title: '"Client"', created: "2026-10-01" });
  write("inbox/notes.md", { title: '"Loose"', created: "2026-10-01" });
  try { symlinkSync(join(root, "life"), join(root, "inbox/email/threads/linked"), "junction"); } catch { /* no symlink rights: still covered by the folder list */ }
  const idx = createNotesIndex(root, { ttlMs: 0 });
  const all = (["email", "teams-chat", "teams-channel", "meeting", "ai-chat"] as const).flatMap(s => idx.rows(s));
  expect(all.map(n => n.path)).toEqual(["inbox/email/threads/2026-10/ok.md"]);
});

test("/api/notes serves one validated page with counts", async () => {
  const { root, write } = vault();
  for (let d = 1; d <= 3; d++) write(`inbox/teams/chats/2026-10/c${d}.md`, { title: `"Chat ${d}"`, created: `2026-10-0${d}` });
  const services = {
    config: () => ({ brainPath: root, clientId: "", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 10 }),
    state: () => ({ cursors: {}, threads: {}, queue: [], lookbackDays: 10, lastRun: null }),
    connected: () => true, running: () => null, schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }),
    configure: () => {}, action: async () => {}, exchange: async () => {},
  } as unknown as PortalDeps;
  const port = freePort(), server = createPortal(port, services), get = (s: string) => fetch(`http://127.0.0.1:${port}/api/notes?${s}`);
  try {
    const ok = await get("source=teams-chat&pageSize=2&page=2");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ total: 3, page: 2, pageSize: 2, pages: 2 });
    expect(body.notes.map((n: { title: string }) => n.title)).toEqual(["Chat 1"]);
    expect(body.counts["teams-chat"]).toBe(3);
    for (const bad of ["source=../../life", "source=teams-chat&from=2026-13-01", "source=teams-chat&page=x"]) expect((await get(bad)).status).toBe(400);
    expect((await get("source=teams-chat&from=2026-10-02&to=2026-10-02")).status).toBe(200);
  } finally { server.stop(true); }
});


test("Notes page view helpers: hash state, presets, page buttons, results line, old-server fallback", async () => {
  const v = await import("../portal/view.js");
  const st = v.parseNotesState("ai-chat", "q=iaq&from=2026-10-01&to=bad&page=3");
  expect(st).toEqual({ source: "ai-chat", q: "iaq", from: "2026-10-01", to: "", page: 3 });
  expect(v.parseNotesState("nope", "page=-2").source).toBeNull();
  expect(v.parseNotesState("email", "page=-2").page).toBe(1);
  expect(v.notesHash(st)).toBe("#/notes/ai-chat?q=iaq&from=2026-10-01&page=3");
  expect(v.notesHash({ source: "email", q: " ", from: "", to: "", page: 1 })).toBe("#/notes/email");
  expect(v.notesApiQuery(st)).toBe("source=ai-chat&page=3&pageSize=25&q=iaq&from=2026-10-01");
  const now = new Date(2026, 9, 17, 9);
  expect(v.datePresets(now).map(p => p.from)).toEqual(["2026-10-11", "2026-09-18", "2026-01-01", ""]);
  expect(v.activePreset({ from: "2026-09-18", to: "" }, now)).toBe("30d");
  expect(v.activePreset({ from: "", to: "" }, now)).toBe("all");
  expect(v.pageItems(1, 1)).toEqual([1]);
  expect(v.pageItems(1, 20)).toEqual([1, 2, 3, "…", 20]);
  expect(v.pageItems(10, 20)).toEqual([1, "…", 8, 9, 10, 11, 12, "…", 20]);
  expect(v.pageItems(4, 20)).toEqual([1, 2, 3, 4, 5, 6, "…", 20]); // a gap of one shows the number, not "…"
  expect(v.showingLine({ total: 412, page: 1, pageSize: 25 })).toBe("Showing 1–25 of 412");
  expect(v.showingLine({ total: 412, page: 17, pageSize: 25 })).toBe("Showing 401–412 of 412");
  const old = Array.from({ length: 30 }, (_, i) => ({ title: `N${i}`, summary: i === 3 ? "RM 8,000" : "", date: `2026-10-${String(30 - i).padStart(2, "0")}T09:00:00Z` }));
  expect(v.pageLocally(old, { q: "", from: "", to: "", page: 2 })).toMatchObject({ total: 30, page: 2, pages: 2 });
  expect(v.pageLocally(old, { q: "rm 8", from: "", to: "", page: 1 }).notes.map(n => n.title)).toEqual(["N3"]);
  expect(v.pageLocally(old, { q: "", from: "2026-10-29", to: "2026-10-30", page: 5 })).toMatchObject({ total: 2, page: 1 });
  expect(v.noteDay({ day: "2025-10-19" }, now)).toEqual({ day: "19", month: expect.any(String), year: "2025", iso: "2025-10-19" });
  expect(v.noteDay({ date: "2026-10-02T01:00:00Z" }, now).year).toBe("");
  expect(v.noteTags({ client: "acme", account: "work" }).map(t => t.kind)).toEqual(["client", "account"]);
});
