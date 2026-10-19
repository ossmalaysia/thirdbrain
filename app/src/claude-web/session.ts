// Claude.ai over the browser session: every request is a fetch() inside the signed-in claude.ai tab, so it
// carries the user's own cookies and a genuine browser fingerprint (plain HTTP gets a Cloudflare challenge).
// Ported from ossmalaysia/claude-sync internal/browser (MIT, Anchor Sprint): the hostGuard and the
// signed-in check are the same.
import { callInTab } from "./cdp.ts";

export const CLAUDE_ORIGIN = "https://claude.ai";

/** The request that runs inside the signed-in tab. A fixed function: the URL arrives as its argument
 *  (Runtime.callFunctionOn), never as code. As claude-sync's hostGuard, it never fetches while the tab is
 *  elsewhere (e.g. an SSO sign-in page). */
export const FETCH_IN_TAB = `async function (url) {
  if (location.host !== "claude.ai") return { status: 0, host: location.host };
  const r = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(45000) });
  return { status: r.status, body: await r.text() };
}`;

/** The absolute URL of a Claude.ai API path. Throws unless it stays on the Claude.ai origin. */
export function claudeUrl(path: string): string {
  let url: URL;
  try { url = new URL(CLAUDE_ORIGIN + path); } catch { throw new Error(`not a Claude.ai path: ${path}`); }
  if (url.origin !== CLAUDE_ORIGIN) throw new Error(`not a Claude.ai path: ${path}`);
  return url.href;
}

type InTab = <T>(port: number, fn: string, args: unknown[]) => Promise<T>;

export class ClaudeAuthError extends Error {}
export class ClaudeBlockedError extends Error {}

export interface ClaudeApi { get: <T = any>(path: string) => Promise<T> }

/** A ClaudeApi that runs requests in the browser listening on `port`. */
export function browserApi(port: number, run: InTab = callInTab): ClaudeApi {
  return {
    async get<T>(path: string): Promise<T> {
      const r = await run<{ status: number; body?: string; host?: string }>(port, FETCH_IN_TAB, [claudeUrl(path)]);
      if (r.host) throw new ClaudeAuthError(`Claude.ai is not signed in (the tab is on ${r.host}). Use Reconnect Claude.ai in the portal.`);
      if (r.status === 401 || r.status === 403) {
        if (/challenge|cf-chl|Just a moment/i.test(r.body ?? "")) throw new ClaudeBlockedError("Cloudflare is challenging the Claude.ai browser. Open it from the portal and complete the check.");
        throw new ClaudeAuthError("Claude.ai signed out. Use Reconnect Claude.ai in the portal.");
      }
      if (r.status !== 200) throw new Error(`Claude.ai request failed (HTTP ${r.status})`);
      try { return JSON.parse(r.body ?? "null") as T; } catch { throw new Error("Claude.ai returned an unexpected page instead of data."); }
    },
  };
}

/** Signed in when /api/organizations answers 200 with at least one organisation (claude-sync's WaitLoggedIn). */
export async function signedIn(api: ClaudeApi): Promise<boolean> {
  try { const orgs = await api.get<unknown[]>("/api/organizations"); return Array.isArray(orgs) && orgs.length > 0; }
  catch { return false; }
}

/** Account email for the portal's status line (no message content). */
export async function accountEmail(api: ClaudeApi): Promise<string | null> {
  try { const a = await api.get<any>("/api/account"); return a?.email_address ?? a?.account?.email_address ?? a?.email ?? null; }
  catch { return null; }
}
