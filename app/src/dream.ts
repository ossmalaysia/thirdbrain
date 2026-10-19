// Dream: the nightly brain upkeep (Runs page > Dream; on/off and start hour there). Two parts:
//  1. Third Brain (vault files): related notes for every note (local Ollama), the duplicate check (decision model or
//     LLM decides clear duplicate entities), and topic/entity pages with their links and merges, then commit + `gbrain sync`. The GBrain server still runs; only the automatic sync is paused.
//  2. GBrain (its own commands, the database alone): extract links/timeline of changed pages, mention links (a new
//     entity page links the OLD notes that name it), embeddings for new chunks (the sync runs --no-embed), and the
//     orphan count for the report. The portal stops its GBrain server for these minutes, so Claude.ai and local agents
//     get no answer; hence the night.
// GBrain's own `gbrain dream` cycle also synthesizes reflections and patterns with a chat model (tokens, and no chat
// key here) and lints/back-links notes in place (it would edit notes agents must not edit), so Dream calls only the
// GBrain commands above.
import { join } from "node:path";
import { homedir } from "node:os";
import { STATE_DIR } from "./state.ts";
import { atomicJson, readJson } from "../docker/scheduler.mjs";

export const DREAM_FILE = join(STATE_DIR, "dream.json");
export const DREAM_HOUR = 3, HISTORY = 14;
const STEP_TIMEOUT_MS = 60 * 60_000, SYNC_WAIT_MS = 2 * 60 * 60_000; // a large chat import makes one sync run long
/** Tries again 30 minutes after a skip (a long sync run), until RETRY_HOURS after the start hour. */
export const RETRY_HOURS = 4, RETRY_AFTER_MS = 30 * 60_000;

export interface DreamStep { id: string; name: string; part: "vault" | "gbrain"; argv: string[] }
export const DREAM_STEPS: DreamStep[] = [
  { id: "related", name: "Related notes", part: "vault", argv: ["related", "rebuild"] },
  { id: "judge", name: "Duplicate check (decision model or LLM)", part: "vault", argv: ["entities", "judge"] },
  { id: "entities", name: "Topics and entity pages, merges, commit, index", part: "vault", argv: ["entities", "rebuild"] },
  { id: "extract", name: "GBrain: links and timeline of changed pages", part: "gbrain", argv: ["extract", "--stale", "--include-frontmatter"] },
  { id: "mentions", name: "GBrain: mention links", part: "gbrain", argv: ["extract", "links", "--by-mention", "--source", "db"] },
  { id: "embed", name: "GBrain: embeddings for search", part: "gbrain", argv: ["embed", "--stale"] },
  { id: "orphans", name: "GBrain: orphan count", part: "gbrain", argv: ["orphans", "--count"] },
];

export interface StepResult { id: string; name: string; code: number; seconds: number; summary?: string }
export interface DreamRun { at: string; finishedAt: string | null; result: "ok" | "failed" | "skipped" | null; detail: string | null; steps: StepResult[] }
export interface DreamState { enabled: boolean; hour: number; history: DreamRun[] }
const EMPTY: DreamState = { enabled: true, hour: DREAM_HOUR, history: [] };
export const loadDream = (file = DREAM_FILE): DreamState => {
  const s = { ...EMPTY, ...readJson(file, {}) } as DreamState;
  return { enabled: s.enabled !== false, hour: Number.isInteger(s.hour) && s.hour >= 0 && s.hour <= 23 ? s.hour : DREAM_HOUR, history: Array.isArray(s.history) ? s.history : [] };
};

/** Local calendar day: one run per night, also after a reboot past the start hour. */
const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/** Due: on, at or after the hour, not yet run today; or a retry after a skip, within RETRY_HOURS of the hour. */
export function dreamDue(s: DreamState, now: number): boolean {
  const h = new Date(now).getHours(), last = s.history[0];
  if (!s.enabled || h < s.hour) return false;
  if (!last || day(Date.parse(last.at)) !== day(now)) return true;
  return last.result === "skipped" && h < s.hour + RETRY_HOURS && now - Date.parse(last.finishedAt ?? last.at) >= RETRY_AFTER_MS;
}

/** One line for the run table from a step's stdout (the CLI prints JSON reports; GBrain prints the orphan count). */
export function summarize(id: string, out: string): string | undefined {
  const json = (() => { try { return JSON.parse(out.slice(out.indexOf("{"))); } catch { return null; } })();
  if (id === "related" && json) return `${json.withRelated} of ${json.notes} notes have related notes (${json.links} links); ${json.notesChanged} changed`;
  if (id === "entities" && json?.entities) return `${json.entities.topic ?? 0} topics, ${json.entities.person} people, ${json.entities.company} companies, ${json.entities.project} projects; ${json.notesLinked} notes and ${json.pagesChanged} pages changed`;
  if (id === "judge" && json && json.judge === null && !json.asked) return "No decision model or LLM set up; pairs wait for you";
  if (id === "judge" && json && "pairs" in json) return `${json.merged} merged, ${json.distinct} not the same, ${json.review} left for you (${json.asked} asked${json.judge ? `, ${json.judge}` : ""})`;
  if (id === "orphans") { const n = out.match(/(\d+)\s*$/)?.[1]; return n ? `${n} pages without inbound links` : undefined; }
  return undefined;
}

export interface DreamDeps {
  file?: string; now?: () => number; sleep?: (ms: number) => Promise<void>;
  /** The automatic sync (the portal's Pause / Resume): on or off, and whether a run is in progress. */
  runner: { status(): Promise<{ enabled: boolean; busy: boolean }>; enable(on: boolean): Promise<void> };
  /** The portal's GBrain server. */
  gbrain: { pause(): void; resume(): void };
  exec?: (step: DreamStep, timeoutMs: number) => Promise<{ code: number; out: string }>;
}

const gbrainExe = () => join(homedir(), ".bun", "bin", process.platform === "win32" ? "gbrain.exe" : "gbrain");
/** Vault steps run this app's CLI in a child process (the portal stays responsive); GBrain steps run gbrain. */
async function execStep(step: DreamStep, timeoutMs: number): Promise<{ code: number; out: string }> {
  const cmd = step.part === "vault" ? [process.execPath, join(import.meta.dir, "cli.ts"), ...step.argv] : [gbrainExe(), ...step.argv];
  const p = Bun.spawn(cmd, { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try { const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]); return { code, out: out.slice(-20_000) }; }
  finally { clearTimeout(timer); }
}

export function createDream(deps: DreamDeps) {
  const file = deps.file ?? DREAM_FILE, now = deps.now ?? Date.now, sleep = deps.sleep ?? Bun.sleep;
  const runner = deps.runner, exec = deps.exec ?? execStep;
  let running = false, current: string | null = null;
  const iso = () => new Date(now()).toISOString();
  /** Updates the newest run (index 0) and keeps HISTORY runs. */
  const saveRun = (patch: Partial<DreamRun>) => {
    const s = loadDream(file), [head, ...rest] = s.history;
    atomicJson(file, { ...s, history: [{ ...head, ...patch }, ...rest].slice(0, HISTORY) });
  };

  async function run(): Promise<boolean> {
    if (running) return false;
    running = true;
    const s = loadDream(file);
    atomicJson(file, { ...s, history: [{ at: iso(), finishedAt: null, result: null, detail: null, steps: [] }, ...s.history].slice(0, HISTORY) });
    let wasEnabled = false, paused = false;
    const steps: StepResult[] = [];
    const step = async (st: DreamStep) => {
      current = st.name;
      const t = now(), r = await exec(st, STEP_TIMEOUT_MS).catch(() => ({ code: -1, out: "" }));
      steps.push({ id: st.id, name: st.name, code: r.code, seconds: Math.round((now() - t) / 1000), summary: summarize(st.id, r.out) });
      saveRun({ steps });
    };
    try {
      wasEnabled = (await runner.status()).enabled;
      if (wasEnabled) await runner.enable(false); // no new sync run starts; a current one finishes
      current = "Waiting for the current sync run";
      for (const start = now(); (await runner.status()).busy; await sleep(15_000))
        if (now() - start > SYNC_WAIT_MS) { saveRun({ result: "skipped", detail: "A sync run did not finish within 2 hours. Dream tries again in 30 minutes (until 4 hours after its start time)." }); return true; }
      for (const st of DREAM_STEPS.filter(x => x.part === "vault")) await step(st);
      current = "Stopping GBrain";
      deps.gbrain.pause(); paused = true;
      await sleep(3000); // the server process tree exits and frees the database lock
      for (const st of DREAM_STEPS.filter(x => x.part === "gbrain")) await step(st);
      const failed = steps.filter(x => x.code !== 0).map(x => x.name);
      saveRun({ steps, result: failed.length ? "failed" : "ok", detail: failed.length ? `Failed: ${failed.join(", ")}.` : null });
    } catch (e) {
      saveRun({ steps, result: "failed", detail: e instanceof Error ? e.message : "Dream failed." });
    } finally {
      if (paused) deps.gbrain.resume();
      if (wasEnabled) await runner.enable(true).catch(() => saveRun({ detail: "Could not turn automatic sync back on. Use Resume on the portal." }));
      saveRun({ finishedAt: iso() });
      running = false; current = null;
    }
    return true;
  }

  async function tick() { if (!running && dreamDue(loadDream(file), now())) await run(); }
  return {
    run, tick,
    status: () => ({ ...loadDream(file), running, current, steps: DREAM_STEPS.map(({ id, name, part }) => ({ id, name, part })) }),
    configure(input: { enabled?: unknown; hour?: unknown }) {
      const s = loadDream(file);
      if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled must be true or false.");
      if (input.hour !== undefined && !(Number.isInteger(input.hour) && (input.hour as number) >= 0 && (input.hour as number) <= 23)) throw new Error("Choose an hour from 0 to 23.");
      atomicJson(file, { ...s, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.hour !== undefined ? { hour: input.hour } : {}) });
    },
    start: () => { const timer = setInterval(() => void tick().catch(() => console.error("Dream could not start.")), 60_000); return () => clearInterval(timer); },
  };
}
export type Dream = ReturnType<typeof createDream>;
