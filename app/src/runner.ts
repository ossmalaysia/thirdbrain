import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { STATE_DIR, loadState } from "./state.ts";
import { readJson, atomicJson } from "../docker/scheduler.mjs";

export const SCHEDULER_DIR = join(STATE_DIR, "scheduler");
export interface Schedule { state: string; nextRun: string | null; lastRun: string | null; result: number | null;
  backend?: "windows" | "docker"; enabled?: boolean; healthy?: boolean; workerAvailable?: boolean; lastFinishedAt?: string | null }
export const dockerBackend = (directory = SCHEDULER_DIR) => readJson(join(directory, "backend.json"))?.backend === "docker";
export function runningCollector(): { since: string | null } | null {
  try {
    const owner = JSON.parse(readFileSync(join(STATE_DIR, "run.lock"), "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return null;
    process.kill(owner.pid, 0);
    return { since: typeof owner.at === "string" ? owner.at : null };
  } catch { return null; }
}
const live = (value: any, now: number) => !!value && Number.isFinite(Date.parse(value.heartbeat)) && now - Date.parse(value.heartbeat) < 30_000;
export function runHistory(directory = SCHEDULER_DIR) {
  return readJson(join(directory, "runs.json"), { total: 0, succeeded: 0, failed: 0, skipped: 0, entries: [] });
}
function updateHistory(directory: string, entry: any, starting = false) {
  const history = runHistory(directory);
  if (starting) { history.total++; history.entries.unshift(entry); history.entries = history.entries.slice(0, 100); }
  else {
    const index = history.entries.findIndex((row: any) => row.id === entry.id);
    if (index >= 0 && history.entries[index].status === "running") {
      history.entries[index] = entry;
      if (entry.status === "succeeded") history.succeeded++;
      else if (entry.status === "skipped") history.skipped++;
      else history.failed++;
    }
  }
  atomicJson(join(directory, "runs.json"), history);
}
export function dockerSchedule(directory = SCHEDULER_DIR, now = Date.now()): Schedule {
  const clock = readJson(join(directory, "status.json"));
  const worker = readJson(join(directory, "worker.json"));
  const healthy = live(clock, now), workerAvailable = live(worker, now);
  const enabled = readJson(join(directory, "control.json"))?.enabled === true;
  const pending = existsSync(join(directory, "requests")) && readdirSync(join(directory, "requests")).some(name => /^[0-9a-f-]{36}\.json$/.test(name));
  return { backend: "docker", enabled, healthy, workerAvailable,
    state: !healthy || !workerAvailable ? "Unavailable" : worker.busy ? "Running" : !enabled ? "Disabled" : pending ? "Queued" : "Ready",
    nextRun: healthy && enabled ? clock.nextRun : null,
    lastRun: worker?.lastStartedAt ?? null, lastFinishedAt: worker?.lastFinishedAt ?? null, result: worker?.result ?? null };
}
export function dockerAction(action: "sync" | "pause" | "resume", directory = SCHEDULER_DIR) {
  mkdirSync(join(directory, "requests"), { recursive: true });
  if (action !== "sync") { atomicJson(join(directory, "control.json"), { enabled: action === "resume" }); return; }
  const status = dockerSchedule(directory);
  if (!status.healthy || !status.workerAvailable) throw new Error("Docker scheduler or local worker is unavailable");
  if (!status.enabled) throw new Error("Resume automatic sync first");
  if (["Running", "Queued"].includes(status.state)) return;
  const id = randomUUID();
  atomicJson(join(directory, "requests", `${id}.json`), { id, source: "manual", createdAt: new Date().toISOString() });
}

/** The collector command for a job: a manual Sync now runs every feed; the 15-minute schedule only the due ones. */
export const collectorArgs = (request: { source?: string }) => request.source === "manual" ? ["run", "--all"] : ["run"];

async function executeCollector(request: { source?: string }): Promise<number> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...collectorArgs(request)], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", windowsHide: true });
  // Drain output without exposing email, provider responses or credentials.
  const timer = setTimeout(() => child.kill(), 90 * 60_000);
  try { const [, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return code; }
  finally { clearTimeout(timer); }
}

export function startWorker(opts: { directory?: string; enabled?: () => boolean; running?: () => ReturnType<typeof runningCollector>; execute?: (request: { source: string }) => Promise<number>; autoStart?: boolean } = {}) {
  const directory = opts.directory ?? SCHEDULER_DIR;
  const enabled = opts.enabled ?? (() => dockerBackend(directory));
  const running = opts.running ?? runningCollector;
  const execute = opts.execute ?? executeCollector;
  mkdirSync(join(directory, "requests"), { recursive: true });
  let busy = false, stopped = false;
  let record = { ...readJson(join(directory, "worker.json"), {}), busy: false };
  // Heartbeat/status write. Best effort: a failed write (Windows rename refused while Docker reads the
  // file) must never abort a poll, skip a run or leave the worker busy. The next heartbeat retries.
  const publish = () => {
    try { if (enabled()) atomicJson(join(directory, "worker.json"), { ...record, busy: busy || !!running(), heartbeat: new Date().toISOString() }); }
    catch { console.error("Local worker could not update worker.json; retrying on the next heartbeat."); }
  };
  async function poll() {
    if (stopped || !enabled() || busy) return;
    publish();
    if (running()) return;
    const active = join(directory, "active.json");
    // Recover an interrupted job after its old collector has exited. The persistent
    // message ledger makes replay safe even if that run already wrote a note.
    if (existsSync(active)) {
      const previous = readJson(active);
      if (/^[0-9a-f-]{36}$/.test(previous?.id ?? "")) atomicJson(join(directory, "requests", `${previous.id}.json`), previous);
      for (const row of runHistory(directory).entries.filter((row: any) => row.status === "running")) {
        updateHistory(directory, { ...row, status: "interrupted", finishedAt: new Date().toISOString(), error: "Worker restarted before recording completion; durable email queue will resume." });
      }
      rmSync(active);
    }
    if (readJson(join(directory, "control.json"))?.enabled !== true) return;
    const name = readdirSync(join(directory, "requests")).sort().find(name => /^[0-9a-f-]{36}\.json$/.test(name));
    if (!name) return;
    const file = join(directory, "requests", name);
    const request = readJson(file);
    if (request?.id !== name.slice(0, -5) || !["automatic", "manual"].includes(request?.source) || !Number.isFinite(Date.parse(request?.createdAt))) { rmSync(file); return; }
    renameSync(file, active);
    busy = true;
    const entry = { id: randomUUID(), source: request.source, startedAt: new Date().toISOString(), finishedAt: null, status: "running" };
    updateHistory(directory, entry, true);
    record = { ...record, lastStartedAt: entry.startedAt, source: request.source, result: null };
    // Status and history writes are best effort: a failed write must never skip the run or leave the
    // worker busy forever (it did on 2026-10-15, when Windows refused a rename of worker.json).
    const attempt = (step: () => void) => { try { step(); } catch { console.error("Local worker could not update scheduler control files."); } };
    try {
      publish();
      try { record.result = await execute({ source: request.source }); }
      catch { record.result = 1; }
      record.lastFinishedAt = new Date().toISOString();
      attempt(() => {
        const state = loadState();
        const report = state.lastRun?.finishedAt && Date.parse(state.lastRun.at) >= Date.parse(entry.startedAt) ? state.lastRun : null;
        updateHistory(directory, { ...entry, finishedAt: record.lastFinishedAt,
          durationSeconds: Math.round((Date.parse(record.lastFinishedAt) - Date.parse(entry.startedAt)) / 1000),
          status: record.result === 0 ? report ? "succeeded" : "skipped" : "failed", exitCode: record.result,
          pulled: report?.pulled ?? null, written: report?.written ?? null, queued: state.queue.length, notes: report?.notes ?? [],
          error: record.result === 0 ? null : report?.error ?? "Collector did not complete; queued emails remain available for retry." });
      });
    } finally {
      attempt(() => rmSync(active, { force: true })); busy = false; publish();
    }
  }
  const safelyPoll = () => { void poll().catch(() => console.error("Local worker could not update scheduler control files.")); };
  if (opts.autoStart !== false) safelyPoll();
  const timer = opts.autoStart === false ? null : setInterval(safelyPoll, 1000);
  const heartbeat = opts.autoStart === false ? null : setInterval(() => { try { publish(); } catch { /* Retry on next heartbeat. */ } }, 5000);
  return { stop: () => { stopped = true; clearInterval(timer); clearInterval(heartbeat); }, poll, busy: () => busy };
}
