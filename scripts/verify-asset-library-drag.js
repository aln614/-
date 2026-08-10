const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'style.css'), 'utf8');

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
assert(/PROMPT_LIBRARY_SIDEBAR_PIN_KEY/.test(app), 'Prompt-library category sidebar must persist its pin state');
assert(/promptSidebarToggleBtn/.test(app) && /prompt-sidebar-collapsed/.test(css), 'Prompt-library category sidebar must support compact collapse');

console.log('[verify-asset-library-drag] OK: full thumbnails, internal reordering, external source drag, and prompt categories are wired.');
