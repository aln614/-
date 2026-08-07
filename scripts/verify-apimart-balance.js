const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const rendererJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');

function assert(value, message) {
  if (!value) throw new Error(message);
}

assert(mainJs.includes("p === '/api/apimart/balance'"), 'APIMart balance route is missing.');
assert(mainJs.includes("getJsonApimart('/balance', apiKey, 15000)"), 'Token balance endpoint is not queried.');
assert(mainJs.includes("getJsonApimart('/user/balance', apiKey, 15000)"), 'User balance endpoint is not queried.');
assert(mainJs.includes('const includeToken = body.include_token'), 'Header refresh cannot limit polling to the user-balance endpoint.');
assert(mainJs.includes('assertApimartBalanceApiKey(body.api_key)'), 'Balance route must require the caller-supplied API Key.');
assert(mainJs.includes('normalizeApimartBalanceResponse'), 'Balance response normalization is missing.');
assert(rendererJs.includes('function refreshApimartBalance'), 'Renderer balance refresh logic is missing.');
assert(rendererJs.includes('function ensureApimartBalanceModal'), 'Renderer balance detail modal is missing.');
assert(rendererJs.includes("api('/api/apimart/balance'"), 'Renderer does not call the balance endpoint.');
assert(rendererJs.includes('apimartBalancePollTimer'), 'Balance periodic refresh is missing.');
assert(rendererJs.includes('APIMART_BALANCE_POLL_INTERVAL_MS = 15000'), 'Balance refresh is not configured for real-time polling.');
assert(rendererJs.includes('balanceTaskSignature'), 'Balance does not refresh immediately when task state changes.');
assert(indexHtml.includes('id="apiState"') && indexHtml.includes('API余额'), 'Header API balance command is missing.');

console.log('[verify-apimart-balance] OK: user and token balance monitoring are wired with per-device API Key isolation.');
