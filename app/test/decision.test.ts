import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testTypesafe, typesafeAsk, TYPESAFE_URL } from "../src/core/decision.ts";
import { loadKeys, saveKey } from "../src/keys.ts";
import { viewModel } from "../portal/view.js";

const ok = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("typesafe: request shape (endpoint, bearer key, state, model, questions) and parsed answers", async () => {
  let seen: { url: string; init: any } | null = null;
  const fake = (async (url: string, init: any) => { seen = { url, init };
    return ok({ model: "jev-1.13.0", answers: { keep: { type: "noul", noul: 0.12 } }, usage: { input_tokens: 40, output_tokens: 2 } }); }) as any;
  const r = await typesafeAsk("k-123", "a receipt", { keep: { type: "noul", instructions: "worth keeping" } }, "", fake);
  expect(seen!.url).toBe(TYPESAFE_URL);
  expect(seen!.init.headers.authorization).toBe("Bearer k-123");
  expect(JSON.parse(seen!.init.body)).toEqual({ state: "a receipt", model: "jev-latest", questions: { keep: { type: "noul", instructions: "worth keeping" } } });
  expect(r).toMatchObject({ model: "jev-1.13.0", answers: { keep: { noul: 0.12 } }, usage: { input_tokens: 40 } });
});

test("typesafe: clear errors for a bad key, rate limit, server error, network failure, odd response", async () => {
  const status = (s: number, text = "") => (async () => new Response(text, { status: s })) as any;
  await expect(typesafeAsk("k", "s", {}, "", status(401))).rejects.toThrow("rejected the API key");
  await expect(typesafeAsk("k", "s", {}, "", status(429))).rejects.toThrow("rate limit");
  await expect(typesafeAsk("k", "s", {}, "", status(500, "boom"))).rejects.toThrow("HTTP 500): boom");
  await expect(typesafeAsk("k", "s", {}, "", (async () => { throw new TypeError("fetch failed"); }) as any)).rejects.toThrow("did not answer");
  await expect(typesafeAsk("k", "s", {}, "", (async () => ok({ nope: 1 })) as any)).rejects.toThrow("unexpected response");
});

test("typesafe test: a fixed receipt question, no vault data; verdict explained", async () => {
  let state = "";
  const fake = (async (_u: string, init: any) => { state = JSON.parse(init.body).state;
    return ok({ model: "jev-1.13.0", answers: { worth_keeping: { type: "noul", noul: 0.03 } }, usage: { input_tokens: 31, output_tokens: 1 } }); }) as any;
  const { message } = await testTypesafe("k", "", fake);
  expect(state).toContain("automated receipt");
  expect(message).toContain("Connected to jev-1.13.0");
  expect(message).toContain("P(worth keeping) = 0.03 (correct");
});

test("keys: a TypeSafe key is stored beside the other keys; malformed keys are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "keys-")), file = join(dir, "api-keys.json");
  try {
    saveKey("typesafe", "  ts_live_abcdefghijklmnop1234  ", file);
    expect(loadKeys(file).typesafe).toBe("ts_live_abcdefghijklmnop1234");
    expect(() => saveKey("typesafe", "has spaces inside it now", file)).toThrow("TypeSafe API key");
    saveKey("typesafe", null, file);
    expect(loadKeys(file).typesafe).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("settings view: decision model steps reflect provider, key and last test", () => {
  const base: any = { connected: true, needsLogin: false, configured: true, busy: false, schedule: { enabled: true, state: "Ready", nextRun: null },
    settings: { lookbackDays: 10, threadsPerRun: 25, provider: "codex", extractor: "Codex", model: "CLI default" },
    counts: { processed: 0, notes: 0, queued: 0, scannedFolders: 0, totalFolders: 0 }, lastRun: null, runs: { total: 0, succeeded: 0, failed: 0, skipped: 0, entries: [] } };
  const ai = (decision: object, typesafe: string | null) => ({ provider: "codex", models: { codex: "", openai: "", anthropic: "" }, defaults: {}, keys: { openai: null, anthropic: null, typesafe },
    chatgpt: { signedIn: true }, decision: { provider: "off", model: "", defaultModel: "jev-latest", lastTest: null, ...decision } });
  const off = viewModel({ ...base, ai: ai({}, null) });
  expect(off.fields.decisionState.text).toBe("Off");
  expect(off.controls.decisionTest.disabled).toBe(true);
  expect(off.forms.decision).toEqual({ decisionProvider: "off", decision_model: "" });
  expect(viewModel({ ...base, ai: ai({ provider: "typesafe" }, null) }).fields.decisionState.text).toBe("Needs a key");
  const tested = viewModel({ ...base, ai: ai({ provider: "typesafe", lastTest: { ok: true, at: new Date().toISOString(), message: "Connected to jev-1.13.0 in 120 ms." } }, "…abcd") });
  expect(tested.fields.decisionState).toEqual({ text: "Connected", tone: "ok" });
  expect(tested.fields.decisionKey.text).toBe("Key saved, ending abcd");
  expect(tested.controls.decisionTest.disabled).toBe(false);
});

test("triage thresholds: skip only sure cases; missing answers never skip", async () => {
  const { triageDecision } = await import("../src/core/decision.ts");
  expect(triageDecision({ pKeep: 0.05, pPersonal: 0.1 })).toEqual({ skip: true, reason: "not-worth-keeping" });
  expect(triageDecision({ pKeep: 0.9, pPersonal: 0.9 })).toEqual({ skip: true, reason: "personal" });
  expect(triageDecision({ pKeep: 0.4, pPersonal: 0.1 }).skip).toBe(false);   // the setup test's receipt (0.40) is NOT skipped
  expect(triageDecision({ pKeep: 0.15, pPersonal: 0.84 }).skip).toBe(false); // exactly at the thresholds: keep
  expect(triageDecision({ pKeep: NaN, pPersonal: NaN })).toEqual({ skip: false, reason: "no-answer" });
});

test("decision test result survives a portal restart; a new key needs a new test", async () => {
  const { createAiService } = await import("../src/ai-settings.ts");
  const { saveKey } = await import("../src/keys.ts");
  const answer = { answers: { keep: { probabilities: { yes: 0.9, no: 0.1 } }, personal: { probabilities: { yes: 0.1, no: 0.9 } } } };
  const fake = (async () => new Response(JSON.stringify(answer))) as any;
  const signedOut: any = { status: () => ({ signedIn: false, signingIn: false, expired: false }), signedIn: () => false };
  saveKey("typesafe", "ts-key-aaaa1111-test");
  await createAiService(signedOut, fake).testDecision().catch(() => {});
  const after = (await createAiService(signedOut, fake).status()).decision.lastTest; // a new service = portal restart
  expect(after?.at).toBeTruthy();
  saveKey("typesafe", "ts-key-bbbb2222-test");
  expect((await createAiService(signedOut, fake).status()).decision.lastTest).toBeNull();
  saveKey("typesafe", null);
});
