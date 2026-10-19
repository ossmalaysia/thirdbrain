// Remote access: the portal runs the one GBrain server (127.0.0.1:<port>) and, when remote access is on,
// a Cloudflare tunnel in front of it. Modes:
//   local - GBrain for this laptop only (Claude Code / Codex over HTTP with bearer tokens)
//   quick - Cloudflare quick tunnel: random https://<words>.trycloudflare.com, new on every tunnel start
//   named - Cloudflare named tunnel: your hostname + tunnel token, fixed address
// GBrain's OAuth issuer is its --public-url, fixed at startup, so a new public URL restarts GBrain.
// Tunnel handling adapted from EzyChat Lite (github.com/ossmalaysia/ezychat-lite, MIT).
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { STATE_DIR } from "../state.ts";
import { loadSecret, saveSecret } from "../secret-box.ts";
import { atomicJson, readJson } from "../../docker/scheduler.mjs";
import { createSupervisor, type SupervisorOptions } from "./supervisor.ts";

export type RemoteMode = "local" | "quick" | "named";
export const REMOTE_MODES: RemoteMode[] = ["local", "quick", "named"];
interface RemoteConfig { mode: RemoteMode; hostname: string | null }

const QUICK_URL = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\.trycloudflare\.com\b/i;
/** A quick-tunnel URL from a cloudflared output line (its own api.trycloudflare.com host is not one). */
export function parseQuickTunnelUrl(line: string): string | null {
  const m = QUICK_URL.exec(line);
  return m && m[1].toLowerCase() !== "api" ? `https://${m[1].toLowerCase()}.trycloudflare.com` : null;
}
export const isRegistered = (line: string) => line.includes("Registered tunnel connection");
export const validHostname = (h: string) => /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(h);
export const validTunnelToken = (t: string) => /^[A-Za-z0-9+/=._-]{50,4000}$/.test(t);

export interface RemoteDeps {
  port: number;
  /** Where the tunnel delivers traffic: the portal, which forwards GBrain's paths (one domain for both). Default: GBrain itself. */
  tunnelPort?: number;
  dir?: string;
  gbrainExe?: string;
  cloudflaredExe?: string | null;
  corsOrigins?: string;
  makeSupervisor?: (o: SupervisorOptions) => ReturnType<typeof createSupervisor>;
  fetchImpl?: typeof fetch;
}

export function createRemoteAccess(deps: RemoteDeps) {
  const dir = deps.dir ?? STATE_DIR, make = deps.makeSupervisor ?? createSupervisor, fetchImpl = deps.fetchImpl ?? fetch;
  const configFile = join(dir, "remote.json"), tokenFile = join(dir, "tunnel-token.json");
  const gbrainExe = deps.gbrainExe ?? join(homedir(), ".bun", "bin", "gbrain.exe");
  const cloudflared = deps.cloudflaredExe !== undefined ? deps.cloudflaredExe
    : Bun.which("cloudflared") ?? ["C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe"].find(p => existsSync(p)) ?? null;
  const local = `http://127.0.0.1:${deps.port}`;
  const config = (): RemoteConfig => ({ mode: "local", hostname: null, ...readJson(configFile, {}) });

  let tunnelUrl: string | null = null, registered = false, gbrainPublicUrl: string | null | undefined = undefined;
  const gbrain = make({ name: "GBrain", pidFile: join(dir, "gbrain.pid") });
  const tunnel = make({
    name: "cloudflared", pidFile: join(dir, "cloudflared.pid"),
    onExit: () => { tunnelUrl = null; registered = false; },
    onLine: line => {
      if (isRegistered(line)) registered = true;
      const url = parseQuickTunnelUrl(line);
      if (url && config().mode === "quick") { tunnelUrl = url; ensureGbrain(url); } // new address -> new OAuth issuer
      return config().mode === "quick" ? !!tunnelUrl && registered : registered;
    },
  });

  /** GBrain's admin bootstrap credential: generated once, stored encrypted, passed by environment only.
   *  It lets the portal mint one-time admin login links (needed to approve Claude.ai / ChatGPT connections). */
  const adminFile = join(dir, "gbrain-admin.json");
  const adminToken = () => {
    const saved = loadSecret<{ token: string }>(adminFile)?.token;
    if (saved) return saved;
    const token = randomBytes(32).toString("hex");
    saveSecret(adminFile, { token });
    return token;
  };

  /** (Re)starts GBrain only when its public URL must change; local agents keep working meanwhile. */
  function ensureGbrain(publicUrl: string | null) {
    if (gbrainPublicUrl === publicUrl && gbrain.running()) return;
    gbrainPublicUrl = publicUrl;
    gbrain.run({ cmd: [gbrainExe, "serve", "--http", "--port", String(deps.port), "--surface", "verbs", ...(publicUrl ? ["--public-url", publicUrl] : [])],
      env: { ...process.env, PATH: `${process.env.PATH};${join(homedir(), ".bun", "bin")}`, GBRAIN_HTTP_CORS_ORIGIN: deps.corsOrigins ?? "https://claude.ai,https://chatgpt.com",
        GBRAIN_ADMIN_BOOTSTRAP_TOKEN: adminToken() } });
  }

  function apply() {
    const c = config();
    tunnel.stop(); tunnelUrl = null; registered = false;
    if (c.mode === "local") return ensureGbrain(null);
    if (c.mode === "named") ensureGbrain(c.hostname ? `https://${c.hostname}` : null);
    else if (!gbrain.running()) ensureGbrain(null); // quick: issuer follows once the random URL is known
    if (!cloudflared) return;
    const base = [cloudflared, "tunnel", "--config=", "--no-autoupdate"]; // empty --config ignores ~/.cloudflared/config.yml
    const env: Record<string, string | undefined> = { ...process.env, TUNNEL_TOKEN: undefined };
    if (c.mode === "quick") tunnel.run({ cmd: [...base, "--url", `http://127.0.0.1:${deps.tunnelPort ?? deps.port}`], env });
    else tunnel.run({ cmd: [...base, "run"], env: { ...env, TUNNEL_TOKEN: loadSecret<{ token: string }>(tokenFile)?.token ?? "" } }); // token via env, not the process list
  }

  // GBrain prints no ready line: confirm with /health.
  const checkHealth = async () => {
    if (!gbrain.running() || gbrain.status().state === "running") return;
    try { if ((await fetchImpl(`${local}/health`, { signal: AbortSignal.timeout(3000) })).ok) gbrain.markReady(); } catch { /* still starting */ }
  };
  let health: ReturnType<typeof setInterval> | null = null;

  return {
    gbrainOrigin: local,
    /** A 5-minute, single-use GBrain admin login link on the public address (never fetched here: that would spend it). */
    async adminLoginLink(): Promise<string> {
      const r = await fetchImpl(`${local}/admin/api/issue-magic-link`, { method: "POST", headers: { authorization: `Bearer ${adminToken()}` }, signal: AbortSignal.timeout(10_000) });
      const body = await r.json().catch(() => ({})) as { url?: string };
      if (!r.ok || !body.url) throw new Error("GBrain did not issue a login link. If GBrain was started before this update, restart the portal.");
      return body.url;
    },
    start: () => { gbrain.clearOrphan(); tunnel.clearOrphan(); apply(); health ??= setInterval(checkHealth, 2000); },
    stop: () => { if (health) clearInterval(health); health = null; tunnel.stop(); gbrain.stop(); },
    checkHealth,
    /** Stops GBrain so a maintenance command can open its database alone (src/maintenance.ts). */
    pauseGbrain: () => { gbrain.stop(); },
    /** Starts GBrain again with the same public URL. */
    resumeGbrain: () => { const url = gbrainPublicUrl ?? null; gbrainPublicUrl = undefined; ensureGbrain(url); },
    /** Saves a mode (and for named: hostname, optional new token), then applies it. */
    configure(input: { mode: RemoteMode; hostname?: string | null; token?: string | null }) {
      if (!REMOTE_MODES.includes(input.mode)) throw new Error("Choose Local only, Quick tunnel or Named tunnel.");
      const next: RemoteConfig = { ...config(), mode: input.mode };
      if (input.hostname !== undefined) {
        const host = input.hostname?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
        if (host && !validHostname(host)) throw new Error("Enter a hostname like brain.example.com.");
        next.hostname = host;
      }
      if (input.token) {
        if (!validTunnelToken(input.token.trim())) throw new Error("That doesn't look like a Cloudflare tunnel token. Copy it from the tunnel's install command.");
        saveSecret(tokenFile, { token: input.token.trim() });
      }
      if (next.mode === "named") {
        if (!next.hostname) throw new Error("A named tunnel needs its public hostname.");
        if (!loadSecret(tokenFile)) throw new Error("Paste the tunnel token from Cloudflare.");
        if (!cloudflared) throw new Error("cloudflared is not installed. Install it with: winget install Cloudflare.cloudflared");
      }
      if (next.mode === "quick" && !cloudflared) throw new Error("cloudflared is not installed. Install it with: winget install Cloudflare.cloudflared");
      atomicJson(configFile, next);
      apply();
    },
    status() {
      const c = config(), t = tunnel.status(), g = gbrain.status();
      const url = c.mode === "quick" ? tunnelUrl : c.mode === "named" && c.hostname ? `https://${c.hostname}` : null;
      return {
        mode: c.mode, hostname: c.hostname, tokenSaved: !!loadSecret(tokenFile), cloudflaredInstalled: !!cloudflared,
        tunnel: c.mode === "local" ? { state: "stopped" as const, lastError: null, logTail: [] } : t,
        url, mcpUrl: url ? `${url}/mcp` : null, localMcpUrl: `${local}/mcp`,
        gbrain: { ...g, logTail: g.logTail.slice(-8), publicUrl: gbrainPublicUrl ?? null },
      };
    },
  };
}
export type RemoteAccess = ReturnType<typeof createRemoteAccess>;
