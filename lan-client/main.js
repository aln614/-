'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { registerFolderExport } = require('./folderExport');
const { createAssetDragCache } = require('./assetDrag');
const { RELEASE_URL, checkClientUpdate } = require('./updates');
const { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage, nativeTheme, net, shell } = require('electron');

const DEFAULT_HOST_URL = 'http://192.168.110.30:7868';
const CONFIG_FILE = 'connection.json';
const DEFAULT_ZOOM_FACTOR = 1;
const MIN_ZOOM_FACTOR = 0.75;
const MAX_ZOOM_FACTOR = 1.5;
const ZOOM_STEP = 0.1;
const DEFAULT_SHORTCUT_SETTINGS = Object.freeze({
  open_app: 'Ctrl+Alt+A',
  toggle_asset_library: 'Ctrl+Shift+A',
  toggle_prompt_library: 'Ctrl+Shift+P',
  toggle_agent: 'Ctrl+Shift+G'
});
const BLOCKED_SHORTCUTS = new Set(['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+S', 'Alt+F4', 'Ctrl+Alt+Delete']);
let mainWindow = null;
let showingLocalPage = false;
let activeOpenAppShortcut = '';
let isAppQuitting = false;
let tray = null;
const libraryWindows = {asset:null,prompt:null};
let libraryShortcuts = {};
let mainWindowDrag = null;
const nativeBackdropSupported = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621;
let experimentalNativeGlass = null;
if (process.env.TENYING_EXPERIMENTAL_NATIVE_GLASS) experimentalNativeGlass={
  apply(...args) {
    if(!this.bridge && !args[1]) return false;
    if(!this.bridge) this.bridge=require('./native-glass').createNativeGlass();
    return this.bridge.apply(...args);
  }
};
function updateWindowShape(win) {
  if (process.platform!=='win32' || nativeBackdropSupported || !win || win.isDestroyed()) return;
  if(win.isMaximized()) { try { win.setShape([]); } catch {} return; }
  const [width,height]=win.getSize(),radius=Math.min(20,Math.floor(width/2),Math.floor(height/2));
  const rectangles=[{x:0,y:radius,width,height:height-radius*2}];
  for(let y=0;y<radius;y++) {
    const inset=Math.ceil(radius-Math.sqrt(radius*radius-(radius-y-.5)**2));
    rectangles.push({x:inset,y,width:width-inset*2,height:1},{x:inset,y:height-y-1,width:width-inset*2,height:1});
  }
  try { win.setShape(rectangles); } catch {}
}
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
else app.on('second-instance', () => bringMainWindowToFront());

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function normalizeHostUrl(value = '') {
  const raw = String(value || '').trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 HTTP 或 HTTPS 地址');
  if (parsed.username || parsed.password) throw new Error('主机地址不能包含用户名或密码');
  if (!parsed.hostname) throw new Error('请输入主机地址');
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizeZoomFactor(value = DEFAULT_ZOOM_FACTOR) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_ZOOM_FACTOR;
  return Math.round(Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, parsed)) * 100) / 100;
}

function normalizeShortcutAccelerator(value = '') {
  const parts = String(value || '').replace(/\s+/g, '').split('+').filter(Boolean);
  const modifiers = new Set();
  let key = '';
  for (const rawPart of parts) {
    const lower = rawPart.toLowerCase();
    if (lower === 'ctrl' || lower === 'control' || lower === 'controlorcommand' || lower === 'commandorcontrol') modifiers.add('Ctrl');
    else if (lower === 'alt' || lower === 'option') modifiers.add('Alt');
    else if (lower === 'shift') modifiers.add('Shift');
    else if (lower === 'cmd' || lower === 'command' || lower === 'meta' || lower === 'super') modifiers.add('Cmd');
    else {
      if (key) return '';
      if (/^[a-z]$/i.test(rawPart)) key = rawPart.toUpperCase();
      else if (/^[0-9]$/.test(rawPart)) key = rawPart;
      else if (/^f(?:[1-9]|1[0-2])$/i.test(rawPart)) key = rawPart.toUpperCase();
      else if (lower === 'delete' || lower === 'del') key = 'Delete';
      else return '';
    }
  }
  if (!key || !modifiers.size) return '';
  return ['Ctrl', 'Alt', 'Shift', 'Cmd'].filter(item => modifiers.has(item)).concat(key).join('+');
}

function validateShortcutConfiguration(input = {}, strict = false) {
  const source = { ...(input.shortcut_settings && typeof input.shortcut_settings === 'object' ? input.shortcut_settings : {}) };
  for (const key of Object.keys(DEFAULT_SHORTCUT_SETTINGS)) {
    if (normalizeShortcutAccelerator(source[key]) !== 'Ctrl+Shift+V') continue;
    if (strict) throw new Error('Ctrl+Shift+V 已用于粘贴附加参考图，请选择其他快捷键。');
    const used = new Set(Object.entries(DEFAULT_SHORTCUT_SETTINGS).filter(([other]) => other !== key).map(([other, fallback]) => normalizeShortcutAccelerator(source[other] || fallback)));
    source[key] = [DEFAULT_SHORTCUT_SETTINGS[key], ...Object.values(DEFAULT_SHORTCUT_SETTINGS)].find(value => !used.has(value));
  }
  const settings = {};
  try {
    for (const key of Object.keys(DEFAULT_SHORTCUT_SETTINGS)) {
      const raw = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : (strict ? '' : DEFAULT_SHORTCUT_SETTINGS[key]);
      const normalized = normalizeShortcutAccelerator(raw);
      if (!normalized) throw new Error('快捷键必须包含修饰键，并使用字母、数字或 F1-F12。');
      if (BLOCKED_SHORTCUTS.has(normalized)) throw new Error(`${normalized} 是系统常用或高风险快捷键，请更换。`);
      settings[key] = normalized;
    }
    if (new Set(Object.values(settings)).size !== Object.keys(settings).length) throw new Error('快捷键不能重复，请重新设置。');
    return { shortcuts_enabled: input.shortcuts_enabled !== false, shortcut_settings: settings };
  } catch (error) {
    if (strict) throw error;
    return { shortcuts_enabled: true, shortcut_settings: { ...DEFAULT_SHORTCUT_SETTINGS } };
  }
}

function readConnectionConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const shortcuts = validateShortcutConfiguration(stored);
    return { host_url: normalizeHostUrl(stored.host_url || DEFAULT_HOST_URL), zoom_factor: normalizeZoomFactor(stored.zoom_factor), ...shortcuts };
  } catch {
    return { host_url: DEFAULT_HOST_URL, zoom_factor: DEFAULT_ZOOM_FACTOR, shortcuts_enabled: true, shortcut_settings: { ...DEFAULT_SHORTCUT_SETTINGS } };
  }
}

function writeConnectionConfig(hostUrl, shortcutInput = null, zoomFactor = null) {
  const current = readConnectionConfig();
  const shortcuts = shortcutInput ? validateShortcutConfiguration(shortcutInput, true) : validateShortcutConfiguration(current);
  const next = {
    host_url: normalizeHostUrl(hostUrl || current.host_url),
    zoom_factor: normalizeZoomFactor(zoomFactor === null ? current.zoom_factor : zoomFactor),
    ...shortcuts,
    updated_at: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function activeHostUrl() {
  return readConnectionConfig().host_url;
}

function isActiveHost(urlValue = '') {
  try { return new URL(urlValue).origin === new URL(activeHostUrl()).origin; }
  catch { return false; }
}

async function showConnectionError(message = '') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showingLocalPage = true;
  await mainWindow.loadFile(path.join(__dirname, 'error.html'), { query: { message: String(message || '').slice(0, 240) } });
}

async function loadHostApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showingLocalPage = false;
  const hostUrl = activeHostUrl();
  try {
    await mainWindow.loadURL(hostUrl);
  } catch (error) {
    await showConnectionError(error.message || '无法连接到主机端');
  }
}

async function showConnectionSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showingLocalPage = true;
  await mainWindow.loadFile(path.join(__dirname, 'settings.html'));
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '连接',
      submenu: [
        { label: '重新连接主机', accelerator: 'Ctrl+R', click: () => loadHostApp() },
        { label: '连接设置', accelerator: 'Ctrl+,', click: () => showConnectionSettings() },
        { type: 'separator' },
        { label: '在浏览器打开主机', click: () => shell.openExternal(activeHostUrl()) },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '查看',
      submenu: [
        { role: 'togglefullscreen', label: '切换全屏' },
        { role: 'reload', label: '刷新当前页面' },
        { type: 'separator' },
        { label: '放大页面', accelerator: 'Ctrl+=', click: () => changePageZoom(ZOOM_STEP) },
        { label: '缩小页面', accelerator: 'Ctrl+-', click: () => changePageZoom(-ZOOM_STEP) },
        { label: '恢复 100%', accelerator: 'Ctrl+0', click: resetPageZoom }
      ]
    }
  ]));
}

function bringMainWindowToFront() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.setSkipTaskbar(false); } catch {}
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  if (typeof mainWindow.moveTop === 'function') mainWindow.moveTop();
  mainWindow.focus();
  try {
    mainWindow.setAlwaysOnTop(true, 'floating');
    const timer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    }, 180);
    if (typeof timer.unref === 'function') timer.unref();
  } catch {}
}

function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.setSkipTaskbar(true); } catch {}
  mainWindow.hide();
}

function toggleMainWindowFromShortcut() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) hideMainWindowToTray();
  else bringMainWindowToFront();
}

function trayIcon() {
  const candidates = [
    path.join(process.resourcesPath || '', 'assets', 'rocket.ico'),
    path.join(__dirname, '..', 'assets', 'rocket.ico'),
    path.join(__dirname, 'assets', 'rocket.ico')
  ];
  const iconPath = candidates.find(candidate => candidate && fs.existsSync(candidate));
  return iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip('TENYING AI 局域网访问端');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 / 关闭程序', click: toggleMainWindowFromShortcut },
    { label: '打开程序', click: bringMainWindowToFront },
    { label: '资产库', click: () => showLibrary('asset') },
    { label: '提示词库', click: () => showLibrary('prompt') },
    { label: '最小化到后台', click: hideMainWindowToTray },
    { type: 'separator' },
    { label: '退出程序', click: () => { isAppQuitting = true; app.quit(); } }
  ]));
  tray.on('click', bringMainWindowToFront);
  tray.on('double-click', bringMainWindowToFront);
}

function showLibrary(kind, toggle = false) {
  if (!['asset','prompt'].includes(kind)) return false;
  let win = libraryWindows[kind];
  if (win && !win.isDestroyed() && win.libraryHost !== activeHostUrl()) {
    win.destroy();
    win = null;
  }
  if (win && !win.isDestroyed()) {
    if (toggle && win.isVisible() && win.isFocused()) { win.hide(); return true; }
    if (win.isMinimized()) win.restore();
    win.webContents.send('library:refresh');
    win.show(); win.focus();
    return true;
  }
  win = new BrowserWindow({
    width:kind === 'asset' ? 1200 : 1050, height:760, minWidth:720, minHeight:500,
    title:kind === 'asset' ? '资产库' : '提示词库', show:false, frame:false,
    transparent:!!experimentalNativeGlass || !nativeBackdropSupported, thickFrame:nativeBackdropSupported && !experimentalNativeGlass,
    backgroundColor:'#00000000', hasShadow:false,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:true}
  });
  win.libraryHost=activeHostUrl();
  libraryWindows[kind]=win;
  updateWindowShape(win);
  win.on('resize',()=>updateWindowShape(win));
  const visibility=()=>{ if (!win.isDestroyed()) win.webContents.send('desktop:visibility',win.isVisible() && !win.isMinimized()); };
  for (const event of ['show','hide','minimize','restore']) win.on(event,visibility);
  win.webContents.on('did-finish-load',visibility);
  win.webContents.on('will-navigate',(event,url)=>{if(!isActiveHost(url)) event.preventDefault();});
  win.webContents.setWindowOpenHandler(({url})=>{if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(()=>{});return {action:'deny'};});
  win.on('close',event=>{if(!isAppQuitting){event.preventDefault();win.hide();}});
  win.on('closed',()=>{if(libraryWindows[kind]===win) libraryWindows[kind]=null;});
  win.once('ready-to-show',()=>{if(!win.isDestroyed()){win.show();win.focus();}});
  win.loadURL(`${win.libraryHost}/?library=${kind}`).catch(error=>{
    console.error(`Failed to load ${kind} library:`, error);
    if(!win.isDestroyed()) win.destroy();
  });
  return true;
}

function replaceLibraryShortcuts(settings = {}) {
  const actions={toggle_asset_library:()=>showLibrary('asset',true),toggle_prompt_library:()=>showLibrary('prompt',true)};
  const previous={...libraryShortcuts};
  for(const value of Object.values(libraryShortcuts)) globalShortcut.unregister(value);
  libraryShortcuts={};
  try {
    for(const [key,callback] of Object.entries(actions)) {
      const value=settings[key];
      if(value && !globalShortcut.register(value,callback)) throw new Error(value);
      if(value) libraryShortcuts[key]=value;
    }
    return true;
  } catch {
    for(const value of Object.values(libraryShortcuts)) globalShortcut.unregister(value);
    libraryShortcuts={};
    for(const [key,value] of Object.entries(previous)) if(globalShortcut.register(value,actions[key])) libraryShortcuts[key]=value;
    return false;
  }
}
function replaceOpenAppShortcut(accelerator = '') {
  if (!app.isReady()) return true;
  const next = String(accelerator || '').trim();
  if (next && next === activeOpenAppShortcut && globalShortcut.isRegistered(next)) return true;
  if (next) {
    try { if (!globalShortcut.register(next, toggleMainWindowFromShortcut)) return false; }
    catch { return false; }
  }
  if (activeOpenAppShortcut && activeOpenAppShortcut !== next) {
    try { globalShortcut.unregister(activeOpenAppShortcut); } catch {}
  }
  activeOpenAppShortcut = next;
  return true;
}

function registerConfiguredOpenAppShortcut() {
  const config = readConnectionConfig();
  const accelerator = config.shortcuts_enabled ? config.shortcut_settings.open_app : '';
  const result=replaceOpenAppShortcut(accelerator);
  replaceLibraryShortcuts(config.shortcuts_enabled ? config.shortcut_settings : {});
  return result;
}

function applyPageZoom(factor = readConnectionConfig().zoom_factor) {
  if (!mainWindow || mainWindow.isDestroyed()) return normalizeZoomFactor(factor);
  const normalized = normalizeZoomFactor(factor);
  try { mainWindow.webContents.setZoomFactor(normalized); } catch {}
  return normalized;
}

function changePageZoom(delta = 0) {
  const config = readConnectionConfig();
  const next = normalizeZoomFactor(Number(config.zoom_factor || DEFAULT_ZOOM_FACTOR) + Number(delta || 0));
  const saved = writeConnectionConfig(config.host_url, null, next);
  return applyPageZoom(saved.zoom_factor);
}

function resetPageZoom() {
  const config = readConnectionConfig();
  const saved = writeConnectionConfig(config.host_url, null, DEFAULT_ZOOM_FACTOR);
  return applyPageZoom(saved.zoom_factor);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    transparent: !!experimentalNativeGlass || !nativeBackdropSupported,
    thickFrame: nativeBackdropSupported && !experimentalNativeGlass,
    backgroundColor: '#00000000',
    title: 'TENYING AI 局域网访问端',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true
    }
  });
  mainWindow.once('ready-to-show', bringMainWindowToFront);
  updateWindowShape(mainWindow);
  for(const event of ['resize','maximize','unmaximize']) mainWindow.on(event,()=>updateWindowShape(mainWindow));
  const sendVisibility=()=>{
    if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:visibility',mainWindow.isVisible() && !mainWindow.isMinimized());
  };
  for(const event of ['show','hide','minimize','restore']) mainWindow.on(event,sendVisibility);
  for(const event of ['maximize','unmaximize']) mainWindow.on(event,()=>{
    if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lan-client:window-state',{maximized:mainWindow.isMaximized()});
  });
  mainWindow.webContents.on('did-finish-load',sendVisibility);
  mainWindow.webContents.on('did-finish-load', () => applyPageZoom());
  let referencePasteGestureUntil = 0;
  mainWindow.on('blur', () => { referencePasteGestureUntil = 0; });
  mainWindow.webContents.on('ipc-message', (_event, channel) => {
    if(channel !== 'reference-image-paste' || Date.now() > referencePasteGestureUntil) return;
    referencePasteGestureUntil = 0;
    mainWindow.webContents.paste();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const referencePasteKey = input.control && input.shift && !input.alt && !input.meta && !input.isComposing && (input.code === 'KeyV' || String(input.key).toLowerCase() === 'v');
    mainWindow.webContents.setIgnoreMenuShortcuts(!!referencePasteKey);
    if(input.type === 'keyDown') referencePasteGestureUntil = referencePasteKey ? Date.now() + 1500 : 0;
    if (!(input.control || input.meta) || input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const code = String(input.code || '').toLowerCase();
    if (key === '+' || key === '=' || code === 'equal' || code === 'numpadadd') {
      event.preventDefault();
      changePageZoom(ZOOM_STEP);
    } else if (key === '-' || code === 'minus' || code === 'numpadsubtract') {
      event.preventDefault();
      changePageZoom(-ZOOM_STEP);
    } else if (key === '0' || code === 'digit0' || code === 'numpad0') {
      event.preventDefault();
      resetPageZoom();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, _code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame && !showingLocalPage && isActiveHost(validatedUrl)) showConnectionError(description || '无法连接到主机端').catch(() => {});
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isActiveHost(targetUrl)) return { action: 'allow' };
    shell.openExternal(targetUrl).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.on('close', event => {
    if (isAppQuitting) return;
    event.preventDefault();
    hideMainWindowToTray();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  loadHostApp();
}

registerFolderExport({getWindow:() => mainWindow, isAllowedOrigin:isActiveHost});
function trustedClientWindow(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  const url = event.senderFrame.url;
  const localPages = ['settings.html','error.html'].map(file => pathToFileURL(path.join(__dirname,file)).href);
  return isActiveHost(url) || (showingLocalPage && localPages.some(page => url === page || url.startsWith(page+'?')));
}
function trustedLibrary(event) {
  if(event.senderFrame !== event.sender.mainFrame || !isActiveHost(event.senderFrame.url)) return null;
  return Object.entries(libraryWindows).find(([,win])=>win && !win.isDestroyed() && win.webContents===event.sender)?.[0] || null;
}
let assetDragCache;
function clientAssetDragCache(event) {
  if (!assetDragCache) {
    const session=event.sender.session;
    assetDragCache=createAssetDragCache({
      root:path.join(app.getPath('userData'),'asset-drag-cache'),
      fetchFile:(url,options)=>session.fetch(url,options)
    });
    assetDragCache.cleanup().catch(()=>{});
  }
  return assetDragCache;
}
async function prepareClientAssetDrag(event,payload) {
  if (!trustedClientWindow(event) && trustedLibrary(event)!=='asset') throw new Error('无权拖拽资产');
  return clientAssetDragCache(event).prepare(payload,activeHostUrl());
}
ipcMain.handle('lan-client:prepare-asset-drag',async(event,payload)=>{
  try {
    const result=await prepareClientAssetDrag(event,payload);
    return {ok:true,name:result.name,size:result.size};
  } catch(error) {return {ok:false,error:error.message};}
});
ipcMain.handle('lan-client:start-asset-drag',async(event,payload)=>{
  try {
    const result=await prepareClientAssetDrag(event,payload);
    if(event.sender.isDestroyed()) throw new Error('拖拽窗口已关闭');
    let icon=trayIcon();
    if (!icon.isEmpty()) icon=icon.resize({width:32,height:32,quality:'good'});
    event.sender.startDrag({file:result.filePath,icon});
    return {ok:true,name:result.name,size:result.size};
  } catch(error) {return {ok:false,error:error.message};}
});
ipcMain.handle('lan-client:library-open',(event,kind)=>trustedClientWindow(event) ? showLibrary(kind) : false);
ipcMain.handle('lan-client:library-hide',event=>{
  const kind=trustedLibrary(event);if(!kind) return false;
  libraryWindows[kind].hide();return true;
});
ipcMain.on('lan-client:library-resize',(event,size)=>{
  const kind=trustedLibrary(event);
  if(!kind || !Number.isFinite(size?.width) || !Number.isFinite(size?.height)) return;
  libraryWindows[kind].setSize(Math.max(720,Math.min(4096,Math.round(size.width))),Math.max(500,Math.min(4096,Math.round(size.height))));
});
ipcMain.handle('lan-client:library-apply-prompt',(event,content)=>{
  if(trustedLibrary(event)!=='prompt' || typeof content!=='string' || !mainWindow || mainWindow.isDestroyed()) return false;
  bringMainWindowToFront();
  mainWindow.webContents.send('library:apply-prompt',content.slice(0,100000));return true;
});
ipcMain.handle('lan-client:suspend-shortcuts',(event,value)=>{
  if(!trustedClientWindow(event)) return false;
  const config=readConnectionConfig();
  if(value===true) {
    replaceLibraryShortcuts({});
    replaceOpenAppShortcut('');
    return true;
  }
  return replaceOpenAppShortcut(config.shortcuts_enabled ? config.shortcut_settings.open_app : '') &&
    replaceLibraryShortcuts(config.shortcuts_enabled ? config.shortcut_settings : {});
});
ipcMain.handle('lan-client:window-action', (event, action) => {
  if (!trustedClientWindow(event)) return false;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  else if (action === 'close') mainWindow.close();
  else if (action !== 'state') return false;
  return {maximized:mainWindow.isMaximized()};
});
function clientDragPoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) && Math.abs(point.x)<100000 && Math.abs(point.y)<100000
    ? {x:Math.round(point.x),y:Math.round(point.y)} : null;
}
ipcMain.on('lan-client:drag-start',(event,point)=>{
  const cursor=clientDragPoint(point);
  if(!trustedClientWindow(event) || !cursor || !mainWindow.isVisible() || mainWindow.isMinimized()) return;
  const bounds=mainWindow.getBounds();
  mainWindowDrag={cursorX:cursor.x,cursorY:cursor.y,bounds,maximized:mainWindow.isMaximized(),lastX:bounds.x,lastY:bounds.y,moved:false};
});
ipcMain.on('lan-client:drag-move',(event,point)=>{
  const cursor=clientDragPoint(point),drag=mainWindowDrag;
  if(!trustedClientWindow(event) || !cursor || !drag || !mainWindow.isVisible() || mainWindow.isMinimized()) return;
  const dx=cursor.x-drag.cursorX,dy=cursor.y-drag.cursorY;
  if(!drag.moved && Math.abs(dx)+Math.abs(dy)<3) return;
  drag.moved=true;
  if(drag.maximized) {
    const anchor=Math.max(0,Math.min(1,(drag.cursorX-drag.bounds.x)/drag.bounds.width));
    const titleOffset=Math.max(0,Math.min(64,drag.cursorY-drag.bounds.y));
    mainWindow.unmaximize();
    const restored=mainWindow.getBounds();
    drag.bounds={...restored,x:Math.round(cursor.x-restored.width*anchor),y:Math.round(cursor.y-titleOffset)};
    drag.cursorX=cursor.x;drag.cursorY=cursor.y;drag.maximized=false;
  }
  const x=Math.round(drag.bounds.x+cursor.x-drag.cursorX),y=Math.round(drag.bounds.y+cursor.y-drag.cursorY);
  if(x===drag.lastX && y===drag.lastY) return;
  drag.lastX=x;drag.lastY=y;
  mainWindow.setPosition(x,y);
});
ipcMain.on('lan-client:drag-end',event=>{if(trustedClientWindow(event)) mainWindowDrag=null;});
ipcMain.handle('lan-client:appearance', (event, appearance) => {
  const kind=trustedLibrary(event);
  if ((!trustedClientWindow(event) && !kind) || !appearance || typeof appearance !== 'object') return {material:'none'};
  const win=kind ? libraryWindows[kind] : mainWindow;
  const theme = appearance.theme === 'dark' ? 'dark' : 'light';
  if (experimentalNativeGlass) {
    let material='none';
    try {
      if(experimentalNativeGlass.apply(win,appearance.mode==='none' && appearance.enabled!==false,appearance.shellBlur)) material='native-blur';
    } catch(error) {console.error('Experimental native glass failed:',error);}
    updateWindowShape(win);
    nativeTheme.themeSource=theme;
    return {material,shape:'custom'};
  }
  let material = appearance.mode === 'none' && appearance.enabled !== false && nativeBackdropSupported ? 'acrylic' : 'none';
  try { win.setBackgroundMaterial(material); } catch { material = 'none'; }
  nativeTheme.themeSource = theme;
  return {material, shape:nativeBackdropSupported?'native':'custom'};
});
ipcMain.handle('lan-client:get-config', () => ({ ...readConnectionConfig(), default_host_url: DEFAULT_HOST_URL, client_version: app.getVersion() }));
ipcMain.handle('lan-client:check-update', event => {
  if (!trustedClientWindow(event)) throw new Error('无权检查更新');
  return checkClientUpdate(app.getVersion(), net.fetch);
});
ipcMain.handle('lan-client:open-release', event => {
  if (!trustedClientWindow(event)) return false;
  return shell.openExternal(RELEASE_URL).then(() => true);
});
ipcMain.handle('lan-client:save-host', async (_event, hostUrl) => {
  const config = writeConnectionConfig(hostUrl);
  await loadHostApp();
  return config;
});
ipcMain.handle('lan-client:retry', async () => { await loadHostApp(); return { ok: true }; });
ipcMain.handle('lan-client:settings', async () => { await showConnectionSettings(); return { ok: true }; });
ipcMain.handle('lan-client:open-host', () => shell.openExternal(activeHostUrl()));
ipcMain.handle('lan-client:copy-host', async () => { await clipboard.writeText(activeHostUrl()); return { ok: true }; });
ipcMain.on('lan-client:change-page-zoom', (_event, delta) => { changePageZoom(Number(delta) || 0); });
ipcMain.handle('lan-client:get-shortcuts', () => {
  const config = readConnectionConfig();
  const accelerator = config.shortcut_settings.open_app;
  return { ...config, defaults: { ...DEFAULT_SHORTCUT_SETTINGS }, global_registered: config.shortcuts_enabled && activeOpenAppShortcut === accelerator && globalShortcut.isRegistered(accelerator), library_global_registered:config.shortcuts_enabled && Object.keys(libraryShortcuts).length===2 };
});
ipcMain.handle('lan-client:save-shortcuts', (_event, body = {}) => {
  const shortcutConfig = validateShortcutConfiguration(body, true);
  const previousShortcut = activeOpenAppShortcut;
  const previousLibraries={...libraryShortcuts};
  const nextShortcut = shortcutConfig.shortcuts_enabled ? shortcutConfig.shortcut_settings.open_app : '';
  if (!replaceOpenAppShortcut(nextShortcut)) throw new Error('当前快捷键被系统或其他软件占用，请更换。');
  if (!replaceLibraryShortcuts(shortcutConfig.shortcuts_enabled ? shortcutConfig.shortcut_settings : {})) {
    replaceOpenAppShortcut(previousShortcut);
    throw new Error('库快捷键被系统或其他软件占用，请更换。');
  }
  try {
    const config = writeConnectionConfig(activeHostUrl(), shortcutConfig);
    return { ...config, defaults: { ...DEFAULT_SHORTCUT_SETTINGS }, global_registered: shortcutConfig.shortcuts_enabled ? globalShortcut.isRegistered(nextShortcut) : false, library_global_registered:shortcutConfig.shortcuts_enabled && Object.keys(libraryShortcuts).length===2 };
  } catch (error) {
    replaceOpenAppShortcut(previousShortcut);
    replaceLibraryShortcuts(previousLibraries);
    throw error;
  }
});

if (hasInstanceLock) app.whenReady().then(() => {
  createMenu();
  createWindow();
  createTray();
  registerConfiguredOpenAppShortcut();
  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    bringMainWindowToFront();
  });
});

app.on('window-all-closed', () => { if (isAppQuitting) app.quit(); });
app.on('before-quit', () => { isAppQuitting = true; });
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  activeOpenAppShortcut = '';
  try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch {}
  tray = null;
});
