// A fake EzyChat for tests, shaped like its open-source server (packages/server/src/mcp/: route.ts, transport.ts,
// tools.ts, oauth.ts, oauth-routes.ts): POST /mcp in stateless JSON mode (the SDK's WebStandardStreamableHTTPServerTransport
// with enableJsonResponse: no initialize, no session; Accept must list application/json and text/event-stream), tool
// results as `result.content[0].text` JSON, errors as `{ error: { code, message } }`, and the OAuth 2.1 sign-in
// (discovery, dynamic registration, PKCE S256, token exchange with `resource`). The approval page approves at once.
import { createHash, randomBytes } from "node:crypto";

export interface FakeChat { jid: string; name: string | null; phone: string; type?: "direct" | "group"; status?: string; assignedTo?: string | null; tags?: string[];
  inboxId?: number; inboxName?: string; updatedAt?: number; messages: FakeMessage[] }
export interface FakeMessage { id: string; at: string; from: "team" | "customer"; sender: string | null; type?: string; text: string | null; media?: { mime: string | null; name: string | null; status: string } | null; truncated?: boolean }

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

export function fakeEzyChat(chats: FakeChat[] = [], opts: { token?: string } = {}) {
  const token = opts.token ?? "ezc_test_token_0123456789";
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const clients = new Map<string, string[]>(), codes = new Map<string, { clientId: string; redirect: string; challenge: string }>();
  const state = { mode: "on" as "on" | "off" | "forbidden" | "rate", rateAfter: Infinity, registrations: 0, lastHeaders: new Headers(), tokenForms: [] as Record<string, string>[] };
  let server: ReturnType<typeof Bun.serve>;
  const issuer = () => `http://127.0.0.1:${server.port}`;
  const err = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
    Response.json({ error: { code, message } }, { status, headers });
  const rpc = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
  const text = (id: unknown, value: unknown, isError = false) => rpc(id, { content: [{ type: "text", text: isError ? String(value) : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
  const lastAt = (c: FakeChat) => c.messages.length ? Date.parse(c.messages[c.messages.length - 1].at) : 0;
  const allowed: Record<string, string[]> = { list_chats: ["status", "assigned", "query", "since", "cursor", "limit", "inboxId"], get_messages: ["jid", "before", "limit"], get_stats: ["days", "inboxId"] };

  function tool(name: string, a: Record<string, any>) {
    if (name === "list_chats") {
      const limit = a.limit ?? 25, cur = a.cursor ? unb64(a.cursor) : null;
      const rows = chats.filter(c => a.since === undefined || (c.updatedAt ?? lastAt(c)) > a.since)
        .sort((x, y) => lastAt(y) - lastAt(x) || x.jid.localeCompare(y.jid))
        .filter(c => !cur || lastAt(c) < cur.ts || (lastAt(c) === cur.ts && c.jid > cur.jid));
      const page = rows.slice(0, limit), more = rows.length > limit, end = page[page.length - 1];
      return { chats: page.map(c => ({ jid: c.jid, ...(c.inboxName ? { inboxId: c.inboxId ?? 1, inboxName: c.inboxName } : {}), type: c.type ?? "direct", name: c.name, phone: c.phone,
        status: c.status ?? "open", assignedTo: c.assignedTo ?? null, unreadCount: 0, lastMessageAt: c.messages.length ? new Date(lastAt(c)).toISOString() : null,
        lastMessagePreview: c.messages[c.messages.length - 1]?.text ?? null, tags: c.tags ?? [] })),
        nextCursor: more && end ? b64({ ts: lastAt(end), jid: end.jid }) : null };
    }
    if (name === "get_messages") {
      const chat = chats.find(c => c.jid === a.jid);
      if (!chat) throw new Error(`No chat found for ${a.jid}`);
      const limit = a.limit ?? 50, before = a.before ? unb64(a.before) : null;
      const older = chat.messages.filter(m => !before || Date.parse(m.at) < before.ts || (Date.parse(m.at) === before.ts && m.id < before.id));
      const page = older.slice(-limit), more = older.length > limit;
      return { messages: page.map(m => ({ id: m.id, at: m.at, from: m.from, sender: m.sender, type: m.type ?? "text", text: m.text, ...(m.truncated ? { truncated: true } : {}),
        media: m.media ?? null, quotedId: null, status: "read" })), nextBefore: more ? b64({ ts: Date.parse(page[0].at), id: page[0].id }) : null };
    }
    if (name === "get_stats") return { chats: { open: chats.filter(c => (c.status ?? "open") === "open").length, resolved: chats.filter(c => c.status === "resolved").length },
      daily: [], openByAssignee: [], waitingForReply: { count: 0, oldestCustomerMessageAt: null } };
    throw new Error(`Tool ${name} not found`);
  }

  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    if (state.mode === "off") return err(404, "not_found", `Route ${req.method} ${url.pathname} not found`);
    if (state.mode === "forbidden") return err(403, "forbidden", "AI assistant access works only on this computer or through the tunnel");
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${issuer()}/mcp`, authorization_servers: [issuer()], bearer_methods_supported: ["header"], resource_name: "EzyChat" });
    if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: issuer(), authorization_endpoint: `${issuer()}/oauth/authorize`,
      token_endpoint: `${issuer()}/mcp/oauth/token`, registration_endpoint: `${issuer()}/mcp/oauth/register`, response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"] });
    if (url.pathname === "/mcp/oauth/register" && req.method === "POST") {
      const b = await req.json() as { redirect_uris?: string[]; client_name?: string; token_endpoint_auth_method?: string };
      if (!b.redirect_uris?.every(u => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(u) || u.startsWith("https://"))) return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
      const id = `ezc_app_${randomBytes(8).toString("hex")}`;
      clients.set(id, b.redirect_uris!); state.registrations++;
      return Response.json({ client_id: id, client_name: b.client_name, redirect_uris: b.redirect_uris, token_endpoint_auth_method: b.token_endpoint_auth_method ?? "client_secret_basic", grant_types: ["authorization_code"], response_types: ["code"] }, { status: 201 });
    }
    if (url.pathname === "/oauth/authorize") { // the admin's approval page: approves at once
      const p = url.searchParams, redirect = p.get("redirect_uri") ?? "", uris = clients.get(p.get("client_id") ?? "");
      if (!uris || !uris.includes(redirect) || p.get("code_challenge_method") !== "S256" || p.get("resource") !== `${issuer()}/mcp`) return new Response("Bad request", { status: 400 });
      const target = new URL(redirect), code = randomBytes(16).toString("hex");
      codes.set(code, { clientId: p.get("client_id")!, redirect, challenge: p.get("code_challenge")! });
      if (p.get("deny") === "1") target.searchParams.set("error", "access_denied"); else target.searchParams.set("code", code);
      if (p.get("state")) target.searchParams.set("state", p.get("state")!);
      target.searchParams.set("iss", issuer());
      return new Response(null, { status: 302, headers: { location: target.toString() } });
    }
    if (url.pathname === "/mcp/oauth/token" && req.method === "POST") {
      if (!req.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return Response.json({ error: "invalid_request" }, { status: 400 });
      const f = Object.fromEntries(new URLSearchParams(await req.text()));
      state.tokenForms.push(f);
      const c = codes.get(f.code ?? ""); codes.delete(f.code ?? "");
      if (f.grant_type !== "authorization_code" || !c || c.clientId !== f.client_id) return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (f.redirect_uri !== c.redirect || s256(f.code_verifier ?? "") !== c.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (f.resource !== undefined && f.resource !== `${issuer()}/mcp`) return Response.json({ error: "invalid_target" }, { status: 400 });
      return Response.json({ access_token: token, token_type: "Bearer" });
    }
    if (url.pathname !== "/mcp") return err(404, "not_found", "Route not found");
    if (req.method !== "POST") return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, { status: 405 });
    state.lastHeaders = req.headers;
    if (req.headers.get("authorization") !== `Bearer ${token}`) return err(401, "unauthorized", "A valid access token is required",
      { "www-authenticate": `Bearer realm="ezychat", error="invalid_token", resource_metadata="${issuer()}/.well-known/oauth-protected-resource/mcp"` });
    if (state.mode === "rate" || calls.length >= state.rateAfter) return err(429, "rate_limited", "Too many requests", { "retry-after": "30" });
    const accept = req.headers.get("accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
      return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Not Acceptable: Client must accept both application/json and text/event-stream" }, id: null }, { status: 406 });
    const body = await req.json() as { id: unknown; method: string; params: { name: string; arguments: Record<string, unknown> } };
    if (body.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    const { name, arguments: args = {} } = body.params;
    calls.push({ tool: name, args });
    const extra = Object.keys(args).filter(k => !(allowed[name] ?? []).includes(k));
    if (extra.length) return text(body.id, `MCP error -32602: Input validation error: Unrecognized key: "${extra[0]}"`, true);
    try { return text(body.id, tool(name, args)); } catch (e) { return text(body.id, (e as Error).message, true); }
  } });
  return { server, base: issuer(), token, calls, state, chats, stop: () => server.stop(true) };
}
export type FakeEzyChat = ReturnType<typeof fakeEzyChat>;
