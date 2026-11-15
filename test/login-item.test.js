'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createLoginItem, LOGIN_ARG } = require('../src/main/login-item.js');

/** Minimal stand-in for Electron's app login-item API, modelled on the Electron 45 docs. */
function fakeMac({ packaged = true, status = 'not-registered', wasOpenedAtLogin = false, approve = true } = {}) {
  const calls = [];
  const app = {
    isPackaged: packaged,
    getLoginItemSettings: () => ({ openAtLogin: status === 'enabled', status, wasOpenedAtLogin }),
    setLoginItemSettings: (o) => { calls.push(o); status = o.openAtLogin ? (approve ? 'enabled' : 'requires-approval') : 'not-registered'; },
  };
  return { app, calls };
}

function fakeWin({ packaged = true, items = [], execPath = 'C:\\Users\\me\\AppData\\Local\\Programs\\agent-cody\\Agent Cody.exe' } = {}) {
  const calls = [];
  const state = { items: [...items] };
  const app = {
    isPackaged: packaged,
    getLoginItemSettings: (opts = {}) => {
      const mine = state.items.find((i) => i.path === opts.path);
      return {
        openAtLogin: Boolean(mine && JSON.stringify(mine.args) === JSON.stringify(opts.args || [])),
        executableWillLaunchAtLogin: Boolean(mine && mine.enabled),
        launchItems: state.items,
      };
    },
    setLoginItemSettings: (o) => {
      calls.push(o);
      state.items = state.items.filter((i) => i.name !== 'com.agentcody.widget');
      if (o.openAtLogin) state.items.push({ name: 'com.agentcody.widget', path: o.path, args: o.args, scope: 'user', enabled: o.enabled !== false });
    },
  };
  return { app, calls, state, execPath };
}

test('dev mode (not packaged) is unsupported and never touches the OS', () => {
  const { app, calls } = fakeMac({ packaged: false });
  const li = createLoginItem({ app, platform: 'darwin', argv: [] });
  assert.equal(li.supported, false);
  assert.deepEqual(li.get(), { supported: false, enabled: false, requiresApproval: false });
  li.set(true);
  assert.equal(calls.length, 0);
});

test('macOS: set reads back the real status, including requires-approval', () => {
  const ok = fakeMac();
  const li = createLoginItem({ app: ok.app, platform: 'darwin', argv: [] });
  assert.equal(li.get().enabled, false);
  assert.equal(li.set(true).enabled, true);
  assert.deepEqual(ok.calls[0], { openAtLogin: true });
  assert.equal(li.set(false).enabled, false);

  const pending = fakeMac({ approve: false });
  const r = createLoginItem({ app: pending.app, platform: 'darwin', argv: [] }).set(true);
  assert.equal(r.enabled, false);
  assert.equal(r.requiresApproval, true);
});

test('macOS: user removing the item in System Settings shows as off', () => {
  const { app } = fakeMac({ status: 'not-registered' });
  assert.equal(createLoginItem({ app, platform: 'darwin', argv: [] }).get().enabled, false);
});

test('macOS: wasOpenedAtLogin comes from the OS', () => {
  const { app } = fakeMac({ wasOpenedAtLogin: true });
  assert.equal(createLoginItem({ app, platform: 'darwin', argv: [] }).wasOpenedAtLogin(), true);
  const manual = fakeMac({ wasOpenedAtLogin: false });
  assert.equal(createLoginItem({ app: manual.app, platform: 'darwin', argv: [] }).wasOpenedAtLogin(), false);
});

test('Windows: registers the current exe with --login, per user, enabled', () => {
  const f = fakeWin();
  const li = createLoginItem({ app: f.app, platform: 'win32', argv: [], env: {}, execPath: f.execPath });
  assert.equal(li.set(true).enabled, true);
  assert.deepEqual(f.calls[0], { openAtLogin: true, enabled: true, path: f.execPath, args: [LOGIN_ARG] });
  assert.equal(li.set(false).enabled, false);
});

test('Windows: disabled in Task Manager / Startup apps shows as off', () => {
  const f = fakeWin();
  f.state.items.push({ name: 'com.agentcody.widget', path: f.execPath, args: [LOGIN_ARG], scope: 'user', enabled: false });
  assert.equal(createLoginItem({ app: f.app, platform: 'win32', argv: [], env: {}, execPath: f.execPath }).get().enabled, false);
});

test('Windows: login start is detected from the --login argument', () => {
  const f = fakeWin();
  assert.equal(createLoginItem({ app: f.app, platform: 'win32', argv: ['Agent Cody.exe', LOGIN_ARG], env: {}, execPath: f.execPath }).wasOpenedAtLogin(), true);
  assert.equal(createLoginItem({ app: f.app, platform: 'win32', argv: ['Agent Cody.exe'], env: {}, execPath: f.execPath }).wasOpenedAtLogin(), false);
});

test('Windows portable build registers the stable portable exe, not the temp unpack dir', () => {
  const f = fakeWin({ execPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\2abc\\Agent Cody.exe' });
  const li = createLoginItem({ app: f.app, platform: 'win32', argv: [], env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Tools\\Agent Cody.exe' }, execPath: f.execPath });
  li.set(true);
  assert.equal(f.calls[0].path, 'D:\\Tools\\Agent Cody.exe');
});

test('Windows: an enabled entry pointing at an old path is repaired; disabled ones are left alone', () => {
  const f = fakeWin({ items: [{ name: 'com.agentcody.widget', path: 'C:\\Old\\Agent Cody.exe', args: [LOGIN_ARG], scope: 'user', enabled: true }] });
  const li = createLoginItem({ app: f.app, platform: 'win32', argv: [], env: {}, execPath: f.execPath });
  assert.equal(li.repairStalePath(), true);
  assert.equal(li.get().enabled, true);
  assert.equal(f.state.items.length, 1);

  const off = fakeWin({ items: [{ name: 'com.agentcody.widget', path: 'C:\\Old\\Agent Cody.exe', args: [LOGIN_ARG], scope: 'user', enabled: false }] });
  assert.equal(createLoginItem({ app: off.app, platform: 'win32', argv: [], env: {}, execPath: off.execPath }).repairStalePath(), false);
  assert.equal(off.calls.length, 0);
});

test('errors from the OS are reported, not thrown', () => {
  const app = { isPackaged: true, getLoginItemSettings: () => { throw new Error('boom'); }, setLoginItemSettings: () => { throw new Error('nope'); } };
  const li = createLoginItem({ app, platform: 'darwin', argv: [] });
  assert.equal(li.get().error, 'boom');
  assert.equal(li.set(true).error, 'nope');
  assert.equal(li.wasOpenedAtLogin(), false);
});
