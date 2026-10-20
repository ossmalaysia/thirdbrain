# Changelog

All notable changes to Third Brain. Versions follow [semantic versioning](https://semver.org/). The app version is
`version` in `app/package.json`; the desktop app (`desktop/package.json`) keeps the same number.

## Unreleased

- **Install:** README Quick start and a full [install guide](docs/install.md) with troubleshooting;
  `scripts/windows/setup-scheduler.ps1` sets up the Docker sync schedule; `config init --client-id --tenant-id`;
  `THIRDBRAIN_PORT` changes the portal port; `install-gbrain.ps1` no longer adds a stdio GBrain server per agent
  (it locked out the portal's GBrain).

## 0.1.1 - 2026-10-20

- **Security:** fixes for all 10 findings of the first CodeQL code scan: the desktop "not running" page goes back
  only to the portal address, code sent to the Claude.ai browser takes its values as arguments, browser hosts are
  compared exactly, and HTML from Teams messages and attachments is reduced to plain text safely.
- **Project:** CI tests on every pull request; protected main branch (pull requests, checks, review); code owners;
  CodeQL code scanning; Dependabot with a 14-day cooldown for version updates; security policy and contributing guide.

## 0.1.0 - first release

- **Connectors:** Outlook mail (with attachment text), Teams chats and channels, meetings (transcript, or invite and
  meeting chat), Claude.ai (several accounts, each with its own sign-in) and ChatGPT chats. Each connector has its
  own sync interval; a history window with a usage estimate decides how far back the chat connectors read.
- **Note writer:** ChatGPT subscription (experimental), OpenAI API or Claude API, chosen on the Settings page.
- **Decision model:** optional TypeSafe Jev check of each new conversation, so the note writer skips what is
  clearly not worth keeping or clearly personal.
- **Entities and links:** pages for people, companies and projects, topic pages for common tags, related notes from
  a local embedding model, and duplicate pages merged automatically or after a model check (with Undo).
- **Dream:** nightly upkeep (related notes, duplicate check, entity rebuild, GBrain links and embeddings).
- **Search:** one shared GBrain server (keyword and semantic search, MCP) for Claude, ChatGPT, Claude Code and Codex.
- **Remote access:** Cloudflare tunnel (quick or named) on one public address, device sign-in links, GBrain OAuth
  for Claude.ai and ChatGPT, and security hardening (laptop-only settings, no logs over the tunnel).
- **Portal:** installable as an app (PWA) and usable on a phone; Notes, Sync runs, Entities, Usage, Vault backup
  (commit and push on a schedule), Remote access and Settings pages.
- **Desktop app:** Windows window and tray icon for the portal, with a Windows installer.
- **Updates:** the Settings page shows when a new release is on GitHub; a clean git checkout updates itself from
  the portal (fast-forward only, after the running sync finishes).
- **Gmail connector:** Primary inbox and Sent mail over IMAP (`imap.gmail.com:993`) with the Gmail address and an
  app password, no Google Cloud project. The add form guides through 2-Step Verification, the app password and IMAP,
  tests the sign-in before saving, and stores the password encrypted on the computer. Gmail threads become notes in
  `inbox/email/gmail/` with the same filters, decision model, attachment text, entities and related notes as Outlook
  mail; history window 1 month to 2 years (default 1 year), interval 15 minutes, a "Gmail" tab on the Notes page.
  The connected address counts as the owner. New dependencies: `imapflow` 2.2.5 and `mailparser` 3.9.35.
- **Gmail: What to include:** on the Gmail page, choose Primary, Sent, Important mail from the other tabs (these three
  by default), Updates, Promotions, Social, Forums and your own labels. Each choice shows how many messages it finds
  in the history window, and the card shows the AI use for the chosen mix before you save. Other choices (or the new
  default) make the next run read the window again; mail already in the brain is skipped.
