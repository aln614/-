const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  startImageDrag: (payload) => ipcRenderer.send('start-image-drag', payload || {})
});
