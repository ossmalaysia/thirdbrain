import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const INTERVAL_MS = 15 * 60_000;
export const nextDue = now => (Math.floor(now / INTERVAL_MS) + 1) * INTERVAL_MS;
export function readJson(file, fallback = null) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }
/** Write-then-rename. On Windows the rename fails (EPERM/EACCES/EBUSY) while another process, e.g. the
 *  Docker scheduler through its bind mount, has the target open, so retry briefly and never leave the temp file. */
export function atomicJson(file, value, attempts = 20) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  for (let i = 1; ; i++) {
    try { renameSync(tmp, file); return; }
    catch (e) {
      if (i >= attempts || !['EPERM', 'EACCES', 'EBUSY'].includes(e?.code)) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * i); // 25ms, 50ms, … ~5s in total
    }
  }
}
export function tick(directory, now = Date.now()) {
  mkdirSync(join(directory, 'requests'), { recursive: true });
  const enabled = readJson(join(directory, 'control.json'), { enabled: false }).enabled === true;
  const previous = readJson(join(directory, 'status.json'));
  let due = previous?.nextRun ? Date.parse(previous.nextRun) : nextDue(now);
  if (!Number.isFinite(due)) due = nextDue(now);
  const worker = readJson(join(directory, 'worker.json'));
  const workerLive = worker && now - Date.parse(worker.heartbeat) < 30_000;
  const pending = readdirSync(join(directory, 'requests')).some(name => /^[0-9a-f-]{36}\.json$/.test(name));
  let dispatched = false;
  if (now >= due) {
    // One pending request is enough. Do not stack jobs while extraction runs.
    if (enabled && !pending && !(workerLive && worker.busy)) {
      const id = randomUUID();
      atomicJson(join(directory, 'requests', `${id}.json`), { id, source: 'automatic', createdAt: new Date(now).toISOString() });
      dispatched = true;
    }
    due = nextDue(now);
  }
  const status = { backend: 'docker', heartbeat: new Date(now).toISOString(), enabled,
    nextRun: new Date(due).toISOString(), lastDispatch: dispatched ? new Date(now).toISOString() : previous?.lastDispatch ?? null };
  atomicJson(join(directory, 'status.json'), status);
  return { ...status, dispatched };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.env.BRAIN_SCHEDULER_DIR || '/control';
  if (process.argv.includes('--health')) {
    const status = readJson(join(directory, 'status.json'));
    process.exit(status && Date.now() - Date.parse(status.heartbeat) < 30_000 ? 0 : 1);
  }
  const poll = () => { try { const s = tick(directory); if (s.dispatched) console.log('Outlook job requested by Docker schedule.'); } catch { console.error('Scheduler could not update control files.'); process.exit(1); } };
  poll(); setInterval(poll, 1000);
}
