'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tg = require('../src/main/telegram.js');
const { Settings } = require('../src/main/settings.js');

const TOKEN = '123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ';
const quiet = { warn() {}, log() {} };
const noSleep = async () => {};

/** Fake fetch: answers each call from `replies` in order (an Error = network failure) and records calls. */
function fakeFetch(...replies) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: url.split('/').pop(), params: JSON.parse(opts.body) });
    const r = replies.length > 1 ? replies.shift() : replies[0];
    if (r instanceof Error) throw r;
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const ok = (result) => ({ status: 200, body: { ok: true, result } });
const fail = (status, description, parameters) => ({ status, body: { ok: false, error_code: status, description, parameters } });
const update = (id, text, chat, from) => ({ update_id: id, message: { message_id: id, text, chat, from: from || chat } });

// ---------- connect link / updates ----------

test('newCode and startLink follow Telegram’s start-parameter rules', () => {
  const code = tg.newCode();
  assert.match(code, /^[A-Za-z0-9]{1,64}$/);
  assert.notEqual(code, tg.newCode());
  assert.equal(tg.startLink('agentcodyalertsbot', code), `https://t.me/agentcodyalertsbot?start=${code}`);
  assert.throws(() => tg.startLink('agentcodyalertsbot', 'has space'));
  assert.throws(() => tg.startLink('agentcodyalertsbot', 'x'.repeat(65)));
});

test('findStartChat picks this app’s /start among other people’s updates', () => {
  const updates = [
    update(1, '/start someoneElsesCode', { id: 111, type: 'private', username: 'friend1' }),
    update(2, 'hello bot', { id: 222, type: 'private', first_name: 'Sam' }),
    update(3, '/start abc1234', { id: 333, type: 'private', first_name: 'Robin' }), // wrong code (prefix)
    update(4, '/start abc12345', { id: 444, type: 'private', username: 'me_here', first_name: 'Me' }),
    update(5, '/start abc12345', { id: 555, type: 'private', username: 'late' }),
  ];
  assert.deepEqual(tg.findStartChat(updates, 'abc12345'), { chatId: 444, name: '@me_here' });
  assert.equal(tg.findStartChat(updates, 'nope'), null);
  assert.equal(tg.findStartChat(updates, ''), null);
  assert.equal(tg.findStartChat(null, 'abc12345'), null);
});

test('findStartChat uses the first name when there is no username', () => {
  const r = tg.findStartChat([update(1, '/start c0de', { id: 9, type: 'private', first_name: 'Robin' })], 'c0de');
  assert.deepEqual(r, { chatId: 9, name: 'Robin' });
});

test('findStartChat ignores updates without message text', () => {
  const updates = [
    { update_id: 1, message: { message_id: 1, chat: { id: 1 }, photo: [{}], caption: '/start c0de' } },
    { update_id: 2, my_chat_member: { chat: { id: 2 } } },
    { update_id: 3, message: { message_id: 3, chat: { id: 3 }, sticker: {} } },
    null,
  ];
  assert.equal(tg.findStartChat(updates, 'c0de'), null);
});

test('parseChatId accepts integers (negative for groups) and nothing else', () => {
  assert.equal(tg.parseChatId('123456789'), 123456789);
  assert.equal(tg.parseChatId(' -1001234567890 '), -1001234567890);
  for (const bad of ['', 'abc', '12.5', '1e5', '0', '@name', '123 456', null, undefined, '99999999999999999']) {
    assert.equal(tg.parseChatId(bad), null, String(bad));
  }
});

test('getUpdates short-polls and never sends an offset', async () => {
  const fetch = fakeFetch(ok([]));
  await tg.getUpdates({ token: TOKEN, fetch });
  assert.equal(fetch.calls[0].method, 'getUpdates');
  assert.deepEqual(fetch.calls[0].params, { timeout: 0 });
});

// ---------- message text ----------

const doneNote = { kind: 'done', sessionId: 's1', turnMs: 252000, title: 'agent-cody finished', body: 'All tests pass and the README is updated.' };

test('formatAlert: title, status line, then the preview', () => {
  assert.equal(tg.formatAlert(doneNote), 'agent-cody finished\nFinished · 4m 12s\nAll tests pass and the README is updated.');
});

test('formatAlert without the preview sends only title and status', () => {
  assert.equal(tg.formatAlert(doneNote, { includePreview: false }), 'agent-cody finished\nFinished · 4m 12s');
  const perm = { kind: 'permission', title: 'web needs permission', body: 'Allow Bash: Running rm -rf build?' };
  assert.equal(tg.formatAlert(perm, { includePreview: false }), 'web needs permission\nNeeds permission');
});

test('status lines match the widget for every alert kind', () => {
  assert.equal(tg.statusLine({ kind: 'question' }), 'Needs your answer');
  assert.equal(tg.statusLine({ kind: 'done' }), 'Finished');
  assert.equal(tg.statusLine({ kind: 'done', turnMs: 9000 }), 'Finished · 9s');
  assert.equal(tg.statusLine({ kind: 'error' }), 'Stopped · error');
  assert.equal(tg.statusLine({ kind: 'stopped' }), 'Stopped · interrupted');
  assert.equal(tg.statusLine({ kind: 'stopped', stopReason: 'exited' }), 'Stopped · exited');
  assert.equal(tg.statusLine({ kind: 'stale' }), 'Stopped · no updates');
});

// ---------- sending and failures ----------

test('sendMessage posts plain text (no parse_mode) to the chat', async () => {
  const fetch = fakeFetch(ok({ message_id: 1 }));
  await tg.sendMessage({ token: TOKEN, chatId: 42, text: 'a <b>&</b> *b*', fetch });
  const { url, params } = fetch.calls[0];
  assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(params.chat_id, 42);
  assert.equal(params.text, 'a <b>&</b> *b*');
  assert.equal(params.parse_mode, undefined);
});

test('403 (bot blocked) and 400 chat not found mean gone, without retrying', async () => {
  for (const reply of [fail(403, 'Forbidden: bot was blocked by the user'), fail(400, 'Bad Request: chat not found')]) {
    const fetch = fakeFetch(reply);
    const r = await tg.sendWithRetry({ token: TOKEN, chatId: 1, text: 'x', fetch, sleep: noSleep });
    assert.equal(r.ok, false);
    assert.equal(r.gone, true);
    assert.equal(fetch.calls.length, 1);
  }
});

test('other 400 errors are not treated as gone', async () => {
  const r = await tg.sendWithRetry({ token: TOKEN, chatId: 1, text: 'x', fetch: fakeFetch(fail(400, 'Bad Request: message is too long')), sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.gone, false);
});

test('network errors retry once after ~5 s, then give up', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const fetch = fakeFetch(new TypeError('fetch failed'));
  const r = await tg.sendWithRetry({ token: TOKEN, chatId: 1, text: 'x', fetch, sleep });
  assert.equal(r.ok, false);
  assert.equal(r.gone, false);
  assert.equal(r.error.kind, 'network');
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(waits, [5000]);

  const fetch2 = fakeFetch(new TypeError('fetch failed'), ok({}));
  assert.equal((await tg.sendWithRetry({ token: TOKEN, chatId: 1, text: 'x', fetch: fetch2, sleep })).ok, true);
});

test('429 waits for retry_after, then retries once', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const fetch = fakeFetch(fail(429, 'Too Many Requests: retry after 7', { retry_after: 7 }), ok({}));
  assert.equal((await tg.sendWithRetry({ token: TOKEN, chatId: 1, text: 'x', fetch, sleep })).ok, true);
  assert.deepEqual(waits, [7000]);

  const always429 = fakeFetch(fail(429, 'Too Many Requests', { retry_after: 1 }));
  const r = await tg.sendWithRetry({ token: TOKEN, chatId: 1, text: 'x', fetch: always429, sleep });
  assert.equal(r.ok, false);
  assert.equal(r.gone, false);
  assert.equal(always429.calls.length, 2);
});

test('error messages never contain the token', async () => {
  const fetch = async () => { throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`); };
  const r = await tg.sendWithRetry({ token: TOKEN, chatId: 1, text: 'x', fetch, sleep: noSleep });
  assert.ok(!r.error.message.includes(TOKEN));
  assert.ok(!tg.redact(`bot${TOKEN}`, null).includes(TOKEN));
});

// ---------- token loading ----------

test('loadToken: env var first, then the config file, else null', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cody-tg-'));
  const file = path.join(d, 'telegram-config.json');
  assert.equal(tg.loadToken({ env: {}, file }), null);
  fs.writeFileSync(file, JSON.stringify({ token: 'from-file' }));
  assert.equal(tg.loadToken({ env: {}, file }), 'from-file');
  assert.equal(tg.loadToken({ env: { AGENT_CODY_TELEGRAM_TOKEN: 'from-env' }, file }), 'from-env');
  fs.writeFileSync(file, '{ not json');
  assert.equal(tg.loadToken({ env: {}, file }), null);
});

// ---------- service ----------

function service({ fetch, idle = 0, token = TOKEN, telegram } = {}) {
  const settings = new Settings(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cody-tg-')));
  if (telegram) settings.set('telegram', { ...settings.get('telegram'), ...telegram });
  let t = 0;
  const opened = [];
  const svc = new tg.TelegramService({
    token, settings, fetch, log: quiet,
    sleep: async (ms) => { t += ms; },
    now: () => t,
    openExternal: async (url) => { opened.push(url); },
    idleSeconds: () => idle,
  });
  return { svc, settings, opened };
}

test('without a token Telegram is unavailable and alerts do nothing', async () => {
  const fetch = fakeFetch(ok({}));
  const { svc } = service({ fetch, token: null, telegram: { chatId: 1 } });
  assert.equal(svc.state().available, false);
  assert.equal(svc.state().connected, false);
  assert.deepEqual(await svc.alert(doneNote), { sent: false });
  assert.equal((await svc.connect()).ok, false);
  assert.equal(fetch.calls.length, 0);
});

test('state() never exposes the token or the chat ID', () => {
  const { svc } = service({ fetch: fakeFetch(ok({})), telegram: { chatId: 987654, name: '@me' } });
  const s = JSON.stringify(svc.state());
  assert.ok(!s.includes(TOKEN));
  assert.ok(!s.includes('987654'));
  assert.deepEqual(svc.state(), { available: true, connected: true, name: '@me', connecting: false, disconnected: false, enabled: true, onlyWhenAway: false, includePreview: true });
});

test('connect: opens the bot, polls until /start <code> shows up, saves the chat and confirms', async () => {
  let code = null;
  let polls = 0;
  const calls = [];
  const fetch = async (url, opts) => {
    const method = url.split('/').pop();
    const params = JSON.parse(opts.body);
    calls.push({ method, params });
    if (method === 'getUpdates') {
      polls++;
      if (polls === 1) return { ok: false, status: 409, json: async () => ({ ok: false, description: 'Conflict' }) };
      const result = [update(1, '/start someoneElse', { id: 5, username: 'friend' })];
      if (polls >= 3) result.push(update(2, `/start ${code}`, { id: 77, username: 'me' }));
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1, chat: { id: params.chat_id } } }) };
  };
  const { svc, settings, opened } = service({ fetch, telegram: { enabled: false } });
  const p = svc.connect();
  code = new URL(opened[0]).searchParams.get('start');
  assert.match(opened[0], /^https:\/\/t\.me\/agentcodyalertsbot\?start=[A-Za-z0-9]+$/);
  assert.equal(svc.state().connecting, true);
  assert.deepEqual(await p, { ok: true, name: '@me' });
  assert.equal(polls, 3, 'a 409 is retried quietly on the next tick');
  assert.equal(settings.get('telegram').chatId, 77);
  assert.equal(svc.state().connected, true);
  assert.equal(svc.state().enabled, true, 'alerts are on once connected');
  assert.equal(svc.state().connecting, false);
  const sent = calls.filter((c) => c.method === 'sendMessage');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.chat_id, 77);
  assert.equal(sent[0].params.text, tg.CONFIRM_TEXT);
  assert.ok(calls.filter((c) => c.method === 'getUpdates').every((c) => c.params.offset === undefined));
});

test('connect gives up after 5 minutes; cancel stops polling', async () => {
  const { svc } = service({ fetch: fakeFetch(ok([])) });
  const r = await svc.connect();
  assert.equal(r.ok, false);
  assert.match(r.message, /Didn’t hear back/);
  assert.equal(svc.state().connecting, false);

  const fetch = fakeFetch(ok([]));
  const b = service({ fetch });
  const p = b.svc.connect();
  b.svc.cancel();
  assert.deepEqual(await p, { ok: false, cancelled: true });
  assert.ok(fetch.calls.length <= 1);
  assert.equal(b.svc.state().connecting, false);
});

test('alert: a 403 marks Telegram disconnected and stops further sends', async () => {
  const fetch = fakeFetch(fail(403, 'Forbidden: bot was blocked by the user'));
  const { svc } = service({ fetch, telegram: { chatId: 5, name: '@me' } });
  assert.deepEqual(await svc.alert(doneNote), { sent: false, gone: true });
  assert.equal(svc.state().disconnected, true);
  assert.equal(svc.state().connected, false);
  await svc.alert(doneNote);
  assert.equal(fetch.calls.length, 1, 'no more sends once disconnected');
});

test('alert: 400 chat not found disconnects; network errors and 429 do not', async () => {
  const gone = service({ fetch: fakeFetch(fail(400, 'Bad Request: chat not found')), telegram: { chatId: 5 } });
  await gone.svc.alert(doneNote);
  assert.equal(gone.svc.state().disconnected, true);

  const net = service({ fetch: fakeFetch(new TypeError('fetch failed')), telegram: { chatId: 5 } });
  assert.deepEqual(await net.svc.alert(doneNote), { sent: false, gone: false });
  assert.equal(net.svc.state().disconnected, false);

  const busy = service({ fetch: fakeFetch(fail(429, 'Too Many Requests', { retry_after: 3 })), telegram: { chatId: 5 } });
  assert.deepEqual(await busy.svc.alert(doneNote), { sent: false, gone: false });
  assert.equal(busy.svc.state().disconnected, false);
});

test('alert respects the switches: enabled, only when away, include preview', async () => {
  const off = service({ fetch: fakeFetch(ok({})), telegram: { chatId: 5, enabled: false } });
  assert.equal((await off.svc.alert(doneNote)).sent, false);

  const atDesk = service({ fetch: fakeFetch(ok({})), idle: 30, telegram: { chatId: 5, onlyWhenAway: true } });
  assert.equal((await atDesk.svc.alert(doneNote)).sent, false);

  const fetch = fakeFetch(ok({}));
  const away = service({ fetch, idle: 121, telegram: { chatId: 5, onlyWhenAway: true, includePreview: false } });
  assert.equal((await away.svc.alert(doneNote)).sent, true);
  assert.equal(fetch.calls[0].params.text, 'agent-cody finished\nFinished · 4m 12s');
});

test('test(): reports failures and marks a blocked chat disconnected', async () => {
  const good = service({ fetch: fakeFetch(ok({})), telegram: { chatId: 5 } });
  assert.equal((await good.svc.test()).ok, true);

  const blocked = service({ fetch: fakeFetch(fail(403, 'Forbidden: bot was blocked by the user')), telegram: { chatId: 5 } });
  const r = await blocked.svc.test();
  assert.equal(r.ok, false);
  assert.match(r.message, /Unblock/);
  assert.equal(blocked.svc.state().disconnected, true);
});

test('setChatId: validates, and saves only if the test message goes through', async () => {
  const bad = service({ fetch: fakeFetch(ok({})) });
  assert.equal((await bad.svc.setChatId('not a number')).ok, false);
  assert.equal(bad.settings.get('telegram').chatId, null);

  const missing = service({ fetch: fakeFetch(fail(400, 'Bad Request: chat not found')) });
  assert.equal((await missing.svc.setChatId('123')).ok, false);
  assert.equal(missing.settings.get('telegram').chatId, null);

  const good = service({ fetch: fakeFetch(ok({ message_id: 1, chat: { id: 123, first_name: 'Robin' } })) });
  assert.equal((await good.svc.setChatId(' 123 ')).ok, true);
  assert.equal(good.settings.get('telegram').chatId, 123);
  assert.equal(good.svc.state().name, 'Robin');
  assert.equal(good.svc.state().connected, true);
});

test('disconnect forgets the chat', () => {
  const { svc, settings } = service({ fetch: fakeFetch(ok({})), telegram: { chatId: 5, name: '@me', disconnected: true } });
  svc.disconnect();
  assert.equal(settings.get('telegram').chatId, null);
  assert.equal(svc.state().connected, false);
  assert.equal(svc.state().disconnected, false);
});
