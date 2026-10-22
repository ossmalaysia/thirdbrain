import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, loadState, saveConfig, STATE_DIR, type Config, type State } from "./state.ts";
import { DEFAULT_PRODUCT_NAME, loadAppConfig, portalPort, type AppConfig } from "./config.ts";
import { makeAuthorization, validCallback, exchangeAuthorizationCode } from "./adapters/browser-login.ts";
import { dockerBackend, dockerSchedule, dockerAction, runningCollector, startWorker, runHistory, type Schedule } from "./runner.ts";
import { createAiService, type AiService } from "./ai-settings.ts";
import { createRemoteAccess, type RemoteAccess } from "./remote/index.ts";
import { createClaudeAccounts, type ClaudeAccounts } from "./claude-web/accounts.ts";
import { chatgptChatsEnabled, setChatgptChats } from "./chatgpt-chats.ts";
import { createSessions, readCookie, SESSION_COOKIE, SESSION_TTL_MS, type Sessions } from "./remote/sessions.ts";
import { NOTE_SOURCES, notesIndexFor, parseNotesQuery, queryNotes } from "./notes-index.ts";
import { PROVIDERS } from "./core/providers.ts";
import { createEstimator, perChatFromLogs, sinceIso, windowCost, writerOf, feedWindowDays, isWindowDays, readLogLines, readWindows, setWindow, WindowBusyError, type Windows } from "./backfill.ts";
import { liveSample } from "./backfill-live.ts";
import { CHATGPT_FEED } from "./adapters/chatgpt-web.ts";
import { GMAIL_FEED, GmailError } from "./adapters/gmail-imap.ts";
import { createGmailService, type GmailService } from "./gmail.ts";
import { createWhatsAppService, type WhatsAppService } from "./whatsapp.ts";
import { RANGES, savePrices, usageReport, rangeStart, type Range } from "./usage.ts";
import { createDream, type Dream } from "./dream.ts";
import { automaticDecisions, createEntityIndex, createMergeApplier, ENTITY_KINDS, recordDistinct, recordMerge, undoMerge, type EntityIndex } from "./entities-view.ts";
import { loadJudgements, pairKey } from "./entities-judge.ts";
import type { EntityKind } from "./core/entities.ts";
import { isInterval, isScheduleKey, readSchedule, resolvedIntervals, saveInterval } from "./feed-schedule.ts";
import { createUpdates, UpdateRefused, type Updates } from "./updates.ts";
import { BACKUP_INTERVALS, backupStatus, createBackupScheduler, createRepoStatusCache, powershell, type BackupAction, type BackupStatus } from "./backup.ts";

const backups = createBackupScheduler();

export type { Schedule } from "./runner.ts";
export interface PortalDeps {
  config: () => Config; state: () => State; connected: () => boolean;
  /** Product name, owner and Microsoft 365 account from config.json (default: Third Brain, no owner). */
  app?: () => Pick<AppConfig, "product" | "owner" | "microsoft">;
  running: () => { since: string | null } | null;
  schedule: () => Promise<Schedule>;
  action: (action: "sync" | "pause" | "resume") => Promise<void>;
  configure: (updates: Record<string, string>) => void;
  exchange: typeof exchangeAuthorizationCode;
  history?: () => ReturnType<typeof runHistory>;
  backup?: () => Promise<BackupStatus>;
  backupAction?: (action: BackupAction) => Promise<void>;
  ai?: AiService;
  remote?: RemoteAccess;
  sessions?: Sessions;
  claude?: ClaudeAccounts;
  dream?: Pick<Dream, "status" | "run" | "configure">;
  /** Entities page: the entity pages, possible duplicates, and the rebuild that applies merges. */
  entities?: { index: EntityIndex; applier: ReturnType<typeof createMergeApplier> };
  /** History windows of the chat feeds and the usage estimate shown before a backfill. */
  backfill?: {
    windows: () => Windows;
    set: (feed: string, days: number) => { widened: boolean; cursorReset: boolean; previous: number };
    estimate: (feed: string) => Promise<unknown>;
    reset?: (feed?: string) => void;
  };
  /** Per-connector sync interval (feed-schedule.ts): saved choices, and Save from a connector page. */
  feedSchedule?: { read: () => Record<string, number>; set: (connector: string, minutes: number) => void };
  /** Usage page: aggregated sync-log tokens for a range; price table edits. */
  usage?: { report: (range: Range) => unknown; savePrices: (prices: unknown) => void };
  /** Gmail over IMAP: status (address only, never the password), connect (tests the login first), disconnect. */
  gmail?: Pick<GmailService, "status" | "connect" | "disconnect"> & Partial<Pick<GmailService, "setScope" | "counts" | "estimate">>;
  /** WhatsApp linked device: status, QR code while linking, chat choices, disconnect (all laptop only but the status). */
  whatsapp?: Pick<WhatsAppService, "status" | "connect" | "cancelLink" | "disconnect" | "qrSvg" | "chats" | "setChats"> & Partial<Pick<WhatsAppService, "start" | "stop">>;
  /** New releases on GitHub (cached; checked 6-hourly in the background) and the laptop-only self-update. */
  updates?: Pick<Updates, "status" | "check" | "apply">;
}

/** Shares one in-flight load and reuses its result for `ttl` ms, so 5-second polling never stacks PowerShell calls. */
function cached<T>(load: () => Promise<T>, ttl = 5_000) {
  let hit: { at: number; value: T } | null = null, flight: Promise<T> | null = null;
  const get = (): Promise<T> => hit && Date.now() - hit.at < ttl ? Promise.resolve(hit.value)
    : flight ??= load().then(value => { hit = { at: Date.now(), value }; return value; }).finally(() => { flight = null; });
  return Object.assign(get, { reset: () => { hit = null; } });
}

const logsDir = join(STATE_DIR, "logs");
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const estimator = createEstimator({ config: loadConfig, logs: () => readLogLines(logsDir, daysAgo(7)), sample: liveSample, windows: () => readWindows() });
// git runs after a sync or backup run changed the vault, else every 30 minutes (edits made in Obsidian), not on each poll.
const repo = createRepoStatusCache(() => loadConfig().brainPath, 30 * 60_000);
const vaultEvent = () => { let k = ""; try { k = String(statSync(stateFile).mtimeMs); } catch { /* no state yet */ } return `${k}|${backups.config().lastRun ?? ""}`; };
/** state.json grows with every processed message (~10 MB at 33k): parse it again only when the file changes. */
const stateFile = join(STATE_DIR, "state.json");
let stateHit: { key: string; value: State } | null = null;
const cachedState = (): State => {
  let key = "";
  try { const s = statSync(stateFile); key = `${s.mtimeMs}:${s.size}`; } catch { /* no state yet */ }
  if (stateHit && key && stateHit.key === key) return stateHit.value;
  const value = loadState();
  stateHit = key ? { key, value } : null;
  return value;
};
/** `entities rebuild` in a child process (it writes notes and pages, commits and indexes); output kept for the reason. */
async function runEntitiesRebuild(opts: { judge?: boolean } = {}): Promise<{ code: number; out: string }> {
  if (opts.judge) { // the duplicate check first (writes merges.json only); a failure still lets the rebuild run
    const j = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "entities", "judge"], { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true });
    await j.exited;
  }
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "entities", "rebuild"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: [out, err].join("\n").slice(-4000) };
}

const deps: PortalDeps = {
  entities: { index: createEntityIndex(() => loadConfig().brainPath), applier: createMergeApplier(runEntitiesRebuild) },
  config: loadConfig, state: cachedState, app: loadAppConfig,
  connected: () => existsSync(join(STATE_DIR, "token.json")),
  running: runningCollector,
  schedule: async () => dockerBackend() ? dockerSchedule() : { ...JSON.parse(await powershell("$t=Get-ScheduledTask -TaskName BrainRunner; $i=Get-ScheduledTaskInfo -TaskName BrainRunner; [pscustomobject]@{state=[string]$t.State; nextRun=$(if($i.NextRunTime.Year -gt 2000){$i.NextRunTime.ToUniversalTime().ToString('o')}else{$null}); lastRun=$(if($i.LastRunTime.Year -gt 2000){$i.LastRunTime.ToUniversalTime().ToString('o')}else{$null}); result=$i.LastTaskResult} | ConvertTo-Json -Compress")), backend: "windows" },
  action: async action => {
    if (dockerBackend()) { dockerAction(action); return; }
    const commands = { sync: "Start-ScheduledTask -TaskName BrainRunner", pause: "Disable-ScheduledTask -TaskName BrainRunner | Out-Null", resume: "Enable-ScheduledTask -TaskName BrainRunner | Out-Null" };
    await powershell(commands[action]);
  },
  configure: saveConfig, exchange: exchangeAuthorizationCode,
  history: runHistory,
  backup: async () => { const cfg = loadConfig(); return backupStatus(backups.config(), backups.running(), cfg.brainPath, cfg.backupPush ?? true, repo.get(vaultEvent())); },
  backupAction: backups.action,
  ai: createAiService(),
  claude: createClaudeAccounts(),
  gmail: createGmailService({ ownerEmails: () => loadAppConfig().owner.emails, known: id => !!cachedState().processed?.[id] }),
  whatsapp: createWhatsAppService({ unlink: async () => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "whatsapp-unlink"], { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "ignore", stdin: "ignore", windowsHide: true });
    return (await p.exited) === 0;
  } }),
  backfill: { windows: () => readWindows(), set: (feed, days) => setWindow(feed, days, loadConfig()), estimate: feed => estimator.estimate(feed), reset: feed => estimator.reset(feed) },
  feedSchedule: { read: () => readSchedule(), set: saveInterval },
  usage: { report: range => usageReport(readLogLines(logsDir, rangeStart(range) ?? ""), loadState(), loadConfig(), range), savePrices: prices => { savePrices(prices); } },
  remote: createRemoteAccess({ port: loadConfig().brainPort ?? 3131, tunnelPort: portalPort() }), // tunnel -> portal, which forwards GBrain paths
};

/** The 5-second status poll sends the newest runs only (the Sync runs page shows 20); totals stay complete. */
export const STATUS_RUNS = 25;
export const limitRuns = <T extends { entries: unknown[] }>(h: T): T => ({ ...h, entries: h.entries.slice(0, STATUS_RUNS) });

/** Only operational metadata reaches the browser: no mail, IDs, tokens or local credentials. */
export function publicStatus(cfg: Config, state: State, connected: boolean, running: ReturnType<PortalDeps["running"]>, schedule: Schedule, intervals: Record<string, number> = {}) {
  const applied = state.lookbackDays ?? null;
  const coverage = applied === cfg.initialSinceDays ? Object.keys(state.scannedFolders ?? {}).length : 0;
  const known = Object.keys(state.folderNames ?? {}).length;
  return {
    connected, needsLogin: !connected || state.lastRun?.error === "NEEDS_LOGIN", configured: !!cfg.clientId,
    microsoftLogin: state.lastRun?.error === "NEEDS_LOGIN" ? state.microsoftLogin ?? null : null,
    busy: !!running || ["Running", "Queued"].includes(schedule.state), runningSince: running?.since ?? null, schedule,
    settings: { lookbackDays: cfg.initialSinceDays, threadsPerRun: cfg.maxThreadsPerRun, appliedDays: applied,
      provider: cfg.provider ?? "codex",
      extractor: { codex: "Codex", openai: "OpenAI API", anthropic: "Claude API" }[cfg.provider ?? "codex"],
      model: ({ codex: cfg.model, openai: cfg.openaiModel, anthropic: cfg.anthropicModel }[cfg.provider ?? "codex"] || "default model"), intervalMinutes: 15 },
    counts: { processed: Object.keys(state.processed ?? {}).length, notes: Object.keys(state.threads).length,
      queued: state.queue.length, scannedFolders: coverage, totalFolders: known || null },
    indexPending: !!state.indexPending,
    lastSuccessAt: state.lastSuccessAt ?? null,
    // Per-connector "Sync every" (minutes) and when each connector's last pull finished: the page shows its next run.
    feedSchedule: { intervals, lastPulledAt: state.feedPulledAt ?? {} },
    lastRun: state.lastRun ? { at: state.lastRun.at, finishedAt: state.lastRun.finishedAt ?? null,
      pulled: state.lastRun.pulled, kept: state.lastRun.kept, written: state.lastRun.written,
      skipped: state.lastRun.skipped, blocked: state.lastRun.blocked, duplicates: state.lastRun.duplicates ?? 0,
      triageSkipped: (state.lastRun as { triageSkipped?: number }).triageSkipped ?? 0,
      dropped: state.lastRun.dropped, error: state.lastRun.error, feedErrors: state.lastRun.feedErrors ?? {} } : null,
  };
}

/** Product name, owner name and the Microsoft 365 account for the portal UI (no other owner details). */
export const identity = (app: Pick<AppConfig, "product" | "owner" | "microsoft"> | null) => ({
  product: { name: app?.product.name || DEFAULT_PRODUCT_NAME }, owner: { name: app?.owner.name ?? "" }, microsoft: { account: app?.microsoft.account ?? "" } });

/** Paths GBrain serves (MCP + its OAuth + its own admin, which has its own login). /metrics stays private. */
export const isGbrainPath = (path: string) =>
  ["/mcp", "/authorize", "/token", "/register", "/revoke", "/health"].includes(path) || path === "/admin" || path.startsWith("/admin/") || path.startsWith("/.well-known/");

/** Static files a device without a session may load: the sign-in page's stylesheet and logo, and the installable
 *  app shell (manifest, icons, service worker, offline page). None of them hold data. Path -> content type. */
export const PUBLIC_SHELL: Record<string, string> = {
  "/style.css": "text/css; charset=utf-8", "/favicon.svg": "image/svg+xml", "/manifest.webmanifest": "application/manifest+json",
  "/sw.js": "text/javascript; charset=utf-8", "/offline.html": "text/html; charset=utf-8", "/offline.js": "text/javascript; charset=utf-8",
  "/icons/icon.svg": "image/svg+xml", "/icons/icon-192.png": "image/png", "/icons/icon-512.png": "image/png",
  "/icons/icon-maskable-512.png": "image/png", "/icons/apple-touch-icon.png": "image/png",
};
/** Every static file of the portal (the laptop, or a device with a session). */
export const SHELL: Record<string, string> = { ...PUBLIC_SHELL,
  "/portal.js": "text/javascript; charset=utf-8", "/view.js": "text/javascript; charset=utf-8", "/empty-state.png": "image/png" };
/** <head> lines that let a phone install the portal from the sign-in page as well. */
const APP_HEAD = `<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`
  + `<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#172226" media="(prefers-color-scheme: dark)">`
  + `<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Third Brain">`;

/** POSTs a device-link session may send over the tunnel. Everything else (remote access, tunnel token, API keys,
 *  AI and backup settings, Claude accounts, history windows, prices) is laptop-only: a stolen 30-day session must
 *  not be able to re-point the tunnel or swap keys (security review 2026-10-18, H1). */
export const PUBLIC_POSTS = new Set(["/api/sync", "/api/pause", "/api/resume", "/api/backup/run"]);
/** Over the tunnel, the status leaves out cloudflared and GBrain log lines (they can name paths and accounts). */
export function withoutLogs<T extends { tunnel?: { logTail?: unknown }; gbrain?: { logTail?: unknown } }>(remote: T, isPublic: boolean): T {
  if (!isPublic) return remote;
  return { ...remote, ...(remote.tunnel ? { tunnel: { ...remote.tunnel, logTail: [] } } : {}), ...(remote.gbrain ? { gbrain: { ...remote.gbrain, logTail: [] } } : {}) };
}
/** Over the tunnel, a failed update's git or bun message (it can name local paths) is replaced by a short line. */
export function publicUpdates<T extends { lastUpdate?: { error?: string | null } | null }>(u: T | null, isPublic: boolean): T | null {
  if (!u || !isPublic || !u.lastUpdate?.error) return u;
  return { ...u, lastUpdate: { ...u.lastUpdate, error: "The update did not finish. Open the portal on the laptop for the reason." } };
}
/** Largest request body forwarded to GBrain over the tunnel (MCP calls from Claude.ai are small). */
export const MAX_PROXY_BODY = 2 * 1024 * 1024;

/** Streams a request through to GBrain and its reply back (SSE included). */
export async function proxyToGbrain(req: Request, url: URL, gbrainOrigin: string, publicHost: string): Promise<Response> {
  // Encoded slashes or backslashes have no legitimate use on GBrain's paths and only help path confusion.
  if (/%2f|%5c/i.test(new URL(req.url).pathname) || /%2f|%5c/i.test(req.url.split("?")[0])) return Response.json({ error: "Bad path" }, { status: 400 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_PROXY_BODY) return Response.json({ error: "Request too large" }, { status: 413 });
  const headers = new Headers(req.headers);
  for (const h of ["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-connection",
    "x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto"]) headers.delete(h); // never trust client copies
  headers.set("x-forwarded-proto", "https"); headers.set("x-forwarded-host", publicHost);
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  // GBrain never needs the portal's own session cookie (M1): forward only the other cookies (e.g. GBrain admin).
  const cookies = (req.headers.get("cookie") ?? "").split(";").map(c => c.trim()).filter(c => c && !c.startsWith(`${SESSION_COOKIE}=`));
  if (cookies.length) headers.set("cookie", cookies.join("; ")); else headers.delete("cookie");
  let reply: Response;
  try {
    reply = await fetch(new URL(url.pathname + url.search, gbrainOrigin), { method: req.method, headers, redirect: "manual",
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body, duplex: "half" } as RequestInit);
  } catch { return Response.json({ error: "GBrain is not running. Check the portal's Remote access page." }, { status: 502 }); }
  const out = new Headers(reply.headers);
  out.delete("content-encoding"); out.delete("content-length"); // fetch already decoded the body
  return new Response(reply.body, { status: reply.status, statusText: reply.statusText, headers: out });
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
const signInPage = (product: string, message = "This portal is private. Sign this device in with a link from your laptop.", status = 401) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Sign in · ${escapeHtml(product)}</title>`
  + `<link rel="icon" href="/favicon.svg" type="image/svg+xml">${APP_HEAD}<link rel="stylesheet" href="/style.css"></head>`
  + `<body class="signin-body"><main class="panel signin"><div class="brand"><img src="/favicon.svg" alt="" width="34" height="34">${escapeHtml(product)}</div>`
  + `<h1>Sign in</h1><p class="muted">${message}</p>`
  + `<ol class="signin-steps"><li>On your laptop, open <strong>Remote access</strong> in the portal.</li>`
  + `<li>Under <strong>Other devices</strong>, choose <strong>Create sign-in link</strong>.</li>`
  + `<li>Open that link on this device within 10 minutes. You stay signed in for 30 days.</li></ol></main></body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'" } });

/** Step 2 of a device link: one button that spends the link. The token is base64url, safe inside an attribute. */
const confirmPage = (product: string, token: string) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Sign in · ${escapeHtml(product)}</title>`
  + `<link rel="icon" href="/favicon.svg" type="image/svg+xml">${APP_HEAD}<link rel="stylesheet" href="/style.css"></head>`
  + `<body class="signin-body"><main class="panel signin"><div class="brand"><img src="/favicon.svg" alt="" width="34" height="34">${escapeHtml(product)}</div>`
  + `<h1>Sign in this device?</h1><p class="muted">This device will open your brain portal for 30 days. Only continue if you created this link on your laptop just now.</p>`
  + `<form method="post" action="/auth/device"><input type="hidden" name="t" value="${token.replace(/[^A-Za-z0-9_-]/g, "")}"><button class="btn" type="submit">Sign in this device</button></form>`
  + `</main></body></html>`,
  { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });

export function createPortal(port = portalPort(), services: PortalDeps = deps) {
  const control = randomBytes(32).toString("hex");
  const redirectUri = `http://localhost:${port}/`;
  let pending: { auth: ReturnType<typeof makeAuthorization>; cfg: Config; expires: number } | null = null;
  let exchanging = false;
  let notice = "";
  const schedule = cached(services.schedule);
  const backup = cached(async () => services.backup ? services.backup() : null);
  // A broken config.json must not take the portal down: fall back to the defaults and keep serving.
  const appInfo = () => { try { return services.app?.() ?? null; } catch { return null; } };
  const product = () => appInfo()?.product.name || DEFAULT_PRODUCT_NAME;
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
  const assets = join(import.meta.dir, "..", "portal");
  // Static files, read from disk per request (a browser reload shows a front-end change). The service worker is
  // revalidated on every load (no-cache) so a new sw.js takes over at once.
  const shellFile = (path: string) => new Response(Bun.file(join(assets, path.slice(1))), { headers: { ...headers, "content-type": SHELL[path],
    ...(path === "/sw.js" ? { "cache-control": "no-cache" } : {}) } });
  const sessions = services.sessions ?? createSessions();
  // Feeds that take a history window: every Claude.ai account's feed, ChatGPT and Gmail.
  const windowFeeds = () => [...(services.claude?.list() ?? []).map(a => a.feed), CHATGPT_FEED, ...(services.gmail ? [GMAIL_FEED] : [])];
  const windowSummary = () => {
    if (!services.backfill) return null;
    const cfg = services.config(), w = services.backfill.windows();
    return Object.fromEntries(windowFeeds().map(f => [f, { days: feedWindowDays(f, cfg, w), chosen: !!w[f] }]));
  };
  const windowMessage = (days: number, r: { widened: boolean; cursorReset: boolean }, feed = "") => {
    const label = ({ 30: "1 month", 182: "6 months", 365: "1 year", 730: "2 years" } as Record<number, string>)[days] ?? `${days} days`;
    const [things, Things] = feed === GMAIL_FEED ? ["emails", "Emails"] : ["chats", "Chats"];
    return r.cursorReset ? `History window set to ${label}. Older ${things} are read again from the next run; ${things} already in your brain are skipped.`
      : r.widened ? `History window set to ${label}.` : `History window set to ${label}. ${Things} older than that are no longer read; existing notes stay.`;
  };
  // Every connector's interval (saved or default), Claude.ai accounts included. Unknown connectors are refused on Save.
  const claudeIds = () => (services.claude?.list() ?? []).map(a => a.id);
  const intervals = () => services.feedSchedule ? resolvedIntervals(services.feedSchedule.read(), claudeIds()) : {};
  const usageCache = new Map<string, { at: number; value: unknown }>();
  return Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, async fetch(req) {
    const url = new URL(req.url);
    // Two ways in: the laptop (localhost:<port>, no login) or the tunnel's public address (device-link session).
    // A request that passed through Cloudflare is never "the laptop", whatever its Host header says (L1).
    const viaCloudflare = ["cf-connecting-ip", "cf-ray", "cdn-loop"].some(h => req.headers.has(h));
    const isLocal = !viaCloudflare && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === String(port);
    const publicUrl = services.remote?.status().url ?? null;
    const isPublic = !isLocal && !!publicUrl && url.host.toLowerCase() === new URL(publicUrl).host;
    if (!isLocal && !isPublic) return json({ error: "Invalid local address" }, 403);
    const origin = isPublic ? new URL(publicUrl!).origin : url.origin; // cloudflared reaches us over http; browsers send https
    if (isPublic) {
      if (isGbrainPath(url.pathname)) return proxyToGbrain(req, url, services.remote!.gbrainOrigin, new URL(publicUrl!).host);
      if (url.pathname === "/auth/device") {
        // Opening the link only shows a button; pressing it (POST) spends the link. Messaging-app previews
        // and browser prefetches open links but never submit forms, so they can no longer use it up.
        if (req.method === "GET") {
          const t = url.searchParams.get("t");
          return sessions.linkValid(t) ? confirmPage(product(), t!) : signInPage(product(), "This sign-in link has expired or was already used. Create a new one on the laptop.", 400);
        }
        const form = req.method === "POST" ? await req.formData().catch(() => null) : null;
        const id = sessions.redeem(typeof form?.get("t") === "string" ? form!.get("t") as string : null);
        if (!id) return signInPage(product(), "This sign-in link has expired or was already used. Create a new one on the laptop.", 400);
        return new Response(null, { status: 303, headers: { ...headers, location: "/",
          "set-cookie": `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}` } });
      }
      // The sign-in page's stylesheet and logo and the app shell (manifest, icons, service worker, offline page) are public: they hold nothing private.
      if (req.method === "GET" && Object.hasOwn(PUBLIC_SHELL, url.pathname)) return shellFile(url.pathname);
      if (!sessions.valid(readCookie(req.headers.get("cookie"), SESSION_COOKIE))) return signInPage(product());
      if (url.searchParams.has("code") || url.searchParams.has("error")) return json({ error: "Not found" }, 404); // Outlook sign-in returns to the laptop only
    }
    try {
      if (req.method === "GET") {
        if (url.pathname === "/api/status") return json({ ...publicStatus(services.config(), services.state(), services.connected(), services.running(), await schedule(), intervals()),
          runs: limitRuns(services.history?.() ?? { total: 0, succeeded: 0, failed: 0, skipped: 0, entries: [] }), backup: await backup(), ai: await services.ai?.status() ?? null, remote: services.remote ? withoutLogs({ ...services.remote.status(), devices: sessions.count() }, isPublic) : null, claude: services.claude?.status() ?? null, claudeAccounts: services.claude?.list() ?? [], gmail: services.gmail?.status() ?? null, whatsapp: services.whatsapp?.status() ?? null, dream: services.dream?.status() ?? null, chatgptChats: { enabled: chatgptChatsEnabled() }, updates: publicUpdates(services.updates?.status() ?? null, isPublic), backfill: windowSummary(), vault: basename(services.config().brainPath), notice, ...identity(appInfo()) });
        if (Object.hasOwn(SHELL, url.pathname)) return shellFile(url.pathname);
        // WhatsApp: the QR code reads every chat and the chat list names private chats, so both stay on the laptop.
        if (url.pathname.startsWith("/api/whatsapp/") && services.whatsapp) {
          if (isPublic) return json({ error: "Open WhatsApp settings on the laptop." }, 403);
          if (url.pathname === "/api/whatsapp/qr") {
            const svg = await services.whatsapp.qrSvg();
            return svg ? new Response(svg, { headers: { ...headers, "content-type": "image/svg+xml", "cache-control": "no-store" } }) : json({ error: "No QR code right now." }, 404);
          }
          if (url.pathname === "/api/whatsapp/chats") return json({ chats: services.whatsapp.chats() });
        }
        if (url.pathname === "/api/backfill/estimate" && services.backfill) {
          // Never part of the status poll: the dialog asks for it, and results are cached for 10 minutes.
          const feed = url.searchParams.get("feed") ?? "";
          if (feed !== "ai:claude:new" && !windowFeeds().includes(feed)) return json({ error: "That is not a chat connector." }, 400);
          try { return json(await services.backfill.estimate(feed)); }
          catch { return json({ error: "The estimate could not be made right now." }, 502); }
        }
        if (url.pathname === "/api/usage" && services.usage) {
          const range = (url.searchParams.get("range") ?? "30d") as Range;
          if (!Object.hasOwn(RANGES, range)) return json({ error: "Choose 7d, 30d, 90d or all." }, 400);
          const hit = usageCache.get(range);
          if (hit && Date.now() - hit.at < 30_000) return json(hit.value);
          const value = services.usage.report(range);
          usageCache.set(range, { at: Date.now(), value });
          return json(value);
        }
        if (url.pathname === "/api/notes") {
          // Server-side paging: ?source=&q=&from=&to=&page=&pageSize= (validated in notes-index.ts).
          const parsed = parseNotesQuery(url.searchParams);
          if ("error" in parsed) return json({ error: parsed.error }, 400);
          return json(queryNotes(notesIndexFor(services.config().brainPath), parsed.query));
        }
        if (url.pathname.startsWith("/api/entities") && services.entities) {
          const { index, applier } = services.entities;
          if (url.pathname === "/api/entities/duplicates") {
            const root = services.config().brainPath, judged = loadJudgements();
            const pairs = index.duplicates().slice(0, 200).map(p => ({ ...p, judgement: judged[pairKey(p.kind, p.keep.slug, p.merge.slug)] ?? null }));
            return json({ pairs, apply: applier.status(), decisions: automaticDecisions(root).slice(0, 200) });
          }
          const kind = url.searchParams.get("kind") as EntityKind;
          if (!ENTITY_KINDS.includes(kind)) return json({ error: "Unknown entity type." }, 400);
          if (url.pathname === "/api/entities") return json(index.list(kind));
          if (url.pathname === "/api/entities/item") {
            const item = index.detail(kind, url.searchParams.get("slug") ?? "");
            return item ? json(item) : json({ error: "That page no longer exists." }, 404);
          }
          return json({ error: "Not found" }, 404);
        }
        if (url.pathname === "/api/note") {
          // Only notes in the connector's own folders (email, Teams, meetings); never other vault files.
          const path = url.searchParams.get("path") ?? "";
          if (!/^inbox\/(email|teams|meetings|ai)\/[\w./-]+\.md$/.test(path) || path.split("/").includes("..")) return json({ error: "That is not a synced note." }, 404);
          const file = join(services.config().brainPath, path);
          if (!existsSync(file)) return json({ error: "This note has since been moved or removed from the vault." }, 404);
          return json({ path, content: readFileSync(file, "utf8").slice(0, 200_000) });
        }
        if (url.pathname !== "/") return json({ error: "Not found" }, 404);
        if (url.searchParams.has("error")) {
          notice = "Microsoft sign-in was cancelled or denied. You can connect again.";
          pending = null;
          return new Response(null, { status: 302, headers: { ...headers, location: "/" } });
        }
        if (url.searchParams.has("code")) {
          if (!pending || pending.expires < Date.now() || !validCallback(url, pending.auth.state) || exchanging) return json({ error: "Sign-in session expired or did not match. Open the portal and connect again." }, 400);
          exchanging = true;
          try {
            await services.exchange(pending.cfg, pending.auth.verifier, redirectUri, url.searchParams.get("code")!);
            notice = "Outlook connected. Use Sync now to collect email.";
          } catch { notice = "Microsoft could not finish sign-in. Try connecting again."; }
          finally { pending = null; exchanging = false; }
          return new Response(null, { status: 302, headers: { ...headers, location: "/" } });
        }
        return new Response(readFileSync(join(assets, "index.html"), "utf8").replace("__CONTROL_TOKEN__", control), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method !== "POST" || req.headers.get("origin") !== origin || req.headers.get("x-portal-token") !== control || req.headers.get("content-type")?.split(";")[0] !== "application/json") return json({ error: "Reload the local portal to continue." }, 403);
      // Over the tunnel only everyday actions are allowed; settings, sign-ins and access changes need the laptop.
      if (isPublic && !PUBLIC_POSTS.has(url.pathname))
        return json({ error: "Do this on the laptop: settings, sign-ins and remote access can only be changed there." }, 403);
      if (url.pathname === "/api/settings") {
        if (Number(req.headers.get("content-length") ?? 0) > 4096) return json({ error: "Request too large" }, 413);
        const body = await req.json();
        if (![body.lookbackDays, body.threadsPerRun].every(n => Number.isSafeInteger(n) && n >= 1)) return json({ error: "Enter positive whole numbers for days and threads." }, 400);
        services.configure({ MAILSYNC_SINCE_DAYS: String(body.lookbackDays), MAILSYNC_MAX_THREADS: String(body.threadsPerRun) });
        return json({ message: "Settings saved. They apply to the next run; wider history rescans safely without duplicate notes." });
      }
      if (url.pathname === "/api/connect") {
        const cfg = services.config();
        if (!cfg.clientId) return json({ error: "Microsoft app configuration is missing." }, 400);
        if (services.running() || (await schedule()).state === "Running") return json({ error: "Wait for the current sync to finish before reconnecting." }, 409);
        pending = { auth: makeAuthorization(cfg, redirectUri), cfg, expires: Date.now() + 15 * 60_000 };
        return json({ url: pending.auth.url });
      }
      if (url.pathname === "/api/backfill/window" && services.backfill) {
        if (Number(req.headers.get("content-length") ?? 0) > 1024) return json({ error: "Request too large" }, 413);
        const body = await req.json().catch(() => ({})) as { feed?: unknown; days?: unknown };
        if (typeof body.feed !== "string" || !windowFeeds().includes(body.feed)) return json({ error: "That is not a chat connector." }, 400);
        if (!isWindowDays(body.days)) return json({ error: "Choose 1 month, 6 months, 1 year or 2 years." }, 400);
        try {
          const r = services.backfill.set(body.feed, body.days);
          services.backfill.reset?.(body.feed);
          return json({ message: windowMessage(body.days, r, body.feed), ...r });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "The history window could not be saved." }, e instanceof WindowBusyError ? 409 : 400); }
      }
      if (url.pathname === "/api/connectors/schedule" && services.feedSchedule) { // laptop only (not in PUBLIC_POSTS)
        if (Number(req.headers.get("content-length") ?? 0) > 1024) return json({ error: "Request too large" }, 413);
        const body = await req.json().catch(() => ({})) as { connector?: unknown; minutes?: unknown };
        const known = isScheduleKey(body.connector) && (!body.connector.startsWith("claude:") || claudeIds().includes(body.connector.slice(7)));
        if (!known) return json({ error: "That is not a connector." }, 400);
        if (!isInterval(body.minutes)) return json({ error: "Choose 15 or 30 minutes, 1, 2, 3, 6 or 12 hours, or once a day." }, 400);
        services.feedSchedule.set(body.connector as string, body.minutes);
        return json({ message: "Sync interval saved. It applies from the next run; Sync now still reads every connector." });
      }
      if (url.pathname === "/api/usage/prices" && services.usage) {
        if (Number(req.headers.get("content-length") ?? 0) > 2048) return json({ error: "Request too large" }, 413);
        try { services.usage.savePrices(await req.json()); } catch (e) { return json({ error: e instanceof Error ? e.message : "Prices could not be saved." }, 400); }
        usageCache.clear();
        return json({ message: "Prices saved. Spend estimates use them from now on." });
      }
      if (url.pathname.startsWith("/api/whatsapp/") && services.whatsapp) { // laptop only (not in PUBLIC_POSTS)
        if (Number(req.headers.get("content-length") ?? 0) > 200_000) return json({ error: "Request too large" }, 413);
        const w = services.whatsapp, body = await req.json().catch(() => ({})) as { chats?: unknown };
        if (url.pathname === "/api/whatsapp/connect") { w.connect(); return json({ message: "Scan the QR code with WhatsApp on your phone." }); }
        if (url.pathname === "/api/whatsapp/cancel") { w.cancelLink(); return json({ message: "Linking stopped." }); }
        if (url.pathname === "/api/whatsapp/chats") {
          try { const on = w.setChats(body.chats); return json({ message: on.length ? `Saved. ${on.length} ${on.length === 1 ? "chat becomes" : "chats become"} notes from the next run.` : "Saved. No chat becomes notes." }); }
          catch (e) { return json({ error: e instanceof Error ? e.message : "Could not save." }, 400); }
        }
        if (url.pathname === "/api/whatsapp/disconnect") {
          const r = await w.disconnect();
          return json({ message: `WhatsApp disconnected and its local messages deleted.${r.unlinked ? "" : " Also remove \"Third Brain\" under Linked devices in WhatsApp on your phone."} Existing notes stay in your brain.` });
        }
        return json({ error: "Not found" }, 404);
      }
      if (url.pathname.startsWith("/api/gmail/") && services.gmail) { // laptop only (not in PUBLIC_POSTS): the app password is typed here
        if (Number(req.headers.get("content-length") ?? 0) > 8192) return json({ error: "Request too large" }, 413);
        const body = await req.json().catch(() => ({})) as { address?: unknown; password?: unknown; days?: unknown; scope?: unknown; refresh?: unknown };
        const g = services.gmail, refresh = body.refresh === true;
        const since = () => sinceIso(feedWindowDays(GMAIL_FEED, services.config(), services.backfill?.windows() ?? {}));
        const failed = (e: unknown, status = 400) => json({ error: e instanceof Error && !(e as { code?: string }).code ? e.message : "Gmail could not be read right now. Try again." }, e instanceof GmailError ? 502 : status);
        if (url.pathname === "/api/gmail/scope" && g.setScope) {
          try {
            const r = g.setScope(body.scope);
            return json({ message: r.changed ? "Saved. The next run reads the whole history window again with these choices. Mail already in your brain is skipped, so only new threads are summarised."
              : "Saved. Nothing changed in what is read." , changed: r.changed });
          } catch (e) { return failed(e); }
        }
        if (url.pathname === "/api/gmail/counts" && g.counts) {
          try { return json(await g.counts(since(), refresh)); } catch (e) { return failed(e); }
        }
        if (url.pathname === "/api/gmail/estimate" && g.estimate) {
          try {
            const r = await g.estimate(body.scope, since(), refresh), cfg = services.config();
            const perChat = perChatFromLogs(readLogLines(logsDir, daysAgo(7)));
            // The same model as the history window dialog: tokens per summarised thread, threads per run, one run per 15 minutes.
            return json({ ...r, perChat, writer: writerOf(cfg), decision: cfg.decisionProvider === "typesafe", threadsPerRun: cfg.maxThreadsPerRun, ...windowCost(r.newThreads, perChat, cfg.maxThreadsPerRun) });
          } catch (e) { return failed(e); }
        }
        if (url.pathname === "/api/gmail/connect") {
          if (body.days !== undefined && (!isWindowDays(body.days) || !services.backfill)) return json({ error: "Choose 1 month, 6 months, 1 year or 2 years." }, 400);
          try {
            const r = await services.gmail.connect(body.address, body.password); // LOGIN + SELECT All Mail before anything is saved
            if (body.days !== undefined) { try { services.backfill!.set(GMAIL_FEED, body.days as number); } catch { /* a running sync: the window stays as it was */ } services.backfill!.reset?.(GMAIL_FEED); }
            return json({ message: `Gmail connected as ${r.address}. Primary inbox and Sent mail sync from the next run.${r.identityAdded ? " Mail from this address now counts as yours." : ""}` });
          } catch (e) {
            // Fixed messages only (adapters/gmail-imap.ts); the password and the server's own words are never echoed.
            return json({ error: e instanceof GmailError || (e instanceof Error && !(e as { code?: string }).code) ? (e as Error).message : "Gmail could not be checked right now. Try again." }, 400);
          }
        }
        if (url.pathname === "/api/gmail/disconnect") {
          services.gmail.disconnect();
          return json({ message: "Gmail disconnected and its app password deleted from this computer. Existing notes stay in your brain." });
        }
        return json({ error: "Not found" }, 404);
      }
      if (url.pathname === "/api/chatgpt-chats/enable" || url.pathname === "/api/chatgpt-chats/disable") {
        const on = url.pathname.endsWith("/enable");
        setChatgptChats(on);
        return json({ message: on ? "ChatGPT chats will sync from the next run, using your ChatGPT sign-in from Settings."
          : "ChatGPT chat sync stopped. Existing notes stay in your brain; the ChatGPT sign-in still writes notes." });
      }
      if (url.pathname.startsWith("/api/claude/") && services.claude) {
        if (Number(req.headers.get("content-length") ?? 0) > 2048) return json({ error: "Request too large" }, 413);
        const body = await req.json().catch(() => ({})) as { account?: unknown; label?: unknown; days?: unknown };
        const account = typeof body.account === "string" ? body.account : undefined;
        // Optional history window chosen in the confirmation dialog (validated before anything is opened).
        if (body.days !== undefined && (!isWindowDays(body.days) || !services.backfill)) return json({ error: "Choose 1 month, 6 months, 1 year or 2 years." }, 400);
        const days = body.days as number | undefined;
        const opened = "A Claude.ai window opened. Sign in there; it minimises itself when you are in, and chats start syncing on the next run.";
        try {
          if (url.pathname === "/api/claude/connect") {
            if (days !== undefined) {
              const feed = services.claude.list().find(a => a.id === (account ?? "personal"))?.feed;
              if (!feed) return json({ error: "That Claude.ai account is not set up." }, 400);
              services.backfill!.set(feed, days); services.backfill!.reset?.(feed);
            }
            await services.claude.connect(account); return json({ message: opened });
          }
          if (url.pathname === "/api/claude/accounts") {
            const added = await services.claude.add(typeof body.label === "string" ? body.label : "");
            const feed = services.claude.list().find(a => a.id === added.id)?.feed;
            if (days !== undefined && feed) services.backfill!.set(feed, days); // a new feed: no cursor yet, so nothing to reset
            return json({ message: `${added.label}: ${opened}`, account: added.id });
          }
          if (url.pathname === "/api/claude/disconnect") {
            services.claude.disconnect(account);
            return json({ message: "Claude.ai account disconnected and its browser profile removed. Existing notes stay in your brain." });
          }
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Could not open the Claude.ai browser." }, e instanceof WindowBusyError ? 409 : 400); }
      }
      if (url.pathname === "/api/remote/device-link") {
        if (!publicUrl) return json({ error: "Turn on a tunnel first; the link uses its public address." }, 409);
        const link = sessions.createLink();
        return json({ message: "Sign-in link created. Open it on your phone or other computer within 10 minutes; it works once.",
          link: `${new URL(publicUrl).origin}/auth/device?t=${link.token}` });
      }
      if (url.pathname === "/api/remote/gbrain-admin-link" && services.remote) {
        if (!publicUrl) return json({ error: "Turn on a tunnel first: approvals happen on the public address." }, 409);
        try { return json({ message: "Opened a one-time GBrain admin sign-in (valid 5 minutes). Approve Claude.ai or ChatGPT connections in that browser.", url: await services.remote.adminLoginLink() }); }
        catch (e) { return json({ error: e instanceof Error ? e.message : "Could not create a GBrain admin login link." }, 502); }
      }
      if (url.pathname === "/api/remote/signout-devices") {
        sessions.revokeAll();
        return json({ message: "Signed out every other device. This laptop stays signed in." });
      }
      if (url.pathname === "/api/remote/settings" && services.remote) {
        if (Number(req.headers.get("content-length") ?? 0) > 8192) return json({ error: "Request too large" }, 413);
        const body = await req.json().catch(() => ({}));
        try {
          services.remote.configure({ mode: body.mode, hostname: typeof body.hostname === "string" ? body.hostname : undefined, token: typeof body.token === "string" && body.token ? body.token : null });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "Remote access could not be changed." }, 400); }
        return json({ message: body.mode === "local" ? "Remote access is off. GBrain answers on this laptop only."
          : body.mode === "quick" ? "Starting a quick tunnel. Its address appears here in a few seconds; it changes each time the tunnel restarts."
          : "Starting the named tunnel. It is ready when the status shows Connected." });
      }
      if (url.pathname.startsWith("/api/ai/") && services.ai) {
        if (Number(req.headers.get("content-length") ?? 0) > 4096) return json({ error: "Request too large" }, 413);
        const step = url.pathname.slice("/api/ai/".length), body = await req.json().catch(() => ({}));
        const provider = PROVIDERS.includes(body.provider) ? body.provider : null;
        try {
          if (step === "settings") {
            if (!provider || typeof body.model !== "string") return json({ error: "Choose a provider." }, 400);
            services.ai.save(provider, body.model);
            return json({ message: "Extraction settings saved. The next sync run uses them." });
          }
          if (step === "decision") {
            if (!["off", "typesafe"].includes(body.provider) || (body.model !== undefined && typeof body.model !== "string")) return json({ error: "Choose Off or TypeSafe Jev." }, 400);
            services.ai.saveDecision(body.provider, body.model ?? "");
            return json({ message: body.provider === "off" ? "Decision model turned off." : "Decision model saved. From the next sync run, Jev checks new conversations before the note writer." });
          }
          if (step === "decision-test") return json({ message: await services.ai.testDecision() });
          if (step === "key") {
            const keyProvider = body.provider === "typesafe" ? "typesafe" : provider;
            if (keyProvider !== "openai" && keyProvider !== "anthropic" && keyProvider !== "typesafe") return json({ error: "Only the OpenAI, Claude and TypeSafe APIs use a key." }, 400);
            if (body.key !== null && typeof body.key !== "string") return json({ error: "Paste an API key." }, 400);
            services.ai.setKey(keyProvider, body.key);
            return json({ message: body.key === null ? "API key removed." : "API key saved on this computer. Use Test connection to check it." });
          }
          if (step === "test") {
            if (!provider) return json({ error: "Choose a provider." }, 400);
            return json({ message: await services.ai.test(provider) });
          }
          if (step === "chatgpt-login") {
            const { started } = services.ai.chatgptLogin(); // the sign-in URL itself stays server-side, in the status's loginUrl
            return json({ message: started
              ? "ChatGPT sign-in opened in your browser. This page updates as soon as you finish there."
              : "Sign-in is already waiting in your browser. Finish it there, or use the link below to reopen it." });
          }
          if (step === "chatgpt-signout") {
            services.ai.chatgptSignOut();
            return json({ message: "Signed out of ChatGPT on this computer." });
          }
        } catch (e) { return json({ error: e instanceof Error ? e.message : "That setting could not be saved." }, 400); }
        return json({ error: "Not found" }, 404);
      }
      if (url.pathname.startsWith("/api/update/") && services.updates) { // laptop only (not in PUBLIC_POSTS)
        const step = url.pathname.slice("/api/update/".length);
        if (step === "check") {
          await services.updates.check(true);
          const u = services.updates.status();
          if (u.error) return json({ error: `Update check failed: ${u.error}` }, 502);
          return json({ message: u.available ? `Third Brain ${u.latest!.version} is available.` : `Third Brain ${u.current.version} is up to date.` });
        }
        if (step === "apply") {
          // Dream pauses the sync itself and turns it back on at its end: start an update only after Dream.
          if (services.dream?.status().running) return json({ error: "Dream is running. Update after it finishes." }, 409);
          try {
            const { version } = await services.updates.apply();
            return json({ message: `Updating to ${version}. The portal pauses the sync, waits for a running sync to finish, updates and restarts; this page reconnects by itself.` });
          } catch (e) { return json({ error: e instanceof Error ? e.message : "The update could not start." }, e instanceof UpdateRefused ? 409 : 500); }
        }
        return json({ error: "Not found" }, 404);
      }
      if (url.pathname === "/api/entities/judge" && services.entities) { // laptop only: ask the model now, then apply
        services.entities.applier.request({ judge: true });
        return json({ message: "Duplicate check started. Clear pairs are merged or dismissed in a few minutes; the rest stay for you." });
      }
      if (url.pathname === "/api/entities/undo" && services.entities) {
        try { undoMerge(services.config().brainPath, await req.json().catch(() => ({}))); } catch (e) { return json({ error: e instanceof Error ? e.message : "That merge could not be undone." }, 400); }
        services.entities.index.reset(); services.entities.applier.request();
        return json({ message: "Merge undone. The other page comes back in a minute (after a running sync); the pair is marked not the same." });
      }
      if ((url.pathname === "/api/entities/merge" || url.pathname === "/api/entities/distinct") && services.entities) { // laptop only
        const root = services.config().brainPath, body = await req.json().catch(() => ({}));
        try {
          if (url.pathname.endsWith("/merge")) {
            const r = recordMerge(root, body);
            services.entities.index.reset(); services.entities.applier.request();
            return json({ message: `Merge saved: ${r.from} goes into ${r.to}. The pages and links change in a minute (after a running sync).` });
          }
          recordDistinct(root, body); services.entities.index.reset();
          return json({ message: "Saved: these are not the same. They are not suggested again." });
        } catch (e) { return json({ error: e instanceof Error ? e.message : "That decision could not be saved." }, 400); }
      }
      if (url.pathname.startsWith("/api/dream/") && services.dream) { // laptop only (not in PUBLIC_POSTS)
        const step = url.pathname.slice("/api/dream/".length);
        if (step === "run") {
          if (services.dream.status().running) return json({ error: "Dream is already running." }, 409);
          void services.dream.run();
          return json({ message: "Dream started. It waits for a running sync first; GBrain does not answer for a few minutes near the end." });
        }
        if (step === "settings") {
          try { services.dream.configure(await req.json()); } catch (e) { return json({ error: e instanceof Error ? e.message : "That setting could not be saved." }, 400); }
          const d = services.dream.status();
          return json({ message: d.enabled ? `Dream is on. It runs every night at ${String(d.hour).padStart(2, "0")}:00.` : "Dream is off. Links are still added to new notes during each sync." });
        }
        return json({ error: "Not found" }, 404);
      }
      if (url.pathname.startsWith("/api/backup/") && services.backupAction) {
        const step = url.pathname.slice("/api/backup/".length);
        if (step === "settings") {
          const body = await req.json();
          if (!BACKUP_INTERVALS.includes(body.intervalMinutes) || typeof body.push !== "boolean") return json({ error: "Choose a listed backup frequency." }, 400);
          services.configure({ BACKUP_PUSH: String(body.push) });
          if ((await backup())?.intervalMinutes !== body.intervalMinutes) await services.backupAction({ intervalMinutes: body.intervalMinutes });
          backup.reset();
          return json({ message: body.push ? "Backup settings saved. Backups commit and push to GitHub." : "Backup settings saved. Backups commit locally and are not pushed." });
        }
        const messages = { run: "Backup started. Status refreshes automatically.", pause: "Automatic backup paused.", resume: "Automatic backup resumed." };
        if (!(step in messages)) return json({ error: "Not found" }, 404);
        if (step === "run" && (await backup())?.state === "Running") return json({ message: "A backup is already running." });
        await services.backupAction(step as keyof typeof messages);
        backup.reset();
        return json({ message: messages[step as keyof typeof messages] });
      }
      const action = { "/api/sync": "sync", "/api/pause": "pause", "/api/resume": "resume" }[url.pathname] as "sync" | "pause" | "resume" | undefined;
      if (action) {
        const task = await services.schedule();
        if (action === "sync") {
          if (!services.connected() || services.state().lastRun?.error === "NEEDS_LOGIN") return json({ error: "Connect Outlook first." }, 409);
          if (task.state === "Unavailable") return json({ error: "Docker scheduler or the local worker is unavailable. Start Docker Desktop and the portal." }, 409);
          if (task.state === "Disabled" || task.enabled === false) return json({ error: "Resume automatic sync first." }, 409);
          if (services.running() || ["Running", "Queued"].includes(task.state)) return json({ message: "A sync is already running or queued." });
        }
        await services.action(action);
        schedule.reset();
        return json({ message: action === "sync" ? "Sync requested. Status refreshes automatically." : action === "pause" ? "Automatic sync paused. Any current run will finish." : "Automatic sync resumed." });
      }
      return json({ error: "Not found" }, 404);
    } catch { return json({ error: "The portal could not complete this request. Check the scheduler and local collector state." }, 500); }
  } });
}

if (import.meta.main) {
  const remote = deps.remote;
  if (remote) deps.dream = createDream({
    gbrain: { pause: remote.pauseGbrain, resume: remote.resumeGbrain },
    runner: { // the same controls as the portal's Pause / Resume buttons
      status: async () => { const s = await deps.schedule(); return { enabled: s.enabled ?? s.state !== "Disabled", busy: s.state === "Running" || !!runningCollector() }; },
      enable: on => deps.action(on ? "resume" : "pause"),
    },
  });
  const updates = createUpdates({
    repo: () => loadAppConfig().updates.repo,
    runner: { // Pause/Resume as on the portal; busy while a sync run or Dream works (a restart would cut them off)
      status: async () => { const s = await deps.schedule(); return { enabled: s.enabled ?? s.state !== "Disabled", busy: s.state === "Running" || !!runningCollector() || !!deps.dream?.status().running }; },
      enable: on => deps.action(on ? "resume" : "pause"),
    },
  });
  deps.updates = updates;
  const server = createPortal();
  startWorker();
  backups.start();
  deps.remote?.start(); // the one GBrain server (+ Cloudflare tunnel when remote access is on)
  deps.claude?.start(); // keeps each connected Claude.ai account's window running (minimised)
  (deps.dream as Dream | undefined)?.start();
  deps.whatsapp?.start?.(); // reconnects a linked WhatsApp device (its own process)
  updates.start(); // this install's version now; GitHub's latest release after 60 s, then every 6 hours // nightly: related notes, topics, GBrain links + embeddings (src/dream.ts)
  // Build the notes index now, so the first visit to the Notes page does not wait ~1 s for the first scan.
  setTimeout(() => {
    try { const index = notesIndexFor(loadConfig().brainPath); for (const source of NOTE_SOURCES) queryNotes(index, { source, q: "", from: "", to: "", page: 1, pageSize: 1 }); }
    catch { /* the page builds it on demand */ }
  }, 2_000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { deps.remote?.stop(); deps.whatsapp?.stop?.(); process.exit(0); });
  console.log(`Brain connector portal: http://localhost:${server.port}/ (loopback only)`);
}
