'use strict';
/*
 * Safely merges Agent Cody's hook entries into ~/.claude/settings.json and removes them again.
 *
 * Safety rules:
 *   - Back up settings.json before every change (settings.json.agent-cody-backup-<timestamp>).
 *   - Never touch hooks that aren't ours. Ours are recognised by "agent-cody-hook" in the handler.
 *   - Refuse to write if settings.json exists but isn't valid JSON.
 *   - Atomic write (temp file + rename).
 *
 * Pure Node: no Electron required (used by scripts/hooks-cli.js and the app).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MARKER = 'agent-cody-hook';
const HOOK_FILENAME = 'agent-cody-hook.js';
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
  'TaskCreated', 'TaskCompleted', 'SessionEnd',
];
// SessionEnd runs while Claude exits; async hooks may be killed then, so it runs synchronously
// with a short timeout (the script caps itself at 1.5s anyway).
const SYNC_EVENTS = new Set(['SessionEnd']);

function defaultSettingsPath() { return path.join(os.homedir(), '.claude', 'settings.json'); }
function defaultHookDir() { return path.join(os.homedir(), '.agent-cody'); }

const isOurs = (handler) => JSON.stringify(handler || {}).includes(MARKER);

/**
 * Find a Node binary for Claude Code to run the hook with.
 * Version-manager paths (nvm, fnm, volta…) change when you switch versions, so for those
 * we use plain "node" and rely on PATH, which Claude Code inherits from your shell.
 */
function findNode() {
  const tryExec = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
        .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } catch (_) { return []; }
  };
  let found = null;
  if (process.platform === 'win32') {
    found = tryExec('where', ['node']).find((l) => /node\.exe$/i.test(l)) || null;
    if (!found) {
      const c = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe');
      if (fs.existsSync(c)) found = c;
    }
  } else {
    // GUI apps on macOS get a minimal PATH; ask the user's login shell.
    const shell = process.env.SHELL || '/bin/zsh';
    found = tryExec(shell, ['-ilc', 'command -v node']).reverse().find((l) => l.startsWith('/') && l.endsWith('node')) || null;
    if (!found) found = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].find((p) => fs.existsSync(p)) || null;
  }
  if (!found) return { command: 'node', resolved: null };
  const managed = /[\\/](\.nvm|nvm|\.fnm|fnm|\.volta|volta|\.nodenv|\.asdf|mise|n[\\/]versions)[\\/]/i.test(found);
  return { command: managed ? 'node' : found, resolved: found };
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8');
  if (!raw.trim()) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch (err) {
    throw new Error(`${settingsPath} is not valid JSON (${err.message}). Fix it first; nothing was changed.`);
  }
}

function backup(settingsPath) {
  if (!fs.existsSync(settingsPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${settingsPath}.agent-cody-backup-${stamp}`;
  fs.copyFileSync(settingsPath, dest);
  return dest;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.agent-cody-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Remove our handlers from a settings object (in place). Returns the number removed. */
function stripOurs(settings) {
  let removed = 0;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) { kept.push(g); continue; }
      const before = g.hooks.length;
      const handlers = g.hooks.filter((h) => !isOurs(h));
      removed += before - handlers.length;
      if (handlers.length === before) kept.push(g);
      else if (handlers.length) kept.push({ ...g, hooks: handlers });
      // else: group contained only our handler(s): drop it
    }
    if (kept.length) hooks[event] = kept; else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
  return removed;
}

function buildHandler(event, nodeCommand, hookScriptPath) {
  const h = { type: 'command', command: nodeCommand, args: [hookScriptPath, '--exec'] };
  if (SYNC_EVENTS.has(event)) h.timeout = 3; else h.async = true;
  return h;
}

/** Copy the hook script to a stable location outside the app bundle (asar-safe). */
function deployHookScript(sourcePath, hookDir) {
  fs.mkdirSync(hookDir, { recursive: true });
  const dest = path.join(hookDir, HOOK_FILENAME);
  fs.writeFileSync(dest, fs.readFileSync(sourcePath)); // read+write works from inside asar
  return dest;
}

/**
 * @param {object} o
 * @param {string} o.hookSource   path to hook/agent-cody-hook.js shipped with the app
 * @param {string} [o.settingsPath]
 * @param {string} [o.hookDir]
 * @param {string} [o.nodeCommand] override node binary (tests)
 */
function install(o) {
  const settingsPath = o.settingsPath || defaultSettingsPath();
  const settings = readSettings(settingsPath); // throws on invalid JSON before anything changes
  const hookPath = deployHookScript(o.hookSource, o.hookDir || defaultHookDir());
  const node = o.nodeCommand ? { command: o.nodeCommand, resolved: o.nodeCommand } : findNode();
  const backupPath = backup(settingsPath);

  stripOurs(settings); // idempotent: replace previous versions of our entries
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  for (const event of EVENTS) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = settings.hooks[event] ? [settings.hooks[event]] : [];
    settings.hooks[event].push({ hooks: [buildHandler(event, node.command, hookPath)] });
  }
  writeAtomic(settingsPath, settings);
  return {
    settingsPath, backupPath, hookPath, node: node.command, nodeFound: Boolean(node.resolved), events: EVENTS.length,
  };
}

function uninstall(o = {}) {
  const settingsPath = o.settingsPath || defaultSettingsPath();
  if (!fs.existsSync(settingsPath)) return { settingsPath, backupPath: null, removed: 0 };
  const settings = readSettings(settingsPath);
  const probe = JSON.parse(JSON.stringify(settings));
  if (!stripOurs(probe)) return { settingsPath, backupPath: null, removed: 0 };
  const backupPath = backup(settingsPath);
  const removed = stripOurs(settings);
  writeAtomic(settingsPath, settings);
  return { settingsPath, backupPath, removed };
}

/** 'installed' | 'partial' | 'not-installed' | 'error' */
function status(o = {}) {
  const settingsPath = o.settingsPath || defaultSettingsPath();
  try {
    const hooks = readSettings(settingsPath).hooks || {};
    const have = EVENTS.filter((ev) => Array.isArray(hooks[ev]) && hooks[ev].some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurs)));
    if (have.length === EVENTS.length) return 'installed';
    return have.length ? 'partial' : 'not-installed';
  } catch (_) { return 'error'; }
}

module.exports = { install, uninstall, status, findNode, stripOurs, EVENTS, MARKER, defaultSettingsPath };
