import { expect, test } from "bun:test";
import { RUN_COLUMNS, catalogModel, connectorCards, connectorsModel, nextRunAt, syncState, viewModel, when } from "../portal/view.js";

const base = {
  busy: false, needsLogin: false, connected: true, configured: true, indexPending: false, lastRun: null,
  counts: { processed: 168, queued: 46, notes: 36, scannedFolders: 3, totalFolders: 9 },
  settings: { lookbackDays: 30, appliedDays: 30, threadsPerRun: 25, extractor: "Codex", model: "CLI default" },
  schedule: { state: "Ready", enabled: true, backend: "docker", nextRun: null, lastRun: null },
};
const flags = { paused: false, unavailable: false, error: undefined };

test("headline state follows priority: busy, login, scheduler, paused, error, queue", () => {
  expect(syncState({ ...base, busy: true, needsLogin: true }, flags).text).toBe("Syncing now");
  expect(syncState({ ...base, needsLogin: true }, { ...flags, paused: true }).text).toBe("Waiting for connection");
  const lost = syncState({ ...base, needsLogin: true, microsoftLogin: { lostAt: "2026-10-22T01:15:00Z", code: "AADSTS70043", reason: "Policy." } }, flags);
  expect(lost).toMatchObject({ text: "Microsoft sign-in needed", tone: "warn" });
  expect(lost.detail).toStartWith("Policy. Since ");
  expect(syncState(base, { ...flags, unavailable: true, paused: true }).tone).toBe("error");
  expect(syncState(base, { ...flags, paused: true, error: "x" }).text).toBe("Automatic sync paused");
  expect(syncState(base, { ...flags, error: "x" }).text).toBe("Last run needs attention");
  expect(syncState(base, flags).text).toBe("Collecting your history");
  expect(syncState({ ...base, counts: { ...base.counts, queued: 0 } }, flags).text).toBe("Up to date");
});

test("controls disable while busy, paused or waiting on an action", () => {
  expect(viewModel(base).controls.sync.disabled).toBe(false);
  expect(viewModel(base, true).controls.sync.disabled).toBe(true);
  const paused = viewModel({ ...base, schedule: { ...base.schedule, enabled: false } });
  expect(paused.controls.sync.disabled).toBe(true);
  expect(paused.controls.schedule).toMatchObject({ label: "Resume", path: "/api/resume" });
});

test("last run report summarises filtered mail and surfaces errors", () => {
  const run = { at: "2026-10-15T00:00:00Z", finishedAt: null, pulled: 5, kept: 2, duplicates: 1, written: 2, skipped: 0, blocked: 0,
    dropped: { "noise:bulk": 2, "secret:aws": 1 }, error: "Graph timeout" };
  const vm = viewModel({ ...base, lastRun: run });
  expect(vm.fields.filtered).toBe("2 bulk mail, 1 secret detection");
  expect(vm.fields.runError).toBe("Graph timeout");
  expect(vm.fields.runResult).toEqual({ text: "Needs attention", tone: "error" });
  expect(vm.fields.coverage).toBe("3 of 9 folders, 30 days back");
});

test("run table columns map statuses to tones and missing counts to dashes", () => {
  const run = { startedAt: "2026-10-15T00:00:00Z", source: "automatic", status: "interrupted", durationSeconds: 75, pulled: null, written: 3, queued: 0 };
  const cells = RUN_COLUMNS.map(([, value]) => value(run));
  expect(cells.slice(1)).toEqual(["Schedule", "Interrupted", "1m 15s", "—", "3", "0"]);
  expect(RUN_COLUMNS[2][2]!(run)).toBe("warn");
});

test("connector cards: status pill, note count and the one obvious next action", () => {
  const byId = (s: any, counts = {}) => Object.fromEntries(connectorsModel(s, counts).map((c: any) => [c.id, c]));
  const ok = byId({ ...base, claude: { connected: true, email: "me@example.com", browserFound: true } }, { email: 3, "ai-chat": 1 });
  expect(ok.outlook).toMatchObject({ pill: { text: "Connected", tone: "ok" }, stat: ["3", "notes"], primary: null, href: "#/connectors/outlook" });
  expect(ok.claude).toMatchObject({ stat: ["1", "note"], accounts: [{ email: "me@example.com" }] });
  expect(ok.writer.href).toBe("#settings");
  const out = byId({ ...base, needsLogin: true, lastRun: { error: "NEEDS_LOGIN", feedErrors: { "teams:chats": "Missing permission Chat.Read\nmore" } } });
  expect(out.outlook).toMatchObject({ pill: { text: "Needs sign-in" }, primary: "connect", error: "" });
  const lost = { lostAt: "2026-10-22T01:15:00Z", code: "AADSTS50173", reason: "Microsoft ended the sign-in because the password changed or the sessions were signed out." };
  const relogin = byId({ ...base, needsLogin: true, microsoftLogin: lost, lastRun: { error: "NEEDS_LOGIN" } });
  expect(relogin.outlook.error).toStartWith(`${lost.reason} (AADSTS50173, since `);
  expect(relogin["teams-chats"].primary).toBe("connect");
  const perm = byId({ ...base, lastRun: { feedErrors: { "teams:chats": "Missing permission Chat.Read\nmore" } } });
  expect(perm["teams-chats"]).toMatchObject({ pill: { text: "Needs permission" }, primary: "connect", error: "Missing permission Chat.Read" });
  expect(perm.meetings.pill.text).toBe("Connected");
  // Not added yet: no Claude.ai card (it is added from the Add connector page); signed out but known: card with Reconnect.
  expect(byId({ ...base, claude: { connected: false, browserFound: true } }).claude).toBeUndefined();
  expect(byId({ ...base, claude: { connected: false, signingIn: false, email: "me@example.com", lastError: "signed out", browserFound: true } }).claude)
    .toMatchObject({ pill: { text: "Needs sign-in" }, primary: "claudeConnect" });
});

test("add connector catalog: Claude.ai can be added once (more accounts next), Microsoft 365 shows as added, others coming soon", () => {
  const byId = (s: any) => Object.fromEntries(catalogModel(s).map((c: any) => [c.id, c]));
  const fresh = byId({ ...base, claude: { connected: false, browserFound: true } });
  expect(fresh.claude).toMatchObject({ action: "claudeAdd", pill: { text: "Not added" }, href: null });
  expect(fresh.m365).toMatchObject({ action: null, pill: { text: "Added" }, href: "#/connectors/outlook" });
  expect(fresh["claude-code"]).toMatchObject({ soon: true, pill: { text: "Coming soon" } });
  const added = byId({ ...base, claude: { connected: true, email: "me@example.com", browserFound: true } });
  expect(added.claude).toMatchObject({ action: null, pill: { text: "1 account added" }, href: "#/connectors/claude" });
  expect(added.claude.accounts.map((a: any) => [a.label, a.email, a.pill.text])).toEqual([["me@example.com", "me@example.com", "Connected"]]);
  expect(byId({ ...base, needsLogin: true }).m365).toMatchObject({ action: "connect", pill: { text: "Not added" } });
  expect(viewModel({ ...base, claude: { connected: false, browserFound: true } }).controls.claudeAdd).toMatchObject({ label: "Add Claude.ai account", disabled: false });
});

test("several Claude.ai accounts: one card, a row per account, add form once one exists", () => {
  const claude = { connected: true, email: "me@gmail.com", browserFound: true };
  const claudeAccounts = [{ id: "personal", label: "Personal", feed: "ai:claude", ...claude },
    { id: "company", label: "Company", feed: "ai:claude:company", connected: false, signingIn: false, email: "aisyah@company.example", lastError: "Claude.ai signed out.", browserFound: true }];
  const s = { ...base, claude, claudeAccounts, lastRun: { feedErrors: {} } };
  const card = connectorsModel(s).find((c: any) => c.id === "claude");
  expect(card).toMatchObject({ account: "2 accounts", pill: { text: "Needs sign-in" }, primary: "claudeConnect", primaryAccount: "company" });
  expect(card.accounts.map((a: any) => [a.id, a.pill.text])).toEqual([["personal", "Connected"], ["company", "Signed out"]]);
  // Overview: one card per account, each with its own login, status and (when signed out) its own Connect.
  expect(connectorCards(connectorsModel(s)).filter((c: any) => c.id === "claude").map((c: any) => [c.name, c.account, c.pill.text, c.primaryAccount ?? null]))
    .toEqual([["Claude.ai", "me@gmail.com", "Connected", "personal"], ["Claude.ai", "aisyah@company.example", "Signed out", "company"]]);
  const cat = catalogModel(s).find((c: any) => c.id === "claude");
  expect(cat).toMatchObject({ action: null, addForm: true, pill: { text: "2 accounts added" }, href: "#/connectors/claude" });
  // A failing account shows its own error and turns the card red; the healthy one stays connected.
  const failing = connectorsModel({ ...s, claudeAccounts: [claudeAccounts[0], { ...claudeAccounts[1], connected: true, lastError: null }], lastRun: { feedErrors: { "ai:claude:company": "Runtime.evaluate timed out" } } })
    .find((c: any) => c.id === "claude");
  expect(failing.pill.text).toBe("Error");
  expect(failing.accounts.map((a: any) => a.error)).toEqual(["", "Runtime.evaluate timed out"]);
});

test("sync interval: the description and Sync every use each connector's own interval (defaults until one is saved)", () => {
  const byId = (s: any) => Object.fromEntries(connectorsModel(s).map((c: any) => [c.id, c]));
  const chat = { ai: { chatgpt: { signedIn: true, email: "me@example.com" }, keys: {} }, chatgptChats: { enabled: true },
    claudeAccounts: [{ id: "personal", feed: "ai:claude", connected: true, email: "me@example.com" }, { id: "work", feed: "ai:claude:work", connected: true, email: "me@work.example" }] };
  const fresh = byId({ ...base, ...chat });
  expect(fresh.outlook.about).toStartWith("Reads your mailbox read-only every 15 minutes.");
  expect(fresh.chatgpt.about).toStartWith("Every 2 hours, chats you started");
  expect(fresh.claude.about).toStartWith("Every hour, chats you started");
  expect([fresh.meetings.schedule, fresh.chatgpt.schedule]).toMatchObject([{ key: "meetings", minutes: 30, label: "30 minutes" }, { key: "chatgpt", minutes: 120, label: "2 hours" }]);
  expect(fresh.claude.schedule).toBeNull(); // one per account instead
  expect(fresh.claude.accounts.map((a: any) => [a.schedule.key, a.schedule.label])).toEqual([["claude:personal", "1 hour"], ["claude:work", "1 hour"]]);
  expect(fresh.writer.schedule).toBeNull();
  const saved = byId({ ...base, ...chat, feedSchedule: { intervals: { outlook: 30, chatgpt: 1440, "claude:personal": 60, "claude:work": 360 }, lastPulledAt: {} } });
  expect(saved.outlook.about).toContain("read-only every 30 minutes.");
  expect(saved.chatgpt.about).toStartWith("Once a day, chats");
  expect(saved.chatgpt.schedule.label).toBe("Once a day");
  expect(saved.claude.about).toStartWith("On each account's own schedule, chats");
  expect(syncState({ ...base, counts: { ...base.counts, queued: 0 }, feedSchedule: { intervals: { outlook: 60 } } }, flags).detail).toBe("Checks for new email every hour.");
});

test("next run: the connector's own due time (last pull + interval), never before the worker's next tick", () => {
  expect(nextRunAt(null, 120, "2026-10-19T10:15:00.000Z")).toBe("2026-10-19T10:15:00.000Z"); // never pulled: next tick
  expect(nextRunAt("2026-10-19T10:01:00.000Z", 15, "2026-10-19T10:15:00.000Z")).toBe("2026-10-19T10:15:00.000Z");
  expect(nextRunAt("2026-10-19T10:01:00.000Z", 120, "2026-10-19T10:15:00.000Z")).toBe("2026-10-19T12:00:00.000Z");
  expect(nextRunAt("2026-10-19T10:01:00.000Z", 30, "2026-10-19T10:15:00.000Z")).toBe("2026-10-19T10:30:00.000Z");
  expect(nextRunAt("2026-10-19T06:00:00.000Z", 60, "2026-10-19T10:15:00.000Z")).toBe("2026-10-19T10:15:00.000Z"); // overdue
  expect(nextRunAt("2026-10-19T10:01:00.000Z", 60, null)).toBeNull();
  const s = { ...base, schedule: { ...base.schedule, nextRun: "2026-10-19T10:15:00.000Z" },
    feedSchedule: { intervals: { chatgpt: 120, meetings: 30 }, lastPulledAt: { chatgpt: "2026-10-19T10:01:00.000Z" } },
    ai: { chatgpt: { signedIn: true }, keys: {} }, chatgptChats: { enabled: true } };
  const byId = Object.fromEntries(connectorsModel(s).map((c: any) => [c.id, c]));
  const next = (c: any) => c.facts.find(([k]: string[]) => k === "Next run")[1];
  expect(next(byId.chatgpt)).toBe(when("2026-10-19T12:00:00.000Z"));
  expect(next(byId.meetings)).toBe(when("2026-10-19T10:15:00.000Z"));
  expect(next(connectorsModel({ ...s, schedule: { ...s.schedule, enabled: false } }).find((c: any) => c.id === "chatgpt"))).toBe("Paused");
});

test("ChatGPT rate limit (HTTP 429) is a wait with a calm note, not an error; other errors stay errors", () => {
  const chat = { ai: { chatgpt: { signedIn: true, email: "me@example.com" }, keys: {} }, chatgptChats: { enabled: true } };
  const of = (message: string) => connectorsModel({ ...base, ...chat, lastRun: { feedErrors: { "ai:chatgpt": message } } }).find((c: any) => c.id === "chatgpt");
  const limited = of("ChatGPT rate limit (HTTP 429); chat sync continues on the next run.");
  expect(limited).toMatchObject({ pill: { text: "Waiting: ChatGPT rate limit", tone: "warn" }, error: "",
    wait: "ChatGPT allows a few chat reads at a time. The import continues at the next run." });
  expect(connectorCards([limited]).map((c: any) => [c.pill.tone, c.error])).toEqual([["warn", ""]]);
  const broken = of("ChatGPT request failed (HTTP 500)");
  expect(broken).toMatchObject({ pill: { text: "Error", tone: "error" }, error: "ChatGPT request failed (HTTP 500)", wait: "" });
});
