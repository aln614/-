const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'style.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/class="asset-image-thumb"/.test(app), 'Asset image thumbnails need a dedicated CSS hook');
assert(/\.asset-image-thumb\{[^}]*object-fit:contain!important/.test(css), 'Asset thumbnails must use contain so images are fully visible');
assert(/function sortAssetRows\(/.test(main) && /sortAssetRows\(visibleAssets/.test(main), 'Asset list must keep the persisted manual order');
assert(/function assetReorder\(/.test(main), 'Asset reorder backend handler is missing');
assert(/canManageAssetRow\(source, local, ownerId\)/.test(main), 'Asset reorder must check source ownership');
assert(/\/api\/assets\/reorder/.test(main), 'Asset reorder route is missing');
assert(/application\/x-laig-asset-reorder/.test(app), 'Internal asset drag type is missing');
assert(/assetHasInternalDrag\(e\.dataTransfer\)/.test(app), 'Internal drags must be separated from file uploads');
assert(/assetReorderAsset\(id, beforeId\)/.test(app), 'Grid drop must persist the new asset order');
assert(/DownloadURL/.test(app) && /text\/uri-list/.test(app), 'Dragging outside must continue to expose the original asset');
assert(/startAssetDrag:\s*\(payload\)\s*=>\s*ipcRenderer\.send\('start-asset-drag'/.test(preload), 'Preload must expose the native asset drag bridge');
assert(/ipcMain\.on\('start-asset-drag'/.test(main), 'Main process must handle native asset drag requests');
assert(/event\.sender\.startDrag\(\{ file: asset\.local_path, icon \}\)/.test(main), 'Native asset drag must use the source local_path, not thumb_path');
assert(/startAssetDrag\?\.\(\{id:asset\.id\}\)/.test(app), 'Asset cards must invoke native source-file dragging');
assert(/PROMPT_LIBRARY_SIDEBAR_PIN_KEY/.test(app), 'Prompt-library category sidebar must persist its pin state');
assert(/promptSidebarToggleBtn/.test(app) && /prompt-sidebar-collapsed/.test(css), 'Prompt-library category sidebar must support compact collapse');
assert(/function assetToggleGroupChildren\(/.test(app), 'Asset parent groups must support expand/collapse from row interactions');
assert(/addEventListener\('dblclick',[\s\S]*?assetToggleGroupChildren\(row\.dataset\.id\)/.test(app), 'Double-clicking an asset parent group must toggle its children');
assert(/addEventListener\('wheel',[\s\S]*?tree\.scrollTop=next/.test(app), 'Asset category wheel scrolling must stay inside the tree');
assert(/\.asset-group-tree\{[^}]*overflow-y:auto!important[^}]*overscroll-behavior:contain/.test(css), 'Asset category tree must own vertical scrolling');

console.log('[verify-asset-library-drag] OK: full thumbnails, drag workflows, prompt categories, and scrollable asset groups are wired.');
