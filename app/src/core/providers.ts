// Stage 5 alternatives to Codex: the same prompt and schema through the OpenAI or Claude API.
// Errors become CodexExtractionError codes so the pipeline's retry/stop logic is provider-neutral.
// Never log or rethrow raw provider messages: they can quote private email.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Thread } from "../types.ts";
import type { Config } from "../state.ts";
import { loadKeys } from "../keys.ts";
import { createChatGptAuth, type ChatGptAuth } from "../chatgpt-auth.ts";
import { ChatGptError, CODEX_BACKEND, fetchModels, streamResponse, type BackendAuth } from "./chatgpt.ts";
import { buildPrompt, codexExtractor, CodexExtractionError, KNOWLEDGE_SCHEMA, parseKnowledge, systemPrompt, type Extractor, type PromptOwner } from "./extract.ts";
import { loadAppConfig } from "../config.ts";

export type Provider = "codex" | "openai" | "anthropic";
export const PROVIDERS: Provider[] = ["codex", "openai", "anthropic"];
export const DEFAULT_MODELS: Record<Provider, string> = { codex: "", openai: "gpt-5", anthropic: "claude-opus-5-5" };
const LABEL: Record<Exclude<Provider, "codex">, string> = { openai: "OpenAI API", anthropic: "Claude API" };

/** Shared classification for both SDKs: they expose the same typed error classes by status code. */
export function failure(provider: Exclude<Provider, "codex">, e: unknown): CodexExtractionError {
  const name = LABEL[provider];
  if (e instanceof CodexExtractionError) return e;
  const status = (e as { status?: number })?.status;
  if (status === 401 || status === 403) return new CodexExtractionError("AUTHENTICATION", `${name} key was rejected; update it in portal Settings.`);
  if (status === 429) return new CodexExtractionError("USAGE_LIMIT", `${name} rate or credit limit reached; queued emails will retry.`);
  if (status === 404) return new CodexExtractionError("MODEL_NOT_FOUND", `${name} model not found; check the model name in portal Settings.`);
  if (e instanceof Error && /timed? ?out|abort/i.test(e.name + e.message)) return new CodexExtractionError("TIMEOUT", `${name} extraction timed out; queued emails will retry.`);
  return new CodexExtractionError("PROVIDER_ERROR", `${name} could not complete extraction; queued emails will retry.`);
}
const invalid = (provider: Exclude<Provider, "codex">) => new CodexExtractionError("INVALID_OUTPUT", `${LABEL[provider]} returned an invalid extraction result; queued emails will retry.`);

export function anthropicExtractor(opts: { apiKey: string; model: string; timeoutMs?: number; owner?: PromptOwner }): Extractor {
  const client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 180_000, maxRetries: 2 });
  return async (thread: Thread) => {
    try {
      // fallbacks: "default" re-runs a safety-declined request on Anthropic's recommended model server-side.
      const response = await client.beta.messages.create({
        model: opts.model || DEFAULT_MODELS.anthropic, max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        system: systemPrompt(opts.owner),
        messages: [{ role: "user", content: buildPrompt(thread, opts.owner) }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: KNOWLEDGE_SCHEMA } },
      });
      if (response.stop_reason === "refusal") throw new CodexExtractionError("REFUSED", "Claude API declined this thread; it stays queued for another provider or a retry.");
      if (response.stop_reason === "max_tokens") throw invalid("anthropic");
      const text = response.content.flatMap(b => b.type === "text" ? [b.text] : []).join("");
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw invalid("anthropic"); }
      try {
        return { knowledge: parseKnowledge(parsed), costUsd: 0,
          usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
      } catch { throw invalid("anthropic"); }
    } catch (e) { throw failure("anthropic", e); }
  };
}

export function openaiExtractor(opts: { apiKey: string; model: string; timeoutMs?: number; owner?: PromptOwner }): Extractor {
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 180_000, maxRetries: 2 });
  return async (thread: Thread) => {
    try {
      const response = await client.responses.create({
        model: opts.model || DEFAULT_MODELS.openai, instructions: systemPrompt(opts.owner), input: buildPrompt(thread, opts.owner),
        text: { format: { type: "json_schema", name: "knowledge", schema: KNOWLEDGE_SCHEMA, strict: true } },
      });
      let parsed: unknown;
      try { parsed = JSON.parse(response.output_text); } catch { throw invalid("openai"); }
      try {
        return { knowledge: parseKnowledge(parsed), costUsd: 0,
          usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 } };
      } catch { throw invalid("openai"); }
    } catch (e) { throw failure("openai", e); }
  };
}

/** ChatGPT subscription via the portal's own sign-in (no Codex CLI). Empty model = the account's first listed model. */
export function chatgptExtractor(opts: { auth: ChatGptAuth; model: string; timeoutMs?: number; fetchImpl?: typeof fetch; retryDelayMs?: number; owner?: PromptOwner }): Extractor {
  let auto: Promise<string> | null = null;
  const pickModel = (a: BackendAuth) => opts.model || (auto ??= fetchModels(a, opts.fetchImpl).then(m => m[0].id, () => CODEX_BACKEND.fallbackModel));
  const toCode = (e: unknown) => {
    if (!(e instanceof ChatGptError)) return new CodexExtractionError("PROVIDER_ERROR", "ChatGPT could not complete extraction; queued emails will retry.");
    const code = { auth: "AUTHENTICATION", usage: "USAGE_LIMIT", request: "MODEL_NOT_FOUND", network: /timed out/.test(e.message) ? "TIMEOUT" : "PROVIDER_ERROR", blocked: "PROVIDER_ERROR", other: "PROVIDER_ERROR" }[e.kind];
    return new CodexExtractionError(code, e.message); // ChatGptError messages are fixed text, never provider output
  };
  return async (thread: Thread) => {
    try {
      let auth = await opts.auth.backendAuth();
      const request = { model: await pickModel(auth), instructions: systemPrompt(opts.owner), input: buildPrompt(thread, opts.owner), schema: KNOWLEDGE_SCHEMA, schemaName: "knowledge" };
      const send = (a: BackendAuth) => streamResponse(a, request, AbortSignal.timeout(opts.timeoutMs ?? 180_000), opts.fetchImpl);
      let result;
      try { result = await send(auth); }
      catch (e) {
        if (e instanceof ChatGptError && e.kind === "auth" && e.status === 401) {
          auth = await opts.auth.refreshAfter401(auth); // one retry with refreshed tokens
          result = await send(auth);
        } else if (e instanceof ChatGptError && (e.kind === "other" || e.kind === "network") && !/timed out/.test(e.message)) {
          // Transient backend hiccup (seen 2026-10-15: the same request succeeded minutes later). Retry once
          // instead of stopping the whole run; usage limits, rejected requests and sign-in problems still stop.
          await Bun.sleep(opts.retryDelayMs ?? 5000);
          result = await send(auth);
        } else throw e;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(result.text); } catch { throw new CodexExtractionError("INVALID_OUTPUT", "ChatGPT returned an invalid extraction result; queued emails will retry."); }
      try { return { knowledge: parseKnowledge(parsed), costUsd: 0, usage: result.usage }; }
      catch { throw new CodexExtractionError("INVALID_OUTPUT", "ChatGPT returned an invalid extraction result; queued emails will retry."); }
    } catch (e) { throw e instanceof CodexExtractionError ? e : toCode(e); }
  };
}

/** Picks the extractor configured in portal Settings. A missing key fails every thread with a clear, retryable error.
 *  ChatGPT subscription: the portal's own sign-in when present, else the Codex CLI login (so nothing breaks before you sign in). */
export function chooseExtractor(cfg: Config, cwd: string, keys = loadKeys(), chatgpt: ChatGptAuth = createChatGptAuth(), owner: PromptOwner = loadAppConfig().owner): Extractor {
  const provider = cfg.provider ?? "codex", timeoutMs = cfg.extractTimeoutMs;
  if (provider === "codex") return chatgpt.status().signedIn || chatgpt.status().expired
    ? chatgptExtractor({ auth: chatgpt, model: cfg.model, timeoutMs, owner })
    : codexExtractor({ model: cfg.model, cwd, timeoutMs, owner });
  const apiKey = keys[provider];
  if (!apiKey) return async () => { throw new CodexExtractionError("AUTHENTICATION", `${LABEL[provider]} key is missing; add it in portal Settings.`); };
  return provider === "anthropic"
    ? anthropicExtractor({ apiKey, model: cfg.anthropicModel ?? "", timeoutMs, owner })
    : openaiExtractor({ apiKey, model: cfg.openaiModel ?? "", timeoutMs, owner });
}

/** Cheap credential + model check for the portal's Test button: a model lookup, not a generation. */
export async function testProvider(provider: Exclude<Provider, "codex">, apiKey: string, model: string): Promise<string> {
  try {
    if (provider === "anthropic") await new Anthropic({ apiKey, timeout: 15_000, maxRetries: 0 }).models.retrieve(model || DEFAULT_MODELS.anthropic);
    else await new OpenAI({ apiKey, timeout: 15_000, maxRetries: 0 }).models.retrieve(model || DEFAULT_MODELS.openai);
    return `${LABEL[provider]} key works and model ${model || DEFAULT_MODELS[provider]} is available.`;
  } catch (e) { throw failure(provider, e); }
}

/** A short JSON question to the configured note writer (entity duplicate check). Null when the writer is the Codex CLI
 *  without the portal's ChatGPT sign-in: it only writes notes. Errors are fixed text, never provider output. */
export type JsonAsk = (instructions: string, input: string, schema: Record<string, unknown>, name: string) => Promise<{ value: unknown; model: string }>;
export function chooseJsonAsk(cfg: Config, keys = loadKeys(), chatgpt: ChatGptAuth = createChatGptAuth()): JsonAsk | null {
  const provider = cfg.provider ?? "codex", timeout = 120_000;
  if (provider === "codex") {
    if (!chatgpt.status().signedIn && !chatgpt.status().expired) return null;
    return async (instructions, input, schema, name) => {
      let auth = await chatgpt.backendAuth();
      const model = cfg.model || (await fetchModels(auth).then(m => m[0].id, () => CODEX_BACKEND.fallbackModel));
      const send = (a: BackendAuth) => streamResponse(a, { model, instructions, input, schema, schemaName: name }, AbortSignal.timeout(timeout));
      let r;
      try { r = await send(auth); }
      catch (e) { if (e instanceof ChatGptError && e.kind === "auth" && e.status === 401) { auth = await chatgpt.refreshAfter401(auth); r = await send(auth); } else throw new Error("ChatGPT did not answer the duplicate check."); }
      return { value: JSON.parse(r.text), model };
    };
  }
  const apiKey = keys[provider];
  if (!apiKey) return null;
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey, timeout, maxRetries: 2 }), model = cfg.anthropicModel || DEFAULT_MODELS.anthropic;
    return async (instructions, input, schema) => {
      const r = await client.messages.create({ model, max_tokens: 1000, system: instructions, messages: [{ role: "user", content: input }],
        output_config: { effort: "low", format: { type: "json_schema", schema } } } as any).catch(e => { throw failure("anthropic", e); });
      return { value: JSON.parse(r.content.flatMap(b => b.type === "text" ? [b.text] : []).join("")), model };
    };
  }
  const client = new OpenAI({ apiKey, timeout, maxRetries: 2 }), model = cfg.openaiModel || DEFAULT_MODELS.openai;
  return async (instructions, input, schema, name) => {
    const r = await client.responses.create({ model, instructions, input, text: { format: { type: "json_schema", name, schema, strict: true } } }).catch(e => { throw failure("openai", e); });
    return { value: JSON.parse(r.output_text), model };
  };
}
