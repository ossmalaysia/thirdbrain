# Third Brain

> 1st brain: your head. 2nd brain: your notes. **3rd brain: the layer that captures what you do across your tools
> and gives it to every AI you use.**

Third Brain is a local-first, open-source app by **OSS Malaysia**. It turns your email, Teams chats and meetings,
Claude.ai and ChatGPT conversations into short, sourced Markdown notes in your own Obsidian vault, backs the vault up
to a **private** GitHub repo, and serves it to Claude, ChatGPT, Claude Code and Codex through a local search + MCP
server ([GBrain](https://github.com/garrytan/gbrain)).

**Status: early, private.** This repo is being extracted from a working personal setup. See
[`docs/roadmap.md`](docs/roadmap.md) for the plan (config instead of personal values, macOS support, setup wizard,
desktop app for Windows and macOS).

## What it does today

- **Connectors:** Outlook mail (with attachment text), Gmail (Primary, Sent and Important mail by default, or the tabs and labels you choose;
  over IMAP with an app password, no Google Cloud project), Teams chats and channels, meetings (transcripts), Claude.ai chats (several accounts,
  projects, documents), ChatGPT chats (projects, canvas documents).
- **Note writer:** your choice of ChatGPT subscription (experimental), OpenAI API, Claude API, or a local model.
- **Safety:** credential check before any AI sees text, personal-matter skip rule, nothing leaves your machine
  unless you turn on remote access or a backup push.
- **Portal:** Connectors (add, accounts, history window with cost estimate), Notes (search, date filter, paging),
  Sync runs, Usage (tokens and spend per provider), Vault backup, Remote access (Cloudflare tunnel), Settings.

## Important

- Claude.ai and ChatGPT chat sync use those sites' **unofficial web APIs** (as ossmalaysia/claude-sync does). They
  can break when the sites change, and each site's terms apply: you use them at your own risk, with your own
  account. Gmail uses IMAP with an app password; Outlook, Teams and meetings use the Microsoft Graph API.
- The ChatGPT subscription sign-in reuses the Codex CLI's public OAuth client and is **experimental**; API keys or a
  local model are the supported note writers.

## Layout

- `app/` - Bun server, sync pipeline, connectors and the portal UI (`app/portal`), with tests (`bun test`).
- `docs/` - architecture, operations, [configuration](docs/configuration.md), roadmap.

## Configuration

Nothing personal is in the code. Owner, vault path, Microsoft 365 account and product name come from `config.json`
in the state directory (`~/.brain-mailsync` by default); tuning settings from a `KEY=value` settings file. See
[`docs/configuration.md`](docs/configuration.md) and [`app/config.example.json`](app/config.example.json);
`bun run src/cli.ts config` (in `app/`) shows what is in effect.
- `scripts/windows/` - current Windows setup scripts (to be replaced by the built-in scheduler and wizard).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
