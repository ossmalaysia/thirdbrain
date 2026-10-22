// Pure view model: status JSON in, display strings/tones out. No DOM access, so it is unit-testable.
export const number = n => Number(n ?? 0).toLocaleString();
export const when = v => v ? new Date(v).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not yet';
export const duration = s => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
const orDash = v => v == null ? '—' : number(v);

const DROP_REASONS = { 'noise:sender': 'sender rules', 'noise:bulk': 'bulk mail', 'noise:calendar': 'calendar notices' };
const RUN_TONES = { succeeded: 'ok', running: 'active', skipped: 'neutral', interrupted: 'warn', failed: 'error' };

// Headline state for the connector. Order matters: the first matching condition wins.
export function syncState(s, { paused, unavailable, error }) {
  if (s.busy) return s.schedule.state === 'Queued'
    ? { text: 'Sync queued', detail: 'Waiting for the local worker', tone: 'active' }
    : { text: 'Syncing now', detail: `Started ${when(s.runningSince || s.schedule.lastRun)}. The queue updates as threads finish.`, tone: 'active' };
  if (s.needsLogin && s.microsoftLogin) return { text: 'Microsoft sign-in needed',
    detail: `${s.microsoftLogin.reason} Since ${when(s.microsoftLogin.lostAt)}. Reconnect Outlook to resume.`, tone: 'warn' };
  if (s.needsLogin) return { text: 'Waiting for connection', detail: 'Connect Outlook to start collecting email.', tone: 'warn' };
  if (unavailable) return { text: 'Scheduler unavailable', detail: 'Start Docker Desktop and keep this portal running.', tone: 'error' };
  const every = everyPhrase(intervalFor(s, 'outlook'));
  if (paused) return { text: 'Automatic sync paused', detail: `Resume to collect email ${every}.`, tone: 'warn' };
  if (error) return { text: 'Last run needs attention', detail: 'See the error under Last run.', tone: 'error' };
  if (s.counts.queued) return { text: 'Collecting your history', detail: `${number(s.counts.queued)} messages waiting for ${s.settings?.extractor ?? 'the note writer'} to turn into notes.`, tone: 'ok' };
  return { text: 'Up to date', detail: `Checks for new email ${every}.`, tone: 'ok' };
}

// Per-connector "Sync every" (src/feed-schedule.ts has the rules; these values mirror it for display, and are the
// defaults while an older portal build sends no feedSchedule). The worker itself still ticks every 15 minutes.
export const SYNC_INTERVALS = [[15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1440, 'Once a day']];
const SYNC_DEFAULTS = { outlook: 15, 'teams-chats': 15, 'teams-channels': 15, meetings: 30, chatgpt: 120, gmail: 15, whatsapp: 15 }, CLAUDE_SYNC_DEFAULT = 60;
const TICK_MS = 15 * 60_000, GRACE_MS = 10 * 60_000; // docker/scheduler.mjs INTERVAL_MS; feed-schedule.ts GRACE_MS
export const intervalLabel = m => SYNC_INTERVALS.find(([v]) => v === m)?.[1] ?? `${m} minutes`;
export const everyPhrase = m => m === 1440 ? 'once a day' : m === 60 ? 'every hour' : m % 60 === 0 ? `every ${m / 60} hours` : `every ${m} minutes`;
const capital = t => t.charAt(0).toUpperCase() + t.slice(1);
export const intervalFor = (s, key) => s.feedSchedule?.intervals?.[key] ?? SYNC_DEFAULTS[key] ?? CLAUDE_SYNC_DEFAULT;
/** A connector's next run: the first worker tick at or after its due time (last pull + interval, less the grace that
 *  lets a pull which ended a few minutes after its tick run again at the matching tick). Never before the next tick. */
export function nextRunAt(lastPulledAt, minutes, tick) {
  const t = Date.parse(tick ?? '');
  if (!Number.isFinite(t)) return null;
  const last = Date.parse(lastPulledAt ?? '');
  if (!Number.isFinite(last)) return new Date(t).toISOString();
  const due = last + minutes * 60_000 - GRACE_MS;
  return new Date(due <= t ? t : t + Math.ceil((due - t) / TICK_MS) * TICK_MS).toISOString();
}
/** The ChatGPT feed's HTTP 429 (src/adapters/chatgpt-web.ts): a wait, not a fault. */
export const isRateLimit = message => /rate limit \(HTTP 429\)/i.test(message ?? '');
export const RATE_LIMIT_NOTE = 'ChatGPT allows a few chat reads at a time. The import continues at the next run.';

// Vault backup: the portal's own scheduler runs it (src/backup.ts); git counts come from the vault.
export const BACKUP_INTERVALS = [[15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour'], [180, 'Every 3 hours'], [360, 'Every 6 hours'], [1440, 'Once a day']];
const plural = (n, word) => `${number(n)} ${word}${n === 1 ? '' : 's'}`;
export function backupState(b) {
  if (!b || b.state === 'Unavailable') return { text: 'Backup status unavailable', detail: 'Restart the BrainPortal task; it runs the backup schedule.', tone: 'error' };
  if (b.state === 'Running') return { text: 'Backing up now', detail: 'Committing changes and pushing to GitHub.', tone: 'active' };
  if (!b.enabled) return { text: 'Automatic backup paused', detail: 'Changes stay uncommitted until you resume or back up now.', tone: 'warn' };
  if (b.lastResult) return { text: 'Last backup failed', detail: `Exit code ${b.lastResult}. Run git status and git push in the vault folder to see the git error.`, tone: 'error' };
  if (b.push && b.unpushed) return { text: 'Backed up locally', detail: `${plural(b.unpushed, 'commit')} will be pushed to GitHub on the next backup.`, tone: 'ok' };
  return { text: 'Backed up', detail: b.push ? 'Your vault matches GitHub as of the last backup.' : 'Commits stay on this computer; pushing is off.', tone: 'ok' };
}
function backupModel(b, pending) {
  const state = backupState(b), ready = b && b.state !== 'Unavailable';
  return {
    fields: {
      backupState: { text: state.text, tone: state.tone }, backupDetail: state.detail,
      backupLast: when(b?.lastRun), backupNext: b && !b.enabled ? 'Paused' : when(b?.nextRun),
      backupUncommitted: b?.uncommitted == null ? '—' : plural(b.uncommitted, 'file'),
      backupUnpushed: b?.unpushed == null ? '—' : plural(b.unpushed, 'commit'),
      backupLastCommit: when(b?.lastCommitAt),
      backupRemotes: b ? b.remotes ? `${plural(b.remotes, 'remote')}, private GitHub` : 'No git remote set' : '—',
    },
    controls: {
      backupRun: { label: b?.state === 'Running' ? 'Backing up…' : 'Back up now', disabled: pending || !ready || b.state === 'Running' },
      backupSchedule: { label: b && !b.enabled ? 'Resume' : 'Pause', disabled: pending || !ready, path: b && !b.enabled ? '/api/backup/resume' : '/api/backup/pause' },
      backupSave: { label: 'Save backup settings', disabled: pending || !ready },
    },
    form: { interval: b?.intervalMinutes ?? 60, push: b?.push ?? true },
  };
}

// Settings > note extraction. `ai` is null until the first (slow) Codex sign-in check returns.
const keyState = hint => hint ? { text: `Key saved, ending ${hint.slice(1)}`, tone: 'ok' } : { text: 'No key saved', tone: 'warn' };
function aiModel(ai, pending) {
  const c = ai?.chatgpt, busy = pending || !ai, signedIn = c?.signedIn, signingIn = c?.signingIn;
  return {
    fields: {
      aiCodexState: !c ? { text: 'Checking sign-in' }
        : signingIn ? { text: 'Finishing sign-in in your browser', tone: 'active' }
        : signedIn ? { text: c.email ? `Signed in as ${c.email}` : 'Signed in with ChatGPT', tone: 'ok' }
        : c.expired ? { text: 'Sign-in expired. Sign in again.', tone: 'error' }
        : c.lastLogin?.ok === false ? { text: c.lastLogin.message || 'Sign-in was not completed. Try again.', tone: 'warn' }
        : c.cliSignedIn ? { text: 'Using your Codex CLI sign-in for now', tone: 'ok' }
        : { text: 'Not signed in', tone: 'warn' },
      aiOpenaiKey: keyState(ai?.keys.openai), aiAnthropicKey: keyState(ai?.keys.anthropic),
      decisionKey: keyState(ai?.keys.typesafe),
      decisionState: !ai?.decision ? { text: 'Checking' } : ai.decision.provider === 'off' ? { text: 'Off', tone: 'neutral' }
        : !ai.keys.typesafe ? { text: 'Needs a key', tone: 'warn' } : ai.decision.lastTest?.ok ? { text: 'Connected', tone: 'ok' }
        : ai.decision.lastTest ? { text: 'Test failed', tone: 'error' } : { text: 'Not tested', tone: 'warn' },
      decisionTest: !ai?.decision?.lastTest ? { text: 'Not tested yet.' }
        : { text: `${ai.decision.lastTest.message} (${when(ai.decision.lastTest.at)})`, tone: ai.decision.lastTest.ok ? 'ok' : 'error' },
    },
    controls: {
      aiSave: { label: 'Save extraction settings', disabled: busy }, aiTest: { label: 'Test connection', disabled: busy },
      chatgptLogin: { label: signingIn ? 'Waiting for browser…' : signedIn ? 'Sign in again' : 'Sign in with ChatGPT', disabled: busy || signingIn },
      chatgptSignOut: { label: 'Sign out', disabled: busy || !(signedIn || c?.expired) },
      keySaveOpenai: { label: 'Save key', disabled: busy }, keySaveAnthropic: { label: 'Save key', disabled: busy },
      keyRemoveOpenai: { label: 'Remove key', disabled: busy || !ai.keys.openai }, keyRemoveAnthropic: { label: 'Remove key', disabled: busy || !ai.keys.anthropic },
      decisionSave: { label: 'Save provider', disabled: busy || !ai?.decision },
      keySaveTypesafe: { label: 'Save key', disabled: busy || !ai?.decision }, keyRemoveTypesafe: { label: 'Remove key', disabled: busy || !ai?.keys?.typesafe },
      decisionTest: { label: 'Test connection', disabled: busy || !ai?.keys?.typesafe },
    },
    forms: {
      ai: { provider: ai?.provider ?? 'codex', model_codex: ai?.models.codex ?? '', model_openai: ai?.models.openai ?? '', model_anthropic: ai?.models.anthropic ?? '' },
      'key-openai': { key: '' }, 'key-anthropic': { key: '' }, 'key-typesafe': { key: '' },
      decision: { decisionProvider: ai?.decision?.provider ?? 'off', decision_model: ai?.decision?.model ?? '' },
    },
    defaults: ai?.defaults,
    chatgpt: { loginUrl: signingIn ? c.loginUrl : null, models: c?.models ?? [] },
  };
}

// Claude.ai connect/disconnect buttons. `c` is null on an older portal build.
function claudeControls(c, pending) {
  const busy = pending || !c;
  return {
    claudeConnect: { label: c?.signingIn ? 'Waiting for sign-in…' : c?.connected ? 'Reconnect' : 'Connect Claude.ai', disabled: busy || c.signingIn || !c.browserFound },
    claudeDisconnect: { label: 'Disconnect', disabled: busy || !c.connected },
    claudeAdd: { label: c?.signingIn ? 'Waiting for sign-in…' : 'Add Claude.ai account', disabled: busy || c.signingIn || !c.browserFound || c.connected },
  };
}
// ChatGPT chat sync: on/off over the existing ChatGPT sign-in.
const chatgptChatControls = (s, pending) => ({
  chatgptChatsEnable: { label: 'Add ChatGPT chats', disabled: pending || !s.ai?.chatgpt?.signedIn || !!s.chatgptChats?.enabled },
  chatgptChatsDisable: { label: 'Stop syncing chats', disabled: pending || !s.chatgptChats?.enabled },
});

// Connectors page, described as data: the overview card and the detail view both render from these.
// `notes` is the Notes page source id (counts and the Browse notes link); `feed` is the key in lastRun.feedErrors.
// The Microsoft 365 account shown on these cards comes from status.microsoft.account (config.json).
const M365 = { m365: true, actions: ['connect', 'sync'], hue: 'teams' };
// Connector and page icons: our own 24x24 line drawings (no product logos), stroked with the text colour so they
// follow light and dark mode. Each entry is a list of SVG path `d` strings; portal.js draws them.
export const ICONS = {
  mail: ['M3.5 6.5h17v11h-17z', 'M3.5 7.5l8.5 6 8.5-6'],
  at: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M15.5 8.5v4.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8'], // an email address sign, not a product mark
  chats: ['M3.5 5h11v8H8l-4.5 3.5z', 'M17 9h3.5v10l-3-2.5H10V15'],
  phone: ['M12 3.5a8.5 8.5 0 0 0-7.3 12.8L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5z', 'M9.2 8.5c0 3.4 2.9 6.3 6.3 6.3l.9-1.6-2-.9-.9.9a4.4 4.4 0 0 1-2.7-2.7l.9-.9-.9-2z'], // a chat bubble with a handset, not a product mark
  channel: ['M9.5 4l-2 16', 'M16.5 4l-2 16', 'M4.5 9h15', 'M3.5 15h15'],
  calendar: ['M4 6h16v14H4z', 'M4 10.5h16', 'M8.5 3.5v4', 'M15.5 3.5v4', 'M8 14.5h3'],
  spark: ['M12 3.5v5', 'M12 15.5v5', 'M3.5 12h5', 'M15.5 12h5', 'M6 6l3.2 3.2', 'M14.8 14.8L18 18', 'M18 6l-3.2 3.2', 'M9.2 14.8L6 18'],
  bubble: ['M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z', 'M8.5 12h.01', 'M12 12h.01', 'M15.5 12h.01'],
  pen: ['M4 20h4L19.5 8.5l-4-4L4 16z', 'M14 6l4 4'],
  apps: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  terminal: ['M3.5 5h17v14h-17z', 'M7 9.5l3 2.5-3 2.5', 'M12.5 15h4.5'],
  moon: ['M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  branch: ['M6.5 4v11', 'M6.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17.5 9c0 5-5 6-11 6'],
  globe: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M3.5 12h17', 'M12 3.5c3 3 3 14 0 17', 'M12 3.5c-3 3-3 14 0 17'],
  plus: ['M12 5v14', 'M5 12h14'],
  update: ['M12 3.5v11', 'M7.5 10l4.5 4.5 4.5-4.5', 'M4.5 15.5v4h15v-4'],
};

export const CONNECTORS = [
  { id: 'outlook', name: 'Outlook email', mark: 'O', icon: 'mail', notes: 'email', ...M365, hue: 'outlook', desc: 'Mail in your Microsoft 365 mailbox',
    about: 'Reads your mailbox read-only {every}. Useful threads become notes in inbox/email/; bulk mail, calendar notices and anything that looks like a secret are filtered out.' },
  { id: 'teams-chats', name: 'Teams chats', mark: 'T', icon: 'chats', notes: 'teams-chat', feed: 'teams:chats', ...M365, desc: 'One-to-one and group chats',
    about: 'Chats from Microsoft Teams, read with the same Microsoft 365 sign-in as Outlook. Each chat becomes a note in inbox/teams/chats/. A problem here never stops email.' },
  { id: 'teams-channels', name: 'Teams channels', mark: '#', icon: 'channel', notes: 'teams-channel', feed: 'teams:channels', ...M365, desc: 'Post threads in your channels',
    about: 'Posts in the Teams channels you belong to, one note per post thread in inbox/teams/channels/. Uses the Microsoft 365 sign-in shared with Outlook.' },
  { id: 'meetings', name: 'Meetings', mark: 'M', icon: 'calendar', notes: 'meeting', feed: 'meetings', ...M365, hue: 'meet', desc: 'Transcripts, invites and meeting chat',
    about: 'One note per finished meeting in inbox/meetings/: the transcript when the meeting was recorded, otherwise the invite and the meeting chat. Uses the Microsoft 365 sign-in shared with Outlook.' },
  { id: 'gmail', name: 'Gmail', mark: '@', icon: 'at', notes: 'gmail', feed: 'gmail', hue: 'meet', actions: ['gmailDisconnect'], desc: 'The Gmail mail you choose to include',
    about: 'Reads the mail you choose under What to include (by default Primary, Sent and Important mail) {every} over IMAP with an app password (no Google Cloud project). Useful threads become notes in inbox/email/gmail/; spam, bulk mail and anything that looks like a secret are left out. Mail from this address counts as yours.' },
  { id: 'whatsapp', name: 'WhatsApp', mark: 'W', icon: 'phone', notes: 'whatsapp', feed: 'whatsapp', hue: 'meet', actions: ['whatsappDisconnect'], desc: 'The WhatsApp chats you choose',
    about: 'Linked to WhatsApp on your phone, like WhatsApp Web, and read-only: it never sends messages and never marks them as read. Only the chats you turn on under Chats to include become notes, {every}, one note per chat per month in inbox/whatsapp/chats/. Text only: photos and voice messages show as a marker. Unofficial: WhatsApp does not permit linked tools like this, so a ban of the account is possible.' },
  { id: 'claude', name: 'Claude.ai chats', mark: 'C', icon: 'spark', notes: 'ai-chat', feed: 'ai:claude', hue: 'claude', actions: [], desc: 'Conversations you have on claude.ai',
    about: '{Every}, chats you started or continued on claude.ai are read and distilled into notes in inbox/ai/claude/: what you decided, produced or still have to do.' },
  { id: 'chatgpt', name: 'ChatGPT chats', mark: 'G', icon: 'bubble', notes: 'chatgpt-chat', feed: 'ai:chatgpt', hue: 'brand', actions: ['chatgptChatsDisable'], desc: 'Conversations you have on chatgpt.com',
    about: '{Every}, chats you started or continued on ChatGPT are read with your ChatGPT sign-in (the one in Settings) and distilled into notes in inbox/ai/chatgpt/, tagged by project, with canvas documents included. No browser window needed.' },
  { id: 'writer', name: 'Note writer', mark: 'AI', icon: 'pen', hue: 'brand', href: '#settings', desc: 'The AI that turns each item into a note' },
];
const pill = (text, tone) => ({ text, tone });
const WHATSAPP_PHASES = { linking: ['Waiting for QR scan', 'active'], connecting: ['Connecting', 'active'], connected: ['Connected', 'ok'],
  offline: ['Offline', 'warn'], loggedOut: ['Signed out on the phone', 'warn'], off: ['Not linked', 'neutral'] };
const firstLine = text => String(text).split('\n')[0];

/** A chat feed's history window from status.backfill; null on a portal build without history windows. */
const windowOf = (s, feed) => { const w = s.backfill?.[feed]; return w ? { feed, days: w.days, chosen: !!w.chosen, label: windowLabel(w.days) } : null; };

/** Claude.ai accounts that are added (signed in, signing in, or signed out with a known login), with their state. */
export function claudeRows(s) {
  const list = s.claudeAccounts?.length ? s.claudeAccounts : s.claude ? [{ id: 'personal', label: 'Personal', feed: 'ai:claude', ...s.claude }] : [];
  return list.filter(a => a.connected || a.signingIn || a.email || a.lastError).map(a => {
    const error = a.connected ? s.lastRun?.feedErrors?.[a.feed] ?? '' : a.signingIn ? '' : a.lastError ?? '';
    // Shown by login email only: a name like "Personal" means nothing to someone else using this portal.
    const email = a.email ?? (a.signingIn ? 'Waiting for sign-in' : 'Not signed in');
    const key = `claude:${a.id}`, minutes = intervalFor(s, key);
    return { id: a.id, label: email, email, connected: !!a.connected, signingIn: !!a.signingIn,
      error: error ? firstLine(error) : '', window: windowOf(s, a.feed),
      schedule: { key, minutes, label: intervalLabel(minutes), last: s.feedSchedule?.lastPulledAt?.[key] ?? null },
      pill: a.signingIn ? pill('Signing in', 'active') : a.connected ? error ? pill('Error', 'error') : pill('Connected', 'ok') : pill('Signed out', 'warn') };
  });
}

/** Live state for each connector: status pill, key facts, last error and the one obvious next action. */
export function connectorsModel(s, counts = {}) {
  const paused = s.schedule.enabled === false || s.schedule.state === 'Disabled', unavailable = s.schedule.state === 'Unavailable';
  const lastSync = s.lastSuccessAt ? `Synced ${when(s.lastSuccessAt)}` : 'Not synced yet';
  // Each connector's own next run (its interval), never before the worker's next tick.
  const nextRun = sch => paused ? 'Paused' : unavailable ? 'Unavailable' : when(sch ? nextRunAt(sch.last, sch.minutes, s.schedule.nextRun) ?? s.schedule.nextRun : s.schedule.nextRun);
  const runError = s.lastRun?.error && s.lastRun.error !== 'NEEDS_LOGIN' ? s.lastRun.error : unavailable ? 'Scheduler unavailable. Start Docker Desktop and keep this portal running.' : '';
  const c = s.claude, ai = s.ai, provider = s.settings.provider || 'codex';

  function state(def) {
    const error = def.id === 'outlook' ? runError : s.lastRun?.feedErrors?.[def.feed] ?? '';
    if (def.id === 'claude') {
      const rows = claudeRows(s), noBrowser = c && !c.browserFound, signedOut = rows.find(r => !r.connected && !r.signingIn);
      return {
        error: noBrowser ? 'Needs Microsoft Edge or Google Chrome on this computer.' : rows.find(r => r.error)?.error ?? '',
        account: rows.length > 1 ? `${rows.length} accounts` : rows[0]?.email ?? 'Not connected',
        primary: signedOut && !noBrowser ? 'claudeConnect' : null, primaryAccount: signedOut?.id,
        pill: !c ? pill('Checking', 'neutral') : rows.some(r => r.signingIn) ? pill('Signing in', 'active') : noBrowser || rows.some(r => r.connected && r.error) ? pill('Error', 'error')
          : rows.length && rows.every(r => r.connected) ? s.busy ? pill('Syncing', 'active') : pill('Connected', 'ok') : rows.length ? pill('Needs sign-in', 'warn') : pill('Off', 'neutral'),
        added: rows.length > 0, // shown on the overview only once added (Add connector)
        accounts: rows,
      };
    }
    if (def.id === 'chatgpt') {
      const g = ai?.chatgpt, on = !!s.chatgptChats?.enabled, limited = !!g?.signedIn && isRateLimit(error);
      // A rate limit is a wait: a calm note and a warn badge, not the red error box.
      return { error: g?.signedIn && !limited ? error : '', wait: limited ? RATE_LIMIT_NOTE : '', account: g?.email ?? 'ChatGPT sign-in', added: on, primary: on && !g?.signedIn ? 'chatgptLogin' : null,
        window: windowOf(s, def.feed),
        pill: !ai ? pill('Checking', 'neutral') : !g?.signedIn ? pill('Needs sign-in', 'warn') : limited ? pill('Waiting: ChatGPT rate limit', 'warn')
          : error ? pill('Error', 'error') : s.busy ? pill('Syncing', 'active') : pill('Connected', 'ok') };
    }
    if (def.id === 'gmail') {
      const g = s.gmail, refused = /app password|2-Step|IMAP turned off/i.test(error);
      return { error, account: g?.address ?? 'Gmail', added: !!g?.connected, window: windowOf(s, def.feed), primary: refused ? 'gmailAdd' : null,
        actions: refused ? ['gmailDisconnect', 'gmailAdd'] : ['gmailDisconnect'],
        pill: !g ? pill('Checking', 'neutral') : refused ? pill('Needs a new app password', 'warn') : error ? pill('Error', 'error')
          : s.busy ? pill('Syncing', 'active') : paused ? pill('Paused', 'neutral') : pill('Connected', 'ok') };
    }
    if (def.id === 'whatsapp') {
      const w = s.whatsapp, phase = w?.phase ?? 'off', relink = phase === 'loggedOut' || phase === 'off';
      return { error: phase === 'loggedOut' ? 'WhatsApp on the phone removed this linked device. Link it again to continue.' : error || (phase === 'offline' ? w?.lastError ?? '' : ''),
        account: w?.name ?? 'WhatsApp', added: !!w?.added, primary: relink ? 'whatsappLink' : null,
        actions: relink ? ['whatsappDisconnect', 'whatsappLink'] : ['whatsappDisconnect'],
        pill: !w ? pill('Checking', 'neutral') : phase === 'connected' && !w.chatsOn ? pill('Choose chats', 'warn') : pill(...(WHATSAPP_PHASES[phase] ?? WHATSAPP_PHASES.off)) };
    }
    if (def.id === 'writer') {
      const g = ai?.chatgpt, ready = provider === 'codex' ? g?.signedIn || g?.cliSignedIn : !!ai?.keys?.[provider];
      return { error: '', account: provider === 'codex' ? g?.email ?? 'ChatGPT subscription' : `${s.settings.extractor} key`,
        pill: !ai ? pill('Checking', 'neutral') : g?.signingIn && provider === 'codex' ? pill('Signing in', 'active') : ready ? pill('Connected', 'ok') : pill('Needs sign-in', 'warn') };
    }
    const permission = /permission/i.test(error);
    const lost = def.m365 && s.needsLogin && s.microsoftLogin;
    return { error: lost ? `${lost.reason} (${lost.code}, since ${when(lost.lostAt)})` : error, account: def.m365 ? s.microsoft?.account || 'Microsoft 365 account' : def.account, primary: s.needsLogin || permission ? 'connect' : null,
      pill: s.needsLogin ? pill('Needs sign-in', 'warn') : permission ? pill('Needs permission', 'warn') : error ? pill('Error', 'error')
        : s.busy ? pill('Syncing', 'active') : paused ? pill('Paused', 'neutral') : pill('Connected', 'ok') };
  }

  return CONNECTORS.map(def => ({ def, st: state(def) })).filter(({ def, st }) => !['claude', 'chatgpt', 'gmail', 'whatsapp'].includes(def.id) || st.added).map(({ def, st }) => {
    const count = def.notes ? counts[def.notes] : undefined;
    // Claude.ai: one interval per account (set on its row); the connector's next run is the soonest account's.
    const rows = def.id === 'claude' ? st.accounts.map(a => a.schedule) : [];
    const minutes = def.id === 'writer' ? 15 : def.id === 'claude' ? null : intervalFor(s, def.id);
    const schedule = minutes ? { key: def.id, minutes, label: intervalLabel(minutes), last: s.feedSchedule?.lastPulledAt?.[def.id] ?? null } : null;
    const soonest = rows.map(r => [r, nextRunAt(r.last, r.minutes, s.schedule.nextRun) ?? '']).sort((a, b) => a[1].localeCompare(b[1]))[0]?.[0];
    const spans = schedule ? [schedule.minutes] : [...new Set(rows.map(r => r.minutes))];
    const every = spans.length === 1 ? everyPhrase(spans[0]) : "on each account's own schedule";
    const facts = def.id === 'writer' ? [] : [['Notes in vault', count == null ? '—' : number(count)], ['Last synced', when(s.lastSuccessAt)], ['Next run', nextRun(schedule ?? soonest)]];
    if (def.id === 'gmail') facts.push(['Mail read', gmailScopeModel(s.gmail).summary.replace(/\.$/, '')], ['App password', s.gmail?.passwordSaved ? 'Saved, encrypted on this computer' : 'Not saved']);
    if (def.id === 'whatsapp') facts.push(['Chats to include', `${number(s.whatsapp?.chatsOn ?? 0)} chosen`],
      ['History from the phone', !s.whatsapp?.history ? 'Arrives in the first minutes after linking' : `${number(s.whatsapp.history.added)} messages${s.whatsapp.history.progress != null && s.whatsapp.history.progress < 100 ? ` (${s.whatsapp.history.progress}%)` : ''}`]);
    if (def.id === 'outlook') facts.push(['History scanned', `${s.counts.scannedFolders}${s.counts.totalFolders ? ` of ${s.counts.totalFolders}` : ''} folders, ${s.settings.lookbackDays} days back`]);
    // Who/what this connector runs as, shown under the name on every card.
    const ident = def.id === 'writer' ? `${s.settings.extractor} · ${s.settings.model === 'CLI default' ? 'default model' : s.settings.model}` : st.account;
    return { ...def, ...st, ident, href: def.href ?? `#/connectors/${def.id}`, facts, error: st.error ? firstLine(st.error) : '',
      schedule: def.id === 'writer' ? null : schedule, wait: st.wait ?? '',
      about: def.about?.replace('{every}', every).replace('{Every}', capital(every)),
      footNote: def.id === 'writer' ? st.account : undefined,
      stat: count == null ? null : [number(count), count === 1 ? 'note' : 'notes'],
      line: def.id === 'writer' ? (s.settings.provider === 'codex' || !s.settings.provider ? 'ChatGPT subscription' : 'API key') : lastSync };
  });
}

// Add connector page: every kind of source, whether it is added already, and how to add it.
export const CATALOG = [
  { id: 'claude', name: 'Claude.ai chats', mark: 'C', icon: 'spark', hue: 'claude',
    desc: 'Chats from a Claude.ai account, tagged by project, with the files and documents in them. Add one per login, e.g. personal and company.' },
  { id: 'm365', name: 'Microsoft 365', mark: 'O', icon: 'apps', hue: 'outlook', desc: 'Outlook email, Teams chats and channels, and meetings, with one sign-in.' },
  { id: 'chatgpt', name: 'ChatGPT chats', mark: 'G', icon: 'bubble', hue: 'brand', desc: 'Conversations from your ChatGPT account, tagged by project, with canvas documents. Uses the ChatGPT sign-in from Settings.' },
  { id: 'gmail', name: 'Gmail', mark: '@', icon: 'at', hue: 'meet', desc: 'Primary, Sent and Important mail from a Gmail account, with attachments (you choose what to include). Signs in with an app password; no Google Cloud project.' },
  { id: 'whatsapp', name: 'WhatsApp', mark: 'W', icon: 'phone', hue: 'meet', desc: 'The WhatsApp chats you choose, read-only, through a linked device (scan a QR code, like WhatsApp Web). Unofficial: a ban of the account is possible.' },
  { id: 'claude-code', name: 'Claude Code sessions', mark: '>_', icon: 'terminal', hue: 'brand', desc: 'Sessions you run on this laptop.', soon: true },
];
export function catalogModel(s) {
  const c = s.claude;
  return CATALOG.map(def => {
    if (def.soon) return { ...def, pill: pill('Coming soon', 'neutral') };
    if (def.id === 'claude') {
      const rows = claudeRows(s);
      return { ...def, href: rows.length ? '#/connectors/claude' : null,
        pill: rows.length ? pill(`${rows.length} ${rows.length === 1 ? 'account' : 'accounts'} added`, 'ok') : c?.signingIn ? pill('Signing in', 'active') : pill('Not added', 'neutral'),
        // First account: one button. More accounts: name it (e.g. Company), then sign in to that login.
        action: rows.length ? null : 'claudeAdd', addForm: rows.length > 0, laptopOnly: true, accounts: rows,
        note: !rows.length && c && !c.browserFound ? 'Needs Microsoft Edge or Google Chrome on this computer.' : '' };
    }
    if (def.id === 'chatgpt') {
      const g = s.ai?.chatgpt, on = !!s.chatgptChats?.enabled;
      return { ...def, href: on ? '#/connectors/chatgpt' : null, pill: on ? pill('Added', 'ok') : pill('Not added', 'neutral'),
        action: on ? null : g?.signedIn ? 'chatgptChatsEnable' : 'chatgptLogin', laptopOnly: !g?.signedIn,
        accounts: g?.signedIn ? [{ email: g.email ?? 'ChatGPT account', pill: on ? pill('Syncing chats', 'ok') : pill('Signed in', 'neutral') }] : [],
        note: g?.signedIn ? '' : 'Sign in with ChatGPT first (the same sign-in the note writer can use).' };
    }
    if (def.id === 'whatsapp') {
      const w = s.whatsapp, on = !!w?.added;
      return { ...def, href: on ? '#/connectors/whatsapp' : null, pill: on ? pill('Added', 'ok') : pill('Not added', 'neutral'),
        action: on ? null : 'whatsappLink', laptopOnly: true, accounts: on && w.name ? [{ email: w.name, pill: pill(WHATSAPP_PHASES[w.phase]?.[0] ?? 'Linked', 'ok') }] : [],
        note: on ? '' : 'Needs WhatsApp on your phone to scan a QR code. Your phone must connect at least every 14 days.' };
    }
    if (def.id === 'gmail') {
      const g = s.gmail, on = !!g?.connected;
      return { ...def, href: on ? '#/connectors/gmail' : null, pill: on ? pill('Added', 'ok') : pill('Not added', 'neutral'),
        action: on ? null : 'gmailAdd', laptopOnly: true, accounts: on ? [{ email: g.address, pill: pill('Syncing mail', 'ok') }] : [],
        note: on ? '' : 'Needs a Gmail app password. The form shows each step.' };
    }
    const added = s.connected && !s.needsLogin;
    return { ...def, href: added ? '#/connectors/outlook' : null, pill: added ? pill('Added', 'ok') : pill('Not added', 'neutral'), action: added ? null : 'connect' };
  });
}

/** Overview cards: one per connector, except Claude.ai, which gets one card per account (each its own login and status). */
export function connectorCards(list) {
  return list.flatMap(c => c.id !== 'claude' || !c.accounts?.length ? [c] : c.accounts.map(a => ({
    ...c, key: `claude-${a.id}`, name: 'Claude.ai', account: a.email, ident: a.email, pill: a.pill, error: a.error, stat: null,
    primary: !a.connected && !a.signingIn ? 'claudeConnect' : null, primaryAccount: a.id })));
}

// Remote access: who can reach GBrain. `r` is null on an older portal build.
const TUNNEL_STATE = { starting: ['Connecting to Cloudflare', 'active'], running: ['Connected', 'ok'], error: ['Tunnel stopped', 'error'], stopped: ['Off', 'neutral'] };
function remoteModel(r, pending) {
  const busy = pending || !r, mode = r?.mode ?? 'local', g = r?.gbrain, t = r?.tunnel;
  const [tText, tTone] = TUNNEL_STATE[t?.state ?? 'stopped'];
  return {
    fields: {
      remoteState: !r ? { text: 'Checking' } : mode === 'local' ? { text: 'Local only. Nothing outside this laptop can reach your brain.', tone: 'neutral' }
        : { text: t.state === 'error' && t.lastError ? `${tText}: ${t.lastError}` : tText, tone: tTone },
      remoteUrl: mode === 'local' ? 'Off' : r?.mcpUrl ?? 'Waiting for the address…',
      remoteNote: mode === 'quick' ? 'This address changes every time the tunnel restarts (portal restart, network change). After a change, update the connector address in Claude.ai and ChatGPT.'
        : mode === 'named' ? 'Fixed address on your domain. Connectors keep working across restarts.' : '',
      remoteLocalUrl: r?.localMcpUrl ?? '—',
      gbrainState: !g ? { text: 'Checking' } : g.state === 'running' ? { text: 'Running', tone: 'ok' } : g.state === 'starting' ? { text: 'Starting', tone: 'active' }
        : g.state === 'error' ? { text: `Stopped: ${g.lastError ?? 'it keeps exiting'}`, tone: 'error' } : { text: 'Stopped', tone: 'warn' },
      remoteLog: mode === 'local' ? '' : (t?.logTail ?? []).slice(-12).join('\n'),
      tunnelTokenState: r?.tokenSaved ? { text: 'Token saved', tone: 'ok' } : { text: 'No token saved', tone: 'warn' },
      portalPublicUrl: mode === 'local' ? 'Off' : r?.url ?? 'Waiting for the address…',
      devices: r ? `${number(r.devices ?? 0)} ${r.devices === 1 ? 'device' : 'devices'} signed in` : '—',
    },
    controls: {
      remoteSave: { label: 'Apply', disabled: busy },
      deviceLink: { label: 'Create sign-in link', disabled: busy || mode === 'local' || !r?.url },
      signOutDevices: { label: 'Sign out all devices', disabled: busy || !r?.devices },
      remoteCopy: { label: 'Copy address', disabled: !r?.mcpUrl || mode === 'local' },
    },
    form: { mode, hostname: r?.hostname ?? '', token: '' },
    url: mode === 'local' ? null : r?.mcpUrl ?? null,
  };
}

/** The product name the portal shows (config.json product.name; status from an older server: Third Brain). */
// Dream: the nightly upkeep (src/dream.ts): related notes, topic pages, then GBrain's links, embeddings and orphan
// count. `d` is null on an older portal build.
const hourLabel = h => `${String(h).padStart(2, '0')}:00`;
const runSeconds = r => (r?.steps ?? []).reduce((n, x) => n + (x.seconds ?? 0), 0);
const RUN_TONE = { ok: ['Done', 'ok'], failed: ['Failed', 'error'], skipped: ['Skipped', 'warn'] };
export function dreamModel(d, pending) {
  const last = d?.history?.[0];
  const state = !d ? { text: 'Checking' }
    : d.running ? { text: `Dreaming now: ${d.current ?? 'starting'}`, tone: 'active' }
    : !d.enabled ? { text: 'Off. New notes still get links during each sync, but older notes get no new links.', tone: 'warn' }
    : !last ? { text: `On. The first dream starts at ${hourLabel(d.hour)}.`, tone: 'neutral' }
    : last.result === 'ok' ? { text: `Last dream ${when(last.finishedAt ?? last.at)}, done in ${duration(runSeconds(last))}`, tone: 'ok' }
    : { text: `Last dream ${when(last.at)}: ${last.result ?? 'stopped'}${last.detail ? `. ${last.detail}` : ''}`, tone: last.result === 'skipped' ? 'warn' : 'error' };
  // The steps of the newest run, in plan order; a running dream shows its current step.
  const steps = (d?.steps ?? []).map(p => {
    const r = last?.steps?.find(x => x.id === p.id);
    const [text, tone] = r ? (r.code === 0 ? ['Done', 'ok'] : ['Failed', 'error']) : d.running && d.current === p.name ? ['Running', 'active'] : ['—', 'neutral'];
    return { name: p.name, result: { text, tone }, time: r ? duration(r.seconds) : '', detail: r?.summary ?? (r && r.code !== 0 ? `Exit code ${r.code}` : '') };
  });
  const history = (d?.history ?? []).map(r => {
    const [text, tone] = RUN_TONE[r.result] ?? (d.running && r === last ? ['Running', 'active'] : ['Stopped', 'warn']);
    const pick = id => r.steps?.find(x => x.id === id)?.summary;
    return { at: when(r.at), result: { text, tone }, time: r.steps?.length ? duration(runSeconds(r)) : '', detail: r.detail ?? [pick('related'), pick('orphans')].filter(Boolean).join('; ') };
  });
  return {
    fields: { dreamState: state, dreamNext: !d ? '—' : d.enabled ? `Every night at ${hourLabel(d.hour)}` : 'Off' },
    controls: { dreamRun: { label: d?.running ? 'Dreaming…' : 'Dream now', disabled: pending || !d || d.running } },
    form: { enabled: d?.enabled ?? true, hour: String(d?.hour ?? 3) },
    steps, history,
  };
}

// Updates card on Settings (src/updates.ts). GitHub's answer is untrusted: links are kept only when they point at
// GitHub over https, and the release notes are shown as plain text by the controller.
const githubLink = (url, hosts) => { try { const u = new URL(url); return u.protocol === 'https:' && hosts.includes(u.hostname) && !u.username && !u.port ? u.href : null; } catch { return null; } };
const UPDATED_NOTE_MS = 7 * 86400_000;
export function updatesModel(u, pending, now = Date.now()) {
  const cur = u?.current, version = cur ? `${cur.version}${cur.commit ? ` (${cur.commit})` : ''}` : '';
  const latest = u?.latest, last = u?.lastUpdate;
  const recent = last && now - Date.parse(last.at) < UPDATED_NOTE_MS;
  const updated = recent && !last.error && last.to === cur?.version;
  const state = !u ? { text: 'Checking' }
    : u.applying ? { text: `Updating: ${u.applying.step}`, tone: 'active' }
    : u.available ? { text: `${latest.version} is available`, tone: 'active' }
    : updated ? { text: `Updated to ${last.to}`, tone: 'ok' }
    : latest ? { text: 'Up to date', tone: 'ok' }
    : u.error ? { text: 'Update check failed', tone: 'error' }
    : { text: 'Not checked yet', tone: 'neutral' };
  const detail = !u || u.applying ? (u?.applying ? 'The portal restarts at the end; this page reconnects by itself.' : '')
    : recent && last.error ? `Last update failed: ${last.error}`
    : u.error && latest ? `The last check failed (${u.error}). Showing the answer from ${when(u.checkedAt)}.`
    : u.error ? u.error
    : u.available && !u.canSelfUpdate && u.reason ? u.reason
    : updated ? `From ${last.from} on ${when(last.at)}.`
    : '';
  const notesUrl = u?.available && u.notesUrl ? githubLink(u.notesUrl, ['github.com']) : null;
  const installerUrl = u?.available && u.installerUrl ? githubLink(u.installerUrl, ['github.com', 'objects.githubusercontent.com']) : null;
  return {
    fields: {
      updateCurrent: cur ? `Third Brain ${version}` : 'Third Brain',
      updateState: state, updateDetail: detail,
      updateLatest: !latest ? '—' : `${latest.version}${latest.publishedAt ? ` · ${when(latest.publishedAt)}` : ''}${u.available ? '' : ' · Up to date'}`,
      updateChecked: !u ? '—' : u.checking ? 'Checking now…' : when(u.checkedAt),
      updateBadge: u?.available ? { text: 'New', tone: 'active' } : '',
    },
    controls: {
      updateCheck: { label: u?.checking ? 'Checking…' : 'Check now', disabled: pending || !u || !!u.checking || !!u.applying },
      updateApply: { label: u?.applying ? 'Updating…' : 'Update now', disabled: pending || !u?.canSelfUpdate },
    },
    updates: { available: !!u?.available, version: latest?.version ?? '', notes: u?.available ? u.notes ?? '' : '', notesUrl, installerUrl, current: cur?.version ?? '' },
  };
}

// Entities page (src/entities-view.ts): tabs, search over names and aliases, and sort.
export const ENTITY_TABS = [['person', 'People'], ['company', 'Companies'], ['project', 'Projects'], ['topic', 'Topics']];
export const ENTITY_DIRS = { person: 'people', company: 'companies', project: 'projects', topic: 'topics' };
export function entityRows(items, { q = '', sort = 'notes' } = {}) {
  const needle = q.trim().toLowerCase();
  const hit = e => !needle || [e.name, e.detail, ...(e.aliases ?? [])].some(x => String(x ?? '').toLowerCase().includes(needle));
  const by = { notes: (a, b) => b.notes - a.notes || a.name.localeCompare(b.name), last: (a, b) => String(b.last ?? '').localeCompare(String(a.last ?? '')) || a.name.localeCompare(b.name), name: (a, b) => a.name.localeCompare(b.name) }[sort] ?? (() => 0);
  return items.filter(hit).sort(by);
}

export const ENTITY_PAGE_SIZE = 25, DUPLICATE_GROUPS_PAGE = 8;
/** One page of a list: the page number is clamped to the pages that exist. */
export function pageSlice(items, page, size) {
  const pages = Math.max(1, Math.ceil(items.length / size)), p = Math.min(Math.max(1, Number(page) || 1), pages);
  return { page: p, pages, items: items.slice((p - 1) * size, p * size) };
}
/** People grouped by organisation (largest groups first; people with no organisation last), each group by notes. */
export function groupByOrg(rows) {
  const groups = new Map();
  for (const r of rows) { const k = r.org || ''; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const total = g => g.reduce((n, r) => n + r.notes, 0);
  return [...groups].sort(([a, ga], [b, gb]) => (a === '') - (b === '') || total(gb) - total(ga) || a.localeCompare(b))
    .flatMap(([org, g]) => g.map((r, i) => ({ ...r, group: i === 0 ? (org || 'No organisation') : null, groupSize: g.length })));
}
/** Possible duplicates grouped by the page that stays: "Fabrikam" with each name that may be the same. */
export function groupDuplicates(pairs) {
  const groups = new Map();
  for (const p of pairs) {
    const k = `${p.kind}/${p.keep.slug}`;
    if (!groups.has(k)) groups.set(k, { kind: p.kind, keep: p.keep, candidates: [] });
    groups.get(k).candidates.push({ merge: p.merge, reason: p.reason, judgement: p.judgement ?? null });
  }
  const weight = g => g.keep.notes + g.candidates.reduce((n, c) => n + c.merge.notes, 0);
  return [...groups.values()].sort((a, b) => weight(b) - weight(a) || a.keep.name.localeCompare(b.keep.name));
}

export const productName = s => s?.product?.name || 'Third Brain';

export function viewModel(s, pending = false, noteCounts = {}) {
  const paused = s.schedule.enabled === false || s.schedule.state === 'Disabled';
  const unavailable = s.schedule.state === 'Unavailable';
  const run = s.lastRun, error = run?.error;
  const state = syncState(s, { paused, unavailable, error });
  const indexed = run && !error;
  const runs = s.runs || { total: 0, succeeded: 0, failed: 0, skipped: 0, entries: [] };
  const filtered = run ? Object.entries(run.dropped ?? {}).map(([k, v]) => `${number(v)} ${DROP_REASONS[k] || (k.startsWith('secret:') ? 'secret detection' : k)}`).join(', ') : '';
  const vault = backupModel(s.backup, pending), ai = aiModel(s.ai, pending), remote = remoteModel(s.remote, pending), dream = dreamModel(s.dream, pending), updates = updatesModel(s.updates, pending);

  return {
    fields: {
      ...vault.fields, ...ai.fields, ...remote.fields, ...dream.fields, ...updates.fields,
      productName: productName(s),
      live: { text: 'Live', tone: 'ok' },
      state: { text: state.text, tone: state.tone },
      detail: state.detail,
      processed: number(s.counts.processed),
      queued: { text: number(s.counts.queued), tone: s.busy ? 'active' : '' },
      notes: number(s.counts.notes),
      index: { text: s.indexPending ? 'Pending' : s.busy ? 'Waiting' : indexed ? 'Synced' : 'Unconfirmed', tone: s.indexPending ? 'warn' : indexed ? 'ok' : '' },
      nextRun: paused ? 'Paused' : unavailable ? 'Unavailable' : when(s.schedule.nextRun),
      coverage: `${s.counts.scannedFolders}${s.counts.totalFolders ? ` of ${s.counts.totalFolders}` : ''} folders, ${s.settings.lookbackDays} days back`,
      applied: s.settings.appliedDays === s.settings.lookbackDays ? `Current scan covers ${s.settings.appliedDays} days.` : `Next run applies ${s.settings.lookbackDays} days.`,
      scheduleLabel: paused ? 'Paused. A run in progress can still finish.' : `${s.schedule.backend === 'docker' ? 'Checks every 15 minutes, dispatched by Docker' : 'Checks every 15 minutes and at Windows sign-in'}. Each connector syncs at its own interval.`,
      extractor: `${s.settings.provider === 'codex' || !s.settings.provider ? 'Codex on your ChatGPT subscription' : `${s.settings.extractor} with your key`}, ${s.settings.model === 'CLI default' ? 'default model' : s.settings.model}`,
      runResult: run ? error ? { text: 'Needs attention', tone: 'error' } : { text: 'Completed', tone: 'ok' } : { text: 'No run yet', tone: 'neutral' },
      runTime: run ? run.finishedAt ? `Finished ${when(run.finishedAt)}` : `Started ${when(run.at)}` : 'Your first sync report will appear here.',
      ...Object.fromEntries(['pulled', 'kept', 'duplicates', 'written', 'skipped', 'blocked', 'triageSkipped'].map(k => [k, run ? number(run[k] ?? 0) : '—'])),
      filtered: run ? filtered || 'Nothing filtered in this run.' : '—',
      runError: error || '',
      runCount: `${number(runs.total)} ${runs.total === 1 ? 'run' : 'runs'}`,
      succeeded: number(runs.succeeded), failed: number(runs.failed), skippedRuns: number(runs.skipped),
    },
    controls: {
      ...vault.controls, ...ai.controls, ...remote.controls, ...dream.controls, ...updates.controls, ...claudeControls(s.claude, pending), ...chatgptChatControls(s, pending),
      gmailAdd: { label: s.gmail?.connected ? 'Connect again' : 'Add Gmail', disabled: pending || !s.gmail },
      gmailDisconnect: { label: 'Disconnect', disabled: pending || !s.gmail?.connected },
      whatsappLink: { label: s.whatsapp?.phase === 'loggedOut' ? 'Link again' : 'Link WhatsApp', disabled: pending || !s.whatsapp || ['linking', 'connecting', 'connected'].includes(s.whatsapp.phase) },
      whatsappDisconnect: { label: 'Disconnect', disabled: pending || !s.whatsapp?.added },
      connect: { label: s.connected ? 'Reconnect' : 'Connect Microsoft 365', disabled: pending || s.busy || !s.configured },
      sync: { label: s.busy ? 'Syncing…' : 'Sync now', disabled: pending || s.busy || s.needsLogin || paused || unavailable },
      schedule: { label: paused ? 'Resume' : 'Pause', disabled: pending, path: paused ? '/api/resume' : '/api/pause' },
      save: { label: 'Save settings', disabled: pending },
    },
    // Form values keyed by form id, then by input name.
    forms: { settings: { days: s.settings.lookbackDays, threads: s.settings.threadsPerRun }, backup: vault.form, ...ai.forms, remote: remote.form, dream: dream.form },
    dream: { steps: dream.steps, history: dream.history }, updates: updates.updates,
    modelDefaults: ai.defaults, chatgpt: ai.chatgpt, remoteUrl: remote.url,
    runs: runs.entries.slice(0, 20),
    connectors: connectorsModel(s, noteCounts),
    catalog: catalogModel(s),
  };
}

// Where each kind of synced note lives. Drives the Notes page tabs and the source tags in Sync runs.
export const NOTE_SOURCES = [
  { id: 'email', label: 'Email', tag: 'Email', prefix: 'inbox/email/threads/' }, // Outlook; Gmail has its own folder
  { id: 'gmail', label: 'Gmail', tag: 'Gmail', prefix: 'inbox/email/gmail/' },
  { id: 'whatsapp', label: 'WhatsApp', tag: 'WhatsApp', prefix: 'inbox/whatsapp/' },
  { id: 'teams-chat', label: 'Teams chats', tag: 'Chat', prefix: 'inbox/teams/chats/' },
  { id: 'teams-channel', label: 'Teams channels', tag: 'Channel', prefix: 'inbox/teams/channels/' },
  { id: 'meeting', label: 'Meetings', tag: 'Meeting', prefix: 'inbox/meetings/' },
  { id: 'ai-chat', label: 'Claude chats', tag: 'Claude', prefix: 'inbox/ai/claude/' },
  { id: 'chatgpt-chat', label: 'ChatGPT chats', tag: 'ChatGPT', prefix: 'inbox/ai/chatgpt/' },
];
export const noteSource = path => NOTE_SOURCES.find(s => path.startsWith(s.prefix)) ?? NOTE_SOURCES[0];
/** Case-insensitive match on title and summary, for the Notes page search box. */
export const matchesNote = (note, query) => !query.trim() || `${note.title} ${note.summary}`.toLowerCase().includes(query.trim().toLowerCase());

// ── Notes page state <-> URL hash: #/notes/<source>?q=&from=&to=&page= ──
export const NOTES_PAGE_SIZE = 25;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Reads the Notes page state from the hash's source segment and query string; drops invalid values. */
export function parseNotesState(sub, qs = '') {
  const p = new URLSearchParams(qs), page = Number(p.get('page'));
  const day = k => DAY_RE.test(p.get(k) ?? '') ? p.get(k) : '';
  return { source: NOTE_SOURCES.some(s => s.id === sub) ? sub : null, q: (p.get('q') ?? '').slice(0, 200), from: day('from'), to: day('to'),
    page: Number.isInteger(page) && page > 1 ? page : 1 };
}
/** The hash for a Notes page state; default values are left out so plain #/notes/email stays plain. */
export function notesHash(st) {
  const p = new URLSearchParams();
  if (st.q.trim()) p.set('q', st.q.trim());
  if (st.from) p.set('from', st.from);
  if (st.to) p.set('to', st.to);
  if (st.page > 1) p.set('page', String(st.page));
  const qs = p.toString();
  return `#/notes/${st.source}${qs ? `?${qs}` : ''}`;
}
/** The /api/notes query for a state. */
export function notesApiQuery(st, pageSize = NOTES_PAGE_SIZE) {
  const p = new URLSearchParams({ source: st.source, page: String(st.page), pageSize: String(pageSize) });
  if (st.q.trim()) p.set('q', st.q.trim());
  if (st.from) p.set('from', st.from);
  if (st.to) p.set('to', st.to);
  return p.toString();
}
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Quick date ranges, in local time; `to` is left open so today's new notes appear. */
export function datePresets(now = new Date()) {
  const back = n => { const d = new Date(now); d.setDate(d.getDate() - n); return isoDay(d); };
  return [
    { id: '7d', label: 'Last 7 days', from: back(6), to: '' },
    { id: '30d', label: 'Last 30 days', from: back(29), to: '' },
    { id: 'year', label: 'This year', from: `${now.getFullYear()}-01-01`, to: '' },
    { id: 'all', label: 'All time', from: '', to: '' },
  ];
}
export const activePreset = (st, now = new Date()) => datePresets(now).find(p => p.from === st.from && p.to === st.to)?.id ?? '';
/** Page buttons: always first and last, two either side of the current page, '…' for gaps. */
export function pageItems(page, pages) {
  const keep = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter(n => n >= 1 && n <= pages));
  const out = [];
  for (const n of [...keep].sort((a, b) => a - b)) { if (out.length && n - out[out.length - 1] > 1) out.push(n - out[out.length - 1] === 2 ? n - 1 : '…'); out.push(n); }
  return out;
}
export function showingLine({ total, page, pageSize }) {
  if (!total) return 'No notes';
  const first = (page - 1) * pageSize + 1, last = Math.min(total, page * pageSize);
  return `Showing ${number(first)}–${number(last)} of ${number(total)}`;
}
const dayOf = n => n.day ?? (DAY_RE.test(String(n.date).slice(0, 10)) ? String(n.date).slice(0, 10) : '');
/** Same filter and paging as the server, for a portal still running the older build that returns every note. */
export function pageLocally(notes, st, pageSize = NOTES_PAGE_SIZE) {
  const matches = notes.filter(n => matchesNote(n, st.q) && (!st.from || dayOf(n) >= st.from) && (!st.to || dayOf(n) <= st.to));
  const pages = Math.max(1, Math.ceil(matches.length / pageSize)), page = Math.min(st.page, pages);
  return { notes: matches.slice((page - 1) * pageSize, page * pageSize), total: matches.length, page, pageSize, pages };
}
/** Date column of a note row: day number, month, and the year when it isn't this year. */
export function noteDay(n, now = new Date()) {
  const d = dayOf(n);
  if (!d) return { day: '—', month: '', year: '', iso: '' };
  const date = new Date(`${d}T12:00:00`);
  return { day: String(date.getDate()), month: date.toLocaleString([], { month: 'short' }), year: date.getFullYear() === now.getFullYear() ? '' : String(date.getFullYear()), iso: d };
}
/** Small tags under a note: client, project, account (AI chats), in that order, when present. */
export const noteTags = n => [['client', 'Client'], ['project', 'Project'], ['account', 'Account']].filter(([k]) => n[k] && n[k] !== 'null').map(([k, label]) => ({ kind: k, label, text: n[k] }));

// Notes written by a run. Paths are vault-relative, e.g. inbox/email/threads/2026-10/2026-10-08-fabrikam-q1-review.md
export const noteTitle = path => {
  const words = path.split('/').pop().replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-[0-9a-f]{16}$/, '').replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
export const obsidianUrl = (vault, path) => `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path.replace(/\.md$/, ''))}`;
/** Splits a note into its frontmatter title and body; falls back to the file name for the title. */
export function parseNote(path, content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const title = match?.[1].match(/^title:\s*"?(.*?)"?\s*$/m)?.[1];
  return { title: title || noteTitle(path), body: (match ? content.slice(match[0].length) : content).trim() };
}

// Minimal Markdown for note previews: headings, paragraphs, lists, **bold**, _italic_, `code`, links.
// Returns plain data; the controller builds DOM nodes from it (never innerHTML), so note text can't inject markup.
const INLINE = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\b_[^_]+_\b)|(\[\[[^\]]+\]\])/g;
export function inlineMarkdown(text) {
  const out = []; let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: 'text', text: text.slice(last, m.index) });
    const s = m[0];
    if (m[1]) out.push({ t: 'b', text: s.slice(2, -2) });
    else if (m[2]) out.push({ t: 'code', text: s.slice(1, -1) });
    else if (m[3]) { const [, label, href] = s.match(/^\[([^\]]+)\]\((.+)\)$/); out.push({ t: 'link', text: label, href }); }
    else if (m[4]) out.push({ t: 'link', text: s, href: s });
    else if (m[5]) out.push({ t: 'i', text: s.slice(1, -1) });
    else out.push({ t: 'text', text: s.slice(2, -2).split('|').pop() }); // [[wiki link]] or [[path|Name]] -> its name
    last = m.index + s.length;
  }
  if (last < text.length) out.push({ t: 'text', text: text.slice(last) });
  return out;
}
/** Blocks: { type: 'h', level, inline } | { type: 'p', inline } | { type: 'ul'|'ol', items: inline[] }. */
export function markdownBlocks(md, skipTitle = '') {
  const blocks = [], lines = md.replace(/\r\n/g, '\n').split('\n');
  let para = [], list = null;
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', inline: inlineMarkdown(para.join(' ')) }); para = [];
    if (list) blocks.push(list); list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd(), h = line.match(/^(#{1,4})\s+(.*)$/), ul = line.match(/^\s*[-*]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim()) { flush(); continue; }
    if (h) { flush(); if (!(h[1].length === 1 && h[2].trim() === skipTitle.trim())) blocks.push({ type: 'h', level: h[1].length, inline: inlineMarkdown(h[2]) }); continue; }
    if (ul || ol) {
      if (para.length) { blocks.push({ type: 'p', inline: inlineMarkdown(para.join(' ')) }); para = []; }
      const type = ul ? 'ul' : 'ol';
      if (list?.type !== type) { if (list) blocks.push(list); list = { type, items: [] }; }
      list.items.push(inlineMarkdown((ul ?? ol)[1]));
      continue;
    }
    if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1].push({ t: 'text', text: ' ' + line.trim() }); continue; } // wrapped list line
    if (list) { blocks.push(list); list = null; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

// Sync runs table, described as data. Each column: header, cell value, optional tone.
export const RUN_COLUMNS = [
  ['Started', r => when(r.startedAt)],
  ['Trigger', r => r.source === 'automatic' ? 'Schedule' : 'Sync now'],
  ['Result', r => r.status[0].toUpperCase() + r.status.slice(1), r => RUN_TONES[r.status] || 'neutral'],
  ['Duration', r => duration(r.durationSeconds ?? Math.round((Date.now() - Date.parse(r.startedAt)) / 1000))],
  ['Fetched', r => orDash(r.pulled)],
  ['Notes', r => orDash(r.written)],
  ['Left in queue', r => orDash(r.queued)],
];

// ── History window (backfill) dialog: how far back a chat connector reads, and what that is expected to cost ──
export const WINDOW_CHOICES = [[30, '1 month'], [182, '6 months'], [365, '1 year'], [730, '2 years']];
export const FALLBACK_PER_CHAT = { in: 7600, out: 420 }; // measured 2026-10-17; used until the estimate route answers
export const windowLabel = days => WINDOW_CHOICES.find(([d]) => d === days)?.[1] ?? `${number(days)} days`;
/** 1234 -> "1.2 k", 4_560_000 -> "4.6 M". */
export function tokens(n) {
  const v = Number(n ?? 0);
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)} M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)} k`;
  return number(Math.round(v));
}
export const hoursText = h => h == null ? '' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min`
  : h < 48 ? `${h < 10 ? String(Math.round(h * 10) / 10) : Math.round(h)} ${h === 1 ? 'hour' : 'hours'}` : `${Math.round(h / 24)} days`;
export const money = n => n == null ? '—' : n > 0 && n < 0.01 ? '< $0.01' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Who writes the notes and who pays: from the estimate, else from the status settings (older portal build). */
export function writerLine(w) {
  if (!w) return '';
  const model = !w.model || w.model === 'CLI default' ? 'default model' : w.model;
  return (w.billing ?? (w.provider === 'codex' ? 'subscription' : 'api-key')) === 'subscription'
    ? `Notes are written by Codex · ${model} on your ChatGPT subscription. This counts toward its usage limits.`
    : `Notes are written by ${w.extractor} · ${model}, billed per token to your ${w.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key.`;
}

/** The dialog's content. `est` is the /api/backfill/estimate reply, null while loading, or 'unavailable'. */
export function windowDialogModel({ est, status, feed, mode, current, claude }) {
  const loaded = !!est && est !== 'unavailable', perChat = loaded ? est.perChat : FALLBACK_PER_CHAT;
  const writer = loaded ? est.writer : status?.settings ? { provider: status.settings.provider || 'codex', extractor: status.settings.extractor, model: status.settings.model } : null;
  const threadsPerRun = loaded ? est.threadsPerRun : status?.settings?.threadsPerRun ?? 25;
  const gmail = feed === 'gmail', [one, many] = gmail ? ['thread', 'threads'] : ['chat', 'chats'];
  const choices = WINDOW_CHOICES.map(([days, label]) => {
    const c = loaded ? est.choices.find(x => x.days === days) : null;
    let line;
    if (!est) line = `Counting ${many}…`;
    else if (c?.chats != null) line = `${c.approximate ? '≈ ' : ''}${number(c.chats)} ${c.chats === 1 ? one : many} · ≈ ${tokens(c.inputTokens)} tokens in · ≈ ${hoursText(c.hours) || '15 min'}`;
    else line = `≈ ${tokens(perChat.in)} tokens in and ${tokens(perChat.out)} out per ${one}`;
    return { days, label, line };
  });
  const name = gmail ? 'Gmail' : claude ? 'Claude.ai' : 'ChatGPT';
  const notes = [];
  if (gmail && (mode === 'add' || (loaded && !est.counted))) notes.push('Thread counts appear once Gmail is connected; until then each choice shows the cost per thread.');
  else if (claude && (mode === 'add' || (loaded && !est.counted))) notes.push('Chat counts appear once this account is signed in; until then each choice shows the cost per chat.');
  else if (est === 'unavailable') notes.push(`${gmail ? 'Thread' : 'Chat'} counts appear after the portal restarts; until then each choice shows the cost per ${one}.`);
  if (loaded && est.perChat.source === 'default') notes.push(`Per-${one} figures are a typical measurement; they become your own after a few runs.`);
  if (loaded && est.counted && est.choices.some(c => c.approximate)) notes.push(`Counts marked ≈ are estimated from your most recent ${many}.`);
  notes.push(`Time assumes ${number(threadsPerRun)} conversations per run, one run every 15 minutes, shared with your other connectors.`);
  return {
    title: mode === 'change' ? `Change ${name} history window` : `How far back should ${name} ${gmail ? 'mail' : 'chats'} go?`,
    lede: mode === 'change' ? `Currently ${windowLabel(current)}. Each ${one} in the window is read once and summarised into a note.`
      : `Choose how much history to import. Each ${one} in the window is read once and summarised into a note; new ${many} then sync every 15 minutes.`,
    choices, writer: writerLine(writer), notes,
    confirm: mode === 'change' ? 'Change window' : claude ? 'Confirm and sign in' : 'Confirm and add',
    selected: WINDOW_CHOICES.some(([d]) => d === current) ? current : gmail ? 365 : 182,
    feed,
  };
}
/** What changing the window does, for the selected choice. */
export const windowChangeNote = (selected, current) => current == null || selected === current ? ''
  : selected > current ? 'Widening re-reads older chats from the next run. Chats already in your brain are skipped, so only new history is summarised.'
  : 'Narrowing stops reading chats older than the new window. Notes already written stay in your brain.';

// ── Usage page: tokens and spend per provider, day and source (from /api/usage) ──
export const USAGE_RANGES = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['all', 'All time']];
export function usageModel(r) {
  const t = r.totals, perChat = r.perChat;
  const subscription = r.providers.some(p => p.billing === 'subscription'), api = r.providers.some(p => p.billing === 'api-key');
  const max = Math.max(1, ...r.days.map(d => d.inputTokens + d.outputTokens));
  return {
    totals: [
      ['Conversations summarised', number(t.threads)],
      ['Tokens in', tokens(t.inputTokens)],
      ['Tokens out', tokens(t.outputTokens)],
      ['Per conversation', perChat ? `${tokens(perChat.in)} in · ${tokens(perChat.out)} out` : '—'],
      ...(api || !subscription ? [['Spend on API keys', money(t.spendUsd)]] : []),
      ...(subscription ? [['Subscription, API-equivalent', money(t.apiEquivalentUsd)]] : []),
    ],
    providers: r.providers.map(p => ({
      name: p.label, model: p.model, assumed: p.assumed,
      threads: number(p.threads), in: tokens(p.inputTokens), out: tokens(p.outputTokens),
      perChat: p.perChat ? `${tokens(p.perChat.in)} / ${tokens(p.perChat.out)}` : '—',
      spend: p.billing === 'subscription' ? 'Included in subscription' : money(p.spendUsd),
      spendNote: p.billing === 'subscription' ? `Counts toward usage limits · API-equivalent ≈ ${money(p.apiEquivalentUsd)}`
        : p.spendSource === 'logged' ? 'As reported by the provider' : 'Estimate from the price table',
    })),
    days: r.days.map(d => ({ day: d.day, total: d.inputTokens + d.outputTokens, share: (d.inputTokens + d.outputTokens) / max,
      label: `${d.day}: ${tokens(d.inputTokens)} in, ${tokens(d.outputTokens)} out, ${number(d.threads)} conversations` })),
    peak: tokens(max),
    sources: r.sources.map(s => ({ name: s.label, threads: number(s.threads), in: tokens(s.inputTokens), out: tokens(s.outputTokens) })),
    sourcesNote: r.sourcesFrom ? `Per-source figures are logged from ${r.sourcesFrom}; earlier runs only have totals.` : 'Per-source figures start with the next sync run.',
    projection: r.projection?.threads
      ? `${number(r.projection.threads)} conversations still to summarise (${number(r.projection.queuedThreads)} queued, ${number(r.projection.chatgptPending)} ChatGPT chats listed): ≈ ${tokens(r.projection.inputTokens)} tokens in, ≈ ${hoursText(r.projection.hours)} left at the current pace.`
      : 'Nothing waiting: every listed conversation has been summarised.',
    pricesNote: r.pricesEdited ? 'Your prices, in US dollars per million tokens.' : 'Estimate: typical list prices in US dollars per million tokens. Edit them to your plan’s prices.',
    empty: !t.threads && !t.inputTokens,
  };
}

// ── Gmail: What to include (src/adapters/gmail-scope.ts has the query; these values mirror it for display) ──
export const GMAIL_DEFAULT_SCOPE = { primary: true, sent: true, important: true, updates: false, promotions: false, social: false, forums: false, labels: [] };
export const GMAIL_SCOPE_CHOICES = [
  ['primary', 'Primary', 'The Primary tab of your inbox.'],
  ['sent', 'Sent', 'Mail you sent.'],
  ['important', 'Important mail from other tabs', 'Mail Gmail marks as important in Updates, Promotions, Social or Forums.'],
  ['updates', 'Updates', 'All of it: receipts, statements, notifications.'],
  ['promotions', 'Promotions', 'Offers and marketing mail.'],
  ['social', 'Social', 'Mail from social networks.'],
  ['forums', 'Forums', 'Mailing lists and groups.'],
];
const scopeKeyOf = s => JSON.stringify([GMAIL_SCOPE_CHOICES.map(([k]) => !!s?.[k]), [...(s?.labels ?? [])].sort()]);
const aboutMessages = n => n == null ? '' : `about ${number(n)} ${n === 1 ? 'message' : 'messages'}`;
const joinWords = xs => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
/** The card's content. `draft` = unsaved choices (null: the saved ones); counts / estimate = the routes' replies. */
export function gmailScopeModel(g, { counts = null, countsError = '', estimate = null, estimateError = '', draft = null, windowDays = 365, pending = false } = {}) {
  const saved = g?.scope ?? GMAIL_DEFAULT_SCOPE, cur = draft ?? saved, labels = cur.labels ?? [];
  const options = GMAIL_SCOPE_CHOICES.map(([id, label, desc]) => ({ id, label, desc, checked: !!cur[id], count: counts ? aboutMessages(counts.options?.[id]) : '' }));
  const known = (counts?.labels ?? []).map(l => ({ name: l.name, checked: labels.includes(l.name), count: aboutMessages(l.count) }));
  const extra = labels.filter(n => !known.some(l => l.name === n)).map(name => ({ name, checked: true, count: '' }));
  const none = !options.some(o => o.checked) && !labels.length, changed = scopeKeyOf(cur) !== scopeKeyOf(saved);
  const chosen = [...options.filter(o => o.checked).map(o => o.label), ...labels.map(n => `label ${n}`)];
  const est = estimate && !estimateError ? estimate : null;
  return {
    options, labels: [...known, ...extra],
    labelsNote: counts ? (known.length ? '' : 'This account has no labels of its own.') : 'Your labels appear here after Count.',
    summary: none ? 'Nothing chosen.' : `${joinWords(chosen)}${g?.scopeChosen ? '' : ' (the default)'}.`,
    countsNote: countsError || (counts ? `Counted ${when(counts.at)} in the ${windowLabel(windowDays)} history window. Counts are kept for an hour.` : 'Counting messages in the history window…'),
    estimate: none ? 'Choose at least one kind of mail.' : estimateError ? estimateError : !est ? 'Estimating the AI use for these choices…'
      : `${number(est.newThreads)} new ${est.newThreads === 1 ? 'thread' : 'threads'} to summarise (${number(est.messages)} messages, ${number(est.threads)} threads in the window) · ≈ ${tokens(est.inputTokens)} tokens in, ${tokens(est.outputTokens)} out · ≈ ${hoursText(est.hours) || '15 min'}`,
    writer: est ? [writerLine(est.writer), est.decision ? 'The decision model checks each new thread first and skips clear noise, so the note writer may run on fewer.' : ''].filter(Boolean).join(' ') : '',
    changeNote: changed && !none ? 'Saving reads the whole history window again with these choices. Mail already in your brain is skipped.' : '',
    save: { label: 'Save', disabled: pending || none || !changed },
    count: { label: counts ? 'Count again' : 'Count', disabled: pending },
    none, changed, scope: { ...Object.fromEntries(GMAIL_SCOPE_CHOICES.map(([k]) => [k, !!cur[k]])), labels: [...labels] },
  };
}

/** WhatsApp Chats to include: search, filter chips and unsaved choices (`draft`: a Set of chat ids, or null = as saved). */
export function waChatsModel(chats, { q = '', filter = 'all', draft = null, limit = 150 } = {}) {
  const isOn = c => draft ? draft.has(c.jid) : c.on;
  const words = q.trim().toLowerCase();
  const match = chats.filter(c => (filter === 'all' || (filter === 'on' ? isOn(c) : c.kind === filter)) && (!words || (c.name ?? '').toLowerCase().includes(words)));
  const changed = draft ? chats.filter(c => draft.has(c.jid) !== c.on).length : 0;
  const onCount = chats.filter(isOn).length;
  return {
    rows: match.slice(0, limit).map(c => ({ jid: c.jid, on: isOn(c), name: c.name ?? (c.kind === 'group' ? 'Unnamed group' : 'Unnamed chat'),
      meta: `${c.kind === 'group' ? 'Group' : 'One-to-one'} · ${number(c.count)} ${c.count === 1 ? 'message' : 'messages'} · last ${when(c.lastAt)}` })),
    more: match.length > limit ? `${number(match.length - limit)} more. Search to find them.` : '',
    count: `${number(onCount)} of ${number(chats.length)} turned on`,
    dirty: changed ? `${changed} unsaved ${changed === 1 ? 'change' : 'changes'}` : '',
    save: { disabled: !changed },
    empty: !chats.length ? 'No chats yet. Messages from the phone arrive in the first minutes after linking.' : !match.length ? 'No chat matches.' : '',
  };
}
