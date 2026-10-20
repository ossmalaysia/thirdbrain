# Configuration

Everything that is specific to one person or one machine lives in two files in the **state directory**, never in
the code, the vault or git:

| File | What | Written by |
|---|---|---|
| `config.json` | Who owns this install, where the vault is, which Microsoft 365 account it reads, product name | you, or `bun run src/cli.ts config init` |
| settings file (default `settings.env`) | Tuning as `KEY=value` lines: history windows, note writer, backup push, ports | the portal's Settings pages, `cli configure` |

The state directory also holds tokens, API keys, logs and connector state (see [operations](operations.md)).

## State directory

`MAILSYNC_STATE_DIR` if set, else `THIRDBRAIN_STATE_DIR`, else `~/.brain-mailsync` (Windows:
`%USERPROFILE%\.brain-mailsync`). The default keeps the original name so existing installs keep their state; a rename
to a Third Brain name is planned and will come with a migration. `THIRDBRAIN_CONFIG` can point at a `config.json`
somewhere else.

## Portal port

The portal answers on `http://127.0.0.1:58432`. Set the environment variable `THIRDBRAIN_PORT` (1024 to 65535) to
use another port, for example for a second install. The Microsoft sign-in and the tunnel follow it; the desktop app
needs `THIRDBRAIN_URL` set to the same address.

Files the portal keeps there include `gmail.json` (the Gmail address and app password, encrypted; see
[operations.md](operations.md#gmail) for how to create the app password) and `owner-identity.json` (addresses that
count as the owner besides `owner.emails`, e.g. a connected Gmail address).

## config.json

All fields are optional. Unknown keys are ignored; a field with the wrong type is an error (the CLI stops with a
message naming the field; the portal falls back to defaults for its name and labels and keeps running).
See [`app/config.example.json`](../app/config.example.json).

| Field | Default | Affects |
|---|---|---|
| `product.name` | `"Third Brain"` | Portal title and brand, sign-in pages (portal device sign-in, Outlook, ChatGPT callback) |
| `owner.name` | `""` | Note writer prompt ("knowledge notes for *name*'s second brain"); fallback sender name for AI chats; shown in the portal status |
| `owner.shortName` | first word of `owner.name` | What the prompt calls the owner in running text ("*Aisyah* decided ...", "sent by *Aisyah*") |
| `owner.emails` | `[]` | Prompt: the owner's own addresses (lower-cased) |
| `owner.org`, `owner.role` | `""` | Prompt: "(*emails*, *role* of *org*)" |
| `owner.pronouns` | `"they"` | Prompt: `he`, `she` or `they` |
| `vault.path` | settings `BRAIN_PATH`, else `~/ThirdBrain` | Where notes are written, committed, backed up, listed and indexed |
| `vault.indexExclude` | `["life/**", "_setup/**", "templates/**"]` | Globs passed to `gbrain sync --exclude` after each sync. **Add every private folder** (e.g. `clients/**`) |
| `microsoft.account` | `""` | The mailbox a sync must be signed into, Outlook `login_hint`, the account shown on the Microsoft 365 connector cards. Empty: the first signed-in mailbox is accepted and written here, and enforced from then on |
| `microsoft.clientId` | settings `MAILSYNC_CLIENT_ID` | Your Entra app registration (public client) |
| `microsoft.tenantId` | settings `MAILSYNC_TENANT_ID`, else `organizations` | Tenant for Microsoft sign-in |
| `settingsFile` | `<state dir>/settings.env` | Path of the `KEY=value` settings file; relative paths are relative to `config.json` |
| `backup.localOnlyRepos` | `["life"]` | Nested git repos inside the vault that the backup commits locally only: never pushed, never added to the vault repo. Missing folders are skipped |
| `updates.repo` | `"ossmalaysia/thirdbrain"` | GitHub repository whose latest release the Settings page's Updates card checks (`owner/name`) |

Without any owner fields the prompt uses neutral wording ("the owner"). The prompt's rules (what to keep, the
personal-matter rule, attachments, AI conversations, untrusted data, never record credentials) do not depend on the
configuration.

**Precedence** per field: environment variable (`BRAIN_PATH`, `MAILSYNC_CLIENT_ID`, `MAILSYNC_TENANT_ID`) →
`config.json` → settings file → default. When the portal saves a new client or tenant id and `config.json` sets that
field, both files are updated so they never disagree.

## Settings file

Plain `KEY=value` lines (`#` comments are kept when the portal saves). Environment variables of the same name win.

| Key | Default | Meaning |
|---|---|---|
| `BRAIN_PATH` | — | Vault path when `config.json` has no `vault.path` |
| `MAILSYNC_CLIENT_ID`, `MAILSYNC_TENANT_ID` | —, `organizations` | Microsoft sign-in when `config.json` has none |
| `MAILSYNC_SINCE_DAYS` | `10` | Email history window |
| `MAILSYNC_TEAMS_SINCE_DAYS` | `30` | Teams chats, channels and meetings, first sync |
| `MAILSYNC_AI_SINCE_DAYS`, `MAILSYNC_CHATGPT_SINCE_DAYS` | `30` | Claude.ai / ChatGPT chats, first sync |
| `MAILSYNC_MAX_THREADS`, `MAILSYNC_MAX_PAGES`, `MAILSYNC_MAX_FOLDERS`, `MAILSYNC_MAX_QUEUE` | `25`, `2`, `3`, `1000` | Per-run budgets |
| `MAILSYNC_EXTRACT_TIMEOUT_SECONDS` | `180` | Note writer timeout |
| `MAILSYNC_PROVIDER` | `codex` | Note writer: `codex` (ChatGPT subscription), `openai`, `anthropic` |
| `MAILSYNC_MODEL`, `MAILSYNC_OPENAI_MODEL`, `MAILSYNC_ANTHROPIC_MODEL` | provider default | Model names |
| `BACKUP_PUSH` | `true` | `false` keeps backup commits local |
| `BRAIN_PORT` | `3131` | Local GBrain HTTP port |
| `RESTIC_REPOSITORY` (+ restic's own variables) | — | Optional encrypted restic copy of the whole vault after each backup |
| `GBRAIN_SYNC_EXCLUDE` | `life/,_setup/,templates/,AGENTS.md,CLAUDE.md,README.md` | Used by `scripts/windows/install-gbrain.ps1` for GBrain's own `sync.exclude` |

API keys are not settings: they live in `api-keys.json` in the state directory (plain JSON, outside the vault).

## Vault backup

The portal runs the backup on its schedule (Vault backup page): `git add -A` in the vault (respecting the vault's
`.gitignore`, and never any `.env` file or a `backup.localOnlyRepos` folder), a commit `backup: YYYY-MM-DD HH:mm` when
anything changed, then `git push <remote> HEAD` to every remote unless `BACKUP_PUSH=false`. Each local-only repo is
committed the same way and never pushed. A failed step marks the run as failed; the remaining steps still run.

## CLI

```powershell
cd app
bun run src/cli.ts config        # resolved configuration, settings file path and which keys it has (never values)
bun run src/cli.ts config init --name "Aisyah Rahman" --email aisyah@example.com --org "Contoh Sdn Bhd" --role founder `
  --pronouns she --account aisyah@example.com --vault C:\Users\aisyah\ThirdBrain --settings-file C:\path\to\old\.env
bun run src/cli.ts configure --client-id <UUID> --tenant-id <UUID>   # change the Microsoft app later
```

`config init` writes `config.json` from the given values plus `BRAIN_PATH`, `MAILSYNC_CLIENT_ID` and
`MAILSYNC_TENANT_ID` read from `--settings-file` (or the default settings file). `--client-id` and `--tenant-id`
(the app registration's Application and Directory IDs, UUIDs) win over the settings file. Other options: `--short-name`,
`--product`, `--force` (replace an existing `config.json`); `--email` can be repeated or comma-separated. It refuses
to write an invalid file. `vault.indexExclude` and `backup.localOnlyRepos` are edited by hand.

### Entities and links (GBrain-native)

```powershell
bun run src/cli.ts entities rebuild --dry-run   # counts only: notes scanned / to link, entity pages to write
bun run src/cli.ts entities rebuild             # writes, then commits and refreshes the index like a sync run
```

Scans every connector note (`inbox/email`, `inbox/teams`, `inbox/meetings`, `inbox/ai`), (re)writes all entity pages
under `inbox/entities/` and rewrites the People, Client and Project lines and old `- **DATE:**` event lines of existing
notes into the linked form. Running it again changes nothing. Sync runs keep the pages up to date afterwards. Then let
GBrain build the edges and timelines: `gbrain extract all` (or `gbrain extract links --include-frontmatter` and
`gbrain extract timeline`); to have sync include frontmatter links, set
`gbrain config set autopilot.incremental_extract_include_frontmatter true`. Details: architecture.md, section 8.

## Moving an existing install onto this repo

An install that ran from an older checkout (settings in a `.env` next to its scripts, state in `~/.brain-mailsync`)
keeps all state, cursors, feed ids and note paths if `config.json` points at that `.env`:

```json
{
  "owner": { "name": "<owner full name>", "shortName": "<first name>", "emails": ["<owner email>"],
             "org": "<organisation>", "role": "<role>", "pronouns": "<he|she|they>" },
  "vault": { "path": "<vault path>", "indexExclude": ["life/**", "<private folder>/**", "_setup/**", "templates/**"] },
  "microsoft": { "account": "<owner email>" },
  "settingsFile": "<vault path>\\_setup\\.env",
  "product": { "name": "<portal name>" }
}
```

Then run `bun run src/cli.ts config` and check the vault path, client id, account and settings keys before
starting the portal from `scripts/windows/serve-portal.ps1`.
