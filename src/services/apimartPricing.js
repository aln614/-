const APIMART_PRICING_URL = 'https://apimart.ai/zh/pricing';

// The application model ids do not always match the public pricing-card ids.
const APP_IMAGE_PRICE_MODEL_MAP = Object.freeze({
  'gemini-3.1-flash-image-preview': 'nano-banana-2-ext',
  'gemini-3.1-flash-image-preview-official': 'nano-banana-2',
  'gemini-3.1-flash-lite-image': 'nano-banana-2-lite',
  'gemini-3.1-flash-lite-image-ext': 'nano-banana-2-lite-ext',
  'gemini-3-pro-image-preview': 'nano-banana-pro-ext',
  'gemini-3-pro-image-preview-official': 'nano-banana-pro',
  'gemini-2.5-flash-image-preview': 'nano-banana-ext',
  'gemini-2.5-flash-image-preview-official': 'nano-banana',
  'gpt-image-2': 'gpt-image-2-ext',
  'seedream-4.0': 'seedance-4-0',
  'seedream-4.5': 'seedance-4-5',
  'flux-kontext-max': 'flux-kontext',
  'flux-2-flex': 'flux-2',
  'grok-imagine-1.5-apimart': 'grok-imagine-1.5-ext',
  'grok-imagine-1.5-edit-apimart': 'grok-imagine-1.5-edit-ext'
});

const APP_VIDEO_PRICE_MODEL_MAP = Object.freeze({
  'omni-flash-ext': 'Omni-Flash-Ext',
  'gemini-omni-1.1-flash-ext': 'Omni-Flash-Ext',
  'doubao-seedance-1-0-pro-fast': 'seedance-1-0-pro-fast',
  'doubao-seedance-1-0-pro-quality': 'seedance-1-0-pro-quality',
  'doubao-seedance-1-5-pro': 'seedance-1-5-pro',
  'doubao-seedance-2.0': 'seedance-2.0',
  'doubao-seedance-2.0-fast': 'seedance-2.0-fast',
  'doubao-seedance-2.0-mini': 'seedance-2.0-mini',
  'doubao-seedance-2.5': 'seedance-2.5'
});

const FIXED_IMAGE_PRICES = Object.freeze({
  'gpt-image-2-ext': [['default', 0.085], ['1K', 0.085], ['2K', 0.14], ['4K', 0.21]],
  'z-image-turbo': [['default', 0.1], ['prompt_extend', 0.2]],
  'nano-banana-ext': [['default', 0.125]],
  'nano-banana-2-lite-ext': [['default', 0.125]],
  'seedream-5-0-pro': [['default', 0.36], ['1K', 0.2925], ['1K-layer', 0.14625], ['2K', 0.585], ['2K-layer', 0.2925]],
  'nano-banana-2-ext': [['default', 0.15], ['0.5K', 0.15], ['1K', 0.15], ['2K', 0.2], ['4K', 0.25]],
  'grok-imagine-1.5-ext': [['default', 0.15]],
  'grok-imagine-1.5-edit-ext': [['default', 0.15]],
  'grok-imagine-2.0-ext': [['default', 0.15], ['region-edit', 0.15]],
  'grok-imagine-image': [['1K', 0.16], ['2K', 0.16]],
  'seedance-4-0': [['default', 0.195]],
  'qwen-image-2.0': [['default', 0.2]],
  'qwen-image-3.0': [['default', 0.205712], ['1K', 0.205712], ['2K', 0.205712]],
  'wan2.7-image': [['default', 0.216]],
  'flux-2-pro': [['1MP', 0.24], ['2MP', 0.36], ['3MP', 0.48], ['4MP', 0.6]],
  'seedance-4-5': [['default', 0.26]],
  'seedream-5-0-lite': [['default', 0.28]],
  'qwen-image-3.0-pro': [['default', 0.285712], ['1K', 0.285712], ['2K', 0.571432]],
  'nano-banana-pro-ext': [['default', 0.3], ['4K', 0.4]],
  'flux-kontext-pro': [['default', 0.32]],
  'grok-imagine-image-2.0': [['1K@low', 0.32], ['1K@medium', 0.48], ['2K@low', 0.48], ['2K@medium', 0.64]],
  'flux-2': [['1MP', 0.4], ['2MP', 0.8], ['3MP', 1.2], ['4MP', 1.6]],
  'grok-imagine-image-quality': [['1K', 0.4], ['2K', 0.56]],
  'imagen-4.0-apimart': [['default', 0.4]],
  'qwen-image-2.0-pro': [['default', 0.5]],
  'wan2.7-image-pro': [['default', 0.544]],
  'flux-2-max': [['default', 0.8], ['1MP', 0.56], ['2MP', 0.8], ['3MP', 1.04], ['4MP', 1.28]],
  'flux-kontext': [['default', 0.64]]
});

// APIMart public pricing snapshot. Live values are refreshed from the pricing
// page; this table keeps estimates available while the network is offline.
const FIXED_VIDEO_PRICES = Object.freeze({
  'MiniMax-H3': { unit:'秒', rows:[['default',0.9144],['2K',0.9144],['768P',0.5712]] },
  'MiniMax-H3-Max': { unit:'秒', rows:[['default',0.75],['768P',0.75],['480P',0.495]] },
  'MiniMax-Hailuo-02': { unit:'秒', rows:[['1080P',0.8],['512P',0.104],['768P',0.4]] },
  'MiniMax-Hailuo-2.3': { unit:'秒', rows:[['default',0.488],['1080P',0.72]] },
  'MiniMax-Hailuo-2.3-Fast': { unit:'秒', rows:[['default',0.248],['1080P',0.424]] },
  'sora-2': { unit:'秒', rows:[['default',0.8],['official-720P',0.8]] },
  'sora-2-pro': { unit:'秒', rows:[['default',6],['official-720P',2.4],['official-1024P',4],['official-1080P',5.6]] },
  'veo3.1-fast': { unit:'次', rows:[['default',1.4],['4K',6.4],['EXTEND-4K',6.4],['extend',1.4]] },
  'veo3.1-quality': { unit:'次', rows:[['default',10],['4K',15],['EXTEND-4K',15],['extend',10]] },
  'veo3.1-lite': { unit:'次', rows:[['default',0.7],['4K',5.7],['EXTEND-4K',5.7],['extend',0.7]] },
  'veo3.1-fast-official': { unit:'秒', rows:[['default',0.8],['720P',0.64],['720P-audio',0.8],['1080P',0.8],['1080P-audio',0.96],['4K',2],['4K-audio',2.4],['audio',0.96]] },
  'veo3.1-quality-official': { unit:'秒', rows:[['default',1.6],['720P',1.6],['1080P',1.6],['4K',3.2],['4K-audio',4.8],['audio',3.2]] },
  'flux-3-video': { unit:'秒', rows:[['default',1.36],['DRAFT',0.48],['HD',1.36],['FHD',2.32],['V2V-DRAFT',0.96],['V2V-HD',3.28],['V2V-FHD',4.24]] },
  'Omni-Flash-Ext': { unit:'次', rows:[['default',3.5],['360P-4S',1.5],['360P-6S',1.75],['360P-8S',2],['360P-10S',2.25],['360P-VIDREF',0.4],['720P-4S',2.5],['720P-6S',3],['720P-8S',3.5],['720P-10S',4],['720P-VIDREF',0.8],['1080P-4S',2.5],['1080P-6S',3],['1080P-8S',3.5],['1080P-10S',4],['1080P-VIDREF',0.8],['4K-4S',7.5],['4K-6S',8],['4K-8S',8.5],['4K-10S',9],['4K-VIDREF',2.4]] },
  'gemini-omni-flash-preview': { unit:'秒', rows:[['720P',0.88]] },
  'grok-imagine-1.5-video-apimart': { unit:'秒', rows:[['480P',0.102],['720P',0.1912]] },
  'grok-imagine-video': { unit:'秒', rows:[['default',0.4],['480P',0.4],['720P',0.56]] },
  'grok-imagine-video-1.5': { unit:'秒', rows:[['default',0.64],['480P',0.64],['720P',1.12],['1080P',2]] },
  'happyhorse-1.0': { unit:'秒', rows:[['default',2.3],['720P',1.3],['1080P',2.3],['edit-720P',1.3],['edit-1080P',2.3]] },
  'happyhorse-1.1': { unit:'秒', rows:[['default',1.72],['720P',1.3],['1080P',1.72]] },
  'kling-3.0-turbo': { unit:'秒', rows:[['720P',1.144],['1080P',1.432]] },
  'kling-v2-6': { unit:'秒', rows:[['default',0.368],['pro',0.625],['pro-sound',1.25],['pro-sound-voice',1.5]] },
  'kling-v2-6-motion-control': { unit:'秒', rows:[['default',0.5712],['pro',0.9144]] },
  'kling-v3': { unit:'秒', rows:[['default',0.672],['pro',0.896],['sound',1.008],['pro-sound',1.344],['4k',4.2856],['4k-sound',4.2856]] },
  'kling-v3-motion-control': { unit:'秒', rows:[['default',1.0288],['pro',1.3712]] },
  'kling-v3-omni': { unit:'秒', rows:[['default',0.672],['pro',0.896],['sound',0.896],['pro-sound',1.12],['video',1.008],['pro-video',1.344],['4k',4.2856],['4k-sound',4.2856]] },
  'kling-video-o1': { unit:'秒', rows:[['default',0.672],['pro',0.896],['video',1.008],['pro-video',1.344]] },
  'pixverse-v6': { unit:'秒', rows:[['default',0.24],['360P',0.16],['360P-audio',0.24],['540P',0.24],['540P-audio',0.32],['720P',0.32],['720P-audio',0.4],['1080P',0.64],['1080P-audio',0.8]] },
  'seedance-1-0-pro-fast': { unit:'秒', rows:[['480P',0.088],['720P',0.2],['1080P',0.416]] },
  'seedance-1-0-pro-quality': { unit:'秒', rows:[['480P',0.204],['720P',0.44],['1080P',1.04]] },
  'seedance-1-5-pro': { unit:'秒', rows:[['480P',0.204],['720P',0.44],['1080P',1.08]] },
  'seedance-2.0': { unit:'秒', rows:[['480P',0.66],['480P-input',0.4],['720P',1.42],['720P-input',0.8584],['1080P',3.544],['1080P-input',2.1568],['4K',7.22],['4K-input',4.4432]] },
  'seedance-2.0-fast': { unit:'秒', rows:[['480P',0.3984],['480P-input',0.2368],['720P',0.856],['720P-input',0.5128]] },
  'seedance-2.0-mini': { unit:'秒', rows:[['480P',0.1056],['480P-input',0.064],['720P',0.2288],['720P-input',0.1384]] },
  'seedance-2.5': { unit:'秒', rows:[['default',2.16],['480P',0.9608],['480P-input',0.576],['720P',2.16],['720P-input',1.296],['1080P',3.8488],['1080P-input',2.2992]] },
  'skyreels-v4-fast': { unit:'秒', rows:[['480P',0.64],['480P-refvideo',1.2],['720P',0.88],['720P-refvideo',1.6],['1080P',2.2],['1080P-refvideo',4]] },
  'skyreels-v4-std': { unit:'秒', rows:[['480P',0.88],['480P-refvideo',1.44],['720P',1.12],['720P-refvideo',2],['1080P',2.8],['1080P-refvideo',5]] },
  'viduq3': { unit:'秒', rows:[['default',0.8],['540P',0.4],['720P',0.8],['1080P',1]] },
  'viduq3-mix': { unit:'秒', rows:[['default',1],['720P',1],['1080P',1.2]] },
  'viduq3-pro': { unit:'秒', rows:[['540P',0.56],['720P',1.2],['1080P',1.28]] },
  'viduq3-turbo': { unit:'秒', rows:[['540P',0.32],['720P',0.48],['1080P',0.56]] },
  'wan2.5-preview': { unit:'秒', rows:[['480P',0.336],['720P',0.664],['1080P',1.096]] },
  'wan2.6': { unit:'秒', rows:[['default',0.5],['1080P',0.84]] },
  'wan2.6-i2v-flash': { unit:'秒', rows:[['720P',0.168],['720P-audio',0.336],['1080P',0.28],['1080P-audio',0.552]] },
  'wan2.7': { unit:'秒', rows:[['default',0.664],['1080P',1.096]] },
  'wan2.7-r2v': { unit:'秒', rows:[['default',0.664],['1080P',1.096]] },
  'wan2.7-videoedit': { unit:'秒', rows:[['default',0.664],['1080P',1.096]] },
  'wan3.0-video': { unit:'秒', rows:[['default',1.37144],['480P',0.34288],['720P',0.68568],['1080P',1.37144]] }
});

const TOKEN_METERED_IMAGE_MODELS = Object.freeze([
  'nano-banana-2-lite',
  'nano-banana',
  'nano-banana-2',
  'gpt-image-1-official',
  'gpt-image-1.5-official',
  'gpt-image-2-official',
  'nano-banana-pro'
]);

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code) || 0));
}

function stripHtml(value = '') {
  return decodeHtml(String(value || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSpec(value = '') {
  const spec = stripHtml(value).replace(/^默认$/i, 'default').trim();
  return spec || 'default';
}

function makeFixedModel(id, rows, aliases = []) {
  return {
    id,
    aliases: Array.from(new Set((aliases || []).filter(Boolean))),
    metered: false,
    note: '',
    variants: (rows || []).map(([spec, credits, unit = '张']) => ({ spec:String(spec), credits:Number(credits), unit:String(unit) }))
  };
}

function fallbackModels() {
  const models = {};
  Object.entries(FIXED_IMAGE_PRICES).forEach(([id, rows]) => { models[id] = makeFixedModel(id, rows); });
  Object.entries(FIXED_VIDEO_PRICES).forEach(([id, value]) => {
    models[id] = makeFixedModel(id, (value.rows || []).map(([spec, credits]) => [spec, credits, value.unit || '秒']));
    models[id].category = 'video';
  });
  TOKEN_METERED_IMAGE_MODELS.forEach(id => {
    models[id] = { id, aliases:[], metered:true, note:'按实际 Token 用量结算，无法给出固定次数', variants:[] };
  });
  return models;
}

function mergePricingModels(liveModels = {}) {
  const merged = fallbackModels();
  Object.entries(liveModels || {}).forEach(([id, value]) => {
    if (!id || !value || typeof value !== 'object') return;
    const current = merged[id] || { id, aliases:[], variants:[], metered:false, note:'' };
    const variants = Array.isArray(value.variants) && value.variants.length ? value.variants : current.variants;
    merged[id] = {
      ...current,
      ...value,
      id,
      aliases: Array.from(new Set([...(current.aliases || []), ...(value.aliases || [])])),
      variants
    };
  });
  return merged;
}

function parseApimartPricingHtml(html = '') {
  const source = String(html || '');
  const headings = [];
  const h3Pattern = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
  let headingMatch;
  while ((headingMatch = h3Pattern.exec(source))) {
    const block = headingMatch[0];
    const titled = Array.from(block.matchAll(/\btitle=(?:"([^"]+)"|'([^']+)')/gi))
      .map(match => stripHtml(match[1] || match[2] || ''))
      .filter(Boolean);
    let id = titled.find(value => /^[a-z0-9][a-z0-9._-]*$/i.test(value)) || '';
    if (!id) {
      const text = stripHtml(headingMatch[1]).replace(/\s+\d+\s*个价格档位.*$/i, '').trim();
      const candidates = text.match(/[a-z0-9][a-z0-9._-]{2,}/ig) || [];
      id = candidates[candidates.length - 1] || '';
    }
    if (id) headings.push({ id, start:headingMatch.index, contentEnd:h3Pattern.lastIndex });
  }

  const parsed = {};
  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.start || source.length;
    const section = source.slice(heading.contentEnd, end);
    const beforeTable = section.split(/<table\b/i, 1)[0] || '';
    const aliasMatch = beforeTable.match(/<div\b[^>]*>\s*\(\s*([^<()]+)\s*\)\s*<\/div>/i);
    const aliases = aliasMatch ? [stripHtml(aliasMatch[1])] : [];
    const tbodyMatch = section.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
    const rows = [];
    if (tbodyMatch) {
      const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let rowMatch;
      while ((rowMatch = rowPattern.exec(tbodyMatch[1]))) {
        const row = rowMatch[1];
        const specCell = row.match(/<(?:th|td)\b([^>]*)\bscope=(?:"row"|'row')([^>]*)>([\s\S]*?)<\/(?:th|td)>/i);
        if (!specCell) continue;
        const attrs = `${specCell[1] || ''} ${specCell[2] || ''}`;
        const titleMatch = attrs.match(/\btitle=(?:"([^"]+)"|'([^']+)')/i);
        const spec = normalizeSpec(titleMatch?.[1] || titleMatch?.[2] || specCell[3]);
        const rest = row.slice((specCell.index || 0) + specCell[0].length);
        const priceCell = rest.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
        if (!priceCell) continue;
        const priceText = stripHtml(priceCell[1]);
        const priceMatch = priceText.match(/([0-9]+(?:\.[0-9]+)?)\s*Credits\s*\/\s*(张|次)/i);
        if (!priceMatch) continue;
        const credits = Number(priceMatch[1]);
        if (Number.isFinite(credits) && credits > 0) rows.push({ spec, credits, unit:priceMatch[2] });
      }
    }
    const sectionText = stripHtml(section);
    const metered = rows.length === 0 && /(?:按实际\s*Token|Tokens?|输入价格|输出价格)/i.test(sectionText);
    parsed[heading.id] = {
      id: heading.id,
      aliases,
      metered,
      note: metered ? '按实际 Token 用量结算，无法给出固定次数' : '',
      variants: rows
    };
  });
  return { ...parsed, ...parseEmbeddedVideoPricing(source) };
}

function decodeNextFlightChunks(source = '') {
  const decoded = [];
  const pattern = /self\.__next_f\.push\(\[1,"((?:\\.|[^"])*)"\]\)/g;
  let match;
  while ((match = pattern.exec(String(source || '')))) {
    try { decoded.push(JSON.parse(`"${match[1]}"`)); } catch {}
  }
  return decoded.join('');
}

function extractJsonArrayAfterKey(source = '', key = '') {
  const marker = `"${key}":`;
  const markerIndex = String(source || '').indexOf(marker);
  if (markerIndex < 0) return [];
  const start = source.indexOf('[', markerIndex + marker.length);
  if (start < 0) return [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '[') depth += 1;
    else if (char === ']' && --depth === 0) {
      try { return JSON.parse(source.slice(start, index + 1)); } catch { return []; }
    }
  }
  return [];
}

function pricingUnitFromUsd(unit = '') {
  if (unit === 'usd_per_second') return '秒';
  if (unit === 'usd_per_image') return '张';
  return '次';
}

function parseEmbeddedVideoPricing(html = '') {
  const flightData = decodeNextFlightChunks(html);
  const videoModels = extractJsonArrayAfterKey(flightData, 'video');
  const parsed = {};
  videoModels.forEach(item => {
    const id = String(item?.id || '').trim();
    const fixed = item?.fixed_prices || {};
    if (!id || !Array.isArray(fixed.items)) return;
    const unit = pricingUnitFromUsd(fixed.unit);
    const variants = fixed.items.map(row => {
      const usd = Number(row?.after_discount);
      if (!Number.isFinite(usd) || usd <= 0) return null;
      return {
        spec: normalizeSpec(row?.key || 'default'),
        // The page payload stores USD; one USD equals ten APIMart Credits.
        credits: Number((usd * 10).toFixed(8)),
        unit
      };
    }).filter(Boolean);
    if (!variants.length) return;
    parsed[id] = {
      id,
      aliases: [item?.alias].filter(Boolean),
      category: 'video',
      metered: false,
      note: '',
      billing_type: String(item?.billing_type || item?.specification || ''),
      dimension: String(fixed.dimension || ''),
      variants
    };
  });
  return parsed;
}

function createFallbackPricingCatalog(warning = '') {
  return {
    ok: true,
    source: 'fallback',
    source_url: APIMART_PRICING_URL,
    fetched_at: new Date().toISOString(),
    warning: String(warning || ''),
    model_aliases: { ...APP_IMAGE_PRICE_MODEL_MAP, ...APP_VIDEO_PRICE_MODEL_MAP },
    models: fallbackModels()
  };
}

function createLivePricingCatalog(html = '') {
  const liveModels = parseApimartPricingHtml(html);
  const pricedCount = Object.values(liveModels).filter(model => Array.isArray(model.variants) && model.variants.length).length;
  if (pricedCount < 15) throw new Error(`APIMart 价格页解析结果异常，仅识别到 ${pricedCount} 个固定计价模型`);
  return {
    ok: true,
    source: 'live',
    source_url: APIMART_PRICING_URL,
    fetched_at: new Date().toISOString(),
    warning: '',
    model_aliases: { ...APP_IMAGE_PRICE_MODEL_MAP, ...APP_VIDEO_PRICE_MODEL_MAP },
    models: mergePricingModels(liveModels)
  };
}

module.exports = {
  APIMART_PRICING_URL,
  APP_IMAGE_PRICE_MODEL_MAP,
  APP_VIDEO_PRICE_MODEL_MAP,
  createFallbackPricingCatalog,
  createLivePricingCatalog,
  parseEmbeddedVideoPricing,
  parseApimartPricingHtml
};
