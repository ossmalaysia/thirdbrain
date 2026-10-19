// Stage 6: Knowledge -> markdown note (templates/note.md shape). Pure.
import type { Knowledge, Note, Source, Thread } from "../types.ts";
import { findSecret } from "./secrets.ts";

export const OUTPUT_DIR = "inbox/email/threads";

/** Per-source note placement and wording. Email keeps its original paths and labels. */
export const SOURCE_STYLE: Record<Source, { dir: string; kind: string; source: string; tag: string; link: string; unit: string }> = {
  "email": { dir: OUTPUT_DIR, kind: "email-thread", source: "outlook-sync", tag: "email", link: "Open in Outlook", unit: "thread" },
  "teams-chat": { dir: "inbox/teams/chats", kind: "teams-chat", source: "teams-sync", tag: "teams", link: "Open in Teams", unit: "chat" },
  "teams-channel": { dir: "inbox/teams/channels", kind: "teams-channel-thread", source: "teams-sync", tag: "teams", link: "Open in Teams", unit: "channel thread" },
  "meeting": { dir: "inbox/meetings", kind: "meeting", source: "meeting-sync", tag: "meeting", link: "Open meeting", unit: "meeting" },
  "ai-chat": { dir: "inbox/ai/claude", kind: "ai-conversation", source: "claude-ai-sync", tag: "ai-chat", link: "Open in Claude", unit: "conversation" },
  "chatgpt-chat": { dir: "inbox/ai/chatgpt", kind: "ai-conversation", source: "chatgpt-sync", tag: "ai-chat", link: "Open in ChatGPT", unit: "conversation" },
  "gmail": { dir: "inbox/email/gmail", kind: "email-thread", source: "gmail-sync", tag: "email", link: "Open in Gmail", unit: "thread" },
};
export const styleOf = (thread: Thread) => SOURCE_STYLE[thread.items[0]?.source ?? "email"];

export function slugify(s: string, max = 60): string {
  const slug = s
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^(re|fw|fwd|aw)\s*:\s*/gi, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug.slice(0, max).replace(/-+$/, "") || "untitled");
}

const q = (s: string) => JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars

export function notePath(thread: Thread, title: string): string {
  const first = thread.items[0].at.slice(0, 10); // YYYY-MM-DD
  return `${styleOf(thread).dir}/${first.slice(0, 7)}/${first}-${slugify(title)}.md`;
}

export function renderThreadNote(
  thread: Thread,
  k: Knowledge,
  opts: { relPath?: string; today: string },
): Note | { blocked: string } {
  const last = thread.items[thread.items.length - 1];
  const previous = thread.existingNote?.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const previousCreated = previous.match(/^created: (\d{4}-\d{2}-\d{2})\s*$/m)?.[1];
  const previousLast = previous.match(/^last_message: (\d{4}-\d{2}-\d{2}T[^\r\n]+)$/m)?.[1];
  const incomingCreated = thread.items[0].at.slice(0, 10);
  const created = previousCreated && previousCreated < incomingCreated ? previousCreated : incomingCreated;
  const lastMessage = previousLast && previousLast > last.at ? previousLast : last.at;
  const relPath = opts.relPath ?? notePath(thread, k.title);
  const style = styleOf(thread);
  const project = thread.items.find(i => i.project)?.project, account = thread.items.find(i => i.account)?.account;
  const tags = [style.tag, ...(account ? [`account/${slugify(account.label, 40)}`] : []), ...(project ? [`project/${slugify(project.name, 40)}`] : []), ...(k.client ? [`client/${slugify(k.client, 40)}`] : []), ...k.tags.map(t => slugify(t, 30))];
  const uniqueTags = [...new Set(tags)];

  const fm = [
    "---",
    `title: ${q(k.title)}`,
    `created: ${created}`,
    `source: ${style.source}`,
    `status: draft`,
    `last_verified: ${opts.today}`,
    `tags: [${uniqueTags.map(q).join(", ")}]`,
    `aliases: []`,
    `kind: ${style.kind}`,
    `client: ${k.client ? q(slugify(k.client, 40)) : "null"}`,
    ...(account ? [`account: ${q(account.label)}`] : []),
    ...(project ? [`project: ${q(project.name)}`] : []),
    `conversation_id: ${q(thread.id)}`,
    `outlook_link: ${q(last.url)}`,
    `last_message: ${lastMessage}`,
    "---",
  ].join("\n");

  const detail: string[] = [];
  for (const d of k.decisions) detail.push(`- **Decision:** ${d.what} (${[d.when, ...d.who].filter(Boolean).join(", ")})`);
  // The model often ends `what` with a full stop already; don't add a second one ("system.. Status").
  for (const c of k.commitments) detail.push(`- **Commitment (${c.owner} → ${c.to}):** ${c.what.replace(/[.\s]+$/, "")}${c.due ? `, due ${c.due}` : ""}. Status: ${c.status}`);
  // GBrain's timeline format (`- **YYYY-MM-DD** — text`, see timeline-citations.ts TIMELINE_LINE_RE), so `gbrain extract timeline` reads it.
  for (const e of k.events) detail.push(`- **${e.date}** — ${e.what}`);

  // Attachments: this run's files plus those listed in the existing note (a re-extraction only sees new mail).
  const kb = (n: number) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  const listed = new Map<string, string>();
  for (const line of thread.existingNote?.match(/## Attachments\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/)?.[1]?.split(/\r?\n/) ?? [])
    if (line.startsWith("- ")) listed.set(line.match(/^- \*\*(.+?)\*\*/)?.[1] ?? line, line);
  for (const item of thread.items) for (const a of item.attachments ?? [])
    listed.set(a.name, `- **${a.name}** (${kb(a.size)}): ${a.status === "read" ? "read into this note" : `not read, ${a.reason}`}`);
  const attachments = [...listed.values()];

  const people = k.people.map(p => `- ${p.name}${p.email ? ` <${p.email}>` : ""}${[p.role, p.org].filter(Boolean).length ? ` · ${[p.role, p.org].filter(Boolean).join(", ")}` : ""}`);

  const body = [
    `# ${k.title}`,
    "",
    "## Summary",
    k.summary,
    "",
    "## Detail",
    detail.length ? detail.join("\n") : "_No decisions or commitments._",
    "",
    "## Why",
    k.why?.trim() || `_Not stated in the ${style.unit}._`,
    "",
    "## People",
    people.length ? people.join("\n") : "_None recorded._",
    "",
    ...(attachments.length ? ["## Attachments", ...attachments, ""] : []),
    "## Links",
    last.url ? `- [${style.link}](${last.url})` : "_No link available._",
    ...(project ? [`- [Project: ${project.name.replace(/[[\]]/g, "")}](https://claude.ai/project/${encodeURIComponent(project.id)})`] : []),
    "",
  ].join("\n");

  const content = `${fm}\n\n${body}`;
  // IDs and links are code-generated, not AI text; scanning them only causes false hits.
  // Scan every model field, including credentials hidden inside model-generated URLs.
  // The adapter's actual Outlook URL and conversation ID never enter this scan.
  const secret = findSecret(JSON.stringify(k));
  if (secret) return { blocked: `secret:${secret}` };
  return { relPath, content };
}
