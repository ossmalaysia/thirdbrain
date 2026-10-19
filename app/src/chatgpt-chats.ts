// ChatGPT chat sync is opt-in: the same ChatGPT sign-in also powers the note writer, so being signed in alone
// must not start reading chat history. Turned on from portal Connectors -> Add connector -> ChatGPT chats.
import { join } from "node:path";
import { STATE_DIR } from "./state.ts";
import { atomicJson, readJson } from "../docker/scheduler.mjs";

export const CHATGPT_CHATS_FILE = join(STATE_DIR, "chatgpt-chats.json");
export const chatgptChatsEnabled = (file = CHATGPT_CHATS_FILE) => (readJson(file, {}) as { enabled?: boolean }).enabled === true;
export const setChatgptChats = (enabled: boolean, file = CHATGPT_CHATS_FILE) => atomicJson(file, { enabled, changedAt: new Date().toISOString() });
