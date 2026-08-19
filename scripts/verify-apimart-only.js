const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

const forbiddenUi = [
  'data-platform="flow2api"',
  '本地 Flow2API 图像模型',
  '127.0.0.1:38000（本地 Flow2API）'
];

for (const value of forbiddenUi) {
  if (html.includes(value)) throw new Error(`removed platform UI returned: ${value}`);
}
if (!/function normalizeImagePlatformValue\([^)]*\)\s*{\s*return 'apimart';\s*}/.test(app)) {
  throw new Error('renderer no longer forces legacy platform settings to APIMart');
}
if (!/function batchImagePlatform\([^)]*\)\s*{\s*return 'apimart';\s*}/.test(main)) {
  throw new Error('server no longer forces new image batches to APIMart');
}
if (main.includes("p === '/api/grsai_tool'")) throw new Error('legacy GrsAI endpoint returned');

console.log('[verify-apimart-only] OK: removed platforms cannot be selected or submitted.');
