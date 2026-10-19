// Pure rules for the desktop shell: which URLs stay in the window, which go to the system,
// and how the portal's status and control token are read. No Electron here, so `bun test` covers it.

// GBrain's paths on the portal origin (the portal forwards them). They are not portal pages:
// the admin login and OAuth pages open in the default browser.
const GBRAIN_PATHS = ["/mcp", "/authorize", "/token", "/register", "/revoke", "/.well-known", "/admin", "/health", "/metrics"];

// Schemes the system may open. Everything else (file:, javascript:, ms-*, custom handlers) is dropped.
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "obsidian:"]);

function parse(url) {
  try { return new URL(url); } catch { return null; }
}

// True when `url` is a portal page on the same origin as `portalUrl`.
function isPortalUrl(url, portalUrl) {
  const u = parse(url), p = parse(portalUrl);
  if (!u || !p || u.origin !== p.origin) return false;
  return !GBRAIN_PATHS.some((path) => u.pathname === path || u.pathname.startsWith(path + "/") || (path === "/admin" && u.pathname.startsWith("/admin")));
}

// True when `url` may go to shell.openExternal (default browser or Obsidian).
function externalAllowed(url) {
  const u = parse(url);
  return !!u && EXTERNAL_SCHEMES.has(u.protocol);
}

// The 64-hex control token from `<meta name="portal-token" content="...">`, or null.
function readPortalToken(html) {
  const tag = String(html).match(/<meta\s+[^>]*name=["']portal-token["'][^>]*>/i);
  const token = tag && tag[0].match(/content=["']([0-9a-f]{64})["']/i);
  return token ? token[1] : null;
}

// The request for "Sync now": same headers as the portal page itself sends.
function syncRequest(portalUrl, token) {
  const origin = new URL(portalUrl).origin;
  return {
    url: origin + "/api/sync",
    init: { method: "POST", headers: { origin, "x-portal-token": token, "content-type": "application/json" }, body: "{}" },
  };
}

// One short line for the tray menu and tooltip. `status` is GET /api/status, or null when the portal is down.
function statusLine(status) {
  if (!status) return "Portal not running";
  const state = status.busy ? "Running" : (status.schedule && status.schedule.state) || "Unavailable";
  const failed = status.lastRun && status.lastRun.error ? " (last run failed)" : "";
  return `Sync: ${state}${failed}`;
}

// The id of the newest run when it failed and is not `seenId`, else null (one notice per failed run).
function failedRunToNotify(status, seenId) {
  const run = status && status.runs && Array.isArray(status.runs.entries) ? status.runs.entries[0] : null;
  return run && run.status === "failed" && run.id && run.id !== seenId ? run.id : null;
}

// The newer release the portal reports (status.updates, from GitHub), as a plain version string, or null.
function availableUpdate(status) {
  const u = status && status.updates;
  const v = u && u.available && u.latest && typeof u.latest.version === "string" ? u.latest.version : "";
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
}

// Tray menu label for an available update, or null.
function updateMenuLabel(status) {
  const v = availableUpdate(status);
  return v ? `Update available: ${v}` : null;
}

// The version to announce once: an available update that is not `seenVersion`, else null.
function updateToNotify(status, seenVersion) {
  const v = availableUpdate(status);
  return v && v !== seenVersion ? v : null;
}

// The portal's Settings page (it has the Updates card).
const settingsUrl = (portalUrl) => new URL("/#settings", portalUrl).href;

module.exports = { isPortalUrl, externalAllowed, readPortalToken, syncRequest, statusLine, failedRunToNotify, availableUpdate, updateMenuLabel, updateToNotify, settingsUrl };
