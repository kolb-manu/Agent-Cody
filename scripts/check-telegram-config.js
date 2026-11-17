#!/usr/bin/env node
/* CI: checks every packaged app.asar under dist/ contains src/main/telegram-config.json. Never prints the token. */
'use strict';
const fs = require('fs');
const path = require('path');
const { listPackage } = require('@electron/asar');

const find = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return find(p);
  return d.name === 'app.asar' ? [p] : [];
});

const asars = find(path.join(__dirname, '..', 'dist'));
if (!asars.length) { console.error('::error::No app.asar found under dist/'); process.exit(1); }
let ok = true;
for (const a of asars) {
  const has = listPackage(a).some((f) => f.replace(/\\/g, '/').endsWith('/src/main/telegram-config.json'));
  console.log(`${has ? '✓' : '✗'} ${path.relative(process.cwd(), a)}`);
  if (!has) ok = false;
}
if (!ok) { console.error('::error::telegram-config.json is missing from the packaged app'); process.exit(1); }
