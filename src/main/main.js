'use strict';
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, dialog, shell } = require('electron');
const { SessionStore } = require('./sessions');
const { startServer } = require('./server');
const { Settings } = require('./settings');
const { Notifier } = require('./notifier');
const { focusSession } = require('./focus');
const { mascotPNG } = require('./icon-draw');
const hooks = require('./hooks-installer');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const PILL = { width: 176, height: 40 };
const MIN_EXPANDED = { width: 300, height: 150 };
const DEFAULT_EXPANDED = { width: 360, height: 340 };
const HOOK_SOURCE = path.join(__dirname, '..', '..', 'hook', 'agent-cody-hook.js');

// Dev/testing: isolate profile (settings + window state) from your real one.
if (process.env.AGENT_CODY_USER_DATA) app.setPath('userData', process.env.AGENT_CODY_USER_DATA);
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
if (IS_WIN) app.setAppUserModelId('com.agentcody.widget');

let win = null;
let tray = null;
let quitting = false;
let settings, store, notifier;
let serverError = null;
let hookStatus = 'not-installed';
const icons = {};

// ---------- window ----------

function workAreaFor(bounds) { return screen.getDisplayMatching(bounds).workArea; }

function clampToScreen(b) {
  const wa = workAreaFor(b);
  const width = Math.min(b.width, wa.width), height = Math.min(b.height, wa.height);
  return {
    width, height,
    x: Math.round(Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width)),
    y: Math.round(Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height)),
  };
}

function isOnScreen(b) {
  return screen.getAllDisplays().some(({ workArea: w }) => b.x < w.x + w.width - 40 && b.x + b.width > w.x + 40 && b.y >= w.y - 10 && b.y < w.y + w.height - 30);
}

function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { ...DEFAULT_EXPANDED, x: wa.x + wa.width - DEFAULT_EXPANDED.width - 24, y: wa.y + 24 };
}

function expandedBounds() {
  const b = settings.get('bounds');
  return b && isOnScreen(b) ? b : defaultBounds();
}

/** Keep the right edge fixed when the window sits on the right half of its screen. */
function anchoredBounds(from, size) {
  const wa = workAreaFor(from);
  const rightSide = from.x + from.width / 2 > wa.x + wa.width / 2;
  return clampToScreen({ x: rightSide ? from.x + from.width - size.width : from.x, y: from.y, ...size });
}

function createWindow() {
  const collapsed = Boolean(settings.get('collapsed'));
  const exp = expandedBounds();
  const start = collapsed ? anchoredBounds(exp, PILL) : exp;
  win = new BrowserWindow({
    ...start,
    minWidth: collapsed ? PILL.width : MIN_EXPANDED.width,
    minHeight: collapsed ? PILL.height : MIN_EXPANDED.height,
    frame: false,
    resizable: !collapsed,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#14151b',
    title: 'Agent Cody',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  // Dev/testing: AGENT_CODY_SCREENSHOT=<file.png>[,<delayMs>] writes a capture of the widget.
  if (process.env.AGENT_CODY_SCREENSHOT) {
    const [file, delay] = process.env.AGENT_CODY_SCREENSHOT.split(',');
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      require('fs').writeFileSync(file, img.toPNG());
    }, parseInt(delay || '3000', 10));
  }

  let saveTimer = null;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      if (settings.get('collapsed')) {
        // Moving the pill moves where the expanded window will reappear.
        const prev = expandedBounds();
        settings.set('bounds', anchoredBoundsInverse(b, prev));
      } else {
        settings.set('bounds', b);
      }
    }, 400);
  };
  win.on('move', saveBounds);
  win.on('resize', saveBounds);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); updateTrayMenu(); } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/** Given the pill bounds, compute expanded bounds that anchor the same way. */
function anchoredBoundsInverse(pill, prevExpanded) {
  const wa = workAreaFor(pill);
  const rightSide = pill.x + pill.width / 2 > wa.x + wa.width / 2;
  const { width, height } = prevExpanded;
  return { width, height, x: rightSide ? pill.x + pill.width - width : pill.x, y: pill.y };
}

function setCollapsed(collapsed) {
  if (!win) return;
  const wasCollapsed = Boolean(settings.get('collapsed'));
  if (collapsed === wasCollapsed) return;
  if (collapsed) {
    settings.set('bounds', win.getBounds());
    settings.set('collapsed', true);
    win.setMinimumSize(PILL.width, PILL.height);
    win.setResizable(false);
    win.setBounds(anchoredBounds(win.getBounds(), PILL));
  } else {
    const prev = expandedBounds();
    settings.set('collapsed', false);
    win.setResizable(true);
    win.setMinimumSize(MIN_EXPANDED.width, MIN_EXPANDED.height);
    win.setBounds(clampToScreen(anchoredBoundsInverse(win.getBounds(), prev)));
  }
  sendUiState();
}

function showWindow({ focus = true, expand = false } = {}) {
  if (!win) return;
  if (expand) setCollapsed(false);
  if (focus) {
    if (IS_MAC) app.focus({ steal: true });
    win.show(); win.focus();
  } else {
    win.showInactive();
  }
  updateTrayMenu();
}

// ---------- renderer sync ----------

let sendTimer = null;
function scheduleSessionsSend() {
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    const list = store.list();
    if (win && !win.isDestroyed()) win.webContents.send('sessions', list);
    updateTray(list);
  }, 60);
}

function sendUiState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('ui-state', {
    collapsed: Boolean(settings.get('collapsed')),
    muted: Boolean(settings.get('muted')),
    hookStatus,
    port: settings.get('port'),
    serverError,
    platform: process.platform,
  });
  updateTrayMenu();
}

// ---------- tray ----------

function buildIcons() {
  const img = (opts) => {
    const i = nativeImage.createEmpty();
    i.addRepresentation({ scaleFactor: 1, buffer: mascotPNG(16, opts) });
    i.addRepresentation({ scaleFactor: 2, buffer: mascotPNG(32, opts) });
    return i;
  };
  if (IS_MAC) {
    icons.normal = img({ mode: 'template' });
    icons.normal.setTemplateImage(true);
    icons.attention = icons.normal;
  } else {
    icons.normal = img({ mode: 'color', color: '#8B7CF6' });
    icons.attention = img({ mode: 'color', color: '#8B7CF6', badge: '#F5A524' });
  }
}

function createTray() {
  tray = new Tray(icons.normal);
  tray.setToolTip('Agent Cody');
  if (!IS_MAC) tray.on('click', () => (win.isVisible() ? win.hide() : showWindow()));
  updateTrayMenu();
}

function updateTray(list) {
  if (!tray) return;
  const active = list.filter((s) => s.state !== 'ended');
  const attention = active.filter((s) => s.state === 'attention').length;
  tray.setToolTip(`Agent Cody: ${active.length} session${active.length === 1 ? '' : 's'}${attention ? `, ${attention} need${attention === 1 ? 's' : ''} you` : ''}`);
  tray.setImage(attention ? icons.attention : icons.normal);
  if (IS_MAC) tray.setTitle(attention ? String(attention) : '');
}

function menuTemplate() {
  return [
    { label: win && win.isVisible() ? 'Hide Agent Cody' : 'Show Agent Cody', click: () => (win.isVisible() ? win.hide() : showWindow()), },
    { label: settings.get('collapsed') ? 'Expand' : 'Collapse to pill', click: () => setCollapsed(!settings.get('collapsed')) },
    { type: 'separator' },
    { label: 'Mute sounds', type: 'checkbox', checked: Boolean(settings.get('muted')), click: () => toggleMute() },
    { type: 'separator' },
    { label: hookStatus === 'installed' ? 'Reinstall Claude Code hooks…' : 'Install Claude Code hooks…', click: () => installHooks() },
    { label: 'Uninstall Claude Code hooks…', enabled: hookStatus !== 'not-installed', click: () => uninstallHooks() },
    { label: 'Open settings folder', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quit Agent Cody', click: () => { quitting = true; app.quit(); } },
  ];
}

function updateTrayMenu() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function toggleMute() {
  settings.set('muted', !settings.get('muted'));
  sendUiState();
}

// ---------- hooks install ----------

async function confirm(message, detail, okLabel) {
  if (IS_MAC) app.focus({ steal: true });
  const r = await dialog.showMessageBox({ type: 'question', buttons: [okLabel, 'Cancel'], defaultId: 0, cancelId: 1, message, detail });
  return r.response === 0;
}

async function installHooks() {
  const ok = await confirm(
    'Install Claude Code hooks?',
    `Agent Cody will add hook entries to ${hooks.defaultSettingsPath()}.\n\n` +
    '• A backup of the file is created first.\n• Existing hooks are kept untouched.\n' +
    '• The hook only talks to 127.0.0.1 and exits immediately if Agent Cody isn\'t running.',
    'Install',
  );
  if (!ok) return;
  try {
    const r = hooks.install({ hookSource: HOOK_SOURCE });
    refreshHookStatus();
    await dialog.showMessageBox({
      type: r.nodeFound ? 'info' : 'warning',
      message: 'Hooks installed',
      detail: `Added hooks for ${r.events} events.\n\nHook script: ${r.hookPath}\nNode: ${r.node}` +
        (r.backupPath ? `\nBackup: ${r.backupPath}` : '') +
        (r.nodeFound ? '' : '\n\nNode.js was not found. The hook needs Node.js on your PATH; until then it does nothing.') +
        '\n\nNew Claude Code sessions pick this up automatically. Restart sessions that are already running.',
    });
  } catch (err) {
    dialog.showErrorBox('Could not install hooks', err.message);
  }
}

async function uninstallHooks() {
  const ok = await confirm('Remove Agent Cody hooks?', `Only Agent Cody's own entries are removed from ${hooks.defaultSettingsPath()} (a backup is created first).`, 'Remove');
  if (!ok) return;
  try {
    const r = hooks.uninstall();
    refreshHookStatus();
    await dialog.showMessageBox({ type: 'info', message: r.removed ? 'Hooks removed' : 'Nothing to remove', detail: r.backupPath ? `Backup: ${r.backupPath}` : '' });
  } catch (err) {
    dialog.showErrorBox('Could not remove hooks', err.message);
  }
}

function refreshHookStatus() {
  hookStatus = hooks.status();
  sendUiState();
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.on('ui-ready', () => { sendUiState(); scheduleSessionsSend(); });
  ipcMain.on('toggle-collapse', () => setCollapsed(!settings.get('collapsed')));
  ipcMain.on('toggle-mute', () => toggleMute());
  ipcMain.on('hide', () => { win.hide(); updateTrayMenu(); });
  ipcMain.on('menu', () => Menu.buildFromTemplate(menuTemplate()).popup({ window: win }));
  ipcMain.on('install-hooks', () => installHooks());
  ipcMain.on('dismiss', (_e, id) => store.dismiss(String(id)));
  ipcMain.handle('activate', async (_e, id) => {
    const s = store.getRaw(String(id));
    if (!s) return { ok: false, reason: 'Session not found' };
    store.acknowledge(s.id);
    return focusSession({ termBundleId: s.termBundleId, termProgram: s.termProgram, pid: s.pid });
  });
}

// ---------- startup ----------

app.on('second-instance', () => showWindow({ expand: true }));
app.on('before-quit', () => { quitting = true; settings && settings.flush(); });
app.on('window-all-closed', (e) => e.preventDefault?.());
app.on('activate', () => showWindow());

app.whenReady().then(async () => {
  if (IS_MAC && app.dock) app.dock.hide();
  settings = new Settings(app.getPath('userData'));
  settings.writeHookConfig();
  store = new SessionStore({
    staleMs: settings.get('staleMinutes') * 60 * 1000,
    fadeMs: settings.get('fadeSeconds') * 1000,
  });
  notifier = new Notifier({ settings, onClick: (id) => { showWindow({ expand: true }); if (win) win.webContents.send('reveal', id); } });
  store.on('change', scheduleSessionsSend);

  buildIcons();
  registerIpc();
  createWindow();
  createTray();
  hookStatus = hooks.status();

  try {
    await startServer({
      port: settings.get('port'),
      onEvent: (evt) => { for (const n of store.handle(evt)) notifier.notify(n); },
    });
  } catch (err) {
    serverError = err.code === 'EADDRINUSE'
      ? `Port ${settings.get('port')} is already in use. Set another port in settings.json (or AGENT_CODY_PORT) and restart.`
      : `Could not start local server: ${err.message}`;
    console.error('[agent-cody]', serverError);
  }
  sendUiState();

  setInterval(() => { for (const n of store.tick()) notifier.notify(n); }, 2000);
  // Hooks can be edited outside the app (CLI, by hand); re-check occasionally.
  setInterval(() => { const s = hooks.status(); if (s !== hookStatus) { hookStatus = s; sendUiState(); } }, 30000);
});
