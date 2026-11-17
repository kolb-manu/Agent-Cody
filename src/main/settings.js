'use strict';
/*
 * Persisted preferences + window state, stored as JSON in the app's userData dir.
 * Also mirrors the port into ~/.agent-cody/config.json so the hook script finds the app.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  port: 47821,
  theme: 'system',          // 'light' | 'dark' | 'system'
  notify: { attention: true, stopped: true, finished: false },
  sound: true,
  alwaysOnTop: true,
  // "Start when I log in" is deliberately NOT stored here: the OS is the source of truth (login-item.js).
  onboarding: { loginAsked: false, hooksAsked: false },
  staleMinutes: 10,
  fadeSeconds: 8,
  collapsed: false,
  hidden: false,            // window hidden to the tray (restored as-is when started at login)
  bounds: null,             // {x, y, width, height} of the expanded window
  checkUpdates: true,       // look for new versions on launch and every few hours
  updateNotified: null,     // last version we showed a "new version" notification for
  // Telegram alerts. chatId/name/disconnected are only ever set by the main process (telegram.js).
  telegram: { chatId: null, name: null, enabled: true, onlyWhenAway: false, includePreview: true, disconnected: false },
};

/** Keys the UI may change, with validators. */
const USER_SETTINGS = {
  theme: (v) => ['light', 'dark', 'system'].includes(v),
  sound: (v) => typeof v === 'boolean',
  alwaysOnTop: (v) => typeof v === 'boolean',
  checkUpdates: (v) => typeof v === 'boolean',
  'notify.attention': (v) => typeof v === 'boolean',
  'notify.stopped': (v) => typeof v === 'boolean',
  'notify.finished': (v) => typeof v === 'boolean',
  'telegram.enabled': (v) => typeof v === 'boolean',
  'telegram.onlyWhenAway': (v) => typeof v === 'boolean',
  'telegram.includePreview': (v) => typeof v === 'boolean',
};

const AGENT_CODY_DIR = path.join(os.homedir(), '.agent-cody');

/**
 * Migrate settings written by earlier versions:
 *   v0.1: { muted: bool, notifyOn: { permission, question, done, error, stopped, stale } }
 *   v0.2: { openAtLogin: bool }  (now read from the OS instead; the old default was "on"
 *         without asking, so it's dropped and the user gets the first-run question)
 * Old notifyOn values were never editable in the UI, so only explicit opt-outs carry over;
 * "finished" follows the new default (off).
 */
function migrate(loaded) {
  const out = { ...loaded };
  if (typeof out.muted === 'boolean' && out.sound === undefined) out.sound = !out.muted;
  if (out.notifyOn && !out.notify) {
    const n = out.notifyOn;
    out.notify = {
      attention: !(n.permission === false && n.question === false),
      stopped: !(n.error === false && n.stopped === false),
      finished: false,
    };
  }
  delete out.muted;
  delete out.notifyOn;
  delete out.openAtLogin;
  return out;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS, notify: { ...DEFAULTS.notify }, onboarding: { ...DEFAULTS.onboarding }, telegram: { ...DEFAULTS.telegram } };
    this.firstRun = true;
    try {
      const loaded = migrate(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      this.data = {
        ...DEFAULTS, ...loaded,
        notify: { ...DEFAULTS.notify, ...(loaded.notify || {}) },
        onboarding: { ...DEFAULTS.onboarding, ...(loaded.onboarding || {}) },
        telegram: { ...DEFAULTS.telegram, ...(loaded.telegram || {}) },
      };
      this.firstRun = false;
    } catch (_) { /* first run or unreadable: defaults */ }
    const envPort = parseInt(process.env.AGENT_CODY_PORT || '', 10);
    this.portFromEnv = envPort > 0;
    if (this.portFromEnv) this.data.port = envPort;
    this._timer = null;
  }

  get(k) {
    if (k.includes('.')) { const [a, b] = k.split('.'); return (this.data[a] || {})[b]; }
    return this.data[k];
  }

  set(k, v) {
    if (k.includes('.')) {
      const [a, b] = k.split('.');
      this.data[a] = { ...(this.data[a] || {}), [b]: v };
    } else {
      this.data[k] = v;
    }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
  }

  /** Validated update from the UI. Returns true if applied. */
  setUser(k, v) {
    if (!USER_SETTINGS[k] || !USER_SETTINGS[k](v)) return false;
    this.set(k, v);
    return true;
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      const out = { ...this.data };
      if (this.portFromEnv) {
        // Don't persist a temporary env override; keep whatever port was saved before.
        let saved;
        try { saved = JSON.parse(this._fileText() || '{}').port; } catch (_) { /* ignore */ }
        if (saved) out.port = saved; else delete out.port;
      }
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) { console.error('[agent-cody] could not save settings:', err.message); }
  }

  _fileText() { try { return fs.readFileSync(this.file, 'utf8'); } catch (_) { return ''; } }

  /** Tell the hook script which port to use. */
  writeHookConfig() {
    // A temporary AGENT_CODY_PORT override must not redirect the real hooks.
    if (this.portFromEnv) return;
    try {
      fs.mkdirSync(AGENT_CODY_DIR, { recursive: true });
      fs.writeFileSync(path.join(AGENT_CODY_DIR, 'config.json'), JSON.stringify({ port: this.data.port }, null, 2));
    } catch (err) { console.error('[agent-cody] could not write hook config:', err.message); }
  }
}

module.exports = { Settings, DEFAULTS, AGENT_CODY_DIR, migrate };
