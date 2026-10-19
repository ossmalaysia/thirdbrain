// Device-link sign-in for the portal on its public address. The laptop (local portal) creates a one-time
// link; opening it in another browser creates a 30-day session cookie there. Only SHA-256 hashes of link
// tokens and session ids are stored, so a copy of the file cannot be used to sign in.
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { STATE_DIR } from "../state.ts";
import { atomicJson, readJson } from "../../docker/scheduler.mjs";

export const LINK_TTL_MS = 10 * 60_000, SESSION_TTL_MS = 30 * 86_400_000;
export const SESSION_COOKIE = "brain_session";
interface Store { links: Record<string, number>; sessions: Record<string, { created: number; expires: number }> }

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export function createSessions(opts: { file?: string; now?: () => number } = {}) {
  const file = opts.file ?? join(STATE_DIR, "portal-sessions.json"), now = opts.now ?? Date.now;
  /** Loads the store with expired links and sessions dropped. */
  const load = (): Store => {
    const s: Store = { links: {}, sessions: {}, ...readJson(file, {}) }, t = now();
    for (const [k, exp] of Object.entries(s.links)) if (exp <= t) delete s.links[k];
    for (const [k, v] of Object.entries(s.sessions)) if (v.expires <= t) delete s.sessions[k];
    return s;
  };
  const save = (s: Store) => atomicJson(file, s);
  return {
    /** A one-time sign-in token, valid for 10 minutes. */
    createLink(): { token: string; expiresAt: number } {
      const s = load(), t = token(), expiresAt = now() + LINK_TTL_MS;
      s.links[hash(t)] = expiresAt; save(s);
      return { token: t, expiresAt };
    },
    /** True while a link is unused and unexpired. Does not spend it (link previews only look). */
    linkValid: (linkToken: string | null) => !!linkToken && !!load().links[hash(linkToken)],
    /** Spends a link token (once) and returns a new session id, or null if unknown, used or expired. */
    redeem(linkToken: string | null): string | null {
      if (!linkToken) return null;
      const s = load(), key = hash(linkToken);
      if (!s.links[key]) return null;
      delete s.links[key];
      const id = token(); s.sessions[hash(id)] = { created: now(), expires: now() + SESSION_TTL_MS }; save(s);
      return id;
    },
    valid: (sessionId: string | null) => !!sessionId && !!load().sessions[hash(sessionId)],
    count: () => Object.keys(load().sessions).length,
    /** Signs out every device (and voids unused links). */
    revokeAll() { save({ links: {}, sessions: {} }); },
  };
}
export type Sessions = ReturnType<typeof createSessions>;

export const readCookie = (header: string | null, name: string) =>
  header?.split(/;\s*/).map(p => p.split("=")).find(([k]) => k === name)?.[1] ?? null;
