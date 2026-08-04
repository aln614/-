'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/let currentPort = 7868;/.test(main), 'default running port must be 7868');
assert(/lan_enabled:\s*true/.test(main), 'LAN sharing must be enabled in the first-run defaults');
assert(/port:\s*7868/.test(main), 'first-run default port must be 7868');
assert(/lan_ip_override:\s*'192\.168\.110\.30'/.test(main), 'first-run LAN IP must be 192.168.110.30');
assert(main.includes("server.listen(currentPort, '0.0.0.0'"), 'server must listen on all local interfaces');
assert(!main.includes('|| 7861'), 'obsolete 7861 fallback remains in main process');
assert(html.includes('http://192.168.110.30:7868'), 'LAN UI placeholder must show the default address');
assert(!html.includes(':7861'), 'obsolete 7861 placeholder remains in the LAN UI');
assert(renderer.includes("$('#servicePort')?.value || 7868"), 'renderer port fallback must be 7868');

console.log('[verify-lan-defaults] OK: new installations default to http://192.168.110.30:7868 with LAN sharing enabled.');
