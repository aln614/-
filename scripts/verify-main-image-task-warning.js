const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'style.css'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/id="mainImageTaskWarning"/.test(html), 'Main image task warning element is missing');
assert(/mainImages\.length >= 2/.test(app), 'Warning must begin when two or more main images are uploaded');
assert(/已上传 \$\{mainImages\.length\} 张主图，将创建 \$\{mainImages\.length\} 个独立主任务/.test(app), 'Warning must state the number of independent main tasks');
assert(/\.main-image-task-warning\{[^}]*color:#dc2626/.test(css), 'Main image task warning must use red text');

console.log('Main image multi-task warning validation passed.');
