'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, clipboard, ipcMain, shell } = require('electron');

const DEFAULT_HOST_URL = 'http://192.168.110.30:7868';
const CONFIG_FILE = 'connection.json';
let mainWindow = null;
let showingLocalPage = false;

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

function readConnectionConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { host_url: normalizeHostUrl(stored.host_url || DEFAULT_HOST_URL) };
  } catch {
    return { host_url: DEFAULT_HOST_URL };
  }
}

function writeConnectionConfig(hostUrl) {
  const next = { host_url: normalizeHostUrl(hostUrl), updated_at: new Date().toISOString() };
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
        { role: 'reload', label: '刷新当前页面' }
      ]
    }
  ]));
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
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-fail-load', (_event, _code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame && !showingLocalPage && isActiveHost(validatedUrl)) showConnectionError(description || '无法连接到主机端').catch(() => {});
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isActiveHost(targetUrl)) return { action: 'allow' };
    shell.openExternal(targetUrl).catch(() => {});
    return { action: 'deny' };
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

app.whenReady().then(() => {
  createMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
