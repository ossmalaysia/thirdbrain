import { expect, test } from "bun:test";
import { emailsWithAttachments, planReprocess } from "../src/reprocess.ts";
import { item } from "./fixtures.ts";

test("old emails with attachments are queued first; chats are reset so the next run re-reads them", () => {
  const old = item({ id: "m-old", hasAttachments: true }), waiting = item({ id: "m-wait" });
  const state = { cursors: { "teams:chats": "2026-10-15T15:00:00Z", "teams:channels": "x", inbox: "rescan" }, threads: {}, queue: [waiting], muted: [], lastRun: null,
    processed: { "m-old": { fingerprint: "f", outcome: "written", at: "d" }, "teams-chat:chat:c1:1": { fingerprint: "f", outcome: "written", at: "d" }, "teams-channel:x:1": { fingerprint: "f", outcome: "written", at: "d" } } } as never;
  const plan = planReprocess(state, { emails: [old, waiting], chats: true });
  expect(plan.state.queue.map(i => i.id)).toEqual(["m-old", "m-wait"]); // no duplicate of the already-queued item
  expect(Object.keys(plan.state.processed)).toEqual(["teams-channel:x:1"]); // channels untouched
  expect(plan.state.cursors).toEqual({ "teams:channels": "x", inbox: "rescan" });
  expect(plan.chatMessages).toBe(1);
  expect(planReprocess(state, { emails: [], chats: false }).state.cursors).toEqual(state.cursors);
});

test("lists emails with attachments since the window, marking sent mail", async () => {
  const asked: string[] = [];
  const get = async (url: string) => { asked.push(url);
    if (url.startsWith("/me/mailFolders/sentitems")) return { id: "SENT" };
    return { value: [{ id: "a", conversationId: "c", receivedDateTime: "2026-10-15T01:00:00Z", parentFolderId: "SENT", hasAttachments: true, subject: "Quote", body: { content: "see attached" } },
      { id: "d", isDraft: true }] }; };
  const items = await emailsWithAttachments(get, "2026-10-06T00:00:00Z");
  expect(items.map(i => [i.id, i.folder, i.hasAttachments])).toEqual([["a", "sentitems", true]]);
  expect(decodeURIComponent(asked[1].replaceAll("+", " "))).toContain("receivedDateTime ge 2026-10-06T00:00:00Z and hasAttachments eq true");
});
