'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sanitizeApimartImagePayload: sanitize, getApimartImageRule } = require('../src/services/apiClient');
const { createFallbackPricingCatalog, APP_IMAGE_PRICE_MODEL_MAP } = require('../src/services/apimartPricing');

const references = Array.from({ length: 17 }, (_, i) => 'https://example.com/' + i + '.png');
for (const [id, version] of [['gpt-image-2.5-ext', 'flare'], ['gpt-image-2.5-ext-sunburst', 'sunburst']]) {
  for (const resolution of ['1K', '2K', '4K']) {
    const payload = sanitize({
      prompt: 'test', size: '16:9', resolution: resolution.toLowerCase(), n: 4,
      image_urls: references, quality: 'max', background: 'transparent',
      output_format: 'webp', mask_url: references[0], version: 'flare'
    }, id);
    assert.equal(payload.model, 'gpt-image-2.5-ext');
    assert.equal(payload.version, version);
    assert.equal(payload.resolution, resolution);
    assert.equal(payload.n, 4);
    assert.equal(payload.image_urls.length, 16);
    for (const key of ['quality','background','output_format','mask_url']) assert.ok(!(key in payload), key);
  }
  assert.equal(sanitize({size:'2048x2048', n:8}, id).size, 'auto');
  assert.equal(sanitize({size:'9:21', n:8}, id).n, 4);
  assert.equal(sanitize({size:'9:21'}, id).size, 'auto');
}
assert.equal(sanitize({version:'sunburst'}, 'gpt-image-2.5-ext').version, 'sunburst');
assert.throws(() => sanitize({version:'invalid'}, 'gpt-image-2.5-ext'), /version/);
assert.equal(sanitize({quality:'max'}, 'gpt-image-2.5-flare').quality, 'max');
assert.equal(sanitize({image_urls:references}, 'gpt-image-2-official').image_urls.length, 16);
for (const id of ['gpt-image-1-official','gpt-image-1.5-official','gpt-image-2']) {
  assert.equal(sanitize({image_urls:references}, id).image_urls.length, 15);
}
for (const id of ['gemini-2.5-flash-image-preview','gemini-2.5-flash-image-preview-official']) {
  const payload = sanitize({image_urls:references, n:4, resolution:'4K'}, id);
  assert.equal(payload.image_urls.length, 14);
  assert.equal(payload.n, 1);
  assert.equal(payload.resolution, '1K');
}
assert.equal(sanitize({image_urls:references}, 'grok-imagine-1.5-apimart').image_urls.length, 5);
assert.equal(sanitize({resolution:'4K'}, 'wan2.7-image-pro').resolution, '4K');
assert.equal(sanitize({resolution:'4K', image_urls:references}, 'wan2.7-image-pro').resolution, '2K');
assert.equal(sanitize({quality:'low'}, 'grok-imagine-image-2.0').quality, 'low');
assert.equal(sanitize({quality:'max'}, 'grok-imagine-image-2.0').quality, 'medium');
assert.ok(!('quality' in sanitize({quality:'medium',image_urls:references}, 'grok-imagine-image-2.0')));
assert.ok(getApimartImageRule('seedream-5-0-lite').resolutions.includes('4k'));

const flash = 'seedream-5-0-flash';
const flashRule = getApimartImageRule(flash);
assert.notStrictEqual(flashRule, getApimartImageRule('seedream-5.0-pro'), 'Keep the Pro alias separate from Flash');
for (const resolution of ['1K','1.5K','2K']) {
  for (const size of flashRule.sizes) {
    const payload = sanitize({prompt:'test', size, resolution:resolution.toLowerCase(), n:15,
      image_urls:references, output_format:'jpeg', output_compression:80,
      quality:'max', background:'transparent', mask_url:references[0],
      watermark:true, optimize_prompt_options:{mode:'standard'}}, flash);
    assert.equal(payload.model, flash);
    assert.equal(payload.size, size);
    assert.equal(payload.resolution, resolution);
    assert.equal(payload.n, 1);
    assert.equal(payload.image_urls.length, 10);
    assert.equal(payload.watermark, true);
    assert.equal(payload.output_format, 'jpeg');
    assert.deepStrictEqual(payload.optimize_prompt_options, {mode:'standard'});
    for (const key of ['output_compression','quality','background','mask_url','sequential_image_generation']) {
      assert.ok(!(key in payload), key);
    }
  }
}
assert.equal(sanitize({resolution:'4K', size:'9:21'}, flash).resolution, '1K');
assert.equal(sanitize({resolution:'4K', size:'9:21'}, flash).size, 'auto');
for (const size of ['2048x1024','1280x720','2048x2048','4000x250']) {
  assert.equal(sanitize({size}, flash).size, size);
}
for (const size of ['512x512','4096x4096','10000x100','0x2048']) {
  assert.equal(sanitize({size}, flash).size, 'auto');
}
assert.equal(sanitize({output_format:'png'}, flash).output_format, 'png');
assert.ok(!('output_format' in sanitize({output_format:'webp'}, flash)));
assert.equal(sanitize({prompt:'text only'}, flash).image_urls, undefined);
assert.equal(sanitize({optimize_prompt_options:{mode:'fast'}}, flash).optimize_prompt_options, undefined);
assert.equal(sanitize({optimize_prompt_options:'fast'}, 'seedream-4.0').optimize_prompt_options, 'fast');
for (const id of ['gpt-image-2.5-flare','gpt-image-2.5-sunburst']) {
  for (const mask of ['https://example.com/mask.png','data:image/png;base64,aGVsbG8=']) {
    assert.equal(sanitize({mask_url:mask,image_urls:[references[0]]}, id).mask_url, mask);
    assert.ok(!('mask_url' in sanitize({mask_url:mask}, id)), 'Mask requires an input image');
    assert.ok(!('mask_url' in sanitize({mask_url:mask,image_urls:[]}, id)));
  }
}

const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/static/app.js'), 'utf8');
function sourceFunction(name) {
  const start = renderer.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'Missing ' + name);
  const firstLine = renderer.slice(start, renderer.indexOf('\n', start)).trimEnd();
  if (firstLine.endsWith('}')) return firstLine;
  return renderer.slice(start, renderer.indexOf('\n}', start) + 2);
}
const catalog = createFallbackPricingCatalog();
const context = vm.createContext({
  resolvePricingEntry: id => {
    const key = APP_IMAGE_PRICE_MODEL_MAP[id] || id;
    return {priceModelId:key, entry:catalog.models[key]};
  }
});
vm.runInContext(['imageModelKey','isGptImage25ExtModel','resolveImagePricingEntry',
  'normalizePricingSpec','resolutionToMegapixelSpec','resolveImagePricingVariant'].map(sourceFunction).join('\n'), context);
for (const id of ['gpt-image-2.5-ext','gpt-image-2.5-ext-sunburst']) {
  const entry = context.resolveImagePricingEntry(id).entry;
  assert.equal(entry.variants.length, 3);
  assert.equal(context.resolveImagePricingVariant(entry, '1K', 'auto').credits, 0.085);
  assert.equal(context.resolveImagePricingVariant(entry, '2K', 'auto').credits, 0.14);
  assert.equal(context.resolveImagePricingVariant(entry, '4K', 'auto').credits, 0.21);
}
assert.equal(catalog.models['gpt-image-2.5-ext'].variants.length, 6, 'Filtering must not mutate the catalog');
console.log('[verify-apimart-model-contracts] Payloads, aliases, media constraints and version pricing passed.');
