// Portal "Settings" > note extraction: which AI provider writes notes, its model, and its sign-in or API key.
import { createChatGptAuth, type ChatGptAuth, type ChatGptStatus } from "./chatgpt-auth.ts";
import { fetchModels } from "./core/chatgpt.ts";
import { codexCommand } from "./core/extract.ts";
import { DEFAULT_MODELS, testProvider, type Provider } from "./core/providers.ts";
import { keyHint, loadKeys, saveKey, type KeyProvider } from "./keys.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig, saveConfig, STATE_DIR, type Config } from "./state.ts";
import { atomicJson, readJson } from "../docker/scheduler.mjs";
import { testTypesafe, TYPESAFE_DEFAULT_MODEL, type DecisionProvider } from "./core/decision.ts";

export const MODEL_KEYS: Record<Provider, string> = { codex: "MAILSYNC_MODEL", openai: "MAILSYNC_OPENAI_MODEL", anthropic: "MAILSYNC_ANTHROPIC_MODEL" };

export interface AiStatus {
  provider: Provider;
  models: Record<Provider, string>; defaults: Record<Provider, string>;
  keys: Record<KeyProvider, string | null>;
  /** The portal's own ChatGPT sign-in; `cliSignedIn` is the Codex CLI login used as a fallback until then. */
  chatgpt: ChatGptStatus & { cliSignedIn: boolean | null; models: string[] };
  /** Decision model (docs/decision-model.md): provider, model and the last successful test. */
  decision: { provider: DecisionProvider; model: string; defaultModel: string; lastTest: { ok: boolean; at: string; message: string } | null };
}
export interface AiService {
  status: () => Promise<AiStatus>;
  save: (provider: Provider, model: string) => void;
  setKey: (provider: KeyProvider, key: string | null) => void;
  test: (provider: Provider) => Promise<string>;
  chatgptLogin: () => { url: string; started: boolean };
  chatgptSignOut: () => void;
  saveDecision: (provider: DecisionProvider, model: string) => void;
  testDecision: () => Promise<string>;
}

async function codexCliSignedIn(): Promise<boolean | null> {
  try {
    const child = Bun.spawn([...codexCommand(), "login", "status"], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const timer = setTimeout(() => child.kill(), 15_000);
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    return code === 0 && /^logged in/im.test(out + err) && !/not logged in/i.test(out + err);
  } catch { return null; } // Codex not installed or not runnable
}

/** Names what is listening on a port: a Docker container if one publishes it, else the Windows process. */
function portHolder(port: number): string | null {
  const run = (cmd: string[]) => { try { const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 10_000 }); return p.exitCode === 0 ? p.stdout.toString().trim() : ""; } catch { return ""; } };
  const container = run(["docker", "ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"]).split(/\r?\n/)[0];
  if (container) return `the Docker container "${container}" (run: docker stop ${container})`;
  const name = run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop)[0].OwningProcess).ProcessName`]);
  return name ? `the program "${name}"` : null;
}

/** Caches a slow lookup for `ttl` ms; failures cache the fallback so polling never hammers the backend. */
function every<T>(ttl: number, load: () => Promise<T>, fallback: T) {
  let hit: { at: number; value: T } | null = null;
  return Object.assign(async () => {
    if (!hit || Date.now() - hit.at > ttl) hit = { at: Date.now(), value: await load().catch(() => fallback) };
    return hit.value;
  }, { reset: () => { hit = null; } });
}

/** The last decision-model test survives a portal restart; it counts only for the same key and model. */
export const DECISION_TEST_FILE = () => join(STATE_DIR, "decision-test.json");
type DecisionTest = { ok: boolean; at: string; message: string; key: string | null; model: string };
const decisionModelOf = (cfg: Config) => cfg.decisionModel || TYPESAFE_DEFAULT_MODEL;
/** A short one-way fingerprint: names which key was tested without storing the key. */
const keyId = (key: string | undefined | null) => key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : null;
function lastDecisionTest(cfg: Config, keyNow: string | null): AiStatus["decision"]["lastTest"] {
  const t = readJson(DECISION_TEST_FILE(), null) as DecisionTest | null;
  if (!t || t.key !== keyNow || t.model !== decisionModelOf(cfg)) return null; // new key or model: test again
  return { ok: t.ok, at: t.at, message: t.message };
}
function saveDecisionTest(t: Omit<DecisionTest, "key" | "model">) {
  try { atomicJson(DECISION_TEST_FILE(), { ...t, key: keyId(loadKeys().typesafe), model: decisionModelOf(loadConfig()) }); } catch { /* shown again after the next test */ }
}

const modelsOf = (cfg: Config): Record<Provider, string> => ({ codex: cfg.model, openai: cfg.openaiModel ?? "", anthropic: cfg.anthropicModel ?? "" });

export function createAiService(chatgpt: ChatGptAuth = createChatGptAuth(), fetchImpl: typeof fetch = fetch): AiService {
  const cli = every(30_000, codexCliSignedIn, null);
  const models = every(10 * 60_000, async () => chatgpt.signedIn() ? (await fetchModels(await chatgpt.backendAuth())).map(m => m.id) : [], [] as string[]);
  return {
    status: async () => {
      const cfg = loadConfig(), keys = loadKeys(), sign = chatgpt.status();
      return { provider: cfg.provider ?? "codex", models: modelsOf(cfg), defaults: DEFAULT_MODELS,
        keys: { openai: keyHint(keys.openai), anthropic: keyHint(keys.anthropic), typesafe: keyHint(keys.typesafe) },
        chatgpt: { ...sign, cliSignedIn: sign.signedIn ? null : await cli(), models: sign.signedIn ? await models() : [] },
        decision: { provider: cfg.decisionProvider ?? "off", model: cfg.decisionModel ?? "", defaultModel: TYPESAFE_DEFAULT_MODEL, lastTest: lastDecisionTest(cfg, keyId(keys.typesafe)) } };
    },
    saveDecision: (provider, model) => saveConfig({ MAILSYNC_DECISION_PROVIDER: provider, MAILSYNC_DECISION_MODEL: model.trim() }),
    testDecision: async () => {
      const key = loadKeys().typesafe;
      if (!key) throw new Error("Save a TypeSafe API key first.");
      try {
        const { message } = await testTypesafe(key, decisionModelOf(loadConfig()), fetchImpl);
        saveDecisionTest({ ok: true, at: new Date().toISOString(), message });
        return message;
      } catch (e) {
        saveDecisionTest({ ok: false, at: new Date().toISOString(), message: e instanceof Error ? e.message : "Test failed." });
        throw e;
      }
    },
    save: (provider, model) => saveConfig({ MAILSYNC_PROVIDER: provider, [MODEL_KEYS[provider]]: model.trim() }),
    setKey: (provider, key) => saveKey(provider, key),
    test: async provider => {
      if (provider === "codex") {
        const sign = chatgpt.status();
        if (sign.signingIn) throw new Error("Sign-in is still open in your browser. Finish it there first.");
        if (sign.signedIn || sign.expired) {
          const list = await fetchModels(await chatgpt.backendAuth()); // refreshes the token if needed; proves the sign-in works
          models.reset();
          return `Signed in to ChatGPT${sign.email ? ` as ${sign.email}` : ""}. ${list.length} models available; Auto uses ${list[0].id}.`;
        }
        if (await codexCliSignedIn()) return "Using the Codex CLI sign-in for now. Sign in with ChatGPT here to let the portal manage it.";
        throw new Error("Not signed in. Use Sign in with ChatGPT.");
      }
      const key = loadKeys()[provider];
      if (!key) throw new Error("Add an API key first.");
      return testProvider(provider, key, modelsOf(loadConfig())[provider]);
    },
    chatgptLogin: () => {
      try { const r = chatgpt.startLogin(); models.reset(); return r; }
      catch (e) {
        // ChatGPT only redirects to localhost:1455, so whoever holds that port receives the sign-in code.
        const holder = e instanceof Error && /Port 1455/.test(e.message) ? portHolder(1455) : null;
        throw holder ? new Error(`Port 1455 is taken by ${holder}, so ChatGPT's sign-in reply would go there instead of this portal. Free that port, then sign in again.`) : e;
      }
    },
    chatgptSignOut: () => { chatgpt.signOut(); models.reset(); cli.reset(); },
  };
}
