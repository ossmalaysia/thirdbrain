// Controller: polls status, applies the view model to [data-bind]/[data-action] hooks, routes views, posts actions.
import { ICONS, entityRows, ENTITY_TABS, ENTITY_DIRS, ENTITY_PAGE_SIZE, DUPLICATE_GROUPS_PAGE, pageSlice, groupByOrg, groupDuplicates } from './view.js';
import { viewModel, productName, RUN_COLUMNS, BACKUP_INTERVALS, noteTitle, obsidianUrl, parseNote, markdownBlocks, NOTE_SOURCES, noteSource, when, CONNECTORS, connectorCards,
  parseNotesState, notesHash, notesApiQuery, datePresets, activePreset, pageItems, showingLine, pageLocally, noteDay, noteTags,
  windowDialogModel, windowChangeNote, windowLabel, USAGE_RANGES, usageModel, SYNC_INTERVALS, gmailScopeModel, waChatsModel } from './view.js';

const $ = sel => document.querySelector(sel), $$ = sel => [...document.querySelectorAll(sel)];
const token = $('meta[name="portal-token"]').content;
// Each form: where it posts and how its inputs become the request body. Values come from vm.forms[id].
const FORMS = {
  settings: { path: '/api/settings', body: f => ({ lookbackDays: Number(f.days.value), threadsPerRun: Number(f.threads.value) }) },
  backup: { path: '/api/backup/settings', body: f => ({ intervalMinutes: Number(f.interval.value), push: f.push.checked }) },
  ai: { path: '/api/ai/settings', body: f => ({ provider: f.provider.value, model: f[`model_${f.provider.value}`].value }) },
  'key-openai': { path: '/api/ai/key', body: f => ({ provider: 'openai', key: f.key.value }) },
  'key-anthropic': { path: '/api/ai/key', body: f => ({ provider: 'anthropic', key: f.key.value }) },
  'key-typesafe': { path: '/api/ai/key', body: f => ({ provider: 'typesafe', key: f.key.value }) },
  decision: { path: '/api/ai/decision', body: f => ({ provider: f.decisionProvider.value, model: f.decision_model.value }) },
  dream: { path: '/api/dream/settings', body: f => ({ enabled: f.enabled.checked, hour: Number(f.hour.value) }) },
  remote: { path: '/api/remote/settings', body: f => ({ mode: f.mode.value, hostname: f.hostname.value, token: f.token.value }) },
};
const dirty = new Set(); // forms the user has edited; polling won't overwrite them
let status = null, pending = false, polling = false, shownNotice = '';

const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
const setTone = (node, tone) => tone ? node.dataset.tone = tone : delete node.dataset.tone;
function show(node, value) {
  if (value === undefined) return;
  const { text, tone } = typeof value === 'object' ? value : { text: value };
  node.textContent = text; setTone(node, tone);
  if ('hideEmpty' in node.dataset) node.hidden = !text;
}
function notice(message, error = false) { const box = $('#notice'); box.hidden = !message; box.textContent = message; box.classList.toggle('error', error); }

// ── Router: #notes, #runs, ... one view per sidebar item; #/connectors/<id> opens a connector; #/notes/<source> picks a tab.
// Unknown hashes fall back to Connectors.
let openConnector = '';
function route() {
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, sub] = path.split('/');
  const views = $$('[data-view]').map(v => v.dataset.view);
  const def = name === 'connectors' && CONNECTORS.find(c => c.id === sub && !c.href);
  const adding = name === 'connectors' && sub === 'add';
  const current = def ? 'connector' : adding ? 'add' : views.includes(name) && !['connector', 'add'].includes(name) ? name : 'connectors';
  openConnector = def ? def.id : '';
  for (const view of $$('[data-view]')) view.hidden = view.dataset.view !== current;
  for (const block of $$('[data-connector]')) block.hidden = block.dataset.connector !== openConnector;
  const navRoute = ['connector', 'add'].includes(current) ? 'connectors' : current;
  for (const link of $$('[data-route]')) link.dataset.route === navRoute ? link.setAttribute('aria-current', 'page') : link.removeAttribute('aria-current');
  $('#nav-more').classList.toggle('is-current', !$(`.tabbar [data-route="${navRoute}"]`)); // a route that is not a tab lives under More
  if (def || adding) { if (def) $('#connector-title').textContent = def.name; shownConnectors = ''; render(); }
  document.title = `${$(`[data-view="${current}"] h1`).textContent} · ${productName(status)}`;
  if (current === 'entities') loadEntities();
  if (current === 'notes') { const st = parseNotesState(sub, qs); notesState = { ...st, source: st.source ?? notesState.source }; loadNotes(); }
  if (navRoute === 'connectors') loadCounts();
  if (openConnector === 'gmail') { gmailScope.shown = ''; openGmailScope(); } else gmailScope.opened = false;
  if (openConnector === 'whatsapp') loadWaChats(true);
  if (current === 'usage') loadUsage();
  setMenu(false);
  window.scrollTo(0, 0);
}

// ── Phone navigation: a bottom tab bar with the main routes; More opens the full menu (the sidebar) as a sheet.
const phone = matchMedia('(max-width: 720px)');
function setMenu(open, { focus = false } = {}) {
  const more = $('#nav-more'), wasOpen = more.getAttribute('aria-expanded') === 'true';
  open = open && phone.matches;
  if (open === wasOpen) return;
  more.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('menu-open', open);
  $('#nav-backdrop').hidden = !open;
  $('main').inert = open; // focus stays in the menu while it is open
  if (open) ($('#sidebar .nav a[aria-current="page"]') ?? $('#sidebar .nav a')).focus();
  else if (focus) more.focus();
}
$('#nav-more').addEventListener('click', () => setMenu($('#nav-more').getAttribute('aria-expanded') !== 'true'));
$('#nav-backdrop').addEventListener('click', () => setMenu(false, { focus: true }));
$('#sidebar').addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.classList.contains('menu-open')) setMenu(false, { focus: true }); });
phone.addEventListener('change', () => setMenu(false));

// ── Data tables with .stacked become one card per row on phones: each cell is labelled with its column header.
function labelCells(table) {
  const heads = [...table.tHead?.rows[0]?.cells ?? []].map(th => th.textContent.trim());
  for (const row of table.tBodies[0]?.rows ?? []) {
    let col = 0;
    for (const td of row.cells) { if (td.colSpan === 1 && heads[col] && td.dataset.label !== heads[col]) td.dataset.label = heads[col]; col += td.colSpan; }
  }
}
for (const table of $$('table.stacked')) { labelCells(table); new MutationObserver(() => labelCells(table)).observe(table, { childList: true, subtree: true }); }

// ── Connectors: one card renderer and one detail renderer, both fed by vm.connectors (view.js).
let noteCounts = {}, countsAt = 0, shownConnectors = '';
async function loadCounts() {
  if (Date.now() - countsAt < 60_000) return; // the per-source note counts change slowly; refresh at most once a minute
  countsAt = Date.now();
  try { const r = await fetch('/api/notes?source=email&pageSize=1', { cache: 'no-store' }); if (r.ok) { noteCounts = (await r.json()).counts ?? {}; shownConnectors = ''; render(); } } catch { /* counts are optional */ }
}
const pill = p => { const b = el('span', { className: 'badge' }, p.text); setTone(b, p.tone); return b; };
const SVG_NS = 'http://www.w3.org/2000/svg';
/** One line icon from ICONS (view.js) as an inline SVG; null for an unknown name (the letter mark stays). */
function iconSvg(name) {
  const paths = ICONS[name];
  if (!paths) return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '22', height: '22', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
  for (const d of paths) { const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
const mark = (node, c) => { const svg = c.icon && iconSvg(c.icon); if (svg) node.replaceChildren(svg); else node.textContent = c.mark; node.dataset.hue = c.hue; return node; };
// Fixed icons in index.html (Dream, Vault repository, Connector address): <span class="source-icon" data-icon="moon">.
for (const node of $$('.source-icon[data-icon]')) { const svg = iconSvg(node.dataset.icon); if (svg) node.replaceChildren(svg); }
const actionButton = (name, quiet = false, laptopOnly = false) => {
  const b = el('button', { type: 'button', className: `btn${quiet ? ' btn-quiet' : ''}${laptopOnly ? ' laptop-only' : ''}`, disabled: true }); b.dataset.action = name; return b;
};
const LAPTOP_ONLY = new Set(['claudeConnect', 'claudeDisconnect', 'gmailAdd', 'gmailDisconnect', 'whatsappLink', 'whatsappDisconnect']);
function connectorCard(c) {
  return el('li', { className: 'panel conn-card' },
    el('div', { className: 'conn-top' }, mark(el('span', { className: 'source-icon', ariaHidden: 'true' }), c), pill(c.pill)),
    el('div', { className: 'conn-name' }, el('h2', {}, el('a', { href: c.href, title: c.desc }, c.name)), el('p', { className: 'conn-ident small' }, c.ident)),
    el('div', { className: 'conn-foot' },
      c.stat ? el('p', { className: 'conn-stat' }, el('strong', {}, c.stat[0]), ` ${c.stat[1]}`) : el('p', { className: 'conn-stat' }, c.footNote ?? ''),
      el('span', { className: 'muted small' }, c.line)),
    c.error ? el('p', { className: 'conn-error small', title: c.error }, c.error) : '',
    c.primary ? primaryButton(c) : '');
}
function primaryButton(c) {
  const b = actionButton(c.primary, false, LAPTOP_ONLY.has(c.primary));
  if (c.primaryAccount) b.dataset.account = c.primaryAccount;
  return b;
}
// Claude.ai account rows carry their own labels (each account differs), so they are not driven by vm.controls.
const accountButton = (action, label, account, quiet) => {
  const b = el('button', { type: 'button', className: `btn${quiet ? ' btn-quiet' : ''} laptop-only`, disabled: pending }, label);
  Object.assign(b.dataset, { action, account }); return b;
};
// No name to type: the account is shown by the email you sign in with.
const addAccountForm = () => el('form', { className: 'add-account actions laptop-only' },
  el('button', { type: 'submit', className: 'btn', disabled: pending }, 'Add another account'),
  el('span', { className: 'muted small' }, 'Opens a new window; sign in with the other Claude.ai login.'));
function renderConnectorDetail(c) {
  mark($('#connector-mark'), c);
  $('#connector-account').textContent = c.account;
  $('#connector-pill').replaceWith(Object.assign(pill(c.pill), { id: 'connector-pill' }));
  $('#connector-about').textContent = c.about;
  $('#connector-actions').replaceChildren(...c.actions.map((a, i) => actionButton(a, i < c.actions.length - 1)),
    el('a', { className: 'btn btn-quiet', href: `#/notes/${c.notes}` }, 'Browse notes'));
  $('#connector-error').hidden = !c.error; $('#connector-error').textContent = c.error;
  $('#connector-wait').hidden = !c.wait; $('#connector-wait').textContent = c.wait ?? '';
  $('#connector-facts').replaceChildren(...c.facts.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))),
    ...(c.schedule ? [el('div', {}, el('dt', {}, 'Sync every'), el('dd', {}, ...scheduleControl(c.schedule)))] : []),
    ...(c.window ? [el('div', { className: 'window-fact' }, el('dt', {}, 'History window'), el('dd', {}, c.window.label, ' ', windowButton(c.window)))] : []));
  if (c.accounts) {
    $('#claude-accounts').replaceChildren(...(c.accounts.length ? c.accounts.map(a => el('li', { className: 'list-row' },
      el('div', { className: 'list-main' }, el('strong', {}, a.email), ' ', pill(a.pill), a.error ? el('p', { className: 'conn-error small' }, a.error) : '',
        a.window ? el('p', { className: 'muted small' }, `History window: ${a.window.label} `, windowButton(a.window)) : '',
        a.schedule ? el('div', { className: 'actions muted small' }, 'Sync every', ...scheduleControl(a.schedule, a.email)) : ''),
      el('div', { className: 'list-actions' },
        accountButton('claudeAccountDisconnect', a.id === 'personal' ? 'Disconnect' : 'Remove', a.id, true),
        accountButton('claudeAccountConnect', a.signingIn ? 'Waiting for sign-in…' : a.connected ? 'Reconnect' : 'Connect', a.id))))
      : [el('li', { className: 'list-row' }, el('span', { className: 'muted list-main' }, 'No Claude.ai account connected yet.'), el('div', { className: 'list-actions' }, accountButton('claudeAccountConnect', 'Connect Claude.ai', 'personal')))]));
    $('#claude-add').replaceChildren(...(c.accounts.length ? [addAccountForm()] : []));
    $('#accounts-title').textContent = c.accounts.length ? `Accounts (${c.accounts.length})` : 'Accounts';
  }
  if (c.id === 'gmail') { openGmailScope(); renderGmailScope(); }
  if (c.id === 'whatsapp') loadWaChats(false);
}

// ── WhatsApp: Chats to include. Loaded on open, then every 20 s while nothing is changed (history keeps arriving).
// Unsaved choices live in waChats.draft; ticking a box updates only the counts, so focus and scroll stay.
const waChats = { list: [], q: '', filter: 'all', draft: null, draftMode: null, loadedAt: 0, seq: 0 };
const waState = () => ({ ...waChats, mode: status?.whatsapp?.mode ?? 'chosen' });
async function loadWaChats(force) {
  if (remoteView() || (!force && (waChats.draft || waChats.draftMode || Date.now() - waChats.loadedAt < 20_000))) return;
  waChats.loadedAt = Date.now();
  const seq = ++waChats.seq;
  try {
    const r = await fetch('/api/whatsapp/chats', { cache: 'no-store' }), data = await r.json().catch(() => ({}));
    if (seq === waChats.seq && r.ok) { waChats.list = data.chats ?? []; renderWaChats(); }
  } catch { /* the next poll tries again */ }
}
function renderWaChatsSummary(m = waChatsModel(waChats.list, waState())) {
  $('#wa-chats-count').textContent = m.count;
  $('#wa-chats-dirty').textContent = m.dirty;
  $('#wa-chats-save').disabled = m.save.disabled || pending;
  $('#wa-mode-hint').textContent = m.hint;
  for (const r of $$('#wa-mode input')) r.checked = r.value === m.mode;
}
function renderWaChats() {
  const m = waChatsModel(waChats.list, waState());
  $('#wa-chats').replaceChildren(...(m.empty ? [el('li', { className: 'list-row muted' }, m.empty)] : m.rows.map(r => el('li', { className: 'list-row' },
    el('label', {}, el('input', { type: 'checkbox', checked: r.on, value: r.jid }),
      el('span', { className: 'list-main' }, el('strong', {}, r.name), el('br'), el('span', { className: 'muted small' }, r.meta)))))));
  $('#wa-chats-more').hidden = !m.more; $('#wa-chats-more').textContent = m.more;
  for (const chip of $$('[data-wa-filter]')) chip.setAttribute('aria-pressed', String(chip.dataset.waFilter === waChats.filter));
  renderWaChatsSummary(m);
}
$('#wa-chats').addEventListener('change', e => {
  const box = e.target.closest('input[type="checkbox"]');
  if (!box) return;
  waChats.draft ??= new Set(waChats.list.filter(c => c.on).map(c => c.jid));
  box.checked ? waChats.draft.add(box.value) : waChats.draft.delete(box.value);
  renderWaChatsSummary();
});
$('#wa-chat-search').addEventListener('input', e => { waChats.q = e.target.value; renderWaChats(); });
for (const chip of $$('[data-wa-filter]')) chip.addEventListener('click', () => { waChats.filter = chip.dataset.waFilter; renderWaChats(); });
// Switching to All chats ticks every chat (the owner then unticks what stays out); back to Chosen keeps the ticks.
$('#wa-mode').addEventListener('change', e => {
  const mode = e.target.value, saved = waState().mode;
  waChats.draftMode = mode === saved ? null : mode;
  if (mode === 'all') waChats.draft = new Set(waChats.list.map(c => c.jid));
  else waChats.draft ??= new Set(waChats.list.filter(c => c.on).map(c => c.jid));
  renderWaChats();
});
function tickShown(on) {
  waChats.draft ??= new Set(waChats.list.filter(c => c.on).map(c => c.jid));
  for (const jid of waChatsModel(waChats.list, waState()).shown) on ? waChats.draft.add(jid) : waChats.draft.delete(jid);
  renderWaChats();
}
$('#wa-tick-shown').addEventListener('click', () => tickShown(true));
$('#wa-untick-shown').addEventListener('click', () => tickShown(false));
$('#wa-chats-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!waChats.draft && !waChats.draftMode) return;
  const chats = waChats.draft ?? new Set(waChats.list.filter(c => c.on).map(c => c.jid));
  if (await post('/api/whatsapp/chats', { mode: waChats.draftMode ?? waState().mode, chats: [...chats] })) { waChats.draft = null; waChats.draftMode = null; await loadWaChats(true); }
});

// ── WhatsApp: Link dialog. The QR code (laptop only) is an image from the portal and changes every few seconds.
let waTimer = 0;
async function openWaDialog() {
  const dialog = $('#wa-dialog'), img = $('#wa-qr-img'), state = $('#wa-state');
  img.hidden = true; state.textContent = 'Making a QR code…';
  dialog.showModal();
  if (!await post('/api/whatsapp/connect')) { dialog.close(); return; }
  const tick = async () => {
    if (!dialog.open) return;
    await refresh();
    const w = status?.whatsapp;
    if (w?.phase === 'connected' || w?.phase === 'connecting') {
      dialog.close();
      notice('WhatsApp is linked. Turn on the chats to include. Messages from the phone arrive in the next minutes.');
      location.hash = '#/connectors/whatsapp';
      return;
    }
    if (w?.phase === 'off') { img.hidden = true; state.textContent = w.lastError || 'Linking stopped. Close this window and try again.'; return; }
    if (w?.hasQr) { img.src = `/api/whatsapp/qr?t=${Date.now()}`; img.hidden = false; state.textContent = 'The code changes every few seconds. Scan the newest one.'; }
    waTimer = setTimeout(tick, 3000);
  };
  tick();
}
$('#wa-cancel').addEventListener('click', () => $('#wa-dialog').close());
$('#wa-dialog').addEventListener('close', () => {
  clearTimeout(waTimer);
  if (status?.whatsapp?.phase === 'linking') post('/api/whatsapp/cancel');
});

// ── Gmail: What to include. Counts and the estimate are read on demand (laptop only; the server keeps them an hour).
// Unsaved choices live in gmailScope.draft and survive the 5-second re-render.
const gmailScope = { opened: false, counts: null, countsError: '', estimate: null, estimateError: '', draft: null, timer: 0, seq: 0, shown: '' };
const remoteView = () => document.body.classList.contains('remote-view');
const gmailModel = () => gmailScopeModel(status?.gmail, { ...gmailScope, windowDays: status?.backfill?.gmail?.days ?? 365, pending });
async function gmailPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-token': token }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 404) throw new Error('Counts appear after the portal restarts.');
  if (!r.ok) throw new Error(data.error || 'Gmail could not be read right now.');
  return data;
}
function openGmailScope() {
  if (gmailScope.opened || remoteView() || !status?.gmail?.connected) return;
  gmailScope.opened = true;
  loadGmailCounts(false); loadGmailEstimate(false);
}
async function loadGmailCounts(refresh) {
  gmailScope.countsError = ''; if (refresh) gmailScope.counts = null; renderGmailScope();
  try { gmailScope.counts = await gmailPost('/api/gmail/counts', { refresh }); }
  catch (e) { gmailScope.countsError = e.message; }
  renderGmailScope();
}
async function loadGmailEstimate(refresh) {
  const m = gmailModel(), seq = ++gmailScope.seq;
  gmailScope.estimate = null; gmailScope.estimateError = '';
  renderGmailScope();
  if (m.none) return;
  try { const est = await gmailPost('/api/gmail/estimate', { scope: m.scope, refresh }); if (seq === gmailScope.seq) gmailScope.estimate = est; }
  catch (e) { if (seq === gmailScope.seq) gmailScope.estimateError = e.message; }
  if (seq === gmailScope.seq) renderGmailScope();
}
function renderGmailScope() {
  if (!status?.gmail) return;
  const m = gmailModel(), key = JSON.stringify(m);
  if (key === gmailScope.shown) return;
  gmailScope.shown = key;
  const focused = document.activeElement?.dataset?.scope;
  const box = $('#gmail-scope-options');
  box.replaceChildren(box.querySelector('legend'), ...m.options.map(o => {
    const input = el('input', { type: 'checkbox', checked: o.checked, disabled: pending }); input.dataset.scope = o.id;
    return el('label', { className: 'choice' }, input, el('span', {}, el('strong', {}, o.label), el('small', {}, o.desc), o.count ? el('small', {}, o.count) : ''));
  }));
  $('#gmail-scope-labels').replaceChildren(...(m.labels.length ? m.labels.map(l => {
    const input = el('input', { type: 'checkbox', checked: l.checked, disabled: pending }); input.dataset.scope = `label:${l.name}`; input.dataset.label = l.name;
    return el('li', { className: 'list-row' }, el('label', { className: 'check list-main' }, input, el('span', {}, l.name)), l.count ? el('span', { className: 'muted small' }, l.count) : '');
  }) : [el('li', { className: 'list-row muted small' }, m.labelsNote)]));
  const chosenLabels = m.labels.filter(l => l.checked).length;
  $('#gmail-scope-labels-title').textContent = chosenLabels ? `Labels (${chosenLabels} chosen)` : 'Labels';
  $('#gmail-scope-counts').textContent = m.countsNote;
  $('#gmail-scope-estimate').textContent = m.estimate;
  $('#gmail-scope-writer').textContent = m.writer; $('#gmail-scope-writer').hidden = !m.writer;
  $('#gmail-scope-change').textContent = m.changeNote; $('#gmail-scope-change').hidden = !m.changeNote;
  Object.assign($('#gmail-scope-save'), { textContent: m.save.label, disabled: m.save.disabled });
  Object.assign($('#gmail-count'), { textContent: m.count.label, disabled: m.count.disabled });
  $('#gmail-scope-summary').textContent = m.summary;
  if (focused) $(`#gmail-scope-form [data-scope="${CSS.escape(focused)}"]`)?.focus();
}
$('#gmail-scope-form').addEventListener('change', e => {
  const input = e.target.closest('input[data-scope]');
  if (!input) return;
  const cur = gmailModel().scope;
  if (input.dataset.label != null) cur.labels = input.checked ? [...new Set([...cur.labels, input.dataset.label])] : cur.labels.filter(n => n !== input.dataset.label);
  else cur[input.dataset.scope] = input.checked;
  gmailScope.draft = cur;
  renderGmailScope();
  clearTimeout(gmailScope.timer); gmailScope.timer = setTimeout(() => loadGmailEstimate(false), 400);
});
$('#gmail-count').addEventListener('click', () => { loadGmailCounts(true); loadGmailEstimate(true); });
$('#gmail-scope-form').addEventListener('submit', async e => {
  e.preventDefault();
  const m = gmailModel();
  if (m.save.disabled) return;
  if (await post('/api/gmail/scope', { scope: m.scope })) { gmailScope.draft = null; renderGmailScope(); }
});
// "Sync every" on a connector (or a Claude.ai account): a select and Save on the laptop, the plain value remotely.
const scheduleDrafts = {}; // connector -> minutes chosen but not saved yet; survives the 5-second re-render
function scheduleControl(sch, who = '') {
  const chosen = scheduleDrafts[sch.key] ?? sch.minutes;
  const select = el('select', { name: 'minutes', disabled: pending }, ...SYNC_INTERVALS.map(([v, label]) => el('option', { value: String(v), selected: v === chosen }, label)));
  select.setAttribute('aria-label', who ? `Sync every, ${who}` : 'Sync every');
  const form = el('form', { className: 'field-inline laptop-only' }, select, el('button', { type: 'submit', className: 'btn btn-quiet', disabled: pending }, 'Save'));
  form.dataset.schedule = sch.key;
  return [form, el('span', { className: 'remote-only' }, sch.label)];
}
document.addEventListener('change', e => { const form = e.target.closest('form[data-schedule]'); if (form) scheduleDrafts[form.dataset.schedule] = Number(e.target.value); });
document.addEventListener('submit', async e => {
  const form = e.target.closest('form[data-schedule]');
  if (!form) return;
  e.preventDefault();
  const connector = form.dataset.schedule;
  if (await post('/api/connectors/schedule', { connector, minutes: Number(form.elements.minutes.value) })) delete scheduleDrafts[connector];
});
// "Change" next to a chat feed's history window: opens the window dialog for that feed.
const windowButton = w => {
  const b = el('button', { type: 'button', className: 'link-btn', disabled: pending }, 'Change');
  Object.assign(b.dataset, { action: 'windowChange', feed: w.feed, days: String(w.days) });
  b.setAttribute('aria-label', `Change history window, currently ${w.label}`);
  return b;
};
const addTile = () => el('li', { className: 'conn-card conn-add' }, el('a', { href: '#/connectors/add' }, el('span', { className: 'plus', ariaHidden: 'true' }, iconSvg('plus') ?? '+'), 'Add connector'));
function catalogItem(k) {
  return el('li', { className: `panel catalog-item${k.soon ? ' soon' : ''}` },
    mark(el('span', { className: 'source-icon', ariaHidden: 'true' }), k),
    el('div', { className: 'catalog-text' }, el('h2', {}, k.href ? el('a', { href: k.href }, k.name) : k.name), el('p', { className: 'muted small' }, k.desc),
      k.note ? el('p', { className: 'hint' }, k.note) : '',
      k.accounts?.length ? el('ul', { className: 'list' }, ...k.accounts.map(a => el('li', { className: 'list-row' },
        el('strong', { className: 'list-main' }, a.email), pill(a.pill)))) : '',
      k.addForm ? addAccountForm() : ''),
    el('div', { className: 'catalog-side' }, pill(k.pill), k.action ? actionButton(k.action, false, !!k.laptopOnly) : ''));
}
function renderConnectors(list, catalog) {
  const key = JSON.stringify([list, catalog]) + openConnector;
  if (key === shownConnectors) return; // unchanged: keep keyboard focus on the cards and buttons
  shownConnectors = key;
  $('#connector-grid').replaceChildren(...connectorCards(list).map(connectorCard), addTile());
  $('#catalog').replaceChildren(...catalog.map(catalogItem));
  const open = list.find(c => c.id === openConnector);
  if (open) renderConnectorDetail(open);
  else if (openConnector) location.replace('#/connectors/add'); // e.g. Claude.ai not added yet
}

const openRuns = new Set(); // runs whose note list is expanded; survives the 5-second re-render
let shownRuns = '';
function noteList(run) {
  const items = run.notes.map(path => {
    const preview = el('button', { type: 'button', className: 'link-btn' }, noteTitle(path)); preview.dataset.note = path;
    return el('li', { className: 'list-row' }, el('span', { className: 'list-main' }, el('span', { className: 'source-tag' }, noteSource(path).tag), preview),
      el('a', { href: obsidianUrl(status.vault, path), className: 'muted small laptop-only' }, 'Open in Obsidian'));
  });
  const details = el('details', { className: 'disclosure', open: openRuns.has(run.id) }, el('summary', {}, `${run.notes.length} ${run.notes.length === 1 ? 'note' : 'notes'} written`), el('ul', { className: 'list' }, ...items));
  details.addEventListener('toggle', () => details.open ? openRuns.add(run.id) : openRuns.delete(run.id));
  return el('tr', { className: 'detail-row' }, el('td', { colSpan: RUN_COLUMNS.length }, details));
}
let shownDream = '';
/** Dream panel tables (Runs page): the newest dream's steps and the recent dreams. */
function renderDream(dream) {
  const key = JSON.stringify(dream);
  if (key === shownDream) return;
  shownDream = key;
  const row = r => {
    const badge = el('span', { className: 'badge' }, r.result.text); setTone(badge, r.result.tone);
    return el('tr', {}, el('td', {}, r.name ?? r.at), el('td', {}, badge), el('td', {}, r.time), el('td', { className: 'wrap' }, r.detail));
  };
  $('#dream-steps').replaceChildren(...dream.steps.map(row));
  $('#dream-history').replaceChildren(...(dream.history.length ? dream.history.map(row) : [el('tr', {}, el('td', { colSpan: 4, className: 'empty-cell' }, 'No dream yet.'))]));
}

const numericRunColumn = i => i >= 4; // Fetched, Notes, Left in queue (RUN_COLUMNS in view.js)
function renderRuns(runs) {
  const key = JSON.stringify(runs) + (runs.some(r => r.status === 'running') ? Date.now() : ''); // a running row's duration ticks
  if (key === shownRuns) return; // unchanged: keep focus and scroll position inside the table
  shownRuns = key;
  const rows = runs.flatMap(run => {
    const cells = RUN_COLUMNS.map(([, value, tone], i) => {
      if (!tone) return el('td', { className: numericRunColumn(i) ? 'num' : '' }, value(run));
      const badge = el('span', { className: 'badge' }, value(run)); setTone(badge, tone(run)); return el('td', {}, badge);
    });
    return [el('tr', {}, ...cells),
      ...run.error ? [el('tr', { className: 'detail-row is-error' }, el('td', { colSpan: RUN_COLUMNS.length }, run.error))] : [],
      ...run.notes?.length ? [noteList(run)] : []];
  });
  $('#runs-body').replaceChildren(...rows);
  $('#runs-table').hidden = !runs.length; $('#runs-empty').hidden = !!runs.length;
}

// Notes page: one tab per source, filtered and paged by the server (/api/notes). State lives in the hash,
// #/notes/<source>?q=&from=&to=&page=, so refresh and Back work. Loads on open and on change, not on the poll.
let notesState = { source: 'email', q: '', from: '', to: '', page: 1 }, notesSeq = 0, notesLoaded = false, searchTimer = 0;
/** Applies a change; pushes a history entry unless `replace` (typing in search). */
function setNotes(change, { replace = false } = {}) {
  notesState = { ...notesState, page: 1, ...change };
  const hash = notesHash(notesState);
  if (replace) { history.replaceState(null, '', hash); loadNotes(); }
  else if (location.hash !== hash) location.hash = hash; // hashchange -> route() -> loadNotes()
  else loadNotes();
}
async function loadNotes() {
  const st = notesState, seq = ++notesSeq, list = $('#notes-list');
  syncNoteFilters(st);
  list.setAttribute('aria-busy', 'true');
  if (!notesLoaded) list.replaceChildren(...Array.from({ length: 6 }, skeletonRow));
  try {
    const response = await fetch(`/api/notes?${notesApiQuery(st)}`, { cache: 'no-store' }), data = await response.json();
    if (seq !== notesSeq) return; // a newer request is on its way
    if (!response.ok) throw new Error(data.error);
    // An older portal build returns every note without `total`: filter and page here until it restarts.
    const result = data.total == null ? pageLocally(data.notes ?? [], st) : data;
    renderNoteTabs(data.counts ?? {});
    renderNotesList(result, st);
    if (result.page !== st.page) { notesState = { ...st, page: result.page }; history.replaceState(null, '', notesHash(notesState)); }
    notesLoaded = true;
  } catch (e) {
    if (seq !== notesSeq) return;
    list.replaceChildren(emptyRow('Could not load notes', e.message || 'The portal did not answer. Check that it is still running, then reload.'));
    $('#note-count').textContent = ''; $('#note-pager').hidden = true;
  } finally { if (seq === notesSeq) list.removeAttribute('aria-busy'); }
}
function syncNoteFilters(st) {
  const search = $('#note-search');
  if (search !== document.activeElement && search.value !== st.q) search.value = st.q;
  $('#note-from').value = st.from; $('#note-to').value = st.to;
  $('#note-from').max = st.to || ''; $('#note-to').min = st.from || '';
  const active = activePreset(st);
  $('#note-presets').replaceChildren(...datePresets().map(p => {
    const chip = el('button', { type: 'button', className: 'chip' }, p.label);
    chip.dataset.preset = p.id; chip.setAttribute('aria-pressed', String(p.id === active));
    return chip;
  }));
}
function renderNoteTabs(counts) {
  $('#note-tabs').replaceChildren(...NOTE_SOURCES.map(s => {
    const tab = el('button', { type: 'button', className: 'tab' }, `${s.label} `, el('span', { className: 'count' }, Number(counts[s.id] ?? 0).toLocaleString()));
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(s.id === notesState.source)); tab.dataset.tab = s.id;
    return tab;
  }));
}
const skeletonRow = () => el('li', { className: 'note-row skeleton', ariaHidden: 'true' }, el('span', {}), el('div', { className: 'note-main' }, el('span', { className: 'bar' }), el('span', { className: 'bar' })));
const emptyRow = (title, text, clear = false) => {
  const li = el('li', { className: 'empty' }, el('strong', {}, title), el('p', { className: 'muted' }, text));
  if (clear) { const b = el('button', { type: 'button', className: 'btn btn-quiet' }, 'Clear filters'); b.dataset.notesClear = ''; li.append(b); }
  return li;
};
function noteRow(n, prev) {
  const d = noteDay(n), open = el('button', { type: 'button', className: 'link-btn note-title' }, n.title);
  open.dataset.note = n.path;
  const date = el('time', { className: 'note-date', dateTime: d.iso, title: when(n.date) },
    el('span', { className: 'd' }, d.day), el('span', { className: 'm' }, d.month), d.year ? el('span', { className: 'y' }, d.year) : '');
  const tags = noteTags(n).map(t => { const tag = el('span', { className: 'note-tag' }, el('span', { className: 'k' }, `${t.label} `), t.text); tag.dataset.kind = t.kind; return tag; });
  const row = el('li', { className: 'note-row' }, date, el('div', { className: 'note-main' }, open,
    n.summary ? el('p', { className: 'note-summary', title: n.summary }, n.summary) : '',
    tags.length ? el('div', { className: 'note-tags' }, ...tags) : ''));
  if (prev && d.iso && noteDay(prev).iso === d.iso) row.classList.add('same-day');
  return row;
}
function renderNotesList(r, st) {
  const filtered = !!(st.q.trim() || st.from || st.to);
  $('#note-count').textContent = r.total ? showingLine(r) : '';
  const label = NOTE_SOURCES.find(s => s.id === st.source)?.label.toLowerCase() ?? 'notes';
  $('#notes-list').replaceChildren(...(r.notes.length ? r.notes.map((n, i) => noteRow(n, r.notes[i - 1]))
    : [filtered ? emptyRow('No notes match', 'Try other words or a wider date range.', true) : emptyRow(`No ${label} yet`, 'Notes appear here after the connector\'s next sync.')]));
  renderPager(r);
}
function renderPager({ page, pages }, pager = $('#note-pager')) {
  pager.hidden = pages <= 1;
  if (pages <= 1) return pager.replaceChildren();
  const btn = (label, target, cls, aria = '') => {
    const b = el('button', { type: 'button', className: `btn btn-quiet ${cls}`, disabled: target < 1 || target > pages }, label);
    b.dataset.page = String(target); if (aria) b.setAttribute('aria-label', aria);
    return b;
  };
  pager.replaceChildren(btn('Previous', page - 1, 'prev'),
    ...pageItems(page, pages).map(n => {
      if (n === '…') return el('span', { className: 'gap', ariaHidden: 'true' }, '…');
      const b = btn(String(n), n, 'num', `Page ${n}`);
      if (n === page) b.setAttribute('aria-current', 'page');
      return b;
    }),
    el('span', { className: 'where' }, `Page ${page} of ${pages}`),
    btn('Next', page + 1, 'next'));
}

// Note preview: Markdown blocks from view.js -> DOM nodes (text only, never innerHTML).
function renderInline(tokens) {
  return tokens.flatMap(tok => {
    if (tok.t === 'b') return [el('strong', {}, tok.text)];
    if (tok.t === 'i') return [el('em', {}, tok.text)];
    if (tok.t === 'code') return [el('code', {}, tok.text)];
    if (tok.t === 'link') return [el('a', { href: tok.href, target: '_blank', rel: 'noopener noreferrer' }, tok.text)];
    const status = tok.text.match(/^(.*?)\s*Status:\s*(open|done)\.?\s*$/i); // commitment lines end with "Status: open|done"
    if (!status) return [tok.text];
    const done = status[2].toLowerCase() === 'done';
    const badge = el('span', { className: 'badge', title: done ? 'A later email in this thread shows this was delivered.' : 'Promised, but no email in this thread shows it delivered yet.' }, done ? 'Done' : 'Pending');
    setTone(badge, done ? 'ok' : 'warn');
    return [`${status[1].replace(/\.{2,}$/, '.')} `, badge]; // notes written before the render fix end with ".."
  });
}
const renderMarkdown = blocks => blocks.map(b =>
  b.type === 'h' ? el(`h${Math.min(b.level + 1, 4)}`, {}, ...renderInline(b.inline))
  : b.type === 'p' ? el('p', {}, ...renderInline(b.inline))
  : el(b.type, {}, ...b.items.map(item => el('li', {}, ...renderInline(item)))));

// ── Entities page: Browse (one tab per type, search, sort, optional grouping by organisation, 25 rows a page) and
// Review duplicates (laptop only: cards grouped by the page that stays, Merge / Not the same, 8 cards a page).
let entityState = { mode: 'browse', kind: 'company', items: [], counts: {}, page: 1, dupPage: 1, pairs: [], apply: null }, entitySeq = 0;
async function loadEntities() {
  const seq = ++entitySeq;
  try {
    const r = await fetch(`/api/entities?kind=${entityState.kind}`, { cache: 'no-store' }), data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (seq !== entitySeq) return;
    entityState = { ...entityState, items: data.items, counts: data.counts };
    renderEntities();
  } catch (e) { notice(e.message || 'Could not load the entities.', true); }
  loadDuplicates();
}
function renderEntities() {
  for (const t of $$('#entity-mode [data-mode]')) t.setAttribute('aria-selected', String(t.dataset.mode === entityState.mode));
  $('#entity-browse').hidden = entityState.mode !== 'browse';
  $('#entity-review').hidden = entityState.mode !== 'review';
  $('#entity-tabs').replaceChildren(...ENTITY_TABS.map(([kind, label]) => {
    const tab = el('button', { type: 'button', className: 'tab' }, `${label} `, el('span', { className: 'count' }, Number(entityState.counts[kind] ?? 0).toLocaleString()));
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(kind === entityState.kind)); tab.dataset.kind = kind;
    return tab;
  }));
  const people = entityState.kind === 'person';
  $('#entity-group-wrap').hidden = !people;
  let rows = entityRows(entityState.items, { q: $('#entity-search').value, sort: $('#entity-sort').value });
  const grouped = people && $('#entity-group').checked;
  if (grouped) rows = groupByOrg(rows);
  const slice = pageSlice(rows, entityState.page, ENTITY_PAGE_SIZE);
  entityState.page = slice.page;
  $('#entity-count').textContent = rows.length === entityState.items.length ? `${rows.length.toLocaleString()} pages` : `${rows.length.toLocaleString()} of ${entityState.items.length.toLocaleString()} pages`;
  const start = (slice.page - 1) * ENTITY_PAGE_SIZE;
  $('#entity-body').replaceChildren(...slice.items.flatMap((e, i) => {
    const name = el('button', { type: 'button', className: 'link-btn' }, e.name);
    name.addEventListener('click', () => openEntity(e.kind, e.slug));
    const aliases = e.aliases?.length ? el('span', { className: 'muted small' }, ` (also ${e.aliases.slice(0, 3).join(', ')})`) : '';
    const row = el('tr', {}, el('td', {}, name, aliases), el('td', {}, e.detail || e.email || ''), el('td', { className: 'num' }, String(e.notes)), el('td', {}, e.last ?? ''));
    let head = null;
    if (grouped && e.group) head = `${e.group} · ${e.groupSize}`;
    else if (grouped && i === 0) head = `${rows.slice(0, start + 1).reverse().find(r => r.group)?.group ?? ''} (continued)`;
    return head ? [el('tr', { className: 'group-row' }, el('td', { colSpan: 4 }, head)), row] : [row];
  }));
  renderPager(slice, $('#entity-pager'));
  renderDuplicates();
}
$('#entity-mode').addEventListener('click', e => { const t = e.target.closest('[data-mode]'); if (t) { entityState.mode = t.dataset.mode; renderEntities(); } });
$('#entity-tabs').addEventListener('click', e => { const t = e.target.closest('[data-kind]'); if (t) { entityState.kind = t.dataset.kind; entityState.page = 1; loadEntities(); } });
$('#entity-search').addEventListener('input', () => { entityState.page = 1; renderEntities(); });
for (const id of ['#entity-sort', '#entity-group']) $(id).addEventListener('change', () => { entityState.page = 1; renderEntities(); });
$('#entity-filters').addEventListener('submit', e => e.preventDefault());
$('#entity-pager').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b && !b.disabled) { entityState.page = Number(b.dataset.page); renderEntities(); $('#entities-title').scrollIntoView(); } });
$('#dups-pager').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b && !b.disabled) { entityState.dupPage = Number(b.dataset.page); renderDuplicates(); $('#entities-title').scrollIntoView(); } });

async function loadDuplicates() {
  if (document.body.classList.contains('remote-view')) return;
  try {
    const r = await fetch('/api/entities/duplicates', { cache: 'no-store' }), data = await r.json();
    if (!r.ok) throw new Error(data.error);
    entityState.pairs = data.pairs; entityState.apply = data.apply; entityState.decisions = data.decisions ?? [];
    renderDuplicates();
  } catch { /* the review is optional */ }
}
const KIND_LABEL = Object.fromEntries(ENTITY_TABS);
function renderDuplicates() {
  const groups = groupDuplicates(entityState.pairs ?? []), apply = entityState.apply;
  $('#dups-count').textContent = entityState.pairs?.length ? String(entityState.pairs.length) : '';
  const waiting = entityState.pairs?.length ?? 0, auto = (entityState.decisions ?? []).length;
  $('#dups-summary').textContent = `${waiting} ${waiting === 1 ? 'pair waits' : 'pairs wait'} for you · ${auto} decided automatically`;
  const status = $('#dups-apply');
  status.hidden = !apply?.pending && !apply?.lastResult;
  status.textContent = apply?.pending ? `Applying merges. ${apply.lastResult ?? ''}` : apply?.lastResult ?? '';
  $('#dups-empty').hidden = groups.length > 0;
  const slice = pageSlice(groups, entityState.dupPage, DUPLICATE_GROUPS_PAGE);
  entityState.dupPage = slice.page;
  const nameButton = (kind, p) => { const b = el('button', { type: 'button', className: 'link-btn' }, p.name); b.addEventListener('click', () => openEntity(kind, p.slug)); return b; };
  const notes = n => `${n} ${n === 1 ? 'note' : 'notes'}`;
  $('#dups-list').replaceChildren(...slice.items.map(g => el('article', { className: 'panel card card-s' },
    el('header', { className: 'card-head' }, el('div', {}, el('strong', {}, nameButton(g.kind, g.keep)), el('span', { className: 'muted small' }, ` ${KIND_LABEL[g.kind] ?? g.kind} · ${notes(g.keep.notes)} · stays`))),
    el('ul', { className: 'list' }, ...g.candidates.map(c => {
      const merge = el('button', { type: 'button', className: 'btn' }, `Merge into ${g.keep.name}`);
      merge.addEventListener('click', async () => { if (await post('/api/entities/merge', { kind: g.kind, from: c.merge.slug, to: g.keep.slug })) loadEntities(); });
      const distinct = el('button', { type: 'button', className: 'btn btn-quiet' }, 'Not the same');
      distinct.addEventListener('click', async () => { if (await post('/api/entities/distinct', { kind: g.kind, a: g.keep.slug, b: c.merge.slug })) loadDuplicates(); });
      return el('li', { className: 'list-row' },
        el('div', { className: 'list-main' }, nameButton(g.kind, c.merge), el('span', { className: 'muted small' }, ` · ${notes(c.merge.notes)}`), el('div', { className: 'muted small' }, c.reason, c.judgement ? ` · Model: ${Math.round(c.judgement.p * 100)}% the same` : '')),
        el('div', { className: 'list-actions' }, distinct, merge));
    })))));
  renderPager(slice, $('#dups-pager'));
  const decided = entityState.decisions ?? [];
  $('#dups-decided').hidden = !decided.length;
  $('#dups-decided-count').textContent = String(decided.length);
  $('#dups-decided-list').replaceChildren(...decided.slice(0, 100).map(d => {
    const who = d.by === 'auto' ? 'same name' : `model${d.p != null ? ` ${Math.round(d.p * 100)}%` : ''}`;
    const text = d.type === 'merge' ? `${d.name} merged into ${d.to}` : `${d.name} is not ${d.to}`;
    const row = el('li', { className: 'list-row' }, el('div', { className: 'list-main' }, el('span', {}, text), el('div', { className: 'muted small' }, `${KIND_LABEL[d.kind] ?? d.kind} · ${who} · ${d.at}`)));
    if (d.type === 'merge') {
      const undo = el('button', { type: 'button', className: 'btn btn-quiet' }, 'Undo');
      undo.addEventListener('click', async () => { if (await post('/api/entities/undo', { kind: d.kind, from: d.from, to: d.to })) loadEntities(); });
      row.append(el('div', { className: 'list-actions' }, undo));
    }
    return row;
  }));
}
$('#dups-judge').addEventListener('click', async () => { if (await post('/api/entities/judge')) setTimeout(loadDuplicates, 3000); });

async function openEntity(kind, slug) {
  try {
    const r = await fetch(`/api/entities/item?kind=${kind}&slug=${encodeURIComponent(slug)}`, { cache: 'no-store' }), data = await r.json();
    if (!r.ok) throw new Error(data.error);
    $('#entity-dialog-title').textContent = data.row.name;
    $('#entity-dialog-sub').textContent = [data.row.detail || data.row.email, `${data.row.notes} ${data.row.notes === 1 ? 'note' : 'notes'}`, data.row.aliases?.length ? `also: ${data.row.aliases.join(', ')}` : ''].filter(Boolean).join(' · ');
    $('#entity-open').href = obsidianUrl(status.vault, `inbox/entities/${ENTITY_DIRS[kind]}/${slug}.md`);
    $('#entity-notes').replaceChildren(...data.notes.map(n => {
      const b = el('button', { type: 'button', className: 'link-btn list-main' }, n.title);
      b.addEventListener('click', () => { $('#entity-dialog').close(); openNote(n.path); });
      return el('li', { className: 'list-row' }, el('span', { className: 'list-meta' }, n.date), b);
    }));
    $('#entity-dialog').showModal();
  } catch (e) { notice(e.message || 'Could not open that page.', true); }
}
$('#entity-close').addEventListener('click', () => $('#entity-dialog').close());

async function openNote(path) {
  const dialog = $('#note-dialog');
  try {
    const response = await fetch(`/api/note?path=${encodeURIComponent(path)}`, { cache: 'no-store' }), data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const note = parseNote(path, data.content);
    $('#note-title').textContent = note.title; $('#note-path').textContent = path; $('#note-body').replaceChildren(...renderMarkdown(markdownBlocks(note.body, note.title)));
    $('#note-open').href = obsidianUrl(status.vault, path);
    dialog.showModal();
  } catch (e) { notice(e.message || 'Could not open that note.', true); }
}

// ── History window dialog: shown before a chat connector is added and from its Change button. Choices render at once
// with per-chat figures; counts fill in when /api/backfill/estimate answers (an older portal build: per-chat only).
let windowCtx = null, windowResolve = null, windowSeq = 0;
function askWindow(ctx) {
  const dialog = $('#window-dialog'), seq = ++windowSeq;
  windowCtx = { ...ctx, est: null };
  drawWindow(true);
  dialog.showModal();
  ($('#window-choices input:checked') ?? $('#window-choices input'))?.focus();
  fetch(`/api/backfill/estimate?feed=${encodeURIComponent(ctx.feed)}`, { cache: 'no-store' })
    .then(async r => { const d = await r.json().catch(() => null); return r.ok && d?.choices ? d : 'unavailable'; }, () => 'unavailable')
    .then(est => { if (seq === windowSeq && dialog.open) { windowCtx.est = est; drawWindow(false); } });
  return new Promise(resolve => { windowResolve = resolve; });
}
function drawWindow(first) {
  const m = windowDialogModel({ ...windowCtx, status }), box = $('#window-choices');
  $('#window-title').textContent = m.title; $('#window-lede').textContent = m.lede;
  $('#window-writer').textContent = m.writer; $('#window-confirm').textContent = m.confirm;
  $('#window-notes').replaceChildren(...m.notes.map(n => el('li', {}, n)));
  if (first) {
    box.replaceChildren(box.querySelector('legend'), ...m.choices.map(c => {
      const input = el('input', { type: 'radio', name: 'days', value: String(c.days), checked: c.days === m.selected });
      const line = el('small', {}, c.line); line.dataset.line = String(c.days);
      return el('label', { className: 'choice' }, input, el('span', {}, el('strong', {}, c.label), line));
    }));
  } else for (const c of m.choices) box.querySelector(`[data-line="${c.days}"]`).textContent = c.line; // keeps focus and selection
  drawWindowChange();
}
function drawWindowChange() {
  const note = windowCtx?.mode === 'change' ? windowChangeNote(Number($('#window-form').elements.days.value), windowCtx.current, windowCtx.feed === 'whatsapp' ? 'messages' : 'chats') : '';
  $('#window-change').hidden = !note; $('#window-change').textContent = note;
}
function closeWindow(days) {
  const resolve = windowResolve; windowResolve = null; windowSeq++;
  if ($('#window-dialog').open) $('#window-dialog').close();
  resolve?.(days);
}
$('#window-form').addEventListener('change', drawWindowChange);
$('#window-form').addEventListener('submit', e => { e.preventDefault(); closeWindow(Number(e.target.elements.days.value)); });
$('#window-cancel').addEventListener('click', () => closeWindow(null));
$('#window-dialog').addEventListener('close', () => closeWindow(null)); // Esc

const NO_WINDOWS = 'This portal version cannot save a history window yet, so the default window applies. After the portal restarts, use Change on the connector.';
/** Saves a window before an add action. false = refused (shown); { unsupported } = older portal build without the route. */
async function saveWindow(feed, days) {
  try {
    const r = await fetch('/api/backfill/window', { method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-token': token }, body: JSON.stringify({ feed, days }) });
    if (r.status === 404) return { unsupported: true };
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { notice(data.error || 'The history window could not be saved.', true); return false; }
    return data;
  } catch { notice('The portal did not answer. Check that it is still running.', true); return false; }
}

// ── Gmail: one form with the setup steps, the address, the app password and the history window. The password goes
// only into the POST body; the field is emptied when the dialog closes. Errors show inside the dialog.
let gmailSeq = 0;
function openGmailDialog() {
  const dialog = $('#gmail-dialog'), form = $('#gmail-form'), seq = ++gmailSeq;
  const ctx = { feed: 'gmail', mode: 'add', current: status.backfill?.gmail?.days ?? 365, claude: false, est: null };
  const draw = first => {
    const m = windowDialogModel({ ...ctx, status }), box = $('#gmail-choices');
    $('#gmail-writer').textContent = m.writer;
    if (first) box.replaceChildren(box.querySelector('legend'), ...m.choices.map(c => {
      const line = el('small', {}, c.line); line.dataset.line = String(c.days);
      return el('label', { className: 'choice' }, el('input', { type: 'radio', name: 'days', value: String(c.days), checked: c.days === m.selected }), el('span', {}, el('strong', {}, c.label), line));
    }));
    else for (const c of m.choices) box.querySelector(`[data-line="${c.days}"]`).textContent = c.line;
  };
  form.reset(); $('#gmail-error').hidden = true;
  if (status.gmail?.address) form.elements.address.value = status.gmail.address;
  draw(true);
  dialog.showModal();
  form.elements.address.focus();
  fetch('/api/backfill/estimate?feed=gmail', { cache: 'no-store' })
    .then(async r => { const d = await r.json().catch(() => null); return r.ok && d?.choices ? d : 'unavailable'; }, () => 'unavailable')
    .then(est => { if (seq === gmailSeq && dialog.open) { ctx.est = est; draw(false); } });
}
$('#gmail-cancel').addEventListener('click', () => $('#gmail-dialog').close());
$('#gmail-dialog').addEventListener('close', () => { gmailSeq++; $('#gmail-form').elements.password.value = ''; });
$('#gmail-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, error = $('#gmail-error'), submit = $('#gmail-submit');
  const address = f.elements.address.value.trim(), password = f.elements.password.value.replace(/\s+/g, '');
  const fail = message => { error.textContent = message; error.hidden = false; };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return fail('Enter your Gmail address, e.g. name@gmail.com.');
  if (!/^[a-z]{16}$/i.test(password)) return fail('Paste the 16-letter app password from step 2 (spaces do not matter).');
  error.hidden = true; submit.disabled = true; submit.textContent = 'Testing the sign-in…';
  try {
    const r = await fetch('/api/gmail/connect', { method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-token': token },
      body: JSON.stringify({ address, password, days: Number(f.elements.days.value) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return fail(data.error || 'Gmail could not be connected. Try again.');
    $('#gmail-dialog').close();
    notice(data.message);
    location.hash = '#/connectors/gmail';
    await refresh();
  } catch { fail('The portal did not answer. Check that it is still running.'); }
  finally { submit.disabled = false; submit.textContent = 'Test and connect'; }
});

// ── Usage page: /api/usage?range=, loaded on open and on range change (not on the 5-second poll).
let usageRange = '30d', usageSeq = 0, pricesDirty = false;
const PRICE_ROWS = [['codex', 'Codex (API-equivalent)'], ['openai', 'OpenAI API'], ['anthropic', 'Claude API']];
async function loadUsage() {
  const seq = ++usageSeq;
  $('#usage-range').replaceChildren(...USAGE_RANGES.map(([id, label]) => {
    const chip = el('button', { type: 'button', className: 'chip' }, label);
    chip.dataset.usageRange = id; chip.setAttribute('aria-pressed', String(id === usageRange)); return chip;
  }));
  $('#usage-body').setAttribute('aria-busy', 'true');
  try {
    const r = await fetch(`/api/usage?range=${usageRange}`, { cache: 'no-store' }), data = await r.json().catch(() => ({}));
    if (seq !== usageSeq) return;
    if (r.status === 404) throw new Error('Usage needs the updated portal. It appears after BrainPortal restarts.');
    if (!r.ok) throw new Error(data.error || 'Usage could not be loaded.');
    renderUsage(data);
    $('#usage-error').hidden = true; $('#usage-body').hidden = false;
  } catch (e) {
    if (seq !== usageSeq) return;
    $('#usage-error').textContent = e.message; $('#usage-error').hidden = false; $('#usage-body').hidden = true;
  } finally { if (seq === usageSeq) $('#usage-body').removeAttribute('aria-busy'); }
}
const cell = (text, sub) => el('td', { className: 'num' }, text, sub ? el('span', { className: 'cell-sub' }, sub) : '');
function renderUsage(r) {
  const m = usageModel(r);
  $('#usage-totals').replaceChildren(...m.totals.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));
  $('#usage-projection').textContent = m.projection;
  $('#usage-providers').replaceChildren(...(m.providers.length ? m.providers.map(p => el('tr', {},
    el('td', {}, el('strong', {}, p.name), el('span', { className: 'cell-sub' }, p.model, p.assumed ? ' · assumed (logged before providers were recorded)' : '')),
    cell(p.threads), cell(p.in), cell(p.out), cell(p.perChat), cell(p.spend, p.spendNote)))
    : [el('tr', {}, el('td', { colSpan: 6, className: 'empty-cell' }, 'No conversations summarised in this range.'))]));
  const chart = $('#usage-chart');
  chart.style.setProperty('--gap', m.days.length > 45 ? '1px' : '2px');
  chart.replaceChildren(el('div', { className: 'bars', ariaHidden: 'true' }, ...m.days.map(d => {
    const bar = el('span', { className: 'bar', title: d.label }); bar.style.height = `${(d.share * 100).toFixed(1)}%`; return bar;
  })), el('div', { className: 'axis small muted', ariaHidden: 'true' }, el('span', {}, m.days[0]?.day ?? ''), el('span', {}, m.days.at(-1)?.day ?? '')));
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', `Tokens per day, ${m.days[0]?.day ?? ''} to ${m.days.at(-1)?.day ?? ''}; busiest day ${m.peak}. A table follows.`);
  $('#usage-peak').textContent = `Busiest day ${m.peak} tokens`;
  $('#usage-days').replaceChildren(...[...m.days].reverse().filter(d => d.total).map(d => el('tr', {}, el('td', {}, d.day), cell(d.total.toLocaleString()), el('td', { className: 'wrap' }, d.label.replace(/^[^:]+: /, '')))));
  $('#usage-sources').replaceChildren(...(m.sources.length ? m.sources.map(s => el('tr', {}, el('td', {}, s.name), cell(s.threads), cell(s.in), cell(s.out)))
    : [el('tr', {}, el('td', { colSpan: 4, className: 'empty-cell' }, 'Nothing logged per source in this range yet.'))]));
  $('#usage-sources-note').textContent = m.sourcesNote;
  $('#usage-prices-note').textContent = m.pricesNote;
  if (!pricesDirty) $('#usage-price-rows').replaceChildren(...PRICE_ROWS.map(([id, label]) => el('fieldset', { className: 'price-row' },
    el('legend', {}, label),
    ...['in', 'out'].map(k => el('label', {}, el('span', {}, k === 'in' ? 'Input $/1M' : 'Output $/1M'),
      el('input', { type: 'number', name: `${id}-${k}`, min: '0', max: '10000', step: 'any', required: true, inputMode: 'decimal', value: String(r.prices[id][k]) }))))));
}
$('#usage-prices').addEventListener('input', () => { pricesDirty = true; });
$('#usage-prices').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  if (!f.reportValidity()) return;
  const body = Object.fromEntries(PRICE_ROWS.map(([id]) => [id, { in: Number(f.elements[`${id}-in`].value), out: Number(f.elements[`${id}-out`].value) }]));
  if (await post('/api/usage/prices', body)) { pricesDirty = false; loadUsage(); }
});

function render() {
  if (!status) return;
  const vm = viewModel(status, pending, noteCounts);
  renderConnectors(vm.connectors, vm.catalog); // before the bindings below, so new buttons get their labels
  for (const node of $$('[data-bind]')) show(node, vm.fields[node.dataset.bind]);
  for (const node of $$('[data-action]')) { const c = vm.controls[node.dataset.action]; if (c) { node.textContent = c.label; node.disabled = c.disabled; } } // buttons without state keep their markup
  for (const [id, values] of Object.entries(vm.forms)) {
    const form = document.getElementById(id);
    for (const input of form.elements) if (input.name) input.disabled = pending;
    if (!dirty.has(id)) for (const [name, value] of Object.entries(values)) form.elements[name][form.elements[name].type === 'checkbox' ? 'checked' : 'value'] = value;
  }
  for (const [provider, model] of Object.entries(vm.modelDefaults ?? {})) $('#ai').elements[`model_${provider}`].placeholder = model || 'Auto: the first model your plan offers';
  const link = $('#chatgpt-login-link'); link.hidden = !vm.chatgpt.loginUrl; if (vm.chatgpt.loginUrl) link.href = vm.chatgpt.loginUrl;
  const options = vm.chatgpt.models.join('\n');
  if ($('#chatgpt-models').dataset.list !== options) { $('#chatgpt-models').dataset.list = options; $('#chatgpt-models').replaceChildren(...vm.chatgpt.models.map(value => el('option', { value }))); }
  renderRuns(vm.runs);
  renderDream(vm.dream);
  renderUpdates(vm.updates);
  if (status.notice && status.notice !== shownNotice) notice(shownNotice = status.notice);
}

// Updates card: links only when view.js accepted them (GitHub, https); release notes as plain text (textContent).
function renderUpdates(u) {
  $('#update-apply').hidden = !u.available;
  const notes = $('#update-notes-link'), installer = $('#update-installer-link');
  notes.hidden = !u.notesUrl; if (u.notesUrl) notes.href = u.notesUrl;
  installer.hidden = !u.installerUrl; if (u.installerUrl) installer.href = u.installerUrl;
  $('#update-links').hidden = !u.notesUrl && !u.installerUrl;
  $('#update-notes').hidden = !u.available;
  $('#update-notes-title').textContent = `What is new in ${u.version}`;
  const text = $('#update-notes-text'); text.hidden = !u.notes;
  if (text.textContent !== u.notes) text.textContent = u.notes;
}
let seenVersion = ''; // after a self-update the restarted portal reports a new version: load the new front end once
// One missed poll is normal (laptop sleep, a busy sync run, a tunnel blip): go Offline only after a few in a row,
// and clear our own Offline notice as soon as a poll works again.
const OFFLINE_AFTER = 3, OFFLINE_NOTICE = 'The portal did not answer. It tries again every 5 seconds. If this stays, check that BrainPortal is running.';
let failedPolls = 0, offlineText = '';

async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' }), data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `The portal answered ${response.status}.`);
    if (offlineText && $('#notice').textContent === offlineText) notice(''); // leave a newer notice alone
    failedPolls = 0; offlineText = '';
    const named = productName(status) !== productName(data);
    status = data; render();
    const version = data.updates?.current?.version ?? '';
    if (seenVersion && version && version !== seenVersion) return location.reload();
    if (version) seenVersion = version;
    if (named) document.title = document.title.replace(/ · [^·]*$/, ` · ${productName(data)}`); // the tab title carries the product name
  } catch (e) {
    if (++failedPolls < OFFLINE_AFTER) return;
    show($('[data-bind="live"]'), { text: 'Offline', tone: 'error' });
    for (const node of $$('[data-action]')) node.disabled = true;
    // fetch() rejects with a TypeError ("Failed to fetch") when no answer came; the portal's own errors are readable
    notice(offlineText = e instanceof TypeError ? OFFLINE_NOTICE : e.message || OFFLINE_NOTICE, true);
  } finally { polling = false; }
}

async function post(path, body = {}, formId = '') {
  if (pending) return;
  pending = true; render();
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-portal-token': token }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (data.url) return location.assign(data.url);
    dirty.delete(formId);
    notice(data.message);
    return data;
  } catch (e) { notice(e.message || 'That action failed. Try again.', true); }
  finally { pending = false; await refresh(); }
}

const ACTIONS = {
  connect: () => post('/api/connect'),
  sync: () => post('/api/sync'),
  schedule: () => post(viewModel(status).controls.schedule.path),
  backupRun: () => post('/api/backup/run'),
  dreamRun: () => post('/api/dream/run'),
  updateCheck: () => post('/api/update/check'),
  updateApply: () => {
    const v = status.updates?.latest?.version;
    if (v && confirm(`Update Third Brain to ${v}? The portal pauses the sync, waits for a running sync to finish, updates with git and restarts.`)) post('/api/update/apply');
  },
  backupSchedule: () => post(viewModel(status).controls.backupSchedule.path),
  aiTest: () => post('/api/ai/test', { provider: $('#ai').provider.value }),
  remoteCopy: async () => {
    const url = viewModel(status).remoteUrl;
    if (!url) return;
    try { await navigator.clipboard.writeText(url); notice('Copied. Paste it as the connector address in Claude.ai or ChatGPT.'); }
    catch { notice(`Copy this address: ${url}`); }
  },
  deviceLink: async () => {
    const data = await post('/api/remote/device-link');
    if (!data?.link) return;
    const box = $('#device-link'); box.hidden = false; box.elements.link.value = data.link; box.elements.link.select();
  },
  copyDeviceLink: async () => {
    const value = $('#device-link').elements.link.value;
    try { await navigator.clipboard.writeText(value); notice('Sign-in link copied. Open it on the other device within 10 minutes.'); } catch { notice(`Copy this link: ${value}`); }
  },
  signOutDevices: () => post('/api/remote/signout-devices'),
  gbrainAdmin: async () => { const data = await post('/api/remote/gbrain-admin-link'); if (data?.url) window.open(data.url, '_blank', 'noopener'); },
  claudeConnect: node => post('/api/claude/connect', { account: node?.dataset.account }),
  claudeDisconnect: node => post('/api/claude/disconnect', { account: node?.dataset.account }),
  claudeAccountConnect: node => post('/api/claude/connect', { account: node.dataset.account }),
  claudeAccountDisconnect: node => post('/api/claude/disconnect', { account: node.dataset.account }),
  // Adding a chat connector first asks how far back to import (and shows the expected usage).
  claudeAdd: async () => {
    const days = await askWindow({ feed: 'ai:claude', mode: 'add', current: status.backfill?.['ai:claude']?.days, claude: true });
    if (days != null && await post('/api/claude/connect', { days })) location.hash = '#/connectors/claude';
  },
  chatgptLogin: () => post('/api/ai/chatgpt-login'),
  chatgptChatsEnable: async () => {
    const days = await askWindow({ feed: 'ai:chatgpt', mode: 'add', current: status.backfill?.['ai:chatgpt']?.days, claude: false });
    if (days == null) return;
    const saved = await saveWindow('ai:chatgpt', days);
    if (!saved) return;
    const data = await post('/api/chatgpt-chats/enable');
    if (!data) return;
    if (saved.unsupported) notice(`${data.message} ${NO_WINDOWS}`);
    location.hash = '#/connectors/chatgpt';
  },
  windowChange: async node => {
    const feed = node.dataset.feed, current = Number(node.dataset.days);
    const days = await askWindow({ feed, mode: 'change', current, claude: feed.startsWith('ai:claude') }); // the model names Gmail by its feed
    if (days != null && days !== current) await post('/api/backfill/window', { feed, days });
    else if (days != null) notice(`History window unchanged: ${windowLabel(current)}.`);
  },
  chatgptChatsDisable: () => post('/api/chatgpt-chats/disable'),
  gmailAdd: () => openGmailDialog(),
  whatsappLink: () => openWaDialog(),
  whatsappDisconnect: () => {
    if (confirm('Disconnect WhatsApp? This computer is removed from Linked devices on your phone, and the messages stored on this computer are deleted. Notes already written stay.')) post('/api/whatsapp/disconnect');
  },
  gmailDisconnect: () => { if (confirm('Disconnect Gmail? The saved app password is deleted from this computer. Notes already written stay.')) post('/api/gmail/disconnect'); },
  chatgptSignOut: () => post('/api/ai/chatgpt-signout'),
  keyRemoveOpenai: () => post('/api/ai/key', { provider: 'openai', key: null }),
  keyRemoveAnthropic: () => post('/api/ai/key', { provider: 'anthropic', key: null }),
  keyRemoveTypesafe: () => post('/api/ai/key', { provider: 'typesafe', key: null }),
  decisionTest: () => post('/api/ai/decision-test'),
};
document.addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (tab && tab !== notesState.source) setNotes({ source: tab }); // filters carry over between sources
  const preset = e.target.closest('[data-preset]')?.dataset.preset;
  if (preset) { const p = datePresets().find(x => x.id === preset); setNotes({ from: p.from, to: p.to }); }
  const page = e.target.closest('#note-pager [data-page]')?.dataset.page; // the Entities pagers have their own handlers
  if (page) setNotes({ page: Number(page) });
  const range = e.target.closest('[data-usage-range]')?.dataset.usageRange;
  if (range && range !== usageRange) { usageRange = range; loadUsage(); }
  if (e.target.closest('[data-notes-clear]')) { $('#note-search').value = ''; setNotes({ q: '', from: '', to: '' }); }
  const button = e.target.closest('[data-action]'), name = button?.dataset.action, note = e.target.closest('[data-note]')?.dataset.note;
  if (ACTIONS[name] && status) ACTIONS[name](button);
  if (note) openNote(note);
});
$('#note-close').addEventListener('click', () => $('#note-dialog').close());
// Add another Claude.ai account (catalog or Claude.ai detail): name it, then its own sign-in window opens.
document.addEventListener('submit', async e => {
  const form = e.target.closest('.add-account');
  if (!form) return;
  e.preventDefault();
  const days = await askWindow({ feed: 'ai:claude:new', mode: 'add', claude: true });
  if (days != null && await post('/api/claude/accounts', { days })) location.hash = '#/connectors/claude';
});
for (const [id, { path, body }] of Object.entries(FORMS)) {
  const form = document.getElementById(id);
  form.addEventListener('input', () => dirty.add(id));
  form.addEventListener('submit', e => { e.preventDefault(); if (form.reportValidity()) post(path, body(form), id); });
}
window.addEventListener('hashchange', route);

$('#runs-head').append(el('tr', {}, ...RUN_COLUMNS.map(([header], i) => el('th', { scope: 'col', className: numericRunColumn(i) ? 'num' : '' }, header))));
$('#interval').append(...BACKUP_INTERVALS.map(([value, label]) => el('option', { value }, label)));
$('#device-link').addEventListener('submit', e => e.preventDefault());
$('#note-search').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => setNotes({ q: e.target.value }, { replace: true }), 250); });
$('#note-filters').addEventListener('submit', e => { e.preventDefault(); clearTimeout(searchTimer); setNotes({ q: $('#note-search').value }, { replace: true }); });
for (const id of ['note-from', 'note-to']) $(`#${id}`).addEventListener('change', () => {
  let from = $('#note-from').value, to = $('#note-to').value;
  if (from && to && from > to) [from, to] = [to, from];
  setNotes({ from, to });
});
// Opened through the tunnel (not on the laptop): hide controls that only work on the laptop.
if (!['localhost', '127.0.0.1'].includes(location.hostname)) document.body.classList.add('remote-view');
// Installable app: the service worker caches the static shell and shows an offline page (sw.js has the rules).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* optional: the portal works without it */ });
route(); refresh(); setInterval(() => { refresh(); if (!$('[data-view="connectors"]').hidden || openConnector) loadCounts(); }, 5000);
