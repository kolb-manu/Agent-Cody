#!/usr/bin/env node
/*
 * Fake-event simulator: plays ~45 seconds of activity for 4 Claude Code sessions
 * so you can see the widget without running real agents.
 *
 *   node scripts/simulate.js            # normal speed
 *   node scripts/simulate.js --fast     # 3x faster
 *   node scripts/simulate.js --via-hook # pipe every event through hook/agent-cody-hook.js (end-to-end)
 *   AGENT_CODY_PORT=5000 node scripts/simulate.js
 *
 * Covers: TodoWrite progress, Task tools progress, a permission request (approved
 * later), an AskUserQuestion, subagents, a Stop (finished), a StopFailure (error)
 * and a SessionEnd (row fades out).
 */
'use strict';
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { post, resolvePort } = require('../hook/agent-cody-hook.js');

const fast = process.argv.includes('--fast');
const viaHook = process.argv.includes('--via-hook');
const speed = fast ? 3 : 1;
const port = resolvePort();
const run = Date.now().toString(36);
const home = process.platform === 'win32' ? 'C:\\Users\\dev\\code' : '/Users/dev/code';
const sep = process.platform === 'win32' ? '\\' : '/';

const S = {
  api: { id: `sim-api-${run}`, cwd: `${home}${sep}payments-api` },
  web: { id: `sim-web-${run}`, cwd: `${home}${sep}marketing-site` },
  cli: { id: `sim-cli-${run}`, cwd: `${home}${sep}infra-cli` },
  docs: { id: `sim-docs-${run}`, cwd: `${home}${sep}handbook` },
};

const todos = (labels, doneCount, active = true) => labels.map((l, i) => ({
  content: l, activeForm: l.replace(/^(\w+)/, (w) => w + 'ing').replace(/eing\b/, 'ing').replace(/^Runing/, 'Running'),
  status: i < doneCount ? 'completed' : i === doneCount && active ? 'in_progress' : 'pending',
}));
const apiPlan = ['Read the payment handler', 'Add idempotency keys', 'Write migration', 'Update tests', 'Run test suite'];
const webPlan = ['Audit hero section', 'Fix layout shift', 'Compress images', 'Check Lighthouse'];

function ev(sess, hook_event_name, extra = {}) {
  return { session_id: sess.id, cwd: sess.cwd, transcript_path: '/dev/null', permission_mode: 'default', hook_event_name, ...extra };
}
const tool = (sess, phase, tool_name, tool_input, more = {}) => ev(sess, phase, { tool_name, tool_input, tool_use_id: 'toolu_' + Math.random().toString(36).slice(2), ...more });

// [secondsFromStart, event]
const script = [
  [0.0, ev(S.api, 'SessionStart', { source: 'startup' })],
  [0.3, ev(S.web, 'SessionStart', { source: 'startup' })],
  [0.6, ev(S.cli, 'SessionStart', { source: 'startup' })],
  [0.9, ev(S.docs, 'SessionStart', { source: 'resume' })],

  [1.5, ev(S.api, 'UserPromptSubmit', { prompt: 'Make the charge endpoint idempotent and add tests' })],
  [2.0, ev(S.web, 'UserPromptSubmit', { prompt: 'Improve the landing page performance score' })],
  [2.5, ev(S.cli, 'UserPromptSubmit', { prompt: 'Clean up the deploy script and remove the old flags' })],
  [3.0, ev(S.docs, 'UserPromptSubmit', { prompt: 'Rewrite the onboarding guide for new hires' })],

  [3.5, tool(S.api, 'PreToolUse', 'TodoWrite', { todos: todos(apiPlan, 0) })],
  [4.0, tool(S.api, 'PreToolUse', 'Read', { file_path: '/src/payments/charge.ts' })],
  [4.2, tool(S.web, 'PreToolUse', 'TodoWrite', { todos: todos(webPlan, 0) })],
  [4.6, tool(S.web, 'PreToolUse', 'Grep', { pattern: 'loading="lazy"' })],
  [5.0, tool(S.cli, 'PreToolUse', 'Read', { file_path: '/scripts/deploy.sh' })],
  [5.4, tool(S.docs, 'PreToolUse', 'Glob', { pattern: 'docs/**/*.md' })],

  // docs uses the newer Task tools (TaskCreated/TaskCompleted events + TaskUpdate)
  [6.0, ev(S.docs, 'TaskCreated', { task_id: '1', task_subject: 'Outline new structure' })],
  [6.1, ev(S.docs, 'TaskCreated', { task_id: '2', task_subject: 'Rewrite first-week section' })],
  [6.2, ev(S.docs, 'TaskCreated', { task_id: '3', task_subject: 'Add tooling setup page' })],
  [6.5, tool(S.docs, 'PostToolUse', 'TaskUpdate', { taskId: '1', status: 'in_progress', activeForm: 'Outlining new structure' })],

  [7.5, tool(S.api, 'PreToolUse', 'TodoWrite', { todos: todos(apiPlan, 1) })],
  [8.0, tool(S.api, 'PreToolUse', 'Edit', { file_path: '/src/payments/charge.ts' })],
  [8.5, tool(S.web, 'PreToolUse', 'Agent', { description: 'Find render-blocking assets', subagent_type: 'Explore' })],
  [8.6, ev(S.web, 'SubagentStart', { agent_id: 'a1', agent_type: 'Explore' })],
  [9.0, tool(S.web, 'PreToolUse', 'Read', { file_path: '/src/app/layout.tsx' }, { agent_id: 'a1', agent_type: 'Explore' })],

  // cli needs permission to run a destructive command
  [10.0, tool(S.cli, 'PreToolUse', 'Bash', { command: 'rm -rf ./legacy-flags', description: 'Remove legacy flag files' })],
  [10.1, tool(S.cli, 'PermissionRequest', 'Bash', { command: 'rm -rf ./legacy-flags', description: 'Remove legacy flag files' })],
  [10.2, ev(S.cli, 'Notification', { notification_type: 'permission_prompt', title: 'Permission needed', message: 'Claude needs your permission to use Bash' })],

  [11.0, ev(S.docs, 'TaskCompleted', { task_id: '1', task_subject: 'Outline new structure' })],
  [11.2, tool(S.docs, 'PostToolUse', 'TaskUpdate', { taskId: '2', status: 'in_progress', activeForm: 'Rewriting first-week section' })],
  [11.5, tool(S.docs, 'PreToolUse', 'Write', { file_path: '/docs/first-week.md' })],

  [12.5, tool(S.api, 'PreToolUse', 'TodoWrite', { todos: todos(apiPlan, 2) })],
  [13.0, tool(S.api, 'PreToolUse', 'Write', { file_path: '/migrations/0042_idempotency.sql' })],
  [13.5, ev(S.web, 'SubagentStop', { agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'Found 3 render-blocking fonts' })],
  [14.0, tool(S.web, 'PreToolUse', 'TodoWrite', { todos: todos(webPlan, 1) })],
  [14.4, tool(S.web, 'PreToolUse', 'Edit', { file_path: '/src/components/Hero.tsx' })],

  // docs asks a question
  [16.0, tool(S.docs, 'PreToolUse', 'AskUserQuestion', { questions: [{ question: 'Should the guide cover Windows setup too?', header: 'Platforms' }] })],

  [17.0, tool(S.api, 'PreToolUse', 'TodoWrite', { todos: todos(apiPlan, 3) })],
  [17.5, tool(S.api, 'PreToolUse', 'Edit', { file_path: '/test/charge.test.ts' })],
  [19.0, tool(S.web, 'PreToolUse', 'TodoWrite', { todos: todos(webPlan, 2) })],
  [19.5, tool(S.web, 'PreToolUse', 'Bash', { command: 'npx squoosh-cli public/*.png', description: 'Compress hero images' })],

  // user approves cli's permission after ~10s
  [20.5, tool(S.cli, 'PostToolUse', 'Bash', { command: 'rm -rf ./legacy-flags', description: 'Remove legacy flag files' })],
  [21.0, tool(S.cli, 'PreToolUse', 'Edit', { file_path: '/scripts/deploy.sh' })],

  [22.0, tool(S.api, 'PreToolUse', 'TodoWrite', { todos: todos(apiPlan, 4) })],
  [22.5, tool(S.api, 'PreToolUse', 'Bash', { command: 'npm test', description: 'Run test suite' })],

  // web hits an API error
  [25.0, ev(S.web, 'StopFailure', { error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error: Rate limit reached' })],

  [26.0, tool(S.docs, 'PostToolUse', 'AskUserQuestion', { questions: [{ question: 'Should the guide cover Windows setup too?' }] })],
  [26.5, ev(S.docs, 'TaskCompleted', { task_id: '2', task_subject: 'Rewrite first-week section' })],
  [26.6, tool(S.docs, 'PostToolUse', 'TaskUpdate', { taskId: '3', status: 'in_progress', activeForm: 'Adding tooling setup page' })],

  // api finishes its turn
  [28.0, tool(S.api, 'PreToolUse', 'TodoWrite', { todos: todos(apiPlan, 5) })],
  [28.5, ev(S.api, 'Stop', { stop_hook_active: false, last_assistant_message: 'Charge endpoint is now idempotent. Added migration 0042 and 6 tests, all passing.', background_tasks: [], session_crons: [] })],

  [30.0, tool(S.cli, 'PreToolUse', 'Bash', { command: './deploy.sh --dry-run', description: 'Dry-run the deploy script' })],
  [33.0, ev(S.cli, 'Stop', { last_assistant_message: 'Removed 4 legacy flags; dry run succeeded.', background_tasks: [], session_crons: [] })],

  // cli session is closed by the user -> row fades out
  [38.0, ev(S.cli, 'SessionEnd', { reason: 'prompt_input_exit' })],

  [40.0, ev(S.docs, 'TaskCompleted', { task_id: '3', task_subject: 'Add tooling setup page' })],
  [41.0, ev(S.docs, 'Stop', { last_assistant_message: 'Onboarding guide rewritten (3 sections).', background_tasks: [], session_crons: [] })],
];

const HOOK = path.join(__dirname, '..', 'hook', 'agent-cody-hook.js');
function sendViaHook(evt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, AGENT_CODY_PORT: String(port) } });
    child.on('exit', () => resolve(true));
    child.stdin.end(JSON.stringify(evt));
  });
}

async function main() {
  console.log(`Agent Cody simulator → http://127.0.0.1:${port}${viaHook ? ' (via hook script)' : ''}`);
  const ok = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
  if (!ok) {
    console.error('Agent Cody does not seem to be running (start it with `npm start`). Sending anyway…');
  }
  const t0 = Date.now();
  for (const [at, evt] of script) {
    const wait = t0 + (at * 1000) / speed - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const sent = viaHook ? await sendViaHook(evt) : await post(evt, port, 800);
    const name = path.basename(evt.cwd);
    console.log(`${(at).toFixed(1).padStart(5)}s  ${name.padEnd(15)} ${evt.hook_event_name.padEnd(18)} ${evt.tool_name || evt.notification_type || evt.error || ''}${sent ? '' : '  (not delivered)'}`);
  }
  console.log('Done. Rows that finished stay visible; the ended session fades out.');
}

main();
