// Third Brain desktop: a window and a tray icon for the local portal. Nothing else.
// The BrainPortal background service runs the sync, Dream, backups and GBrain; this app never
// starts, stops or owns any of it. It only shows the portal and reads GET /api/status.
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, screen, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { isPortalUrl, externalAllowed, readPortalToken, syncRequest, statusLine, failedRunToNotify, loginToNotify, updateMenuLabel, updateToNotify, settingsUrl } = require("./rules.js");

const PORTAL_URL = new URL(process.env.THIRDBRAIN_URL || "http://127.0.0.1:58432").href;
const SMOKE = process.argv.includes("--smoke");   // load, print title + tray status, quit
const HIDDEN = process.argv.includes("--hidden"); // started at sign-in: stay in the tray
const STATUS_EVERY_MS = 60_000;
const ICON = path.join(__dirname, "assets", "icon.png");
const TRAY_ICON = path.join(__dirname, "assets", "tray.png"); // tray@2x.png is picked up for high DPI

app.setName("Third Brain");
if (process.platform === "win32") app.setAppUserModelId("org.ossmalaysia.thirdbrain");

let win = null, tray = null, quitting = false;
let status = null, statusText = statusLine(null), seenFailedRun = undefined;

// --- Window state: a small JSON in userData -------------------------------------------------

const STATE_FILE = path.join(app.getPath("userData"), "window-state.json");

function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // Only reuse the position when it is still on a connected display.
    const area = screen.getDisplayMatching(b).workArea;
    const visible = b.x < area.x + area.width && b.x + b.width > area.x && b.y < area.y + area.height && b.y + b.height > area.y;
    return visible ? b : { width: b.width, height: b.height };
  } catch { return { width: 1280, height: 860 }; }
}

let saveTimer = null;
function saveBounds() {
  if (SMOKE || !win || win.isMinimized() || win.isFullScreen()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(win.getNormalBounds())); } catch {}
  }, 500);
}

// --- The window -----------------------------------------------------------------------------

function showOffline() {
  win.loadFile(path.join(__dirname, "offline.html"), { query: { url: PORTAL_URL } });
}

// Open outside the app, but only for http/https/obsidian. Anything else is dropped.
function openOutside(url) {
  if (externalAllowed(url)) shell.openExternal(url).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    ...loadBounds(), minWidth: 360, minHeight: 480,
    title: "Third Brain", icon: ICON, show: false, autoHideMenuBar: true, backgroundColor: "#161615",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });

  const contents = win.webContents;
  // Only portal pages (and the local offline page) load in the window; the rest goes to the system.
  contents.on("will-navigate", (event, url) => {
    if (isPortalUrl(url, PORTAL_URL)) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.on("will-redirect", (event, url) => {
    if (isPortalUrl(url, PORTAL_URL)) return;
    event.preventDefault();
    openOutside(url);
  });
  // window.open and target=_blank: never a new Electron window.
  contents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: "deny" }; });
  // The portal is down (connection refused, timeout ...): show the local page, not a blank window.
  contents.on("did-fail-load", (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */ || url.startsWith("file:")) return;
    showOffline();
  });
  contents.on("page-title-updated", (event) => { event.preventDefault(); win.setTitle(contents.getTitle() || "Third Brain"); });

  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  // Closing hides to the tray; "Quit" in the tray really quits.
  win.on("close", (event) => {
    if (quitting || SMOKE) return;
    event.preventDefault();
    win.hide();
  });

  win.once("ready-to-show", () => { if (!HIDDEN && !SMOKE) win.show(); });
  win.loadURL(PORTAL_URL).catch(() => {}); // failures arrive through did-fail-load
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// --- Portal status and "Sync now" -----------------------------------------------------------

async function refreshStatus() {
  try {
    const res = await fetch(new URL("/api/status", PORTAL_URL), { signal: AbortSignal.timeout(3000) });
    status = res.ok ? await res.json() : null;
  } catch { status = null; }
  statusText = statusLine(status);
  if (tray) { tray.setToolTip(`Third Brain - ${statusText}`); if (process.platform !== "win32") tray.setContextMenu(buildMenu()); }
  notifyFailedRun();
  notifyLogin();
  notifyUpdate();
  return statusText;
}

// One notice per lost Microsoft sign-in (remembered in userData; announced also when it was lost before this app started).
const LOGIN_SEEN_FILE = path.join(app.getPath("userData"), "login-seen.json");
function notifyLogin() {
  let seen = null;
  try { seen = JSON.parse(fs.readFileSync(LOGIN_SEEN_FILE, "utf8")).lostAt || null; } catch {}
  const lost = loginToNotify(status, seen);
  if (!lost || SMOKE) return;
  try { fs.mkdirSync(path.dirname(LOGIN_SEEN_FILE), { recursive: true }); fs.writeFileSync(LOGIN_SEEN_FILE, JSON.stringify({ lostAt: lost.lostAt })); } catch {}
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: "Microsoft sign-in needed", body: `${lost.reason} Click to open Third Brain and reconnect Outlook.`, icon: ICON });
  note.on("click", () => { showWindow(); if (win) win.loadURL(new URL("/#/connectors/outlook", PORTAL_URL).href).catch(() => {}); });
  note.show();
}

// One notice per failed run. Runs that had already failed when the app started are not announced.
function notifyFailedRun() {
  if (!status) return;
  const id = failedRunToNotify(status, seenFailedRun);
  if (seenFailedRun === undefined) { seenFailedRun = id || null; return; }
  if (!id) return;
  seenFailedRun = id;
  if (SMOKE || !Notification.isSupported()) return;
  const note = new Notification({ title: "Third Brain sync failed", body: (status.lastRun && status.lastRun.error) || "Open Third Brain for details.", icon: ICON });
  note.on("click", showWindow);
  note.show();
}

// One notice per new version (remembered in userData, so a restart of this app does not repeat it).
const UPDATE_SEEN_FILE = path.join(app.getPath("userData"), "update-seen.json");
function notifyUpdate() {
  let seen = null;
  try { seen = JSON.parse(fs.readFileSync(UPDATE_SEEN_FILE, "utf8")).version || null; } catch {}
  const version = updateToNotify(status, seen);
  if (!version || SMOKE) return;
  try { fs.mkdirSync(path.dirname(UPDATE_SEEN_FILE), { recursive: true }); fs.writeFileSync(UPDATE_SEEN_FILE, JSON.stringify({ version })); } catch {}
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: `Third Brain ${version} is available`, body: "Open Settings in Third Brain to see what is new and update.", icon: ICON });
  note.on("click", openSettings);
  note.show();
}

// Show the window on the portal's Settings page (the Updates card).
function openSettings() {
  showWindow();
  if (win) win.loadURL(settingsUrl(PORTAL_URL)).catch(() => {});
}

// Same request the portal page sends: the control token comes from the page's meta tag.
async function syncNow() {
  try {
    const page = await fetch(PORTAL_URL, { signal: AbortSignal.timeout(5000) });
    const token = readPortalToken(await page.text());
    if (!token) throw new Error("The portal page has no control token.");
    const { url, init } = syncRequest(PORTAL_URL, token);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || `HTTP ${res.status}`);
  } catch (error) {
    if (Notification.isSupported()) new Notification({ title: "Sync did not start", body: String(error.message || error), icon: ICON }).show();
  }
  setTimeout(refreshStatus, 1500);
}

// --- Tray -----------------------------------------------------------------------------------

// Open at sign-in. In development (electron .) the app folder must follow electron.exe.
function loginItem() {
  const args = app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"];
  return { path: process.execPath, args };
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: "Open Third Brain", click: showWindow },
    { label: statusText, enabled: false },
    ...(updateMenuLabel(status) ? [{ label: updateMenuLabel(status), click: openSettings }] : []),
    { label: "Sync now", enabled: !!status && !status.busy, click: syncNow },
    { type: "separator" },
    { label: "Open at sign-in", type: "checkbox", checked: app.getLoginItemSettings(loginItem()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ ...loginItem(), openAtLogin: item.checked }) },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.setToolTip(`Third Brain - ${statusText}`);
  tray.on("click", showWindow);
  if (process.platform === "win32") {
    // Read the status first, so the menu opens with the current state.
    tray.on("right-click", async () => { await refreshStatus(); tray.popUpContextMenu(buildMenu()); });
  } else {
    tray.setContextMenu(buildMenu());
  }
}

// --- Start ----------------------------------------------------------------------------------

async function smoke() {
  const timer = setTimeout(() => { console.log("smoke: timeout"); app.exit(1); }, 20000);
  await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  // A refused connection loads the offline page next; wait for it to settle.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log(`smoke: url ${win.webContents.getURL().split("?")[0]}`);
  console.log(`smoke: title ${win.webContents.getTitle()}`);
  console.log(`smoke: tray ${await refreshStatus()}`);
  clearTimeout(timer);
  app.exit(0);
}

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit(); // a first instance runs: it gets "second-instance" and shows its window
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => {}); // keep running in the tray
  app.whenReady().then(() => {
    createWindow();
    createTray();
    if (SMOKE) return smoke();
    refreshStatus();
    setInterval(refreshStatus, STATUS_EVERY_MS);
  });
}
