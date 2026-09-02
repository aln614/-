const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'style.css'), 'utf8');

function expect(pattern, text, message) {
  if (!pattern.test(text)) throw new Error(message);
}

expect(/function setupAutoHideScrollbars\(\)/, app, 'global auto-hide scrollbar setup is missing');
expect(/document\.addEventListener\('scroll',[\s\S]*capture:true/, app, 'scroll capture listener is missing');
expect(/setupAutoHideScrollbars\(\);[\s\S]*loadPreviewBgSettings/, app, 'scrollbar setup is not initialized at startup');
expect(/\.ui-scrollbar-active::\-webkit-scrollbar-thumb/, css, 'active scrollbar thumb style is missing');
expect(/::\-webkit-scrollbar-button:single-button[\s\S]*display:none!important/, css, 'native scrollbar buttons are not hidden');
expect(/::\-webkit-scrollbar-thumb\{[\s\S]*border-radius:999px!important/, css, 'rounded scrollbar thumb style is missing');

console.log('[verify-scrollbars] OK');
