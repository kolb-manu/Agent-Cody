'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { startServer } = require('../src/main/server.js');
const { slim } = require('../hook/agent-cody-hook.js');

const HOOK = path.join(__dirname, '..', 'hook', 'agent-cody-hook.js');

function runHook(input, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK, '--exec'], { env: { ...process.env, AGENT_CODY_PORT: String(port) } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out, ms: Date.now() - t0 }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

test('hook exits 0 quickly and silently when the app is not running', async () => {
  const r = await runHook({ session_id: 'x', hook_event_name: 'Stop', cwd: '/tmp' }, 1); // nothing listens on port 1
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.ok(r.ms < 1500, `took ${r.ms}ms`);
});

test('hook exits 0 on garbage input', async () => {
  const r = await runHook('not json', 1);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('hook delivers a slimmed event to the server', async () => {
  const got = [];
  const server = await startServer({ port: 0, onEvent: (e) => got.push(e) });
  const { port } = server.address();
  const big = 'x'.repeat(500_000);
  const r = await runHook({
    session_id: 's1', hook_event_name: 'PreToolUse', cwd: '/w/proj', transcript_path: '/t.jsonl',
    tool_name: 'Write', tool_input: { file_path: '/w/proj/a.txt', content: big },
  }, port);
  server.close();
  assert.equal(r.code, 0);
  assert.equal(got.length, 1);
  assert.equal(got[0].session_id, 's1');
  assert.equal(got[0].tool_input.file_path, '/w/proj/a.txt');
  assert.equal(got[0].tool_input.content, undefined, 'file contents must not be forwarded');
  assert.equal(got[0].transcript_path, undefined);
  assert.equal(typeof got[0].claude_pid, 'number');
});

test('server rejects requests without the Agent Cody header (browser drive-by)', async () => {
  const got = [];
  const server = await startServer({ port: 0, onEvent: (e) => got.push(e) });
  const { port } = server.address();
  const status = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/event', headers: { 'Content-Type': 'text/plain' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end(JSON.stringify({ session_id: 'evil', hook_event_name: 'Stop' }));
  });
  server.close();
  assert.equal(status, 403);
  assert.equal(got.length, 0);
});

test('slim keeps todo statuses and the first question', () => {
  const s = slim({
    session_id: 'a', hook_event_name: 'PreToolUse', tool_name: 'TodoWrite',
    tool_input: { todos: [{ content: 'A', status: 'completed', activeForm: 'Doing A' }], questions: [{ question: 'Q?' }] },
  });
  assert.deepEqual(s.tool_input.todos, [{ content: 'A', status: 'completed', activeForm: 'Doing A' }]);
  assert.equal(s.tool_input.question, 'Q?');
});
