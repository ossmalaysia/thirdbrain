// The Gmail connection: the address and app password, stored encrypted in the state folder (gmail.json, AES-GCM via
// secret-box.ts). Never in config.json, never logged, never sent to the browser: the status has the address only.
// Owner identity: a connected Gmail address is the owner's. It is recorded in owner-identity.json in the state folder
// (config.json is not edited) and stays there after a disconnect, so the owner never gets a person page for it.
import { join } from "node:path";
import { STATE_DIR } from "./state.ts";
import { loadSecret, saveSecret } from "./secret-box.ts";
import { atomicJson, readJson } from "../docker/scheduler.mjs";
import { GmailError, gmailQuery, openGmail, type GmailAccount, type GmailSession } from "./adapters/gmail-imap.ts";
import { DEFAULT_SCOPE, labelTerm, parseScope, safeLabel, SCOPE_OPTIONS, SCOPE_TERMS, scopeKey, scopeQuery, termQuery, type GmailScope, type ScopeOption } from "./adapters/gmail-scope.ts";

export const GMAIL_FILE = join(STATE_DIR, "gmail.json");
export const IDENTITY_FILE = join(STATE_DIR, "owner-identity.json");
const ADDRESS = /^[^\s@<>"(),;:]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;

interface Stored extends GmailAccount { connectedAt: string }

export const loadGmail = (file = GMAIL_FILE): Stored | null => {
  const s = loadSecret<Stored>(file);
  return s && typeof s.address === "string" && typeof s.password === "string" ? s : null;
};

/** Validates and normalises the form input. App passwords are 16 letters; Google shows them in groups of four. */
export function gmailInput(address: unknown, password: unknown): GmailAccount {
  const a = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (!ADDRESS.test(a) || a.length > 254) throw new Error("Enter your Gmail address, e.g. name@gmail.com.");
  const p = typeof password === "string" ? password.replace(/\s+/g, "") : "";
  if (!/^[a-z]{16}$/i.test(p)) throw new Error("Paste the 16-letter app password from step 2 (spaces do not matter).");
  return { address: a, password: p.toLowerCase() };
}

/** Extra owner addresses learned from connectors (lower case). */
export function identityEmails(file = IDENTITY_FILE): string[] {
  const raw = readJson(file, {}) as { emails?: unknown };
  return Array.isArray(raw?.emails) ? raw.emails.filter((e): e is string => typeof e === "string" && ADDRESS.test(e)).map(e => e.toLowerCase()) : [];
}
export function addIdentityEmail(email: string, configured: string[] = [], file = IDENTITY_FILE): boolean {
  const e = email.toLowerCase(), known = [...configured.map(c => c.toLowerCase()), ...identityEmails(file)];
  if (known.includes(e)) return false;
  atomicJson(file, { ...(readJson(file, {}) as object), emails: [...identityEmails(file), e] });
  return true;
}
/** The owner's addresses: config.json's owner.emails plus those recorded here, without duplicates. */
export const ownerEmails = (configured: string[], file = IDENTITY_FILE) => [...new Set([...configured.map(e => e.toLowerCase()), ...identityEmails(file)])];

// ── What to include (scope): a plain settings file next to the secret one; it holds no secret. ──
export const SETTINGS_FILE = join(STATE_DIR, "gmail-settings.json");

/** The saved choices, or the default (Primary, Sent, Important) when nothing valid is saved. */
export function readScope(file = SETTINGS_FILE): { scope: GmailScope; chosen: boolean } {
  const raw = readJson(file, null) as { scope?: unknown } | null;
  if (!raw?.scope) return { scope: DEFAULT_SCOPE, chosen: false };
  try { return { scope: parseScope(raw.scope), chosen: true }; } catch { return { scope: DEFAULT_SCOPE, chosen: false }; }
}
/** Validates and saves; `changed` = the query differs from before, so the next run reads the window again. */
export function saveScope(raw: unknown, file = SETTINGS_FILE): { scope: GmailScope; changed: boolean } {
  const scope = parseScope(raw), before = readScope(file).scope;
  atomicJson(file, { ...(readJson(file, {}) as object), scope, savedAt: new Date().toISOString() });
  return { scope, changed: scopeKey(scope) !== scopeKey(before) };
}

export interface ScopeCounts { at: string; sinceIso: string; options: Record<ScopeOption, number>; labels: { name: string; count: number | null }[] }
export interface ScopeEstimate { at: string; sinceIso: string; messages: number; threads: number; newThreads: number; complete: boolean }
export const MAX_COUNTED_LABELS = 40;

/** Messages per choice in the window (IMAP SEARCH, uids only), and the account's labels with their counts. */
export async function countScope(open: () => Promise<GmailSession>, sinceIso: string): Promise<ScopeCounts> {
  const session = await open();
  try {
    const options = {} as Record<ScopeOption, number>;
    for (const k of SCOPE_OPTIONS) options[k] = (await session.search({ gmraw: termQuery(SCOPE_TERMS[k], sinceIso) })).length;
    const names = (session.labels ?? []).filter(safeLabel), labels: ScopeCounts["labels"] = [];
    for (const [i, name] of names.entries())
      labels.push({ name, count: i < MAX_COUNTED_LABELS ? (await session.search({ gmraw: termQuery(labelTerm(name), sinceIso) })).length : null });
    return { at: new Date().toISOString(), sinceIso, options, labels };
  } finally { await session.close(); }
}

/** Messages and threads the chosen scope finds; `newThreads` = threads with a message not yet in the brain. */
export async function estimateScope(open: () => Promise<GmailSession>, scope: GmailScope, sinceIso: string, known: (id: string) => boolean, cap = 20_000): Promise<ScopeEstimate> {
  const session = await open();
  try {
    const uids = (await session.search({ gmraw: scopeQuery(scope, sinceIso) })).sort((a, b) => b - a), newest = uids.slice(0, cap);
    const threads = new Set<string>(), fresh = new Set<string>();
    for (let i = 0; i < newest.length; i += 500) for (const m of await session.fetch(newest.slice(i, i + 500), { metaOnly: true })) {
      if (!m.threadId) continue;
      threads.add(m.threadId);
      if (!m.emailId || !known(`gmail:${m.emailId}`)) fresh.add(m.threadId);
    }
    return { at: new Date().toISOString(), sinceIso, messages: uids.length, threads: threads.size, newThreads: fresh.size, complete: uids.length <= cap };
  } finally { await session.close(); }
}

/** A result for `ms`, or a fixed timeout error: a slow Gmail never holds a portal request. */
export async function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});
  try { return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new GmailError("timeout")), ms); })]); }
  finally { clearTimeout(timer); }
}

export interface GmailStatus { connected: boolean; address: string | null; passwordSaved: boolean; connectedAt: string | null; countsAsOwner: boolean; scope: GmailScope; scopeChosen: boolean }

export interface GmailServiceDeps { file?: string; identityFile?: string; settingsFile?: string; open?: (a: GmailAccount) => Promise<GmailSession>;
  ownerEmails?: () => string[]; known?: (id: string) => boolean; ttlMs?: number; timeoutMs?: number }

export function createGmailService(deps: GmailServiceDeps = {}) {
  const file = deps.file ?? GMAIL_FILE, idFile = deps.identityFile ?? IDENTITY_FILE, settings = deps.settingsFile ?? SETTINGS_FILE;
  const open = deps.open ?? (a => openGmail(a)), ttl = deps.ttlMs ?? 3_600_000, limit = deps.timeoutMs ?? 90_000;
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  const cached = <T>(key: string, refresh: boolean, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && !refresh && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
    const value = deadline(load(), limit);
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key)); // a failure is not remembered
    return value;
  };
  const session = () => { const a = loadGmail(file); if (!a) throw new Error("Connect Gmail first."); return () => open(a); };
  return {
    status(): GmailStatus {
      const s = loadGmail(file), { scope, chosen } = readScope(settings);
      return { connected: !!s, address: s?.address ?? null, passwordSaved: !!s?.password, connectedAt: s?.connectedAt ?? null,
        countsAsOwner: !!s && ownerEmails(deps.ownerEmails?.() ?? [], idFile).includes(s.address), scope, scopeChosen: chosen };
    },
    /** Tests LOGIN + SELECT of All Mail first; only a working login is saved. Errors carry fixed messages. */
    async connect(address: unknown, password: unknown): Promise<{ address: string; identityAdded: boolean }> {
      const account = gmailInput(address, password);
      const s = await open(account);
      await s.close();
      saveSecret(file, { ...account, connectedAt: new Date().toISOString() } satisfies Stored);
      cache.clear();
      return { address: account.address, identityAdded: addIdentityEmail(account.address, deps.ownerEmails?.() ?? [], idFile) };
    },
    /** Deletes the saved password. Notes, the owner identity and the scope choices stay. */
    disconnect(): void { saveSecret(file, null); cache.clear(); },
    setScope: (raw: unknown) => saveScope(raw, settings),
    /** Counts per choice (cached for an hour; `refresh` reads again). */
    counts: (sinceIso: string, refresh = false) => cached(`counts:${sinceIso.slice(0, 10)}`, refresh, () => countScope(session(), sinceIso)),
    estimate: (raw: unknown, sinceIso: string, refresh = false) => {
      const scope = parseScope(raw);
      return cached(`estimate:${scopeKey(scope)}:${sinceIso.slice(0, 10)}`, refresh, () => estimateScope(session(), scope, sinceIso, deps.known ?? (() => false)));
    },
  };
}
export type GmailService = ReturnType<typeof createGmailService>;

/** Backfill estimate: the newest message date of each thread in the window (dates and ids only, never content). */
export async function sampleGmail(open: () => Promise<GmailSession>, stopBefore: string, cap = 20_000, scope: GmailScope = readScope().scope): Promise<{ updated: string[]; complete: boolean }> {
  const session = await open();
  try {
    const uids = (await session.search({ gmraw: gmailQuery(stopBefore, scope) })).sort((a, b) => b - a);
    const newest = uids.slice(0, cap), latest = new Map<string, string>();
    for (let i = 0; i < newest.length; i += 500) {
      for (const m of await session.fetch(newest.slice(i, i + 500), { metaOnly: true })) {
        const at = m.internalDate instanceof Date ? m.internalDate.toISOString() : String(m.internalDate ?? "");
        if (m.threadId && at > (latest.get(m.threadId) ?? "")) latest.set(m.threadId, at);
      }
    }
    return { updated: [...latest.values()].sort().reverse(), complete: uids.length <= cap };
  } finally { await session.close(); }
}
