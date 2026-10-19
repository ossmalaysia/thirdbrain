// What the Gmail connector reads (pure): the owner's choices -> one X-GM-RAW query. Default: Primary, Sent and the
// mail Gmail marks Important in the other tabs. Label names are user data: they are quoted, and names that cannot be
// quoted safely (quotes, backslashes, control characters) are refused.
import { createHash } from "node:crypto";

export const SCOPE_OPTIONS = ["primary", "sent", "important", "updates", "promotions", "social", "forums"] as const;
export type ScopeOption = typeof SCOPE_OPTIONS[number];
export type GmailScope = Record<ScopeOption, boolean> & { labels: string[] };

export const DEFAULT_SCOPE: GmailScope = { primary: true, sent: true, important: true, updates: false, promotions: false, social: false, forums: false, labels: [] };
export const SCOPE_TERMS: Record<ScopeOption, string> = {
  primary: "category:primary", sent: "in:sent", important: "(is:important -category:primary)",
  updates: "category:updates", promotions: "category:promotions", social: "category:social", forums: "category:forums",
};
export const MAX_LABELS = 20;
const EXCLUDE = "-in:spam -in:trash -in:chats";

/** A label name that can go inside label:"…": no quotes, backslashes or control characters, 1-200 characters. */
export const safeLabel = (name: unknown): name is string => typeof name === "string" && name.trim().length > 0 && name.length <= 200 && !/["\\\u0000-\u001f\u007f]/.test(name);
export const labelTerm = (name: string) => { if (!safeLabel(name)) throw new Error("That label name cannot be searched safely."); return `label:"${name.trim()}"`; };

/** Validates a stored or posted scope. Throws a message for the owner on bad input. */
export function parseScope(raw: unknown): GmailScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose what to include.");
  const r = raw as Record<string, unknown>, out = { ...DEFAULT_SCOPE, labels: [] as string[] };
  for (const k of SCOPE_OPTIONS) {
    if (r[k] === undefined) { out[k] = false; continue; }
    if (typeof r[k] !== "boolean") throw new Error("Each choice is on or off.");
    out[k] = r[k] as boolean;
  }
  const labels = r.labels ?? [];
  if (!Array.isArray(labels) || labels.length > MAX_LABELS) throw new Error(`Choose at most ${MAX_LABELS} labels.`);
  for (const l of labels) if (!safeLabel(l)) throw new Error("A label name with quotes or backslashes cannot be searched. Rename it in Gmail or leave it out.");
  out.labels = [...new Set((labels as string[]).map(l => l.trim()))].sort();
  if (!SCOPE_OPTIONS.some(k => out[k]) && !out.labels.length) throw new Error("Choose at least one kind of mail to include.");
  return out;
}

/** The terms joined with OR (each option, then each label). */
export const scopeTerms = (s: GmailScope) => [...SCOPE_OPTIONS.filter(k => s[k]).map(k => SCOPE_TERMS[k]), ...s.labels.map(labelTerm)];

export function afterDate(sinceIso: string): string {
  const d = new Date(sinceIso);
  return Number.isFinite(d.getTime()) ? `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}` : "1970/01/01";
}

/** The IMAP search: the chosen kinds of mail, never spam, trash or chat logs, inside the history window. */
export function scopeQuery(scope: GmailScope, sinceIso: string): string {
  const terms = scopeTerms(scope);
  if (!terms.length) throw new Error("Choose at least one kind of mail to include.");
  return `(${terms.join(" OR ")}) ${EXCLUDE} after:${afterDate(sinceIso)}`;
}
/** One term alone (for the counts next to each choice). */
export const termQuery = (term: string, sinceIso: string) => `${term} ${EXCLUDE} after:${afterDate(sinceIso)}`;

/** Stable id of a scope, kept in the cursor: a different key means the window is read again. */
export const scopeKey = (s: GmailScope) => createHash("sha256").update(JSON.stringify(scopeTerms(s))).digest("hex").slice(0, 16);
