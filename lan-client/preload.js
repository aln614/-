'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let lastCtrlWheelZoomAt = 0;
window.addEventListener('wheel', event => {
  if (!(event.ctrlKey || event.metaKey) || !event.deltaY) return;
  const now = Date.now();
  if (now - lastCtrlWheelZoomAt < 90) {
    event.preventDefault();
    return;
  }
  lastCtrlWheelZoomAt = now;
  event.preventDefault();
  ipcRenderer.send('lan-client:change-page-zoom', event.deltaY < 0 ? 0.1 : -0.1);
}, { capture: true, passive: false });

contextBridge.exposeInMainWorld('lanClient', {
  getConfig: () => ipcRenderer.invoke('lan-client:get-config'),
  saveHost: (hostUrl) => ipcRenderer.invoke('lan-client:save-host', hostUrl),
  retry: () => ipcRenderer.invoke('lan-client:retry'),
  openSettings: () => ipcRenderer.invoke('lan-client:settings'),
  openHost: () => ipcRenderer.invoke('lan-client:open-host'),
  copyHost: () => ipcRenderer.invoke('lan-client:copy-host'),
  getShortcuts: () => ipcRenderer.invoke('lan-client:get-shortcuts'),
  saveShortcuts: (payload) => ipcRenderer.invoke('lan-client:save-shortcuts', payload)
});
