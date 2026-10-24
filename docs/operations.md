# Local Outlook collector

The collector reads Outlook, uses Codex to extract useful knowledge, writes thread notes under `inbox/email/`, commits that folder, and refreshes GBrain through the running local MCP server. It requires no public URL or incoming connection. State, token cache, logs, schemas and dry-run samples live under `%USERPROFILE%\.brain-mailsync`, outside the vault.

## Microsoft setup

The app is a single-tenant Microsoft Entra public client with browser sign-in using authorization code + PKCE and a registered desktop redirect URI of `http://localhost`. “Public client” describes a desktop app without a client secret; it does not publish the collector. Use delegated `Mail.Read`, `User.Read` and `offline_access`, plus the Teams and meeting permissions under [Teams and meetings](#teams-and-meetings) (the sign-in asks for all of them at once). Mailbox sign-in and consent are completed by the owner (the mailbox in `microsoft.account`, see [configuration](configuration.md)). No send or write mail permissions are requested. Step-by-step registration: [install guide](install.md#3-register-the-microsoft-365-app).

The persistent connector portal is **http://localhost:58432/**. Register/start it with `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/register-portal-task.ps1`. `BrainPortal` starts at Windows sign-in and keeps the portal available; closing a browser tab does not stop collection. Click **Connect Outlook** or **Reconnect** to complete Microsoft sign-in. The portal remains open after connection.

**Restarting the portal** (needed after changing portal code, e.g. `src/claude-web/`; sync runs load code fresh each run): `Stop-ScheduledTask BrainPortal` does NOT stop it, because the task's hidden `conhost` launcher exits and leaves `bun run src/portal.ts` running. Pause sync on the portal, wait until no run is active, then end the `bun` process running `src/portal.ts` together with its children (`taskkill /PID <pid> /T /F`) and `Start-ScheduledTask BrainPortal`. GBrain, cloudflared and the Claude.ai window restart with it; the named-tunnel address (e.g. `brain.example.com`) does not change.

The portal binds to `127.0.0.1` only. OAuth state rejects mismatched callbacks; PKCE keeps the code verifier in memory and callback codes are cleared by redirecting to the clean portal URL. Tokens are saved outside the vault and never returned to the browser. Local controls require a per-server nonce and matching origin. No public endpoint, tunnel or incoming firewall rule is required.

To commission a new install from the command line instead of the portal (run from the repository root): `login` opens a temporary connection listener at `http://localhost:58434/`, which stops after sign-in or a 15-minute timeout; `login --device-code` is an optional fallback (needs **Allow public client flows** on the app registration).

```powershell
bun run app/src/cli.ts login
bun run app/src/cli.ts run --dry-run --limit 5
bun run app/src/cli.ts run --limit 5
# Resume automatic sync in the local portal after commissioning succeeds.
```

The Docker container `brain-scheduler` owns the quarter-hour schedule. It shares only `%USERPROFILE%\.brain-mailsync\scheduler` with the host, with no network access or published ports. The portal's Windows worker polls that directory and launches the existing collector, using the owner's saved ChatGPT subscription login for Codex and local GBrain IPC. `BrainPortal` starts this worker at Windows sign-in; Docker Desktop must also be running. Collection works while the Windows session is locked. The container uses `restart: unless-stopped`, and the worker recovers interrupted requests without duplicate notes. `BrainRunner` has been removed; Vault backup is scheduled by the portal itself (see the Vault backup page); the `BrainBackup` task was removed on 2026-10-15.

Set up or update the schedule with `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/setup-scheduler.ps1`: it writes `scheduler\backend.json` (`{"backend":"docker"}`, which switches the portal to the Docker schedule) and runs `docker compose up -d --build`. The schedule starts paused; **Resume** on the portal enables it. Without `backend.json` the portal falls back to a legacy `BrainRunner` scheduled task, which no script in this repository creates. For direct Docker commands, set `$env:BRAIN_SCHEDULER_DIR = Join-Path $env:USERPROFILE '.brain-mailsync\scheduler'`, then use `docker compose -f app/docker/compose.yaml ps` or `logs`. The build context contains scheduler code only.

## Change the historical window

```powershell
bun run app/src/cli.ts configure --days 30
bun run app/src/cli.ts run
```

Changing 10 to 30 days automatically restarts retrieval with the wider window. Old pagination links are discarded but the processed-message ledger is retained. Unchanged messages are skipped before extraction; changed content updates the thread's owned inbox note. Shrinking the window does not delete notes. `run --resync` explicitly restarts pagination with the configured range and keeps deduplication. `--backfill` is an alias for `--resync`. `run --days N` overrides the range for one run; `configure --days N` is the persistent setting.

## Coverage and checkpoints

Each folder is scanned separately, including nested/custom folders, Archive and Sent. Junk, Deleted and Drafts (including their descendants) are excluded. Inbox and Sent are prioritized on first discovery, with round-robin folder scheduling thereafter. `Mail.Read` covers bodies; attachments are not archived by this version. Notes retain links back to Outlook. Noise, credentials and personal/family matters are filtered under the vault's existing policy.

Historical retrieval uses paginated Graph `/messages` scans rather than filtered delta: Microsoft's filtered message-delta query has a 5,000-message limit. Each completed sweep starts another reconciliation of the configured window. This uses more read requests than delta, but provides complete range re-scans and straightforward recovery. The default budget is three folders and two pages of 50 messages each per run, then up to 25 extracted threads. Larger folders resume from their next-page link. Queue backpressure pauses retrieval when 1,000 messages await extraction. A widened window completes over multiple scheduled runs; the applied range alone does not mean every folder is complete.

The ledger uses immutable Graph message IDs and SHA-256 fingerprints of meaningful message content. Folder moves, changed web links and read/unread changes do not trigger repeat extraction. A copy is a distinct Outlook message ID. Fingerprints and outcomes persist for kept, rejected and secret-blocked messages. Promoted notes outside `inbox/email/` are never edited.

Fetched/filtered items and pagination links are checkpointed before Codex runs. Notes are written atomically, then the processed ledger is checkpointed before git/index refresh. Failed extraction stays queued; failed indexing retries even with no new notes. Logs contain IDs and outcomes, not mail bodies or subjects. Codex token counts are recorded; dollar cost is not reported by ChatGPT-authenticated CLI runs.

## Status

Open **http://localhost:58432/** for live queue/processed/note counts, history coverage, last-run metrics/errors and pending GBrain indexing. **Sync now** requests work from the same Windows worker used by Docker; it does not create a second ingestion writer. **Pause/Resume** persists the Docker schedule's enabled flag; pausing allows an active run to finish. **Sync runs** shows lifetime counts for attempts/successes/failures/skips and the latest 20 attempts, with start time, trigger, duration, fetched messages, written notes, remaining queue and safe failure details. The latest 100 attempts are retained outside the vault; lifetime counters survive restarts. These counters begin at the Docker migration and do not claim to include earlier Windows runs. Settings persist the historical window and maximum threads per run, applying on the next run. Coverage is the number of folders whose pagination completed for the configured range; a configured/applied range alone does not mean the whole historical backfill has finished. Other connector cards are explicitly planned, with no active ingest behind them yet.

```powershell
bun run app/src/cli.ts status
docker ps --filter name=brain-scheduler
Get-ScheduledTask -TaskName BrainPortal
```

CLI status reports the configured/applied lookback, token-cache presence, processed IDs, owned notes, queued items, each folder's last completed scan, pending indexing and the last run/error. Token-cache presence is not a guarantee that Microsoft will still accept a refresh token; expired/revoked consent requires reconnecting. The local portal returns operational metadata plus, on the Sync runs page, the vault paths of notes each run wrote and a read-only preview of those notes (only `inbox/email/*.md` files listed in run history; anything else is refused). It never returns raw messages, token contents or Graph pagination links. Each note also has an Open in Obsidian link (`obsidian://` to the `brain` vault). Integration into the GBrain extension and its MCP status tools remains separate work.

## Note extraction provider

Portal **Settings** chooses which AI turns each thread into a note: **ChatGPT subscription** (the portal signs in itself, like Codex CLI: OAuth + PKCE with Codex's public client and a one-shot listener on `127.0.0.1:1455`; tokens are saved AES-256-GCM-encrypted in `%USERPROFILE%\.brain-mailsync\chatgpt-auth.json`, refreshed automatically, and used to call ChatGPT's Codex endpoint directly. Until you sign in there, the Codex CLI login is used. Port 1455 must be free: ChatGPT only redirects to `localhost:1455`, so any other program on that port receives the code instead. Experimental: the client id is borrowed and the endpoint is not public, so it can break or be blocked; the API-key providers are the supported fallback. Adapted from EzyChat Lite, MIT), **OpenAI API** (Responses API, strict JSON schema, default model `gpt-5`) or **Claude API** (`@anthropic-ai/sdk`, structured outputs, default `claude-opus-5-5` at effort `medium`, with server-side `fallbacks: "default"` so a safety-declined thread is retried on Anthropic's recommended model). The choice and model names live in the settings file (`MAILSYNC_PROVIDER`, `MAILSYNC_*_MODEL`; see [configuration](configuration.md)); API keys live only in `%USERPROFILE%\.brain-mailsync\api-keys.json`, outside the vault, and the browser only ever sees the last four characters. *Test connection* checks the key and model with a model lookup (no tokens spent). Provider errors are classified (rejected key, rate or credit limit, unknown model, timeout) without storing provider text, and stop the batch so queued email retries on the next run. Email thread text is sent to whichever provider is selected.

## Teams and meetings

The same connector reads Teams 1:1 and group chats (`inbox/teams/chats/`), Teams channel post threads (`inbox/teams/channels/`) and finished meetings (`inbox/meetings/`) every run, with a 30-day first sync (`MAILSYNC_TEAMS_SINCE_DAYS`). Meetings come from the calendar; when transcription was on, the transcript is used (re-checked for 24 hours, since transcripts arrive late), otherwise the invite text and meeting chat. Sign-in asks once for `Chat.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All Calendars.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All` (all read-only); `ChannelMessage.Read.All` and `OnlineMeetingTranscript.Read.All` need tenant admin consent. Teams/meetings use their own access token: if a permission is missing, the run records it (Connectors shows "Needs permission") and email keeps syncing. Email-only noise rules (newsletters, no-reply senders, calendar notices) don't apply to Teams; the secret check does.

## Email attachments

When an email thread is extracted, its file attachments are read into the AI prompt (option B, 2026-10-16): PDF (text layer, via `unpdf`), Word, PowerPoint, Excel (via `fflate`, no Office needed) and text-like files (txt, csv, md, json, html, xml, ics). Images, archives and other binaries, files over 15 MB, scanned PDFs without a text layer and damaged or password-protected files are listed by name only; a document whose text looks like it contains credentials is withheld. Text is capped at 20,000 characters per file and 40,000 per email. Attachments are downloaded only for threads extracted in that run, never stored in the vault, Git or the queue; the note gets an **Attachments** section saying which files were read. Emails processed before this change are not re-read.

## Gmail

Gmail is read over IMAP (`imap.gmail.com:993`, TLS) with your Gmail address and an **app password**. No Google Cloud
project and no OAuth app are needed. Before you add it (Connectors → Add connector → Gmail; the form shows the same
steps with links):

1. [Turn on 2-Step Verification](https://myaccount.google.com/signinoptions/twosv) for your Google account. Skip this
   if it is already on.
2. [Create an app password](https://myaccount.google.com/apppasswords). Type the name Third Brain and click Create.
3. Copy the 16-character password Google shows (spaces do not matter) and paste it into the form.
4. [Make sure IMAP is on in Gmail](https://mail.google.com/mail/u/0/#settings/fwdandpop), if your Gmail settings show
   the option. It is on by default for most accounts.

The form tests the sign-in (LOGIN, then the All Mail folder) before anything is saved. A refused sign-in names the
step to repeat: a wrong or revoked password is step 2, an account without app passwords is step 1, IMAP turned off is
step 4. The password is stored encrypted in the state directory (`gmail.json`, AES-256-GCM with `secret.key`),
never in `config.json`, the vault, the logs or the browser; **Disconnect** deletes it. To revoke access from the
Google side, delete the app password at the same page.

What is read is set on the Gmail page under **What to include**, inside the history window (default 1 year; 1 month,
6 months, 1 year or 2 years, with the same usage estimate as the chat connectors):

| Choice | Default | Gmail search term |
|---|---|---|
| Primary | on | `category:primary` |
| Sent | on | `in:sent` |
| Important mail from other tabs | on | `(is:important -category:primary)` |
| Updates, Promotions, Social, Forums | off | `category:updates`, `category:promotions`, `category:social`, `category:forums` |
| Labels (your own, from the account's label list) | none | `label:"Name"` (names with quotes or backslashes cannot be chosen) |

The choices are joined with OR, so the default search is
`(category:primary OR in:sent OR (is:important -category:primary)) -in:spam -in:trash -in:chats after:YYYY/MM/DD`.
Spam, trash and chat logs are always left out. The card shows how many messages each choice finds in the window
(**Count**; counts are kept for an hour) and the AI use for the chosen mix (new threads to summarise, tokens and
time, with the same per-thread figures as the history window dialog). The choices are stored in
`gmail-settings.json` in the state directory (no secret in it). Other choices make the next run read the whole window
again: the cursor keeps a key of the choices, so this also happens on its own when the default changes. Messages
already in the brain are recognised (same Gmail id and content) and skipped, so only new threads are summarised.

Technically: one search in the special-use `\All` folder (found by its flag, so a localized "All Mail" name works; it
must have **Show in IMAP** ticked under Gmail settings → Labels) with Gmail's `X-GM-RAW` extension. Threads are
Gmail's own (`X-GM-THRID`); each thread is one note in `inbox/email/gmail/` (`source: gmail-sync`,
`kind: email-thread`, link "Open in Gmail"). The same filters, decision model, attachment text, entities, related
notes and secret check apply as for Outlook mail.

Progress: the cursor is the All Mail UIDVALIDITY, the last UID read and the key of the choices. Each run reads the oldest 200 new messages,
so a large backfill finishes over several runs and nothing is skipped. If Gmail rebuilds the folder (new
UIDVALIDITY), reading starts again from the window; messages already in the brain are recognised and not summarised
again. Every network step has a time limit; a silent or unreachable server ends the Gmail feed for that run with a
clear error and never stops Outlook or the other connectors. Default interval: 15 minutes.

Owner: the connected address counts as yours (mail from it is your own words, and you get no person page for it).
It is recorded in `owner-identity.json` in the state directory, next to `owner.emails` from `config.json`
(which is not edited), and it stays there after a disconnect so existing notes keep treating it as you.

## WhatsApp

WhatsApp chats come in through a **linked device**, the same way as WhatsApp Web, with the open-source
[Baileys](https://github.com/WhiskeySockets/Baileys) library. There is no official API for personal WhatsApp
accounts, so this connector is **unofficial**: WhatsApp's terms do not permit it, and an account that uses it can be
banned. If you are not sure, link a second number first.

How it works:

- **Add connector -> WhatsApp** shows a QR code. On the phone open WhatsApp -> Settings (iPhone) or the menu
  (Android) -> **Linked devices** -> **Link a device** and scan it. The code changes every few seconds.
- The portal runs the link in its own process (`cli.ts whatsapp-worker`) and starts it again after a restart.
- It is **read-only**: it never sends messages, presence or read receipts.
- Text messages of all chats are stored in `whatsapp/whatsapp.db` in the state folder, outside the vault. The message
  text and the sign-in keys are encrypted with the state folder's key; chat and contact names are not, so the chat list
  can show them. Photos, videos, voice messages and documents are stored as a marker such as `[photo]`.
- On the WhatsApp page, **Chats to include** chooses the chats that become notes: **Chosen chats** (only the ticked
  chats; none at first; new chats stay off) or **All chats** (every chat, also chats that start later, except the
  unticked ones). **Tick all shown** / **Untick all shown** act on the current search and filter. Only those chats
  reach the note writer: one note per chat per month in `inbox/whatsapp/chats/`, with the usual secret check,
  decision model, entities and related notes. Phone numbers are never written into notes.
- **History window** (WhatsApp card, Change): 1 month until you choose 6 months, 1 year or 2 years. Messages sent
  before the window are passed over; widening it reads them on the next run (messages already summarised are skipped).
- WhatsApp sends a part of the history when you link (usually the recent months). Older history is not available
  through a linked device.
- Your phone must connect to the internet at least every 14 days, or WhatsApp signs out all linked devices.
- **Disconnect** removes this computer from the phone's Linked devices list and deletes the local store. Notes
  already written stay.

If the WhatsApp card shows **Signed out on the phone**, the device was removed on the phone (or by WhatsApp): click
**Link again**.

## Claude.ai chats

Connectors → **Connect Claude.ai** opens a dedicated Microsoft Edge window (profile `%USERPROFILE%\.brain-mailsync\claude-browser`, DevTools on 127.0.0.1:9333). Sign in to claude.ai there once; the portal detects it (`/api/organizations` = 200, as ossmalaysia/claude-sync does), minimises the window and keeps it running while connected (relaunching it minimised after a reboot). Each sync connects to that window, lists chats newest first in every organisation, stops at the last seen `updated_at`, reads only changed chats (the on-screen branch), and the pipeline turns new messages into `inbox/ai/claude/` notes. First sync: 30 days (`MAILSYNC_AI_SINCE_DAYS`). Plain HTTP is not possible (Cloudflare challenge), and the endpoints are undocumented: a site change shows as a Claude.ai problem on Connectors while email and Teams keep syncing. **Disconnect** closes the window and deletes its profile.

## Updates

The Settings page's **Updates** card shows this install's version (`app/package.json`, plus the git commit) and the
latest GitHub release. The portal asks GitHub 60 seconds after it starts and then every 6 hours (**Check now** asks
at once); the answer is cached in `updates.json` in the state directory, and a failed check keeps the last answer.
For a private repository the check uses the GitHub CLI (`gh auth login` once); otherwise the public API.

**Update now** (laptop only) works when the install is a git checkout of the release repository, on `main`, with no
local changes. It pauses the automatic sync, waits for a running sync to finish (at most 30 minutes), runs
`git fetch --tags origin`, checks that the release tag is on `origin/main`, runs `git merge --ff-only origin/main`
and `bun install` in `app/`, resumes the sync and restarts the BrainPortal task. Any failed step stops the update,
resumes the sync and shows the reason on the card. Other installs: download the new version from the release page.
Release checklist: bump `version` in `app/package.json` and `desktop/package.json`, add a `CHANGELOG.md` entry,
tag `vX.Y.Z` on `main` and publish a GitHub release (attach the Windows installer `.exe`).
