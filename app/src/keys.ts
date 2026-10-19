// API keys for the OpenAI and Claude extractors. Stored outside the vault (never committed or
// backed up to GitHub) and never returned to the browser: the portal only sees the last 4 characters.
import { join } from "node:path";
import { STATE_DIR } from "./state.ts";
import { readJson, atomicJson } from "../docker/scheduler.mjs";

export type KeyProvider = "openai" | "anthropic" | "typesafe";
export const KEYS_FILE = join(STATE_DIR, "api-keys.json");
// TypeSafe does not document a key prefix: accept any single token of key characters.
const SHAPES: Record<KeyProvider, RegExp> = { openai: /^sk-[\w-]{20,200}$/, anthropic: /^sk-ant-[\w-]{20,200}$/, typesafe: /^[\w.~+/=-]{16,300}$/ };
const NAMES: Record<KeyProvider, string> = { openai: "an OpenAI API key (it starts with sk-)", anthropic: "a Claude API key (it starts with sk-ant-)", typesafe: "a TypeSafe API key (one line, no spaces)" };

export const loadKeys = (file = KEYS_FILE): Partial<Record<KeyProvider, string>> => readJson(file, {});
export const keyHint = (key?: string) => key ? `…${key.slice(-4)}` : null;

export function saveKey(provider: KeyProvider, key: string | null, file = KEYS_FILE): void {
  if (key !== null && !SHAPES[provider].test(key.trim())) throw new Error(`That doesn't look like ${NAMES[provider]}.`);
  const keys = loadKeys(file);
  if (key === null) delete keys[provider]; else keys[provider] = key.trim();
  atomicJson(file, keys);
}
