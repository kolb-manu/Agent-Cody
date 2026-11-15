#!/usr/bin/env node
/*
 * Agent Cody hook script.
 *
 * Claude Code runs this for each configured hook event. It reads the hook JSON
 * from stdin, keeps only the small set of fields the widget needs, and POSTs it
 * to the Agent Cody app on 127.0.0.1.
 *
 * Design rules:
 *   - Never block or slow Claude Code: hard 1.5s overall cap, short HTTP timeout.
 *   - Never fail loudly: always exit 0 with no stdout, even if the app isn't running.
 *   - No dependencies, works on macOS, Windows and Linux with any Node >= 14.
 *   - Only talks to localhost.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 47821;
const HARD_CAP_MS = 1500;

function str(v, max) {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function resolvePort() {
  const fromEnv = parseInt(process.env.AGENT_CODY_PORT || '', 10);
  if (fromEnv > 0) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.agent-cody', 'config.json'), 'utf8'));
    const p = parseInt(cfg.port, 10);
    if (p > 0) return p;
  } catch (_) { /* no config: use default */ }
  return DEFAULT_PORT;
}

/** Reduce tool_input to the few fields used for activity text and progress. */
function slimToolInput(ti) {
  if (!ti || typeof ti !== 'object') return undefined;
  const out = {};
  const keep = {
    file_path: 300, notebook_path: 300, path: 300, command: 200, description: 200,
    pattern: 120, url: 300, query: 200, skill: 100, subagent_type: 80,
    subject: 200, activeForm: 200, taskId: 40, status: 30,
  };
  for (const k of Object.keys(keep)) {
    if (ti[k] !== undefined) out[k] = str(ti[k], keep[k]);
  }
  if (Array.isArray(ti.todos)) {
    out.todos = ti.todos.slice(0, 100).map((t) => ({
      content: str(t && t.content, 160),
      activeForm: str(t && t.activeForm, 160),
      status: str(t && t.status, 20),
    }));
  }
  if (Array.isArray(ti.questions) && ti.questions[0]) {
    out.question = str(ti.questions[0].question || ti.questions[0].header, 200);
  }
  return out;
}

/** Keep only what the widget needs; drop file contents, diffs, transcripts. */
function slim(input, opts) {
  const e = input || {};
  const out = {
    v: 1,
    session_id: str(e.session_id, 100),
    hook_event_name: str(e.hook_event_name, 60),
    cwd: str(e.cwd, 500),
    ts: Date.now(),
    permission_mode: str(e.permission_mode, 30),
    agent_id: str(e.agent_id, 100),
    agent_type: str(e.agent_type, 100),
    source: str(e.source, 30),
    model: str(e.model, 80),
    session_title: str(e.session_title, 200),
    prompt: str(e.prompt, 200),
    tool_name: str(e.tool_name, 120),
    tool_input: slimToolInput(e.tool_input),
    error: str(e.error, 300),
    error_details: str(e.error_details, 300),
    is_interrupt: e.is_interrupt === true ? true : undefined,
    message: str(e.message, 300),
    title: str(e.title, 120),
    notification_type: str(e.notification_type, 60),
    stop_hook_active: e.stop_hook_active === true ? true : undefined,
    last_assistant_message: str(e.last_assistant_message, 300),
    background_task_count: Array.isArray(e.background_tasks) ? e.background_tasks.length : undefined,
    task_id: str(e.task_id, 60),
    task_subject: str(e.task_subject, 200),
    reason: str(e.reason, 60),
  };
  // TaskCreate's response carries the new task id; keep a short string so the app can parse it.
  if (e.tool_name === 'TaskCreate' && e.tool_response !== undefined) {
    out.tool_response_text = str(e.tool_response, 400);
  }
  // Context for "click to focus" (best effort, local only).
  if (opts && opts.trustParentPid) out.claude_pid = process.ppid;
  if (process.env.__CFBundleIdentifier) out.term_bundle_id = str(process.env.__CFBundleIdentifier, 120);
  if (process.env.TERM_PROGRAM) out.term_program = str(process.env.TERM_PROGRAM, 60);
  if (process.env.WT_SESSION) out.term_program = out.term_program || 'WindowsTerminal';
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** POST a JSON payload to the app. Resolves true/false, never rejects. */
function post(payload, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    let body;
    try { body = JSON.stringify(payload); } catch (_) { return finish(false); }
    const req = http.request({
      host: '127.0.0.1',
      port: port || resolvePort(),
      method: 'POST',
      path: '/event',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Agent-Cody': '1',
      },
      timeout: timeoutMs || 800,
    }, (res) => { res.resume(); res.on('end', () => finish(res.statusCode < 300)); });
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.on('error', () => finish(false));
    req.end(body);
  });
}

function main() {
  const quit = () => process.exit(0);
  // Absolute safety net: whatever happens, we're gone quickly with exit 0.
  setTimeout(quit, HARD_CAP_MS).unref();
  process.on('uncaughtException', quit);
  process.on('unhandledRejection', quit);

  const trustParentPid = process.argv.includes('--exec');
  const chunks = [];
  process.stdin.on('data', (c) => {
    chunks.push(c);
    if (chunks.reduce((n, b) => n + b.length, 0) > 20 * 1024 * 1024) quit(); // absurdly large: give up
  });
  process.stdin.on('error', quit);
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { return quit(); }
    if (!input || !input.session_id) return quit();
    post(slim(input, { trustParentPid })).then(quit, quit);
  });
}

if (require.main === module) main();

module.exports = { slim, post, resolvePort, DEFAULT_PORT };
