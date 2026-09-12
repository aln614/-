'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const renderer = read('src/renderer/static/app.js');
const start = renderer.indexOf('let homepageReferencePasteUntil = 0;');
const end = renderer.indexOf('function normalizePublicAccessUrl(', start);
assert(start > 0 && end > start, 'Reference paste routing must be present');
const pasteSource = renderer.slice(start, end);

function namedFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert(start >= 0, 'Missing ' + name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
for (const file of ['src/main.js', 'lan-client/main.js']) {
  const source = read(file);
  const defaults = source.match(/const DEFAULT_SHORTCUT_SETTINGS = Object\.freeze\(\{[\s\S]*?\}\);/)[0];
  const blocked = source.match(/const BLOCKED_SHORTCUTS = new Set\([^\n]+/)[0];
  const context = vm.createContext({});
  vm.runInContext(defaults + '\n' + blocked + '\n' + namedFunction(source, 'normalizeShortcutAccelerator') + '\n' + namedFunction(source, 'validateShortcutConfiguration'), context);
  const original = {shortcuts_enabled:false, shortcut_settings:{open_app:'Ctrl+Shift+V', toggle_asset_library:'Ctrl+Alt+A', toggle_prompt_library:'Ctrl+Alt+P', toggle_agent:'Alt+G'}};
  context.original = original;
  const repaired = vm.runInContext('validateShortcutConfiguration(original)', context);
  assert.equal(repaired.shortcuts_enabled, false);
  assert.notEqual(repaired.shortcut_settings.open_app, 'Ctrl+Shift+V');
  assert.equal(new Set(Object.values(repaired.shortcut_settings)).size, 4);
  for (const key of ['toggle_asset_library', 'toggle_prompt_library', 'toggle_agent']) assert.equal(repaired.shortcut_settings[key], original.shortcut_settings[key]);
  assert.equal(original.shortcut_settings.open_app, 'Ctrl+Shift+V', 'Do not mutate stored input');
  assert.throws(() => vm.runInContext('validateShortcutConfiguration(original, true)', context), /Ctrl\+Shift\+V/);
  assert.match(source, /before-input-event/);
  const gestureHandler = source.match(/const referencePasteKey = input.control[\s\S]*?if\(input.type === 'keyDown'\) referencePasteGestureUntil = referencePasteKey \? Date.now\(\) \+ 1500 : 0;/)[0];
  const ipcHandler = source.match(/mainWindow.webContents.on\('ipc-message', \(_event, channel\) => \{[\s\S]*?\n  \}\);/)[0];
  let pasteCount = 0, onMessage;
  const gestureContext = vm.createContext({mainWindow:{webContents:{setIgnoreMenuShortcuts:()=>{}, paste:()=>pasteCount++, on:(name, handler)=>{onMessage = handler;}}}});
  vm.runInContext('let referencePasteGestureUntil = 0;\n' + ipcHandler, gestureContext);
  onMessage({}, 'reference-image-paste'); assert.equal(pasteCount, 0, 'Reject clipboard access without a key gesture');
  gestureContext.input = {type:'keyDown',control:true,shift:true,code:'KeyV'};
  vm.runInContext('{' + gestureHandler + '}', gestureContext);
  onMessage({}, 'reference-image-paste'); onMessage({}, 'reference-image-paste');
  assert.equal(pasteCount, 1, 'Native paste must be one-shot');
  vm.runInContext('{' + gestureHandler + '}\nreferencePasteGestureUntil = Date.now() - 1;', gestureContext);
  onMessage({}, 'reference-image-paste'); assert.equal(pasteCount, 1, 'Reject expired gestures');
}
for (const file of ['src/preload.js', 'lan-client/preload.js']) assert.match(read(file), /pasteReferenceImages: \(\) => ipcRenderer.send\('reference-image-paste'\)/);
assert.match(read('src/renderer/index.html'), /id="refDrop" tabindex="0" aria-keyshortcuts="Control\+Shift\+V"/);
assert.match(pasteSource, /addFiles\(imageFiles, 'ref'\)/);
assert.match(pasteSource, /addFiles\(imageFiles, 'main'\)/);
assert.match(pasteSource, /window.isSecureContext && typeof navigator.clipboard\?\.read === 'function'/, 'Browser Clipboard API must be secure-context gated');
console.log('[verify-reference-paste] Shortcut conflict repair, desktop bridges and paste routes passed.');
module.exports = {pasteSource};
