// Minimal Chrome DevTools Protocol client: launch a real Edge/Chrome with its own profile, find the claude.ai
// tab, call fixed JavaScript functions in it, and minimise/restore its window. Replaces chromedp from
// ossmalaysia/claude-sync (MIT, Anchor Sprint), whose browser flags and approach this follows.
import { existsSync } from "node:fs";

/** Same candidates as claude-sync's FindBrowser, Edge first (always installed on Windows). */
export function findBrowser(env: Record<string, string | undefined> = process.env): string | null {
  const roots = (keys: string[]) => keys.map(k => env[k]).filter(Boolean) as string[];
  const candidates = [
    ...roots(["ProgramFiles(x86)", "ProgramFiles"]).map(b => `${b}\\Microsoft\\Edge\\Application\\msedge.exe`),
    ...roots(["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"]).map(b => `${b}\\Google\\Chrome\\Application\\chrome.exe`),
  ];
  return candidates.find(p => existsSync(p)) ?? null;
}

/** Headed on purpose: Cloudflare challenges headless browsers. Flags as in claude-sync's browser.Open. */
export function launchArgs(profileDir: string, port: number, url: string): string[] {
  return [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled",
    // The window lives minimised: without these, Edge freezes the hidden tab (sleeping tabs, timer throttling)
    // and every in-tab fetch hangs (seen 2026-10-17).
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--disable-features=msSleepingTabs,IntensiveWakeUpThrottling,CalculateNativeWinOcclusion",
    "--window-size=1100,800", url];
}

export interface Target { id: string; type: string; url: string; webSocketDebuggerUrl?: string }

/** One WebSocket connection to a DevTools target, with request/response matching. */
export class CdpConnection {
  private next = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", ev => {
      const msg = JSON.parse(String(ev.data));
      const w = msg.id && this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message ?? "DevTools error")) : w.resolve(msg.result);
    });
    ws.addEventListener("close", () => { for (const w of this.waiting.values()) w.reject(new Error("browser window closed")); this.waiting.clear(); });
  }
  static open(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error("could not reach the browser")); }, timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(new CdpConnection(ws)); });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("could not reach the browser")); });
    });
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.waiting.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

const devtools = (port: number, path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: AbortSignal.timeout(5000) });

/** True when a browser answers DevTools on this port. */
export async function browserAlive(port: number): Promise<boolean> {
  try { return (await devtools(port, "/json/version")).ok; } catch { return false; }
}

/** True when `url` is on exactly `origin` (scheme, host name and port). Look-alikes such as
 *  https://claude.ai.evil.com or https://evilclaude.ai are not; neither is anything that does not parse. */
export function onOrigin(url: string, origin: string): boolean {
  try { return new URL(url).origin === new URL(origin).origin; } catch { return false; }
}

/** The tab to use: one on `origin`, else a sign-in page, else none (pure, for tests). */
export function pickTab(targets: Target[], origin: string): Target | undefined {
  const pages = targets.filter(t => t.type === "page");
  return pages.find(t => onOrigin(t.url, origin)) ?? pages.find(t => /login|auth|sso|accounts\./i.test(t.url));
}

/** The claude.ai tab, opening one if the user closed it. */
export async function claudeTab(port: number, origin = "https://claude.ai"): Promise<Target> {
  const tab = pickTab(await (await devtools(port, "/json/list")).json() as Target[], origin);
  if (tab) return tab;
  const created = await devtools(port, `/json/new?${encodeURIComponent(origin + "/")}`, { method: "PUT" });
  return await created.json() as Target;
}

/** Calls `fn` (the source of a function, a fixed constant: never built from data) in the tab with `args` as
 *  its arguments, awaiting a promise, and returns its JSON value. The arguments travel as DevTools values
 *  (Runtime.callFunctionOn), so no data is ever turned into code. The minimised tab is marked active and
 *  focused first; if the call still hangs (a frozen page never settles its fetches) the tab is reloaded once. */
export async function callInTab<T>(port: number, fn: string, args: unknown[] = [], timeoutMs = 60_000): Promise<T> {
  const tab = await claudeTab(port);
  if (!tab.webSocketDebuggerUrl) throw new Error("the claude.ai tab is not debuggable");
  const conn = await CdpConnection.open(tab.webSocketDebuggerUrl);
  const wake = async () => {
    await conn.send("Page.setWebLifecycleState", { state: "active" }, 5000).catch(() => {});
    await conn.send("Emulation.setFocusEmulationEnabled", { enabled: true }, 5000).catch(() => {});
  };
  const run = async () => {
    // The page's global object is the `this` of the call; asked again after a reload (the old one is gone).
    const global = await conn.send<{ result: { objectId?: string } }>("Runtime.evaluate", { expression: "globalThis" }, timeoutMs);
    if (!global.result.objectId) throw new Error("the claude.ai tab has no page to run in");
    return conn.send<{ result: { value: T }; exceptionDetails?: { text?: string } }>("Runtime.callFunctionOn",
      { objectId: global.result.objectId, functionDeclaration: fn, arguments: args.map(value => ({ value })), awaitPromise: true, returnByValue: true }, timeoutMs);
  };
  try {
    await wake();
    let r;
    try { r = await run(); }
    catch (e) {
      if (!/timed out/.test(String(e))) throw e;
      await conn.send("Page.reload", {}, 10_000).catch(() => {});
      for (let i = 0; i < 30; i++) { // wait for the reloaded page to be scriptable on claude.ai again
        await new Promise(res => setTimeout(res, 1000));
        const ready = await conn.send<{ result: { value: string } }>("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, 5000).catch(() => null);
        if (ready?.result.value === "complete") break;
      }
      await wake();
      r = await run();
    }
    if (r.exceptionDetails) throw new Error(`script failed in the claude.ai tab: ${r.exceptionDetails.text ?? "error"}`);
    return r.result.value;
  } finally { conn.close(); }
}

/** Minimises (after sign-in) or restores (for sign-in) the browser window holding the claude.ai tab. */
export async function setWindowState(port: number, state: "minimized" | "normal"): Promise<void> {
  const version = await (await devtools(port, "/json/version")).json() as { webSocketDebuggerUrl: string };
  const tab = await claudeTab(port);
  const conn = await CdpConnection.open(version.webSocketDebuggerUrl);
  try {
    const { windowId } = await conn.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: tab.id });
    await conn.send("Browser.setWindowBounds", { windowId, bounds: { windowState: state } });
  } finally { conn.close(); }
}
