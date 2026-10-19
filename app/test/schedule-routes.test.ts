import { expect, test } from "bun:test";
import { createPortal, type PortalDeps } from "../src/portal.ts";
import type { Config, State } from "../src/state.ts";
import { freePort } from "./fixtures.ts";

const cfg = { brainPath: "p", clientId: "c", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 30 } as Config;
const state: State = { cursors: {}, threads: {}, queue: [], muted: [], lastRun: null, feedPulledAt: { chatgpt: "2026-10-19T08:00:00.000Z" } };

function fixture() {
  const port = freePort(), base = `http://127.0.0.1:${port}`;
  const saved: Record<string, number> = { meetings: 60 }, sets: [string, number][] = [];
  const services: PortalDeps = { config: () => cfg, state: () => state, connected: () => true, running: () => null,
    schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }), configure: () => {}, action: async () => {}, exchange: async () => {},
    claude: { list: () => [{ id: "personal", label: "", feed: "ai:claude" }, { id: "work", label: "", feed: "ai:claude:work" }] as any, status: () => ({}) as any } as any,
    feedSchedule: { read: () => saved, set: (k, m) => { sets.push([k, m]); saved[k] = m; } } };
  const server = createPortal(port, services);
  let token = "";
  return { server, base, sets,
    init: async () => { token = (await (await fetch(base)).text()).match(/name="portal-token" content="([^"]+)"/)![1]; },
    post: (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify(body) }) };
}

test("status sends every connector's interval (saved or default) and when each was last pulled", async () => {
  const f = fixture();
  try {
    const s = await (await fetch(f.base + "/api/status")).json();
    expect(s.feedSchedule).toEqual({
      intervals: { outlook: 15, "teams-chats": 15, "teams-channels": 15, meetings: 60, chatgpt: 120, gmail: 15, "claude:personal": 60, "claude:work": 60 },
      lastPulledAt: { chatgpt: "2026-10-19T08:00:00.000Z" } });
  } finally { f.server.stop(true); }
});

test("Save sync interval: a known connector and a listed interval only", async () => {
  const f = fixture();
  try {
    await f.init();
    for (const body of [{ connector: "dropbox", minutes: 60 }, { connector: "claude:other", minutes: 60 }, { connector: "__proto__", minutes: 60 }, { minutes: 60 }, { connector: 5, minutes: 60 }])
      expect([body, (await f.post("/api/connectors/schedule", body)).status]).toEqual([body, 400]);
    for (const minutes of [0, 45, "60", 60.5, null, 2880])
      expect([minutes, (await f.post("/api/connectors/schedule", { connector: "chatgpt", minutes })).status]).toEqual([minutes, 400]);
    expect(f.sets).toEqual([]);
    const ok = await f.post("/api/connectors/schedule", { connector: "chatgpt", minutes: 1440 });
    expect(ok.status).toBe(200); expect((await ok.json()).message).toContain("next run");
    expect((await f.post("/api/connectors/schedule", { connector: "claude:work", minutes: 30 })).status).toBe(200);
    expect(f.sets).toEqual([["chatgpt", 1440], ["claude:work", 30]]);
    expect((await (await fetch(f.base + "/api/status")).json()).feedSchedule.intervals).toMatchObject({ chatgpt: 1440, "claude:work": 30 });
  } finally { f.server.stop(true); }
});
