'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings, migrate } = require('../src/main/settings.js');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cody-settings-'));

test('defaults: system theme, finished notifications off, everything else on', () => {
  const s = new Settings(dir());
  assert.equal(s.get('theme'), 'system');
  assert.deepEqual(s.get('notify'), { attention: true, stopped: true, finished: false });
  assert.equal(s.get('sound'), true);
  assert.equal(s.get('alwaysOnTop'), true);
  assert.equal(s.get('openAtLogin'), undefined, 'login item is read from the OS, never stored');
  assert.deepEqual(s.get('onboarding'), { loginAsked: false, hooksAsked: false });
  assert.equal(s.get('hidden'), false);
  assert.equal(s.get('checkUpdates'), true);
  assert.equal(s.get('updateNotified'), null);
});

test('checkUpdates is a validated boolean; updateNotified is not UI-editable', () => {
  const d = dir();
  const s = new Settings(d);
  assert.equal(s.setUser('checkUpdates', 'no'), false);
  assert.equal(s.setUser('checkUpdates', false), true);
  assert.equal(s.setUser('updateNotified', '9.9.9'), false);
  s.flush();
  assert.equal(new Settings(d).get('checkUpdates'), false);
});

test('settings from v0.1.0 (before the updater) get checkUpdates on', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ theme: 'dark', onboarding: { loginAsked: true, hooksAsked: true } }));
  assert.equal(new Settings(d).get('checkUpdates'), true);
});

test('migrates v0.1 settings (muted / notifyOn) without losing window state', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({
    port: 5000, muted: true, collapsed: true, bounds: { x: 1, y: 2, width: 340, height: 300 },
    notifyOn: { permission: true, question: true, done: true, error: false, stopped: false, stale: true },
  }));
  const s = new Settings(d);
  assert.equal(s.get('sound'), false);
  assert.deepEqual(s.get('notify'), { attention: true, stopped: false, finished: false });
  assert.equal(s.get('port'), 5000);
  assert.equal(s.get('collapsed'), true);
  assert.deepEqual(s.get('bounds'), { x: 1, y: 2, width: 340, height: 300 });
  s.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(d, 'settings.json'), 'utf8'));
  assert.equal(saved.muted, undefined);
  assert.equal(saved.notifyOn, undefined);
});

test('migrate drops the old silently-on openAtLogin so the user gets asked', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ theme: 'dark', openAtLogin: true }));
  const s = new Settings(d);
  assert.equal(s.get('openAtLogin'), undefined);
  assert.equal(s.get('onboarding').loginAsked, false);
  assert.equal(s.get('theme'), 'dark');
});

test('migrate leaves current-format settings alone', () => {
  const cur = { theme: 'dark', sound: false, notify: { attention: false, stopped: true, finished: true } };
  assert.deepEqual(migrate(cur), cur);
});

test('setUser validates keys and values and persists', () => {
  const d = dir();
  const s = new Settings(d);
  assert.equal(s.setUser('theme', 'light'), true);
  assert.equal(s.setUser('theme', 'neon'), false);
  assert.equal(s.setUser('notify.finished', true), true);
  assert.equal(s.setUser('port', 1), false, 'port is not UI-editable');
  assert.equal(s.setUser('sound', 'yes'), false);
  assert.equal(s.setUser('openAtLogin', true), false, 'login item goes through the OS helper, not settings');
  s.flush();
  const again = new Settings(d);
  assert.equal(again.get('theme'), 'light');
  assert.equal(again.get('notify.finished'), true);
  assert.equal(again.get('notify.attention'), true);
});
