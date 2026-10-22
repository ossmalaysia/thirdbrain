// The WhatsApp connection in the portal: runs the linked-device worker (adapters/whatsapp-link.ts) as a supervised
// child process, shows its QR code while linking, and keeps which chats become notes (whatsapp-settings.json; none
// until the owner turns one on). Disconnect removes the linked device and deletes the local store.
import { existsSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import { STATE_DIR } from "./state.ts";
import { atomicJson, readJson } from "../docker/scheduler.mjs";
import { createSupervisor, type Supervisor } from "./remote/supervisor.ts";
import { deleteWhatsAppStore, openWhatsAppStore, WA_DB, type WaChat } from "./adapters/whatsapp-store.ts";
import { parseLinkLine } from "./adapters/whatsapp-link.ts";

export const SETTINGS_FILE = join(STATE_DIR, "whatsapp-settings.json");
/** A QR code that nobody scans stops after this, so the worker does not loop on new codes all day. */
export const LINK_TIMEOUT_MS = 5 * 60_000;
const RETRY_MS = 5 * 60_000;
const JID = /^[0-9a-z.:_-]{1,80}@(s\.whatsapp\.net|g\.us|lid)$/i;

export type WhatsAppPhase = "off" | "linking" | "connecting" | "connected" | "offline" | "loggedOut";

/** The chats whose messages become notes. */
export function readChosen(file = SETTINGS_FILE): string[] {
  const raw = readJson(file, {}) as { chats?: unknown };
  return Array.isArray(raw?.chats) ? raw.chats.filter((j): j is string => typeof j === "string" && JID.test(j)) : [];
}
export function saveChosen(jids: unknown, known: string[], file = SETTINGS_FILE): string[] {
  if (!Array.isArray(jids) || jids.length > 2000) throw new Error("Choose the chats from the list.");
  const allowed = new Set(known), chats = [...new Set(jids.filter((j): j is string => typeof j === "string" && allowed.has(j)))];
  atomicJson(file, { chats, savedAt: new Date().toISOString() });
  return chats;
}

interface Deps {
  /** Tests: a fake process runner that receives the worker's line handler. */
  makeSupervisor?: (onLine: (line: string) => boolean) => Supervisor;
  /** `cli.ts whatsapp-unlink`: removes this device from the phone's Linked devices list. */
  unlink?: () => Promise<boolean>;
  dbFile?: string;
  settingsFile?: string;
  now?: () => number;
}

export function createWhatsAppService(deps: Deps = {}) {
  const dbFile = deps.dbFile ?? WA_DB, settingsFile = deps.settingsFile ?? SETTINGS_FILE, now = deps.now ?? Date.now;
  let phase: WhatsAppPhase = "off", qr: string | null = null, name: string | null = null, history: { progress: number | null; added: number } | null = null;
  let lastError: string | null = null, linkTimer: ReturnType<typeof setTimeout> | null = null, linkingSince = 0;

  /** One worker status line; true = the link is open (the supervisor then counts the process as running). */
  const onLine = (line: string): boolean => {
    const l = parseLinkLine(line);
    if (!l) { if (line.startsWith("error:")) lastError = line.slice(6).trim(); return false; }
    if (l.state === "qr") { qr = l.qr ?? null; phase = "linking"; return false; }
    if (l.state === "open") { phase = "connected"; qr = null; name = l.name ?? name; lastError = null; stopLinkTimer(); return true; }
    if (l.state === "history") { history = { progress: l.progress ?? null, added: (history?.added ?? 0) + (l.added ?? 0) }; return false; }
    if (l.state === "loggedOut") { phase = "loggedOut"; qr = null; queueMicrotask(() => worker.stop()); return false; }
    if (l.state === "closed") { lastError = l.reason ?? null; if (phase === "connected") phase = "offline"; }
    return false;
  };
  const worker = deps.makeSupervisor?.(onLine) ?? createSupervisor({ name: "WhatsApp link", pidFile: join(STATE_DIR, "whatsapp-worker.pid"), onLine });

  const linked = () => {
    if (!existsSync(dbFile)) return false;
    const store = openWhatsAppStore(dbFile);
    try { return store.auth.linked(); } finally { store.close(); }
  };
  const stopLinkTimer = () => { if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; } };
  const launch = () => worker.run({ cmd: [process.execPath, join(import.meta.dir, "cli.ts"), "whatsapp-worker"] });

  // The supervisor gives up after 5 quick failures (e.g. the laptop was offline for a minute); a linked device tries
  // again every 5 minutes, so WhatsApp comes back by itself after a network outage or sleep.
  let watchdog: ReturnType<typeof setInterval> | null = null;
  const retryWhenStopped = () => {
    if (["connecting", "connected", "offline"].includes(phase) && worker.status().state === "error") { phase = "connecting"; launch(); }
  };

  return {
    /** Portal start: reconnect a device that is already linked. */
    start() {
      if (linked()) { phase = "connecting"; launch(); }
      watchdog ??= setInterval(retryWhenStopped, RETRY_MS);
    },
    retryWhenStopped,
    /** Shows a QR code to link this computer (or reconnects, when already linked). */
    connect() {
      if (phase === "connected" || phase === "connecting" || phase === "linking") return;
      phase = linked() ? "connecting" : "linking"; qr = null; history = null; lastError = null; linkingSince = now();
      launch();
      stopLinkTimer();
      linkTimer = setTimeout(() => { if (phase === "linking") { worker.stop(); phase = "off"; qr = null; lastError = "The QR code was not scanned in 5 minutes."; } }, LINK_TIMEOUT_MS);
    },
    cancelLink() { if (phase === "linking") { stopLinkTimer(); worker.stop(); phase = "off"; qr = null; } },
    async disconnect(): Promise<{ unlinked: boolean }> {
      stopLinkTimer(); worker.stop();
      const unlinked = linked() && deps.unlink ? await deps.unlink().catch(() => false) : false;
      deleteWhatsAppStore(dbFile);
      atomicJson(settingsFile, { chats: [], savedAt: new Date().toISOString() });
      phase = "off"; qr = null; name = null; history = null; lastError = null;
      return { unlinked };
    },
    /** The QR code as SVG (laptop only: whoever scans it reads every chat). */
    async qrSvg(): Promise<string | null> { return qr ? QRCode.toString(qr, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : null; },
    chats(): (WaChat & { on: boolean })[] {
      if (!existsSync(dbFile)) return [];
      const store = openWhatsAppStore(dbFile), chosen = new Set(readChosen(settingsFile));
      try { return store.chats().map(c => ({ ...c, on: chosen.has(c.jid) })); } finally { store.close(); }
    },
    setChats(jids: unknown) { return saveChosen(jids, this.chats().map(c => c.jid), settingsFile); },
    status() {
      const proc = worker.status();
      const added = phase !== "off" || linked();
      return { added, phase: phase === "connecting" && proc.state === "error" ? "offline" as const : phase, name, history, chatsOn: readChosen(settingsFile).length,
        linkingFor: phase === "linking" ? Math.round((now() - linkingSince) / 1000) : null, hasQr: !!qr, lastError: lastError ?? proc.lastError };
    },
    stop() { stopLinkTimer(); if (watchdog) clearInterval(watchdog); watchdog = null; worker.stop(); },
  };
}
export type WhatsAppService = ReturnType<typeof createWhatsAppService>;
