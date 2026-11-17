'use strict';
/*
 * Telegram alerts through the shared bot @agentcodyalertsbot. There is no server: each copy of the
 * app calls the Bot API directly and only ever sends to the chat ID saved in its own settings.
 *
 * Everything here is plain Node with injected dependencies (fetch, sleep, settings, idle time),
 * so it can be unit tested without Electron or the network.
 *
 * The bot token is a secret: it is never logged, never sent to the renderer and never part of an
 * error message (see redact()).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOT_USERNAME = 'agentcodyalertsbot';
const API = 'https://api.telegram.org';
const CONFIG_FILE = path.join(__dirname, 'telegram-config.json');
const POLL_MS = 2000;
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const NETWORK_RETRY_MS = 5000;
const MAX_RETRY_AFTER_S = 60;
const AWAY_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_TEXT = 4096;

const CONFIRM_TEXT = 'Agent Cody is connected. You’ll get alerts here when your agents need you.';
const TEST_TEXT = 'Test from Agent Cody. Alerts from this computer will arrive here.';

// ---------- token ----------

/** Dev env var first, then the file the release build writes. Returns null if neither has one. */
function loadToken({ env = process.env, file = CONFIG_FILE, readFile = fs.readFileSync } = {}) {
  const fromEnv = String(env.AGENT_CODY_TELEGRAM_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const t = String(JSON.parse(readFile(file, 'utf8')).token || '').trim();
    return t || null;
  } catch (_) {
    return null;
  }
}

/** Remove the token from any text before it goes near a log. */
function redact(text, token) {
  let s = String(text == null ? '' : text);
  if (token) s = s.split(token).join('<token>');
  return s.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>');
}

// ---------- connect link ----------

/** Telegram's `start` parameter: letters, digits, _ and -, up to 64 chars. We use letters/digits only. */
function newCode() {
  return crypto.randomBytes(16).toString('hex'); // 32 chars, [0-9a-f]
}

function startLink(botUsername, code) {
  if (!/^[A-Za-z0-9]{1,64}$/.test(String(code))) throw new Error('Invalid start code');
  return `https://t.me/${botUsername}?start=${code}`;
}

function displayName(from, chat) {
  const u = (from && from.username) || (chat && chat.username);
  if (u) return `@${u}`;
  return (from && from.first_name) || (chat && (chat.first_name || chat.title)) || 'Telegram';
}

/** Find the chat that sent exactly "/start <code>" among the bot's pending updates (shared by everyone). */
function findStartChat(updates, code) {
  if (!Array.isArray(updates) || !code) return null;
  const want = `/start ${code}`;
  for (const u of updates) {
    const m = u && u.message;
    if (!m || typeof m.text !== 'string' || !m.chat) continue;
    if (m.text.trim() !== want) continue;
    return { chatId: m.chat.id, name: displayName(m.from, m.chat) };
  }
  return null;
}

/** Chat IDs are integers (negative for groups). Returns the number, or null if it isn't one. */
function parseChatId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^-?\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
}

// ---------- message text ----------

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The same status line the widget shows for the session's row. */
function statusLine(n) {
  switch (n.kind) {
    case 'permission': return 'Needs permission';
    case 'question': return 'Needs your answer';
    case 'done': return typeof n.turnMs === 'number' ? `Finished · ${fmtDuration(n.turnMs)}` : 'Finished';
    case 'error': return 'Stopped · error';
    case 'stopped': return `Stopped · ${n.stopReason || 'interrupted'}`;
    case 'stale': return 'Stopped · no updates';
    default: return '';
  }
}

/** Plain text (no parse_mode): title, status line, then the notification body unless previews are off. */
function formatAlert(n, { includePreview = true } = {}) {
  const lines = [n.title || 'Agent Cody', statusLine(n)];
  if (includePreview && n.body) lines.push(n.body);
  return lines.filter(Boolean).join('\n').slice(0, MAX_TEXT);
}

// ---------- Bot API ----------

class TelegramError extends Error {
  /** kind: 'network' | 'rate' | 'gone' (blocked / chat not found) | 'conflict' | 'auth' | 'other' */
  constructor(kind, message, { status = 0, retryAfter = null } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function classify(status, body) {
  const desc = String((body && body.description) || `HTTP ${status}`);
  if (status === 429) {
    const ra = Number(body && body.parameters && body.parameters.retry_after);
    return new TelegramError('rate', desc, { status, retryAfter: Number.isFinite(ra) && ra >= 0 ? ra : 1 });
  }
  if (status === 403 || (status === 400 && /chat not found/i.test(desc))) return new TelegramError('gone', desc, { status });
  if (status === 409) return new TelegramError('conflict', desc, { status });
  if (status === 401 || status === 404) return new TelegramError('auth', desc, { status }); // bad or revoked token
  return new TelegramError('other', desc, { status });
}

async function callApi({ token, method, params, fetch }) {
  let res;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new TelegramError('network', redact((err && err.message) || 'Network error', token));
  }
  let body = null;
  try { body = await res.json(); } catch (_) { /* not JSON */ }
  if (res.ok && body && body.ok) return body.result;
  throw classify(res.status || 0, body);
}

function sendMessage({ token, chatId, text, fetch }) {
  return callApi({ token, method: 'sendMessage', fetch, params: { chat_id: chatId, text: String(text).slice(0, MAX_TEXT), link_preview_options: { is_disabled: true } } });
}

/** Short polling, and never an offset: an offset would mark other people's /start messages as read. */
function getUpdates({ token, fetch }) {
  return callApi({ token, method: 'getUpdates', fetch, params: { timeout: 0 } });
}

/**
 * Send once, retrying at most once: after ~5 s for network errors, after retry_after for 429.
 * Never throws. Returns { ok, result } or { ok: false, gone, error }.
 */
async function sendWithRetry({ token, chatId, text, fetch, sleep = defaultSleep }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, result: await sendMessage({ token, chatId, text, fetch }) };
    } catch (err) {
      const e = err instanceof TelegramError ? err : new TelegramError('other', redact(err && err.message, token));
      if (attempt === 0 && e.kind === 'network') { await sleep(NETWORK_RETRY_MS); continue; }
      if (attempt === 0 && e.kind === 'rate') { await sleep(Math.min(e.retryAfter, MAX_RETRY_AFTER_S) * 1000); continue; }
      return { ok: false, gone: e.kind === 'gone', error: e };
    }
  }
}

function defaultSleep(ms) { return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }); }

/** What the Send test / Save & test buttons tell the user. */
function errorMessage(e) {
  if (!e) return 'Couldn’t reach Telegram.';
  if (e.kind === 'network') return 'Couldn’t reach Telegram. Check your internet connection.';
  if (e.kind === 'gone') return 'Telegram says this chat can’t get messages. Unblock the bot or reconnect.';
  if (e.kind === 'rate') return 'Telegram is busy. Try again in a minute.';
  if (e.kind === 'auth') return 'The Telegram bot token in this build doesn’t work.';
  return `Telegram said: ${e.message}`;
}

// ---------- service (wired into the app by main.js) ----------

class TelegramService {
  /**
   * @param o.token           bot token or null (Telegram unavailable)
   * @param o.settings        Settings instance (reads/writes `telegram`)
   * @param o.fetch           fetch implementation
   * @param o.openExternal    (url) => Promise, opens the t.me link
   * @param o.idleSeconds     () => seconds since the last keyboard/mouse input
   * @param o.onChange        () => void, called when state() changed
   * @param o.sleep, o.now, o.log   overridable for tests
   */
  constructor({ token, settings, fetch, openExternal, idleSeconds, onChange, sleep = defaultSleep, now = Date.now, log = console }) {
    this.token = token || null;
    this.settings = settings;
    this.fetch = fetch;
    this.openExternal = openExternal || (async () => {});
    this.idleSeconds = idleSeconds || (() => 0);
    this.onChange = onChange || (() => {});
    this.sleep = sleep;
    this.now = now;
    this.log = log;
    this.connecting = false;
    this._gen = 0; // bumps on every connect/cancel so an old poll loop stops
  }

  get available() { return Boolean(this.token); }
  _cfg() { return this.settings.get('telegram') || {}; }
  _save(patch) { this.settings.set('telegram', { ...this._cfg(), ...patch }); this.settings.flush(); this.onChange(); }
  _warn(msg, err) { this.log.warn(`[agent-cody] telegram: ${msg}`, redact(err && err.message, this.token)); }

  /** For the renderer. Never includes the token or the chat ID. */
  state() {
    const c = this._cfg();
    return {
      available: this.available,
      connected: this.available && c.chatId != null && !c.disconnected,
      name: c.name || null,
      connecting: this.connecting,
      disconnected: Boolean(c.disconnected),
      enabled: c.enabled !== false,
      onlyWhenAway: Boolean(c.onlyWhenAway),
      includePreview: c.includePreview !== false,
    };
  }

  /** Open the bot with a fresh code and wait (up to 5 min) for "/start <code>". */
  async connect() {
    if (!this.available) return { ok: false, message: 'Telegram isn’t available in this build.' };
    const gen = ++this._gen;
    const code = newCode();
    this.connecting = true;
    this.onChange();
    try {
      await this.openExternal(startLink(BOT_USERNAME, code));
    } catch (err) {
      this._warn('could not open Telegram link', err);
    }
    const deadline = this.now() + CONNECT_TIMEOUT_MS;
    try {
      while (this._gen === gen && this.now() < deadline) {
        let found = null;
        try {
          found = findStartChat(await getUpdates({ token: this.token, fetch: this.fetch }), code);
        } catch (err) {
          if (err.kind === 'auth') return { ok: false, message: errorMessage(err) };
          // network blips and 409 Conflict (someone else polling): just try again next tick
        }
        if (this._gen !== gen) break;
        if (found) {
          this._save({ chatId: found.chatId, name: found.name, disconnected: false, enabled: true });
          const r = await sendWithRetry({ token: this.token, chatId: found.chatId, text: CONFIRM_TEXT, fetch: this.fetch, sleep: this.sleep });
          if (!r.ok) this._warn('confirmation message failed', r.error);
          return { ok: true, name: found.name };
        }
        await this.sleep(POLL_MS);
      }
      return this._gen === gen
        ? { ok: false, message: 'Didn’t hear back from Telegram. Click Connect Telegram to try again.' }
        : { ok: false, cancelled: true };
    } finally {
      if (this._gen === gen) { this.connecting = false; this.onChange(); }
    }
  }

  cancel() {
    this._gen++;
    if (this.connecting) { this.connecting = false; this.onChange(); }
  }

  async test() {
    const c = this._cfg();
    if (!this.available || c.chatId == null) return { ok: false, message: 'Connect Telegram first.' };
    const r = await sendWithRetry({ token: this.token, chatId: c.chatId, text: TEST_TEXT, fetch: this.fetch, sleep: this.sleep });
    if (r.ok) {
      if (c.disconnected) this._save({ disconnected: false });
      return { ok: true, message: 'Test message sent. Check Telegram.' };
    }
    if (r.gone) this._save({ disconnected: true });
    return { ok: false, message: errorMessage(r.error) };
  }

  disconnect() {
    this.cancel();
    this._save({ chatId: null, name: null, disconnected: false });
  }

  /** Fallback: a typed chat ID is saved only if a test message to it goes through. */
  async setChatId(raw) {
    if (!this.available) return { ok: false, message: 'Telegram isn’t available in this build.' };
    const chatId = parseChatId(raw);
    if (chatId == null) return { ok: false, message: 'A chat ID is a number, like 123456789.' };
    const r = await sendWithRetry({ token: this.token, chatId, text: TEST_TEXT, fetch: this.fetch, sleep: this.sleep });
    if (!r.ok) return { ok: false, message: errorMessage(r.error) };
    const chat = (r.result && r.result.chat) || {};
    this.cancel();
    this._save({ chatId, name: displayName(null, chat), disconnected: false, enabled: true });
    return { ok: true, message: 'Connected. A test message is on its way.' };
  }

  /** A session alert that already passed the category switches and dedupe. Never throws, never toasts. */
  async alert(n) {
    const c = this._cfg();
    if (!this.available || c.chatId == null || c.disconnected || c.enabled === false) return { sent: false };
    if (c.onlyWhenAway && this.idleSeconds() < AWAY_SECONDS) return { sent: false };
    const chatId = c.chatId;
    const r = await sendWithRetry({ token: this.token, chatId, text: formatAlert(n, { includePreview: c.includePreview !== false }), fetch: this.fetch, sleep: this.sleep });
    if (r.ok) return { sent: true };
    // Only mark disconnected if it's still the same chat (the user may have reconnected meanwhile).
    if (r.gone && this._cfg().chatId === chatId) this._save({ disconnected: true });
    else if (!r.gone) this._warn('alert not sent', r.error);
    return { sent: false, gone: r.gone };
  }
}

module.exports = {
  BOT_USERNAME, CONFIG_FILE, AWAY_SECONDS, CONFIRM_TEXT, TEST_TEXT,
  loadToken, redact, newCode, startLink, findStartChat, parseChatId, displayName,
  statusLine, formatAlert, sendMessage, getUpdates, sendWithRetry, classify, errorMessage,
  TelegramError, TelegramService,
};
