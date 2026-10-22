import { describe, expect, test } from "bun:test";
const { isPortalUrl, externalAllowed, readPortalToken, syncRequest, statusLine, failedRunToNotify, loginToNotify, availableUpdate, updateMenuLabel, updateToNotify, settingsUrl } = require("./rules.js");

const PORTAL = "http://127.0.0.1:58432";

describe("isPortalUrl", () => {
  test("portal pages stay in the window", () => {
    expect(isPortalUrl(PORTAL + "/", PORTAL)).toBe(true);
    expect(isPortalUrl(PORTAL + "/#entities", PORTAL)).toBe(true);
    expect(isPortalUrl(PORTAL + "/api/status", PORTAL)).toBe(true);
  });
  test("other origins, ports and schemes leave the window", () => {
    expect(isPortalUrl("http://localhost:58432/", PORTAL)).toBe(false);
    expect(isPortalUrl("http://127.0.0.1:3131/admin", PORTAL)).toBe(false);
    expect(isPortalUrl("https://127.0.0.1:58432/", PORTAL)).toBe(false);
    expect(isPortalUrl("https://claude.ai/", PORTAL)).toBe(false);
    expect(isPortalUrl("obsidian://open?vault=brain", PORTAL)).toBe(false);
    expect(isPortalUrl("not a url", PORTAL)).toBe(false);
  });
  test("GBrain paths forwarded by the portal leave the window", () => {
    for (const path of ["/admin", "/admin/login?t=x", "/authorize?client_id=x", "/token", "/mcp", "/.well-known/oauth-authorization-server"]) {
      expect(isPortalUrl(PORTAL + path, PORTAL)).toBe(false);
    }
    expect(isPortalUrl(PORTAL + "/administrator-notes", PORTAL)).toBe(false);
    expect(isPortalUrl(PORTAL + "/tokens-page", PORTAL)).toBe(true);
  });
});

describe("externalAllowed", () => {
  test("http, https and obsidian go to the system", () => {
    expect(externalAllowed("https://claude.ai/new")).toBe(true);
    expect(externalAllowed("https://login.microsoftonline.com/common/oauth2/v2.0/authorize")).toBe(true);
    expect(externalAllowed("https://chatgpt.com/auth/login")).toBe(true);
    expect(externalAllowed("https://github.com/ossmalaysia/thirdbrain")).toBe(true);
    expect(externalAllowed("http://127.0.0.1:3131/admin")).toBe(true);
    expect(externalAllowed("obsidian://open?vault=brain&file=inbox")).toBe(true);
  });
  test("other schemes are dropped", () => {
    for (const url of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-settings:privacy", "smb://host/share", "vbscript:x", "data:text/html,hi", ""]) {
      expect(externalAllowed(url)).toBe(false);
    }
  });
});

describe("readPortalToken", () => {
  const token = "a".repeat(32) + "0123456789abcdef".repeat(2);
  test("reads the 64-hex token from the meta tag", () => {
    expect(readPortalToken(`<head><meta name="portal-token" content="${token}"></head>`)).toBe(token);
    expect(readPortalToken(`<meta content="${token}" name="portal-token">`)).toBe(token);
  });
  test("returns null when missing or malformed", () => {
    expect(readPortalToken("<html></html>")).toBe(null);
    expect(readPortalToken(`<meta name="portal-token" content="short">`)).toBe(null);
    expect(readPortalToken(`<meta name="other" content="${token}">`)).toBe(null);
  });
});

test("syncRequest sends the portal's own headers (dry: nothing is posted)", () => {
  const { url, init } = syncRequest(PORTAL + "/", "f".repeat(64));
  expect(url).toBe(PORTAL + "/api/sync");
  expect(init.method).toBe("POST");
  expect(init.headers).toEqual({ origin: PORTAL, "x-portal-token": "f".repeat(64), "content-type": "application/json" });
  expect(init.body).toBe("{}");
});

describe("statusLine", () => {
  test("portal down", () => expect(statusLine(null)).toBe("Portal not running"));
  test("schedule state", () => expect(statusLine({ schedule: { state: "Ready" }, lastRun: { error: null } })).toBe("Sync: Ready"));
  test("busy wins", () => expect(statusLine({ busy: true, schedule: { state: "Ready" } })).toBe("Sync: Running"));
  test("last run error", () => expect(statusLine({ schedule: { state: "Ready" }, lastRun: { error: "boom" } })).toBe("Sync: Ready (last run failed)"));
  test("missing schedule", () => expect(statusLine({})).toBe("Sync: Unavailable"));
});

describe("failedRunToNotify", () => {
  const failed = { runs: { entries: [{ id: "r2", status: "failed" }, { id: "r1", status: "succeeded" }] } };
  test("new failed run", () => expect(failedRunToNotify(failed, null)).toBe("r2"));
  test("same failed run only once", () => expect(failedRunToNotify(failed, "r2")).toBe(null));
  test("succeeded run", () => expect(failedRunToNotify({ runs: { entries: [{ id: "r3", status: "succeeded" }] } }, null)).toBe(null));
  test("no status", () => expect(failedRunToNotify(null, null)).toBe(null));
  test("a lost sign-in is not a failed-run notice", () => expect(failedRunToNotify({ runs: { entries: [{ id: "r4", status: "failed", error: "NEEDS_LOGIN" }] } }, null)).toBe(null));
});

describe("loginToNotify", () => {
  const lost = { lostAt: "2026-10-22T01:15:00Z", code: "AADSTS50173", reason: "Password changed." };
  test("new lost sign-in", () => expect(loginToNotify({ microsoftLogin: lost }, null)).toEqual(lost));
  test("same lost sign-in only once", () => expect(loginToNotify({ microsoftLogin: lost }, lost.lostAt)).toBe(null));
  test("signed in", () => expect(loginToNotify({ microsoftLogin: null }, null)).toBe(null));
  test("no status", () => expect(loginToNotify(null, null)).toBe(null));
});

describe("updates", () => {
  const avail = { updates: { available: true, latest: { version: "0.2.0" } } };
  test("an available update gives a tray item and one notice per version", () => {
    expect(availableUpdate(avail)).toBe("0.2.0");
    expect(updateMenuLabel(avail)).toBe("Update available: 0.2.0");
    expect(updateToNotify(avail, null)).toBe("0.2.0");
    expect(updateToNotify(avail, "0.2.0")).toBeNull();
    expect(updateToNotify({ updates: { available: true, latest: { version: "0.3.0" } } }, "0.2.0")).toBe("0.3.0");
  });
  test("no update, an old portal, or a strange version string: nothing", () => {
    for (const s of [null, {}, { updates: null }, { updates: { available: false, latest: { version: "0.2.0" } } },
      { updates: { available: true, latest: { version: "<img src=x>" } } }, { updates: { available: true } }]) {
      expect(updateMenuLabel(s)).toBeNull();
      expect(updateToNotify(s, null)).toBeNull();
    }
  });
  test("Settings opens on the portal itself", () => {
    expect(settingsUrl(PORTAL)).toBe(PORTAL + "/#settings");
    expect(isPortalUrl(settingsUrl(PORTAL), PORTAL)).toBe(true);
  });
});
