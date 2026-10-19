import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../state.ts";
import { LOGIN_SCOPES, saveToken } from "./graph.ts";
import { DEFAULT_PRODUCT_NAME, productName } from "../config.ts";

export function makeAuthorization(cfg: Config, redirectUri: string) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({ client_id: cfg.clientId, response_type: "code", response_mode: "query",
    redirect_uri: redirectUri, scope: LOGIN_SCOPES, state,
    code_challenge: challenge, code_challenge_method: "S256", ...(cfg.account ? { login_hint: cfg.account } : {}) }).toString();
  return { verifier, state, url: url.toString() };
}

export function validCallback(url: URL, state: string): boolean {
  return !!state && url.searchParams.get("state") === state && !!url.searchParams.get("code");
}

export async function exchangeAuthorizationCode(cfg: Config, verifier: string, redirectUri: string, code: string): Promise<void> {
  const response = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(60_000),
    body: new URLSearchParams({ client_id: cfg.clientId, grant_type: "authorization_code", code,
      redirect_uri: redirectUri, code_verifier: verifier, scope: LOGIN_SCOPES }),
  });
  const token = await response.json() as any;
  if (!response.ok || !token.access_token) throw new Error("Microsoft could not finish sign-in. Try Connect Outlook again.");
  saveToken(token);
}

const escape = (text: string) => text.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
export function connectionPage(state: string, notice = "", connected = false, opts: { product?: string; account?: string } = {}): string {
  const name = opts.product || DEFAULT_PRODUCT_NAME, product = escape(name), upper = escape(name.toUpperCase()), account = opts.account ? escape(opts.account) : "Your Microsoft 365 mailbox";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Outlook · ${product}</title>
<style>body{margin:0;background:#f5f6f8;color:#182231;font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{box-sizing:border-box;width:min(480px,calc(100% - 40px));background:white;padding:40px;border:1px solid #e1e5eb;border-radius:18px;box-shadow:0 12px 40px #18223108}small{color:#627086;letter-spacing:.08em}h1{font-size:30px;line-height:1.2;margin:14px 0}p{color:#556276}a{display:block;text-align:center;background:#2457d6;color:white;text-decoration:none;border-radius:9px;padding:13px;margin:26px 0 18px;font-weight:650}footer{font-size:13px;color:#68758a}.notice{padding:12px;background:#eef3ff;border-radius:8px}</style>
<main><small>${upper} · OUTLOOK</small><h1>${connected ? "Outlook connected" : "Connect your mailbox"}</h1><p>${connected ? "Your mailbox is connected. The setup check will now run before automatic collection starts." : "Sign in with Microsoft to collect useful knowledge from your Outlook mail."}</p>${notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ""}${connected ? "" : `<a href="/connect?nonce=${state}">Connect Outlook</a>`}<footer>${connected ? "You can close this tab." : `${account}<br>Read-only mailbox access · Runs on this laptop`}</footer></main></html>`;
}

export async function browserLogin(cfg: Config, opts: { port?: number; timeoutMs?: number } = {}): Promise<void> {
  if (!cfg.clientId) throw new Error("Set MAILSYNC_CLIENT_ID first");
  const port = opts.port ?? 58434;
  const redirectUri = `http://localhost:${port}/`;
  const auth = makeAuthorization(cfg, redirectUri);
  let resolveLogin!: () => void;
  let rejectLogin!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
  let exchanging = false;
  let connected = false;
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" };
  const html = (notice = "", status = 200) => new Response(connectionPage(auth.state, notice, connected, { product: productName(), account: cfg.account }), { status, headers });
  const server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(req) {
    const url = new URL(req.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || req.method !== "GET") return new Response("Not allowed", { status: 403 });
    if (url.pathname === "/connect") {
      if (url.searchParams.get("nonce") !== auth.state) return html("Open the connection page again.", 403);
      return new Response(null, { status: 302, headers: { location: auth.url, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    }
    if (url.pathname !== "/") return new Response("Not found", { status: 404 });
    if (url.searchParams.has("error")) return html("Microsoft sign-in was cancelled or denied. You can try connecting again.", 400);
    if (!url.searchParams.has("code")) return html();
    if (!validCallback(url, auth.state)) return html("The sign-in session does not match. Start Connect Outlook again.", 400);
    if (connected || exchanging) return html("Finishing Microsoft sign-in…");
    exchanging = true;
    try {
      await exchangeAuthorizationCode(cfg, auth.verifier, redirectUri, url.searchParams.get("code")!);
      connected = true;
      console.log("Outlook connected. Microsoft token saved outside the vault.");
      // Deliver the confirmation page before the setup process proceeds.
      setTimeout(resolveLogin, 500);
      return html();
    } catch (e) { exchanging = false; console.error(e instanceof Error ? e.message : "Microsoft sign-in failed"); return html("Microsoft could not finish sign-in. Try Connect Outlook again.", 400); }
  } });
  const timer = setTimeout(() => rejectLogin(new Error("Connect Outlook session expired. Run mailsync login again.")), opts.timeoutMs ?? 15 * 60_000);
  console.log(`Connect Outlook: ${redirectUri}`);
  try { await completed; } finally { clearTimeout(timer); server.stop(); }
}
