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
  Sync runs, Entities (people, companies, projects, topics; duplicate review), Dream (nightly linking), Usage
  (tokens and spend per provider), Vault backup, Remote access (Cloudflare tunnel), Settings.

## How it works

```mermaid
flowchart LR
  subgraph SRC["Sources"]
    direction TB
    MS["Outlook mail<br/>Teams chats and channels<br/>Meetings"]
    GM["Gmail"]
    CH["Claude.ai chats<br/>ChatGPT chats"]
  end

  subgraph SYNC["Third Brain sync"]
    direction TB
    FI["Filters and<br/>secret check"]
    DM["Decision model<br/>triage (optional)"]
    NW["Note writer<br/>ChatGPT subscription,<br/>OpenAI API or Claude API"]
    FI --> DM --> NW
  end

  subgraph VAULT["Markdown vault"]
    direction TB
    NO["Inbox notes"]
    EN["Entity and topic pages"]
    RN["Related notes"]
    GB["Git backup<br/>(private GitHub)"]
  end

  subgraph IDX["GBrain index"]
    direction TB
    SE["Keyword + semantic search<br/>(local Ollama embeddings)"]
    MCP["MCP server"]
    SE --- MCP
  end

  subgraph CLI["Clients"]
    direction TB
    LO["Claude Code, Codex<br/>(this computer)"]
    RE["Claude.ai, ChatGPT"]
    OB["Obsidian"]
  end

  MS -- "Microsoft Graph" --> FI
  GM -- "IMAP" --> FI
  CH -- "web sign-in" --> FI
  NW --> NO
  VAULT -- "gbrain sync" --> SE
  MCP --> LO
  MCP -- "Cloudflare tunnel + OAuth" --> RE
  VAULT -. "reads files" .-> OB

  PO["Portal<br/>settings, status,<br/>PWA and desktop app"] -.-> SYNC
  DR["Nightly Dream<br/>links, duplicates, embeddings"] -.-> VAULT
  DR -.-> IDX
```

- **Sources:** connectors read new items on a schedule: Outlook mail, Teams chats and channels and meetings through
  Microsoft Graph (read-only), Gmail over IMAP with an app password, and Claude.ai and ChatGPT chats through their
  web sign-ins.
- **Sync:** plain code drops noise and blocks passwords, one-time codes, card, bank and ID numbers and keys before any
  AI sees it. The optional decision model skips clear noise and personal matters; the note writer you choose turns
  each kept conversation into a short, sourced note.
- **Vault:** notes, entity and topic pages and related-note links are plain Markdown in your Obsidian vault. The
  vault backup commits it to Git and pushes it to your private GitHub repository.
- **Index and clients:** GBrain indexes the vault (keyword search plus semantic search with local Ollama embeddings)
  and serves it over MCP: to Claude Code and Codex on this computer, and to Claude.ai and ChatGPT only when you turn
  on remote access (Cloudflare tunnel, GBrain OAuth). The nightly Dream refreshes links, duplicates and embeddings.
- **Local-first:** the vault, the index, the state and the keys stay on your computer, and the portal answers on
  `127.0.0.1`. Only the AI providers you choose (note writer, decision model) receive conversation text.

The same diagram, with the screens, is in the [feature guide](docs/features.md#how-it-works).

## Screenshots

From the demo portal (`cd app && bun run demo`), with invented data. The full tour is in the
[feature guide](docs/features.md).

![Connectors: one card per source with its account, note count and last sync](docs/feature-screen/connectors-dark.png)

| Notes | Entities: review duplicates |
|---|---|
| ![Notes page with tabs per source, search and date filter](docs/feature-screen/notes-light.png) | ![Possible duplicate companies and people with Merge and Not the same](docs/feature-screen/entities-duplicates-dark.png) |
| **Gmail: what to include** | **Usage** |
| ![Gmail connector with tabs, labels and message counts](docs/feature-screen/connector-gmail-dark.png) | ![Tokens and spend per provider and per day](docs/feature-screen/usage-dark.png) |

## Important

- Claude.ai and ChatGPT chat sync use those sites' **unofficial web APIs** (as ossmalaysia/claude-sync does). They
  can break when the sites change, and each site's terms apply: you use them at your own risk, with your own
  account. Gmail uses IMAP with an app password; Outlook, Teams and meetings use the Microsoft Graph API.
- The ChatGPT subscription sign-in reuses the Codex CLI's public OAuth client and is **experimental**; API keys or a
  local model are the supported note writers.

## Layout

- `app/` - Bun server, sync pipeline, connectors and the portal UI (`app/portal`), with tests (`bun test`).
- `docs/` - architecture, operations, [configuration](docs/configuration.md), roadmap.

## Docs

- [Feature guide](docs/features.md) - every portal screen, with screenshots.
- [Configuration](docs/configuration.md) - `config.json`, the settings file and the CLI.
- [Operations](docs/operations.md) - Microsoft setup, Gmail, Claude.ai, updates, restarting the portal.
- [Architecture](docs/architecture.md), [decision model](docs/decision-model.md), [roadmap](docs/roadmap.md).
- Try the portal on invented data: `cd app && bun run demo`, then open http://localhost:58600/.

## Configuration

Nothing personal is in the code. Owner, vault path, Microsoft 365 account and product name come from `config.json`
in the state directory (`~/.brain-mailsync` by default); tuning settings from a `KEY=value` settings file. See
[`docs/configuration.md`](docs/configuration.md) and [`app/config.example.json`](app/config.example.json);
`bun run src/cli.ts config` (in `app/`) shows what is in effect.
- `scripts/windows/` - current Windows setup scripts (to be replaced by the built-in scheduler and wizard).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
