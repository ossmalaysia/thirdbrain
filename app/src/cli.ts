// mailsync CLI: config [init ...] | login | run [--dry-run] [--limit N] [--all] | status | mute <sender-or-domain> | entities rebuild [--dry-run] | related rebuild [--dry-run]
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { graphGet, deviceLogin, NeedsLoginError } from "./adapters/graph.ts";
import { browserLogin } from "./adapters/browser-login.ts";
import { listFolders, pullFolder } from "./adapters/outlook.ts";
import { chooseExtractor } from "./core/providers.ts";
import { planFolders } from "./folders.ts";
import { FEEDS, isTeamsFeed, pullTeamsFeed, teamsDeps } from "./adapters/teams.ts";
import { enrichThreadAttachments, outlookAttachmentDeps } from "./adapters/outlook-attachments.ts";
import { emailsWithAttachments, planReprocess, reprocessSince } from "./reprocess.ts";
import { AI_FEED, enrichChatThread, pullClaudeChats } from "./adapters/claude-web.ts";
import { browserApi } from "./claude-web/session.ts";
import { readClaudeBrowser } from "./claude-web/connector.ts";
import { listAccounts } from "./claude-web/accounts.ts";
import { CHATGPT_FEED, chatgptApi, enrichChatGptThread, pullChatGptChats } from "./adapters/chatgpt-web.ts";
import { createChatGptAuth } from "./chatgpt-auth.ts";
import { chatgptChatsEnabled } from "./chatgpt-chats.ts";
import { enrichGmailThread, GMAIL_FEED, openGmail, pullGmail } from "./adapters/gmail-imap.ts";
import { loadGmail, ownerEmails, readScope } from "./gmail.ts";
import { commitAndIndex } from "./core/commit.ts";
import { shadowTriage, triageDecision, TYPESAFE_DEFAULT_MODEL } from "./core/decision.ts";
import { buildPrompt } from "./core/extract.ts";
import { loadKeys } from "./keys.ts";
import { feedSince, readWindows, writerOf } from "./backfill.ts";
import { runOnce } from "./pipeline.ts";
import { rebuildEntities } from "./entities-rebuild.ts";
import { rebuildRelated, relatedForRun } from "./related-rebuild.ts";
import { judgeDuplicates } from "./entities-judge.ts";
import { cascadeJudge, llmJudge, typesafeJudge } from "./core/entity-judge.ts";
import { chooseJsonAsk } from "./core/providers.ts";
import { STATE_DIR, acquireLock, loadConfig, loadState, log, saveConfig, saveState, validateConfig } from "./state.ts";
import { dueFeeds, isRateLimit, readSchedule, scheduleKey } from "./feed-schedule.ts";
import { checkMailbox, describeConfig, initConfigFile, loadAppConfig, patchConfigFile } from "./config.ts";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const values = (name: string) => args.flatMap((a, i) => a === name && args[i + 1] !== undefined ? args[i + 1].split(",").map(v => v.trim()).filter(Boolean) : []);

/** `config` prints the resolved configuration (no setting values); `config init` writes config.json. */
function configCommand(): number {
  if (args[0] === "init") {
    const written = initConfigFile({ name: value("--name"), shortName: value("--short-name"), emails: values("--email"), org: value("--org"),
      role: value("--role"), pronouns: value("--pronouns"), vault: value("--vault"), settingsFile: value("--settings-file"),
      account: value("--account"), clientId: value("--client-id"), tenantId: value("--tenant-id"), product: value("--product"), force: flag("--force") });
    console.log(JSON.stringify(written, null, 2));
    return 0;
  }
  if (args[0]) { console.error("usage: mailsync config [init --name N --short-name S --email E [--email E2] --org O --role R --pronouns he|she|they --vault PATH --settings-file PATH --account EMAIL --client-id UUID --tenant-id UUID --product NAME --force]"); return 2; }
  console.log(JSON.stringify(describeConfig(loadAppConfig()), null, 2));
  return 0;
}

async function main(): Promise<number> {
  if (cmd === "config") return configCommand();
  const cfg = loadConfig(), app = loadAppConfig();
  validateConfig(cfg);
  switch (cmd) {
    case "login":
      if (flag("--device-code")) await deviceLogin(cfg);
      else await browserLogin(cfg);
      return 0;

    case "run": {
      const release = acquireLock();
      if (!release) { console.log("Another mailsync run is in progress; exiting."); return 0; }
      const dryRun = flag("--dry-run");
      const state = loadState();
      try {
        if (!cfg.clientId) throw new Error("Set MAILSYNC_CLIENT_ID, then run mailsync login");
        if (!existsSync(join(STATE_DIR, "token.json"))) throw new NeedsLoginError();
        const profile = await graphGet(cfg, "/me?$select=id,displayName,userPrincipalName,mail");
        const mailbox = String(profile.mail ?? profile.userPrincipalName ?? "");
        // A configured account is enforced; without one, the first signed-in mailbox is recorded and enforced from then on.
        if (checkMailbox(mailbox, app.microsoft.account) === "record" && !dryRun) patchConfigFile({ microsoft: { account: mailbox.toLowerCase() } });
        if (value("--days")) cfg.initialSinceDays = Number(value("--days"));
        const limit = Number(value("--limit") ?? cfg.maxThreadsPerRun);
        validateConfig({ ...cfg, maxThreadsPerRun: limit });
        if (flag("--resync") || flag("--backfill")) state.cursors = {};
        const since = new Date(Date.now() - cfg.initialSinceDays * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
        const teamsSince = new Date(Date.now() - (cfg.teamsSinceDays ?? 30) * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
        // Chat feeds: the history window chosen in the portal for that feed, else the .env window (as before).
        const windows = readWindows();
        // Every signed-in Claude.ai account is its own feed (the first keeps `ai:claude` and its watermark).
        // Notes name the account by its login email (anyone reading them knows what it means).
        const claudeAccounts = listAccounts().map(a => ({ ...a, ...readClaudeBrowser(a.file) })).filter(a => a.connected)
          .map(a => ({ ...a, label: a.email ?? a.label }));
        const accountOf = (feedOrId: string) => claudeAccounts.find(a => a.feed === feedOrId || a.id === feedOrId);
        // ChatGPT chats: opt-in, through the portal's ChatGPT sign-in (no browser window needed).
        const chatgptAuth = createChatGptAuth(), chatgpt = chatgptApi(chatgptAuth);
        const chatgptOn = chatgptChatsEnabled() && chatgptAuth.signedIn();
        const chatgptAccount = { id: "chatgpt", label: chatgptAuth.status().email ?? "ChatGPT" };
        const me = { name: String(profile.displayName ?? (app.owner.name || "Me")), email: String(profile.mail ?? profile.userPrincipalName ?? "").toLowerCase() };
        // Gmail (IMAP + app password): optional, its own feed. The connected address counts as the owner (gmail.ts).
        const gmail = loadGmail(), openMail = () => openGmail(gmail!);
        const owner = { ...app.owner, name: app.owner.name || String(profile.displayName ?? ""), emails: ownerEmails([...app.owner.emails, ...(me.email ? [me.email] : [])]) };
        const teams = teamsDeps(cfg, { id: String(profile.id ?? ""), name: String(profile.displayName ?? ""), email: String(profile.mail ?? profile.userPrincipalName ?? "").toLowerCase() });
        const extractCwd = join(STATE_DIR, "extract-cwd");
        mkdirSync(extractCwd, { recursive: true });
        const outRoot = dryRun ? join(STATE_DIR, "dry-run") : cfg.brainPath;
        const rank = (kind: string) => kind === "inbox" ? 0 : kind === "sentitems" ? 1 : 2;
        const allFolders = (await listFolders(cfg)).sort((a, b) => rank(a.kind) - rank(b.kind) || a.id.localeCompare(b.id));
        if (!allFolders.length) throw new Error("No eligible Outlook folders found");
        state.folderNames = Object.fromEntries(allFolders.map(f => [f.id, f.name]));
        const start = state.lookbackDays !== cfg.initialSinceDays ? 0 : state.folderOffset ?? 0;
        const plan = planFolders(allFolders, start, cfg.maxFoldersPerRun ?? 3);
        // A long queue (usually a Claude.ai backfill) pauses only the Claude.ai feed; mail and Teams keep flowing.
        // Far past the limit everything pauses so the queue cannot grow without bound.
        const queued = state.queue.length, maxQueue = cfg.maxQueue ?? 1000, overloaded = queued >= maxQueue * 4;
        // Each connector has its own interval (portal: Sync every); only the feeds that are due take part.
        // A manual Sync now (`run --all`) and a resync/backfill take every feed. Email is decided on its own.
        const feeds = overloaded ? [] : dueFeeds({ email: plan.folders.map(f => f.id), teams: Object.values(FEEDS), mail: gmail ? [GMAIL_FEED] : [],
          chats: queued < maxQueue ? [...claudeAccounts.map(a => a.feed), ...(chatgptOn ? [CHATGPT_FEED] : [])] : [],
          all: flag("--all") || flag("--resync") || flag("--backfill"), pulledAt: state.feedPulledAt, saved: readSchedule() });
        const folders = plan.folders.filter(f => feeds.includes(f.id));
        const { report, notes, nextState } = await runOnce(cfg, state, {
          // Email folders, then Teams chats, channels, meetings and (when connected) Claude.ai and ChatGPT chats.
          // Problems in the optional feeds are reported per feed and never stop email.
          folders: feeds,
          pulledKey: scheduleKey,
          waitAfter: isRateLimit, // a ChatGPT 429 waits a full interval, like a finished pull
          pull: (folder, cursor) => folder === GMAIL_FEED ? pullGmail(openMail, cursor, feedSince(GMAIL_FEED, cfg, windows), { name: owner.name || gmail!.address, email: gmail!.address }, undefined, readScope().scope)
            : folder === CHATGPT_FEED ? pullChatGptChats(chatgpt, cursor, feedSince(CHATGPT_FEED, cfg, windows), me, chatgptAccount)
            : accountOf(folder) ? pullClaudeChats(browserApi(accountOf(folder)!.port), cursor, feedSince(accountOf(folder)!.feed, cfg, windows), me, undefined, { id: accountOf(folder)!.id, label: accountOf(folder)!.label })
            : isTeamsFeed(folder) ? pullTeamsFeed(folder, teams, cursor, teamsSince)
            : pullFolder(cfg, folder, cursor, since, folders.find(f => f.id === folder)!.kind),
          optionalFeed: f => f === GMAIL_FEED || isTeamsFeed(f) || f === AI_FEED || f.startsWith(`${AI_FEED}:`) || f === CHATGPT_FEED,
          extract: chooseExtractor(cfg, extractCwd, undefined, undefined, owner),
          relatedNotes: notes => relatedForRun(notes), // local Ollama; no AI tokens
          // Decision model (Settings > Decision model): active when TypeSafe Jev is chosen and its key is saved.
          ...(cfg.decisionProvider === "typesafe" && loadKeys().typesafe ? {
            triage: async (thread: Parameters<typeof buildPrompt>[0]) => {
              const a = await shadowTriage(loadKeys().typesafe!, buildPrompt(thread), cfg.decisionModel || undefined);
              return { ...a, ...triageDecision(a) };
            },
          } : {}),
          // Queued items from before accounts existed carry no account: they belong to the first one.
          enrich: thread => thread.items[0]?.source === "gmail" ? (gmail ? enrichGmailThread(openMail, thread) : Promise.resolve())
            : thread.items[0]?.source === "chatgpt-chat" ? enrichChatGptThread(chatgpt, thread)
            : thread.items[0]?.source === "ai-chat"
            ? (accountOf(thread.items[0].account?.id ?? "personal") ? enrichChatThread(browserApi(accountOf(thread.items[0].account?.id ?? "personal")!.port), thread) : Promise.resolve())
            : enrichThreadAttachments(thread.items, outlookAttachmentDeps(cfg)),
          commit: n => commitAndIndex(cfg.brainPath, n, undefined, app.vault.indexExclude),
          owner: { name: owner.name, emails: owner.emails, org: app.owner.org },
          checkpoint: saveState,
          log: e => log({ dryRun, ...e }),
          today: new Date().toISOString().slice(0, 10),
        }, { dryRun, limit, outRoot });
        if (!dryRun) {
          const finishedAt = new Date().toISOString();
          saveState({ ...nextState, lastRun: { ...report, finishedAt },
            lastSuccessAt: report.error ? nextState.lastSuccessAt : finishedAt,
            folderOffset: folders.length ? plan.nextOffset : start });
        }
        // Which AI wrote the notes, so the portal's Usage page can attribute tokens per provider and model.
        log({ stage: "run", dryRun, provider: writerOf(cfg).provider, model: writerOf(cfg).model, ...report });
        console.log(JSON.stringify(report, null, 2));
        for (const n of notes) console.log(`  wrote ${join(outRoot, n.relPath)}`);
        return report.error ? 1 : 0;
      } catch (e) {
        const error = e instanceof NeedsLoginError ? "NEEDS_LOGIN" : String(e);
        // Preserve the durable checkpoint if a later stage threw.
        const durable = loadState();
        if (!dryRun) saveState({ ...durable, lastRun: { ...(durable.lastRun ?? { at: "", pulled: 0, kept: 0, dropped: {}, written: 0, skipped: 0, blocked: 0, queued: durable.queue.length, costUsd: 0 }), at: new Date().toISOString(), error } });
        log({ stage: "run", error });
        console.error(e instanceof Error ? e.message : e);
        return 1;
      } finally {
        release();
      }
    }

    case "status": {
      const s = loadState();
      console.log(JSON.stringify({
        stateDir: STATE_DIR,
        extractor: cfg.provider ?? "codex",
        configured: !!cfg.clientId,
        lookbackDays: cfg.initialSinceDays,
        appliedLookbackDays: s.lookbackDays ?? null,
        signedIn: (await Bun.file(join(STATE_DIR, "token.json")).exists()),
        folders: Object.keys(s.cursors),
        threadsOwned: Object.keys(s.threads).length,
        processedMessages: Object.keys(s.processed ?? {}).length,
        indexPending: s.indexPending ?? false,
        scannedFolders: s.scannedFolders ?? {},
        queued: s.queue.length,
        muted: s.muted,
        lastRun: s.lastRun,
      }, null, 2));
      return 0;
    }

    case "configure": {
      const updates: Record<string, string> = {};
      const settings = { "--days": "MAILSYNC_SINCE_DAYS", "--threads": "MAILSYNC_MAX_THREADS", "--client-id": "MAILSYNC_CLIENT_ID", "--tenant-id": "MAILSYNC_TENANT_ID", "--model": "MAILSYNC_MODEL" };
      for (const [arg, key] of Object.entries(settings)) {
        const v = value(arg);
        if (v !== undefined) {
          if (/[\r\n]/.test(v)) throw new Error("Configuration values cannot contain newlines");
          updates[key] = v;
        }
      }
      saveConfig(updates);
      console.log(`Configured: ${Object.keys(updates).join(", ")}`);
      return 0;
    }

    case "mute": {
      const who = args[0]?.toLowerCase();
      if (!who) { console.error("usage: mailsync mute <address-or-domain>"); return 2; }
      const release = acquireLock();
      if (!release) throw new Error("A sync is running; retry mute when it finishes");
      try {
        const s = loadState();
        if (!s.muted.includes(who)) s.muted.push(who);
        saveState(s);
      } finally { release(); }
      console.log(`Muted ${who}`);
      return 0;
    }

    case "related": {
      // mailsync related rebuild [--dry-run]: link every connector note to its closest notes (local Ollama).
      if (args[0] !== "rebuild") { console.error("usage: mailsync related rebuild [--dry-run]"); return 2; }
      const release = acquireLock();
      if (!release) throw new Error("A sync is running; retry when it finishes");
      try {
        const report = await rebuildRelated(cfg.brainPath, { dryRun: flag("--dry-run") });
        log({ stage: "related-rebuild", ...report });
        console.log(JSON.stringify(report, null, 2));
      } finally { release(); }
      return 0;
    }

    case "entities": {
      if (args[0] === "judge") {
        // mailsync entities judge [--dry-run]: the decision model (or the note writer LLM) decides clear duplicates.
        // The decision model first when it is set up; the note writer LLM decides what it is not sure about.
        const key = loadKeys().typesafe, ask = chooseJsonAsk(cfg);
        const jev = cfg.decisionProvider === "typesafe" && key ? typesafeJudge(key, cfg.decisionModel || TYPESAFE_DEFAULT_MODEL) : null;
        const llm = ask ? llmJudge(ask) : null;
        const judge = jev && llm ? cascadeJudge(jev, llm) : jev ?? llm;
        if (!judge) { console.log(JSON.stringify({ pairs: 0, asked: 0, cached: 0, merged: 0, distinct: 0, review: 0, failed: 0, judge: null })); return 0; } // nothing set up: all pairs stay for review
        const report = await judgeDuplicates(cfg.brainPath, judge, { dryRun: flag("--dry-run") });
        log({ stage: "entities-judge", ...report });
        console.log(JSON.stringify(report, null, 2));
        return report.failed && !report.asked && !report.cached ? 1 : 0;
      }
      // mailsync entities rebuild [--dry-run]: backfill entity pages and links for every connector note in the vault.
      if (args[0] !== "rebuild") { console.error("usage: mailsync entities rebuild|judge [--dry-run]"); return 2; }
      const release = acquireLock();
      if (!release) throw new Error("A sync is running; retry when it finishes");
      try {
        const dryRun = flag("--dry-run");
        const { report, notes, pages } = rebuildEntities(cfg.brainPath, { name: app.owner.name, emails: ownerEmails(app.owner.emails), org: app.owner.org },
          new Date().toISOString().slice(0, 10), { dryRun });
        log({ stage: "entities-rebuild", ...report });
        if (!dryRun && (notes.length || pages.length || report.pagesMerged)) {
          const result = commitAndIndex(cfg.brainPath, notes, undefined, app.vault.indexExclude);
          console.log(JSON.stringify({ ...report, commit: result }, null, 2));
          return result.committed ? 0 : 1;
        }
        console.log(JSON.stringify(report, null, 2));
      } finally { release(); }
      return 0;
    }

    case "reprocess": {
      // mailsync reprocess [--attachments] [--chats]: queue old emails with attachments again and/or
      // re-read Teams chats. Notes are rebuilt by the following sync runs.
      const release = acquireLock();
      if (!release) throw new Error("A sync is running; retry reprocess when it finishes");
      try {
        const state = loadState();
        const emails = flag("--attachments") ? await emailsWithAttachments((url, h) => graphGet(cfg, url, h), reprocessSince(cfg)) : [];
        const plan = planReprocess(state, { emails, chats: flag("--chats") });
        saveState(plan.state);
        log({ stage: "reprocess", emails: plan.emails, chatMessages: plan.chatMessages });
        console.log(JSON.stringify({ emailsQueued: plan.emails, chatMessagesReset: plan.chatMessages, queueNow: plan.state.queue.length }));
      } finally { release(); }
      return 0;
    }

    default:
      console.log("usage: mailsync config [init ...] | configure [--days N] [--client-id UUID] [--tenant-id UUID] | login | run [--dry-run] [--limit N] [--days N] [--resync] [--all] | status | mute <sender-or-domain> | entities rebuild [--dry-run] | related rebuild [--dry-run]");
      return cmd ? 2 : 0;
  }
}

try { process.exit(await main()); } catch (e) { console.error(e instanceof Error ? e.message : "mailsync failed"); process.exit(1); }
