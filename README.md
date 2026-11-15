# Agent Cody

A small, always-on-top desktop widget that shows live progress of every Claude Code session running on your machine, and sends a native notification when a session needs permission, asks a question, finishes, or stops.

- Compact rows, one per agent: status dot, project name, one-line activity, a small step bar with `3/5`, and an **Open** button.
- Rows that need permission or an answer get an orange tint and a filled Open button until you handle them. Finished rows say `Finished · 4m 12s`; stopped or errored rows say `Stopped · error`. Ended sessions fade out.
- Light and dark themes (or follow the OS), switchable from the header.
- Minimises to a pill: `4 agents` with tiny per-agent bars, solid orange `infra-cli needs you` with an Open button, or `All 4 agents finished`. Position, size and minimised state are remembered.
- Settings panel (gear icon): theme, which notifications you get, sound, keep on top, start at login.
- Tray / menu-bar icon to show or hide the widget, open settings, toggle sound, install or uninstall hooks, and quit.
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

The widget appears in the top-right corner, and an icon appears in the menu bar (macOS) or system tray (Windows).

## See it working without real agents

With the app running, in a second terminal:

```bash
npm run simulate:showcase # every state at once, alternating light/dark previews
npm run simulate          # ~45s of fake activity for 4 sessions
npm run simulate -- --fast
npm run simulate:hook     # same, but every event goes through the real hook script
```

The showcase puts six agents on screen: working with a 3/5 plan, working without a to-do list (sweeping bar), needs permission, asks a question, finished (`Finished · 4m 12s`), and stopped (`Stopped · error`). It previews the light and dark themes twice (`--cycles=N`, `--hold=ms`), then returns to your saved theme. The preview doesn't change your setting.

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
| **Open** button, or click a row | Marks the row as handled and brings that session's terminal or editor window to the front (see [Open](#open-behaviour)) |
| Hover a row → × | Dismiss the row (it comes back if that session gets a new prompt) |
| Moon / sun | Switch between light and dark. This saves an explicit choice; pick **System** in Settings to follow the OS again |
| Gear | Settings (back arrow or Esc returns to the list) |
| Chevron | Minimise to the pill. Click the pill to expand. Drag it by its dotted grip |
| Pill's **Open** | Opens the agent that needs you |
| Click a notification | Opens that agent's window, like Open. If that isn't possible, the widget appears with a hint |
| Tray icon | Show/hide, minimise, settings, sound, hooks, quit |

Row states:

| Dot | Second line | Meaning |
| --- | --- | --- |
| Orange, pulsing | step bar + `3/5`, or sweeping bar + `working` | Working (sweep = no to-do list) |
| Orange, tinted row | `Needs permission` / `Needs your answer` | Waiting for you |
| Green | `Finished · 4m 12s` | Turn finished (time since your prompt) |
| Pink | `Stopped · error` / `interrupted` / `no updates` / `exited` / `ended` | API error, Esc mid-tool, silent for `staleMinutes`, process vanished, or session ended mid-work |
| Hollow | `Ready` | Session open, no prompt yet |

### Settings

| Setting | Default |
| --- | --- |
| Theme: Light / Dark / System (System follows macOS/Windows, live) | System |
| Notify when an agent needs permission or asks a question | On |
| Notify when an agent stops or errors | On |
| Notify when an agent finishes | Off |
| Play a sound | On |
| Keep on top of other windows | On |
| Start when I log in (installed app only; never registers the dev build) | On |

All settings persist between launches. The Settings panel also shows hook status, with Install/Reinstall/Uninstall buttons.

### Open behaviour

Best effort, and it never fails silently:

1. **macOS, Terminal.app and iTerm2:** focuses the exact tab, by matching the tty of the session's Claude process. The first time, macOS asks whether Agent Cody may control Terminal/iTerm2. If you decline, it falls back to step 3.
2. **macOS, VS Code / Cursor / Windsurf / VSCodium / Zed:** opens the project folder in that editor, which brings its window to the front. If the folder isn't open in a window yet, a new one opens.
3. **macOS, other apps** (Warp, Ghostty, WezTerm, JetBrains…): activates the app and shows the hint "look for the *project* tab".
4. **Windows:** walks up from the Claude process to its first ancestor with a window and activates it. Windows may only flash the taskbar button.
5. **If none of that works:** opens the project folder in Finder/Explorer and says so. If the folder doesn't exist either, it shows a hint with the path.

## Configuration

Settings live in `settings.json` in the app's data folder (tray → **Open settings folder**):

- macOS: `~/Library/Application Support/Agent Cody/settings.json`
- Windows: `%APPDATA%\Agent Cody\settings.json`

```json
{
  "port": 47821,
  "theme": "system",
  "notify": { "attention": true, "stopped": true, "finished": false },
  "sound": true,
  "alwaysOnTop": true,
  "openAtLogin": true,
  "staleMinutes": 10,
  "fadeSeconds": 8
}
```

Most of these can be changed in the Settings panel. Edit `port`, `staleMinutes` and `fadeSeconds` in the file while the app is closed. Settings files from 0.1 (`muted`, `notifyOn`) are migrated automatically. Window position, size and minimised state carry over. On start, the app writes the port to `~/.agent-cody/config.json`, and the hook reads it from there, so you don't need to reinstall hooks after changing the port. `AGENT_CODY_PORT=<n>` overrides the port temporarily for both the app and the simulator, without touching the hook config. `AGENT_CODY_USER_DATA=<dir>` uses a separate profile, which is handy for testing.

## Build installers

```bash
npm run icons      # regenerates build/icon.png (already committed; only needed if you change the icon)
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
- `src/main/focus.js`: best-effort window focusing (tty matching, editor folders, app activation).
- `src/main/settings.js`: persisted settings with validation and migration.
- `src/main/main.js`: window, tray, IPC and notifications wiring. `src/renderer/`: the UI.

Run the tests with `npm test`. They cover the reducer (states, turn timing, stop reasons), settings defaults and migration, installer safety (preserving hooks, idempotency, invalid JSON, uninstall restoring the original file), and the hook script (exits fast with no app running, drops file contents).

## Privacy

Everything stays on your machine. The hook sends only the session id, project path, event name, tool name, short descriptions (file name, command or description, search pattern, truncated prompt or last message), to-do statuses, and terminal identification for the Open button. It never sends file contents, diffs or transcripts. The app makes no outbound network requests.

## Known limitations

- **Open is best effort** (see [Open behaviour](#open-behaviour)).
  - Exact-tab focus only works for Terminal.app and iTerm2, and only for sessions started after the hooks were installed (it needs the Claude process id).
  - The iTerm2 script couldn't be checked on the build machine, because iTerm2 isn't installed there.
  - Windows Terminal tabs can't be targeted individually.
- **Progress bars need a plan.** They come from `TodoWrite` or the Task tools (`TaskCreate`/`TaskUpdate`, plus the `TaskCreated`/`TaskCompleted` events). Claude Code only enables those tools by default on some models (see "Task tool availability" in the Claude Code tools reference). Sessions without a plan show a sweeping bar and `working` instead of a step count.
- **The hook needs Node.js.** The installer records the absolute path to `node`. For version managers (nvm, fnm, volta, asdf…) it records plain `node`, so it follows your active version. If Node isn't found, the hook fails silently and the widget stays empty.
- **Interrupts:** pressing Esc doesn't fire `Stop`. Agent Cody only sees an interrupt if a tool was running (`PostToolUseFailure` with `is_interrupt`). Otherwise the row shows *working* until the next event, or `Stopped · no updates` after `staleMinutes`.
- **"Needs permission" clears** when Claude continues (the next tool event, prompt or stop) or when you press Open. Pressing Open counts as handled even if you didn't answer in the terminal.
- **Start when I log in** only applies to the installed app. Running from source never registers a login item.
- **Theme preview:** the showcase's light/dark preview overrides the display only. Your saved theme is restored when the showcase ends, or when you change the theme.
- **Sessions that started before the app** appear on their next event. Their step progress fills in at the next plan update.
- **Windows notifications** need the installed app (the NSIS installer registers the Start-menu shortcut and AppUserModelID). When running from source, Windows may not show toasts.
- **Untested on real Windows hardware:** the code paths and the Windows build were checked from macOS only.
- Linux isn't a target, though the app mostly works there (no click-to-focus).
