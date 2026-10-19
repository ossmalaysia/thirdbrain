import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicJson, readJson, tick, nextDue } from "../docker/scheduler.mjs";
import { dockerSchedule, dockerAction, startWorker, runHistory } from "../src/runner.ts";
import { codexFailure } from "../src/core/extract.ts";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "brain-scheduler-test-"));
  mkdirSync(join(dir, "requests"));
  atomicJson(join(dir, "control.json"), { enabled: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test("Docker dispatches on quarter hours, skips running/pending work, and persists pause", () => {
  const f = fixture(); const start = Date.parse("2026-10-15T00:00:00Z");
  try {
    expect(nextDue(start + 60_000)).toBe(start + 15 * 60_000);
    expect(tick(f.dir, start).dispatched).toBe(false);
    expect(tick(f.dir, start + 15 * 60_000).dispatched).toBe(true);
    expect(readdirSync(join(f.dir, "requests")).length).toBe(1);
    expect(tick(f.dir, start + 30 * 60_000).dispatched).toBe(false);
    for (const file of readdirSync(join(f.dir, "requests"))) rmSync(join(f.dir, "requests", file));
    atomicJson(join(f.dir, "worker.json"), { busy: true, heartbeat: new Date(start + 45 * 60_000).toISOString() });
    expect(tick(f.dir, start + 45 * 60_000).dispatched).toBe(false);
    dockerAction("pause", f.dir);
    expect(tick(f.dir, start + 60 * 60_000).dispatched).toBe(false);
    expect(readJson(join(f.dir, "control.json")).enabled).toBe(false);
    dockerAction("resume", f.dir);
    expect(tick(f.dir, start + 75 * 60_000).dispatched).toBe(true);
  } finally { f.cleanup(); }
});
test("Docker status detects stale heartbeats, keeps pause independent of an active run, and manual sync deduplicates", () => {
  const f = fixture();
  try {
    tick(f.dir);
    atomicJson(join(f.dir, "worker.json"), { heartbeat: new Date().toISOString(), busy: false });
    expect(dockerSchedule(f.dir).state).toBe("Ready");
    dockerAction("sync", f.dir); dockerAction("sync", f.dir);
    expect(readdirSync(join(f.dir, "requests")).length).toBe(1);
    expect(dockerSchedule(f.dir).state).toBe("Queued");
    dockerAction("pause", f.dir);
    atomicJson(join(f.dir, "worker.json"), { heartbeat: new Date().toISOString(), busy: true });
    expect(dockerSchedule(f.dir).state).toBe("Running");
    expect(dockerSchedule(f.dir).enabled).toBe(false);
    expect(dockerSchedule(f.dir, Date.now() + 60_000).state).toBe("Unavailable");
    expect(() => dockerAction("sync", f.dir)).toThrow("Resume");
  } finally { f.cleanup(); }
});
test("worker executes only fixed valid jobs, prevents overlap, and lets an active job finish when paused", async () => {
  const f = fixture(); let count = 0; let resolve!: (n: number) => void;
  const worker = startWorker({ directory: f.dir, enabled: () => true, running: () => null, autoStart: false,
    execute: () => { count++; return new Promise<number>(r => { resolve = r; }); } });
  try {
    const id = randomUUID(); atomicJson(join(f.dir, "requests", `${id}.json`), { id, source: "manual", createdAt: new Date().toISOString(), command: "ignored" });
    const run = worker.poll();
    expect(worker.busy()).toBe(true); await worker.poll(); expect(count).toBe(1);
    dockerAction("pause", f.dir); resolve(0); await run;
    expect(readJson(join(f.dir, "worker.json")).result).toBe(0);
    expect(readJson(join(f.dir, "worker.json")).busy).toBe(false);
    const invalid = randomUUID(); atomicJson(join(f.dir, "requests", `${invalid}.json`), { id: invalid, source: "shell", createdAt: new Date().toISOString() });
    dockerAction("resume", f.dir); await worker.poll(); expect(count).toBe(1);
  } finally { worker.stop(); f.cleanup(); }
});
test("a status file that cannot be written never skips the run or leaves the worker busy (2026-10-15 regression)", async () => {
  const f = fixture(); let count = 0;
  mkdirSync(join(f.dir, "worker.json")); // a directory: every rename onto it fails, like a file Windows holds open
  const worker = startWorker({ directory: f.dir, enabled: () => true, running: () => null, autoStart: false, execute: async () => { count++; return 0; } });
  try {
    const id = randomUUID(); atomicJson(join(f.dir, "requests", `${id}.json`), { id, source: "automatic", createdAt: new Date().toISOString() });
    await worker.poll().catch(() => {});
    expect(count).toBe(1); // the sync still ran
    expect(worker.busy()).toBe(false); // and the worker is free for the next one
    expect(readdirSync(f.dir).some(n => n.endsWith(".tmp"))).toBe(false); // no temp files left behind
  } finally { worker.stop(); f.cleanup(); }
}, 30_000);
test("worker recovers an interrupted claimed job only after the old collector exits", async () => {
  const f = fixture(); let alive = true, count = 0;
  const worker = startWorker({ directory: f.dir, enabled: () => true, running: () => alive ? { since: "date" } : null, autoStart: false, execute: async () => { count++; return 0; } });
  try {
    const id = randomUUID(); atomicJson(join(f.dir, "active.json"), { id, source: "automatic", createdAt: new Date().toISOString() });
    await worker.poll(); expect(count).toBe(0);
    alive = false; await worker.poll(); expect(count).toBe(1);
    expect(readJson(join(f.dir, "active.json"))).toBeNull();
    expect(readJson(join(f.dir, "worker.json")).source).toBe("automatic");
  } finally { worker.stop(); f.cleanup(); }
});
test("run counters survive worker restarts and failures do not store raw thrown data", async () => {
  const f = fixture();
  const opts = { directory: f.dir, enabled: () => true, running: () => null, autoStart: false, execute: async (): Promise<number> => { throw new Error("PRIVATE PROVIDER TEXT"); } };
  let worker = startWorker(opts);
  try {
    const id = randomUUID(); atomicJson(join(f.dir, "requests", `${id}.json`), { id, source: "manual", createdAt: new Date().toISOString() });
    await worker.poll(); worker.stop();
    expect(runHistory(f.dir).total).toBe(1); expect(runHistory(f.dir).failed).toBe(1);
    expect(JSON.stringify(runHistory(f.dir))).not.toContain("PRIVATE PROVIDER TEXT");
    worker = startWorker(opts); await worker.poll();
    expect(runHistory(f.dir).total).toBe(1); expect(runHistory(f.dir).entries.length).toBe(1);
  } finally { worker.stop(); f.cleanup(); }
});
test("Codex failure details distinguish timeout, subscription limits and sign-in without raw output", () => {
  expect(codexFailure("private text", true).code).toBe("TIMEOUT");
  expect(codexFailure("You've hit your usage limit").code).toBe("USAGE_LIMIT");
  expect(codexFailure("401 Unauthorized").code).toBe("AUTHENTICATION");
  expect(codexFailure("PRIVATE PROVIDER TEXT").message).not.toContain("PRIVATE PROVIDER TEXT");
});
