'use strict';
/*
 * SessionStore: turns Claude Code hook events into per-session UI state.
 * Pure Node (no Electron) so it can be unit tested.
 *
 * States:
 *   idle      session open, waiting for a prompt
 *   working   Claude is doing something
 *   attention needs permission / asked a question / waiting for input
 *   done      finished its turn (Stop)
 *   error     turn ended with an API error (StopFailure)
 *   stopped   turn was interrupted by the user mid-tool
 *   stale     was working but stopped reporting for a long time
 *   ended     session ended (SessionEnd or the Claude process exited); fades out
 */
const path = require('path');
const { EventEmitter } = require('events');

const PALETTE_SIZE = 8;

function basenameAny(p) {
  if (!p) return 'Claude session';
  const trimmed = String(p).replace(/[\\/]+$/, '');
  return path.win32.basename(path.posix.basename(trimmed)) || trimmed || 'Claude session';
}

function hashIndex(s, n) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h) % n;
}

function short(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function normalizeTaskId(id) {
  if (id === undefined || id === null) return null;
  const m = String(id).match(/(\d+)\s*$/);
  return m ? String(parseInt(m[1], 10)) : String(id);
}

function questionOf(ti) {
  if (!ti) return '';
  if (ti.question) return ti.question;
  const q = Array.isArray(ti.questions) && ti.questions[0];
  return q ? (q.question || q.header || '') : '';
}

function describeTool(name, ti) {
  ti = ti || {};
  const file = (p) => basenameAny(p);
  switch (name) {
    case 'Bash': case 'PowerShell':
      return ti.description ? short(ti.description, 80) : `Running ${short(ti.command, 60)}`;
    case 'Read': return `Reading ${file(ti.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${file(ti.file_path)}`;
    case 'Write': return `Writing ${file(ti.file_path)}`;
    case 'NotebookEdit': return `Editing ${file(ti.notebook_path)}`;
    case 'Grep': return `Searching for “${short(ti.pattern, 40)}”`;
    case 'Glob': return `Finding files ${short(ti.pattern, 40)}`;
    case 'LS': return `Listing ${file(ti.path)}`;
    case 'WebFetch': {
      let host = ti.url;
      try { host = new URL(ti.url).host; } catch (_) { /* keep raw */ }
      return `Fetching ${short(host, 50)}`;
    }
    case 'WebSearch': return `Searching the web: ${short(ti.query, 50)}`;
    case 'Agent': case 'Task':
      return `Delegating: ${short(ti.description || ti.subagent_type || 'subagent', 60)}`;
    case 'TodoWrite': return 'Updating the plan';
    case 'TaskCreate': return `Planning: ${short(ti.subject, 60)}`;
    case 'TaskUpdate': return ti.status === 'in_progress' && (ti.activeForm || ti.subject)
      ? short(ti.activeForm || ti.subject, 80) : 'Updating tasks';
    case 'TaskList': case 'TaskGet': return 'Checking tasks';
    case 'AskUserQuestion': return questionOf(ti) ? `Asks: ${short(questionOf(ti), 70)}` : 'Asking you a question';
    case 'ExitPlanMode': return 'Plan ready for review';
    case 'Skill': return `Using skill ${short(ti.skill, 40)}`;
    default:
      if (name && name.startsWith('mcp__')) {
        const [, server, ...tool] = name.split('__');
        return `${server}: ${tool.join('__')}`;
      }
      return name ? `Using ${name}` : 'Working';
  }
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return true; // unknown: assume alive
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class SessionStore extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} [opts.staleMs]  working sessions silent this long become "stale"
   * @param {number} [opts.fadeMs]   ended sessions are removed after this long
   * @param {number} [opts.forgetMs] idle/done sessions without a live pid are forgotten after this long
   * @param {() => number} [opts.now]
   * @param {(pid:number) => boolean} [opts.isPidAlive]
   */
  constructor(opts = {}) {
    super();
    this.staleMs = opts.staleMs ?? 10 * 60 * 1000;
    this.fadeMs = opts.fadeMs ?? 8000;
    this.forgetMs = opts.forgetMs ?? 6 * 60 * 60 * 1000;
    this.now = opts.now || Date.now;
    this.isPidAlive = opts.isPidAlive || isPidAlive;
    this.sessions = new Map();
    this.dismissed = new Map(); // id -> dismissedAt; ignore stray events briefly after a dismiss/end
  }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((s) => this._public(s));
  }

  _public(s) {
    const steps = this._steps(s);
    return {
      id: s.id, name: s.name, cwd: s.cwd, title: s.title, state: s.state,
      activity: s.activity, detail: s.detail, attention: s.attention,
      steps, colorIndex: s.colorIndex, subagents: s.subagents,
      stopReason: s.stopReason, turnMs: s.turnMs,
      turnStartedAt: s.turnStartedAt,
      startedAt: s.startedAt, lastEventAt: s.lastEventAt, endedAt: s.endedAt,
      fadeAt: s.endedAt ? s.endedAt + this.fadeMs : null,
      canFocus: Boolean(s.termBundleId || s.termProgram || s.pid),
    };
  }

  _steps(s) {
    let items = null;
    if (s.todos) items = s.todos;
    else if (s.tasks.size) items = [...s.tasks.values()];
    if (!items || !items.length) return null;
    const total = items.length;
    const done = items.filter((t) => t.status === 'completed').length;
    const current = items.find((t) => t.status === 'in_progress');
    return { done, total, current: current ? short(current.activeForm || current.content || current.subject, 80) : null };
  }

  /** Stable per-session colour, avoiding colours already used by other live sessions. */
  _pickColor(id) {
    const used = new Set([...this.sessions.values()].filter((x) => x.state !== 'ended').map((x) => x.colorIndex));
    const start = hashIndex(id, PALETTE_SIZE);
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const c = (start + i) % PALETTE_SIZE;
      if (!used.has(c)) return c;
    }
    return start;
  }

  _get(e) {
    let s = this.sessions.get(e.session_id);
    if (!s) {
      const now = this.now();
      s = {
        id: e.session_id, cwd: e.cwd || '', name: basenameAny(e.cwd), title: null,
        state: 'idle', activity: 'Session detected', detail: null, attention: null,
        todos: null, tasks: new Map(), subagents: 0,
        colorIndex: this._pickColor(e.session_id),
        startedAt: now, lastEventAt: now, endedAt: null,
        pid: null, termBundleId: null, termProgram: null,
        turnStartedAt: null, turnMs: null, stopReason: null,
      };
      this.sessions.set(s.id, s);
    }
    return s;
  }

  /** Feed one (slimmed) hook event. Returns the notifications it should trigger. */
  handle(e) {
    if (!e || typeof e.session_id !== 'string' || !e.session_id) return [];
    const ev = e.hook_event_name;
    // A dismissed/ended session can still emit a trailing event; only a real new start revives it.
    if (this.dismissed.has(e.session_id) && ev !== 'SessionStart' && ev !== 'UserPromptSubmit') return [];
    this.dismissed.delete(e.session_id);

    const s = this._get(e);
    const notes = [];
    const prevState = s.state;
    const now = this.now();
    s.lastEventAt = now;
    if (e.cwd && e.cwd !== s.cwd) { s.cwd = e.cwd; s.name = basenameAny(e.cwd); }
    if (e.session_title) s.title = e.session_title;
    if (e.claude_pid) s.pid = e.claude_pid;
    if (e.term_bundle_id) s.termBundleId = e.term_bundle_id;
    if (e.term_program) s.termProgram = e.term_program;
    if (s.state === 'ended' || s.state === 'stale') { s.endedAt = null; s.state = 'working'; s.stopReason = null; }

    const fromSubagent = Boolean(e.agent_id);
    const prefix = fromSubagent && e.agent_type ? `[${e.agent_type}] ` : '';
    const ti = e.tool_input || {};

    const needAttention = (kind, message) => {
      const already = s.state === 'attention' && s.attention && s.attention.kind === kind;
      s.state = 'attention';
      // Keep the first (most specific) message: PermissionRequest says what, Notification is generic.
      s.attention = already ? s.attention : { kind, message: short(message, 160), since: now };
      if (!already) {
        notes.push({
          kind, sessionId: s.id,
          title: kind === 'permission' ? `${s.name} needs permission` : `${s.name} needs your input`,
          body: short(message, 180),
        });
      }
    };
    const clearAttention = () => { s.attention = null; };

    switch (ev) {
      case 'SessionStart':
        s.state = 'idle'; clearAttention();
        s.activity = e.source === 'resume' ? 'Session resumed' : e.source === 'compact' ? 'Context compacted' : 'Ready';
        if (e.source === 'clear' || e.source === 'startup') { s.todos = null; s.tasks.clear(); }
        break;

      case 'UserPromptSubmit':
        s.state = 'working'; clearAttention();
        // Prefer the hook's own timestamp (more accurate) when it's plausible.
        s.turnStartedAt = typeof e.ts === 'number' && e.ts <= now + 5000 && e.ts >= now - 24 * 3600 * 1000 ? Math.min(e.ts, now) : now;
        s.activity = 'Thinking…';
        s.detail = e.prompt ? `“${short(e.prompt, 100)}”` : null;
        break;

      case 'PreToolUse':
        if (e.tool_name === 'AskUserQuestion') {
          needAttention('question', questionOf(ti) || 'Claude is asking you a question');
          s.activity = 'Waiting for your answer';
          break;
        }
        if (e.tool_name === 'ExitPlanMode' && !fromSubagent) {
          needAttention('question', 'Plan ready: approve or give feedback');
          s.activity = describeTool(e.tool_name, ti);
          break;
        }
        s.state = 'working'; clearAttention();
        s.activity = prefix + describeTool(e.tool_name, ti);
        if (e.tool_name === 'TodoWrite' && Array.isArray(ti.todos) && !fromSubagent) s.todos = ti.todos;
        break;

      case 'PermissionRequest':
        needAttention('permission', `Allow ${e.tool_name || 'tool'}: ${describeTool(e.tool_name, ti)}?`);
        break;

      case 'PostToolUse':
        // Tool ran: any pending permission / question for the session is resolved.
        s.state = 'working'; clearAttention();
        if (!fromSubagent) this._applyTaskTool(s, e);
        break;

      case 'PostToolUseFailure':
        if (e.is_interrupt) {
          s.state = 'stopped'; clearAttention();
          s.stopReason = 'interrupted';
          s.turnStartedAt = null;
          s.activity = 'Interrupted';
          notes.push({ kind: 'stopped', sessionId: s.id, title: `${s.name} was interrupted`, body: describeTool(e.tool_name, ti) });
        } else {
          s.state = 'working'; clearAttention();
          s.activity = `${prefix}${e.tool_name || 'Tool'} failed, continuing`;
        }
        break;

      case 'Notification': {
        const t = e.notification_type;
        if (t === 'permission_prompt') needAttention('permission', e.message || 'Claude needs your permission');
        else if (t === 'elicitation_dialog' || t === 'elicitation_url_dialog' || t === 'agent_needs_input') {
          needAttention('question', e.message || 'Claude needs your input');
        } else if (t === 'idle_prompt') {
          // Fires after Claude has been waiting a while; Stop already notified, so only flag it.
          if (s.state !== 'attention' && s.state !== 'done' && s.state !== 'error') {
            s.state = 'done'; s.activity = 'Waiting for your input';
          }
        } else if (e.message) {
          s.detail = short(e.message, 100);
        }
        break;
      }

      case 'Stop': {
        if (fromSubagent) break;
        clearAttention();
        if (prevState !== 'done') s.turnMs = now - (s.turnStartedAt || s.startedAt);
        s.turnStartedAt = null;
        s.state = 'done';
        const bg = e.background_task_count || 0;
        s.activity = bg ? `Finished, ${bg} background task${bg > 1 ? 's' : ''} running` : 'Finished';
        s.detail = e.last_assistant_message ? short(e.last_assistant_message, 120) : s.detail;
        if (prevState !== 'done') {
          notes.push({ kind: 'done', sessionId: s.id, title: `${s.name} finished`, body: short(e.last_assistant_message || 'Claude is done and waiting for you.', 180) });
        }
        break;
      }

      case 'StopFailure':
        clearAttention();
        s.state = 'error';
        s.stopReason = 'error';
        s.turnStartedAt = null;
        s.activity = `Error: ${e.error || 'unknown'}`;
        s.detail = short(e.error_details || e.last_assistant_message, 120) || null;
        notes.push({ kind: 'error', sessionId: s.id, title: `${s.name} stopped with an error`, body: short(e.last_assistant_message || e.error_details || e.error || 'API error', 180) });
        break;

      case 'SubagentStart':
        s.subagents += 1;
        if (s.state !== 'attention') s.state = 'working';
        s.activity = `Started subagent ${e.agent_type || ''}`.trim();
        break;

      case 'SubagentStop':
        s.subagents = Math.max(0, s.subagents - 1);
        if (s.state !== 'attention') s.activity = `Subagent ${e.agent_type || ''} finished`.replace('  ', ' ');
        break;

      case 'TaskCreated': {
        const id = normalizeTaskId(e.task_id);
        if (id && !s.todos) s.tasks.set(id, { ...(s.tasks.get(id) || { status: 'pending' }), subject: e.task_subject });
        break;
      }

      case 'TaskCompleted': {
        const id = normalizeTaskId(e.task_id);
        if (id && !s.todos) s.tasks.set(id, { ...(s.tasks.get(id) || {}), subject: e.task_subject || (s.tasks.get(id) || {}).subject, status: 'completed' });
        break;
      }

      case 'SessionEnd': {
        const wasBusy = prevState === 'working' || prevState === 'attention';
        this._end(s, e.reason === 'clear' ? 'Cleared' : 'Session ended', true);
        if (wasBusy && e.reason !== 'clear' && e.reason !== 'resume') s.stopReason = 'ended';
        if (wasBusy && e.reason !== 'clear' && e.reason !== 'resume') {
          notes.push({ kind: 'stopped', sessionId: s.id, title: `${s.name} ended`, body: 'The session ended while Claude was still working.' });
        }
        break;
      }

      default:
        break; // unknown event: just counts as a heartbeat
    }
    // Turn timing for "Finished · 4m 12s": start at the prompt, or at the first sign of work.
    if ((s.state === 'working' || s.state === 'attention') && !s.turnStartedAt) s.turnStartedAt = now;
    if (s.state === 'working' || s.state === 'attention') { s.stopReason = null; s.turnMs = null; }
    this.emit('change');
    return notes;
  }

  _applyTaskTool(s, e) {
    const ti = e.tool_input || {};
    if (e.tool_name === 'TaskCreate') {
      const m = String(e.tool_response_text || '').match(/(?:"id"\s*:\s*"?|#|[Tt]ask\s+#?)(\d+)/);
      const id = m ? String(parseInt(m[1], 10)) : null;
      // Only add if the TaskCreated event didn't already register a task with this subject.
      const exists = [...s.tasks.values()].some((t) => t.subject && t.subject === ti.subject);
      if (id && !s.tasks.has(id) && !exists && !s.todos) s.tasks.set(id, { subject: ti.subject, activeForm: ti.activeForm, status: 'pending' });
    } else if (e.tool_name === 'TaskUpdate') {
      const id = normalizeTaskId(ti.taskId);
      if (!id || s.todos) return;
      if (ti.status === 'deleted') { s.tasks.delete(id); return; }
      const t = s.tasks.get(id) || { subject: `Task ${id}`, status: 'pending' };
      if (ti.status) t.status = ti.status;
      if (ti.subject) t.subject = ti.subject;
      if (ti.activeForm) t.activeForm = ti.activeForm;
      s.tasks.set(id, t);
    }
  }

  _end(s, activity, suppressTrailing) {
    s.state = 'ended'; s.attention = null;
    s.activity = activity;
    s.endedAt = this.now();
    // After SessionEnd, ignore stray trailing events (e.g. a late async hook) for a short while.
    if (suppressTrailing) this.dismissed.set(s.id, s.endedAt);
  }

  /** User handled the attention state (e.g. clicked the row). */
  acknowledge(id) {
    const s = this.sessions.get(id);
    if (!s || s.state !== 'attention') return;
    s.attention = null; s.state = 'working';
    this.emit('change');
  }

  dismiss(id) {
    if (!this.sessions.delete(id)) return;
    this.dismissed.set(id, this.now());
    this.emit('change');
  }

  getRaw(id) { return this.sessions.get(id); }

  /** Periodic housekeeping: dead processes, stale sessions, fading out. Returns notifications. */
  tick() {
    const now = this.now();
    const notes = [];
    let changed = false;
    for (const s of [...this.sessions.values()]) {
      if (s.state === 'ended') {
        if (now - s.endedAt >= this.fadeMs) { this.sessions.delete(s.id); changed = true; }
        continue;
      }
      if (s.pid && !this.isPidAlive(s.pid)) {
        const wasBusy = s.state === 'working' || s.state === 'attention';
        this._end(s, 'Claude process exited');
        if (wasBusy) s.stopReason = 'exited';
        if (wasBusy) notes.push({ kind: 'stopped', sessionId: s.id, title: `${s.name} stopped`, body: 'The Claude Code process exited unexpectedly.' });
        changed = true;
        continue;
      }
      const silentFor = now - s.lastEventAt;
      if ((s.state === 'working') && silentFor >= this.staleMs) {
        s.state = 'stale';
        s.stopReason = 'no updates';
        s.activity = `No updates for ${Math.round(silentFor / 60000)} min`;
        notes.push({ kind: 'stale', sessionId: s.id, title: `${s.name} went quiet`, body: `No activity for ${Math.round(silentFor / 60000)} minutes. It may have stopped.` });
        changed = true;
      } else if (!s.pid && ['idle', 'done', 'stale', 'error', 'stopped'].includes(s.state) && silentFor >= this.forgetMs) {
        this.sessions.delete(s.id); changed = true;
      }
    }
    for (const [id, at] of this.dismissed) if (now - at > 60 * 1000) this.dismissed.delete(id);
    if (changed) this.emit('change');
    return notes;
  }
}

module.exports = { SessionStore, describeTool, normalizeTaskId, basenameAny, PALETTE_SIZE };
