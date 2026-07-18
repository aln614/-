const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/globalShortcut/.test(main), 'Electron globalShortcut is not imported');
assert(/open_app:\s*'Ctrl\+Alt\+A'/.test(main), 'Default open-app shortcut is missing');
assert(/toggle_asset_library:\s*'Ctrl\+Shift\+A'/.test(main), 'Default asset shortcut is missing');
assert(/toggle_prompt_library:\s*'Ctrl\+Shift\+P'/.test(main), 'Default prompt shortcut is missing');
assert(/p === '\/api\/shortcuts'/.test(main), 'Shortcut configuration API is missing');
assert(/globalShortcut\.register\(next, toggleMainWindowFromShortcut\)/.test(main), 'Open-app global shortcut toggle registration is missing');
assert(/globalShortcut\.unregisterAll\(\)/.test(main), 'Global shortcut cleanup is missing');
assert(/\bTray\b/.test(main) && /new Tray\(iconPath\)/.test(main), 'Windows system tray is missing');
assert(/function toggleMainWindowFromShortcut\(\)[\s\S]*?hideMainWindowToTray\(\)[\s\S]*?bringMainWindowToFront\(\)/.test(main), 'Open-app shortcut must toggle tray visibility');
assert(/mainWindow\.on\('close',[\s\S]*?hideMainWindowToTray\(\)/.test(main), 'Window close must hide the app to tray');
assert(/label:'退出程序'/.test(main), 'Tray quit command is missing');
assert(/id="shortcutSettingsBtn"/.test(html), 'Sidebar shortcut entry is missing');
assert(/id="shortcutSettingsLayer"/.test(html), 'Shortcut settings panel is missing');
assert(/setupShortcutSettings\(\)/.test(app), 'Renderer shortcut setup is missing');
assert(/toggleAssetLibraryShortcut\(\)/.test(app), 'Asset library shortcut handler is missing');
assert(/togglePromptLibraryShortcut\(\)/.test(app), 'Prompt library shortcut handler is missing');
assert(/SHORTCUT_BLOCKED/.test(app) && /Alt\+F4/.test(app), 'Blocked shortcut validation is missing');

console.log('[verify-shortcuts] OK: global app visibility toggle, system tray, and two in-window library shortcuts are wired.');
