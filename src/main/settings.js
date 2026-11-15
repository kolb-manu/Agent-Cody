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
  muted: false,
  staleMinutes: 10,
  fadeSeconds: 8,
  collapsed: false,
  bounds: null, // {x, y, width, height} of the expanded window
  notifyOn: { permission: true, question: true, done: true, error: true, stopped: true, stale: true },
};

const AGENT_CODY_DIR = path.join(os.homedir(), '.agent-cody');

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...loaded, notifyOn: { ...DEFAULTS.notifyOn, ...(loaded.notifyOn || {}) } };
    } catch (_) { /* first run or unreadable: defaults */ }
    const envPort = parseInt(process.env.AGENT_CODY_PORT || '', 10);
    this.portFromEnv = envPort > 0;
    if (this.portFromEnv) this.data.port = envPort;
    this._timer = null;
  }

  get(k) { return this.data[k]; }

  set(k, v) {
    this.data[k] = v;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
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

module.exports = { Settings, DEFAULTS, AGENT_CODY_DIR };
