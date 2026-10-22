// Microsoft sign-in and a Graph client with retry. The only code that talks to Microsoft.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, writeJsonAtomic, type Config } from "../state.ts";

// One Microsoft sign-in, two access tokens: mail, and Teams/meetings. They are refreshed separately so a
// Teams permission that isn't granted yet can never stop email (it raises PermissionNeededError, not NeedsLogin).
export const MAIL_SCOPES = "offline_access User.Read Mail.Read";
export const TEAMS_SCOPES = "offline_access User.Read Chat.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All Calendars.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All";
/** Requested at sign-in so one consent covers both. ChannelMessage.Read.All and OnlineMeetingTranscript.Read.All need admin consent. */
export const LOGIN_SCOPES = [...new Set(`${MAIL_SCOPES} ${TEAMS_SCOPES}`.split(" "))].join(" ");
const SCOPES = MAIL_SCOPES;
const TOKEN_FILE = () => join(STATE_DIR, "token.json");

interface Token { access_token: string; refresh_token: string; expires_at: number; extra?: Record<string, { access_token: string; expires_at: number }> }

/** The sign-in works, but Microsoft hasn't granted this permission (admin consent or a fresh Connect needed). */
export class PermissionNeededError extends Error {}

export class NeedsLoginError extends Error {
  constructor(msg = "Microsoft login needed: run `mailsync login`", readonly code: string | null = null, readonly reason = "Microsoft 365 is not connected yet.") { super(msg); }
}

// Why Microsoft refused the saved sign-in, in words a user can act on. Codes: Microsoft Entra AADSTS error codes.
const LOGIN_REASONS: [RegExp, string][] = [
  [/^(50173|50133|50132)$/, "Microsoft ended the sign-in because the password changed or the sessions were signed out."],
  [/^(70008|700082)$/, "The sign-in expired because it was not used for a long time."],
  [/^70043$/, "Your organization's policy asks for a new sign-in after a set time."],
  [/^(50076|50079|50078)$/, "Your organization now asks for multi-factor authentication."],
  [/^53003$/, "Your organization's Conditional Access policy blocked the sign-in."],
  [/^50057$/, "The Microsoft account is disabled."],
];

/** The AADSTS code and a plain reason for a refused token refresh. */
export function loginLost(t: { error?: string; error_codes?: number[] }): { code: string; reason: string } {
  const n = t.error_codes?.[0] != null ? String(t.error_codes[0]) : null;
  const known = n ? LOGIN_REASONS.find(([re]) => re.test(n))?.[1] : undefined;
  return { code: n ? `AADSTS${n}` : t.error ?? "unknown_error", reason: known ?? `Microsoft refused the saved sign-in (${t.error ?? "unknown error"}).` };
}

const expired = (t: any) => { const l = loginLost(t); return new NeedsLoginError(`Microsoft login expired (${l.code}): ${l.reason}`, l.code, l.reason); };

const authority = (cfg: Config) => `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0`;

async function tokenRequest(cfg: Config, body: Record<string, string>): Promise<any> {
  const res = await fetch(`${authority(cfg)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, ...body }),
  });
  return res.json();
}

export function saveToken(t: any, extra?: Token["extra"]): Token {
  if (typeof t.access_token !== "string" || typeof t.refresh_token !== "string" || !Number.isFinite(Number(t.expires_in))) throw new Error("Microsoft returned an incomplete token response");
  // A fresh sign-in (no `extra` passed) drops cached Teams tokens so new consent takes effect at once.
  const token: Token = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (Number(t.expires_in) - 120) * 1000, ...(extra ? { extra } : {}) };
  writeJsonAtomic(TOKEN_FILE(), token);
  return token;
}

/** Interactive, once: prints a code for the user to approve in their own browser. */
export async function deviceLogin(cfg: Config): Promise<void> {
  if (!cfg.clientId) throw new Error("No Microsoft client id: set microsoft.clientId in config.json or MAILSYNC_CLIENT_ID in the settings file");
  const res = await fetch(`${authority(cfg)}/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, scope: LOGIN_SCOPES }),
  });
  const dc: any = await res.json();
  if (!dc.device_code) throw new Error(`device code request failed: ${dc.error_description ?? JSON.stringify(dc)}`);
  console.log(dc.message);
  const deadline = Date.now() + Number(dc.expires_in) * 1000;
  let interval = Number(dc.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(interval);
    const t = await tokenRequest(cfg, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code });
    if (t.access_token) { saveToken(t); console.log("Signed in. Token saved to", TOKEN_FILE()); return; }
    if (t.error === "authorization_pending") continue;
    if (t.error === "slow_down") { interval += 5000; continue; }
    throw new Error(`sign-in failed: ${t.error_description ?? t.error}`);
  }
  throw new Error("sign-in timed out");
}

async function accessToken(cfg: Config, forceRefresh = false, scopes = SCOPES): Promise<string> {
  if (!existsSync(TOKEN_FILE())) throw new NeedsLoginError();
  const tok: Token = JSON.parse(readFileSync(TOKEN_FILE(), "utf8"));
  if (scopes === SCOPES) {
    if (!forceRefresh && tok.expires_at > Date.now()) return tok.access_token;
    const t = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: tok.refresh_token, scope: SCOPES });
    if (!t.access_token) throw expired(t);
    return saveToken({ ...t, refresh_token: t.refresh_token ?? tok.refresh_token }, tok.extra).access_token;
  }
  // Teams/meetings: same refresh token, its own access token. Missing consent is reported, not fatal.
  const cached = tok.extra?.[scopes];
  if (!forceRefresh && cached && cached.expires_at > Date.now()) return cached.access_token;
  const t = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: tok.refresh_token, scope: scopes });
  if (!t.access_token) {
    if (/consent|AADSTS65001|AADSTS90094|invalid_scope|insufficient/i.test(`${t.error} ${t.error_description}`)) throw new PermissionNeededError("Teams and meetings need permission: an admin approves the new Microsoft permissions, then use Reconnect in the portal.");
    throw expired(t);
  }
  const extra = { ...tok.extra, [scopes]: { access_token: t.access_token, expires_at: Date.now() + (Number(t.expires_in) - 120) * 1000 } };
  writeJsonAtomic(TOKEN_FILE(), { ...tok, refresh_token: t.refresh_token ?? tok.refresh_token, extra });
  return t.access_token;
}

export class GoneError extends Error {}

/** GET a Graph URL (absolute or /v1.0-relative). Retries 429/5xx, refreshes once on 401. */
export async function graphGet(cfg: Config, url: string, headers: Record<string, string> = {}, scopes = SCOPES): Promise<any> {
  return (await graphFetch(cfg, url, headers, scopes)).json();
}
/** Raw bytes (email attachments). */
export async function graphGetBytes(cfg: Config, url: string, headers: Record<string, string> = {}, scopes = SCOPES): Promise<Uint8Array> {
  return new Uint8Array(await (await graphFetch(cfg, url, headers, scopes)).arrayBuffer());
}
/** Same, for non-JSON bodies (meeting transcripts are text/vtt). */
export async function graphGetText(cfg: Config, url: string, headers: Record<string, string> = {}, scopes = SCOPES): Promise<string> {
  return (await graphFetch(cfg, url, headers, scopes)).text();
}

async function graphFetch(cfg: Config, url: string, headers: Record<string, string>, scopes: string): Promise<Response> {
  const full = url.startsWith("http") ? url : `https://graph.microsoft.com/v1.0${url}`;
  if (new URL(full).origin !== "https://graph.microsoft.com") throw new Error("Refusing to send Microsoft credentials to another host");
  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(full, { headers: { authorization: `Bearer ${await accessToken(cfg, false, scopes)}`, ...headers }, signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (res.ok) return res;
    if (res.status === 401 && !refreshed) { refreshed = true; await accessToken(cfg, true, scopes); continue; }
    if (res.status === 403 && scopes !== SCOPES) throw new PermissionNeededError("Microsoft refused a Teams or meetings request (403): the permission may need admin approval, then Reconnect in the portal.");
    if (res.status === 410) throw new GoneError(`delta cursor expired: ${full}`);
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Number(res.headers.get("retry-after") ?? 2 ** attempt) * 1000;
      await Bun.sleep(Math.min(wait, 60_000));
      continue;
    }
    throw new Error(`Microsoft Graph request failed (HTTP ${res.status}); check permissions or retry`);
  }
}
