// Demo portal: the real portal UI on invented data, for screenshots, docs and front-end work.
//
//   cd app && bun run demo            (http://localhost:58600/, or DEMO_PORT=<port>)
//
// Everything lives in two new temporary folders (a vault and a state folder). Nothing signs in, nothing calls the
// network, and no real install is read: MAILSYNC_STATE_DIR points at the temporary state folder BEFORE any app module
// loads, so state, keys and settings of a real install are never touched. People, companies and addresses are made
// up (example.com / example.org only). Stop with Ctrl+C; the temporary folders are removed on exit.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Deps = import("../src/portal.ts").PortalDeps;

interface DemoNote {
  dir: string; title: string; ago: number; summary: string; client?: string; project?: string; account?: string;
  decisions?: string[]; commitments?: string[]; people?: string[]; tags?: string[];
}

/** Starts the demo portal in this process on invented data. `port` 0 (or taken) picks a free port. `stop()` stops the
 *  server and removes the temporary vault and state folders. Call it before any app module is imported elsewhere in
 *  the process: MAILSYNC_STATE_DIR must point at the temporary state folder before the app modules load. */
export async function startDemo(opts: { port?: number } = {}): Promise<{ url: string; stop: () => void }> {
  for (const key of ["THIRDBRAIN_STATE_DIR", "THIRDBRAIN_CONFIG", "BRAIN_PATH", "MAILSYNC_CLIENT_ID", "MAILSYNC_TENANT_ID", "RESTIC_REPOSITORY"]) delete process.env[key];
  const STATE = mkdtempSync(join(tmpdir(), "thirdbrain-demo-state-"));
  const VAULT_PARENT = mkdtempSync(join(tmpdir(), "thirdbrain-demo-vault-"));
  const VAULT = join(VAULT_PARENT, "Brain"); // the Obsidian vault name the portal shows
  process.env.MAILSYNC_STATE_DIR = STATE;
  const removeTemp = () => { for (const d of [STATE, VAULT_PARENT]) rmSync(d, { recursive: true, force: true }); };
  try {

    const { createPortal } = await import("../src/portal.ts");
    const { createSessions } = await import("../src/remote/sessions.ts");
    const { createEntityIndex, createMergeApplier } = await import("../src/entities-view.ts");
    const { DREAM_STEPS } = await import("../src/dream.ts");
    const { pairKey } = await import("../src/entities-judge.ts");

    // ── Time helpers: everything is relative to now, so the demo always looks fresh ──
    const NOW = Date.now(), MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
    const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
    const day = (daysAgo: number) => iso(daysAgo * DAY).slice(0, 10);
    const write = (rel: string, text: string, root = VAULT) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    // ── Notes: one invented note per item, in each connector's folder ──
    const NOTES: DemoNote[] = [
      // Outlook email
      { dir: "inbox/email/threads", title: "Northwind portal revamp: phase 2 scope agreed", ago: 0, client: "Northwind", project: "Northwind Portal Revamp", tags: ["scope", "proposal"],
        summary: "Northwind accepted the phase 2 scope: single sign-on, the new reporting module and a mobile layout. Go-live moves to the end of January.",
        decisions: ["Phase 2 includes single sign-on and reporting; the chatbot moves to phase 3."], commitments: ["Daniel Tan: send the revised timeline to Northwind by Friday. Status: open", "Aisyah Rahman: book the design review. Status: done"],
        people: ["Daniel Tan (Northwind, IT Manager)", "Aisyah Rahman (Delivery Lead)"] },
      { dir: "inbox/email/threads", title: "Contoso renewal: pricing for 2027", ago: 1, client: "Contoso", project: "Contoso Support Renewal", tags: ["renewal", "pricing"],
        summary: "Contoso asked for a 2-year term in exchange for a 6% lower monthly rate. Finance agreed if payment is quarterly in advance.",
        decisions: ["Offer the 2-year term at the lower rate, paid quarterly in advance."], commitments: ["Mei Ling Tan: send the updated quotation. Status: open"], people: ["Mei Ling Tan (Account Manager)", "Ravi Kumar (Contoso, Procurement)"] },
      { dir: "inbox/email/threads", title: "Fabrikam: security questionnaire returned", ago: 2, client: "Fabrikam", tags: ["security"],
        summary: "The security questionnaire for Fabrikam went back with two open points: data residency and the penetration test date.",
        commitments: ["Ravi Kumar: confirm the penetration test date with the vendor. Status: open"] },
      { dir: "inbox/email/threads", title: "Globex onboarding: kickoff date and attendees", ago: 3, client: "Globex", project: "Globex Data Platform", tags: ["kickoff"],
        summary: "Kickoff with Globex is set for next Tuesday at 10:00. Their data team brings three people; we bring the delivery lead and two engineers." },
      { dir: "inbox/email/threads", title: "Invoice 2026-118 paid by Northwind", ago: 5, client: "Northwind", tags: ["finance"],
        summary: "Northwind paid invoice 2026-118 in full. No open invoices remain for this client." },
      { dir: "inbox/email/threads", title: "Hiring: two backend engineer candidates shortlisted", ago: 6, tags: ["hiring"],
        summary: "Two candidates passed the technical round. Second interviews are planned for next week with the delivery lead." },
      { dir: "inbox/email/threads", title: "Fabrikam Holdings: purchase order received", ago: 8, client: "Fabrikam Holdings", tags: ["finance", "purchase-order"],
        summary: "A purchase order arrived for the first support block of 40 hours. Work can start once the contract is countersigned." },
      { dir: "inbox/email/threads", title: "Contoso: incident report for the weekend outage", ago: 11, client: "Contoso", project: "Contoso Support Renewal", tags: ["incident"],
        summary: "Root cause of the weekend outage was an expired certificate on the reporting server. A renewal reminder now runs every month." },
      { dir: "inbox/email/threads", title: "Northwind: user acceptance test plan", ago: 14, client: "Northwind", project: "Northwind Portal Revamp", tags: ["testing"],
        summary: "The test plan covers 42 cases over two weeks. Northwind supplies five testers from finance and operations." },
      // Gmail
      { dir: "inbox/email/gmail", title: "Conference talk accepted: building a second brain", ago: 2, tags: ["speaking"],
        summary: "The talk proposal for the regional developer conference was accepted. Slides are due three weeks before the event." },
      { dir: "inbox/email/gmail", title: "Domain renewal reminder for the side project", ago: 4, tags: ["admin"],
        summary: "The side project's domain renews next month. Auto-renew is on; the card on file expires before then." },
      { dir: "inbox/email/gmail", title: "Open-source contributor asks about the roadmap", ago: 9, tags: ["open-source"],
        summary: "A contributor offered to build the Slack connector and asked which interfaces are stable." },
      // Teams chats and channels
      { dir: "inbox/teams/chats", title: "Chat with Daniel Tan: SSO test accounts", ago: 0, client: "Northwind", project: "Northwind Portal Revamp", tags: ["sso"],
        summary: "Daniel will create three test accounts in Northwind's directory so the team can test single sign-on before Friday." },
      { dir: "inbox/teams/chats", title: "Delivery team: sprint 14 priorities", ago: 1, project: "Globex Data Platform", tags: ["sprint"],
        summary: "Sprint 14 focuses on the Globex ingestion pipeline and two bug fixes for Contoso. The demo moves to Thursday." },
      { dir: "inbox/teams/chats", title: "Chat with Mei Ling Tan: quotation template", ago: 3, tags: ["sales"],
        summary: "Mei Ling updated the quotation template with the new payment terms and a section for optional support hours." },
      { dir: "inbox/teams/channels", title: "Engineering / Releases: version 4.2 deployed", ago: 1, tags: ["release"],
        summary: "Version 4.2 of the client portal went live without downtime. Rollback plan stays ready until Monday." },
      { dir: "inbox/teams/channels", title: "Engineering / Architecture: queue choice for Globex", ago: 4, project: "Globex Data Platform", tags: ["architecture"],
        summary: "The team chose a managed queue over self-hosting for Globex, to reduce operations work. Cost is within the budget." },
      // Meetings
      { dir: "inbox/meetings", title: "Northwind weekly status", ago: 0, client: "Northwind", project: "Northwind Portal Revamp", tags: ["status"],
        summary: "Phase 1 is on track. Two risks: SSO test accounts and the reporting data feed. Next status meeting moves to Wednesday.",
        decisions: ["Freeze the phase 1 scope from today."], commitments: ["Daniel Tan: provide the reporting data sample. Status: open"] },
      { dir: "inbox/meetings", title: "Globex kickoff", ago: 3, client: "Globex", project: "Globex Data Platform", tags: ["kickoff"],
        summary: "Kickoff covered goals, the data sources and the team. Globex wants a first dashboard within six weeks." },
      { dir: "inbox/meetings", title: "Quarterly planning", ago: 7, tags: ["planning"],
        summary: "Q1 priorities: finish Northwind phase 2, renew Contoso, and hire two engineers. Marketing gets one blog post a month." },
      // Claude.ai
      { dir: "inbox/ai/claude", title: "Draft of the Globex solution outline", ago: 1, account: "alex@example.com", project: "Globex Data Platform", tags: ["proposal"],
        summary: "Produced a two-page solution outline for Globex: ingestion, a small warehouse and three dashboards. Still to do: the cost table." },
      { dir: "inbox/ai/claude", title: "Rewrite of the support policy in plain English", ago: 5, account: "alex@example.com", tags: ["policy"],
        summary: "Rewrote the support policy so each response time and exclusion fits in one sentence. Ready to send to Contoso." },
      { dir: "inbox/ai/claude", title: "Interview questions for backend engineers", ago: 6, account: "alex.work@example.org", tags: ["hiring"],
        summary: "Made a list of twelve interview questions with what a strong answer shows, for the backend role." },
      // ChatGPT
      { dir: "inbox/ai/chatgpt", title: "SQL for the monthly revenue report", ago: 2, project: "Finance reporting", tags: ["sql"],
        summary: "Wrote the SQL that groups paid invoices by client and month. Tested on last quarter's data; numbers match the ledger." },
      { dir: "inbox/ai/chatgpt", title: "Comparison of managed queue services", ago: 4, project: "Globex Data Platform", tags: ["architecture"],
        summary: "Compared three managed queue services on price, limits and ordering guarantees. The cheapest one fits Globex's volume." },
      { dir: "inbox/ai/chatgpt", title: "Blog post outline: local-first knowledge tools", ago: 10, tags: ["writing"],
        summary: "Outline for a blog post on keeping notes local and searchable, with a short demo section." },
    ];
    const NOTE_PATHS: Record<string, string> = {};
    for (const n of NOTES) {
      const d = day(n.ago), sub = n.dir.startsWith("inbox/email/") ? `/${d.slice(0, 7)}` : "";
      const rel = `${n.dir}${sub}/${d}-${slug(n.title).slice(0, 60)}.md`;
      NOTE_PATHS[n.title] = rel.slice(0, -3);
      const fm = ["---", `title: ${JSON.stringify(n.title)}`, `created: ${d}`, `last_message: ${iso(n.ago * DAY + 2 * HOUR)}`, "status: draft",
        `tags: [${(n.tags ?? []).map(t => JSON.stringify(t)).join(", ")}]`,
        ...(n.client ? [`client: ${JSON.stringify(n.client)}`] : []), ...(n.project ? [`project: ${JSON.stringify(n.project)}`] : []),
        ...(n.account ? [`account: ${JSON.stringify(n.account)}`] : []), "---"];
      const body = [`# ${n.title}`, "", "## Summary", n.summary, "",
        ...(n.decisions?.length ? ["## Decisions", ...n.decisions.map(x => `- ${x}`), ""] : []),
        ...(n.commitments?.length ? ["## Commitments", ...n.commitments.map(x => `- ${x}`), ""] : []),
        ...(n.people?.length ? ["## People", ...n.people.map(x => `- ${x}`), ""] : []),
        `- Topics: ${(n.tags ?? []).join(", ")}`, ""];
      write(`${rel}`, `${fm.join("\n")}\n\n${body.join("\n")}`);
    }

    // Older filler notes, so the tabs and counts look like a vault in use (built from invented parts).
    const CLIENTS = ["Northwind", "Contoso", "Fabrikam", "Globex"];
    const SUBJECTS = ["status update", "change request", "invoice question", "meeting notes follow-up", "test results", "deployment plan", "access request",
      "budget review", "support ticket", "design feedback", "contract question", "training session"];
    const FILLER: Record<string, number> = { "inbox/email/threads": 214, "inbox/email/gmail": 63, "inbox/teams/chats": 96, "inbox/teams/channels": 41,
      "inbox/meetings": 58, "inbox/ai/claude": 87, "inbox/ai/chatgpt": 52 };
    for (const [dir, count] of Object.entries(FILLER)) for (let i = 0; i < count; i++) {
      const client = CLIENTS[i % CLIENTS.length], subject = SUBJECTS[(i * 5 + dir.length) % SUBJECTS.length], ago = 15 + Math.floor(i * 170 / count);
      const title = `${client}: ${subject}`, d = day(ago), sub = dir.startsWith("inbox/email/") ? `/${d.slice(0, 7)}` : "";
      write(`${dir}${sub}/${d}-${slug(title)}-${i}.md`, ["---", `title: ${JSON.stringify(title)}`, `created: ${d}`, `last_message: ${iso(ago * DAY)}`,
        `client: ${JSON.stringify(client)}`, "---", "", `# ${title}`, "", "## Summary", `A short invented ${subject} with ${client}, kept as demo data.`, ""].join("\n"));
    }

    // ── Entity pages (people, companies, projects, topics), including a few likely duplicates to review ──
    const titlesFor = (pick: (n: DemoNote) => boolean) => NOTES.filter(pick).map(n => ({ date: day(n.ago), slug: NOTE_PATHS[n.title], title: n.title }));
    function entity(kind: "person" | "company" | "project" | "topic", name: string, refs: { date: string; slug: string; title: string }[], extra: { email?: string; role?: string; org?: string; aliases?: string[]; count?: number } = {}) {
      const dir = { person: "people", company: "companies", project: "projects", topic: "topics" }[kind];
      const fm = ["---", `title: ${JSON.stringify(name)}`, `created: ${refs.map(r => r.date).sort()[0] ?? day(30)}`, "source: third-brain-sync", "status: draft", `last_verified: ${day(0)}`,
        `tags: ["entity", "${kind}"]`, `aliases: [${(extra.aliases ?? []).map(a => JSON.stringify(a)).join(", ")}]`, `type: ${kind}`, "kind: entity", `entity_keys: [${JSON.stringify(slug(name))}]`,
        ...(extra.email ? [`email: ${JSON.stringify(extra.email)}`] : []), ...(extra.role ? [`role: ${JSON.stringify(extra.role)}`] : []), ...(extra.org ? [`org: ${JSON.stringify(extra.org)}`] : []),
        `note_count: ${Math.max(refs.length, extra.count ?? 0)}`, "---"];
      const body = [`# ${name}`, "", "## Notes", ...refs.map(r => `- ${r.date} · [[${r.slug}|${r.title}]]`), ""];
      write(`inbox/entities/${dir}/${slug(name)}.md`, `${fm.join("\n")}\n\n${body.join("\n")}`);
    }
    const has = (word: string) => (n: DemoNote) => `${n.title} ${n.summary} ${n.client ?? ""} ${n.project ?? ""} ${(n.people ?? []).join(" ")}`.includes(word);
    entity("person", "Aisyah Rahman", titlesFor(has("Aisyah")), { email: "aisyah@example.com", role: "Delivery Lead", org: "Example Studio", count: 38 });
    entity("person", "Daniel Tan", titlesFor(has("Daniel")), { email: "daniel.tan@example.org", role: "IT Manager", org: "Northwind", count: 27 });
    entity("person", "Daniel", titlesFor(n => n.title.startsWith("Chat with Daniel")), { count: 2 });
    entity("person", "Mei Ling Tan", titlesFor(has("Mei Ling")), { email: "meiling@example.com", role: "Account Manager", org: "Example Studio", count: 19 });
    entity("person", "Ravi Kumar", titlesFor(has("Ravi")), { email: "ravi.kumar@example.net", role: "Procurement", org: "Contoso", count: 11 });
    entity("person", "Sofia Lim", titlesFor(has("Globex")).slice(0, 2), { email: "sofia@example.net", role: "Data Lead", org: "Globex", count: 6 });
    entity("person", "Hafiz Ismail", titlesFor(has("Fabrikam")), { email: "hafiz@example.org", role: "Operations Director", org: "Fabrikam", count: 5 });
    entity("person", "Priya Nair", titlesFor(has("hiring")).concat(titlesFor(has("engineers"))), { email: "priya@example.com", role: "Engineering Manager", org: "Example Studio", count: 8 });
    entity("company", "Northwind", titlesFor(has("Northwind")), { count: 64 });
    entity("company", "Contoso", titlesFor(has("Contoso")), { count: 41 });
    entity("company", "Fabrikam", titlesFor(n => n.client === "Fabrikam"), { count: 23 });
    entity("company", "Fabrikam Holdings", titlesFor(n => n.client === "Fabrikam Holdings"), { count: 4 });
    entity("company", "Globex", titlesFor(has("Globex")), { count: 17 });
    entity("company", "Globex Asia", titlesFor(has("Globex kickoff")), { count: 2 });
    entity("project", "Northwind Portal Revamp", titlesFor(n => n.project === "Northwind Portal Revamp"), { count: 33 });
    entity("project", "Northwind Portal", titlesFor(n => n.title.includes("weekly status")), { count: 3 });
    entity("project", "Globex Data Platform", titlesFor(n => n.project === "Globex Data Platform"), { count: 21 });
    entity("project", "Contoso Support Renewal", titlesFor(n => n.project === "Contoso Support Renewal"), { count: 9 });
    entity("project", "Finance reporting", titlesFor(n => n.project === "Finance reporting"), { count: 6 });
    for (const [topic, count] of [["architecture", 14], ["hiring", 9], ["kickoff", 7], ["renewal", 6], ["proposal", 12], ["finance", 10]] as const)
      entity("topic", topic[0].toUpperCase() + topic.slice(1), titlesFor(n => (n.tags ?? []).includes(topic)), { count });
    // Decisions already made by the duplicate check (shown under "Decided automatically", each with Undo).
    write("inbox/entities/merges.json", JSON.stringify({
      merges: [
        { kind: "company", from: "contoso-ltd", to: "contoso", name: "Contoso Ltd", keys: ["contoso-ltd"], aliases: [], by: "model", p: 0.94, judge: "decision-model", at: day(1) },
        { kind: "person", from: "meiling-tan", to: "mei-ling-tan", name: "MeiLing Tan", keys: ["meiling-tan"], aliases: [], by: "auto", at: day(2) },
      ],
      distinct: [{ kind: "person", a: "ravi-kumar", b: "ravi-kumaran", at: day(3), by: "model", p: 0.06, judge: "decision-model" }],
    }, null, 2));
    writeFileSync(join(STATE, "entity-judgements.json"), JSON.stringify({
      [pairKey("company", "fabrikam", "fabrikam-holdings")]: { p: 0.62, by: "decision-model", model: "jev", at: day(0) },
      [pairKey("person", "daniel-tan", "daniel")]: { p: 0.55, by: "llm", model: "default", at: day(0) },
    }));
    writeFileSync(join(STATE, "chatgpt-chats.json"), JSON.stringify({ enabled: true }));

    // ── Fake services: the shapes the real ones return, with invented values ──
    const many = (n: number, prefix: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}-${i}`, { fingerprint: "", outcome: "keep", at: day(i % 60) }]));
    const config = { brainPath: VAULT, clientId: "demo-client", tenantId: "common", model: "", maxThreadsPerRun: 25, initialSinceDays: 90,
      provider: "codex", decisionProvider: "typesafe" } as unknown as ReturnType<Deps["config"]>;
    const state = { cursors: {}, threads: many(1284, "thread"), queue: [], processed: many(5210, "msg"), lookbackDays: 90,
      scannedFolders: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`folder-${i}`, day(0)])), folderNames: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`folder-${i}`, `Folder ${i}`])),
      lastSuccessAt: iso(6 * MIN), feedPulledAt: { outlook: iso(6 * MIN), "teams-chats": iso(6 * MIN), "teams-channels": iso(6 * MIN), meetings: iso(21 * MIN), chatgpt: iso(52 * MIN), gmail: iso(6 * MIN), "claude:personal": iso(36 * MIN), "claude:work": iso(36 * MIN) },
      lastRun: { at: iso(8 * MIN), finishedAt: iso(6 * MIN), pulled: 37, kept: 9, written: 6, skipped: 24, blocked: 0, duplicates: 2, triageSkipped: 11, dropped: { "noise:bulk": 14, "noise:calendar": 4 }, error: null, feedErrors: {} },
    } as unknown as ReturnType<Deps["state"]>;
    const sample = (n: number) => NOTES.slice(n, n + 3).map(x => `${NOTE_PATHS[x.title]}.md`);
    const runs = [
      { id: "r1", startedAt: iso(8 * MIN), source: "automatic", status: "succeeded", durationSeconds: 131, pulled: 37, written: 6, queued: 0, notes: sample(0) },
      { id: "r2", startedAt: iso(23 * MIN), source: "automatic", status: "succeeded", durationSeconds: 96, pulled: 22, written: 3, queued: 0, notes: sample(12) },
      { id: "r3", startedAt: iso(38 * MIN), source: "manual", status: "succeeded", durationSeconds: 204, pulled: 51, written: 9, queued: 4, notes: sample(17) },
      { id: "r4", startedAt: iso(53 * MIN), source: "automatic", status: "failed", durationSeconds: 18, pulled: 0, written: 0, queued: 4,
        error: "Microsoft Graph answered 503 (service busy). Nothing was lost; the next run tries again." },
      { id: "r5", startedAt: iso(68 * MIN), source: "automatic", status: "skipped", durationSeconds: 2, pulled: null, written: null, queued: null },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `r${6 + i}`, startedAt: iso((83 + 15 * i) * MIN), source: "automatic", status: "succeeded", durationSeconds: 60 + ((i * 37) % 120), pulled: 10 + ((i * 7) % 30), written: (i * 3) % 7, queued: 0, notes: [] })),
    ];
    const dreamHistory = [0, 1, 2, 3].map(n => ({ at: iso(n * DAY + 7 * HOUR), finishedAt: iso(n * DAY + 7 * HOUR - 19 * MIN), result: n === 2 ? "failed" : "ok",
      detail: n === 2 ? "Failed: GBrain: embeddings for search." : null,
      steps: DREAM_STEPS.map((s, i) => ({ id: s.id, name: s.name, code: n === 2 && s.id === "embed" ? 1 : 0, seconds: [212, 95, 340, 120, 64, 310, 4][i],
        summary: ({ related: `${41 - n * 5} notes got related links`, judge: "6 pairs checked: 2 merged, 1 not the same, 3 wait for you", entities: "184 pages written, committed", orphans: `${12 + n} orphan pages` } as Record<string, string>)[s.id] })) }));
    const usageDays = Array.from({ length: 30 }, (_, i) => { const t = 29 - i, threads = 8 + ((t * 13) % 25); return { day: day(t), threads, inputTokens: threads * 7400 + ((t * 977) % 9000), outputTokens: threads * 410 }; });
    const sum = (k: "threads" | "inputTokens" | "outputTokens") => usageDays.reduce((n, d) => n + d[k], 0);
    const ai = {
      status: async () => ({ provider: "codex", models: { codex: "", openai: "", anthropic: "" }, defaults: { codex: "", openai: "gpt-5", anthropic: "claude-opus-5-5" },
        keys: { openai: null, anthropic: "…Q7x2", typesafe: "…f3K9" },
        chatgpt: { signedIn: true, expired: false, email: "alex@example.com", signingIn: false, loginUrl: null, lastLogin: { ok: true, at: iso(9 * DAY) }, cliSignedIn: true, models: [] },
        decision: { provider: "typesafe", model: "", defaultModel: "jev", lastTest: { ok: true, at: iso(2 * DAY), message: "TypeSafe Jev answered: keep (p = 0.91)." } } }),
      save: () => {}, setKey: () => {}, test: async () => "Codex works (demo).", chatgptLogin: () => ({ url: "", started: false }), chatgptSignOut: () => {},
      saveDecision: () => {}, testDecision: async () => "TypeSafe Jev answered (demo).",
    };
    const claudeAccounts = [
      { id: "personal", label: "Personal", feed: "ai:claude", connected: true, email: "alex@example.com", signingIn: false, lastError: null, browserFound: true },
      { id: "work", label: "Work", feed: "ai:claude:work", connected: true, email: "alex.work@example.org", signingIn: false, lastError: null, browserFound: true },
    ];
    const sessions = createSessions({ file: join(STATE, "portal-sessions.json") });
    const services = {
      config: () => config, state: () => state, connected: () => true, running: () => null,
      app: () => ({ product: { name: "Third Brain" }, owner: { name: "Alex Morgan" }, microsoft: { account: "alex@example.com" } }),
      schedule: async () => ({ state: "Ready", nextRun: new Date(NOW + 9 * MIN).toISOString(), lastRun: iso(8 * MIN), result: 0, backend: "windows", enabled: true }),
      action: async () => {}, configure: () => {}, exchange: async () => {},
      history: () => ({ total: 1873, succeeded: 1841, failed: 19, skipped: 13, entries: runs }),
      backup: async () => ({ state: "Ready", enabled: true, intervalMinutes: 60, lastRun: iso(14 * MIN), nextRun: new Date(NOW + 46 * MIN).toISOString(), lastResult: 0,
        push: true, remotes: 1, uncommitted: 3, unpushed: 0, lastCommitAt: iso(14 * MIN) }),
      backupAction: async () => {},
      ai,
      remote: { gbrainOrigin: "http://127.0.0.1:9", configure: () => {}, adminLoginLink: async () => "https://brain.example.com/admin",
        status: () => ({ mode: "named", hostname: "brain.example.com", tokenSaved: true, cloudflaredInstalled: true,
          tunnel: { state: "running", lastError: null, logTail: ["INF Registered tunnel connection connIndex=0 protocol=quic", "INF Registered tunnel connection connIndex=1 protocol=quic"] },
          url: "https://brain.example.com", mcpUrl: "https://brain.example.com/mcp", localMcpUrl: "http://127.0.0.1:3131/mcp",
          gbrain: { state: "running", lastError: null, logTail: [], publicUrl: "https://brain.example.com" } }) },
      sessions: { ...sessions, count: () => 2 },
      claude: { list: () => claudeAccounts, status: () => claudeAccounts[0], connect: async () => {}, add: async () => ({ id: "x", label: "x" }), disconnect: () => {}, start: () => {} },
      dream: { status: () => ({ enabled: true, hour: 3, running: false, current: null, steps: DREAM_STEPS.map(({ id, name, part }) => ({ id, name, part })), history: dreamHistory }),
        run: async () => true, configure: () => {} },
      entities: { index: createEntityIndex(() => VAULT), applier: createMergeApplier(async () => ({ code: 0, out: "" })) },
      backfill: {
        windows: () => ({ "ai:claude": { days: 182, chosenAt: day(20) }, "ai:claude:work": { days: 30, chosenAt: day(12) }, "ai:chatgpt": { days: 182, chosenAt: day(20) }, gmail: { days: 365, chosenAt: day(9) } }),
        set: () => ({ widened: false, cursorReset: false, previous: 182 }),
        estimate: async () => ({ choices: [[30, 46], [182, 212], [365, 388], [730, 640]].map(([days, chats]) => ({ days, chats, approximate: days > 365, inputTokens: chats * 7400, hours: Math.round(Math.ceil(chats / 25) * 2.5) / 10 })),
          perChat: { in: 7400, out: 410, source: "logs" }, writer: { provider: "codex", extractor: "Codex", model: "default model", billing: "subscription" }, threadsPerRun: 25, counted: true }),
        reset: () => {},
      },
      feedSchedule: { read: () => ({ chatgpt: 60, meetings: 30 }), set: () => {} },
      usage: {
        report: () => ({ totals: { threads: sum("threads"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), spendUsd: 0, apiEquivalentUsd: 41.37 },
          perChat: { in: 7400, out: 410 }, days: usageDays,
          providers: [{ label: "Codex", model: "default model", billing: "subscription", threads: sum("threads"), inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), perChat: { in: 7400, out: 410 }, apiEquivalentUsd: 41.37, spendUsd: 0, assumed: false }],
          sources: [["Outlook email", 0.38], ["Teams chats", 0.17], ["Meetings", 0.12], ["Gmail", 0.11], ["Claude.ai chats", 0.13], ["ChatGPT chats", 0.09]].map(([label, share]) => ({ label,
            threads: Math.round(sum("threads") * (share as number)), inputTokens: Math.round(sum("inputTokens") * (share as number)), outputTokens: Math.round(sum("outputTokens") * (share as number)) })),
          sourcesFrom: day(29), projection: { threads: 18, queuedThreads: 4, chatgptPending: 14, inputTokens: 133_200, hours: 0.5 },
          prices: { codex: { in: 1.25, out: 10 }, openai: { in: 1.25, out: 10 }, anthropic: { in: 5, out: 25 } }, pricesEdited: false }),
        savePrices: () => {},
      },
      gmail: {
        status: () => ({ connected: true, address: "alex@example.org", passwordSaved: true, connectedAt: iso(9 * DAY), countsAsOwner: true,
          scope: { primary: true, sent: true, important: true, updates: false, promotions: false, social: false, forums: false, labels: ["Clients"] }, scopeChosen: true }),
        connect: async () => ({ address: "alex@example.org", identityAdded: false }), disconnect: () => {},
        setScope: () => ({ changed: false }),
        counts: async () => ({ at: iso(3 * MIN), options: { primary: 2140, sent: 860, important: 310, updates: 4120, promotions: 3650, social: 420, forums: 95 },
          labels: [{ name: "Clients", count: 318 }, { name: "Invoices", count: 96 }, { name: "Travel", count: 41 }] }),
        estimate: async () => ({ newThreads: 47, messages: 3310, threads: 1206 }),
      },
      updates: {
        status: () => ({ current: { version: "0.1.1", commit: null }, latest: { version: "0.1.1", name: "0.1.1", publishedAt: iso(2 * DAY) }, available: false, checkedAt: iso(40 * MIN),
          checking: false, error: null, notesUrl: null, notes: "", installerUrl: null, canSelfUpdate: true, reason: null, applying: null, lastUpdate: null }),
        check: async () => {}, apply: async () => ({ done: Promise.resolve({}), version: "0.1.1" }),
      },
    } as unknown as Deps;


    let server: ReturnType<typeof createPortal>;
    const wanted = opts.port ?? 0;
    try { if (!wanted) throw new Error("any port"); server = createPortal(wanted, services); } catch { // taken: any free port (the portal needs the real number, never 0)
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), free = probe.port;
      probe.stop(true);
      server = createPortal(free, services);
    }
    let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; try { server.stop(true); } catch { /* already stopped */ } removeTemp(); };
    return { url: `http://localhost:${server.port}/`, stop };
  } catch (e) { removeTemp(); throw e; }
}

if (import.meta.main) {
  const demo = await startDemo({ port: Number(process.env.DEMO_PORT ?? 58600) });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { demo.stop(); process.exit(0); });
  console.log(`Third Brain demo portal (invented data): ${demo.url}`);
  console.log("Press Ctrl+C to stop. The temporary vault and state folders are removed on exit.");
}
