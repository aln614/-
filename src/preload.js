const { contextBridge, ipcRenderer } = require('electron');
let nativeVisible=true;
const visibilityListeners=new Set();
ipcRenderer.on('desktop:visibility',(_event,visible)=>{nativeVisible=visible===true;for(const callback of visibilityListeners) callback(nativeVisible);});
contextBridge.exposeInMainWorld('desktopVisibility',{
  onChange:callback=>{visibilityListeners.add(callback);callback(nativeVisible);}
});
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
let lastLibraryBackdrop=null;
const libraryBackdropListeners=new Set();
const libraryBackdropMotionListeners=new Set();
ipcRenderer.on('library:backdrop',(_event,payload)=>{lastLibraryBackdrop={...lastLibraryBackdrop,...payload};for(const callback of libraryBackdropListeners) callback(payload);});
ipcRenderer.on('library:backdrop-motion',(_event,payload)=>{for(const callback of libraryBackdropMotionListeners) callback(payload);});
contextBridge.exposeInMainWorld('libraryPanel', {
  open: kind => ipcRenderer.invoke('library:open', kind),
  hide: () => ipcRenderer.invoke('library:hide'),
  resize: size => ipcRenderer.send('library:resize', size),
  setGlassEnabled: enabled => ipcRenderer.send('library:glass-enabled', enabled === true),
  startWindowDrag: point => ipcRenderer.send('library:drag-start', point),
  moveWindowDrag: point => ipcRenderer.send('library:drag-move', point),
  endWindowDrag: () => ipcRenderer.send('library:drag-end'),
  backdropUnavailable: () => ipcRenderer.send('library:backdrop-unavailable'),
  setBackdropVisible: visible => ipcRenderer.send('library:backdrop-visibility', visible === true),
  applyPrompt: content => ipcRenderer.invoke('library:apply-prompt', content),
  suspendShortcuts: value => ipcRenderer.invoke('shortcuts:suspend', value),
  onBackdrop: callback => { libraryBackdropListeners.add(callback); if(lastLibraryBackdrop) queueMicrotask(()=>callback(lastLibraryBackdrop)); },
  onBackdropMotion: callback => {libraryBackdropMotionListeners.add(callback);return ()=>libraryBackdropMotionListeners.delete(callback);},
  onRefresh: callback => ipcRenderer.on('library:refresh', () => callback()),
  onApplyPrompt: callback => ipcRenderer.on('library:apply-prompt', (_event, content) => callback(content))
});
contextBridge.exposeInMainWorld('mainWindowControls', {
  action: action => ipcRenderer.invoke('main-window:action', action),
  startDrag: point => ipcRenderer.send('main-window:drag-start', point),
  moveDrag: point => ipcRenderer.send('main-window:drag-move', point),
  endDrag: () => ipcRenderer.send('main-window:drag-end'),
  onState: callback => ipcRenderer.on('main-window:state', (_event, state) => callback(state))
});
