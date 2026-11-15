#!/usr/bin/env node
/*
 * Install / uninstall / check Agent Cody hooks from the command line.
 *   node scripts/hooks-cli.js install | uninstall | status
 *   Options: --settings <path>   (default ~/.claude/settings.json)
 */
'use strict';
const path = require('path');
const installer = require('../src/main/hooks-installer.js');

const [cmd] = process.argv.slice(2);
const i = process.argv.indexOf('--settings');
const settingsPath = i > 0 ? process.argv[i + 1] : undefined;

try {
  if (cmd === 'install') {
    const r = installer.install({ hookSource: path.join(__dirname, '..', 'hook', 'agent-cody-hook.js'), settingsPath });
    console.log(`Installed hooks for ${r.events} events into ${r.settingsPath}`);
    console.log(`Hook script: ${r.hookPath}`);
    console.log(`Node command: ${r.node}${r.nodeFound ? '' : '  (WARNING: node not found on this machine; hooks will fail silently until Node is installed)'}`);
    if (r.backupPath) console.log(`Backup: ${r.backupPath}`);
    console.log('Restart running Claude Code sessions (or run /hooks in them) to pick up the change.');
  } else if (cmd === 'uninstall') {
    const r = installer.uninstall({ settingsPath });
    console.log(r.removed ? `Removed ${r.removed} Agent Cody hook entries from ${r.settingsPath}\nBackup: ${r.backupPath}` : 'No Agent Cody hooks found; nothing changed.');
  } else if (cmd === 'status') {
    console.log(installer.status({ settingsPath }));
  } else {
    console.log('Usage: node scripts/hooks-cli.js install|uninstall|status [--settings <path>]');
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
