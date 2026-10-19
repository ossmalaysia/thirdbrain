# Roadmap

Third Brain starts as code extracted from one person's working setup. To become an app anyone can install on
Windows or macOS:

## Phase 1 - Extract (in progress)
- Code only in this repo; no notes, state or credentials (all app state lives in the user's home folder, never in
  the vault or in git).
- Done: one `config.json` replaces every personal value that was in code: owner name, emails and organisation (used
  in the note writer prompt), the Microsoft 365 account, vault path, product name in the UI, index exclusions; a
  test fails if personal names, domains or paths come back ([configuration](configuration.md)).
- Done: vault backup in TypeScript (no `backup.ps1`).
- A small `platform/` layer for OS-specific actions (open URL, kill a process tree, find Edge/Chrome, cloudflared,
  gbrain).

## Phase 2 - Cross-platform
- Built-in scheduler in the app (no Windows Task Scheduler, no Docker).
- macOS paths and behaviour.
- Rename the default state directory (`~/.brain-mailsync`) with a migration.
- CI on Windows and macOS.

## Phase 3 - Setup wizard
1. Owner profile. 2. Vault: create (folders, AGENTS.md, templates) or pick one; install/open Obsidian.
3. Private GitHub backup with `gh`. 4. Note writer: ChatGPT subscription (experimental), OpenAI API, Claude API, or
   a local model (Ollama / OpenAI-compatible). 5. GBrain install + first index + MCP registration for Claude Code /
   Codex. 6. Connectors with history window and cost estimate. 7. Optional remote access (Cloudflare tunnel, OAuth
   client for Claude.ai, device links).

## Phase 4 - Desktop app
Electron shell running the bundled Bun server: tray (status, Sync now, Open vault), start at login, auto-update,
installers for Windows (.exe) and macOS (.dmg, signed and notarised).

## Phase 5 - Release
Docs, security review and `SECURITY.md`, demo vault, public release under OSS Malaysia.

## Known risks
- Claude.ai / ChatGPT chat sync rely on unofficial web APIs.
- ChatGPT subscription sign-in borrows the Codex CLI OAuth client (experimental, may be blocked).
- Microsoft 365: each user registers their own Entra app at first; a verified multi-tenant app may follow.
- Before going public: scrub personal details from code, docs and test fixtures, and start public history from a
  clean commit; run a secret scanner (e.g. gitleaks) in CI.
