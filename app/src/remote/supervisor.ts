// Keeps one child process alive: restart with backoff, kill the whole process tree, and clean up an
// orphan left by a crashed portal (its pid is recorded). Restart rules adapted from EzyChat Lite's
// tunnel manager (github.com/ossmalaysia/ezychat-lite, MIT).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const STABLE_RUN_MS = 30_000, BACKOFF_RESET_MS = 5 * 60_000, MAX_FAILURES = 5, MAX_BACKOFF_MS = 60_000, LOG_TAIL = 30;

export type ProcState = "stopped" | "starting" | "running" | "error";
export interface Launch { cmd: string[]; env?: Record<string, string | undefined> }
export interface SupervisorOptions {
  name: string;
  /** Records the child pid so a later portal can kill an orphan holding a port or lock. */
  pidFile?: string;
  /** Called for every output line; return true once the child is ready (state becomes running). */
  onLine?: (line: string) => boolean | void;
  onExit?: () => void;
  spawn?: typeof Bun.spawn;
  killTree?: (pid: number) => void;
  now?: () => number;
}

/** Windows: taskkill /T kills children too (gbrain.exe runs a bun child that holds the DB lock). */
export function killTree(pid: number): void {
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true });
  else try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function createSupervisor(opts: SupervisorOptions) {
  const spawn = opts.spawn ?? Bun.spawn, kill = opts.killTree ?? killTree, now = opts.now ?? Date.now;
  let child: ReturnType<typeof Bun.spawn> | null = null, launch: Launch | null = null;
  let state: ProcState = "stopped", lastError: string | null = null, logTail: string[] = [];
  let failures = 0, attempts = 0, runningAt = 0, timer: ReturnType<typeof setTimeout> | null = null;

  const clearOrphan = () => {
    if (!opts.pidFile || !existsSync(opts.pidFile)) return;
    const pid = Number(readFileSync(opts.pidFile, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== child?.pid && alive(pid)) kill(pid);
    rmSync(opts.pidFile, { force: true });
  };

  async function pump(stream: ReadableStream<Uint8Array> | null, own: typeof child) {
    if (!stream) return;
    const decoder = new TextDecoder();
    let buffer = "";
    const emit = (line: string) => {
      line = line.slice(-4096).trimEnd();
      if (!line || child !== own) return;
      logTail = [...logTail, line].slice(-LOG_TAIL);
      if (opts.onLine?.(line) && state !== "running") { state = "running"; runningAt = now(); lastError = null; }
    };
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n")) !== -1) { emit(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
    }
    emit(buffer);
  }

  function start() {
    if (!launch) return;
    clearOrphan();
    runningAt = 0; state = "starting";
    let own: ReturnType<typeof Bun.spawn>;
    const env = launch.env && Object.fromEntries(Object.entries(launch.env).filter((e): e is [string, string] => e[1] !== undefined));
    try { own = spawn(launch.cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env }); }
    catch (e) { gone(null, e instanceof Error ? e.message : String(e)); return; }
    child = own;
    if (opts.pidFile) writeFileSync(opts.pidFile, String(own.pid));
    void pump(own.stdout as ReadableStream<Uint8Array>, own);
    void pump(own.stderr as ReadableStream<Uint8Array>, own);
    void own.exited.then(code => gone(own, `${opts.name} exited (code ${code})`));
  }

  /** Unexpected exit: back off 1s, 2s, 4s… (max 60s); 5 quick failures in a row -> error. */
  function gone(own: typeof child, reason: string) {
    if (own && child !== own) return; // replaced or stopped on purpose
    child = null;
    if (opts.pidFile) rmSync(opts.pidFile, { force: true });
    opts.onExit?.();
    lastError = reason;
    const upFor = runningAt ? now() - runningAt : 0;
    if (upFor >= STABLE_RUN_MS) failures = 0;
    if (upFor >= BACKOFF_RESET_MS) attempts = 0;
    failures++; attempts++;
    if (failures >= MAX_FAILURES) { state = "error"; return; }
    state = "starting";
    const delay = Math.min(1000 * 2 ** Math.min(attempts - 1, 16), MAX_BACKOFF_MS);
    timer = setTimeout(() => { timer = null; if (launch && !child) start(); }, delay);
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    const own = child;
    child = null; launch = null;
    if (own) kill(own.pid);
    if (opts.pidFile) rmSync(opts.pidFile, { force: true });
    opts.onExit?.();
    state = "stopped"; runningAt = 0;
  }

  return {
    /** (Re)starts with a new command line; resets failure counters. */
    run(next: Launch) { stop(); launch = next; failures = 0; attempts = 0; lastError = null; logTail = []; start(); },
    stop,
    clearOrphan,
    /** For children that print no ready line (GBrain): the caller confirms readiness, e.g. via /health. */
    markReady() { if (child && state !== "running") { state = "running"; runningAt = now(); lastError = null; } },
    status: () => ({ state, lastError, logTail: [...logTail] }),
    running: () => !!child,
  };
}
export type Supervisor = ReturnType<typeof createSupervisor>;
