'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, screen, dialog, shell, net } = require('electron');
const { SessionStore } = require('./sessions');
const { startServer } = require('./server');
const { Settings } = require('./settings');
const { Notifier } = require('./notifier');
const { focusSession } = require('./focus');
const { mascotPNG } = require('./icon-draw');
const hooks = require('./hooks-installer');
const { createLoginItem, LOGIN_ARG } = require('./login-item');
const updateCheck = require('./update-check');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const PILL = { width: 248, height: 40 };
const MIN_EXPANDED = { width: 300, height: 120 };
const DEFAULT_EXPANDED = { width: 340, height: 300 };
const BG = { light: '#FFFFFF', dark: '#1F1E1D' };
const HOOK_SOURCE = path.join(__dirname, '..', '..', 'hook', 'agent-cody-hook.js');
const UPDATE_FIRST_CHECK_MS = 10 * 1000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
let previewTheme = null; // transient theme override from the simulator showcase
let openedAtLogin = false;
/** status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error' */
let update = { status: 'idle', version: null, message: null };
const loginItem = createLoginItem({ app });
const icons = {};

// ---------- theme ----------

function resolvedTheme() {
  if (previewTheme) return previewTheme;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function applyTheme() {
  nativeTheme.themeSource = settings.get('theme'); // also themes native menus and dialogs
  if (win && !win.isDestroyed()) win.setBackgroundColor(BG[resolvedTheme()]);
  sendUiState();
}

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

/** Given the pill bounds, compute expanded bounds that anchor the same way. */
function anchoredBoundsInverse(pill, prevExpanded) {
  const wa = workAreaFor(pill);
  const rightSide = pill.x + pill.width / 2 > wa.x + wa.width / 2;
  const { width, height } = prevExpanded;
  return { width, height, x: rightSide ? pill.x + pill.width - width : pill.x, y: pill.y };
}

function applyAlwaysOnTop() {
  if (!win) return;
  const on = settings.get('alwaysOnTop') !== false;
  win.setAlwaysOnTop(on, 'floating');
  if (IS_MAC) win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: on });
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
    skipTaskbar: true,
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: BG[resolvedTheme()],
    title: 'Agent Cody',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyAlwaysOnTop();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (openedAtLogin) {
      // Automatic start: quiet. Restore the last state (expanded/pill/hidden) without taking focus.
      if (!settings.get('hidden')) win.showInactive();
    } else {
      win.show(); // manual start: behave normally
    }
  });
  // Remember whether the widget was hidden to the tray (not when hiding because we're quitting).
  win.on('hide', () => { if (!quitting) { settings.set('hidden', true); updateTrayMenu(); } });
  win.on('show', () => { settings.set('hidden', false); updateTrayMenu(); });
  // Dev/testing: AGENT_CODY_SCREENSHOT='[{"file":"a.png","at":3000,"js":"optional UI action"}]'
  // writes captures of the widget (used to check the UI without clicking).
  if (process.env.AGENT_CODY_SCREENSHOT) {
    let shots = [];
    try { shots = JSON.parse(process.env.AGENT_CODY_SCREENSHOT); } catch (_) { shots = [{ file: process.env.AGENT_CODY_SCREENSHOT, at: 3000 }]; }
    for (const shot of shots) {
      setTimeout(async () => {
        if (shot.js) { await win.webContents.executeJavaScript(shot.js).catch(() => {}); await new Promise((r) => setTimeout(r, 400)); }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(shot.file, img.toPNG());
      }, shot.at || 3000);
    }
  }

  let saveTimer = null;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      if (settings.get('collapsed')) settings.set('bounds', anchoredBoundsInverse(b, expandedBounds()));
      else settings.set('bounds', b);
    }, 400);
  };
  win.on('move', saveBounds);
  win.on('resize', saveBounds);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); updateTrayMenu(); } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function setCollapsed(collapsed) {
  if (!win) return;
  if (collapsed === Boolean(settings.get('collapsed'))) return;
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

/** Which first-run question to show inside the widget, if any. Installed app only. */
function onboardingStep() {
  if (!app.isPackaged && process.env.AGENT_CODY_FORCE_ONBOARDING !== '1') return null;
  const ob = settings.get('onboarding') || {};
  if (!ob.loginAsked) return 'login';
  if (!ob.hooksAsked && hookStatus !== 'installed') return 'hooks';
  return null;
}

function sendUiState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('ui-state', {
    collapsed: Boolean(settings.get('collapsed')),
    theme: settings.get('theme'),
    resolvedTheme: resolvedTheme(),
    sound: settings.get('sound') !== false,
    notify: settings.get('notify'),
    alwaysOnTop: settings.get('alwaysOnTop') !== false,
    loginItem: loginItem.get(), // read from the OS every time, never cached
    onboarding: onboardingStep(),
    hookStatus,
    port: settings.get('port'),
    serverError,
    platform: process.platform,
    appVersion: app.getVersion(),
    checkUpdates: settings.get('checkUpdates') !== false,
    update,
  });
  updateTrayMenu();
}

const sendToRenderer = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

// ---------- open (focus a session's window) ----------

async function openSession(id, { fromNotification = false } = {}) {
  const s = store.getRaw(String(id));
  if (!s) return { ok: false, method: 'none', message: 'That session is gone.' };
  store.acknowledge(s.id);
  let r = await focusSession({ name: s.name, cwd: s.cwd, termBundleId: s.termBundleId, termProgram: s.termProgram, pid: s.pid });
  if (!r.ok) {
    // Fallback: bring the project folder to the front.
    const reason = r.message || 'Couldn’t find the session’s window.';
    const err = s.cwd && fs.existsSync(s.cwd) ? await shell.openPath(s.cwd) : 'missing';
    r = err === ''
      ? { ok: true, method: 'folder', message: `${reason} Opened the project folder instead.` }
      : { ok: false, method: 'none', message: `${reason}${s.cwd ? ` It runs in ${s.cwd}.` : ''}` };
  }
  if (fromNotification) {
    // If we couldn't reach the exact window, show the widget so the hint is visible.
    if (r.method !== 'window') showWindow({ focus: r.method === 'none', expand: true });
    sendToRenderer('reveal', s.id);
    if (r.message) sendToRenderer('toast', r.message);
  }
  return r;
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
    icons.normal = img({ mode: 'color', color: '#D97757' });
    icons.attention = img({ mode: 'color', color: '#D97757', badge: '#FAF9F5' });
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
  tray.setToolTip(`Agent Cody: ${active.length} agent${active.length === 1 ? '' : 's'}${attention ? `, ${attention} need${attention === 1 ? 's' : ''} you` : ''}`);
  tray.setImage(attention ? icons.attention : icons.normal);
  if (IS_MAC) tray.setTitle(attention ? String(attention) : '');
}

function menuTemplate() {
  return [
    { label: win && win.isVisible() ? 'Hide Agent Cody' : 'Show Agent Cody', click: () => (win.isVisible() ? win.hide() : showWindow()) },
    { label: settings.get('collapsed') ? 'Expand' : 'Minimise to pill', click: () => setCollapsed(!settings.get('collapsed')) },
    { label: 'Settings…', click: () => { showWindow({ expand: true }); sendToRenderer('show-settings'); } },
    { type: 'separator' },
    ...(update.status === 'available' && IS_MAC ? [{ label: `Download Agent Cody ${update.version}`, click: () => { showWindow({ expand: true }); downloadUpdate(); } }] : []),
    ...(update.status === 'ready' ? [{ label: 'Restart to update', click: () => installUpdate() }] : []),
    { label: 'Check for updates…', enabled: update.status !== 'checking', click: () => { showWindow({ expand: true }); sendToRenderer('show-settings'); checkForUpdates({ manual: true }); } },
    { type: 'separator' },
    { label: 'Play a sound', type: 'checkbox', checked: settings.get('sound') !== false, click: () => updateSetting('sound', !(settings.get('sound') !== false)) },
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

// ---------- settings ----------

/** Turn "Start when I log in" on/off and report what the OS actually did. */
function setLoginItem(on) {
  const r = loginItem.set(Boolean(on));
  if (!r.supported) sendToRenderer('toast', 'Start at login only works in the installed app.');
  else if (r.error) sendToRenderer('toast', `Couldn’t change the login item: ${r.error}`);
  else if (on && r.requiresApproval) sendToRenderer('toast', 'Almost there: allow Agent Cody in System Settings › General › Login Items.');
  else if (on && !r.enabled) sendToRenderer('toast', 'The system didn’t accept the login item. On macOS this needs a signed app.');
  sendUiState();
  return r;
}

function openLoginItemsSettings() {
  const url = IS_MAC ? 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension' : IS_WIN ? 'ms-settings:startupapps' : null;
  if (url) shell.openExternal(url).catch(() => {});
}

async function answerOnboarding(step, yes) {
  const ob = { ...(settings.get('onboarding') || {}) };
  if (step === 'login') {
    ob.loginAsked = true;
    settings.set('onboarding', ob);
    if (yes) setLoginItem(true);
  } else if (step === 'hooks') {
    ob.hooksAsked = true;
    settings.set('onboarding', ob);
    if (yes) {
      // The in-widget card already explained what happens, so no extra confirmation dialog.
      try {
        const r = hooks.install({ hookSource: HOOK_SOURCE });
        hookStatus = hooks.status();
        sendToRenderer('toast', r.nodeFound
          ? 'Hooks installed. New Claude Code sessions will show up here.'
          : 'Hooks installed, but Node.js wasn’t found. Install Node.js for them to work.');
      } catch (err) {
        sendToRenderer('toast', `Couldn’t install hooks: ${err.message}`);
      }
    }
  }
  settings.flush();
  sendUiState();
}

function updateSetting(key, value) {
  if (!settings.setUser(key, value)) return false;
  if (key === 'theme') { previewTheme = null; applyTheme(); }
  if (key === 'alwaysOnTop') applyAlwaysOnTop();
  if (key === 'checkUpdates' && value) checkForUpdates();
  sendUiState();
  return true;
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

// ---------- updates ----------
// Windows: electron-updater downloads in the background and installs on restart/quit.
// macOS: the ad-hoc signed app can't update itself, so we only tell the user and open the DMG.

let winUpdater = null;      // electron-updater's autoUpdater (Windows only)
let macRelease = null;      // { version, downloadUrl, pageUrl } of a newer release (macOS only)
let manualCheck = false;    // the current check was started by the user, so errors get shown
let updateCheckRunning = false;

function updatesSupported() {
  return app.isPackaged || process.env.AGENT_CODY_FORCE_UPDATE_CHECK === '1';
}

function setUpdate(patch) {
  update = { ...update, ...patch };
  sendUiState();
}

/** One notification per new version, remembered across restarts. */
function notifyNewVersion(version, body) {
  if (settings.get('updateNotified') === version) return;
  settings.set('updateNotified', version);
  settings.flush();
  if (manualCheck) return; // they're looking at Settings already
  notifier.notifyApp({ title: `Agent Cody ${version} is available`, body, onClick: () => showWindow({ expand: true }) });
}

function updateErrorMessage(err) {
  const msg = String((err && err.message) || err || '');
  if (/net::ERR_|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timed? ?out|aborted/i.test(msg)) {
    return 'Couldn’t reach GitHub. Check your internet connection and try again.';
  }
  if (/\b(403|429)\b|rate limit/i.test(msg)) return 'GitHub is busy right now. Try again in a little while.';
  return 'Couldn’t check for updates. Try again later.';
}

function setupWinUpdater() {
  if (!IS_WIN || winUpdater) return;
  ({ autoUpdater: winUpdater } = require('electron-updater'));
  winUpdater.logger = console;
  winUpdater.autoDownload = true;
  winUpdater.autoInstallOnAppQuit = true;
  // From source: reads dev-app-update.yml in the project folder (only with AGENT_CODY_FORCE_UPDATE_CHECK=1).
  if (!app.isPackaged) winUpdater.forceDevUpdateConfig = true;
  winUpdater.on('update-available', (info) => setUpdate({ status: 'downloading', version: info.version, message: null }));
  winUpdater.on('update-not-available', () => setUpdate({ status: 'up-to-date', version: null, message: null }));
  winUpdater.on('update-downloaded', (info) => {
    setUpdate({ status: 'ready', version: info.version, message: null });
    notifyNewVersion(info.version, 'It’s downloaded. Restart Agent Cody to update, or it updates next time you quit.');
  });
  // Check errors also reject checkForUpdates() and download errors reject downloadPromise; both are
  // handled there. This listener only logs (an 'error' event without a listener would throw).
  winUpdater.on('error', (err) => console.warn('[agent-cody] update:', err && err.message));
}

/** The Mac's real CPU: an Intel build running under Rosetta on Apple Silicon should get the arm64 DMG. */
function macArch() { return app.runningUnderARM64Translation ? 'arm64' : process.arch; }

async function checkMac() {
  const res = await net.fetch(updateCheck.LATEST_RELEASE_URL, {
    headers: { 'User-Agent': `Agent-Cody/${app.getVersion()}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) { macRelease = null; return setUpdate({ status: 'up-to-date', version: null, message: null }); } // no releases yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const json = await res.json();
  if (!updateCheck.parseLatestRelease(json, macArch())) throw new Error('Unexpected reply from GitHub');
  macRelease = updateCheck.newerRelease(json, app.getVersion(), macArch());
  if (!macRelease) return setUpdate({ status: 'up-to-date', version: null, message: null });
  // Keep the "how to install" message if this version was already being shown.
  if (update.status !== 'available' || update.version !== macRelease.version) setUpdate({ status: 'available', version: macRelease.version, message: null });
  notifyNewVersion(macRelease.version, 'Click Download in the Agent Cody widget to get it.');
}

/** Automatic checks stay silent when something goes wrong; manual ones say what happened. */
async function checkForUpdates({ manual = false } = {}) {
  if (!updatesSupported()) {
    if (manual) setUpdate({ status: 'error', message: 'Updates only work in the installed app.' });
    return;
  }
  if (updateCheckRunning) return;
  if (update.status === 'ready' || update.status === 'downloading') { if (manual) sendUiState(); return; } // Windows: already on its way
  updateCheckRunning = true;
  manualCheck = manual;
  if (manual) setUpdate({ status: 'checking', message: null });
  try {
    if (IS_WIN) {
      setupWinUpdater();
      const r = await winUpdater.checkForUpdates();
      if (!r && manual) setUpdate({ status: 'error', message: 'Updates only work in the installed app.' });
      if (r && r.downloadPromise) {
        r.downloadPromise.catch(() => {
          if (update.status !== 'downloading') return;
          setUpdate(manual
            ? { status: 'error', version: null, message: 'Couldn’t download the update. Try again later.' }
            : { status: 'idle', version: null, message: null }); // quietly try again at the next check
        });
      }
    } else if (IS_MAC) {
      await checkMac();
    } else if (manual) {
      setUpdate({ status: 'error', message: 'Download new versions from the GitHub Releases page.' });
    }
  } catch (err) {
    console.warn('[agent-cody] update check failed:', err && err.message);
    if (manual) setUpdate({ status: 'error', message: updateErrorMessage(err) }); // automatic: keep whatever we knew
  } finally {
    updateCheckRunning = false;
    manualCheck = false;
  }
}

/** macOS: open the DMG in the browser and explain the swap. Windows: install if it's ready. */
function downloadUpdate() {
  if (IS_WIN) { if (update.status === 'ready') installUpdate(); else checkForUpdates({ manual: true }); return; }
  if (!macRelease) return;
  shell.openExternal(macRelease.downloadUrl).catch(() => shell.openExternal(macRelease.pageUrl).catch(() => {}));
  setUpdate({
    message: `When the download finishes: open the DMG, quit Agent Cody, then drag the new Agent Cody into Applications and choose Replace. Your settings and hooks are kept. If macOS asks, allow it in Privacy & Security like the first time.`,
  });
  sendToRenderer('toast', 'Downloading in your browser. Open the DMG, quit Agent Cody and drag the new one into Applications. Your settings stay.');
}

function installUpdate() {
  if (!IS_WIN || !winUpdater || update.status !== 'ready') return;
  quitting = true; // otherwise win.on('close') just hides the window
  settings.flush();
  setImmediate(() => winUpdater.quitAndInstall(true, true)); // silent install, then start again
}

function scheduleUpdateChecks() {
  if (!updatesSupported()) return;
  const auto = () => { if (settings.get('checkUpdates') !== false) checkForUpdates(); };
  setTimeout(auto, UPDATE_FIRST_CHECK_MS);
  setInterval(auto, UPDATE_INTERVAL_MS);
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.on('ui-ready', () => { sendUiState(); scheduleSessionsSend(); });
  ipcMain.on('toggle-collapse', () => setCollapsed(!settings.get('collapsed')));
  ipcMain.on('install-hooks', () => installHooks());
  ipcMain.on('uninstall-hooks', () => uninstallHooks());
  ipcMain.on('dismiss', (_e, id) => store.dismiss(String(id)));
  ipcMain.handle('set-setting', (_e, key, value) => updateSetting(String(key), value));
  ipcMain.handle('open', (_e, id) => openSession(id));
  ipcMain.handle('set-login-item', (_e, on) => setLoginItem(on));
  ipcMain.on('refresh-ui-state', () => sendUiState()); // e.g. Settings opened: re-read the real login-item state
  ipcMain.on('open-login-items', () => openLoginItemsSettings());
  ipcMain.on('onboarding-answer', (_e, step, yes) => answerOnboarding(String(step), Boolean(yes)));
  ipcMain.on('check-for-updates', () => checkForUpdates({ manual: true }));
  ipcMain.on('download-update', () => downloadUpdate());
  ipcMain.on('install-update', () => installUpdate());
}

// ---------- startup ----------

// Only one copy runs: a second launch just brings the widget forward (unless it's a login start).
app.on('second-instance', (_e, argv) => { if (!argv.includes(LOGIN_ARG)) showWindow({ expand: true }); });
app.on('before-quit', () => { quitting = true; settings && settings.flush(); });
app.on('window-all-closed', (e) => e.preventDefault?.());
app.on('activate', () => showWindow());

app.whenReady().then(async () => {
  if (IS_MAC && app.dock) app.dock.hide();
  settings = new Settings(app.getPath('userData'));
  openedAtLogin = loginItem.wasOpenedAtLogin();
  settings.writeHookConfig();
  nativeTheme.themeSource = settings.get('theme');
  nativeTheme.on('updated', () => applyTheme()); // live-follow OS appearance when theme = system
  store = new SessionStore({
    staleMs: settings.get('staleMinutes') * 60 * 1000,
    fadeMs: settings.get('fadeSeconds') * 1000,
  });
  notifier = new Notifier({ settings, onClick: (id) => openSession(id, { fromNotification: true }) });
  store.on('change', scheduleSessionsSend);

  buildIcons();
  registerIpc();
  createWindow();
  createTray();
  hookStatus = hooks.status();
  loginItem.repairStalePath(); // Windows: keep the Run entry pointing at the current exe

  try {
    await startServer({
      port: settings.get('port'),
      onEvent: (evt) => { for (const n of store.handle(evt)) notifier.notify(n); },
      onControl: (msg) => {
        if (msg && 'preview_theme' in msg) {
          previewTheme = msg.preview_theme === 'light' || msg.preview_theme === 'dark' ? msg.preview_theme : null;
          applyTheme();
        }
      },
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
  scheduleUpdateChecks();
});
