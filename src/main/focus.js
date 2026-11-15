'use strict';
/*
 * Best-effort "bring the session's terminal/editor to the front" (the Open button).
 *
 * Returns { ok, method, message }:
 *   method 'window'  the session's own window/tab was focused
 *          'app'     the right app was activated, but not a specific window/tab
 *          'none'    nothing could be focused (caller falls back to opening the project folder)
 *
 * macOS
 *   1. Terminal.app / iTerm2: find the tab whose tty matches the Claude process (AppleScript).
 *      First use triggers the macOS "Agent Cody wants to control Terminal" prompt.
 *   2. VS Code-family editors: `open -b <editor> <cwd>` focuses the window that has the folder open.
 *   3. Any other app (detected via __CFBundleIdentifier / TERM_PROGRAM): activate it.
 * Windows
 *   Walk up from the Claude process to the first ancestor with a window and activate it.
 *   Windows may refuse to steal focus; then the taskbar button flashes.
 *
 * Every path has a timeout and swallows errors: it can never do anything harmful.
 */
const fs = require('fs');
const { execFile } = require('child_process');

const MAC_TERM_PROGRAMS = {
  Apple_Terminal: 'com.apple.Terminal',
  'iTerm.app': 'com.googlecode.iterm2',
  vscode: 'com.microsoft.VSCode',
  WarpTerminal: 'dev.warp.Warp-Stable',
  ghostty: 'com.mitchellh.ghostty',
  WezTerm: 'com.github.wez.wezterm',
  Hyper: 'co.zeit.hyper',
  Tabby: 'org.tabby',
};
const MAC_APP_NAMES = {
  'com.apple.Terminal': 'Terminal',
  'com.googlecode.iterm2': 'iTerm2',
  'com.microsoft.VSCode': 'VS Code',
  'com.microsoft.VSCodeInsiders': 'VS Code Insiders',
  'com.todesktop.230313mzl4w4u92': 'Cursor',
  'com.exafunction.windsurf': 'Windsurf',
  'com.vscodium': 'VSCodium',
  'dev.warp.Warp-Stable': 'Warp',
  'com.mitchellh.ghostty': 'Ghostty',
  'com.github.wez.wezterm': 'WezTerm',
  'dev.zed.Zed': 'Zed',
};
// Editors where `open -b <id> <folder>` focuses (or opens) the window for that folder.
const FOLDER_EDITORS = new Set([
  'com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders', 'com.todesktop.230313mzl4w4u92',
  'com.exafunction.windsurf', 'com.vscodium', 'dev.zed.Zed',
]);

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() }));
  });
}

const asString = (s) => `"${String(s).replace(/[\\"]/g, '')}"`;

/** Controlling terminal of a process, e.g. "/dev/ttys003", or null. */
async function ttyOf(pid) {
  if (!pid || process.platform === 'win32') return null;
  const r = await run('ps', ['-o', 'tty=', '-p', String(pid | 0)], 3000);
  const t = r.ok ? r.out.trim() : '';
  if (!t || t === '??' || t === '?') return null;
  return t.startsWith('/dev/') ? t : `/dev/${t}`;
}

function terminalScript(tty) {
  return `
tell application id "com.apple.Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is ${asString(tty)} then
        set selected of t to true
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "none"`;
}

function itermScript(tty) {
  return `
tell application id "com.googlecode.iterm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is ${asString(tty)} then
          select w
          tell t to select
          tell s to select
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "none"`;
}

async function focusMac(s) {
  const bundle = s.termBundleId || MAC_TERM_PROGRAMS[s.termProgram];
  if (!bundle || !/^[\w.-]+$/.test(bundle)) return { ok: false, method: 'none', message: 'Couldn’t tell which app this session runs in.' };
  const appName = MAC_APP_NAMES[bundle] || bundle.split('.').pop();

  if (bundle === 'com.apple.Terminal' || bundle === 'com.googlecode.iterm2') {
    const tty = await ttyOf(s.pid);
    if (tty) {
      // Long timeout: the first run may sit behind the macOS automation permission prompt.
      const r = await run('osascript', ['-e', bundle === 'com.apple.Terminal' ? terminalScript(tty) : itermScript(tty)], 20000);
      if (r.ok && r.out === 'ok') return { ok: true, method: 'window' };
    }
  }

  if (FOLDER_EDITORS.has(bundle) && s.cwd && fs.existsSync(s.cwd)) {
    const r = await run('open', ['-b', bundle, s.cwd]);
    if (r.ok) return { ok: true, method: 'window' };
  }

  const r = await run('open', ['-b', bundle]);
  if (r.ok) return { ok: true, method: 'app', message: `Brought ${appName} to the front. Look for the ${s.name} tab.` };
  return { ok: false, method: 'none', message: `Couldn’t activate ${appName}.` };
}

const WIN_SCRIPT = (pid) => `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class AgentCodyWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
$id = ${Number(pid) | 0}
for ($i = 0; $i -lt 8 -and $id; $i++) {
  $p = Get-Process -Id $id
  if ($p -and $p.MainWindowHandle -ne 0) {
    if ([AgentCodyWin]::IsIconic($p.MainWindowHandle)) { [AgentCodyWin]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null }
    (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null
    [AgentCodyWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    Write-Output "ok"; exit 0
  }
  $id = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").ParentProcessId
}
Write-Output "none"
`;

async function focusWindows(s) {
  if (!s.pid) return { ok: false, method: 'none', message: 'No process info for this session (reinstall the hooks if this persists).' };
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT(s.pid)], 8000);
  if (r.out.endsWith('ok')) return { ok: true, method: 'window' };
  return { ok: false, method: 'none', message: 'Couldn’t find a window for this session.' };
}

/**
 * @param {{name:string, cwd?:string, termBundleId?:string, termProgram?:string, pid?:number}} s
 * @returns {Promise<{ok:boolean, method:'window'|'app'|'none', message?:string}>}
 */
async function focusSession(s) {
  try {
    if (process.platform === 'darwin') return await focusMac(s);
    if (process.platform === 'win32') return await focusWindows(s);
    return { ok: false, method: 'none', message: 'Window focusing isn’t supported on this platform.' };
  } catch (err) {
    return { ok: false, method: 'none', message: `Couldn’t focus the window (${err.message}).` };
  }
}

module.exports = { focusSession, ttyOf, terminalScript, itermScript };
