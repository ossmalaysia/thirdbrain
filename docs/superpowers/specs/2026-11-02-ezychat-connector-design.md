# EzyChat connector - design

Date: 2026-11-02. Status: approved to build (owner asked to implement directly; choices below marked "builder's
call" were made without a question round).

## Intent

EzyChat (Lite or Enterprise) is the business WhatsApp team inbox where customers talk to the company. Third Brain
already syncs the owner's personal WhatsApp. This connector brings the **business customer conversations** into the
vault in the same shape as the other chat connectors, so that a customer's EzyChat chats, emails and meetings meet on
one entity page ("consistent data").

## Goals

- Read customer chats from one EzyChat instance (Lite or Enterprise, any number of inboxes) on a schedule.
- One note per chat per month in `inbox/ezychat/chats/YYYY-MM/`, `source: ezychat-sync`, same pipeline as the other
  feeds (filters, decision model, note writer, entities, related notes, commit).
- Connect from the portal with the EzyChat address and a token; test before saving; disconnect.

## Non-goals

- Sending messages, changing the AI agent setup, or any write to EzyChat. The token needs `inbox:read` only.
- Media files (EzyChat describes media by type and name only; that description is enough).
- Several EzyChat instances (one connection; a later change can add more, like Claude.ai accounts).

## Anti-goals

- No phone numbers in notes (same rule as WhatsApp). The customer is named by the chat name; a chat without a name is
  "EzyChat customer".
- A failing EzyChat (offline computer, tunnel down, bad token) never stops email or the other feeds
  (`optionalFeed`).
- Never wait inside the run for a rate limit (lesson from ChatGPT, 2026-10-18): a 429 ends the feed for this run.

## Source of data (decided)

EzyChat's own MCP server: `POST <address>/mcp`, Streamable HTTP in **stateless JSON mode** (one JSON-RPC request per
POST, no session, no SSE), header `Authorization: Bearer <token>`. The token comes from EzyChat Admin -> Settings ->
Integrations -> "For developer tools" (personal access token). The server is open source:
`github.com/ossmalaysia/ezychat-lite`, `packages/server/src/mcp/` (`tools.ts`, `route.ts`, `transport.ts`) and the
input schemas in `packages/shared/src/mcp.ts`. Limits there: 60 requests a minute per token, 120 per IP; the endpoint
answers only on the EzyChat computer or through its tunnel (an `https://` address).

Tools used (read scope):

- `list_chats { since?: epoch ms, cursor?, limit<=100, status?, inboxId? }` -> `{ chats: [{ jid, inboxId?, inboxName?,
  type, name, phone, status, assignedTo, lastMessageAt, tags }], nextCursor }`, newest activity first.
- `get_messages { jid, before?, limit<=100 }` -> messages oldest first within a page, `nextBefore` to page back.
  Message: `{ id, at, from: "team"|"customer", sender, type, text, truncated?, isVoiceTranscript?, media, status }`.
- `get_stats` for the portal's Test button.

Builder's call: call the MCP tools with plain `fetch` JSON-RPC (`tools/call`), no MCP SDK dependency. Check the exact
response envelope (`result.content[0].text` JSON, or `structuredContent`) against the EzyChat source.

## Behaviour

- **Feed** `ezychat`, optional, own "Sync every" interval and history window (backfill feed `ezychat`, default 1 month,
  like WhatsApp).
- **Cursor** (builder's call): JSON `{ since: epoch ms of the newest lastMessageAt fully read, chats: { jid: newest
  message id or time read } }`. A run lists chats changed since `since` (all pages), reads the oldest-changed first,
  pages messages back only to the chat's mark (or the history window start), and moves marks only past what it read,
  so a run that stops early continues next time.
- **Budget** (builder's call): at most 40 chats and 50 MCP calls per run; the rest follow in later runs.
- **Items**: `source: "ezychat"`, `id: ezychat:<jid>:<message id>`, `threadId: ezychat:<jid>:<YYYY-MM>`, customer
  messages from the customer (chat name), team messages from the named team member (or the owner when `sender` is
  "phone"), folder `inbox` / `sentitems` like WhatsApp. Subject `<chat name> (EzyChat)`; with several inboxes
  `<chat name> (EzyChat, <inbox name>)`. Empty texts are skipped; media without text becomes `[image: name]` style.
- **Render**: new source entry in `src/core/render.ts`: dir `inbox/ezychat/chats`, kind `ezychat-chat`, source
  `ezychat-sync`, tag `ezychat`, unit `chat`, link text "Open in EzyChat" only if a stable chat link exists (else none).
- **Tags on the chat** (EzyChat labels) go into the prompt so the note writer can use them; status and assignee too.

## Sign-in (decided by the owner: OAuth, no token to copy)

EzyChat's MCP sign-in (`packages/server/src/mcp/oauth.ts`, `oauth-routes.ts`): OAuth 2.1 with dynamic client
registration (RFC 7591), PKCE S256 only, loopback `http://localhost` / `127.0.0.1` redirect URIs allowed, the admin
approves on EzyChat's page, and the code is exchanged for an ordinary personal access token (**no refresh token, no
expiry**; revoked in EzyChat Settings -> Integrations). Flow in the portal:

1. The owner enters the EzyChat address (with or without `/mcp`) and clicks **Connect**.
2. The portal discovers the endpoints (`/.well-known/oauth-protected-resource/mcp` -> authorization server metadata),
   registers itself once (client name "Third Brain", redirect URI on the portal's own loopback address), keeps the
   client id, makes a PKCE verifier and state, and sends the browser to the authorize URL (with `resource`).
3. EzyChat shows its approval page; the admin approves; the browser returns to the portal callback.
4. The portal checks state, exchanges the code (`resource`, `code_verifier`), stores the access token encrypted with
   `secret-box.ts`, and calls `get_stats` to show that it works.

Same shape as the Microsoft **Connect** in the portal (state check, one-time code cleared from the URL). Laptop only
(the redirect is loopback; over the remote address the button explains this). A 401 later means the app was removed
in EzyChat: the page shows **Reconnect**. Token entry by hand is not offered.

## Portal

An EzyChat page (or card on the connectors page, following the Gmail pattern): address, **Connect** /
**Reconnect**, **Disconnect** (forgets the token and client; tells the owner to remove "Third Brain" under EzyChat
Settings -> Integrations -> Connected apps), Sync every, history window, status (inbox name or chat count from
`get_stats`, last run, last error). The token is never sent to the browser and never logged.

## Errors (plain words in the portal)

- 401: "EzyChat refused the token. Create a new one in EzyChat Settings -> Integrations."
- 404 on `/mcp`: "AI assistant access is off in EzyChat. Turn on Let AI assistants read this inbox."
- 403: "EzyChat accepts this only on its own computer or through its tunnel address."
- Network error: "EzyChat is not reachable at <address>. Is the EzyChat computer on?"
- 429: end the feed for this run; next run continues.

## Tests

Adapter with a fake MCP server (Bun.serve) for: paging both tools, cursor and budget, history window, 401/404/429
mapping, items without phone numbers, month split. Render of the new source. Portal routes for save/test/disconnect
(token never in `/api/status`). The `no-personal-strings` test must stay green.

## Left to the builder

File layout (`src/adapters/ezychat.ts`, `src/ezychat.ts` for settings), exact portal layout, docs updates
(`docs/features.md`, `docs/configuration.md`, CHANGELOG "Unreleased").
