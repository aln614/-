const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  APIMART_PRICING_URL,
  APP_IMAGE_PRICE_MODEL_MAP,
  APP_VIDEO_PRICE_MODEL_MAP,
  createFallbackPricingCatalog,
  createLivePricingCatalog,
  parseEmbeddedVideoPricing,
  parseApimartPricingHtml
} = require('../src/services/apimartPricing');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const fixture = `
  <h3><span title="demo-image">demo-image</span> 2 个价格档位</h3>
  <div>(demo-image-alias)</div>
  <table><tbody>
    <tr><th scope="row" title="默认">默认</th><td>0.25 Credits/张 ~$0.025/张</td></tr>
    <tr><th scope="row" title="2K">2K</th><td>0.5 Credits/张 ~$0.05/张</td></tr>
  </tbody></table>
  <h3><span title="token-image">token-image</span></h3>
  <table><tbody><tr><th scope="row" title="输出价格">输出价格</th><td>8 Credits/M Tokens</td></tr></tbody></table>
`;

const parsed = parseApimartPricingHtml(fixture);
assert.deepStrictEqual(parsed['demo-image'].aliases, ['demo-image-alias']);
assert.strictEqual(parsed['demo-image'].variants.length, 2);
assert.strictEqual(parsed['demo-image'].variants[0].spec, 'default');
assert.strictEqual(parsed['demo-image'].variants[1].credits, 0.5);
assert.strictEqual(parsed['token-image'].metered, true);

const embeddedVideoPayload = JSON.stringify({
  video:[
    {id:'video-per-second', specification:'second', billing_type:'per_second', fixed_prices:{unit:'usd_per_second', dimension:'resolution', items:[{key:'720P', after_discount:0.08}]}},
    {id:'video-per-call', specification:'times', fixed_prices:{unit:'usd_per_call', dimension:'resolution_duration', items:[{key:'1080P-6S', after_discount:0.3}]}}
  ]
});
const embeddedVideoFixture = `<script>self.__next_f.push([1,${JSON.stringify(embeddedVideoPayload)}])</script>`;
const parsedVideos = parseEmbeddedVideoPricing(embeddedVideoFixture);
assert.strictEqual(parsedVideos['video-per-second'].variants[0].credits, 0.8, 'USD per second must convert to APIMart Credits');
assert.strictEqual(parsedVideos['video-per-second'].variants[0].unit, '秒');
assert.strictEqual(parsedVideos['video-per-call'].variants[0].credits, 3);
assert.strictEqual(parseApimartPricingHtml(fixture + embeddedVideoFixture)['video-per-call'].category, 'video');

const live = createLivePricingCatalog(fixture + Object.keys(createFallbackPricingCatalog().models).slice(0, 16).map((id, index) => `
  <h3><span title="fixture-${index}">fixture-${index}</span></h3>
  <table><tbody><tr><th scope="row" title="默认">默认</th><td>${(index + 1) / 100} Credits/张</td></tr></tbody></table>`).join(''));
assert.strictEqual(live.source, 'live');
assert.ok(live.models['demo-image']);

const fallback = createFallbackPricingCatalog();
assert.strictEqual(APIMART_PRICING_URL, 'https://apimart.ai/zh/pricing');
assert.strictEqual(APP_IMAGE_PRICE_MODEL_MAP['gemini-3.1-flash-image-preview'], 'nano-banana-2-ext');
assert.strictEqual(APP_VIDEO_PRICE_MODEL_MAP['doubao-seedance-2.5'], 'seedance-2.5');
assert.strictEqual(APP_VIDEO_PRICE_MODEL_MAP['gemini-omni-1.1-flash-ext'], 'Omni-Flash-Ext');
assert.strictEqual(fallback.models['qwen-image-3.0-pro'].variants.find(row => row.spec === '2K').credits, 0.571432);
assert.strictEqual(fallback.models['gpt-image-2-official'].metered, true);
assert.strictEqual(fallback.models['Omni-Flash-Ext'].variants.find(row => row.spec === '1080P-VIDREF').credits, 0.8);
assert.strictEqual(fallback.models['MiniMax-H3-Max'].variants.find(row => row.spec === '768P').credits, 0.75);
assert.strictEqual(fallback.models['seedance-2.5'].variants.find(row => row.spec === '720P').unit, '秒');

const main = read('src/main.js');
const renderer = read('src/renderer/static/app.js');
const html = read('src/renderer/index.html');
const css = read('src/renderer/static/style.css');

assert.ok(main.includes("p === '/api/apimart/pricing'"), 'missing cached pricing route');
assert.ok(main.includes("p === '/api/apimart/pricing/refresh'"), 'missing live pricing refresh route');
assert.ok(main.includes('APIMART_PRICING_CACHE_TTL_MS'), 'missing pricing cache');
assert.ok(main.includes('windowsHide:true'), 'pricing network helper must not show a console window');
assert.ok(html.includes('id="modelUsageEstimateBtn"'), 'missing current-model usage badge');
assert.ok(html.includes('id="videoModelUsageEstimateBtn"'), 'missing current-video-model usage badge');
assert.ok(renderer.includes('user?.remain_credits'), 'estimate must use APIMart Credits rather than currency balance');
assert.ok(renderer.includes('Math.floor(credits / unitCost)'), 'estimate must round down to whole usable calls');
assert.ok(renderer.includes("text = '动态计费'"), 'token-metered models must not show a false fixed count');
assert.ok(renderer.includes('APIMART_MODEL_OPTIONS.forEach'), 'detail dialog must cover all image models offered by the app');
assert.ok(renderer.includes('allApimartVideoModels().forEach'), 'detail dialog must cover all video models offered by the app');
assert.ok(renderer.includes("add(`${res}-VIDREF`)"), 'Omni video editing must use the video-reference price tier');
assert.ok(renderer.includes("variant?.unit === '秒'"), 'per-second video prices must be multiplied by duration');
assert.ok(renderer.includes('selectedVideoDuration()'), 'video estimates must use the actual selected duration, not the slider index');
assert.ok(renderer.includes("$('#imageQuality')?.addEventListener('change', renderModelUsageEstimate)"), 'quality changes must update the estimate');
assert.ok(renderer.includes("$('#clarity')?.addEventListener('change'"), 'resolution changes must update the estimate');
assert.ok(css.includes('.model-usage-estimate'), 'missing estimate badge styling');
assert.ok(css.includes('.model-usage-list'), 'missing detail list styling');

console.log('Model usage estimate checks passed.');
