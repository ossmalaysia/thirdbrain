// Teams chats, Teams channel threads and meetings -> source-neutral Items for the shared pipeline.
// Uses the separate Teams/meetings token (TEAMS_SCOPES); a missing permission throws PermissionNeededError,
// which the pipeline records without stopping email.
// Cursors are watermarks (ISO times); duplicates are harmless because the pipeline dedupes by id + fingerprint.
import type { Config } from "../state.ts";
import type { Item, Person, Source } from "../types.ts";
import { graphGet, graphGetText, TEAMS_SCOPES } from "./graph.ts";
import { decodeEntities, stripTags } from "../core/html-text.ts";

export const FEEDS = { chats: "teams:chats", channels: "teams:channels", meetings: "meetings" } as const;
export const isTeamsFeed = (feed: string) => Object.values(FEEDS).includes(feed as never);
const MAX_TEXT = 8000, MAX_MEETING_TEXT = 60_000, MAX_PAGES = 3;
/** Meetings are re-checked for this long after they end, because transcripts appear some minutes later. */
const TRANSCRIPT_GRACE_MS = 24 * 3600_000, MEETING_SETTLE_MS = 10 * 60_000;

type Get = (url: string, headers?: Record<string, string>) => Promise<any>;
type GetText = (url: string, headers?: Record<string, string>) => Promise<string>;
export interface TeamsDeps { get: Get; getText: GetText; me: { id: string; name: string; email: string }; now?: () => number }

export function teamsDeps(cfg: Config, me: TeamsDeps["me"]): TeamsDeps {
  return { get: (url, h) => graphGet(cfg, url, h, TEAMS_SCOPES), getText: (url, h) => graphGetText(cfg, url, h, TEAMS_SCOPES), me };
}

/** Teams message HTML -> readable plain text for a note (mentions, line breaks and links kept as text).
 *  The result is plain text, not HTML: core/html-text.ts removes every tag and decodes entities once. */
export function htmlToText(html: string): string {
  const marked = html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, "\n").replace(/<li[^>]*>/gi, "- ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href, label) => label && !href.includes(label) ? `${label} (${href})` : href)
    .replace(/<attachment[^>]*><\/attachment>/gi, "[attachment]");
  return decodeEntities(stripTags(marked)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A WebVTT cue timing line: "00:00:01.000 --> 00:00:03.000" (hours optional, cue settings may follow). */
const VTT_TIMING = /^(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d+:)?\d{2}:\d{2}[.,]\d{3}/;

/** WebVTT transcript -> "Speaker: words" lines, merging consecutive cues from the same speaker. */
export function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const block of vtt.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    const cue = block.split("\n").map(l => l.trim()).filter(l => l && !/^WEBVTT|^NOTE|^\d+$/.test(l) && !VTT_TIMING.test(l)).join(" ").trim();
    if (!cue) continue;
    const m = cue.match(/^<v ([^>]+)>(.*?)(?:<\/v>)?$/s);
    const speaker = m?.[1].trim(), words = decodeEntities(stripTags(m ? m[2] : cue)).trim();
    if (!words) continue;
    const last = lines[lines.length - 1];
    if (speaker && last?.startsWith(`${speaker}: `)) lines[lines.length - 1] = `${last} ${words}`;
    else lines.push(speaker ? `${speaker}: ${words}` : words);
  }
  return lines.join("\n");
}

const clip = (s: string, max: number) => s.length > max ? `${s.slice(0, max)}\n[truncated]` : s;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

async function pages(get: Get, first: string, max = MAX_PAGES, headers?: Record<string, string>): Promise<any[]> {
  const out: any[] = [];
  let url: string | undefined = first;
  for (let i = 0; url && i < max; i++) {
    const page = await get(url, headers);
    out.push(...(Array.isArray(page?.value) ? page.value : []));
    url = page?.["@odata.nextLink"];
  }
  return out;
}

function messageItem(raw: any, ctx: { threadId: string; subject: string; url: string; source: Source; members: Map<string, Person>; me: TeamsDeps["me"] }): Item | null {
  if (!raw?.id || raw.messageType !== "message" || raw.deletedDateTime) return null;
  const text = raw.body?.contentType === "html" ? htmlToText(String(raw.body.content ?? "")) : String(raw.body?.content ?? "").trim();
  if (!text) return null;
  const userId = raw.from?.user?.id;
  const from = ctx.members.get(userId) ?? { name: String(raw.from?.user?.displayName ?? raw.from?.application?.displayName ?? "Unknown"), email: "" };
  return {
    id: `${ctx.source}:${ctx.threadId}:${raw.id}`, threadId: ctx.threadId, at: String(raw.createdDateTime),
    from, to: [...ctx.members.entries()].filter(([id]) => id !== userId).map(([, p]) => p), cc: [],
    subject: ctx.subject, text: clip(text, MAX_TEXT), url: String(raw.webUrl ?? ctx.url ?? ""),
    folder: userId === ctx.me.id ? "sentitems" : "received", source: ctx.source,
  };
}

const memberMap = (members: any[]) => new Map<string, Person>(members.filter(m => m?.userId).map(m => [m.userId, { name: String(m.displayName ?? ""), email: String(m.email ?? "").toLowerCase() }]));

/** 1:1 and group chats with activity after the watermark (meeting chats belong to the meetings feed). */
export async function pullChats(d: TeamsDeps, cursor: string | undefined, sinceIso: string): Promise<{ items: Item[]; next: string }> {
  const now = (d.now ?? Date.now)(), since = cursor && cursor > sinceIso ? cursor : sinceIso;
  const chats = await pages(d.get, "/me/chats?$expand=members,lastMessagePreview&$top=50", 10);
  const items: Item[] = [];
  let tried = 0, refused = 0, lastError: unknown = null;
  for (const chat of chats) {
    if (chat.chatType === "meeting" || !(chat.lastMessagePreview?.createdDateTime > since)) continue;
    tried++;
    const members = memberMap(chat.members ?? []);
    const others = [...members.entries()].filter(([id]) => id !== d.me.id).map(([, p]) => p.name).filter(Boolean);
    const subject = chat.topic?.trim() || `Chat with ${others.slice(0, 4).join(", ") || "Teams contact"}`;
    const params = new URLSearchParams({ $top: "50", $orderby: "lastModifiedDateTime desc", $filter: `lastModifiedDateTime gt ${since}` });
    // One chat Microsoft won't open (e.g. another organisation's) must not hide all the others.
    let messages: any[];
    try { messages = await pages(d.get, `/me/chats/${encodeURIComponent(chat.id)}/messages?${params}`); }
    catch (e) { refused++; lastError = e; continue; }
    for (const raw of messages) {
      const item = messageItem(raw, { threadId: `chat:${chat.id}`, subject, url: chat.webUrl, source: "teams-chat", members, me: d.me });
      if (item && item.at >= sinceIso) items.push(item);
    }
  }
  if (tried && refused === tried) throw lastError; // every chat refused: a real permission problem, keep the watermark
  return { items, next: iso(now) };
}

/** Channel posts changed after the watermark, each with its replies: one thread per post. */
export async function pullChannels(d: TeamsDeps, cursor: string | undefined, sinceIso: string): Promise<{ items: Item[]; next: string }> {
  const now = (d.now ?? Date.now)(), since = cursor && cursor > sinceIso ? cursor : sinceIso;
  const items: Item[] = [];
  let tried = 0, refused = 0, lastError: unknown = null;
  for (const team of await pages(d.get, "/me/joinedTeams?$select=id,displayName", 5)) {
    const members = memberMap(await pages(d.get, `/teams/${encodeURIComponent(team.id)}/members?$top=50`, 5).catch(() => []));
    for (const channel of await pages(d.get, `/teams/${encodeURIComponent(team.id)}/channels?$select=id,displayName,webUrl`, 2)) {
      const base = `/teams/${encodeURIComponent(team.id)}/channels/${encodeURIComponent(channel.id)}/messages`;
      tried++;
      let roots: any[];
      try { roots = await pages(d.get, `${base}/delta?${new URLSearchParams({ $top: "50", $filter: `lastModifiedDateTime gt ${since}` })}`); }
      catch (e) { refused++; lastError = e; continue; } // e.g. a private channel you can't read
      for (const root of roots) {
        if (!root?.id) continue;
        const first = root.body?.contentType === "html" ? htmlToText(String(root.body.content ?? "")) : String(root.body?.content ?? "");
        const subject = `${team.displayName} / ${channel.displayName}: ${root.subject?.trim() || first.split("\n")[0].slice(0, 80) || "post"}`;
        const ctx = { threadId: `channel:${channel.id}:${root.id}`, subject, url: root.webUrl ?? channel.webUrl, source: "teams-channel" as const, members, me: d.me };
        const replies = await pages(d.get, `${base}/${encodeURIComponent(root.id)}/replies?$top=50`, 2).catch(() => []);
        for (const raw of [root, ...replies]) {
          const item = messageItem(raw, ctx);
          if (item && item.at >= sinceIso) items.push(item);
        }
      }
    }
  }
  if (tried && refused === tried) throw lastError; // every channel refused: a real permission problem
  return { items, next: iso(now) };
}

const person = (a: any): Person => ({ name: String(a?.emailAddress?.name ?? a?.emailAddress?.address ?? "").trim(), email: String(a?.emailAddress?.address ?? "").toLowerCase() });

/** Finished meetings: calendar details + transcript (when recorded) + meeting chat, one item per meeting. */
export async function pullMeetings(d: TeamsDeps, cursor: string | undefined, sinceIso: string): Promise<{ items: Item[]; next: string }> {
  const now = (d.now ?? Date.now)(), settled = now - MEETING_SETTLE_MS;
  // Re-check the last day for late transcripts; the pipeline skips anything unchanged.
  const fromMs = Math.max(Date.parse(sinceIso), cursor ? Date.parse(cursor) - TRANSCRIPT_GRACE_MS : 0);
  const params = new URLSearchParams({ startDateTime: iso(fromMs), endDateTime: iso(settled), $top: "50", $orderby: "start/dateTime",
    $select: "id,subject,start,end,isCancelled,isAllDay,isOnlineMeeting,onlineMeeting,organizer,attendees,bodyPreview,webLink" });
  const events = await pages(d.get, `/me/calendarView?${params}`, 10, { prefer: 'outlook.timezone="UTC"' });
  const items: Item[] = [];
  for (const ev of events) {
    const end = Date.parse(`${String(ev.end?.dateTime ?? "").slice(0, 19)}Z`); // Graph sends 7 fractional digits; keep seconds
    const attendees = (ev.attendees ?? []).map(person).filter((p: Person) => p.email && p.email !== d.me.email);
    if (ev.isCancelled || ev.isAllDay || !(end <= settled) || (!attendees.length && !ev.isOnlineMeeting)) continue;
    let transcript = "", chat = "", transcripts = 0;
    const joinUrl = ev.onlineMeeting?.joinUrl;
    if (joinUrl) {
      const found = await d.get(`/me/onlineMeetings?$filter=${encodeURIComponent(`JoinWebUrl eq '${joinUrl.replace(/'/g, "''")}'`)}`).catch(() => null);
      const meeting = found?.value?.[0];
      if (meeting?.id) {
        const list = await d.get(`/me/onlineMeetings/${encodeURIComponent(meeting.id)}/transcripts`).catch(() => null);
        for (const t of list?.value ?? []) {
          const vtt = await d.getText(`/me/onlineMeetings/${encodeURIComponent(meeting.id)}/transcripts/${encodeURIComponent(t.id)}/content?$format=text/vtt`).catch(() => "");
          const text = vttToText(vtt);
          if (text) { transcript += (transcript ? "\n\n" : "") + text; transcripts++; }
        }
        const threadId = meeting.chatInfo?.threadId;
        if (threadId) {
          const msgs = await pages(d.get, `/me/chats/${encodeURIComponent(threadId)}/messages?$top=50`, 2).catch(() => []);
          chat = msgs.filter(m => m?.messageType === "message" && !m.deletedDateTime)
            .sort((a, b) => String(a.createdDateTime).localeCompare(String(b.createdDateTime)))
            .map(m => `${m.from?.user?.displayName ?? "Someone"}: ${m.body?.contentType === "html" ? htmlToText(String(m.body.content ?? "")) : String(m.body?.content ?? "")}`)
            .filter(l => !l.endsWith(": ")).join("\n");
        }
      }
    }
    const organizer = person(ev.organizer);
    const text = [
      `Meeting: ${ev.subject ?? "(untitled)"}`,
      `When: ${ev.start?.dateTime?.slice(0, 16)} to ${ev.end?.dateTime?.slice(11, 16)} UTC`,
      `Organizer: ${organizer.name} <${organizer.email}>`,
      `Attendees: ${attendees.map((p: Person) => `${p.name} <${p.email}>`).join(", ") || "none listed"}`,
      ev.bodyPreview?.trim() ? `Agenda / invite text: ${ev.bodyPreview.trim()}` : "",
      transcript ? `\nTranscript:\n${transcript}` : "\nNo transcript was recorded for this meeting.",
      chat ? `\nMeeting chat:\n${chat}` : "",
    ].filter(Boolean).join("\n");
    items.push({
      id: `meeting:${ev.id}:${transcripts}`, threadId: `meeting:${ev.id}`, at: `${ev.start?.dateTime?.slice(0, 19)}Z`,
      from: organizer, to: attendees, cc: [], subject: String(ev.subject ?? "(untitled meeting)").trim(),
      text: clip(text, MAX_MEETING_TEXT), url: String(joinUrl ?? ev.webLink ?? ""),
      folder: organizer.email === d.me.email ? "sentitems" : "received", source: "meeting",
    });
  }
  return { items, next: iso(settled) };
}

export function pullTeamsFeed(feed: string, d: TeamsDeps, cursor: string | undefined, sinceIso: string) {
  if (feed === FEEDS.chats) return pullChats(d, cursor, sinceIso);
  if (feed === FEEDS.channels) return pullChannels(d, cursor, sinceIso);
  return pullMeetings(d, cursor, sinceIso);
}
