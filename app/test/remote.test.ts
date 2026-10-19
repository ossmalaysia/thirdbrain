import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteAccess, isRegistered, parseQuickTunnelUrl } from "../src/remote/index.ts";
import type { Launch, SupervisorOptions } from "../src/remote/supervisor.ts";

/** Fake supervisors: record launches and let the test feed cloudflared output lines. */
function harness(opts: { cloudflared?: string | null } = {}) {
  const procs: Record<string, { opts: SupervisorOptions; runs: Launch[]; up: boolean }> = {};
  const dir = mkdtempSync(join(tmpdir(), "remote-"));
  const remote = createRemoteAccess({ port: 3131, dir, gbrainExe: "gbrain.exe", cloudflaredExe: opts.cloudflared === undefined ? "cloudflared.exe" : opts.cloudflared,
    makeSupervisor: o => {
      const p = procs[o.name] = { opts: o, runs: [] as Launch[], up: false };
      return { run: (l: Launch) => { p.runs.push(l); p.up = true; }, stop: () => { p.up = false; o.onExit?.(); }, clearOrphan: () => {}, markReady: () => {},
        status: () => ({ state: p.up ? "running" : "stopped", lastError: null, logTail: [] }), running: () => p.up } as never;
    } });
  const line = (l: string) => procs.cloudflared.opts.onLine?.(l);
  const publicUrlOf = (l?: Launch) => { const i = l?.cmd.indexOf("--public-url") ?? -1; return i >= 0 ? l!.cmd[i + 1] : null; };
  return { remote, procs, line, dir, gbrainRuns: () => procs.GBrain.runs, lastGbrainUrl: () => publicUrlOf(procs.GBrain.runs.at(-1)) };
}

test("parses quick tunnel URLs and edge registration", () => {
  expect(parseQuickTunnelUrl("INF |  https://quiet-river-moon.trycloudflare.com  |")).toBe("https://quiet-river-moon.trycloudflare.com");
  expect(parseQuickTunnelUrl("POST https://api.trycloudflare.com/tunnel")).toBeNull();
  expect(isRegistered("INF Registered tunnel connection connIndex=0")).toBe(true);
});

test("local only: GBrain without a public URL and no tunnel", () => {
  const h = harness();
  h.remote.start();
  expect(h.gbrainRuns()).toHaveLength(1); expect(h.lastGbrainUrl()).toBeNull();
  expect(h.procs.cloudflared.runs).toHaveLength(0);
  expect(h.remote.status()).toMatchObject({ mode: "local", url: null, mcpUrl: null, localMcpUrl: "http://127.0.0.1:3131/mcp" });
});

test("quick tunnel: GBrain restarts with each new random address as its OAuth issuer", () => {
  const h = harness();
  h.remote.start();
  h.remote.configure({ mode: "quick" });
  expect(h.procs.cloudflared.runs.at(-1)!.cmd).toEqual(["cloudflared.exe", "tunnel", "--config=", "--no-autoupdate", "--url", "http://127.0.0.1:3131"]);
  expect(h.gbrainRuns()).toHaveLength(1); // still serving locally while the address is unknown
  h.line("https://first-words-here.trycloudflare.com");
  expect(h.lastGbrainUrl()).toBe("https://first-words-here.trycloudflare.com");
  h.line("Registered tunnel connection");
  expect(h.remote.status().mcpUrl).toBe("https://first-words-here.trycloudflare.com/mcp");
  h.line("https://first-words-here.trycloudflare.com"); // same address again: no restart
  expect(h.gbrainRuns()).toHaveLength(2);
  h.line("https://second-other-words.trycloudflare.com"); // tunnel restarted with a new address
  expect(h.lastGbrainUrl()).toBe("https://second-other-words.trycloudflare.com"); expect(h.gbrainRuns()).toHaveLength(3);
});

test("named tunnel: needs hostname + token, passes the token by environment, stores it encrypted", () => {
  const h = harness();
  h.remote.start();
  expect(() => h.remote.configure({ mode: "named", hostname: "brain.example.com" })).toThrow("tunnel token");
  expect(() => h.remote.configure({ mode: "named", hostname: "not a host", token: "x".repeat(80) })).toThrow("hostname");
  const token = "eyJh" + "A".repeat(120);
  h.remote.configure({ mode: "named", hostname: "https://Brain.Example.com/", token });
  const run = h.procs.cloudflared.runs.at(-1)!;
  expect(run.cmd).toEqual(["cloudflared.exe", "tunnel", "--config=", "--no-autoupdate", "run"]);
  expect(run.cmd.join(" ")).not.toContain(token); expect(run.env?.TUNNEL_TOKEN).toBe(token);
  expect(h.lastGbrainUrl()).toBe("https://brain.example.com");
  expect(readFileSync(join(h.dir, "tunnel-token.json"), "utf8")).not.toContain(token);
  expect(h.remote.status()).toMatchObject({ mode: "named", hostname: "brain.example.com", tokenSaved: true, mcpUrl: "https://brain.example.com/mcp" });
  h.remote.configure({ mode: "local" });
  expect(h.procs.cloudflared.up).toBe(false); expect(h.lastGbrainUrl()).toBeNull();
});

test("tunnel modes explain a missing cloudflared instead of failing silently", () => {
  const h = harness({ cloudflared: null });
  h.remote.start();
  expect(() => h.remote.configure({ mode: "quick" })).toThrow("winget install Cloudflare.cloudflared");
});
