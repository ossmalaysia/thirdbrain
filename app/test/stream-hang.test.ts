import { expect, test } from "bun:test";
import { aggregateSse, parseSse, readWithin } from "../src/core/chatgpt.ts";

/** A stream that sends one frame (or nothing) and then stays open without data: the 2026-10-18 hang. */
const silent = (first?: string) => new ReadableStream<Uint8Array>({ start(c) { if (first) c.enqueue(new TextEncoder().encode(first)); } });

test("a silent answer stream ends with an error instead of waiting forever", async () => {
  const t = Date.now();
  await expect(aggregateSse(parseSse(silent('data: {"type":"response.created"}\n\n'), { idleMs: 50 }))).rejects.toThrow("stopped sending");
  expect(Date.now() - t).toBeLessThan(2000);
});

test("the request time limit also ends a waiting read", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await expect(aggregateSse(parseSse(silent(), { idleMs: 60_000, signal: ac.signal }))).rejects.toThrow("timed out");
});

test("readWithin passes data through", async () => {
  const r = await readWithin(new ReadableStream<string>({ start(c) { c.enqueue("x"); c.close(); } }).getReader(), 1000);
  expect(r).toEqual({ done: false, value: "x" });
});
