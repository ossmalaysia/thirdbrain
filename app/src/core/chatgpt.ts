// ChatGPT sign-in and the ChatGPT Codex backend, without the Codex CLI.
//
// Adapted from EzyChat Lite (github.com/ossmalaysia/ezychat-lite, MIT, (c) 2026 OSS Malaysia and
// contributors): packages/server/src/ai/chatgpt-oauth.ts and chatgpt-backend.ts; protocol notes in its
// docs/ai-chatgpt-protocol.md. Like Codex CLI it uses OAuth authorization code + PKCE (S256) with the
// public Codex CLI client id and a one-shot loopback listener on 127.0.0.1:1455.
//
// EXPERIMENTAL: the client id is borrowed and chatgpt.com/backend-api is not a public API; it can change
// or be blocked without notice. Never log tokens, codes, state, verifiers, account ids or full URLs.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { arch, platform, release } from "node:os";
import { productName } from "../config.ts";

export const CHATGPT_OAUTH = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  callbackHost: "127.0.0.1", callbackPort: 1455, callbackPath: "/auth/callback",
  redirectUri: "http://localhost:1455/auth/callback",
  scope: "openid profile email offline_access",
  originator: "codex_cli_rs",
} as const;
export const CODEX_BACKEND = {
  responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
  modelsUrl: "https://chatgpt.com/backend-api/codex/models",
  /** Model entries carry minimal_client_version; claim a recent Codex release. */
  clientVersion: "0.160.0",
  fallbackModel: "gpt-5.5",
} as const;
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

// ── OAuth ────────────────────────────────────────────────────────────────────
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export function createPkce() { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: pkceChallenge(verifier) }; }
export const createState = () => randomBytes(16).toString("hex");
export function stateMatches(expected: string, received: string | null): boolean {
  if (!received) return false;
  const a = Buffer.from(expected), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const url = new URL(CHATGPT_OAUTH.authorizeUrl);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: CHATGPT_OAUTH.clientId, redirect_uri: CHATGPT_OAUTH.redirectUri,
    scope: CHATGPT_OAUTH.scope, code_challenge: challenge, code_challenge_method: "S256", state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: CHATGPT_OAUTH.originator })) url.searchParams.set(k, v);
  return url.toString();
}

export function decodeJwtPayload(token: string | null | undefined): Record<string, any> | null {
  const parts = token?.split(".");
  if (!parts || parts.length !== 3) return null;
  try { const v = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
  catch { return null; }
}
const str = (v: unknown) => typeof v === "string" && v.trim() ? v.trim() : null;
export const accountIdFromTokens = (access: string, id?: string | null) =>
  str(decodeJwtPayload(access)?.["https://api.openai.com/auth"]?.chatgpt_account_id) ?? str(decodeJwtPayload(id)?.["https://api.openai.com/auth"]?.chatgpt_account_id);
export const emailFromTokens = (access: string, id?: string | null) =>
  str(decodeJwtPayload(access)?.["https://api.openai.com/profile"]?.email) ?? str(decodeJwtPayload(id)?.email);

export interface ChatGptTokens { accessToken: string; refreshToken: string; idToken: string | null; accountId: string; email: string | null; expiresAt: number }

export class ChatGptError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly kind: "auth" | "usage" | "blocked" | "request" | "network" | "other" = "other") { super(message); }
}

type FetchFn = typeof fetch;
async function tokenRequest(body: URLSearchParams, fetchImpl: FetchFn, previous?: Pick<ChatGptTokens, "refreshToken" | "idToken">): Promise<ChatGptTokens> {
  let response: Response;
  try {
    response = await fetchImpl(CHATGPT_OAUTH.tokenUrl, { method: "POST", redirect: "error", body, signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" } });
  } catch { throw new ChatGptError("Cannot reach ChatGPT sign-in. Check the internet connection.", null, "network"); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ChatGptError("ChatGPT sign-in was rejected. Sign in again.", response.status, "auth"); }
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  const accessToken = str(json?.access_token), refreshToken = str(json?.refresh_token) ?? previous?.refreshToken ?? null;
  const idToken = str(json?.id_token) ?? previous?.idToken ?? null;
  if (!accessToken || !refreshToken) throw new ChatGptError("ChatGPT sign-in returned an incomplete response.");
  const accountId = accountIdFromTokens(accessToken, idToken);
  if (!accountId) throw new ChatGptError("This sign-in has no ChatGPT account. Use the account with your ChatGPT plan.");
  const exp = decodeJwtPayload(accessToken)?.exp;
  const expiresAt = typeof json?.expires_in === "number" ? Date.now() + json.expires_in * 1000 : typeof exp === "number" ? exp * 1000 : Date.now() + 3600_000;
  return { accessToken, refreshToken, idToken, accountId, email: emailFromTokens(accessToken, idToken), expiresAt };
}
export const exchangeCode = (code: string, verifier: string, fetchImpl: FetchFn = fetch) => tokenRequest(new URLSearchParams({
  grant_type: "authorization_code", client_id: CHATGPT_OAUTH.clientId, code, code_verifier: verifier, redirect_uri: CHATGPT_OAUTH.redirectUri }), fetchImpl);
export const refreshTokens = (current: Pick<ChatGptTokens, "refreshToken" | "idToken">, fetchImpl: FetchFn = fetch) => tokenRequest(new URLSearchParams({
  grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: CHATGPT_OAUTH.clientId }), fetchImpl, current);

// ── One-shot loopback listener for the OAuth redirect ───────────────────────
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#17252B}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
export type CallbackResult = { code: string } | { error: "denied" | "missing_code" | "closed" };
export interface CallbackListener { result: Promise<CallbackResult>; finish: (success: boolean, message?: string) => void; close: () => void }

/** Binds 127.0.0.1 only, accepts only GET /auth/callback with a loopback Host (DNS-rebinding defence), checks `state`. */
export function startCallbackListener(state: string, port: number = CHATGPT_OAUTH.callbackPort, product: string = productName()): CallbackListener {
  const portal = `the ${product.replace(/[&<>"']/g, "")} portal`; // plain text inside the page
  let settle!: (r: CallbackResult) => void, done = false, reply: ((r: Response) => void) | null = null;
  const result = new Promise<CallbackResult>(r => { settle = r; });
  const html = (status: number, title: string, body: string) => new Response(page(title, body), { status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "referrer-policy": "no-referrer" } });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: CHATGPT_OAUTH.callbackHost, port, fetch(req) {
      const url = new URL(req.url), host = (req.headers.get("host") ?? "").toLowerCase();
      if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) return new Response(null, { status: 421 });
      if (req.method !== "GET" || url.pathname !== CHATGPT_OAUTH.callbackPath || done) return new Response("Not found", { status: 404 });
      if (!stateMatches(state, url.searchParams.get("state"))) return html(400, "Sign-in link expired", `Start ChatGPT sign-in again from ${portal}.`);
      done = true;
      if (url.searchParams.get("error")) { settle({ error: "denied" }); return html(400, "Sign-in cancelled", `You can close this tab and try again from ${portal}.`); }
      const code = url.searchParams.get("code");
      if (!code) { settle({ error: "missing_code" }); return html(400, "Sign-in failed", `You can close this tab and try again from ${portal}.`); }
      settle({ code });
      return new Promise<Response>(r => { reply = r; setTimeout(() => r(html(200, "Signing in…", `Return to ${portal}.`)), 30_000); });
    } });
  } catch (e) {
    throw new ChatGptError((e as { code?: string })?.code === "EADDRINUSE"
      ? `Port ${port} is in use: another Codex or ChatGPT sign-in is open. Close it and try again.` : "Cannot start the local ChatGPT sign-in listener.");
  }
  return {
    result,
    finish: (success, message) => { reply?.(success ? html(200, "Signed in", `ChatGPT is connected. You can close this tab and return to ${portal}.`)
      : html(400, "Sign-in failed", message ?? `You can close this tab and try again from ${portal}.`)); reply = null; },
    close: () => { done = true; settle({ error: "closed" }); setTimeout(() => server.stop(true), 1000); },
  };
}

// ── Codex backend (Responses API over SSE) ──────────────────────────────────
export interface BackendAuth { accessToken: string; accountId: string }
export function backendHeaders(auth: BackendAuth, sessionId?: string): Record<string, string> {
  return { authorization: `Bearer ${auth.accessToken}`, "chatgpt-account-id": auth.accountId, originator: CHATGPT_OAUTH.originator,
    "user-agent": `${CHATGPT_OAUTH.originator}/${CODEX_BACKEND.clientVersion} (${platform()} ${release()}; ${arch()}) third-brain`,
    "OpenAI-Beta": "responses=experimental", accept: "text/event-stream", "content-type": "application/json", ...(sessionId ? { session_id: sessionId } : {}) };
}

const usageCode = (code: unknown) => typeof code === "string" && /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code);
const usage = () => new ChatGptError("ChatGPT usage limit reached; queued emails will retry when usage is available.", 429, "usage");

/** Default limit for a silent stream: no byte for this long ends the answer with an error. */
export const SSE_IDLE_MS = 90_000;

/** One `reader.read()` that also ends on `signal` or after `idleMs` without data. Bun's fetch signal does not reach a
 *  body read that is already waiting (seen 2026-10-18: a sync run hung 90 minutes on a silent chatgpt.com stream). */
export function readWithin<T>(reader: ReadableStreamDefaultReader<T>, idleMs: number, signal?: AbortSignal): Promise<ReadableStreamReadResult<T>> {
  return new Promise((resolve, reject) => {
    const stop = (e: Error) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(e); };
    const onAbort = () => stop(new ChatGptError("ChatGPT extraction timed out; queued emails will retry.", null, "network"));
    const timer = setTimeout(() => stop(new ChatGptError("ChatGPT stopped sending its answer; queued emails will retry.", null, "network")), idleMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.read().then(r => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(r); }, stop);
  });
}

/** Parses `data:` SSE frames (blank-line separated); skips `[DONE]` and malformed frames. */
export async function* parseSse(body: ReadableStream<Uint8Array>, opts: { signal?: AbortSignal; idleMs?: number } = {}): AsyncGenerator<Record<string, any>> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  function* frames(final: boolean) {
    buffer = buffer.replace(/\r\n/g, "\n");
    let i = buffer.indexOf("\n\n");
    while (i !== -1 || (final && buffer.trim())) {
      const chunk = i === -1 ? buffer : buffer.slice(0, i);
      buffer = i === -1 ? "" : buffer.slice(i + 2);
      const data = chunk.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n").trim();
      if (data && data !== "[DONE]") { try { const v = JSON.parse(data); if (v && typeof v === "object") yield v; } catch { /* malformed frame */ } }
      i = buffer.indexOf("\n\n");
    }
  }
  try {
    for (;;) { const { done, value } = await readWithin(reader, opts.idleMs ?? SSE_IDLE_MS, opts.signal); if (done) break; buffer += decoder.decode(value, { stream: true }); yield* frames(false); }
    buffer += decoder.decode(); yield* frames(true);
  } finally { void reader.cancel().catch(() => {}); } // not awaited: a stuck stream must not hold the run
}

/** Collects the final text and token usage of a streamed response. */
export async function aggregateSse(events: AsyncIterable<Record<string, any>>) {
  let deltas = "", done: string | null = null, seen = 0;
  for await (const e of events) {
    if (typeof e.type === "string") seen++;
    switch (e.type) {
      case "response.output_text.delta": if (typeof e.delta === "string") deltas += e.delta; break;
      case "response.output_text.done": if (typeof e.text === "string") done = (done ?? "") + e.text; break;
      case "error": throw usageCode(e.code) ? usage() : new ChatGptError("ChatGPT could not answer.");
      case "response.failed": throw usageCode(e.response?.error?.code) ? usage() : new ChatGptError("ChatGPT could not answer.");
      case "response.incomplete": throw new ChatGptError("ChatGPT did not complete its answer.");
      case "response.completed": case "response.done": {
        if (e.response?.status && e.response.status !== "completed") throw new ChatGptError("ChatGPT did not complete its answer.");
        const text = done ?? (deltas || (e.response?.output ?? []).filter((o: any) => o?.type === "message")
          .flatMap((o: any) => o.content ?? []).filter((p: any) => p?.type === "output_text").map((p: any) => p.text ?? "").join(""));
        return { text, usage: { inputTokens: Number(e.response?.usage?.input_tokens ?? 0), outputTokens: Number(e.response?.usage?.output_tokens ?? 0) } };
      }
    }
  }
  throw new ChatGptError(seen ? "ChatGPT ended its answer early." : "ChatGPT returned an empty answer.");
}

export interface ResponsesRequest { model: string; instructions: string; input: string; schema?: Record<string, unknown>; schemaName?: string }
export function responsesBody(r: ResponsesRequest, sessionId: string) {
  return { model: r.model, instructions: r.instructions, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: r.input }] }],
    store: false, stream: true, tools: [], tool_choice: "auto", parallel_tool_calls: false, reasoning: { effort: "low" }, include: [], prompt_cache_key: sessionId,
    text: r.schema ? { verbosity: "low", format: { type: "json_schema", name: r.schemaName ?? "result", strict: true, schema: r.schema } } : { verbosity: "low" } };
}

/** One request; every failure is a ChatGptError with a fixed message (upstream bodies are never surfaced). */
export async function streamResponse(auth: BackendAuth, request: ResponsesRequest, signal: AbortSignal, fetchImpl: FetchFn = fetch) {
  const sessionId = randomUUID();
  let response: Response;
  try {
    response = await fetchImpl(CODEX_BACKEND.responsesUrl, { method: "POST", redirect: "error", signal, headers: backendHeaders(auth, sessionId), body: JSON.stringify(responsesBody(request, sessionId)) });
  } catch (e) {
    if (signal.aborted) throw new ChatGptError("ChatGPT extraction timed out; queued emails will retry.", null, "network");
    throw new ChatGptError("Cannot reach ChatGPT. Check the internet connection.", null, "network");
  }
  if (!response.ok) {
    let code: unknown;
    try { const j = await response.json() as any; code = j?.error?.code ?? j?.error?.type; } catch { /* not JSON */ }
    const s = response.status;
    if (s === 429 || usageCode(code)) throw usage();
    throw s === 401 ? new ChatGptError("ChatGPT sign-in expired. Sign in again in portal Settings.", s, "auth")
      : s === 403 || s === 404 ? new ChatGptError("ChatGPT refused the connection; use the Codex CLI or an API key instead.", s, "blocked")
      : s === 400 ? new ChatGptError("ChatGPT rejected the request; choose another model or leave it on Auto.", s, "request")
      : new ChatGptError("ChatGPT could not answer; queued emails will retry.", s);
  }
  const type = response.headers.get("content-type");
  if (type && !type.toLowerCase().includes("text/event-stream")) { await response.body?.cancel().catch(() => {}); throw new ChatGptError("ChatGPT returned an unexpected response.", response.status, "blocked"); }
  if (!response.body) throw new ChatGptError("ChatGPT returned an empty answer.");
  return aggregateSse(parseSse(response.body, { signal }));
}

export interface BackendModel { id: string; label: string; priority: number }
/** The signed-in account's model catalogue (same shape as Codex's models_cache.json). */
export async function fetchModels(auth: BackendAuth, fetchImpl: FetchFn = fetch): Promise<BackendModel[]> {
  const url = new URL(CODEX_BACKEND.modelsUrl);
  url.searchParams.set("client_version", CODEX_BACKEND.clientVersion);
  const headers = backendHeaders(auth); headers.accept = "application/json"; delete headers["content-type"];
  let response: Response;
  try { response = await fetchImpl(url, { method: "GET", redirect: "error", headers, signal: AbortSignal.timeout(15_000) }); }
  catch { throw new ChatGptError("Cannot reach ChatGPT for the model list.", null, "network"); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ChatGptError(response.status === 401 ? "ChatGPT sign-in expired. Sign in again." : "ChatGPT did not return a model list.", response.status, response.status === 401 ? "auth" : "other"); }
  const json = await response.json().catch(() => null) as { models?: Array<Record<string, any>> } | null;
  const models = (Array.isArray(json?.models) ? json!.models : [])
    .filter(m => typeof m.slug === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(m.slug) && m.visibility === "list" && m.supported_in_api !== false)
    .map(m => ({ id: m.slug as string, label: typeof m.display_name === "string" && m.display_name.length <= 64 ? m.display_name : m.slug, priority: typeof m.priority === "number" ? m.priority : 1000 }))
    .sort((a, b) => a.priority - b.priority);
  if (!models.length) throw new ChatGptError("ChatGPT returned an empty model list.");
  return models;
}
