import { expect, test } from "bun:test";
import { freePort } from "./fixtures.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackupScheduler, type BackupAction, type BackupStatus } from "../src/backup.ts";
import { createPortal, type PortalDeps } from "../src/portal.ts";
import { backupState } from "../portal/view.js";

const ok: BackupStatus = { state: "Ready", enabled: true, intervalMinutes: 60, lastRun: null, nextRun: null, lastResult: 0,
  push: true, remotes: 1, uncommitted: 0, unpushed: 0, lastCommitAt: null };

test("scheduler runs when due, catches up missed runs once, and honours pause and interval changes", async () => {
  let clock = Date.parse("2026-10-15T00:00:00Z"), runs = 0;
  const minutes = (n: number) => { clock += n * 60_000; };
  const s = createBackupScheduler({ file: join(mkdtempSync(join(tmpdir(), "backup-")), "backup.json"), now: () => clock, execute: async () => { runs++; return 0; } });
  await s.tick(); expect(runs).toBe(0); // first tick only plans the next run
  expect(s.config().nextRun).toBe("2026-10-15T01:00:00.000Z");
  minutes(59); await s.tick(); expect(runs).toBe(0);
  minutes(1); await s.tick(); expect(runs).toBe(1);
  expect(s.config()).toMatchObject({ lastResult: 0, nextRun: "2026-10-15T02:00:00.000Z" });
  minutes(600); await s.tick(); await s.tick(); expect(runs).toBe(2); // asleep 10h: one catch-up run, not ten
  await s.action("pause"); minutes(120); await s.tick(); expect(runs).toBe(2);
  await s.action("resume"); await s.tick(); expect(runs).toBe(3);
  await s.action({ intervalMinutes: 15 }); expect(s.config().nextRun).toBe(new Date(clock + 15 * 60_000).toISOString());
  expect(s.action({ intervalMinutes: 7 })).rejects.toThrow();
});

test("a failed backup is recorded and retried at the next interval", async () => {
  let clock = 0;
  const s = createBackupScheduler({ file: join(mkdtempSync(join(tmpdir(), "backup-")), "backup.json"), now: () => clock, execute: async () => { throw new Error("git push failed"); } });
  await s.action("run"); await Bun.sleep(0);
  expect(s.config()).toMatchObject({ lastResult: 1, nextRun: new Date(60 * 60_000).toISOString() });
  expect(s.running()).toBe(false);
});

test("backup headline: missing task, running, paused, failed, unpushed, ok", () => {
  expect(backupState(undefined).tone).toBe("error");
  expect(backupState({ ...ok, state: "Running", lastResult: 1 }).text).toBe("Backing up now");
  expect(backupState({ ...ok, enabled: false, state: "Disabled" }).text).toBe("Automatic backup paused");
  expect(backupState({ ...ok, lastResult: 1 }).text).toBe("Last backup failed");
  expect(backupState({ ...ok, lastResult: null }).text).toBe("Backed up"); // never run yet is not a failure
  expect(backupState({ ...ok, unpushed: 2 }).detail).toContain("2 commits");
  expect(backupState({ ...ok, push: false, unpushed: 2 }).detail).toContain("pushing is off");
});

test("backup endpoints validate settings, change the interval only when needed, and avoid overlapping runs", async () => {
  let status = { ...ok }, configured: Record<string, string> | null = null;
  const actions: BackupAction[] = [];
  const services = {
    config: () => ({ brainPath: "x", clientId: "", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 10 }),
    state: () => ({ cursors: {}, threads: {}, queue: [], lookbackDays: 10, lastRun: null }),
    connected: () => true, running: () => null, schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }),
    configure: (u: Record<string, string>) => { configured = u; }, action: async () => {}, exchange: async () => {},
    backup: async () => status, backupAction: async (a: BackupAction) => { actions.push(a); },
  } as unknown as PortalDeps;
  const port = freePort(), server = createPortal(port, services), base = `http://127.0.0.1:${port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="portal-token" content="([^"]+)"/)![1];
    const post = (path: string, body: unknown = {}) => fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify(body) });
    expect((await (await fetch(base + "/api/status")).json()).backup.remotes).toBe(1);
    for (const body of [{ intervalMinutes: 7, push: true }, { intervalMinutes: 60, push: "yes" }]) expect((await post("/api/backup/settings", body)).status).toBe(400);
    expect(configured).toBeNull();
    expect((await post("/api/backup/settings", { intervalMinutes: 60, push: false })).status).toBe(200);
    expect(configured).toEqual({ BACKUP_PUSH: "false" }); expect(actions).toEqual([]);
    expect((await post("/api/backup/settings", { intervalMinutes: 180, push: true })).status).toBe(200);
    expect(actions).toEqual([{ intervalMinutes: 180 }]);
    await post("/api/backup/run"); await post("/api/backup/pause");
    expect(actions.slice(1)).toEqual(["run", "pause"]);
    status = { ...ok, state: "Running" };
    expect((await (await post("/api/backup/run")).json()).message).toBe("A backup is already running.");
    expect(actions).toHaveLength(3);
    expect((await post("/api/backup/nope")).status).toBe(404);
  } finally { server.stop(true); }
});

test("real git: a local-only repo that .gitignore already ignores does not fail the backup (2026-10-18 bug)", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { runVaultBackup } = await import("../src/backup.ts");
  const git = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const vault = mkdtempSync(join(tmpdir(), "vault-"));
  try {
    git(["init", "-q", "-b", "main"], vault); git(["config", "user.email", "t@example.com"], vault); git(["config", "user.name", "t"], vault);
    writeFileSync(join(vault, ".gitignore"), "life/\n");
    mkdirSync(join(vault, "life")); git(["init", "-q", "-b", "main"], join(vault, "life"));
    git(["config", "user.email", "t@example.com"], join(vault, "life")); git(["config", "user.name", "t"], join(vault, "life"));
    writeFileSync(join(vault, "life", "private.md"), "family");
    writeFileSync(join(vault, "note.md"), "hello");
    const code = await runVaultBackup({ vault, push: false, localOnlyRepos: ["life"], now: new Date("2026-10-18T09:00:00Z") });
    expect(code).toBe(0);
    expect(git(["log", "--oneline"], vault).stdout.toString()).toContain("backup:");
    expect(git(["ls-files"], vault).stdout.toString().split("\n").filter(Boolean).sort()).toEqual([".gitignore", "note.md"]); // life/ never in the vault repo
    expect(git(["log", "--oneline"], join(vault, "life")).stdout.toString()).toContain("backup:"); // committed locally in its own repo
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
