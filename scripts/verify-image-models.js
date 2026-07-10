const fs = require('fs');
const path = require('path');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function fail(message) {
  console.error(`[verify-image-models] ${message}`);
  process.exit(1);
}

function parseArrayBlock(source, constName) {
  const marker = `const ${constName} = [`;
  const start = source.indexOf(marker);
  if (start < 0) fail(`Missing ${constName}`);
  const bodyStart = start + marker.length;
  const end = source.indexOf('\n];', bodyStart);
  if (end < 0) fail(`Could not parse ${constName}`);
  return source.slice(bodyStart, end);
}

function parseFrontendModelOptions(appJs) {
  const block = parseArrayBlock(appJs, 'APIMART_MODEL_OPTIONS');
  const out = [];
  const re = /\[\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*\]/g;
  let match;
  while ((match = re.exec(block))) out.push({ value: match[1], label: match[2] });
  return out;
}

function parseStringListFromArray(apiClientJs, constName) {
  const block = parseArrayBlock(apiClientJs, constName);
  const out = [];
  const re = /['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(block))) out.push(match[1]);
  return out;
}

function parseIndexApimartOptions(indexHtml) {
  const groupStart = indexHtml.indexOf('<optgroup label="APIMart');
  if (groupStart < 0) return [];
  const groupEnd = indexHtml.indexOf('</optgroup>', groupStart);
  const block = indexHtml.slice(groupStart, groupEnd > groupStart ? groupEnd : indexHtml.length);
  const out = [];
  const re = /<option\s+value="([^"]+)"/g;
  let match;
  while ((match = re.exec(block))) {
    if (match[1] !== 'custom') out.push(match[1]);
  }
  return out;
}

function unique(values) {
  return Array.from(new Set(values));
}

function main() {
  const rootArgIndex = process.argv.indexOf('--root');
  const root = rootArgIndex >= 0 ? path.resolve(process.argv[rootArgIndex + 1] || '.') : process.cwd();
  const appJsPath = path.join(root, 'src', 'renderer', 'static', 'app.js');
  const apiClientPath = path.join(root, 'src', 'services', 'apiClient.js');
  const indexPath = path.join(root, 'src', 'renderer', 'index.html');
  for (const file of [appJsPath, apiClientPath, indexPath]) {
    if (!fs.existsSync(file)) fail(`Missing file: ${file}`);
  }

  const appJs = read(appJsPath);
  const apiClientJs = read(apiClientPath);
  const indexHtml = read(indexPath);

  const frontendModels = parseFrontendModelOptions(appJs).map(x => x.value);
  const backendModels = parseStringListFromArray(apiClientJs, 'APIMART_IMAGE_MODELS');
  const indexModels = parseIndexApimartOptions(indexHtml);

  const backendSet = new Set(backendModels.map(x => x.toLowerCase()));
  const missingBackend = unique(frontendModels.filter(x => !backendSet.has(String(x).toLowerCase())));
  if (missingBackend.length) fail(`Frontend APIMart models missing in backend APIMART_IMAGE_MODELS: ${missingBackend.join(', ')}`);

  const frontendSet = new Set(frontendModels.map(x => x.toLowerCase()));
  const missingRuntime = unique(indexModels.filter(x => !frontendSet.has(String(x).toLowerCase())));
  if (missingRuntime.length) fail(`index.html APIMart options missing in runtime APIMART_MODEL_OPTIONS: ${missingRuntime.join(', ')}`);

  const required = ['doubao-seedream-5-0-pro'];
  const missingRequired = required.filter(x => !frontendSet.has(x) || !backendSet.has(x) || !indexModels.map(v => v.toLowerCase()).includes(x));
  if (missingRequired.length) fail(`Required homepage models are not wired end-to-end: ${missingRequired.join(', ')}`);

  console.log(`[verify-image-models] OK: ${frontendModels.length} frontend APIMart models match backend list.`);
}

main();
