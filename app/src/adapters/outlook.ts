// Bounded Graph scans. Wider lookback starts a new sweep; persistent IDs skip overlap.
import type { Config } from "../state.ts";
import type { Item } from "../types.ts";
import { graphGet } from "./graph.ts";
import { normalizeOutlook } from "./outlook-normalize.ts";

export const RESCAN = "rescan";
export interface MailFolder { id: string; kind: string; name: string }

const SELECT = "id,conversationId,receivedDateTime,sentDateTime,from,sender,toRecipients,ccRecipients,subject,body,bodyPreview,webLink,isDraft,hasAttachments";
export const HEADERS = { prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' };
type Get = (cfg: Config, url: string, headers?: Record<string, string>) => Promise<any>;

export async function listFolders(cfg: Config, get: Get = graphGet): Promise<MailFolder[]> {
  const special = await Promise.all(["junkemail", "deleteditems", "drafts", "sentitems", "inbox"].map(async kind => {
    const f = await get(cfg, `/me/mailFolders/${kind}?$select=id`, HEADERS);
    return [f.id, kind] as const;
  }));
  const kinds = new Map(special);
  const found: MailFolder[] = [];
  const seen = new Set<string>();
  async function walk(initial: string): Promise<void> {
    let url: string | undefined = initial;
    while (url) {
      const page = await get(cfg, url, HEADERS);
      for (const f of page.value ?? []) {
        if (!f.id || seen.has(f.id)) continue;
        seen.add(f.id);
        const kind = kinds.get(f.id) ?? f.id;
        if (["junkemail", "deleteditems", "drafts"].includes(kind)) continue;
        found.push({ id: f.id, kind, name: f.displayName });
        if (f.childFolderCount > 0) await walk(`/me/mailFolders/${encodeURIComponent(f.id)}/childFolders?$select=id,displayName,childFolderCount&$top=100`);
      }
      url = page["@odata.nextLink"];
    }
  }
  await walk("/me/mailFolders?$select=id,displayName,childFolderCount&$top=100");
  return found;
}

export function scanUrl(folder: string, sinceIso: string): string {
  const params = new URLSearchParams({ "$select": SELECT, "$filter": `receivedDateTime ge ${sinceIso}`,
    "$orderby": "receivedDateTime desc", "$top": "50" });
  return `/me/mailFolders/${encodeURIComponent(folder)}/messages?${params}`;
}

export async function pullFolder(cfg: Config, folder: string, cursor: string | undefined,
  sinceIso: string, kind = folder, get: Get = graphGet): Promise<{ items: Item[]; next: string }> {
  let url = cursor && cursor !== RESCAN && !cursor.includes("/delta") ? cursor : scanUrl(folder, sinceIso);
  const items: Item[] = [];
  for (let i = 0; i < (cfg.maxPagesPerFolder ?? 2); i++) {
    const page = await get(cfg, url, HEADERS);
    if (!Array.isArray(page.value)) throw new Error("Graph returned an invalid message page");
    for (const raw of page.value) {
      if (!raw.id || raw["@removed"] || raw.isDraft) continue;
      items.push(normalizeOutlook(raw, kind));
    }
    if (!page["@odata.nextLink"]) return { items, next: RESCAN };
    url = page["@odata.nextLink"];
  }
  return { items, next: url };
}
