#!/usr/bin/env node
/*
 * Release builds: writes src/main/telegram-config.json ({ "token": "..." }) from the
 * TELEGRAM_BOT_TOKEN env var so the packaged app can send Telegram alerts.
 * The file is gitignored. The token is never printed.
 *
 *   REQUIRE_TELEGRAM_TOKEN=1  → fail if the token is missing or malformed (tag builds)
 *   otherwise                 → warn and build without Telegram
 */
'use strict';
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'src', 'main', 'telegram-config.json');
const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const required = process.env.REQUIRE_TELEGRAM_TOKEN === '1';
const onCI = Boolean(process.env.GITHUB_ACTIONS);

function problem(msg) {
  if (required) { console.error(`${onCI ? '::error::' : ''}${msg}`); process.exit(1); }
  console.warn(`${onCI ? '::warning::' : ''}${msg} Building without Telegram alerts.`);
  process.exit(0);
}

if (!token) problem('TELEGRAM_BOT_TOKEN is empty.');
if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) problem('TELEGRAM_BOT_TOKEN doesn’t look like a bot token (expected 123456:ABC…).');

fs.writeFileSync(out, JSON.stringify({ token }) + '\n', { mode: 0o600 });
console.log(`Wrote ${path.relative(process.cwd(), out)} (token length ${token.length}).`);
