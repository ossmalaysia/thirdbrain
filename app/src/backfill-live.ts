// Live samplers for the backfill estimate: list rows only (update times), never chat content.
import { sampleUpdates } from "./backfill.ts";
import { CHATGPT_FEED, chatgptApi, iso, PAGE as CHATGPT_PAGE, type ChatGptApi, type ConvRow } from "./adapters/chatgpt-web.ts";
import { PAGE as CLAUDE_PAGE, type ChatRow } from "./adapters/claude-web.ts";
import { createChatGptAuth } from "./chatgpt-auth.ts";
import { listAccounts } from "./claude-web/accounts.ts";
import { readClaudeBrowser } from "./claude-web/connector.ts";
import { browserApi, type ClaudeApi } from "./claude-web/session.ts";
import { loadState } from "./state.ts";
import { GMAIL_FEED, openGmail } from "./adapters/gmail-imap.ts";
import { loadGmail, sampleGmail } from "./gmail.ts";
import { existsSync } from "node:fs";
import { WHATSAPP_FEED } from "./adapters/whatsapp-feed.ts";
import { openWhatsAppStore, WA_DB, type WhatsAppStore } from "./adapters/whatsapp-store.ts";
import { activeChats, readWaSettings, type WaSettings } from "./whatsapp.ts";

/** ChatGPT: one or two list pages. The list's `total` is fake, so density decides when the pages run out first. */
export const sampleChatGpt = (api: ChatGptApi, stopBefore: string, maxPages = 2) =>
  sampleUpdates(async offset => {
    const page = await api.get<{ items?: ConvRow[] }>(`/backend-api/conversations?offset=${offset}&limit=${CHATGPT_PAGE}&order=updated`);
    const items = page.items ?? [];
    return { rows: items.map(r => iso(r.update_time)).filter(Boolean), more: items.length === CHATGPT_PAGE };
  }, stopBefore, maxPages, CHATGPT_PAGE);

/** Claude.ai: chat organisations, newest first, at most `maxPages` list pages in total. */
export async function sampleClaude(api: ClaudeApi, stopBefore: string, maxPages = 20): Promise<{ updated: string[]; complete: boolean }> {
  const orgs = (await api.get<{ uuid?: string; capabilities?: string[] }[]>("/api/organizations"))
    .filter(o => o.uuid && (!o.capabilities || o.capabilities.includes("chat")));
  const per = Math.max(1, Math.floor(maxPages / Math.max(1, orgs.length)));
  const updated: string[] = [];
  let complete = true;
  for (const org of orgs) {
    const r = await sampleUpdates(async offset => {
      const page = await api.get<{ data?: ChatRow[]; has_more?: boolean }>(`/api/organizations/${org.uuid}/chat_conversations_v2?limit=${CLAUDE_PAGE}&offset=${offset}`);
      return { rows: (page.data ?? []).map(c => String(c.updated_at ?? "")).filter(Boolean), more: !!page.has_more };
    }, stopBefore, per, CLAUDE_PAGE);
    updated.push(...r.updated);
    complete &&= r.complete;
  }
  return { updated: updated.sort().reverse(), complete };
}

/** ChatGPT after its first listing: the cursor holds every changed chat not read yet (exact). That is precisely the
 *  usage still to come, which sampling recent pages badly underestimates for heavy older use (546 vs ~1,700 seen). */
export function pendingChatGpt(cursor: string | undefined): { updated: string[]; complete: boolean } | null {
  try {
    const c = cursor ? JSON.parse(cursor) as { pending?: { u?: string }[] } : null;
    return c?.pending ? { updated: c.pending.map(p => p.u ?? "").filter(Boolean).sort().reverse(), complete: true } : null;
  } catch { return null; }
}

/** WhatsApp: one row per chat and month (one note each) in the chats that become notes, from the local store. */
export function sampleWhatsApp(store: WhatsAppStore, settings: WaSettings, stopBefore: string): { updated: string[]; complete: boolean } {
  const on = new Set(activeChats(settings, store.chats().map(c => c.jid)));
  return { updated: store.chatMonths(stopBefore).filter(m => on.has(m.jid)).map(m => m.lastAt), complete: true };
}

/** null when the feed's account is not signed in (the dialog then shows per-chat figures only). */
export async function liveSample(feed: string, stopBefore: string) {
  if (feed === WHATSAPP_FEED) {
    if (!existsSync(WA_DB)) return null;
    const store = openWhatsAppStore();
    try { return sampleWhatsApp(store, readWaSettings(), stopBefore); } finally { store.close(); }
  }
  if (feed === GMAIL_FEED) { const account = loadGmail(); return account ? sampleGmail(() => openGmail(account), stopBefore) : null; }
  if (feed === CHATGPT_FEED) {
    const auth = createChatGptAuth();
    if (!auth.signedIn()) return null;
    return pendingChatGpt(loadState().cursors?.[CHATGPT_FEED]) ?? sampleChatGpt(chatgptApi(auth), stopBefore);
  }
  const account = listAccounts().find(a => a.feed === feed);
  const browser = account ? readClaudeBrowser(account.file) : null;
  return browser?.connected ? sampleClaude(browserApi(browser.port), stopBefore) : null;
}
