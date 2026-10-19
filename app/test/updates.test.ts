import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareSemver, createUpdates, isNewer, latestRelease, NOTES_MAX, originMatches, parseRelease, restartScript, safeAssetUrl,
  selfUpdateCheck, CHECK_EVERY_MS, IDLE_WAIT_MS, type Exec, type ExecResult } from "../src/updates.ts";
import { updatesModel } from "../portal/view.js";

const REPO = "example-org/thirdbrain";
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: "v0.2.0", name: "Third Brain 0.2.0", published_at: "2026-10-20T08:00:00Z",
  html_url: `https://github.com/${REPO}/releases/tag/v0.2.0`, body: "- Faster sync\n- Fixes",
  assets: [{ name: "ThirdBrain-Setup-0.2.0.exe", browser_download_url: `https://github.com/${REPO}/releases/download/v0.2.0/ThirdBrain-Setup-0.2.0.exe` }],
  ...over,
});
const ok = (out = ""): ExecResult => ({ code: 0, out, err: "" });
const fail = (err = "boom", code = 1): ExecResult => ({ code, out: "", err });

/** A fake install: app/package.json at `version`, a .git folder, and a fake exec that answers by command line. */
function install(version = "0.1.0") {
  const repoDir = mkdtempSync(join(tmpdir(), "tb-upd-")), appDir = join(repoDir, "app");
  mkdirSync(appDir); mkdirSync(join(repoDir, ".git"));
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "x", version }));
  return { repoDir, appDir, file: join(repoDir, "updates.json") };
}
type Answers = Record<string, ExecResult | ((argv: string[]) => ExecResult)>;
function fakeExec(repoDir: string, answers: Answers = {}) {
  const log: string[] = [];
  const base: Answers = {
    "git rev-parse --short HEAD": ok("f2eaa83\n"),
    "git rev-parse --show-toplevel": ok(repoDir + "\n"),
    "git remote get-url origin": ok(`https://github.com/${REPO}.git\n`),
    "git rev-parse --abbrev-ref HEAD": ok("main\n"),
    "git status --porcelain": ok(""),
    "gh api": fail("gh: not found", -1),
    "git rev-parse HEAD": ok("aaaaaaaaaaaa1111\n"),
    "git fetch --tags origin": ok(),
    "git rev-parse --verify": ok("bbbbbbbbbbbb2222\n"),
    "git merge-base --is-ancestor": ok(),
    "git merge --ff-only refs/remotes/origin/main": ok(),
    "git diff --name-only": ok("app/src/portal.ts\n"),
    "install": ok(),
  };
  const all = { ...base, ...answers };
  const exec: Exec = async argv => {
    const line = argv[0] === process.execPath ? argv.slice(1).join(" ") : argv.join(" ");
    log.push(line);
    const key = Object.keys(all).filter(k => line.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const a = key ? all[key]! : ok();
    return typeof a === "function" ? a(argv) : a;
  };
  return { exec, log };
}
const noFetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

test("semver: order, pre-releases, a leading v; invalid versions are not newer", () => {
  expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
  expect(compareSemver("v0.2.0", "0.1.9")).toBe(1);
  expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
  expect(compareSemver("1.0.0", "1.0.0-beta.2")).toBe(1);
  expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
  expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
  expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  expect(compareSemver("1.0.0+build.7", "1.0.0")).toBe(0);
  expect(() => compareSemver("latest", "0.1.0")).toThrow();
  expect(isNewer("0.2.0", "0.1.0")).toBe(true);
  expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("nightly", "0.1.0")).toBe(false);
  expect(isNewer(null, "0.1.0")).toBe(false);
});

test("release parsing: plain fields, GitHub links only, notes cut, the .exe asset", () => {
  const r = parseRelease(release());
  expect(r).toEqual({ version: "0.2.0", tag: "v0.2.0", name: "Third Brain 0.2.0", publishedAt: "2026-10-20T08:00:00.000Z",
    notesUrl: `https://github.com/${REPO}/releases/tag/v0.2.0`, notes: "- Faster sync\n- Fixes",
    installerUrl: `https://github.com/${REPO}/releases/download/v0.2.0/ThirdBrain-Setup-0.2.0.exe` });
  const bad = parseRelease(release({ html_url: "javascript:alert(1)", body: "x".repeat(NOTES_MAX + 500) + "<script>",
    assets: [{ name: "a.exe", browser_download_url: "https://evil.example/a.exe" }, { name: "b.exe", browser_download_url: "http://github.com/b.exe" }] }));
  expect(bad.notesUrl).toBeNull();
  expect(bad.installerUrl).toBeNull();
  expect(bad.notes.length).toBeLessThanOrEqual(NOTES_MAX + 2);
  expect(parseRelease(release({ assets: [{ name: "setup.exe", browser_download_url: "https://objects.githubusercontent.com/x/setup.exe" }] })).installerUrl).toContain("objects.githubusercontent.com");
  expect(safeAssetUrl("https://user:pw@github.com/a.exe")).toBe(false);
  expect(safeAssetUrl("https://github.com.evil.example/a.exe")).toBe(false);
  for (const tag of ["", "latest", "-v1.0.0", "v1.0.0;rm"]) expect(() => parseRelease(release({ tag_name: tag }))).toThrow("version tag");
  expect(parseRelease(release({ name: "" })).name).toBe("v0.2.0");
});

test("latest release: the gh CLI first (private repo), else the public API; 404 and network errors are clear", async () => {
  const { repoDir } = install();
  // gh signed in: its JSON is used and no fetch happens.
  const gh = fakeExec(repoDir, { "gh api": ok(JSON.stringify(release())) });
  expect((await latestRelease(REPO, { exec: gh.exec, fetch: noFetch })).version).toBe("0.2.0");
  expect(gh.log).toContain(`gh api repos/${REPO}/releases/latest`);
  // No gh: the REST API without a token.
  const seen: string[] = [];
  const rest = (async (url: string, init: RequestInit) => { seen.push(url); expect((init.headers as Record<string, string>).authorization).toBeUndefined(); return Response.json(release({ tag_name: "0.3.0" })); }) as unknown as typeof fetch;
  expect((await latestRelease(REPO, { exec: fakeExec(repoDir).exec, fetch: rest })).version).toBe("0.3.0");
  expect(seen).toEqual([`https://api.github.com/repos/${REPO}/releases/latest`]);
  const notFound = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  expect(latestRelease(REPO, { exec: fakeExec(repoDir).exec, fetch: notFound })).rejects.toThrow("gh auth login");
  expect(latestRelease(REPO, { exec: fakeExec(repoDir).exec, fetch: noFetch })).rejects.toThrow("Could not reach GitHub: offline");
  // gh signed in and the repo exists, but nothing is released yet.
  const none = fakeExec(repoDir, { "gh api repos/": fail("gh: Not Found (HTTP 404)"), [`gh api repos/${REPO} --jq`]: ok(REPO) });
  expect(latestRelease(REPO, { exec: none.exec, fetch: noFetch })).rejects.toThrow(`No release has been published for ${REPO} yet.`);
  expect(latestRelease("not a repo; rm", { exec: fakeExec(repoDir).exec, fetch: noFetch })).rejects.toThrow("owner/name");
});

test("cache: 6 hours; a failure keeps the last good answer and records the error; Check now forces", async () => {
  const { repoDir, appDir, file } = install();
  let t = Date.parse("2026-10-20T09:00:00Z"), calls = 0, online = true;
  const get = (async () => { calls++; if (!online) throw new Error("offline"); return Response.json(release()); }) as unknown as typeof fetch;
  const u = createUpdates({ file, repo: () => REPO, exec: fakeExec(repoDir).exec, fetch: get, now: () => t, appDir, repoDir, platform: "win32" });
  await u.check();
  expect(calls).toBe(1);
  expect(u.status()).toMatchObject({ current: { version: "0.1.0", commit: "f2eaa83" }, latest: { version: "0.2.0" }, available: true, error: null, canSelfUpdate: true, reason: null });
  t += 60_000; await u.check(); expect(calls).toBe(1);                    // fresh: no new call
  t += CHECK_EVERY_MS; online = false; await u.check(); expect(calls).toBe(2);
  expect(u.status()).toMatchObject({ latest: { version: "0.2.0" }, available: true, error: "Could not reach GitHub: offline" });
  t += 10 * 60_000; await u.check(); expect(calls).toBe(2);               // waits an hour after an error
  online = true; await u.check(true); expect(calls).toBe(3);              // Check now
  expect(u.status().error).toBeNull();
  // The answer survives a restart (state file).
  const again = createUpdates({ file, repo: () => REPO, exec: fakeExec(repoDir).exec, fetch: noFetch, now: () => t, appDir, repoDir, platform: "win32" });
  expect(again.status().latest?.version).toBe("0.2.0");
});

test("self-update reasons: not a checkout, other remote, wrong branch, local changes, not Windows", async () => {
  const { repoDir } = install();
  const reason = async (answers: Answers, platform = "win32") => (await selfUpdateCheck({ exec: fakeExec(repoDir, answers).exec, repoDir, repo: REPO, platform })).reason;
  expect(await reason({})).toBeNull();
  expect(await reason({ "git rev-parse --show-toplevel": fail("fatal: not a git repository", 128) })).toBe("Not a git checkout: download the new version from the release page.");
  expect(await reason({ "git rev-parse --show-toplevel": ok(join(repoDir, "..") + "\n") })).toContain("Not a git checkout");
  expect(await reason({ "git rev-parse --show-toplevel": fail("not found", -1) })).toContain("Git is not installed");
  expect(await reason({ "git remote get-url origin": ok("https://github.com/someone-else/thirdbrain.git\n") })).toContain(`not github.com/${REPO}`);
  expect(await reason({ "git rev-parse --abbrev-ref HEAD": ok("feature-x\n") })).toBe("This checkout is on branch feature-x: switch to main to update from the portal.");
  expect(await reason({ "git status --porcelain": ok(" M app/src/portal.ts\n") })).toBe("Local changes: commit or stash them first.");
  expect(await reason({}, "linux")).toContain("Windows");
  for (const url of [`https://github.com/${REPO}`, `https://github.com/${REPO}.git`, `git@github.com:${REPO}.git`, `ssh://git@github.com/${REPO}.git`, `https://github.com/${REPO.toUpperCase()}/`])
    expect([url, originMatches(url, REPO)]).toEqual([url, true]);
  for (const url of [`https://gitlab.com/${REPO}.git`, `https://github.com/${REPO}-fork.git`, `https://github.com.evil.example/${REPO}.git`])
    expect([url, originMatches(url, REPO)]).toEqual([url, false]);
});

function applyHarness(answers: Answers = {}, busy: boolean[] = [false], enabled = true) {
  const { repoDir, appDir, file } = install();
  const { exec, log } = fakeExec(repoDir, { "gh api": ok(JSON.stringify(release())), ...answers });
  let t = Date.parse("2026-10-20T09:00:00Z"), restarts = 0;
  const runner = {
    status: async () => ({ enabled, busy: busy.length > 1 ? busy.shift()! : busy[0]! }),
    enable: async (on: boolean) => { log.push(on ? "sync on" : "sync off"); },
  };
  const u = createUpdates({ file, repo: () => REPO, exec, fetch: noFetch, now: () => t, sleep: async ms => { t += ms; }, appDir, repoDir, platform: "win32", runner,
    restart: () => { restarts++; log.push("restart"); } });
  return { u, log, restarts: () => restarts, appDir };
}
const gitSteps = (log: string[]) => log.filter(l => /^(git (fetch|merge|rev-parse --verify|merge-base)|install|sync|restart)/.test(l));

test("apply: pause, wait for the running sync, fetch, check the tag, fast-forward, bun install, resume, restart", async () => {
  const h = applyHarness({}, [false, true, true, false]);
  await h.u.check(true);
  const { done, version } = await h.u.apply();
  expect(version).toBe("0.2.0");
  const result = await done;
  expect(result).toMatchObject({ from: "0.1.0", error: null, commitBefore: "aaaaaaaaaaaa", commitAfter: "aaaaaaaaaaaa" });
  expect(gitSteps(h.log)).toEqual(["sync off", "git fetch --tags origin", "git rev-parse --verify --quiet refs/tags/v0.2.0^{commit}",
    "git merge-base --is-ancestor bbbbbbbbbbbb2222 refs/remotes/origin/main", "git merge --ff-only refs/remotes/origin/main", "install", "sync on", "restart"]);
  expect(h.log.some(l => /reset|--force|push|checkout|-X|--no-ff/.test(l))).toBe(false); // fast-forward only
  expect(h.restarts()).toBe(1);
  expect(h.u.status().lastUpdate).toMatchObject({ from: "0.1.0", error: null });
});

test("apply: a failed git step stops, resumes the sync, records the error and does not restart", async () => {
  const h = applyHarness({ "git merge --ff-only refs/remotes/origin/main": fail("fatal: Not possible to fast-forward, aborting.", 128) });
  await h.u.check(true);
  const result = await (await h.u.apply()).done;
  expect(result.error).toBe("git merge --ff-only failed: fatal: Not possible to fast-forward, aborting.");
  expect(gitSteps(h.log).slice(-2)).toEqual(["git merge --ff-only refs/remotes/origin/main", "sync on"]);
  expect(h.log).not.toContain("install");
  expect(h.restarts()).toBe(0);
  expect(h.u.status()).toMatchObject({ applying: null, lastUpdate: { error: expect.stringContaining("fast-forward") } });

  const tag = applyHarness({ "git merge-base --is-ancestor": fail("", 1) });
  await tag.u.check(true);
  expect((await (await tag.u.apply()).done).error).toContain("not on origin/main");
  expect(tag.log).not.toContain("git merge --ff-only refs/remotes/origin/main");
  expect(tag.restarts()).toBe(0);
});

test("apply: a sync paused by the user stays paused; a sync busy for 30 minutes gives up; refusals", async () => {
  const paused = applyHarness({}, [false], false);
  await paused.u.check(true);
  await (await paused.u.apply()).done;
  expect(paused.log.filter(l => l.startsWith("sync"))).toEqual([]);

  const stuck = applyHarness({}, [true]);
  await stuck.u.check(true);
  const r = await (await stuck.u.apply()).done;
  expect(r.error).toContain("30 minutes");
  expect(IDLE_WAIT_MS).toBe(30 * 60_000);
  expect(stuck.log).not.toContain("git fetch --tags origin");
  expect(stuck.log.filter(l => l.startsWith("sync"))).toEqual(["sync off", "sync on"]);

  const dirty = applyHarness({ "git status --porcelain": ok("?? new-file.txt\n") });
  await dirty.u.check(true);
  expect(dirty.u.status()).toMatchObject({ available: true, canSelfUpdate: false, reason: "Local changes: commit or stash them first." });
  expect(dirty.u.apply()).rejects.toThrow("Local changes");

  const current = applyHarness({ "gh api": ok(JSON.stringify(release({ tag_name: "v0.1.0" }))) });
  await current.u.check(true);
  expect(current.u.status().available).toBe(false);
  expect(current.u.apply()).rejects.toThrow("No newer release");
});

test("restart helper: only a whole process id goes into the script; it ends the tree and starts the task", () => {
  const s = restartScript(4242);
  expect(s).toContain("taskkill.exe /PID 4242 /T /F");
  expect(s).toContain("Start-ScheduledTask -TaskName BrainPortal");
  expect(s.indexOf("Start-Sleep -Seconds 5")).toBe(0);
  for (const bad of [0, -1, 1.5, NaN]) expect(() => restartScript(bad)).toThrow();
});

test("Updates card: up to date, available, cannot self-update, updating, updated, failed check", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const base = { current: { version: "0.1.0", commit: "f2eaa83" }, latest: { version: "0.1.0", name: "0.1.0", publishedAt: "2026-10-19T08:00:00Z" },
    available: false, checkedAt: "2026-10-20T11:00:00Z", checking: false, error: null, notesUrl: null, notes: "", installerUrl: null,
    canSelfUpdate: false, reason: null, applying: null, lastUpdate: null };
  const up = updatesModel(base, false, now);
  expect(up.fields.updateCurrent).toBe("Third Brain 0.1.0 (f2eaa83)");
  expect(up.fields.updateState).toEqual({ text: "Up to date", tone: "ok" });
  expect(up.fields.updateLatest).toEndWith("· Up to date");
  expect(up.fields.updateBadge).toBe("");
  expect(up.updates.available).toBe(false);

  const avail = { ...base, available: true, canSelfUpdate: true, latest: { version: "0.2.0", name: "0.2.0", publishedAt: null },
    notesUrl: "https://github.com/example-org/thirdbrain/releases/tag/v0.2.0", notes: "<b>bold</b>", installerUrl: "https://github.com/example-org/thirdbrain/releases/download/v0.2.0/a.exe" };
  const a = updatesModel(avail, false, now);
  expect(a.fields.updateState).toEqual({ text: "0.2.0 is available", tone: "active" });
  expect(a.fields.updateBadge).toEqual({ text: "New", tone: "active" });
  expect(a.controls.updateApply).toEqual({ label: "Update now", disabled: false });
  expect(a.updates).toMatchObject({ available: true, version: "0.2.0", notes: "<b>bold</b>", notesUrl: avail.notesUrl, installerUrl: avail.installerUrl });
  expect(updatesModel(avail, true, now).controls.updateApply.disabled).toBe(true); // a request is pending

  const blocked = updatesModel({ ...avail, canSelfUpdate: false, reason: "Not a git checkout: download the new version from the release page.", notesUrl: "javascript:alert(1)", installerUrl: "https://evil.example/a.exe" }, false, now);
  expect(blocked.controls.updateApply.disabled).toBe(true);
  expect(blocked.fields.updateDetail).toContain("Not a git checkout");
  expect(blocked.updates.notesUrl).toBeNull();
  expect(blocked.updates.installerUrl).toBeNull();

  const busy = updatesModel({ ...avail, applying: { step: "Waiting for the current sync run to finish", startedAt: "2026-10-20T11:59:00Z" } }, false, now);
  expect(busy.fields.updateState).toEqual({ text: "Updating: Waiting for the current sync run to finish", tone: "active" });
  expect(busy.controls.updateCheck.disabled).toBe(true);

  const done = updatesModel({ ...base, current: { version: "0.1.1", commit: "abc1234" }, latest: { version: "0.1.1", name: "", publishedAt: null },
    lastUpdate: { at: "2026-10-20T11:30:00Z", from: "0.1.0", to: "0.1.1", commitBefore: "a", commitAfter: "b", error: null } }, false, now);
  expect(done.fields.updateState).toEqual({ text: "Updated to 0.1.1", tone: "ok" });
  expect(done.fields.updateDetail).toContain("From 0.1.0");

  const failedUpdate = updatesModel({ ...base, lastUpdate: { at: "2026-10-20T11:30:00Z", from: "0.1.0", to: null, commitBefore: null, commitAfter: null, error: "git fetch failed: offline" } }, false, now);
  expect(failedUpdate.fields.updateDetail).toBe("Last update failed: git fetch failed: offline");

  const never = updatesModel({ ...base, latest: null, checkedAt: null, error: "No release found for example-org/thirdbrain." }, false, now);
  expect(never.fields.updateState).toEqual({ text: "Update check failed", tone: "error" });
  expect(never.fields.updateLatest).toBe("—");
  expect(updatesModel(null, false, now).fields.updateState).toEqual({ text: "Checking" });
});
