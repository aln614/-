'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('folderExport', {
  start: payload => ipcRenderer.invoke('folder-export:start', payload),
  cancel: id => ipcRenderer.send('folder-export:cancel', id),
  onProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('folder-export:progress', listener);
    return () => ipcRenderer.removeListener('folder-export:progress', listener);
  }
});

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
  pasteReferenceImages: () => ipcRenderer.send('reference-image-paste'),
  getConfig: () => ipcRenderer.invoke('lan-client:get-config'),
  saveHost: (hostUrl) => ipcRenderer.invoke('lan-client:save-host', hostUrl),
  retry: () => ipcRenderer.invoke('lan-client:retry'),
  openSettings: () => ipcRenderer.invoke('lan-client:settings'),
  openHost: () => ipcRenderer.invoke('lan-client:open-host'),
  copyHost: () => ipcRenderer.invoke('lan-client:copy-host'),
  getShortcuts: () => ipcRenderer.invoke('lan-client:get-shortcuts'),
  saveShortcuts: (payload) => ipcRenderer.invoke('lan-client:save-shortcuts', payload)
});
