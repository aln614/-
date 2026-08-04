'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lanClient', {
  getConfig: () => ipcRenderer.invoke('lan-client:get-config'),
  saveHost: (hostUrl) => ipcRenderer.invoke('lan-client:save-host', hostUrl),
  retry: () => ipcRenderer.invoke('lan-client:retry'),
  openSettings: () => ipcRenderer.invoke('lan-client:settings'),
  openHost: () => ipcRenderer.invoke('lan-client:open-host'),
  copyHost: () => ipcRenderer.invoke('lan-client:copy-host')
});
