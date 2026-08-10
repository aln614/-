const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  startImageDrag: (payload) => ipcRenderer.send('start-image-drag', payload || {}),
  // Asset-library cards need a native file drag. URLs alone let some targets pick the thumbnail.
  startAssetDrag: (payload) => ipcRenderer.send('start-asset-drag', payload || {})
});
