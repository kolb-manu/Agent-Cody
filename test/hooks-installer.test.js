'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('../src/main/hooks-installer.js');

const HOOK_SOURCE = path.join(__dirname, '..', 'hook', 'agent-cody-hook.js');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cody-test-'));
  return { dir, settingsPath: path.join(dir, '.claude', 'settings.json'), hookDir: path.join(dir, '.agent-cody') };
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const opts = (t) => ({ hookSource: HOOK_SOURCE, settingsPath: t.settingsPath, hookDir: t.hookDir, nodeCommand: '/usr/bin/node' });

const EXISTING = {
  theme: 'dark',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'echo compact' }] }],
  },
};

test('install creates settings.json when missing and deploys the hook script', () => {
  const t = tmp();
  const r = installer.install(opts(t));
  assert.equal(r.backupPath, null);
  assert.ok(fs.existsSync(r.hookPath));
  const s = read(t.settingsPath);
  for (const ev of installer.EVENTS) {
    assert.equal(s.hooks[ev].length, 1);
    const h = s.hooks[ev][0].hooks[0];
    assert.equal(h.type, 'command');
    assert.equal(h.command, '/usr/bin/node');
    assert.deepEqual(h.args, [r.hookPath, '--exec']);
  }
  assert.equal(s.hooks.PreToolUse[0].hooks[0].async, true);
  assert.equal(s.hooks.SessionEnd[0].hooks[0].async, undefined);
  assert.equal(installer.status({ settingsPath: t.settingsPath }), 'installed');
});

test('install preserves existing settings and hooks, and backs up first', () => {
  const t = tmp();
  fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
  fs.writeFileSync(t.settingsPath, JSON.stringify(EXISTING, null, 2));
  const r = installer.install(opts(t));
  assert.deepEqual(read(r.backupPath), EXISTING);
  const s = read(t.settingsPath);
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.permissions, EXISTING.permissions);
  assert.deepEqual(s.hooks.PreToolUse[0], EXISTING.hooks.PreToolUse[0]);
  assert.deepEqual(s.hooks.Stop[0], EXISTING.hooks.Stop[0]);
  assert.deepEqual(s.hooks.PreCompact, EXISTING.hooks.PreCompact);
  assert.equal(s.hooks.PreToolUse.length, 2);
});

test('install is idempotent (no duplicate entries on reinstall)', () => {
  const t = tmp();
  installer.install(opts(t));
  installer.install(opts(t));
  const s = read(t.settingsPath);
  for (const ev of installer.EVENTS) assert.equal(s.hooks[ev].length, 1, ev);
});

test('uninstall removes only our entries and restores the original shape', () => {
  const t = tmp();
  fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
  fs.writeFileSync(t.settingsPath, JSON.stringify(EXISTING, null, 2));
  installer.install(opts(t));
  const r = installer.uninstall({ settingsPath: t.settingsPath });
  assert.equal(r.removed, installer.EVENTS.length);
  assert.ok(r.backupPath);
  assert.deepEqual(read(t.settingsPath), EXISTING);
  assert.equal(installer.status({ settingsPath: t.settingsPath }), 'not-installed');
});

test('uninstall keeps a group that mixes our handler with a user handler', () => {
  const t = tmp();
  installer.install(opts(t));
  const s = read(t.settingsPath);
  s.hooks.Stop[0].hooks.push({ type: 'command', command: 'say done' });
  fs.writeFileSync(t.settingsPath, JSON.stringify(s));
  installer.uninstall({ settingsPath: t.settingsPath });
  assert.deepEqual(read(t.settingsPath), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
});

test('uninstall with nothing installed changes nothing and makes no backup', () => {
  const t = tmp();
  fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
  fs.writeFileSync(t.settingsPath, JSON.stringify(EXISTING));
  const r = installer.uninstall({ settingsPath: t.settingsPath });
  assert.equal(r.removed, 0);
  assert.equal(r.backupPath, null);
  assert.equal(fs.readdirSync(path.dirname(t.settingsPath)).length, 1);
});

test('refuses to touch invalid JSON', () => {
  const t = tmp();
  fs.mkdirSync(path.dirname(t.settingsPath), { recursive: true });
  fs.writeFileSync(t.settingsPath, '{ "hooks": { oops');
  assert.throws(() => installer.install(opts(t)), /not valid JSON/);
  assert.equal(fs.readFileSync(t.settingsPath, 'utf8'), '{ "hooks": { oops');
  assert.equal(installer.status({ settingsPath: t.settingsPath }), 'error');
});

test('status reports partial installs', () => {
  const t = tmp();
  installer.install(opts(t));
  const s = read(t.settingsPath);
  delete s.hooks.Stop;
  fs.writeFileSync(t.settingsPath, JSON.stringify(s));
  assert.equal(installer.status({ settingsPath: t.settingsPath }), 'partial');
});
