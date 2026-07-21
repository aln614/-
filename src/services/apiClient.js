const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { downloadToFile } = require('./cache');

function cleanBase(base) { return String(base || '').replace(/\/+$/, ''); }
const AUTO_PROXY_CANDIDATES = [
  'http://127.0.0.1:10808', // v2rayN 常见 HTTP/Mixed 端口；已验证可访问 APIMart
  'http://127.0.0.1:10809',
  'http://127.0.0.1:7890',
  'http://127.0.0.1:7897',
  'http://127.0.0.1:20171',
  'http://127.0.0.1:2080',
  'socks5h://127.0.0.1:10808',
  'socks5h://127.0.0.1:7891'
];
function normalizeProxyUrl(v='') {
  let s = String(v || '').trim();
  if (!s || /^auto$/i.test(s)) return '';
  if (/^https?:\/\//i.test(s) || /^socks5h?:\/\//i.test(s)) return s;
  if (/^(127\.0\.0\.1|localhost|\d+\.\d+\.\d+\.\d+):\d+$/i.test(s)) return 'http://' + s;
  if (/^\d+$/.test(s)) return 'http://127.0.0.1:' + s;
  return s;
}
let lastGoodApimartProxy = '';
function markGoodProxy(proxy='') {
  const p = normalizeProxyUrl(proxy);
  if (p) lastGoodApimartProxy = p;
}
function getProxyCandidates(explicit='') {
  const out = [];
  const add = (v) => {
    const x = normalizeProxyUrl(v);
    if (x && !out.includes(x)) out.push(x);
  };
  // 优先复用上一次已经跑通的代理，避免每次都从错误端口重新试。
  add(lastGoodApimartProxy);
  add(explicit);
  add(process.env.APIMART_PROXY_URL);
  add(process.env.HTTPS_PROXY);
  add(process.env.HTTP_PROXY);
  for (const c of AUTO_PROXY_CANDIDATES) add(c);
  return out;
}
function getProxyUrl(explicit='') { return getProxyCandidates(explicit)[0] || ''; }
function isApimartUrl(url='') { return /api\.apimart\.ai/i.test(String(url || '')); }
function runProcessAsync(exe, args, opts = {}, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide:true, ...opts });
    let stdout = '', stderr = '';
    let settled = false;
    const timeoutMs = Number(opts.timeoutMs || 0);
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`${exe} 请求超时 ${Math.ceil(timeoutMs/1000)}s`));
    }, timeoutMs) : null;
    child.stdout?.on('data', d => stdout += d.toString('utf8'));
    child.stderr?.on('data', d => stderr += d.toString('utf8'));
    child.on('error', e => { if (settled) return; settled = true; if (timer) clearTimeout(timer); reject(e); });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    if (input !== undefined && input !== null && input !== '') child.stdin.end(input);
    else child.stdin.end();
  });
}
// V11.8：图片生成模式恢复 V9.8 逻辑，不再对 GRS 图片接口做单次网络请求 30000ms 强制中断。
// 单任务累计超时仍由 taskQueue 按任务创建时间统计；轮询间隔只控制结果查询节奏。
async function fetchNoSingleTimeout(url, options = {}) {
  return fetch(url, options);
}
function describeNetworkError(err, targetUrl = '') {
  const cause = err && (err.cause || err);
  const code = cause && (cause.code || cause.name || '');
  const msg = cause && (cause.message || err.message) || String(err || 'unknown');
  const host = (()=>{ try { return new URL(targetUrl).host; } catch { return targetUrl || ''; } })();
  return `网络连接失败：无法访问 ${host || 'API'}。底层原因：${code ? code + ' ' : ''}${msg}${/ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(String(code+' '+msg)) ? '。这通常是 DNS/网络/代理/防火墙问题，不是接口参数错误。' : ''}`;
}

function parseJsonText(text){
  const raw = String(text || '').trim();
  if(!raw) return {};
  try { return JSON.parse(raw); } catch { return { raw }; }
}
function hasUsefulApiResponse(data){
  if(!data || typeof data !== 'object') return false;
  if(pickTaskId(data) || pickResultUrl(data) || pickBase64(data)) return true;
  if(data.code !== undefined || data.status_code !== undefined || data.error || data.message || data.msg || data.raw) return true;
  if(data.data && (Array.isArray(data.data) ? data.data.length : Object.keys(data.data || {}).length)) return true;
  return Object.keys(data).length > 0;
}
function compactJson(data, maxLen = 1000){
  try { return JSON.stringify(data).slice(0, maxLen); }
  catch { return String(data).slice(0, maxLen); }
}
function extractApimartErrorMessage(data){
  const seen = new Set();
  const candidates = [];
  const add = (v) => { if (v !== undefined && v !== null && String(v).trim()) candidates.push(String(v)); };
  const walk = (x) => {
    if (!x || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    add(x.message); add(x.msg); add(x.detail); add(x.reason); add(x.error_description);
    if (typeof x.error === 'string') add(x.error);
    else walk(x.error);
    if (Array.isArray(x.errors)) x.errors.forEach(walk);
    if (x.data && x.data !== x) walk(x.data);
  };
  walk(data);
  return candidates[0] || compactJson(data, 600) || 'unknown_error';
}
function assertApimartCode200(data, context = 'APIMart'){
  const code = data && (data.code ?? data.status_code);
  if (code !== undefined && code !== null && Number(code) !== 200) {
    throw new Error(`${context} 返回错误：${extractApimartErrorMessage(data)}；实际响应：${compactJson(data, 1000)}`);
  }
  return data;
}

async function curlDownloadToFile(targetUrl, outputPath, proxyUrl = '') {
  const proxy = normalizeProxyUrl(proxyUrl);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = ['-sS','-L','--connect-timeout','4','--max-time','420'];
  if (proxy) args.push('--proxy', proxy);
  args.push('-o', outputPath, targetUrl);
  const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const r = await runProcessAsync(exe, args, { timeoutMs: 425000 });
  if (r.status !== 0) throw new Error(`curl 下载失败${proxy ? '（代理 '+proxy+'）' : ''}：${(r.stderr || r.stdout || '').slice(0,800)}`);
  const st = fs.existsSync(outputPath) ? fs.statSync(outputPath) : { size: 0 };
  if (!st.size) throw new Error('curl 下载失败：文件为空');
  markGoodProxy(proxy);
  return outputPath;
}
async function downloadResultToFile(targetUrl, outputPath, proxyUrl = '') {
  const errors = [];
  // 用户电脑直连经常失败，先走已验证的代理候选下载远端结果。
  for (const proxy of getProxyCandidates(proxyUrl)) {
    try { return await curlDownloadToFile(targetUrl, outputPath, proxy); }
    catch (e) { errors.push(`[${proxy}] ${e.message || e}`); }
  }
  try { return await downloadToFile(targetUrl, outputPath); }
  catch (e) {
    errors.push(`直连下载失败：${e.message || e}`);
    throw new Error('远端结果已生成，但下载到本地失败：' + errors.join(' | '));
  }
}
async function curlRequestJson(targetUrl, apiKey, payload = null, method = 'GET', proxyUrl = ''){
  const proxy = normalizeProxyUrl(proxyUrl);
  const args = ['-sS','-L','--connect-timeout','4','--max-time','90'];
  if (proxy) args.push('--proxy', proxy);
  args.push('-X', method.toUpperCase(), targetUrl, '-H','Accept: application/json', '-H', `Authorization: Bearer ${apiKey || ''}`);
  let input = '';
  if(payload){
    args.push('-H','Content-Type: application/json','--data-binary', '@-');
    input = JSON.stringify(payload || {});
  }
  const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const r = await runProcessAsync(exe, args, { timeoutMs: 95000 }, input);
  if(r.status !== 0) throw new Error(`curl.exe 请求失败${proxy ? '（代理 '+proxy+'）' : ''}：${(r.stderr || r.stdout || '').slice(0,800)}`);
  const data = parseJsonText(r.stdout);
  if (hasUsefulApiResponse(data)) markGoodProxy(proxy);
  return data;
}
function nodeRequestJson(targetUrl, apiKey, payload = null, method = 'GET') {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(new Error('无效 API 地址：' + targetUrl)); }
    const lib = u.protocol === 'http:' ? http : https;
    const body = payload ? JSON.stringify(payload) : '';
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers: {
        ...(body ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} : {}),
        'Accept':'application/json',
        'User-Agent':'LocalApiImageGenerator/14.5.6',
        'Authorization': apiKey ? `Bearer ${apiKey}` : ''
      },
      timeout: 15000
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data; try { data = JSON.parse(text); } catch { data = { raw:text }; }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0,600)}`));
        resolve(data);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('网络请求超时 15000ms')); });
    req.on('error', e => reject(new Error(describeNetworkError(e, targetUrl))));
    if (body) req.write(body);
    req.end();
  });
}


function powershellRequestJson(targetUrl, apiKey, payload = null, method = 'GET', proxyUrl = '') {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('PowerShell 兜底请求只支持 Windows'));
    const payloadB64 = Buffer.from(JSON.stringify(payload || {}), 'utf8').toString('base64');
    const urlB64 = Buffer.from(String(targetUrl || ''), 'utf8').toString('base64');
    const keyB64 = Buffer.from(String(apiKey || ''), 'utf8').toString('base64');
    const methodSafe = String(method || 'GET').toUpperCase().replace(/[^A-Z]/g,'') || 'GET';
    const proxyB64 = Buffer.from(getProxyUrl(proxyUrl), 'utf8').toString('base64');
    const ps = `
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${urlB64}'))
$key = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${keyB64}'))
$headers = @{ 'Accept'='application/json'; 'User-Agent'='LocalApiImageGenerator/14.5.6' }
$proxy = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${proxyB64}'))
$common = @{ Uri=$url; Headers=$headers; TimeoutSec=120 }
if ($proxy -ne '') { $common['Proxy'] = $proxy }
if ($key -ne '') { $headers['Authorization'] = 'Bearer ' + $key }
try {
  if ('${methodSafe}' -eq 'POST') {
    $body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadB64}'))
    $common['Method']='Post'; $common['ContentType']='application/json'; $common['Body']=$body; $r = Invoke-RestMethod @common
  } else {
    $common['Method']='Get'; $r = Invoke-RestMethod @common
  }
  $r | ConvertTo-Json -Depth 30 -Compress
} catch {
  Write-Error $_.Exception.Message
  exit 2
}`;
    const child = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command','-'], {windowsHide:true});
    let out='', err='';
    const timer = setTimeout(()=>{ try{child.kill();}catch{}; reject(new Error('PowerShell 系统代理兜底请求超时')); }, 130000);
    child.stdout.on('data', d=> out += d.toString('utf8'));
    child.stderr.on('data', d=> err += d.toString('utf8'));
    child.on('error', e=>{ clearTimeout(timer); reject(e); });
    child.on('close', code=>{
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('PowerShell 系统代理兜底也失败：' + (err || out || `exit ${code}`).slice(0,800)));
      resolve(parseJsonText(out));
    });
    child.stdin.end(ps);
  });
}
async function jsonRequestWithFallback(url, apiKey, payload = null, method = 'GET', proxyUrl = '') {
  const errors = [];
  const proxies = getProxyCandidates(proxyUrl);

  // 1) 有代理候选时优先走轻量 curl 代理；PowerShell 只作为最后代理兜底，避免大量轮询时频繁启动 PowerShell 导致卡顿。
  for (const proxy of proxies) {
    errors.push('尝试 APIMart 代理：' + proxy);
    try { const data = await curlRequestJson(url, apiKey, payload, method, proxy); if (hasUsefulApiResponse(data)) { markGoodProxy(proxy); return data; } errors.push('curl代理返回空响应：' + JSON.stringify(data)); } catch(e){ errors.push('curl代理失败['+proxy+']：' + (e.message || e)); }
  }
  for (const proxy of proxies.slice(0, 2)) {
    try { const data = await powershellRequestJson(url, apiKey, payload, method, proxy); if (hasUsefulApiResponse(data)) { markGoodProxy(proxy); return data; } errors.push('PowerShell代理返回空响应：' + JSON.stringify(data)); } catch(e){ errors.push('PowerShell代理失败['+proxy+']：' + (e.message || e)); }
  }

  // 2) 代理都失败后再直连兜底。
  try {
    const data = await nodeRequestJson(url, apiKey, payload, method);
    if (hasUsefulApiResponse(data)) return data;
    errors.push('node https 返回空响应：' + JSON.stringify(data));
  } catch (e) { errors.push('node https 失败：' + (e.message || e)); }
  try {
    const data = await powershellRequestJson(url, apiKey, payload, method, '');
    if (hasUsefulApiResponse(data)) return data;
    errors.push('PowerShell直连返回空响应：' + JSON.stringify(data));
  } catch (e) { errors.push('PowerShell直连失败：' + (e.message || e)); }
  try {
    const data = await curlRequestJson(url, apiKey, payload, method, '');
    if (hasUsefulApiResponse(data)) return data;
    errors.push('curl.exe直连返回空响应：' + JSON.stringify(data));
  } catch (e) { errors.push('curl.exe直连失败：' + (e.message || e)); }
  throw new Error('APIMart 请求失败或响应为空。' + errors.join(' | '));
}
const APIMART_IMAGE_MODELS = [
  'gemini-3.1-flash-image-preview','gemini-3.1-flash-image-preview-official',
  'gemini-3-pro-image-preview','gemini-3-pro-image-preview-official',
  'gemini-2.5-flash-image-preview','gemini-2.5-flash-image-preview-official',
  'imagen-4.0-apimart',
  'gpt-image-1-official','gpt-image-1.5-official','gpt-image-2','gpt-image-2-official',
  'seedream-4.0','seedream-4.5','seedream-5.0-lite','seedream-5.0-pro',
  'doubao-seedance-4-0','doubao-seedream-4.0','doubao-seedream-4-0',
  'doubao-seedream-5-0-lite','doubao-seedream-5.0-lite',
  'doubao-seedream-5-0-pro','doubao-seedream-5.0-pro',
  'qwen-image','qwen-image-2.0','z-image-turbo',
  'grok-imagine-1.0','grok-imagine-1.0-edit',
  'grok-imagine-1.5-apimart','grok-imagine-1.0-edit-apimart','grok-imagine-1.5-edit-apimart',
  'wan2.7-image','wan2.7-image-pro'
];
const APIMART_RATIO_SET = new Set(['auto','1:1','3:2','2:3','4:3','3:4','16:9','9:16','5:4','4:5','21:9','9:21','1:4','4:1','1:8','8:1','2:1','1:2','3:1','1:3']);

// V14.4.6: APIMart 模型规则表。不要把所有图片模型都套同一套参数，按模型能力过滤/归一化。
const SEEDREAM4_RULE = {
  endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 999,
  nMin: 1, nMax: 15, defaultN: 1,
  sizes: ['1:1','4:3','3:4','16:9','9:16','3:2','2:3','21:9','9:21','auto'], defaultSize: '1:1', autoRequiresImage: true,
  resolutions: ['1k','2k','4k'], defaultResolution: '2k',
  allowOptimizePrompt: true, optimizePromptOptions: ['standard','fast'], defaultOptimizePrompt: 'standard',
  allowSequential: true, allowWatermark: true
};
const SEEDREAM5_LITE_RULE = {
  endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 999,
  nMin: 1, nMax: 15, defaultN: 1,
  sizes: ['1:1','4:3','3:4','16:9','9:16','3:2','2:3','21:9','auto'], defaultSize: '1:1', autoRequiresImage: true,
  resolutions: ['2k','3k','4k'], defaultResolution: '2k',
  outputFormats: ['jpeg','png'], defaultOutputFormat: 'jpeg', allowOutputFormat: true,
  allowSequential: true, allowWatermark: true
};
const SEEDREAM5_PRO_RULE = {
  endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 10,
  nMin: 1, nMax: 1, defaultN: 1,
  sizes: ['1:1','4:3','3:4','16:9','9:16','3:2','2:3','21:9','auto'], defaultSize: '1:1', noCustomSize: true,
  resolutions: ['1K','2K'], defaultResolution: '2K',
  outputFormats: ['jpeg','png'], defaultOutputFormat: 'jpeg', allowOutputFormat: true,
  allowWatermark: true
};
const GROK_IMAGINE_15_RULE = {
  endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 0,
  nMin: 1, nMax: 10, defaultN: 1,
  sizes: ['1:1','16:9','9:16','3:2','2:3'], defaultSize: '1:1',
  noResolution: true
};
const GROK_IMAGINE_EDIT_RULE = {
  endpoint: '/v1/images/edits', taskQuery: 'batch', maxImageUrls: 999,
  nMin: 1, nMax: 10, defaultN: 1,
  noSize: true, noResolution: true
};
const APIMART_MODEL_RULES = {
  'gpt-image-2': {
    endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 16,
    nMin: 1, nMax: 1, defaultN: 1,
    resolutions: ['1k','2k','4k'], defaultResolution: '1k',
    allowQuality: false, allowMask: false, allowOutputFormat: false, allowBackground: false
  },
  'gpt-image-2-official': {
    endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 16,
    nMin: 1, nMax: 4, defaultN: 1,
    resolutions: ['1k','2k','4k'], defaultResolution: '1k',
    sizes: ['auto','1:1','3:2','2:3','4:3','3:4','5:4','4:5','16:9','9:16','2:1','1:2','3:1','1:3','21:9','9:21'],
    qualities: ['auto','low','medium','high'], defaultQuality: 'auto',
    backgrounds: ['auto','opaque','transparent'], moderations: ['auto','low'], outputFormats: ['png','jpeg','webp'],
    allowQuality: true, allowMask: true, allowOutputFormat: true, allowBackground: true, allowModeration: true
  },
  'gpt-image-1-official': { endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 16, nMin: 1, nMax: 4, defaultN: 1, resolutions: ['1k','2k','4k'], defaultResolution: '1k', qualities: ['auto','low','medium','high'], backgrounds: ['auto','opaque','transparent'], moderations: ['auto','low'], outputFormats: ['png','jpeg','webp'], allowQuality: true, allowMask: true, allowOutputFormat: true, allowBackground: true, allowModeration: true },
  'gpt-image-1.5-official': { endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 16, nMin: 1, nMax: 4, defaultN: 1, resolutions: ['1k','2k','4k'], defaultResolution: '1k', qualities: ['auto','low','medium','high'], backgrounds: ['auto','opaque','transparent'], moderations: ['auto','low'], outputFormats: ['png','jpeg','webp'], allowQuality: true, allowMask: true, allowOutputFormat: true, allowBackground: true, allowModeration: true },
  'imagen-4.0-apimart': { endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 0, nMin: 1, nMax: 1, defaultN: 1, resolutions: ['1k','2k','4k'], defaultResolution: '1k', textOnly: true },
  'seedream-4.0': SEEDREAM4_RULE,
  'doubao-seedance-4-0': SEEDREAM4_RULE,
  'doubao-seedream-4.0': SEEDREAM4_RULE,
  'doubao-seedream-4-0': SEEDREAM4_RULE,
  'seedream-4.5': { endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 999, nMin: 1, nMax: 15, defaultN: 1, sizes: ['auto','1:1','3:2','2:3','4:3','3:4','16:9','9:16','21:9','9:21'], defaultSize: '1:1', resolutions: ['1k','2k','4k'], defaultResolution: '2k' },
  'seedream-5.0-lite': SEEDREAM5_LITE_RULE,
  'doubao-seedream-5-0-lite': SEEDREAM5_LITE_RULE,
  'doubao-seedream-5.0-lite': SEEDREAM5_LITE_RULE,
  'seedream-5.0-pro': SEEDREAM5_PRO_RULE,
  'doubao-seedream-5-0-pro': SEEDREAM5_PRO_RULE,
  'doubao-seedream-5.0-pro': SEEDREAM5_PRO_RULE,
  'grok-imagine-1.0': GROK_IMAGINE_15_RULE,
  'grok-imagine-1.5-apimart': GROK_IMAGINE_15_RULE,
  'grok-imagine-1.0-edit': GROK_IMAGINE_EDIT_RULE,
  'grok-imagine-1.0-edit-apimart': GROK_IMAGINE_EDIT_RULE,
  'grok-imagine-1.5-edit-apimart': GROK_IMAGINE_EDIT_RULE,
  'z-image-turbo': { endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 0, nMin: 1, nMax: 1, defaultN: 1, noResolution: true, noSize: true, textOnly: true }
};
const DEFAULT_APIMART_IMAGE_RULE = { endpoint: '/v1/images/generations', taskQuery: 'batch', maxImageUrls: 16, nMin: 1, nMax: 1, defaultN: 1, resolutions: ['1k','2k','4k'], defaultResolution: '1k' };
function getApimartImageRule(model='') {
  return APIMART_MODEL_RULES[String(model || '').toLowerCase()] || DEFAULT_APIMART_IMAGE_RULE;
}
function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function normalizeRuleResolution(value, rule = DEFAULT_APIMART_IMAGE_RULE) {
  const raw = String(value || rule.defaultResolution || '1k').trim().toLowerCase();
  const map = { '0.5k':'0.5k', '512':'0.5k', '1k':'1k', '1K':'1k', '2k':'2k', '2K':'2k', '3k':'3k', '3K':'3k', '4k':'4k', '4K':'4k' };
  const r = map[raw] || raw;
  const available = rule.resolutions || [];
  const matched = available.find(x => String(x).toLowerCase() === String(r).toLowerCase());
  return matched || rule.defaultResolution || available[0] || '1k';
}
function sanitizeApimartImagePayload(rawPayload = {}, model = '') {
  const rule = getApimartImageRule(model);
  const payload = {
    model: String(model || rawPayload.model || '').trim() || 'gemini-3.1-flash-image-preview',
    prompt: rawPayload.prompt,
    n: clampInt(rawPayload.n, rule.nMin || 1, rule.nMax || 1, rule.defaultN || 1)
  };

  const hasRefs = Array.isArray(rawPayload.image_urls) && rawPayload.image_urls.filter(Boolean).length > 0;
  if (!rule.noSize) {
    let rawSize = String(rawPayload.size || rule.defaultSize || 'auto').replace('×','x').replace(/\s+/g,'').toLowerCase();
    if (rawSize === 'none') rawSize = rule.defaultSize || '1:1';
    const sizes = rule.sizes || null;
    if (sizes && !sizes.includes(rawSize) && !/^\d+x\d+$/i.test(rawSize)) rawSize = rule.defaultSize || sizes[0] || '1:1';
    if (sizes && rule.noCustomSize && /^\d+x\d+$/i.test(rawSize)) rawSize = rule.defaultSize || sizes[0] || '1:1';
    if (rule.autoRequiresImage && rawSize === 'auto' && !hasRefs) rawSize = rule.defaultSize || '1:1';
    payload.size = rawSize || rule.defaultSize || 'auto';
  }
  if (!rule.noResolution) payload.resolution = normalizeRuleResolution(rawPayload.resolution, rule);

  if (hasRefs) {
    if (rule.textOnly || Number(rule.maxImageUrls || 0) <= 0) throw new Error(`${payload.model} 仅支持文生图，不支持上传参考图`);
    // 按用户要求：本地不再限制参考图数量，最终以 APIMart 服务端模型规则为准。
    payload.image_urls = rawPayload.image_urls.filter(Boolean);
  }
  const quality = String(rawPayload.quality || '').trim().toLowerCase();
  if (rule.allowQuality && quality && (rule.qualities || ['auto','low','medium','high']).includes(quality)) payload.quality = quality;
  const background = String(rawPayload.background || '').trim().toLowerCase();
  if (rule.allowBackground && background && (rule.backgrounds || ['auto','opaque','transparent']).includes(background)) payload.background = background;
  const moderation = String(rawPayload.moderation || '').trim().toLowerCase();
  if (rule.allowModeration && moderation && (rule.moderations || ['auto','low']).includes(moderation)) payload.moderation = moderation;
  const outputFormatRaw = String(rawPayload.output_format || rawPayload.outputFormat || rule.defaultOutputFormat || '').trim().toLowerCase();
  if (rule.allowOutputFormat && outputFormatRaw && (rule.outputFormats || ['png','jpeg','webp']).includes(outputFormatRaw)) payload.output_format = outputFormatRaw;
  const outputCompression = parseInt(rawPayload.output_compression ?? rawPayload.outputCompression, 10);
  if (rule.allowOutputFormat && Number.isFinite(outputCompression) && ['jpeg','webp'].includes(payload.output_format)) payload.output_compression = Math.max(0, Math.min(100, outputCompression));
  const maskUrl = String(rawPayload.mask_url || rawPayload.maskUrl || '').trim();
  if (rule.allowMask && maskUrl) payload.mask_url = maskUrl;

  if (rule.allowOptimizePrompt) {
    const opt = String(rawPayload.optimize_prompt_options || rawPayload.prompt_optimize || rule.defaultOptimizePrompt || 'standard').trim().toLowerCase();
    if ((rule.optimizePromptOptions || ['standard','fast']).includes(opt)) payload.optimize_prompt_options = opt;
  }
  if (rule.allowSequential) {
    const seq = String(rawPayload.sequential_image_generation || (payload.n > 1 ? 'auto' : 'disabled')).trim().toLowerCase();
    if (['disabled','auto'].includes(seq)) payload.sequential_image_generation = seq;
    if (payload.sequential_image_generation === 'auto') payload.sequential_image_generation_options = { max_images: payload.n };
  }
  if (rule.allowWatermark && rawPayload.watermark !== undefined) payload.watermark = !!rawPayload.watermark;
  return payload;
}
function isApimartBase(base){ return /api\.apimart\.ai/i.test(String(base || '')) || /docs\.apimart\.ai/i.test(String(base || '')); }
function normalizeApimartBase(input){
  let s = String(input || 'https://api.apimart.ai').trim();
  // 用户如果误填文档页或完整接口地址，也强制归一化为 API 根地址，避免拼出 docs/.../v1/images/generations 或重复 /v1/images/generations。
  if (/docs\.apimart\.ai/i.test(s)) return 'https://api.apimart.ai';
  if (/api\.apimart\.ai/i.test(s)) return 'https://api.apimart.ai';
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/v1\/(images\/generations|tasks.*|uploads\/images).*$/i, '');
  return cleanBase(s || 'https://api.apimart.ai');
}
function makeApimartUrl(base, endpoint){ return normalizeApimartBase(base) + endpoint; }
function compactPayloadForLog(payload){
  const clone = {...(payload||{})};
  if(Array.isArray(clone.image_urls)) clone.image_urls = clone.image_urls.map(x=>String(x).slice(0,120));
  return JSON.stringify(clone);
}

function normalizeApimartResolution(v){
  const s = String(v || '1K').trim();
  const map = {'0.5k':'0.5K','512':'0.5K','1k':'1K','2k':'2K','3k':'3K','4k':'4K'};
  return map[s.toLowerCase()] || s.toUpperCase();
}
function mimeFromPath(filePath){
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if(ext === '.png') return 'image/png';
  if(ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function isApimartAuthenticationError(value, status = 0){
  if(value && value.code === 'APIMART_INVALID_API_KEY') return true;
  if(Number(status) === 401) return true;
  let text = '';
  try{ text = typeof value === 'string' ? value : JSON.stringify(value || {}); }catch{ text = String(value || ''); }
  return /invalid\s+(?:api\s+)?key|unauthori[sz]ed|authentication\s+(?:failed|error)|missing\s+(?:api\s+)?key/i.test(text);
}
function apimartAuthenticationError(){
  const error = new Error('APIMart API Key 无效，请在当前公网设备首页重新填写正确的 API Key');
  error.code = 'APIMART_INVALID_API_KEY';
  error.terminal = true;
  return error;
}
function assertApimartUploadApiKey(apiKey=''){
  const key = String(apiKey || '').trim();
  if(!key || /(?:^[a-z][a-z0-9+.-]*:\/\/|^www\.)/i.test(key) || /\s/.test(key)) throw apimartAuthenticationError();
  return key;
}

async function uploadImageToApimartByCurl(baseUrl, apiKey, filePath, proxyUrl='') {
  const proxy = getProxyUrl(proxyUrl);
  const args = ['-sS','-L','--connect-timeout','4','--max-time','90'];
  if (proxy) args.push('--proxy', proxy);
  args.push('-X','POST', makeApimartUrl(baseUrl, '/v1/uploads/images'), '-H', `Authorization: Bearer ${apiKey || ''}`, '-F', `file=@${filePath}`);
  const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const r = await runProcessAsync(exe, args, { timeoutMs: 185000 });
  if (r.status !== 0) throw new Error(`curl 上传参考图失败：${(r.stderr || r.stdout || '').slice(0,800)}`);
  const data = parseJsonText(r.stdout);
  if(isApimartAuthenticationError(data)) throw apimartAuthenticationError();
  const url = data.url || data?.data?.url || data?.data?.[0]?.url;
  if(!url) throw new Error('curl 上传参考图失败：APIMart 未返回图片 URL，实际响应：' + JSON.stringify(data).slice(0,600));
  markGoodProxy(proxy);
  return url;
}
async function uploadImageToApimart(baseUrl, apiKey, filePath, proxyUrl=''){
  if(!filePath) return '';
  apiKey = assertApimartUploadApiKey(apiKey);
  const stat = fs.statSync(filePath);
  const errors = [];
  for (const proxy of getProxyCandidates(proxyUrl)) {
    try { return await uploadImageToApimartByCurl(baseUrl, apiKey, filePath, proxy); }
    catch (e) {
      if(isApimartAuthenticationError(e)) throw apimartAuthenticationError();
      errors.push(`curl上传失败[${proxy}]：${e.message || e}`);
    }
  }
  // 代理都失败后再走 fetch 直连兜底。
  try {
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mimeFromPath(filePath) }), path.basename(filePath));
    const res = await fetchNoSingleTimeout(makeApimartUrl(baseUrl, '/v1/uploads/images'), { method:'POST', headers:{ 'Authorization': apiKey ? `Bearer ${apiKey}` : '' }, body:form });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw:text }; }
    if(isApimartAuthenticationError(data, res.status)) throw apimartAuthenticationError();
    if(!res.ok) throw new Error(`上传参考图失败 HTTP ${res.status}: ${text.slice(0, 600)}`);
    const url = data.url || data?.data?.url || data?.data?.[0]?.url;
    if(!url) throw new Error('上传参考图失败：APIMart 未返回图片 URL');
    return url;
  } catch (e) {
    if(isApimartAuthenticationError(e)) throw apimartAuthenticationError();
    errors.push('fetch直连上传失败：' + (e.message || e));
    throw new Error('上传参考图失败：' + errors.join(' | '));
  }
}

const GPT_IMAGE_2_VIP_SIZES = {
  '1:1': { '1K':'1024x1024', '2K':'2048x2048', '4K':'2880x2880' },
  '16:9': { '1K':'1280x720', '2K':'2048x1152', '4K':'3840x2160' },
  '9:16': { '1K':'720x1280', '2K':'1152x2048', '4K':'2160x3840' },
  '4:3': { '1K':'1152x864', '2K':'2304x1728', '4K':'3264x2448' },
  '3:4': { '1K':'864x1152', '2K':'1728x2304', '4K':'2448x3264' },
  '3:2': { '1K':'1536x1024', '2K':'2048x1360', '4K':'3504x2336' },
  '2:3': { '1K':'1024x1536', '2K':'1360x2048', '4K':'2336x3504' },
  '5:4': { '1K':'1120x896', '2K':'2240x1792', '4K':'3200x2560' },
  '4:5': { '1K':'896x1120', '2K':'1792x2240', '4K':'2560x3200' },
  '21:9': { '1K':'1456x624', '2K':'2912x1248', '4K':'3840x1648' },
  '9:21': { '1K':'624x1456', '2K':'1248x2912', '4K':'1648x3840' },
  '1:3': { '1K':'688x2048', '4K':'1280x3840' },
  '3:1': { '1K':'2048x688', '4K':'3840x1280' },
  '2:1': { '1K':'1536x768', '2K':'3072x1536', '4K':'3840x1920' },
  '1:2': { '1K':'768x1536', '2K':'1536x3072', '4K':'1920x3840' }
};
const GPT_IMAGE_2_SIZES = {
  '1:1':'1024x1024', '16:9':'1672x941', '9:16':'941x1672', '4:3':'1443x1090',
  '3:4':'1090x1443', '3:2':'1536x1024', '2:3':'1024x1536', '5:4':'1408x1120',
  '4:5':'1120x1408', '21:9':'1920x832', '9:21':'832x1920', '1:2':'896x1792', '2:1':'1792x896'
};
function resolveModelSize(model, size, clarity) {
  const raw = String(size || 'auto').replace('×','x').replace(/\s+/g,'').toLowerCase();
  if (!raw || raw === 'auto') return 'auto';
  if (/^\d+x\d+$/i.test(raw)) return raw;
  const ratio = raw.replace(/^([0-9]+):([0-9]+)$/, '$1:$2');
  const m = String(model || '').toLowerCase();
  const q = String(clarity || '1K').toUpperCase();
  if (m === 'gpt-image-2-vip') return GPT_IMAGE_2_VIP_SIZES[ratio]?.[q] || GPT_IMAGE_2_VIP_SIZES[ratio]?.['1K'] || ratio;
  if (m === 'gpt-image-2') return GPT_IMAGE_2_SIZES[ratio] || ratio;
  return ratio;
}

function urlJoin(base, p) { return cleanBase(base) + p; }

function sizeToAspect(size, model = '', clarity = '1K') {
  const raw = String(size || 'auto').replace('×','x').replace(/\s+/g,'').toLowerCase();
  if(APIMART_IMAGE_MODELS.includes(String(model || '').toLowerCase())) return APIMART_RATIO_SET.has(raw) || /^\d+x\d+$/i.test(raw) ? raw : 'auto';
  return resolveModelSize(model, size, clarity);
}

function pickResultUrls(data) {
  if (!data) return [];
  const out = [];
  const seen = new Set();
  const seenUrl = new Set();
  const looksLikeRemoteUrl = (s) => /^https?:\/\//i.test(String(s || ''));
  const isNonResultUrl = (s) => /\/v1\/tasks|\/v1\/images|\/v1\/videos|api\.apimart\.ai|docs\.apimart\.ai/i.test(String(s || ''));
  const looksLikeImageUrl = (s, ctx='') => {
    const x = String(s || '');
    const c = String(ctx || '').toLowerCase();
    if (!looksLikeRemoteUrl(x) || isNonResultUrl(x)) return false;
    if (/\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(x)) return true;
    if (/image|img|photo|picture|result|output|download|remote|file|url|data|response|content|asset/i.test(c) && !/prompt|input_text|input_image|source|video_url|video_urls/i.test(c)) return true;
    // Some CDN signed URLs do not expose an extension; accept storage/CDN URLs when they appear inside result-like fields.
    if (/result|output|download|remote|file|asset|response/i.test(c) && /cdn|storage|oss|cos|r2|cloudflare|apimart|openai|oaidalleapi|blob|files/i.test(x)) return true;
    return false;
  };
  const pushUrl = (s, ctx='') => {
    const u = String(s || '').trim().replace(/[\s"'<>]+$/g, '');
    if (!looksLikeImageUrl(u, ctx)) return;
    if (!seenUrl.has(u)) { seenUrl.add(u); out.push(u); }
  };
  const extractUrlsFromString = (s, ctx='') => {
    const str = String(s || '');
    const re = /https?:\/\/[^\s"'<>\\]+/ig;
    let m;
    while ((m = re.exec(str))) pushUrl(m[0], ctx);
    // If a field contains stringified JSON, parse it too.
    const t = str.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try { add(JSON.parse(t), ctx + '.jsonString'); } catch {}
    }
  };
  const add = (v, ctx = '') => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach((x,i) => add(x, `${ctx}[${i}]`));
    if (typeof v === 'string') { pushUrl(v, ctx); extractUrlsFromString(v, ctx); return; }
    if (typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      // Direct fields.
      add(v.url, ctx + '.url');
      add(v.urls, ctx + '.urls');
      add(v.image_url, ctx + '.image_url');
      add(v.image_urls, ctx + '.image_urls');
      add(v.images_url, ctx + '.images_url');
      add(v.output_url, ctx + '.output_url');
      add(v.output_urls, ctx + '.output_urls');
      add(v.result_url, ctx + '.result_url');
      add(v.download_url, ctx + '.download_url');
      add(v.download_urls, ctx + '.download_urls');
      add(v.remote_url, ctx + '.remote_url');
      add(v.file_url, ctx + '.file_url');
      add(v.file_urls, ctx + '.file_urls');
      add(v.src, ctx + '.src');
      add(v.link, ctx + '.link');
      add(v.href, ctx + '.href');
      add(v.asset_url, ctx + '.asset_url');
      add(v.content_url, ctx + '.content_url');
      // APIMart / model providers often put final URLs in these containers.
      add(v.result, ctx + '.result');
      add(v.response, ctx + '.response');
      add(v.output, ctx + '.output');
      add(v.outputs, ctx + '.outputs');
      add(v.images, ctx + '.images');
      add(v.image, ctx + '.image');
      add(v.results, ctx + '.results');
      add(v.files, ctx + '.files');
      add(v.file, ctx + '.file');
      add(v.artifacts, ctx + '.artifacts');
      add(v.artifact, ctx + '.artifact');
      add(v.content, ctx + '.content');
      if (v.data && v.data !== v) add(v.data, ctx + '.data');
      // Last-resort deep scan for unknown response shapes, but keep URL filtering above to avoid prompt/source URLs.
      for (const [k, val] of Object.entries(v)) {
        if (['url','urls','image_url','image_urls','output_url','output_urls','result_url','download_url','remote_url','file_url','src','link','href','result','response','output','outputs','images','image','results','files','file','artifacts','artifact','content','data'].includes(k)) continue;
        if (typeof val === 'string') extractUrlsFromString(val, ctx + '.' + k);
        else if (val && typeof val === 'object' && /result|output|image|file|asset|download|response|data|content/i.test(k)) add(val, ctx + '.' + k);
      }
    }
  };
  add(data, 'root');
  return out;
}
function pickResultUrl(data) {
  return pickResultUrls(data)[0] || '';
}
function normalizeResultImageUrls(urls = [], expectedCount = 0) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(urls) ? urls : [])) {
    const u = String(raw || '').trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  const limit = Math.max(0, Number(expectedCount || 0));
  return limit > 0 ? out.slice(0, limit) : out;
}

function pickTaskId(data) {
  if (!data) return '';
  return data.task_id || data.id || data.job_id || data?.data?.task_id || data?.data?.id || data?.data?.[0]?.task_id || data?.data?.[0]?.id || data?.result?.id || '';
}

function pickBase64(data) {
  const seen = new Set();
  let found = '';
  const walk = (x) => {
    if (found || !x) return;
    if (typeof x === 'string') return;
    if (Array.isArray(x)) { for (const it of x) walk(it); return; }
    if (typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    found = x.image_base64 || x.base64 || x.b64_json || x.data_base64 || '';
    if (found) return;
    walk(x.data); walk(x.result); walk(x.output); walk(x.images); walk(x.results); walk(x.outputs);
  };
  walk(data);
  return found || '';
}

async function postJson(url, apiKey, payload, proxyUrl = '') {
  const cleanPayload = Object.fromEntries(Object.entries(payload || {}).filter(([k]) => k !== '__requestTimeoutMs'));
  // APIMart 在当前网络环境直连经常超时；直接走代理兜底链，避免每次先卡在 fetch 直连。
  if (isApimartUrl(url) && getProxyCandidates(proxyUrl).length) {
    return jsonRequestWithFallback(url, apiKey, cleanPayload, 'POST', proxyUrl);
  }
  try {
    const res = await fetchNoSingleTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'LocalApiImageGenerator/14.5.5',
        'Authorization': apiKey ? `Bearer ${apiKey}` : ''
      },
      body: JSON.stringify(cleanPayload)
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      if (/api\.apimart\.ai/i.test(String(url || '')) && data && typeof data === 'object') assertApimartCode200(data, `APIMart HTTP ${res.status}`);
      throw new Error(`HTTP ${res.status}: ${extractApimartErrorMessage(data) || text.slice(0, 600)}`);
    }
    if(!hasUsefulApiResponse(data)) return jsonRequestWithFallback(url, apiKey, cleanPayload, 'POST', proxyUrl);
    return data;
  } catch (e) {
    // V14.1：Node/Electron fetch 在部分 Windows 网络环境会直接 TypeError: fetch failed。
    // 对 APIMart JSON 接口改用 https.request 再试一次，并输出真实网络原因。
    if (/fetch failed|TypeError|network|ECONN|ENOTFOUND|ETIMEDOUT|TLS/i.test(String(e && (e.message || e)))) {
      return jsonRequestWithFallback(url, apiKey, cleanPayload, 'POST', proxyUrl);
    }
    throw e;
  }
}

async function getJson(url, apiKey, proxyUrl = '') {
  if (isApimartUrl(url) && getProxyCandidates(proxyUrl).length) {
    return jsonRequestWithFallback(url, apiKey, null, 'GET', proxyUrl);
  }
  try {
    const res = await fetchNoSingleTimeout(url, { headers: { 'Authorization': apiKey ? `Bearer ${apiKey}` : '', 'Accept':'application/json', 'User-Agent':'LocalApiImageGenerator/14.5.6' } });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      if (/api\.apimart\.ai/i.test(String(url || '')) && data && typeof data === 'object') assertApimartCode200(data, `APIMart HTTP ${res.status}`);
      throw new Error(`HTTP ${res.status}: ${extractApimartErrorMessage(data) || text.slice(0, 600)}`);
    }
    if(!hasUsefulApiResponse(data)) return jsonRequestWithFallback(url, apiKey, null, 'GET', proxyUrl);
    return data;
  } catch (e) {
    if (/fetch failed|TypeError|network|ECONN|ENOTFOUND|ETIMEDOUT|TLS/i.test(String(e && (e.message || e)))) {
      return jsonRequestWithFallback(url, apiKey, null, 'GET', proxyUrl);
    }
    throw e;
  }
}

function flattenApimartTaskItems(resp) {
  const out = [];
  const walk = (x) => {
    if (!x) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x !== 'object') return;
    const id = x.id || x.task_id || x.taskId || x.taskID;
    const looksTask = id || x.status || x.progress || x.result || x.error;
    if (looksTask) out.push(x);
    if (x.data && x.data !== x) walk(x.data);
    if (x.tasks && x.tasks !== x) walk(x.tasks);
    if (x.results && x.results !== x) walk(x.results);
  };
  walk(resp);
  return out;
}
function taskItemId(item = {}) { return String(item.id || item.task_id || item.taskId || item.taskID || '').trim(); }

function pickTaskStatus(data) {
  const items = flattenApimartTaskItems(data);
  const cands = [data?.status, data?.state, data?.data?.status, data?.data?.state, data?.result?.status, data?.result?.state];
  if (Array.isArray(data?.data) && data.data[0]) cands.push(data.data[0].status, data.data[0].state);
  for (const it of items) cands.push(it.status, it.state, it.task_status);
  return String(cands.find(v => v !== undefined && v !== null && String(v).trim()) || '').toLowerCase();
}
function pickTaskProgress(data) {
  const items = flattenApimartTaskItems(data);
  const cands = [data?.progress, data?.data?.progress, data?.result?.progress];
  if (Array.isArray(data?.data) && data.data[0]) cands.push(data.data[0].progress);
  for (const it of items) cands.push(it.progress, it.percent, it.percentage);
  const v = cands.find(x => Number.isFinite(Number(x)));
  return Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : 0;
}
function pickTaskErrorMessage(data) {
  const items = flattenApimartTaskItems(data);
  const cands = [data?.message, data?.msg, data?.error?.message, data?.data?.message, data?.data?.msg, data?.data?.error?.message];
  if (Array.isArray(data?.data) && data.data[0]) cands.push(data.data[0].message, data.data[0].msg, data.data[0]?.error?.message, data.data[0]?.error);
  for (const it of items) cands.push(it.message, it.msg, it?.error?.message, it.error, it.reason);
  return String(cands.find(v => v !== undefined && v !== null && String(v).trim()) || '').trim();
}
function isPendingTaskStatus(statusText) {
  const s = String(statusText || '').toLowerCase();
  return !s || ['pending','submitted','queued','queue','waiting','wait','processing','running','generating','in_progress','created'].includes(s);
}
function isFinishedTaskStatus(statusText) {
  const s = String(statusText || '').toLowerCase();
  return ['completed','complete','succeeded','success','done','finished'].includes(s);
}
function hasTaskResultPayload(data) { return !!(pickResultUrl(data) || pickBase64(data)); }
async function queryApimartTaskSingle(base, apiKey, taskId, proxyUrl = '') {
  const baseUrl = normalizeApimartBase(base);
  const single = await getJson(makeApimartUrl(baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}`), apiKey, proxyUrl);
  assertApimartCode200(single, 'APIMart 单任务查询');
  return single;
}
function normalizeSingleTaskFromBatch(resp, taskId) {
  const id = String(taskId || '').trim();
  const items = flattenApimartTaskItems(resp);
  const exact = items.find(x => taskItemId(x) === id) || items.find(x => taskItemId(x) && (taskItemId(x).includes(id) || id.includes(taskItemId(x))));
  return exact || (resp && resp.data && !Array.isArray(resp.data) ? resp.data : resp);
}
const apimartBatchState = { timer:null, queue:[], taskMeta:new Map() };
function taskMetaFor(id){
  const key = String(id || '').trim();
  let meta = apimartBatchState.taskMeta.get(key);
  if(!meta){ meta = { firstSeenAt: Date.now(), lastSingleAt: 0, polls: 0 }; apimartBatchState.taskMeta.set(key, meta); }
  meta.polls += 1;
  return meta;
}
function shouldForceSingleTaskCheck(taskId, item, statusText){
  // V14.5.6 性能修复：旧版在 batch 返回 pending 时每个任务立刻再 GET 一次单任务。
  // 多并发时会变成 1 次 batch + N 次 GET + N 个 curl.exe 进程，是“无响应”的主要原因。
  // 现在只在完成态解析不到结果、或 pending 超过一段时间且冷却结束时，才强查单任务。
  if (hasTaskResultPayload(item)) return false;
  const st = String(statusText || '').toLowerCase();
  const meta = taskMetaFor(taskId);
  const now = Date.now();
  if (isFinishedTaskStatus(st)) return true;
  if (!isPendingTaskStatus(st)) return true;
  const ageMs = now - meta.firstSeenAt;
  const coolMs = now - meta.lastSingleAt;
  return ageMs >= 20000 && coolMs >= 15000;
}
function queryApimartTaskBatchAware(base, apiKey, taskId, proxyUrl = '', timeoutMs = 120000) {
  const id = String(taskId || '').trim();
  if (!id) return Promise.reject(new Error('task_id 不能为空'));
  return new Promise((resolve, reject) => {
    apimartBatchState.queue.push({ base, apiKey, taskId:id, proxyUrl, timeoutMs, resolve, reject });
    if (!apimartBatchState.timer) {
      apimartBatchState.timer = setTimeout(async () => {
        const jobs = apimartBatchState.queue.splice(0, apimartBatchState.queue.length);
        apimartBatchState.timer = null;
        const groups = new Map();
        for (const j of jobs) {
          const key = `${normalizeApimartBase(j.base)}|${j.apiKey}|${j.proxyUrl}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(j);
        }
        for (const group of groups.values()) {
          const first = group[0];
          const baseUrl = normalizeApimartBase(first.base);
          const ids = [...new Set(group.map(j => j.taskId))];
          try {
            const batchUrl = makeApimartUrl(baseUrl, '/v1/tasks/batch');
            const resp = await postJson(batchUrl, first.apiKey, { task_ids: ids }, first.proxyUrl);
            assertApimartCode200(resp, 'APIMart 批量查询');
            for (const j of group) {
              const item = normalizeSingleTaskFromBatch(resp, j.taskId);
              const st = pickTaskStatus(item);
              if (shouldForceSingleTaskCheck(j.taskId, item, st)) {
                try {
                  const meta = taskMetaFor(j.taskId);
                  meta.lastSingleAt = Date.now();
                  const single = await queryApimartTaskSingle(baseUrl, j.apiKey, j.taskId, j.proxyUrl);
                  if (hasTaskResultPayload(single) || !isPendingTaskStatus(pickTaskStatus(single))) {
                    if (hasTaskResultPayload(single) || isFinishedTaskStatus(pickTaskStatus(single))) apimartBatchState.taskMeta.delete(j.taskId);
                    j.resolve(single);
                  } else {
                    j.resolve(item);
                  }
                } catch (_) { j.resolve(item); }
              } else {
                if (hasTaskResultPayload(item) || isFinishedTaskStatus(st)) apimartBatchState.taskMeta.delete(j.taskId);
                j.resolve(item);
              }
            }
          } catch (batchErr) {
            for (const j of group) {
              try {
                const single = await queryApimartTaskSingle(baseUrl, j.apiKey, j.taskId, j.proxyUrl);
                j.resolve(single);
              } catch (singleErr) {
                j.reject(new Error(`批量查询失败：${batchErr.message || batchErr}；单任务兜底也失败：${singleErr.message || singleErr}`));
              }
            }
          }
        }
      }, 180);
    }
  });
}

async function generateOne({ cfg, prompt, mainImagePath, refImages = [], outputPath, remoteTaskId = '', onSubmitted = null, onProgress = null }) {
  const proxyUrl = getProxyUrl(cfg.apimartProxyUrl || cfg.proxyUrl || cfg.apimart_proxy_url || '');
  const rawBase = cleanBase(cfg.apiBaseUrl || 'https://api.apimart.ai');
  const platform = String(cfg.imageApiPlatform || '').toLowerCase();
  const migratedLegacyFlow = ['legacy','grsai'].includes(platform) || /grsaiapi\.com|grsai\.dakka\.com\.cn/i.test(rawBase);
  const flow2apiMode = platform === 'flow2api' || migratedLegacyFlow || /(?:127\.0\.0\.1|localhost):38000/i.test(rawBase);
  if (flow2apiMode) {
    const flowCfg = migratedLegacyFlow ? { ...cfg, imageApiPlatform:'flow2api', apiBaseUrl:'http://127.0.0.1:38000', apiKey:'', model:'gemini-3.1-flash-image' } : cfg;
    return generateFlow2ApiImage({ cfg:flowCfg, prompt, mainImagePath, refImages, outputPath, onProgress });
  }
  const apimartMode = isApimartBase(rawBase);
  const base = apimartMode ? normalizeApimartBase(rawBase) : rawBase;
  const allImagePaths = [mainImagePath, ...(refImages || [])].filter(Boolean);
  let imageUrls = [];

  const model = cfg.model || 'gemini-3.1-flash-image-preview';
  const rule = getApimartImageRule(model);
  if (apimartMode && allImagePaths.length) {
    const maxImages = Number(rule.maxImageUrls ?? 16);
    if (rule.textOnly || maxImages <= 0) throw new Error(`${model} 仅支持文生图，不支持上传参考图`);
    for (const p of allImagePaths.slice(0, maxImages)) imageUrls.push(await uploadImageToApimart(base, cfg.apiKey, p, proxyUrl));
  }

  const rawPayload = {
    model,
    prompt,
    size: sizeToAspect(cfg.size, model, cfg.imageSize || cfg.clarity || '1K'),
    resolution: cfg.imageSize || cfg.clarity || '1K',
    n: cfg.imageN || cfg.image_n || cfg.n || cfg.count || 1,
    quality: cfg.quality,
    background: cfg.background,
    moderation: cfg.moderation,
    output_format: cfg.output_format || cfg.outputFormat,
    output_compression: cfg.output_compression || cfg.outputCompression,
    mask_url: cfg.mask_url || cfg.maskUrl,
    optimize_prompt_options: cfg.optimize_prompt_options || cfg.promptOptimize,
    sequential_image_generation: cfg.sequential_image_generation,
    watermark: cfg.watermark
  };
  if (apimartMode && imageUrls.length) rawPayload.image_urls = imageUrls;
  const payload = apimartMode ? sanitizeApimartImagePayload(rawPayload, model) : {
    model: cfg.model,
    prompt,
    images: [],
    aspectRatio: sizeToAspect(cfg.size, cfg.model, cfg.imageSize || cfg.clarity || '1K'),
    imageSize: cfg.imageSize || '1K',
    replyType: 'json'
  };
  if (!apimartMode) {
    const { fileToDataUrl } = require('./cache');
    if (mainImagePath) payload.images.push(fileToDataUrl(mainImagePath));
    for (const p of refImages || []) payload.images.push(fileToDataUrl(p));
  }

  const expectedCount = Math.max(1, Number(payload.n || cfg.imageN || cfg.image_n || 1));
  const pollMs = apimartMode ? Math.max(2500, Number(cfg.pollIntervalMs || 2500)) : Math.max(100, Number(cfg.pollIntervalMs || 1200));
  const deadlineAt = Number(cfg.deadlineAt || 0) || (Date.now() + (Number(cfg.timeoutMs || 20 * 60 * 1000)));
  let submit = {};
  let imageUrl = '';
  let imageUrlsResult = [];
  let b64 = '';
  let taskId = String(remoteTaskId || '');

  if (!taskId) {
    const generateUrl = apimartMode ? makeApimartUrl(base, (getApimartImageRule(model).endpoint || '/v1/images/generations')) : urlJoin(base, '/v1/api/generate');
    if (typeof cfg.onSubmitLog === 'function') {
      try { cfg.onSubmitLog({ url: generateUrl, payload: compactPayloadForLog(payload) }); } catch {}
    }
    submit = await postJson(generateUrl, cfg.apiKey, payload, proxyUrl);
    if (apimartMode) assertApimartCode200(submit, 'APIMart 图像生成');
    imageUrlsResult = normalizeResultImageUrls(pickResultUrls(submit), expectedCount);
    imageUrl = imageUrlsResult[0] || '';
    b64 = pickBase64(submit);
    taskId = pickTaskId(submit);
    if (typeof cfg.onSubmitLog === 'function') {
      try { cfg.onSubmitLog({ response: JSON.stringify(submit).slice(0,1000), taskId }); } catch {}
    }
    if (taskId && typeof onSubmitted === 'function') {
      try { onSubmitted(taskId); } catch {}
    }
    if (apimartMode && !taskId && !imageUrl && !b64) {
      throw new Error(`APIMart 图像接口没有返回 task_id。按文档成功响应应为 {code:200,data:[{status:'submitted',task_id:'...'}]}。实际响应：${JSON.stringify(submit).slice(0,1000)}。请检查 API Key、账户余额、模型名、请求格式和网络/代理。`);
    }
  }

  if (!imageUrl && !b64 && taskId) {
    const resultUrl = apimartMode ? makeApimartUrl(base, `/v1/tasks/${encodeURIComponent(taskId)}`) : urlJoin(base, `/v1/api/result?id=${encodeURIComponent(taskId)}`);
    let firstPoll = true;
    while (Date.now() < deadlineAt) {
      const firstPollMs = Math.max(2500, Number(cfg.apimartFirstPollMs || 3000));
      const waitTarget = apimartMode && firstPoll ? Math.max(firstPollMs, pollMs) : pollMs;
      firstPoll = false;
      const waitMs = Math.min(waitTarget, Math.max(0, deadlineAt - Date.now()));
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
      if (Date.now() >= deadlineAt) break;
      let status;
      try {
        status = apimartMode
          ? await queryApimartTaskBatchAware(base, cfg.apiKey, taskId, proxyUrl)
          : await getJson(resultUrl, cfg.apiKey, proxyUrl);
      }
      catch (e) { if (Date.now() >= deadlineAt) throw e; throw e; }
      imageUrlsResult = normalizeResultImageUrls(pickResultUrls(status), expectedCount);
      imageUrl = imageUrlsResult[0] || '';
      b64 = pickBase64(status);
      const statusText = pickTaskStatus(status);
      const rawProgress = pickTaskProgress(status);
      const progress = rawProgress || (isFinishedTaskStatus(statusText) ? 99 : (isPendingTaskStatus(statusText) ? 15 : 60));
      if (typeof onProgress === 'function') {
        try { onProgress({ progress, statusText, payload: status }); } catch {}
      }
      if (imageUrl || b64) break;
      if (['failed', 'fail', 'error', 'cancelled', 'canceled'].includes(statusText)) {
        const msg = pickTaskErrorMessage(status) || 'remote generation failed';
        throw new Error(String(msg));
      }
      if (isFinishedTaskStatus(statusText) && !imageUrl && !b64) {
        // V14.5.5：远端已完成时不再一直显示“正在解析结果”。
        // 立即强查单任务接口并再次解析；仍找不到链接就给出原始响应，方便继续适配。
        if (typeof onProgress === 'function') {
          try { onProgress({ progress: 99, statusText: statusText + '，正在强制读取结果链接', payload: status }); } catch {}
        }
        try {
          const singleStatus = await queryApimartTaskSingle(base, cfg.apiKey, taskId, proxyUrl);
          imageUrlsResult = normalizeResultImageUrls(pickResultUrls(singleStatus), expectedCount);
          imageUrl = imageUrlsResult[0] || '';
          b64 = pickBase64(singleStatus);
          if (imageUrl || b64) break;
          throw new Error('APIMart 任务已完成，但程序未能从响应中解析图片 URL。批量响应：' + JSON.stringify(status).slice(0, 800) + '；单任务响应：' + JSON.stringify(singleStatus).slice(0, 1200));
        } catch(e) {
          if (/未能从响应中解析图片 URL/.test(String(e.message || e))) throw e;
          throw new Error('APIMart 任务已完成，但单任务强查失败：' + (e.message || e));
        }
      }
    }
  }

  // V14.5.1: 到达超时边界前再强制做一次单任务查询，防止 batch 仍 pending 但单任务接口已有结果。
  if (!imageUrl && !b64 && taskId && apimartMode) {
    try {
      const finalStatus = await queryApimartTaskSingle(base, cfg.apiKey, taskId, proxyUrl);
      imageUrlsResult = normalizeResultImageUrls(pickResultUrls(finalStatus), expectedCount);
      imageUrl = imageUrlsResult[0] || '';
      b64 = pickBase64(finalStatus);
      if (!imageUrl && !b64 && isFinishedTaskStatus(pickTaskStatus(finalStatus))) {
        throw new Error('APIMart 任务已完成，但程序未能从响应中解析图片 URL。实际响应：' + JSON.stringify(finalStatus).slice(0, 1200));
      }
    } catch (e) {
      if (!/已完成，但程序未能/.test(String(e.message || e)) && Date.now() < deadlineAt) {
        // 查询失败但仍未超时时，不覆盖前面的轮询状态。
      } else if (/已完成，但程序未能/.test(String(e.message || e))) throw e;
    }
  }

  if (imageUrl) {
    imageUrlsResult = normalizeResultImageUrls(imageUrlsResult.length ? imageUrlsResult : [imageUrl], expectedCount);
    imageUrl = imageUrlsResult[0] || imageUrl;
    const downloaded = [];
    const pathObj = require('path');
    const ext = pathObj.extname(outputPath) || '.png';
    const baseNoExt = outputPath.slice(0, outputPath.length - ext.length);
    for (let i = 0; i < imageUrlsResult.length; i++) {
      const target = i === 0 ? outputPath : `${baseNoExt}_${String(i+1).padStart(2,'0')}${ext}`;
      await downloadResultToFile(imageUrlsResult[i], target, proxyUrl);
      downloaded.push({ outputPath: target, imageUrl: imageUrlsResult[i] });
    }
    return { outputPath, extraImages: downloaded.slice(1), remoteTaskId: taskId || '', imageUrl: imageUrl || '', imageUrls: imageUrlsResult, response: submit };
  }
  if (b64) {
    const cleaned = String(b64).replace(/^data:image\/\w+;base64,/, '');
    require('fs').writeFileSync(outputPath, Buffer.from(cleaned, 'base64'));
    return { outputPath, remoteTaskId: taskId || '', imageUrl: imageUrl || '', response: submit };
  }
  if (Date.now() >= deadlineAt) throw new Error(`单任务累计超时：${Math.round(Number(cfg.timeoutMs || 0) / 1000)} 秒`);
  throw new Error('API 未返回图片 URL / base64 / task_id');
}

function resolveFlow2ApiImageModel(model='', size='auto', clarity='1K') {
  const current = String(model || 'gemini-3.1-flash-image').trim();
  const match = /^(gemini-3\.1-flash-image|gemini-3\.0-pro-image)(?:-(?:landscape|portrait|square|four-three|three-four))?(?:-(?:2k|4k))?$/i.exec(current);
  if(!match) return 'gemini-3.1-flash-image-landscape';
  const aspect = String(size).toLowerCase();
  const variant = aspect === '1:1' ? 'square'
    : aspect === '4:3' ? 'four-three'
    : aspect === '3:4' ? 'three-four'
    : ['9:16','2:3','9:21'].includes(aspect) ? 'portrait'
    : 'landscape';
  const resolution = String(clarity || '').toLowerCase();
  const suffix = resolution === '4k' ? '-4k' : resolution === '2k' ? '-2k' : '';
  return `${match[1]}-${variant}${suffix}`;
}

function pickFlow2ApiImage(content='') {
  const text = String(content || '');
  const markdown = /!\[[^\]]*\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=\r\n]+|https?:\/\/[^)\s]+)\)/ig.exec(text);
  if(markdown && markdown[1]) return markdown[1].trim();
  const dataUrl = /(data:image\/[^;]+;base64,[A-Za-z0-9+/=\r\n]+)/i.exec(text);
  if(dataUrl && dataUrl[1]) return dataUrl[1].trim();
  const url = /(https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp)(?:\?[^\s"'<>]*)?)/i.exec(text);
  return url ? url[1] : '';
}

async function generateFlow2ApiImage({ cfg, prompt, mainImagePath, refImages = [], outputPath, onProgress = null }) {
  const base = cleanBase(cfg.apiBaseUrl || 'http://127.0.0.1:38000');
  if(!String(cfg.apiKey || '').trim()) throw new Error('请先填写本地 Flow2API API Key');
  const model = resolveFlow2ApiImageModel(cfg.model, cfg.size, cfg.imageSize || cfg.clarity || '1K');
  const paths = [mainImagePath, ...(refImages || [])].filter(Boolean);
  const content = [{ type:'text', text:String(prompt || '') }];
  if(paths.length){
    const { fileToDataUrl } = require('./cache');
    for(const filePath of paths) content.push({ type:'image_url', image_url:{ url:fileToDataUrl(filePath) } });
  }
  const payload = {
    model,
    messages:[{ role:'user', content:paths.length ? content : String(prompt || '') }],
    stream:false
  };
  const url = `${base}/v1/chat/completions`;
  if(typeof cfg.onSubmitLog === 'function'){
    try{ cfg.onSubmitLog({ url, payload:compactPayloadForLog({...payload, messages:[{role:'user',content:paths.length ? `[文本 + ${paths.length} 张图片]` : String(prompt || '')}]}) }); }catch{}
  }
  if(typeof onProgress === 'function') onProgress({progress:8,statusText:'正在提交到本地 Flow2API'});
  const response = await postJson(url, cfg.apiKey, payload, '');
  const error = response?.error?.message || response?.detail || '';
  if(error) throw new Error(`Flow2API 生成失败：${error}`);
  const message = response?.choices?.[0]?.message?.content || response?.choices?.[0]?.delta?.content || '';
  const image = pickFlow2ApiImage(message);
  if(!image) throw new Error(`Flow2API 未返回图片结果。请先在管理后台导入可用 Token。响应：${JSON.stringify(response).slice(0,1000)}`);
  if(typeof onProgress === 'function') onProgress({progress:95,statusText:'Flow2API 已返回图片，正在保存'});
  if(/^data:image\//i.test(image)){
    const cleaned = image.replace(/^data:image\/[^;]+;base64,/i, '');
    fs.writeFileSync(outputPath, Buffer.from(cleaned, 'base64'));
  }else{
    await downloadResultToFile(image, outputPath, '');
  }
  return { outputPath, remoteTaskId:'', imageUrl:/^data:/i.test(image) ? '' : image, response, model };
}

const APIMART_RESPONSE_CHAT_MODELS = [
  // GPT first
  { id: 'gpt-5.6-terra', name: 'GPT · gpt-5.6-terra' },
  { id: 'gpt-5.6-luna', name: 'GPT · gpt-5.6-luna' },
  { id: 'gpt-5.6-sol', name: 'GPT · gpt-5.6-sol' },
  { id: 'gpt-5.5', name: 'GPT · gpt-5.5' },
  { id: 'gpt-5.4', name: 'GPT · gpt-5.4' },
  { id: 'gpt-5.4-pro', name: 'GPT · gpt-5.4-pro' },
  { id: 'gpt-5.4-mini', name: 'GPT · gpt-5.4-mini' },
  { id: 'gpt-5.4-nano', name: 'GPT · gpt-5.4-nano' },
  { id: 'gpt-5.3-codex', name: 'GPT · gpt-5.3-codex' },
  { id: 'gpt-5.2-codex', name: 'GPT · gpt-5.2-codex' },
  { id: 'gpt-5.1-codex-max', name: 'GPT · gpt-5.1-codex-max' },
  { id: 'gpt-5.1-chat-latest', name: 'GPT · gpt-5.1-chat-latest' },
  { id: 'gpt-5', name: 'GPT · gpt-5' },
  { id: 'gpt-5-mini', name: 'GPT · gpt-5-mini' },
  { id: 'gpt-5-nano', name: 'GPT · gpt-5-nano' },
  { id: 'gpt-5.2', name: 'GPT · gpt-5.2' },
  { id: 'gpt-5.2-mini', name: 'GPT · gpt-5.2-mini' },
  { id: 'gpt-5.2-nano', name: 'GPT · gpt-5.2-nano' },
  { id: 'gpt-5.2-chat-latest', name: 'GPT · gpt-5.2-chat-latest' },
  { id: 'gpt-5.2-pro', name: 'GPT · gpt-5.2-pro' },
  { id: 'chatgpt-4o-latest', name: 'GPT · chatgpt-4o-latest' },
  { id: 'gpt-4.1', name: 'GPT · gpt-4.1' },
  { id: 'gpt-4.1-mini', name: 'GPT · gpt-4.1-mini' },
  { id: 'gpt-4.1-nano', name: 'GPT · gpt-4.1-nano' },
  { id: 'gpt-4o', name: 'GPT · gpt-4o' },
  { id: 'gpt-4o-mini', name: 'GPT · gpt-4o-mini' },
  { id: 'gpt-4-mini', name: 'GPT · gpt-4-mini' },
  { id: 'gpt-4-1106-preview', name: 'GPT · gpt-4-1106-preview' },
  { id: 'GPT-4o-image', name: 'GPT · GPT-4o-image' },
  { id: 'gpt-4-vision', name: 'GPT · gpt-4-vision' },
  { id: 'o3', name: 'GPT · o3' },
  { id: 'o3-mini', name: 'GPT · o3-mini' },
  { id: 'o4-mini', name: 'GPT · o4-mini' },
  { id: 'o4-mini-2025-04-16', name: 'GPT · o4-mini-2025-04-16' },
  { id: 'o1', name: 'GPT · o1' },
  { id: 'o1-mini', name: 'GPT · o1-mini' },

  // Gemini second
  { id: 'gemini-2.5-pro', name: 'Gemini · gemini-2.5-pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini · gemini-2.5-flash' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini · gemini-2.5-flash-lite' },
  { id: 'gemini-2.0-flash', name: 'Gemini · gemini-2.0-flash' },
  { id: 'gemini-2.0-flash-lite', name: 'Gemini · gemini-2.0-flash-lite' },
  { id: 'gemini-1.5-pro', name: 'Gemini · gemini-1.5-pro' },
  { id: 'gemini-1.5-flash', name: 'Gemini · gemini-1.5-flash' },
  { id: 'gemini-3.5-flash', name: 'Gemini · gemini-3.5-flash' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini · gemini-3.1-pro-preview' },
  { id: 'gemini-3-pro-preview', name: 'Gemini · gemini-3-pro-preview' },

  // Claude
  { id: 'claude-sonnet-5', name: 'Claude · claude-sonnet-5' },
  { id: 'claude-fable-5', name: 'Claude · claude-fable-5' },
  { id: 'claude-opus-4-8', name: 'Claude · claude-opus-4-8' },
  { id: 'claude-opus-4-7', name: 'Claude · claude-opus-4-7' },
  { id: 'claude-sonnet-4-6-thinking', name: 'Claude · claude-sonnet-4-6-thinking' },
  { id: 'claude-opus-4-6', name: 'Claude · claude-opus-4-6' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude · claude-opus-4-6-thinking' },
  { id: 'claude-opus-4-5-20251101', name: 'Claude · claude-opus-4-5-20251101' },
  { id: 'claude-opus-4-5-20251101-thinking', name: 'Claude · claude-opus-4-5-20251101-thinking' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude · claude-haiku-4-5-20251001' },
  { id: 'claude-haiku-4-5-20251001-thinking', name: 'Claude · claude-haiku-4-5-20251001-thinking' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude · claude-sonnet-4-5-20250929' },
  { id: 'claude-sonnet-4-5-20250929-thinking', name: 'Claude · claude-sonnet-4-5-20250929-thinking' },
  { id: 'claude-sonnet-4-6', name: 'Claude · claude-sonnet-4-6' },
  { id: 'claude-3-7-sonnet-20250219-thinking', name: 'Claude · claude-3-7-sonnet-20250219-thinking' },
  { id: 'claude-opus-4.1', name: 'Claude · claude-opus-4.1' },
  { id: 'claude-opus-4', name: 'Claude · claude-opus-4' },
  { id: 'claude-sonnet-4', name: 'Claude · claude-sonnet-4' },
  { id: 'claude-haiku-4', name: 'Claude · claude-haiku-4' },
  { id: 'claude-3.7-sonnet', name: 'Claude · claude-3.7-sonnet' },
  { id: 'claude-3.5-sonnet', name: 'Claude · claude-3.5-sonnet' },
  { id: 'claude-3.5-haiku', name: 'Claude · claude-3.5-haiku' },

  // DeepSeek
  { id: 'deepseek-v4-pro', name: 'DeepSeek · deepseek-v4-pro' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek · deepseek-v4-flash' },
  { id: 'deepseek-ocr', name: 'DeepSeek · deepseek-ocr' },
  { id: 'deepseek-v3.2-exp', name: 'DeepSeek · deepseek-v3.2-exp' },
  { id: 'deepseek-v3.1-terminus', name: 'DeepSeek · deepseek-v3.1-terminus' },
  { id: 'deepseek-v3.2', name: 'DeepSeek · deepseek-v3.2' },
  { id: 'deepseek-r1-250528', name: 'DeepSeek · deepseek-r1-250528' },
  { id: 'deepseek-v3-0324', name: 'DeepSeek · deepseek-v3-0324' },
  { id: 'deepseek-r1', name: 'DeepSeek · deepseek-r1' },
  { id: 'deepseek-r1-0528', name: 'DeepSeek · deepseek-r1-0528' },
  { id: 'deepseek-v3', name: 'DeepSeek · deepseek-v3' },
  { id: 'deepseek-v3.1', name: 'DeepSeek · deepseek-v3.1' },
  { id: 'deepseek-chat', name: 'DeepSeek · deepseek-chat' },
  { id: 'deepseek-reasoner', name: 'DeepSeek · deepseek-reasoner' },

  // Kimi
  { id: 'kimi-k2', name: 'Kimi · kimi-k2' },
  { id: 'kimi-k2-turbo', name: 'Kimi · kimi-k2-turbo' },
  { id: 'kimi-k2-0905', name: 'Kimi · kimi-k2-0905' },
  { id: 'kimi-k2.5', name: 'Kimi · kimi-k2.5' },
  { id: 'moonshot-v1-8k', name: 'Kimi · moonshot-v1-8k' },
  { id: 'moonshot-v1-32k', name: 'Kimi · moonshot-v1-32k' },
  { id: 'moonshot-v1-128k', name: 'Kimi · moonshot-v1-128k' },

  // Qwen
  { id: 'qwen-max', name: 'Qwen · qwen-max' },
  { id: 'qwen-plus', name: 'Qwen · qwen-plus' },
  { id: 'qwen-turbo', name: 'Qwen · qwen-turbo' },
  { id: 'qwen3-235b-a22b', name: 'Qwen · qwen3-235b-a22b' },
  { id: 'qwen3-32b', name: 'Qwen · qwen3-32b' },
  { id: 'qwen3-14b', name: 'Qwen · qwen3-14b' },
  { id: 'qwen3-8b', name: 'Qwen · qwen3-8b' },
  { id: 'qwen2.5-72b-instruct', name: 'Qwen · qwen2.5-72b-instruct' },
  { id: 'qwen2.5-32b-instruct', name: 'Qwen · qwen2.5-32b-instruct' },
  { id: 'qwen2.5-14b-instruct', name: 'Qwen · qwen2.5-14b-instruct' },
  { id: 'qwen2.5-7b-instruct', name: 'Qwen · qwen2.5-7b-instruct' },

  // GLM
  { id: 'glm-5', name: 'GLM · glm-5' },
  { id: 'glm-4.5', name: 'GLM · glm-4.5' },
  { id: 'glm-4.5-air', name: 'GLM · glm-4.5-air' },
  { id: 'glm-4-plus', name: 'GLM · glm-4-plus' },
  { id: 'glm-4-air', name: 'GLM · glm-4-air' },
  { id: 'glm-4-flash', name: 'GLM · glm-4-flash' },

  // MiniMax
  { id: 'minimax-m2', name: 'MiniMax · minimax-m2' },
  { id: 'minimax-m2-pro', name: 'MiniMax · minimax-m2-pro' },
  { id: 'minimax-m2.5', name: 'MiniMax · minimax-m2.5' },
  { id: 'minimax-text-01', name: 'MiniMax · minimax-text-01' },

  // Grok
  { id: 'grok-4', name: 'Grok · grok-4' },
  { id: 'grok-3', name: 'Grok · grok-3' },
  { id: 'grok-3-mini', name: 'Grok · grok-3-mini' },
  { id: 'grok-2', name: 'Grok · grok-2' },

  // Mistral
  { id: 'mistral-large-latest', name: 'Mistral · mistral-large-latest' },
  { id: 'mistral-medium-latest', name: 'Mistral · mistral-medium-latest' },
  { id: 'mistral-small-latest', name: 'Mistral · mistral-small-latest' },
  { id: 'codestral-latest', name: 'Mistral · codestral-latest' },

  // Llama
  { id: 'llama-3.3-70b-instruct', name: 'Llama · llama-3.3-70b-instruct' },
  { id: 'llama-3.1-405b-instruct', name: 'Llama · llama-3.1-405b-instruct' },
  { id: 'llama-3.1-70b-instruct', name: 'Llama · llama-3.1-70b-instruct' },
  { id: 'llama-3.1-8b-instruct', name: 'Llama · llama-3.1-8b-instruct' },

  // Other useful models
  { id: 'doubao-pro-32k', name: 'Doubao · doubao-pro-32k' },
  { id: 'doubao-lite-32k', name: 'Doubao · doubao-lite-32k' },
  { id: 'yi-large', name: 'Yi · yi-large' },
  { id: 'yi-medium', name: 'Yi · yi-medium' },
  { id: 'hunyuan-turbo', name: 'Hunyuan · hunyuan-turbo' },
  { id: 'hunyuan-large', name: 'Hunyuan · hunyuan-large' }
];

const APIMART_CHAT_MARKETPLACE_URL = 'https://api.apimart.ai/api/marketplace/models';
const APIMART_CHAT_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
let apimartLiveChatModels = [];
let apimartChatModelsUpdatedAt = 0;
let apimartChatModelsRefreshPromise = null;
let apimartChatModelsLastError = '';

function chatModelFamily(id = '', vendor = '') {
  const model = String(id || '').toLowerCase();
  if (/^(gpt-|chatgpt-|o\d)/.test(model)) return 'GPT';
  if (model.startsWith('gemini-')) return 'Gemini';
  if (model.startsWith('claude-')) return 'Claude';
  if (model.startsWith('deepseek-')) return 'DeepSeek';
  if (/^(kimi-|moonshot-)/.test(model)) return 'Kimi';
  if (model.startsWith('qwen')) return 'Qwen';
  if (model.startsWith('glm-')) return 'GLM';
  if (model.startsWith('minimax-')) return 'MiniMax';
  if (model.startsWith('grok-')) return 'Grok';
  if (/^(mistral-|codestral-)/.test(model)) return 'Mistral';
  if (model.startsWith('llama-')) return 'Llama';
  return String(vendor || 'Other').trim() || 'Other';
}

function normalizeMarketplaceChatModels(rows = []) {
  const familyOrder = ['GPT','Gemini','Claude','DeepSeek','Kimi','Qwen','GLM','MiniMax','Grok','Mistral','Llama','Other'];
  const unique = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.model_name || row?.id || '').trim();
    if (!id || String(row?.media_type || 'chat').toLowerCase() !== 'chat' || /^text-embedding/i.test(id)) continue;
    const family = chatModelFamily(id, row?.vendor?.name || '');
    unique.set(id.toLowerCase(), {
      id,
      name:`${family} · ${id}`,
      family,
      created_at:Number(row?.created_at || 0)
    });
  }
  return [...unique.values()]
    .sort((a, b) => {
      const aGroup = familyOrder.indexOf(a.family);
      const bGroup = familyOrder.indexOf(b.family);
      const groupDiff = (aGroup < 0 ? familyOrder.length : aGroup) - (bGroup < 0 ? familyOrder.length : bGroup);
      if (groupDiff) return groupDiff;
      if (b.created_at !== a.created_at) return b.created_at - a.created_at;
      return a.id.localeCompare(b.id);
    })
    .map(({id, name}) => ({id, name}));
}

async function refreshApimartChatModels(proxyUrl = '', force = false) {
  if (!force && apimartLiveChatModels.length && Date.now() - apimartChatModelsUpdatedAt < APIMART_CHAT_CATALOG_TTL_MS) {
    return apimartLiveChatModels;
  }
  if (apimartChatModelsRefreshPromise) return apimartChatModelsRefreshPromise;
  apimartChatModelsRefreshPromise = (async () => {
    const first = await getJson(`${APIMART_CHAT_MARKETPLACE_URL}?type=chat&page_size=100&page=1`, '', proxyUrl);
    const firstData = first?.data || {};
    const rows = Array.isArray(firstData.models) ? [...firstData.models] : [];
    const pageCount = Math.max(1, Math.min(5, Math.ceil(Number(firstData.total || rows.length) / 100)));
    if (pageCount > 1) {
      const rest = await Promise.all(Array.from({length:pageCount - 1}, (_, i) =>
        getJson(`${APIMART_CHAT_MARKETPLACE_URL}?type=chat&page_size=100&page=${i + 2}`, '', proxyUrl)
      ));
      for (const page of rest) rows.push(...(Array.isArray(page?.data?.models) ? page.data.models : []));
    }
    const normalized = normalizeMarketplaceChatModels(rows);
    if (!normalized.length) throw new Error('APIMart 聊天模型目录为空');
    apimartLiveChatModels = normalized;
    apimartChatModelsUpdatedAt = Date.now();
    apimartChatModelsLastError = '';
    return apimartLiveChatModels;
  })().catch(err => {
    apimartChatModelsLastError = String(err?.message || err || 'unknown_error');
    return apimartLiveChatModels.length ? apimartLiveChatModels : APIMART_RESPONSE_CHAT_MODELS;
  }).finally(() => { apimartChatModelsRefreshPromise = null; });
  return apimartChatModelsRefreshPromise;
}

function getApimartChatModels(proxyUrl = '') {
  const stale = !apimartLiveChatModels.length || Date.now() - apimartChatModelsUpdatedAt >= APIMART_CHAT_CATALOG_TTL_MS;
  if (stale && !apimartChatModelsRefreshPromise) refreshApimartChatModels(proxyUrl).catch(()=>{});
  return {
    models:apimartLiveChatModels.length ? apimartLiveChatModels : APIMART_RESPONSE_CHAT_MODELS,
    source:apimartLiveChatModels.length ? 'apimart_marketplace' : 'built_in',
    refreshing:!!apimartChatModelsRefreshPromise,
    updated_at:apimartChatModelsUpdatedAt || null,
    error:apimartChatModelsLastError
  };
}

function responseTextBlockTypeForRole(role) {
  // APIMart /v1/responses follows OpenAI Responses content rules:
  // user/system/developer messages use input_text; assistant history must use output_text/refusal.
  // Sending assistant history as input_text causes invalid_value: supported values are output_text/refusal.
  return String(role || '').toLowerCase() === 'assistant' ? 'output_text' : 'input_text';
}

function normalizeResponseContent(content, role = 'user') {
  const textType = responseTextBlockTypeForRole(role);
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (!part) continue;
      if (typeof part === 'string') { blocks.push({ type: textType, text: part }); continue; }
      const type = String(part.type || '').toLowerCase();
      if (type === 'refusal' && textType === 'output_text') {
        const text = part.text ?? part.content ?? part.refusal ?? '';
        if (String(text).length) blocks.push({ type: 'refusal', refusal: String(text) });
      } else if (type === 'output_text' || type === 'input_text' || type === 'text') {
        const text = part.text ?? part.content ?? '';
        if (String(text).length) blocks.push({ type: textType, text: String(text) });
      } else if (type === 'input_image' || type === 'image_url') {
        // Assistant history cannot contain input_image. Drop old image blocks for assistant messages.
        if (textType === 'output_text') continue;
        let imageUrl = '';
        if (typeof part.image_url === 'string') imageUrl = part.image_url;
        else if (part.image_url && typeof part.image_url === 'object') imageUrl = part.image_url.url || part.image_url.image_url || '';
        else imageUrl = part.url || '';
        if (imageUrl) blocks.push({ type: 'input_image', image_url: String(imageUrl) });
      }
    }
    return blocks.length ? blocks : [{ type: textType, text: '' }];
  }
  return [{ type: textType, text: String(content ?? '') }];
}

function messagesToResponsesInput(messages = []) {
  const input = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg) continue;
    const rawRole = String(msg.role || '').toLowerCase();
    const role = ['system', 'developer', 'assistant', 'user'].includes(rawRole) ? rawRole : 'user';
    input.push({ role, content: normalizeResponseContent(msg.content, role) });
  }
  return input.length ? input : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }];
}

function pickResponseText(data) {
  const root = data?.data || data || {};
  const found = [];
  const addText = (v) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'string') { if (v.trim()) found.push(v.trim()); return; }
    if (Array.isArray(v)) { v.forEach(addText); return; }
    if (typeof v === 'object') {
      if (typeof v.text === 'string') addText(v.text);
      else if (typeof v.content === 'string') addText(v.content);
    }
  };

  // Fast paths for common OpenAI-compatible shapes.
  addText(root.output_text);
  addText(data?.output_text);
  addText(root.choices?.[0]?.message?.content);
  addText(data?.choices?.[0]?.message?.content);

  // APIMart Responses actual shape often is:
  // data.output = [{type:'reasoning',...}, {type:'message', content:[{type:'output_text', text:'...'}]}]
  const output = root.output || data?.output || [];
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item) continue;
      if (String(item.type || '').toLowerCase() === 'message') addText(item.content);
      else if (Array.isArray(item.content)) addText(item.content);
    }
  }

  // Last resort: recursively search for output_text blocks only, not the whole raw JSON.
  const seen = new Set();
  const walk = (x) => {
    if (!x || found.length || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if (String(x.type || '').toLowerCase() === 'output_text' && typeof x.text === 'string') addText(x.text);
    if (Array.isArray(x)) { for (const it of x) walk(it); return; }
    for (const key of ['output','content','message','messages','data','result']) walk(x[key]);
  };
  walk(root);

  return found.join('\n').trim();
}

function normalizeChatCompletionContent(content) {
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (!part) continue;
      if (typeof part === 'string') { blocks.push({ type:'text', text: part }); continue; }
      const type = String(part.type || '').toLowerCase();
      if (type === 'input_text' || type === 'output_text' || type === 'text') {
        const text = part.text ?? part.content ?? '';
        if (String(text).length) blocks.push({ type:'text', text:String(text) });
      } else if (type === 'input_image' || type === 'image_url') {
        let url = '';
        if (typeof part.image_url === 'string') url = part.image_url;
        else if (part.image_url && typeof part.image_url === 'object') url = part.image_url.url || part.image_url.image_url || '';
        else url = part.url || '';
        if (url) blocks.push({ type:'image_url', image_url:{ url:String(url) } });
      }
    }
    return blocks.length ? blocks : '';
  }
  return String(content ?? '');
}

function messagesToChatCompletionsMessages(messages = []) {
  const out = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg) continue;
    const rawRole = String(msg.role || '').toLowerCase();
    const role = ['system','developer','assistant','user'].includes(rawRole) ? (rawRole === 'developer' ? 'system' : rawRole) : 'user';
    const content = normalizeChatCompletionContent(msg.content);
    if (Array.isArray(content) && !content.length) continue;
    if (typeof content === 'string' && !content.trim()) continue;
    out.push({ role, content });
  }
  return out.length ? out : [{ role:'user', content:'' }];
}

function pickChatCompletionText(data) {
  const root = data?.data || data || {};
  const found = [];
  const addText = (v) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'string') { if (v.trim()) found.push(v.trim()); return; }
    if (Array.isArray(v)) { v.forEach(addText); return; }
    if (typeof v === 'object') {
      if (typeof v.content === 'string') addText(v.content);
      else if (typeof v.text === 'string') addText(v.text);
    }
  };
  addText(root.choices?.[0]?.message?.content);
  addText(data?.choices?.[0]?.message?.content);
  addText(root.output_text);
  addText(data?.output_text);
  addText(root.response);
  addText(root.result?.content);
  addText(root.result?.text);
  addText(root.candidates?.[0]?.content?.parts?.map(p=>p.text).filter(Boolean).join('\n'));
  if (!found.length && Array.isArray(root.output)) {
    for (const item of root.output) {
      if (String(item?.type || '').toLowerCase() === 'message') addText(item.content);
      else if (Array.isArray(item?.content)) addText(item.content);
    }
  }
  const seen = new Set();
  const walk = (x) => {
    if (!x || found.length || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if (String(x.type || '').toLowerCase() === 'output_text' && typeof x.text === 'string') addText(x.text);
    if (Array.isArray(x)) { for (const it of x) walk(it); return; }
    for (const key of ['choices','message','content','candidates','parts','output','data','result','response']) walk(x[key]);
  };
  walk(root);
  return [...new Set(found.map(text => String(text || '').trim()).filter(Boolean))].join('\n').trim();
}

function normalizeApimartTextBase(input){
  let s = String(input || 'https://api.apimart.ai').trim();
  if (/docs\.apimart\.ai/i.test(s)) return 'https://api.apimart.ai';
  if (/api\.apimart\.ai/i.test(s)) return 'https://api.apimart.ai';
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/v1\/responses.*$/i, '');
  s = s.replace(/\/v1\/chat\/completions.*$/i, '');
  return cleanBase(s || 'https://api.apimart.ai');
}


function pickChatStreamText(text=''){
  const lines = String(text || '').split(/\r?\n/);
  const chunks = [];
  for (const line of lines) {
    const m = line.match(/^\s*data:\s*(.*)\s*$/);
    if(!m) continue;
    const data = m[1].trim();
    if(!data || data === '[DONE]') continue;
    try{
      const j = JSON.parse(data);
      const delta = j?.choices?.[0]?.delta?.content || j?.choices?.[0]?.message?.content || j?.delta?.content || j?.content || '';
      if(delta) chunks.push(delta);
    }catch(_e){}
  }
  if(chunks.length) return chunks.join('');
  try{
    const j = JSON.parse(String(text || ''));
    return pickChatCompletionText(j) || pickResponseText(j) || '';
  }catch(_e){}
  return '';
}

async function postChatStreamText(url, apiKey, payload){
  const errors = [];
  const proxies = getProxyCandidates('');
  for (const proxy of proxies) {
    try{
      const args = ['-sS','-L','--connect-timeout','4','--max-time','180'];
      if (proxy) args.push('--proxy', proxy);
      args.push('-X','POST', url, '-H','Accept: text/event-stream', '-H',`Authorization: Bearer ${apiKey || ''}`, '-H','Content-Type: application/json', '--data-binary', '@-');
      const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';
      const r = await runProcessAsync(exe, args, { timeoutMs: 185000 }, JSON.stringify(payload || {}));
      if(r.status !== 0) throw new Error((r.stderr || r.stdout || '').slice(0,800));
      markGoodProxy(proxy);
      return r.stdout || '';
    }catch(e){ errors.push(`[${proxy}] ${e.message || e}`); }
  }
  try{
    const res = await fetchNoSingleTimeout(url, {method:'POST', headers:{'Content-Type':'application/json','Accept':'text/event-stream','Authorization':apiKey ? `Bearer ${apiKey}` : ''}, body:JSON.stringify(payload || {})});
    return await res.text();
  }catch(e){ errors.push('fetch直连失败：' + (e.message || e)); }
  throw new Error('APIMart Stream 请求失败：' + errors.join(' | '));
}

function applyChatOptions(payload, options = {}, model = ''){
  const out = {...payload};
  const addNum = (key) => {
    if(typeof options[key] === 'undefined' || options[key] === '' || options[key] === null) return;
    const n = Number(options[key]);
    if(Number.isFinite(n)) out[key] = n;
  };
  addNum('max_tokens');
  addNum('temperature');
  addNum('top_p');
  addNum('presence_penalty');
  addNum('frequency_penalty');
  const m = String(model || '').toLowerCase();
  if(!/^(gpt-|o\d|chatgpt-)/i.test(m)) addNum('top_k');
  return out;
}

async function chatCompletion({ baseUrl, apiKey, model, messages = [], stream = false, options = {} }) {
  const base = normalizeApimartTextBase(baseUrl);
  const payload = applyChatOptions({
    model: model || 'gpt-5.5',
    messages: messagesToChatCompletionsMessages(messages),
    stream: !!stream
  }, options, model || 'gpt-5.5');
  if (payload.stream) {
    const rawText = await postChatStreamText(base + '/v1/chat/completions', apiKey, payload);
    const content = pickChatStreamText(rawText);
    return { raw: { stream_text: rawText.slice(0, 2000) }, content, endpoint: '/v1/chat/completions', model: payload.model, stream: true };
  }
  const data = await postJson(base + '/v1/chat/completions', apiKey, payload);
  assertApimartCode200(data, 'APIMart Chat Completions');
  const content = pickChatCompletionText(data);
  return { raw: data, content, endpoint: '/v1/chat/completions', model: payload.model, stream: false };
}

async function grsaiTool({ baseUrl, apiKey, action, model, extra = {}, queryApiKey = '' }) {
  const base = cleanBase(baseUrl);
  if (action === 'model_status') {
    return getJson(`${base}/client/common/getModelStatus?model=${encodeURIComponent(model || '')}`, apiKey);
  }
  const map = {
    account_credits: '/client/openapi/getCredits',
    api_key_credits: '/client/openapi/getAPIKeyCredits',
    create_api_key: '/client/openapi/createAPIKey',
    update_api_key: '/client/openapi/updateAPIKeyInfo',
    delete_api_key: '/client/openapi/deleteAPIKey'
  };
  const path = map[action];
  if (!path) throw new Error('unknown action');
  let payload = { ...extra };
  if (action === 'api_key_credits') {
    payload = { apiKey: queryApiKey || apiKey, api_key: queryApiKey || apiKey, key: queryApiKey || apiKey };
  }
  return postJson(base + path, apiKey, payload);
}

module.exports = { generateOne, grsaiTool, chatCompletion, APIMART_RESPONSE_CHAT_MODELS, getApimartChatModels, refreshApimartChatModels, sizeToAspect, resolveModelSize, GPT_IMAGE_2_VIP_SIZES, GPT_IMAGE_2_SIZES, APIMART_IMAGE_MODELS, APIMART_MODEL_RULES, getApimartImageRule };
