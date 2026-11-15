'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cody', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, list) => cb(list)),
  onUiState: (cb) => ipcRenderer.on('ui-state', (_e, s) => cb(s)),
  onReveal: (cb) => ipcRenderer.on('reveal', (_e, id) => cb(id)),
  ready: () => ipcRenderer.send('ui-ready'),
  toggleCollapse: () => ipcRenderer.send('toggle-collapse'),
  toggleMute: () => ipcRenderer.send('toggle-mute'),
  hide: () => ipcRenderer.send('hide'),
  menu: () => ipcRenderer.send('menu'),
  installHooks: () => ipcRenderer.send('install-hooks'),
  dismiss: (id) => ipcRenderer.send('dismiss', id),
  activate: (id) => ipcRenderer.invoke('activate', id),
});
