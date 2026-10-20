// Screenshots for docs/feature-screen/: the demo portal (invented data) in a real browser, one PNG per screen.
//
//   cd app && bun run screenshots                    (all images)
//   cd app && bun run screenshots --only notes-dark  (one image; the name with or without .png)
//
// The demo portal starts in this process on a free port (scripts/demo.ts: temporary vault and state folders, invented
// people and example.com addresses; it sets MAILSYNC_STATE_DIR before any app module loads, so a real install is never
// read). The browser is the Microsoft Edge or Google Chrome already installed on this computer (playwright-core
// downloads nothing). Every request that is not for the demo portal is blocked, so nothing goes to the network. The
// temporary folders are removed on exit, also after an error or Ctrl+C.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startDemo } from "./demo.ts";

const OUT = join(import.meta.dir, "..", "..", "docs", "feature-screen");
const LAPTOP = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };

interface Shot {
  name: string;                       // file name without .png
  hash: string;                       // portal route to open first ("#/remote", not "#remote": that would scroll to the form with id "remote")
  light?: boolean;                    // prefers-color-scheme: light (default dark)
  phone?: boolean;                    // 390x844 touch viewport (default 1440x900)
  ready: string;                      // selector that shows the data has rendered
  then?: (page: Page) => Promise<void>; // what a user does next (click a tab, open a dialog, scroll)
}

/** Scrolls the page so the top of `selector`'s element sits `y` pixels below the top of the window. */
const scrollTo = (selector: string, y: number) => async (page: Page) => {
  await page.locator(selector).first().evaluate((node, y) => window.scrollBy(0, node.getBoundingClientRect().top - y), y);
};
const openNote = async (page: Page) => {
  await page.locator("#notes-list .note-title", { hasText: "Northwind portal revamp" }).click();
  await page.locator("#note-dialog[open] #note-body li").first().waitFor();
};
const claudeTab = async (page: Page) => {
  await page.locator("#note-tabs [role=tab]", { hasText: "Claude chats" }).click();
  await page.locator("#notes-list .note-title", { hasText: "Draft of the Globex solution outline" }).waitFor();
};
const entityTab = (label: string, row: string) => async (page: Page) => {
  await page.locator("#entity-tabs [data-kind]", { hasText: label }).click();
  await page.locator("#entity-body tr", { hasText: row }).waitFor();
};
const peopleTab = entityTab("People", "Aisyah Rahman"), companiesTab = entityTab("Companies", "Fabrikam Holdings");
const reviewDuplicates = async (page: Page) => {
  await page.locator('#entity-mode [data-mode="review"]').click();
  await page.locator("#dups-list > *").first().waitFor();
  await page.locator("#dups-summary", { hasNotText: "Checking" }).waitFor();
};
const gmailScope = async (page: Page) => {
  await page.locator("#gmail-scope-estimate", { hasText: "new threads" }).waitFor();
  await scrollTo("#connector-actions", 29)(page);
};
const decisionCard = async (page: Page) => {
  await page.locator('[data-bind="decisionState"]', { hasText: "Connected" }).waitFor();
  await scrollTo(".card:has(#decision-title)", 149)(page);
};

const SHOTS: Shot[] = [
  { name: "connectors-dark", hash: "#/connectors", ready: "#connector-grid li" },
  { name: "connectors-light", hash: "#/connectors", light: true, ready: "#connector-grid li" },
  { name: "connector-gmail-dark", hash: "#/connectors/gmail", ready: "#gmail-scope-options input", then: gmailScope },
  { name: "add-connector-dark", hash: "#/connectors/add", ready: "#catalog li" },
  { name: "notes-dark", hash: "#/notes/email", ready: "#notes-list .note-row:not(.skeleton)" },
  { name: "note-dialog-dark", hash: "#/notes/email", ready: "#notes-list .note-row:not(.skeleton)", then: openNote },
  { name: "notes-light", hash: "#/notes/email", light: true, ready: "#notes-list .note-row:not(.skeleton)", then: claudeTab },
  { name: "sync-runs-dark", hash: "#/runs", ready: "#runs-body tr" },
  { name: "entities-dark", hash: "#/entities", ready: "#entity-body tr", then: peopleTab },
  { name: "entities-light", hash: "#/entities", light: true, ready: "#entity-body tr", then: companiesTab },
  { name: "entities-duplicates-dark", hash: "#/entities", ready: "#entity-body tr", then: reviewDuplicates },
  { name: "dream-dark", hash: "#/dream", ready: "#dream-steps tr" },
  { name: "usage-dark", hash: "#/usage", ready: "#usage-totals > *" },
  { name: "vault-backup-dark", hash: "#/backup", ready: '[data-view="backup"]:not([hidden])' },
  { name: "remote-access-dark", hash: "#/remote", ready: '[data-view="remote"]:not([hidden])' },
  { name: "settings-dark", hash: "#/settings", ready: '[data-view="settings"]:not([hidden])' },
  { name: "settings-decision-dark", hash: "#/settings", ready: '[data-view="settings"]:not([hidden])', then: decisionCard },
  { name: "phone-connectors-dark", hash: "#/connectors", phone: true, ready: "#connector-grid li" },
  { name: "phone-entities-dark", hash: "#/entities", phone: true, ready: "#entity-body tr", then: peopleTab },
];

function pickShots(argv: string[]): Shot[] {
  const at = argv.indexOf("--only");
  if (at < 0) return SHOTS;
  const name = (argv[at + 1] ?? "").replace(/\.png$/i, "");
  const shot = SHOTS.find(s => s.name === name);
  if (!shot) throw new Error(`--only: unknown image "${name}". Known: ${SHOTS.map(s => s.name).join(", ")}`);
  return [shot];
}

async function launch(): Promise<Browser> {
  const errors: string[] = [];
  for (const channel of ["msedge", "chrome"]) {
    try { return await chromium.launch({ channel, headless: true }); }
    catch (e) { errors.push(`${channel}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`); }
  }
  throw new Error(`No installed Microsoft Edge or Google Chrome found (nothing is downloaded).\n${errors.join("\n")}`);
}

async function take(browser: Browser, base: string, shot: Shot): Promise<void> {
  const context: BrowserContext = await browser.newContext({
    viewport: shot.phone ? PHONE : LAPTOP, deviceScaleFactor: 1, isMobile: !!shot.phone, hasTouch: !!shot.phone,
    colorScheme: shot.light ? "light" : "dark", reducedMotion: "reduce", serviceWorkers: "block", locale: "en-US",
  });
  try {
    const origin = new URL(base).origin;
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: shot.light ? "light" : "dark", reducedMotion: "reduce" });
    await page.goto(base + shot.hash);
    await page.locator('[data-bind="live"]', { hasText: "Live" }).waitFor({ state: "attached" }); // status loaded (hidden on a phone)
    await page.locator(shot.ready).first().waitFor();
    if (shot.then) await shot.then(page);
    await page.waitForLoadState("networkidle").catch(() => { /* the portal polls every 5 s; the selectors above already waited */ });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(OUT, `${shot.name}.png`), animations: "disabled", caret: "hide" });
  } finally {
    await context.close();
  }
}

async function main() {
  const shots = pickShots(process.argv.slice(2));
  mkdirSync(OUT, { recursive: true });
  const started = Date.now();
  const demo = await startDemo({ port: 0 });
  let browser: Browser | null = null;
  const stopAll = async () => { await browser?.close().catch(() => {}); browser = null; demo.stop(); };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void stopAll().finally(() => process.exit(130)); });
  try {
    browser = await launch();
    for (const shot of shots) {
      const t = Date.now();
      await take(browser, demo.url, shot);
      console.log(`${shot.name}.png  ${((Date.now() - t) / 1000).toFixed(1)} s`);
    }
    console.log(`${shots.length} image(s) in docs/feature-screen/ (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } finally {
    await stopAll();
  }
}

main().then(() => process.exit(0), e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
