import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce, type RunDeps } from "../src/pipeline.ts";
import type { Config, State } from "../src/state.ts";
import type { Item, Knowledge } from "../src/types.ts";
import { item, knowledge } from "./fixtures.ts";

function setup(pages: Record<string, Item[]>, decide: (subject: string) => Knowledge | Error) {
  const root = mkdtempSync(join(tmpdir(), "mailsync-"));
  const cfg: Config = { brainPath: root, clientId: "x", tenantId: "t", model: "sonnet", maxThreadsPerRun: 25, initialSinceDays: 7 };
  const state: State = { cursors: {}, threads: {}, queue: [], muted: [], lastRun: null };
  const extracted: string[] = [];
  const commits: number[] = [];
  const deps: RunDeps = {
    folders: ["inbox"],
    pull: async (folder, cursor) => ({ items: cursor ? [] : pages[folder] ?? [], next: `delta-${folder}` }),
    extract: async t => {
      extracted.push(t.id);
      const r = decide(t.items[0].subject);
      if (r instanceof Error) throw r;
      return { knowledge: r, costUsd: 0.01 };
    },
    commit: notes => { commits.push(notes.length); return { committed: true, indexed: true, detail: "ok" }; },
    log: () => {},
    today: "2026-09-25",
  };
  return { root, cfg, state, deps, extracted, commits, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("pipeline end to end (fake Outlook, fake AI, temp vault)", () => {
  test("crash after note write before ledger save does not duplicate the thread note", async () => {
    const s = setup({ inbox: [item({ id: "crash-id", threadId: "A" })] }, () => knowledge());
    try {
      let checkpoint: State = s.state;
      let checkpoints = 0;
      s.deps.checkpoint = state => {
        if (++checkpoints === 2) throw new Error("simulated crash before ledger save");
        checkpoint = JSON.parse(JSON.stringify(state));
      };
      await expect(runOnce(s.cfg, s.state, s.deps, { dryRun: false, limit: 25, outRoot: s.root })).rejects.toThrow("simulated crash");
      s.deps.checkpoint = undefined;
      const resumed = await runOnce(s.cfg, checkpoint, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      expect(resumed.notes).toHaveLength(0);
      expect(resumed.nextState.threads.A.relPath.endsWith("-acme-renewal-pricing-agreed.md")).toBe(true);
      expect(Object.keys(resumed.nextState.processed!)).toEqual(["crash-id"]);
    } finally { s.cleanup(); }
  });
  test("10 -> 30 days restarts retrieval but overlapping IDs never repeat extraction", async () => {
    const original = item({ id: "original", threadId: "A", subject: "Alpha" });
    const older = item({ id: "older", threadId: "B", subject: "Beta", at: "2026-09-01T00:00:00Z" });
    const s = setup({ inbox: [original] }, subj => knowledge({ title: subj }));
    try {
      s.cfg.initialSinceDays = 10;
      const r1 = await runOnce(s.cfg, s.state, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      const cursors: (string | undefined)[] = [];
      s.deps.pull = async (_, cursor) => { cursors.push(cursor); return { items: [original, older], next: "wide-cursor" }; };
      s.cfg.initialSinceDays = 30;
      const r2 = await runOnce(s.cfg, r1.nextState, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      expect(cursors).toEqual([undefined]);
      expect(r2.report).toMatchObject({ duplicates: 1, written: 1 });
      expect(s.extracted).toEqual(["A", "B"]);
      const r3 = await runOnce(s.cfg, r2.nextState, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      expect(r3.report).toMatchObject({ duplicates: 2, written: 0 });
      expect(s.extracted).toEqual(["A", "B"]);
      s.cfg.initialSinceDays = 10;
      const r4 = await runOnce(s.cfg, r3.nextState, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      expect(Object.keys(r4.nextState.processed!)).toHaveLength(2);
      expect(Object.keys(r4.nextState.threads)).toHaveLength(2);
    } finally { s.cleanup(); }
  });

  test("a run links its notes and writes the entity pages they touch (owner excluded)", async () => {
    const s = setup({ inbox: [item({ id: "e1", threadId: "E" })] }, subj => knowledge({ title: subj,
      people: [{ name: "Jane Lim", email: "jane@acme.com", org: "Acme", role: "Procurement" }, { name: "Aisyah Rahman", email: "aisyah@example.com", org: null, role: null }] }));
    try {
      s.deps.owner = { name: "Aisyah Rahman", emails: ["aisyah@example.com"] };
      const r = await runOnce(s.cfg, s.state, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      expect(r.report).toMatchObject({ written: 1, entityPages: 2 });
      expect(r.report.notes).toEqual([r.notes[0].relPath]); // entity pages are not listed as the run's notes
      const note = readFileSync(join(s.root, r.notes[0].relPath), "utf8");
      expect(note).toContain("- [[inbox/entities/people/jane-lim|Jane Lim]] <jane@acme.com>");
      expect(note).toContain('related: ["inbox/entities/companies/acme", "inbox/entities/people/jane-lim"]');
      expect(readFileSync(join(s.root, "inbox/entities/people/jane-lim.md"), "utf8")).toContain(`[[${r.notes[0].relPath.slice(0, -3)}|Acme renewal]]`);
      expect(existsSync(join(s.root, "inbox/entities/people/aisyah-rahman.md"))).toBe(false);
    } finally { s.cleanup(); }
  });

  test("changed message content re-extracts into the owned note", async () => {
    const original = item({ id: "stable-id", threadId: "A" });
    const s = setup({ inbox: [original] }, () => knowledge());
    try {
      const r1 = await runOnce(s.cfg, s.state, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      s.deps.pull = async () => ({ items: [{ ...original, text: "The new agreed price is RM 900." }], next: "updated" });
      s.deps.extract = async () => ({ knowledge: knowledge({ summary: "Agreed price RM 900." }), costUsd: 0 });
      const r2 = await runOnce(s.cfg, r1.nextState, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      expect(r2.notes[0].relPath).toBe(r1.notes[0].relPath);
      expect(r2.notes[0].content).toContain("RM 900");
      expect(Object.keys(r2.nextState.processed!)).toHaveLength(1);
    } finally { s.cleanup(); }
  });

  test("queue/cursor checkpoint survives an extraction interruption; indexing retries without new notes", async () => {
    const s = setup({ inbox: [item({ id: "durable", threadId: "A" })] }, () => knowledge());
    try {
      const checkpoints: State[] = [];
      s.deps.checkpoint = x => checkpoints.push(JSON.parse(JSON.stringify(x)));
      s.deps.commit = () => ({ committed: true, indexed: false, detail: "index unavailable" });
      const r1 = await runOnce(s.cfg, s.state, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      expect(checkpoints[0].queue.map(x => x.id)).toEqual(["durable"]);
      expect(checkpoints[0].cursors.inbox).toBe("delta-inbox");
      expect(r1.nextState.indexPending).toBe(true);
      let attempts = 0;
      s.deps.commit = notes => { attempts++; expect(notes).toHaveLength(0); return { committed: true, indexed: true, detail: "index refreshed" }; };
      const r2 = await runOnce(s.cfg, r1.nextState, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      expect(attempts).toBe(1);
      expect(r2.nextState.indexPending).toBe(false);
      expect(s.extracted).toEqual(["A"]);
    } finally { s.cleanup(); }
  });
  test("keeps the good thread, drops noise and secrets, skips what the AI rejects", async () => {
    const s = setup({
      inbox: [
        item({ id: "1", threadId: "A", subject: "Acme renewal" }),
        item({ id: "2", threadId: "N", subject: "Weekly digest", from: { name: "x", email: "no-reply@x.com" } }),
        item({ id: "3", threadId: "S", subject: "Your code", text: "verification code 993311" }),
        item({ id: "4", threadId: "K", subject: "Lunch?" }),
      ],
    }, subj => (subj === "Lunch?" ? knowledge({ keep: false, reason: "trivial" }) : knowledge()));
    const { report, notes, nextState } = await runOnce(s.cfg, s.state, s.deps, { dryRun: false, limit: 25, outRoot: s.root });

    expect(report).toMatchObject({ pulled: 4, kept: 2, written: 1, skipped: 1, blocked: 0, queued: 0 });
    expect(report.dropped).toEqual({ "noise:sender": 1, "secret:otp": 1 });
    expect(s.extracted.sort()).toEqual(["A", "K"]);             // secret + noise never reached the AI
    expect(existsSync(join(s.root, notes[0].relPath))).toBe(true);
    expect(nextState.cursors).toEqual({ inbox: "delta-inbox" });
    expect(nextState.threads.A.relPath).toBe(notes[0].relPath);
    s.cleanup();
  });

  test("cap and AI errors queue items for the next run instead of losing them", async () => {
    const s = setup({
      inbox: [
        item({ id: "1", threadId: "A", subject: "Alpha", at: "2026-09-24T00:00:00Z" }),
        item({ id: "2", threadId: "B", subject: "Beta", at: "2026-09-23T00:00:00Z" }),
        item({ id: "3", threadId: "C", subject: "Gamma", at: "2026-09-22T00:00:00Z" }),
      ],
    }, subj => (subj === "Alpha" ? new Error("claude -p timeout") : knowledge({ title: subj })));
    const first = await runOnce(s.cfg, s.state, s.deps, { dryRun: false, limit: 2, outRoot: s.root });
    expect(first.report).toMatchObject({ written: 1, queued: 2 });   // A errored, C over the cap
    expect(first.nextState.queue.map(i => i.threadId).sort()).toEqual(["A", "C"]);

    const second = await runOnce(s.cfg, first.nextState, s.deps, { dryRun: false, limit: 2, outRoot: s.root });
    expect(second.report.pulled).toBe(0);                            // delta cursor: nothing new
    expect(s.extracted.filter(x => x === "C")).toHaveLength(1);      // queued thread finally processed
    s.cleanup();
  });

  test("an update rewrites the thread's own note; a moved note is never touched", async () => {
    const s = setup({ inbox: [item({ id: "1", threadId: "A", subject: "Acme renewal" })] }, () => knowledge());
    const r1 = await runOnce(s.cfg, s.state, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
    const path = r1.notes[0].relPath;

    // Aisyah promotes the note out of inbox/email during triage.
    const moved = join(s.root, "anchor/decisions/acme.md");
    mkdirSync(join(s.root, "anchor/decisions"), { recursive: true });
    writeFileSync(moved, readFileSync(join(s.root, path), "utf8") + "\nAisyah's edits\n");
    rmSync(join(s.root, path));

    s.deps.pull = async () => ({ items: [item({ id: "2", threadId: "A", subject: "Re: Acme renewal", at: "2026-09-25T00:00:00Z" })], next: "d2" });
    const r2 = await runOnce(s.cfg, r1.nextState, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
    expect(readFileSync(moved, "utf8")).toContain("Aisyah's edits");   // untouched
    expect(r2.notes).toHaveLength(1);                                 // new inbox note instead
    expect(existsSync(join(s.root, r2.notes[0].relPath))).toBe(true);
    s.cleanup();
  });

  test("dry run writes only to its own folder and keeps state unchanged", async () => {
    const s = setup({ inbox: [item({ id: "1", threadId: "A" })] }, () => knowledge());
    const out = join(s.root, "dry");
    const r = await runOnce(s.cfg, s.state, s.deps, { dryRun: true, limit: 25, outRoot: out });
    expect(existsSync(join(out, r.notes[0].relPath))).toBe(true);
    expect(existsSync(join(s.root, "inbox"))).toBe(false);
    expect(s.commits).toHaveLength(0);
    expect(r.nextState).toBe(s.state);
    s.cleanup();
  });
});

test("each extracted thread logs its tokens and source (ids only) for the Usage page", async () => {
  const s = setup({ inbox: [item({ id: "m1", threadId: "ai-chatgpt:c1", source: "chatgpt-chat" }), item({ id: "m2", threadId: "B" })] }, () => knowledge());
  try {
    const logged: Record<string, unknown>[] = [];
    s.deps.log = e => logged.push(e);
    s.deps.extract = async () => ({ knowledge: knowledge(), costUsd: 0.02, usage: { inputTokens: 7000, outputTokens: 400 } });
    await runOnce(s.cfg, s.state, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
    const tokens = logged.filter(e => e.stage === "tokens").sort((a, b) => String(a.thread).localeCompare(String(b.thread)));
    expect(tokens).toEqual([{ stage: "tokens", thread: "ai-chatgpt:c1", source: "chatgpt-chat", inputTokens: 7000, outputTokens: 400, costUsd: 0.02 },
      { stage: "tokens", thread: "B", source: "email", inputTokens: 7000, outputTokens: 400, costUsd: 0.02 }]);
  } finally { s.cleanup(); }
});

describe("decision model triage before the note writer", () => {
  test("sure skips never reach the note writer; uncertain, errors and existing notes always do", async () => {
    const s = setup({ inbox: [
      item({ id: "1", threadId: "R", subject: "Receipt" }),
      item({ id: "2", threadId: "P", subject: "Family dinner" }),
      item({ id: "3", threadId: "D", subject: "Deal terms" }),
      item({ id: "4", threadId: "E", subject: "Flaky" }),
    ] }, () => knowledge());
    const answers: Record<string, { pKeep: number; pPersonal: number } | Error> = {
      Receipt: { pKeep: 0.05, pPersonal: 0.01 }, "Family dinner": { pKeep: 0.6, pPersonal: 0.95 },
      "Deal terms": { pKeep: 0.4, pPersonal: 0.02 }, Flaky: new Error("TypeSafe did not answer"),
    };
    const { triageDecision } = await import("../src/core/decision.ts");
    const logs: any[] = [];
    s.deps.log = e => logs.push(e);
    s.deps.triage = async t => {
      const a = answers[t.items[0].subject];
      if (a instanceof Error) throw a;
      return { ...a, ...triageDecision(a), ms: 5, inputTokens: 100, model: "jev-test" };
    };
    try {
      const { report, nextState } = await runOnce(s.cfg, s.state, s.deps, { dryRun: false, limit: 25, outRoot: s.root });
      expect(s.extracted.sort()).toEqual(["D", "E"]);              // the receipt and the personal one skipped the writer
      expect(report).toMatchObject({ skipped: 2, triageSkipped: 2, written: 2 });
      expect(nextState.processed?.["1"]?.outcome ?? (nextState as any).processed["1"].outcome).toBe("skipped:decision:not-worth-keeping");
      expect((nextState as any).processed["2"].outcome).toBe("skipped:decision:personal");
      expect(logs.filter(l => l.stage === "triage" && l.error).map(l => l.thread)).toEqual(["E"]);
      expect(logs.some(l => l.stage === "triage" && JSON.stringify(l).includes("Deal terms"))).toBe(false); // ids and numbers only
      // A thread that already has a note is never triaged: a short reply can not stop the update.
      const s2 = setup({ inbox: [item({ id: "9", threadId: "D", subject: "Receipt" })] }, () => knowledge());
      s2.deps.triage = s.deps.triage;
      const st = { ...s2.state, threads: { D: { relPath: nextState.threads.D.relPath, lastMessageAt: "" } } };
      mkdirSync(join(s2.root, nextState.threads.D.relPath, ".."), { recursive: true });
      writeFileSync(join(s2.root, nextState.threads.D.relPath), readFileSync(join(s.root, nextState.threads.D.relPath)));
      await runOnce(s2.cfg, st as State, s2.deps, { dryRun: false, limit: 25, outRoot: s2.root });
      expect(s2.extracted).toEqual(["D"]);
      s2.cleanup();
    } finally { s.cleanup(); }
  });
});
