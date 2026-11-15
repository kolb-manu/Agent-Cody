# Agent Cody

A small, always-on-top desktop widget that shows live progress of every Claude Code session running on your machine, and sends a native notification when a session needs permission, asks a question, finishes, or stops.

- One row per session: coloured mascot, project folder name, current activity, step progress (`2/5`) and status.
- Rows that need you are highlighted until you handle them. Ended sessions fade out.
- Collapses to a small pill (`● 4 agents` / `● 1 needs you · 4`). Position, size and collapsed state are remembered.
- Tray / menu-bar icon to show or hide the widget, mute sounds, install or uninstall hooks, and quit.
- Runs fully locally: the only network traffic is the hook talking to `127.0.0.1`.

Works on macOS and Windows (Electron, plain JavaScript, no native modules).

## Requirements

- Node.js 18+ (for development, and on PATH for the hook. See [Known limitations](#known-limitations)).
- Claude Code with hooks support.

## Install and run (development)

```bash
npm install
npm start
```

The widget appears in the top-right corner, and a mascot icon appears in the menu bar (macOS) or system tray (Windows).

## See it working without real agents

With the app running, in a second terminal:

```bash
npm run simulate          # ~45s of fake activity for 4 sessions
npm run simulate -- --fast
npm run simulate:hook     # same, but every event goes through the real hook script
```

The simulation includes TodoWrite progress, Task-tool progress, subagents, a permission request (approved after ~10s), a question, a finished turn, an API error, and a session that ends and fades out. You get native notifications for the permission request, the question, the finishes and the error.

## Install the Claude Code hooks

Pick one:

- Click **Install Claude Code hooks** in the widget, which appears when no hooks are installed.
- Use the tray menu: **Install Claude Code hooks…**
- From the terminal: `npm run hooks:install` (`hooks:status`, `hooks:uninstall`)

What the installer does:

1. Copies `hook/agent-cody-hook.js` to `~/.agent-cody/agent-cody-hook.js`, a stable location outside the app bundle.
2. Backs up `~/.claude/settings.json` to `settings.json.agent-cody-backup-<timestamp>`.
3. Appends one entry per event and never modifies or removes your existing hooks. Reinstalling replaces only Agent Cody's own entries. If `settings.json` isn't valid JSON, it refuses and changes nothing.

Each added entry looks like this. It runs in exec form, with no shell, so it behaves the same on macOS and Windows:

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "/usr/local/bin/node",
                    "args": ["/Users/you/.agent-cody/agent-cody-hook.js", "--exec"], "async": true }] }
    ]
  }
}
```

Events used: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `SessionEnd`.

All events except `SessionEnd` are `async: true`, so Claude Code never waits for them. `SessionEnd` runs synchronously with a 3s timeout, because async hooks may be killed while Claude exits. The script caps itself at 1.5s, exits 0 silently, and fails fast (connection refused) when the app isn't running.

New Claude Code sessions pick up the hooks. If an already-running session doesn't show up, restart it.

**Uninstall:** use the tray menu, or run `npm run hooks:uninstall`. This removes only entries containing `agent-cody-hook` and makes a backup first. You can also delete `~/.agent-cody/`.

## Using it

| Action | Result |
| --- | --- |
| Click a row | Clears its "needs you" highlight and tries to bring that session's terminal or editor to the front |
| Hover a row → × | Dismiss the row (it comes back if that session gets a new prompt) |
| `–` in the title bar | Collapse to the pill. Click the pill to expand. Drag the pill by its dotted grip |
| `×` in the title bar | Hide to the tray |
| Bell | Mute or unmute notification sounds (notifications still show) |
| Click a notification | Shows and expands the widget, and flashes that row |

Status meanings: **Working**, **Needs you** (permission, question or input), **Done** (turn finished), **Error** (API error), **Ready** (idle), **Quiet** (was working, but no events for 10 min), **Ended**.

You get a notification when a session needs permission or input, finishes a turn, ends with an API error, is interrupted mid-tool, goes quiet while working, ends while still working, or its Claude process disappears. Quitting an idle session yourself doesn't notify.

## Configuration

Settings live in `settings.json` in the app's data folder (tray → **Open settings folder**):

- macOS: `~/Library/Application Support/Agent Cody/settings.json`
- Windows: `%APPDATA%\Agent Cody\settings.json`

```json
{
  "port": 47821,
  "muted": false,
  "staleMinutes": 10,
  "fadeSeconds": 8,
  "notifyOn": { "permission": true, "question": true, "done": true, "error": true, "stopped": true, "stale": true }
}
```

Edit the file while the app is closed. On start, the app writes the port to `~/.agent-cody/config.json`, and the hook reads it from there, so you don't need to reinstall hooks after changing the port. `AGENT_CODY_PORT=<n>` overrides the port temporarily for both the app and the simulator, without touching the hook config. `AGENT_CODY_USER_DATA=<dir>` uses a separate profile, which is handy for testing.

## Build installers

```bash
npm run icons      # regenerates build/icon.png (already committed; only needed if you change the mascot)
npm run dist:mac   # → dist/Agent Cody-<version>-arm64.dmg and .zip
npm run dist:win   # → dist/Agent Cody Setup <version>.exe (NSIS) and a portable .exe
npm run pack       # unpacked app for the current OS, for quick testing
```

- **macOS:** builds are unsigned unless you configure signing (`CSC_LINK` / `CSC_KEY_PASSWORD`, plus notarization). For an unsigned app, right-click → **Open** the first time. Build for Intel with `npx electron-builder --mac --x64`.
- **Windows:** build on Windows for the most reliable result. Building from macOS works for `--dir` and portable targets, but the NSIS installer and icon editing may need Wine. Without a code-signing certificate, SmartScreen warns on first run.

## How it works

```
Claude Code ──hook (stdin JSON)──▶ node ~/.agent-cody/agent-cody-hook.js
                                        │ keeps ~20 small fields (no file contents, no transcripts)
                                        ▼
                              POST http://127.0.0.1:47821/event  (header X-Agent-Cody: 1)
                                        ▼
                     Electron main: SessionStore (state per session_id) ──▶ widget, tray, notifications
```

- `hook/agent-cody-hook.js`: dependency-free hook script.
- `src/main/sessions.js`: pure event → state reducer (unit-tested). Handles staleness, dead processes and fade-out.
- `src/main/server.js`: localhost-only receiver. It requires a custom header, so web pages can't post events.
- `src/main/hooks-installer.js`: safe merge into, and removal from, `~/.claude/settings.json`.
- `src/main/focus.js`: best-effort window focusing.
- `src/main/main.js`: window, tray, IPC and notifications wiring. `src/renderer/`: the UI.

Run the tests with `npm test`. They cover the reducer, installer safety (preserving hooks, idempotency, invalid JSON, uninstall restoring the original file), and the hook script (exits fast with no app running, drops file contents).

## Privacy

Everything stays on your machine. The hook sends only the session id, project path, event name, tool name, short descriptions (file name, command or description, search pattern, truncated prompt or last message), to-do statuses, and terminal identification for click-to-focus. It never sends file contents, diffs or transcripts. The app makes no outbound network requests.

## Known limitations

- **Click to focus is best effort.**
  - macOS activates the app that launched the session (Terminal, iTerm2, VS Code, Warp, Ghostty…, detected via `__CFBundleIdentifier` / `TERM_PROGRAM`). It brings the app to the front, not the specific tab or window.
  - Windows walks up from the Claude process to the first ancestor with a window and asks Windows to activate it. Windows may refuse to steal focus and flash the taskbar button instead. Windows Terminal tabs can't be targeted individually.
  - On other platforms, or if nothing is detected, clicking does nothing except clear the highlight, and a short message says so.
- **Progress bars need a plan.** They come from `TodoWrite` or the Task tools (`TaskCreate`/`TaskUpdate`, plus the `TaskCreated`/`TaskCompleted` events). Claude Code only enables those tools by default on some models (see "Task tool availability" in the Claude Code tools reference). Sessions without a plan show activity but no bar.
- **The hook needs Node.js.** The installer records the absolute path to `node`. For version managers (nvm, fnm, volta, asdf…) it records plain `node`, so it follows your active version. If Node isn't found, the hook fails silently and the widget stays empty.
- **Interrupts:** pressing Esc doesn't fire `Stop`. Agent Cody only sees an interrupt if a tool was running (`PostToolUseFailure` with `is_interrupt`). Otherwise the row shows *Working* until the next event, or *Quiet* after `staleMinutes`.
- **"Needs you" clears** when Claude continues (the next tool event, prompt or stop) or when you click the row. Clicking counts as handled even if you didn't answer in the terminal.
- **Sessions that started before the app** appear on their next event. Their step progress fills in at the next plan update.
- **Windows notifications** need the installed app (the NSIS installer registers the Start-menu shortcut and AppUserModelID). When running from source, Windows may not show toasts.
- **Untested on real Windows hardware:** the code paths and the Windows build were checked from macOS only.
- Linux isn't a target, though the app mostly works there (no click-to-focus).
