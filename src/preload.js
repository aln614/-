const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  startImageDrag: (payload) => ipcRenderer.invoke('start-image-drag', payload || {}),
  // Asset-library cards need a native file drag. URLs alone let some targets pick the thumbnail.
  prepareAssetDrag: (payload) => ipcRenderer.invoke('prepare-asset-drag', payload || {}),
  startAssetDrag: (payload) => ipcRenderer.invoke('start-asset-drag', payload || {})
});
