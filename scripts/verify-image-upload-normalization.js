const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'src', 'services', 'apiClient.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const cache = fs.readFileSync(path.join(root, 'src', 'services', 'cache.js'), 'utf8');

function assert(value, message){ if(!value) throw new Error(message); }

assert(/async function normalizeBatchImageFile\([\s\S]{0,1500}createImageBitmap\(file\)[\s\S]{0,1200}image\/png/.test(app), 'renderer does not normalize WebP through Chromium canvas');
assert(/async function batchImageFileToItem\([\s\S]{0,300}normalizeBatchImageFile\(file\)/.test(app), 'batch inputs bypass WebP normalization');
assert(/isInvalidApimartImageContentError[\s\S]{0,1600}convertImageToUploadPng/.test(api), 'image generation upload lacks invalid-content fallback');
assert(/isInvalidApimartImageContentError[\s\S]{0,1600}convertImageToUploadPng/.test(main), 'video/MJ upload lacks invalid-content fallback');
assert(/async function convertImageToUploadPng\([\s\S]{0,1200}\.toPNG\(\)[\s\S]{0,500}convertImageWithChromium/.test(cache), 'main-process PNG fallback is missing');
assert(/async function convertImageWithChromium\([\s\S]{0,1800}createImageBitmap[\s\S]{0,1000}image\/png/.test(cache), 'main-process Chromium decoder fallback is missing');
assert(/for \(const \[index, p\][\s\S]{0,700}path\.basename\(p\)/.test(api), 'upload errors do not identify the failed input');

console.log('[verify-image-upload-normalization] OK: WebP inputs are normalized and deterministic upload errors stop proxy cycling.');
