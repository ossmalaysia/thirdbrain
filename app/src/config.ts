// App configuration: who owns this install, where the vault is, which Microsoft 365 account it reads, and the product
// name the UI shows. Lives in <state dir>/config.json (never in the vault or in git). Every field is optional;
// missing fields fall back to the legacy key=value settings file and then to neutral defaults.
// Tuning settings (MAILSYNC_*, BACKUP_PUSH, BRAIN_PORT, ...) stay in that key=value settings file (see state.ts).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_PRODUCT_NAME = "Third Brain";
/** Vault paths the index refresh after each sync never indexes (gbrain sync --exclude). */
export const DEFAULT_INDEX_EXCLUDE = ["life/**", "_setup/**", "templates/**"];
export type Pronouns = "he" | "she" | "they";

export interface Owner {
  /** Full name, e.g. "Aisyah Rahman". Used in the note writer prompt. Empty: "the owner". */
  name: string;
  /** What the prompt calls the owner in running text, e.g. "Aisyah". Empty: first word of `name`. */
  shortName: string;
  /** The owner's own addresses, lower case. */
  emails: string[];
  org: string;
  role: string;
  /** Pronouns the note writer prompt uses for the owner. */
  pronouns: Pronouns;
}

export interface AppConfig {
  product: { name: string };
  owner: Owner;
  vault: {
    path: string;
    /** Globs passed to `gbrain sync --exclude` after each sync run. Add private folders (e.g. "clients/**"). */
    indexExclude: string[];
  };
  microsoft: {
    /** The mailbox this install must read. Empty: the first signed-in mailbox is accepted and recorded here. */
    account: string;
    clientId: string;
    tenantId: string;
  };
  /** The key=value settings file (MAILSYNC_*, BACKUP_PUSH, BRAIN_PORT, ...). */
  settingsFile: string;
  backup: {
    /** Nested git repos inside the vault (relative paths) that are committed locally and never pushed or added to
     *  the vault repo. Missing folders are skipped. */
    localOnlyRepos: string[];
  };
  /** Where new releases are looked up (GitHub "owner/name"); the portal's Settings page shows them. */
  updates: { repo: string };
}

/** The GitHub repository whose releases the update check reads, unless config.json names another. */
export const DEFAULT_UPDATE_REPO = "ossmalaysia/thirdbrain";

type Env = Record<string, string | undefined>;

/** State directory. MAILSYNC_STATE_DIR is the original name; THIRDBRAIN_STATE_DIR is accepted as an alias.
 *  The default stays ~/.brain-mailsync so existing installs keep their state (a rename is planned). */
export function resolveStateDir(env: Env = process.env): string {
  return env.MAILSYNC_STATE_DIR || env.THIRDBRAIN_STATE_DIR || join(homedir(), ".brain-mailsync");
}

/** The portal's port on 127.0.0.1. THIRDBRAIN_PORT changes it (e.g. a second install, or when 58432 is taken). */
export const DEFAULT_PORTAL_PORT = 58432;
export function portalPort(env: Env = process.env): number {
  const raw = env.THIRDBRAIN_PORT?.trim();
  if (!raw) return DEFAULT_PORTAL_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1024 || port > 65535) throw new Error("THIRDBRAIN_PORT must be a port number from 1024 to 65535");
  return port;
}

export const configPath = (stateDir = resolveStateDir(), env: Env = process.env) => env.THIRDBRAIN_CONFIG || join(stateDir, "config.json");

/** Parses a key=value settings file (the format of the old `.env`). Missing file: no settings. */
export function readSettings(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!file || !existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Raw config.json (unvalidated), or {} when there is none. Invalid JSON is an error, never silently ignored. */
export function readConfigFile(file = configPath()): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); }
  catch { throw new Error(`${file} is not valid JSON`); }
  if (!isObj(raw)) throw new Error(`${file} must hold a JSON object`);
  return raw;
}

function str(raw: Record<string, unknown>, section: string, key: string): string | undefined {
  const s = raw[section];
  if (s === undefined) return undefined;
  if (!isObj(s)) throw new Error(`config.json: ${section} must be an object`);
  const v = s[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || /[\r\n]/.test(v)) throw new Error(`config.json: ${section}.${key} must be a single-line string`);
  return v.trim();
}

function list(raw: Record<string, unknown>, section: string, key: string): string[] | undefined {
  const s = raw[section];
  if (!isObj(s) || s[key] === undefined || s[key] === null) return undefined;
  const v = s[key];
  if (!Array.isArray(v) || v.some(x => typeof x !== "string" || /[\r\n]/.test(x))) throw new Error(`config.json: ${section}.${key} must be a list of strings`);
  return (v as string[]).map(x => x.trim()).filter(Boolean);
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;

/** Resolves the app configuration. Precedence per field: environment variable, config.json, settings file, default. */
export function loadAppConfig(opts: { stateDir?: string; env?: Env; file?: string } = {}): AppConfig {
  const env = opts.env ?? process.env, stateDir = opts.stateDir ?? resolveStateDir(env);
  const file = opts.file ?? configPath(stateDir, env);
  const raw = readConfigFile(file);
  if (raw.settingsFile !== undefined && (typeof raw.settingsFile !== "string" || !raw.settingsFile.trim())) throw new Error("config.json: settingsFile must be a path");
  const settingsFile = typeof raw.settingsFile === "string" ? resolve(dirname(file), raw.settingsFile.trim()) : join(stateDir, "settings.env");
  const settings = readSettings(settingsFile);
  const pick = (envKey: string, fromConfig: string | undefined, fallback: string) => env[envKey] || fromConfig || settings[envKey] || fallback;

  const emails = (list(raw, "owner", "emails") ?? []).map(e => e.toLowerCase());
  const bad = emails.find(e => !EMAIL.test(e));
  if (bad) throw new Error(`config.json: owner.emails has an invalid address`);
  const pronouns = str(raw, "owner", "pronouns") || "they";
  if (!["he", "she", "they"].includes(pronouns)) throw new Error("config.json: owner.pronouns must be he, she or they");
  const account = (str(raw, "microsoft", "account") ?? "").toLowerCase();
  if (account && !EMAIL.test(account)) throw new Error("config.json: microsoft.account must be an email address");
  const localOnlyRepos = list(raw, "backup", "localOnlyRepos") ?? ["life"];
  const indexExclude = list(raw, "vault", "indexExclude") ?? DEFAULT_INDEX_EXCLUDE;
  if (indexExclude.some(g => isAbsolute(g) || g.startsWith("-"))) throw new Error("config.json: vault.indexExclude must be paths inside the vault");
  const repo = str(raw, "updates", "repo")?.trim() || DEFAULT_UPDATE_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("config.json: updates.repo must be a GitHub owner/name");
  if (localOnlyRepos.some(r => isAbsolute(r) || r.split(/[\\/]/).includes(".."))) throw new Error("config.json: backup.localOnlyRepos must be folders inside the vault");

  return {
    product: { name: str(raw, "product", "name") || DEFAULT_PRODUCT_NAME },
    owner: { name: str(raw, "owner", "name") ?? "", shortName: str(raw, "owner", "shortName") ?? "", emails,
      org: str(raw, "owner", "org") ?? "", role: str(raw, "owner", "role") ?? "", pronouns: pronouns as Pronouns },
    vault: { path: pick("BRAIN_PATH", str(raw, "vault", "path"), join(homedir(), "ThirdBrain")), indexExclude: [...indexExclude] },
    microsoft: { account,
      clientId: pick("MAILSYNC_CLIENT_ID", str(raw, "microsoft", "clientId"), ""),
      tenantId: pick("MAILSYNC_TENANT_ID", str(raw, "microsoft", "tenantId"), "organizations") },
    settingsFile,
    backup: { localOnlyRepos },
    updates: { repo },
  };
}

/** Merges `patch` into config.json, keeping every other field (and unknown keys) as written. Atomic. */
export function patchConfigFile(patch: Record<string, Record<string, unknown> | string>, file = configPath()): void {
  const raw = readConfigFile(file);
  for (const [k, v] of Object.entries(patch)) raw[k] = isObj(v) && isObj(raw[k]) ? { ...(raw[k] as object), ...v } : v;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(raw, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

/** The product name for pages served outside the portal (sign-in callbacks). Never throws: a broken config.json
 *  must not break a sign-in page. */
export function productName(): string {
  try { return loadAppConfig().product.name; } catch { return DEFAULT_PRODUCT_NAME; }
}

/** Run guard: the signed-in Microsoft mailbox must be the configured one. With none configured, the caller records
 *  the signed-in mailbox (so a later sign-in to another mailbox is refused, as before). */
export function checkMailbox(signedIn: string, expected: string): "ok" | "record" {
  const mail = signedIn.trim().toLowerCase();
  if (!mail) throw new Error("Microsoft did not return the signed-in mailbox");
  if (!expected) return "record";
  if (mail !== expected.trim().toLowerCase()) throw new Error(`Signed into a different Microsoft mailbox; run login with ${expected}`);
  return "ok";
}

/** What `cli config` prints: the resolved configuration and which settings exist, never any setting's value. */
export function describeConfig(cfg: AppConfig, file = configPath()) {
  return { configFile: file, configFileExists: existsSync(file), stateDir: resolveStateDir(), ...cfg,
    settingsFileExists: existsSync(cfg.settingsFile), settingsKeys: Object.keys(readSettings(cfg.settingsFile)).sort() };
}

export interface InitOptions { name?: string; shortName?: string; emails?: string[]; org?: string; role?: string; pronouns?: string;
  vault?: string; settingsFile?: string; account?: string; clientId?: string; tenantId?: string; product?: string; force?: boolean }

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** `cli config init`: writes config.json from an existing settings file (e.g. an old .env) plus the given values.
 *  Only fields with a value are written; everything else keeps its default. Refuses to overwrite without force. */
export function initConfigFile(opts: InitOptions, file = configPath()): Record<string, unknown> {
  if (existsSync(file) && !opts.force) throw new Error(`${file} already exists; pass --force to replace it`);
  if (opts.clientId && !UUID.test(opts.clientId)) throw new Error("--client-id must be the Application (client) ID, a UUID");
  if (opts.tenantId && !UUID.test(opts.tenantId) && !["organizations", "common"].includes(opts.tenantId)) throw new Error("--tenant-id must be the Directory (tenant) ID, a UUID");
  const settingsFile = opts.settingsFile ? resolve(opts.settingsFile) : undefined;
  const settings = readSettings(settingsFile ?? join(resolveStateDir(), "settings.env"));
  const drop = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)));
  const out = drop({
    product: opts.product ? { name: opts.product } : undefined,
    owner: drop({ name: opts.name, shortName: opts.shortName, emails: opts.emails?.map(e => e.toLowerCase()), org: opts.org, role: opts.role, pronouns: opts.pronouns }),
    vault: (opts.vault ?? settings.BRAIN_PATH) ? { path: opts.vault ?? settings.BRAIN_PATH } : undefined,
    microsoft: drop({ account: opts.account?.toLowerCase(), clientId: opts.clientId ?? settings.MAILSYNC_CLIENT_ID, tenantId: opts.tenantId ?? settings.MAILSYNC_TENANT_ID }),
    settingsFile,
  });
  for (const k of ["owner", "microsoft"]) if (!Object.keys(out[k] as object ?? {}).length) delete out[k];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(out, null, 2) + "\n");
  try { loadAppConfig({ file: `${file}.tmp` }); } catch (e) { rmSync(`${file}.tmp`, { force: true }); throw e; } // never write an invalid config
  renameSync(`${file}.tmp`, file);
  return out;
}
