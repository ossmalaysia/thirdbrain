import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortal, identity, type PortalDeps } from "../src/portal.ts";
import { createSessions } from "../src/remote/sessions.ts";
import { connectionPage, makeAuthorization } from "../src/adapters/browser-login.ts";
import { loadAppConfig } from "../src/config.ts";
import { connectorsModel, productName, viewModel } from "../portal/view.js";
import type { Config } from "../src/state.ts";
import { freePort } from "./fixtures.ts";

const cfg: Config = { brainPath: "x", clientId: "client", tenantId: "tenant", model: "", maxThreadsPerRun: 25, initialSinceDays: 10 };
const app = { product: { name: "Contoh Brain" }, owner: { name: "Aisyah Rahman", shortName: "", emails: ["aisyah@example.com"], org: "Contoh Sdn Bhd", role: "founder", pronouns: "she" as const },
  microsoft: { account: "aisyah@example.com", clientId: "client", tenantId: "tenant" } };

function portal(appDep?: PortalDeps["app"]) {
  const sessions = createSessions({ file: join(mkdtempSync(join(tmpdir(), "sess-")), "s.json") });
  const services = { config: () => cfg, state: () => ({ cursors: {}, threads: {}, queue: [], muted: [], lastRun: null }), app: appDep,
    connected: () => true, running: () => null, schedule: async () => ({ state: "Ready", nextRun: null, lastRun: null, result: 0 }),
    configure: () => {}, action: async () => {}, exchange: async () => {}, sessions,
    remote: { gbrainOrigin: "http://127.0.0.1:9", status: () => ({ url: "https://quiet-river-moon.trycloudflare.com" }), configure: () => {} },
  } as unknown as PortalDeps;
  const port = freePort();
  return { server: createPortal(port, services), base: `http://127.0.0.1:${port}` };
}

test("status exposes product name, owner name and Microsoft 365 account, and nothing else about the owner", async () => {
  const p = portal(() => app);
  try {
    const s = await (await fetch(`${p.base}/api/status`)).json();
    expect(s.product).toEqual({ name: "Contoh Brain" });
    expect(s.owner).toEqual({ name: "Aisyah Rahman" });
    expect(s.microsoft).toEqual({ account: "aisyah@example.com" });
    expect(JSON.stringify(s)).not.toContain("Contoh Sdn Bhd");
    expect(JSON.stringify(s)).not.toContain("founder");
  } finally { p.server.stop(true); }
  expect(identity(null)).toEqual({ product: { name: "Third Brain" }, owner: { name: "" }, microsoft: { account: "" } });
});

test("a broken config.json does not take the portal down: defaults are served", async () => {
  const p = portal(() => { throw new Error("config.json is not valid JSON"); });
  try {
    const r = await fetch(`${p.base}/api/status`);
    expect(r.status).toBe(200);
    expect((await r.json()).product).toEqual({ name: "Third Brain" });
  } finally { p.server.stop(true); }
});

test("remote sign-in page carries the configured product name, escaped", async () => {
  const p = portal(() => ({ ...app, product: { name: "Contoh <Brain>" } }));
  try {
    const page = await (await fetch(`${p.base}/`, { headers: { host: "quiet-river-moon.trycloudflare.com" } })).text();
    expect(page).toContain("<title>Sign in · Contoh &lt;Brain&gt;</title>");
    expect(page).not.toContain("<Brain>");
  } finally { p.server.stop(true); }
});

test("portal front end: product name and Microsoft 365 account come from status", () => {
  const base = { schedule: { state: "Ready", nextRun: null }, settings: { lookbackDays: 10, threadsPerRun: 25, appliedDays: 10, provider: "codex", extractor: "Codex", model: "default model" },
    counts: { processed: 0, notes: 0, queued: 0, scannedFolders: 0, totalFolders: null }, lastRun: null, needsLogin: false, busy: false };
  const outlook = (s: object) => connectorsModel(s).find((c: any) => c.id === "outlook");
  expect(outlook({ ...base, microsoft: { account: "aisyah@example.com" } }).ident).toBe("aisyah@example.com");
  expect(outlook(base).ident).toBe("Microsoft 365 account");
  expect(connectorsModel({ ...base, microsoft: { account: "aisyah@example.com" } }).filter((c: any) => ["teams-chats", "teams-channels", "meetings"].includes(c.id)).map((c: any) => c.ident))
    .toEqual(["aisyah@example.com", "aisyah@example.com", "aisyah@example.com"]);
  expect(productName({ product: { name: "Contoh Brain" } })).toBe("Contoh Brain");
  expect(productName(null)).toBe("Third Brain");
  expect(viewModel({ ...base, product: { name: "Contoh Brain" } }).fields.productName).toBe("Contoh Brain");
});

test("Outlook sign-in: login hint only for a configured account; page shows product and account", () => {
  const url = (account?: string) => new URL(makeAuthorization({ ...cfg, account }, "http://localhost:1/").url);
  expect(url("aisyah@example.com").searchParams.get("login_hint")).toBe("aisyah@example.com");
  expect(url().searchParams.has("login_hint")).toBe(false);
  expect(url("").searchParams.has("login_hint")).toBe(false);
  const page = connectionPage("n", "", false, { product: "Contoh Brain", account: "aisyah@example.com" });
  expect(page).toContain("<title>Connect Outlook · Contoh Brain</title>");
  expect(page).toContain("CONTOH BRAIN · OUTLOOK");
  expect(page).toContain("aisyah@example.com<br>Read-only mailbox access");
  expect(connectionPage("n")).toContain("Third Brain");
  expect(connectionPage("n")).toContain("Your Microsoft 365 mailbox<br>");
  expect(loadAppConfig().product.name).toBe("Third Brain"); // the test state dir has no config.json
});
