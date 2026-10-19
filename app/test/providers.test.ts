import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseExtractor, failure } from "../src/core/providers.ts";
import { keyHint, loadKeys, saveKey } from "../src/keys.ts";
import { createPortal, type PortalDeps } from "../src/portal.ts";
import type { AiService } from "../src/ai-settings.ts";
import { freePort, item } from "./fixtures.ts";

const cfg = { brainPath: "x", clientId: "", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 10 };

test("provider errors map to retryable codes without echoing provider text", () => {
  const cases: [unknown, string][] = [[{ status: 401, message: "PRIVATE" }, "AUTHENTICATION"], [{ status: 403 }, "AUTHENTICATION"],
    [{ status: 429 }, "USAGE_LIMIT"], [{ status: 404 }, "MODEL_NOT_FOUND"], [new Error("PRIVATE EMAIL TEXT"), "PROVIDER_ERROR"]];
  for (const [error, code] of cases) {
    const mapped = failure("anthropic", error);
    expect(mapped.code).toBe(code); expect(mapped.message).not.toContain("PRIVATE");
  }
  expect(failure("openai", { status: 401 }).message).toContain("OpenAI API");
});

test("a missing API key fails extraction with a clear message instead of calling the provider", async () => {
  const extract = chooseExtractor({ ...cfg, provider: "anthropic" }, tmpdir(), {});
  await expect(extract({ id: "conv-A", items: [item()] } as never)).rejects.toMatchObject({ code: "AUTHENTICATION", message: expect.stringContaining("Claude API key is missing") });
});

test("API keys are validated, stored outside the vault, and only exposed as a hint", () => {
  const file = join(mkdtempSync(join(tmpdir(), "keys-")), "api-keys.json");
  expect(() => saveKey("anthropic", "sk-proj-not-claude", file)).toThrow("sk-ant-");
  saveKey("anthropic", " sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234 ", file);
  expect(loadKeys(file).anthropic).toBe("sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234");
  expect(keyHint(loadKeys(file).anthropic)).toBe("…1234");
  saveKey("anthropic", null, file);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
});

test("settings endpoints validate input and never return a saved key", async () => {
  const calls: unknown[][] = [];
  const ai: AiService = {
    status: async () => ({ provider: "codex", models: { codex: "", openai: "", anthropic: "" }, defaults: { codex: "", openai: "gpt-5", anthropic: "claude-opus-5-5" },
      keys: { openai: null, anthropic: "…1234" }, chatgpt: { signedIn: true, expired: false, email: "aisyah@example.org", signingIn: false, loginUrl: null, lastLogin: null, cliSignedIn: null, models: [] } }),
    save: (...a) => { calls.push(["save", ...a]); }, setKey: (...a) => { calls.push(["key", ...a]); },
    test: async p => `ok ${p}`, chatgptLogin: () => { calls.push(["login"]); return { url: "u", started: true }; }, chatgptSignOut: () => { calls.push(["signout"]); },
  };
  const services = {
    config: () => cfg, state: () => ({ cursors: {}, threads: {}, queue: [], lookbackDays: 10, lastRun: null }),
    connected: () => true, running: () => null, schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }),
    configure: () => {}, action: async () => {}, exchange: async () => {}, ai,
  } as unknown as PortalDeps;
  const port = freePort(), server = createPortal(port, services), base = `http://127.0.0.1:${port}`;
  try {
    const token = (await (await fetch(base)).text()).match(/name="portal-token" content="([^"]+)"/)![1];
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-portal-token": token }, body: JSON.stringify(body) });
    const status = await (await fetch(base + "/api/status")).json();
    expect(status.ai.keys.anthropic).toBe("…1234"); expect(JSON.stringify(status)).not.toContain("sk-ant");
    expect((await post("/api/ai/settings", { provider: "gemini", model: "" })).status).toBe(400);
    expect((await post("/api/ai/key", { provider: "codex", key: "sk-x" })).status).toBe(400);
    expect((await post("/api/ai/settings", { provider: "anthropic", model: "claude-opus-5-5" })).status).toBe(200);
    expect((await post("/api/ai/key", { provider: "openai", key: null })).status).toBe(200);
    expect((await (await post("/api/ai/test", { provider: "anthropic" })).json()).message).toBe("ok anthropic");
    await post("/api/ai/chatgpt-login", {}); await post("/api/ai/chatgpt-signout", {});
    expect(calls).toEqual([["save", "anthropic", "claude-opus-5-5"], ["key", "openai", null], ["login"], ["signout"]]);
  } finally { server.stop(true); }
});
