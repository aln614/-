'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, Tray, clipboard, globalShortcut, ipcMain, nativeImage, shell } = require('electron');

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
  const source = input.shortcut_settings && typeof input.shortcut_settings === 'object' ? input.shortcut_settings : {};
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
    { label: '最小化到后台', click: hideMainWindowToTray },
    { type: 'separator' },
    { label: '退出程序', click: () => { isAppQuitting = true; app.quit(); } }
  ]));
  tray.on('click', bringMainWindowToFront);
  tray.on('double-click', bringMainWindowToFront);
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
  return replaceOpenAppShortcut(accelerator);
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
    backgroundColor: '#111827',
    title: 'TENYING AI 局域网访问端',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.once('ready-to-show', bringMainWindowToFront);
  mainWindow.webContents.on('did-finish-load', () => applyPageZoom());
  mainWindow.webContents.on('before-input-event', (event, input) => {
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

ipcMain.handle('lan-client:get-config', () => ({ ...readConnectionConfig(), default_host_url: DEFAULT_HOST_URL }));
ipcMain.handle('lan-client:save-host', async (_event, hostUrl) => {
  const config = writeConnectionConfig(hostUrl);
  await loadHostApp();
  return config;
});
ipcMain.handle('lan-client:retry', async () => { await loadHostApp(); return { ok: true }; });
ipcMain.handle('lan-client:settings', async () => { await showConnectionSettings(); return { ok: true }; });
ipcMain.handle('lan-client:open-host', () => shell.openExternal(activeHostUrl()));
ipcMain.handle('lan-client:copy-host', () => { clipboard.writeText(activeHostUrl()); return { ok: true }; });
ipcMain.on('lan-client:change-page-zoom', (_event, delta) => { changePageZoom(Number(delta) || 0); });
ipcMain.handle('lan-client:get-shortcuts', () => {
  const config = readConnectionConfig();
  const accelerator = config.shortcut_settings.open_app;
  return { ...config, defaults: { ...DEFAULT_SHORTCUT_SETTINGS }, global_registered: config.shortcuts_enabled && activeOpenAppShortcut === accelerator && globalShortcut.isRegistered(accelerator) };
});
ipcMain.handle('lan-client:save-shortcuts', (_event, body = {}) => {
  const shortcutConfig = validateShortcutConfiguration(body, true);
  const previousShortcut = activeOpenAppShortcut;
  const nextShortcut = shortcutConfig.shortcuts_enabled ? shortcutConfig.shortcut_settings.open_app : '';
  if (!replaceOpenAppShortcut(nextShortcut)) throw new Error('当前快捷键被系统或其他软件占用，请更换。');
  try {
    const config = writeConnectionConfig(activeHostUrl(), shortcutConfig);
    return { ...config, defaults: { ...DEFAULT_SHORTCUT_SETTINGS }, global_registered: shortcutConfig.shortcuts_enabled ? globalShortcut.isRegistered(nextShortcut) : false };
  } catch (error) {
    replaceOpenAppShortcut(previousShortcut);
    throw error;
  }
});

app.whenReady().then(() => {
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
