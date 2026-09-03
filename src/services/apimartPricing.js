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
  return parsed;
}

function createFallbackPricingCatalog(warning = '') {
  return {
    ok: true,
    source: 'fallback',
    source_url: APIMART_PRICING_URL,
    fetched_at: new Date().toISOString(),
    warning: String(warning || ''),
    model_aliases: { ...APP_IMAGE_PRICE_MODEL_MAP },
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
    model_aliases: { ...APP_IMAGE_PRICE_MODEL_MAP },
    models: mergePricingModels(liveModels)
  };
}

module.exports = {
  APIMART_PRICING_URL,
  APP_IMAGE_PRICE_MODEL_MAP,
  createFallbackPricingCatalog,
  createLivePricingCatalog,
  parseApimartPricingHtml
};
