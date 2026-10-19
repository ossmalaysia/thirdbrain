// Entity pages (people, companies, projects) and the links from notes to them, in the formats GBrain already reads.
// GBrain builds the graph itself (`gbrain extract links|timeline`, and on sync): wikilinks `[[dir/slug|Name]]` in the
// body, frontmatter `related:` / `attendees:` / `company:`, and pages typed `person` / `company` (frontmatter `type:`
// and the `/people/`, `/companies/`, `/projects/` path convention) for its mention linker. This module only writes
// the missing pages and the links. Deterministic, no AI. Pages live under inbox/entities/ (connectors write only in
// inbox/). See docs/architecture.md "Entities and links (GBrain-native)".
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Note } from "../types.ts";
import { slugify } from "./render.ts";
import { findSecret } from "./secrets.ts";
import { NOISE_SENDER } from "./filter.ts";
import { isDistinct, loadMerges, resolveMerge, squashName, type MergeEntry, type Merges } from "./entity-merges.ts";

export const ENTITY_DIR = "inbox/entities";
export type EntityKind = "person" | "company" | "project" | "topic";
export const KIND_DIR: Record<EntityKind, string> = { person: "people", company: "companies", project: "projects", topic: "topics" };
/** A note tag gets a topic page once this many notes carry it (set by the rebuild; the sync links existing pages). */
export const MIN_TOPIC_NOTES = 5;
/** Tags that name the source or a scope, not a subject: never topics. Prefixed tags (account/, client/, project/) neither. */
const NOT_A_TOPIC = new Set(["ai-chat", "email", "teams", "meeting", "personal", "entity", "person", "company", "project", "topic"]);
/** Notes listed on an entity page; older ones are counted ("and N more"). */
export const NOTES_CAP = 200;
export const ENTITY_SOURCE = "third-brain-sync";

/** Who the vault belongs to: never gets a person page. */
export interface OwnerId { name: string; emails: string[]; org?: string }

export interface NoteRef { slug: string; title: string; date: string }

export interface Entity {
  kind: EntityKind;
  slug: string; // basename under inbox/entities/<dir>/
  name: string;
  /** Company named only from its slug ("acme-corp" -> "Acme Corp"); a real name replaces it. */
  nameIsGuess?: boolean;
  keys: string[];
  aliases: string[];
  email?: string;
  role?: string;
  org?: string;
  company?: string; // company basename (person pages)
  created?: string;
  lastVerified?: string;
  notes: Map<string, NoteRef>;
  /** Notes counted on the page but no longer listed (beyond the cap). */
  extraCount: number;
  touched: boolean;
  existing?: string; // page content as read from the vault
}

export interface PersonInput { name: string; email?: string | null; role?: string | null; org?: string | null }

export const entityPath = (kind: EntityKind, slug: string) => `${ENTITY_DIR}/${KIND_DIR[kind]}/${slug}`;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ROLE_ADDRESS = /^(support|help|info|admin|billing|accounts?|sales|team|hello|contact|office|hr|careers|jobs|enquir(?:y|ies)|service|helpdesk|it|security|reception|bot)([._+-]|@)/i;
const NOT_A_PERSON = /^(claude|chatgpt|codex|copilot|gemini|assistant|ai|bot|system|unknown|me|you|everyone|all|team|n\/?a|none)$/i;
const BOTLIKE = /\b(bot|no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster)\b/i;

/** Lower case, accents and punctuation removed, words single-spaced; letters of any script kept. */
export function normName(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
/** Text safe inside a wikilink label and on one line. A name echoed back as a wikilink keeps only its label. */
const label = (s: string) => s.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/[[\]|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const q = (s: string) => JSON.stringify(s);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const humanize = (slug: string) => slug.split("-").filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");

/** The topic slug of a note tag, or null for source/scope tags and prefixed tags. */
export function topicSlug(tag: string): string | null {
  const t = tag.trim().toLowerCase();
  if (!t || t.includes("/") || NOT_A_TOPIC.has(t)) return null;
  const s = slugify(t, 40);
  return s === "untitled" || !SAFE_SLUG.test(s) ? null : s;
}
/** "platform-engineering" -> "Platform engineering"; short words are acronyms ("aws" -> "AWS", "ai-agents" -> "AI agents"). */
export const topicName = (slug: string) => slug.split("-").filter(Boolean)
  .map((w, i) => w.length <= 3 && !/\d/.test(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w).join(" ");

function baseSlug(kind: EntityKind, name: string, key: string): string {
  const s = slugify(name, kind === "person" ? 60 : 40);
  return s === "untitled" ? `${kind}-${hash(key).slice(0, 8)}` : s;
}

/** All entity pages of a vault, resolved by identity, plus the pages touched since loading. */
export class EntityStore {
  private bySlug = new Map<string, Entity>(); // `${kind}/${slug}`
  private byKey = new Map<string, Entity[]>();
  private companyNames = new Map<string, Entity>(); // normName(name or alias) -> company
  private bySquash = new Map<string, Entity>(); // `${kind}:${squashName}` -> entity (core/entity-merges.ts)
  blocked = 0;
  /** The vault's merge list; merges found while loading are added (and listed in `newMerges` for the rebuild to save). */
  merges: Merges = { merges: [], distinct: [] };
  newMerges: MergeEntry[] = [];
  /** Vault paths of merged-away pages (the rebuild deletes them). */
  absorbed: string[] = [];
  /** Topic slugs that may get a NEW page (the rebuild sets them from tag counts). Null: link only existing pages. */
  topicTags: Set<string> | null = null;

  constructor(readonly owner: OwnerId = { name: "", emails: [] }) {}

  /** Reads inbox/entities/{people,companies,projects}/*.md. Missing folders: an empty store. */
  static load(root: string, owner?: OwnerId): EntityStore {
    const store = new EntityStore(owner);
    store.merges = loadMerges(root);
    for (const kind of Object.keys(KIND_DIR) as EntityKind[]) {
      const dir = join(root, ENTITY_DIR, KIND_DIR[kind]);
      if (!existsSync(dir)) continue;
      for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!d.isFile() || !d.name.endsWith(".md")) continue;
        const slug = d.name.slice(0, -3);
        if (!SAFE_SLUG.test(slug)) continue;
        const e = parseEntityPage(kind, slug, readFileSync(join(dir, d.name), "utf8"));
        if (e) store.add(e);
      }
    }
    store.applyMerges(new Date().toISOString().slice(0, 10));
    return store;
  }

  /** Merges from the vault list first, then automatic ones (names equal without spaces, dashes and dots). A merged
   *  page leaves the store; its names, keys and notes move to the page that stays. */
  private applyMerges(today: string) {
    // Undone merges first: the names and keys of the other page leave the page that stayed.
    for (const x of this.merges.strip ?? []) {
      const e = this.bySlug.get(`${x.kind}/${x.to}`);
      if (!e) continue;
      const names = new Set([x.name, ...x.aliases].map(normName));
      e.aliases = e.aliases.filter(a => !names.has(normName(a)));
      for (const k of x.keys) {
        e.keys = e.keys.filter(y => y !== k);
        const list = (this.byKey.get(k) ?? []).filter(y => y !== e);
        if (list.length) this.byKey.set(k, list); else this.byKey.delete(k);
      }
      for (const n of names) if (this.companyNames.get(n) === e) this.companyNames.delete(n);
      for (const n of [x.name, ...x.aliases]) { const sq = `${x.kind}:${squashName(x.kind, n)}`; if (this.bySquash.get(sq) === e && squashName(x.kind, n) !== squashName(x.kind, e.name)) this.bySquash.delete(sq); }
    }
    for (const m of this.merges.merges) {
      const to = this.bySlug.get(`${m.kind}/${resolveMerge(this.merges, m.kind, m.to)}`);
      if (!to) continue;
      const from = this.bySlug.get(`${m.kind}/${m.from}`);
      if (from && from !== to) this.absorb(from, to);
      else if (!from) { this.addNames(to, [m.name, ...m.aliases]); for (const k of m.keys) this.index(k, to); }
    }
    const groups = new Map<string, Entity[]>();
    for (const e of this.bySlug.values()) {
      if (e.kind === "topic") continue;
      const k = `${e.kind}:${squashName(e.kind, e.name)}`;
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
    const size = (e: Entity) => e.notes.size + e.extraCount;
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const [keep, ...rest] = [...g].sort((a, b) => size(b) - size(a) || a.slug.length - b.slug.length || a.slug.localeCompare(b.slug));
      for (const e of rest) {
        if (e.kind === "person" && e.email && keep.email && e.email !== keep.email) continue; // same name, different person
        if (isDistinct(this.merges, e.kind, e.slug, keep.slug)) continue;
        const entry: MergeEntry = { kind: e.kind, from: e.slug, to: keep.slug, name: e.name, keys: [...e.keys], aliases: [...e.aliases], by: "auto", at: today };
        this.merges.merges.push(entry); this.newMerges.push(entry);
        this.absorb(e, keep);
      }
    }
  }

  private absorb(from: Entity, to: Entity) {
    this.bySlug.delete(`${from.kind}/${from.slug}`);
    this.absorbed.push(`${entityPath(from.kind, from.slug)}.md`);
    this.addNames(to, [from.name, ...from.aliases]);
    for (const k of from.keys) {
      const list = (this.byKey.get(k) ?? []).map(x => x === from ? to : x);
      this.byKey.set(k, [...new Set(list)]);
      if (!to.keys.includes(k)) to.keys.push(k);
    }
    for (const [k, v] of this.bySquash) if (v === from) this.bySquash.set(k, to);
    for (const [k, v] of this.companyNames) if (v === from) this.companyNames.set(k, to);
    for (const [slug, ref] of from.notes) to.notes.set(slug, ref);
    to.extraCount += from.extraCount;
    to.email ??= from.email; to.role ??= from.role; to.org ??= from.org; to.company ??= from.company;
    if (from.kind === "company") for (const p of this.bySlug.values()) if (p.kind === "person" && p.company === from.slug) p.company = to.slug;
    to.touched = true;
  }

  private addNames(e: Entity, names: string[]) {
    for (const n of names) {
      if (!n || normName(n) === normName(e.name) || e.aliases.some(a => normName(a) === normName(n))) continue;
      e.aliases.push(n);
      if (e.kind === "company") this.nameCompany(e, n);
    }
  }

  /** An existing entity whose name is the same without spaces, dashes and dots. */
  private squashed(kind: EntityKind, name: string): Entity | undefined { return this.bySquash.get(`${kind}:${squashName(kind, name)}`); }

  all(): Entity[] { return [...this.bySlug.values()]; }
  get(kind: EntityKind, slug: string) { return this.bySlug.get(`${kind}/${resolveMerge(this.merges, kind, slug)}`); }

  /** Rebuild: forget every page's note list (identities and slugs stay, so links remain stable). */
  clearNotes() { for (const e of this.bySlug.values()) { e.notes.clear(); e.extraCount = 0; } }

  private add(e: Entity) {
    this.bySlug.set(`${e.kind}/${e.slug}`, e);
    const sq = `${e.kind}:${squashName(e.kind, e.name)}`;
    if (!this.bySquash.has(sq)) this.bySquash.set(sq, e);
    for (const k of e.keys) this.index(k, e);
    if (e.kind === "company") for (const n of [e.name, ...e.aliases]) this.nameCompany(e, n);
  }
  private nameCompany(e: Entity, name: string) {
    const n = normName(name);
    if (n && !this.companyNames.has(n)) this.companyNames.set(n, e);
  }
  private index(key: string, e: Entity) {
    const list = this.byKey.get(key) ?? [];
    if (!list.includes(e)) list.push(e);
    this.byKey.set(key, list);
    if (!e.keys.includes(key)) e.keys.push(key);
  }
  private create(kind: EntityKind, name: string, key: string): Entity {
    let slug = baseSlug(kind, name, key);
    if (this.get(kind, slug)) slug = `${slug}-${hash(key).slice(0, 6)}`;
    const e: Entity = { kind, slug, name, keys: [], aliases: [], notes: new Map(), extraCount: 0, touched: false };
    this.add(e);
    this.index(key, e);
    return e;
  }

  isOwner(p: { name: string; email?: string | null }): boolean {
    const email = p.email?.trim().toLowerCase();
    if (email && this.owner.emails.some(o => o.toLowerCase() === email)) return true;
    return !!this.owner.name.trim() && normName(p.name) === normName(this.owner.name);
  }

  /** The person's entity (created when new), or null for the owner, bots and role addresses. */
  person(p: PersonInput, opts: { pageSlug?: string } = {}): Entity | null {
    let email = p.email?.trim().toLowerCase() ?? "";
    if (!EMAIL.test(email)) email = "";
    let name = label(p.name ?? "");
    if (!email && EMAIL.test(name.toLowerCase())) { email = name.toLowerCase(); name = ""; }
    if (!name && email) name = humanize(slugify(email.split("@")[0], 60));
    if (!name || !/\p{L}/u.test(name) || NOT_A_PERSON.test(name) || BOTLIKE.test(name)) return null;
    if (email && (NOISE_SENDER.test(email) || ROLE_ADDRESS.test(email))) return null;
    if (this.isOwner({ name, email })) return null;
    const emailKey = email ? `email:${email}` : "", norm = normName(name), nameKey = norm ? `name:${norm}` : "";
    let e = opts.pageSlug ? this.get("person", opts.pageSlug) : undefined;
    // A link to a page whose names no longer include this name (an undone merge): resolve by name and address instead.
    if (e && norm && normName(e.name) !== norm && !e.aliases.some(a => normName(a) === norm) && !(email && e.email === email)) e = undefined;
    if (!e && emailKey) e = this.byKey.get(emailKey)?.[0];
    if (!e && nameKey) {
      const named = (this.byKey.get(nameKey) ?? []).filter(c => c.kind === "person");
      // A different address under the same name is a different person.
      e = email ? named.find(c => !c.email || c.email === email) : named.find(c => !c.email) ?? named[0];
    }
    if (!e) { const same = this.squashed("person", name); if (same && (!email || !same.email || same.email === email)) e = same; }
    if (!e) {
      if (opts.pageSlug && SAFE_SLUG.test(opts.pageSlug)) {
        e = { kind: "person", slug: opts.pageSlug, name, keys: [], aliases: [], notes: new Map(), extraCount: 0, touched: false };
        this.add(e);
      } else e = this.create("person", name, emailKey || nameKey);
    }
    if (emailKey) this.index(emailKey, e);
    if (nameKey) this.index(nameKey, e);
    if (email && !e.email) e.email = email;
    if (email && email !== e.email && !e.aliases.includes(email)) e.aliases.push(email);
    if (name !== e.name && !e.aliases.some(a => normName(a) === norm)) e.aliases.push(name);
    if (p.role?.trim()) e.role = label(p.role);
    if (p.org?.trim()) e.org = label(p.org);
    return e;
  }

  /** The client's company page (created when new). `slug` is the note's `client:` value when known. */
  company(name: string, slug?: string, guess = false): Entity | null {
    const s = slug && SAFE_SLUG.test(slug) ? slug : slugify(name, 40);
    if (!s || s === "untitled") return null;
    if (this.owner.org && slugify(this.owner.org, 40) === s) return null; // the owner's own company is not a client
    let e = this.byKey.get(`company:${s}`)?.[0] ?? this.get("company", s) ?? (label(name) ? this.squashed("company", label(name)) : undefined);
    if (!e) {
      e = { kind: "company", slug: s, name: label(name) || humanize(s), nameIsGuess: guess || !label(name), keys: [], aliases: [], notes: new Map(), extraCount: 0, touched: false };
      this.add(e);
    }
    this.index(`company:${s}`, e);
    const n = label(name);
    if (n && !guess) {
      if (e.nameIsGuess) { e.name = n; e.nameIsGuess = false; }
      else if (normName(n) !== normName(e.name) && !e.aliases.some(a => normName(a) === normName(n))) e.aliases.push(n);
      this.nameCompany(e, n);
    }
    return e;
  }

  /** An existing company matching an organisation name (slug, name or alias); never creates one. */
  findCompany(org: string | null | undefined): Entity | null {
    if (!org?.trim()) return null;
    return this.byKey.get(`company:${slugify(org, 40)}`)?.[0] ?? this.companyNames.get(normName(org)) ?? null;
  }

  project(name: string): Entity | null {
    const n = label(name), s = slugify(n, 40);
    if (!n || s === "untitled") return null;
    let e = this.byKey.get(`project:${s}`)?.[0] ?? this.get("project", s) ?? this.squashed("project", n);
    if (!e) {
      e = { kind: "project", slug: s, name: n, keys: [], aliases: [], notes: new Map(), extraCount: 0, touched: false };
      this.add(e);
    }
    this.index(`project:${s}`, e);
    return e;
  }

  /** The page for a note tag: an existing company or project of that name first; else its topic page (a new one only
   *  for tags in `topicTags`). Null for source/scope tags. */
  topic(tag: string): Entity | null {
    const s = topicSlug(tag);
    if (!s) return null;
    const same = this.findCompany(s) ?? this.byKey.get(`project:${s}`)?.[0] ?? null;
    if (same) return same;
    let e = this.get("topic", s);
    if (!e) {
      if (!this.topicTags?.has(s)) return null;
      e = { kind: "topic", slug: s, name: topicName(s), keys: [], aliases: [], notes: new Map(), extraCount: 0, touched: false };
      this.add(e);
    }
    this.index(`topic:${s}`, e);
    return e;
  }

  addNote(e: Entity, ref: NoteRef) { e.notes.set(ref.slug, ref); e.touched = true; }

  /** Rendered pages of every touched entity that has notes. Pages holding a secret are skipped (counted in `blocked`). */
  pages(today: string): Note[] {
    const out: Note[] = [];
    for (const e of this.all()) {
      if (!e.touched || !e.notes.size || !SAFE_SLUG.test(e.slug)) continue;
      // Only the AI-derived text: names, roles and note titles (generated paths and dates cause false hits).
      if (findSecret(JSON.stringify([e.name, e.aliases, e.role, e.org, [...e.notes.values()].map(n => n.title)]))) { this.blocked++; continue; }
      const relPath = `${entityPath(e.kind, e.slug)}.md`;
      // last_verified moves only when something else on the page changed, so a rebuild is idempotent.
      let content = renderEntityPage(e, this, e.lastVerified ?? today);
      if (content !== e.existing) content = renderEntityPage(e, this, today);
      out.push({ relPath, content });
    }
    return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }
}

// ---------- entity pages ----------

const NOTE_LINE = /^- (\d{4}-\d{2}-\d{2}) · \[\[([^|\]]+)\|([^\]]*)\]\]\s*$/;

function frontMatter(text: string): Record<string, unknown> {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const out: Record<string, unknown> = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([a-z_]+):[ \t]*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    try { out[m[1]] = /^["[]/.test(raw) ? JSON.parse(raw) : raw === "null" ? null : raw; } catch { out[m[1]] = raw; }
  }
  return out;
}
const str = (v: unknown) => typeof v === "string" && v ? v : undefined;
const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function parseEntityPage(kind: EntityKind, slug: string, text: string): Entity | null {
  const fm = frontMatter(text);
  if (fm.source !== ENTITY_SOURCE) return null; // not ours: never rewritten
  const notes = new Map<string, NoteRef>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(NOTE_LINE);
    if (m) notes.set(m[2], { date: m[1], slug: m[2], title: m[3] });
  }
  const count = Number(fm.note_count);
  return {
    kind, slug, name: str(fm.title) ?? humanize(slug), nameIsGuess: fm.name_guessed === "true" || fm.name_guessed === true,
    keys: strs(fm.entity_keys), aliases: strs(fm.aliases), email: str(fm.email), role: str(fm.role), org: str(fm.org),
    company: str(fm.company)?.split("/").pop(), created: str(fm.created), lastVerified: str(fm.last_verified),
    notes, extraCount: Number.isFinite(count) ? Math.max(0, count - notes.size) : 0, touched: false, existing: text,
  };
}

const link = (kind: EntityKind, slug: string, name: string) => `[[${entityPath(kind, slug)}|${label(name)}]]`;

export function renderEntityPage(e: Entity, store: EntityStore, today: string): string {
  const notes = [...e.notes.values()].sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  const shown = notes.slice(0, NOTES_CAP), total = notes.length + e.extraCount;
  const firstDate = notes.map(n => n.date).sort()[0];
  const created = [e.created, firstDate].filter((d): d is string => !!d).sort()[0] ?? today;
  const company = e.company ? store.get("company", e.company) : undefined;
  const aliases = [...new Set(e.aliases.filter(a => a && a !== e.name))];
  const fm = [
    "---",
    `title: ${q(e.name)}`,
    `created: ${created}`,
    `source: ${ENTITY_SOURCE}`,
    "status: draft",
    `last_verified: ${today}`,
    `tags: [${["entity", e.kind].map(q).join(", ")}]`,
    `aliases: [${aliases.map(q).join(", ")}]`,
    `type: ${e.kind}`,
    `kind: entity`,
    `entity_keys: [${e.keys.map(q).join(", ")}]`,
    ...(e.email ? [`email: ${q(e.email)}`] : []),
    ...(e.role ? [`role: ${q(e.role)}`] : []),
    ...(e.org ? [`org: ${q(e.org)}`] : []),
    ...(company ? [`company: ${q(entityPath("company", company.slug))}`] : []),
    ...(e.nameIsGuess ? ["name_guessed: true"] : []),
    `note_count: ${total}`,
    "---",
  ];
  const facts: string[] = [];
  if (e.kind === "person") {
    if (e.role) facts.push(`- **Role:** ${e.role}`);
    if (company) facts.push(`- **Organisation:** ${link("company", company.slug, company.name)}`);
    else if (e.org) facts.push(`- **Organisation:** ${e.org}`);
    if (e.email) facts.push(`- **Email:** ${e.email}`);
  }
  if (e.kind === "company") facts.push("- **Relationship:** client");
  const people = e.kind === "company"
    ? store.all().filter(p => p.kind === "person" && p.company === e.slug).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  const body = [
    `# ${e.name}`,
    "",
    e.kind === "topic" ? `_Topic page kept by ${ENTITY_SOURCE}: the notes tagged \`${e.slug}\`, newest first._`
      : `_${e.kind === "person" ? "Person" : e.kind === "company" ? "Company" : "Project"} page kept by ${ENTITY_SOURCE}: the notes that involve ${e.kind === "person" ? "them" : "it"}, newest first._`,
    "",
    ...(facts.length ? [...facts, ""] : []),
    ...(people.length ? ["## People", ...people.map(p => `- ${link("person", p.slug, p.name)}${p.role ? ` · ${p.role}` : ""}`), ""] : []),
    "## Notes",
    ...shown.map(n => `- ${n.date} · [[${n.slug}|${label(n.title) || n.slug.split("/").pop()}]]`),
    ...(total > shown.length ? [`- _and ${total - shown.length} more_`] : []),
    "",
  ];
  return `${fm.join("\n")}\n\n${body.join("\n")}`;
}

// ---------- notes ----------

export interface LinkHint { people: PersonInput[]; client: string | null }

const PEOPLE_LINE = /^- (?:\[\[([^|\]]+)\|([^\]]*)\]\]|(.+?))(?: <([^<>\s]+)>)?(?: · (.*))?$/;
const COMPANY_LINK = /\[\[inbox\/entities\/companies\/([a-z0-9-]+)\|([^\]]*)\]\]$/;
const OLD_EVENT = /^(\s*-\s*)\*\*(\d{4}-\d{2}-\d{2}):\*\*\s*(.*)$/;

/** Section body (lines after `## name` up to the next `## ` heading), as [start, end) line indexes. */
function section(lines: string[], name: string): [number, number] | null {
  const start = lines.findIndex(l => l.trim() === `## ${name}`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^##? /.test(lines[end])) end++;
  return [start + 1, end];
}

/** People as written in a note's People section (old plain form and the linked form). */
export function parsePeople(lines: string[], store: EntityStore): (PersonInput & { pageSlug?: string })[] {
  const out: (PersonInput & { pageSlug?: string })[] = [];
  for (const line of lines) {
    const m = line.match(PEOPLE_LINE);
    if (!m || line.startsWith("- _")) continue;
    const pageSlug = m[1]?.match(/^inbox\/entities\/people\/([a-z0-9][a-z0-9-]*)$/)?.[1]; // anything else: resolved by name/email
    const name = (m[2] ?? m[3] ?? "").trim();
    let role: string | null = null, org: string | null = null;
    const tail = m[5]?.trim() ?? "";
    const linked = tail.match(COMPANY_LINK);
    if (linked) { org = linked[2]; role = tail.slice(0, linked.index).replace(/,\s*$/, "").trim() || null; }
    else if (tail.includes(", ")) { const i = tail.lastIndexOf(", "); role = tail.slice(0, i); org = tail.slice(i + 2); }
    else if (tail) { if (store.findCompany(tail)) org = tail; else role = tail; }
    out.push({ name, email: m[4] ?? null, role, org, ...(pageSlug ? { pageSlug } : {}) });
  }
  return out;
}

function setField(fmLines: string[], key: string, value: string | null) {
  const i = fmLines.findIndex(l => l.startsWith(`${key}:`));
  if (value === null) { if (i >= 0) fmLines.splice(i, 1); return; }
  const line = `${key}: ${value}`;
  if (i >= 0) { fmLines[i] = line; return; }
  const after = fmLines.findIndex(l => l.startsWith("aliases:"));
  fmLines.splice(after >= 0 ? after + 1 : fmLines.length, 0, line);
}

export interface LinkResult { content: string; entities: Entity[]; migratedEvents: number }

/** Links one connector note to its entity pages: People as wikilinks, Client/Project lines under Links, frontmatter
 *  `related:` (and `attendees:` on meetings), old `- **DATE:**` events in GBrain's timeline format. Records the note on
 *  each entity. Idempotent: an already linked note comes back unchanged. */
export function linkNote(store: EntityStore, relPath: string, content: string, hint?: LinkHint): LinkResult {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const text = content.replace(/\r\n/g, "\n");
  const head = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!head || !relPath.endsWith(".md") || relPath.split("/").includes("..")) return { content, entities: [], migratedEvents: 0 };
  const fm = frontMatter(text);
  const tags = strs(fm.tags);
  if (tags.some(t => t === "personal" || t.startsWith("personal/"))) return { content, entities: [], migratedEvents: 0 };
  const noteSlug = relPath.slice(0, -3);
  const ref: NoteRef = { slug: noteSlug, title: str(fm.title) ?? noteSlug.split("/").pop()!,
    date: (str(fm.last_message) ?? str(fm.created) ?? "").slice(0, 10) };
  const lines = text.slice(head[0].length).split("\n");

  // Company (the note's client) and project.
  const clientSlug = str(fm.client);
  let company: Entity | null = null;
  if (clientSlug) {
    const links = section(lines, "Links");
    // The name on the note's Client line, unless that link points elsewhere now (an undone merge): then it is the
    // other page's name.
    const target = resolveMerge(store.merges, "company", clientSlug);
    const linkMatch = links ? lines.slice(...links).map(l => l.match(/^- Client: \[\[inbox\/entities\/companies\/([^|\]]+)\|([^\]]*)\]\]/)).find(Boolean) : undefined;
    let written = linkMatch && linkMatch[1] === target ? linkMatch[2] : undefined;
    const known = store.get("company", clientSlug);
    // A guessed name we wrote ourselves earlier is still a guess.
    if (written && known?.nameIsGuess && normName(written) === normName(known.name)) written = undefined;
    const fromPeople = (hint?.people ?? []).concat(parsePeople(section(lines, "People") ? lines.slice(...section(lines, "People")!) : [], store))
      .map(p => p.org?.trim()).find(o => o && slugify(o, 40) === clientSlug);
    const name = hint?.client ?? written ?? fromPeople ?? (known && !known.nameIsGuess ? known.name : undefined);
    company = store.company(name ?? humanize(clientSlug), clientSlug, !name);
  }
  const projectName = str(fm.project);
  const project = projectName ? store.project(projectName) : null;
  // Topics: the note's tags that have a page (or a company / project of the same name).
  const topics = [...new Set(tags.map(t => store.topic(t)).filter((e): e is Entity => !!e && e !== company && e !== project))];

  // People.
  const peopleAt = section(lines, "People");
  const people = hint?.people ?? (peopleAt ? parsePeople(lines.slice(...peopleAt), store) : []);
  const persons: (Entity | null)[] = people.map(p => store.person(p, { pageSlug: (p as { pageSlug?: string }).pageSlug }));
  const orgs = people.map((p, i) => {
    const e = persons[i];
    const org = p.org?.trim() ? (company && slugify(p.org, 40) === company.slug ? company : store.findCompany(p.org)) : null;
    if (e && org) { e.company = org.slug; if (org.notes.size || org === company) org.touched = true; }
    return org;
  });

  if (peopleAt && people.length) {
    const rendered = people.map((p, i) => {
      const e = persons[i], name = label(p.name) || e?.name || "";
      const email = p.email?.trim() && EMAIL.test(p.email.trim()) ? ` <${p.email.trim()}>` : "";
      const org = orgs[i] ? link("company", orgs[i]!.slug, label(p.org!)) : p.org?.trim() ? label(p.org) : "";
      const tail = [p.role?.trim() ? label(p.role) : "", org].filter(Boolean).join(", ");
      return `- ${e ? link("person", e.slug, name) : name}${email}${tail ? ` · ${tail}` : ""}`;
    });
    lines.splice(peopleAt[0], peopleAt[1] - peopleAt[0], ...rendered, ...(peopleAt[1] < lines.length ? [""] : []));
  }

  // Client / Project lines at the top of Links.
  const linksAt = section(lines, "Links");
  if (linksAt) {
    const kept = lines.slice(...linksAt).filter(l => !/^- (Client|Project|Topics): \[\[/.test(l));
    const add = [...(company ? [`- Client: ${link("company", company.slug, company.name)}`] : []),
      ...(project ? [`- Project: ${link("project", project.slug, project.name)}`] : []),
      ...(topics.length ? [`- Topics: ${topics.map(t => link(t.kind, t.slug, t.name)).join(", ")}`] : [])];
    lines.splice(linksAt[0], linksAt[1] - linksAt[0], ...add, ...kept);
  }

  // Old event lines in Detail -> GBrain's timeline format.
  let migratedEvents = 0;
  const detailAt = section(lines, "Detail");
  if (detailAt) for (let i = detailAt[0]; i < detailAt[1]; i++) {
    const m = lines[i].match(OLD_EVENT);
    if (m) { lines[i] = `${m[1]}**${m[2]}** — ${m[3]}`; migratedEvents++; }
  }

  // Frontmatter: related (every entity) and attendees (meetings: GBrain's `attended` edge).
  const personEntities = [...new Set(persons.filter((e): e is Entity => !!e))];
  const entities = [...new Set([...(company ? [company] : []), ...(project ? [project] : []), ...topics, ...personEntities])];
  const fmLines = head[1].split("\n");
  setField(fmLines, "related", entities.length ? `[${entities.map(e => q(entityPath(e.kind, e.slug))).join(", ")}]` : null);
  if (str(fm.kind) === "meeting") setField(fmLines, "attendees", personEntities.length ? `[${personEntities.map(e => q(entityPath("person", e.slug))).join(", ")}]` : null);

  for (const e of entities) store.addNote(e, ref);
  const out = `---\n${fmLines.join("\n")}\n---\n${lines.join("\n")}`;
  return { content: eol === "\n" ? out : out.replace(/\n/g, eol), entities, migratedEvents };
}
