import { expect, test } from "bun:test";
import { createPortal, publicStatus, type PortalDeps } from "../src/portal.ts";
import type { Config, State } from "../src/state.ts";
import { freePort, item } from "./fixtures.ts";
const cfg: Config = { brainPath: "private-path", clientId: "private-client", tenantId: "tenant", model: "", maxThreadsPerRun: 25, initialSinceDays: 30 };
const state: State = { cursors: { "private-folder": "private-cursor" }, threads: {}, queue: [item({ text: "PRIVATE MAIL BODY", subject: "PRIVATE SUBJECT" })], muted: ["private-sender"], processed: { "private-id": { fingerprint: "private-hash", outcome: "skip", at: "date" } }, lookbackDays: 10, scannedFolders: { "private-folder": "date" }, lastRun: null };
const ready = { state: "Ready", nextRun: null, lastRun: null, result: 0 };
test("portal exposes counts, not message contents or identifiers; changed range resets displayed coverage", () => {
  const status = publicStatus(cfg, state, true, null, ready);
  expect(status.counts.processed).toBe(1); expect(status.counts.queued).toBe(1);
  expect(status.counts.scannedFolders).toBe(0); expect(status.settings.appliedDays).toBe(10);
  for (const hidden of ["PRIVATE", "private-", "fingerprint", "muted"]) expect(JSON.stringify(status)).not.toContain(hidden);
});
function fixture(port: number) {
  let task = { ...ready }, running = false, configured: Record<string, string> | null = null;
  const actions: string[] = [], exchanges: string[] = [];
  const services: PortalDeps = { config: () => cfg, state: () => state, connected: () => true,
    running: () => running ? { since: "date" } : null, schedule: async () => task,
    configure: updates => { configured = updates; }, action: async action => { actions.push(action); },
    exchange: async (_cfg, _verifier, _redirect, code) => { exchanges.push(code); } };
  const server = createPortal(port, services), base = `http://127.0.0.1:${port}`;
  let token = "";
  return { server, base, actions, exchanges, setTask: (s: string) => { task.state = s; }, setRunning: () => { running = true; }, configured: () => configured,
    init: async () => { const page = await (await fetch(base)).text(); token = page.match(/name="portal-token" content="([^"]+)"/)![1]; },
    post: (path: string, body: unknown = {}, override: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-portal-token": token, ...override }, body: JSON.stringify(body) }) };
}
test("portal rejects cross-site controls and invalid settings; valid changes use shared config", async () => {
  const f = fixture(freePort());
  try {
    await f.init();
    expect((await f.post("/api/settings", { lookbackDays: 30, threadsPerRun: 25 }, { origin: "https://attacker.test" })).status).toBe(403);
    expect((await f.post("/api/sync", {}, { "x-portal-token": "wrong" })).status).toBe(403);
    expect((await fetch(f.base, { headers: { host: `attacker.test:${new URL(f.base).port}` } })).status).toBe(403);
    for (const n of [0, -1, 1.5, "30"]) expect((await f.post("/api/settings", { lookbackDays: n, threadsPerRun: 25 })).status).toBe(400);
    expect(f.configured()).toBeNull();
    expect((await f.post("/api/settings", { lookbackDays: 30, threadsPerRun: 15 })).status).toBe(200);
    expect(f.configured()).toEqual({ MAILSYNC_SINCE_DAYS: "30", MAILSYNC_MAX_THREADS: "15" });
  } finally { f.server.stop(true); }
});
test("sync uses one scheduled runner, rejects a paused task, and avoids overlapping runs", async () => {
  const f = fixture(freePort());
  try {
    await f.init(); f.setTask("Disabled");
    expect((await f.post("/api/sync")).status).toBe(409); expect(f.actions).toEqual([]);
    f.setTask("Ready"); expect((await f.post("/api/sync")).status).toBe(200); expect(f.actions).toEqual(["sync"]);
    f.setRunning(); await f.post("/api/sync"); expect(f.actions).toEqual(["sync"]);
    expect((await f.post("/api/connect")).status).toBe(409);
    await f.post("/api/pause"); expect(f.actions).toEqual(["sync", "pause"]);
  } finally { f.server.stop(true); }
});
test("persistent portal verifies OAuth state, clears callback codes, and stays available after login", async () => {
  const f = fixture(freePort());
  try {
    await f.init(); const start = await (await f.post("/api/connect")).json(); const auth = new URL(start.url);
    expect(auth.searchParams.get("redirect_uri")).toBe(`http://localhost:${new URL(f.base).port}/`);
    expect((await fetch(f.base + "/?code=fixture&state=wrong")).status).toBe(400);
    const callback = await fetch(f.base + "/?code=fixture&state=" + auth.searchParams.get("state"), { redirect: "manual" });
    expect(callback.status).toBe(302); expect(callback.headers.get("location")).toBe("/"); expect(f.exchanges).toEqual(["fixture"]);
    expect((await fetch(f.base + "/api/status")).status).toBe(200);
    expect((await fetch(f.base + "/?code=fixture&state=" + auth.searchParams.get("state"))).status).toBe(400);
  } finally { f.server.stop(true); }
});
test("updates routes (laptop): Check now forces a check; Update now starts the update or gives the reason", async () => {
  const port = freePort(), base = `http://127.0.0.1:${port}`, calls: string[] = [];
  let refuse: string | null = null, dreaming = false;
  const { UpdateRefused } = await import("../src/updates.ts");
  const services = { config: () => cfg, state: () => state, connected: () => true, running: () => null, schedule: async () => ready,
    configure: () => {}, action: async () => {}, exchange: async () => {},
    dream: { status: () => ({ running: dreaming }), run: async () => {}, configure: () => {} },
    updates: {
      status: () => ({ current: { version: "0.1.0", commit: "f2eaa83" }, latest: { version: "0.2.0" }, available: true, error: null }),
      check: async (force?: boolean) => { calls.push(`check ${force}`); },
      apply: async () => { calls.push("apply"); if (refuse) throw new UpdateRefused(refuse); return { done: Promise.resolve({}), version: "0.2.0" }; },
    } } as unknown as PortalDeps;
  const server = createPortal(port, services);
  try {
    const token = (await (await fetch(base)).text()).match(/name="portal-token" content="([^"]+)"/)![1];
    const post = (path: string) => fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-portal-token": token }, body: "{}" });
    expect((await (await fetch(base + "/api/status")).json()).updates).toMatchObject({ current: { version: "0.1.0" }, available: true });
    const checked = await post("/api/update/check");
    expect(checked.status).toBe(200); expect((await checked.json()).message).toBe("Third Brain 0.2.0 is available.");
    const started = await post("/api/update/apply");
    expect(started.status).toBe(200); expect((await started.json()).message).toContain("Updating to 0.2.0");
    refuse = "Local changes: commit or stash them first.";
    const refused = await post("/api/update/apply");
    expect(refused.status).toBe(409); expect((await refused.json()).error).toBe(refuse);
    dreaming = true;
    expect((await post("/api/update/apply")).status).toBe(409);
    expect(calls).toEqual(["check true", "apply", "apply"]); // no apply while Dream runs
    expect((await post("/api/update/other")).status).toBe(404);
  } finally { server.stop(true); }
});
