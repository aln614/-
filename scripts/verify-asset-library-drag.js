const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'style.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
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
assert(/prepareAssetDrag:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('prepare-asset-drag'/.test(preload), 'Preload must expose asynchronous asset drag preparation');
assert(/startAssetDrag:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('start-asset-drag'/.test(preload), 'Preload must expose the controlled native asset drag bridge');
assert(/ipcMain\.handle\('prepare-asset-drag'/.test(main) && /ipcMain\.handle\('start-asset-drag'/.test(main), 'Main process must prepare and start native asset drags');
assert(/nativeDragPreparedFile[\s\S]*?copyFileToLocalHotCache/.test(main), 'Native dragging must create an independent local copy');
assert(/icon\.resize\(\{ width:32, height:32/.test(main), 'Native drag feedback must use a bounded icon');
assert(/sender\.startDrag\(\{ file:prepared\.filePath, icon \}\)/.test(main), 'Native dragging must expose only the prepared copy');
assert(!/startDrag\(\{ file:\s*asset\.local_path/.test(main), 'Native dragging must never expose the library source path directly');
assert(/e\.preventDefault\(\);[\s\S]*?assetStartNativeDrag\(asset, card\)/.test(app), 'Electron asset drags must cancel the competing HTML drag loop');
assert(/if\(e\.target\.closest\?\.\('\.asset-card'\)\) return;/.test(app), 'Asset cards must bypass the generic generated-image drag handler');
assert(/window\.addEventListener\('blur', hideDragOriginalBadge/.test(app), 'Native drag feedback must be cleared if the window loses focus');
assert(/id="assetSearchAllBtn"/.test(index), 'Asset library must expose the all-groups search toggle');
assert(/searchAll:false/.test(app) && /searchEveryGroup=assetState\.searchAll && !!query/.test(app), 'All-groups search must only expand scope when a query exists');
assert(/assetState\.searchAll=!assetState\.searchAll/.test(app), 'All-groups search button must toggle its search scope');
assert(/assetPrepareNativeDrag\(asset\)/.test(app), 'Asset cards must warm the independent drag copy before dragstart');
assert(/startImageDrag:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('start-image-drag'/.test(preload), 'Generated images must use the controlled native drag bridge');
assert(/ipcMain\.handle\('start-image-drag'/.test(main), 'Main process must await the generated-image drag copy');
assert(/imageDragCanUseNative\(fullUrl\)[\s\S]*?e\.preventDefault\(\)/.test(app), 'Native image dragging must cancel the competing HTML drag loop');
assert(/PROMPT_LIBRARY_SIDEBAR_PIN_KEY/.test(app), 'Prompt-library category sidebar must persist its pin state');
assert(/promptSidebarToggleBtn/.test(app) && /prompt-sidebar-collapsed/.test(css), 'Prompt-library category sidebar must support compact collapse');
assert(/function assetToggleGroupChildren\(/.test(app), 'Asset parent groups must support expand/collapse from row interactions');
assert(/function assetMoveGroup\(/.test(main) && /\/api\/assets\/groups\/move/.test(main), 'Asset group move/reorder backend is missing');
assert(/descendants\.has\(parentId\)/.test(main), 'Asset groups must not be moved into their own descendants');
assert(/application\/x-laig-asset-group/.test(app), 'Asset category rows must expose an internal group drag type');
assert(/function assetGroupDropIntentForEvent\(/.test(app) && /group-drop-(before|after|inside)/.test(app), 'Asset category drag placement must support reorder and nesting');
assert(/assetMoveGroupTree\(sourceId,intent\.parentId,intent\.beforeId\)/.test(app), 'Asset category drops must persist through the move endpoint');
assert(/addEventListener\('dblclick',[\s\S]*?assetToggleGroupChildren\(row\.dataset\.id\)/.test(app), 'Double-clicking an asset parent group must toggle its children');
assert(/addEventListener\('wheel',[\s\S]*?tree\.scrollTop=next/.test(app), 'Asset category wheel scrolling must stay inside the tree');
assert(/\.asset-group-tree\{[^}]*overflow-y:auto!important[^}]*overscroll-behavior:contain/.test(css), 'Asset category tree must own vertical scrolling');
assert(/function assetApplyLoadedFilter\(/.test(app), 'Asset group switching must filter the loaded asset index locally');
assert(/function loadAssetAssets\([^)]*skipTree=true/.test(app), 'Asset group switching must preserve the existing category tree');
assert(/renderAssetLibrary\(\{skipTree\}\)/.test(app), 'Asset rendering must support a grid-only fast path');
assert(/assetTextMeasureContext[\s\S]*?measureText\(String\(text\|\|''\)\)/.test(app), 'Asset text fitting must avoid repeated DOM layout measurements');
assert(/data-asset-media-src/.test(app) && /function assetHydrateCardMedia\(/.test(app), 'Asset thumbnails must hydrate only near the visible grid area');
assert(/new IntersectionObserver[\s\S]*?root:grid[\s\S]*?rootMargin:'240px 0px'/.test(app), 'Asset media lazy loading must follow the asset grid viewport');
assert(/assetRevealTreeScrollbar\(tree\)/.test(app) && /scrollbar-active/.test(app), 'Asset scrollbar visibility must follow active scrolling');
assert(/\.asset-group-tree\.scrollbar-active/.test(css) && /scrollbar-color:transparent transparent/.test(css), 'Asset scrollbar must hide after scrolling without shifting layout');
assert(/\*::\-webkit-scrollbar-button:single-button\{[^}]*display:none!important/.test(css), 'Scrollbar arrow buttons must stay hidden');
assert(/\.asset-group-tree\.scrollbar-active::\-webkit-scrollbar-track\{background:transparent!important\}/.test(css), 'Active asset scrolling must keep the track invisible');

console.log('[verify-asset-library-drag] OK: full thumbnails, drag workflows, prompt categories, fast switching, and auto-hidden group scrolling are wired.');
