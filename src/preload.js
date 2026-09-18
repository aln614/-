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
contextBridge.exposeInMainWorld('electronAPI', {
  pasteReferenceImages: () => ipcRenderer.send('reference-image-paste'),
  startImageDrag: (payload) => ipcRenderer.invoke('start-image-drag', payload || {}),
  // Asset-library cards need a native file drag. URLs alone let some targets pick the thumbnail.
  prepareAssetDrag: (payload) => ipcRenderer.invoke('prepare-asset-drag', payload || {}),
  startAssetDrag: (payload) => ipcRenderer.invoke('start-asset-drag', payload || {})
});
