import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptAuth, loadStored } from "../src/chatgpt-auth.ts";
import { aggregateSse, buildAuthorizeUrl, CHATGPT_OAUTH, pkceChallenge, startCallbackListener } from "../src/core/chatgpt.ts";
import { chatgptExtractor } from "../src/core/providers.ts";
import { freePort, item, knowledge } from "./fixtures.ts";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const access = (n: number) => jwt({ exp: 9_999_999_999, n, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" }, "https://api.openai.com/profile": { email: "aisyah@example.org" } });
const tokenResponse = (n: number) => Response.json({ access_token: access(n), refresh_token: `refresh-${n}`, id_token: jwt({ email: "aisyah@example.org" }), expires_in: 3600 });
const tempFile = () => join(mkdtempSync(join(tmpdir(), "chatgpt-")), "chatgpt-auth.json");

test("authorize URL carries PKCE S256, state and the Codex CLI client", () => {
  const url = new URL(buildAuthorizeUrl(pkceChallenge("verifier"), "state-1"));
  expect(url.origin + url.pathname).toBe(CHATGPT_OAUTH.authorizeUrl);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: "code", client_id: CHATGPT_OAUTH.clientId, redirect_uri: CHATGPT_OAUTH.redirectUri,
    code_challenge_method: "S256", code_challenge: pkceChallenge("verifier"), state: "state-1", codex_cli_simplified_flow: "true" });
});

test("sign-in end to end: browser callback -> code exchange -> tokens saved encrypted -> success page", async () => {
  const file = tempFile(), port = freePort();
  let opened = "", exchanged: URLSearchParams | null = null;
  const auth = createChatGptAuth({ file, open: url => { opened = url; }, listen: state => startCallbackListener(state, port),
    fetchImpl: (async (_url: string, init: RequestInit) => { exchanged = new URLSearchParams(String(init.body)); return tokenResponse(1); }) as typeof fetch });
  const { url } = auth.startLogin();
  expect(opened).toBe(url);
  expect(auth.status()).toMatchObject({ signedIn: false, signingIn: true });
  const state = new URL(url).searchParams.get("state")!;
  // A forged callback must not cancel the real sign-in.
  expect((await fetch(`http://127.0.0.1:${port}/auth/callback?code=evil&state=wrong`)).status).toBe(400);
  const page = await fetch(`http://localhost:${port}/auth/callback?code=real-code&state=${state}`);
  expect(page.status).toBe(200); expect(await page.text()).toContain("Signed in");
  expect(exchanged!.get("code")).toBe("real-code"); expect(exchanged!.get("grant_type")).toBe("authorization_code");
  expect(pkceChallenge(exchanged!.get("code_verifier")!)).toBe(new URL(url).searchParams.get("code_challenge")!);
  await Bun.sleep(10);
  expect(auth.status()).toMatchObject({ signedIn: true, signingIn: false, email: "aisyah@example.org", lastLogin: { ok: true } });
  expect(readFileSync(file, "utf8")).not.toContain("refresh-1"); // encrypted at rest
  expect(createChatGptAuth({ file }).status().signedIn).toBe(true); // survives a portal restart
});

test("refresh: rotates and saves the new refresh token; adopts tokens another process already refreshed; marks a rejected sign-in expired", async () => {
  const file = tempFile();
  let calls = 0, now = 0;
  const fetchImpl = (async (_u: string, init: RequestInit) => { calls++; const r = new URLSearchParams(String(init.body)).get("refresh_token");
    return r === "refresh-1" ? tokenResponse(2) : new Response("{}", { status: 400 }); }) as typeof fetch;
  const auth = createChatGptAuth({ file, fetchImpl, now: () => now });
  const { saveStored } = await import("../src/chatgpt-auth.ts");
  saveStored({ tokens: { accessToken: access(1), refreshToken: "refresh-1", idToken: null, accountId: "acct-1", email: null, expiresAt: 60_000 } }, file);
  const [a, b] = await Promise.all([auth.backendAuth(), auth.backendAuth()]); // expiring soon: refresh once, shared
  expect(calls).toBe(1); expect(a.accessToken).toBe(access(2)); expect(b.accessToken).toBe(access(2));
  expect(loadStored(file)!.tokens.refreshToken).toBe("refresh-2");
  now = 9_999_999_999_000; // force another refresh: refresh-2 is rejected by the server
  await expect(auth.backendAuth()).rejects.toMatchObject({ kind: "auth" });
  expect(auth.status()).toMatchObject({ signedIn: false, expired: true });
});

test("stream aggregation returns the final text and usage; usage-limit events are classified", async () => {
  async function* events(list: object[]) { yield* list as Record<string, any>[]; }
  const result = await aggregateSse(events([{ type: "response.output_text.delta", delta: '{"a":' }, { type: "response.output_text.delta", delta: "1}" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 2 } } }]));
  expect(result).toEqual({ text: '{"a":1}', usage: { inputTokens: 5, outputTokens: 2 } });
  await expect(aggregateSse(events([{ type: "error", code: "usage_limit_reached" }]))).rejects.toMatchObject({ kind: "usage" });
});

test("extractor retries once after a 401 with refreshed tokens", async () => {
  const sse = (text: string) => new Response(`data: ${JSON.stringify({ type: "response.output_text.done", text })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  let tries = 0, refreshed = 0;
  const auth = { backendAuth: async () => ({ accessToken: "old", accountId: "a" }), refreshAfter401: async () => { refreshed++; return { accessToken: "new", accountId: "a" }; } };
  const fetchImpl = (async (_u: string, init: RequestInit) => { tries++; return (init.headers as Record<string, string>).authorization === "Bearer old" ? new Response("{}", { status: 401 }) : sse(JSON.stringify(knowledge())); }) as typeof fetch;
  const extract = chatgptExtractor({ auth: auth as never, model: "gpt-5.5", fetchImpl });
  const { knowledge: k } = await extract({ id: "t", items: [item()] } as never);
  expect(k.title).toBe(knowledge().title); expect(tries).toBe(2); expect(refreshed).toBe(1);
});

test("a one-off ChatGPT backend error is retried once; a usage limit is not", async () => {
  const sse = (text: string) => new Response(`data: ${JSON.stringify({ type: "response.output_text.done", text })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  const auth = { backendAuth: async () => ({ accessToken: "t", accountId: "a" }), refreshAfter401: async () => ({ accessToken: "t", accountId: "a" }) };
  let calls = 0;
  const flaky = (async () => ++calls === 1 ? new Response("{}", { status: 502 }) : sse(JSON.stringify(knowledge()))) as unknown as typeof fetch;
  await chatgptExtractor({ auth: auth as never, model: "m", fetchImpl: flaky, retryDelayMs: 0 })({ id: "t", items: [item()] } as never);
  expect(calls).toBe(2);
  let limited = 0;
  const limit = (async () => { limited++; return new Response('{"error":{"code":"usage_limit_reached"}}', { status: 429 }); }) as unknown as typeof fetch;
  await expect(chatgptExtractor({ auth: auth as never, model: "m", fetchImpl: limit, retryDelayMs: 0 })({ id: "t", items: [item()] } as never)).rejects.toMatchObject({ code: "USAGE_LIMIT" });
  expect(limited).toBe(1);
});
