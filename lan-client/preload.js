'use strict';

const { contextBridge, ipcRenderer } = require('electron');
let nativeVisible=true;
let shortcutConfig=null;
const visibilityListeners=new Set();
ipcRenderer.on('desktop:visibility',(_event,visible)=>{nativeVisible=visible===true;for(const callback of visibilityListeners) callback(nativeVisible);});
contextBridge.exposeInMainWorld('desktopVisibility',{
  onChange:callback=>{visibilityListeners.add(callback);callback(nativeVisible);}
});
contextBridge.exposeInMainWorld('desktopAppearance', {
  apply: appearance => ipcRenderer.invoke('lan-client:appearance', appearance)
});
contextBridge.exposeInMainWorld('electronAPI', {
  prepareAssetDrag: payload => ipcRenderer.invoke('lan-client:prepare-asset-drag',payload),
  startAssetDrag: payload => ipcRenderer.invoke('lan-client:start-asset-drag',payload)
});
contextBridge.exposeInMainWorld('libraryPanel', {
  open: kind => ipcRenderer.invoke('lan-client:library-open',kind),
  hide: () => ipcRenderer.invoke('lan-client:library-hide'),
  resize: size => ipcRenderer.send('lan-client:library-resize',size),
  applyPrompt: content => ipcRenderer.invoke('lan-client:library-apply-prompt',content),
  suspendShortcuts: value => ipcRenderer.invoke('lan-client:suspend-shortcuts',value),
  onRefresh: callback => ipcRenderer.on('library:refresh',()=>callback()),
  onApplyPrompt: callback => ipcRenderer.on('library:apply-prompt',(_event,content)=>callback(content))
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
  checkUpdate: () => ipcRenderer.invoke('lan-client:check-update'),
  saveHost: (hostUrl) => ipcRenderer.invoke('lan-client:save-host', hostUrl),
  retry: () => ipcRenderer.invoke('lan-client:retry'),
  openSettings: () => ipcRenderer.invoke('lan-client:settings'),
  openHost: () => ipcRenderer.invoke('lan-client:open-host'),
  copyHost: () => ipcRenderer.invoke('lan-client:copy-host'),
  getShortcuts: () => ipcRenderer.invoke('lan-client:get-shortcuts'),
  saveShortcuts: (payload) => ipcRenderer.invoke('lan-client:save-shortcuts', payload).then(config=>{shortcutConfig=config;return config;})
});

window.addEventListener('DOMContentLoaded', () => {
  const local = location.protocol === 'file:';
  const kind = new URLSearchParams(location.search).get('library');
  if (!local && ['asset','prompt'].includes(kind)) {
    const css=document.createElement('style');
    css.textContent='body.standalone-library :is(.asset-library-drag-region,.prompt-library-drag-region){-webkit-app-region:drag!important}body.standalone-library :is(button,input,select,textarea,a,.asset-library-resize,.prompt-library-resize){-webkit-app-region:no-drag!important}';
    document.head.append(css);
    return;
  }
  let bar = document.querySelector('.topbar');
  if (local) {
    bar = document.createElement('header');
    bar.className = 'client-titlebar';
    bar.innerHTML = '<strong>TENYING AI</strong><div class="client-window-controls"><button type="button" data-action="minimize" aria-label="最小化" title="最小化">&#8722;</button><button type="button" data-action="maximize" aria-label="最大化" title="最大化">&#9633;</button><button type="button" data-action="close" aria-label="关闭" title="关闭">&#215;</button></div>';
    document.body.prepend(bar);
  } else if (bar) {
    document.body.classList.add('desktop-shell', 'lan-desktop-shell');
    const css = document.createElement('style');
    css.textContent = 'body.lan-desktop-shell .topbar,body.lan-desktop-shell .topbar .window-drag-region,body.lan-desktop-shell .topbar .window-drag-region *{-webkit-app-region:no-drag!important}body.lan-desktop-shell .topbar .window-drag-region{cursor:grab;touch-action:none}body.lan-desktop-shell .topbar button,body.lan-desktop-shell .topbar input,body.lan-desktop-shell .topbar select,body.lan-desktop-shell .topbar a,body.lan-desktop-shell .topbar .top-status,body.lan-desktop-shell .desktop-window-controls{-webkit-app-region:no-drag!important}body.lan-desktop-shell #sidebar .nav[data-page="settings"]{display:flex!important}#page-lan-client-settings .about-update-section{margin-top:24px}#lanClientUpdateStatus{display:block;line-height:1.6;margin-top:12px}';
    document.head.append(css);
    const dragRegion=bar.querySelector('.window-drag-region');
    if(dragRegion) {
      let dragging=null,frame=0;
      const finish=()=>{
        if(!dragging) return;
        if(frame) {cancelAnimationFrame(frame);frame=0;}
        ipcRenderer.send('lan-client:drag-move',dragging.point);
        const id=dragging.id;
        dragging=null;
        if(dragRegion.hasPointerCapture(id)) dragRegion.releasePointerCapture(id);
        ipcRenderer.send('lan-client:drag-end');
      };
      dragRegion.addEventListener('pointerdown',event=>{
        if(event.button!==0 || !event.isPrimary || dragging) return;
        event.preventDefault();
        dragging={id:event.pointerId,point:{x:event.screenX,y:event.screenY}};
        dragRegion.setPointerCapture(event.pointerId);
        ipcRenderer.send('lan-client:drag-start',dragging.point);
      });
      dragRegion.addEventListener('pointermove',event=>{
        if(!dragging || event.pointerId!==dragging.id) return;
        dragging.point={x:event.screenX,y:event.screenY};
        if(!frame) frame=requestAnimationFrame(()=>{frame=0;if(dragging) ipcRenderer.send('lan-client:drag-move',dragging.point);});
      });
      dragRegion.addEventListener('pointerup',event=>{if(dragging && event.pointerId===dragging.id) finish();});
      dragRegion.addEventListener('pointercancel',finish);
      dragRegion.addEventListener('lostpointercapture',finish);
      dragRegion.addEventListener('dblclick',()=>ipcRenderer.invoke('lan-client:window-action','maximize'));
      window.addEventListener('blur',finish);
      window.addEventListener('pagehide',finish);
    }
    const settingsNav = document.querySelector('#sidebar .nav[data-page="settings"]');
    const glassSettings = document.querySelector('#page-settings .liquid-settings');
    const main = document.querySelector('main');
    if (settingsNav && glassSettings && main) {
      const page = document.createElement('section');
      page.className = 'page';
      page.id = 'page-lan-client-settings';
      page.innerHTML = '<div class="section-head"><div><h1>设置中心</h1></div></div><div class="card"><div class="lan-glass-settings"></div><div class="about-update-section"><h2>关于</h2><div class="about-update-card"><div class="about-update-row"><span>客户端版本</span><b id="lanClientVersion">-</b></div><div class="about-update-row"><span>版本更新</span><button type="button" class="about-update-btn" id="lanClientCheckUpdate">检查更新</button></div><span id="lanClientUpdateStatus" role="status" aria-live="polite"></span><button type="button" class="secondary" id="lanClientRelease" hidden>打开官方下载页</button></div></div></div>';
      page.querySelector('.lan-glass-settings').append(glassSettings);
      main.append(page);
      ipcRenderer.invoke('lan-client:get-config').then(config => {
        page.querySelector('#lanClientVersion').textContent = config.client_version || '-';
      }).catch(() => {});
      settingsNav.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        document.querySelectorAll('.page').forEach(item => item.classList.toggle('active', item === page));
        document.querySelectorAll('.nav').forEach(item => {
          const active = item === settingsNav;
          item.classList.toggle('active', active);
          if (active) item.setAttribute('aria-current', 'page');
          else item.removeAttribute('aria-current');
        });
      }, true);
      const check = page.querySelector('#lanClientCheckUpdate');
      const status = page.querySelector('#lanClientUpdateStatus');
      const release = page.querySelector('#lanClientRelease');
      check.addEventListener('click', async () => {
        check.disabled = true;
        release.hidden = true;
        status.textContent = '正在检查客户端版本...';
        try {
          const result = await ipcRenderer.invoke('lan-client:check-update');
          status.textContent = result.comparison > 0 ? `发现客户端新版本 ${result.latestVersion}，请打开官方下载页获取。` :
            result.comparison < 0 ? `已发布客户端版本 ${result.latestVersion} 低于当前版本，不会降级。` : '当前客户端已是发布版最新版本。';
          release.hidden = result.comparison <= 0;
        } catch (error) {
          status.textContent = error.message || '检查更新失败，请稍后重试。';
        } finally {
          check.disabled = false;
        }
      });
      release.addEventListener('click', () => ipcRenderer.invoke('lan-client:open-release').catch(() => {
        status.textContent = '无法打开下载页，请稍后重试。';
      }));
    }
    document.addEventListener('click',event=>{
      const button=event.target.closest?.('#assetLibraryBtn,#promptLibraryBtn');
      if(!button) return;
      event.preventDefault();event.stopImmediatePropagation();
      ipcRenderer.invoke('lan-client:library-open',button.id==='assetLibraryBtn'?'asset':'prompt');
    },true);
    ipcRenderer.invoke('lan-client:get-shortcuts').then(config=>{shortcutConfig=config;}).catch(()=>{});
    document.addEventListener('keydown',event=>{
      if(!shortcutConfig?.shortcuts_enabled || document.querySelector('.shortcut-setting-row.recording')) return;
      const key=event.key.toUpperCase();
      const value=[event.ctrlKey?'Ctrl':null,event.altKey?'Alt':null,event.shiftKey?'Shift':null,event.metaKey?'Cmd':null,key].filter(Boolean).join('+');
      const settings=shortcutConfig.shortcut_settings || {};
      const kind=value===settings.toggle_asset_library?'asset':value===settings.toggle_prompt_library?'prompt':null;
      if(!kind) return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!shortcutConfig.library_global_registered) ipcRenderer.invoke('lan-client:library-open',kind);
    },true);
  }
  if (!bar) return;
  const ids = [['mainWindowMinimize','minimize'],['mainWindowMaximize','maximize'],['mainWindowClose','close']];
  for (const [id,action] of ids) {
    const button = local ? bar.querySelector(`[data-action="${action}"]`) : document.getElementById(id);
    button?.addEventListener('click', () => ipcRenderer.invoke('lan-client:window-action',action).then(updateState).catch(()=>{}));
  }
  function updateState(state) {
    const button = local ? bar.querySelector('[data-action="maximize"]') : document.getElementById('mainWindowMaximize');
    if (!button || !state) return;
    const label = state.maximized ? '还原窗口' : '最大化';
    button.title = label;
    button.setAttribute('aria-label',label);
    button.classList.toggle('is-maximized',!!state.maximized);
  }
  ipcRenderer.on('lan-client:window-state', (_event,state)=>updateState(state));
  ipcRenderer.invoke('lan-client:window-action','state').then(updateState).catch(()=>{});
});
