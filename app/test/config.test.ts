import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkMailbox, DEFAULT_INDEX_EXCLUDE, describeConfig, initConfigFile, loadAppConfig, portalPort, readSettings, resolveStateDir } from "../src/config.ts";
import { loadConfig, saveConfig } from "../src/state.ts";

const dir = () => mkdtempSync(join(tmpdir(), "tb-config-"));
const write = (file: string, value: unknown) => writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));

test("defaults: no config.json and no settings file give a neutral, working configuration", () => {
  const d = dir();
  expect(loadAppConfig({ stateDir: d, env: {} })).toEqual({
    product: { name: "Third Brain" },
    owner: { name: "", shortName: "", emails: [], org: "", role: "", pronouns: "they" },
    vault: { path: join(homedir(), "ThirdBrain"), indexExclude: DEFAULT_INDEX_EXCLUDE },
    microsoft: { account: "", clientId: "", tenantId: "organizations" },
    settingsFile: join(d, "settings.env"),
    backup: { localOnlyRepos: ["life"] },
    updates: { repo: "ossmalaysia/thirdbrain" },
  });
});

test("state dir: MAILSYNC_STATE_DIR, then the THIRDBRAIN_STATE_DIR alias, then ~/.brain-mailsync", () => {
  expect(resolveStateDir({ MAILSYNC_STATE_DIR: "/a", THIRDBRAIN_STATE_DIR: "/b" })).toBe("/a");
  expect(resolveStateDir({ THIRDBRAIN_STATE_DIR: "/b" })).toBe("/b");
  expect(resolveStateDir({})).toBe(join(homedir(), ".brain-mailsync"));
});

test("config.json fields, legacy settings file fallback, and environment overrides", () => {
  const d = dir(), legacy = join(d, "legacy", ".env");
  mkdirSync(join(d, "legacy"));
  write(legacy, "BRAIN_PATH=C:\\vault-from-env\nMAILSYNC_CLIENT_ID=11111111-1111-1111-1111-111111111111\nMAILSYNC_TENANT_ID=22222222-2222-2222-2222-222222222222\n");
  write(join(d, "config.json"), { settingsFile: "legacy/.env", unknownKey: { ignored: true },
    product: { name: "Contoh Brain" },
    owner: { name: "Aisyah Rahman", emails: ["Aisyah@Example.com", "aisyah.home@example.net"], org: "Contoh Sdn Bhd", role: "founder", pronouns: "she" },
    microsoft: { account: "Aisyah@Example.com" } });
  const c = loadAppConfig({ stateDir: d, env: {} });
  expect(c.settingsFile).toBe(legacy);                          // relative to config.json
  expect(c.vault.path).toBe("C:\\vault-from-env");               // settings file fallback
  expect(c.microsoft).toEqual({ account: "aisyah@example.com", clientId: "11111111-1111-1111-1111-111111111111", tenantId: "22222222-2222-2222-2222-222222222222" });
  expect(c.owner).toEqual({ name: "Aisyah Rahman", shortName: "", emails: ["aisyah@example.com", "aisyah.home@example.net"], org: "Contoh Sdn Bhd", role: "founder", pronouns: "she" });
  expect(c.product.name).toBe("Contoh Brain");
  expect((c as any).unknownKey).toBeUndefined();

  // config.json beats the settings file; environment variables beat both.
  write(join(d, "config.json"), { settingsFile: legacy, vault: { path: "D:\\Notes" }, microsoft: { tenantId: "organizations" } });
  expect(loadAppConfig({ stateDir: d, env: {} }).vault.path).toBe("D:\\Notes");
  expect(loadAppConfig({ stateDir: d, env: {} }).microsoft.tenantId).toBe("organizations");
  expect(loadAppConfig({ stateDir: d, env: { BRAIN_PATH: "E:\\Override", MAILSYNC_TENANT_ID: "t-env" } })).toMatchObject({ vault: { path: "E:\\Override" }, microsoft: { tenantId: "t-env" } });
  // THIRDBRAIN_CONFIG points at another config file.
  const other = join(dir(), "elsewhere.json");
  write(other, { product: { name: "Elsewhere" } });
  expect(loadAppConfig({ stateDir: d, env: { THIRDBRAIN_CONFIG: other } }).product.name).toBe("Elsewhere");
});

test("validation: bad JSON and wrong types are errors; nothing is silently guessed", () => {
  const d = dir(), f = join(d, "config.json"), load = () => loadAppConfig({ stateDir: d, env: {} });
  for (const [value, message] of [
    ["{not json", "not valid JSON"], ["[1]", "JSON object"],
    [{ owner: { emails: "a@b.c" } }, "owner.emails"], [{ owner: { emails: ["not-an-email"] } }, "owner.emails"],
    [{ owner: { pronouns: "it" } }, "owner.pronouns"], [{ owner: { name: 42 } }, "owner.name"], [{ owner: { name: "two\nlines" } }, "owner.name"],
    [{ microsoft: { account: "nobody" } }, "microsoft.account"], [{ product: "x" }, "product must be an object"],
    [{ backup: { localOnlyRepos: ["../outside"] } }, "localOnlyRepos"], [{ vault: { indexExclude: ["--all"] } }, "indexExclude"],
    [{ settingsFile: 7 }, "settingsFile"], [{ updates: { repo: "a/b/c" } }, "updates.repo"], [{ updates: { repo: "x; rm" } }, "updates.repo"],
  ] as const) {
    write(f, value);
    expect(load).toThrow(message);
  }
});

test("settings file: loadConfig reads it and saveConfig writes it, keeping config.json's Microsoft ids in step", () => {
  const d = dir(), settings = join(d, "my.env"), config = join(d, "config.json");
  write(settings, "# kept comment\nMAILSYNC_SINCE_DAYS=12\nBACKUP_PUSH=false\nBRAIN_PORT=4000\n");
  write(config, { settingsFile: settings, vault: { path: "V:\\vault" }, microsoft: { clientId: "11111111-1111-1111-1111-111111111111" } });
  const previous = process.env.THIRDBRAIN_CONFIG;
  process.env.THIRDBRAIN_CONFIG = config;
  try {
    expect(loadConfig()).toMatchObject({ brainPath: "V:\\vault", clientId: "11111111-1111-1111-1111-111111111111", initialSinceDays: 12, backupPush: false, brainPort: 4000, account: "" });
    saveConfig({ MAILSYNC_MAX_THREADS: "7", MAILSYNC_CLIENT_ID: "33333333-3333-3333-3333-333333333333" });
    const body = readFileSync(settings, "utf8");
    expect(body).toContain("# kept comment");
    expect(body).toContain("MAILSYNC_MAX_THREADS=7");
    expect(JSON.parse(readFileSync(config, "utf8")).microsoft.clientId).toBe("33333333-3333-3333-3333-333333333333");
    expect(loadConfig()).toMatchObject({ maxThreadsPerRun: 7, clientId: "33333333-3333-3333-3333-333333333333" });
    expect(() => saveConfig({ BRAIN_PATH: "x" })).toThrow("Invalid configuration setting");
  } finally {
    if (previous === undefined) delete process.env.THIRDBRAIN_CONFIG; else process.env.THIRDBRAIN_CONFIG = previous;
  }
});

test("settings file parser ignores comments and blank lines", () => {
  const f = join(dir(), "s.env");
  write(f, "# c\n\nA_B=1\n  C = two words  \nlower=no\n");
  expect(readSettings(f)).toEqual({ A_B: "1", C: "two words" });
  expect(readSettings(join(dir(), "missing.env"))).toEqual({});
});

test("mailbox guard: a configured account is enforced; without one the signed-in mailbox is recorded", () => {
  expect(checkMailbox("Aisyah@Example.com", "aisyah@example.com")).toBe("ok");
  expect(() => checkMailbox("someone@else.example", "aisyah@example.com")).toThrow("run login with aisyah@example.com");
  expect(checkMailbox("aisyah@example.com", "")).toBe("record");
  expect(() => checkMailbox("", "")).toThrow("did not return");
});

let saved: string | undefined;
beforeEach(() => { saved = process.env.THIRDBRAIN_CONFIG; });
afterEach(() => { if (saved === undefined) delete process.env.THIRDBRAIN_CONFIG; else process.env.THIRDBRAIN_CONFIG = saved; });

test("config init: writes config.json from a legacy .env and flags, never overwrites by accident, never writes an invalid file", () => {
  const d = dir(), legacy = join(d, ".env"), file = join(d, "config.json");
  write(legacy, "BRAIN_PATH=D:\\Vault\nMAILSYNC_CLIENT_ID=11111111-1111-1111-1111-111111111111\nOPENAI_SECRETISH=never-copied\n");
  const out = initConfigFile({ name: "Aisyah Rahman", emails: ["Aisyah@Example.com"], org: "Contoh Sdn Bhd", role: "founder", pronouns: "she",
    settingsFile: legacy, account: "aisyah@example.com" }, file);
  expect(out).toEqual({ owner: { name: "Aisyah Rahman", emails: ["aisyah@example.com"], org: "Contoh Sdn Bhd", role: "founder", pronouns: "she" },
    vault: { path: "D:\\Vault" }, microsoft: { account: "aisyah@example.com", clientId: "11111111-1111-1111-1111-111111111111" }, settingsFile: legacy });
  expect(readFileSync(file, "utf8")).not.toContain("never-copied");
  expect(() => initConfigFile({ name: "Other" }, file)).toThrow("already exists");
  expect(() => initConfigFile({ emails: ["broken"], force: true }, file)).toThrow("owner.emails");
  expect(JSON.parse(readFileSync(file, "utf8")).owner.name).toBe("Aisyah Rahman"); // the bad init changed nothing
  expect(existsSync(`${file}.tmp`)).toBe(false);

  process.env.THIRDBRAIN_CONFIG = file;
  const shown = describeConfig(loadAppConfig(), file);
  expect(shown).toMatchObject({ configFile: file, configFileExists: true, settingsFileExists: true });
  expect(shown.settingsKeys).toEqual(["BRAIN_PATH", "MAILSYNC_CLIENT_ID", "OPENAI_SECRETISH"]);
  expect(JSON.stringify(shown)).not.toContain("never-copied"); // keys only, never values
});

test("config.example.json is a valid configuration", () => {
  const c = loadAppConfig({ file: join(import.meta.dir, "..", "config.example.json"), env: {} });
  expect(c.owner.name).toBe("Aisyah Rahman");
  expect(c.vault.indexExclude).toContain("clients/**");
  expect(c.settingsFile).toBe(join(import.meta.dir, "..", "settings.env"));
});

test("config init: --client-id and --tenant-id are written to config.json and must be UUIDs", () => {
  const d = dir(), file = join(d, "config.json"), empty = join(d, "none.env");
  const client = "22222222-2222-2222-2222-222222222222", tenant = "33333333-3333-3333-3333-333333333333";
  expect(initConfigFile({ vault: "C:\Users\you\Brain", clientId: client, tenantId: tenant, settingsFile: empty }, file))
    .toMatchObject({ microsoft: { clientId: client, tenantId: tenant } });
  expect(loadAppConfig({ file, stateDir: d, env: {} }).microsoft).toMatchObject({ clientId: client, tenantId: tenant });
  expect(() => initConfigFile({ clientId: "not-a-uuid", force: true }, file)).toThrow("--client-id");
  expect(() => initConfigFile({ tenantId: "contoso.com", force: true }, file)).toThrow("--tenant-id");
  expect(JSON.parse(readFileSync(file, "utf8")).microsoft.clientId).toBe(client); // the bad init changed nothing
});

test("portal port: 58432 unless THIRDBRAIN_PORT names another valid port", () => {
  expect(portalPort({})).toBe(58432);
  expect(portalPort({ THIRDBRAIN_PORT: "" })).toBe(58432);
  expect(portalPort({ THIRDBRAIN_PORT: "58500" })).toBe(58500);
  for (const bad of ["80", "70000", "58500x", "-1", "5.5"]) expect(() => portalPort({ THIRDBRAIN_PORT: bad })).toThrow("THIRDBRAIN_PORT");
});
