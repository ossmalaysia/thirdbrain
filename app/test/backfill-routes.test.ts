import { expect, test } from "bun:test";
import { createPortal, type PortalDeps } from "../src/portal.ts";
import { WindowBusyError } from "../src/backfill.ts";
import type { Config, State } from "../src/state.ts";
import { freePort } from "./fixtures.ts";

const cfg = { brainPath: "p", clientId: "c", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 30, aiSinceDays: 730 } as Config;
const state: State = { cursors: {}, threads: {}, queue: [], muted: [], lastRun: null };

function fixture() {
  const port = freePort(), base = `http://127.0.0.1:${port}`;
  const sets: [string, number][] = [], connects: (string | undefined)[] = [], estimates: string[] = [], prices: unknown[] = [], ranges: string[] = [];
  let busy = false;
  const accounts = [{ id: "personal", label: "", feed: "ai:claude" }, { id: "company", label: "", feed: "ai:claude:company" }];
  const services: PortalDeps = { config: () => cfg, state: () => state, connected: () => true, running: () => null,
    schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }), configure: () => {}, action: async () => {}, exchange: async () => {},
    claude: { list: () => accounts as any, status: () => ({}) as any, connect: async (id?: string) => { connects.push(id); },
      add: async () => { accounts.push({ id: "account-3", label: "", feed: "ai:claude:account-3" }); return { id: "account-3", label: "" }; },
      disconnect: () => {}, start: () => {}, stop: () => {} } as any,
    backfill: { windows: () => ({ "ai:chatgpt": { days: 182, chosenAt: "" } }), estimate: async feed => { estimates.push(feed); return { feed }; },
      set: (feed, days) => { if (busy) throw new WindowBusyError("Wait for the current sync to finish"); sets.push([feed, days]); return { widened: true, cursorReset: true, previous: 30 }; } },
    usage: { report: range => { ranges.push(range); return { range }; }, savePrices: p => { if (!(p as any)?.codex) throw new Error("Enter prices"); prices.push(p); } } };
  const server = createPortal(port, services);
  let token = "";
  return { server, base, sets, connects, estimates, prices, ranges, setBusy: () => { busy = true; },
    init: async () => { token = (await (await fetch(base)).text()).match(/name="portal-token" content="([^"]+)"/)![1]; },
    post: (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify(body) }) };
}

test("status lists each chat feed's window (chosen or the env default)", async () => {
  const f = fixture();
  try {
    const s = await (await fetch(f.base + "/api/status")).json();
    expect(s.backfill).toEqual({ "ai:claude": { days: 730, chosen: false }, "ai:claude:company": { days: 730, chosen: false }, "ai:chatgpt": { days: 182, chosen: true } });
  } finally { f.server.stop(true); }
});

test("estimate and window routes accept only known chat feeds and listed windows", async () => {
  const f = fixture();
  try {
    await f.init();
    for (const feed of ["inbox", "ai:claude:other", "", "teams:chats"]) expect((await fetch(`${f.base}/api/backfill/estimate?feed=${encodeURIComponent(feed)}`)).status).toBe(400);
    for (const feed of ["ai:chatgpt", "ai:claude:company", "ai:claude:new"]) expect((await fetch(`${f.base}/api/backfill/estimate?feed=${feed}`)).status).toBe(200);
    expect(f.estimates).toEqual(["ai:chatgpt", "ai:claude:company", "ai:claude:new"]);
    for (const body of [{ feed: "ai:chatgpt", days: 90 }, { feed: "ai:chatgpt", days: "730" }, { feed: "inbox", days: 30 }, { feed: "ai:claude:new", days: 30 }, {}])
      expect((await f.post("/api/backfill/window", body)).status).toBe(400);
    expect(f.sets).toEqual([]);
    const ok = await f.post("/api/backfill/window", { feed: "ai:claude:company", days: 730 });
    expect(ok.status).toBe(200); expect((await ok.json()).message).toContain("skipped");
    f.setBusy();
    expect((await f.post("/api/backfill/window", { feed: "ai:chatgpt", days: 730 })).status).toBe(409);
    expect(f.sets).toEqual([["ai:claude:company", 730]]);
  } finally { f.server.stop(true); }
});

test("Claude add/connect take an optional window: validated first, stored for the account's feed", async () => {
  const f = fixture();
  try {
    await f.init();
    expect((await f.post("/api/claude/accounts", { days: 45 })).status).toBe(400);
    expect((await f.post("/api/claude/connect", { days: "x" })).status).toBe(400);
    expect(f.connects).toEqual([]);
    expect((await f.post("/api/claude/accounts", { days: 365 })).status).toBe(200);
    expect((await f.post("/api/claude/connect", { days: 30 })).status).toBe(200);
    expect((await f.post("/api/claude/connect", { account: "company" })).status).toBe(200); // reconnect: window untouched
    expect(f.sets).toEqual([["ai:claude:account-3", 365], ["ai:claude", 30]]);
    expect(f.connects).toEqual([undefined, "company"]);
  } finally { f.server.stop(true); }
});

test("usage route validates the range; prices are validated by the service", async () => {
  const f = fixture();
  try {
    await f.init();
    expect((await fetch(f.base + "/api/usage?range=1y")).status).toBe(400);
    expect((await fetch(f.base + "/api/usage?range=__proto__")).status).toBe(400);
    expect(await (await fetch(f.base + "/api/usage?range=7d")).json()).toEqual({ range: "7d" });
    await fetch(f.base + "/api/usage?range=7d"); // cached
    expect(await (await fetch(f.base + "/api/usage")).json()).toEqual({ range: "30d" });
    expect(f.ranges).toEqual(["7d", "30d"]);
    expect((await f.post("/api/usage/prices", { nope: 1 })).status).toBe(400);
    expect((await f.post("/api/usage/prices", { codex: { in: 1, out: 2 } })).status).toBe(200);
  } finally { f.server.stop(true); }
});
