const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'style.css'), 'utf8');

function requireText(source, text, message) {
  if (!source.includes(text)) throw new Error(message);
}

requireText(html, 'id="previewInfoTitle"', 'Image preview title must be replaceable.');
requireText(html, 'id="videoPreviewInfoTitle"', 'Video preview title must be replaceable.');
requireText(app, 'function assetPreviewMeta', 'Asset preview metadata mapping is missing.');
requireText(app, "setPreviewLabel('previewInfoTitle', '文件信息')", 'Image assets must use file information.');
requireText(app, "setPreviewLabel('videoPreviewInfoTitle', '文件信息')", 'Video assets must use file information.');
requireText(app, "else showPreview('',previewMeta)", 'Attachments must open a file-information preview.');
requireText(app, "classList.toggle('asset-file-preview'", 'Asset previews must be raised above the library window.');
requireText(app, 'fitAssetTextElement', 'Asset text fitting is missing.');
requireText(css, '#previewModal.asset-file-preview', 'Asset preview stacking style is missing.');
requireText(css, '.asset-card .asset-name', 'Asset filename wrapping style is missing.');

console.log('[verify-asset-file-preview] OK: file-aware preview, stacking, and adaptive asset text are wired.');
