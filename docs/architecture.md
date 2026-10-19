# Connector design: Outlook → brain (mailsync)

**Status:** original design (2026-09-25); implementation updated 2026-10-14 · **Author:** claude-code
**Fits:** `_setup/ARCHITECTURE.md`, contract A (source connector → vault).

**Implemented deployment:** [`operations.md`](operations.md) supersedes the original pull/extract/runtime details below. The current adapter performs bounded paginated Graph scans with immutable IDs and persistent content fingerprints; the lookback defaults to 10 days and expands automatically when configured to 30 or another range. Extraction uses unattended Codex with the owner's ChatGPT subscription login. Docker `brain-scheduler` owns the quarter-hour schedule; `BrainPortal` hosts the loopback portal and a Windows worker that executes queued jobs with a collector process lock. Windows `BrainRunner` was removed after a verified sync/index. The dedicated shared control directory holds requests, enabled/paused state, heartbeats, lifetime counters and the latest 100 attempts; no email or tokens are mounted into Docker. Queue/cursor checkpoints and index retries are implemented. Separate person/client notes, attachment archiving, API dollar spending caps, GBrain extension integration and additional M365 adapters remain unimplemented.

## 1. The connector pipeline

```
SOURCE                              CONNECTOR (every 15 min)                                         BRAIN
Outlook (M365)                                                                                       <vault> 
   │                                                                                                    ▲
   │  Graph delta    ┌──────┐ RawMsg ┌───────────┐ Item ┌────────┐ Item  ┌───────┐ Thread ┌─────────┐ │
   └────────────────►│ PULL ├───────►│ NORMALIZE ├─────►│ FILTER ├──────►│ GROUP ├───────►│ EXTRACT │ │
                     └──┬───┘        └───────────┘      └───┬────┘       └───────┘        └────┬────┘ │
                        │ cursor                            │ drop log                     Knowledge │
                        ▼                                   ▼                                   ▼      │
                   ┌─────────────── STATE  ~\.brain-mailsync ───────────────┐          ┌────────┐ Note  ┌────────┐
                   │ cursors · queue · processed ids · cost · log · token   │          │ RENDER ├──────►│ COMMIT ├──► inbox/email/*.md
                   └────────────────────────────────────────────────────────┘          └────────┘       └───┬────┘   git commit
                                                                                                           │        gbrain sync → index
```

Seven stages. Each takes one data type in and hands one out, so each can be built and tested alone.

| # | Stage | In → Out | Does | AI? |
|---|---|---|---|---|
| 1 | **Pull** | cursor → `RawMsg[]` + new cursor | Graph `delta` per folder (all except Junk/Deleted/Drafts; Sent included). Backfill pages newest → oldest | no |
| 2 | **Normalize** | `RawMsg` → `Item` | Graph JSON to a source-neutral shape; HTML → plain text; strips quoted replies and signatures | no |
| 3 | **Filter** | `Item` → `Item` or drop | Noise rules (noreply, notifications, lists, calendar, mute list) and secret rules (passwords, OTP, card/bank, NRIC/passport, API keys). Every drop is logged with its reason | no |
| 4 | **Group** | `Item[]` → `Thread[]` | Groups by conversation; loads the thread's existing note so the AI updates it rather than starting over | no |
| 5 | **Extract** | `Thread` → `Knowledge` | Haiku 4.5: anything worth keeping? If yes, Sonnet 5 fills a fixed JSON schema: decisions, commitments, people, client events | **yes** |
| 6 | **Render** | `Knowledge` → `Note[]` | Template → markdown (thread, person, client notes); Outlook link from `Item.url`; second secret scan | no |
| 6b | **Link** | `Note[]` → linked `Note[]` + entity pages | People, client and project become wikilinks to `inbox/entities/` pages, which are updated (section 8) | no |
| 7 | **Commit** | `Note[]` → brain | Writes to `inbox/email/`, `git commit`, `gbrain sync`. Push is left to the hourly backup | no |

**Code for data, AI for judgment:** only stage 5 calls an AI. Everything that must be exactly right (links, IDs, dedup, secret filtering) is plain code.

## 2. Source adapter + shared core

The connector is split so future sources (Teams, calendar, meeting transcripts) reuse stages 3-7:

```
            source-specific                          shared core (same for every source)
┌────────────────────────────────┐   Item   ┌──────────────────────────────────────────────┐
│ OutlookAdapter                 │ ───────► │ filter → group → extract → render → commit   │
│   pull(cursor), normalize(raw) │          └──────────────────────────────────────────────┘
└────────────────────────────────┘
  later: TeamsAdapter, CalendarAdapter … same interface
```

```ts
// The only thing a new source has to implement.
interface SourceAdapter {
  id: string;                                   // "outlook" → writes to inbox/email/
  pull(cursor: Cursor | null): Promise<{ raw: unknown[]; next: Cursor }>;
  normalize(raw: unknown): Item;
}

// Source-neutral item every later stage works on.
interface Item {
  id: string;            // Graph message id (dedup key)
  threadId: string;      // conversationId (grouping + note key)
  at: string;            // ISO time
  from: Person; to: Person[]; cc: Person[];
  subject: string;
  text: string;          // plain text, quoted replies stripped
  url: string;           // Outlook webLink, from Graph, never from the AI
  folder: string;        // Inbox, Sent Items, …
}

// What stage 5 must return (schema-validated; invalid → retry, then queue).
interface Knowledge {
  keep: boolean;
  summary: string;
  client: string | null;
  decisions:   { what: string; when: string; who: string[] }[];
  commitments: { owner: string; to: string; what: string; due: string | null; status: "open" | "done" }[];
  people:      { name: string; email: string; org: string | null; role: string | null }[];
  events:      { date: string; what: string }[];   // for the client log
}
```

## 3. Where the source is, where the brain is

| | Where | Owned by |
|---|---|---|
| **Source** | The owner's Microsoft 365 mailbox (`microsoft.account` in [config.json](configuration.md)), read with Graph `Mail.Read` (delegated, read-only) | Microsoft; the connector never changes mail |
| **Connector code** | `app/` in this repo (Bun + TypeScript, not in the vault) | repo |
| **Connector state** | `~\.brain-mailsync\` (cursors, queue, processed ids, cost, logs, token cache) | laptop only, never in git |
| **Secrets** | settings file and `api-keys.json` in the state dir (see [configuration](configuration.md)) | never in the vault or git |
| **Brain output** | `<vault>\inbox\email\` → git → GBrain index (source `brain`) | connector writes; the owner owns a note once moved out |

Output layout:

```
inbox/email/
  threads/2026-09/2026-09-22-acme-renewal-pricing.md   one per worthwhile conversation
inbox/entities/                                         written by the sync for every source (section 8)
  people/jane-lim.md                                    one per person
  companies/acme.md                                     one per client
  projects/portal-migration.md                          one per Claude / ChatGPT project
```

## 4. How you use it

| Command | When |
|---|---|
| `mailsync login` | Once (and if Microsoft login ever expires): approve a code in the browser |
| `mailsync run --dry-run --limit 50` | First: writes 50 sample notes to a scratch folder for you to review |
| `mailsync run --backfill` | After you approve the samples: works through all history in resumable chunks |
| *(automatic)* task `BrainMailsync`, every 15 min | `mailsync run`: new mail only |
| `mailsync status` | Last run, items pulled/kept/dropped, queue, cost today, last error |
| `mailsync mute <sender>` | Stop a sender's mail from being processed |

Day to day you do nothing. Notes appear in `inbox/email/`, and on Fridays you move the ones worth keeping into their home folders.

## 5. Reliability

| If | Then |
|---|---|
| Run overlaps | Lock file; second run exits |
| Microsoft login expired | Stop, Windows toast "run mailsync login"; cursors kept, nothing lost |
| Graph 429/5xx | Honour `Retry-After`, backoff, max 5 tries |
| Cursor invalid (410) | Re-sync that folder; idempotent writes (keyed by `threadId`) prevent duplicates |
| AI error or invalid JSON | Retry twice, then queue the thread for next run |
| Daily cost cap hit | Keep pulling and queueing; resume extraction tomorrow |
| git / gbrain fails | Notes stay on disk; next run commits them |

## 6. Testing

- Stages 2, 3, 4, 6: unit tests with fixture emails (noise, secrets, keepers, threads).
- Stage 5: recorded AI replies as fixtures; schema validation tests.
- Stage 7: temp git repo; running twice gives no diff.
- End-to-end: `--dry-run` against the real mailbox before the first real run.

## 7. Decisions behind this design

Verbatim mail stays in Outlook; notes are visible to all consumers including client material (rule change 2026-09-24); 15-minute delta sync; full-history backfill; standalone script + Claude API modelled on GBrain's `email-to-brain`; distilled notes only, no raw thread pages.

## 8. Entities and links (GBrain-native)

Third Brain does not build a graph. GBrain already extracts links and timelines (`gbrain extract links|timeline`,
`extract all`, and incrementally on `gbrain sync`); it was finding nothing because the pages its links point at did not
exist and the notes used formats it does not read. The sync now supplies both, deterministically (no AI):

- **Entity pages** under `inbox/entities/` (connectors write only in `inbox/`): `people/<slug>.md`,
  `companies/<slug>.md` (the note's `client:`), `projects/<slug>.md` (Claude.ai / ChatGPT projects). Frontmatter in the
  vault template's fields with `source: third-brain-sync`, plus `type: person|company|project`, `aliases:` (other
  spellings and addresses), `entity_keys:`, and for people `email`, `role`, `org` and `company:` (GBrain's `works_at`
  edge). The body has a short header and `## Notes`: `- YYYY-MM-DD · [[note slug|title]]`, newest first, capped at 200
  (then "and N more"; `note_count:` keeps the total).
- **Identity:** a person is keyed by email when there is one, else by normalised name (case, accents, punctuation
  ignored); a name without an address joins the known person of that name, and the same name with a different address
  is a different person. The owner (`owner.emails`, `owner.name`), no-reply / role addresses and bots never get a page.
  A company is the slug of the client name (the same value as the note's `client:`); a person's organisation links to
  a company when it matches a client by slug, name or alias. No company pages are made from organisations alone.
- **Links in notes:** the People list is `- [[inbox/entities/people/<slug>|Name]] <email> · role, [[companies link|Org]]`,
  Links starts with `- Client: [[…|Client]]` / `- Project: [[…|Project]]`, and frontmatter gets
  `related: [entity slugs]` (and `attendees:` on meetings: GBrain's `attended` edge). `client:` and `project:` stay as
  they were for the portal. Events are `- **YYYY-MM-DD** — text`, GBrain's timeline line.
- **How GBrain recognises the pages:** its mention linker (`extract links --by-mention`) uses pages whose type is
  `person`, `company`, `organization` or `entity` (`src/core/mentions/policy.ts`, `ALWAYS_LINKABLE_TYPES`), plus pack
  types marked `primitive: entity`. The type comes from frontmatter `type:`, else the path (`/people/`, `/companies/`,
  `/projects/` in `src/core/markdown.ts`). `project` is `primitive: concept` in the base pack, so project pages are
  reached by wikilinks and `related:` only, unless `gbrain config set mentions.entity_types +project`.
  Wikilinks to full slugs resolve exactly (`src/core/link-extraction.ts`, resolver step 1); frontmatter fields are read
  with `--include-frontmatter` or `autopilot.incremental_extract_include_frontmatter`.
- **When pages are written:** each sync run updates the pages its notes touch (existing pages are read so lists
  accumulate) and commits `inbox/entities/` with the notes. A linking error leaves that run's notes unlinked and never
  fails the run. Pages go through the secret check before writing. `entities rebuild` (configuration.md, CLI) is the
  one-off backfill for notes written before this.
