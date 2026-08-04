'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'settings.html'), 'utf8');
const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(main.includes("const DEFAULT_HOST_URL = 'http://192.168.110.30:7868';"), 'LAN client default host is incorrect');
assert(packageJson.includes('"electronVersion": "35.7.5"'), 'LAN client build must pin its Electron version');
assert(main.includes("await mainWindow.loadURL(hostUrl);"), 'LAN client does not load the host application');
assert(main.includes("contextIsolation: true") && main.includes("nodeIntegration: false"), 'LAN client BrowserWindow security settings are missing');
assert(main.includes('writeConnectionConfig'), 'LAN client host setting is not persisted');
assert(preload.includes("contextBridge.exposeInMainWorld('lanClient'"), 'LAN client preload bridge is missing');
assert(settings.includes('保存并连接'), 'LAN client connection settings page is missing');
assert(main.includes('globalShortcut') && main.includes('function toggleMainWindowFromShortcut'), 'LAN client global open/close shortcut is missing');
assert(main.includes('new Tray(') && main.includes('function hideMainWindowToTray'), 'LAN client system tray is missing');
assert(/mainWindow\.on\('close',[\s\S]*?hideMainWindowToTray\(\)/.test(main), 'LAN client close must minimize to the system tray');
assert(main.includes("lan-client:get-shortcuts") && main.includes("lan-client:save-shortcuts"), 'LAN client shortcut IPC is missing');
assert(preload.includes('getShortcuts') && preload.includes('saveShortcuts'), 'LAN client shortcut preload API is missing');
assert(packageJson.includes('"extraResources"'), 'LAN client tray icon must be packaged as an extra resource');
assert(main.includes('function changePageZoom') && main.includes('webContents.setZoomFactor'), 'LAN client page zoom control is missing');
assert(main.includes("before-input-event") && main.includes("changePageZoom(ZOOM_STEP)"), 'LAN client Ctrl +/- page zoom handling is missing');
assert(main.includes('zoom_factor') && main.includes('writeConnectionConfig(config.host_url, null, next)'), 'LAN client page zoom must persist locally');
assert(preload.includes("addEventListener('wheel'") && preload.includes('lan-client:change-page-zoom'), 'LAN client Ctrl + mouse wheel zoom handling is missing');

console.log('[lan-client:check] OK: dedicated LAN client defaults to http://192.168.110.30:7868 with background shortcuts and persistent page zoom.');
