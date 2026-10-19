import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { makeAuthorization, validCallback, connectionPage, browserLogin } from "../src/adapters/browser-login.ts";
import type { Config } from "../src/state.ts";
const cfg: Config = { brainPath: "unused", clientId: "client", tenantId: "tenant", model: "", maxThreadsPerRun: 25, initialSinceDays: 10 };

test("browser authorization uses PKCE, correct callback and read-only scopes", () => {
  const a = makeAuthorization(cfg, "http://localhost:58432/");
  const url = new URL(a.url);
  expect(url.origin).toBe("https://login.microsoftonline.com");
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:58432/");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
  const scopes = url.searchParams.get("scope")!.split(" ");
  expect(scopes).toEqual(expect.arrayContaining(["offline_access", "User.Read", "Mail.Read", "Chat.Read", "ChannelMessage.Read.All", "Calendars.Read", "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"]));
  for (const s of scopes) expect(s).toMatch(/^(offline_access|[A-Za-z]+\.Read(Basic)?(\.All)?)$/); // read-only: nothing that sends, writes or deletes
  expect(url.searchParams.has("code_verifier")).toBe(false);
  expect(validCallback(new URL(`http://localhost:58432/?code=fixture&state=${a.state}`), a.state)).toBe(true);
  expect(validCallback(new URL("http://localhost:58432/?code=fixture&state=wrong"), a.state)).toBe(false);
  expect(validCallback(new URL(`http://localhost:58432/?state=${a.state}`), a.state)).toBe(false);
});

test("connection errors are escaped and completed page does not offer another connection", () => {
  expect(connectionPage("nonce", "<script>bad</script>")).toContain("&lt;script&gt;");
  expect(connectionPage("nonce", "", true)).toContain("Outlook connected");
  expect(connectionPage("nonce", "", true)).not.toContain('href="/connect');
});

test("local connect server serves the button, rejects forged callbacks, and redirects only to Microsoft", async () => {
  const task = browserLogin(cfg, { port: 58433, timeoutMs: 1000 }).then(() => null, error => error as Error);
  const response = await fetch("http://127.0.0.1:58433/");
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).toContain("Connect Outlook");
  const path = page.match(/href="(\/connect\?nonce=[^"]+)"/)![1];
  const connect = await fetch("http://127.0.0.1:58433" + path, { redirect: "manual" });
  expect(connect.status).toBe(302);
  expect(new URL(connect.headers.get("location")!).origin).toBe("https://login.microsoftonline.com");
  expect((await fetch("http://127.0.0.1:58433/?code=fake&state=forged")).status).toBe(400);
  expect((await fetch("http://127.0.0.1:58433/connect?nonce=forged")).status).toBe(403);
  expect((await fetch("http://127.0.0.1:58433/", { method: "POST" })).status).toBe(403);
  expect((await fetch("http://127.0.0.1:58433/", { headers: { host: "example.test" } })).status).toBe(403);
  expect((await task)?.message).toContain("session expired");
});
