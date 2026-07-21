const fs = require('fs');
const path = require('path');
const { isTerminalGenerationError } = require('../src/services/taskErrors');

const root = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const rendererJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const apiClientJs = fs.readFileSync(path.join(root, 'src', 'services', 'apiClient.js'), 'utf8');

function assert(value, message) {
  if (!value) throw new Error(message);
}

assert(rendererJs.includes('function validateImageApiKey'), 'renderer API Key validation is missing');
assert(rendererJs.includes('当前内容是网址，请填写 APIMart API Key'), 'renderer does not explain the URL/API-Key mix-up');
assert(rendererJs.includes("$('#apiKey')?.addEventListener('input', updateApiKeyWarning)"), 'API Key validation is not immediate');
assert(rendererJs.includes('const keyValidation = updateApiKeyWarning()'), 'batch submit does not stop on an invalid API Key');

assert(mainJs.includes('function validateBatchApiKey'), 'server-side batch API Key validation is missing');
assert(mainJs.includes('body.api_key = validateBatchApiKey(body, cfg, local)'), 'batch route can bypass API Key validation');
assert(mainJs.includes('error.statusCode = 400'), 'invalid API Key does not return HTTP 400');
assert(mainJs.includes('requestedCode >= 400 && requestedCode <= 599'), 'API handler discards validation status codes');

assert(apiClientJs.includes("error.code = 'APIMART_INVALID_API_KEY'"), 'APIMart authentication errors are not classified');
assert(apiClientJs.includes('if(isApimartAuthenticationError(e)) throw apimartAuthenticationError()'), 'authentication errors still fall through to proxy retries');
assert(isTerminalGenerationError(Object.assign(new Error('invalid API key'), { code:'APIMART_INVALID_API_KEY' })), 'invalid API Key is not terminal');
assert(isTerminalGenerationError(new Error('APIMart API Key 无效')), 'localized API Key errors are not terminal');
assert(!isTerminalGenerationError(new Error('temporary network timeout')), 'temporary network errors must remain retryable');

console.log('[verify-public-api-key-validation] OK: public API Key errors fail before batch creation and never enter proxy/task retry loops.');
