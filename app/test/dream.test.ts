import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDream, DREAM_STEPS, dreamDue, HISTORY, loadDream, summarize, type DreamState } from "../src/dream.ts";
import { dreamModel } from "../portal/view.js";

const at = (h: number, d = 18, m = 5) => new Date(2026, 9, d, h, m).getTime();
const tmp = () => join(mkdtempSync(join(tmpdir(), "tb-dream-")), "dream.json");
const run = (start: number, result: "ok" | "skipped" | "failed" | null = "ok", finished = start + 60_000) =>
  ({ at: new Date(start).toISOString(), finishedAt: new Date(finished).toISOString(), result, detail: null, steps: [] });

test("due: once per night at or after the hour, also after a late start; off means never; retry after a skip", () => {
  const s: DreamState = { enabled: true, hour: 3, history: [] };
  expect(dreamDue(s, at(2))).toBe(false);
  expect(dreamDue(s, at(3))).toBe(true);
  expect(dreamDue(s, at(9))).toBe(true);                                   // laptop was off at 03:00
  expect(dreamDue({ ...s, enabled: false }, at(4))).toBe(false);
  expect(dreamDue({ ...s, hour: 1 }, at(1))).toBe(true);
  const ran = { ...s, history: [run(at(3))] };
  expect(dreamDue(ran, at(23))).toBe(false);
  expect(dreamDue(ran, at(3, 19))).toBe(true);
  const skipped = { ...s, history: [run(at(3), "skipped", at(3, 18, 35))] };
  expect(dreamDue(skipped, at(3, 18, 50))).toBe(false);
  expect(dreamDue(skipped, at(4, 18, 6))).toBe(true);
  expect(dreamDue(skipped, at(8))).toBe(false);                             // retry window over
});

function harness(states: string[], codes: Record<string, number> = {}) {
  const log: string[] = [];
  let t = at(3);
  const file = tmp();
  const dream = createDream({
    file, now: () => t, sleep: async ms => { t += ms; },
    runner: { status: async () => { const st = states.length > 1 ? states.shift()! : states[0]; return { enabled: st !== "Disabled", busy: st === "Running" }; },
      enable: async on => { log.push(on ? "sync on" : "sync off"); } },
    gbrain: { pause: () => log.push("gbrain stop"), resume: () => log.push("gbrain start") },
    exec: async step => { log.push(step.id); t += 60_000; return { code: codes[step.id] ?? 0, out: step.id === "orphans" ? "42\n" : "" }; },
  });
  return { dream, log, file };
}

test("run: sync paused; vault steps with GBrain up; GBrain steps with it stopped; both started again", async () => {
  const { dream, log } = harness(["Ready", "Running", "Ready"]);
  await dream.run();
  expect(log).toEqual(["sync off", "related", "judge", "entities", "gbrain stop", "extract", "mentions", "embed", "orphans", "gbrain start", "sync on"]);
  const s = dream.status();
  expect(s.history[0]).toMatchObject({ result: "ok", detail: null });
  expect(s.history[0].steps).toHaveLength(DREAM_STEPS.length);
  expect(s.history[0].steps.at(-1)!.summary).toBe("42 pages without inbound links");
  const vm = dreamModel(s, false);
  expect(vm.fields.dreamState).toMatchObject({ tone: "ok", text: expect.stringContaining("7m 0s") });
  expect(vm.steps.every(x => x.result.text === "Done")).toBe(true);
  expect(vm.history[0].detail).toContain("42 pages");
});

test("run: a sync the user paused stays paused; a failed step is reported", async () => {
  const { dream, log } = harness(["Disabled"], { embed: 1 });
  await dream.run();
  expect(log).not.toContain("sync on");
  expect(log.at(-1)).toBe("gbrain start");
  expect(dream.status().history[0]).toMatchObject({ result: "failed", detail: "Failed: GBrain: embeddings for search." });
});

test("run: a sync that does not finish skips; GBrain is never stopped", async () => {
  const { dream, log } = harness(["Ready", "Running"]);
  await dream.run();
  expect(log).toEqual(["sync off", "sync on"]);
  expect(dream.status().history[0].result).toBe("skipped");
  expect(dreamModel(dream.status(), false).fields.dreamState.tone).toBe("warn");
});

test("settings: on/off and hour validated and kept; history capped", async () => {
  const { dream, file } = harness(["Ready"]);
  dream.configure({ enabled: false, hour: 2 });
  expect(loadDream(file)).toMatchObject({ enabled: false, hour: 2 });
  expect(dreamModel(dream.status(), false).fields).toMatchObject({ dreamNext: "Off", dreamState: { tone: "warn" } });
  expect(() => dream.configure({ hour: 24 })).toThrow("0 to 23");
  expect(() => dream.configure({ enabled: "yes" })).toThrow("true or false");
  for (let i = 0; i < HISTORY + 3; i++) await dream.run();
  expect(loadDream(file).history).toHaveLength(HISTORY);
});

test("summaries from the step output", () => {
  expect(summarize("related", '{"notes":10,"embedded":2,"withRelated":7,"links":15,"notesChanged":3}')).toBe("7 of 10 notes have related notes (15 links); 3 changed");
  expect(summarize("entities", 'log line\n{"entities":{"person":1,"company":2,"project":3,"topic":4},"notesLinked":5,"pagesChanged":6}')).toBe("4 topics, 1 people, 2 companies, 3 projects; 5 notes and 6 pages changed");
  expect(summarize("orphans", "")).toBeUndefined();
});
