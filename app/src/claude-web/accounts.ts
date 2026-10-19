// Several Claude.ai logins (e.g. personal and company). One login per browser profile, so each account has its
// own profile, DevTools port, state file and sync feed. The first account keeps the original single-account
// paths and feed id (`ai:claude`), so its sign-in and sync watermark carry over unchanged.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../state.ts";
import { atomicJson, readJson } from "../../docker/scheduler.mjs";
import { AI_FEED } from "../adapters/claude-web.ts";
import { CLAUDE_BROWSER_FILE, CLAUDE_PROFILE_DIR, DEFAULT_PORT, createClaudeConnector, readClaudeBrowser, type ClaudeConnector } from "./connector.ts";

export const ACCOUNTS_FILE = join(STATE_DIR, "claude-accounts.json");
export const FIRST_ACCOUNT = "personal";

export interface ClaudeAccount { id: string; label: string; file: string; profileDir: string; feed: string }

const paths = (id: string, dir: string) => id === FIRST_ACCOUNT
  ? { file: dir === STATE_DIR ? CLAUDE_BROWSER_FILE : join(dir, "claude-browser.json"), profileDir: dir === STATE_DIR ? CLAUDE_PROFILE_DIR : join(dir, "claude-browser"), feed: AI_FEED }
  : { file: join(dir, `claude-browser-${id}.json`), profileDir: join(dir, `claude-browser-${id}`), feed: `${AI_FEED}:${id}` };

/** Every account, the first one always included (it may be signed out). */
export function listAccounts(dir = STATE_DIR): ClaudeAccount[] {
  const saved = readJson(join(dir, "claude-accounts.json"), []) as { id: string; label: string }[];
  const rows = saved.some(a => a.id === FIRST_ACCOUNT) ? saved : [{ id: FIRST_ACCOUNT, label: "Personal" }, ...saved];
  return rows.map(a => ({ ...a, ...paths(a.id, dir) }));
}

const slug = (label: string) => label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);

/** Registers a new account with the next free DevTools port. Its browser starts on connect. Accounts are shown by
 *  their login email (meaningful to anyone using the portal); the optional label only seeds the internal id. */
export function addAccount(label = "", dir = STATE_DIR): ClaudeAccount {
  const name = label.trim().replace(/\s+/g, " ").slice(0, 40);
  const accounts = listAccounts(dir);
  let id = slug(name);
  if (id && accounts.some(a => a.id === id)) throw new Error(`There is already a Claude.ai account called ${name}.`);
  for (let n = accounts.length + 1; !id || accounts.some(a => a.id === id); n++) id = `account-${n}`;
  const ports = accounts.map(a => readClaudeBrowser(a.file).port);
  const port = Math.max(DEFAULT_PORT, ...ports) + 1;
  const account = { id, label: name, ...paths(id, dir) };
  if (!existsSync(account.file)) atomicJson(account.file, { connected: false, port, email: null });
  atomicJson(join(dir, "claude-accounts.json"), [...accounts.map(({ id, label }) => ({ id, label })), { id, label: name }]);
  return account;
}

/** Forgets an added account (the first one stays; it is only signed out). */
export function removeAccount(id: string, dir = STATE_DIR): void {
  if (id === FIRST_ACCOUNT) return;
  atomicJson(join(dir, "claude-accounts.json"), listAccounts(dir).filter(a => a.id !== id).map(({ id, label }) => ({ id, label })));
}

/** Portal side: one connector (window, sign-in, keep-alive) per account. */
export function createClaudeAccounts(opts: { dir?: string; make?: typeof createClaudeConnector } = {}) {
  const dir = opts.dir ?? STATE_DIR, make = opts.make ?? createClaudeConnector;
  const connectors = new Map<string, ClaudeConnector>();
  let started = false;
  const connector = (a: ClaudeAccount) => {
    let c = connectors.get(a.id);
    if (!c) { c = make({ file: a.file, profileDir: a.profileDir }); connectors.set(a.id, c); }
    return c;
  };
  const find = (id = FIRST_ACCOUNT) => {
    const a = listAccounts(dir).find(x => x.id === id);
    if (!a) throw new Error("That Claude.ai account is not set up.");
    return a;
  };
  return {
    /** Per-account status, first account first. */
    list: () => listAccounts(dir).map(a => ({ id: a.id, label: a.label, feed: a.feed, ...connector(a).status() })),
    /** The first account's status, in the single-account shape older pages read. */
    status: () => connector(find()).status(),
    connect: async (id?: string) => connector(find(id)).connect(),
    /** Adds an account and opens its window for sign-in. */
    async add(label = "") {
      const a = addAccount(label, dir), c = connector(a);
      if (started) c.start(); // keep-alive for the new window once it is signed in
      await c.connect();
      return { id: a.id, label: a.label };
    },
    /** Signs the account out and deletes its browser profile; an added account is also removed from the list. */
    disconnect(id?: string) {
      const a = find(id);
      connector(a).disconnect(true);
      if (a.id !== FIRST_ACCOUNT) { connectors.get(a.id)?.stop(); connectors.delete(a.id); removeAccount(a.id, dir); }
    },
    start() { started = true; for (const a of listAccounts(dir)) connector(a).start(); },
    stop() { started = false; for (const c of connectors.values()) c.stop(); },
  };
}
export type ClaudeAccounts = ReturnType<typeof createClaudeAccounts>;
