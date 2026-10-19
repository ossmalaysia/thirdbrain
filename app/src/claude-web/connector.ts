// Portal side of the Claude.ai connector: owns the dedicated Edge/Chrome window (own profile, outside the
// vault), the sign-in flow and keep-alive. The sync process reaches the same window over DevTools using the
// port recorded in claude-browser.json.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../state.ts";
import { atomicJson, readJson } from "../../docker/scheduler.mjs";
import { browserAlive, findBrowser, launchArgs, setWindowState } from "./cdp.ts";
import { hideBrowserWindows, showBrowserWindows } from "./window.ts";
import { accountEmail, browserApi, signedIn, CLAUDE_ORIGIN } from "./session.ts";
import { killTree } from "../remote/supervisor.ts";

export const CLAUDE_BROWSER_FILE = join(STATE_DIR, "claude-browser.json");
export const CLAUDE_PROFILE_DIR = join(STATE_DIR, "claude-browser");
export const DEFAULT_PORT = 9333;
const SIGNIN_TIMEOUT_MS = 10 * 60_000;

export interface ClaudeBrowserState { connected: boolean; port: number; email: string | null; pid?: number; connectedAt?: string; hiddenWindows?: string[] }
export const readClaudeBrowser = (file = CLAUDE_BROWSER_FILE): ClaudeBrowserState =>
  ({ connected: false, port: DEFAULT_PORT, email: null, ...readJson(file, {}) });

export function createClaudeConnector(opts: { file?: string; profileDir?: string; exe?: string | null } = {}) {
  const file = opts.file ?? CLAUDE_BROWSER_FILE, profileDir = opts.profileDir ?? CLAUDE_PROFILE_DIR;
  const exe = opts.exe !== undefined ? opts.exe : findBrowser();
  let signingIn = false, lastError: string | null = null, keepAlive: ReturnType<typeof setInterval> | null = null, hiddenThisRun = false;
  const save = (patch: Partial<ClaudeBrowserState>) => { const next = { ...readClaudeBrowser(file), ...patch }; atomicJson(file, next); return next; };
  /** Minimise, then hide from the taskbar; remember the handles so a sign-in can show the same windows again. */
  const tuckAway = async (port: number) => {
    await setWindowState(port, "minimized").catch(() => {});
    const handles = await hideBrowserWindows(readClaudeBrowser(file).pid);
    if (handles.length) save({ hiddenWindows: [...new Set([...(readClaudeBrowser(file).hiddenWindows ?? []), ...handles])] });
    hiddenThisRun = true;
  };

  /** Starts the browser on the claude.ai tab unless it is already answering on the port. */
  async function ensureBrowser(): Promise<number> {
    const { port } = readClaudeBrowser(file);
    if (await browserAlive(port)) return port;
    if (!exe) throw new Error("Microsoft Edge or Google Chrome is needed for the Claude.ai connector.");
    mkdirSync(profileDir, { recursive: true });
    const child = Bun.spawn([exe, ...launchArgs(profileDir, port, `${CLAUDE_ORIGIN}/`)], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    save({ pid: child.pid });
    for (let i = 0; i < 40; i++) { await Bun.sleep(500); if (await browserAlive(port)) return port; }
    throw new Error("The Claude.ai browser did not start.");
  }

  return {
    status: () => {
      const s = readClaudeBrowser(file);
      return { connected: s.connected, email: s.email, signingIn, lastError, browserFound: !!exe };
    },

    /** Opens the window for sign-in and waits (in the background) until claude.ai reports an organisation. */
    async connect(): Promise<void> {
      if (signingIn) return;
      const port = await ensureBrowser();
      if (await showBrowserWindows(readClaudeBrowser(file).hiddenWindows)) save({ hiddenWindows: [] });
      await setWindowState(port, "normal").catch(() => {});
      signingIn = true; lastError = null;
      void (async () => {
        const api = browserApi(port), deadline = Date.now() + SIGNIN_TIMEOUT_MS;
        try {
          while (Date.now() < deadline) {
            if (await signedIn(api)) {
              save({ connected: true, email: await accountEmail(api), connectedAt: new Date().toISOString() });
              await tuckAway(port);
              return;
            }
            await Bun.sleep(3000);
          }
          lastError = "Sign-in was not finished within 10 minutes. Use Connect Claude.ai again.";
        } catch (e) { lastError = e instanceof Error ? e.message : "Claude.ai sign-in failed."; }
        finally { signingIn = false; }
      })();
    },

    /** Closes the window; `forget` also deletes its profile (signs this browser out of claude.ai). */
    disconnect(forget = false): void {
      const s = readClaudeBrowser(file);
      if (s.pid) killTree(s.pid);
      save({ connected: false, email: null, pid: undefined, hiddenWindows: [] });
      if (forget) setTimeout(() => rmSync(profileDir, { recursive: true, force: true }), 1500);
    },

    /** Keeps the window running (minimised) while connected, e.g. after a reboot or if it was closed. */
    start(): void {
      const tick = async () => {
        if (!readClaudeBrowser(file).connected || signingIn) return;
        try {
          const { port } = readClaudeBrowser(file);
          if (await browserAlive(port)) {
            if (!hiddenThisRun) await tuckAway(port); // windows left visible by an earlier portal version
            return;
          }
          await ensureBrowser();
          save({ hiddenWindows: [] }); // a new browser process: old handles are gone
          await tuckAway(port);
          lastError = null;
        } catch (e) { lastError = e instanceof Error ? e.message : "Could not start the Claude.ai browser."; }
      };
      void tick();
      keepAlive ??= setInterval(() => void tick(), 60_000);
    },
    stop(): void { if (keepAlive) clearInterval(keepAlive); keepAlive = null; },
  };
}
export type ClaudeConnector = ReturnType<typeof createClaudeConnector>;
