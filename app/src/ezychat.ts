// The EzyChat connection: EzyChat's own MCP sign-in (packages/server/src/mcp/oauth.ts, oauth-routes.ts in EzyChat):
// OAuth 2.1 with dynamic client registration (RFC 7591), PKCE S256 only, a loopback redirect to this portal, and
// `resource` = the MCP address (RFC 8707). The code becomes an ordinary EzyChat personal access token: no refresh
// token, no expiry; it is revoked in EzyChat Settings -> Integrations. Same shape as the Microsoft Connect in portal.ts
// (state check, one-time code, the code cleared from the address bar).
// Stored encrypted in the state folder (ezychat.json, secret-box.ts): never in config.json, never logged, never sent to
// the browser (the status has the address and the last check only).
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { STATE_DIR } from "./state.ts";
import { loadSecret, saveSecret } from "./secret-box.ts";
import { EzyChatError, ezychatApi, normalizeBase, statusError } from "./adapters/ezychat.ts";

export const EZYCHAT_FILE = join(STATE_DIR, "ezychat.json");
export const CLIENT_NAME = "Third Brain";
const FLOW_MS = 10 * 60_000, HTTP_MS = 20_000;
const MESSAGE_FAILED = "EzyChat could not be checked right now. Try again.";

export interface EzyChatCheck { ok: boolean; at: string; summary?: string; error?: string }
interface Stored { base: string; token: string; clientId: string; issuer: string; redirectUri: string; connectedAt: string; check?: EzyChatCheck }

export const loadEzyChat = (file = EZYCHAT_FILE): Stored | null => {
  const s = loadSecret<Stored>(file);
  return s && typeof s.base === "string" && typeof s.token === "string" && s.token ? s : null;
};

/** The callback did not belong to the sign-in this portal started (or came twice). */
export class EzyChatSignInMismatch extends Error {
  constructor() { super("EzyChat sign-in expired or did not match. Open the portal and connect again."); }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const endpoint = (raw: unknown): string => {
  try { const u = new URL(String(raw)); if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))) return u.toString(); } catch { /* below */ }
  throw new EzyChatError("signin");
};

interface Meta { issuer: string; resource: string; authorize: string; token: string; register: string }

/** Endpoints from EzyChat's own metadata (RFC 9728, then RFC 8414), not hard-coded paths. */
async function discover(base: string, http: typeof fetch): Promise<Meta> {
  const get = async (url: string) => {
    let r: Response;
    try { r = await http(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(HTTP_MS), redirect: "error" }); }
    catch { throw new EzyChatError("network", base); }
    if (!r.ok) throw statusError(r.status, base);
    try { return await r.json() as Record<string, unknown>; } catch { throw new EzyChatError("signin"); }
  };
  const u = new URL(base), prm = await get(`${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, "")}/mcp`);
  const issuer = Array.isArray(prm.authorization_servers) && typeof prm.authorization_servers[0] === "string" ? endpoint(prm.authorization_servers[0]).replace(/\/$/, "") : "";
  if (!issuer) throw new EzyChatError("signin");
  const as = await get(`${issuer}/.well-known/oauth-authorization-server`);
  const methods = as.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new EzyChatError("signin");
  return { issuer, resource: typeof prm.resource === "string" ? prm.resource : `${base}/mcp`,
    authorize: endpoint(as.authorization_endpoint), token: endpoint(as.token_endpoint), register: endpoint(as.registration_endpoint) };
}

const b64url = (b: Buffer) => b.toString("base64url");
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** get_stats -> "12 chats" or "12 chats in 2 inboxes (Sales, Support)". */
export function statsSummary(s: { chats?: { open?: number; resolved?: number }; byInbox?: { name?: string }[] }): string {
  const chats = plural((s.chats?.open ?? 0) + (s.chats?.resolved ?? 0), "chat"), inboxes = (s.byInbox ?? []).map(i => i.name).filter(Boolean);
  return inboxes.length > 1 ? `${chats} in ${inboxes.length} inboxes (${inboxes.join(", ")})` : chats;
}

export interface EzyChatStatus { connected: boolean; address: string | null; connectedAt: string | null; test: EzyChatCheck | null }

export function createEzyChatService(deps: { file?: string; fetch?: typeof fetch; now?: () => number } = {}) {
  const file = deps.file ?? EZYCHAT_FILE, http = deps.fetch ?? fetch, now = deps.now ?? Date.now;
  let pending: { base: string; meta: Meta; clientId: string; verifier: string; state: string; redirectUri: string; expires: number } | null = null;
  let exchanging = false;

  async function register(meta: Meta, base: string, redirectUri: string): Promise<string> {
    let r: Response;
    try {
      r = await http(meta.register, { method: "POST", signal: AbortSignal.timeout(HTTP_MS), redirect: "error", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }) });
    } catch { throw new EzyChatError("network", base); }
    if (!r.ok) throw r.status === 400 ? new EzyChatError("signin") : statusError(r.status, base);
    const body = await r.json().catch(() => ({})) as { client_id?: unknown };
    if (typeof body.client_id !== "string" || !body.client_id) throw new EzyChatError("signin");
    return body.client_id;
  }

  async function check(): Promise<{ summary: string }> {
    const s = loadEzyChat(file);
    if (!s) throw new Error("Connect EzyChat first.");
    const at = new Date(now()).toISOString();
    try {
      const summary = statsSummary(await ezychatApi(s, http).call("get_stats", { days: 1 }, HTTP_MS));
      saveSecret(file, { ...s, check: { ok: true, at, summary } } satisfies Stored);
      return { summary };
    } catch (e) {
      saveSecret(file, { ...s, check: { ok: false, at, error: e instanceof EzyChatError ? e.message : MESSAGE_FAILED } } satisfies Stored);
      throw e;
    }
  }

  return {
    status(): EzyChatStatus {
      const s = loadEzyChat(file);
      return { connected: !!s, address: s?.base ?? null, connectedAt: s?.connectedAt ?? null, test: s?.check ?? null };
    },
    /** Discovers the sign-in, registers once (the app kept from the last connection is reused: EzyChat then replaces its
     *  token instead of adding one), and returns EzyChat's approval page with PKCE and a fresh state. */
    async begin(address: unknown, redirectUri: string): Promise<{ url: string; base: string }> {
      const base = normalizeBase(address), meta = await discover(base, http), saved = loadEzyChat(file);
      const clientId = saved && saved.base === base && saved.issuer === meta.issuer && saved.redirectUri === redirectUri && saved.clientId
        ? saved.clientId : await register(meta, base, redirectUri);
      const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(24));
      pending = { base, meta, clientId, verifier, state, redirectUri, expires: now() + FLOW_MS };
      const url = new URL(meta.authorize);
      for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, resource: meta.resource,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" })) url.searchParams.set(k, v);
      return { url: url.toString(), base };
    },
    /** The approval page's redirect: state (and issuer, RFC 9207) checked, the code exchanged once, the token stored,
     *  then get_stats shows that it works. A failed first check still keeps the connection (the page shows why). */
    async finish(params: URLSearchParams): Promise<{ message: string }> {
      const p = pending;
      if (!p || p.expires < now() || exchanging || params.get("state") !== p.state) throw new EzyChatSignInMismatch();
      pending = null; // one try per sign-in, right or wrong
      if (params.has("iss") && params.get("iss")!.replace(/\/$/, "") !== p.meta.issuer) throw new EzyChatSignInMismatch();
      if (params.has("error") || !params.get("code")) throw new Error("EzyChat sign-in was cancelled or denied. You can connect again.");
      exchanging = true;
      try {
        let r: Response;
        try {
          r = await http(p.meta.token, { method: "POST", signal: AbortSignal.timeout(HTTP_MS), redirect: "error",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({ grant_type: "authorization_code", code: params.get("code")!, redirect_uri: p.redirectUri, client_id: p.clientId,
              code_verifier: p.verifier, resource: p.meta.resource }) });
        } catch { throw new EzyChatError("network", p.base); }
        const body = await r.json().catch(() => ({})) as { access_token?: unknown; token_type?: unknown };
        if (!r.ok || typeof body.access_token !== "string" || !body.access_token || String(body.token_type ?? "bearer").toLowerCase() !== "bearer")
          throw new Error("EzyChat could not finish the sign-in. Connect again.");
        saveSecret(file, { base: p.base, token: body.access_token, clientId: p.clientId, issuer: p.meta.issuer, redirectUri: p.redirectUri,
          connectedAt: new Date(now()).toISOString() } satisfies Stored);
      } finally { exchanging = false; }
      try { const { summary } = await check(); return { message: `EzyChat connected (${summary}). Customer chats sync from the next run.` }; }
      catch (e) { return { message: `EzyChat connected, but the first check failed: ${e instanceof EzyChatError ? e.message : MESSAGE_FAILED}` }; }
    },
    /** get_stats with the stored token (the Test button). */
    async test(): Promise<{ message: string }> {
      const { summary } = await check();
      return { message: `EzyChat answers: ${summary}.` };
    },
    /** Forgets the token and the registered app. Notes stay; the app is removed in EzyChat itself. */
    disconnect(): void { saveSecret(file, null); pending = null; },
  };
}
export type EzyChatService = ReturnType<typeof createEzyChatService>;
