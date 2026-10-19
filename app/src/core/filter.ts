// Stage 3: drop noise and anything carrying a secret. Pure, no I/O.
import type { Dropped, Item } from "../types.ts";
import { findSecret } from "./secrets.ts";

export const NOISE_SENDER = /(^|[._-])(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|newsletters?|news|marketing|digest|updates|bounces?)([._+-]|@)/i;
const CALENDAR_SUBJECT = /^(accepted|declined|tentative|tentatively accepted|canceled|cancelled|updated invitation|invitation|new time proposed)\b.*?:/i;
const BULK_BODY = /\bunsubscribe\b|\bmanage (?:your )?(?:email )?preferences\b|\bview (?:this email )?in (?:your )?browser\b/i;
/** Gmail: services whose mail only repeats what their own site shows (GitHub alone was 75% of the owner's Important
 *  mail, 2026-10-19). Other automatic senders (banks, bookings, government, own businesses) are not dropped here:
 *  Gmail's "What to include" already narrows the mail, and the decision model judges each thread. */
export const NOTIFICATION_SERVICES = ["github.com", "linkedin.com", "facebookmail.com", "instagram.com", "x.com", "twitter.com",
  "youtube.com", "discord.com", "slack.com", "notion.so", "atlassian.net", "medium.com", "quora.com", "pinterest.com", "tiktok.com", "reddit.com"];
const isService = (sender: string) => { const d = sender.split("@")[1] ?? ""; return NOTIFICATION_SERVICES.some(s => d === s || d.endsWith(`.${s}`)); };

export interface FilterOptions {
  muted: string[]; // sender addresses or domains, lowercase
}

export function classify(item: Item, opts: FilterOptions): string | null {
  const sender = item.from.email.toLowerCase();
  if (opts.muted.some(m => sender === m || sender.endsWith("@" + m) || sender.endsWith("." + m))) return "noise:muted";
  // Your own sent mail is never noise, whatever the body says. Sender/bulk/calendar rules are email-only:
  // Teams messages and meetings have no newsletters, and meeting text legitimately mentions invitations.
  const email = ["email", "gmail"].includes(item.source ?? "email"); // Outlook and Gmail
  if (email && item.folder !== "sentitems") {
    if (item.source === "gmail") { if (isService(sender)) return "noise:sender"; }
    else {
      if (NOISE_SENDER.test(sender)) return "noise:sender";
      if (BULK_BODY.test(item.text)) return "noise:bulk";
    }
  }
  if (email && CALENDAR_SUBJECT.test(item.subject)) return "noise:calendar";
  const secret = findSecret(`${item.subject}\n${item.text}`);
  if (secret) return `secret:${secret}`;
  return null;
}

export function filterItems(items: Item[], opts: FilterOptions): { kept: Item[]; dropped: Dropped[] } {
  const kept: Item[] = [];
  const dropped: Dropped[] = [];
  for (const item of items) {
    const reason = classify(item, opts);
    if (reason) dropped.push({ item, reason });
    else kept.push(item);
  }
  return { kept, dropped };
}
