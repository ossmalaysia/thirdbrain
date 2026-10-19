import { expect, test } from "bun:test";
import { createRepoStatusCache } from "../src/backup.ts";
import { limitRuns, STATUS_RUNS } from "../src/portal.ts";

test("repo status cache: answers at once, refreshes in the background, at most once per window", async () => {
  let calls = 0, t = 1_000_000;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const load = async () => { calls++; await gate; return { remotes: 1, uncommitted: 3, unpushed: 0, lastCommitAt: "2026-10-18T00:00:00Z" }; };
  const cache = createRepoStatusCache(() => "D:/vault", 60_000, load, () => t);
  expect(cache.get()).toEqual({ remotes: 0, uncommitted: null, unpushed: null, lastCommitAt: null }); // no wait for git
  expect(cache.get().uncommitted).toBeNull();
  expect(calls).toBe(1);                                   // one refresh in flight, not one per call
  release(); await cache.ready();
  expect(cache.get().uncommitted).toBe(3);
  t += 30_000; cache.get(); expect(calls).toBe(1);        // still fresh
  t += 31_000; cache.get(); await cache.ready(); expect(calls).toBe(2);
  cache.invalidate(); cache.get(); await cache.ready(); expect(calls).toBe(3);
});

test("repo status cache: git runs again after a vault event, not on every poll", async () => {
  let calls = 0, t = 1_000_000;
  const cache = createRepoStatusCache(() => "D:/vault", 30 * 60_000, async () => { calls++; return { remotes: 1, uncommitted: calls, unpushed: 0, lastCommitAt: null }; }, () => t);
  cache.get("run-1"); await cache.ready(); expect(calls).toBe(1);
  for (let i = 0; i < 100; i++) { t += 5_000; cache.get("run-1"); }   // 100 polls, 8 minutes, no new run
  await cache.ready(); expect(calls).toBe(1);
  cache.get("run-2"); await cache.ready(); expect(calls).toBe(2);       // a sync or backup run finished
  t += 31 * 60_000; cache.get("run-2"); await cache.ready(); expect(calls).toBe(3); // Obsidian edits: 30-minute fallback
});

test("status poll sends the newest runs only; totals stay complete", () => {
  const h = { total: 100, succeeded: 90, failed: 10, skipped: 0, entries: Array.from({ length: 100 }, (_, i) => ({ id: i })) };
  const r = limitRuns(h);
  expect(r.entries).toHaveLength(STATUS_RUNS);
  expect(r).toMatchObject({ total: 100, succeeded: 90, failed: 10 });
  expect(r.entries[0]).toEqual({ id: 0 });
});
