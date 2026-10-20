# Install guide

The full setup on Windows, from nothing to the first notes. The short version is the
[Quick start](../README.md#quick-start) in the README. Every command is for **PowerShell**.

Third Brain runs on **Windows 10 and 11** only for now. macOS and Linux are on the [roadmap](roadmap.md). The
paths below use `$HOME\thirdbrain` for the code and `$HOME\ThirdBrain` for the vault; any other folders work.

## What you need

| Item | Needed for | Install |
|---|---|---|
| Git | the code, the vault, backups | `winget install --id Git.Git -e` |
| Bun 1.4 or later | the portal and the sync | `winget install --id Oven-sh.Bun -e` |
| Docker Desktop | the automatic sync every 15 minutes | `winget install --id Docker.DockerDesktop -e` |
| A Microsoft 365 work or school account | Outlook, Teams and meetings; today every sync run needs it | - |
| An admin of that Microsoft 365 organisation | one app registration and its consent | - |
| A note writer: a ChatGPT subscription, an OpenAI API key or a Claude API key | turning conversations into notes | - |
| Obsidian (optional) | reading the notes | `winget install --id Obsidian.Obsidian -e` |
| Ollama (optional) | related notes, semantic search | `winget install --id Ollama.Ollama -e` |
| GBrain (optional) | search and MCP for Claude Code, Codex, Claude.ai, ChatGPT | step 6 below |
| cloudflared (optional) | remote access for Claude.ai and ChatGPT | `winget install --id Cloudflare.cloudflared -e` |

Open a **new** PowerShell window after you install, so that `git`, `bun` and `docker` are on the PATH. Check with
`git --version` and `bun --version`.

## 1. Get the code

```powershell
git clone https://github.com/ossmalaysia/thirdbrain $HOME\thirdbrain
cd $HOME\thirdbrain\app
bun install
```

Want to look around first? `bun run demo` starts a demo portal with invented data on http://localhost:58600/. It
needs no sign-in, Docker, Ollama or GBrain.

## 2. Create the vault

The vault is a plain folder of Markdown files and a Git repository. The sync commits every note it writes, so the
folder must be a Git repository with at least one commit.

```powershell
git init $HOME\ThirdBrain
git -C $HOME\ThirdBrain commit --allow-empty -m "Start vault"
```

If Git says `Please tell me who you are`, set your name and email once, then run the commit again:

```powershell
git config --global user.name "Your Name"
git config --global user.email you@example.com
```

Optional: open the folder in Obsidian (**Open folder as vault**). Notes appear under `inbox/`.

## 3. Register the Microsoft 365 app

Third Brain reads Outlook, Teams and meetings through Microsoft Graph with **your own** app registration. It only
reads; it never sends or changes mail. An admin of your Microsoft 365 organisation does steps 7 and 8 (or the whole
section).

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com) → **Applications** → **App registrations**
   → **New registration**.
2. Name: `Third Brain`. Supported account types: **Accounts in this organizational directory only**.
3. Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`. Click
   **Register**.
4. On the **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
5. Optional: under **Authentication**, set **Allow public client flows** to **Yes**. This is only needed for the
   `login --device-code` fallback.
6. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**. Add:
   `User.Read`, `offline_access`, `Mail.Read`, `Chat.Read`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`,
   `ChannelMessage.Read.All`, `Calendars.Read`, `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`.
7. Click **Grant admin consent for (your organisation)**. `ChannelMessage.Read.All` and
   `OnlineMeetingTranscript.Read.All` always need it, and the sign-in asks for all permissions at once.
8. Check that every permission shows **Granted**.

No client secret is needed: the portal signs in with authorization code + PKCE, and the tokens stay in the state
directory. Personal Microsoft accounts (outlook.com, hotmail.com) are not supported.

## 4. Write the configuration

```powershell
cd $HOME\thirdbrain\app
bun run src/cli.ts config init --name "Your Name" --email you@example.com --account you@example.com `
  --vault $HOME\ThirdBrain --client-id <Application (client) ID> --tenant-id <Directory (tenant) ID>
bun run src/cli.ts config
```

- `--name` and `--email`: you. The note writer uses them to tell your words from other people's. Repeat `--email`
  for more addresses. Optional extras: `--org`, `--role`, `--pronouns he|she|they`.
- `--account`: the Microsoft 365 mailbox to read. A sign-in to another mailbox is refused.
- `--vault`: the folder from step 2.

This writes `config.json` in the **state directory**, `%USERPROFILE%\.brain-mailsync`. Tokens, keys, logs and the
sync state also live there, never in the vault. The second command shows what is in effect. Every field is
explained in [configuration](configuration.md).

## 5. Start the automatic sync schedule

Start **Docker Desktop** and wait until it says it is running. Then:

```powershell
cd $HOME\thirdbrain
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup-scheduler.ps1
```

This builds and starts the `brain-scheduler` container (no network, no ports; it only drops a job request in
`%USERPROFILE%\.brain-mailsync\scheduler` every 15 minutes) and tells the portal to use it. The schedule starts
paused. Docker Desktop must run whenever you want automatic sync: turn on **Start Docker Desktop when you sign in**
in its settings.

Without Docker you can still sync by hand: `cd app; bun run src/cli.ts run --all`.

## 6. Optional: install GBrain (search and MCP)

GBrain indexes the vault and serves it to Claude Code, Codex, Claude.ai and ChatGPT. Without it the portal, the sync
and the notes still work, but nothing can search them over MCP.

Run this **before** you start the portal for the first time (GBrain's database allows one process):

```powershell
cd $HOME\thirdbrain
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\install-gbrain.ps1
```

It installs GBrain with Bun, creates its database in `%USERPROFILE%\.gbrain` (keyword search), registers the vault
as the source `brain` and indexes it. Later, to run GBrain commands such as `gbrain extract`, stop the portal first
(see [operations](operations.md)).

**Semantic search and related notes** (optional): install Ollama, then `ollama pull nomic-embed-text`. The portal's
nightly Dream links related notes with it (`http://127.0.0.1:11434`, or `OLLAMA_BASE_URL`). To have GBrain embed
the notes too, configure GBrain's Ollama embedding provider as described in GBrain's own documentation.

## 7. Start the portal

For a first try, in its own PowerShell window (it stops when you close the window):

```powershell
cd $HOME\thirdbrain\app
bun run src/portal.ts
```

To keep it running and start it at every Windows sign-in, register the `BrainPortal` task instead:

```powershell
cd $HOME\thirdbrain
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\register-portal-task.ps1
```

Open **http://localhost:58432/**. The portal answers on `127.0.0.1` only; on this computer no login is needed. To use
another port, set `THIRDBRAIN_PORT` (for example `$env:THIRDBRAIN_PORT = 58500`) before you start it.

## 8. Choose the note writer

**Settings** → **Note extraction**:

- **ChatGPT subscription** (experimental): click **Sign in with ChatGPT**. Port 1455 must be free.
- **OpenAI API** or **Claude API**: paste the API key, optionally a model name.

Click **Test connection**. The keys are stored encrypted in the state directory, never in the vault.

## 9. Connect Microsoft 365

**Connectors** → **Add connector** → **Microsoft 365** → **Connect Microsoft 365**. Sign in with the mailbox from
step 4 and accept the permissions. The button stays grey until the client ID is set (step 4).

## 10. Run the first sync

On **Connectors**, click **Resume** (the schedule starts paused), then **Sync now**. The first run reads the last 10
days of mail and 30 days of Teams and meetings, a few folders per run. Notes appear on the **Notes** page and in
`$HOME\ThirdBrain\inbox\`. **Sync runs** shows each run and any error.

## 11. Optional: more connectors

On **Add connector**:

- **Gmail**: IMAP with an app password, no Google Cloud project. Steps: [operations](operations.md#gmail).
- **Claude.ai**: a Microsoft Edge window opens; sign in to claude.ai there. Unofficial web API.
- **ChatGPT chats**: uses the ChatGPT sign-in from Settings. Unofficial web API.

Each chat connector first asks for a history window and shows the expected cost.

## 12. Optional: vault backup

Create an **empty, private** repository on GitHub, then:

```powershell
git -C $HOME\ThirdBrain remote add origin https://github.com/<you>/<private-repo>.git
git -C $HOME\ThirdBrain push -u origin HEAD
```

The portal's **Vault backup** page commits and pushes every hour. Never make this repository public: it holds your
mail and chat notes.

## 13. Optional: remote access (Claude.ai and ChatGPT)

Needs GBrain (step 6) and cloudflared. On **Remote access**, choose **Quick tunnel** (a random address that changes
on restart) or **Named tunnel** (your own hostname and a Cloudflare tunnel token). Copy the address into Claude.ai or
ChatGPT as a custom connector, then approve the connection with **Sign in to GBrain admin**. Details:
[feature guide](features.md#remote-access). `scripts\windows\setup-tunnel.ps1` (Tailscale Funnel) is an older way
and is not needed.

## 14. Optional: desktop app

Download `ThirdBrain-Setup-<version>.exe` from the [latest release](https://github.com/ossmalaysia/thirdbrain/releases/latest)
and run it. It is not code-signed yet, so Windows SmartScreen asks once: **More info** → **Run anyway**. The app is
only a window and tray icon for the portal; the portal itself must run (step 7). See
[desktop/README.md](../desktop/README.md).

## Connect Claude Code and Codex

The portal runs **one** GBrain server on `http://127.0.0.1:3131/mcp` (`BRAIN_PORT`). Connect each agent to it with
its own token. Never add a separate `gbrain serve` per agent: the second server locks out the first.

1. Stop the portal (see [operations](operations.md), "Restarting the portal").
2. Create a token per agent: `gbrain auth create claude-code-local --scopes read,write`. Copy the token it prints.
3. Start the portal again.
4. Claude Code:
   `claude mcp add --transport http gbrain http://127.0.0.1:3131/mcp --header "Authorization: Bearer <token>" -s user`
5. Codex: in `~/.codex/config.toml`, add an `[mcp_servers.gbrain]` entry with `url = "http://127.0.0.1:3131/mcp"`
   and `bearer_token_env_var = "GBRAIN_CODEX_TOKEN"`, and set that user environment variable to a second token.

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| `bun` or `git` is not recognized | Open a new PowerShell window after the install. |
| `Failed to start server. Is port 58432 in use?` | The portal already runs (the `BrainPortal` task), or another program uses the port. Open http://localhost:58432/, or start with another `THIRDBRAIN_PORT`. |
| **Connect Microsoft 365** is grey | No client ID. In `app`, run `bun run src/cli.ts configure --client-id <id> --tenant-id <id>`, then reload the page. |
| Microsoft sign-in: `AADSTS50194` (not configured as a multi-tenant application) | The tenant ID is missing, so the sign-in used `organizations`. Set `--tenant-id`. |
| Microsoft sign-in: `AADSTS50011` (redirect URI does not match) | Add the redirect URI `http://localhost` under the **Public client/native** platform (step 3). |
| Microsoft sign-in: **Need admin approval** | An admin must click **Grant admin consent** (step 3, item 7). |
| `Signed into a different Microsoft mailbox` | You signed in with another account than `--account`. Use **Reconnect** and pick the right account. |
| **Sync now**: `Docker scheduler or the local worker is unavailable` | Start Docker Desktop and run `setup-scheduler.ps1` (step 5). The portal must also run. |
| **Sync now**: `Resume automatic sync first` | Click **Resume** on Connectors. |
| **Sync now**: `Connect Outlook first` | Every run starts with the Microsoft 365 sign-in (step 9). |
| A run fails with `git status: ... not a git repository` | The vault is not a Git repository. Run step 2. |
| A run fails with `git commit` and `Please tell me who you are` | Set `git config --global user.name` and `user.email`. |
| ChatGPT sign-in never finishes | Port 1455 is taken by another program. Stop it and sign in again. |
| No search in Claude Code, Remote access shows GBrain stopped | GBrain is not installed (step 6), or another `gbrain serve` holds its database. |
| `config.json ... is not valid JSON` | Fix or remove `%USERPROFILE%\.brain-mailsync\config.json` and run `config init` again. |

Logs: `%USERPROFILE%\.brain-mailsync\logs\<date>.jsonl` (IDs and outcomes, never mail text).
`bun run src/cli.ts status` (in `app`) shows the sign-in, the queue and the last run.

## Uninstall

1. `Unregister-ScheduledTask BrainPortal` (if you registered it), then end the `bun` process of `src/portal.ts`.
2. `docker rm -f brain-scheduler`.
3. Delete `$HOME\thirdbrain` and `%USERPROFILE%\.brain-mailsync` (tokens and keys). Keep the vault: it is yours.
4. Optional: delete the app registration in Microsoft Entra, and `%USERPROFILE%\.gbrain` for GBrain.
