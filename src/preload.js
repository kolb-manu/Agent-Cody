'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cody', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, list) => cb(list)),
  onUiState: (cb) => ipcRenderer.on('ui-state', (_e, s) => cb(s)),
  onReveal: (cb) => ipcRenderer.on('reveal', (_e, id) => cb(id)),
  onToast: (cb) => ipcRenderer.on('toast', (_e, msg) => cb(msg)),
  onShowSettings: (cb) => ipcRenderer.on('show-settings', () => cb()),
  ready: () => ipcRenderer.send('ui-ready'),
  toggleCollapse: () => ipcRenderer.send('toggle-collapse'),
  installHooks: () => ipcRenderer.send('install-hooks'),
  uninstallHooks: () => ipcRenderer.send('uninstall-hooks'),
  dismiss: (id) => ipcRenderer.send('dismiss', id),
  open: (id) => ipcRenderer.invoke('open', id),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  setLoginItem: (on) => ipcRenderer.invoke('set-login-item', on),
  refreshUiState: () => ipcRenderer.send('refresh-ui-state'),
  openLoginItems: () => ipcRenderer.send('open-login-items'),
  answerOnboarding: (step, yes) => ipcRenderer.send('onboarding-answer', step, yes),
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  downloadUpdate: () => ipcRenderer.send('download-update'),
  installUpdate: () => ipcRenderer.send('install-update'),
});
