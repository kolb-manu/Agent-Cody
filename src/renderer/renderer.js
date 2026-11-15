'use strict';
/* global cody */

const PALETTE = ['#8b7cf6', '#6ea8fe', '#3ecf8e', '#f5a524', '#f06ba8', '#2cc5d2', '#f2785a', '#b4d455'];
const STATE_LABEL = {
  working: 'Working', attention: 'Needs you', done: 'Done', error: 'Error',
  idle: 'Ready', stale: 'Quiet', ended: 'Ended',
};

const $ = (id) => document.getElementById(id);
const els = {
  expanded: $('expanded'), pill: $('pill'), list: $('list'), empty: $('empty'), emptyText: $('empty-text'),
  btnInstall: $('btn-install'), banner: $('banner'), count: $('count'), toast: $('toast'),
  pillText: $('pill-text'), pillDot: $('pill-dot'),
};

// ---------- icons (static markup only; never interpolate session data into HTML) ----------
const ICON = {
  bell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8z"/><path d="M6.5 14a1.6 1.6 0 0 0 3 0"/></svg>',
  bellOff: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11V7a4 4 0 0 1 6.5-3.1M12 7v4l1.2 1.5H5"/><path d="M6.5 14a1.6 1.6 0 0 0 3 0"/><path d="M2 2l12 12"/></svg>',
  more: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  collapse: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 8h9"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

/** "Cody": rounded robot head with an antenna. Eyes change with state. */
function mascotSVG(colorIndex, state) {
  const c = PALETTE[Math.abs(colorIndex | 0) % PALETTE.length];
  const dark = '#14151b';
  let eyes;
  if (state === 'done') {
    eyes = `<path class="m-eye" d="M9.2 18.5q1.6-2 3.2 0M17.6 18.5q1.6-2 3.2 0" stroke="${dark}" stroke-width="1.7" fill="none" stroke-linecap="round"/>`;
  } else if (state === 'error') {
    eyes = `<path d="M9.4 16.4l2.8 2.8M12.2 16.4l-2.8 2.8M17.8 16.4l2.8 2.8M20.6 16.4l-2.8 2.8" stroke="${dark}" stroke-width="1.6" stroke-linecap="round"/>`;
  } else if (state === 'ended' || state === 'stale') {
    eyes = `<path d="M9.2 18h3.2M17.6 18h3.2" stroke="${dark}" stroke-width="1.7" stroke-linecap="round"/>`;
  } else if (state === 'attention') {
    eyes = `<circle class="m-eye" cx="10.8" cy="17.8" r="2.3" fill="${dark}"/><circle class="m-eye" cx="19.2" cy="17.8" r="2.3" fill="${dark}"/>`;
  } else {
    eyes = `<circle class="m-eye" cx="10.8" cy="18" r="1.8" fill="${dark}"/><circle class="m-eye" cx="19.2" cy="18" r="1.8" fill="${dark}"/>`;
  }
  const ball = state === 'attention' ? '#f5a524' : c;
  return `<svg viewBox="0 0 30 30" aria-hidden="true">
    <rect x="14.1" y="5.5" width="1.8" height="5" rx=".9" fill="${c}"/>
    <circle class="m-ball" cx="15" cy="4.6" r="2.4" fill="${ball}"/>
    <rect x="3.5" y="9.5" width="23" height="17" rx="6" fill="${c}"/>
    ${eyes}
  </svg>`;
}

// ---------- state ----------
let ui = { collapsed: false, muted: false, hookStatus: 'installed', serverError: null, port: 0 };
let sessions = [];
const rows = new Map(); // id -> { el, refs }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function createRow(s) {
  const row = el('div', 'row');
  row.tabIndex = 0;
  row.dataset.id = s.id;
  const avatar = el('div', 'avatar');
  const body = el('div', 'body');
  const line1 = el('div', 'line1');
  const name = el('span', 'name');
  const chip = el('span', 'chip');
  line1.append(name, chip);
  const activity = el('div', 'activity');
  const attn = el('div', 'attn-msg');
  const progress = el('div', 'progress');
  const bar = el('div', 'bar');
  const fill = el('i');
  bar.append(fill);
  const frac = el('span', 'frac');
  progress.append(bar, frac);
  const step = el('div', 'step');
  body.append(line1, activity, attn, progress, step);
  const dismiss = el('button', 'dismiss');
  dismiss.innerHTML = ICON.close;
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss session');
  row.append(avatar, body, dismiss);

  dismiss.addEventListener('click', (e) => { e.stopPropagation(); removeRow(s.id, true); cody.dismiss(s.id); });
  const activate = async () => {
    const r = await cody.activate(s.id);
    if (r && !r.ok) toast(`Can't bring this session's window forward${r.reason ? `: ${r.reason}` : ''}`);
  };
  row.addEventListener('click', activate);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });

  const entry = { el: row, refs: { avatar, name, chip, activity, attn, progress, fill, frac, step }, last: {} };
  rows.set(s.id, entry);
  return entry;
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

function updateRow(entry, s) {
  const { el: row, refs, last } = entry;
  const ended = s.state === 'ended';
  row.className = `row state-${s.state}${s.state === 'attention' ? ' attention' : ''}${s.state === 'error' ? ' error' : ''}${ended ? ' ended' : ''}${row.classList.contains('flash') ? ' flash' : ''}`;
  if (last.avatarKey !== `${s.colorIndex}:${s.state}`) {
    refs.avatar.innerHTML = mascotSVG(s.colorIndex, s.state); // colorIndex is a number; state is from a fixed set
    last.avatarKey = `${s.colorIndex}:${s.state}`;
  }
  setText(refs.name, s.name);
  setText(refs.chip, s.subagents > 0 && s.state === 'working' ? `${STATE_LABEL.working} +${s.subagents}` : (STATE_LABEL[s.state] || s.state));
  setText(refs.activity, s.activity || '');
  row.title = [s.cwd, s.title, s.detail].filter(Boolean).join('\n');

  const attnText = s.state === 'attention' && s.attention ? s.attention.message : '';
  refs.attn.hidden = !attnText;
  setText(refs.attn, attnText);

  if (s.steps && s.steps.total > 0) {
    refs.progress.hidden = false;
    refs.fill.style.width = `${Math.round((s.steps.done / s.steps.total) * 100)}%`;
    setText(refs.frac, `${s.steps.done}/${s.steps.total}`);
    const showStep = s.steps.current && s.steps.current !== s.activity && s.state !== 'attention';
    refs.step.hidden = !showStep;
    setText(refs.step, showStep ? s.steps.current : '');
  } else {
    refs.progress.hidden = true;
    refs.step.hidden = true;
  }

  // Ended sessions fade out shortly before main removes them.
  if (ended && s.fadeAt && !entry.fadeTimer) {
    entry.fadeTimer = setTimeout(() => row.classList.add('fading'), Math.max(0, s.fadeAt - Date.now() - 900));
  } else if (!ended && entry.fadeTimer) {
    clearTimeout(entry.fadeTimer); entry.fadeTimer = null; row.classList.remove('fading');
  }
}

function removeRow(id, immediate) {
  const entry = rows.get(id);
  if (!entry) return;
  rows.delete(id);
  clearTimeout(entry.fadeTimer);
  entry.el.classList.add('leaving');
  setTimeout(() => entry.el.remove(), immediate ? 180 : 500);
}

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
  const attention = active.filter((s) => s.state === 'attention').length;
  const working = active.filter((s) => s.state === 'working').length;
  els.count.textContent = active.length ? String(active.length) : '';
  els.empty.hidden = sessions.length > 0;
  updateEmpty();

  const n = active.length;
  els.pillText.textContent = attention
    ? `${attention} need${attention === 1 ? 's' : ''} you · ${n}`
    : `${n} agent${n === 1 ? '' : 's'}`;
  const anyError = active.some((s) => s.state === 'error');
  els.pillDot.className = `dot ${attention ? 'attention' : anyError ? 'error' : working ? 'working' : n ? 'done' : ''}`;
  document.title = `Agent Cody (${n})`;
}

function updateEmpty() {
  const needsHooks = ui.hookStatus !== 'installed';
  els.btnInstall.hidden = !needsHooks;
  if (needsHooks) {
    els.emptyText.textContent = ui.hookStatus === 'partial'
      ? 'Some Claude Code hooks are missing. Reinstall them to see all activity.'
      : 'Connect Claude Code by installing the Agent Cody hooks.';
  } else {
    els.emptyText.innerHTML = 'No active sessions. Start <code>claude</code> in a terminal and it shows up here.';
  }
}

function renderUi() {
  els.expanded.hidden = ui.collapsed;
  els.pill.hidden = !ui.collapsed;
  const mute = $('btn-mute');
  mute.innerHTML = ui.muted ? ICON.bellOff : ICON.bell;
  mute.classList.toggle('active', ui.muted);
  mute.title = ui.muted ? 'Sounds muted (click to unmute)' : 'Mute notification sounds';
  mute.setAttribute('aria-pressed', String(ui.muted));
  if (ui.serverError) {
    els.banner.hidden = false; els.banner.className = 'banner'; els.banner.textContent = ui.serverError;
  } else if (ui.hookStatus === 'partial' && sessions.length) {
    els.banner.hidden = false; els.banner.className = 'banner info'; els.banner.textContent = 'Some hooks are missing. Click to reinstall.';
  } else {
    els.banner.hidden = true;
  }
  updateEmpty();
}

let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

// ---------- wiring ----------
$('brand-mark').innerHTML = mascotSVG(0, 'idle');
$('empty-mark').innerHTML = mascotSVG(0, 'idle');
$('btn-menu').innerHTML = ICON.more;
$('btn-collapse').innerHTML = ICON.collapse;
$('btn-hide').innerHTML = ICON.close;
$('btn-mute').addEventListener('click', () => cody.toggleMute());
$('btn-menu').addEventListener('click', () => cody.menu());
$('btn-collapse').addEventListener('click', () => cody.toggleCollapse());
$('btn-hide').addEventListener('click', () => cody.hide());
$('pill-btn').addEventListener('click', () => cody.toggleCollapse());
els.btnInstall.addEventListener('click', () => cody.installHooks());
els.banner.addEventListener('click', () => { if (els.banner.classList.contains('info')) cody.installHooks(); });

cody.onSessions((list) => { sessions = list; render(); });
cody.onUiState((s) => { ui = s; renderUi(); render(); });
cody.onReveal((id) => {
  const entry = rows.get(id);
  if (!entry) return;
  entry.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  entry.el.classList.remove('flash');
  void entry.el.offsetWidth;
  entry.el.classList.add('flash');
  setTimeout(() => entry.el.classList.remove('flash'), 2000);
});

renderUi();
render();
cody.ready();
