import { expect, test } from "bun:test";
import { htmlToText, pullChats, pullMeetings, pullChannels, vttToText, type TeamsDeps } from "../src/adapters/teams.ts";
import { classify } from "../src/core/filter.ts";
import { notePath, renderThreadNote } from "../src/core/render.ts";
import { buildPrompt } from "../src/core/extract.ts";
import { runOnce } from "../src/pipeline.ts";
import { PermissionNeededError } from "../src/adapters/graph.ts";
import { item, knowledge } from "./fixtures.ts";

const ME = { id: "me-id", name: "Aisyah Rahman", email: "aisyah@example.com" };
const NOW = Date.parse("2026-10-15T12:00:00Z");

/** Fake Graph: answers by URL prefix; records every URL asked. */
function fakeGraph(routes: Record<string, unknown>, text: Record<string, string> = {}) {
  const asked: string[] = [];
  const find = (url: string, table: Record<string, unknown>) => Object.entries(table).find(([k]) => url.startsWith(k))?.[1];
  const d: TeamsDeps = { me: ME, now: () => NOW,
    get: async url => { asked.push(url); const v = find(url, routes); if (v instanceof Error) throw v; return v ?? { value: [] }; },
    getText: async url => { asked.push(url); return String(find(url, text) ?? ""); } };
  return { d, asked };
}

test("Teams HTML and transcripts become readable text", () => {
  expect(htmlToText('<p>Hi <at id="0">Mei Ling</at>,</p><p>see <a href="https://x.example/doc">the doc</a>&nbsp;&amp; reply</p><ul><li>one</li></ul>'))
    .toBe("Hi Mei Ling,\nsee the doc (https://x.example/doc) & reply\n- one");
  expect(vttToText("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Aisyah Rahman>Let's agree the price.</v>\n\n00:00:03.000 --> 00:00:05.000\n<v Aisyah Rahman>RM 8,000.</v>\n\n00:00:05.000 --> 00:00:06.000\n<v Mei Ling Tan>Agreed.</v>"))
    .toBe("Aisyah Rahman: Let's agree the price. RM 8,000.\nMei Ling Tan: Agreed.");
});

test("chats: only chats active since the watermark; meeting chats and system messages skipped; own messages marked", async () => {
  const { d, asked } = fakeGraph({
    "/me/chats?": { value: [
      { id: "c1", chatType: "oneOnOne", webUrl: "https://teams/c1", lastMessagePreview: { createdDateTime: "2026-10-15T10:00:00Z" },
        members: [{ userId: "me-id", displayName: "Aisyah Rahman", email: "aisyah@example.com" }, { userId: "u2", displayName: "Mei Ling Tan", email: "meiling@acme.example" }] },
      { id: "old", chatType: "group", lastMessagePreview: { createdDateTime: "2026-10-01T10:00:00Z" }, members: [] },
      { id: "m1", chatType: "meeting", lastMessagePreview: { createdDateTime: "2026-10-15T10:00:00Z" }, members: [] },
    ] },
    "/me/chats/c1/messages": { value: [
      { id: "1", messageType: "message", createdDateTime: "2026-10-15T09:00:00Z", from: { user: { id: "u2", displayName: "Mei Ling Tan" } }, body: { contentType: "html", content: "<p>Can you send the quote?</p>" } },
      { id: "2", messageType: "message", createdDateTime: "2026-10-15T09:05:00Z", from: { user: { id: "me-id" } }, body: { contentType: "text", content: "Sending today." } },
      { id: "3", messageType: "systemEventMessage", createdDateTime: "2026-10-15T09:06:00Z", body: { content: "<systemEvent/>" } },
    ] },
  });
  const { items, next } = await pullChats(d, "2026-10-14T00:00:00Z", "2026-09-15T00:00:00Z");
  expect(items.map(i => [i.threadId, i.folder, i.text, i.source])).toEqual([
    ["chat:c1", "received", "Can you send the quote?", "teams-chat"], ["chat:c1", "sentitems", "Sending today.", "teams-chat"]]);
  expect(items[0].subject).toBe("Chat with Mei Ling Tan");
  expect(items[0].from).toEqual({ name: "Mei Ling Tan", email: "meiling@acme.example" });
  expect(asked.some(u => u.includes("/me/chats/old/") || u.includes("/me/chats/m1/"))).toBe(false);
  expect(next).toBe("2026-10-15T12:00:00Z");
});

test("channels: changed posts with their replies form one thread per post", async () => {
  const { d } = fakeGraph({
    "/me/joinedTeams": { value: [{ id: "t1", displayName: "Delivery" }] },
    "/teams/t1/members": { value: [] },
    "/teams/t1/channels?": { value: [{ id: "ch1", displayName: "General", webUrl: "https://teams/ch1" }] },
    "/teams/t1/channels/ch1/messages/delta": { value: [{ id: "p1", messageType: "message", subject: "Release plan", createdDateTime: "2026-10-15T08:00:00Z", from: { user: { id: "u2", displayName: "Ali" } }, body: { contentType: "text", content: "Ship Friday?" } }] },
    "/teams/t1/channels/ch1/messages/p1/replies": { value: [{ id: "r1", messageType: "message", createdDateTime: "2026-10-15T08:10:00Z", from: { user: { id: "me-id", displayName: "Aisyah" } }, body: { contentType: "text", content: "Yes, Friday." } }] },
  });
  const { items } = await pullChannels(d, undefined, "2026-09-15T00:00:00Z");
  expect(items.map(i => [i.threadId, i.text])).toEqual([["channel:ch1:p1", "Ship Friday?"], ["channel:ch1:p1", "Yes, Friday."]]);
  expect(items[0].subject).toBe("Delivery / General: Release plan");
});

test("meetings: finished meetings with transcript and chat; cancelled, all-day, solo and unfinished ones skipped", async () => {
  const ev = (id: string, extra: object) => ({ id, subject: `Meeting ${id}`, start: { dateTime: "2026-10-15T09:00:00.0000000" }, end: { dateTime: "2026-10-15T10:00:00.0000000" },
    organizer: { emailAddress: { name: "Aisyah Rahman", address: "aisyah@example.com" } },
    attendees: [{ emailAddress: { name: "Mei Ling Tan", address: "meiling@acme.example" } }], ...extra });
  const { d } = fakeGraph({
    "/me/calendarView": { value: [
      ev("e1", { isOnlineMeeting: true, onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" } }),
      ev("cancelled", { isCancelled: true }), ev("allday", { isAllDay: true }), ev("solo", { attendees: [] }),
      ev("later", { end: { dateTime: "2026-10-15T11:55:00.0000000" } }),
    ] },
    "/me/onlineMeetings?": { value: [{ id: "om1", chatInfo: { threadId: "19:meeting" } }] },
    "/me/onlineMeetings/om1/transcripts?": { value: [] },
    "/me/onlineMeetings/om1/transcripts": { value: [{ id: "tr1" }] },
    "/me/chats/19%3Ameeting/messages": { value: [{ messageType: "message", createdDateTime: "2026-10-15T09:30:00Z", from: { user: { displayName: "Mei Ling Tan" } }, body: { contentType: "text", content: "Slides attached" } }] },
  }, { "/me/onlineMeetings/om1/transcripts/tr1/content": "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Mei Ling Tan>We accept RM 8,000.</v>" });
  const { items, next } = await pullMeetings(d, undefined, "2026-09-15T00:00:00Z");
  expect(items.map(i => i.threadId)).toEqual(["meeting:e1"]);
  const m = items[0];
  expect(m).toMatchObject({ id: "meeting:e1:1", source: "meeting", folder: "sentitems", subject: "Meeting e1", url: "https://teams.microsoft.com/l/meetup-join/x" });
  expect(m.text).toContain("Transcript:\nMei Ling Tan: We accept RM 8,000.");
  expect(m.text).toContain("Meeting chat:\nMei Ling Tan: Slides attached");
  expect(next).toBe("2026-10-15T11:50:00Z"); // 10 minutes settle time
});

test("a meeting without transcript still yields a note record, and a later transcript gets a new id", async () => {
  const base = { "/me/calendarView": { value: [{ id: "e2", subject: "Kickoff", start: { dateTime: "2026-10-15T08:00:00" }, end: { dateTime: "2026-10-15T09:00:00" },
    organizer: { emailAddress: { name: "Ali", address: "ali@x.example" } }, attendees: [{ emailAddress: { name: "Ali", address: "ali@x.example" } }], bodyPreview: "Agenda: scope" }] } };
  const { items } = await pullMeetings(fakeGraph(base).d, undefined, "2026-09-15T00:00:00Z");
  expect(items[0].id).toBe("meeting:e2:0");
  expect(items[0].text).toContain("No transcript was recorded");
  expect(items[0].text).toContain("Agenda / invite text: Agenda: scope");
});

test("email-only noise rules don't apply to Teams; secrets are still caught", () => {
  const teams = item({ source: "teams-chat", folder: "received", from: { name: "Bot", email: "no-reply@x.example" }, subject: "Invitation: sync", text: "click unsubscribe" });
  expect(classify(teams, { muted: [] })).toBeNull();
  expect(classify(item({ source: "meeting", text: "password: hunter2xyz Pa55word!" }), { muted: [] })).not.toBeNull();
});

test("notes land in their own folders with Teams/meeting wording", () => {
  const thread = (source: "teams-chat" | "meeting") => ({ id: source === "meeting" ? "meeting:e1" : "chat:c1", items: [item({ source, url: "https://teams/x", at: "2026-10-15T09:00:00Z" })], existingNote: null });
  expect(notePath(thread("teams-chat"), "IAQ workshop")).toBe("inbox/teams/chats/2026-10/2026-10-15-iaq-workshop.md");
  expect(notePath(thread("meeting"), "IAQ workshop")).toBe("inbox/meetings/2026-10/2026-10-15-iaq-workshop.md");
  const note = renderThreadNote(thread("meeting"), knowledge(), { today: "2026-10-15" }) as { content: string };
  expect(note.content).toContain("source: meeting-sync"); expect(note.content).toContain("kind: meeting");
  expect(note.content).toContain("[Open meeting](https://teams/x)"); expect(note.content).toContain('tags: ["meeting"');
  expect(buildPrompt(thread("meeting"))).toStartWith("Source: meeting");
});

test("a Teams permission problem is reported and email still syncs", async () => {
  const cfg = { brainPath: "x", clientId: "c", tenantId: "t", model: "", maxThreadsPerRun: 5, initialSinceDays: 10 };
  const state = { cursors: {}, threads: {}, queue: [], muted: [], lastRun: null, lookbackDays: 10 } as never;
  const { report } = await runOnce(cfg, state, {
    folders: ["inbox", "teams:chats"], optionalFeed: f => f === "teams:chats",
    pull: async f => { if (f === "teams:chats") throw new PermissionNeededError("Teams and meetings need permission"); return { items: [item()], next: "rescan" }; },
    extract: async () => ({ knowledge: knowledge({ keep: false }), costUsd: 0 }), commit: () => ({ committed: true, indexed: true, detail: "" }),
    log: () => {}, today: "2026-10-15",
  }, { dryRun: true, limit: 5, outRoot: "x" });
  expect(report.pulled).toBe(1); // email still read
  expect(report.feedErrors).toEqual({ "teams:chats": "Teams and meetings need permission" });
  expect(report.error).toBeNull();
});

test("one refused chat is skipped; only if every chat is refused does the source report a problem", async () => {
  const chat = (id: string) => ({ id, chatType: "group", lastMessagePreview: { createdDateTime: "2026-10-15T10:00:00Z" }, members: [] });
  const ok = { value: [{ id: "1", messageType: "message", createdDateTime: "2026-10-15T09:00:00Z", from: { user: { id: "u2", displayName: "Ali" } }, body: { contentType: "text", content: "hello" } }] };
  const some = fakeGraph({ "/me/chats?": { value: [chat("blocked"), chat("fine")] }, "/me/chats/blocked/": new PermissionNeededError("403"), "/me/chats/fine/": ok });
  expect((await pullChats(some.d, undefined, "2026-09-15T00:00:00Z")).items.map(i => i.threadId)).toEqual(["chat:fine"]);
  const all = fakeGraph({ "/me/chats?": { value: [chat("blocked")] }, "/me/chats/blocked/": new PermissionNeededError("403") });
  await expect(pullChats(all.d, undefined, "2026-09-15T00:00:00Z")).rejects.toBeInstanceOf(PermissionNeededError);
});
