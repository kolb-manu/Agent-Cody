'use strict';
/*
 * "Start when I log in", one small helper over Electron's login-item API (Electron >= 45).
 *
 * The system is the single source of truth: we never store our own copy of the setting,
 * we read it back from macOS / Windows every time it's shown.
 *
 * macOS   app.setLoginItemSettings({ openAtLogin }) registers the app via SMAppService
 *         (type "mainAppService"). getLoginItemSettings() reports `status`
 *         ('enabled' | 'not-registered' | 'requires-approval' | 'not-found') and
 *         `wasOpenedAtLogin`. Works reliably only for a signed + notarized app.
 * Windows Writes a per-user Run key (HKCU, no admin). We register the exe with a `--login`
 *         argument so we can tell an automatic start from a manual one (Windows has no
 *         wasOpenedAtLogin). `executableWillLaunchAtLogin` is false when the user disabled the
 *         entry in Task Manager / Settings › Startup apps, so the switch shows the real state.
 *         For the portable build, the stable path is PORTABLE_EXECUTABLE_FILE (the running exe
 *         itself is unpacked to a temp folder that changes every launch).
 * Dev     (npm start) unsupported: we never register the bare Electron binary.
 */

const LOGIN_ARG = '--login';

/**
 * @param {object} deps
 * @param {Electron.App} deps.app
 * @param {string} [deps.platform]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {string[]} [deps.argv]
 * @param {string} [deps.execPath]
 */
function createLoginItem({ app, platform = process.platform, env = process.env, argv = process.argv, execPath = process.execPath }) {
  const isMac = platform === 'darwin';
  const isWin = platform === 'win32';
  const supported = Boolean(app.isPackaged) && (isMac || isWin);

  const winTarget = () => ({ path: env.PORTABLE_EXECUTABLE_FILE || execPath, args: [LOGIN_ARG] });

  /** @returns {{supported:boolean, enabled:boolean, requiresApproval:boolean, status?:string, error?:string}} */
  function get() {
    if (!supported) return { supported: false, enabled: false, requiresApproval: false };
    try {
      if (isMac) {
        const s = app.getLoginItemSettings();
        return {
          supported: true,
          enabled: s.status ? s.status === 'enabled' : Boolean(s.openAtLogin),
          requiresApproval: s.status === 'requires-approval',
          status: s.status,
        };
      }
      const s = app.getLoginItemSettings(winTarget());
      const enabled = typeof s.executableWillLaunchAtLogin === 'boolean' ? s.executableWillLaunchAtLogin : Boolean(s.openAtLogin);
      return { supported: true, enabled, requiresApproval: false };
    } catch (err) {
      return { supported: true, enabled: false, requiresApproval: false, error: err.message };
    }
  }

  /** Register / unregister, then read back what the system actually did. */
  function set(on) {
    if (!supported) return get();
    try {
      if (isMac) app.setLoginItemSettings({ openAtLogin: Boolean(on) });
      else app.setLoginItemSettings({ openAtLogin: Boolean(on), enabled: Boolean(on), ...winTarget() });
    } catch (err) {
      return { ...get(), error: err.message };
    }
    return get();
  }

  /** True when this process was started automatically at login. */
  function wasOpenedAtLogin() {
    if (argv.includes(LOGIN_ARG)) return true;
    if (!supported || !isMac) return false;
    try { return Boolean(app.getLoginItemSettings().wasOpenedAtLogin); } catch (_) { return false; }
  }

  /**
   * Windows: if our Run entry points at an old exe path (app moved or reinstalled elsewhere),
   * re-register it with the current path. Only touches an entry that is already enabled.
   */
  function repairStalePath() {
    if (!supported || !isWin) return false;
    try {
      const s = app.getLoginItemSettings(winTarget());
      const current = winTarget().path.toLowerCase();
      const ours = (s.launchItems || []).filter((i) => i.scope !== 'machine' && /agent ?cody/i.test(`${i.name} ${i.path}`));
      const stale = ours.find((i) => i.enabled && String(i.path).toLowerCase() !== current);
      if (!stale || s.executableWillLaunchAtLogin) return false;
      app.setLoginItemSettings({ openAtLogin: true, enabled: true, ...winTarget() });
      return true;
    } catch (_) { return false; }
  }

  return { supported, get, set, wasOpenedAtLogin, repairStalePath, LOGIN_ARG };
}

module.exports = { createLoginItem, LOGIN_ARG };
