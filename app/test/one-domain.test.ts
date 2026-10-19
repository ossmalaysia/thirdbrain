import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortal, isGbrainPath, type PortalDeps } from "../src/portal.ts";
import { createSessions } from "../src/remote/sessions.ts";
import { freePort } from "./fixtures.ts";

const PUBLIC = "https://quiet-river-moon.trycloudflare.com";

/** Portal with a fake GBrain behind it; `as` sends a request as if it arrived through the tunnel (Host = public). */
function setup() {
  const seen: { path: string; auth: string | null; body: string }[] = [];
  const gbrain = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const u = new URL(req.url); seen.push({ path: u.pathname + u.search, auth: req.headers.get("authorization"), body: req.method === "POST" ? await req.text() : "" });
    return u.pathname === "/mcp" ? new Response("data: {\"ok\":true}\n\n", { headers: { "content-type": "text/event-stream" } }) : Response.json({ issuer: PUBLIC + "/" });
  } });
  const sessions = createSessions({ file: join(mkdtempSync(join(tmpdir(), "sess-")), "s.json") });
  const services = {
    config: () => ({ brainPath: "x", clientId: "", tenantId: "t", model: "", maxThreadsPerRun: 25, initialSinceDays: 10 }),
    state: () => ({ cursors: {}, threads: {}, queue: [], lookbackDays: 10, lastRun: null }),
    connected: () => true, running: () => null, schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }),
    configure: () => {}, action: async () => {}, exchange: async () => {}, sessions,
    feedSchedule: { read: () => ({}), set: () => { throw new Error("a remote session changed a sync interval"); } },
    updates: { status: () => ({ current: { version: "0.1.0", commit: null }, available: true, lastUpdate: { error: "git fetch failed: C:/somewhere" } }),
      check: async () => { throw new Error("a remote session checked for updates"); }, apply: async () => { throw new Error("a remote session started an update"); } },
    remote: { gbrainOrigin: `http://127.0.0.1:${gbrain.port}`, status: () => ({ url: PUBLIC, mcpUrl: PUBLIC + "/mcp" }), configure: () => {} },
  } as unknown as PortalDeps;
  const port = freePort(), portal = createPortal(port, services), local = `http://127.0.0.1:${port}`;
  const as = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(local + path, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), host: new URL(PUBLIC).host, ...(init.cookie ? { cookie: init.cookie } : {}) } });
  return { seen, sessions, as, local, stop: () => { portal.stop(true); gbrain.stop(true); } };
}

test("GBrain paths are recognised; the portal's own paths and /metrics are not", () => {
  for (const p of ["/mcp", "/authorize", "/token", "/register", "/revoke", "/.well-known/oauth-authorization-server", "/admin", "/admin/login"]) expect(isGbrainPath(p)).toBe(true);
  for (const p of ["/", "/api/status", "/style.css", "/metrics", "/administrator", "/auth/device"]) expect(isGbrainPath(p)).toBe(false);
});

test("one domain: MCP and OAuth go to GBrain unchanged; the portal needs a device session", async () => {
  const h = setup();
  try {
    const mcp = await h.as("/mcp", { method: "POST", body: '{"jsonrpc":"2.0"}', headers: { authorization: "Bearer abc", "content-type": "application/json" } });
    expect(mcp.status).toBe(200); expect(await mcp.text()).toContain('"ok":true');
    expect(h.seen.at(-1)).toEqual({ path: "/mcp", auth: "Bearer abc", body: '{"jsonrpc":"2.0"}' }); // body and token pass through
    expect((await (await h.as("/.well-known/oauth-authorization-server")).json()).issuer).toBe(PUBLIC + "/");
    // The portal itself is closed without a session…
    expect((await h.as("/")).status).toBe(401);
    expect((await h.as("/api/status")).status).toBe(401);
    // The sign-in page can load its own stylesheet and logo; nothing else is public.
    expect((await h.as("/style.css")).status).toBe(200); expect((await h.as("/favicon.svg")).status).toBe(200);
    expect((await h.as("/portal.js")).status).toBe(401);
    // …while the laptop needs no login.
    expect((await fetch(h.local + "/api/status")).status).toBe(200);
  } finally { h.stop(); }
});

test("installable app: manifest, icons, service worker and offline page load without a session; data still needs one", async () => {
  const h = setup();
  try {
    const types: Record<string, string> = {
      "/manifest.webmanifest": "application/manifest+json", "/sw.js": "text/javascript", "/offline.html": "text/html", "/offline.js": "text/javascript",
      "/icons/icon.svg": "image/svg+xml", "/icons/icon-192.png": "image/png", "/icons/icon-512.png": "image/png",
      "/icons/icon-maskable-512.png": "image/png", "/icons/apple-touch-icon.png": "image/png",
    };
    for (const [path, type] of Object.entries(types)) {
      const r = await h.as(path);
      expect([path, r.status, r.headers.get("content-type")?.split(";")[0]]).toEqual([path, 200, type]);
      expect(r.headers.get("content-security-policy")).toContain("default-src 'self'"); // the security headers stay
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect((await h.as("/sw.js")).headers.get("cache-control")).toBe("no-cache"); // a new worker takes over at once
    const manifest = await (await h.as("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ name: "Third Brain", start_url: "/", scope: "/", display: "standalone" });
    expect(manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes} ${i.purpose}`)).toEqual(["any any", "192x192 any", "512x512 any", "512x512 maskable"]);
    // The sign-in page links the manifest and theme colour, so a phone can install the app before it signs in.
    const signin = await (await h.as("/")).text();
    expect(signin).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(signin).toContain('name="theme-color"');
    // Data and the app's own code still need a session; so does any path outside the allowlist.
    expect((await h.as("/api/status")).status).toBe(401);
    for (const path of ["/portal.js", "/view.js", "/empty-state.png", "/icons/other.png", "/icons/icon-maskable.svg", "/index.html", "/sw.js.map"])
      expect([path, (await h.as(path)).status]).toEqual([path, 401]);
    expect((await h.as("/manifest.webmanifest", { method: "POST", body: "{}" })).status).toBe(401); // GET only
    // The laptop gets every shell file, and the app's code too.
    for (const path of [...Object.keys(types), "/portal.js", "/view.js", "/empty-state.png", "/style.css"]) expect([path, (await fetch(h.local + path)).status]).toEqual([path, 200]);
    expect((await fetch(h.local + "/icons/other.png")).status).toBe(404);
  } finally { h.stop(); }
});

test("service worker: never answers for GBrain, API, auth or non-GET requests; only the static shell is cached", async () => {
  const listeners: Record<string, (e: unknown) => void> = {};
  const self: Record<string, unknown> = { location: new URL(PUBLIC + "/sw.js"), addEventListener: (type: string, fn: (e: unknown) => void) => { listeners[type] = fn; } };
  // Runs the repo's own sw.js with a fake worker scope; its network calls never settle, so nothing leaves the test.
  new Function("self", "caches", "fetch", await Bun.file(join(import.meta.dir, "..", "portal", "sw.js")).text())(self, {}, () => new Promise(() => {}));
  const answered = (path: string, init: { method?: string; mode?: string } = {}) => {
    let used = false;
    listeners.fetch({ request: { method: init.method ?? "GET", mode: init.mode ?? "no-cors", url: PUBLIC + path }, respondWith: () => { used = true; } });
    return used;
  };
  for (const path of ["/api/status", "/api/notes?page=2", "/auth/device?t=x", "/mcp", "/authorize", "/token", "/register", "/revoke", "/.well-known/oauth-authorization-server", "/admin", "/admin/login", "/health", "/sw.js"]) {
    expect([path, answered(path)]).toEqual([path, false]);
    expect([path, answered(path, { mode: "navigate" })]).toEqual([path, false]);
  }
  expect(answered("/api/sync", { method: "POST" })).toBe(false);
  expect(answered("/style.css", { method: "POST" })).toBe(false);
  expect(answered("/", { mode: "navigate" })).toBe(true); // network first, offline page on failure
  expect(answered("/style.css")).toBe(true);
  expect(answered("/icons/icon-192.png")).toBe(true);
  expect(answered("/")).toBe(false); // the HTML (it carries the control token) is never served from the cache
  expect(answered("/index.html")).toBe(false);
  const outside = (path: string) => { let used = false; listeners.fetch({ request: { method: "GET", mode: "no-cors", url: "https://elsewhere.example" + path }, respondWith: () => { used = true; } }); return used; };
  expect(outside("/style.css")).toBe(false);
});

/** Presses the confirm page's button: the only step that spends a link. */
const press = (h: ReturnType<typeof setup>, token: string) =>
  h.as("/auth/device", { method: "POST", body: new URLSearchParams({ t: token }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

test("device link: opening it (e.g. a WhatsApp preview) doesn't spend it; pressing Sign in does, once", async () => {
  const h = setup();
  try {
    const { token } = h.sessions.createLink();
    for (let i = 0; i < 2; i++) { // a preview bot and a prefetch both open the link first
      const page = await h.as(`/auth/device?t=${token}`);
      expect(page.status).toBe(200); expect(page.headers.get("set-cookie")).toBeNull();
      expect(await page.text()).toContain("Sign in this device");
    }
    const signin = await press(h, token);
    expect(signin.status).toBe(303);
    const cookie = signin.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=Lax");
    const session = cookie.split(";")[0];
    expect((await h.as("/api/status", { cookie: session })).status).toBe(200);
    expect((await h.as(`/auth/device?t=${token}`)).status).toBe(400); // spent
    expect((await press(h, token)).status).toBe(400);
    expect((await h.as("/auth/device?t=forged")).status).toBe(400);
    h.sessions.revokeAll();
    expect((await h.as("/api/status", { cookie: session })).status).toBe(401); // signed out everywhere
  } finally { h.stop(); }
});

test("remote sessions cannot mint new links or start laptop sign-ins; foreign hosts are refused", async () => {
  const h = setup();
  try {
    const { token } = h.sessions.createLink();
    const session = (await press(h, token)).headers.get("set-cookie")!.split(";")[0];
    const page = await (await h.as("/", { cookie: session })).text();
    const control = page.match(/name="portal-token" content="([^"]+)"/)![1];
    const post = (path: string) => h.as(path, { method: "POST", cookie: session, body: "{}", headers: { origin: PUBLIC, "x-portal-token": control, "content-type": "application/json" } });
    for (const path of ["/api/remote/device-link", "/api/connect", "/api/ai/chatgpt-login"]) expect((await post(path)).status).toBe(403);
    expect((await h.as("/api/remote/device-link", { method: "POST", cookie: session, body: "{}", headers: { origin: "https://evil.example", "x-portal-token": control, "content-type": "application/json" } })).status).toBe(403);
    expect((await fetch(h.local + "/api/status", { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await h.as("/?code=x&state=y", { cookie: session })).status).toBe(404); // Outlook sign-in returns to the laptop only
  } finally { h.stop(); }
});

test("security review 2026-10-18: a remote session may only sync/pause/resume/back up; settings and access are laptop-only (H1)", async () => {
  const h = setup();
  try {
    const { token } = h.sessions.createLink();
    const session = (await press(h, token)).headers.get("set-cookie")!.split(";")[0];
    const control = (await (await h.as("/", { cookie: session })).text()).match(/name="portal-token" content="([^"]+)"/)![1];
    const post = (path: string, body = "{}") => h.as(path, { method: "POST", cookie: session, body, headers: { origin: PUBLIC, "x-portal-token": control, "content-type": "application/json" } });
    for (const path of ["/api/remote/settings", "/api/ai/key", "/api/ai/settings", "/api/ai/decision", "/api/ai/chatgpt-signout", "/api/backup/settings",
      "/api/settings", "/api/claude/accounts", "/api/chatgpt-chats/enable", "/api/backfill/window", "/api/usage/prices", "/api/remote/signout-devices",
      "/api/connectors/schedule", "/api/update/apply", "/api/update/check"])
      expect([path, (await post(path, '{"mode":"named","hostname":"evil.example","token":"x"}')).status]).toEqual([path, 403]);
    expect((await post("/api/connectors/schedule", '{"connector":"chatgpt","minutes":60}')).status).toBe(403); // a valid body too
    for (const path of ["/api/sync", "/api/pause", "/api/resume"]) expect([path, (await post(path)).status]).not.toEqual([path, 403]);
  } finally { h.stop(); }
});

test("a request that came through Cloudflare is never the laptop, whatever its Host header (L1)", async () => {
  const h = setup();
  try {
    for (const hdr of ["cf-connecting-ip", "cf-ray", "cdn-loop"])
      expect([hdr, (await fetch(h.local + "/api/status", { headers: { [hdr]: "1.2.3.4" } })).status]).toEqual([hdr, 403]);
    expect((await fetch(h.local + "/api/status")).status).toBe(200); // the real laptop still needs no login
  } finally { h.stop(); }
});

test("proxy to GBrain: no portal session cookie, no client forwarding headers, no encoded slashes, size cap (M1, L2)", async () => {
  const seenHeaders: Record<string, string | null>[] = [];
  const gbrain = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    seenHeaders.push({ cookie: req.headers.get("cookie"), xff: req.headers.get("x-forwarded-for"), fwd: req.headers.get("forwarded"), real: req.headers.get("x-real-ip") });
    return Response.json({ ok: true });
  } });
  const { proxyToGbrain, MAX_PROXY_BODY } = await import("../src/portal.ts");
  try {
    const origin = `http://127.0.0.1:${gbrain.port}`;
    const req = new Request("http://127.0.0.1:1/admin/api/agents", { headers: { cookie: "brain_session=secret; gbrain_admin=adm", "x-forwarded-for": "127.0.0.1", forwarded: "for=127.0.0.1", "x-real-ip": "127.0.0.1", "cf-connecting-ip": "9.9.9.9" } });
    expect((await proxyToGbrain(req, new URL(req.url), origin, "brain.example")).status).toBe(200);
    expect(seenHeaders.at(-1)).toEqual({ cookie: "gbrain_admin=adm", xff: "9.9.9.9", fwd: null, real: null });
    const enc = new Request("http://127.0.0.1:1/admin/..%2fmetrics");
    expect((await proxyToGbrain(enc, new URL(enc.url), origin, "brain.example")).status).toBe(400);
    const big = new Request("http://127.0.0.1:1/mcp", { method: "POST", headers: { "content-length": String(MAX_PROXY_BODY + 1) }, body: "x" });
    expect((await proxyToGbrain(big, new URL(big.url), origin, "brain.example")).status).toBe(413);
  } finally { gbrain.stop(true); }
});

test("updates: the status shows them over the tunnel without local error text; check and apply are laptop-only", async () => {
  const h = setup();
  try {
    const { token } = h.sessions.createLink();
    const session = (await press(h, token)).headers.get("set-cookie")!.split(";")[0];
    const remote = await (await h.as("/api/status", { cookie: session })).json();
    expect(remote.updates).toMatchObject({ current: { version: "0.1.0" }, available: true });
    expect(remote.updates.lastUpdate.error).not.toContain("C:/");
    expect((await (await fetch(h.local + "/api/status")).json()).updates.lastUpdate.error).toContain("git fetch failed"); // the laptop sees the reason
  } finally { h.stop(); }
});
