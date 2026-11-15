'use strict';
/*
 * Best-effort "bring the session's terminal/editor to the front".
 *
 * macOS:   the hook forwards __CFBundleIdentifier (set by the terminal/editor app that launched
 *          the shell, e.g. com.googlecode.iterm2, com.microsoft.VSCode). We activate that app with
 *          `open -b`. Falls back to TERM_PROGRAM. This activates the app, not a specific tab/window.
 * Windows: walk up from the Claude Code process to the first ancestor with a visible window and
 *          activate it via PowerShell. Windows may refuse to steal focus; then the taskbar flashes.
 * Other:   does nothing.
 *
 * Every path is wrapped with a timeout and swallows errors: it can never do anything harmful.
 */
const { execFile } = require('child_process');

const MAC_TERM_PROGRAMS = {
  'Apple_Terminal': 'com.apple.Terminal',
  'iTerm.app': 'com.googlecode.iterm2',
  'vscode': 'com.microsoft.VSCode',
  'WarpTerminal': 'dev.warp.Warp-Stable',
  'ghostty': 'com.mitchellh.ghostty',
  'WezTerm': 'com.github.wez.wezterm',
  'Hyper': 'co.zeit.hyper',
  'Tabby': 'org.tabby',
};

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() }));
  });
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

/**
 * @param {{termBundleId?:string, termProgram?:string, pid?:number}} s
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function focusSession(s) {
  try {
    if (process.platform === 'darwin') {
      const bundle = s.termBundleId || MAC_TERM_PROGRAMS[s.termProgram];
      if (!bundle || !/^[\w.-]+$/.test(bundle)) return { ok: false, reason: 'Unknown terminal app' };
      const r = await run('open', ['-b', bundle]);
      return r.ok ? { ok: true } : { ok: false, reason: `Could not activate ${bundle}` };
    }
    if (process.platform === 'win32') {
      if (!s.pid) return { ok: false, reason: 'No process info for this session' };
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT(s.pid)], 8000);
      return r.out.endsWith('ok') ? { ok: true } : { ok: false, reason: 'No window found for this session' };
    }
    return { ok: false, reason: 'Not supported on this platform' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { focusSession };
