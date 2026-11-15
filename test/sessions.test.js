'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { SessionStore, describeTool, normalizeTaskId } = require('../src/main/sessions.js');

function mk(opts = {}) {
  let t = 1_000_000;
  const store = new SessionStore({ now: () => t, staleMs: 60_000, fadeMs: 5_000, ...opts });
  return { store, advance: (ms) => { t += ms; }, ev: (id, name, extra = {}) => store.handle({ session_id: id, cwd: `/home/u/${id}-proj`, hook_event_name: name, ...extra }) };
}
const get = (store, id) => store.list().find((s) => s.id === id);

test('labels sessions by project folder, including Windows paths', () => {
  const { store } = mk();
  store.handle({ session_id: 'w', cwd: 'C:\\Users\\me\\code\\my-app\\', hook_event_name: 'SessionStart' });
  assert.equal(get(store, 'w').name, 'my-app');
});

test('tracks multiple sessions independently, creating them on first event', () => {
  const { store, ev } = mk();
  ev('a', 'UserPromptSubmit', { prompt: 'hi' });
  ev('b', 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x/y/z.js' } });
  assert.equal(store.list().length, 2);
  assert.equal(get(store, 'a').state, 'working');
  assert.equal(get(store, 'b').activity, 'Reading z.js');
});

test('permission request notifies once and clears when the tool runs', () => {
  const { store, ev } = mk();
  ev('a', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf x', description: 'Remove x' } });
  const n1 = ev('a', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf x', description: 'Remove x' } });
  const n2 = ev('a', 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.equal(n1.length, 1);
  assert.equal(n1[0].kind, 'permission');
  assert.equal(n2.length, 0, 'duplicate permission signal must not notify again');
  assert.equal(get(store, 'a').state, 'attention');
  assert.match(get(store, 'a').attention.message, /Remove x/);
  ev('a', 'PostToolUse', { tool_name: 'Bash', tool_input: {} });
  assert.equal(get(store, 'a').state, 'working');
  assert.equal(get(store, 'a').attention, null);
});

test('AskUserQuestion raises a question with the question text (raw and slimmed input)', () => {
  const { store, ev } = mk();
  const n = ev('a', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Tabs or spaces?' }] } });
  assert.equal(n[0].kind, 'question');
  assert.equal(get(store, 'a').attention.message, 'Tabs or spaces?');
  ev('b', 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { question: 'Ship it?' } });
  assert.equal(get(store, 'b').attention.message, 'Ship it?');
});

test('TodoWrite drives step progress', () => {
  const { store, ev } = mk();
  ev('a', 'PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [
    { content: 'A', status: 'completed', activeForm: 'Doing A' },
    { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
    { content: 'C', status: 'pending', activeForm: 'Doing C' },
  ] } });
  assert.deepEqual(get(store, 'a').steps, { done: 1, total: 3, current: 'Doing B' });
});

test('Task tools + TaskCreated/TaskCompleted drive step progress with id normalisation', () => {
  const { store, ev } = mk();
  ev('a', 'TaskCreated', { task_id: 'task-001', task_subject: 'One' });
  ev('a', 'TaskCreated', { task_id: 'task-002', task_subject: 'Two' });
  ev('a', 'PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'in_progress', activeForm: 'Doing one' } });
  assert.deepEqual(get(store, 'a').steps, { done: 0, total: 2, current: 'Doing one' });
  ev('a', 'TaskCompleted', { task_id: 'task-001', task_subject: 'One' });
  ev('a', 'PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' } });
  assert.equal(get(store, 'a').steps.done, 1);
  ev('a', 'PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: '2', status: 'deleted' } });
  assert.deepEqual(get(store, 'a').steps, { done: 1, total: 1, current: null });
});

test('TaskCreate response is used when TaskCreated did not fire', () => {
  const { store, ev } = mk();
  ev('a', 'PostToolUse', { tool_name: 'TaskCreate', tool_input: { subject: 'Write docs' }, tool_response_text: '{"task":{"id":"7","subject":"Write docs"}}' });
  assert.equal(get(store, 'a').steps.total, 1);
});

test('subagent tool events do not overwrite the main plan', () => {
  const { store, ev } = mk();
  ev('a', 'PreToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'A', status: 'pending' }] } });
  ev('a', 'PreToolUse', { tool_name: 'TodoWrite', agent_id: 'x', agent_type: 'Explore', tool_input: { todos: [] } });
  assert.equal(get(store, 'a').steps.total, 1);
  ev('a', 'PreToolUse', { tool_name: 'Read', agent_id: 'x', agent_type: 'Explore', tool_input: { file_path: '/a/b.md' } });
  assert.equal(get(store, 'a').activity, '[Explore] Reading b.md');
});

test('Stop notifies "done"; repeated Stop/idle_prompt do not spam', () => {
  const { store, ev } = mk();
  ev('a', 'UserPromptSubmit', { prompt: 'x' });
  const n1 = ev('a', 'Stop', { last_assistant_message: 'All good' });
  const n2 = ev('a', 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  const n3 = ev('a', 'Stop', {});
  assert.equal(n1[0].kind, 'done');
  assert.equal(n2.length + n3.length, 0);
  assert.equal(get(store, 'a').state, 'done');
});

test('StopFailure becomes an error with notification', () => {
  const { store, ev } = mk();
  const n = ev('a', 'StopFailure', { error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' });
  assert.equal(n[0].kind, 'error');
  assert.equal(get(store, 'a').state, 'error');
});

test('SessionEnd fades out, ignores trailing events, then removes the row', () => {
  const { store, ev, advance } = mk();
  ev('a', 'UserPromptSubmit', { prompt: 'x' });
  const n = ev('a', 'SessionEnd', { reason: 'other' });
  assert.equal(n[0].kind, 'stopped', 'ending mid-work notifies');
  assert.equal(get(store, 'a').state, 'ended');
  ev('a', 'PostToolUse', { tool_name: 'Read' });
  assert.equal(get(store, 'a').state, 'ended', 'late async event must not revive');
  advance(5_001);
  store.tick();
  assert.equal(get(store, 'a'), undefined);
});

test('ending an idle session does not notify', () => {
  const { ev } = mk();
  ev('a', 'Stop', {});
  assert.equal(ev('a', 'SessionEnd', { reason: 'prompt_input_exit' }).length, 0);
});

test('working sessions that go silent become stale', () => {
  const { store, ev, advance } = mk();
  ev('a', 'UserPromptSubmit', { prompt: 'x' });
  advance(61_000);
  const n = store.tick();
  assert.equal(n[0].kind, 'stale');
  assert.equal(get(store, 'a').state, 'stale');
  ev('a', 'PreToolUse', { tool_name: 'Read', tool_input: {} });
  assert.equal(get(store, 'a').state, 'working', 'activity revives a stale session');
});

test('dead Claude process ends the session', () => {
  let alive = true;
  const { store, ev } = mk({ isPidAlive: () => alive });
  ev('a', 'UserPromptSubmit', { prompt: 'x', claude_pid: 4242 });
  store.tick();
  assert.equal(get(store, 'a').state, 'working');
  alive = false;
  const n = store.tick();
  assert.equal(get(store, 'a').state, 'ended');
  assert.equal(n[0].kind, 'stopped');
});

test('dismiss removes a row; acknowledge clears attention', () => {
  const { store, ev } = mk();
  ev('a', 'PermissionRequest', { tool_name: 'Bash', tool_input: {} });
  store.acknowledge('a');
  assert.equal(get(store, 'a').state, 'working');
  store.dismiss('a');
  assert.equal(get(store, 'a'), undefined);
  ev('a', 'PostToolUse', { tool_name: 'Read' });
  assert.equal(get(store, 'a'), undefined, 'trailing events after dismiss are ignored');
  ev('a', 'UserPromptSubmit', { prompt: 'again' });
  assert.equal(get(store, 'a').state, 'working', 'a new prompt brings it back');
});

test('live sessions get distinct colours while the palette allows', () => {
  const { store, ev } = mk();
  for (let i = 0; i < 8; i++) ev(`s${i}`, 'SessionStart');
  assert.equal(new Set(store.list().map((s) => s.colorIndex)).size, 8);
});

test('ignores malformed events', () => {
  const { store } = mk();
  assert.deepEqual(store.handle(null), []);
  assert.deepEqual(store.handle({ hook_event_name: 'Stop' }), []);
  assert.equal(store.list().length, 0);
});

test('describeTool and normalizeTaskId', () => {
  assert.equal(describeTool('mcp__github__create_issue', {}), 'github: create_issue');
  assert.equal(describeTool('Bash', { command: 'ls' }), 'Running ls');
  assert.equal(normalizeTaskId('task-007'), '7');
  assert.equal(normalizeTaskId('#3'), '3');
});

test('finished turns record their duration; hook timestamp backdates the start', () => {
  const { store, ev, advance } = mk();
  ev('a', 'UserPromptSubmit', { prompt: 'x' });
  advance(252_000);
  ev('a', 'Stop', {});
  assert.equal(get(store, 'a').turnMs, 252_000);
  ev('b', 'UserPromptSubmit', { prompt: 'x', ts: store.now() - 60_000 });
  ev('b', 'Stop', {});
  assert.equal(get(store, 'b').turnMs, 60_000);
  ev('c', 'UserPromptSubmit', { prompt: 'x', ts: store.now() + 10 * 60_000 });
  ev('c', 'Stop', {});
  assert.equal(get(store, 'c').turnMs, 0, 'future timestamps are ignored');
});

test('interrupt mid-tool becomes "stopped" with a reason; a new prompt clears it', () => {
  const { store, ev } = mk();
  ev('a', 'UserPromptSubmit', { prompt: 'x' });
  const n = ev('a', 'PostToolUseFailure', { tool_name: 'Bash', is_interrupt: true, error: 'interrupted' });
  assert.equal(n[0].kind, 'stopped');
  assert.equal(get(store, 'a').state, 'stopped');
  assert.equal(get(store, 'a').stopReason, 'interrupted');
  ev('a', 'UserPromptSubmit', { prompt: 'again' });
  assert.equal(get(store, 'a').stopReason, null);
});

test('errors, staleness and abnormal ends carry a stop reason', () => {
  const { store, ev, advance } = mk();
  ev('e', 'StopFailure', { error: 'overloaded' });
  assert.equal(get(store, 'e').stopReason, 'error');
  ev('s', 'UserPromptSubmit', { prompt: 'x' });
  ev('x', 'UserPromptSubmit', { prompt: 'x' });
  ev('x', 'SessionEnd', { reason: 'other' });
  assert.equal(get(store, 'x').stopReason, 'ended');
  advance(61_000);
  store.tick();
  assert.equal(get(store, 's').stopReason, 'no updates');
});
