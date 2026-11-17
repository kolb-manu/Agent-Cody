'use strict';
/* global cody */

const $ = (id) => document.getElementById(id);
const els = {
  root: document.documentElement,
  expanded: $('expanded'), pill: $('pill'), list: $('list'), empty: $('empty'), emptyText: $('empty-text'),
  settings: $('settings'), btnInstall: $('btn-install'), banner: $('banner'), count: $('count'), toast: $('toast'),
  pillText: $('pill-text'), pillDot: $('pill-dot'), minibars: $('minibars'), pillOpen: $('pill-open'),
  btnTheme: $('btn-theme'), btnSettings: $('btn-settings'),
};

// ---------- icons (static markup only; session data is always set via textContent) ----------
const ICON = {
  // Agent Cody "ping" logo (build/logo/agent-cody-ping.svg) on a rounded tile.
  spark: '<svg viewBox="0 0 160 160" aria-hidden="true"><rect width="160" height="160" rx="36" fill="#D97757"/>' +
    '<g transform="translate(80 80) scale(0.85) translate(-80 -76)" stroke="#FAF4EE" stroke-linecap="round" fill="none">' +
    '<path d="M64 22 Q56 34 64 46" stroke-width="7"/><path d="M96 22 Q104 34 96 46" stroke-width="7"/>' +
    '<path d="M52 14 Q40 34 52 54" stroke-width="7"/><path d="M108 14 Q120 34 108 54" stroke-width="7"/>' +
    '<line x1="80" y1="70" x2="80" y2="44" stroke-width="8"/><circle cx="80" cy="34" r="10" fill="#FAF4EE" stroke="none"/>' +
    '<rect x="30" y="70" width="100" height="68" rx="22" fill="#FAF4EE" stroke="none"/>' +
    '<circle cx="60" cy="104" r="10" fill="#D97757" stroke="none"/><circle cx="100" cy="104" r="10" fill="#D97757" stroke="none"/>' +
    '</g></svg>',
  moon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z"/></svg>',
  sun: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>',
  gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M6.9 1.6h2.2l.4 1.7c.4.2.8.4 1.1.6l1.7-.5 1.1 1.9-1.3 1.2a4.5 4.5 0 0 1 0 1.3l1.3 1.2-1.1 1.9-1.7-.5c-.3.3-.7.5-1.1.6l-.4 1.8H6.9l-.4-1.8c-.4-.1-.8-.3-1.1-.6l-1.7.5-1.1-1.9 1.3-1.2a4.5 4.5 0 0 1 0-1.3L2.6 5.3l1.1-1.9 1.7.5c.3-.2.7-.4 1.1-.6z"/><circle cx="8" cy="8" r="2"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5l4 4 4-4"/></svg>',
  back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5L5.5 8l4.5 4.5"/></svg>',
  open: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

// ---------- state ----------
let ui = { collapsed: false, theme: 'system', resolvedTheme: 'dark', hookStatus: 'installed', notify: {}, sound: true };
let sessions = [];
let view = 'list';
const rows = new Map(); // id -> { el, refs, fadeTimer }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Line-2 status for non-working states; null means "show progress". */
function statusOf(s) {
  switch (s.state) {
    case 'attention':
      return { cls: 'orange', text: s.attention && s.attention.kind === 'question' ? 'Needs your answer' : 'Needs permission' };
    case 'done': return { cls: 'green', text: s.turnMs != null ? `Finished · ${fmtDuration(s.turnMs)}` : 'Finished' };
    case 'error': return { cls: 'pink', text: 'Stopped · error' };
    case 'stopped': return { cls: 'pink', text: `Stopped · ${s.stopReason || 'interrupted'}` };
    case 'stale': return { cls: 'pink', text: 'Stopped · no updates' };
    case 'ended': return s.stopReason ? { cls: 'pink', text: `Stopped · ${s.stopReason}` } : { cls: 'muted', text: 'Session ended' };
    case 'idle': return { cls: 'muted', text: 'Ready' };
    default: return null;
  }
}

function activityOf(s) {
  if (s.state === 'attention' && s.attention) return s.attention.message;
  if (s.state === 'done' && s.detail && !s.detail.startsWith('“')) return s.detail;
  if (s.state === 'error' && s.detail) return s.detail;
  return s.activity || '';
}

async function openSession(id) {
  const r = await cody.open(id);
  if (r && r.message) toast(r.message);
}

// ---------- rows ----------
function createRow(s) {
  const row = el('div', 'row');
  row.tabIndex = 0;
  row.dataset.id = s.id;
  const dot = el('span', 'dot');
  const main = el('div', 'main');
  const l1 = el('div', 'l1');
  const name = el('span', 'name');
  const activity = el('span', 'activity');
  l1.append(name, activity);
  const l2 = el('div', 'l2');
  const bar = el('div', 'bar');
  const fill = el('i');
  bar.append(fill);
  const meta = el('span', 'meta');
  const status = el('span', 'status');
  l2.append(bar, meta, status);
  main.append(l1, l2);
  const actions = el('div', 'row-actions');
  const dismiss = el('button', 'dismiss');
  dismiss.innerHTML = ICON.close;
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', `Dismiss ${s.name}`);
  const open = el('button', 'open');
  open.innerHTML = ICON.open;
  open.title = 'Open';
  open.setAttribute('aria-label', `Open ${s.name}`);
  actions.append(dismiss, open);
  row.append(dot, main, actions);

  dismiss.addEventListener('click', (e) => { e.stopPropagation(); removeRow(s.id, true); cody.dismiss(s.id); });
  open.addEventListener('click', (e) => { e.stopPropagation(); openSession(s.id); });
  row.addEventListener('click', () => openSession(s.id));
  row.addEventListener('keydown', (e) => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openSession(s.id); } });

  const entry = { el: row, refs: { name, activity, bar, fill, meta, status } };
  rows.set(s.id, entry);
  return entry;
}

function updateRow(entry, s) {
  const { el: row, refs } = entry;
  const st = statusOf(s);
  const flash = row.classList.contains('flash') ? ' flash' : '';
  const fading = row.classList.contains('fading') ? ' fading' : '';
  row.className = `row state-${s.state}${s.state === 'attention' ? ' attention' : ''}${s.state === 'ended' ? ' ended' : ''}${s.state === 'ended' && s.stopReason ? ' stopped-end' : ''}${flash}${fading}`;
  setText(refs.name, s.name);
  setText(refs.activity, activityOf(s));
  row.title = [s.cwd, s.title, s.detail].filter(Boolean).join('\n');

  if (st) {
    refs.bar.hidden = true; refs.meta.hidden = true; refs.status.hidden = false;
    refs.status.className = `status ${st.cls}`;
    setText(refs.status, st.text);
  } else {
    refs.bar.hidden = false; refs.meta.hidden = false; refs.status.hidden = true;
    if (s.steps && s.steps.total > 0) {
      refs.bar.classList.remove('sweep');
      refs.fill.style.width = `${Math.round((s.steps.done / s.steps.total) * 100)}%`;
      setText(refs.meta, `${s.steps.done}/${s.steps.total}`);
    } else {
      refs.bar.classList.add('sweep');
      refs.fill.style.width = '';
      setText(refs.meta, 'working');
    }
  }

  // Ended sessions fade out shortly before main removes them.
  if (s.state === 'ended' && s.fadeAt && !entry.fadeTimer) {
    entry.fadeTimer = setTimeout(() => row.classList.add('fading'), Math.max(0, s.fadeAt - Date.now() - 900));
  } else if (s.state !== 'ended' && entry.fadeTimer) {
    clearTimeout(entry.fadeTimer); entry.fadeTimer = null; row.classList.remove('fading');
  }
}

function removeRow(id, immediate) {
  const entry = rows.get(id);
  if (!entry) return;
  rows.delete(id);
  clearTimeout(entry.fadeTimer);
  entry.el.classList.add('leaving');
  setTimeout(() => entry.el.remove(), immediate ? 160 : 500);
}

// ---------- pill ----------
function renderPill(active) {
  const attention = active.filter((s) => s.state === 'attention');
  const n = active.length;
  els.pill.classList.toggle('attention', attention.length > 0);
  els.pillOpen.hidden = attention.length === 0;
  if (attention.length) {
    const first = attention[0];
    els.pillText.textContent = `${first.name} needs you${attention.length > 1 ? ` +${attention.length - 1}` : ''}`;
    els.pillText.title = first.attention ? first.attention.message : '';
    els.pillOpen.dataset.id = first.id;
    els.pillOpen.setAttribute('aria-label', `Open ${first.name}`);
    els.pillDot.className = 'pill-dot';
    return;
  }
  const allDone = n > 0 && active.every((s) => s.state === 'done');
  const anyWorking = active.some((s) => s.state === 'working');
  if (allDone) els.pillText.textContent = n === 1 ? '1 agent finished' : `All ${n} agents finished`;
  else els.pillText.textContent = n ? `${n} agent${n === 1 ? '' : 's'}` : 'No agents';
  els.pillDot.className = `pill-dot ${allDone ? 'done' : anyWorking ? '' : 'idle'}`;

  els.minibars.hidden = allDone || n === 0;
  els.minibars.replaceChildren(...active.slice(0, 6).map((s) => {
    const span = el('span');
    const i = el('i');
    if (s.state === 'done') span.className = 'done';
    else if (['error', 'stopped', 'stale'].includes(s.state)) span.className = 'stopped';
    else if (s.steps && s.steps.total) i.style.width = `${Math.round((s.steps.done / s.steps.total) * 100)}%`;
    else if (s.state === 'working') span.className = 'sweep';
    span.append(i);
    return span;
  }));
}

// ---------- render ----------
function render() {
  const ids = new Set(sessions.map((s) => s.id));
  for (const id of [...rows.keys()]) if (!ids.has(id)) removeRow(id);
  sessions.forEach((s, i) => {
    const entry = rows.get(s.id) || createRow(s);
    updateRow(entry, s);
    const atIndex = els.list.children[i];
    if (atIndex !== entry.el) els.list.insertBefore(entry.el, atIndex || null);
  });
  const active = sessions.filter((s) => s.state !== 'ended');
  els.count.textContent = active.length ? String(active.length) : '';
  document.title = `Agent Cody (${active.length})`;
  renderView();
  renderPill(active);
}

function renderView() {
  const inSettings = view === 'settings';
  els.settings.hidden = !inSettings;
  els.list.hidden = inSettings;
  els.empty.hidden = inSettings || sessions.length > 0;
  els.btnSettings.classList.toggle('active', inSettings);
  els.btnSettings.setAttribute('aria-pressed', String(inSettings));
  const needsHooks = ui.hookStatus !== 'installed';
  renderOnboarding(inSettings);
  els.btnInstall.hidden = !needsHooks || ui.onboarding === 'hooks';
  if (needsHooks) {
    els.emptyText.textContent = ui.hookStatus === 'partial'
      ? 'Some Claude Code hooks are missing. Reinstall them to see all activity.'
      : 'Connect Claude Code by installing the Agent Cody hooks.';
  } else {
    els.emptyText.innerHTML = 'No agents running. Start <code>claude</code> in a terminal and it shows up here.';
  }
}

const ONBOARDING = {
  login: () => ({
    title: 'Start Agent Cody automatically when you log in?',
    sub: `It waits quietly in the ${ui.platform === 'darwin' ? 'menu bar' : 'system tray'} until an agent needs you. You can change this in Settings any time.`,
    yes: 'Yes',
  }),
  hooks: () => ({
    title: 'Connect Claude Code?',
    sub: 'Adds Agent Cody’s hooks to ~/.claude/settings.json so your sessions show up here. The file is backed up first and your existing hooks stay.',
    yes: 'Install hooks',
  }),
};

function renderOnboarding(inSettings) {
  const card = $('onboarding');
  const step = ui.onboarding && ONBOARDING[ui.onboarding] ? ui.onboarding : null;
  card.hidden = !step || inSettings;
  if (!step) return;
  const c = ONBOARDING[step]();
  $('ob-title').textContent = c.title;
  $('ob-sub').textContent = c.sub;
  $('ob-yes').textContent = c.yes;
  card.dataset.step = step;
}

function renderLoginItem() {
  const li = ui.loginItem || { supported: false, enabled: false };
  const sw = $('login-switch');
  const note = $('login-note');
  const link = $('btn-login-items');
  sw.disabled = !li.supported;
  sw.checked = Boolean(li.enabled);
  $('login-row').classList.toggle('disabled', !li.supported);
  link.hidden = true;
  if (!li.supported) {
    note.hidden = false; note.textContent = 'Only works in the installed app.';
  } else if (li.requiresApproval) {
    note.hidden = false; note.textContent = 'Waiting for your approval in System Settings › Login Items.';
    link.hidden = false; link.textContent = 'Open Login Items';
  } else if (li.error) {
    note.hidden = false; note.textContent = `Couldn’t read the login item (${li.error}).`;
  } else {
    note.hidden = true;
    link.hidden = false;
    link.textContent = ui.platform === 'darwin' ? 'Manage in System Settings' : 'Manage in Startup apps';
  }
}

function renderUi() {
  els.root.dataset.theme = ui.resolvedTheme === 'light' ? 'light' : 'dark';
  els.expanded.hidden = ui.collapsed;
  els.pill.hidden = !ui.collapsed;

  const toDark = ui.resolvedTheme === 'light';
  els.btnTheme.innerHTML = toDark ? ICON.moon : ICON.sun;
  els.btnTheme.title = toDark ? 'Switch to dark theme' : 'Switch to light theme';

  for (const b of document.querySelectorAll('[data-theme-choice]')) b.setAttribute('aria-checked', String(b.dataset.themeChoice === ui.theme));
  for (const input of document.querySelectorAll('[data-setting]')) {
    const k = input.dataset.setting;
    const [group, key] = k.split('.');
    input.checked = key ? Boolean((ui[group] || {})[key]) : Boolean(ui[k]);
  }
  renderLoginItem();
  renderTelegram();
  const hs = $('hook-status');
  hs.textContent = { installed: 'Installed', partial: 'Partly installed', 'not-installed': 'Not installed', error: 'settings.json unreadable' }[ui.hookStatus] || ui.hookStatus;
  hs.className = `hook-status ${ui.hookStatus === 'installed' ? 'ok' : 'warn'}`;
  $('btn-hooks-install').textContent = ui.hookStatus === 'installed' ? 'Reinstall' : 'Install';
  $('btn-hooks-uninstall').hidden = ui.hookStatus === 'not-installed';
  $('port').textContent = String(ui.port || '');

  renderUpdate();
  const upd = ui.update || {};
  const updateBanner = upd.status === 'ready' ? `Agent Cody ${upd.version} is ready · Restart to update`
    : upd.status === 'available' ? `Agent Cody ${upd.version} is available · Download` : null;
  els.banner.dataset.action = '';
  if (ui.serverError) {
    els.banner.hidden = false; els.banner.className = 'banner'; els.banner.textContent = ui.serverError;
  } else if (updateBanner) {
    els.banner.hidden = false; els.banner.className = 'banner info'; els.banner.textContent = updateBanner;
    els.banner.dataset.action = upd.status === 'ready' ? 'install' : 'download';
  } else if (ui.hookStatus === 'partial' && sessions.length) {
    els.banner.hidden = false; els.banner.className = 'banner info'; els.banner.textContent = 'Some hooks are missing. Click to reinstall.';
    els.banner.dataset.action = 'hooks';
  } else {
    els.banner.hidden = true;
  }
  renderView();
}

function renderUpdate() {
  const upd = ui.update || { status: 'idle' };
  $('app-version').textContent = ui.appVersion ? `Version ${ui.appVersion}` : '';
  const text = {
    checking: 'Checking…',
    available: `Agent Cody ${upd.version} is available.`,
    downloading: `Downloading Agent Cody ${upd.version}…`,
    ready: `Agent Cody ${upd.version} is downloaded. Restart to update, or it updates next time you quit.`,
    'up-to-date': 'You’re up to date.',
    error: upd.message || 'Couldn’t check for updates.',
  }[upd.status] || '';
  const status = $('update-status');
  status.textContent = upd.status === 'available' && upd.message ? `${text} ${upd.message}` : text;
  status.hidden = !status.textContent;
  const btn = $('btn-update');
  btn.textContent = upd.status === 'ready' ? 'Restart to update' : upd.status === 'available' ? 'Download' : 'Check for updates';
  btn.className = upd.status === 'ready' || upd.status === 'available' ? 'btn primary' : 'btn';
  btn.disabled = upd.status === 'checking' || upd.status === 'downloading';
  btn.dataset.action = upd.status === 'ready' ? 'install' : upd.status === 'available' ? 'download' : 'check';
}

// ---------- Telegram ----------
let tgBusy = false;       // a test / save request is in flight
let tgManualOpen = false; // the "Enter chat ID instead" field is showing

function renderTelegram() {
  const tg = ui.telegram || { available: false };
  const status = $('tg-status');
  const show = (id, on) => { $(id).hidden = !on; };
  const idle = tg.available && !tg.connecting;
  let text = '', cls = 'hook-status';
  if (!tg.available) { text = 'Telegram isn’t available in this build'; cls += ' muted'; }
  else if (tg.connecting) { text = 'Waiting for you to tap Start in Telegram…'; cls += ' muted'; }
  else if (tg.connected) { text = `Connected as ${tg.name || 'Telegram'}`; cls += ' ok'; }
  else if (tg.disconnected) { text = 'Telegram disconnected ·'; cls += ' warn'; }
  else { text = 'Get alerts on your phone, even when you’re away from the computer.'; cls += ' muted'; }
  status.textContent = text;
  status.className = cls;

  show('tg-reconnect', idle && !tg.connected && tg.disconnected);
  show('tg-connect', idle && !tg.connected && !tg.disconnected);
  show('tg-cancel', tg.available && tg.connecting);
  show('tg-test', idle && tg.connected);
  show('tg-disconnect', idle && (tg.connected || tg.disconnected));
  $('tg-actions').classList.toggle('none', [...$('tg-actions').children].every((b) => b.hidden));
  show('tg-manual-link', idle && !tg.connected && !tgManualOpen);
  show('tg-manual', idle && !tg.connected && tgManualOpen);
  show('tg-switches', tg.available && tg.connected);
  show('tg-note', tg.available);
  for (const id of ['tg-test', 'tg-save']) $(id).disabled = tgBusy;
}

async function telegramConnect() {
  tgManualOpen = false;
  const r = await cody.telegramConnect();
  if (r && r.ok) toast(`Connected as ${r.name}. Check Telegram for the confirmation.`);
  else if (r && !r.cancelled && r.message) toast(r.message);
}

async function telegramRequest(fn) {
  if (tgBusy) return;
  tgBusy = true; renderTelegram();
  try {
    const r = await fn();
    if (r && r.message) toast(r.message);
    return r;
  } finally {
    tgBusy = false; renderTelegram();
  }
}

function runUpdateAction(action) {
  if (action === 'install') cody.installUpdate();
  else if (action === 'download') cody.downloadUpdate();
  else cody.checkForUpdates();
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), Math.min(7000, 2500 + msg.length * 35));
}

// ---------- wiring ----------
$('spark').innerHTML = ICON.spark;
$('btn-settings').innerHTML = ICON.gear;
$('btn-min').innerHTML = ICON.chevron;
$('btn-back').innerHTML = ICON.back;

els.btnTheme.addEventListener('click', () => cody.setSetting('theme', ui.resolvedTheme === 'light' ? 'dark' : 'light'));
function setView(v) {
  view = v;
  if (v === 'settings') cody.refreshUiState(); // re-read the real login-item state from the OS
  renderView();
}
els.btnSettings.addEventListener('click', () => setView(view === 'settings' ? 'list' : 'settings'));
window.addEventListener('focus', () => { if (view === 'settings') cody.refreshUiState(); });
$('login-switch').addEventListener('change', async (e) => {
  const want = e.target.checked;
  const r = await cody.setLoginItem(want);
  if (r) e.target.checked = Boolean(r.enabled); // show what the OS actually did
});
$('btn-login-items').addEventListener('click', () => cody.openLoginItems());
$('ob-yes').addEventListener('click', () => cody.answerOnboarding($('onboarding').dataset.step, true));
$('ob-no').addEventListener('click', () => cody.answerOnboarding($('onboarding').dataset.step, false));
$('btn-back').addEventListener('click', () => setView('list'));
$('btn-min').addEventListener('click', () => cody.toggleCollapse());
$('pill-main').addEventListener('click', () => cody.toggleCollapse());
els.pillOpen.addEventListener('click', () => openSession(els.pillOpen.dataset.id));
els.btnInstall.addEventListener('click', () => cody.installHooks());
$('btn-hooks-install').addEventListener('click', () => cody.installHooks());
$('btn-hooks-uninstall').addEventListener('click', () => cody.uninstallHooks());
els.banner.addEventListener('click', () => {
  const action = els.banner.dataset.action;
  if (action === 'hooks') cody.installHooks();
  else if (action === 'install' || action === 'download') runUpdateAction(action);
});
$('btn-update').addEventListener('click', (e) => runUpdateAction(e.currentTarget.dataset.action));
$('tg-connect').addEventListener('click', () => telegramConnect());
$('tg-reconnect').addEventListener('click', () => telegramConnect());
$('tg-cancel').addEventListener('click', () => cody.telegramCancel());
$('tg-test').addEventListener('click', () => telegramRequest(() => cody.telegramTest()));
$('tg-disconnect').addEventListener('click', () => cody.telegramDisconnect());
$('tg-manual-link').addEventListener('click', () => { tgManualOpen = true; renderTelegram(); $('tg-chat-id').focus(); });
$('tg-manual').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await telegramRequest(() => cody.telegramSetChatId($('tg-chat-id').value));
  if (r && r.ok) { tgManualOpen = false; $('tg-chat-id').value = ''; renderTelegram(); }
});
for (const b of document.querySelectorAll('[data-theme-choice]')) b.addEventListener('click', () => cody.setSetting('theme', b.dataset.themeChoice));
for (const input of document.querySelectorAll('[data-setting]')) input.addEventListener('change', () => cody.setSetting(input.dataset.setting, input.checked));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view === 'settings') { view = 'list'; renderView(); } });

cody.onSessions((list) => { sessions = list; render(); });
cody.onUiState((s) => { ui = s; renderUi(); render(); });
cody.onToast((msg) => toast(msg));
cody.onShowSettings(() => setView('settings'));
cody.onReveal((id) => {
  view = 'list'; renderView();
  const entry = rows.get(id);
  if (!entry) return;
  entry.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  entry.el.classList.remove('flash');
  void entry.el.offsetWidth;
  entry.el.classList.add('flash');
  setTimeout(() => entry.el.classList.remove('flash'), 1800);
});

renderUi();
render();
cody.ready();
