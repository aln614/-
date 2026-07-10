const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

function fail(message) {
  console.error(`[verify-midjourney] ${message}`);
  process.exit(1);
}

const expectedTabs = [
  'imagine',
  'blend',
  'describe',
  'edits',
  'upscale',
  'variation',
  'high_variation',
  'low_variation',
  'reroll',
  'inpaint',
  'zoom',
  'pan',
  'remix',
  'video'
];

const tabBlock = appJs.match(/const\s+MJ_TABS\s*=\s*\[([\s\S]*?)\];/);
if (!tabBlock) fail('MJ_TABS not found');
const tabs = Array.from(tabBlock[1].matchAll(/key\s*:\s*'([^']+)'/g)).map(m => m[1]);

const formBlock = appJs.match(/const\s+MJ_FORM_CONFIG\s*=\s*\{([\s\S]*?)\n\};/);
if (!formBlock) fail('MJ_FORM_CONFIG not found');

const labelBlock = appJs.match(/const\s+MJ_SUBMIT_LABELS\s*=\s*\{([\s\S]*?)\n\};/);
if (!labelBlock) fail('MJ_SUBMIT_LABELS not found');

const endpointBlock = mainJs.match(/const\s+endpointMap\s*=\s*\{([^}]+)\s*\};/);
if (!endpointBlock) fail('backend endpointMap not found');

for (const key of expectedTabs) {
  if (!tabs.includes(key)) fail(`frontend MJ_TABS missing ${key}`);
  if (key === 'inpaint') {
    if (!appJs.includes('function renderMjInpaintForm')) fail('frontend inpaint special renderer missing');
  } else if (!new RegExp(`\\b${key}\\s*:`).test(formBlock[1])) {
    fail(`frontend MJ_FORM_CONFIG missing ${key}`);
  }
  if (!new RegExp(`\\b${key}\\s*:`).test(labelBlock[1])) fail(`frontend MJ_SUBMIT_LABELS missing ${key}`);
  if (key !== 'remix' && !new RegExp(`\\b${key}\\s*:`).test(endpointBlock[1])) fail(`backend endpointMap missing ${key}`);
}

if (!appJs.includes("POST /v1/midjourney/generations/video")) fail('MJ video endpoint missing from UI');
if (!mainJs.includes("'/midjourney/generations/video'")) fail('MJ video endpoint missing from backend');
if (!mainJs.includes("pickApimartVideoUrls(raw)")) fail('MJ task normalization no longer exposes video_urls');

console.log(`[verify-midjourney] OK: ${expectedTabs.length} Midjourney tabs and backend endpoints are aligned.`);
