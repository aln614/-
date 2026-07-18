const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const zlib = require('zlib');
const { app, BrowserWindow, Tray, shell, Menu, clipboard, nativeImage, ipcMain, globalShortcut } = require('electron');
const { spawn } = require('child_process');
const { initDB, getDB, addLog, listBatches, listImages, listLogs, nowISO, uuid, setNetworkTimeOffset, getNetworkTimeInfo } = require('./services/db');
const { TaskQueue } = require('./services/taskQueue');
const { grsaiTool, chatCompletion, getApimartChatModels, refreshApimartChatModels } = require('./services/apiClient');
const { safeName, ensureDir, makeDirs, createThumb, downloadToFile } = require('./services/cache');

let mainWindow = null;
let server = null;
let queue = null;
let configPath = null;
let currentPort = 7860;
let activeOpenAppShortcut = '';
let isAppQuitting = false;
let tray = null;
let lastMidjourneyImageRepairAt = 0;
let tunnelProcess = null;
let tunnelState = { running: false, provider: '', url: '', logs: [], last_error: '' };
const staticDir = path.join(__dirname, 'renderer');
const SERVER_ONLY = process.env.LAIG_SERVER_ONLY === '1' || process.env.LAIG_DOCKER === '1';
const JSON_BODY_LIMIT_BYTES = Number(process.env.LAIG_JSON_BODY_LIMIT_MB || 64) * 1024 * 1024;
const MEDIA_BODY_LIMIT_BYTES = Number(process.env.LAIG_MEDIA_BODY_LIMIT_MB || 1536) * 1024 * 1024;
const STATUS_CACHE_TTL_MS = 1800;
const HOST_STATS_CACHE_TTL_MS = 8000;
const STALE_CLEANUP_TTL_MS = 15000;
const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
const APP_DISPLAY_NAME = 'TENYING_AI 1.0';
const OUTPUT_ROOT_NAME = 'TENYING_AI_1_0';
const OUTPUT_ZIP_DIR_NAME = 'TENYING_AI_1_0_Zips';
const OUTPUT_WORD_DIR_NAME = 'TENYING_AI_1_0_Word';
const OUTPUT_EXCEL_DIR_NAME = 'TENYING_AI_1_0_Excel';
const OUTPUT_MJ_DIR_NAME = 'TENYING_AI_1_0_Midjourney';
const OUTPUT_RUNTIME_DATA_DIR_NAME = '运行数据目录';
const LEGACY_OUTPUT_RUNTIME_DATA_DIR_NAME = '.TENYING_AI_RuntimeData';
const DEFAULT_UPDATE_REPO = 'aln614/-';
const DEFAULT_SHORTCUT_SETTINGS = Object.freeze({
  open_app: 'Ctrl+Alt+A',
  toggle_asset_library: 'Ctrl+Shift+A',
  toggle_prompt_library: 'Ctrl+Shift+P'
});
const BLOCKED_SHORTCUTS = new Set(['Ctrl+C','Ctrl+V','Ctrl+X','Ctrl+Z','Ctrl+S','Alt+F4','Ctrl+Alt+Delete']);
try { app.setAppUserModelId('com.local.api.image.generator.webui.v14_9_8'); } catch {}

// V7.4：清除软件所有数据会同时清除本机配置、API Key、浏览器本地缓存和运行数据。
// 旧版本都用了相同 productName，Windows 会复用 %APPDATA%\本地调用api生成，
// 所以打包成功后第一次打开会把旧批次/旧图片又加载回来。
const DATA_ROOT = process.env.LOCAL_API_IMAGE_GENERATOR_DATA_DIR || path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'LocalApiImageGenerator_RuntimeData_V1498'
);
try { app.setPath('userData', DATA_ROOT); } catch {}


const RESET_MARKER = path.join(os.tmpdir(), 'LocalApiImageGenerator_full_reset_v1498.json');
const LEGACY_RESTORE_BLOCK_MARKER = path.join(DATA_ROOT, 'data', 'skip_legacy_restore.json');
const PREVIEW_IMAGE_DEFAULT_MAX_DIM = 2200;
const PREVIEW_IMAGE_MAX_WORKERS = Math.max(1, Math.min(2, os.cpus().length || 2));
const LOCAL_HOT_CACHE_ROOT = process.env.TENYING_AI_LOCAL_HOT_CACHE_DIR || path.join(
  process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'TENYING_AI',
  'HotCache'
);
const LOCAL_HOT_CACHE_MAX_BYTES = Math.max(512, Number(process.env.TENYING_AI_LOCAL_HOT_CACHE_MB || 4096)) * 1024 * 1024;
const LOCAL_HOT_CACHE_FILE_MAX_BYTES = Math.max(8, Number(process.env.TENYING_AI_LOCAL_HOT_CACHE_FILE_MB || 80)) * 1024 * 1024;
const LOCAL_HOT_CACHE_VIDEO_FILE_MAX_BYTES = Math.max(64, Number(process.env.TENYING_AI_LOCAL_HOT_CACHE_VIDEO_MB || 1024)) * 1024 * 1024;
const LOCAL_HOT_CACHE_WORKERS = Math.max(1, Math.min(2, Number(process.env.TENYING_AI_LOCAL_HOT_CACHE_WORKERS || 1)));
let previewImageActiveWorkers = 0;
const previewImageQueue = [];
const previewImageInflight = new Map();
let hotCacheActiveWorkers = 0;
let hotCacheLastTrimAt = 0;
const hotCacheQueue = [];
const hotCacheInflight = new Map();

function clampPreviewImageMaxDim(value) {
  const n = Number(value || PREVIEW_IMAGE_DEFAULT_MAX_DIM);
  if (!Number.isFinite(n)) return PREVIEW_IMAGE_DEFAULT_MAX_DIM;
  return Math.max(600, Math.min(3600, Math.round(n)));
}
function previewImageCacheDir() {
  return ensureDir(path.join(LOCAL_HOT_CACHE_ROOT, 'preview_images'));
}
function previewImageWorkerScriptPath() {
  return path.join(LOCAL_HOT_CACHE_ROOT, 'preview_worker.ps1');
}
function ensurePreviewImageWorkerScript() {
  const file = previewImageWorkerScriptPath();
  ensureDir(path.dirname(file));
  const script = `
param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Dest,
  [int]$MaxDim = ${PREVIEW_IMAGE_DEFAULT_MAX_DIM}
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$srcFull = [System.IO.Path]::GetFullPath($Source)
$destFull = [System.IO.Path]::GetFullPath($Dest)
$destDir = [System.IO.Path]::GetDirectoryName($destFull)
if (-not [System.IO.Directory]::Exists($destDir)) { [System.IO.Directory]::CreateDirectory($destDir) | Out-Null }
$fs = [System.IO.File]::Open($srcFull, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
$img = $null
$bmp = $null
$g = $null
try {
  $img = [System.Drawing.Image]::FromStream($fs, $false, $false)
  $w = [double]$img.Width
  $h = [double]$img.Height
  if ($w -lt 1 -or $h -lt 1) { throw 'Invalid image size' }
  $scale = [Math]::Min(1.0, [Math]::Min(([double]$MaxDim / $w), ([double]$MaxDim / $h)))
  $nw = [Math]::Max(1, [int][Math]::Round($w * $scale))
  $nh = [Math]::Max(1, [int][Math]::Round($h * $scale))
  $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($img, 0, 0, $nw, $nh)
  $bmp.Save($destFull, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  if ($g -ne $null) { $g.Dispose() }
  if ($bmp -ne $null) { $bmp.Dispose() }
  if ($img -ne $null) { $img.Dispose() }
  if ($fs -ne $null) { $fs.Dispose() }
}
`.trim();
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== script) fs.writeFileSync(file, script, 'utf8');
  } catch {
    fs.writeFileSync(file, script, 'utf8');
  }
  return file;
}
function previewImageCachePath(filePath, maxDim) {
  const stat = fs.statSync(filePath);
  const key = crypto.createHash('sha1').update([filePath, stat.size, maxDim, 'v4'].join('|')).digest('hex');
  return path.join(previewImageCacheDir(), `${key}.png`);
}
function runPreviewImageQueue() {
  while (previewImageActiveWorkers < PREVIEW_IMAGE_MAX_WORKERS && previewImageQueue.length) {
    const job = previewImageQueue.shift();
    previewImageActiveWorkers++;
    job.fn().then(job.resolve, job.reject).finally(() => {
      previewImageActiveWorkers--;
      runPreviewImageQueue();
    });
  }
}
function enqueuePreviewImageJob(key, fn) {
  if (previewImageInflight.has(key)) return previewImageInflight.get(key);
  const promise = new Promise((resolve, reject) => {
    previewImageQueue.push({ fn, resolve, reject });
    runPreviewImageQueue();
  }).finally(() => previewImageInflight.delete(key));
  previewImageInflight.set(key, promise);
  return promise;
}
function generatePreviewImageInWorker(filePath, outPath, maxDim) {
  return new Promise((resolve, reject) => {
    const script = ensurePreviewImageWorkerScript();
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, filePath, outPath, String(maxDim)], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('预览图后台处理超时'));
    }, 120000);
    child.stderr.on('data', b => { stderr += b.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
      else reject(new Error(stderr.trim() || `预览图后台处理失败：${code}`));
    });
  });
}
function ensurePreviewImage(filePath, maxDim) {
  const outPath = previewImageCachePath(filePath, maxDim);
  if (fs.existsSync(outPath)) return Promise.resolve(outPath);
  const key = `${filePath}|${maxDim}`;
  return enqueuePreviewImageJob(key, async () => {
    if (fs.existsSync(outPath)) return outPath;
    await generatePreviewImageInWorker(filePath, outPath, maxDim);
    return outPath;
  });
}
function localHotMediaCacheDir() {
  return ensureDir(path.join(LOCAL_HOT_CACHE_ROOT, 'media'));
}
function hotCacheKey(filePath, version = 'path-v1') {
  return crypto.createHash('sha1').update([filePath, version].join('|')).digest('hex');
}
function localHotMediaCachePath(filePath) {
  const ext = (path.extname(filePath) || '.bin').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
  return path.join(localHotMediaCacheDir(), `${hotCacheKey(filePath)}${ext}`);
}
function shouldHotCacheMedia(filePath, stat, type) {
  if (!filePath || !stat || !stat.isFile || !stat.isFile()) return false;
  const mime = type || contentType(filePath);
  const isImage = /^image\//i.test(mime);
  const isVideo = /^video\//i.test(mime);
  if (!isImage && !isVideo) return false;
  const maxBytes = isVideo ? LOCAL_HOT_CACHE_VIDEO_FILE_MAX_BYTES : LOCAL_HOT_CACHE_FILE_MAX_BYTES;
  if (stat.size <= 0 || stat.size > maxBytes) return false;
  return true;
}
function hotCacheAwaitMs(filePath, stat) {
  const p = String(filePath || '').toLowerCase();
  if (p.includes(`${path.sep}_thumbs${path.sep}`) || p.includes('/_thumbs/')) return 1600;
  if (/\.(mp4|mov|webm|m4v)$/i.test(p)) return stat.size <= 64 * 1024 * 1024 ? 1800 : 450;
  if (stat.size <= 8 * 1024 * 1024) return 900;
  return 0;
}
function runHotCacheQueue() {
  while (hotCacheActiveWorkers < LOCAL_HOT_CACHE_WORKERS && hotCacheQueue.length) {
    const job = hotCacheQueue.shift();
    hotCacheActiveWorkers++;
    job.fn().then(job.resolve, job.reject).finally(() => {
      hotCacheActiveWorkers--;
      runHotCacheQueue();
    });
  }
}
function enqueueHotCacheJob(key, fn) {
  if (hotCacheInflight.has(key)) return hotCacheInflight.get(key);
  const promise = new Promise((resolve, reject) => {
    hotCacheQueue.push({ fn, resolve, reject });
    runHotCacheQueue();
  }).finally(() => hotCacheInflight.delete(key));
  hotCacheInflight.set(key, promise);
  return promise;
}
async function copyFileToLocalHotCache(filePath, outPath) {
  ensureDir(path.dirname(outPath));
  const tmp = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.copyFile(filePath, tmp);
    await fs.promises.rename(tmp, outPath).catch(async () => {
      await fs.promises.copyFile(tmp, outPath);
      await fs.promises.unlink(tmp).catch(()=>{});
    });
    return outPath;
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch {}
    throw e;
  }
}
function trimLocalHotCacheSoon() {
  const now = Date.now();
  if (now - hotCacheLastTrimAt < 5 * 60 * 1000) return;
  hotCacheLastTrimAt = now;
  setTimeout(async () => {
    try {
      const files = [];
      const walk = async (dir) => {
        let entries = [];
        try { entries = await fs.promises.readdir(dir, { withFileTypes:true }); } catch { return; }
        for (const entry of entries) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(p);
            continue;
          }
          let st = null;
          try { st = await fs.promises.stat(p); } catch { continue; }
          files.push({ path:p, size:st.size, time:Math.max(st.atimeMs || 0, st.mtimeMs || 0) });
        }
      };
      await walk(LOCAL_HOT_CACHE_ROOT);
      let total = files.reduce((sum, f) => sum + f.size, 0);
      if (total <= LOCAL_HOT_CACHE_MAX_BYTES) return;
      files.sort((a,b)=>a.time-b.time);
      for (const f of files) {
        if (total <= LOCAL_HOT_CACHE_MAX_BYTES * 0.82) break;
        try { await fs.promises.unlink(f.path); total -= f.size; } catch {}
      }
    } catch {}
  }, 1000).unref?.();
}
function ensureLocalHotMedia(filePath, stat, type) {
  if (!shouldHotCacheMedia(filePath, stat, type)) return Promise.resolve('');
  const outPath = localHotMediaCachePath(filePath);
  try {
    if (fs.existsSync(outPath)) {
      fs.utimes(outPath, new Date(), new Date(), ()=>{});
      return Promise.resolve(outPath);
    }
  } catch {}
  const key = `media|${filePath}|${stat.size}`;
  return enqueueHotCacheJob(key, async () => {
    if (fs.existsSync(outPath)) return outPath;
    const ret = await copyFileToLocalHotCache(filePath, outPath);
    trimLocalHotCacheSoon();
    return ret;
  });
}
function scheduleLocalHotMedia(filePath) {
  const value = String(filePath || '').trim();
  if (!value || /^https?:/i.test(value) || /^data:/i.test(value)) return;
  enqueueHotCacheJob(`stat|${value}`, async () => {
    let st = null;
    try { st = await fs.promises.stat(value); } catch { return ''; }
    const type = contentType(value);
    if (!shouldHotCacheMedia(value, st, type)) return '';
    const outPath = localHotMediaCachePath(value);
    if (fs.existsSync(outPath)) return outPath;
    const ret = await copyFileToLocalHotCache(value, outPath);
    trimLocalHotCacheSoon();
    return ret;
  }).catch(()=>{});
}
function warmLocalHotCacheForImageRows(rows = [], opts = {}) {
  const picked = [];
  for (const row of rows.slice(0, 48)) {
    if (row && row.thumb_path) picked.push(row.thumb_path);
  }
  const fullLimit = opts.preloadFull === false ? 0 : 6;
  for (const row of rows.slice(0, fullLimit)) {
    if (row && row.file_path) picked.push(row.file_path);
  }
  Array.from(new Set(picked.filter(Boolean))).forEach(scheduleLocalHotMedia);
}
function warmLocalHotCacheForVideoRows(rows = []) {
  const picked = [];
  for (const row of rows.slice(0, 10)) {
    if (row && row.file_path) picked.push(row.file_path);
  }
  Array.from(new Set(picked.filter(Boolean))).forEach(scheduleLocalHotMedia);
}
function getLegacyDataRoots() {
  const appDataRoot = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const roots = [
    DATA_ROOT,
    path.join(appDataRoot, '本地调用api生成'),
    path.join(appDataRoot, 'LocalApiImageGenerator'),
    path.join(appDataRoot, 'local-api-image-generator-webui'),
    path.join(appDataRoot, 'LocalApiImageGenerator_RuntimeData'),
    path.join(appDataRoot, 'LocalApiImageGenerator_RuntimeData_V65'),
    path.join(appDataRoot, 'LocalApiImageGenerator_RuntimeData_V70'),
    path.join(appDataRoot, 'LocalApiImageGenerator_RuntimeData_V1498'),
    path.join(appDataRoot, 'LocalApiImageGenerator_RuntimeData_V90')
  ];
  // V9.1: 自动扫描所有历史 RuntimeData 目录，避免脚本只清固定版本导致旧缓存残留。
  try {
    if (fs.existsSync(appDataRoot)) {
      for (const name of fs.readdirSync(appDataRoot)) {
        if (/^LocalApiImageGenerator_RuntimeData/i.test(name)) roots.push(path.join(appDataRoot, name));
      }
    }
  } catch {}
  return [...new Set(roots)];
}
function removePathSafe(p) {
  try {
    if (!p || !fs.existsSync(p)) return false;
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    return true;
  } catch { return false; }
}
function hardResetDataDirsBeforeInit() {
  if (!fs.existsSync(RESET_MARKER)) return false;
  const targets = new Set([DATA_ROOT]);
  targets.add(path.join(app.getPath('pictures'), OUTPUT_ROOT_NAME));
  targets.add(path.join(app.getPath('downloads'), OUTPUT_ZIP_DIR_NAME));
  targets.add(path.join(app.getPath('downloads'), OUTPUT_WORD_DIR_NAME));
  targets.add(path.join(app.getPath('downloads'), OUTPUT_EXCEL_DIR_NAME));
  targets.add(path.join(app.getPath('pictures'), OUTPUT_MJ_DIR_NAME));
  targets.add(path.join(app.getPath('pictures'), 'LocalApiImageGenerator_V14_10_15'));
  targets.add(path.join(app.getPath('downloads'), 'LocalApiImageGenerator_V14_10_15_Zips'));
  for (const t of targets) removePathSafe(t);
  try {
    fs.mkdirSync(path.dirname(LEGACY_RESTORE_BLOCK_MARKER), { recursive:true });
    fs.writeFileSync(LEGACY_RESTORE_BLOCK_MARKER, JSON.stringify({ at:new Date().toISOString(), reason:'manual_clear_all_data' }, null, 2), 'utf8');
  } catch {}
  try { fs.rmSync(RESET_MARKER, { force: true }); } catch {}
  return true;
}
function readStoreSummary(storeFile) {
  try {
    if (!storeFile || !fs.existsSync(storeFile)) return null;
    const stat = fs.statSync(storeFile);
    const data = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    const count = ['batches','tasks','images','video_tasks'].reduce((sum, key) => sum + (Array.isArray(data[key]) ? data[key].length : 0), 0);
    return { file:storeFile, data, count, size:stat.size, mtime:stat.mtimeMs };
  } catch {
    return null;
  }
}
function compactOutputRootFromPath(filePath = '') {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  let dir = raw;
  try {
    const ext = path.extname(raw);
    dir = ext ? path.dirname(raw) : raw;
    if (path.basename(dir).toLowerCase() === '_thumbs') dir = path.dirname(dir);
    const base = path.basename(dir);
    if (/^(Batch|MJ|Video)_/i.test(base)) dir = path.dirname(dir);
    return path.resolve(dir);
  } catch {
    return '';
  }
}
function collectOutputRootsFromStoreData(data = {}) {
  const roots = new Set();
  const addPath = (p) => {
    const root = compactOutputRootFromPath(p);
    if (root && !roots.has(root) && fs.existsSync(root)) roots.add(root);
  };
  for (const b of Array.isArray(data.batches) ? data.batches : []) addPath(b.output_dir || '');
  for (const img of Array.isArray(data.images) ? data.images : []) {
    addPath(img.file_path || '');
    addPath(img.thumb_path || '');
  }
  for (const t of Array.isArray(data.tasks) ? data.tasks : []) {
    addPath(t.result_path || '');
    addPath(t.thumb_path || '');
    addPath(t.mj_grid_local_path || '');
  }
  for (const v of Array.isArray(data.video_tasks) ? data.video_tasks : []) {
    addPath(v.file_path || '');
    addPath(v.thumb_path || '');
  }
  return Array.from(roots);
}
function collectOutputRootsFromStoreFile(storeFile = '') {
  const summary = readStoreSummary(storeFile);
  return summary ? collectOutputRootsFromStoreData(summary.data) : [];
}
function rememberHistoricalOutputRootsFromStoreData(data = {}) {
  const roots = collectOutputRootsFromStoreData(data);
  if (!roots.length || !configPath) return roots;
  try {
    const cfg = readConfig();
    const existing = Array.isArray(cfg.legacy_output_dirs) ? cfg.legacy_output_dirs : [];
    const merged = Array.from(new Set([...existing, ...roots].map(r => path.resolve(r)).filter(Boolean)));
    if (merged.length !== existing.length || merged.some((r, i) => r !== existing[i])) {
      saveConfig({ legacy_output_dirs: merged });
    }
  } catch {}
  return roots;
}
function rememberHistoricalOutputRootsFromStoreFile(storeFile = '') {
  const summary = readStoreSummary(storeFile);
  return summary ? rememberHistoricalOutputRootsFromStoreData(summary.data) : [];
}
function restoreStoreFromLegacyIfCurrentEmpty() {
  if (fs.existsSync(LEGACY_RESTORE_BLOCK_MARKER)) return false;
  const currentStore = path.join(DATA_ROOT, 'data', 'store.json');
  const current = readStoreSummary(currentStore);
  if (current && current.count > 0) return false;

  const candidates = [];
  for (const root of getLegacyDataRoots()) {
    const file = path.join(root, 'data', 'store.json');
    if (path.resolve(file) === path.resolve(currentStore)) continue;
    const summary = readStoreSummary(file);
    if (summary && summary.count > 0) candidates.push(summary);
  }
  candidates.sort((a, b) => (b.count - a.count) || (b.mtime - a.mtime) || (b.size - a.size));
  const best = candidates[0];
  if (!best) return false;

  fs.mkdirSync(path.dirname(currentStore), { recursive:true });
  if (fs.existsSync(currentStore)) {
    const backup = path.join(path.dirname(currentStore), `store.empty-before-restore-${Date.now()}.json`);
    try { fs.copyFileSync(currentStore, backup); } catch {}
  }
  const marker = path.join(DATA_ROOT, 'data', 'store_restore_marker.json');
  fs.copyFileSync(best.file, currentStore);
  rememberHistoricalOutputRootsFromStoreData(best.data);
  try {
    fs.writeFileSync(marker, JSON.stringify({
      restored_at: new Date().toISOString(),
      source: best.file,
      restored_count: best.count,
      reason: 'current_store_empty_after_update'
    }, null, 2), 'utf8');
  } catch {}
  return true;
}

const DEFAULT_CONFIG = {
  app_name: APP_DISPLAY_NAME,
  image_api_platform: 'apimart',
  api_endpoint: 'https://api.apimart.ai',
  legacy_api_endpoint: 'http://127.0.0.1:38000',
  api_key: '',
  model: 'gemini-3.1-flash-image-preview',
  chat_model: 'gpt-5.5',
  size: 'auto',
  clarity: '1K',
  quality: 'auto',
  background: 'auto',
  moderation: 'auto',
  output_format: 'png',
  output_compression: 90,
  image_n: 1,
  mask_url: '',
  theme_mode: 'auto',
  concurrency: 30,
  retry_times: 2,
  repeat_count: 1,
  poll_interval_ms: 1200,
  timeout_seconds: 1200,
  apimart_proxy_url: 'http://127.0.0.1:10808',
  background_keepalive: true,
  output_dir: '',
  log_keep_days: 3,
  lan_enabled: false,
  device_data_isolation: true,
  port: 7868,
  lan_ip_override: '',
  public_enabled: false,
  public_provider: 'cloudflare',
  public_url: '',
  public_password: '',
  public_permission: 'generate',
  public_remember_days: 7,
  prompt_multiline_tasks: true,
  prompt_library_permission_shared: false,
  cloudflared_path: 'cloudflared',
  ngrok_path: 'ngrok',
  announcement_url: 'https://apimart.ai/zh/log-updates',
  announcement_custom_title: '',
  announcement_custom_content: '',
  announcement_custom_items: [],
  announcement_custom_enabled: false,
  asset_library_dir: '',
  legacy_output_dirs: [],
  shortcuts_enabled: true,
  shortcut_settings: { ...DEFAULT_SHORTCUT_SETTINGS },
  update_repo: DEFAULT_UPDATE_REPO,
  update_last_check: null
};


async function syncNetworkTime() {
  const sources = [
    { name:'Cloudflare-Date', url:'https://www.cloudflare.com/cdn-cgi/trace', type:'date-header' },
    { name:'Baidu-Date', url:'https://www.baidu.com/', type:'date-header' },
    { name:'WorldTimeAPI-Shanghai', url:'https://worldtimeapi.org/api/timezone/Asia/Shanghai', type:'worldtimeapi' },
    { name:'TimeAPI-Shanghai', url:'https://timeapi.io/api/Time/current/zone?timeZone=Asia/Shanghai', type:'timeapi' }
  ];
  for (const src of sources) {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 5000);
    try {
      const res = await fetch(src.url, { method:'GET', cache:'no-store', signal:controller.signal });
      let serverMs = 0;
      if (src.type === 'date-header') {
        const dateHeader = res.headers.get('date');
        if (dateHeader) serverMs = Date.parse(dateHeader);
      } else if (src.type === 'worldtimeapi') {
        const j = await res.json();
        if (j.unixtime) serverMs = Number(j.unixtime) * 1000;
        else if (j.utc_datetime) serverMs = Date.parse(j.utc_datetime);
      } else if (src.type === 'timeapi') {
        const j = await res.json();
        if (j.year) serverMs = Date.UTC(Number(j.year), Number(j.month)-1, Number(j.day), Number(j.hour)-8, Number(j.minute), Number(j.seconds||0));
        else if (j.dateTime) serverMs = Date.parse(j.dateTime);
      }
      if (serverMs && !Number.isNaN(serverMs)) {
        const offset = serverMs - Date.now();
        setNetworkTimeOffset(offset, { source: src.name, server_time:new Date(serverMs).toISOString() });
        addLog(`网络时间同步成功：${src.name}，偏差 ${Math.round(offset/1000)} 秒`);
        return true;
      }
    } catch (e) {
      // try next source silently
    } finally { clearTimeout(timer); }
  }
  addLog('网络时间同步失败：使用本机时间', { level:'warn' });
  return false;
}
function startNetworkTimeSync() {
  syncNetworkTime().catch(()=>{});
  setInterval(()=>syncNetworkTime().catch(()=>{}), 10 * 60 * 1000);
}


function normalizeImageApiEndpoint(input) {
  let s = String(input || 'https://api.apimart.ai').trim();
  // V14.0: 修复 V13.9 白屏/主进程报错：main.js 调用了 normalizeImageApiEndpoint 但未定义。
  // APIMart 文档页统一转换为 APIMart API 根地址；本地 Flow2API 地址保持不变。
  if (!s) return 'https://api.apimart.ai';
  if (/docs\.apimart\.ai/i.test(s)) return 'https://api.apimart.ai';
  if (/api\.apimart\.ai/i.test(s)) return 'https://api.apimart.ai';
  if (/grsaiapi\.com|grsai\.dakka\.com\.cn/i.test(s)) return 'http://127.0.0.1:38000';
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/v1\/(images\/generations|tasks.*|uploads\/images).*$/i, '');
  return s || 'https://api.apimart.ai';
}

function normalizeShortcutAccelerator(value = '') {
  const parts = String(value || '').replace(/\s+/g, '').split('+').filter(Boolean);
  const modifiers = new Set();
  let key = '';
  for (const rawPart of parts) {
    const lower = rawPart.toLowerCase();
    if (lower === 'ctrl' || lower === 'control' || lower === 'controlorcommand' || lower === 'commandorcontrol') modifiers.add('Ctrl');
    else if (lower === 'alt' || lower === 'option') modifiers.add('Alt');
    else if (lower === 'shift') modifiers.add('Shift');
    else if (lower === 'cmd' || lower === 'command' || lower === 'meta' || lower === 'super') modifiers.add('Cmd');
    else {
      if (key) return '';
      if (/^[a-z]$/i.test(rawPart)) key = rawPart.toUpperCase();
      else if (/^[0-9]$/.test(rawPart)) key = rawPart;
      else if (/^f(?:[1-9]|1[0-2])$/i.test(rawPart)) key = rawPart.toUpperCase();
      else if (lower === 'delete' || lower === 'del') key = 'Delete';
      else return '';
    }
  }
  if (!key || !modifiers.size) return '';
  return ['Ctrl','Alt','Shift','Cmd'].filter(item => modifiers.has(item)).concat(key).join('+');
}

function validateShortcutConfiguration(input = {}, strict = false) {
  const enabled = input.shortcuts_enabled !== false;
  const source = input.shortcut_settings && typeof input.shortcut_settings === 'object' ? input.shortcut_settings : {};
  const settings = {};
  try {
    for (const key of Object.keys(DEFAULT_SHORTCUT_SETTINGS)) {
      const raw = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : (strict ? '' : DEFAULT_SHORTCUT_SETTINGS[key]);
      const normalized = normalizeShortcutAccelerator(raw);
      if (!normalized) throw new Error('快捷键必须包含修饰键，并使用字母、数字或 F1-F12。');
      if (BLOCKED_SHORTCUTS.has(normalized)) throw new Error(`${normalized} 是系统常用或高风险快捷键，请更换。`);
      settings[key] = normalized;
    }
    if (new Set(Object.values(settings)).size !== Object.keys(settings).length) throw new Error('三个快捷键不能重复，请重新设置。');
    return { shortcuts_enabled: enabled, shortcut_settings: settings, repaired: false };
  } catch (error) {
    if (strict) throw error;
    return { shortcuts_enabled: true, shortcut_settings: { ...DEFAULT_SHORTCUT_SETTINGS }, repaired: true };
  }
}

function bringMainWindowToFront() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.setSkipTaskbar(false); } catch {}
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  if (typeof mainWindow.moveTop === 'function') mainWindow.moveTop();
  mainWindow.focus();
  try {
    mainWindow.setAlwaysOnTop(true, 'floating');
    const releaseTopTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    }, 180);
    if (typeof releaseTopTimer.unref === 'function') releaseTopTimer.unref();
  } catch {}
}

function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.setSkipTaskbar(true); } catch {}
  mainWindow.hide();
}

function toggleMainWindowFromShortcut() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) hideMainWindowToTray();
  else bringMainWindowToFront();
}

function createTray() {
  if (SERVER_ONLY || tray) return;
  const iconPath = path.join(__dirname, '..', 'assets', 'rocket.ico');
  tray = new Tray(iconPath);
  tray.setToolTip(readConfig().app_name || APP_DISPLAY_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label:'打开主窗口', click:bringMainWindowToFront },
    { label:'隐藏到托盘', click:hideMainWindowToTray },
    { type:'separator' },
    { label:'退出程序', click:()=>{ isAppQuitting = true; app.quit(); } }
  ]));
  tray.on('click', bringMainWindowToFront);
  tray.on('double-click', bringMainWindowToFront);
}

function replaceOpenAppShortcut(accelerator = '') {
  if (SERVER_ONLY || !app.isReady()) return true;
  const next = String(accelerator || '').trim();
  if (next && next === activeOpenAppShortcut && globalShortcut.isRegistered(next)) return true;
  if (next) {
    try { if (!globalShortcut.register(next, toggleMainWindowFromShortcut)) return false; }
    catch { return false; }
  }
  if (activeOpenAppShortcut && activeOpenAppShortcut !== next) {
    try { globalShortcut.unregister(activeOpenAppShortcut); } catch {}
  }
  activeOpenAppShortcut = next;
  return true;
}

function registerConfiguredOpenAppShortcut() {
  const shortcutConfig = validateShortcutConfiguration(readConfig());
  const accelerator = shortcutConfig.shortcuts_enabled ? shortcutConfig.shortcut_settings.open_app : '';
  const ok = replaceOpenAppShortcut(accelerator);
  if (!ok) addLog(`全局快捷键注册失败：${accelerator} 已被系统或其他软件占用。`, { level:'warn' });
  return ok;
}

function initConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
}
function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const migrated = { ...raw };
    // 兼容 V5.4 的 camelCase 配置，界面仍然使用旧版 WebUI 的 snake_case 配置项。
    if (!migrated.app_name && raw.appName) migrated.app_name = raw.appName;
    if (!migrated.api_endpoint && raw.apiBaseUrl) migrated.api_endpoint = raw.apiBaseUrl;
    if (!migrated.api_key && raw.apiKey) migrated.api_key = raw.apiKey;
    if (!migrated.clarity && raw.imageSize) migrated.clarity = raw.imageSize;
    if (!migrated.theme_mode && raw.theme) migrated.theme_mode = raw.theme;
    if (!migrated.retry_times && raw.retryTimes) migrated.retry_times = raw.retryTimes;
    if (!migrated.repeat_count && raw.repeatCount) migrated.repeat_count = raw.repeatCount;
    if (!migrated.output_dir && raw.outputDir) migrated.output_dir = raw.outputDir;
    if (typeof migrated.background_keepalive === 'undefined' && typeof raw.keepAlive !== 'undefined') migrated.background_keepalive = raw.keepAlive;
    if (typeof migrated.lan_enabled === 'undefined' && typeof raw.lanEnabled !== 'undefined') migrated.lan_enabled = raw.lanEnabled;
    if (typeof migrated.device_data_isolation === 'undefined' && typeof raw.deviceDataIsolation !== 'undefined') migrated.device_data_isolation = raw.deviceDataIsolation;
    if (!migrated.port && raw.lanPort) migrated.port = raw.lanPort;
    const migratedFromGrsai = ['legacy','grsai'].includes(String(migrated.image_api_platform || '').toLowerCase()) || /grsaiapi\.com|grsai\.dakka\.com\.cn/i.test(String(migrated.api_endpoint || ''));
    if (migratedFromGrsai) {
      migrated.image_api_platform = 'flow2api';
      migrated.api_endpoint = 'http://127.0.0.1:38000';
      migrated.legacy_api_endpoint = 'http://127.0.0.1:38000';
      migrated.api_key = '';
      migrated.model = 'gemini-3.1-flash-image';
    }
    if (/grsaiapi\.com|grsai\.dakka\.com\.cn/i.test(String(migrated.api_endpoint || ''))) migrated.api_endpoint = 'http://127.0.0.1:38000';
    if (!migrated.api_endpoint) migrated.api_endpoint = migrated.image_api_platform === 'flow2api' ? 'http://127.0.0.1:38000' : 'https://api.apimart.ai';
    migrated.api_endpoint = normalizeImageApiEndpoint(migrated.api_endpoint);
    if (!migrated.model || ['gpt-image-2-vip','nano-banana-pro','nano-banana-2','nano-banana-pro-vt','nano-banana-fast','nano-banana-2-cl','nano-banana-pro-cl','nano-banana'].includes(String(migrated.model || '').toLowerCase())) migrated.model = migrated.image_api_platform === 'flow2api' ? 'gemini-3.1-flash-image' : 'gemini-3.1-flash-image-preview';
    if (migrated.image_api_platform === 'flow2api') {
      migrated.model = String(migrated.model || '').toLowerCase().startsWith('gemini-3.0-pro-image') ? 'gemini-3.0-pro-image' : 'gemini-3.1-flash-image';
      if (String(migrated.api_key || '').trim() === 'laig-flow2api-local-2026') migrated.api_key = '';
    }
    // V14.7.3: AI聊天接口使用 APIMart 通用对话 /v1/chat/completions，保留用户选择的 GPT/Gemini 等语言模型。
    if (!migrated.chat_model) migrated.chat_model = 'gpt-5.5';
    // V14.5.0：用户电脑直连 api.apimart.ai:443 超时，已验证本机 HTTP 代理 10808 可通。
    // 这里不强制覆盖用户手动填写的代理，但空值会自动使用默认 10808；如果 10808 不通，请求层还会尝试其他常见端口。
    if (!String(migrated.apimart_proxy_url || '').trim()) migrated.apimart_proxy_url = DEFAULT_CONFIG.apimart_proxy_url;
    if ((!Array.isArray(migrated.announcement_custom_items) || !migrated.announcement_custom_items.length) && (migrated.announcement_custom_title || migrated.announcement_custom_content)) {
      migrated.announcement_custom_items = [{ title: migrated.announcement_custom_title || '', tag: '自定义', content: migrated.announcement_custom_content || '' }];
    }
    migrated.legacy_output_dirs = Array.isArray(migrated.legacy_output_dirs)
      ? Array.from(new Set(migrated.legacy_output_dirs.map(r => String(r || '').trim()).filter(Boolean)))
      : [];
    const shortcutConfig = validateShortcutConfiguration(migrated);
    migrated.shortcuts_enabled = shortcutConfig.shortcuts_enabled;
    migrated.shortcut_settings = shortcutConfig.shortcut_settings;
    delete migrated.repaired;
    if (SERVER_ONLY) {
      if (!String(migrated.output_dir || '').trim()) migrated.output_dir = process.env.LAIG_OUTPUT_DIR || '/data/output';
      if (!String(migrated.asset_library_dir || '').trim() && process.env.LAIG_ASSET_DIR) migrated.asset_library_dir = process.env.LAIG_ASSET_DIR;
      if (process.env.PORT) migrated.port = Number(process.env.PORT) || migrated.port || DEFAULT_CONFIG.port;
      migrated.lan_enabled = typeof process.env.LAIG_LAN_ENABLED === 'undefined'
        ? true
        : (process.env.LAIG_LAN_ENABLED !== '0' && process.env.LAIG_LAN_ENABLED !== 'false');
      if (!String(process.env.APIMART_PROXY_URL || '').trim() && (!String(raw.apimart_proxy_url || '').trim() || String(raw.apimart_proxy_url || '').trim() === DEFAULT_CONFIG.apimart_proxy_url)) migrated.apimart_proxy_url = '';
    }
    return { ...DEFAULT_CONFIG, ...migrated };
  }
  catch {
    const fallback = { ...DEFAULT_CONFIG };
    if (SERVER_ONLY) {
      fallback.output_dir = process.env.LAIG_OUTPUT_DIR || '/data/output';
      fallback.port = Number(process.env.PORT || fallback.port || 7868);
      fallback.lan_enabled = process.env.LAIG_LAN_ENABLED === '0' || process.env.LAIG_LAN_ENABLED === 'false' ? false : true;
      fallback.apimart_proxy_url = String(process.env.APIMART_PROXY_URL || '').trim();
    }
    return fallback;
  }
}
function saveConfig(partial) {
  const next = { ...readConfig(), ...partial };
  if (next.api_endpoint) next.api_endpoint = normalizeImageApiEndpoint(next.api_endpoint);
  next.announcement_url = normalizeAnnouncementUrl(next.announcement_url || DEFAULT_CONFIG.announcement_url);
  next.announcement_custom_title = String(next.announcement_custom_title || '').slice(0, 120);
  next.announcement_custom_content = String(next.announcement_custom_content || '').slice(0, 5000);
  next.announcement_custom_items = Array.isArray(next.announcement_custom_items) ? next.announcement_custom_items.map((item, idx)=>({
    title: String(item && item.title || '').slice(0,120),
    content: String(item && item.content || '').slice(0,5000),
    tag: String(item && item.tag || '自定义').slice(0,24),
    _id: String(item && item._id || `ann_${idx}`).slice(0,80)
  })).filter(item => item.title || item.content) : [];
  next.legacy_output_dirs = Array.isArray(next.legacy_output_dirs)
    ? Array.from(new Set(next.legacy_output_dirs.map(r => String(r || '').trim()).filter(Boolean)))
    : [];
  const shortcutConfig = validateShortcutConfiguration(next);
  next.shortcuts_enabled = shortcutConfig.shortcuts_enabled;
  next.shortcut_settings = shortcutConfig.shortcut_settings;
  delete next.repaired;
  next.announcement_custom_enabled = next.announcement_custom_enabled === true;
  if (!next.port) next.port = 7860;
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
  try { mirrorRuntimeDataToOutputDir(next, { configOnly: true }); } catch {}
  return next;
}
function cleanOwner(raw, isLocal) {
  if (isLocal) return 'local';
  return String(raw || 'lan_guest').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'lan_guest';
}
function headerFirst(value = '') {
  return String(value || '').split(',')[0].trim();
}
function forwardedHostName(req) {
  const fwd = String(req.headers.forwarded || '');
  const m = /(?:^|;)\s*host=([^;]+)/i.exec(fwd);
  return (m ? m[1] : '').replace(/^"|"$/g, '');
}
function hostName(req) {
  const raw = headerFirst(req.headers['x-forwarded-host']) || forwardedHostName(req) || String(req.headers.host || '');
  return String(raw || '').split(':')[0].toLowerCase();
}
function isLoopbackIP(req) {
  const ip = String(req.socket.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip.includes('127.0.0.1');
}
function isPrivateHostName(host = '') {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h);
}
function isLocalReq(req) {
  const host = hostName(req);
  const remote = String(req.socket.remoteAddress || '').replace('::ffff:', '');
  const localIP = getLocalIP();
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === localIP;
  if (!localHost) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return isLoopbackIP(req);
  // 本机通过 127.0.0.1 / localhost / 本机局域网IP 访问时，都视为本机管理端。
  // 其他局域网设备访问同一个 host 时，remoteAddress 会是对方设备IP，不会误判为本机。
  if (isLoopbackIP(req)) return true;
  return host === localIP && remote === localIP;
}
function isPublicHost(req, cfg) {
  const host = hostName(req);
  if (!host || isPrivateHostName(host)) return false;
  if (host === getLocalIP()) return false;
  return true;
}
function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
const publicAccessTokens = new Map();
function prunePublicAccessTokens() {
  const now = Date.now();
  for (const [token, expiresAt] of publicAccessTokens.entries()) {
    if (!expiresAt || expiresAt <= now) publicAccessTokens.delete(token);
  }
}
function issuePublicAccessToken(days = 7) {
  prunePublicAccessTokens();
  const ttl = Math.max(1, Number(days || 7)) * 24 * 60 * 60 * 1000;
  const token = 'pa_' + crypto.randomBytes(24).toString('hex');
  publicAccessTokens.set(token, Date.now() + ttl);
  return token;
}
function isValidPublicAccessToken(token = '') {
  const s = String(token || '').trim();
  if (!s) return false;
  prunePublicAccessTokens();
  const expiresAt = publicAccessTokens.get(s);
  return !!expiresAt && expiresAt > Date.now();
}
function hasPublicAccess(req, parsed, cfg) {
  if (!cfg.public_enabled) return false;
  const pass = String(cfg.public_password || '').trim();
  // V13.4：公网网页必须有访问密码；不能因为密码为空而直接放行。
  if (!pass) return false;
  const cookies = parseCookies(req);
  const got = String(req.headers['x-public-access'] || parsed.query.access || parsed.query.token || cookies.local_api_public_access || '').trim();
  return isValidPublicAccessToken(got) || got === pass;
}
function requestOrigin(req){
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (isPublicHost(req, readConfig()) ? 'https' : 'http');
  const host = headerFirst(req.headers['x-forwarded-host']) || forwardedHostName(req) || req.headers.host || '';
  return host ? `${proto}://${host}`.replace(/\/+$/,'') : '';
}
function isSameOriginRequest(req) {
  const raw = String(req.headers.origin || req.headers.referer || '').trim();
  if (!raw) return true;
  if (raw === 'null') return false;
  try {
    const got = new URL(raw);
    const host = headerFirst(req.headers['x-forwarded-host']) || forwardedHostName(req) || req.headers.host || '';
    if (!host) return false;
    const expected = new URL(`${got.protocol}//${host}`);
    return got.host.toLowerCase() === expected.host.toLowerCase();
  } catch {
    return false;
  }
}
function requiresSameOriginCheck(method = '') {
  return String(method || '').toUpperCase() !== 'OPTIONS';
}
function getOwner(req, parsed, cfg = readConfig()) {
  if (cfg.device_data_isolation === false) return 'shared';
  return cleanOwner(req.headers['x-laig-client-id'] || req.headers['x-client-id'] || parsed.query.client_id || parsed.query.owner || '', isLocalReq(req));
}
function getDeviceOwner(req, parsed) {
  // 实时面板统计始终按当前访问设备隔离：局域网/公网设备只看自己今日任务和最近批次。
  return cleanOwner(req.headers['x-laig-client-id'] || req.headers['x-client-id'] || parsed.query.client_id || parsed.query.owner || '', isLocalReq(req));
}
function configForClient(cfg, local, publicHost) {
  const out = { ...cfg };
  if (!local) {
    // 局域网/公网访问端必须手动填写本设备 API Key；绝不下发主机端 API Key。
    out.api_key = '';
    out.chat_api_key = '';
    out.apimart_api_key = '';
    // 访问端不能配置主机端公网/局域网/设置中心，也不下发主机端敏感配置。
    out.cloudflared_path = '';
    out.ngrok_path = '';
    out.public_password = '';
  }
  out.is_local_client = !!local;
  out.is_public_client = !!publicHost;
  out.device_data_isolation = cfg.device_data_isolation !== false;
  out.app_version = getAppVersion();
  out.local_runtime_data_dir = local ? DATA_ROOT : '';
  out.output_runtime_data_dir = local ? runtimeMirrorDir(cfg) : '';
  out.local_hot_cache_dir = local ? LOCAL_HOT_CACHE_ROOT : '';
  out.local_hot_cache_max_mb = local ? Math.round(LOCAL_HOT_CACHE_MAX_BYTES / 1024 / 1024) : 0;
  return out;
}
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return '127.0.0.1';
}
function urls(cfg) {
  const port = Number(cfg.port || 7861);
  const ip = cfg.lan_ip_override || getLocalIP();
  const pub = normalizeExternalPublicOrigin((cfg.public_url || tunnelState.url || '').trim());
  return { local_ip: ip, port, local_url: `http://127.0.0.1:${port}`, lan_url: `http://${ip}:${port}`, public_url: pub };
}
function toCamelConfig(cfg) {
  return {
    appName: cfg.app_name,
    imageApiPlatform: (['legacy','grsai','flow2api'].includes(String(cfg.image_api_platform||'').toLowerCase()) || /(?:127\.0\.0\.1|localhost):38000|grsaiapi\.com|grsai\.dakka\.com\.cn/i.test(cfg.api_endpoint||'') ? 'flow2api' : 'apimart'),
    apiBaseUrl: cfg.api_endpoint,
    legacyApiEndpoint: cfg.legacy_api_endpoint || 'http://127.0.0.1:38000',
    apiKey: cfg.api_key,
    model: cfg.model,
    size: cfg.size,
    imageSize: cfg.clarity || '1K',
    quality: cfg.quality || 'auto',
    background: cfg.background || 'auto',
    moderation: cfg.moderation || 'auto',
    outputFormat: cfg.output_format || 'png',
    outputCompression: cfg.output_compression || 90,
    imageN: Number(cfg.image_n || 1),
    maskUrl: cfg.mask_url || '',
    concurrency: Number(cfg.concurrency || 30),
    retryTimes: Number(cfg.retry_times || 2),
    repeatCount: Number(cfg.repeat_count || 1),
    outputDir: cfg.output_dir || '',
    theme: cfg.theme_mode || 'auto',
    keepAlive: cfg.background_keepalive !== false,
    pollIntervalMs: Number(cfg.poll_interval_ms || 1200),
    timeoutMs: Number(cfg.timeout_seconds || 1200) * 1000,
    thumbSize: 300,
    ownerId: 'local'
  };
}
function send(res, obj, code = 200, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = {...BASE_SECURITY_HEADERS, 'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin':'*', ...extraHeaders};
  const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(String(res.req?.headers?.['accept-encoding'] || ''));
  if (acceptsGzip && body.length >= 32 * 1024) {
    zlib.gzip(body, { level:zlib.constants.Z_BEST_SPEED }, (error, compressed) => {
      if (res.destroyed || res.writableEnded) return;
      if (!error && compressed) {
        res.writeHead(code, {...headers, 'Content-Encoding':'gzip', 'Vary':'Accept-Encoding', 'Content-Length':compressed.length});
        return res.end(compressed);
      }
      res.writeHead(code, {...headers, 'Content-Length':body.length});
      res.end(body);
    });
    return;
  }
  res.writeHead(code, {...headers, 'Content-Length':body.length});
  res.end(body);
}
function sendText(res, txt, type = 'text/plain; charset=utf-8', code = 200) {
  res.writeHead(code, {...BASE_SECURITY_HEADERS, 'Content-Type': type, 'Access-Control-Allow-Origin':'*'});
  res.end(txt);
}
function bodyLimitForRequest(req) {
  const p = url.parse(req.url || '', true).pathname || '';
  if ([
    '/api/batches',
    '/api/assets/upload',
    '/api/video_submit',
    '/api/video_batch_submit',
    '/api/mj_submit',
    '/api/grsai_tool'
  ].includes(p)) return MEDIA_BODY_LIMIT_BYTES;
  return JSON_BODY_LIMIT_BYTES;
}
function payloadTooLargeError(limitBytes) {
  const err = new Error(`请求体过大，最大允许 ${Math.round(limitBytes / 1024 / 1024)}MB`);
  err.statusCode = 413;
  return err;
}
function readBody(req, limitBytes = 0) {
  return new Promise((resolve, reject) => {
    const limit = Number(limitBytes || bodyLimitForRequest(req) || JSON_BODY_LIMIT_BYTES);
    const declared = Number(req.headers['content-length'] || 0);
    let tooLarge = declared > limit;
    let bytes = 0;
    const chunks = [];
    req.on('data', c => {
      bytes += c.length;
      if (tooLarge || bytes > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(Buffer.from(c));
    });
    req.on('end', () => {
      if (tooLarge) return reject(payloadTooLargeError(limit));
      try {
        const raw = chunks.length ? Buffer.concat(chunks, bytes).toString('utf8') : '';
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
function safeJoinStatic(p) {
  let clean = '';
  try { clean = decodeURIComponent(p === '/' ? '/index.html' : p).replace(/^\/+/, ''); }
  catch { return null; }
  const full = path.resolve(staticDir, clean);
  return isPathInside(staticDir, full) ? full : null;
}
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.svg' ? 'image/svg+xml' : ext === '.mp4' ? 'video/mp4' : ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : ext === '.m4v' ? 'video/x-m4v' : 'application/octet-stream';
}
function getAppVersion() {
  try { return app.getVersion() || require('../package.json').version || '0.0.0'; }
  catch { return '0.0.0'; }
}
function compareVersions(a = '', b = '') {
  const pa = String(a).replace(/^v/i,'').split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b).replace(/^v/i,'').split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
function normalizeUpdateRepo(input = '') {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\/github\.com\//i, '').replace(/^git@github\.com:/i, '').replace(/\.git$/i, '').replace(/\/+$/,'');
  const parts = s.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : s;
}
function updateCacheDir() {
  const dir = path.join(app.getPath('userData'), 'updates');
  ensureDir(dir);
  return dir;
}
let softwareUpdateRuntime = {
  state: 'idle',
  message: '',
  repo: '',
  version: '',
  asset_name: '',
  downloaded_path: '',
  bytes: 0,
  total: 0,
  progress: 0,
  started_at: '',
  updated_at: ''
};
function setSoftwareUpdateRuntime(patch = {}) {
  softwareUpdateRuntime = { ...softwareUpdateRuntime, ...patch, updated_at: nowISO() };
  try { saveConfig({ update_runtime: softwareUpdateRuntime }); } catch {}
  return softwareUpdateRuntime;
}
function getSoftwareUpdateStatus() {
  const cfg = readConfig();
  const runtime = cfg.update_runtime || softwareUpdateRuntime;
  if (['queued','downloading'].includes(runtime.state) && runtime.updated_at) {
    const ts = Date.parse(runtime.updated_at);
    if (Number.isFinite(ts) && Date.now() - ts > 10 * 60 * 1000) {
      return { ok:true, ...setSoftwareUpdateRuntime({ state:'failed', message:'更新下载长时间无进度，已停止。请重新点击更新。', progress:0 }), last_check: cfg.update_last_check || null };
    }
  }
  return { ok:true, ...runtime, last_check: cfg.update_last_check || null };
}
function httpJson(target, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(target, { timeout: timeoutMs, headers: { 'User-Agent':'LocalApiImageGenerator-Updater', 'Accept':'application/vnd.github+json' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return httpJson(r.headers.location, timeoutMs).then(resolve, reject);
      }
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', c => raw += c);
      r.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) {
          if (r.statusCode === 404) {
            return reject(new Error('GitHub 更新检查失败：未找到 Release。请确认仓库已公开、已创建 Release，并且 Release 中包含 Windows EXE 附件。'));
          }
          return reject(new Error(`GitHub 更新检查失败：HTTP ${r.statusCode}`));
        }
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub 更新检查超时')));
    req.on('error', reject);
  });
}
function downloadUrlToFile(target, dest, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dest));
    const file = fs.createWriteStream(dest);
    const lib = String(target).startsWith('https:') ? https : http;
    const req = lib.get(target, { timeout: timeoutMs, headers: { 'User-Agent':'LocalApiImageGenerator-Updater', 'Accept':'application/octet-stream' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume(); file.close(()=>{ try { fs.rmSync(dest, {force:true}); } catch {} });
        return downloadUrlToFile(r.headers.location, dest, timeoutMs).then(resolve, reject);
      }
      if (r.statusCode < 200 || r.statusCode >= 300) {
        r.resume(); file.close(()=>{ try { fs.rmSync(dest, {force:true}); } catch {} });
        return reject(new Error(`新版 EXE 下载失败：HTTP ${r.statusCode}`));
      }
      r.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('timeout', () => req.destroy(new Error('新版 EXE 下载超时')));
    req.on('error', e => { file.close(()=>{}); try { fs.rmSync(dest, {force:true}); } catch {}; reject(e); });
    file.on('error', reject);
  });
}
function downloadUrlToFileRobust(target, dest, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || 30 * 60 * 1000);
  const idleTimeoutMs = Number(opts.idleTimeoutMs || 120000);
  const redirectsLeft = Number.isFinite(opts.redirectsLeft) ? opts.redirectsLeft : 8;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dest));
    const tmp = `${dest}.part`;
    try { fs.rmSync(tmp, { force:true }); } catch {}
    const file = fs.createWriteStream(tmp);
    const lib = String(target).startsWith('https:') ? https : http;
    let req;
    const totalTimer = setTimeout(() => {
      try { req?.destroy(new Error('新版 EXE 下载超过 30 分钟，请检查网络后重试')); } catch {}
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(totalTimer);
      try { file.close(()=>{}); } catch {}
      try { fs.rmSync(tmp, { force:true }); } catch {}
    };
    req = lib.get(target, { headers:{ 'User-Agent':'LocalApiImageGenerator-Updater', 'Accept':'application/octet-stream' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        clearTimeout(totalTimer);
        file.close(()=>{ try { fs.rmSync(tmp, { force:true }); } catch {} });
        if (redirectsLeft <= 0) return reject(new Error('新版 EXE 下载重定向次数过多'));
        return downloadUrlToFileRobust(r.headers.location, dest, { ...opts, redirectsLeft:redirectsLeft - 1 }).then(resolve, reject);
      }
      if (r.statusCode < 200 || r.statusCode >= 300) {
        r.resume(); cleanup();
        return reject(new Error(`新版 EXE 下载失败：HTTP ${r.statusCode}`));
      }
      const total = Number(r.headers['content-length'] || 0);
      let bytes = 0;
      r.on('data', chunk => {
        bytes += chunk.length;
        if (onProgress) onProgress({ bytes, total });
      });
      r.pipe(file);
      file.on('finish', () => file.close(() => {
        clearTimeout(totalTimer);
        try {
          const stat = fs.statSync(tmp);
          if (!stat.size) throw new Error('新版 EXE 下载为空文件');
          fs.renameSync(tmp, dest);
          resolve(dest);
        } catch (e) {
          cleanup();
          reject(e);
        }
      }));
    });
    req.setTimeout(idleTimeoutMs, () => req.destroy(new Error('新版 EXE 下载长时间无数据响应，请稍后重试')));
    req.on('error', e => { cleanup(); reject(e); });
    file.on('error', e => { cleanup(); reject(e); });
  });
}
function downloadUrlToFileWithSystemCurl(target, dest, opts = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('system curl fast path is only enabled on Windows'));
    ensureDir(path.dirname(dest));
    const tmp = `${dest}.part`;
    try { fs.rmSync(tmp, { force:true }); } catch {}
    const args = ['-L', '--fail', '--retry', '2', '--retry-delay', '1', '--connect-timeout', '12', '--max-time', String(Math.ceil(Number(opts.timeoutMs || 6 * 60 * 1000) / 1000)), '--output', tmp, target];
    const child = spawn('curl.exe', args, { windowsHide:true, stdio:['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    let lastBytes = 0;
    let lastGrowAt = Date.now();
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const finishReject = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(progressTimer);
      try { child.kill(); } catch {}
      try { fs.rmSync(tmp, { force:true }); } catch {}
      reject(error);
    };
    const timer = setTimeout(() => {
      finishReject(new Error('系统下载器下载超时，切换内置下载'));
    }, Number(opts.timeoutMs || 6 * 60 * 1000));
    const progressTimer = setInterval(() => {
      let bytes = 0;
      try { bytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0; } catch {}
      if (bytes > lastBytes) { lastBytes = bytes; lastGrowAt = Date.now(); }
      if (onProgress) onProgress({ bytes, total:Number(opts.total || 0), source:'system' });
      if (Date.now() - lastGrowAt > Number(opts.idleTimeoutMs || 60000)) {
        finishReject(new Error('系统下载器长时间没有下载进度，切换内置下载'));
      }
    }, 1000);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', e => finishReject(e));
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(progressTimer);
      try {
        if (code !== 0) throw new Error((stderr || `curl exited with code ${code}`).slice(-600));
        const stat = fs.statSync(tmp);
        if (!stat.size) throw new Error('新版 EXE 下载为空文件');
        fs.renameSync(tmp, dest);
        resolve(dest);
      } catch (e) {
        try { fs.rmSync(tmp, { force:true }); } catch {}
        reject(e);
      }
    });
  });
}
function pickWindowsExeAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const exeAssets = assets
    .filter(a => /\.exe$/i.test(a.name || '') && (!a.state || a.state === 'uploaded') && Number(a.size || 0) > 0)
    .sort((a, b) => {
      const score = x => (/tenying|localapi|image|generator/i.test(x.name || '') ? 8 : 0) + (/win|windows/i.test(x.name || '') ? 4 : 0) + (/x64|portable/i.test(x.name || '') ? 2 : 0);
      return score(b) - score(a);
    });
  return exeAssets[0] || null;
}
async function checkSoftwareUpdate(repoInput = '', cfg = readConfig()) {
  const repo = normalizeUpdateRepo(repoInput || cfg.update_repo || DEFAULT_UPDATE_REPO);
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('请填写 GitHub 仓库，例如：aln614/-');
  const release = await httpJson(`https://api.github.com/repos/${repo}/releases/latest`);
  const version = String(release.tag_name || release.name || '').replace(/^v/i, '').trim();
  if (!version) throw new Error('GitHub Release 缺少可识别的版本号 tag');
  const asset = pickWindowsExeAsset(release);
  const current = getAppVersion();
  const hasUpdate = compareVersions(version, current) > 0;
  const updateReady = hasUpdate && !!(asset && asset.browser_download_url);
  const message = hasUpdate
    ? (updateReady ? '检测到新版本，可直接更新。' : '检测到新版本，但 GitHub Release 安装包还未上传完成，请稍后再检查。')
    : '当前已经是最新版本。';
  const info = {
    repo,
    current_version: current,
    latest_version: version,
    has_update: hasUpdate,
    update_ready: updateReady,
    update_status: updateReady ? 'ready' : (hasUpdate ? 'waiting_asset' : 'latest'),
    message,
    release_url: release.html_url || `https://github.com/${repo}/releases/latest`,
    notes: release.body || '',
    asset_name: asset ? asset.name : '',
    asset_url: asset ? asset.browser_download_url : '',
    asset_size: asset ? Number(asset.size || 0) : 0,
    checked_at: nowISO()
  };
  saveConfig({ update_repo: repo, update_last_check: info });
  return { ok:true, ...info };
}
async function downloadSoftwareUpdate(repoInput = '', cfg = readConfig()) {
  const info = await checkSoftwareUpdate(repoInput, cfg);
  if (!info.asset_url) throw new Error('最新 Release 没有找到 Windows EXE 附件，请先在 GitHub Release 上传单文件 EXE。');
  const assetName = path.basename(String(info.asset_name || `LocalApiImageGenerator-${info.latest_version}-win-x64.exe`));
  const dest = ensureInside(updateCacheDir(), path.join(updateCacheDir(), assetName));
  setSoftwareUpdateRuntime({ state:'downloading', message:'正在下载新版 EXE...', repo:info.repo, version:info.latest_version, asset_name:assetName, downloaded_path:'', bytes:0, total:info.asset_size || 0, progress:0, started_at:nowISO() });
  try {
    setSoftwareUpdateRuntime({ state:'downloading', message:'正在调用系统下载器下载新版 EXE...', progress:1 });
    await downloadUrlToFileWithSystemCurl(info.asset_url, dest, {
      timeoutMs: 6 * 60 * 1000,
      idleTimeoutMs: 60000,
      total: info.asset_size || 0,
      onProgress: p => {
        const total = p.total || info.asset_size || 0;
        const progress = total ? Math.max(1, Math.min(99, Math.round(p.bytes / total * 100))) : 1;
        setSoftwareUpdateRuntime({ state:'downloading', message:`正在调用系统下载器下载新版 EXE${total ? ` ${progress}%` : ''}`, bytes:p.bytes, total, progress });
      }
    });
  } catch (fastError) {
    addLog(`系统下载器失败，切换到内置下载：${fastError.message || fastError}`, { level:'warn' });
    setSoftwareUpdateRuntime({ state:'downloading', message:'系统下载器无进度，已切换到内置下载...', bytes:0, progress:1 });
    await downloadUrlToFileRobust(info.asset_url, dest, {
      onProgress: p => {
        const total = p.total || info.asset_size || 0;
        const progress = total ? Math.max(1, Math.min(99, Math.round(p.bytes / total * 100))) : 0;
        setSoftwareUpdateRuntime({ state:'downloading', message:`正在下载新版 EXE${total ? ` ${progress}%` : ''}`, bytes:p.bytes, total, progress });
      }
    });
  }
  const next = { ...info, downloaded_path: dest, downloaded_at: nowISO() };
  saveConfig({ update_repo: info.repo, update_last_check: next });
  setSoftwareUpdateRuntime({ state:'downloaded', message:'新版 EXE 下载完成，准备安装...', downloaded_path:dest, progress:100 });
  return { ok:true, ...next };
}
async function applyLatestSoftwareUpdate(repoInput = '', cfg = readConfig()) {
  const info = await checkSoftwareUpdate(repoInput, cfg);
  if (!info.has_update) return { ok:true, ...info, message:'当前已是最新版本' };
  if (!info.asset_url) throw new Error('最新 Release 没有找到 Windows EXE 附件，请先等待 GitHub Actions 构建完成。');
  if (softwareUpdateRuntime.state === 'downloading' || softwareUpdateRuntime.state === 'installing') {
    return { ok:true, ...info, update_runtime:softwareUpdateRuntime, message:'更新任务已经在后台运行，请等待完成。' };
  }
  setSoftwareUpdateRuntime({ state:'queued', message:'更新任务已排队，准备下载...', repo:info.repo, version:info.latest_version, asset_name:info.asset_name, bytes:0, total:info.asset_size || 0, progress:0, started_at:nowISO() });
  const nextCfg = readConfig();
  setImmediate(async () => {
    try {
      const downloaded = await downloadSoftwareUpdate(repoInput, nextCfg);
      setSoftwareUpdateRuntime({ state:'installing', message:'下载完成，正在替换并重启软件...', progress:100, downloaded_path:downloaded.downloaded_path || '' });
      installSoftwareUpdate(downloaded.downloaded_path || '', readConfig());
    } catch (e) {
      setSoftwareUpdateRuntime({ state:'failed', message:e.message || String(e), progress:0 });
      addLog(`软件更新失败：${e.message || e}`, { level:'error' });
    }
  });
  return { ok:true, ...info, message:'更新任务已在后台开始，下载完成后会自动替换并重启。' };
}
function installSoftwareUpdate(downloadedPath = '', cfg = readConfig()) {
  const file = String(downloadedPath || (cfg.update_last_check && cfg.update_last_check.downloaded_path) || '').trim();
  if (!file || !fs.existsSync(file)) throw new Error('未找到已下载的新版本 EXE');
  if (!app.isPackaged) throw new Error('当前是开发调试模式，不能覆盖安装；打包后的 EXE 才可以原地更新。');
  const updateFile = ensureInside(updateCacheDir(), file);
  if (path.extname(updateFile).toLowerCase() !== '.exe') throw new Error('更新文件必须是 EXE');
  const target = process.execPath;
  const bat = path.join(os.tmpdir(), `LAIG_update_${Date.now()}.bat`);
  const backup = path.join(updateCacheDir(), `backup_${path.basename(target)}`);
  const log = path.join(updateCacheDir(), 'last_update_install.log');
  const script = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal EnableExtensions EnableDelayedExpansion',
    `set "SRC=${updateFile}"`,
    `set "TARGET=${target}"`,
    `set "BACKUP=${backup}"`,
    `set "LOG=${log}"`,
    'echo [%date% %time%] updater started>"%LOG%"',
    'timeout /t 1 /nobreak >nul',
    'if exist "%TARGET%" copy /Y "%TARGET%" "%BACKUP%" >>"%LOG%" 2>&1',
    'set /a TRY=0',
    ':RETRY_COPY',
    'set /a TRY+=1',
    'copy /Y "%SRC%" "%TARGET%" >>"%LOG%" 2>&1',
    'if !ERRORLEVEL! EQU 0 goto LAUNCH_NEW',
    'if !TRY! GEQ 60 goto ROLLBACK',
    'timeout /t 1 /nobreak >nul',
    'goto RETRY_COPY',
    ':LAUNCH_NEW',
    'echo [%date% %time%] update copied after !TRY! tries>>"%LOG%"',
    'start "" "%TARGET%"',
    'timeout /t 2 /nobreak >nul',
    'del /f /q "%SRC%" >>"%LOG%" 2>&1',
    'del "%~f0"',
    'exit /b 0',
    ':ROLLBACK',
    'echo [%date% %time%] update failed, rolling back>>"%LOG%"',
    'if exist "%BACKUP%" copy /Y "%BACKUP%" "%TARGET%" >>"%LOG%" 2>&1',
    'start "" "%TARGET%"',
    'del "%~f0"',
    'exit /b 1'
  ].join('\r\n');
  fs.writeFileSync(bat, script, 'utf8');
  spawn('cmd.exe', ['/c', 'start', '', bat], { detached:true, stdio:'ignore', windowsHide:true }).unref();
  setTimeout(()=>app.quit(), 500);
  return { ok:true, message:'正在原地更新并重启软件...' };
}
function dataUrlToFile(item, owner) {
  if (!item) return '';
  if (typeof item === 'string' && fs.existsSync(item)) return item;
  if (!item.data || !String(item.data).startsWith('data:')) return '';
  const m = String(item.data).match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return '';
  const mime = m[1];
  const fallbackExt = mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : mime.includes('png') ? '.png' : mime.includes('mp4') ? '.mp4' : mime.includes('quicktime') ? '.mov' : mime.includes('webm') ? '.webm' : '.bin';
  const ext = (path.extname(item.name || '') || fallbackExt).toLowerCase();
  const dir = path.join(app.getPath('userData'), 'uploads', owner);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}
function normalizeBatch(b) {
  return { ...b, image_size: b.image_size || b.imageSize || '', note: b.note || '' };
}
function parseUTCDateLike(v) {
  if (!v) return null;
  const s = String(v).trim();
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}
function beijingDateKey(input = new Date()) {
  const d = input instanceof Date ? input : (parseUTCDateLike(input) || new Date(input));
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function formatBeijingTime(input = new Date()) {
  const d = input instanceof Date ? input : (parseUTCDateLike(input) || new Date(input));
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().replace('T', ' ').slice(0, 19);
}
function uniqueExistingPaths(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const p = String(item || '').trim();
    if (!p) continue;
    let key = '';
    try { key = pathKey(p); } catch { key = p.toLowerCase(); }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
function mediaSearchRootsForRow(row = {}, batch = {}) {
  const cfg = readConfig();
  const roots = [];
  const add = (p) => { if (p) roots.push(p); };
  add(batch.output_dir);
  add(cfg.output_dir);
  add(path.join(app.getPath('pictures'), OUTPUT_ROOT_NAME));
  add(path.join(app.getPath('pictures'), OUTPUT_MJ_DIR_NAME));
  if (Array.isArray(cfg.legacy_output_dirs)) cfg.legacy_output_dirs.forEach(add);
  try { historicalOutputRootsFromCurrentStore().forEach(add); } catch {}
  const filePath = String(row.file_path || row.thumb_path || '').trim();
  if (filePath) {
    add(path.dirname(filePath));
    add(path.dirname(path.dirname(filePath)));
  }
  return uniqueExistingPaths(roots).filter(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}
function findMediaPathByName(fileName = '', roots = [], thumb = false) {
  const name = String(fileName || '').trim();
  if (!name) return '';
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, name));
    candidates.push(path.join(root, '_thumbs', name));
    if (thumb && path.extname(name).toLowerCase() !== '.png') {
      candidates.push(path.join(root, '_thumbs', path.basename(name, path.extname(name)) + '.png'));
    }
  }
  for (const fp of candidates) {
    try { if (fp && fs.existsSync(fp)) return fp; } catch {}
  }
  return '';
}
function repairImageRowPaths(row = {}) {
  if (!row) return row;
  const st = getDB()._store;
  const batch = st.batches.find(b => b.id === row.batch_id) || {};
  const roots = mediaSearchRootsForRow(row, batch);
  const originalFile = String(row.file_path || '').trim();
  const originalThumb = String(row.thumb_path || '').trim();
  let filePath = originalFile && fs.existsSync(originalFile) ? originalFile : '';
  let thumbPath = originalThumb && fs.existsSync(originalThumb) ? originalThumb : '';
  if (!filePath) {
    const fileName = path.basename(originalFile || row.filename || row.remote_url || '');
    filePath = findMediaPathByName(fileName, roots, false);
  }
  if (!thumbPath) {
    const thumbName = path.basename(originalThumb || filePath || row.filename || '');
    thumbPath = findMediaPathByName(thumbName, roots, true);
  }
  if (!thumbPath && filePath) {
    const desired = path.join(path.dirname(filePath), '_thumbs', path.basename(filePath, path.extname(filePath)) + '.png');
    try {
      ensureDir(path.dirname(desired));
      createThumb(filePath, desired, 300);
      if (fs.existsSync(desired)) thumbPath = desired;
    } catch {}
  }
  let changed = false;
  if (filePath && filePath !== row.file_path) { row.file_path = filePath; changed = true; }
  if (thumbPath && thumbPath !== row.thumb_path) { row.thumb_path = thumbPath; changed = true; }
  if (changed) {
    try { getDB()._save(); } catch {}
  }
  return row;
}
let storeLookupCache = { tasksRef: null, batchesRef: null, tasksLen: -1, batchesLen: -1, tasksById: new Map(), batchesById: new Map() };
function storeLookups() {
  const st = getDB()._store;
  const tasks = st.tasks || [];
  const batches = st.batches || [];
  if (storeLookupCache.tasksRef !== tasks || storeLookupCache.batchesRef !== batches || storeLookupCache.tasksLen !== tasks.length || storeLookupCache.batchesLen !== batches.length) {
    storeLookupCache = {
      tasksRef: tasks,
      batchesRef: batches,
      tasksLen: tasks.length,
      batchesLen: batches.length,
      tasksById: new Map(tasks.map(t => [t.id, t])),
      batchesById: new Map(batches.map(b => [b.id, b]))
    };
  }
  return storeLookupCache;
}
function formatImage(row, opts = {}) {
  const fast = !!opts.fast;
  row = fast ? row : repairImageRowPaths(row);
  const remote = row.remote_url || row.result_url || '';
  const localFull = row.file_path && (fast || fs.existsSync(row.file_path)) ? `/file?path=${encodeURIComponent(row.file_path)}` : '';
  const localThumb = row.thumb_path && (fast || fs.existsSync(row.thumb_path)) ? `/file?path=${encodeURIComponent(row.thumb_path)}` : localFull;
  const lookups = storeLookups();
  const task = lookups.tasksById.get(row.task_id) || {};
  const batch = lookups.batchesById.get(row.batch_id) || {};
  let mjImages = [], mjButtons = [], mjExecutedButtons = [];
  try { mjImages = JSON.parse(task.mj_images_json || '[]') || []; } catch {}
  try { mjButtons = JSON.parse(task.mj_buttons_json || '[]') || []; } catch {}
  try { mjExecutedButtons = JSON.parse(task.mj_executed_buttons_json || '[]') || []; } catch {}
  return {
    ...row,
    missing: !(localFull || remote),
    url: localThumb || remote,
    thumb_url: localThumb || remote,
    full_url: localFull || remote,
    original_url: localFull || remote,
    remote_url: remote,
    filename: path.basename(row.file_path || '') || (row.mj_is_grid ? 'midjourney-grid.png' : 'midjourney-image.png'),
    prompt: task.prompt || '',
    model: batch.model || '',
    size: batch.size || '',
    image_size: batch.image_size || '',
    batch_name: batch.note || batch.name || '',
    generated_at: row.created_at || task.finished_at || '',
    status: task.status || '',
    progress: Number(task.progress || 0),
    progress_text: task.progress_text || '',
    task_id: task.remote_task_id || task.id || '',
    local_task_id: task.id || '',
    batch_id: batch.id || '',
    mj_source: row.mj_source || task.mj_source || '',
    mj_action: task.mj_action || '',
    mj_parent_task_id: task.mj_parent_task_id || '',
    mj_parent_remote_task_id: task.mj_parent_remote_task_id || '',
    mj_is_grid: !!row.mj_is_grid,
    mj_variant_index: Number(task.mj_variant_index || row.mj_variant_index || 0),
    mj_images: mjImages.map(item=>{
      const local = item.local_path && (!fast && fs.existsSync(item.local_path)) ? `/file?path=${encodeURIComponent(item.local_path)}` : '';
      return { ...item, full_url: local || item.remote_url || '', remote_url: item.remote_url || '' };
    }),
    mj_grid_remote_url: task.mj_grid_remote_url || '',
    mj_grid_local_url: !fast && task.mj_grid_local_path && fs.existsSync(task.mj_grid_local_path) ? `/file?path=${encodeURIComponent(task.mj_grid_local_path)}` : (task.mj_grid_remote_url || ''),
    mj_buttons: mjButtons,
    mj_executed_buttons: mjExecutedButtons,
    hidden_in_recent: !!row.hidden_in_recent
  };
}

let announcementCache = { ts: 0, data: null, key: '' };
function normalizeAnnouncementUrl(input='') {
  let s = String(input || '').trim();
  if (!s) s = DEFAULT_CONFIG.announcement_url;
  if (!/^https?:\/\//i.test(s)) s = DEFAULT_CONFIG.announcement_url;
  return s;
}
function decodeHtmlEntities(str='') {
  return String(str)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function announcementTextFromHtml(html='') {
  return decodeHtmlEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(h1|h2|h3|h4|p|div|section|article|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
  );
}
function parseAnnouncements(html='') {
  const text = announcementTextFromHtml(html);
  let lines = text.split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const apimartStart = lines.findIndex(x => /日志|更新|公告|通知|changelog|updates/i.test(x));
  if (apimartStart >= 0 && apimartStart < 12) lines = lines.slice(apimartStart + 1);
  const dateRe = /^(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}|\d{4}-\d{2}-\d{2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/;
  const navStop = new Set(['APIMart','Grsai','管理员','合作管理','用户信息','仪表板','模型列表','日志','充值','月结数据统计','订单','消耗查询','帮助中心','API Management','API Key','存储库','在线体验/文档','未登录','中文','English','首页','文档','价格','登录','注册']);
  const items = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    current.content = (current.content || '').replace(/\n{3,}/g, '\n\n').trim();
    if (current.title || current.content) items.push(current);
    current = null;
  };
  for (let i = 0; i < lines.length && items.length < 30; i++) {
    const line = lines[i];
    if (!line || navStop.has(line) || /^https?:\/\//.test(line)) continue;
    const dateMatch = line.match(dateRe);
    const looksTitle = /更新|上线|新增|修复|优化|公告|通知|模型|API|Video|Image|GPT|Seed|Sora|Nano|价格|计费|渠道|版本/i.test(line);
    if (dateMatch || (!current && looksTitle) || (current && looksTitle && current.content && current.content.length > 80)) {
      flush();
      current = { id: `${dateMatch ? dateMatch[0] : i}_${line}`.replace(/\s+/g, '_'), title: line.replace(dateRe, '').trim() || line, tag: dateMatch ? '更新' : '', content: '', date: dateMatch ? dateMatch[0] : '' };
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line;
    } else {
      current = { id: `notice_${i}_${line}`.replace(/\s+/g, '_'), title: line, tag: '', content: '', date: '' };
    }
  }
  flush();
  return items.slice(0, 30);
}
function customAnnouncementItems(cfg) {
  if (cfg.announcement_custom_enabled !== true) return [];
  const raw = Array.isArray(cfg.announcement_custom_items) && cfg.announcement_custom_items.length
    ? cfg.announcement_custom_items
    : [{ title: cfg.announcement_custom_title || '', content: cfg.announcement_custom_content || '', tag:'自定义' }];
  return raw.map((item, idx)=>({
    id: `custom_${idx}_${String(item?.title||'').slice(0,80)}_${String(item?.content||'').slice(0,80)}`.replace(/\s+/g, '_'),
    title: String(item?.title || '').trim() || `自定义公告 ${idx + 1}`,
    tag: String(item?.tag || '自定义').trim() || '自定义',
    content: String(item?.content || '').trim(),
    date: nowISO()
  })).filter(item => item.title || item.content);
}
async function getAnnouncements(force=false) {
  const cfg = readConfig();
  const sourceUrl = normalizeAnnouncementUrl(cfg.announcement_url);
  const cacheKey = `${sourceUrl}|${cfg.announcement_custom_enabled}|${JSON.stringify(cfg.announcement_custom_items || [])}|${cfg.announcement_custom_title}|${cfg.announcement_custom_content}`;
  const now = Date.now();
  if (!force && announcementCache.data && announcementCache.key === cacheKey && now - announcementCache.ts < 5 * 60 * 1000) return announcementCache.data;
  const customItems = customAnnouncementItems(cfg);
  try {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 2500);
    let html = '';
    try {
      const r = await fetch(sourceUrl, { headers: { 'User-Agent': 'LocalApiImageGenerator/14.6.4' }, signal: controller.signal });
      html = await r.text();
    } finally { clearTimeout(timer); }
    const remoteItems = parseAnnouncements(html).slice(0, 12);
    const items = [...customItems, ...remoteItems];
    const data = { ok: true, source_url: sourceUrl, fetched_at: nowISO(), latest: items[0] || null, items };
    announcementCache = { ts: now, key: cacheKey, data };
    return data;
  } catch (e) {
    const fallbackItems = customItems.length ? customItems : [
      { id:'apimart_updates_link', title:'APIMart 更新日志', tag:'链接', content:'公告远程读取较慢，已改为极速弹窗。点击“打开链接”查看完整更新日志。', date:nowISO(), link:sourceUrl }
    ];
    const data = { ok: !!fallbackItems.length, source_url: sourceUrl, fetched_at: nowISO(), error: e.message || String(e), latest: fallbackItems[0] || null, items: fallbackItems };
    announcementCache = { ts: now, key: cacheKey, data };
    return data;
  }
}


function ensureVideoStore() {
  const db = getDB();
  const st = db._store;
  let changed = false;
  if (!Array.isArray(st.video_tasks)) { st.video_tasks = []; changed = true; }
  if (!Array.isArray(st.public_videos)) { st.public_videos = []; changed = true; }
  if (changed) db._save();
  return st;
}
function cleanupStaleVideoTasks(owner = '') {
  const st = ensureVideoStore();
  const stuck = new Set(['等待提交', '提交中', '重试中']);
  const cutoff = Date.now() - 20 * 60 * 1000;
  let changed = false;
  for (const row of st.video_tasks || []) {
    if (owner && row.owner_id !== owner) continue;
    if (row.task_id || !stuck.has(String(row.status || ''))) continue;
    const ts = Date.parse(row.updated_at || row.created_at || '');
    if (!Number.isFinite(ts) || ts > cutoff) continue;
    row.status = '失败';
    row.progress_text = '提交超时，未收到远端 task_id';
    row.error_message = row.error_message || '任务长时间停留在提交中，且没有后端 task_id，已自动标记失败。请重新提交。';
    row.finished_at = nowISO();
    row.updated_at = nowISO();
    changed = true;
  }
  if (changed) getDB()._save();
  return changed;
}
function repairLegacyGeminiOmniVideoFailures() {
  const st = ensureVideoStore();
  let changed = false;
  for (const row of st.video_tasks || []) {
    if (String(row.model || '').toLowerCase() !== 'gemini-omni-flash-preview') continue;
    if (!/interaction status=failed/i.test(String(row.error_message || row.raw_error_message || ''))) continue;
    row.raw_error_message = row.raw_error_message || row.error_message;
    row.error_message = 'Gemini Omni Flash 上游交互失败：旧任务可能混用了“续写/延长”和“编辑原视频”指令，或携带了该模型不支持的 duration/size 参数。程序现已按官方接口修复，并会在失败重试时自动精简为纯视频编辑指令。';
    changed = true;
  }
  if (changed) getDB()._save();
  return changed;
}
function pickTaskIdFromApimart(obj={}) {
  const candidates = [];
  const push = v => { if (v !== undefined && v !== null && String(v).trim()) candidates.push(String(v).trim()); };
  push(obj.task_id); push(obj.taskId); push(obj.taskID); push(obj.post_id); push(obj.postId); push(obj.postID); push(obj.id);
  const data = obj && obj.data;
  if (Array.isArray(data)) {
    for (const item of data) {
      push(item && item.task_id); push(item && item.taskId); push(item && item.taskID); push(item && item.post_id); push(item && item.postId); push(item && item.postID); push(item && item.id);
      const nested = item && (item.task || item.result || item.data);
      if (nested && typeof nested === 'object') { push(nested.task_id); push(nested.taskId); push(nested.taskID); push(nested.post_id); push(nested.postId); push(nested.postID); push(nested.id); }
    }
  } else if (data && typeof data === 'object') {
    push(data.task_id); push(data.taskId); push(data.taskID); push(data.post_id); push(data.postId); push(data.postID); push(data.id);
    if (Array.isArray(data.tasks)) {
      for (const item of data.tasks) { push(item && item.task_id); push(item && item.taskId); push(item && item.taskID); push(item && item.post_id); push(item && item.postId); push(item && item.postID); push(item && item.id); }
    }
    const nested = data.task || data.result || data.data;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) { push(nested.task_id); push(nested.taskId); push(nested.taskID); push(nested.post_id); push(nested.postId); push(nested.postID); push(nested.id); }
  }
  // 优先使用 APIMart 标准 task_ 前缀，避免误把 request_id、trace_id 当成任务 ID。
  return candidates.find(x => /^task[-_]/i.test(x)) || candidates.find(x => /^post[-_]/i.test(x)) || candidates.find(x => /task|post/i.test(x)) || candidates[0] || '';
}
function pickApimartVideoUrls(status={}) {
  const out = [];
  const seen = new Set();
  const seenUrl = new Set();
  const isHttp = (s) => /^https?:\/\//i.test(String(s || ''));
  const isNonResultUrl = (s) => /\/v1\/tasks|\/v1\/videos|api\.apimart\.ai\/v1|docs\.apimart\.ai/i.test(String(s || ''));
  const looksVideo = (s, ctx='') => {
    const x = String(s || '');
    const c = String(ctx || '').toLowerCase();
    if (!isHttp(x) || isNonResultUrl(x)) return false;
    if (/\.(mp4|mov|webm|m4v|avi)(\?|#|$)/i.test(x)) return true;
    if (/video|media|result|output|download|remote|file|url|data|response|content|asset/i.test(c) && !/image_urls|input_image|source_image|prompt|thumbnail|cover/i.test(c)) return true;
    if (/result|output|download|remote|file|asset|response/i.test(c) && /cdn|storage|oss|cos|r2|cloudflare|apimart|openai|video|files|blob/i.test(x)) return true;
    return false;
  };
  const push = (s, ctx='') => {
    const u = String(s || '').trim().replace(/[\s"'<>]+$/g, '');
    if (!looksVideo(u, ctx)) return;
    if (!seenUrl.has(u)) { seenUrl.add(u); out.push(u); }
  };
  const extractUrlsFromString = (s, ctx='') => {
    const str = String(s || '');
    const re = /https?:\/\/[^\s"'<>\\]+/ig;
    let m;
    while ((m = re.exec(str))) push(m[0], ctx);
    const t = str.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try { add(JSON.parse(t), ctx + '.jsonString'); } catch {}
    }
  };
  const add = (v, ctx='') => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach((x,i)=>add(x, `${ctx}[${i}]`));
    if (typeof v === 'string') { push(v, ctx); extractUrlsFromString(v, ctx); return; }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    const type = String(v.type || v.kind || v.mime_type || v.content_type || '').toLowerCase();
    if (/video/.test(type)) add(v.url || v.video_url || v.output_url || v.download_url || v.file_url, ctx + '.typedVideo');
    add(v.video_url, ctx + '.video_url');
    add(v.video_urls, ctx + '.video_urls');
    add(v.video, ctx + '.video');
    add(v.videos, ctx + '.videos');
    add(v.media_url, ctx + '.media_url');
    add(v.media_urls, ctx + '.media_urls');
    add(v.output_url, ctx + '.output_url');
    add(v.output_urls, ctx + '.output_urls');
    add(v.result_url, ctx + '.result_url');
    add(v.download_url, ctx + '.download_url');
    add(v.download_urls, ctx + '.download_urls');
    add(v.remote_url, ctx + '.remote_url');
    add(v.file_url, ctx + '.file_url');
    add(v.file_urls, ctx + '.file_urls');
    add(v.url, ctx + '.url');
    add(v.urls, ctx + '.urls');
    add(v.link, ctx + '.link');
    add(v.href, ctx + '.href');
    add(v.asset_url, ctx + '.asset_url');
    add(v.content_url, ctx + '.content_url');
    add(v.result, ctx + '.result');
    add(v.response, ctx + '.response');
    add(v.output, ctx + '.output');
    add(v.outputs, ctx + '.outputs');
    add(v.results, ctx + '.results');
    add(v.files, ctx + '.files');
    add(v.file, ctx + '.file');
    add(v.artifacts, ctx + '.artifacts');
    add(v.artifact, ctx + '.artifact');
    add(v.content, ctx + '.content');
    if (v.data && v.data !== v) add(v.data, ctx + '.data');
    for (const [k, val] of Object.entries(v)) {
      if (['video_url','video_urls','video','videos','media_url','output_url','output_urls','result_url','download_url','remote_url','file_url','url','urls','link','href','result','response','output','outputs','results','files','file','artifacts','artifact','content','data'].includes(k)) continue;
      if (typeof val === 'string') extractUrlsFromString(val, ctx + '.' + k);
      else if (val && typeof val === 'object' && /result|output|video|media|file|asset|download|response|data|content/i.test(k)) add(val, ctx + '.' + k);
    }
  };
  add(status, 'root');
  return out;
}
function pickApimartVideoUrl(status={}) {
  return pickApimartVideoUrls(status)[0] || '';
}
function pickApimartStatus(status={}) {
  const data = status.data || status;
  if (Array.isArray(data)) {
    const first = data.find(x => x && (x.status || x.result || x.output || x.video_url || x.videos)) || data[0] || {};
    return String(first.status || status.status || '').toLowerCase();
  }
  return String(data.status || status.status || '').toLowerCase();
}
function isApimartPendingStatusText(v='') {
  return ['pending','queued','queueing','submitted','processing','running','in_progress','generating','created',''].includes(String(v || '').toLowerCase());
}
function pickApimartProgress(status={}) {
  const data = status.data || status;
  const items = Array.isArray(data) ? data : [data];
  const values = [];
  const push = (v) => { if (Number.isFinite(Number(v))) values.push(Number(v)); };
  push(status.progress); push(data.progress); push(data.percent); push(data.percentage);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    push(item.progress); push(item.percent); push(item.percentage);
    if (item.result && typeof item.result === 'object') { push(item.result.progress); push(item.result.percent); }
  }
  const v = values.find(x => Number.isFinite(Number(x)));
  return Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : 0;
}
function pickApimartTaskErrorMessage(status = {}, fallback = '视频任务失败') {
  const parts = [];
  const push = v => { if (v !== undefined && v !== null && String(v).trim()) parts.push(String(v).trim()); };
  const visit = (x) => {
    if (!x) return;
    if (Array.isArray(x)) { x.forEach(visit); return; }
    if (typeof x !== 'object') { push(x); return; }
    push(x.error_message); push(x.errorMessage); push(x.fail_reason); push(x.failure_reason); push(x.reason); push(x.message); push(x.msg); push(x.detail);
    if (x.error && x.error !== x) visit(x.error);
    if (x.data && x.data !== x) visit(x.data);
    if (x.result && x.result !== x) visit(x.result);
  };
  visit(status);
  return parts.find(Boolean) || fallback;
}
function videoProgressTextByStatus(statusText='', progress=0, phase='query') {
  const s = String(statusText || '').toLowerCase();
  if (phase === 'submit') return '正在提交到 APIMart';
  if (phase === 'download') return '远端已完成，正在下载到本地';
  if (['failed','fail','error','cancelled','canceled'].includes(s)) return '任务失败';
  if (['completed','complete','succeeded','success','done','finished'].includes(s)) return progress >= 100 ? '已完成' : '远端已完成，准备下载';
  if (['queued','queueing','pending','created','submitted'].includes(s)) return progress > 0 ? `远端排队中 ${progress}%` : '远端排队中';
  if (['processing','running','in_progress','generating'].includes(s)) return progress > 0 ? `远端生成中 ${progress}%` : '远端生成中';
  return progress > 0 ? `正在查询进度 ${progress}%` : '正在批量查询远端状态';
}
function videoPublicBase(cfg, req) {
  const u = (cfg.public_url || tunnelState.url || '').trim();
  if (u) return u.replace(/\/+$/, '');
  // 仅作为兜底。APIMart 云端通常无法访问局域网地址；公网访问开启后会自动使用公网地址。
  const host = (req && req.headers && req.headers.host) ? `http://${req.headers.host}` : urls(cfg).lan_url;
  return String(host || urls(cfg).local_url).replace(/\/+$/, '');
}
function normalizeExternalPublicOrigin(raw) {
  const u = String(raw || '').trim();
  if (!u) return '';
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:') return '';
    const host = parsed.hostname || '';
    if (/^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(host)) return '';
    // V12.5：APIMart 只需要公网域名源地址。自动去掉公网访问页路径、查询参数、密码参数，避免拼出错误视频直链。
    return parsed.origin.replace(/\/+$/, '');
  } catch { return ''; }
}
function videoReferencePublicBase(cfg) {
  return normalizeExternalPublicOrigin((cfg.public_url || tunnelState.url || '').trim());
}
function base64UrlEncode(str) { return Buffer.from(String(str), 'utf8').toString('base64url'); }
function base64UrlDecode(str) { return Buffer.from(String(str), 'base64url').toString('utf8'); }
function publicTempExpireAt(hours = 2) { return new Date(Date.now() + Math.max(1, Number(hours || 2)) * 60 * 60 * 1000).toISOString(); }
function isPublicTempExpired(v = {}) {
  const exp = Date.parse(v.expires_at || '');
  if (Number.isFinite(exp) && exp > 0) return Date.now() > exp;
  const created = Date.parse(v.created_at || '');
  return Number.isFinite(created) && created > 0 ? Date.now() - created > 2 * 60 * 60 * 1000 : false;
}
function registerPublicVideo(filePath, ownerId='', opts = {}) {
  const st = ensureVideoStore();
  const ext = path.extname(filePath).toLowerCase();
  const id = uuid('pv_').replace(/[^a-zA-Z0-9_]/g,'');
  st.public_videos = (st.public_videos || []).filter(v => fs.existsSync(v.path || '') && v.active !== false && !isPublicTempExpired(v));
  st.public_videos.push({ id, path:filePath, ext, owner_id:ownerId, active:true, kind: opts.kind || 'video', name: path.basename(filePath), created_at:nowISO(), expires_at: publicTempExpireAt(opts.expireHours || 2) });
  getDB()._save();
  return id;
}
function closePublicVideoByPath(filePath) {
  if (!filePath) return;
  try {
    const st = ensureVideoStore();
    let changed = false;
    for (const v of (st.public_videos || [])) {
      // 不再任务完成后立即关闭临时视频链接；保留到 expires_at，默认 2 小时后自动失效。
      if (v.path === filePath && v.active !== false) {
        if (!v.expires_at) v.expires_at = publicTempExpireAt(2);
        v.closed_at = nowISO();
        changed = true;
      }
    }
    if (changed) getDB()._save();
  } catch {}
}
function closePublicVideoById(id) {
  if (!id) return;
  try {
    const st = ensureVideoStore();
    const hit = (st.public_videos || []).find(v => v.id === id);
    if (hit && hit.active !== false) { hit.active = false; hit.closed_at = nowISO(); getDB()._save(); }
  } catch {}
}

function buildPublicVideoUrl(filePath, cfg, ownerId='') {
  const base = videoReferencePublicBase(cfg);
  if (!base || !/^https:\/\//i.test(base)) {
    throw new Error('参考视频必须使用公网 HTTPS 直链。请先开启 Cloudflare Tunnel，并确认公网链接是 https://xxx.trycloudflare.com 这种域名；不要使用局域网、本机地址、带密码/参数的页面链接。')
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!['.mp4','.mov'].includes(ext)) throw new Error('参考视频只支持 .mp4 或 .mov，且小于等于 100MB。');
  const stat = fs.statSync(filePath);
  if (stat.size > 100 * 1024 * 1024) throw new Error('参考视频不能超过 100MB，请压缩后再上传。');
  const id = registerPublicVideo(filePath, ownerId);
  // V10.9：使用短直链，最后路径直接以 .mp4/.mov 结尾，避免 APIMart 对长 token/中文文件名/二级路径探测失败。
  return `${base}/public-video/${id}${ext}`;
}
function buildLocalFlow2VideoUrl(filePath, ownerId='', endpoint='') {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.mp4','.mov','.webm','.m4v'].includes(ext)) throw new Error('Flow2API source video must be mp4/mov/webm/m4v');
  const id = registerPublicVideo(filePath, ownerId, { kind:'flow2api_source_video', expireHours:2 });
  const host = String(endpoint || '').includes('127.0.0.1') || /localhost/i.test(String(endpoint || ''))
    ? (process.env.LAIG_FLOW2API_HOST_ACCESS || 'host.docker.internal')
    : '127.0.0.1';
  return `http://${host}:${currentPort || Number(readConfig().port || 7861)}/public-video/${id}${ext}`;
}
async function probePublicVideoUrl(urlValue) {
  if (!urlValue) return;
  if (!/^https?:\/\//i.test(urlValue)) throw new Error('参考视频 URL 必须是 HTTP/HTTPS 公网直链');
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)/i.test(urlValue)) {
    throw new Error('参考视频 URL 是本机/局域网地址，APIMart 云端无法访问。请使用 Cloudflare Tunnel 公网 HTTPS 地址。');
  }
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), 12000);
  try {
    let res = await fetch(urlValue, { method:'HEAD', signal:controller.signal, headers:{'User-Agent':'LocalApiImageGenerator-APIMart-Probe'} });
    if (!res.ok || Number(res.headers.get('content-length') || 0) <= 0) {
      // 部分服务不支持 HEAD，改用 Range GET 探测前 1KB。
      res = await fetch(urlValue, { method:'GET', signal:controller.signal, headers:{Range:'bytes=0-1023','User-Agent':'LocalApiImageGenerator-APIMart-Probe'} });
    }
    if (!(res.ok || res.status === 206)) throw new Error(`公网视频直链自检失败 HTTP ${res.status}`);
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct && !/video|octet-stream|quicktime|mp4/.test(ct)) throw new Error(`公网视频直链 Content-Type 异常：${ct}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > 100 * 1024 * 1024) throw new Error('参考视频超过 100MB');
  } catch(e) {
    if (e.name === 'AbortError') throw new Error('公网视频直链自检超时：APIMart 也可能无法读取这个视频 URL。');
    throw e;
  } finally { clearTimeout(timer); }
}


const AUTO_APIMART_PROXY_CANDIDATES = [
  'http://127.0.0.1:10808',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:7890',
  'http://127.0.0.1:7897',
  'http://127.0.0.1:20171',
  'http://127.0.0.1:2080',
  'socks5h://127.0.0.1:10808',
  'socks5h://127.0.0.1:7891'
];
function normalizeProxyUrl(v = '') {
  let s = String(v || '').trim();
  if (!s || /^auto$/i.test(s)) return '';
  if (/^https?:\/\//i.test(s) || /^socks5h?:\/\//i.test(s)) return s;
  if (/^(127\.0\.0\.1|localhost|\d+\.\d+\.\d+\.\d+):\d+$/i.test(s)) return 'http://' + s;
  if (/^\d+$/.test(s)) return 'http://127.0.0.1:' + s;
  return s;
}
let lastGoodApimartProxy = '';
function markGoodApimartProxy(proxy = '') {
  const p = normalizeProxyUrl(proxy);
  if (p) lastGoodApimartProxy = p;
}
function getApimartProxyCandidates(explicit = '') {
  const out = [];
  const add = (v) => {
    const x = normalizeProxyUrl(v);
    if (x && !out.includes(x)) out.push(x);
  };
  // 优先复用上一次成功的代理，避免每次都试错端口导致请求慢。
  add(lastGoodApimartProxy);
  add(explicit);
  add(process.env.APIMART_PROXY_URL);
  add(process.env.HTTPS_PROXY);
  add(process.env.HTTP_PROXY);
  for (const c of AUTO_APIMART_PROXY_CANDIDATES) add(c);
  return out;
}

function describeApimartNetworkError(err, targetUrl = '') {
  const cause = err && (err.cause || err);
  const code = cause && (cause.code || cause.name || '');
  const msg = cause && (cause.message || err.message) || String(err || 'unknown');
  let host = targetUrl;
  try { host = new URL(targetUrl).host; } catch {}
  const extra = /ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED/i.test(String(code + ' ' + msg))
    ? '。这是网络/DNS/代理/防火墙连接问题，不是图片或视频参数错误。'
    : '';
  return `网络连接失败：无法访问 ${host || 'api.apimart.ai'}。底层原因：${code ? code + ' ' : ''}${msg}${extra}`;
}
function nativeJsonRequest(targetUrl, apiKey, payload = null, method = 'GET', timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch { return reject(new Error('无效 API 地址：' + targetUrl)); }
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
        'User-Agent':'LocalApiImageGenerator/14.5.5',
        'Authorization': apiKey ? `Bearer ${apiKey}` : ''
      },
      timeout: timeoutMs
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw:text }; }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(json?.error?.message || json?.message || text || `HTTP ${res.statusCode}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`网络请求超时 ${timeoutMs}ms`)));
    req.on('error', e => reject(new Error(describeApimartNetworkError(e, targetUrl))));
    if (body) req.write(body);
    req.end();
  });
}
function safeInt(value, defaultValue = 0, minValue = null, maxValue = null) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return defaultValue;
  let out = n;
  if (Number.isFinite(Number(minValue))) out = Math.max(Number(minValue), out);
  if (Number.isFinite(Number(maxValue))) out = Math.min(Number(maxValue), out);
  return out;
}
function safeFloat(value, defaultValue = 0, minValue = null, maxValue = null) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return defaultValue;
  let out = n;
  if (Number.isFinite(Number(minValue))) out = Math.max(Number(minValue), out);
  if (Number.isFinite(Number(maxValue))) out = Math.min(Number(maxValue), out);
  return out;
}
function optionalInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}
const APIMART_VIDEO_MODEL_RULES = {
  'omni-flash-ext': {
    label: 'Omni Flash',
    model: 'Omni-Flash-Ext',
    endpoint: '/v1/videos/generations', taskQuery: 'batch',
    resolutions: ['720p','1080p','4k'], defaultResolution: '720p', resolutionParam: 'resolution',
    aspectRatios: ['16:9','9:16'], defaultAspectRatio: '16:9', aspectParam: 'aspect_ratio',
    durations: [4,6,8,10], defaultDuration: 6,
    supportsImageUrls: true, supportsVideoUrls: true, supportsImageWithRoles: false,
    videoParam: 'video_urls', durationWithVideo: false,
    allowedImageCounts: [0,1,3]
  },
  'doubao-seedance-1-0-pro-fast': {
    label: 'Doubao Seedance 1.0 Pro Fast',
    endpoint: '/v1/videos/generations', taskQuery: 'batch',
    resolutions: ['480p','720p','1080p'], defaultResolution: '1080p',
    aspectRatios: ['16:9','9:16','1:1','4:3','3:4','21:9'], defaultAspectRatio: '16:9',
    durationRange: [2,12], defaultDuration: 5,
    supportsImageUrls: false, supportsVideoUrls: false, supportsImageWithRoles: true,
    supportsLastFrame: false, maxImageCount: 1,
    resolutionParam: 'resolution', aspectParam: 'aspect_ratio'
  },
  'doubao-seedance-1-0-pro-quality': {
    label: 'Doubao Seedance 1.0 Pro Quality',
    endpoint: '/v1/videos/generations', taskQuery: 'batch',
    resolutions: ['480p','720p','1080p'], defaultResolution: '1080p',
    aspectRatios: ['16:9','9:16','1:1','4:3','3:4','21:9'], defaultAspectRatio: '16:9',
    durationRange: [2,12], defaultDuration: 5,
    supportsImageUrls: false, supportsVideoUrls: false, supportsImageWithRoles: true,
    supportsLastFrame: true, maxImageCount: 2,
    resolutionParam: 'resolution', aspectParam: 'aspect_ratio'
  }
};
function registerApimartVideoRules(items = []) {
  for (const item of items) {
    const model = String(item.model || '').trim();
    if (!model) continue;
    APIMART_VIDEO_MODEL_RULES[model.toLowerCase()] = {
      endpoint: '/v1/videos/generations',
      taskQuery: 'batch',
      defaultResolution: '720p',
      defaultAspectRatio: '16:9',
      defaultDuration: 5,
      resolutionParam: 'resolution',
      aspectParam: 'aspect_ratio',
      supportsImageUrls: true,
      supportsVideoUrls: false,
      supportsImageWithRoles: false,
      supportsLastFrame: false,
      ...item
    };
  }
}
registerApimartVideoRules([
  { model:'gemini-omni-flash-preview', label:'Gemini Omni Flash Preview', resolutions:['720p'], defaultResolution:'720p', aspectRatios:['16:9','9:16'], defaultAspectRatio:'16:9', supportsImageUrls:true, supportsVideoUrls:true, videoParam:'video_urls', maxImageCount:16, maxVideoCount:1, supportsDuration:false, supportsSeed:false, durationWithVideo:false },
  { model:'doubao-seedance-1-0-pro-fast', label:'Doubao Seedance 1.0 Pro Fast', resolutions:['480p','720p','1080p'], defaultResolution:'1080p', aspectRatios:['16:9','9:16','1:1','4:3','3:4','21:9'], durationRange:[2,12], defaultDuration:5, supportsImageUrls:false, supportsImageWithRoles:true, supportsLastFrame:false, maxImageCount:1 },
  { model:'doubao-seedance-1-0-pro-quality', label:'Doubao Seedance 1.0 Pro Quality', resolutions:['480p','720p','1080p'], defaultResolution:'1080p', aspectRatios:['16:9','9:16','1:1','4:3','3:4','21:9'], durationRange:[2,12], defaultDuration:5, supportsImageUrls:false, supportsImageWithRoles:true, supportsLastFrame:true, maxImageCount:2 },
  { model:'doubao-seedance-1-5-pro', label:'Doubao Seedance 1.5 Pro', resolutions:['480p','720p','1080p'], defaultResolution:'720p', aspectRatios:['16:9','9:16','1:1','4:3','3:4','21:9'], durationRange:[4,12], supportsImageUrls:true, supportsImageWithRoles:true, supportsLastFrame:true, maxImageCount:2, audioParam:'audio', defaultAudio:true, cameraFixedParam:'camerafixed' },
  { model:'doubao-seedance-2.0', label:'Doubao Seedance 2.0', resolutions:['480p','720p','1080p','4k'], aspectRatios:['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'], aspectParam:'size', durationRange:[4,15], supportsImageUrls:true, supportsVideoUrls:true, supportsImageWithRoles:true, supportsLastFrame:true, maxImageCount:9, maxVideoCount:3, videoParam:'video_urls', durationWithVideo:true, audioParam:'generate_audio', defaultAudio:true, returnLastFrameParam:'return_last_frame' },
  { model:'doubao-seedance-2.0-fast', label:'Doubao Seedance 2.0 Fast', resolutions:['480p','720p'], aspectRatios:['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'], aspectParam:'size', durationRange:[4,15], supportsImageUrls:true, supportsVideoUrls:true, supportsImageWithRoles:true, supportsLastFrame:true, maxImageCount:9, maxVideoCount:3, videoParam:'video_urls', durationWithVideo:true, audioParam:'generate_audio', defaultAudio:true, returnLastFrameParam:'return_last_frame' },
  { model:'doubao-seedance-2.0-mini', label:'Doubao Seedance 2.0 Mini', resolutions:['480p','720p'], aspectRatios:['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'], aspectParam:'size', durationRange:[4,15], supportsImageUrls:true, supportsVideoUrls:true, supportsImageWithRoles:true, supportsLastFrame:true, maxImageCount:9, maxVideoCount:3, videoParam:'video_urls', durationWithVideo:true, audioParam:'generate_audio', defaultAudio:true, returnLastFrameParam:'return_last_frame' },
  { model:'sora-2', label:'Sora 2', resolutions:['720p'], aspectRatios:['16:9','9:16'], durations:[4,8,12,16,20], defaultDuration:4, supportsImageUrls:true, maxImageCount:1, omitAspectWithImages:true },
  { model:'sora-2-pro', label:'Sora 2 Pro', resolutions:['720p','1024p','1080p'], aspectRatios:['16:9','9:16'], durations:[4,8,12,16,20], defaultDuration:4, supportsImageUrls:true, maxImageCount:1, omitAspectWithImages:true },
  { model:'veo3.1-fast', label:'VEO3.1 Fast', resolutions:['720p','1080p','4k'], aspectRatios:['16:9','9:16'], durations:[8], defaultDuration:8, supportsImageUrls:true, maxImageCount:3 },
  { model:'veo3.1-quality', label:'VEO3.1 Quality', resolutions:['720p','1080p','4k'], aspectRatios:['16:9','9:16'], durations:[8], defaultDuration:8, supportsImageUrls:true, maxImageCount:3 },
  { model:'veo3.1-lite', label:'VEO3.1 Lite', resolutions:['720p','1080p','4k'], aspectRatios:['16:9','9:16'], durations:[8], defaultDuration:8, supportsImageUrls:false, maxImageCount:0 },
  { model:'MiniMax-Hailuo-02', label:'MiniMax Hailuo 02', resolutions:['512p','768p','1080p'], defaultResolution:'768p', aspectParam:false, durations:[5,10], supportsImageUrls:false, imageParam:'first_frame_image', supportsLastFrame:true, maxImageCount:2, resolutionDurationRules:{'1080p':[5]}, watermarkParam:'watermark', promptOptimizerParam:'prompt_optimizer', fastPretreatmentParam:'fast_pretreatment' },
  { model:'MiniMax-Hailuo-2.3', label:'MiniMax Hailuo 2.3', resolutions:['768p','1080p'], defaultResolution:'768p', aspectParam:false, durations:[6,10], defaultDuration:6, supportsImageUrls:false, imageParam:'first_frame_image', maxImageCount:1, resolutionDurationRules:{'1080p':[6]}, watermarkParam:'watermark', promptOptimizerParam:'prompt_optimizer' },
  { model:'MiniMax-Hailuo-2.3-Fast', label:'MiniMax Hailuo 2.3 Fast', resolutions:['768p','1080p'], defaultResolution:'768p', aspectParam:false, durations:[6,10], defaultDuration:6, supportsImageUrls:false, imageParam:'first_frame_image', minImageCount:1, maxImageCount:1, resolutionDurationRules:{'1080p':[6]}, watermarkParam:'watermark', promptOptimizerParam:'prompt_optimizer' },
  { model:'skyreels-v4-fast', label:'SkyReels V4 Fast', resolutions:['480p','720p','1080p'], defaultResolution:'1080p', aspectRatios:['16:9','4:3','1:1','9:16','3:4'], durationRange:[3,15], supportsImageUrls:true, supportsVideoUrls:true, imageParam:'skyreels', videoParam:'ref_videos', maxImageCount:15, maxVideoCount:1, durationWithVideo:true, omitAspectWithImages:true, omitAspectWithVideo:true, promptOptimizerParam:'prompt_optimizer' },
  { model:'skyreels-v4-std', label:'SkyReels V4 Std', resolutions:['480p','720p','1080p'], defaultResolution:'1080p', aspectRatios:['16:9','4:3','1:1','9:16','3:4'], durationRange:[3,15], supportsImageUrls:true, supportsVideoUrls:true, imageParam:'skyreels', videoParam:'ref_videos', maxImageCount:15, maxVideoCount:1, durationWithVideo:true, omitAspectWithImages:true, omitAspectWithVideo:true, promptOptimizerParam:'prompt_optimizer' },
  { model:'happyhorse-1.0', label:'HappyHorse 1.0', resolutions:['720P','1080P'], defaultResolution:'1080P', aspectRatios:['16:9','9:16','1:1','4:3','3:4'], aspectParam:'size', durationRange:[3,15], supportsImageUrls:true, supportsVideoUrls:true, imageParam:'first_frame_image', videoParam:'video_url', maxImageCount:9, watermarkParam:'watermark' },
  { model:'happyhorse-1.1', label:'HappyHorse 1.1', resolutions:['720P','1080P'], defaultResolution:'1080P', aspectRatios:['16:9','9:16','1:1','4:3','3:4'], aspectParam:'size', durationRange:[3,15], supportsImageUrls:true, imageParam:'first_frame_image', maxImageCount:9, watermarkParam:'watermark' },
  { model:'wan2.5-preview', label:'Wan2.5 Preview', resolutions:['480p','720p','1080p'], defaultResolution:'720p', aspectRatios:['16:9','9:16','1:1','4:3','3:4'], aspectParam:'size', durations:[5,10], supportsImageUrls:true, maxImageCount:1, omitAspectWithImages:true, audioParam:'audio', defaultAudio:true, forceAudio:true, watermarkParam:'watermark', negativePromptParam:'negative_prompt' },
  { model:'wan2.6', label:'Wan2.6', resolutions:['720p','1080p'], defaultResolution:'720p', aspectRatios:['16:9','9:16','1:1','4:3','3:4'], durations:[5,10,15], supportsImageUrls:true, maxImageCount:1, omitAspectWithImages:true, audioParam:'audio', defaultAudio:true, watermarkParam:'watermark', negativePromptParam:'negative_prompt' },
  { model:'wan2.7', label:'Wan2.7', resolutions:['720P','1080P'], defaultResolution:'1080P', aspectRatios:['16:9','9:16','1:1','4:3','3:4'], aspectParam:'size', durationRange:[2,15], supportsImageUrls:true, supportsVideoUrls:true, supportsImageWithRoles:true, supportsLastFrame:true, videoParam:'video_urls', maxVideoCount:1, durationWithVideo:true, omitAspectWithImages:true, omitAspectWithVideo:true, watermarkParam:'watermark', negativePromptParam:'negative_prompt' },
  { model:'wan2.7-r2v', label:'Wan2.7 R2V', resolutions:['720P','1080P'], defaultResolution:'1080P', aspectRatios:['16:9','9:16','1:1','4:3','3:4'], aspectParam:'size', durationRange:[2,15], videoDurationRange:[2,10], supportsImageUrls:false, supportsVideoUrls:true, supportsImageWithRoles:true, referenceOnlyRoles:true, videoParam:'video_urls', maxImageCount:5, maxVideoCount:5, maxReferenceCount:5, durationWithVideo:true, minReferenceCount:1, omitAspectWithImages:true, omitAspectWithVideo:true, watermarkParam:'watermark', negativePromptParam:'negative_prompt' },
  { model:'wan2.7-videoedit', label:'Wan2.7 VideoEdit', resolutions:['720P','1080P'], defaultResolution:'1080P', aspectRatios:['16:9','9:16','1:1','4:3','3:4'], aspectParam:'size', durations:[0,2,3,4,5,6,7,8,9,10], defaultDuration:0, supportsImageUrls:true, supportsVideoUrls:true, videoParam:'video_urls', maxImageCount:4, maxVideoCount:1, requiredVideo:true, durationWithVideo:true, watermarkParam:'watermark', negativePromptParam:'negative_prompt' },
  { model:'kling-v2-6', label:'Kling 2.6', resolutions:['720p','1080p'], aspectRatios:['16:9','9:16','1:1'], durations:[5,10], supportsImageUrls:true, maxImageCount:2, modeFromResolution:true, audioParam:'audio', defaultAudio:false, watermarkParam:'watermark', negativePromptParam:'negative_prompt' },
  { model:'kling-v2-6-motion-control', label:'Kling 2.6 Motion Control', resolutions:['720p','1080p'], aspectParam:false, supportsDuration:false, supportsImageUrls:false, supportsVideoUrls:true, imageParam:'image_url', videoParam:'video_url', minImageCount:1, maxImageCount:1, requiredVideo:true, modeFromResolution:true, characterOrientationParam:'character_orientation' },
  { model:'kling-v3', label:'Kling v3', resolutions:['720p','1080p','4k'], aspectRatios:['16:9','9:16','1:1'], durationRange:[3,15], supportsImageUrls:true, maxImageCount:2, modeFromResolution:true, audioParam:'audio', defaultAudio:false, watermarkParam:'watermark', negativePromptParam:'negative_prompt' },
  { model:'kling-v3-motion-control', label:'Kling v3 Motion Control', resolutions:['720p','1080p'], aspectParam:false, supportsDuration:false, supportsImageUrls:false, supportsVideoUrls:true, imageParam:'image_url', videoParam:'video_url', minImageCount:1, maxImageCount:1, requiredVideo:true, modeFromResolution:true, characterOrientationParam:'character_orientation' },
  { model:'kling-v3-omni', label:'Kling v3 Omni', resolutions:['720p','1080p','4k'], aspectRatios:['16:9','9:16','1:1'], durationRange:[3,15], supportsImageUrls:true, supportsVideoUrls:true, supportsImageWithRoles:true, supportsLastFrame:true, videoParam:'video_list', maxVideoCount:1, modeFromResolution:true, durationWithVideo:false, audioParam:'audio', defaultAudio:false, watermarkParam:'watermark' },
  { model:'kling-video-o1', label:'Kling Video O1', resolutions:['720p','1080p'], aspectRatios:['16:9','9:16','1:1'], durations:[5,10], defaultDuration:5, supportsImageUrls:true, supportsImageWithRoles:true, supportsLastFrame:true, maxImageCount:2, modeFromResolution:true },
  { model:'kling-3.0-turbo', label:'Kling 3.0 Turbo', resolutions:['720p','1080p'], aspectRatios:['16:9','9:16','1:1'], durationRange:[3,15], supportsImageUrls:false, imageParam:'first_frame_image', omitAspectWithImages:true, watermarkParam:'watermark' },
  { model:'viduq3', label:'Vidu Q3', resolutions:['540p','720p','1080p'], aspectRatios:['16:9','9:16','4:3','3:4','1:1'], durationRange:[3,16], supportsImageUrls:true, minImageCount:1, maxImageCount:7 },
  { model:'viduq3-mix', label:'Vidu Q3 Mix', resolutions:['720p','1080p'], aspectRatios:['16:9','9:16','4:3','3:4','1:1'], durationRange:[1,16], supportsImageUrls:true, minImageCount:1, maxImageCount:7 },
  { model:'viduq3-pro', label:'Vidu Q3 Pro', resolutions:['540p','720p','1080p'], aspectRatios:['16:9','9:16','4:3','3:4','1:1'], durationRange:[1,16], supportsImageUrls:true, maxImageCount:2, supportsLastFrame:true, omitAspectWithImages:true, audioParam:'audio', defaultAudio:true },
  { model:'viduq3-turbo', label:'Vidu Q3 Turbo', resolutions:['540p','720p','1080p'], aspectRatios:['16:9','9:16','4:3','3:4','1:1'], durationRange:[1,16], supportsImageUrls:true, maxImageCount:2, supportsLastFrame:true, omitAspectWithImages:true, audioParam:'audio', defaultAudio:true },
  { model:'grok-imagine-1.5-video-apimart', label:'Grok Imagine 1.5 Video', resolutions:['480p','720p'], defaultResolution:'480p', resolutionParam:'quality', aspectRatios:['16:9','9:16','1:1','3:2','2:3'], aspectParam:'size', durationRange:[6,30], defaultDuration:6, supportsImageUrls:true, maxImageCount:7 },
  { model:'pixverse-v6', label:'Pixverse v6', resolutions:['360p','540p','720p','1080p'], defaultResolution:'540p', aspectRatios:['16:9','4:3','1:1','3:4','9:16','2:3','3:2','21:9'], aspectParam:'size', durationRange:[1,15], firstLastDurations:[5,8], supportsImageUrls:true, imageParam:'pixverse', maxImageCount:7, omitAspectWithImages:true, audioParam:'audio', defaultAudio:false, watermarkParam:'watermark', negativePromptParam:'negative_prompt', motionModeParam:'motion_mode' },
  { model:'Omni-Flash-Ext', label:'Omni Flash Ext', resolutions:['720p','1080p','4k'], defaultResolution:'720p', aspectRatios:['16:9','9:16'], defaultAspectRatio:'16:9', durations:[4,6,8,10], defaultDuration:6, supportsImageUrls:true, supportsVideoUrls:true, videoParam:'video_urls', allowedImageCounts:[0,1,3], durationWithVideo:false }
]);
function canonicalApimartVideoModel(model = 'Omni-Flash-Ext') {
  const raw = String(model || 'Omni-Flash-Ext').trim();
  if (!raw || raw.toLowerCase() === 'omni-flash-ext') return 'Omni-Flash-Ext';
  return raw;
}
function getApimartVideoRule(model = 'Omni-Flash-Ext') {
  return APIMART_VIDEO_MODEL_RULES[String(model || 'Omni-Flash-Ext').toLowerCase()] || APIMART_VIDEO_MODEL_RULES['omni-flash-ext'];
}
function normalizeVideoResolution(value, model = 'Omni-Flash-Ext') {
  const rule = getApimartVideoRule(model);
  const raw = String(value || rule.defaultResolution || '1080p').trim();
  const match = (rule.resolutions || []).find(item => String(item).toLowerCase() === raw.toLowerCase());
  return match || rule.defaultResolution || '1080p';
}
function normalizeVideoAspectRatio(value, model = 'Omni-Flash-Ext') {
  const rule = getApimartVideoRule(model);
  const raw = String(value || rule.defaultAspectRatio || '9:16').trim();
  return (rule.aspectRatios || []).includes(raw) ? raw : (rule.defaultAspectRatio || '9:16');
}
function normalizeVideoDurationForRule(value, defaultValue = 6, rule = {}, model = 'Omni-Flash-Ext') {
  const requested = Number(value);
  if (Array.isArray(rule.durationRange) && rule.durationRange.length >= 2) {
    const min = Number(rule.durationRange[0]);
    const max = Number(rule.durationRange[1]);
    const configuredDefault = Number(defaultValue ?? rule.defaultDuration ?? min);
    const fallback = Number.isFinite(configuredDefault) ? configuredDefault : min;
    const duration = Number.isFinite(requested) ? Math.round(requested) : fallback;
    return Math.max(min, Math.min(max, duration));
  }
  const allowed = [...new Set((rule.durations || [4, 6, 8, 10]).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const configuredDefault = Number(defaultValue ?? rule.defaultDuration);
  const fallback = allowed.includes(configuredDefault) ? configuredDefault : allowed[0];
  const n = Number.isFinite(requested) ? Math.round(requested) : fallback;
  if (allowed.includes(n)) return n;
  addLog(`APIMart ${model} 时长 ${n} 不受支持，已自动改为 ${fallback} 秒`, { level:'warn' });
  return fallback;
}

function normalizeVideoDuration(value, defaultValue = 6, model = 'Omni-Flash-Ext') {
  return normalizeVideoDurationForRule(value, defaultValue, getApimartVideoRule(model), model);
}

function normalizeVideoMode(value = 'auto') {
  const mode = String(value || 'auto').trim();
  return ['auto','text_to_video','first_frame','first_last_frame','multi_reference','video_edit','veo_remix'].includes(mode) ? mode : 'auto';
}
function resolveApimartVideoMode(requested = 'auto', { imageCount = 0, hasVideo = false } = {}) {
  const mode = normalizeVideoMode(requested);
  if (mode !== 'auto') return mode;
  if (hasVideo) return 'video_edit';
  if (imageCount > 2) return 'multi_reference';
  if (imageCount === 2) return 'first_last_frame';
  if (imageCount === 1) return 'first_frame';
  return 'text_to_video';
}
function apimartVideoModeLabel(mode = 'text_to_video') {
  return ({
    text_to_video: '文生视频',
    first_frame: '首帧生成',
    first_last_frame: '首尾帧生成',
    multi_reference: '多素材生成',
    video_edit: '上传视频编辑'
  })[mode] || '文生视频';
}
function buildApimartVideoImageRolePayload(model = 'Omni-Flash-Ext', imageUrls = [], mode = 'auto') {
  const rule = getApimartVideoRule(model);
  const urls = (imageUrls || []).filter(Boolean);
  if (!urls.length || !rule.supportsImageWithRoles || mode === 'text_to_video') return [];
  if (rule.referenceOnlyRoles) return urls.map(url => ({ url, role:'reference' }));
  if (mode === 'multi_reference' && !rule.supportsImageUrls) {
    return urls.map(url => ({ url, role: 'reference' }));
  }
  if (mode === 'multi_reference') throw new Error(`${rule.label || model} 不支持多素材参考图模式，请选择 Omni Flash 或改为首帧/首尾帧。`);
  if (mode === 'first_last_frame') {
    if (!rule.supportsLastFrame) throw new Error(`${rule.label || model} 不支持首尾帧同时使用，请切换到 quality 模型。`);
    if (urls.length < 2) throw new Error('首尾帧生成需要至少 2 张参考图：第 1 张为首帧，第 2 张为尾帧。');
    return [{ url: urls[0], role: 'first_frame' }, { url: urls[1], role: 'last_frame' }];
  }
  return [{ url: urls[0], role: 'first_frame' }];
}

function assertApimartVideoReferenceRules({ imageUrls = [], videoUrl = '', context = '视频任务' } = {}) {
  // V14.4.5: 不再限制视频参考图数量，也不再拦截 2 张或 3 张以上参考图。
  // 按用户要求直接把已上传/已填写的 image_urls 原样提交给 APIMart。
  return true;
}

function extractApimartErrorMessage(json = {}, fallback = 'APIMart 请求失败') {
  const parts = [];
  const push = v => { if (v !== undefined && v !== null && String(v).trim()) parts.push(String(v).trim()); };
  push(json?.error?.message); push(json?.error?.code);
  push(json?.data?.error?.message); push(json?.data?.error?.code);
  push(json?.message); push(json?.msg); push(json?.detail);
  if (json?.raw && !parts.length) push(String(json.raw).slice(0, 800));
  const code = json && json.code !== undefined ? `code=${json.code}` : '';
  const text = parts.filter(Boolean).join(' / ') || fallback;
  return code ? `${text}（${code}）` : text;
}
function isPlainEmptyObject(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === 0;
}
function isLikelyEmptyApimartResponse(json) {
  if (json === undefined || json === null) return true;
  if (isPlainEmptyObject(json)) return true;
  if (typeof json === 'string' && !json.trim()) return true;
  if (json && typeof json === 'object') {
    const hasKnownField = ['code','data','task_id','taskId','taskID','post_id','postId','postID','id','status','message','msg','error','raw','result'].some(k => Object.prototype.hasOwnProperty.call(json, k));
    return !hasKnownField;
  }
  return false;
}
function compactJsonForLog(json, maxLen = 1000) {
  try { return JSON.stringify(json).slice(0, maxLen); }
  catch { return String(json).slice(0, maxLen); }
}
function validateApimartJsonResponse(json = {}, context = 'APIMart') {
  // APIMart 有些错误会用 HTTP 200 返回 {code:400/401/402/429,...}，必须在这里转成真实错误，
  // 否则前端只会看到“未返回 task_id”。
  if (isLikelyEmptyApimartResponse(json)) {
    throw new Error(`${context} 返回空响应或非 APIMart 标准 JSON：${compactJsonForLog(json)}。程序已改为继续尝试其他请求方式；如果所有方式都为空，请检查代理是否拦截了 POST 响应、API Key 是否属于 APIMart、以及接口地址是否被代理/网关重写。`);
  }
  const code = json && json.code;
  if (code !== undefined && code !== null && Number(code) !== 200) {
    throw new Error(`${context} 返回错误：${extractApimartErrorMessage(json)}；实际响应：${compactJsonForLog(json)}`);
  }
  return json;
}
function powershellJsonRequest(targetUrl, apiKey, payload = null, method = 'GET', timeoutSec = 120, proxyUrl = '') {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('PowerShell 兜底请求仅支持 Windows'));
    const payloadB64 = Buffer.from(JSON.stringify(payload || {}), 'utf8').toString('base64');
    const urlB64 = Buffer.from(String(targetUrl || ''), 'utf8').toString('base64');
    const keyB64 = Buffer.from(String(apiKey || ''), 'utf8').toString('base64');
    const methodSafe = String(method || 'GET').toUpperCase().replace(/[^A-Z]/g,'') || 'GET';
    const proxyB64 = Buffer.from(String(proxyUrl || process.env.APIMART_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''), 'utf8').toString('base64');
    const ps = `
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$url = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${urlB64}'))
$key = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${keyB64}'))
$headers = @{ 'Accept'='application/json'; 'User-Agent'='LocalApiImageGenerator/14.5.5' }
$proxy = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${proxyB64}'))
$common = @{ Uri=$url; Headers=$headers; TimeoutSec=${safeInt(timeoutSec, 120, 1, 86400)} }
if ($proxy -ne '') { $common['Proxy'] = $proxy }
if ($key -ne '') { $headers['Authorization'] = 'Bearer ' + $key }
try {
  if ('${methodSafe}' -eq 'POST') {
    $body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadB64}'))
    $common['Method']='Post'; $common['ContentType']='application/json'; $common['Body']=$body; $r = Invoke-RestMethod @common
  } else {
    $common['Method']='Get'; $r = Invoke-RestMethod @common
  }
  $r | ConvertTo-Json -Depth 50 -Compress
} catch {
  Write-Error $_.Exception.Message
  exit 2
}`;
    const child = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command','-'], { windowsHide:true });
    let out='', err='';
    const timer = setTimeout(()=>{ try{child.kill();}catch{}; reject(new Error('PowerShell 系统代理兜底请求超时')); }, (timeoutSec+10)*1000);
    child.stdout.on('data', d=> out += d.toString('utf8'));
    child.stderr.on('data', d=> err += d.toString('utf8'));
    child.on('error', e=>{ clearTimeout(timer); reject(e); });
    child.on('close', code=>{
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `PowerShell 请求失败 code=${code}`));
      try { resolve(out.trim() ? JSON.parse(out.trim()) : {}); }
      catch { reject(new Error('PowerShell 返回不是 JSON：' + out.slice(0,600))); }
    });
    child.stdin.end(ps);
  });
}
function curlJsonRequest(targetUrl, apiKey, payload = null, method = 'GET', timeoutMs = 120000, proxyUrl = '') {
  return new Promise((resolve, reject) => {
    const isTaskQuery = /\/v1\/tasks(\/batch|\/)/i.test(String(targetUrl || ''));
    const timeoutSec = isTaskQuery ? Math.min(18, Math.max(8, Math.ceil(Number(timeoutMs || 120000) / 1000))) : Math.min(90, Math.max(10, Math.ceil(Number(timeoutMs || 120000) / 1000)));
    const args = ['-sS','-L','--connect-timeout','4','--max-time', String(timeoutSec)];
    if (proxyUrl) args.push('--proxy', String(proxyUrl));
    args.push('-X', String(method || 'GET').toUpperCase(), targetUrl, '-H', 'Accept: application/json', '-H', 'User-Agent: LocalApiImageGenerator/14.5.5');
    if (apiKey) args.push('-H', `Authorization: Bearer ${apiKey}`);
    if (payload && String(method || '').toUpperCase() === 'POST') {
      args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
    }
    const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const child = spawn(exe, args, { windowsHide:true });
    let out = '', err = '';
    const timer = setTimeout(()=>{ try { child.kill(); } catch {} reject(new Error(`curl 请求超时 ${timeoutSec}s`)); }, (timeoutSec + 5) * 1000);
    child.stdout.on('data', d => out += d.toString('utf8'));
    child.stderr.on('data', d => err += d.toString('utf8'));
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err || out || `curl 退出码 ${code}`).trim()));
      const text = String(out || '').trim();
      let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw:text }; }
      resolve(json);
    });
    if (payload && String(method || '').toUpperCase() === 'POST') child.stdin.end(JSON.stringify(payload || {}));
    else child.stdin.end();
  });
}

async function apimartJsonWithFallback(targetUrl, apiKey, payload = null, method = 'GET', timeoutMs = 120000) {
  const rawProxy = String(readConfig().apimart_proxy_url || process.env.APIMART_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
  const proxyCandidates = getApimartProxyCandidates(rawProxy);
  const errors = [];
  const isPost = String(method || '').toUpperCase() === 'POST';
  const methodSafe = isPost ? 'POST' : 'GET';
  const isTaskQuery = /\/v1\/tasks(\/batch|\/)/i.test(String(targetUrl || ''));
  const verboseLogs = !isTaskQuery;
  const addErr = (label, e) => {
    const msg = e && e.message ? e.message : String(e || 'unknown');
    errors.push(`${label}: ${msg}`);
    if (verboseLogs) addLog(`APIMart ${label} 失败：${msg}`, { level:'warn' });
  };
  const acceptOrThrowEmpty = (json, label, meta = '', proxy = '') => {
    if (isLikelyEmptyApimartResponse(json)) {
      throw new Error(`${meta ? meta + '，' : ''}返回空 JSON/非标准响应 ${compactJsonForLog(json, 600)}`);
    }
    if (proxy) markGoodApimartProxy(proxy);
    if (verboseLogs) addLog(`APIMart ${label}${meta ? ' ' + meta : ''} 响应：${compactJsonForLog(json, 1000)}`);
    return json;
  };

  if (verboseLogs) {
    addLog(`APIMart 标准请求：${methodSafe} ${targetUrl}${proxyCandidates.length ? '（代理优先：' + proxyCandidates[0] + '）' : ''}`);
    if (isPost) addLog(`APIMart 最终 payload：${compactJsonForLog(payload, 1200)}`);
  }

  // 1) 当前电脑直连 api.apimart.ai 经常超时，所以 APIMart 请求优先走代理 curl。
  // curl 是异步子进程，不阻塞 UI；PowerShell 只作为少量兜底，避免大量轮询时卡顿。
  for (const proxy of proxyCandidates) {
    try { return acceptOrThrowEmpty(await curlJsonRequest(targetUrl, apiKey, payload, method, timeoutMs, proxy), `curl代理 ${proxy}`, '', proxy); }
    catch (e2) { addErr(`curl代理 ${proxy}`, e2); }
  }
  if (process.platform === 'win32') {
    for (const proxy of proxyCandidates.slice(0, 2)) {
      try { return acceptOrThrowEmpty(await powershellJsonRequest(targetUrl, apiKey, payload, method, Math.max(30, Math.ceil(timeoutMs / 1000)), proxy), `PowerShell代理 ${proxy}`, '', proxy); }
      catch (e3) { addErr(`PowerShell代理 ${proxy}`, e3); }
    }
  }

  // 2) 代理都失败后才尝试官方直连 fetch，且超时缩短到 12 秒，避免拖慢每次提交/查询。
  try {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), Math.min(timeoutMs, 12000));
    try {
      const headers = isPost
        ? { 'Authorization':`Bearer ${apiKey}`, 'Content-Type':'application/json', 'Accept':'application/json', 'User-Agent':'LocalApiImageGenerator/14.5.5' }
        : { 'Authorization':`Bearer ${apiKey}`, 'Accept':'application/json', 'User-Agent':'LocalApiImageGenerator/14.5.5' };
      const options = isPost
        ? { method:'POST', headers, body: JSON.stringify(payload || {}), signal:controller.signal }
        : { method:'GET', headers, signal:controller.signal };
      const res = await fetch(targetUrl, options);
      const txt = await res.text();
      let json; try { json = txt ? JSON.parse(txt) : {}; } catch { json = { raw:txt }; }
      const meta = `HTTP ${res.status}`;
      if (verboseLogs) addLog(`APIMart fetch ${meta} 原始响应：${String(txt || '').slice(0, 1000)}`);
      if (!res.ok) {
        if (json && typeof json === 'object' && !isLikelyEmptyApimartResponse(json)) return json;
        throw new Error(json?.error?.message || json?.message || txt || `HTTP ${res.status}`);
      }
      return acceptOrThrowEmpty(json, 'fetch直连', meta);
    } finally { clearTimeout(timer); }
  } catch (e1) { addErr('fetch直连', e1); }

  // 3) 最后再试 Node/PowerShell/curl 直连。
  try { return acceptOrThrowEmpty(await nativeJsonRequest(targetUrl, apiKey, payload, method, timeoutMs), 'Node原生请求'); }
  catch (e4) { addErr('Node原生请求', e4); }
  if (process.platform === 'win32') {
    try { return acceptOrThrowEmpty(await powershellJsonRequest(targetUrl, apiKey, payload, method, Math.max(30, Math.ceil(timeoutMs / 1000)), ''), 'PowerShell直连'); }
    catch (e5) { addErr('PowerShell直连', e5); }
  }
  try { return acceptOrThrowEmpty(await curlJsonRequest(targetUrl, apiKey, payload, method, timeoutMs, ''), 'curl直连'); }
  catch (e6) { addErr('curl直连', e6); }

  throw new Error(`APIMart 请求失败：所有请求方式都没有拿到标准响应。${errors.join(' | ')}`);
}

async function postJsonApimart(endpoint, apiKey, payload, timeoutMs=120000) {
  const target = `https://api.apimart.ai/v1${endpoint}`;
  const json = await apimartJsonWithFallback(target, apiKey, payload, 'POST', timeoutMs);
  return validateApimartJsonResponse(json, `APIMart POST ${endpoint}`);
}

function normalizeApimartVideoError(err, hasVideoUrl) {
  const msg = err && err.message ? err.message : String(err || '');
  if (hasVideoUrl && /Reference video too long|too long|at most 10s|最多.*10/i.test(msg)) {
    return '参考视频时长超过 APIMart Omni-Flash-Ext 限制：参考视频最长约 10 秒。请裁剪到 10 秒以内后再上传。原始错误：' + msg;
  }
  if (hasVideoUrl && /probe reference video duration|video_url|publicly accessible|duration/i.test(msg)) {
    return '参考视频无法被 APIMart 服务器读取：请使用公网 HTTPS 视频直链，最后路径建议以 .mp4/.mov 结尾，且 ≤100MB。若用本地上传，请先开启 Cloudflare Tunnel 公网访问；不要使用局域网/本机地址、需要密码的页面或网盘预览页。原始错误：' + msg;
  }
  return msg;
}

async function getJsonApimart(endpoint, apiKey, timeoutMs=120000) {
  const target = `https://api.apimart.ai/v1${endpoint}`;
  const json = await apimartJsonWithFallback(target, apiKey, null, 'GET', timeoutMs);
  return validateApimartJsonResponse(json, `APIMart GET ${endpoint}`);
}

function flattenApimartTaskItems(resp) {
  const out = [];
  const walk = (x) => {
    if (!x) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x !== 'object') return;
    const id = x.id || x.task_id || x.taskId || x.taskID || x.post_id || x.postId || x.postID;
    const looksTask = id || x.status || x.progress || x.result || x.error;
    if (looksTask) out.push(x);
    if (x.data && x.data !== x) walk(x.data);
    if (x.tasks && x.tasks !== x) walk(x.tasks);
    if (x.results && x.results !== x) walk(x.results);
  };
  walk(resp);
  return out;
}
function taskItemId(item = {}) { return String(item.id || item.task_id || item.taskId || item.taskID || item.post_id || item.postId || item.postID || '').trim(); }
function normalizeSingleTaskFromBatch(resp, taskId) {
  const id = String(taskId || '').trim();
  const items = flattenApimartTaskItems(resp);
  const exact = items.find(x => taskItemId(x) === id) || items.find(x => taskItemId(x) && (taskItemId(x).includes(id) || id.includes(taskItemId(x))));
  return exact || (resp && resp.data && !Array.isArray(resp.data) ? resp.data : resp);
}
const apimartTaskBatchState = { timer:null, queue:[] };
function queryApimartTaskBatchAware(taskId, apiKey, timeoutMs = 120000) {
  const id = String(taskId || '').trim();
  if (!id) return Promise.reject(new Error('task_id 不能为空'));
  return new Promise((resolve, reject) => {
    apimartTaskBatchState.queue.push({ taskId:id, apiKey, timeoutMs, resolve, reject });
    if (!apimartTaskBatchState.timer) {
      apimartTaskBatchState.timer = setTimeout(async () => {
        const jobs = apimartTaskBatchState.queue.splice(0, apimartTaskBatchState.queue.length);
        apimartTaskBatchState.timer = null;
        const groups = new Map();
        for (const j of jobs) {
          const key = String(j.apiKey || '');
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(j);
        }
        for (const group of groups.values()) {
          const first = group[0];
          const ids = [...new Set(group.map(j => j.taskId))];
          try {
            const resp = await postJsonApimart('/tasks/batch', first.apiKey, { task_ids: ids }, first.timeoutMs || 120000);
            for (const j of group) {
              const item = normalizeSingleTaskFromBatch(resp, j.taskId);
              const stText = pickApimartStatus(item);
              const progressInBatch = pickApimartProgress(item);
              // 视频任务更需要排队/进度状态。
              // 如果批量查询仍是 pending/queued/processing，且没有进度或没有最终结果，
              // 则立刻交叉验证单任务 GET，优先拿到更完整的 status/progress/result。
              if (isApimartPendingStatusText(stText) && (!progressInBatch || !pickApimartVideoUrl(item))) {
                try {
                  const single = await getJsonApimart(`/tasks/${encodeURIComponent(j.taskId)}`, j.apiKey, j.timeoutMs || 120000);
                  const singleProgress = pickApimartProgress(single);
                  const singleStatus = pickApimartStatus(single);
                  if (pickApimartVideoUrl(single) || singleProgress || !isApimartPendingStatusText(singleStatus)) j.resolve(single);
                  else j.resolve(item);
                } catch (_) { j.resolve(item); }
              } else {
                j.resolve(item);
              }
            }
          } catch (batchErr) {
            addLog(`APIMart 批量查询失败，回退单任务查询：${batchErr.message || batchErr}`, { level:'warn' });
            for (const j of group) {
              try {
                const single = await getJsonApimart(`/tasks/${encodeURIComponent(j.taskId)}`, j.apiKey, j.timeoutMs || 120000);
                j.resolve(single);
              } catch (singleErr) {
                j.reject(new Error(`批量查询失败：${batchErr.message || batchErr}；单任务兜底也失败：${singleErr.message || singleErr}`));
              }
            }
          }
        }
      }, 80);
    }
  });
}
async function queryMidjourneyTaskRaw(taskId, apiKey, timeoutMs = 180000) {
  const id = String(taskId || '').trim();
  if (!id) throw new Error('task_id 不能为空');
  let mjRaw = null;
  let taskRaw = null;
  let mjErr = null;
  let taskErr = null;
  try {
    mjRaw = await getJsonApimart(`/midjourney/${encodeURIComponent(id)}`, apiKey, timeoutMs);
  } catch (e) { mjErr = e; }
  try {
    taskRaw = await queryApimartTaskBatchAware(id, apiKey, timeoutMs);
  } catch (e) { taskErr = e; }
  if (!mjRaw && !taskRaw) {
    throw new Error(`Midjourney 任务查询失败：MJ查询=${mjErr ? (mjErr.message || mjErr) : 'unknown'}；统一任务查询=${taskErr ? (taskErr.message || taskErr) : 'unknown'}`);
  }
  if (mjRaw && taskRaw && mjRaw !== taskRaw) {
    const merged = Object.assign({}, taskRaw, mjRaw);
    // buttons / grid_image_url / image_urls 以 MJ 风格查询为准；
    // status / progress 缺失时再回退统一任务查询。
    if (!merged.status && taskRaw.status) merged.status = taskRaw.status;
    if (!merged.progress && taskRaw.progress) merged.progress = taskRaw.progress;
    if (!merged.id && taskRaw.id) merged.id = taskRaw.id;
    return merged;
  }
  return mjRaw || taskRaw;
}

function extractUploadUrlFromAny(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^https?:\/\//i.test(s)) return s;
    const m = s.match(/https?:\/\/[^"'\s<>]+/i);
    return m ? m[0] : '';
  }
  if (typeof raw !== 'object') return '';
  return raw.url || raw?.data?.url || raw?.data?.[0]?.url || raw?.result?.url || raw?.result?.file_url || raw?.file_url || raw?.upload_url || raw?.location || extractUploadUrlFromAny(raw.raw || '');
}

function parseUploadResponseText(txt) {
  const rawText = String(txt || '').trim();
  if (!rawText) return { json:{}, url:'' };
  try {
    const json = JSON.parse(rawText);
    return { json, url: extractUploadUrlFromAny(json) };
  } catch {
    return { json:{ raw: rawText }, url: extractUploadUrlFromAny(rawText) };
  }
}

function runCurlForFile(args, timeoutMs = 180000, input = '') {
  return new Promise((resolve, reject) => {
    const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const child = spawn(exe, args, { windowsHide:true });
    let stdout = '', stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`curl 超时 ${Math.ceil(timeoutMs/1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString('utf8'));
    child.stderr.on('data', d => stderr += d.toString('utf8'));
    child.on('error', e => { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
    child.on('close', code => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status:code, stdout, stderr }); });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}
async function uploadImageToApimartByCurl(apiKey, filePath, proxyUrl = '') {
  const args = ['-sS','-L','--connect-timeout','4','--max-time','120'];
  if (proxyUrl) args.push('--proxy', proxyUrl);
  args.push('-X','POST','https://api.apimart.ai/v1/uploads/images','-H',`Authorization: Bearer ${apiKey || ''}`,'-F',`file=@${filePath}`);
  const r = await runCurlForFile(args, 125000);
  if (r.status !== 0) throw new Error(`curl 上传参考图失败${proxyUrl ? '（代理 '+proxyUrl+'）' : ''}：${(r.stderr || r.stdout || '').slice(0,800)}`);
  const { json, url } = parseUploadResponseText(r.stdout);
  if (!url) throw new Error('APIMart 上传图片未返回 URL：' + compactJsonForLog(json, 600));
  markGoodApimartProxy(proxyUrl);
  return url;
}
async function uploadImageToApimart(apiKey, filePath) {
  const errors = [];
  for (const proxy of getApimartProxyCandidates(readConfig().apimart_proxy_url || '')) {
    try { return await uploadImageToApimartByCurl(apiKey, filePath, proxy); }
    catch(e) { errors.push(`[${proxy}] ${e.message || e}`); }
  }
  try {
    const data = fs.readFileSync(filePath);
    const blob = new Blob([data], { type: contentType(filePath) || 'application/octet-stream' });
    const fd = new FormData();
    fd.append('file', blob, path.basename(filePath));
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 15000);
    try {
      const res = await fetch('https://api.apimart.ai/v1/uploads/images', { method:'POST', headers:{ 'Authorization':`Bearer ${apiKey}` }, body:fd, signal:controller.signal });
      const txt = await res.text();
      const { json, url } = parseUploadResponseText(txt);
      if (!res.ok) throw new Error(json?.error?.message || json?.message || txt || `APIMart upload HTTP ${res.status}`);
      if (!url) throw new Error('APIMart 上传图片未返回 URL：' + compactJsonForLog(json, 600));
      return url;
    } finally { clearTimeout(timer); }
  } catch(e) {
    errors.push('fetch直连上传失败：' + (e.message || e));
    throw new Error('上传参考图失败：' + errors.join(' | '));
  }
}
async function curlDownloadVideoResult(urlValue, destPath, proxyUrl = '') {
  fs.mkdirSync(path.dirname(destPath), { recursive:true });
  const args = ['-sS','-L','--connect-timeout','12','--max-time','900'];
  if (proxyUrl) args.push('--proxy', proxyUrl);
  args.push('-o', destPath, String(urlValue));
  const r = await runCurlForFile(args, 905000);
  if (r.status !== 0) throw new Error(`curl 下载视频失败${proxyUrl ? '（代理 '+proxyUrl+'）' : ''}：${(r.stderr || r.stdout || '').slice(0,800)}`);
  const st = fs.existsSync(destPath) ? fs.statSync(destPath) : { size:0 };
  if (!st.size) throw new Error('curl 下载视频失败：文件为空');
  markGoodApimartProxy(proxyUrl);
  return destPath;
}
async function downloadVideoResult(urlValue, destPath) {
  if (!urlValue) return '';
  const errors = [];
  for (const proxy of getApimartProxyCandidates(readConfig().apimart_proxy_url || '')) {
    try { return await curlDownloadVideoResult(urlValue, destPath, proxy); }
    catch(e) { errors.push(`[${proxy}] ${e.message || e}`); }
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(), 30000);
    try {
      const res = await fetch(urlValue, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(destPath), { recursive:true });
      fs.writeFileSync(destPath, buf);
      return destPath;
    } finally { clearTimeout(timer); }
  } catch(e) {
    errors.push(`直连下载失败：${e.message || e}`);
    throw new Error('远端视频已生成，但下载到本地失败：' + errors.join(' | '));
  }
}

function videoOutputBaseDir() {
  const cfg = readConfig();
  const configured = String(cfg.output_dir || '').trim();
  if (configured) {
    try {
      fs.mkdirSync(configured, { recursive: true });
      return configured;
    } catch (e) {
      addLog(`video output directory unavailable, falling back: ${configured} / ${e.message || e}`, { ownerId: 'local', level: 'warn' });
    }
  }
  const fallback = path.join(app.getPath('pictures'), OUTPUT_ROOT_NAME);
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}
function videoBatchOutputDir(row = {}) {
  const batchName = safeName(row.video_batch_name || row.video_batch_id || `Video_${beijingDateKey().replace(/-/g, '')}`, 'Video_Batch');
  const dir = path.join(videoOutputBaseDir(), batchName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function videoOutputFilePath(row = {}) {
  const ext = '.mp4';
  const copy = Number(row.copy_index || 0) > 1 ? `_copy${String(row.copy_index).padStart(2, '0')}` : '';
  const source = row.source_video_name ? `_${safeName(path.basename(row.source_video_name, path.extname(row.source_video_name)), 'source')}` : '';
  const name = safeName(`${row.id}${copy}${source}`, row.id || `video_${Date.now().toString(36)}`);
  return path.join(videoBatchOutputDir(row), `${name}${ext}`);
}


async function pollApimartVideoTask(taskId, apiKey, localTaskId) {
  const st = ensureVideoStore();
  const task = st.video_tasks.find(x=>x.id===localTaskId);
  if (!task) return;
  task.status = '生成中';
  task.progress = Math.max(8, Number(task.progress || 0));
  task.progress_text = '已提交，等待首轮批量查询';
  task.updated_at = nowISO();
  getDB()._save();
  const started = Date.now();
  const timeoutMs = 40 * 60 * 1000;
  let firstPoll = true;
  while (Date.now() - started < timeoutMs) {
    task.status = '查询中';
    task.progress = Math.max(10, Number(task.progress || 0));
    task.progress_text = '正在批量查询远端状态';
    task.updated_at = nowISO();
    getDB()._save();
    await new Promise(r=>setTimeout(r, firstPoll ? 5000 : 3500));
    firstPoll = false;
    let status;
    try { status = await queryApimartTaskBatchAware(taskId, apiKey, 120000); }
    catch(e){ task.status = '查询中'; task.last_error = e.message; task.progress_text = '批量查询失败，稍后自动重试'; task.updated_at = nowISO(); getDB()._save(); continue; }
    const sText = pickApimartStatus(status);
    const remoteProgress = pickApimartProgress(status);
    const mappedProgress = remoteProgress || (isApimartPendingStatusText(sText) ? 18 : 72);
    task.progress = Math.max(0, Math.min(100, mappedProgress));
    task.status_payload = status;
    task.updated_at = nowISO();
    if (sText === 'failed' || sText === 'cancelled') {
      let failureStatus = status;
      try {
        const single = await getJsonApimart(`/tasks/${encodeURIComponent(taskId)}`, apiKey, 120000);
        if (single) {
          failureStatus = single;
          task.status_payload = single;
        }
      } catch (detailError) {
        task.last_error = detailError.message || String(detailError);
      }
      task.status = '失败';
      task.progress_text = '任务失败';
      task.raw_error_message = pickApimartTaskErrorMessage(failureStatus, '视频任务失败');
      task.error_message = task.raw_error_message;
      if (/interaction status=failed/i.test(task.error_message) && String(task.model || '').toLowerCase() === 'gemini-omni-flash-preview') {
        task.error_message = 'Gemini Omni Flash 上游交互失败：请求已通过 APIMart 参数校验，但 Google 视频处理阶段拒绝或中止。请缩短并简化编辑指令，避免把“续写/延长视频”和“编辑原视频”混在同一个任务中；也可能是临时内容审核或上游故障。';
      }
      task.finished_at = nowISO();
      getDB()._save();
      addLog(`视频任务失败：${task.error_message}`, { ownerId: task.owner_id, level:'error' });
      throw new Error(task.error_message);
    }
    task.status = '生成中';
    task.progress_text = videoProgressTextByStatus(sText, task.progress, 'query');
    let videoUrl = pickApimartVideoUrl(status);
    if ((sText === 'completed' || sText === 'succeeded' || sText === 'success' || sText === 'finished') && !videoUrl) {
      try {
        const single = await getJsonApimart(`/tasks/${encodeURIComponent(taskId)}`, apiKey, 120000);
        task.status_payload = single;
        videoUrl = pickApimartVideoUrl(single);
        if (!videoUrl) {
          task.status = '失败';
          task.progress_text = '任务失败';
          task.error_message = 'APIMart 视频任务已完成，但程序未能从响应中解析视频 URL。批量响应：' + compactJsonForLog(status, 700) + '；单任务响应：' + compactJsonForLog(single, 1200);
          task.finished_at = nowISO();
          task.updated_at = nowISO();
          closePublicVideoByPath(task.local_video_path);
          getDB()._save();
          addLog(`视频任务解析失败：${task.error_message}`, { ownerId: task.owner_id, level:'error' });
          return;
        }
      } catch(e) { task.last_error = e.message || String(e); }
    }
    if ((sText === 'completed' || sText === 'succeeded' || sText === 'success' || sText === 'finished' || videoUrl) && videoUrl) {
      const filePath = videoOutputFilePath(task);
      task.status = '下载中';
      task.progress = Math.max(96, Number(task.progress || 0));
      task.progress_text = videoProgressTextByStatus('completed', task.progress, 'download');
      task.updated_at = nowISO();
      getDB()._save();
      try { await downloadVideoResult(videoUrl, filePath); task.file_path = filePath; } catch(e) { task.download_error = e.message; }
      task.remote_url = videoUrl; task.status = '已完成'; task.progress = 100; task.progress_text = '已完成'; task.finished_at = nowISO(); task.updated_at = nowISO(); closePublicVideoByPath(task.local_video_path); getDB()._save(); addLog(`视频任务完成：${task.id}`, { ownerId: task.owner_id }); return;
    }
    getDB()._save();
  }
  task.status = '失败'; task.progress_text = '视频任务累计超时'; task.error_message = '视频任务累计超时'; task.finished_at = nowISO(); task.updated_at = nowISO(); closePublicVideoByPath(task.local_video_path); getDB()._save();
}

function splitVideoPrompts(text, multiline=true) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (multiline === false) return [raw];
  const blankParts = raw.split(/\n\s*\n+/).map(x=>x.trim()).filter(Boolean);
  if (blankParts.length > 1) return blankParts;
  return raw.split(/\n+/).map(x=>x.trim()).filter(Boolean);
}
async function runLimited(items, limit, worker) {
  const ret = [];
  let idx = 0;
  const n = Math.max(1, Number(limit || 1));
  const workers = Array.from({length: Math.min(n, items.length)}, async()=>{
    while (idx < items.length) {
      const my = idx++;
      try { ret[my] = await worker(items[my], my); }
      catch(e) { ret[my] = { ok:false, error:e.message || String(e) }; }
    }
  });
  await Promise.all(workers);
  return ret;
}

function normalizeFlow2VideoEndpoint(input='') {
  const value = String(input || 'http://127.0.0.1:38000').trim().replace(/\/+$/, '');
  return value || 'http://127.0.0.1:38000';
}

function resolveFlow2VideoModel(body={}, imageCount=0, hasVideo=false) {
  const requestedVariant = String(body.video_model || '').toLowerCase();
  const requestedSeconds = Number(body.duration);
  const orientation = String(body.aspect_ratio || '') === '9:16' ? 'portrait' : 'landscape';
  if (['omni','omni-flash','omni-flash-ext'].includes(requestedVariant)) {
    if (hasVideo) {
      return {
        model:`omni_flash_edit_${orientation}`,
        mode:'Omni Flash · 上传视频编辑',
        variant:'omni', seconds:0, orientation, resolution:'720p'
      };
    }
    const seconds = [4,6,8,10].includes(requestedSeconds) ? requestedSeconds : 4;
    const mode = imageCount > 1 ? '多素材生成' : imageCount === 1 ? '首帧生成' : '文生视频';
    const type = imageCount > 1 ? 'r2v' : imageCount === 1 ? 'i2v' : 't2v';
    return {
      model:`omni_flash_${type}_${seconds}s_${orientation}`,
      mode:`Omni Flash · ${mode}`,
      variant:'omni',
      seconds,
      orientation,
      resolution:'720p'
    };
  }
  const variant = ['lite','lite-low','fast','quality'].includes(requestedVariant) ? requestedVariant : 'fast';
  const modelVariant = variant === 'lite-low' ? 'lite' : variant;
  const seconds = [4,6,8].includes(requestedSeconds) ? requestedSeconds : 8;
  const resolution = ['1080p','4k'].includes(String(body.resolution || '').toLowerCase()) ? String(body.resolution).toLowerCase() : '720p';
  const upscale = modelVariant === 'quality' && resolution !== '720p' ? `_${resolution}` : '';
  const durationSuffix = seconds === 8 ? '' : `_${seconds}s`;
  let model;
  let mode;
  if (imageCount > 2) {
    model = `veo_3_1_r2v_fast_${orientation}`;
    mode = '多素材生成';
  } else if (imageCount > 0) {
    mode = imageCount === 2 ? '首尾帧生成' : '首帧生成';
    if (modelVariant === 'lite') {
      model = imageCount === 2
        ? (seconds === 8 ? `veo_3_1_interpolation_lite_${orientation}` : `veo_3_1_interpolation_lite_${seconds}s_${orientation}`)
        : (seconds === 8 ? `veo_3_1_i2v_lite_${orientation}` : `veo_3_1_i2v_lite_${seconds}s_${orientation}`);
    } else if (modelVariant === 'fast') {
      const fastOrientation = orientation === 'portrait' ? 'portrait_' : '';
      model = `veo_3_1_i2v_s_fast_${fastOrientation}${durationSuffix ? `${durationSuffix.slice(1)}_` : ''}fl`;
    } else {
      model = `veo_3_1_i2v_s_${orientation}${durationSuffix}${upscale}`;
    }
  } else {
    mode = '文生视频';
    if (modelVariant === 'lite') model = seconds === 8 ? `veo_3_1_t2v_lite_${orientation}` : `veo_3_1_t2v_lite_${seconds}s_${orientation}`;
    else if (modelVariant === 'fast') model = `veo_3_1_t2v_fast_${orientation}${durationSuffix}`;
    else model = `veo_3_1_t2v_${orientation}${durationSuffix}${upscale}`;
  }
  return { model, mode, variant, seconds, orientation, resolution: modelVariant === 'quality' ? resolution : '720p' };
}

function flow2VideoProgress(text='', current=0) {
  const value = String(text || '');
  if (/缓存|下载视频/.test(value)) return Math.max(current, 95);
  const matches = [...value.matchAll(/生成进度\s*[:：]\s*(\d{1,3})%/g)];
  const match = matches[matches.length - 1];
  if (match) return Math.max(current, Math.min(92, 45 + Math.round(Number(match[1]) * .47)));
  if (/视频生成中|轮询|已提交/.test(value)) return Math.max(current, 45);
  if (/上传.*图片|参考图片/.test(value)) return Math.max(current, 22);
  if (/打码|验证|提交.*请求/.test(value)) return Math.max(current, 34);
  if (/初始化|启动/.test(value)) return Math.max(current, 8);
  return current;
}

function flow2VideoResultUrl(text='') {
  const urls = String(text || '').match(/https?:\/\/[^\s\)\]\}"']+/g) || [];
  return urls.find(url => /flow-content\.google\/video\//i.test(url) || /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(url)) || '';
}

function friendlyFlow2VideoError(error) {
  const raw = String(error?.message || error || 'Flow2API 视频生成失败');
  if (/PUBLIC_ERROR_UNUSUAL_ACTIVITY|UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC|recaptcha evaluation failed/i.test(raw)) {
    return '本地 Flow2API 视频编辑提交未通过 Google Flow reCAPTCHA 校验。网页端能生成时，通常不是账号限制，而是 Captcha Worker 未连接或仍在使用 Docker 内置浏览器；请保持 Chrome 中 Flow 页面打开，并确认 Flow2API Captcha Worker 已连接后重试。';
  }
  if (/没有可用的Token/i.test(raw)) return 'Flow2API 当前没有可用 Token，请在 Token 管理中检查账号状态后重试。';
  return raw;
}

async function runFlow2VideoTask(row, body, ownerId) {
  const st = ensureVideoStore();
  const touch = (status, progress, progressText, extra={}) => {
    const nextProgress = Math.max(0, Math.min(100, Number(progress || 0)));
    const changed = row.status !== status || Number(row.progress || 0) !== nextProgress || row.progress_text !== progressText;
    Object.assign(row, extra, { status, progress:nextProgress, progress_text:progressText, updated_at:nowISO() });
    if (changed) {
      if (!Array.isArray(row.progress_history)) row.progress_history = [];
      row.progress_history.push({ at:row.updated_at, status, progress:nextProgress, text:progressText });
      if (row.progress_history.length > 40) row.progress_history = row.progress_history.slice(-40);
    }
    getDB()._save();
  };
  try {
    touch('提交中', 2, '正在连接本地 Flow2API');
    const endpoint = normalizeFlow2VideoEndpoint(body.api_endpoint);
    const submittedPrompt = String(row.submitted_prompt || row.prompt || '');
    const content = [{ type:'text', text:submittedPrompt }];
    for (const image of (Array.isArray(body.ref_images) ? body.ref_images : [])) {
      const data = typeof image === 'string' ? image : image && image.data;
      if (data) content.push({ type:'image_url', image_url:{ url:data } });
    }
    const sourceIndex = Math.max(0, Number(row.source_video_index || 0));
    const sourceItem = Array.isArray(body.video_files) && body.video_files.length ? body.video_files[sourceIndex] : null;
    let sourceVideo = sourceItem
      ? (typeof sourceItem === 'string' ? sourceItem : sourceItem?.data)
      : String(body.video_url || '').trim();
    if (sourceItem && typeof sourceItem === 'object' && sourceItem.data) {
      const localSourcePath = dataUrlToFile(sourceItem, ownerId);
      if (localSourcePath) {
        row.local_video_path = localSourcePath;
        row.video_url = buildLocalFlow2VideoUrl(localSourcePath, ownerId, endpoint);
        sourceVideo = row.video_url;
        touch(row.status || '提交中', Math.max(3, Number(row.progress || 0)), 'Source video prepared for local Flow2API upload', {
          local_video_path: localSourcePath,
          video_url: row.video_url
        });
      }
    }
    if (sourceVideo) content.push({ type:'video_url', video_url:{ url:sourceVideo } });
    if (/^omni_flash_edit_/i.test(String(row.model || '')) && !sourceVideo) {
      const imageCount = Array.isArray(body.ref_images) ? body.ref_images.length : 0;
      const orientation = String(row.aspect_ratio || body.aspect_ratio || '') === '9:16' ? 'portrait' : 'landscape';
      const seconds = [4,6,8,10].includes(Number(row.duration || body.duration)) ? Number(row.duration || body.duration) : 4;
      const type = imageCount > 1 ? 'r2v' : imageCount === 1 ? 'i2v' : 't2v';
      row.model = `omni_flash_${type}_${seconds}s_${orientation}`;
      row.mode = imageCount > 1 ? 'Omni Flash multi-material' : imageCount === 1 ? 'Omni Flash image-to-video' : 'Omni Flash text-to-video';
      row.duration = seconds;
      row.resolution = '720p';
      touch('生成中', Math.max(4, Number(row.progress || 0)), 'No source video; switched to Omni Flash generation mode', {
        model: row.model,
        mode: row.mode
      });
    }
    const requestBody = { model:row.model, messages:[{ role:'user', content:content.length === 1 ? submittedPrompt : content }], stream:true };
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${body.api_key}`, 'Content-Type':'application/json' },
      body:JSON.stringify(requestBody)
    });
    if (!response.ok) throw new Error(`Flow2API HTTP ${response.status}：${(await response.text()).slice(0, 800)}`);
    if (!response.body) throw new Error('Flow2API 没有返回流式响应');
    touch('生成中', 6, 'Flow2API 已连接，等待生成阶段');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let output = '';
    let lastSavedText = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream:!done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const event of events) {
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          let packet;
          try { packet = JSON.parse(raw); } catch { continue; }
          if (packet.error) throw new Error(packet.error.message || packet.error || 'Flow2API 视频生成失败');
          const delta = packet.choices?.[0]?.delta?.content ?? packet.choices?.[0]?.message?.content ?? '';
          if (!delta) continue;
          output += delta;
          const clean = String(delta).replace(/\s+/g, ' ').trim();
          const nextProgress = flow2VideoProgress(output, row.progress || 0);
          if (clean && (clean !== lastSavedText || nextProgress !== row.progress)) {
            lastSavedText = clean;
            touch('生成中', nextProgress, clean.slice(0, 140), { stream_message:clean.slice(0, 300) });
          }
        }
      }
      if (done) break;
    }
    const remoteUrl = flow2VideoResultUrl(output);
    if (!remoteUrl) throw new Error(`Flow2API 已结束响应，但没有解析到视频地址：${output.slice(-600)}`);
    touch('下载中', 96, '视频生成完成，正在保存到本机', { remote_url:remoteUrl });
    const filePath = videoOutputFilePath(row);
    await downloadVideoResult(remoteUrl, filePath);
    touch('已完成', 100, '已完成', { file_path:filePath, remote_url:remoteUrl, finished_at:nowISO(), error_message:'' });
    addLog(`Flow2API 视频任务完成：${row.id} model=${row.model}`, { ownerId });
  } catch (error) {
    const rawError = String(error?.message || error || '');
    const canFallbackToOmni = !body._flow2OmniFallback
      && /^veo_/i.test(String(row.model || ''))
      && /Generation job finished with state:\s*FAILED|state:\s*FAILED|code:\s*13/i.test(rawError);
    if (canFallbackToOmni) {
      const hasSourceVideo = Boolean((Array.isArray(body.video_files) && body.video_files.length) || String(body.video_url || '').trim());
      const imageCount = Array.isArray(body.ref_images) ? body.ref_images.length : 0;
      const orientation = String(row.aspect_ratio || body.aspect_ratio || '') === '9:16' ? 'portrait' : 'landscape';
      const seconds = [4,6,8,10].includes(Number(row.duration || body.duration)) ? Number(row.duration || body.duration) : 4;
      const type = hasSourceVideo ? 'edit' : imageCount > 1 ? 'r2v' : imageCount === 1 ? 'i2v' : 't2v';
      row.model = hasSourceVideo ? `omni_flash_edit_${orientation}` : `omni_flash_${type}_${seconds}s_${orientation}`;
      row.mode = 'Omni Flash fallback from Veo';
      row.duration = hasSourceVideo ? 0 : seconds;
      row.resolution = '720p';
      touch('生成中', Math.max(46, Number(row.progress || 0)), 'Veo failed, retrying with Omni Flash', {
        model: row.model,
        error_message: ''
      });
      addLog(`Flow2API Veo failed, retrying with Omni Flash: ${row.id} -> ${row.model}`, { ownerId });
      return runFlow2VideoTask(row, { ...body, video_model:'omni', duration:seconds, _flow2OmniFallback:true }, ownerId);
    }
    const message = friendlyFlow2VideoError(error);
    const retryLimit = Math.max(0, Number(row.retry_times ?? body.retry_times ?? 0));
    const retryCount = Math.max(0, Number(row.retry_count || 0));
    if (retryCount < retryLimit) {
      const nextRetry = retryCount + 1;
      touch('重试中', Math.max(1, Number(row.progress || 0)), `失败重试 ${nextRetry}/${retryLimit}`, {
        error_message: message,
        retry_count: nextRetry,
        retry_times: retryLimit
      });
      addLog(`Flow2API 视频任务失败，准备重试 ${nextRetry}/${retryLimit}：${row.id}`, { ownerId, level:'warn' });
      return runFlow2VideoTask(row, { ...body, retry_times:retryLimit, _flow2OmniFallback:body._flow2OmniFallback }, ownerId);
    }
    touch('失败', Math.max(1, Number(row.progress || 0)), '视频任务失败', { error_message:message, finished_at:nowISO() });
    addLog(`Flow2API 视频任务失败：${row.error_message}`, { ownerId, level:'error' });
  }
  return row;
}

async function createFlow2VideoBatch(body, ownerId) {
  const apiKey = String(body.api_key || '').trim();
  if (!apiKey) throw new Error('请填写本地 Flow2API API Key');
  const hasVideo = Boolean((Array.isArray(body.video_files) && body.video_files.length) || String(body.video_url || '').trim());
  const originalPrompts = splitVideoPrompts(body.prompts || body.prompt || '', body.prompt_multiline_tasks === true);
  if (!originalPrompts.length) throw new Error('请输入视频提示词');
  const refs = Array.isArray(body.ref_images) ? body.ref_images.filter(item => item && (typeof item === 'string' || item.data)) : [];
  const retryTimes = safeInt(body.retry_times, 2, 0, 10);
  // Preserve the exact text entered by the user. Flow2API receives Chinese
  // prompts directly and no third-party translation request is made.
  const promptEntries = originalPrompts.map(prompt => ({ original:prompt, submitted:prompt, translated:false }));
  const requestedModel = String(body.video_model || 'omni').toLowerCase();
  if (hasVideo && !['omni', 'omni-flash', 'omni-flash-ext'].includes(requestedModel)) {
    throw new Error('本地 Flow2API 上传视频编辑仅支持 Omni Flash。Veo 3.1 仅支持文生视频或图生视频，请移除源视频后再选择 Veo 模型。');
  }
  const modelInfo = resolveFlow2VideoModel(body, refs.length, hasVideo);
  const copies = safeInt(body.copies, 1, 1, 50);
  const sourceVideos = hasVideo
    ? (Array.isArray(body.video_files) && body.video_files.length
      ? body.video_files.map((item, index) => ({ item, index }))
      : [{ item:null, index:0 }])
    : [{ item:null, index:0 }];
  const batchId = uuid('video_batch_');
  const batchName = `Flow2_${beijingDateKey().replace(/-/g,'')}_${new Date().toISOString().slice(11,19).replace(/:/g,'')}`;
  const rows = [];
  for (const promptEntry of promptEntries) {
    for (const sourceVideo of sourceVideos) {
      for (let copy = 1; copy <= copies; copy++) {
        const sourceFile = sourceVideo.item && typeof sourceVideo.item === 'object' ? sourceVideo.item : null;
      rows.push({
        id:uuid('video_'), owner_id:ownerId, task_id:'', status:'等待提交', progress:0, progress_text:'等待提交到本地 Flow2API',
        platform:'flow2api', prompt:promptEntry.original, submitted_prompt:promptEntry.submitted, prompt_translated:promptEntry.translated === true, model:modelInfo.model, resolution:modelInfo.resolution, aspect_ratio:body.aspect_ratio === '9:16' ? '9:16' : '16:9', duration:modelInfo.seconds,
        mode:modelInfo.mode, image_count:refs.length, video_url:hasVideo ? (sourceFile?.data ? '' : String(body.video_url || '')) : '', local_video_path:'', source_video_index:sourceVideo.index, source_video_name:sourceFile?.name || (body.video_url ? 'external_url' : ''), remote_url:'', file_path:'', error_message:'',
      video_batch_id:batchId, video_batch_name:batchName, copy_index:copy, retry_times:retryTimes, retry_count:0, created_at:nowISO(), updated_at:nowISO()
      });
      }
    }
  }
  const st = ensureVideoStore();
  st.video_tasks.unshift(...rows);
  getDB()._save();
  setImmediate(() => runLimited(rows, Math.max(1, rows.length), row => runFlow2VideoTask(row, { ...body, ref_images:refs }, ownerId)).catch(error => addLog(`Flow2API 视频批次异常：${error.message || error}`, { ownerId, level:'error' })));
  addLog(`Flow2API 视频批次已创建：model=${modelInfo.model} mode=${modelInfo.mode} tasks=${rows.length}`, { ownerId });
  return { ok:true, count:rows.length, video_count:sourceVideos.length, prompt_count:originalPrompts.length, success:rows.length, fail:0, rows:rows.map(formatVideoTask) };
}

function compactGeminiOmniEditPrompt(input = '') {
  let text = String(input || '').replace(/\r/g, '\n').trim();
  if (!text) return '';
  text = text
    .replace(/^【[^】]*(?:续写|结尾节点|负面提示)[^】]*】\s*/i, '')
    .split(/(?:^|\n)\s*(?:【?\s*)?(?:负面提示词|Negative Prompt|Chinese Explanation|中文解说)(?:\s*】)?\s*[:：]?/i)[0]
    .replace(/结尾\s*\d+\s*秒\s*(?:续写|延长)|结尾节点提示词|续写视频|延长视频/gi, '编辑原视频')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!/^编辑原视频[。,.，]/.test(text)) text = `编辑原视频。${text}`;
  if (text.length > 420) {
    const clipped = text.slice(0, 420);
    const sentenceEnd = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('！'), clipped.lastIndexOf('；'));
    text = (sentenceEnd >= 180 ? clipped.slice(0, sentenceEnd + 1) : clipped).trim();
  }
  return text;
}

async function retryApimartVideoRow(row, body, ownerId, req, cfg, error) {
  if (!row) return null;
  const retryLimit = Math.max(0, Number(row.retry_times ?? body.retry_times ?? 0));
  const retryCount = Math.max(0, Number(row.retry_count || 0));
  const permanent = isPermanentApimartVideoError(error);
  row.status = '失败';
  row.progress_text = '任务失败';
  row.error_message = error?.message || String(error || 'APIMart video task failed');
  row.updated_at = nowISO();
  if (!permanent && retryCount < retryLimit) {
    const nextRetry = retryCount + 1;
    const isGeminiInteractionFailure = String(row.model || '').toLowerCase() === 'gemini-omni-flash-preview'
      && !!(row.local_video_path || row.video_url || body.local_video_path || body.video_url)
      && /interaction status=failed|Gemini Omni Flash 上游交互失败/i.test(String(row.raw_error_message || row.error_message || ''))
      && body._gemini_omni_prompt_fallback !== true;
    if (isGeminiInteractionFailure) {
      const compactPrompt = compactGeminiOmniEditPrompt(body.prompt || row.prompt || '');
      if (compactPrompt && compactPrompt !== String(body.prompt || row.prompt || '').trim()) {
        row.original_prompt = row.original_prompt || row.prompt || body.prompt || '';
        row.prompt = compactPrompt;
        row.retry_count = nextRetry;
        row.retry_times = retryLimit;
        row.status = '重试中';
        row.progress = Math.max(1, Number(row.progress || 0));
        row.progress_text = `Gemini 编辑指令精简重试 ${nextRetry}/${retryLimit}`;
        row.error_message = '';
        row.updated_at = nowISO();
        getDB()._save();
        addLog(`Gemini Omni interaction 失败，已自动改为纯视频编辑指令并在同一任务重试 ${nextRetry}/${retryLimit}：${row.id}`, { ownerId, level:'warn' });
        return createApimartVideoTask({
          ...body,
          prompt:compactPrompt,
          prompts:compactPrompt,
          retry_times:retryLimit,
          _gemini_omni_prompt_fallback:true
        }, ownerId, req, cfg, row);
      }
    }
    row.retry_count = nextRetry;
    row.retry_times = retryLimit;
    row.status = '重试中';
    row.progress = Math.max(1, Number(row.progress || 0));
    row.progress_text = `失败重试 ${nextRetry}/${retryLimit}`;
    row.task_id = '';
    row.remote_url = '';
    row.file_path = '';
    row.download_url = '';
    row.finished_at = '';
    getDB()._save();
    addLog(`APIMart 视频任务失败，复用同一任务重试 ${nextRetry}/${retryLimit}：${row.id}`, { ownerId, level:'warn' });
    return createApimartVideoTask({ ...body, retry_times:retryLimit }, ownerId, req, cfg, row);
  }
  row.finished_at = nowISO();
  getDB()._save();
  closePublicVideoByPath(row.local_video_path);
  addLog(`APIMart 视频任务最终失败：${row.error_message}`, { ownerId, level:'error' });
  return row;
}

function isPermanentApimartVideoError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return /model_not_found|model not found|invalid model|unsupported|不支持|仅支持|api key|unauthorized|forbidden|无权限/.test(msg);
}

async function createApimartVideoTask(body, ownerId, req, cfg, existingRow = null) {
  const apiKey = String(body.api_key || '').trim();
  if (!apiKey) throw new Error('请填写 APIMart API Key');
  const prompt = String(body.prompt || '').trim();
  if (!prompt) throw new Error('请输入视频提示词');
  const refImages = Array.isArray(body.ref_images) ? body.ref_images : [];
  const videoItem = body.video_file || null;
  const videoUrlInput = String(body.video_url || '').trim();
  const prebuiltLocalVideoPath = String(body.local_video_path || '').trim();
  const sourceVideoName = String(body.source_video_name || '').trim();
  const st = ensureVideoStore();
  const videoModel = canonicalApimartVideoModel(body.video_model || 'omni-flash-ext');
  const localId = existingRow?.id || uuid('video_');
  const retryTimes = safeInt(body.retry_times, Number(cfg.retryTimes || 2), 0, 10);
  const fallbackVideoBatchId = body.video_batch_id || uuid('video_batch_');
  const fallbackVideoBatchName = body.video_batch_name || `Video_${beijingDateKey().replace(/-/g,'')}_${new Date().toISOString().slice(11,19).replace(/:/g,'')}`;
  const initialImageCount = refImages.length + (Array.isArray(body.ref_image_urls) ? body.ref_image_urls.filter(Boolean).length : 0);
  const requestedMode = resolveApimartVideoMode(body.video_mode, { imageCount: initialImageCount, hasVideo: !!(videoItem || videoUrlInput || prebuiltLocalVideoPath) });
  // V12.2：任务一创建就进入视频生成库，数量立即与“视频数 × 提示词数”匹配；随后每个任务独立提交并轮询 task_id。
  const row = existingRow || {
    id:localId, owner_id:ownerId, task_id:'', status:'等待提交', progress:0, progress_text:'等待提交到 APIMart', platform:'apimart',
    prompt, model:videoModel, resolution:body.resolution || '1080p', aspect_ratio:body.aspect_ratio || '9:16', duration:'',
    mode: videoItem || videoUrlInput ? '参考视频编辑' : (refImages.length || (body.ref_image_urls||[]).length ? '图生视频' : '文生视频'),
    image_urls:Array.isArray(body.ref_image_urls) ? body.ref_image_urls.filter(Boolean) : [],
    video_url:videoUrlInput, local_video_path:'', remote_url:'', file_path:'', error_message:'',
        video_batch_id: fallbackVideoBatchId,
        video_batch_name: fallbackVideoBatchName,
        retry_times: retryTimes,
        retry_count: 0,
        created_at:nowISO(), updated_at:nowISO()
      };
  if (!existingRow) st.video_tasks.unshift(row);
  row.video_batch_id = row.video_batch_id || fallbackVideoBatchId;
  row.video_batch_name = row.video_batch_name || fallbackVideoBatchName;
  row.owner_id = row.owner_id || ownerId;
  row.platform = 'apimart';
  row.model = videoModel;
  row.prompt = prompt;
  row.retry_times = retryTimes;
  row.task_id = '';
  row.remote_url = '';
  row.file_path = '';
  row.download_url = '';
  row.error_message = '';
  row.finished_at = '';
  getDB()._save();
  try {
    row.status = '提交中'; row.progress = 2; row.progress_text = '正在提交到 APIMart'; row.updated_at = nowISO(); getDB()._save();
    const localVideoPath = prebuiltLocalVideoPath || row.local_video_path || (videoItem ? dataUrlToFile(videoItem, ownerId) : '');
    let videoUrl = videoUrlInput || (localVideoPath ? await buildPublicVideoUrlAuto(localVideoPath, cfg, ownerId, req) : '');
    const imageUrls = Array.isArray(body.ref_image_urls) ? body.ref_image_urls.filter(Boolean) : [];
    if (!imageUrls.length) {
      for (const img of refImages) {
        const fp = dataUrlToFile(img, ownerId);
        if (!fp) continue;
        imageUrls.push(await uploadImageToApimart(apiKey, fp));
      }
    }
    assertApimartVideoReferenceRules({ imageUrls, videoUrl, context:'视频任务' });
    const rule = getApimartVideoRule(videoModel);
    if (Array.isArray(rule.allowedImageCounts) && !rule.allowedImageCounts.includes(imageUrls.length)) {
      throw new Error(`${rule.label || videoModel} 参考图数量仅支持 ${rule.allowedImageCounts.join('/')} 张，当前为 ${imageUrls.length} 张。`);
    }
    if (Number(rule.maxImageCount || 0) > 0 && imageUrls.length > Number(rule.maxImageCount)) {
      throw new Error(`${rule.label || videoModel} 参考图最多支持 ${rule.maxImageCount} 张，当前为 ${imageUrls.length} 张。`);
    }
    const mode = resolveApimartVideoMode(body.video_mode, { imageCount: imageUrls.length, hasVideo: !!videoUrl });
    const acceptsImages = rule.supportsImageUrls || rule.supportsImageWithRoles || !!rule.imageParam;
    if (imageUrls.length && !acceptsImages) throw new Error(`${rule.label || videoModel} 不支持参考图片输入。`);
    if (Number(rule.minImageCount || 0) > imageUrls.length) throw new Error(`${rule.label || videoModel} 至少需要 ${rule.minImageCount} 张参考图片。`);
    if (rule.minReferenceCount && imageUrls.length + (videoUrl ? 1 : 0) < Number(rule.minReferenceCount)) throw new Error(`${rule.label || videoModel} 至少需要一张参考图片或一个参考视频。`);
    if (rule.maxReferenceCount && imageUrls.length + (videoUrl ? 1 : 0) > Number(rule.maxReferenceCount)) throw new Error(`${rule.label || videoModel} 的参考图片和视频合计最多 ${rule.maxReferenceCount} 个。`);
    if (rule.requiredVideo && !videoUrl) throw new Error(`${rule.label || videoModel} 必须上传视频或填写公开视频 URL。`);
    if (videoUrl && String(rule.model || videoModel).toLowerCase() === 'happyhorse-1.0' && imageUrls.length > 5) throw new Error('HappyHorse 1.0 视频编辑最多支持 5 张参考图片。');
    if (videoUrl && !rule.supportsVideoUrls) throw new Error(`${rule.label || videoModel} 不支持上传视频编辑，请切换 Omni Flash。`);
    if (videoUrl && Number(rule.maxVideoCount || 0) > 0 && Number(rule.maxVideoCount) < 1) throw new Error(`${rule.label || videoModel} 不支持上传视频编辑。`);
    const payload = { model: rule.model || videoModel, prompt };
    const normalizedResolution = normalizeVideoResolution(body.resolution, videoModel);
    const normalizedAspectRatio = normalizeVideoAspectRatio(body.aspect_ratio, videoModel);
    // Field names are model-specific: for example Grok uses quality/size while Kling uses mode.
    if (rule.modeFromResolution) {
      payload.mode = String(normalizedResolution).toLowerCase() === '4k' ? '4k' : (String(normalizedResolution).toLowerCase() === '1080p' ? 'pro' : 'std');
    } else if (rule.resolutionParam !== false) {
      payload[rule.resolutionParam || 'resolution'] = normalizedResolution;
    }
    const omitAspect = (imageUrls.length && rule.omitAspectWithImages) || (videoUrl && rule.omitAspectWithVideo);
    if (!omitAspect && rule.aspectParam !== false) payload[rule.aspectParam || 'aspect_ratio'] = normalizedAspectRatio;
    if (imageUrls.length) {
      if (rule.imageParam === 'skyreels') {
        if (mode === 'multi_reference' || imageUrls.length > 2) {
          payload.ref_images = [];
          for (let i = 0; i < imageUrls.length; i += 5) {
            const tag = `@image${payload.ref_images.length + 1}`;
            payload.ref_images.push({ tag, type:'image', image_urls:imageUrls.slice(i, i + 5) });
            if (!payload.prompt.includes(tag)) payload.prompt = `${tag} ${payload.prompt}`;
          }
        } else {
          payload.first_frame_image = imageUrls[0];
          if (imageUrls[1]) payload.end_frame_image = imageUrls[1];
        }
      } else if (rule.imageParam === 'pixverse') {
        if (mode === 'multi_reference' || imageUrls.length > 2) payload.img_references = imageUrls;
        else if (mode === 'first_last_frame' || imageUrls.length === 2) {
          payload.first_frame_image = imageUrls[0];
          payload.last_frame_image = imageUrls[1];
        } else payload.image_urls = [imageUrls[0]];
      } else if (rule.imageParam === 'image_url') {
        payload.image_url = imageUrls[0];
      } else if (rule.imageParam === 'first_frame_image' && (imageUrls.length === 1 || (mode === 'first_last_frame' && rule.supportsLastFrame))) {
        payload.first_frame_image = imageUrls[0];
        if (imageUrls[1] && rule.supportsLastFrame) payload.last_frame_image = imageUrls[1];
        else if (imageUrls.length > 1 && rule.supportsImageUrls) payload.image_urls = imageUrls;
      } else if (rule.supportsImageWithRoles && (mode === 'first_frame' || mode === 'first_last_frame' || !rule.supportsImageUrls)) {
        const imageWithRoles = buildApimartVideoImageRolePayload(videoModel, imageUrls, mode);
        if (imageWithRoles.length) payload.image_with_roles = imageWithRoles;
      } else if (rule.supportsImageUrls) {
        payload.image_urls = imageUrls;
      } else if (rule.imageParam === 'first_frame_image') {
        payload.first_frame_image = imageUrls[0];
      }
    }
    if (String(payload.model || '').toLowerCase() === 'omni-flash-ext' && imageUrls.length) {
      payload.generation_type = (videoUrl || mode === 'multi_reference' || imageUrls.length > 1) ? 'reference' : 'frame';
    }
    if (videoUrl) {
      try {
        await probePublicVideoUrl(videoUrl);
      } catch (probeError) {
        const canRenewTunnel = !!localVideoPath
          && (cfg.public_provider || 'cloudflare') !== 'manual'
          && /HTTP 5\d\d|超时|fetch failed|socket|ECONN|network/i.test(String(probeError?.message || probeError || ''));
        if (!canRenewTunnel) throw probeError;
        addLog(`公网视频通道失效，正在自动重建：${probeError.message || probeError}`, { ownerId, level:'warn' });
        await restartPublicTunnelForVideoReference(readConfig());
        videoUrl = await buildPublicVideoUrlAuto(localVideoPath, readConfig(), ownerId, req);
        await probePublicVideoUrl(videoUrl);
      }
      if (rule.videoParam === 'video_url') payload.video_url = videoUrl;
      else if (rule.videoParam === 'video_list') {
        payload.video_list = [{ video_url:videoUrl, refer_type:'base', keep_original_sound:'yes' }];
      } else if (rule.videoParam === 'ref_videos') {
        const tag = '@video1';
        payload.ref_videos = [{ tag, type:String(body.video_reference_type || 'reference') === 'extend' ? 'extend' : 'reference', video_url:videoUrl }];
        if (!payload.prompt.includes(tag)) payload.prompt = `${tag} ${payload.prompt}`;
      } else payload.video_urls = [videoUrl];
    }
    let durationRule = rule;
    if (videoUrl && Array.isArray(rule.videoDurationRange)) durationRule = { ...rule, durations:undefined, durationRange:rule.videoDurationRange };
    if ((mode === 'first_last_frame' || (imageUrls.length === 2 && rule.imageParam === 'pixverse')) && Array.isArray(rule.firstLastDurations)) durationRule = { ...rule, durationRange:undefined, durations:rule.firstLastDurations };
    const resolutionDurations = rule.resolutionDurationRules && rule.resolutionDurationRules[normalizedResolution];
    if (Array.isArray(resolutionDurations)) durationRule = { ...rule, durationRange:undefined, durations:resolutionDurations, defaultDuration:resolutionDurations[0] };
    if (rule.supportsDuration !== false && (!videoUrl || rule.durationWithVideo)) {
      payload.duration = normalizeVideoDurationForRule(body.duration, durationRule.defaultDuration ?? 6, durationRule, payload.model);
    }
    if (rule.audioParam && !(videoUrl && rule.videoParam === 'video_list')) payload[rule.audioParam] = rule.forceAudio ? true : body.generate_audio !== false && rule.defaultAudio !== false;
    if (rule.watermarkParam) payload[rule.watermarkParam] = body.watermark === true;
    if (rule.cameraFixedParam) payload[rule.cameraFixedParam] = body.camera_fixed === true;
    if (rule.returnLastFrameParam) payload[rule.returnLastFrameParam] = body.return_last_frame === true;
    if (rule.promptOptimizerParam) payload[rule.promptOptimizerParam] = body.prompt_optimizer !== false;
    if (rule.fastPretreatmentParam) payload[rule.fastPretreatmentParam] = body.fast_pretreatment === true;
    if (rule.motionModeParam) payload[rule.motionModeParam] = 'normal';
    if (rule.characterOrientationParam) payload[rule.characterOrientationParam] = ['image','video'].includes(body.character_orientation) ? body.character_orientation : 'image';
    if (rule.negativePromptParam && String(body.negative_prompt || '').trim()) payload[rule.negativePromptParam] = String(body.negative_prompt).trim();
    let submitEndpoint = '/videos/generations';
    let suppressSeed = false;
    if (mode === 'veo_remix') {
      const sourceTaskId = String(body.source_task_id || '').trim();
      const taskExtendModel = String(payload.model).toLowerCase();
      if (!sourceTaskId) throw new Error('任务续写需要填写已完成的原任务 ID。');
      if (imageUrls.length || videoUrl) throw new Error('任务续写使用原任务 ID，不能同时上传参考图片或视频。');
      if (['veo3.1-fast','veo3.1-quality'].includes(taskExtendModel)) {
        submitEndpoint = `/videos/${encodeURIComponent(sourceTaskId)}/remix`;
        payload.raw = body.remix_raw === true;
        delete payload.duration;
        suppressSeed = true;
      } else if (['pixverse-v6','gemini-omni-flash-preview'].includes(taskExtendModel)) {
        payload.extend_from_task_id = sourceTaskId;
      } else {
        throw new Error('任务续写仅支持 VEO3.1 Fast / Quality、Pixverse v6 或 Gemini Omni Flash。');
      }
    }
    const seed = optionalInt(body.seed);
    if (seed !== undefined && rule.supportsSeed !== false && !suppressSeed) payload.seed = seed;
    row.resolution = normalizedResolution;
    row.aspect_ratio = normalizedAspectRatio;
    row.duration = payload.duration ?? '';
    row.mode = videoUrl ? '参考视频编辑' : (imageUrls.length ? '图生视频' : '文生视频');
    row.mode = apimartVideoModeLabel(mode);
    if (mode === 'veo_remix') row.mode = '任务续写';
    row.image_urls = imageUrls;
    row.video_url = videoUrl;
    row.reference_public_url = videoUrl;
    row.local_video_path = localVideoPath;
    row.submission_payload = payload;
    if (sourceVideoName) row.source_video_name = sourceVideoName;
    if (body.source_video_duration) row.source_video_duration = body.source_video_duration;
    row.updated_at = nowISO(); getDB()._save();
    let ret;
    addLog(`视频请求参数：endpoint=${submitEndpoint} model=${payload.model} resolution=${payload.resolution || payload.quality || payload.mode || ''} aspect=${payload.aspect_ratio || payload.size || ''} duration=${payload.duration ?? (rule.supportsDuration === false ? '模型自动' : '参考视频模式')} images=${imageUrls.length} videos=${videoUrl ? 1 : 0}`, { ownerId });
    try {
      ret = await postJsonApimart(submitEndpoint, apiKey, payload, 30000);
      addLog(`视频接口返回：${JSON.stringify(ret).slice(0, 1000)}`, { ownerId });
    }
    catch(e) {
      const normalized = normalizeApimartVideoError(e, !!videoUrl);
      addLog(`视频接口请求失败：${normalized}`, { ownerId, level:'error' });
      throw new Error(normalized);
    }
    const taskId = pickTaskIdFromApimart(ret);
    if (!taskId) {
      const responseText = JSON.stringify(ret).slice(0, 1200);
      throw new Error(`APIMart 未返回 task_id。实际响应：${responseText}。程序已在 V14.4.4 中按标准 fetch 优先并加入 curl/PowerShell/Node 兜底；如果这里仍没有 task_id，请打开日志查看“APIMart 标准请求 / fetch HTTP 原始响应 / curl / PowerShell 响应”，并检查 API Key、余额、模型权限、接口网关是否返回空 JSON。`);
    }
    row.task_id = taskId;
    row.status = '已提交';
    row.progress = 5;
    row.progress_text = '已提交，等待批量查询结果';
    row.updated_at = nowISO(); getDB()._save();
    addLog(`视频任务提交：${taskId}`, { ownerId });
    pollApimartVideoTask(taskId, apiKey, localId).catch(e=>retryApimartVideoRow(row, body, ownerId, req, cfg, e));
    return row;
  } catch (e) {
    row.status = '失败';
    row.progress_text = '任务失败';
    row.error_message = e.message || String(e);
    row.finished_at = nowISO();
    row.updated_at = nowISO();
    const retryLimit = Math.max(0, Number(row.retry_times || body.retry_times || 0));
    const retryCount = Math.max(0, Number(row.retry_count || 0));
    if (!isPermanentApimartVideoError(e) && retryCount < retryLimit) {
      const nextRetry = retryCount + 1;
      row.retry_count = nextRetry;
      row.retry_times = retryLimit;
      row.status = '重试中';
      row.progress_text = `失败重试 ${nextRetry}/${retryLimit}`;
      row.error_message = e.message || String(e);
      row.updated_at = nowISO();
      getDB()._save();
      addLog(`APIMart 视频任务失败，准备重试 ${nextRetry}/${retryLimit}：${row.id}`, { ownerId, level:'warn' });
      return createApimartVideoTask({ ...body, retry_times:retryLimit }, ownerId, req, cfg, row);
    }
    closePublicVideoByPath(row.local_video_path);
    getDB()._save();
    addLog(`视频任务失败：${row.error_message}`, { ownerId, level:'error' });
    return row;
  }
}
async function createApimartVideoBatch(body, ownerId, req, cfg) {
  const apiKey = String(body.api_key || '').trim();
  if (!apiKey) throw new Error('请填写 APIMart API Key');
  const prompts = splitVideoPrompts(body.prompts || body.prompt || '', body.prompt_multiline_tasks === true);
  if (!prompts.length) throw new Error('请输入视频提示词');

  const videoFiles = Array.isArray(body.video_files) ? body.video_files : (body.video_file ? [body.video_file] : []);
  const videoUrlInput = String(body.video_url || '').trim();
  const refImages = Array.isArray(body.ref_images) ? body.ref_images : [];

  // V12.7 修复：批量上传多个参考视频时，先逐个落盘并生成各自独立的 public-video URL。
  // 避免并发提交时反复转换 dataURL / 复用同一个链接，导致提交到 APIMart 的参考视频看起来都一样。
  const sourceVideos = [];
  if (videoFiles.length) {
    for (let i = 0; i < videoFiles.length; i++) {
      const item = videoFiles[i];
      const rawDuration = safeFloat(item && item.duration_seconds, NaN);
      const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : NaN;
      // V14.7.6：0.00 秒通常是浏览器/编码元数据误读，不作为真实时长显示，也不阻止提交。
      if (Number.isFinite(duration) && (duration < 2.5 || duration > 10.5)) {
        addLog(`视频 ${item && item.name ? item.name : i+1} 本地读取时长 ${duration.toFixed(2)} 秒，继续提交，若超出 APIMart 限制将显示远端错误`, { ownerId, level:'warn' });
      } else if (!Number.isFinite(duration)) {
        addLog(`视频 ${item && item.name ? item.name : i+1} 本地时长未准确读取，继续提交，真实时长以 APIMart 远端识别为准`, { ownerId, level:'info' });
      }
      const localPath = dataUrlToFile(item, ownerId);
      if (!localPath) continue;
      // V12.7: 只先落盘，不提前生成/探测公网链接。真正执行到该任务时再创建短公网链接，避免大量 public-video 链接同时开放和探测造成卡顿。
      sourceVideos.push({
        source_index: i + 1,
        name: item && item.name ? item.name : `video_${i+1}${path.extname(localPath) || '.mp4'}`,
        local_video_path: localPath,
        video_url: '',
        duration_seconds: Number.isFinite(duration) ? duration : ''
      });
    }
  } else if (videoUrlInput) {
    await probePublicVideoUrl(videoUrlInput);
    sourceVideos.push({ source_index: 1, name: 'external_url', local_video_path: '', video_url: videoUrlInput });
  } else {
    sourceVideos.push({ source_index: 1, name: '', local_video_path: '', video_url: '' });
  }
  if (!sourceVideos.length) throw new Error('没有可用的视频任务，请上传 mp4/mov 或填写公网视频直链');

  const refImageUrls = [];
  for (const img of refImages) {
    const fp = dataUrlToFile(img, ownerId);
    if (!fp) continue;
    refImageUrls.push(await uploadImageToApimart(apiKey, fp));
  }
  assertApimartVideoReferenceRules({ imageUrls: refImageUrls, videoUrl: videoUrlInput || (videoFiles.length ? 'local_video_upload' : ''), context:'视频批量任务' });

  const tasks = [];
  const copies = safeInt(body.copies, 1, 1, 4);
  for (const src of sourceVideos) {
    for (const prompt of prompts) {
      for (let copy = 1; copy <= copies; copy++) tasks.push({ ...src, prompt, copy_index:copy });
    }
  }

  const concurrency = safeInt(body.concurrency, 1, 1, 50);
  const videoBatchId = uuid('video_batch_');
  const videoBatchName = `Video_${beijingDateKey().replace(/-/g,'')}_${new Date().toISOString().slice(11,19).replace(/:/g,'')}`;
  addLog(`视频批量任务开始，并发：${concurrency}，视频：${sourceVideos.length}，提示词：${prompts.length}，任务：${tasks.length}`, { ownerId });
  const rows = await runLimited(tasks, concurrency, async(item)=>{
    addLog(`提交视频任务：第 ${item.source_index} 个视频 ${item.name || ''}`, { ownerId });
    return await createApimartVideoTask({
      ...body,
      prompt:item.prompt,
      video_file:null,
      video_files:[],
      ref_images:[],
      ref_image_urls:refImageUrls,
      video_url:item.video_url || '',
      local_video_path:item.local_video_path || '',
      source_video_name:item.name || '',
      source_video_duration:item.duration_seconds || '',
      video_batch_id: videoBatchId,
      video_batch_name: videoBatchName
    }, ownerId, req, cfg);
  });
  const okRows = rows.filter(x=>x && x.id);
  const failRows = rows.filter(x=>!x || !x.id);
  addLog(`视频批量任务提交完成，成功：${okRows.length}，失败：${failRows.length}`, { ownerId, level: failRows.length ? 'warn' : 'info' });
  return { ok:true, count:tasks.length, video_count:sourceVideos.length, prompt_count:prompts.length, success:okRows.length, fail:failRows.length, rows:okRows.map(formatVideoTask), errors:failRows.map(x=>x && x.error).filter(Boolean) };
}
function deleteVideoTasks(ids = [], owner='') {
  const st = ensureVideoStore();
  const set = new Set((ids || []).filter(Boolean));
  if (!set.size) throw new Error('请选择要删除的视频');
  const removed = [];
  st.video_tasks = (st.video_tasks || []).filter(v=>{
    const hit = set.has(v.id) && (!owner || v.owner_id === owner);
    if (hit) {
      removed.push(v);
      try { if (v.file_path && fs.existsSync(v.file_path)) fs.unlinkSync(v.file_path); } catch {}
    }
    return !hit;
  });
  getDB()._save();
  return { ok:true, deleted:removed.length };
}
function exportSelectedVideos(ids = [], owner='') {
  const st = ensureVideoStore();
  const set = new Set((ids || []).filter(Boolean));
  const rows = (st.video_tasks || []).filter(v=>set.has(v.id) && (!owner || v.owner_id === owner) && v.file_path && fs.existsSync(v.file_path));
  if (!rows.length) throw new Error('选中的视频没有已保存到本地的文件，无法导出');
  const zipDir = path.join(DATA_ROOT, 'zips');
  const zipPath = path.join(zipDir, `selected_videos_${Date.now().toString(36)}.zip`);
  zipFiles(rows.map(v=>v.file_path), zipPath, 'selected_videos');
  return zipPath;
}
function formatVideoTask(row, opts = {}) {
  row = opts.fast ? row : repairVideoTaskFilePath(row);
  const hasFile = opts.fast ? !!row.file_path : !!(row.file_path && fs.existsSync(row.file_path));
  const stream = hasFile ? `/video-file?id=${encodeURIComponent(row.id)}${opts.allOwners ? '&all_owners=1' : ''}` : '';
  const cacheReady = !opts.fast && hasFile && row.file_path ? fs.existsSync(localHotMediaCachePath(row.file_path)) : false;
  return { ...row, file_exists: hasFile, video_cache_ready: cacheReady, progress_text: row.progress_text || (row.status === '\u5df2\u5b8c\u6210' ? '\u5df2\u5b8c\u6210' : ''), stream_url: stream, share_url: hasFile ? `/video-share?id=${encodeURIComponent(row.id)}` : '', url: stream || row.remote_url || '', download_url: hasFile ? `/download?path=${encodeURIComponent(row.file_path)}` : (row.remote_url || ''), filename: hasFile ? path.basename(row.file_path) : `${row.id}.mp4` };
}

function listVideoBatchSummaries(owner = '') {
  cleanupStaleVideoTasks(owner);
  const st = ensureVideoStore();
  const groups = new Map();
  for (const row of st.video_tasks || []) {
    if (owner && row.owner_id !== owner) continue;
    const created = row.created_at || '';
    const day = beijingDateKey(created) || 'unknown';
    const minute = formatBeijingTime(created).slice(11, 16).replace(':', '') || '0000';
    const key = row.video_batch_id || `legacy_${day}_${minute}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([id, rows]) => {
    rows.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    const first = rows[0] || {};
    const latest = rows.reduce((acc, row) => String(row.updated_at || row.created_at || '').localeCompare(String(acc || '')) > 0 ? (row.updated_at || row.created_at || '') : acc, first.updated_at || first.created_at || '');
    const taskCount = rows.length;
    const successCount = rows.filter(v => String(v.status || '') === '已完成').length;
    const failCount = rows.filter(v => String(v.status || '').includes('失败')).length;
    const runningCount = rows.filter(v => ['等待提交','提交中','重试中','已提交','提交生成中','生成中','查询中','下载中'].includes(String(v.status || ''))).length;
    const status = runningCount ? '生成中' : (successCount === taskCount && taskCount ? '已完成' : (failCount === taskCount && taskCount ? '失败' : (successCount ? '部分完成' : '失败')));
    return {
      id,
      name: first.video_batch_name || `Video_${formatBeijingTime(first.created_at || '').replace(/[^\d]/g, '').slice(0, 14) || id}`,
      note: '',
      model: first.platform === 'flow2api' ? '本地 Flow2API' : (first.model || 'APIMart'),
      size: [first.resolution, first.aspect_ratio].filter(Boolean).join(' / '),
      status,
      task_count: taskCount,
      success_count: successCount,
      fail_count: failCount,
      running_count: runningCount,
      created_at: first.created_at || '',
      updated_at: latest,
      batch_type: 'video',
      video_ids: rows.map(v => v.id).filter(Boolean)
    };
  }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function videoTodayStats(owner='') {
  const st = ensureVideoStore();
  const today = beijingDateKey();
  const rows = (st.video_tasks || []).filter(v => (!owner || v.owner_id === owner) && beijingDateKey(v.created_at || '') === today);
  return {
    total: rows.length,
    done: rows.filter(v => v.status === '已完成').length,
    fail: rows.filter(v => v.status === '失败').length,
    running: rows.filter(v => ['等待中','提交中','提交生成中','生成中','查询中','下载中'].includes(v.status)).length
  };
}

function findVideoTaskById(id, owner='') {
  const st = ensureVideoStore();
  return (st.video_tasks || []).find(v => v.id === id && (!owner || v.owner_id === owner));
}

function resolveVideoTaskFilePath(row = {}) {
  const cfg = readConfig();
  const owner = String(row.owner_id || '').trim() || 'local';
  const bases = [];
  const currentBase = String(videoOutputBaseDir() || '').trim();
  if (currentBase) bases.push(currentBase);
  const fallbackBase = path.join(app.getPath('pictures'), OUTPUT_ROOT_NAME);
  if (fallbackBase && !bases.includes(fallbackBase)) bases.push(fallbackBase);
  if (cfg.output_dir && !bases.includes(cfg.output_dir)) bases.push(cfg.output_dir);
  if (Array.isArray(cfg.legacy_output_dirs)) bases.push(...cfg.legacy_output_dirs.filter(Boolean));
  const candidates = [];
  if (row.file_path) candidates.push(String(row.file_path));
  for (const base of bases) {
    const batchFolder = safeName(row.video_batch_name || row.video_batch_id || '', '');
    if (batchFolder) {
      candidates.push(path.join(base, batchFolder, `${row.id}.mp4`));
      candidates.push(path.join(base, batchFolder, `${row.id}${Number(row.copy_index || 0) > 1 ? `_copy${String(row.copy_index).padStart(2, '0')}` : ''}.mp4`));
    }
    candidates.push(path.join(base, owner, `${row.id}.mp4`));
    candidates.push(path.join(base, `${row.id}.mp4`));
  }
  for (const fp of candidates) {
    try { if (fp && fs.existsSync(fp)) return fp; } catch {}
  }
  return row.file_path || '';
}
function repairVideoTaskFilePath(row = {}) {
  const filePath = resolveVideoTaskFilePath(row);
  if (filePath && filePath !== row.file_path) row.file_path = filePath;
  return row;
}


function quotePowerShellLiteralPath(filePath) {
  return "'" + String(filePath || '').replace(/'/g, "''") + "'";
}
function copyFileToSystemClipboard(filePath, label='文件') {
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`${label}源文件不存在，无法复制。`);
  const platform = process.platform;
  if (platform !== 'win32') throw new Error(`当前系统暂不支持直接复制${label}源文件。`);
  return new Promise((resolve, reject) => {
    // Windows Explorer 文件剪贴板：Set-Clipboard -LiteralPath 可以把文件本体放入剪贴板，支持直接粘贴到文件夹/微信/QQ等支持文件粘贴的地方。
    const cmd = `Set-Clipboard -LiteralPath ${quotePowerShellLiteralPath(filePath)}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true });
    let err = '';
    child.stderr.on('data', b => err += b.toString('utf8'));
    child.on('error', e => reject(new Error('调用系统剪贴板失败：' + e.message)));
    child.on('close', code => code === 0 ? resolve(true) : reject(new Error(err.trim() || `复制${label}源文件失败，PowerShell exit ${code}`)));
  });
}
function copyVideoFileToSystemClipboard(filePath) { return copyFileToSystemClipboard(filePath, '视频'); }
async function streamVideoFile(file, req, res, download=false, opts = {}) {
  if (!opts.trustedLocal) {
    try { file = resolveServedFilePath(file, readConfig()); }
    catch { return sendText(res, 'video access denied', 'text/plain', 403); }
  }
  if (!download && opts.previewOnly) {
    const cachedPath = localHotMediaCachePath(file);
    if (fs.existsSync(cachedPath)) {
      try { fs.utimes(cachedPath, new Date(), new Date(), ()=>{}); } catch {}
      file = cachedPath;
    }
  }
  if (!file || !fs.existsSync(file)) return sendText(res, 'video not found', 'text/plain', 404);
  if (!download && !opts.previewOnly) {
    let sourceStat = null;
    try { sourceStat = await fs.promises.stat(file); } catch { sourceStat = null; }
    const cachedPath = localHotMediaCachePath(file);
    if (fs.existsSync(cachedPath)) {
      try { fs.utimes(cachedPath, new Date(), new Date(), ()=>{}); } catch {}
      file = cachedPath;
    } else if (sourceStat && shouldHotCacheMedia(file, sourceStat, contentType(file))) {
      const promise = ensureLocalHotMedia(file, sourceStat, contentType(file)).catch(()=> '');
      const waitMs = Math.min(1800, Math.max(450, hotCacheAwaitMs(file, sourceStat)));
      const ready = await Promise.race([promise, new Promise(resolve => setTimeout(()=>resolve(''), waitMs))]);
      if (ready && fs.existsSync(ready)) file = ready;
    }
  }
  const stat = fs.statSync(file);
  const total = stat.size;
  const type = contentType(file) || 'video/mp4';
  const filename = path.basename(file);
  const baseHeaders = {
    ...BASE_SECURITY_HEADERS,
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`
  };
  const range = req.headers.range;
  if (req.method === 'HEAD') { res.writeHead(200, {...baseHeaders, 'Content-Length': total}); return res.end(); }
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (start <= end && start < total) {
        res.writeHead(206, {...baseHeaders, 'Content-Range':`bytes ${start}-${end}/${total}`, 'Content-Length':end-start+1});
        return fs.createReadStream(file,{start,end}).pipe(res);
      }
    }
  }
  res.writeHead(200, {...baseHeaders, 'Content-Length': total});
  return fs.createReadStream(file).pipe(res);
}


function ensurePromptLibraryStore() {
  const db = getDB();
  const st = db._store;
  if (!Array.isArray(st.prompt_groups)) st.prompt_groups = [];
  if (!Array.isArray(st.prompt_templates)) st.prompt_templates = [];
  const defaults = [
    ['uncategorized','未分类',999],['favorites','常用收藏',1],['ecommerce-main','电商主图',2],['product-selling','产品卖点图',3],['unboxing','真实开箱图',4],['video','图生视频',5],['img2img','图生图',6],['keyframe','首帧/尾帧',7],['action','人物动作',8],['skincare','皮肤护理',9],['slimming-patch','瘦身贴片',10],['ad-copy','广告文案',11],['chat','AI聊天',12]
  ];
  let changed = false;
  // 只在空库首次初始化默认分组；删除后不自动恢复。
  if (st.prompt_groups.length === 0) {
    for (const [id,name,sort_order] of defaults) st.prompt_groups.push({ id, name, sort_order, system:false, created_at:nowISO(), updated_at:nowISO() });
    changed = true;
  }
  for (const g of st.prompt_groups) { if (g.system === true) { g.system = false; changed = true; } if (typeof g.sort_order === 'undefined') { g.sort_order = 100; changed = true; } }
  if (changed) db._save();
  return st;
}
function canWritePromptLibrary(local, cfg) { return !!local || cfg.prompt_library_permission_shared === true; }
function promptLibraryResponse(local, cfg) {
  const st = ensurePromptLibraryStore();
  const groups = [{ id:'all', name:'全部', sort_order:-999, system:true, virtual:true }, ...st.prompt_groups.slice().sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0))];
  const templates = st.prompt_templates.slice().sort((a,b)=>String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||'')));
  return { ok:true, groups, templates, can_manage:!!local, can_write:canWritePromptLibrary(local,cfg), permission_shared:cfg.prompt_library_permission_shared===true };
}
function upsertPromptGroup(body, local, cfg, deviceOwner) {
  if (!canWritePromptLibrary(local, cfg)) throw new Error('当前没有提示词库分组编辑权限');
  const st = ensurePromptLibraryStore();
  const action = body.action || (body.id ? 'update' : 'create');
  if (body.id === 'all') throw new Error('“全部”是筛选入口，不能编辑或删除');
  if (action === 'delete') {
    const g = st.prompt_groups.find(x=>x.id === body.id);
    if (!g) throw new Error('分组不存在');
    if (!local && g.created_by && g.created_by !== deviceOwner) throw new Error('访问端只能删除自己创建的分组');
    st.prompt_groups = st.prompt_groups.filter(x=>x.id !== body.id);
    let fallback = st.prompt_groups.find(x=>x.id === 'uncategorized') || st.prompt_groups[0];
    if (!fallback) { fallback = { id:'uncategorized', name:'未分类', sort_order:999, system:false, created_at:nowISO(), updated_at:nowISO() }; st.prompt_groups.push(fallback); }
    for (const t of st.prompt_templates) if (t.group_id === body.id) t.group_id = fallback.id;
    getDB()._save(); return {ok:true, moved_to:fallback.id};
  }
  const name = String(body.name || '').trim();
  if (!name) throw new Error('分组名称不能为空');
  if (action === 'create') {
    const id = 'grp_' + uuid('').replace(/[^a-zA-Z0-9]/g,'');
    st.prompt_groups.push({ id, name, sort_order:Number(body.sort_order || Date.now()), system:false, created_by:deviceOwner, created_at:nowISO(), updated_at:nowISO() });
    getDB()._save(); return {ok:true, id};
  }
  const g = st.prompt_groups.find(x=>x.id === body.id);
  if (!g) throw new Error('分组不存在');
  if (!local && g.created_by && g.created_by !== deviceOwner) throw new Error('访问端只能重命名自己创建的分组');
  g.name = name; g.system = false; if (typeof body.sort_order !== 'undefined') g.sort_order = Number(body.sort_order || 0); g.updated_at = nowISO();
  getDB()._save(); return {ok:true, id:g.id};
}
function upsertPromptTemplate(body, local, cfg, deviceOwner) {
  if (!canWritePromptLibrary(local, cfg)) throw new Error('当前没有提示词库编辑权限');
  const st = ensurePromptLibraryStore();
  const action = body.action || (body.id ? 'update' : 'create');
  const existing = body.id ? st.prompt_templates.find(t=>t.id === body.id) : null;
  if ((action === 'update' || action === 'delete') && !existing) throw new Error('模板不存在');
  if (!local && existing && existing.created_by && existing.created_by !== deviceOwner) throw new Error('访问端只能编辑自己创建的模板');
  if (action === 'delete') { st.prompt_templates = st.prompt_templates.filter(t=>t.id !== body.id); getDB()._save(); return {ok:true}; }
  const title = String(body.title || '').trim();
  const content = String(body.content || '').trim();
  if (!title) throw new Error('模板标题不能为空');
  if (!content) throw new Error('提示词内容不能为空');
  const row = existing || { id:'tpl_' + uuid('').replace(/[^a-zA-Z0-9]/g,''), created_at:nowISO(), created_by:deviceOwner };
  Object.assign(row,{ title, content, group_id:body.group_id || 'uncategorized', type:body.type || '通用', tags:Array.isArray(body.tags)?body.tags:String(body.tags||'').split(/[,，\s]+/).filter(Boolean), note:body.note || '', updated_at:nowISO() });
  if (!existing) st.prompt_templates.push(row);
  getDB()._save(); return {ok:true, id:row.id};
}

function assetClientId(local, deviceOwner='') {
  return local ? 'host' : (String(deviceOwner || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'guest');
}
function defaultAssetLibraryDir(cfg=readConfig()) {
  return path.resolve(String(cfg.asset_library_dir || '').trim() || path.join(app.getPath('userData'), 'assets_library'));
}
function ensureInside(base, target) {
  const b = path.resolve(base);
  const t = path.resolve(target);
  if (t !== b && !t.startsWith(b + path.sep)) throw new Error('路径不在资产库目录内');
  return t;
}
function pathKey(p) {
  const resolved = path.resolve(String(p || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function currentStoreFilePath() {
  return path.join(DATA_ROOT, 'data', 'store.json');
}
function runtimeMirrorDir(cfg = readConfig()) {
  const base = String(cfg.output_dir || '').trim();
  return base ? path.join(base, OUTPUT_RUNTIME_DATA_DIR_NAME) : '';
}
function legacyRuntimeMirrorDir(cfg = readConfig()) {
  const base = String(cfg.output_dir || '').trim();
  return base ? path.join(base, LEGACY_OUTPUT_RUNTIME_DATA_DIR_NAME) : '';
}
function runtimeMirrorCandidateDirs(cfg = readConfig()) {
  return Array.from(new Set([runtimeMirrorDir(cfg), legacyRuntimeMirrorDir(cfg)].filter(Boolean)));
}

const chatHistoryCache = new Map();
const chatHistoryWriteChains = new Map();
function chatHistoryOwnerKey(owner = '') {
  return cleanOwner(owner || 'local', false) || 'local';
}
function chatHistoryStoragePaths(owner = '', cfg = readConfig()) {
  const filename = `${chatHistoryOwnerKey(owner)}.json`;
  const localFile = path.join(DATA_ROOT, 'data', 'chat_history', filename);
  const outputRuntime = runtimeMirrorDir(cfg);
  const outputFile = outputRuntime ? path.join(outputRuntime, 'chat_history', filename) : '';
  return uniqueExistingPaths([localFile, outputFile]);
}
function normalizeChatHistoryPayload(payload = {}) {
  const conversations = Array.isArray(payload.conversations) ? payload.conversations : [];
  return {
    version: 1,
    current_chat_id: String(payload.current_chat_id || ''),
    updated_at: new Date().toISOString(),
    conversations: conversations
      .filter(item => item && typeof item === 'object' && String(item.id || '').trim())
      .map(item => ({
        ...item,
        id: String(item.id || '').slice(0, 160),
        title: String(item.title || '新聊天').slice(0, 500),
        created_at: Number(item.created_at || Date.now()),
        updated_at: Number(item.updated_at || item.created_at || Date.now()),
        messages: Array.isArray(item.messages)
          ? item.messages.filter(message => message && typeof message === 'object').map(message => ({ ...message, streaming:false }))
          : []
      }))
      .sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0))
  };
}
async function readChatHistory(owner = '', cfg = readConfig()) {
  const key = chatHistoryOwnerKey(owner);
  const cached = chatHistoryCache.get(key);
  if (cached) return { ok:true, ...cached, storage:'output' };
  const candidates = [];
  for (const file of chatHistoryStoragePaths(key, cfg)) {
    try {
      const stat = await fs.promises.stat(file);
      candidates.push({ file, mtime:stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates) {
    try {
      const normalized = normalizeChatHistoryPayload(JSON.parse(await fs.promises.readFile(candidate.file, 'utf8')));
      chatHistoryCache.set(key, normalized);
      return { ok:true, ...normalized, storage:'output' };
    } catch {}
  }
  const empty = normalizeChatHistoryPayload({ conversations:[], current_chat_id:'' });
  chatHistoryCache.set(key, empty);
  return { ok:true, ...empty, storage:'output' };
}
async function writeChatHistory(owner = '', payload = {}, cfg = readConfig()) {
  const key = chatHistoryOwnerKey(owner);
  const normalized = normalizeChatHistoryPayload(payload);
  chatHistoryCache.set(key, normalized);
  const previous = chatHistoryWriteChains.get(key) || Promise.resolve();
  const write = previous.catch(()=>{}).then(async () => {
    const json = JSON.stringify(normalized);
    let written = 0;
    let lastError = null;
    for (const file of chatHistoryStoragePaths(key, cfg)) {
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive:true });
        await fs.promises.writeFile(file, json, 'utf8');
        written += 1;
      } catch (error) { lastError = error; }
    }
    if (!written && lastError) throw lastError;
    return { ok:true, count:normalized.conversations.length, updated_at:normalized.updated_at };
  });
  chatHistoryWriteChains.set(key, write);
  try { return await write; }
  finally { if (chatHistoryWriteChains.get(key) === write) chatHistoryWriteChains.delete(key); }
}

const outputMediaIndexState = {
  running:false,
  root:'',
  scanned_batches:0,
  scanned_files:0,
  added_images:0,
  relinked_images:0,
  recovered_batches:0,
  started_at:'',
  finished_at:'',
  error:''
};
function outputMediaIndexMarkerPath() {
  return path.join(DATA_ROOT, 'data', 'output_media_index.json');
}
function recoveredBatchTime(name = '') {
  const match = String(name).match(/(20\d{2})-(\d{2})-(\d{2})_(\d{2})_(\d{2})_(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}` : nowISO();
}
function shouldRunOutputMediaIndex(root = '', force = false) {
  if (force) return true;
  try {
    const marker = JSON.parse(fs.readFileSync(outputMediaIndexMarkerPath(), 'utf8'));
    if (pathKey(marker.root || '') !== pathKey(root || '')) return true;
    return Date.now() - Date.parse(marker.finished_at || 0) > 6 * 60 * 60 * 1000;
  } catch { return true; }
}
async function indexOutputMediaFromConfiguredDir(opts = {}) {
  if (outputMediaIndexState.running) return { ok:true, ...outputMediaIndexState };
  const cfg = readConfig();
  const root = String(cfg.output_dir || '').trim();
  if (!root) return { ok:false, error:'设置中心尚未配置输出目录' };
  if (!shouldRunOutputMediaIndex(root, opts.force === true)) return { ok:true, skipped:true, ...outputMediaIndexState };
  Object.assign(outputMediaIndexState, {
    running:true, root, scanned_batches:0, scanned_files:0, added_images:0,
    relinked_images:0, recovered_batches:0, started_at:new Date().toISOString(), finished_at:'', error:''
  });
  try {
    const rootEntries = await fs.promises.readdir(root, { withFileTypes:true });
    const batchDirs = rootEntries.filter(entry => entry.isDirectory() && /^Batch_/i.test(entry.name));
    const st = getDB()._store;
    const batchesByPath = new Map();
    const batchesByName = new Map();
    for (const batch of st.batches || []) {
      if (batch.output_dir) batchesByPath.set(pathKey(batch.output_dir), batch);
      if (batch.name && !batchesByName.has(String(batch.name).toLowerCase())) batchesByName.set(String(batch.name).toLowerCase(), batch);
    }
    const existingPaths = new Set();
    const imagesByBatchName = new Map();
    for (const image of st.images || []) {
      if (image.file_path) existingPaths.add(pathKey(image.file_path));
      const filename = path.basename(String(image.file_path || '')).toLowerCase();
      if (image.batch_id && filename) imagesByBatchName.set(`${image.batch_id}|${filename}`, image);
    }
    const tasksByBatchIndex = new Map();
    for (const task of st.tasks || []) tasksByBatchIndex.set(`${task.batch_id}|${Number(task.task_index || 0)}`, task);
    const recoveredCounts = new Map();
    let cursor = 0;
    const worker = async () => {
      while (cursor < batchDirs.length) {
        const entry = batchDirs[cursor++];
        const dir = path.join(root, entry.name);
        let files = [];
        try {
          files = (await fs.promises.readdir(dir, { withFileTypes:true }))
            .filter(file => file.isFile() && /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name));
        } catch { continue; }
        outputMediaIndexState.scanned_batches += 1;
        outputMediaIndexState.scanned_files += files.length;
        if (!files.length) continue;
        let batch = batchesByPath.get(pathKey(dir)) || batchesByName.get(entry.name.toLowerCase());
        if (!batch) {
          const createdAt = recoveredBatchTime(entry.name);
          batch = {
            id:uuid('batch_recovered_'), owner_id:'local', name:entry.name, note:'从输出目录恢复', status:'已完成',
            model:'', size:'', image_size:'', concurrency:1, retry_times:0, repeat_count:1,
            task_count:0, success_count:0, fail_count:0, running_count:0, output_dir:dir,
            config_json:'{}', created_at:createdAt, updated_at:createdAt, finished_at:createdAt, recovered_from_output:true
          };
          st.batches.push(batch);
          batchesByName.set(entry.name.toLowerCase(), batch);
          outputMediaIndexState.recovered_batches += 1;
        }
        if (!batch.output_dir || path.basename(String(batch.output_dir)) === entry.name) batch.output_dir = dir;
        const ownerId = batch.owner_id || 'local';
        const taskIndexes = new Set();
        for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
          const file = files[fileIndex];
          const filePath = path.join(dir, file.name);
          const filenameKey = file.name.toLowerCase();
          const prefix = /^(\d{1,6})/.exec(file.name);
          const taskIndex = prefix ? Math.max(1, Number(prefix[1])) : fileIndex + 1;
          taskIndexes.add(taskIndex);
          const taskKey = `${batch.id}|${taskIndex}`;
          let task = tasksByBatchIndex.get(taskKey);
          if (!task) {
            const createdAt = batch.created_at || recoveredBatchTime(entry.name);
            task = {
              id:uuid('task_recovered_'), batch_id:batch.id, owner_id:ownerId, task_index:taskIndex, prompt:'',
              main_image_path:'', ref_images_json:'[]', status:'已完成', attempt:1, progress:100,
              progress_text:'已从输出目录恢复', remote_task_id:'', result_path:filePath,
              thumb_path:path.join(dir, '_thumbs', `${path.basename(file.name, path.extname(file.name))}.png`),
              error_message:'', created_at:createdAt, updated_at:createdAt, finished_at:createdAt,
              recovered_from_output:true
            };
            st.tasks.push(task);
            tasksByBatchIndex.set(taskKey, task);
          }
          const exactKey = pathKey(filePath);
          const thumbPath = path.join(dir, '_thumbs', `${path.basename(file.name, path.extname(file.name))}.png`);
          if (existingPaths.has(exactKey)) continue;
          const oldRow = imagesByBatchName.get(`${batch.id}|${filenameKey}`);
          if (oldRow) {
            oldRow.file_path = filePath;
            if (!oldRow.thumb_path || path.basename(path.dirname(oldRow.thumb_path)).toLowerCase() === '_thumbs') oldRow.thumb_path = thumbPath;
            oldRow.recovered_from_output = true;
            existingPaths.add(exactKey);
            outputMediaIndexState.relinked_images += 1;
            continue;
          }
          const createdAt = task.finished_at || task.updated_at || batch.created_at || recoveredBatchTime(entry.name);
          const row = {
            id:uuid('img_recovered_'), batch_id:batch.id, task_id:task.id, owner_id:ownerId,
            file_path:filePath, thumb_path:thumbPath, size_bytes:0, created_at:createdAt,
            remote_url:'', recovered_from_output:true
          };
          st.images.push(row);
          imagesByBatchName.set(`${batch.id}|${filenameKey}`, row);
          existingPaths.add(exactKey);
          outputMediaIndexState.added_images += 1;
        }
        recoveredCounts.set(batch.id, Math.max(recoveredCounts.get(batch.id) || 0, taskIndexes.size));
        if (outputMediaIndexState.scanned_batches % 40 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    };
    await Promise.all(Array.from({ length:Math.min(6, Math.max(1, batchDirs.length)) }, () => worker()));
    for (const [batchId, count] of recoveredCounts) {
      const batch = st.batches.find(item => item.id === batchId);
      if (!batch) continue;
      batch.task_count = Math.max(Number(batch.task_count || 0), count);
      if (batch.recovered_from_output) batch.success_count = Math.max(Number(batch.success_count || 0), count);
    }
    if (outputMediaIndexState.added_images || outputMediaIndexState.relinked_images || outputMediaIndexState.recovered_batches) getDB()._save();
    outputMediaIndexState.finished_at = new Date().toISOString();
    await fs.promises.mkdir(path.dirname(outputMediaIndexMarkerPath()), { recursive:true });
    await fs.promises.writeFile(outputMediaIndexMarkerPath(), JSON.stringify({ ...outputMediaIndexState, running:false }, null, 2), 'utf8');
    addLog(`输出目录增量索引完成：扫描 ${outputMediaIndexState.scanned_batches} 个批次，补录 ${outputMediaIndexState.added_images} 张图片，修复 ${outputMediaIndexState.relinked_images} 条路径。`);
  } catch (error) {
    outputMediaIndexState.error = error.message || String(error);
    outputMediaIndexState.finished_at = new Date().toISOString();
    addLog(`输出目录增量索引失败：${outputMediaIndexState.error}`, { level:'warn' });
  } finally {
    outputMediaIndexState.running = false;
  }
  return { ok:!outputMediaIndexState.error, ...outputMediaIndexState };
}
function scheduleOutputMediaIndex() {
  const timer = setTimeout(() => indexOutputMediaFromConfiguredDir().catch(()=>{}), 2500);
  if (typeof timer.unref === 'function') timer.unref();
}
let runtimeMirrorInFlight = null;
let runtimeMirrorPending = null;
const runtimeMirrorSignatures = new Map();
async function copyRuntimeMirrorFile(source, destination) {
  let stat = null;
  try { stat = await fs.promises.stat(source); } catch { return false; }
  const key = path.resolve(destination);
  const signature = `${path.resolve(source)}|${stat.size}|${stat.mtimeMs}`;
  if (runtimeMirrorSignatures.get(key) === signature) return false;
  await fs.promises.mkdir(path.dirname(destination), { recursive:true });
  await fs.promises.copyFile(source, destination);
  runtimeMirrorSignatures.set(key, signature);
  return true;
}
async function runRuntimeDataMirror(cfg = readConfig(), opts = {}) {
  const dir = runtimeMirrorDir(cfg);
  if (!dir) return false;
  try {
    await fs.promises.mkdir(path.join(dir, 'data'), { recursive:true });
    if (configPath) await copyRuntimeMirrorFile(configPath, path.join(dir, 'config.json'));
    if (!opts.configOnly) {
      const storeFile = currentStoreFilePath();
      await copyRuntimeMirrorFile(storeFile, path.join(dir, 'data', 'store.json'));
      const assetFile = assetDbPath(cfg);
      if (assetFile) await copyRuntimeMirrorFile(assetFile, path.join(dir, 'assets_meta', 'assets_db.json'));
    }
    return true;
  } catch {
    return false;
  }
}
function mirrorRuntimeDataToOutputDir(cfg = readConfig(), opts = {}) {
  const request = { cfg:{ ...cfg }, opts:{ configOnly:opts.configOnly === true } };
  if (runtimeMirrorInFlight) {
    if (runtimeMirrorPending && runtimeMirrorPending.opts.configOnly === false) request.opts.configOnly = false;
    runtimeMirrorPending = request;
    return true;
  }
  runtimeMirrorInFlight = runRuntimeDataMirror(request.cfg, request.opts).finally(() => {
    runtimeMirrorInFlight = null;
    const pending = runtimeMirrorPending;
    runtimeMirrorPending = null;
    if (pending) mirrorRuntimeDataToOutputDir(pending.cfg, pending.opts);
  });
  return true;
}
function restoreStoreFromOutputMirrorIfCurrentEmpty() {
  try {
    const cfg = readConfig();
    const current = readStoreSummary(currentStoreFilePath());
    if (current && current.count > 0) return false;
    const candidates = runtimeMirrorCandidateDirs(cfg)
      .map(dir => readStoreSummary(path.join(dir, 'data', 'store.json')))
      .filter(summary => summary && summary.count > 0)
      .sort((a, b) => (b.count - a.count) || (b.mtime - a.mtime) || (b.size - a.size));
    const summary = candidates[0];
    if (!summary || summary.count <= 0) return false;
    ensureDir(path.dirname(currentStoreFilePath()));
    fs.copyFileSync(summary.file, currentStoreFilePath());
    rememberHistoricalOutputRootsFromStoreData(summary.data);
    return true;
  } catch {
    return false;
  }
}
const historicalOutputRootsCache = { file: '', roots: [], loaded: false };
function historicalOutputRootsFromCurrentStore() {
  const file = currentStoreFilePath();
  if (historicalOutputRootsCache.loaded && historicalOutputRootsCache.file === file) return historicalOutputRootsCache.roots;
  try {
    const roots = collectOutputRootsFromStoreFile(file);
    historicalOutputRootsCache.file = file;
    historicalOutputRootsCache.roots = roots;
    historicalOutputRootsCache.loaded = true;
    return roots;
  } catch {
    return historicalOutputRootsCache.roots || [];
  }
}
function isPathInside(base, target) {
  const b = pathKey(base);
  const t = pathKey(target);
  return !!b && !!t && (t === b || t.startsWith(b + path.sep));
}
function normalizeServedPathInput(filePath = '') {
  let raw = String(filePath || '').trim();
  if (/%[0-9a-f]{2}/i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch {}
  }
  return path.resolve(raw);
}
let referencedServedPathCache = { ts: 0, keys: new Set() };
function referencedServedPathKeys(cfg = readConfig()) {
  if (Date.now() - referencedServedPathCache.ts < 5000) return referencedServedPathCache.keys;
  const keys = new Set();
  const add = (p) => {
    if (!p) return;
    try { keys.add(pathKey(p)); } catch {}
  };
  try {
    const st = getDB()._store || {};
    for (const img of Array.isArray(st.images) ? st.images : []) {
      add(img.file_path);
      add(img.thumb_path);
    }
    for (const task of Array.isArray(st.tasks) ? st.tasks : []) {
      add(task.result_path);
      add(task.thumb_path);
      add(task.main_image_path);
      add(task.mj_grid_local_path);
      try {
        const refs = JSON.parse(task.ref_images_json || '[]') || [];
        refs.forEach(r => { add(r && (r.file_path || r.local_path)); add(r && r.thumb_path); });
      } catch {}
      try {
        const imgs = JSON.parse(task.mj_images_json || '[]') || [];
        imgs.forEach(r => { add(r && (r.local_path || r.file_path)); add(r && r.thumb_path); });
      } catch {}
    }
    for (const video of Array.isArray(st.video_tasks) ? st.video_tasks : []) {
      add(video.file_path);
      add(video.thumb_path);
      add(video.local_video_path);
    }
    for (const video of Array.isArray(st.public_videos) ? st.public_videos : []) add(video.path);
  } catch {}
  try {
    const adb = readAssetDb(cfg);
    for (const asset of Array.isArray(adb.assets) ? adb.assets : []) {
      add(asset.local_path);
      add(asset.thumb_path);
    }
  } catch {}
  referencedServedPathCache = { ts: Date.now(), keys };
  return keys;
}
function isReferencedServedFile(filePath = '', cfg = readConfig()) {
  const key = pathKey(filePath);
  return !!key && referencedServedPathKeys(cfg).has(key);
}
let allowedFileRootsCache = { ts: 0, key: '', roots: [] };
function allowedFileRoots(cfg = readConfig()) {
  const cacheKey = JSON.stringify({
    output_dir: cfg.output_dir || '',
    legacy_output_dirs: Array.isArray(cfg.legacy_output_dirs) ? cfg.legacy_output_dirs : [],
    asset_library_dir: cfg.asset_library_dir || ''
  });
  if (allowedFileRootsCache.key === cacheKey && Date.now() - allowedFileRootsCache.ts < 5000) return allowedFileRootsCache.roots;
  const roots = [
    path.join(DATA_ROOT, 'uploads'),
    path.join(DATA_ROOT, 'zips'),
    path.join(app.getPath('pictures'), OUTPUT_ROOT_NAME),
    path.join(app.getPath('pictures'), OUTPUT_MJ_DIR_NAME),
    path.join(app.getPath('downloads'), OUTPUT_ZIP_DIR_NAME),
    path.join(app.getPath('downloads'), OUTPUT_WORD_DIR_NAME),
    path.join(app.getPath('downloads'), OUTPUT_EXCEL_DIR_NAME),
    path.join(app.getPath('downloads'), 'LocalApiImageGenerator_AssetLibrary_Zips'),
    updateCacheDir(),
    defaultAssetLibraryDir(cfg)
  ];
  if (cfg.output_dir) roots.push(cfg.output_dir);
  if (Array.isArray(cfg.legacy_output_dirs)) roots.push(...cfg.legacy_output_dirs);
  roots.push(...historicalOutputRootsFromCurrentStore());
  const resolved = Array.from(new Set(roots.map(r => path.resolve(r)).filter(Boolean)));
  allowedFileRootsCache = { ts: Date.now(), key: cacheKey, roots: resolved };
  return resolved;
}
function isAllowedServedFile(filePath = '', cfg = readConfig()) {
  const resolved = normalizeServedPathInput(filePath);
  return allowedFileRoots(cfg).some(root => isPathInside(root, resolved)) || isReferencedServedFile(resolved, cfg);
}
function resolveServedFilePath(filePath = '', cfg = readConfig()) {
  const resolved = normalizeServedPathInput(filePath);
  if (!isAllowedServedFile(resolved, cfg)) throw new Error('文件路径不在允许访问的程序目录内');
  return resolved;
}
function resolveMediaCachePath(filePath = '', cfg = readConfig()) {
  const resolved = normalizeServedPathInput(filePath);
  const key = pathKey(resolved);
  const outputRoot = String(cfg.output_dir || '').trim();
  if (outputRoot && isPathInside(path.resolve(outputRoot), resolved)) return resolved;
  try {
    const st = getDB()._store || {};
    const rows = Array.isArray(st.images) ? st.images : [];
    for (const img of rows) {
      if ((img.file_path && pathKey(img.file_path) === key) || (img.thumb_path && pathKey(img.thumb_path) === key)) return resolved;
    }
  } catch {}
  throw new Error('文件路径不在允许访问的程序目录内');
}
function assetDbPath(cfg=readConfig()) {
  const base = defaultAssetLibraryDir(cfg);
  ensureDir(path.join(base, 'meta'));
  ensureDir(path.join(base, 'files'));
  ensureDir(path.join(base, 'thumbs'));
  return path.join(base, 'meta', 'assets_db.json');
}
function readAssetDb(cfg=readConfig()) {
  const p = assetDbPath(cfg);
  if (!fs.existsSync(p)) {
    const db = { groups: [], assets: [], created_at: nowISO(), updated_at: nowISO() };
    fs.writeFileSync(p, JSON.stringify(db, null, 2), 'utf8');
    return db;
  }
  try {
    const db = JSON.parse(fs.readFileSync(p, 'utf8'));
    db.groups = Array.isArray(db.groups) ? db.groups : [];
    db.assets = Array.isArray(db.assets) ? db.assets : [];
    return db;
  } catch {
    return { groups: [], assets: [], created_at: nowISO(), updated_at: nowISO() };
  }
}
function writeAssetDb(db, cfg=readConfig()) {
  db.updated_at = nowISO();
  fs.writeFileSync(assetDbPath(cfg), JSON.stringify(db, null, 2), 'utf8');
  return db;
}
function ensureDefaultAssetGroups(db, ownerId) {
  // V14.10.37: 用户不需要任何强制默认库。保留旧数据，但不再自动创建默认资产库/角色/场景/智能分类。
  normalizeAssetGroupSchema(db);
  return db;
}
function normalizeAssetGroupSchema(db) {
  const groups = Array.isArray(db.groups) ? db.groups : [];
  const byId = new Map(groups.map(g => [g.id, g]));
  groups.forEach(g => {
    if (!g.type) g.type = g.parent_id ? 'folder' : 'project';
    if (!g.root_project_id) g.root_project_id = g.type === 'project' ? g.id : '';
    g.share_children = g.share_children !== false;
  });
  let changed = true;
  while (changed) {
    changed = false;
    groups.forEach(g => {
      if (g.parent_id) {
        const p = byId.get(g.parent_id);
        const root = p ? (p.root_project_id || p.id) : '';
        if (root && g.root_project_id !== root) {
          g.root_project_id = root;
          changed = true;
        }
        if (g.type !== 'folder') {
          g.type = 'folder';
          changed = true;
        }
      } else if (g.type !== 'project' || g.root_project_id !== g.id) {
        g.type = 'project';
        g.root_project_id = g.id;
        changed = true;
      }
    });
  }
  return db;
}
function canManageAssetRow(row, local, ownerId) {
  return !!local || row.owner_client_id === ownerId;
}
function assetPermission(row, local, ownerId, shared=false) {
  if (local) return 'host';
  if (row && row.owner_client_id === ownerId) return 'owner';
  if (shared || (row && row.shared === true)) return 'shared_viewer';
  return 'none';
}
function assetSharedGroupIds(db) {
  const groups = Array.isArray(db.groups) ? db.groups : [];
  const byParent = new Map();
  groups.forEach(g => {
    const p = String(g.parent_id || '');
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(g);
  });
  const out = new Set();
  const markChildren = (id) => {
    for (const child of (byParent.get(id) || [])) {
      out.add(child.id);
      if (child.share_children !== false) markChildren(child.id);
    }
  };
  groups.forEach(g => {
    if (g.shared === true) {
      out.add(g.id);
      if (g.share_children !== false) markChildren(g.id);
    }
  });
  return out;
}
function assetPublicGroup(g, local, ownerId, sharedGroupSet, visibleIdSet=null) {
  const shared = sharedGroupSet.has(g.id) || g.shared === true;
  const permission = assetPermission(g, local, ownerId, shared);
  let parentId = g.parent_id || '';
  if (visibleIdSet && parentId && !visibleIdSet.has(parentId)) parentId = '';
  return {
    ...g,
    parent_id: parentId,
    shared,
    share_children: g.share_children !== false,
    permission,
    readonly: permission === 'shared_viewer',
    can_manage: permission === 'host' || permission === 'owner'
  };
}
function visibleAssetGroups(db, local, ownerId) {
  const sharedGroupSet = assetSharedGroupIds(db);
  const rows = db.groups.filter(g => local || g.owner_client_id === ownerId || sharedGroupSet.has(g.id) || g.shared === true);
  const visibleIdSet = new Set(rows.map(g => g.id));
  return rows.map(g => assetPublicGroup(g, local, ownerId, sharedGroupSet, visibleIdSet));
}
function visibleAssets(db, local, ownerId) {
  const sharedGroupSet = assetSharedGroupIds(db);
  return db.assets.filter(a => local || a.owner_client_id === ownerId || a.shared === true || sharedGroupSet.has(a.group_id));
}
function assetDescendantGroupIds(db, groupId) {
  const start = String(groupId || '').trim();
  if (!start) return new Set();
  const byParent = new Map();
  (db.groups || []).forEach(g => {
    const p = String(g.parent_id || '');
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(g);
  });
  const out = new Set();
  const walk = (id) => {
    if (!id || out.has(id)) return;
    out.add(id);
    (byParent.get(id) || []).forEach(child => walk(child.id));
  };
  walk(start);
  return out;
}
function assetTypeByName(name='', mime='') {
  const ext = path.extname(name).toLowerCase();
  if (String(mime).startsWith('image/') || ['.png','.jpg','.jpeg','.webp','.gif'].includes(ext)) return 'image';
  if (String(mime).startsWith('video/') || ['.mp4','.mov','.webm','.m4v'].includes(ext)) return 'video';
  return 'file';
}
function assetPublicRow(a, local=false, ownerId='', sharedGroupSet=new Set()) {
  const shared = a.shared === true || sharedGroupSet.has(a.group_id);
  const permission = assetPermission(a, local, ownerId, shared);
  return {
    ...a,
    shared,
    permission,
    readonly: permission === 'shared_viewer',
    can_manage: permission === 'host' || permission === 'owner',
    source_url: a.local_path ? `/api/assets/source?id=${encodeURIComponent(a.id)}` : '',
    url: a.local_path ? `/api/assets/source?id=${encodeURIComponent(a.id)}` : '',
    download_url: a.local_path ? `/api/assets/source?id=${encodeURIComponent(a.id)}&download=1` : '',
    thumb_url: a.thumb_path ? `/file?path=${encodeURIComponent(a.thumb_path)}` : ''
  };
}

function streamAssetSource(assetId, local, cfg, deviceOwner, req, res, download=false) {
  const ownerId = assetClientId(local, deviceOwner);
  const db = readAssetDb(cfg);
  const row = visibleAssets(db, local, ownerId).find(a => a.id === String(assetId || ''));
  if (!row || !row.local_path || !fs.existsSync(row.local_path)) return sendText(res, 'asset not found or access denied', 'text/plain', 404);
  if (row.type === 'video' || /^video\//i.test(contentType(row.local_path))) return streamVideoFile(row.local_path, req, res, download);
  const headers = {
    'Content-Type': contentType(row.local_path) || row.mime_type || 'application/octet-stream',
    'Content-Length': fs.statSync(row.local_path).size,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, max-age=60'
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(row.name || path.basename(row.local_path))}`;
  res.writeHead(200, headers);
  return fs.createReadStream(row.local_path).pipe(res);
}
function assetLibraryInit(local, cfg, deviceOwner) {
  const ownerId = assetClientId(local, deviceOwner);
  const db = readAssetDb(cfg);
  ensureDefaultAssetGroups(db, ownerId);
  writeAssetDb(db, cfg);
  return {
    ok:true,
    client_id: ownerId,
    is_host: !!local,
    settings: { dir: defaultAssetLibraryDir(cfg), can_manage: !!local },
    groups: visibleAssetGroups(db, local, ownerId),
    assets: visibleAssets(db, local, ownerId).map(a => assetPublicRow(a, local, ownerId, assetSharedGroupIds(db)))
  };
}
function assetCreateGroup(body, local, cfg, deviceOwner) {
  const ownerId = assetClientId(local, deviceOwner);
  const db = readAssetDb(cfg);
  ensureDefaultAssetGroups(db, ownerId);
  const parentId = String(body.parent_id || '').trim();
  let parent = null;
  if (parentId) {
    parent = db.groups.find(g => g.id === parentId);
    if (!parent || !canManageAssetRow(parent, local, ownerId)) throw new Error('没有权限操作该资产');
  }
  const isProject = !parentId;
  const name = String(body.name || '').trim() || (isProject ? '新建项目库' : '新建分组');
  const id = 'asset_group_' + uuid('').replace(/[^a-zA-Z0-9]/g,'');
  const g = { id, type:isProject?'project':'folder', root_project_id:isProject?id:(parent.root_project_id || parent.id), parent_id:parentId, owner_client_id:ownerId, owner_name:ownerId === 'host' ? '主机' : ownerId, name, shared:false, share_children:true, system:false, sort_order:Date.now(), created_at:nowISO(), updated_at:nowISO() };
  db.groups.push(g); writeAssetDb(db, cfg);
  return {ok:true, group:g};
}
function assetRenameGroup(body, local, cfg, deviceOwner) {
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg);
  const g = db.groups.find(x=>x.id === (body.id || body.group_id));
  if (!g) throw new Error('分组不存在');
  if (!canManageAssetRow(g, local, ownerId)) throw new Error('没有权限操作该资产');
  g.name = String(body.name || '').trim() || g.name; g.updated_at = nowISO();
  writeAssetDb(db, cfg); return {ok:true, group:g};
}
function assetDeleteGroup(body, local, cfg, deviceOwner) {
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg), base = defaultAssetLibraryDir(cfg);
  const g = db.groups.find(x=>x.id === (body.id || body.group_id));
  if (!g) throw new Error('分组不存在');
  if (!canManageAssetRow(g, local, ownerId)) throw new Error('没有权限操作该资产');
  const childIds = new Set([g.id]);
  let changed = true;
  while (changed) {
    changed = false;
    db.groups.forEach(x => { if (x.parent_id && childIds.has(x.parent_id) && !childIds.has(x.id)) { childIds.add(x.id); changed = true; } });
  }
  db.groups = db.groups.filter(x => !childIds.has(x.id));
  let deletedAssets = 0;
  db.assets = db.assets.filter(a => {
    if (!childIds.has(a.group_id)) return true;
    if (!canManageAssetRow(a, local, ownerId)) throw new Error('没有权限操作该资产');
    for (const p of [a.local_path, a.thumb_path]) {
      try { if (p) fs.rmSync(ensureInside(base, p), {force:true}); } catch {}
    }
    deletedAssets++;
    return false;
  });
  writeAssetDb(db, cfg); return {ok:true, deleted_groups:childIds.size, deleted_assets:deletedAssets};
}
function assetShare(body, local, cfg, deviceOwner, shared=true) {
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg);
  const ids = Array.isArray(body.ids) ? body.ids : [body.id].filter(Boolean);
  const groupIds = Array.isArray(body.group_ids) ? body.group_ids : [body.group_id].filter(Boolean);
  let count = 0;
  const targetGroups = new Set(groupIds);
  if (shared && body.share_children !== false) {
    let changed = true;
    while (changed) {
      changed = false;
      db.groups.forEach(g => {
        if (g.parent_id && targetGroups.has(g.parent_id) && !targetGroups.has(g.id)) {
          targetGroups.add(g.id);
          changed = true;
        }
      });
    }
  }
  db.assets.forEach(a => { if (ids.includes(a.id)) { if (!canManageAssetRow(a, local, ownerId)) throw new Error('没有权限操作该资产'); a.shared = !!shared; a.shared_at = shared ? nowISO() : null; a.shared_by = shared ? ownerId : null; a.updated_at = nowISO(); count++; } });
  db.groups.forEach(g => { if (targetGroups.has(g.id)) { if (!canManageAssetRow(g, local, ownerId)) throw new Error('没有权限操作该资产'); g.shared = !!shared; g.share_children = body.share_children !== false; g.shared_at = shared ? nowISO() : null; g.shared_by = shared ? ownerId : null; g.updated_at = nowISO(); count++; } });
  writeAssetDb(db, cfg); return {ok:true, count};
}
function assetUpload(body, local, cfg, deviceOwner) {
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg);
  ensureDefaultAssetGroups(db, ownerId);
  const groupId = String(body.group_id || `root_${ownerId}`);
  const group = db.groups.find(g => g.id === groupId);
  if (!group || !canManageAssetRow(group, local, ownerId)) throw new Error('没有权限操作该资产');
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) throw new Error('请选择要上传的素材');
  const base = defaultAssetLibraryDir(cfg);
  const saved = [];
  for (const f of files.slice(0, 50)) {
    const m = String(f.data || '').match(/^data:([^;]+);base64,(.*)$/);
    if (!m) continue;
    const mime = m[1];
    const original = safeName(f.name || 'asset.bin', 'asset.bin');
    const ext = (path.extname(original) || (mime.includes('png')?'.png':mime.includes('jpeg')?'.jpg':mime.includes('webp')?'.webp':mime.includes('gif')?'.gif':mime.includes('mp4')?'.mp4':'.bin')).toLowerCase();
    const type = assetTypeByName(original, mime);
    const id = 'asset_' + uuid('').replace(/[^a-zA-Z0-9]/g,'');
    const dir = ensureInside(base, path.join(base, 'files', ownerId, groupId));
    ensureDir(dir);
    const filename = `${Date.now().toString(36)}_${id}${ext}`;
    const localPath = ensureInside(base, path.join(dir, filename));
    fs.writeFileSync(localPath, Buffer.from(m[2], 'base64'));
    let thumbPath = '';
    if (type === 'image') {
      const td = ensureInside(base, path.join(base, 'thumbs', ownerId));
      ensureDir(td);
      thumbPath = path.join(td, `${id}.png`);
      if (!createThumb(localPath, thumbPath, 360)) thumbPath = '';
    } else if (type === 'video' && f.thumb_data) {
      const tm = String(f.thumb_data || '').match(/^data:image\/(?:webp|png|jpeg);base64,(.*)$/);
      if (tm) {
        const td = ensureInside(base, path.join(base, 'thumbs', ownerId));
        ensureDir(td);
        thumbPath = path.join(td, `${id}.webp`);
        try { fs.writeFileSync(thumbPath, Buffer.from(tm[1], 'base64')); } catch { thumbPath = ''; }
      }
    }
    const stat = fs.statSync(localPath);
    const row = { id, owner_client_id:ownerId, owner_name:ownerId === 'host' ? '主机' : ownerId, group_id:groupId, name:original, original_name:original, type, mime_type:mime, size:stat.size, local_path:localPath, thumb_path:thumbPath, created_at:nowISO(), updated_at:nowISO(), shared:false, shared_at:null, shared_by:null, tags:[], note:'' };
    db.assets.push(row); saved.push(assetPublicRow(row, local, ownerId, assetSharedGroupIds(db)));
  }
  writeAssetDb(db, cfg);
  return {ok:true, assets:saved};
}
function assetList(groupId, local, cfg, deviceOwner, search='') {
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg);
  ensureDefaultAssetGroups(db, ownerId); writeAssetDb(db, cfg);
  const q = String(search || '').trim().toLowerCase();
  const sharedGroupSet = assetSharedGroupIds(db);
  const scopeIds = assetDescendantGroupIds(db, groupId);
  const assets = visibleAssets(db, local, ownerId)
    .filter(a => (!groupId || scopeIds.has(a.group_id)) && (!q || String(a.name || '').toLowerCase().includes(q)))
    .map(a => assetPublicRow(a, local, ownerId, sharedGroupSet));
  return {ok:true, assets};
}
function assetDelete(body, local, cfg, deviceOwner) {
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg), base = defaultAssetLibraryDir(cfg);
  const ids = new Set((Array.isArray(body.ids) ? body.ids : [body.id]).filter(Boolean));
  let count = 0;
  db.assets = db.assets.filter(a => {
    if (!ids.has(a.id)) return true;
    if (!canManageAssetRow(a, local, ownerId)) throw new Error('没有权限操作该资产');
    for (const p of [a.local_path, a.thumb_path]) {
      try { if (p) fs.rmSync(ensureInside(base, p), {force:true}); } catch {}
    }
    count++;
    return false;
  });
  writeAssetDb(db, cfg); return {ok:true, count};
}
function assetRename(body, local, cfg, deviceOwner) {
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg);
  const id = String(body.id || '').trim();
  const name = String(body.name || '').trim();
  if (!id) throw new Error('素材 ID 不能为空');
  if (!name) throw new Error('素材名称不能为空');
  const row = db.assets.find(a => a.id === id);
  if (!row) throw new Error('素材不存在');
  if (!canManageAssetRow(row, local, ownerId)) throw new Error('没有权限操作该资产');
  row.name = safeName(name, row.name || 'asset');
  row.updated_at = nowISO();
  writeAssetDb(db, cfg);
  return { ok:true, asset:assetPublicRow(row, local, ownerId, assetSharedGroupIds(db)) };
}
function assetUpdate(body, local, cfg, deviceOwner) {
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg);
  const id = String(body.id || '').trim();
  if (!id) throw new Error('素材 ID 不能为空');
  const row = db.assets.find(a => a.id === id);
  if (!row) throw new Error('素材不存在');
  if (!canManageAssetRow(row, local, ownerId)) throw new Error('没有权限操作该资产');
  if (typeof body.name !== 'undefined') {
    const name = String(body.name || '').trim();
    if (name) row.name = safeName(name, row.name || 'asset');
  }
  if (Array.isArray(body.tags)) row.tags = body.tags.map(x => String(x || '').trim()).filter(Boolean).slice(0, 40);
  else if (typeof body.tags === 'string') row.tags = body.tags.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean).slice(0, 40);
  if (typeof body.note !== 'undefined') row.note = String(body.note || '').slice(0, 2000);
  if (body.group_id) {
    const target = db.groups.find(g => g.id === body.group_id);
    if (!target || !canManageAssetRow(target, local, ownerId)) throw new Error('没有权限操作该资产');
    row.group_id = target.id;
  }
  row.updated_at = nowISO();
  writeAssetDb(db, cfg);
  return { ok:true, asset:assetPublicRow(row, local, ownerId, assetSharedGroupIds(db)) };
}
function assetMove(body, local, cfg, deviceOwner) {
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg), base = defaultAssetLibraryDir(cfg);
  const target = db.groups.find(g => g.id === body.group_id);
  if (!target || !canManageAssetRow(target, local, ownerId)) throw new Error('没有权限操作该资产');
  const ids = new Set((Array.isArray(body.ids) ? body.ids : [body.id]).filter(Boolean));
  let count = 0;
  db.assets.forEach(a => {
    if (!ids.has(a.id)) return;
    if (!canManageAssetRow(a, local, ownerId)) throw new Error('没有权限操作该资产');
    const source = String(a.local_path || '');
    if(source && fs.existsSync(source)){
      const targetDir = ensureInside(base, path.join(base, 'files', a.owner_client_id || ownerId, target.id));
      ensureDir(targetDir);
      const ext = path.extname(source);
      const stem = safeName(path.basename(source, ext), 'asset');
      let destination = path.join(targetDir, `${stem}${ext}`);
      let n = 1;
      while(fs.existsSync(destination) && path.resolve(destination) !== path.resolve(source)) destination = path.join(targetDir, `${stem}_${n++}${ext}`);
      if(path.resolve(destination) !== path.resolve(source)){
        try{ fs.renameSync(source, destination); }
        catch(e){ if(e && e.code === 'EXDEV'){ fs.copyFileSync(source, destination); fs.unlinkSync(source); } else throw e; }
        a.local_path = destination;
      }
    }
    a.group_id = target.id;
    a.updated_at = nowISO();
    count++;
  });
  writeAssetDb(db, cfg); return {ok:true, count};
}
async function assetCopySource(body, local, cfg, deviceOwner) {
  if(!local) return {ok:false,error:'远程访问端无法直接操作主机剪贴板，请使用复制资产链接或下载'};
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg);
  const row = visibleAssets(db, local, ownerId).find(a => a.id === body.id);
  if(!row || !row.local_path || !fs.existsSync(row.local_path)) throw new Error('资产源文件不存在或无权访问');
  await copyFileToSystemClipboard(row.local_path, '资产');
  return {ok:true, filename:path.basename(row.local_path)};
}
function assetExportZip(body, local, cfg, deviceOwner) {
  const ownerId = assetClientId(local, deviceOwner), db = readAssetDb(cfg);
  const ids = new Set((Array.isArray(body.ids) ? body.ids : [body.id]).filter(Boolean));
  const rows = visibleAssets(db, local, ownerId).filter(a => ids.has(a.id) && a.local_path && fs.existsSync(a.local_path));
  if (!rows.length) throw new Error('没有可下载的素材');
  const zipDir = path.join(app.getPath('downloads'), 'LocalApiImageGenerator_AssetLibrary_Zips');
  const zipPath = path.join(zipDir, `asset_library_${Date.now().toString(36)}.zip`);
  zipFileEntries(rows.map(a => ({filePath:a.local_path, entryName:safeName(a.name || path.basename(a.local_path), 'asset')})), zipPath);
  return zipPath;
}
function assetSettings(body, local, cfg) {
  if (!local) return {ok:false,error:'只有主机端可以修改资产库存储目录'};
  const current = defaultAssetLibraryDir(cfg);
  let nextDir = String(body.dir || '').trim();
  if (!nextDir) nextDir = path.join(app.getPath('userData'), 'assets_library');
  nextDir = path.resolve(nextDir);
  ensureDir(nextDir);
  if (body.migrate === true && path.resolve(current) !== nextDir && fs.existsSync(current)) {
    ensureDir(path.dirname(nextDir));
    fs.cpSync(current, nextDir, {recursive:true, force:true});
  }
  const next = saveConfig({asset_library_dir: nextDir});
  return {ok:true, dir:defaultAssetLibraryDir(next)};
}


function imageTaskProgress(owner) {
  const st = getDB()._store;
  const lookups = storeLookups();
  const filterOwner = (r) => !owner || r.owner_id === owner;
  const activeSet = new Set(['等待中','提交生成中','生成中','下载中']);
  return (st.tasks || [])
    .filter(t => filterOwner(t) && activeSet.has(t.status))
    .sort((a,b)=>String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||'')))
    .slice(0, 12)
    .map(t => {
      const b = lookups.batchesById.get(t.batch_id) || {};
      const progress = Number.isFinite(Number(t.progress)) ? Number(t.progress) : (t.remote_task_id ? 5 : 0);
      let mjImages = [], mjButtons = [];
      try { mjImages = JSON.parse(t.mj_images_json || '[]') || []; } catch {}
      try { mjButtons = JSON.parse(t.mj_buttons_json || '[]') || []; } catch {}
      const gridLocal = t.mj_grid_local_path ? `/file?path=${encodeURIComponent(t.mj_grid_local_path)}` : '';
      const resultLocal = t.result_path ? `/file?path=${encodeURIComponent(t.result_path)}` : '';
      const thumbLocal = t.thumb_path ? `/file?path=${encodeURIComponent(t.thumb_path)}` : '';
      return {
        id: t.id,
        batch_id: t.batch_id,
        batch_name: b.note || b.name || '',
        task_index: t.task_index,
        status: t.status,
        progress: Math.max(0, Math.min(100, progress)),
        progress_text: t.progress_text || (t.remote_task_id ? '正在查询结果' : '等待提交'),
        remote_task_id: t.remote_task_id || '',
        prompt: t.prompt || '',
        model: b.model || '',
        full_url: gridLocal || resultLocal || t.mj_grid_remote_url || '',
        thumb_url: thumbLocal || gridLocal || resultLocal || t.mj_grid_remote_url || '',
        remote_url: t.mj_grid_remote_url || '',
        mj_source: t.mj_source || '',
        mj_action: t.mj_action || '',
        mj_is_grid: !!t.mj_grid_remote_url,
        mj_grid_remote_url: t.mj_grid_remote_url || '',
        mj_grid_local_url: gridLocal || t.mj_grid_remote_url || '',
        mj_images: mjImages.map(item => {
          const local = item.local_path ? `/file?path=${encodeURIComponent(item.local_path)}` : '';
          return { ...item, full_url: local || item.remote_url || '', remote_url: item.remote_url || '' };
        }),
        mj_buttons: mjButtons,
        updated_at: t.updated_at || '',
        created_at: t.created_at || ''
      };
    });
}
function cleanupStaleImageTasks(owner = '') {
  const st = getDB()._store;
  const activeSet = new Set(['等待中','提交生成中','生成中','下载中']);
  const cutoff = Date.now() - 30 * 60 * 1000;
  let changed = false;
  for (const task of st.tasks || []) {
    if (owner && task.owner_id !== owner) continue;
    if (!activeSet.has(String(task.status || ''))) continue;
    if (String(task.remote_task_id || '').trim()) continue;
    const ts = Date.parse(String(task.updated_at || task.created_at || '').replace(' ', 'T') + 'Z');
    if (Number.isFinite(ts) && ts > cutoff) continue;
    const oldTime = task.updated_at || task.created_at || nowISO();
    task.status = '失败';
    task.progress = 100;
    task.progress_text = '已自动标记失败';
    task.error_message = task.error_message || '程序重启后未找到本地队列或远端 task_id，已停止显示为生成中。';
    task.finished_at = task.finished_at || oldTime;
    task.updated_at = oldTime;
    const batch = (st.batches || []).find(b => b.id === task.batch_id);
    if (batch) {
      batch.running_count = Math.max(0, Number(batch.running_count || 0) - 1);
      batch.fail_count = Math.max(Number(batch.fail_count || 0), (st.tasks || []).filter(t => t.batch_id === batch.id && String(t.status || '') === '失败').length);
      const done = Number(batch.success_count || 0) + Number(batch.fail_count || 0);
      if (done >= Number(batch.task_count || 0) && Number(batch.running_count || 0) === 0) {
        batch.status = Number(batch.success_count || 0) > 0 && Number(batch.fail_count || 0) > 0 ? '部分完成' : (Number(batch.fail_count || 0) > 0 ? '失败' : '已完成');
        batch.finished_at = batch.finished_at || oldTime;
      }
      batch.updated_at = batch.updated_at || oldTime;
    }
    changed = true;
  }
  if (changed) getDB()._save();
  return changed;
}

const appStatsCache = new Map();
let hostCumulativeStatsCache = { ts: 0, data: null };
const staleImageCleanupCache = new Map();
function cleanupStaleImageTasksThrottled(owner = '') {
  const key = owner || '__all__';
  const last = staleImageCleanupCache.get(key) || 0;
  if (Date.now() - last < STALE_CLEANUP_TTL_MS) return false;
  staleImageCleanupCache.set(key, Date.now());
  return cleanupStaleImageTasks(owner);
}
function appStats(owner) {
  const cacheKey = owner || '__all__';
  const cached = appStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < STATUS_CACHE_TTL_MS) return cached.data;
  const s = getDB()._store;
  const filterOwner = (r) => !owner || r.owner_id === owner;
  const today = beijingDateKey();
  const ownerTasks = s.tasks.filter(filterOwner);
  // V8.1：右侧实时面板按中国北京时间 UTC+8 的自然日统计；每天北京时间 00:00 自动归零，历史和图片不受影响。
  const tasks = ownerTasks.filter(t => beijingDateKey(t.created_at || '') === today);
  const batches = s.batches.filter(b => filterOwner(b) && beijingDateKey(b.created_at || '') === today).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,8).map(normalizeBatch);
  const data = {
    total: tasks.length,
    done: tasks.filter(t => t.status === '已完成').length,
    fail: tasks.filter(t => t.status === '失败').length,
    running: tasks.filter(t => ['等待中','提交生成中','生成中','下载中'].includes(t.status)).length,
    batches,
    video_stats: videoTodayStats(owner),
    image_task_progress: imageTaskProgress(owner),
    api: { ok: true, status: '正常' },
    stats_scope: 'today_device'
  };
  appStatsCache.set(cacheKey, { ts: Date.now(), data });
  return data;
}
function hostCumulativeStats() {
  if (hostCumulativeStatsCache.data && Date.now() - hostCumulativeStatsCache.ts < HOST_STATS_CACHE_TTL_MS) return hostCumulativeStatsCache.data;
  const s = getDB()._store;
  const allTasks = s.tasks || [];
  const allImages = s.images || [];
  const data = {
    host_cumulative: {
      total_tasks: allTasks.length,
      completed_tasks: allTasks.filter(t => t.status === '已完成').length,
      failed_tasks: allTasks.filter(t => t.status === '失败').length,
      running_tasks: allTasks.filter(t => ['等待中','提交生成中','生成中','下载中'].includes(t.status)).length,
      generated_images: allImages.length,
      batches: (s.batches || []).length
    }
  };
  hostCumulativeStatsCache = { ts: Date.now(), data };
  return data;
}
function parseBoolValue(value, defaultValue = true) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return defaultValue;
}

function mapPayloadToQueue(body, owner) {
  const mainImages = (body.main_images || []).map(x => dataUrlToFile(x, owner)).filter(Boolean);
  const refImages = (body.reference_images || []).map(x => dataUrlToFile(x, owner)).filter(Boolean);
  const cfg = toCamelConfig(readConfig());
  const payload = {
    ownerId: owner,
    prompts: body.prompts || '',
    promptMultilineTasks: parseBoolValue(body.prompt_multiline_tasks, true),
    mainImages,
    refImages,
    imageApiPlatform: (['legacy','grsai','flow2api'].includes(String(body.image_api_platform || cfg.imageApiPlatform || '').toLowerCase()) || /(?:127\.0\.0\.1|localhost):38000|grsaiapi\.com|grsai\.dakka\.com\.cn/i.test(body.api_endpoint || cfg.apiBaseUrl || '') ? 'flow2api' : 'apimart'),
    apiBaseUrl: normalizeImageApiEndpoint(['legacy','grsai','flow2api'].includes(String(body.image_api_platform || cfg.imageApiPlatform || '').toLowerCase()) ? (body.api_endpoint || body.legacy_api_endpoint || cfg.legacyApiEndpoint || 'http://127.0.0.1:38000') : (body.api_endpoint || cfg.apiBaseUrl)),
    legacyApiEndpoint: body.legacy_api_endpoint || cfg.legacyApiEndpoint || 'http://127.0.0.1:38000',
    apiKey: body.api_key || cfg.apiKey,
    apimartProxyUrl: body.apimart_proxy_url || cfg.apimartProxyUrl || '',
    model: body.model || cfg.model,
    size: body.size || cfg.size,
    imageSize: body.clarity || cfg.imageSize || '1K',
    quality: body.quality || cfg.quality || 'auto',
    background: body.background || cfg.background || 'auto',
    moderation: body.moderation || cfg.moderation || 'auto',
    outputFormat: body.output_format || cfg.outputFormat || 'png',
    outputCompression: Number(body.output_compression || cfg.outputCompression || 90),
    imageN: Number(body.image_n || cfg.imageN || 1),
    maskUrl: body.mask_url || cfg.maskUrl || '',
    concurrency: Number(body.concurrency || cfg.concurrency || 30),
    retryTimes: Number(body.retry_times || cfg.retryTimes || 2),
    repeatCount: Number(body.repeat_count || cfg.repeatCount || 1),
    pollIntervalMs: Number(body.poll_interval_ms || cfg.pollIntervalMs || 1200),
    timeoutMs: Number(body.timeout_seconds || 1200) * 1000,
    outputDir: body.output_dir || cfg.outputDir || '',
    name: body.name || ''
  };
  return { payload, cfg: { ...cfg, ...payload, ownerId: owner } };
}
async function repeatBatch(batchId, accessOwner, createOwner, opts = {}) {
  const s = getDB()._store;
  const canAccess = (r) => !accessOwner || r.owner_id === accessOwner;
  const b = s.batches.find(x => x.id === batchId && canAccess(x));
  if (!b) throw new Error('批次不存在或无权限');
  const tasks = s.tasks.filter(t => t.batch_id === batchId && canAccess(t)).sort((a,b)=>Number(a.task_index)-Number(b.task_index));
  let cfgBatch = {}; try { cfgBatch = JSON.parse(b.config_json || '{}') || {}; } catch {}
  if (String(cfgBatch.action || '').toLowerCase() === 'describe' || tasks.some(t => String(t.mj_action || '').toLowerCase() === 'describe')) {
    let newBatchId = '';
    const apiKey = String(opts.api_key || readConfig().api_key || '').trim();
    if(!apiKey) throw new Error('重复 Describe 批次需要 API Key');
    for (const t of tasks.filter(x => String(x.mj_action || '').toLowerCase() === 'describe')) {
      let sub = {}; try { sub = JSON.parse(t.mj_submission_json || '{}') || {}; } catch {}
      const urls = Array.isArray(sub.image_urls) ? sub.image_urls : parseMjUrlText(sub.image_url || sub.image_urls_text || '');
      const imageUrl = urls[0] || '';
      if(!imageUrl) continue;
      const ret = await submitMidjourneyAction({ action:'describe', describe_mode:'single', image_url:imageUrl, image_urls_text:imageUrl, speed:sub.speed || 'relax', batch_id:newBatchId, api_key:apiKey }, createOwner || accessOwner || b.owner_id || 'local');
      if(!newBatchId) newBatchId = ret.batch_id || '';
    }
    if(!newBatchId) throw new Error('该 Describe 批次没有可重复提交的图片 URL');
    return { id:newBatchId, taskCount:s.tasks.filter(t=>t.batch_id===newBatchId).length };
  }
  const prompts = [...new Set(tasks.map(t => t.prompt).filter(Boolean))].join('\n\n');
  const mainImages = [...new Set(tasks.map(t => t.main_image_path).filter(Boolean))];
  let refImages = [];
  try { refImages = JSON.parse(tasks[0]?.ref_images_json || '[]') || []; } catch {}
  const cfg0 = cfgBatch;
  const payload = { ...cfg0, ownerId: createOwner || accessOwner || b.owner_id || 'local', prompts, mainImages, refImages, name: (b.note || b.name || 'Batch') + '_repeat' };
  const cfg = { ...toCamelConfig(readConfig()), ...payload };
  return queue.createBatch(payload, cfg);
}
function deleteImages(ids, owner) {
  const s = getDB()._store;
  const set = new Set(ids || []);
  const canAccess = (r) => !owner || r.owner_id === owner;
  const del = s.images.filter(i => set.has(i.id) && canAccess(i));
  for (const i of del) {
    try { if (i.file_path && fs.existsSync(i.file_path)) fs.unlinkSync(i.file_path); } catch {}
    try { if (i.thumb_path && fs.existsSync(i.thumb_path)) fs.unlinkSync(i.thumb_path); } catch {}
  }
  s.images = s.images.filter(i => !(set.has(i.id) && canAccess(i)));
  getDB()._save();
  return { ok: true, deleted: del.length };
}

function deleteBatch(batchId, owner) {
  const s = getDB()._store;
  const canAccess = (r) => !owner || r.owner_id === owner;
  const batch = s.batches.find(b => b.id === batchId && canAccess(b));
  if (!batch) throw new Error('批次不存在或无权限');
  try { if (queue && typeof queue.stopBatch === 'function') queue.stopBatch(batchId); } catch {}
  const imgs = s.images.filter(i => i.batch_id === batchId && canAccess(i));
  for (const i of imgs) {
    try { if (i.file_path && fs.existsSync(i.file_path)) fs.unlinkSync(i.file_path); } catch {}
    try { if (i.thumb_path && fs.existsSync(i.thumb_path)) fs.unlinkSync(i.thumb_path); } catch {}
  }
  try { if (batch.output_dir && fs.existsSync(batch.output_dir)) fs.rmSync(batch.output_dir, { recursive: true, force: true }); } catch {}
  s.images = s.images.filter(i => !(i.batch_id === batchId && canAccess(i)));
  s.tasks = s.tasks.filter(t => !(t.batch_id === batchId && canAccess(t)));
  s.logs = s.logs.filter(l => l.batch_id !== batchId);
  s.batches = s.batches.filter(b => !(b.id === batchId && canAccess(b)));
  getDB()._save();
  return { ok: true, deleted_batch: batchId, deleted_images: imgs.length };
}

async function clearAllSoftwareData(confirmText = '') {
  const must = '清空所有数据';
  if (String(confirmText || '').trim() !== must) throw new Error(`请准确输入“${must}”确认清除`);

  // V8.1 硬清理：先停止所有内存队列，再写入重置标记并重启。
  // 真正删除 DATA_ROOT/AppData/userData 会在下一次进程启动、数据库初始化之前执行，避免运行中的文件锁导致清不掉。
  try { if (queue && typeof queue.clearAllRunning === 'function') queue.clearAllRunning(); } catch {}
  try { stopTunnelProcess(); } catch {}

  try { fs.writeFileSync(RESET_MARKER, JSON.stringify({ at: new Date().toISOString(), version: '13.4' }, null, 2), 'utf8'); } catch {}

  // 尽量先清当前会话存储；即使失败，重启后也会通过 RESET_MARKER 清除整套 userData。
  try {
    const ses = mainWindow && mainWindow.webContents && mainWindow.webContents.session;
    if (ses) {
      await ses.clearCache().catch(()=>{});
      await ses.clearStorageData({
        storages: ['cookies','filesystem','indexdb','localstorage','shadercache','websql','serviceworkers','cachestorage']
      }).catch(()=>{});
    }
  } catch {}

  setTimeout(() => {
    try { app.relaunch(); } catch {}
    try { app.exit(0); } catch { process.exit(0); }
  }, 450);

  return { ok: true, cleared: true, hard_reset: true, relaunching: true, message: '正在清除本机所有数据并重启软件' };
}
function dosDateTime(date) {
  const dt = date || new Date();
  const time = ((dt.getHours() & 31) << 11) | ((dt.getMinutes() & 63) << 5) | (Math.floor(dt.getSeconds()/2) & 31);
  const d = (((dt.getFullYear()-1980)&127)<<9) | (((dt.getMonth()+1)&15)<<5) | (dt.getDate()&31);
  return { time, date: d };
}
const CRC_TABLE = (() => { const table = new Uint32Array(256); for(let i=0;i<256;i++){let c=i; for(let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); table[i]=c>>>0;} return table; })();
function crc32(buf){ let c=0xffffffff; for(let i=0;i<buf.length;i++) c=CRC_TABLE[(c^buf[i])&0xff]^(c>>>8); return (c^0xffffffff)>>>0; }
function makeZipEntry(filePath, entryName, offset) {
  const data = fs.readFileSync(filePath); const nameBuf = Buffer.from(entryName.replace(/\\/g,'/'), 'utf8'); const crc = crc32(data); const {time,date}=dosDateTime(fs.statSync(filePath).mtime);
  const local = Buffer.alloc(30+nameBuf.length); local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0x0800,6); local.writeUInt16LE(0,8); local.writeUInt16LE(time,10); local.writeUInt16LE(date,12); local.writeUInt32LE(crc,14); local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(nameBuf.length,26); local.writeUInt16LE(0,28); nameBuf.copy(local,30);
  const central = Buffer.alloc(46+nameBuf.length); central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(0x0800,8); central.writeUInt16LE(0,10); central.writeUInt16LE(time,12); central.writeUInt16LE(date,14); central.writeUInt32LE(crc,16); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(nameBuf.length,28); central.writeUInt16LE(0,30); central.writeUInt16LE(0,32); central.writeUInt16LE(0,34); central.writeUInt16LE(0,36); central.writeUInt32LE(0,38); central.writeUInt32LE(offset,42); nameBuf.copy(central,46);
  return {local,data,central,size:local.length+data.length};
}
function makeZipBufferEntry(dataInput, entryName, offset) {
  const data = Buffer.isBuffer(dataInput) ? dataInput : Buffer.from(String(dataInput || ''), 'utf8');
  const nameBuf = Buffer.from(entryName.replace(/\\/g,'/'), 'utf8'); const crc = crc32(data); const {time,date}=dosDateTime(new Date());
  const local = Buffer.alloc(30+nameBuf.length); local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0x0800,6); local.writeUInt16LE(0,8); local.writeUInt16LE(time,10); local.writeUInt16LE(date,12); local.writeUInt32LE(crc,14); local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(nameBuf.length,26); local.writeUInt16LE(0,28); nameBuf.copy(local,30);
  const central = Buffer.alloc(46+nameBuf.length); central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(0x0800,8); central.writeUInt16LE(0,10); central.writeUInt16LE(time,12); central.writeUInt16LE(date,14); central.writeUInt32LE(crc,16); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(nameBuf.length,28); central.writeUInt16LE(0,30); central.writeUInt16LE(0,32); central.writeUInt16LE(0,34); central.writeUInt16LE(0,36); central.writeUInt32LE(0,38); central.writeUInt32LE(offset,42); nameBuf.copy(central,46);
  return {local,data,central,size:local.length+data.length};
}
function writeZipBufferEntries(entries, zipPath) {
  const chunks=[], centrals=[]; let offset=0;
  for (const item of entries || []) {
    const e = makeZipBufferEntry(item.data, item.name, offset);
    chunks.push(e.local, e.data); centrals.push(e.central); offset += e.size;
  }
  const centralStart=offset, centralSize=centrals.reduce((s,b)=>s+b.length,0); const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(0,4); end.writeUInt16LE(0,6); end.writeUInt16LE(centrals.length,8); end.writeUInt16LE(centrals.length,10); end.writeUInt32LE(centralSize,12); end.writeUInt32LE(centralStart,16); end.writeUInt16LE(0,20); fs.mkdirSync(path.dirname(zipPath),{recursive:true}); fs.writeFileSync(zipPath,Buffer.concat([...chunks,...centrals,end])); return zipPath;
}
function zipFiles(files, zipPath, rootName) {
  const chunks=[], centrals=[]; let offset=0; const used=new Set();
  for(const f of files){ if(!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) continue; let base=path.basename(f); let entry=`${rootName}/${base}`; let n=1; while(used.has(entry)){const ext=path.extname(base), stem=path.basename(base,ext); entry=`${rootName}/${stem}_${n++}${ext}`;} used.add(entry); const e=makeZipEntry(f,entry,offset); chunks.push(e.local,e.data); centrals.push(e.central); offset+=e.size; }
  if(!centrals.length) throw new Error('没有可导出的文件');
  const centralStart=offset, centralSize=centrals.reduce((s,b)=>s+b.length,0); const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(0,4); end.writeUInt16LE(0,6); end.writeUInt16LE(centrals.length,8); end.writeUInt16LE(centrals.length,10); end.writeUInt32LE(centralSize,12); end.writeUInt32LE(centralStart,16); end.writeUInt16LE(0,20); fs.mkdirSync(path.dirname(zipPath),{recursive:true}); fs.writeFileSync(zipPath,Buffer.concat([...chunks,...centrals,end])); return zipPath;
}
function zipFileEntries(entries, zipPath) {
  const chunks=[], centrals=[]; let offset=0; const used=new Set();
  for(const item of entries){
    const f = item && item.filePath;
    if(!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) continue;
    let entry = String(item.entryName || path.basename(f)).replace(/\\/g,'/');
    let n=1;
    while(used.has(entry)){
      const ext=path.extname(entry), stem=entry.slice(0, entry.length - ext.length);
      entry=`${stem}_${n++}${ext}`;
    }
    used.add(entry);
    const e=makeZipEntry(f,entry,offset);
    chunks.push(e.local,e.data); centrals.push(e.central); offset+=e.size;
  }
  if(!centrals.length) throw new Error('没有可导出的文件');
  const centralStart=offset, centralSize=centrals.reduce((s,b)=>s+b.length,0); const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(0,4); end.writeUInt16LE(0,6); end.writeUInt16LE(centrals.length,8); end.writeUInt16LE(centrals.length,10); end.writeUInt32LE(centralSize,12); end.writeUInt32LE(centralStart,16); end.writeUInt16LE(0,20); fs.mkdirSync(path.dirname(zipPath),{recursive:true}); fs.writeFileSync(zipPath,Buffer.concat([...chunks,...centrals,end])); return zipPath;
}
function exportZip(batchId, owner, ids = null) {
  const s = getDB()._store;
  const canAccess = (r) => !owner || r.owner_id === owner;
  let images = [];
  let name = 'selected_images';
  const idList = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (idList.length) {
    const set = new Set(idList);
    images = s.images.filter(i => set.has(i.id) && canAccess(i));
    if (batchId) {
      const batch = s.batches.find(b => b.id === batchId && canAccess(b));
      if (batch) name = safeName(batch.note || batch.name, 'batch') + '_selected';
    } else {
      name = 'selected_images';
    }
  } else {
    const batch = s.batches.find(b => b.id === batchId && canAccess(b));
    if (!batch) throw new Error('批次不存在或无权限');
    images = s.images.filter(i => i.batch_id === batchId && canAccess(i));
    name = safeName(batch.note || batch.name, 'batch');
  }
  if (!images.length) throw new Error('没有可导出的图片');
  const zipDir = path.join(app.getPath('downloads'), OUTPUT_ZIP_DIR_NAME);
  const zipPath = path.join(zipDir, `${name}_${Date.now().toString(36)}.zip`);
  zipFiles(images.map(i => i.file_path), zipPath, name);
  return zipPath;
}
function isExportableGeneratedImage(img) {
  if(!img || !img.file_path || !fs.existsSync(img.file_path)) return false;
  if(img.is_input || img.is_reference || img.input_source || img.reference_source) return false;
  const source = String(img.mj_source || img.source || '').toLowerCase();
  if(source.includes('input') || source.includes('reference') || source.includes('upload')) return false;
  return true;
}
function exportBatchesZip(batchIds = [], owner = '') {
  const s = getDB()._store;
  const canAccess = (r) => !owner || r.owner_id === owner;
  const ids = [...new Set((Array.isArray(batchIds) ? batchIds : []).map(String).filter(Boolean))];
  if(!ids.length) throw new Error('请先选择批次');
  const batches = ids.map(id => s.batches.find(b => b.id === id && canAccess(b))).filter(Boolean);
  if(!batches.length) throw new Error('批次不存在或无权限');
  const entries = [];
  const seen = new Set();
  for(const batch of batches){
    const folder = safeName(batch.note || batch.name || batch.id, 'batch');
    const images = s.images.filter(img => img.batch_id === batch.id && canAccess(img) && isExportableGeneratedImage(img));
    let index = 1;
    for(const img of images){
      const dedupeKey = `${batch.id}|${img.remote_url || ''}|${img.file_path || ''}`;
      if(seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const base = safeName(path.basename(img.file_path || `image_${index}.png`), `image_${String(index).padStart(3,'0')}.png`);
      entries.push({ filePath: img.file_path, entryName: `${folder}/${base}` });
      index++;
    }
  }
  if(!entries.length) throw new Error('选中批次没有可导出的生成图片');
  const zipDir = path.join(app.getPath('downloads'), OUTPUT_ZIP_DIR_NAME);
  const name = batches.length === 1 ? safeName(batches[0].note || batches[0].name, 'batch') : 'Selected_Batches_Images';
  const zipPath = path.join(zipDir, `${name}_${Date.now().toString(36)}.zip`);
  zipFileEntries(entries, zipPath);
  return zipPath;
}
function xmlEscape(v='') {
  return String(v || '').replace(/[<>&'"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[ch]));
}
function describeBatchRows(batchId='', owner='') {
  const st = getDB()._store;
  const canAccess = (r) => !owner || r.owner_id === owner;
  const batch = st.batches.find(b => b.id === batchId && canAccess(b));
  if (!batch) throw new Error('批次不存在或无权限');
  const tasks = st.tasks.filter(t => t.batch_id === batchId && canAccess(t) && String(t.mj_action || '').toLowerCase() === 'describe').sort((a,b)=>Number(a.task_index||0)-Number(b.task_index||0));
  const rows = tasks.map((t) => {
    let texts = [], refs = [], submission = {}, raw = {};
    try { texts = JSON.parse(t.mj_text_outputs_json || '[]') || []; } catch {}
    try { refs = JSON.parse(t.ref_images_json || '[]') || []; } catch {}
    try { submission = JSON.parse(t.mj_submission_json || '{}') || {}; } catch {}
    try { raw = JSON.parse(t.mj_query_raw_json || '{}') || {}; } catch {}
    if (!texts.length) texts = pickMidjourneyTextOutputs(raw);
    texts = normalizeDescribePromptTexts(texts);
    const firstRef = refs[0] || {};
    const localPath = t.main_image_path || firstRef.file_path || '';
    const thumbPath = firstRef.thumb_path || t.thumb_path || '';
    const localFull = localPath && fs.existsSync(localPath) ? `/file?path=${encodeURIComponent(localPath)}` : '';
    const localThumb = thumbPath && fs.existsSync(thumbPath) ? `/file?path=${encodeURIComponent(thumbPath)}` : localFull;
    const submittedUrls = Array.isArray(submission.image_urls) ? submission.image_urls : parseMjUrlText(submission.image_url || submission.image_urls_text || '');
    return {
      task_id: t.remote_task_id || t.id,
      local_task_id: t.id,
      batch_id: t.batch_id,
      action: 'DESCRIBE',
      status: t.status || '',
      error_message: t.error_message || '',
      source_image_local_path: localPath,
      source_image_url: submittedUrls[0] || '',
      thumb_url: localThumb || submittedUrls[0] || '',
      full_url: localFull || submittedUrls[0] || '',
      result_texts: texts,
      final_prompt_text: texts.join('\n\n'),
      raw_response: raw,
      created_at: t.created_at || '',
      finished_at: t.finished_at || ''
    };
  });
  return { ok:true, batch:normalizeBatch(batch), rows };
}
function wordPara(text='', style='') {
  const styleXml = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${styleXml}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}
function wordImagePara(relId) {
  return `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2743200" cy="2743200"/><wp:docPr id="${String(relId).replace(/\D/g,'') || '1'}" name="source image"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="source"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="2743200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}
function exportDescribeWord(batchId='', owner='') {
  const data = describeBatchRows(batchId, owner);
  const batch = data.batch;
  const rows = data.rows;
  if (!rows.length) throw new Error('该批次没有 Describe 结果');
  const mediaEntries = [];
  const rels = [];
  let body = '';
  body += wordPara('Midjourney Describe 结果导出', 'Title');
  body += wordPara(`批次名称：${batch.note || batch.name || batch.id}`);
  body += wordPara(`总任务数：${rows.length}`);
  body += wordPara(`导出时间：${nowISO()}`);
  rows.forEach((row, idx) => {
    body += wordPara(`第 ${idx+1} 张图片`, 'Heading1');
    const imgPath = row.source_image_local_path && fs.existsSync(row.source_image_local_path) ? row.source_image_local_path : '';
    if (imgPath) {
      const relId = `rIdImg${idx+1}`;
      const mediaName = `media/image${idx+1}.png`;
      try {
        const image = nativeImage.createFromPath(imgPath);
        const buf = image && !image.isEmpty() ? image.resize({width:360, height:360, quality:'best'}).toPNG() : fs.readFileSync(imgPath);
        mediaEntries.push({ name:`word/${mediaName}`, data:buf });
        rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${mediaName}"/>`);
        body += wordImagePara(relId);
      } catch {
        body += wordPara(`原图路径：${imgPath}`);
      }
    } else if (row.source_image_url) {
      body += wordPara(`原图 URL：${row.source_image_url}`);
    }
    body += wordPara(`任务ID：${row.task_id || row.local_task_id}`);
    body += wordPara(`状态：${row.status || '-'}`);
    if (row.error_message) body += wordPara(`失败原因：${row.error_message}`);
    body += wordPara(`生成时间：${row.finished_at || row.created_at || '-'}`);
    (row.result_texts || []).forEach((txt, i) => body += wordPara(`提示词结果 ${i+1}：${txt}`));
    if (row.final_prompt_text) body += wordPara(`最终整合提示词：${row.final_prompt_text}`);
  });
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const entries = [
    {name:'[Content_Types].xml', data:`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`},
    {name:'_rels/.rels', data:`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`},
    {name:'word/_rels/document.xml.rels', data:`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`},
    {name:'word/styles.xml', data:`<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="34"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`},
    {name:'word/document.xml', data:documentXml},
    ...mediaEntries
  ];
  const dir = path.join(app.getPath('downloads'), OUTPUT_WORD_DIR_NAME);
  const file = path.join(dir, `${safeName(batch.note || batch.name || 'MJ_describe', 'MJ_describe')}.docx`);
  return writeZipBufferEntries(entries, file);
}
function xlsxCellRef(col, row) {
  let s = '', n = col;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return `${s}${row}`;
}
function xlsxInlineCell(col, row, value='', style=0) {
  const ref = xlsxCellRef(col, row);
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}
function describeStatusLabel(status='') {
  const s = String(status || '').toLowerCase();
  if (/success|completed|done|finish|已完成/.test(s)) return '已完成';
  if (/fail|error|cancel|失败/.test(s)) return '失败';
  if (/pending|processing|submitted|生成中|提交/.test(s)) return '进行中';
  return status || '-';
}
function exportDescribeXlsx(batchId='', owner='') {
  const data = describeBatchRows(batchId, owner);
  const batch = data.batch;
  const rows = data.rows;
  if (!rows.length) throw new Error('该批次没有 Describe 结果');
  const headers = ['序号','原图','任务ID','状态','生成时间','提示词结果 1','提示词结果 2','提示词结果 3','提示词结果 4','全部提示词','原图 URL / 本地路径','失败原因'];
  const colWidths = [8,20,28,12,22,60,60,60,60,80,45,40];
  const sheetRows = [];
  sheetRows.push(`<row r="1" ht="24" customHeight="1">${headers.map((h,i)=>xlsxInlineCell(i+1,1,h,1)).join('')}</row>`);
  const mediaEntries = [], drawingAnchors = [], drawingRels = [], sheetRels = [];
  rows.forEach((row, idx)=>{
    const r = idx + 2;
    const prompts = normalizeDescribePromptTexts(row.result_texts || []).slice(0, 12);
    const sourceText = row.source_image_url || row.source_image_local_path || '';
    const values = [
      String(idx + 1),
      '',
      row.task_id || row.local_task_id || '',
      describeStatusLabel(row.status),
      row.finished_at || row.created_at || '',
      prompts[0] || '',
      prompts[1] || '',
      prompts[2] || '',
      prompts[3] || '',
      prompts.join('\n\n'),
      sourceText,
      row.error_message || ''
    ];
    sheetRows.push(`<row r="${r}" ht="100" customHeight="1">${values.map((v,i)=>xlsxInlineCell(i+1,r,v, i===0 ? 2 : 3)).join('')}</row>`);
    const imgPath = row.source_image_local_path && fs.existsSync(row.source_image_local_path) ? row.source_image_local_path : '';
    if (imgPath) {
      try {
        const image = nativeImage.createFromPath(imgPath);
        if (image && !image.isEmpty()) {
          const size = image.getSize();
          const max = 120;
          const scale = Math.min(max / Math.max(1, size.width), max / Math.max(1, size.height), 1);
          const w = Math.max(1, Math.round(size.width * scale));
          const h = Math.max(1, Math.round(size.height * scale));
          const buf = image.resize({ width:w, height:h, quality:'best' }).toPNG();
          const mediaName = `image${idx+1}.png`;
          const relId = `rId${idx+1}`;
          mediaEntries.push({ name:`xl/media/${mediaName}`, data:buf });
          drawingRels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>`);
          drawingAnchors.push(`<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>${r-1}</xdr:row><xdr:rowOff>95250</xdr:rowOff></xdr:from><xdr:ext cx="${w*9525}" cy="${h*9525}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${idx+1}" name="${mediaName}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`);
        }
      } catch {}
    }
  });
  if (drawingAnchors.length) sheetRels.push(`<Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`);
  const cols = `<cols>${colWidths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${cols}<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheetRows.join('')}</sheetData><autoFilter ref="A1:L1"/>${drawingAnchors.length ? '<drawing r:id="rIdDrawing1"/>' : ''}</worksheet>`;
  const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${drawingAnchors.join('')}</xdr:wsDr>`;
  const entries = [
    {name:'[Content_Types].xml', data:`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`},
    {name:'_rels/.rels', data:`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
    {name:'xl/workbook.xml', data:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Describe Results" sheetId="1" r:id="rId1"/></sheets></workbook>`},
    {name:'xl/_rels/workbook.xml.rels', data:`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`},
    {name:'xl/styles.xml', data:`<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBFF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD0D7DE"/></left><right style="thin"><color rgb="FFD0D7DE"/></right><top style="thin"><color rgb="FFD0D7DE"/></top><bottom style="thin"><color rgb="FFD0D7DE"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs></styleSheet>`},
    {name:'xl/worksheets/sheet1.xml', data:sheetXml},
    {name:'xl/worksheets/_rels/sheet1.xml.rels', data:`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels.join('')}</Relationships>`},
    ...(drawingAnchors.length ? [{name:'xl/drawings/drawing1.xml', data:drawingXml},{name:'xl/drawings/_rels/drawing1.xml.rels', data:`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRels.join('')}</Relationships>`}] : []),
    ...mediaEntries
  ];
  const dir = path.join(app.getPath('downloads'), OUTPUT_EXCEL_DIR_NAME);
  const file = path.join(dir, `${safeName(batch.note || batch.name || 'MJ_describe', 'MJ_describe')}.xlsx`);
  return writeZipBufferEntries(entries, file);
}

function pushTunnelLog(line) {
  const msg = String(line || '').trim();
  if (!msg) return;
  tunnelState.logs.push(`[${nowISO()}] ${msg}`);
  if (tunnelState.logs.length > 200) tunnelState.logs = tunnelState.logs.slice(-200);
}
function extractPublicUrl(text) {
  const m = String(text || '').match(/https:\/\/[a-zA-Z0-9._-]+\.(trycloudflare\.com|ngrok-free\.app|ngrok\.io|ngrok\.app|loca\.lt|localhost\.run)[^\s]*/);
  return m ? m[0].replace(/["'<>)]*$/, '') : '';
}
function stopTunnelProcess(opts = {}) {
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch {}
    tunnelProcess = null;
  }
  tunnelState.running = false;
  tunnelState.provider = '';
  if (!opts.preserveConfig) saveConfig({ public_enabled: false, public_url: '' });
}
function startTunnelProcess(body = {}) {
  const cfg0 = readConfig();
  if (tunnelProcess) stopTunnelProcess({ preserveConfig:true });
  const provider = body.provider || cfg0.public_provider || 'cloudflare';
  const port = Number(cfg0.port || 7861);
  const access = String(body.public_password || cfg0.public_password || '').trim() || Math.random().toString(36).slice(2, 10);
  const nextCfg = saveConfig({
    public_enabled: true,
    public_provider: provider,
    public_password: access,
    public_permission: body.public_permission || cfg0.public_permission || 'generate',
    cloudflared_path: body.cloudflared_path || cfg0.cloudflared_path || 'cloudflared',
    ngrok_path: body.ngrok_path || cfg0.ngrok_path || 'ngrok',
    // Temporary tunnel URLs cannot be reused after the child process exits.
    public_url: provider === 'manual' ? (cfg0.public_url || '') : ''
  });
  tunnelState = { running: true, provider, url: nextCfg.public_url || '', logs: [], last_error: '' };
  if (provider === 'manual') {
    const manualUrl = String(body.manual_url || body.public_url || nextCfg.public_url || '').trim();
    const finalUrl = manualUrl;
    tunnelState.url = finalUrl;
    saveConfig({ public_url: finalUrl, public_enabled: true });
    pushTunnelLog('Manual public URL enabled: ' + finalUrl);
    return { ok: true, ...tunnelState, access };
  }
  let cmd, args;
  if (provider === 'ngrok') {
    cmd = nextCfg.ngrok_path || 'ngrok';
    args = ['http', String(port), '--log=stdout'];
  } else {
    cmd = nextCfg.cloudflared_path || 'cloudflared';
    args = ['tunnel', '--url', `http://127.0.0.1:${port}`];
  }
  pushTunnelLog(`Starting ${provider}: ${cmd} ${args.join(' ')}`);
  try {
    tunnelProcess = spawn(cmd, args, { windowsHide: true });
    const onData = (buf) => {
      const out = buf.toString('utf8');
      pushTunnelLog(out);
      const u = extractPublicUrl(out);
      if (u) {
        const finalUrl = u;
        tunnelState.url = finalUrl;
        saveConfig({ public_url: finalUrl, public_enabled: true });
      }
    };
    tunnelProcess.stdout.on('data', onData);
    tunnelProcess.stderr.on('data', onData);
    tunnelProcess.on('error', (err) => { tunnelState.last_error = err.message; pushTunnelLog('ERROR: ' + err.message); });
    tunnelProcess.on('exit', (code) => { pushTunnelLog(`Tunnel exited: ${code}`); tunnelState.running = false; tunnelProcess = null; });
    return { ok: true, ...tunnelState, access, hint: provider === 'cloudflare' ? '如果没有出现公网链接，请先安装 cloudflared 或填写 cloudflared.exe 路径。' : '如果没有出现公网链接，请先安装 ngrok 或填写 ngrok.exe 路径。' };
  } catch (err) {
    tunnelState.running = false;
    tunnelState.last_error = err.message;
    return { ok: false, error: err.message, ...tunnelState };
  }
}
async function waitForPublicTunnelUrl(timeoutMs = 35000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cfg = readConfig();
    const base = normalizeExternalPublicOrigin((cfg.public_url || tunnelState.url || '').trim());
    if (base) return base;
    await new Promise(r => setTimeout(r, 700));
  }
  return '';
}
async function ensurePublicAccessForVideoReference(req, cfg) {
  const provider = cfg.public_provider || 'cloudflare';
  let base = normalizeExternalPublicOrigin((cfg.public_url || tunnelState.url || '').trim());
  if (provider === 'manual') {
    if (base) return base;
    throw new Error('参考视频需要公网 HTTPS 直链。当前是手动公网模式，但没有填写有效公网地址，请先在“公网访问”里填写 https 公网地址。');
  }
  // The saved trycloudflare/ngrok URL belongs to the previous child process.
  // Reuse a temporary URL only when this process still owns a live tunnel.
  if (tunnelProcess && tunnelState.running) {
    if (base) return base;
    base = await waitForPublicTunnelUrl(12000);
    if (base) return base;
  }
  // V13.3：本地上传参考视频时，如果公网未开启，自动尝试开启公网，避免用户手动去公网访问页启动。
  // 访问密码仍然使用公网访问页里的设置；public-video 临时直链不要求网页登录密码，不影响 APIMart 读取。
  const ret = startTunnelProcess({ provider, public_password: cfg.public_password || '', public_permission: cfg.public_permission || 'generate' });
  if (ret && ret.ok === false) throw new Error('自动开启公网访问失败：' + (ret.error || ret.last_error || '未知错误'));
  addLog('视频生成需要公网参考视频链接，已自动尝试开启公网访问', { ownerId:'local' });
  base = await waitForPublicTunnelUrl(35000);
  if (!base) throw new Error('已自动尝试开启公网访问，但还没有获取到 https 公网链接。请确认 cloudflared 已安装，或到“公网访问”页面查看日志。公网网页访问需要密码，但 /public-video 临时视频直链会自动跳过密码供 APIMart 读取。');
  return base;
}
async function restartPublicTunnelForVideoReference(cfg = readConfig()) {
  const provider = cfg.public_provider || 'cloudflare';
  if (provider === 'manual') throw new Error('手动公网地址不可用，请更换为可访问的 HTTPS 地址。');
  const ret = startTunnelProcess({ provider, public_password:cfg.public_password || '', public_permission:cfg.public_permission || 'generate' });
  if (ret && ret.ok === false) throw new Error('重新建立公网视频通道失败：' + (ret.error || ret.last_error || '未知错误'));
  const base = await waitForPublicTunnelUrl(35000);
  if (!base) throw new Error('已重新启动公网通道，但没有获取到新的 HTTPS 地址。');
  return base;
}
async function buildPublicVideoUrlAuto(filePath, cfg, ownerId='', req=null) {
  const latestCfg = readConfig();
  const base = await ensurePublicAccessForVideoReference(req, { ...latestCfg, ...cfg });
  const ext = path.extname(filePath).toLowerCase();
  if (!['.mp4','.mov'].includes(ext)) throw new Error('参考视频只支持 .mp4 或 .mov，且小于等于 100MB。');
  const stat = fs.statSync(filePath);
  if (stat.size > 100 * 1024 * 1024) throw new Error('参考视频不能超过 100MB，请压缩后再上传。');
  const id = registerPublicVideo(filePath, ownerId);
  return `${base}/public-video/${id}${ext}`;
}

async function buildPublicTempFileUrlAuto(filePath, cfg, ownerId='', req=null) {
  const latestCfg = readConfig();
  const base = await ensurePublicAccessForVideoReference(req, { ...latestCfg, ...cfg });
  const ext = path.extname(filePath).toLowerCase() || '.bin';
  const stat = fs.statSync(filePath);
  if (stat.size > 100 * 1024 * 1024) throw new Error('聊天附件临时公网链接最大支持 100MB，请压缩后再上传。');
  const id = registerPublicVideo(filePath, ownerId, { kind:'chat_attachment', expireHours:2 });
  return `${base}/public-file/${id}${ext}`;
}

async function appendChatAttachmentLinks(messages = [], attachments = [], cfg = readConfig(), ownerId = '', req = null) {
  const files = Array.isArray(attachments) ? attachments : [];
  if (!files.length) return messages;
  const lines = [];
  for (const item of files) {
    try {
      if (!item || !item.data) continue;
      const fp = dataUrlToFile(item, ownerId);
      if (!fp || !fs.existsSync(fp)) continue;
      const url = await buildPublicTempFileUrlAuto(fp, cfg, ownerId, req);
      const isVideo = /^video\//i.test(item.type || '') || /\.(mp4|mov|webm|mkv)$/i.test(item.name || '');
      const isImage = /^image\//i.test(item.type || '');
      lines.push(`${isVideo ? '视频' : (isImage ? '图片' : '附件')}：${item.name || path.basename(fp)}\n类型：${item.type || contentType(fp) || 'unknown'}\n大小：${Math.round(Number(item.size || fs.statSync(fp).size || 0)/1024)} KB\n公网临时链接（2小时有效）：${url}`);
    } catch (e) {
      lines.push(`附件：${item?.name || '未知文件'}\n生成公网临时链接失败：${e.message || e}`);
    }
  }
  if (!lines.length) return messages;
  const textBlock = `\n\n[聊天附件公网临时链接]\n${lines.join('\n\n')}\n请优先根据这些公网链接读取/分析附件；链接会在约 2 小时后自动失效。`;
  const out = Array.isArray(messages) ? [...messages] : [];
  let last = out.length ? out[out.length - 1] : null;
  if (!last || String(last.role || '').toLowerCase() !== 'user') {
    out.push({ role:'user', content:textBlock });
  } else if (Array.isArray(last.content)) {
    last = { ...last, content:[...last.content, { type:'text', text:textBlock }] };
    out[out.length - 1] = last;
  } else {
    last = { ...last, content:String(last.content || '') + textBlock };
    out[out.length - 1] = last;
  }
  return out;
}


function normalizeChatStreamBase(raw) {
  let s = String(raw || 'https://api.apimart.ai').trim() || 'https://api.apimart.ai';
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/v1\/chat\/completions.*$/i, '');
  s = s.replace(/\/v1\/responses.*$/i, '');
  s = s.replace(/\/api\/v1\/chat\/completions.*$/i, '');
  return s || 'https://api.apimart.ai';
}
function normalizeChatStreamContent(content) {
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
function chatStreamMessages(messages = []) {
  const out = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg) continue;
    const rawRole = String(msg.role || '').toLowerCase();
    const role = ['system','developer','assistant','user'].includes(rawRole) ? (rawRole === 'developer' ? 'system' : rawRole) : 'user';
    const content = normalizeChatStreamContent(msg.content);
    if (Array.isArray(content) && !content.length) continue;
    if (typeof content === 'string' && !content.trim()) continue;
    out.push({role, content});
  }
  return out.length ? out : [{role:'user', content:''}];
}
function applyChatStreamOptions(payload, options = {}, model = '') {
  const out = {...payload};
  const addNum = (key) => {
    if (typeof options[key] === 'undefined' || options[key] === '' || options[key] === null) return;
    const n = Number(options[key]);
    if (Number.isFinite(n)) out[key] = n;
  };
  addNum('max_tokens');
  addNum('temperature');
  addNum('top_p');
  addNum('presence_penalty');
  addNum('frequency_penalty');
  if (!/^(gpt-|o\d|chatgpt-)/i.test(String(model || ''))) addNum('top_k');
  return out;
}
function pickChatDeltaFromStreamJson(j) {
  const root = j?.data || j || {};
  return root?.choices?.[0]?.delta?.content
    || root?.choices?.[0]?.message?.content
    || root?.delta?.content
    || root?.content
    || '';
}
async function streamChatCompletionsToClient(res, {baseUrl, apiKey, model, messages, options, proxyUrl}) {
  res.writeHead(200, {
    'Content-Type':'text/event-stream; charset=utf-8',
    'Cache-Control':'no-cache, no-transform',
    'Connection':'keep-alive',
    'X-Accel-Buffering':'no'
  });
  const sendEvent = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
  };
  const start = Date.now();
  const base = normalizeChatStreamBase(baseUrl);
  const target = `${base}/v1/chat/completions`;
  const payload = applyChatStreamOptions({
    model: model || 'gpt-5.5',
    messages: chatStreamMessages(messages),
    stream: true
  }, options || {}, model || 'gpt-5.5');
  const candidates = getApimartProxyCandidates(proxyUrl || '');
  const errors = [];
  const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';

  async function tryProxy(proxy) {
    return new Promise((resolve, reject) => {
      const args = ['-sS','-N','-L','--connect-timeout','4','--max-time','240'];
      if (proxy) args.push('--proxy', String(proxy));
      args.push('-X','POST', target, '-H','Accept: text/event-stream', '-H',`Authorization: Bearer ${apiKey || ''}`, '-H','Content-Type: application/json', '--data-binary','@-');
      const child = spawn(exe, args, { windowsHide:true });
      let stderr = '';
      let raw = '';
      let lineBuf = '';
      let content = '';
      let gotAny = false;
      const timer = setTimeout(()=>{ try{ child.kill(); }catch{}; reject(new Error('Stream 请求超时')); }, 245000);
      const processLine = (line) => {
        const m = String(line || '').match(/^\s*data:\s*(.*)\s*$/);
        if (!m) return;
        const data = m[1].trim();
        if (!data || data === '[DONE]') return;
        try {
          const j = JSON.parse(data);
          const delta = pickChatDeltaFromStreamJson(j);
          if (delta) {
            gotAny = true;
            content += String(delta);
            sendEvent({delta:String(delta), elapsed:(Date.now()-start)/1000});
          }
        } catch {}
      };
      child.stdout.on('data', d => {
        const s = d.toString('utf8');
        raw += s;
        lineBuf += s;
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop() || '';
        for (const line of lines) processLine(line);
      });
      child.stderr.on('data', d => stderr += d.toString('utf8'));
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (lineBuf) processLine(lineBuf);
        if (code !== 0) return reject(new Error((stderr || raw || `curl code=${code}`).slice(0, 1200)));
        if (!gotAny) {
          try {
            const j = JSON.parse(String(raw || '').trim());
            const msg = j?.error?.message || j?.message || j?.data?.message || '';
            if (msg || (j.code && Number(j.code) !== 200)) return reject(new Error(msg || JSON.stringify(j).slice(0, 800)));
          } catch {}
        }
        if (proxy) markGoodApimartProxy(proxy);
        resolve({content});
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }

  for (const proxy of candidates) {
    try {
      const ret = await tryProxy(proxy);
      sendEvent({done:true, content:ret.content || '', elapsed:(Date.now()-start)/1000});
      try { res.end(); } catch {}
      return;
    } catch (e) {
      errors.push(`[${proxy || 'direct'}] ${e.message || e}`);
    }
  }
  sendEvent({error:'APIMart Stream 请求失败：' + errors.join(' | '), elapsed:(Date.now()-start)/1000});
  try { res.end(); } catch {}
}



function pickApimartImageUrls(status={}) {
  const out = [];
  const seen = new Set();
  const seenObj = new Set();
  const isHttp = (s) => /^https?:\/\//i.test(String(s || ''));
  const nonResult = (s) => /\/v1\/tasks|api\.apimart\.ai\/v1|docs\.apimart\.ai/i.test(String(s || ''));
  const isImage = (s, ctx='') => {
    const x = String(s || '');
    const c = String(ctx || '').toLowerCase();
    if (!isHttp(x) || nonResult(x)) return false;
    if (/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(x)) return true;
    if (/image|thumbnail|thumb|cover|preview|result|output|artifact|file|url|asset|media/i.test(c) && !/video|mask|task|api|docs/i.test(c)) return true;
    if (/cdn|storage|oss|cos|r2|cloudflare|apimart|openai|blob|files/i.test(x) && !/\.mp4(\?|#|$)|\.mov(\?|#|$)|\.webm(\?|#|$)/i.test(x)) return true;
    return false;
  };
  const push = (s, ctx='') => {
    const u = String(s || '').trim().replace(/[\s"'<>\,，]+$/g, '');
    if (!isImage(u, ctx)) return;
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  };
  const extractUrlsFromString = (s, ctx='') => {
    const str = String(s || '');
    // APIMart 的 MJ Result 经常把多个图片 URL 用英文逗号连续拼在一行：url_grid.png,url_0.png,url_1.png
    // 这里必须把逗号当分隔符，否则多个 URL 会被粘成一个，导致少图/不显示。
    const re = /https?:\/\/[^\s"'<>\\,，]+/ig;
    let m;
    while ((m = re.exec(str))) push(m[0], ctx);
    const t = str.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try { add(JSON.parse(t), ctx + '.jsonString'); } catch {}
    }
  };
  const add = (v, ctx='root') => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach((x,i)=>add(x, `${ctx}[${i}]`));
    if (typeof v === 'string') { push(v, ctx); extractUrlsFromString(v, ctx); return; }
    if (typeof v !== 'object' || seenObj.has(v)) return;
    seenObj.add(v);
    add(v.image_url, ctx + '.image_url');
    add(v.image_urls, ctx + '.image_urls');
    add(v.images, ctx + '.images');
    add(v.image, ctx + '.image');
    add(v.thumbnail, ctx + '.thumbnail');
    add(v.thumbnail_url, ctx + '.thumbnail_url');
    add(v.preview_url, ctx + '.preview_url');
    add(v.output_url, ctx + '.output_url');
    add(v.output_urls, ctx + '.output_urls');
    add(v.result_url, ctx + '.result_url');
    add(v.remote_url, ctx + '.remote_url');
    add(v.url, ctx + '.url');
    add(v.urls, ctx + '.urls');
    add(v.file_url, ctx + '.file_url');
    add(v.file_urls, ctx + '.file_urls');
    add(v.results, ctx + '.results');
    add(v.result, ctx + '.result');
    add(v.output, ctx + '.output');
    add(v.outputs, ctx + '.outputs');
    add(v.response, ctx + '.response');
    add(v.files, ctx + '.files');
    add(v.file, ctx + '.file');
    add(v.artifacts, ctx + '.artifacts');
    add(v.artifact, ctx + '.artifact');
    if (v.data && v.data !== v) add(v.data, ctx + '.data');
    for (const [k, val] of Object.entries(v)) {
      if (['image_url','image_urls','images','image','thumbnail','thumbnail_url','preview_url','output_url','output_urls','result_url','remote_url','url','urls','file_url','file_urls','results','result','output','outputs','response','files','file','artifacts','artifact','data'].includes(k)) continue;
      if (typeof val === 'string') extractUrlsFromString(val, ctx + '.' + k);
      else if (val && typeof val === 'object' && /image|thumb|preview|result|output|asset|file|data|content|artifact/i.test(k)) add(val, ctx + '.' + k);
    }
  };
  add(status, 'root');
  return out;
}
function pickMidjourneyTextOutputs(raw={}) {
  const out = [];
  const seen = new Set();
  const isValid = (text) => {
    const s = String(text || '').trim();
    if (!s) return false;
    const bad = ['SUCCESS','DESCRIBE','FAILURE','PENDING','PROCESSING','SUBMITTED','COMPLETED','ACTION','STATUS'];
    if (bad.includes(s.toUpperCase())) return false;
    if (s.length < 8) return false;
    return true;
  };
  const add = (v) => {
    const s = String(v || '').trim();
    if (!isValid(s)) return;
    if (/^https?:\/\//i.test(s)) return;
    if (/^task[-_]/i.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  const walk = (x) => {
    if (!x) return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x === 'string') {
      if (x.length > 6 && x.length < 2000 && /[\u4e00-\u9fa5A-Za-z]/.test(x)) add(x);
      return;
    }
    if (typeof x !== 'object') return;
    ['prompts','prompt','description','caption','text','content','result_text','message'].forEach(k => { if (x[k]) add(x[k]); });
    for (const v of Object.values(x)) walk(v);
  };
  walk(raw);
  return out.slice(0, 12);
}
function isValidDescribePrompt(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  const bad = ['SUCCESS','DESCRIBE','FAILURE','PENDING','PROCESSING','SUBMITTED','COMPLETED','ACTION','STATUS'];
  if (bad.includes(s.toUpperCase())) return false;
  if (s.length < 8) return false;
  return true;
}
function normalizeDescribePromptTexts(items=[]) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [items])
    .map(x => String(x || '').trim())
    .filter(isValidDescribePrompt)
    .filter(x => { if (seen.has(x)) return false; seen.add(x); return true; });
}
function sanitizeMjPayload(obj={}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
}
function parseMjUrlText(v='') {
  return String(v || '').split(/[\n,\s]+/).map(s=>s.trim()).filter(s=>/^https?:\/\//i.test(s));
}
function buildMidjourneyPrompt(body={}) {
  let prompt = String(body.prompt || body.modal_prompt || '').trim();
  const append = (txt) => { if (!txt) return; prompt += (prompt ? ' ' : '') + txt; };
  const neg = String(body.negative_prompt || '').trim();
  if (neg) append(`--no ${neg}`);
  if (body.niji) append('--niji');
  if (body.tile) append('--tile');
  if (body.raw) append('--raw');
  if (body.hd) append('--hd');
  if (body.draft) append('--draft');
  if (body.aspect_ratio) append(`--ar ${String(body.aspect_ratio).trim()}`);
  if (body.image_quality !== undefined && String(body.image_quality).trim()) append(`--q ${String(body.image_quality).trim()}`);
  if (body.stylize !== undefined && String(body.stylize).trim()) append(`--s ${String(body.stylize).trim()}`);
  if (body.chaos !== undefined && String(body.chaos).trim()) append(`--chaos ${String(body.chaos).trim()}`);
  if (body.weirdness !== undefined && String(body.weirdness).trim()) append(`--weird ${String(body.weirdness).trim()}`);
  if (body.seed !== undefined && String(body.seed).trim()) append(`--seed ${String(body.seed).trim()}`);
  if (body.stop !== undefined && String(body.stop).trim()) append(`--stop ${String(body.stop).trim()}`);
  if (body.cref) append(`--cref ${String(body.cref).trim()}`);
  if (body.sref) append(`--sref ${String(body.sref).trim()}`);
  if (body.dref) append(`--dref ${String(body.dref).trim()}`);
  if (body.repeat !== undefined && String(body.repeat).trim()) append(`--repeat ${String(body.repeat).trim()}`);
  if (body.extra_flag) append(String(body.extra_flag).trim());
  return prompt.trim();
}

function compressImageFileToMaxMiB(filePath, maxMiB = 12) {
  const maxBytes = Math.max(1, Number(maxMiB || 12)) * 1024 * 1024;
  try {
    if (!filePath || !fs.existsSync(filePath)) return filePath;
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) return filePath;
    const img = nativeImage.createFromPath(filePath);
    if (!img || img.isEmpty()) return filePath;
    let size = img.getSize();
    let working = img;
    let out = null;
    for (let round = 0; round < 12; round++) {
      for (const q of [86, 78, 70, 62, 54, 46, 38]) {
        out = working.toJPEG(q);
        if (out && out.length <= maxBytes) break;
      }
      if (out && out.length <= maxBytes) break;
      const nextW = Math.max(320, Math.floor(size.width * 0.86));
      const nextH = Math.max(320, Math.floor(size.height * 0.86));
      if (nextW === size.width && nextH === size.height) break;
      size = { width: nextW, height: nextH };
      working = img.resize({ width: size.width, height: size.height, quality: 'best' });
    }
    if (out && out.length) {
      const dst = filePath.replace(/\.[^.]+$/, '') + '_under12mb.jpg';
      fs.writeFileSync(dst, out);
      addLog(`Midjourney 上传图超过 ${maxMiB}MiB，已本地压缩：${path.basename(filePath)} -> ${path.basename(dst)} (${(out.length/1024/1024).toFixed(2)}MiB)`);
      return dst;
    }
  } catch (e) {
    addLog('Midjourney 本地压缩图片失败：' + (e.message || e));
  }
  return filePath;
}
function saveMidjourneyInputPreview(task, item, label='input') {
  try {
    if (!task || !item || !item.data) return '';
    const st = getDB()._store;
    const batch = st.batches.find(b => b.id === task.batch_id);
    if (!batch) return '';
    ensureDir(batch.output_dir || mjOutputRoot());
    ensureDir(path.join(batch.output_dir, '_thumbs'));
    const temp = dataUrlToFile(item, task.owner_id || 'local');
    if (!temp || !fs.existsSync(temp)) return '';
    const ext = path.extname(temp) || '.png';
    const dst = path.join(batch.output_dir, `${String(task.task_index).padStart(5,'0')}_${label}${ext}`);
    fs.copyFileSync(temp, dst);
    const thumb = path.join(batch.output_dir, '_thumbs', `${String(task.task_index).padStart(5,'0')}_${label}.png`);
    createThumb(dst, thumb, 300);
    task.main_image_path = dst;
    task.ref_images_json = JSON.stringify([{ label, file_path: dst, thumb_path: thumb, name: item.name || '' }]);
    getDB()._save();
    try { fs.unlinkSync(temp); } catch {}
    return dst;
  } catch (e) {
    addLog('保存 Midjourney 输入缩略图失败：' + (e.message || e));
    return '';
  }
}

async function uploadMidjourneyItemsToUrls(items = [], owner='local', apiKey='') {
  const urls = [];
  for (const item of Array.isArray(items) ? items : []) {
    let filePath = dataUrlToFile(item, owner);
    if (!filePath) continue;
    let uploadPath = filePath;
    try {
      uploadPath = compressImageFileToMaxMiB(filePath, 12);
      urls.push(await uploadImageToApimart(apiKey, uploadPath));
    }
    finally {
      try { if (uploadPath && uploadPath !== filePath && fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath); } catch {}
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }
  }
  return urls;
}

function safeJsonParse(text, fallback={}) { try { return JSON.parse(text); } catch { return fallback; } }
function isHttpImageUrlForMj(v='') {
  const u = String(v || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (/\/v1\/tasks|api\.apimart\.ai\/v1|docs\.apimart\.ai/i.test(u)) return false;
  return /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(u) || /cdn|storage|oss|cos|r2|cloudflare|apimart|openai|blob|files/i.test(u);
}
function normalizeMjRemoteUrl(v='') {
  let s = String(v || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    ['Expires','Signature','X-Amz-Signature','X-Amz-Credential','X-Amz-Date','X-Amz-Expires','OSSAccessKeyId','token'].forEach(k=>u.searchParams.delete(k));
    s = u.toString();
  } catch {}
  return s.replace(/\/+$/, '').toLowerCase();
}
function collectMjFieldValues(raw={}, matcher=()=>false) {
  const out = [];
  const seenObj = new Set();
  const walk = (x) => {
    if (!x) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x !== 'object' || seenObj.has(x)) return;
    seenObj.add(x);
    for (const [k, v] of Object.entries(x)) {
      if (matcher(k, v)) out.push(v);
      if (v && typeof v === 'object') walk(v);
    }
  };
  walk(raw);
  return out;
}
function flattenMjUrlValues(v, out=[]) {
  if (!v) return out;
  if (Array.isArray(v)) { v.forEach(x=>flattenMjUrlValues(x, out)); return out; }
  if (typeof v === 'string') { if (isHttpImageUrlForMj(v)) out.push(v.trim()); return out; }
  if (typeof v === 'object') {
    ['url','image_url','remote_url','file_url','result_url','output_url'].forEach(k=>{ if(v[k]) flattenMjUrlValues(v[k], out); });
  }
  return out;
}
function pickMidjourneyResultUrls(raw={}) {
  const out = [];
  const seen = new Set();
  const values = collectMjFieldValues(raw, (k, v)=>/^result$/i.test(k) && typeof v === 'string');
  for (const val of values) {
    const str = String(val || '').trim();
    if (!str || !/^https?:\/\//i.test(str)) continue;
    // APIMart Midjourney Result returns one image URL per item, separated by English comma:
    // first URL = grid/composite image, following URLs = cropped single images.
    const parts = str.split(',').map(x => String(x || '').trim()).filter(Boolean);
    for (const part of parts) {
      const m = part.match(/https?:\/\/[^\s"'<>\\,，]+/i);
      const u = m ? m[0].trim().replace(/[\s"'<>\,，]+$/g, '') : '';
      if (!u || !isHttpImageUrlForMj(u) || seen.has(u)) continue;
      seen.add(u); out.push(u);
    }
  }
  return out;
}

function midjourneyTaskRoots(raw={}) {
  const roots = [];
  const add = (x) => { if (x && typeof x === 'object' && !Array.isArray(x) && !roots.includes(x)) roots.push(x); };
  add(raw);
  if (raw && typeof raw === 'object') {
    add(raw.data); add(raw.task); add(raw.result); add(raw.response);
    if (raw.data && typeof raw.data === 'object') { add(raw.data.task); add(raw.data.result); add(raw.data.response); }
  }
  return roots;
}
function pickDirectMidjourneyGridUrl(raw={}) {
  for (const root of midjourneyTaskRoots(raw)) {
    const u = String(root.grid_image_url || root.gridImageUrl || '').trim();
    if (isHttpImageUrlForMj(u)) return u;
  }
  return '';
}
function pickDirectMidjourneyImageUrls(raw={}) {
  const out = [], seen = new Set();
  for (const root of midjourneyTaskRoots(raw)) {
    const arr = root && (root.image_urls || root.imageUrls);
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const urls = flattenMjUrlValues(item, []);
      for (const url of urls) {
        const u = String(url || '').trim();
        if (!u || seen.has(u) || !isHttpImageUrlForMj(u)) continue;
        seen.add(u); out.push(u);
      }
    }
    if (out.length) return out;
  }
  return out;
}

function looksMidjourneyGridUrl(url='') {
  const u = String(url || '').toLowerCase();
  return /(^|[\/_-])grid([\/_\-.]|$)|grid_image|image_grid|_grid\.(png|jpe?g|webp|gif)/i.test(u);
}
function hasExplicitMidjourneyImageUrls(raw={}) {
  return collectMjFieldValues(raw, (k)=>/^(image_urls|imageUrls)$/i.test(k)).length > 0;
}
function pickMidjourneyGridUrl(raw={}) {
  const directGrid = pickDirectMidjourneyGridUrl(raw);
  if (directGrid) return directGrid;
  const candidates = collectMjFieldValues(raw, (k)=>/^(grid_image_url|gridImageUrl)$/i.test(k) || /grid.*image.*url/i.test(k));
  for (const val of candidates) {
    const urls = flattenMjUrlValues(val, []);
    if (urls[0]) return urls[0];
  }
  const resultUrls = pickMidjourneyResultUrls(raw);
  if (resultUrls.length) return resultUrls[0];
  // Some APIMart MJ task detail pages return all result URLs in one Result string:
  // grid_url, image_0, image_1, image_2, image_3. Save the first/grid URL as a real image too.
  const all = pickApimartImageUrls(raw).filter(isHttpImageUrlForMj);
  const gridLike = all.find(looksMidjourneyGridUrl);
  if (gridLike) return gridLike;
  const explicitSingles = pickExplicitMidjourneyImageUrlsFromFieldsOnly(raw);
  if (explicitSingles.length && all.length > explicitSingles.length) {
    const singles = new Set(explicitSingles.map(u => String(u || '').trim()).filter(Boolean));
    const extra = all.find(u => !singles.has(String(u || '').trim()));
    if (extra) return extra;
  }
  return hasExplicitMidjourneyImageUrls(raw) ? '' : (all[0] || '');
}
function pickExplicitMidjourneyImageUrlsFromFieldsOnly(raw={}) {
  const values = collectMjFieldValues(raw, (k)=>/^(image_urls|imageUrls)$/i.test(k));
  const out = [], seen = new Set();
  for (const val of values) {
    const urls = flattenMjUrlValues(val, []);
    for (const url of urls) {
      const u = String(url || '').trim();
      if (!u || seen.has(u)) continue;
      seen.add(u); out.push(u);
    }
  }
  return out;
}
function pickExplicitMidjourneyImageUrls(raw={}) {
  const grid = pickMidjourneyGridUrl(raw);
  const out = [], seen = new Set();
  for (const url of pickExplicitMidjourneyImageUrlsFromFieldsOnly(raw)) {
    const u = String(url || '').trim();
    if (!u || seen.has(u) || (grid && u === grid)) continue;
    seen.add(u); out.push(u);
  }
  return out;
}
function mergeMidjourneyResultImageUrls(raw={}) {
  const directGrid = pickDirectMidjourneyGridUrl(raw);
  const resultUrls = pickMidjourneyResultUrls(raw);
  const grid = directGrid || (resultUrls[0] || '');
  const out = [];
  const seen = new Set();
  const addSingle = (url) => {
    const u = String(url || '').trim();
    if (!u || !isHttpImageUrlForMj(u) || u === grid || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  pickDirectMidjourneyImageUrls(raw).forEach(addSingle);
  resultUrls.slice(1).forEach(addSingle);
  return { grid, image_urls: out, result_urls: resultUrls };
}
function pickMidjourneyButtons(raw={}) {
  const out = [];
  const seen = new Set();
  const sources = collectMjFieldValues(raw, (k,v)=>/^buttons$/i.test(k) && Array.isArray(v));
  for (const arr of sources) for (const item of Array.isArray(arr) ? arr : []) {
    if (!item) continue;
    const label = String(item.label || item.text || item.name || '').trim();
    const custom_id = String(item.customId || item.custom_id || item.id || '').trim();
    const key = `${label}|${custom_id}`;
    if (!label || seen.has(key)) continue;
    seen.add(key); out.push({ label, custom_id });
  }
  return out;
}

function buildMidjourneyFallbackButtons(raw={}, localTask=null, imageUrls=[]) {
  const remoteTaskId = String(pickTaskIdFromApimart(raw) || (localTask && localTask.remote_task_id) || '').trim();
  if (!remoteTaskId) return [];
  const status = String(pickApimartStatus(raw) || (localTask && localTask.status) || '').toLowerCase();
  if (status && !/success|succeed|completed|done|finish|已完成/.test(status)) return [];
  const action = String((localTask && localTask.mj_action) || '').trim().toLowerCase();
  let count = 0;
  const actual = collectMjFieldValues(raw, (k)=>/actual.*image.*count|image.*count|actual_image_count/i.test(k));
  for (const v of actual) { const n = Number(v); if (Number.isFinite(n) && n > count) count = n; }
  if (Array.isArray(imageUrls) && imageUrls.length) count = Math.max(count, imageUrls.length);
  try { const arr = JSON.parse((localTask && localTask.mj_images_json) || '[]') || []; if (arr.length) count = Math.max(count, arr.length); } catch {}
  count = Math.max(1, Math.min(4, Number(count || 4)));
  const buttons = [];
  const add = (label) => buttons.push({ label, custom_id:'' });
  if (!action || ['imagine','blend','edits','reroll','variation','high_variation','low_variation'].includes(action)) {
    for (let i=1;i<=count;i++) add(`U${i}`);
    for (let i=1;i<=count;i++) add(`V${i}`);
    add('Reroll');
    return buttons;
  }
  if (action === 'upscale') {
    add('Vary Strong'); add('Vary Subtle'); add('Vary Region'); add('Zoom 1.5x'); add('Zoom 2x');
    add('Pan Left'); add('Pan Right'); add('Pan Up'); add('Pan Down');
    add('Video Low Motion'); add('Video High Motion');
    add('Remix Strong'); add('Remix Subtle');
    return buttons;
  }
  return buttons;
}

function uniqueMidjourneyImageUrls(raw={}) {
  const merged = mergeMidjourneyResultImageUrls(raw);
  if (merged.image_urls.length) return merged.image_urls;
  const direct = pickDirectMidjourneyImageUrls(raw);
  if (direct.length) return direct;
  const resultUrls = pickMidjourneyResultUrls(raw);
  if (resultUrls.length) return resultUrls.slice(1).filter(u => u !== merged.grid);
  const grid = pickMidjourneyGridUrl(raw);
  const urls = pickApimartImageUrls(raw);
  const out = [], seen = new Set();
  for (const url of urls) {
    const u = String(url || '').trim();
    if (!u || seen.has(u) || (grid && u === grid)) continue;
    seen.add(u); out.push(u);
  }
  return out;
}
function buttonActionFromMeta(label='', customId='') {
  const text = String(label || '').trim();
  const custom = String(customId || '').trim();
  const combo = `${text} ${custom}`.toLowerCase();
  const explicitIndex = text.match(/^(?:u|v)\s*([1-4])$/i) || text.match(/\b([1-4])\b/);
  const customIndex = custom.match(/::(?:upscale|variation|high-variation|low-variation|high_variation|low_variation|inpaint|pan_[a-z]+|video)::([0-4])::/i);
  let index = explicitIndex ? Number(explicitIndex[1]) : 0;
  if (!index && customIndex) {
    const n = Number(customIndex[1]);
    index = n >= 0 && n <= 3 ? n + 1 : n;
  }
  if (/^u[1-4]$/i.test(text) || /::upscale::/i.test(custom)) return { action:'upscale', index };
  if (/::high[-_]variation::/i.test(custom) || (/strong/i.test(combo) && /variation|vary/i.test(combo))) return { action:'high_variation', index };
  if (/::low[-_]variation::/i.test(custom) || (/subtle|weak|low/i.test(combo) && /variation|vary/i.test(combo))) return { action:'low_variation', index };
  if (/^v[1-4]$/i.test(text) || /::variation::/i.test(custom)) return { action:'variation', index };
  if (/reroll|redo|re-roll|再生成/i.test(combo) || /::reroll::/i.test(custom)) return { action:'reroll', index };
  if (/vary region|region|inpaint/i.test(combo) || /::inpaint::/i.test(custom)) return { action:'inpaint', index };
  if (/remix/i.test(combo)) return { action:'remix', remix_strength:/subtle|weak|low/i.test(combo)?'subtle':'strong', index };
  if (/video|animate|motion|动态|视频/i.test(combo) || /::video::/i.test(custom)) return { action:'video', motion:/high|高/i.test(combo) ? 'high' : 'low', index };
  if (/\bleft\b|←|⬅|pan_left/i.test(combo)) return { action:'pan', direction:'left', index };
  if (/\bright\b|→|➡|pan_right/i.test(combo)) return { action:'pan', direction:'right', index };
  if (/\bup\b|↑|⬆|pan_up/i.test(combo)) return { action:'pan', direction:'up', index };
  if (/\bdown\b|↓|⬇|pan_down/i.test(combo)) return { action:'pan', direction:'down', index };
  if (/zoom/i.test(combo) || /customzoom/i.test(custom)) {
    const zm = combo.match(/(1(?:\.5|\.75)?|2(?:x)?)/i);
    return { action:'zoom', zoom_ratio: zm ? Number(String(zm[1]).replace(/x/i,'')) || 2 : 2, index };
  }
  return { action:'variation', index };
}
function mjOutputRoot() { return path.join(app.getPath('pictures'), OUTPUT_MJ_DIR_NAME); }
function ensureMjBatchAndTask(body={}, owner='local') {
  const db = getDB(); const st = db._store;
  const action = String(body.action || 'imagine').trim().toLowerCase();
  let followBatchId = String(body.batch_id || '').trim();
  if (!followBatchId && String(body.source_task_local_id || '').trim()) {
    const parentTask = st.tasks.find(t => t.id === String(body.source_task_local_id || '').trim() && (!owner || t.owner_id === owner));
    if (parentTask && parentTask.batch_id) followBatchId = parentTask.batch_id;
  }
  let batch = followBatchId ? st.batches.find(b => b.id === followBatchId && (!owner || b.owner_id === owner)) : null;
  const createdAt = nowISO();
  if (!batch) {
    const batchId = uuid('batch_');
    const name = `MJ_${action}_${createdAt.replace(/[\s:]/g,'_')}`;
    const dirs = makeDirs(mjOutputRoot(), name);
    batch = { id:batchId, owner_id:owner, name, note:'', status:'生成中', model:'Midjourney',
      size:String(body.aspect_ratio || body.size || '').trim(), image_size:'MJ', concurrency:1, retry_times:0,
      repeat_count:1, task_count:0, success_count:0, fail_count:0, running_count:0, output_dir:dirs.dir,
      config_json:JSON.stringify({source:'midjourney', action, ownerId:owner}), created_at:createdAt, updated_at:createdAt, finished_at:'' };
    st.batches.push(batch);
  }
  const taskIndex = (st.tasks.filter(t => t.batch_id === batch.id).length || 0) + 1;
  const task = { id:uuid('task_'), batch_id:batch.id, owner_id:owner, task_index:taskIndex,
    prompt:String(body.prompt || body.modal_prompt || '').trim(), main_image_path:'', ref_images_json:'[]',
    status:'提交生成中', attempt:1, remote_task_id:'', result_path:'', thumb_path:'', error_message:'',
    created_at:createdAt, updated_at:createdAt, finished_at:'', progress:1, progress_text:'正在提交到 Midjourney',
    mj_source:'midjourney', mj_action:action, mj_query_raw_json:'', mj_grid_remote_url:'', mj_grid_local_path:'',
    mj_variant_index:Number(body.index || body.image_no || body.image_index || 0) || 0,
    mj_images_json:'[]', mj_buttons_json:'[]', mj_executed_buttons_json:'[]',
    mj_parent_task_id:String(body.source_task_local_id || '').trim(),
    mj_parent_remote_task_id:String(body.task_id || '').trim(), mj_submission_json:JSON.stringify(body || {}) };
  st.tasks.push(task);
  batch.task_count = Number(batch.task_count || 0) + 1;
  batch.running_count = Number(batch.running_count || 0) + 1;
  batch.status = '生成中'; batch.updated_at = createdAt;
  db._save(); addLog(`创建 Midjourney 任务：${batch.name} / #${taskIndex}`, { ownerId:owner, batchId:batch.id });
  return { batch, task };
}
function markMjButtonExecuted(localTaskId='', buttonMeta={}) {
  const task = getDB()._store.tasks.find(t => t.id === localTaskId); if (!task) return;
  let arr = []; try { arr = JSON.parse(task.mj_executed_buttons_json || '[]') || []; } catch {}
  const key = String(buttonMeta.custom_id || buttonMeta.label || '').trim(); if (!key) return;
  if (!arr.includes(key)) arr.push(key); task.mj_executed_buttons_json = JSON.stringify(arr); task.updated_at = nowISO(); getDB()._save();
}
function resolveMidjourneyLocalTask(body={}) {
  const st = getDB()._store;
  const localTaskId = String(body.local_task_id || '').trim();
  if (localTaskId) { const byId = st.tasks.find(t => t.id === localTaskId); if (byId) return byId; }
  const remoteId = String(body.task_id || '').trim();
  if (remoteId) return st.tasks.find(t => t.remote_task_id === remoteId) || null;
  return null;
}
async function saveMidjourneyTaskImages(task, ret={}) {
  const st = getDB()._store; const batch = st.batches.find(b => b.id === task.batch_id); if (!batch) return;
  ensureDir(batch.output_dir || mjOutputRoot()); ensureDir(path.join(batch.output_dir, '_thumbs'));
  const allResultUrls = Array.isArray(ret.all_image_urls) ? ret.all_image_urls.map(x=>String(x||'').trim()).filter(Boolean) : [];
  let gridUrl = String(ret.grid_image_url || ret.gridImageUrl || '').trim();
  let rawUrls = Array.isArray(ret.image_urls) ? ret.image_urls.map(x=>String(x||'').trim()).filter(Boolean) : [];
  // 优先使用 grid_image_url + image_urls；只有没有 image_urls 时才用 allResultUrls 兜底，避免参考图/旧字段重复进入批次。
  if (!gridUrl && allResultUrls.length) gridUrl = allResultUrls[0];
  if (!rawUrls.length && allResultUrls.length) rawUrls = allResultUrls.filter(u => u && u !== gridUrl);
  rawUrls = [...new Set(rawUrls.map(u => String(u || '').trim()).filter(u => u && u !== gridUrl))];
  if (!gridUrl && allResultUrls.length) gridUrl = allResultUrls[0];
  if (!rawUrls.length && allResultUrls.length) rawUrls = allResultUrls.filter(u => u && u !== gridUrl);
  rawUrls = [...new Set(rawUrls.map(u => String(u || '').trim()).filter(u => u && u !== gridUrl && isHttpImageUrlForMj(u)))];
  const taskAction = String(task.mj_action || '').toLowerCase();
  const singleImageAction = /^(upscale|zoom|pan|remix|inpaint|modal)$/.test(taskAction);
  if (singleImageAction) { rawUrls = rawUrls.length ? rawUrls : allResultUrls; gridUrl = ''; }
  const normGrid = normalizeMjRemoteUrl(gridUrl);
  const seenRawUrls = new Set();
  rawUrls = rawUrls.map(u => String(u || '').trim()).filter(u => {
    const nu = normalizeMjRemoteUrl(u);
    if (!u || !nu || !isHttpImageUrlForMj(u)) return false;
    if (normGrid && nu === normGrid) return false;
    if (seenRawUrls.has(nu)) return false;
    seenRawUrls.add(nu);
    return true;
  });
  if (!gridUrl && !rawUrls.length) {
    addLog(`Midjourney 查询结果暂无图片 URL，跳过保存并继续等待：task=${task.remote_task_id || task.id}`, { ownerId:task.owner_id, batchId:batch.id, level:'warn' });
    return { gridRow:null, imageRows:[], payload:[] };
  }
  const prefix = String(task.task_index).padStart(5,'0'); const createdAt = nowISO();
  // 清理同一任务下重复 remote_url 记录，避免图片管理 / 历史记录里同一单图出现两次。
  const dedupExisting = new Map();
  let keptGrid = false;
  st.images = st.images.filter((img)=>{
    if (img.task_id !== task.id) return true;
    const remote = normalizeMjRemoteUrl(img.remote_url || '');
    if (!remote) return true;
    if (normGrid && remote === normGrid && !img.mj_is_grid) return false;
    if (img.mj_is_grid) {
      if (singleImageAction) return false;
      if (normGrid && remote !== normGrid) return false;
      if (keptGrid) return false;
      keptGrid = true;
    }
    const key = `${task.id}|${remote}|${img.mj_is_grid ? 'grid' : 'single'}`;
    if (dedupExisting.has(key)) return false;
    dedupExisting.set(key, img.id);
    return true;
  });
  const existing = st.images.filter(i => i.task_id === task.id);
  const saveOne = async (remoteUrl, suffix, variantIndex=0, isGrid=false, hidden=false) => {
    if (!remoteUrl) return null;
    let ext = '.png'; try { const m=String(new URL(remoteUrl).pathname||'').match(/\.(png|jpe?g|webp|gif)$/i); if(m) ext=m[0].toLowerCase(); } catch {}
    const desiredFilePath = path.join(batch.output_dir, `${prefix}${suffix}${ext}`);
    const desiredThumbPath = path.join(batch.output_dir, '_thumbs', `${prefix}${suffix}.png`);
    let filePath = '';
    let thumbPath = '';
    try {
      if (!fs.existsSync(desiredFilePath)) await downloadToFile(remoteUrl, desiredFilePath);
      if (fs.existsSync(desiredFilePath)) {
        filePath = desiredFilePath;
        createThumb(filePath, desiredThumbPath, 300);
        if (fs.existsSync(desiredThumbPath)) thumbPath = desiredThumbPath;
      }
    } catch (e) {
      addLog(`Midjourney 图片下载失败，已保留远程 URL 显示：${remoteUrl}；${e.message || e}`, { ownerId:task.owner_id, batchId:batch.id, level:'warn' });
    }
    const stat = filePath && fs.existsSync(filePath) ? fs.statSync(filePath) : {size:0};
    const remoteKey = normalizeMjRemoteUrl(remoteUrl);
    let row = existing.find(i => normalizeMjRemoteUrl(i.remote_url || '') === remoteKey && !!i.mj_is_grid === !!isGrid);
    const rowPatch = { batch_id:batch.id, task_id:task.id, owner_id:task.owner_id, file_path:filePath, thumb_path:thumbPath, size_bytes:stat.size||0, remote_url:remoteUrl, mj_is_grid:!!isGrid, hidden_in_recent:!!hidden, mj_variant_index:Number(variantIndex||0), mj_source:'midjourney' };
    if (!row) { row = { id:uuid('img_'), created_at:createdAt, ...rowPatch }; st.images.push(row); }
    else Object.assign(row, rowPatch);
    return row;
  };
  let gridRow = null;
  if (gridUrl) gridRow = await saveOne(gridUrl, '_grid', 0, true, false);
  const rows = [];
  for (let i=0;i<rawUrls.length;i++){
    const r=await saveOne(rawUrls[i], `_${i+1}`, i+1, false, !!gridUrl);
    if(r) rows.push(r);
  }
  const payload = rows.map((row, idx)=>({ index:Number(row.mj_variant_index || idx+1), label:`${Number(row.mj_variant_index || idx+1)}（${['左上','右上','左下','右下'][Math.max(0,Number(row.mj_variant_index||idx+1)-1)]||''}）`, remote_url:row.remote_url||'', local_path:row.file_path||'', image_id:row.id||'' }));
  task.mj_grid_remote_url = gridUrl || task.mj_grid_remote_url || '';
  task.mj_grid_local_path = (gridRow && gridRow.file_path) || task.mj_grid_local_path || '';
  task.mj_images_json = JSON.stringify(payload);
  task.result_path = (gridRow && gridRow.file_path) || (payload[0] && payload[0].local_path) || task.result_path || '';
  task.thumb_path = (gridRow && gridRow.thumb_path) || (rows[0] && rows[0].thumb_path) || task.thumb_path || '';
  addLog(`Midjourney 结果已记录：四宫格=${gridUrl ? '1' : '0'}，单图=${rows.length}，批次=${batch.name}`, { ownerId:task.owner_id, batchId:batch.id });
  return { gridRow, imageRows:rows, payload };
}

async function saveMidjourneyTaskVideos(task, ret={}) {
  const st = ensureVideoStore();
  const batch = st.batches.find(b => b.id === task.batch_id);
  if (!batch) return [];
  const videoUrls = pickApimartVideoUrls(ret.raw || ret);
  if (!videoUrls.length) return [];
  ensureDir(batch.output_dir || mjOutputRoot());
  const prefix = String(task.task_index || 1).padStart(5, '0');
  const createdAt = nowISO();
  const rows = [];
  for (let i = 0; i < videoUrls.length; i++) {
    const remoteUrl = String(videoUrls[i] || '').trim();
    if (!remoteUrl) continue;
    let row = (st.video_tasks || []).find(v => v.source_midjourney_task_id === task.id && v.remote_url === remoteUrl);
    if (!row) {
      row = {
        id: uuid('video_'),
        owner_id: task.owner_id,
        platform: 'midjourney',
        model: 'Midjourney Video',
        prompt: task.prompt || '',
        status: '下载中',
        progress: 96,
        progress_text: 'Midjourney 视频已生成，正在保存到本地',
        task_id: task.remote_task_id || '',
        remote_url: remoteUrl,
        file_path: '',
        video_batch_id: `mj_video_${batch.id}`,
        video_batch_name: `MJ_Video_${safeName(batch.note || batch.name || batch.id, 'Midjourney')}`,
        source_midjourney_batch_id: batch.id,
        source_midjourney_task_id: task.id,
        created_at: createdAt,
        updated_at: createdAt,
        finished_at: ''
      };
      st.video_tasks.push(row);
    }
    const filePath = path.join(batch.output_dir, `${prefix}_video_${i + 1}.mp4`);
    try {
      if (!fs.existsSync(filePath)) await downloadVideoResult(remoteUrl, filePath);
      row.file_path = filePath;
      row.progress_text = '已完成';
    } catch (e) {
      row.download_error = e.message || String(e);
      row.progress_text = '远端视频已生成，本地保存失败，可用远程链接预览';
      addLog(`Midjourney 视频保存失败，保留远程链接：${remoteUrl}，${e.message || e}`, { ownerId: task.owner_id, batchId: batch.id, level:'warn' });
    }
    row.status = '已完成';
    row.progress = 100;
    row.updated_at = nowISO();
    row.finished_at = row.finished_at || nowISO();
    rows.push(row);
  }
  task.result_path = rows.find(r => r.file_path)?.file_path || task.result_path || '';
  task.mj_video_urls_json = JSON.stringify(rows.map((row, idx)=>({ index:idx + 1, remote_url:row.remote_url || '', local_path:row.file_path || '', video_id:row.id || '' })));
  getDB()._save();
  addLog(`Midjourney 视频结果已记录：${rows.length} 个，批次 ${batch.name}`, { ownerId:task.owner_id, batchId:batch.id });
  return rows;
}
async function repairCompletedMidjourneyImages(ownerId='') {
  const st = getDB()._store;
  const tasks = st.tasks.filter(t => (t.mj_source || '') === 'midjourney' && String(t.mj_action || '') !== 'describe' && /已完成|success|completed|done/i.test(String(t.status || '')) && (!ownerId || t.owner_id === ownerId));
  for (const task of tasks) {
    let raw = null;
    try { raw = JSON.parse(task.mj_query_raw_json || 'null'); } catch {}
    if (!raw) continue;
    const ret = normalizeMidjourneyTaskResult(task.remote_task_id || '', raw, task);
    const grid = String(ret.grid_image_url || '').trim() || (Array.isArray(ret.all_image_urls) && ret.all_image_urls[0] ? String(ret.all_image_urls[0]).trim() : '');
    const urls = Array.isArray(ret.image_urls) ? ret.image_urls.filter(Boolean) : [];
    if (!grid && !urls.length) continue;
    const existing = st.images.filter(i => i.task_id === task.id);
    const hasGrid = !grid || existing.some(i => i.mj_is_grid && i.remote_url === grid);
    const variantUrls = new Set(existing.filter(i => !i.mj_is_grid).map(i => String(i.remote_url || '').trim()).filter(Boolean));
    const missingVariant = urls.some(u => !variantUrls.has(String(u || '').trim()));
    if (!hasGrid || missingVariant) {
      await saveMidjourneyTaskImages(task, ret);
    }
  }
}

function pickMidjourneyFailureReason(ret={}) {
  const raw = ret && ret.raw && typeof ret.raw === 'object' ? ret.raw : {};
  const candidates = [
    ret.fail_reason, ret.error_message, ret.error, ret.reason,
    raw.fail_reason, raw.error_message, raw.error, raw.reason,
    raw.data && raw.data.fail_reason, raw.data && raw.data.error_message, raw.data && raw.data.error, raw.data && raw.data.reason
  ];
  for (const item of candidates) {
    if (item == null) continue;
    const text = typeof item === 'string' ? item : (typeof item === 'object' ? JSON.stringify(item) : String(item));
    if (text && text.trim()) return text.trim();
  }
  return '';
}

async function syncMidjourneyTaskState(task, ret={}) {
  if (!task) return; const st=getDB()._store; const batch=st.batches.find(b=>b.id===task.batch_id); if(!batch) return;
  const statusRaw=String(ret.status||'').trim(); const statusLower=statusRaw.toLowerCase();
  const failureReasonEarly = pickMidjourneyFailureReason(ret);
  const isSuccess=/success|succeed|completed|done|finish/.test(statusLower); const isFailed=/fail|error|cancel/.test(statusLower) || (!!failureReasonEarly && !isSuccess);
  task.remote_task_id=String(ret.task_id || task.remote_task_id || ''); task.progress=Math.max(0,Math.min(100,Number(ret.progress||task.progress||0)));
  task.progress_text=statusRaw || task.progress_text || '处理中'; task.updated_at=nowISO(); task.mj_query_raw_json=JSON.stringify(ret.raw||ret||{}); task.mj_buttons_json=JSON.stringify(Array.isArray(ret.buttons)?ret.buttons:[]); task.mj_text_outputs_json=JSON.stringify(Array.isArray(ret.text_outputs)?ret.text_outputs:[]);
  if(ret.grid_image_url) task.mj_grid_remote_url=ret.grid_image_url;
  const hasImageUrls = !!(ret.grid_image_url || (Array.isArray(ret.image_urls) && ret.image_urls.length) || (Array.isArray(ret.all_image_urls) && ret.all_image_urls.length));
  const hasVideoUrls = Array.isArray(ret.video_urls) && ret.video_urls.length > 0;
  const isDescribe = String(task.mj_action || '').toLowerCase() === 'describe';
  const hasTextOutputs = Array.isArray(ret.text_outputs) && ret.text_outputs.length > 0;
  if(isFailed){ const reason=failureReasonEarly || statusRaw || 'Midjourney task failed'; if(task.status!=='失败'){ batch.fail_count=Number(batch.fail_count||0)+1; batch.running_count=Math.max(0,Number(batch.running_count||0)-1); } task.status='失败'; task.error_message=reason; task.finished_at=nowISO(); task.progress=100; task.progress_text=reason; }
  else if(isSuccess && isDescribe){ if(task.status!=='已完成'){ batch.success_count=Number(batch.success_count||0)+1; batch.running_count=Math.max(0,Number(batch.running_count||0)-1); } task.status='已完成'; task.finished_at=nowISO(); task.progress=100; task.progress_text='图生文已完成'; }
  else if(isSuccess && hasVideoUrls){ await saveMidjourneyTaskVideos(task, ret); if(task.status!=='已完成'){ batch.success_count=Number(batch.success_count||0)+1; batch.running_count=Math.max(0,Number(batch.running_count||0)-1); } task.status='已完成'; task.finished_at=nowISO(); task.progress=100; task.progress_text='Midjourney 视频已完成'; }
  else if(isSuccess && hasImageUrls){ await saveMidjourneyTaskImages(task, ret); if(task.status!=='已完成'){ batch.success_count=Number(batch.success_count||0)+1; batch.running_count=Math.max(0,Number(batch.running_count||0)-1); } task.status='已完成'; task.finished_at=nowISO(); task.progress=100; }
  else if(isSuccess && !hasImageUrls){ task.status='生成中'; task.progress=Math.max(Number(task.progress||0), 95); task.progress_text=hasTextOutputs ? '任务已成功，等待文本结果' : '任务已成功，等待图片 URL 返回'; }
  else task.status=task.remote_task_id ? '生成中' : '提交生成中';
  const done=Number(batch.success_count||0)+Number(batch.fail_count||0);
  if(done>=Number(batch.task_count||0) && Number(batch.running_count||0)===0){ batch.status=Number(batch.fail_count||0)>0 && Number(batch.success_count||0)>0 ? '部分完成' : (Number(batch.fail_count||0)>0?'失败':'已完成'); batch.finished_at=nowISO(); } else batch.status='生成中';
  batch.updated_at=nowISO(); getDB()._save();
}
function normalizeMidjourneyTaskResult(taskId, raw={}, localTask=null) {
  const mergedUrls = mergeMidjourneyResultImageUrls(raw);
  const localAction = String((localTask && localTask.mj_action) || '').toLowerCase();
  const singleImageAction = /^(upscale|zoom|pan|remix|inpaint|modal)$/.test(localAction);
  const directGrid = pickDirectMidjourneyGridUrl(raw);
  let grid = singleImageAction && !directGrid ? '' : (mergedUrls.grid || pickMidjourneyGridUrl(raw));
  let imageUrls = uniqueMidjourneyImageUrls(raw);
  if (singleImageAction && !imageUrls.length) {
    const singles = mergedUrls.result_urls && mergedUrls.result_urls.length ? mergedUrls.result_urls : pickApimartImageUrls(raw).filter(isHttpImageUrlForMj);
    const seenSingle = new Set();
    imageUrls = singles.map(u=>String(u||'').trim()).filter(u=>u && u !== grid && !seenSingle.has(u) && seenSingle.add(u));
  }
  let buttons=pickMidjourneyButtons(raw);
  if (!buttons.length) buttons = buildMidjourneyFallbackButtons(raw, localTask, imageUrls);
  let executed=[], batchId='', localTaskId='', batchName='', localImages=[], gridLocalPath='';
  if(localTask){ batchId=localTask.batch_id||''; localTaskId=localTask.id||''; const batch=getDB()._store.batches.find(b=>b.id===localTask.batch_id); batchName=(batch && (batch.note||batch.name)) || ''; try{executed=JSON.parse(localTask.mj_executed_buttons_json||'[]')||[]}catch{} try{localImages=JSON.parse(localTask.mj_images_json||'[]')||[]}catch{} gridLocalPath=localTask.mj_grid_local_path||''; }
  const resultUrls = pickMidjourneyResultUrls(raw);
  const directAll = grid ? [grid, ...imageUrls] : [];
  const failureReason = pickMidjourneyFailureReason({raw});
  return { ok:true, source:'midjourney', task_id:String(taskId || pickTaskIdFromApimart(raw) || ''), local_task_id:localTaskId, batch_id:batchId, batch_name:batchName, status:pickApimartStatus(raw)||'submitted', progress:pickApimartProgress(raw), grid_image_url:grid, image_urls:imageUrls, all_image_urls:directAll.length ? directAll : (resultUrls.length ? resultUrls : pickApimartImageUrls(raw).filter(isHttpImageUrlForMj)), local_images:localImages, local_grid_path:gridLocalPath, video_urls:pickApimartVideoUrls(raw), text_outputs:pickMidjourneyTextOutputs(raw), buttons, executed_buttons:executed, fail_reason:failureReason, error_message:failureReason, error:failureReason, raw };
}
async function submitMidjourneyAction(body={}, owner='local') {
  const cfg=readConfig(); const apiKey=String(body.api_key || cfg.api_key || cfg.apiKey || '').trim(); if(!apiKey) throw new Error('请先在首页填写并保存 APIMart API Key');
  let action=String(body.action || 'imagine').trim().toLowerCase();
  if(action==='button'){ const meta=buttonActionFromMeta(body.button_label || body.label || '', body.custom_id || ''); action=meta.action; body.index=body.index || meta.index || ''; body.direction=body.direction || meta.direction || ''; body.zoom_ratio=body.zoom_ratio || meta.zoom_ratio || ''; body.remix_strength=body.remix_strength || meta.remix_strength || ''; body.motion=body.motion || meta.motion || ''; }
  if(action === 'describe' && (body.describe_multi || String(body.describe_mode || '').toLowerCase() === 'multi')){
    const urlEntries = [...new Set(parseMjUrlText(body.image_urls_text || body.image_url || '').map(String))].map(url => ({url}));
    const fileEntries = (Array.isArray(body.describe_images) ? body.describe_images : (Array.isArray(body.images) ? body.images : [])).map(item => ({item}));
    const entries = [...fileEntries, ...urlEntries];
    if(!entries.length) throw new Error('多图图生文需要上传图片或填写图片 URL');
    let batchId = String(body.batch_id || '').trim();
    const results = [];
    for(const entry of entries){
      const childBody = { ...body, describe_multi:false, describe_mode:'single', image_url:entry.url || '', image_urls_text:entry.url || '', describe_images:entry.item ? [entry.item] : [], images:entry.item ? [entry.item] : [], batch_id:batchId };
      const ret = await submitMidjourneyAction(childBody, owner);
      if(!batchId) batchId = ret.batch_id || '';
      results.push(ret);
    }
    return { ok:true, action:'describe', multi:true, batch_id:batchId, task_count:results.length, tasks:results };
  }
  for (const ref of [{field:'cref', upload:'cref_images'}, {field:'sref', upload:'sref_images'}, {field:'dref', upload:'dref_images'}]) {
    if (!String(body[ref.field] || '').trim() && Array.isArray(body[ref.upload]) && body[ref.upload].length) {
      const uploadedRef = await uploadMidjourneyItemsToUrls(body[ref.upload].slice(0,1), owner, apiKey);
      if (uploadedRef[0]) body[ref.field] = uploadedRef[0];
    }
  }
  const ctx=ensureMjBatchAndTask(body, owner); const batch=ctx.batch, task=ctx.task;
  const endpointMap={ imagine:'/midjourney/generations', blend:'/midjourney/generations/blend', describe:'/midjourney/generations/describe', edits:'/midjourney/generations/edits', upscale:'/midjourney/generations/upscale', variation:'/midjourney/generations/variation', high_variation:'/midjourney/generations/high-variation', low_variation:'/midjourney/generations/low-variation', reroll:'/midjourney/generations/reroll', zoom:'/midjourney/generations/zoom', pan:'/midjourney/generations/pan', inpaint:'/midjourney/generations/inpaint', modal:'/midjourney/generations/modal', video:'/midjourney/generations/video' };
  let endpoint=endpointMap[action]; if(action==='remix') endpoint=`/midjourney/generations/remix-${String(body.remix_strength||'strong').trim().toLowerCase()==='subtle'?'subtle':'strong'}`; if(!endpoint) throw new Error('不支持的 Midjourney 操作：'+action);
  const prompt=buildMidjourneyPrompt(body); const speed=String(body.speed || body.modal_speed || '').trim(); const index=Number(body.index || body.image_no || body.image_index || 0); const customId=String(body.custom_id || '').trim(); const version=String(body.version || '').trim(); let payload={};
  if(action==='blend'){ const imageUrls=[...parseMjUrlText(body.image_urls_text), ...await uploadMidjourneyItemsToUrls(body.blend_images || body.images || [], owner, apiKey)].slice(0,4); if(imageUrls.length<2) throw new Error('多图融合至少需要 2 张图片'); payload={ image_urls:imageUrls, dimensions:String(body.dimensions||'SQUARE').trim(), size:String(body.size||'').trim(), speed }; }
  else if(action==='describe'){ const direct=parseMjUrlText(body.image_url || body.image_urls_text)[0] || ''; const srcItems = body.describe_images || body.images || []; if(Array.isArray(srcItems) && srcItems[0]) saveMidjourneyInputPreview(task, srcItems[0], 'describe_input'); const uploaded=await uploadMidjourneyItemsToUrls(srcItems, owner, apiKey); const imageUrl=direct || uploaded[0] || ''; if(!imageUrl) throw new Error('图生文需要上传 1 张图片'); payload={ image_urls:[imageUrl], speed }; }
  else if(action==='edits'){ const imageUrls=[...parseMjUrlText(body.image_urls_text), ...await uploadMidjourneyItemsToUrls(body.edit_images || body.images || [], owner, apiKey)]; if(!imageUrls.length) throw new Error('图片编辑至少需要 1 张源图'); payload={ prompt, image_urls:imageUrls, speed, version }; }
  else if(action==='imagine'){ const imageUrls=[...parseMjUrlText(body.image_urls_text), ...await uploadMidjourneyItemsToUrls(body.imagine_images || body.images || [], owner, apiKey)].slice(0,4); const finalPrompt = imageUrls.length ? `${imageUrls.join(' ')} ${prompt}`.trim() : prompt; payload={ prompt: finalPrompt, speed, version }; if(body.size) payload.size=body.size; }
  else if(action==='modal'){ const maskUrl=String(body.modal_mask_url||'').trim() || (await uploadMidjourneyItemsToUrls(body.modal_mask ? [body.modal_mask] : (body.modal_masks || []), owner, apiKey))[0] || ''; if(!maskUrl) throw new Error('Modal 补充参数需要上传遮罩图或填写遮罩图 URL'); payload={ task_id:String(body.modal_task_id || body.task_id || '').trim(), prompt:String(body.modal_prompt || prompt || '').trim(), mask_url:maskUrl, speed }; }
  else if(action==='video'){
    const taskId=String(body.task_id||'').trim();
    const startUrls=[...parseMjUrlText(body.image_urls_text || body.start_image_url), ...await uploadMidjourneyItemsToUrls(body.video_start_images || body.images || [], owner, apiKey)].slice(0,1);
    const endUrl=String(body.end_url||'').trim() || (await uploadMidjourneyItemsToUrls(body.video_end_images || [], owner, apiKey))[0] || '';
    if(taskId && startUrls.length) throw new Error('Midjourney 图生视频的 task_id 和 image_urls 不能同时提交，请二选一');
    if(taskId && endUrl) throw new Error('Midjourney 图生视频使用 task_id 时不能同时提交结束帧 end_url');
    if(!taskId && !startUrls.length) throw new Error('图生视频需要填写任务 ID，或上传/填写 1 张起始帧图片');
    const videoIndex = body.video_index !== undefined && String(body.video_index).trim() !== '' ? Number(body.video_index) : (index ? Math.max(0, index - 1) : undefined);
    const batchSizeRaw = Number(body.batch_size || 1);
    const batchSize = Number.isFinite(batchSizeRaw) ? Math.max(1, Math.min(4, batchSizeRaw)) : 1;
    payload={ prompt, task_id:taskId, image_urls:startUrls, end_url:endUrl, motion:String(body.motion||'low').trim(), video_type:String(body.video_type||'480').trim(), batch_size:batchSize };
    if(customId) payload.custom_id=customId;
    if(Number.isFinite(videoIndex)) payload.index=videoIndex;
  }
  else if(action in {upscale:1, variation:1, high_variation:1, low_variation:1, reroll:1, zoom:1, pan:1, inpaint:1, remix:1}){ const taskId=String(body.task_id||'').trim(); if(!taskId) throw new Error('task_id 不能为空'); payload={ task_id:taskId, speed }; if(customId) payload.custom_id=customId; if(index) payload.index=index; if(action==='zoom') payload.zoom_ratio=Number(body.zoom_ratio||2); if(action==='pan') payload.direction=String(body.direction||'left').trim(); if(action==='reroll' && prompt) payload.prompt=prompt; if(action==='remix' && prompt) payload.prompt=prompt; }
  payload=sanitizeMjPayload(payload); addLog(`Midjourney ${action} 提交：${compactJsonForLog(payload,1200)}`);
  try { const raw=await postJsonApimart(endpoint, apiKey, payload, 180000); const remoteTaskId=pickTaskIdFromApimart(raw); Object.assign(task,{ remote_task_id:remoteTaskId||'', status:remoteTaskId?'生成中':'提交生成中', progress:remoteTaskId?5:1, progress_text:remoteTaskId?'已提交，等待 Midjourney 查询结果':'已提交', updated_at:nowISO(), mj_action:action, mj_submission_json:JSON.stringify(payload) }); if(body.source_task_local_id && (body.button_label || body.custom_id)) markMjButtonExecuted(String(body.source_task_local_id||''), {label:body.button_label||'', custom_id:body.custom_id||''}); getDB()._save(); return { ok:true, action, endpoint:`/v1${endpoint}`, task_id:remoteTaskId, local_task_id:task.id, batch_id:batch.id, batch_name:batch.note||batch.name||'', submitted_payload:payload, raw }; }
  catch(e){ Object.assign(task,{status:'失败', progress:100, progress_text:'提交失败', error_message:e.message||String(e), updated_at:nowISO(), finished_at:nowISO()}); batch.running_count=Math.max(0,Number(batch.running_count||0)-1); batch.fail_count=Number(batch.fail_count||0)+1; batch.updated_at=nowISO(); getDB()._save(); throw e; }
}
async function queryMidjourneyTask(body={}) {
  const cfg=readConfig(); const apiKey=String(body.api_key || cfg.api_key || cfg.apiKey || '').trim(); if(!apiKey) throw new Error('请先填写 APIMart API Key');
  const taskId=String(body.task_id || '').trim(); if(!taskId) throw new Error('task_id 不能为空');
  const localTask=resolveMidjourneyLocalTask(body) || getDB()._store.tasks.find(t=>t.remote_task_id===taskId) || null;
  const raw = await queryMidjourneyTaskRaw(taskId, apiKey, 180000);
  const ret=normalizeMidjourneyTaskResult(taskId, raw, localTask);
  if(localTask){ await syncMidjourneyTaskState(localTask, ret); return normalizeMidjourneyTaskResult(taskId, raw, localTask); }
  return ret;
}

function findMjUpscaleChild(parentLocalId='', index=0, owner='') {
  const idx = Number(index || 0);
  if (!parentLocalId || !idx) return null;
  return getDB()._store.tasks
    .filter(t => (!owner || t.owner_id === owner) && t.mj_parent_task_id === parentLocalId && String(t.mj_action || '').toLowerCase() === 'upscale' && Number(t.mj_variant_index || 0) === idx)
    .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0] || null;
}
function mjTaskPrimaryImage(task) {
  if (!task) return null;
  const img = getDB()._store.images
    .filter(i => i.task_id === task.id && !i.mj_is_grid)
    .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0] || null;
  return img ? formatImage(img) : null;
}
async function mjUpscaleJump(body={}, owner='local') {
  const st = getDB()._store;
  const parentLocalId = String(body.local_task_id || body.source_task_local_id || '').trim();
  const index = Number(body.index || 0);
  if (!parentLocalId || !index) throw new Error('跳转图片需要父任务 local_task_id 和 index');
  const parent = st.tasks.find(t => t.id === parentLocalId && (!owner || t.owner_id === owner));
  if (!parent) throw new Error('父四宫格任务不存在或无权限');
  let child = findMjUpscaleChild(parent.id, index, owner);
  if (child) return { ok:true, found:true, task_id:child.remote_task_id || '', local_task_id:child.id, batch_id:child.batch_id, status:child.status || '', image:mjTaskPrimaryImage(child) };
  const ret = await submitMidjourneyAction({ action:'upscale', task_id:parent.remote_task_id || String(body.task_id || '').trim(), index, source_task_local_id:parent.id, batch_id:parent.batch_id, api_key:body.api_key || '' }, owner);
  child = st.tasks.find(t => t.id === ret.local_task_id) || null;
  return { ok:true, found:false, submitted:true, task_id:ret.task_id || '', local_task_id:ret.local_task_id || '', batch_id:ret.batch_id || '', status:child ? child.status || '' : 'submitted', image:null };
}


async function apiHandler(req, res, parsed) {
  const cfg = readConfig();
  const local = isLocalReq(req);
  const publicHost = isPublicHost(req, cfg);
  const p = parsed.pathname;
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return send(res, {ok:true});
  if (requiresSameOriginCheck(method) && !isSameOriginRequest(req)) {
    return send(res, {ok:false,error:'跨站请求已拦截'}, 403);
  }
  if (!local && publicHost && p === '/api/public_login' && method === 'POST') {
    const body = await readBody(req).catch(()=>({}));
    const pass = String(cfg.public_password || '').trim();
    const got = String(body.password || body.access || '').trim();
    if (!cfg.public_enabled) return send(res, {ok:false,error:'公网访问未开启'}, 403);
    if (!pass) return send(res, {ok:false,error:'公网访问密码未设置，请在主机端“公网访问”里设置访问密码'}, 403);
    if (got !== pass) return send(res, {ok:false,error:'访问密码错误'}, 403);
    const days = Number(cfg.public_remember_days || 7);
    const access = issuePublicAccessToken(days);
    const cookie = `local_api_public_access=${encodeURIComponent(access)}; Max-Age=${Math.max(1, days) * 24 * 60 * 60}; Path=/; SameSite=Lax`;
    return send(res, {ok:true, access, remember_days: days, app: cfg.app_name}, 200, {'Set-Cookie': cookie});
  }
  if (!local && publicHost && !hasPublicAccess(req, parsed, cfg)) return send(res, {ok:false,error:'公网访问密码错误或未填写'}, 403);
  if (!local && !publicHost && !cfg.lan_enabled) return send(res, {ok:false,error:'局域网共享未开启'}, 403);
  if (!local && publicHost && !cfg.public_enabled) return send(res, {ok:false,error:'公网访问未开启'}, 403);
  // V9.2 修复实时任务面板统计：
  // 访问设备数据隔离关闭时，历史/图片列表可以看全部数据（owner=''），
  // 但右侧实时任务面板必须始终统计“当前设备自己创建的任务”。
  // 因此创建批次永远使用 deviceOwner；列表/删除/导出权限仍按 owner 控制。
  const deviceOwner = getDeviceOwner(req, parsed);
  const accessOwner = getOwner(req, parsed, cfg);
  const owner = cfg.device_data_isolation === false ? '' : accessOwner;
  const dataOwner = owner;
  // 公网访问已通过密码后，按局域网逻辑使用；不再用只读模式阻止上传/生成。
  try {
    if (method === 'GET' && p === '/api/health') return send(res, {ok:true, time: nowISO(), app: cfg.app_name, ...urls(cfg)});
    if (method === 'GET' && p === '/api/shortcuts') {
      if (!local) return send(res, {ok:false,error:'快捷键只能在主机程序中配置'}, 403);
      const shortcutConfig = validateShortcutConfiguration(cfg);
      const accelerator = shortcutConfig.shortcut_settings.open_app;
      const globalRegistered = shortcutConfig.shortcuts_enabled && !SERVER_ONLY
        ? activeOpenAppShortcut === accelerator && globalShortcut.isRegistered(accelerator)
        : false;
      return send(res, {ok:true, shortcuts_enabled:shortcutConfig.shortcuts_enabled, shortcut_settings:shortcutConfig.shortcut_settings, defaults:{...DEFAULT_SHORTCUT_SETTINGS}, global_registered:globalRegistered});
    }
    if (method === 'POST' && p === '/api/shortcuts') {
      if (!local) return send(res, {ok:false,error:'快捷键只能在主机程序中配置'}, 403);
      const body = await readBody(req);
      let shortcutConfig;
      try { shortcutConfig = validateShortcutConfiguration(body, true); }
      catch (error) { return send(res, {ok:false,error:error.message || '快捷键配置无效'}, 400); }
      const previousShortcut = activeOpenAppShortcut;
      const nextShortcut = shortcutConfig.shortcuts_enabled ? shortcutConfig.shortcut_settings.open_app : '';
      if (!replaceOpenAppShortcut(nextShortcut)) {
        return send(res, {ok:false,error:'当前快捷键被系统或其他软件占用，请更换。'}, 409);
      }
      try {
        saveConfig({shortcuts_enabled:shortcutConfig.shortcuts_enabled, shortcut_settings:shortcutConfig.shortcut_settings});
      } catch (error) {
        replaceOpenAppShortcut(previousShortcut);
        return send(res, {ok:false,error:error.message || '快捷键设置保存失败'}, 500);
      }
      return send(res, {ok:true, shortcuts_enabled:shortcutConfig.shortcuts_enabled, shortcut_settings:shortcutConfig.shortcut_settings, defaults:{...DEFAULT_SHORTCUT_SETTINGS}, global_registered:shortcutConfig.shortcuts_enabled ? globalShortcut.isRegistered(shortcutConfig.shortcut_settings.open_app) : false});
    }
    if (method === 'GET' && p === '/api/config') {
      const u = urls(cfg);
      if (publicHost) u.public_url = requestOrigin(req) || u.public_url;
      const publicOrigin = publicHost ? requestOrigin(req) : '';
      const status = publicHost ? { ...tunnelState, url: publicOrigin || u.public_url || normalizeExternalPublicOrigin(tunnelState.url || '') } : { ...tunnelState, url: normalizeExternalPublicOrigin(tunnelState.url || '') };
      return send(res, { ...configForClient(cfg, local, publicHost), ...u, public_url: publicOrigin || u.public_url, lan_enabled: cfg.lan_enabled, public_status: status });
    }
    if (method === 'POST' && p === '/api/config') {
      if (!local) return send(res, {ok:false,error:'局域网端只能在浏览器本地保存 API Key，不能修改主机设置'}, 403);
      const body = await readBody(req);
      if (!String(body.api_key || '').trim() && String(cfg.api_key || '').trim()) delete body.api_key;
      const oldPort = Number(cfg.port || 7861); const next = saveConfig(body); const newPort = Number(next.port || 7861);
      const runtime = { port_changed: oldPort !== newPort };
      if (runtime.port_changed) setTimeout(()=>startServer(newPort), 900);
      return send(res, {ok:true, config:{...next, ...urls(next), local_runtime_data_dir:DATA_ROOT, output_runtime_data_dir:runtimeMirrorDir(next), local_hot_cache_dir:LOCAL_HOT_CACHE_ROOT, local_hot_cache_max_mb:Math.round(LOCAL_HOT_CACHE_MAX_BYTES / 1024 / 1024)}, runtime});
    }
    if (method === 'POST' && p === '/api/update/check') {
      if (!local) return send(res, {ok:false,error:'只有主机端可以检查软件更新'}, 403);
      const body = await readBody(req);
      return send(res, await checkSoftwareUpdate(body.repo || body.update_repo || '', cfg));
    }
    if (method === 'POST' && p === '/api/update/download') {
      if (!local) return send(res, {ok:false,error:'只有主机端可以下载软件更新'}, 403);
      const body = await readBody(req);
      return send(res, await downloadSoftwareUpdate(body.repo || body.update_repo || '', readConfig()));
    }
    if (method === 'POST' && p === '/api/update/install') {
      if (!local) return send(res, {ok:false,error:'只有主机端可以安装软件更新'}, 403);
      const body = await readBody(req);
      return send(res, installSoftwareUpdate(body.path || '', readConfig()));
    }
    if (method === 'POST' && p === '/api/update/apply_latest') {
      if (!local) return send(res, {ok:false,error:'只有主机端可以执行软件更新'}, 403);
      const body = await readBody(req);
      return send(res, await applyLatestSoftwareUpdate(body.repo || body.update_repo || '', readConfig()));
    }
    if (method === 'GET' && p === '/api/update/status') {
      if (!local) return send(res, {ok:false,error:'只有主机端可以查看软件更新状态'}, 403);
      return send(res, getSoftwareUpdateStatus());
    }
    if (method === 'GET' && p === '/api/public_status') {
      const publicCfg = configForClient(cfg, local, publicHost);
      const u = urls(cfg);
      if (publicHost) u.public_url = requestOrigin(req) || u.public_url;
      const publicOrigin = publicHost ? requestOrigin(req) : '';
      const status = publicHost ? { ...tunnelState, url: publicOrigin || u.public_url || normalizeExternalPublicOrigin(tunnelState.url || '') } : { ...tunnelState, url: normalizeExternalPublicOrigin(tunnelState.url || '') };
      return send(res, { ok:true, config:{...publicCfg, ...u, public_url: publicOrigin || u.public_url}, status, readonly: !local });
    }
    if (method === 'POST' && p === '/api/public_start') {
      if (!local) return send(res, {ok:false,error:'只有本机管理端可以开启公网访问'}, 403);
      const body = await readBody(req);
      const ret = startTunnelProcess(body);
      return send(res, ret);
    }
    if (method === 'POST' && p === '/api/public_stop') {
      if (!local) return send(res, {ok:false,error:'只有本机管理端可以关闭公网访问'}, 403);
      stopTunnelProcess();
      return send(res, {ok:true, status:tunnelState});
    }
    if (method === 'GET' && p === '/api/prompt_library') return send(res, promptLibraryResponse(local, cfg));
    if (method === 'POST' && p === '/api/prompt_library/group') { const body = await readBody(req); return send(res, upsertPromptGroup(body, local, cfg, deviceOwner)); }
    if (method === 'POST' && p === '/api/prompt_library/template') { const body = await readBody(req); return send(res, upsertPromptTemplate(body, local, cfg, deviceOwner)); }
    if (method === 'GET' && p === '/api/assets/init') return send(res, assetLibraryInit(local, cfg, deviceOwner));
    if (method === 'GET' && p === '/api/assets/groups') { const db=readAssetDb(cfg); ensureDefaultAssetGroups(db, assetClientId(local, deviceOwner)); writeAssetDb(db, cfg); return send(res,{ok:true, groups:visibleAssetGroups(db, local, assetClientId(local, deviceOwner))}); }
    if (method === 'GET' && p === '/api/assets/list') return send(res, assetList(String(parsed.query.group_id || ''), local, cfg, deviceOwner, parsed.query.search || ''));
    if (method === 'GET' && p === '/api/assets/source') return streamAssetSource(parsed.query.id || '', local, cfg, deviceOwner, req, res, parsed.query.download === '1');
    if (method === 'GET' && p === '/api/assets/settings') return send(res,{ok:true, dir:defaultAssetLibraryDir(cfg), can_manage:!!local});
    if (method === 'POST' && p === '/api/assets/settings') { const body=await readBody(req); return send(res, assetSettings(body, local, cfg)); }
    if (method === 'POST' && p === '/api/assets/groups/create') { const body=await readBody(req); return send(res, assetCreateGroup(body, local, cfg, deviceOwner)); }
    if (method === 'POST' && p === '/api/assets/groups/rename') { const body=await readBody(req); return send(res, assetRenameGroup(body, local, cfg, deviceOwner)); }
    if (method === 'POST' && p === '/api/assets/groups/delete') { const body=await readBody(req); return send(res, assetDeleteGroup(body, local, cfg, deviceOwner)); }
    if (method === 'POST' && p === '/api/assets/upload') { const body=await readBody(req); return send(res, assetUpload(body, local, cfg, deviceOwner)); }
    if (method === 'POST' && p === '/api/assets/delete') { const body=await readBody(req); return send(res, assetDelete(body, local, cfg, deviceOwner)); }
    if (method === 'POST' && p === '/api/assets/rename') { const body=await readBody(req); return send(res, assetRename(body, local, cfg, deviceOwner)); }
    if (method === 'POST' && p === '/api/assets/update') { const body=await readBody(req); return send(res, assetUpdate(body, local, cfg, deviceOwner)); }
    if (method === 'POST' && p === '/api/assets/move') { const body=await readBody(req); return send(res, assetMove(body, local, cfg, deviceOwner)); }
    if (method === 'POST' && p === '/api/assets/copy_source') { const body=await readBody(req); return send(res, await assetCopySource(body, local, cfg, deviceOwner)); }
    if (method === 'POST' && p === '/api/assets/share') { const body=await readBody(req); return send(res, assetShare(body, local, cfg, deviceOwner, true)); }
    if (method === 'POST' && p === '/api/assets/unshare') { const body=await readBody(req); return send(res, assetShare(body, local, cfg, deviceOwner, false)); }
    if (method === 'POST' && p === '/api/assets/export_zip') { const body=await readBody(req); const zipPath=assetExportZip(body, local, cfg, deviceOwner); return send(res,{ok:true,url:`/download?path=${encodeURIComponent(zipPath)}`}); }
    if (method === 'GET' && p === '/api/announcements') return send(res, await getAnnouncements(parsed.query.force === '1'));
    if (method === 'GET' && p === '/api/status') { cleanupStaleImageTasksThrottled(deviceOwner); return send(res, { ...appStats(deviceOwner), time_info: getNetworkTimeInfo(), ...hostCumulativeStats(), ...urls(cfg), is_local_client: local, is_public_client: publicHost, device_data_isolation: cfg.device_data_isolation !== false, host_status_visible: true }); }
    if (method === 'GET' && p === '/api/batches') {
      const pageSize = Math.max(1, Math.min(local ? 6000 : 1000, Number(parsed.query.limit || (local ? 6000 : 1000))));
      return send(res, listBatches({ownerId:dataOwner, page:1, pageSize}).rows.map(normalizeBatch));
    }
    if (method === 'GET' && p === '/api/history_batches') {
      const scopedOwner = local && parsed.query.all_owners === '1' ? '' : dataOwner;
      const imageRows = listBatches({ownerId: scopedOwner, page: 1, pageSize: local ? 6000 : 1000}).rows.map(b => ({ ...normalizeBatch(b), batch_type:'image' }));
      const videoRows = listVideoBatchSummaries(scopedOwner);
      return send(res, [...imageRows, ...videoRows].sort((a,b)=>String(b.created_at || '').localeCompare(String(a.created_at || ''))));
    }
    if (method === 'POST' && p === '/api/batches') {
      const body = await readBody(req);
      // V13.2：局域网/公网访问端不使用主机端保存的 API Key；必须使用当前设备自己填写的 API Key。
      if (!local && !String(body.api_key || '').trim()) throw new Error('访问端请先填写本设备自己的 API Key，不能使用主机端保存的 API Key');
      const mapped = mapPayloadToQueue(body, deviceOwner); const ret = queue.createBatch(mapped.payload, mapped.cfg);
      return send(res, {ok:true, id:ret.id, name:ret.name, task_count:ret.taskCount, output_dir:ret.outputDir});
    }
    if (method === 'POST' && p === '/api/stop_batch') { const body=await readBody(req); const b=getDB()._store.batches.find(x=>x.id===body.batch_id && (!owner || x.owner_id===owner)); if(!b) throw new Error('无权限或批次不存在'); queue.stopBatch(body.batch_id); return send(res,{ok:true}); }
    if (method === 'POST' && p === '/api/delete_batch') { const body=await readBody(req); return send(res, deleteBatch(body.batch_id, owner)); }
    if (method === 'POST' && p === '/api/repeat_batch') { const body=await readBody(req); const ret=await repeatBatch(body.batch_id, owner, deviceOwner, body); return send(res,{ok:true, id:ret.id, task_count:ret.taskCount}); }
    if (method === 'POST' && p === '/api/update_batch_note') { const body=await readBody(req); const b=getDB()._store.batches.find(x=>x.id===body.batch_id && (!owner || x.owner_id===owner)); if(!b) throw new Error('无权限或批次不存在'); b.note=body.note||''; b.updated_at=nowISO(); getDB()._save(); return send(res,{ok:true}); }
    if (method === 'GET' && p === '/api/images') {
      const hasBatchFilter = !!String(parsed.query.batch_id || '');
      const fastRequested = String(parsed.query.fast || '') === '1';
      const forceRepair = String(parsed.query.repair || '') === '1';
      const shouldRepair = forceRepair || (!fastRequested && dataOwner && Date.now() - lastMidjourneyImageRepairAt > 5 * 60 * 1000);
      if (shouldRepair) { lastMidjourneyImageRepairAt = Date.now(); await repairCompletedMidjourneyImages(dataOwner || ''); }
      const defaultImageLimit = hasBatchFilter ? (local ? 6000 : 1000) : 300;
      const page = Math.max(1, Number(parsed.query.page || 1));
      const pageSize = Math.max(1, Math.min(local ? 6000 : 1000, Number(parsed.query.limit || parsed.query.page_size || defaultImageLimit)));
      const imagePageResult = listImages({ownerId:dataOwner, batchId: parsed.query.batch_id || '', page, pageSize});
      let rows = imagePageResult.rows;
      if (String(parsed.query.panel_only || '') === '1') rows = rows.filter(r => !r.hidden_in_recent || (!fastRequested && r.file_path && fs.existsSync(r.file_path)));
      if (String(parsed.query.only_mj || '') === '1') rows = rows.filter(r => (r.mj_source || '') === 'midjourney');
      const seenImageKeys = new Set();
      const gridByTask = new Map();
      rows.forEach(r => { if (r.mj_is_grid) gridByTask.set(r.task_id || '', normalizeMjRemoteUrl(r.remote_url || r.result_url || '')); });
      rows = rows.filter(r => {
        const remoteKey = normalizeMjRemoteUrl(r.remote_url || r.result_url || '');
        if (!r.mj_is_grid && remoteKey && gridByTask.get(r.task_id || '') === remoteKey) return false;
        const key = [r.batch_id || '', r.task_id || '', r.mj_is_grid ? 'grid' : `v${Number(r.mj_variant_index || 0) || 0}`, remoteKey || r.file_path || r.id || ''].join('|');
        if (seenImageKeys.has(key)) return false;
        seenImageKeys.add(key);
        return true;
      });
      rows = rows.slice(0, pageSize);
      warmLocalHotCacheForImageRows(rows, { preloadFull:page === 1 && !hasBatchFilter });
      const fastFormat = fastRequested || (String(parsed.query.panel_only || '') === '1' && !String(parsed.query.batch_id || ''));
      const formattedRows = rows.map(row => formatImage(row, { fast: fastFormat }));
      if (String(parsed.query.meta || '') === '1') {
        return send(res, { ok:true, rows:formattedRows, total:imagePageResult.total, page, page_size:pageSize, has_more:page * pageSize < imagePageResult.total });
      }
      return send(res, formattedRows);
    }
    if (method === 'GET' && p === '/api/media_cache_status') {
      const ret = mediaCacheStatus(req, parsed);
      return send(res, ret, ret.status || 200);
    }
    if (method === 'POST' && p === '/api/delete_images') { const body=await readBody(req); return send(res, deleteImages(body.image_ids || [], owner)); }
    if (method === 'POST' && p === '/api/clear_all_cache') {
      if (!local) return send(res, {ok:false,error:'只有主机端可以清除所有数据'}, 403);
      const body = await readBody(req);
      return send(res, await clearAllSoftwareData(body.confirm_text || ''));
    }
    if (method === 'GET' && p === '/api/logs') {
      const pageSize = Math.max(20, Math.min(300, Number(parsed.query.limit || parsed.query.page_size || 120)));
      return send(res, listLogs({ownerId:dataOwner, page:1, pageSize}));
    }
    if (method === 'GET' && p === '/api/export_zip') { const zipPath=exportZip(parsed.query.batch_id, owner); return send(res,{ok:true,url:`/download?path=${encodeURIComponent(zipPath)}`}); }
    if (method === 'POST' && p === '/api/export_selected_zip') { const body=await readBody(req); const zipPath=exportZip(body.batch_id, owner, body.image_ids||[]); return send(res,{ok:true,url:`/download?path=${encodeURIComponent(zipPath)}`}); }
    if (method === 'POST' && p === '/api/export_batches_zip') { const body=await readBody(req); const zipPath=exportBatchesZip(body.batch_ids||[], owner); return send(res,{ok:true,url:`/download?path=${encodeURIComponent(zipPath)}`}); }
    if (method === 'GET' && p === '/api/mj_describe_batch') { return send(res, describeBatchRows(String(parsed.query.batch_id || ''), owner)); }
    if (method === 'POST' && p === '/api/export_describe_word') { const body=await readBody(req); const docPath=exportDescribeWord(body.batch_id || '', owner); return send(res,{ok:true,url:`/download?path=${encodeURIComponent(docPath)}`}); }
    if (method === 'POST' && p === '/api/export_describe_xlsx') { const body=await readBody(req); const xlsxPath=exportDescribeXlsx(body.batch_id || '', owner); return send(res,{ok:true,url:`/download?path=${encodeURIComponent(xlsxPath)}`}); }
    if (method === 'GET' && p === '/api/chat_models') {
      const catalog = getApimartChatModels(cfg.apimart_proxy_url || '');
      return send(res, {ok:true, ...catalog, endpoint:'/v1/chat/completions'});
    }
    if (method === 'GET' && p === '/api/chat_history') return send(res, await readChatHistory(deviceOwner, cfg));
    if (method === 'POST' && p === '/api/chat_history') {
      const body = await readBody(req);
      return send(res, await writeChatHistory(deviceOwner, body, cfg));
    }
    if (method === 'GET' && p === '/api/output_media_index_status') return send(res, {ok:true, ...outputMediaIndexState});
    if (method === 'POST' && p === '/api/reindex_output_media') {
      if (!local) return send(res, {ok:false,error:'只有主机端可以重新索引输出目录'}, 403);
      setImmediate(() => indexOutputMediaFromConfiguredDir({ force:true }).catch(()=>{}));
      return send(res, {ok:true, started:!outputMediaIndexState.running, ...outputMediaIndexState});
    }
    if (method === 'POST' && p === '/api/chat_completions_stream') {
      const body = await readBody(req);
      if (!local && !String(body.api_key || '').trim()) throw new Error('访问端请先填写本设备自己的 API Key，不能使用主机端 API Key');
      const chatMessagesWithLinks = await appendChatAttachmentLinks(body.messages || [], body.attachments || [], cfg, deviceOwner, req);
      await streamChatCompletionsToClient(res, {
        baseUrl: body.api_endpoint || cfg.api_endpoint,
        apiKey: body.api_key || (local ? cfg.api_key : ''),
        model: body.model || cfg.chat_model || 'gpt-5.5',
        messages: chatMessagesWithLinks,
        options: body.options || {},
        proxyUrl: body.apimart_proxy_url || cfg.apimart_proxy_url || ''
      });
      return;
    }
    if (method === 'POST' && p === '/api/chat_completions') {
      const body = await readBody(req);
      if (!local && !String(body.api_key || '').trim()) throw new Error('访问端请先填写本设备自己的 API Key，不能使用主机端 API Key');
      const chatMessagesWithLinks = await appendChatAttachmentLinks(body.messages || [], body.attachments || [], cfg, deviceOwner, req);
      const ret = await chatCompletion({
        baseUrl: body.api_endpoint || cfg.api_endpoint,
        apiKey: body.api_key || (local ? cfg.api_key : ''),
        model: body.model || cfg.chat_model || 'gpt-5.5',
        messages: chatMessagesWithLinks,
        stream: !!body.stream,
        options: body.options || {}
      });
      if (!ret.content) addLog(`AI聊天接口已返回，但未解析到文本内容。endpoint=${ret.endpoint} model=${ret.model}`, { ownerId: deviceOwner, level: 'warn' });
      // 不把 raw JSON 返回给前端，避免聊天气泡显示整段接口响应。调试请看实时日志。
      return send(res, {ok:true, response:{content: ret.content || '', endpoint: ret.endpoint, model: ret.model}, content: ret.content || '接口已返回，但没有解析到文本回复。请查看实时日志中的 APIMart Chat Completions 原始结构。'});
    }
    if (method === 'POST' && p === '/api/video_submit') { const body=await readBody(req); if(String(body.video_platform||'').toLowerCase()==='flow2api'){const ret=await createFlow2VideoBatch({...body,prompts:body.prompt||body.prompts,copies:1},deviceOwner);return send(res,{ok:true,task:ret.rows[0]||null});} const row = await createApimartVideoTask(body, deviceOwner, req, cfg); return send(res,{ok:true, task:formatVideoTask(row)}); }
    if (method === 'POST' && p === '/api/video_batch_submit') { const body=await readBody(req); return send(res, String(body.video_platform||'').toLowerCase()==='flow2api' ? await createFlow2VideoBatch(body, deviceOwner) : await createApimartVideoBatch(body, deviceOwner, req, cfg)); }
    if (method === 'GET' && p === '/api/video_tasks') { const scopedOwner = local && parsed.query.all_owners === '1' ? '' : dataOwner; cleanupStaleVideoTasks(scopedOwner); const st=ensureVideoStore(); const allOwners = !scopedOwner; const pageSize = Math.max(1, Math.min(local ? 5000 : 500, Number(parsed.query.limit || parsed.query.page_size || (local ? 1200 : 500)))); const rawRows=st.video_tasks.filter(v=>!scopedOwner || v.owner_id===scopedOwner).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,pageSize); const rows=rawRows.map(row=>formatVideoTask(row, { allOwners, fast:true })); return send(res,{ok:true, rows, video_stats: videoTodayStats(scopedOwner), scope: scopedOwner ? 'device' : 'all_owners'}); }
    if (method === 'POST' && p === '/api/video_delete_selected') { const body=await readBody(req); const scopedOwner = local && body.all_owners === true ? '' : owner; return send(res, deleteVideoTasks(body.ids || [], scopedOwner)); }
    if (method === 'POST' && p === '/api/video_export_selected') { const body=await readBody(req); const scopedOwner = local && body.all_owners === true ? '' : owner; const zipPath=exportSelectedVideos(body.ids || [], scopedOwner); return send(res,{ok:true,url:`/download?path=${encodeURIComponent(zipPath)}`}); }
    if (method === 'POST' && p === '/api/video_cache_touch') {
      const body = await readBody(req);
      const scopedOwner = local && body.all_owners === true ? '' : owner;
      const ids = Array.from(new Set((body.ids || []).filter(Boolean))).slice(0, 24);
      const rows = ids.map(id => findVideoTaskById(id, scopedOwner)).filter(v => v && v.file_path);
      rows.forEach(v => scheduleLocalHotMedia(v.file_path));
      return send(res, { ok:true, queued:rows.length });
    }
    if (method === 'POST' && p === '/api/video_copy_file') {
      if (!local) return send(res,{ok:false,error:'远程访问端无法直接复制主机上的视频文件，请使用下载按钮。'},403);
      const body = await readBody(req);
      const t = findVideoTaskById(body.id || '', local && body.all_owners === true ? '' : owner);
      if (!t) throw new Error('视频任务不存在或无权限');
      if (!t.file_path) throw new Error('视频还没有保存到本地，无法复制文件。');
      await copyVideoFileToSystemClipboard(t.file_path);
      return send(res,{ok:true, file_path:t.file_path, filename:path.basename(t.file_path)});
    }
    if (method === 'GET' && p === '/api/mj_describe_recent') {
      const limit = Math.max(1, Math.min(30, Number(parsed.query.limit || 30)));
      const st = getDB()._store;
      const tasks = st.tasks
        .filter(t => (!dataOwner || t.owner_id === dataOwner) && t.mj_source === 'midjourney' && t.mj_action === 'describe')
        .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))
        .slice(0, limit)
        .map(t => {
          let refs = [], texts = [];
          try { refs = JSON.parse(t.ref_images_json || '[]') || []; } catch {}
          try { texts = JSON.parse(t.mj_text_outputs_json || '[]') || []; } catch {}
          const batch = st.batches.find(b=>b.id===t.batch_id) || {};
          return {
            id: t.id,
            task_id: t.remote_task_id || '',
            local_task_id: t.id,
            batch_id: t.batch_id,
            batch_name: batch.note || batch.name || '',
            status: t.status || '',
            progress: Number(t.progress || 0),
            created_at: t.created_at || '',
            updated_at: t.updated_at || '',
            prompt: t.prompt || '',
            text_outputs: texts,
            thumb_url: refs[0]?.thumb_path ? `/file?path=${encodeURIComponent(refs[0].thumb_path)}` : '',
            full_url: refs[0]?.file_path ? `/file?path=${encodeURIComponent(refs[0].file_path)}` : '',
            raw: safeJsonParse(t.mj_query_raw_json || '{}', {})
          };
        });
      return send(res, { ok:true, rows:tasks });
    }
    if (method === 'POST' && p === '/api/mj_submit') { const body=await readBody(req); return send(res, await submitMidjourneyAction(body, owner || deviceOwner)); }
    if (method === 'POST' && p === '/api/mj_upscale_jump') { return send(res, { ok:false, error:'mj_upscale_jump is disabled; jump image opens existing image_urls directly.' }, 410); }
    if (method === 'GET' && p === '/api/mj_task') {
      if (String(parsed.query.api_key || '').trim()) return send(res, {ok:false,error:'请使用 POST 查询 MJ 任务，避免 API Key 出现在链接中'}, 405);
      return send(res, await queryMidjourneyTask({ task_id: parsed.query.task_id || '', api_key: local ? cfg.api_key || '' : '' }));
    }
    if (method === 'POST' && p === '/api/mj_task') { const body=await readBody(req); return send(res, await queryMidjourneyTask(body)); }
    if (method === 'POST' && p === '/api/grsai_tool') {
      const body=await readBody(req); const ret = await grsaiTool({baseUrl: body.api_endpoint || cfg.api_endpoint, apiKey: body.api_key || (local ? cfg.api_key : ''), action: body.action, model: body.model || cfg.model, extra: body.body || {}, queryApiKey: body.target_api_key || ''});
      return send(res,{ok:true, action:body.action, response:ret});
    }
    return send(res, {ok:false,error:'接口不存在'}, 404);
  } catch (e) {
    const code = Number(e && (e.statusCode || e.code)) === 413 ? 413 : 500;
    return send(res, {ok:false,error:e.message || String(e)}, code);
  }
}
function requestHandler(req, res) {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname.startsWith('/api/')) return apiHandler(req,res,parsed);
  if (parsed.pathname === '/video-share') {
    // V13.2：用于公网分享的视频直链，不要求公网访问密码；只凭视频任务 id 访问本地已保存的视频文件。
    const id = parsed.query.id || '';
    const t = findVideoTaskById(id, '');
    if (!t || !t.file_path) return sendText(res, 'video not found', 'text/plain', 404);
    return streamVideoFile(t.file_path, req, res, false);
  }
  if (parsed.pathname === '/video-file') {
    const cfg = readConfig();
    const local = isLocalReq(req);
    const publicHost = isPublicHost(req, cfg);
    if (!local && publicHost && !hasPublicAccess(req, parsed, cfg)) return sendText(res, 'public access denied', 'text/plain', 403);
    if (!local && publicHost && !cfg.public_enabled) return sendText(res, 'public access disabled', 'text/plain', 403);
    if (!local && !publicHost && !cfg.lan_enabled) return sendText(res, 'lan access disabled', 'text/plain', 403);
    const accessOwner = getOwner(req, parsed, cfg);
    const owner = (local && parsed.query.all_owners === '1') || cfg.device_data_isolation === false ? '' : accessOwner;
    const id = parsed.query.id || '';
    const t = findVideoTaskById(id, owner);
    if (!t || !t.file_path) return sendText(res, 'video task not found', 'text/plain', 404);
    if (parsed.query.preview === '1') {
      const cachedPath = localHotMediaCachePath(t.file_path);
      if (fs.existsSync(cachedPath)) return streamVideoFile(cachedPath, req, res, false, { trustedLocal:true });
    }
    return streamVideoFile(t.file_path, req, res, false, { previewOnly: parsed.query.preview === '1' });
  }
  if (parsed.pathname.startsWith('/public-video/') || parsed.pathname.startsWith('/public-file/')) {
    const isPublicFile = parsed.pathname.startsWith('/public-file/');
    // 给 APIMart/AI 聊天探测附件时使用：不要求登录 cookie，但临时链接 2 小时后自动失效。
    const parts = parsed.pathname.split('/').filter(Boolean);
    const token = parts[1] || '';
    let file = '';
    const cleanId = path.basename(token, path.extname(token));
    try {
      const st = ensureVideoStore();
      const hit = (st.public_videos || []).find(v => v.id === cleanId && v.active !== false && !isPublicTempExpired(v));
      if (hit) file = hit.path;
    } catch {}
    if (!file || !isAllowedServedFile(file, readConfig()) || !fs.existsSync(file)) return sendText(res, 'not found or expired', 'text/plain', 404);
    const ext = path.extname(file).toLowerCase();
    if (!isPublicFile && !['.mp4','.mov','.webm','.m4v'].includes(ext)) return sendText(res, 'unsupported video type', 'text/plain', 400);
    const stat = fs.statSync(file);
    if (stat.size > 100 * 1024 * 1024) return sendText(res, 'file too large', 'text/plain', 413);
    const total = stat.size;
    const type = contentType(file) || (isPublicFile ? 'application/octet-stream' : 'video/mp4');
    const range = req.headers.range;
    const cleanName = `${cleanId || 'reference'}${ext}`;
    const baseHeaders = {...BASE_SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': total, 'Accept-Ranges':'bytes', 'Access-Control-Allow-Origin':'*', 'Cache-Control':'public, max-age=7200', 'Content-Disposition': `inline; filename="${cleanName}"`};
    if (req.method === 'HEAD') { res.writeHead(200, baseHeaders); return res.end(); }
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start <= end && start < total) {
          res.writeHead(206, {...BASE_SECURITY_HEADERS, 'Content-Type':type,'Content-Range':`bytes ${start}-${end}/${total}`,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*'});
          return fs.createReadStream(file,{start,end}).pipe(res);
        }
      }
    }
    res.writeHead(200, baseHeaders); return fs.createReadStream(file).pipe(res);
  }
  if (parsed.pathname === '/preview-image') {
    servePreviewImage(req, res, parsed);
    return;
  }
  if (parsed.pathname === '/file' || parsed.pathname === '/download') {
    serveFileRequest(req, res, parsed);
    return;
  }
  const file = safeJoinStatic(parsed.pathname);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendText(res, 'not found', 'text/plain', 404);
  res.writeHead(200, {...BASE_SECURITY_HEADERS, 'Content-Type': contentType(file)}); fs.createReadStream(file).pipe(res);
}
function startServer(port, retryCount = 0) {
  const desiredPort = Number(port || readConfig().port || 7861);
  currentPort = desiredPort;
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
  server = http.createServer(requestHandler);
  server.on('error', (err) => {
    const code = err && err.code;
    addLog(`WebUI server start failed on port ${currentPort}: ${err.message}`, {ownerId:'local', level:'error'});
    if ((code === 'EADDRINUSE' || code === 'EACCES') && retryCount < 20) {
      const nextPort = currentPort + 1;
      addLog(`端口 ${currentPort} 被占用，自动尝试端口 ${nextPort}`, {ownerId:'local'});
      setTimeout(()=>startServer(nextPort, retryCount + 1), 250);
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      const html = `<html><body style="font-family:system-ui;padding:28px;background:#111827;color:#fff"><h2>WebUI 启动失败</h2><p>端口 ${currentPort} 无法启动：${String(err.message||err)}</p><p>请关闭旧版本程序，或到设置中心修改端口后重新打开。</p></body></html>`;
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(()=>{});
    }
  });
  server.listen(currentPort, '0.0.0.0', () => {
    saveConfig({port:Number(currentPort || 7861)});
    addLog(`Desktop WebUI server started on http://127.0.0.1:${currentPort}`, {ownerId:'local'});
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
    const chatCatalogTimer = setTimeout(() => refreshApimartChatModels(readConfig().apimart_proxy_url || '').catch(()=>{}), 1200);
    if (typeof chatCatalogTimer.unref === 'function') chatCatalogTimer.unref();
  });
}

function resolveImageInfoFromSrc(src) {
  const info = { filePath: '', remoteUrl: '', prompt: '', displayUrl: src || '' };
  if (!src) return info;
  try {
    if (src.startsWith('data:image/')) { info.filePath = src; return info; }
    const u = new URL(src, `http://127.0.0.1:${currentPort || 7861}`);
    if (u.pathname === '/file' || u.pathname === '/download') {
      const fp = u.searchParams.get('path') || '';
      const img = getDB()._store.images.find(x => x.file_path === fp || x.thumb_path === fp);
      if (img) {
        info.filePath = img.file_path || fp;
        info.remoteUrl = img.remote_url || img.result_url || '';
        const task = getDB()._store.tasks.find(t => t.id === img.task_id) || {};
        info.prompt = task.prompt || '';
      } else if (fp && fs.existsSync(fp)) {
        info.filePath = fp;
      }
    } else if (u.protocol === 'file:') {
      const fp = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (fs.existsSync(fp)) info.filePath = fp;
    } else if (/^https?:/i.test(src)) {
      info.remoteUrl = src;
    }
  } catch {}
  return info;
}
function localPathFromImageSrc(src) {
  return resolveImageInfoFromSrc(src).filePath || '';
}
async function servePreviewImage(req, res, parsed) {
  try {
    const cfg = readConfig();
    const local = isLocalReq(req);
    const publicHost = isPublicHost(req, cfg);
    if (!local && publicHost && !hasPublicAccess(req, parsed, cfg)) return sendText(res, 'public access denied', 'text/plain', 403);
    if (!local && publicHost && !cfg.public_enabled) return sendText(res, 'public access disabled', 'text/plain', 403);
    if (!local && !publicHost && !cfg.lan_enabled) return sendText(res, 'lan access disabled', 'text/plain', 403);
    let file = '';
    try { file = resolveServedFilePath(parsed.query.path || '', cfg); }
    catch { return sendText(res, 'file access denied', 'text/plain', 403); }
    if (!file || !fs.existsSync(file)) return sendText(res, 'not found', 'text/plain', 404);
    if (!/^image\//i.test(contentType(file))) return sendText(res, 'not an image', 'text/plain', 415);
    const maxDim = clampPreviewImageMaxDim(parsed.query.max);
    const previewPath = await ensurePreviewImage(file, maxDim);
    const stat = fs.statSync(previewPath);
    const headers = {
      ...BASE_SECURITY_HEADERS,
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=604800'
    };
    if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
    res.writeHead(200, headers);
    return fs.createReadStream(previewPath).pipe(res);
  } catch (e) {
    addLog('预览图后台处理失败：' + (e.message || e), { ownerId:'local', level:'warn' });
    return sendText(res, e.message || 'preview image failed', 'text/plain', 500);
  }
}
async function sendDiskFile(req, res, file, opts = {}) {
  const stat = opts.stat || await fs.promises.stat(file);
  const headers = {
    ...BASE_SECURITY_HEADERS,
    'Content-Type': opts.type || contentType(file),
    'Content-Length': stat.size,
    'Access-Control-Allow-Origin':'*',
    'Cache-Control':'public, max-age=86400'
  };
  if (opts.download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(opts.filename || path.basename(file))}`;
  if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
  res.writeHead(200, headers);
  return fs.createReadStream(file).pipe(res);
}
async function serveFileRequest(req, res, parsed) {
  const cfg = readConfig();
  const local = isLocalReq(req);
  const publicHost = isPublicHost(req, cfg);
  if (!local && publicHost && !hasPublicAccess(req, parsed, cfg)) return sendText(res, 'public access denied', 'text/plain', 403);
  if (!local && publicHost && !cfg.public_enabled) return sendText(res, 'public access disabled', 'text/plain', 403);
  if (!local && !publicHost && !cfg.lan_enabled) return sendText(res, 'lan access disabled', 'text/plain', 403);
  let file = '';
  try {
    const rawPath = parsed.query.path || '';
    const maybeType = contentType(normalizeServedPathInput(rawPath));
    if (parsed.pathname !== '/download' && /^image\//i.test(maybeType)) file = resolveMediaCachePath(rawPath, cfg);
    else file = resolveServedFilePath(rawPath, cfg);
  }
  catch { return sendText(res, 'file access denied', 'text/plain', 403); }
  const type = contentType(file);
  if (parsed.pathname !== '/download' && /^image\//i.test(type)) {
    const cachedPath = localHotMediaCachePath(file);
    if (fs.existsSync(cachedPath)) {
      fs.utimes(cachedPath, new Date(), new Date(), ()=>{});
      return sendDiskFile(req, res, cachedPath, { download:false, filename:path.basename(file), type });
    }
  }
  if (/^video\//i.test(type)) return streamVideoFile(file, req, res, parsed.pathname === '/download');
  let sourceStat = null;
  try { sourceStat = await fs.promises.stat(file); } catch { return sendText(res, 'not found', 'text/plain', 404); }
  let servePath = file;
  if (parsed.pathname !== '/download' && shouldHotCacheMedia(file, sourceStat, type)) {
    const cachedPath = localHotMediaCachePath(file);
    if (fs.existsSync(cachedPath)) {
      servePath = cachedPath;
      fs.utimes(cachedPath, new Date(), new Date(), ()=>{});
    } else {
      const promise = ensureLocalHotMedia(file, sourceStat, type).catch(()=> '');
      const waitMs = hotCacheAwaitMs(file, sourceStat);
      if (waitMs > 0) {
        const ready = await Promise.race([promise, new Promise(resolve => setTimeout(()=>resolve(''), waitMs))]);
        if (ready && fs.existsSync(ready)) servePath = ready;
      }
    }
  }
  return sendDiskFile(req, res, servePath, { download: parsed.pathname === '/download', filename:path.basename(file), type, stat: servePath === file ? sourceStat : null });
}
function mediaCacheStatus(req, parsed) {
  const cfg = readConfig();
  const local = isLocalReq(req);
  const publicHost = isPublicHost(req, cfg);
  if (!local && publicHost && !hasPublicAccess(req, parsed, cfg)) return { ok:false, error:'public access denied', status:403 };
  if (!local && publicHost && !cfg.public_enabled) return { ok:false, error:'public access disabled', status:403 };
  if (!local && !publicHost && !cfg.lan_enabled) return { ok:false, error:'lan access disabled', status:403 };
  let file = '';
  try { file = resolveMediaCachePath(parsed.query.path || '', cfg); }
  catch { return { ok:false, error:'file access denied', status:403 }; }
  const type = contentType(file);
  if (!/^image\//i.test(type)) return { ok:false, error:'not an image', status:415 };
  const cachedPath = localHotMediaCachePath(file);
  if (fs.existsSync(cachedPath)) {
    fs.utimes(cachedPath, new Date(), new Date(), ()=>{});
    return { ok:true, ready:true, url:`/file?path=${encodeURIComponent(file)}`, cached_path:cachedPath };
  }
  scheduleLocalHotMedia(file);
  return { ok:true, ready:false, url:`/file?path=${encodeURIComponent(file)}` };
}
function setupImageContextMenu(win) {
  win.webContents.on('context-menu', (event, params) => {
    if (!params.srcURL) return;
    const imgSrc = params.srcURL;
    const info = resolveImageInfoFromSrc(imgSrc);
    const template = [{
      label: '复制该图片（原图）',
      click: async () => {
        try {
          let img = null;
          const localPath = info.filePath || localPathFromImageSrc(imgSrc);
          if (localPath && localPath.startsWith('data:image/')) img = nativeImage.createFromDataURL(localPath);
          else if (localPath) img = nativeImage.createFromPath(localPath);
          else if (/^https?:\/\//i.test(info.remoteUrl || imgSrc)) {
            const r = await fetch(info.remoteUrl || imgSrc);
            const b = Buffer.from(await r.arrayBuffer());
            img = nativeImage.createFromBuffer(b);
          }
          if (!img || img.isEmpty()) throw new Error('图片读取失败');
          clipboard.writeImage(img);
          if (win && !win.isDestroyed()) win.webContents.executeJavaScript("window.__copyImageToast && window.__copyImageToast('原图已复制到剪贴板')").catch(()=>{});
        } catch (e) {
          if (win && !win.isDestroyed()) win.webContents.executeJavaScript("window.__copyImageToast && window.__copyImageToast('复制失败：" + String(e.message || e).replace(/'/g, "\'") + "')").catch(()=>{});
        }
      }
    }, {
      label: '复制图片链接（返回 url）',
      click: () => {
        try {
          const link = info.remoteUrl || imgSrc;
          clipboard.writeText(link);
          if (win && !win.isDestroyed()) win.webContents.executeJavaScript("window.__copyImageToast && window.__copyImageToast('图片链接已复制')").catch(()=>{});
        } catch {}
      }
    }, {
      label: '复制提示词',
      click: () => {
        try {
          clipboard.writeText(info.prompt || '');
          if (win && !win.isDestroyed()) win.webContents.executeJavaScript("window.__copyImageToast && window.__copyImageToast('提示词已复制')").catch(()=>{});
        } catch {}
      }
    }, { type:'separator' }, { label:'在新窗口打开原图', click:()=>{ try { shell.openExternal(info.remoteUrl || imgSrc); } catch {} } }];
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}


ipcMain.on('start-image-drag', (event, payload = {}) => {
  try {
    const info = resolveImageInfoFromSrc(payload.fullUrl || payload.url || '');
    const filePath = info.filePath;
    if (!filePath || filePath.startsWith('data:image/') || !fs.existsSync(filePath)) return;
    event.sender.startDrag({ file: filePath, icon: filePath });
  } catch {}
});

function createWindow() {
  const cfg = readConfig();
  mainWindow = new BrowserWindow({
    width: 1480, height: 960, minWidth: 1180, minHeight: 760,
    title: (cfg.app_name || APP_DISPLAY_NAME),
    icon: path.join(__dirname, '..', 'assets', 'rocket.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: true, allowRunningInsecureContent: false, preload: path.join(__dirname, 'preload.js') }
  });
  setupImageContextMenu(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(String(target || ''))) shell.openExternal(target).catch(()=>{});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    try {
      const u = new URL(target);
      const allowedHosts = new Set(['127.0.0.1', 'localhost', getLocalIP()]);
      if (!allowedHosts.has(String(u.hostname || '').toLowerCase())) {
        event.preventDefault();
        if (/^https?:$/i.test(u.protocol)) shell.openExternal(target).catch(()=>{});
      }
    } catch {}
  });
  mainWindow.on('close', event => {
    if (isAppQuitting) return;
    event.preventDefault();
    hideMainWindowToTray();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}
// V14.1: 不再使用全局单实例锁。不同版本使用不同 appId，可与旧版本同时打开；端口被占用时会自动顺延。
app.whenReady().then(() => {
  hardResetDataDirsBeforeInit();
  initConfig();
  const restoredOutputMirror = restoreStoreFromOutputMirrorIfCurrentEmpty();
  const restoredLegacyStore = restoredOutputMirror ? false : restoreStoreFromLegacyIfCurrentEmpty();
  if (!restoredLegacyStore) rememberHistoricalOutputRootsFromStoreFile(path.join(DATA_ROOT, 'data', 'store.json'));
  initDB(app.getPath('userData'));
  repairLegacyGeminiOmniVideoFailures();
  cleanupStaleImageTasks('');
  mirrorRuntimeDataToOutputDir();
  scheduleOutputMediaIndex();
  const mirrorTimer = setInterval(() => mirrorRuntimeDataToOutputDir(), 60 * 1000);
  if (typeof mirrorTimer.unref === 'function') mirrorTimer.unref();
  if (restoredOutputMirror) addLog(`检测到当前任务库为空，已自动从输出目录 ${OUTPUT_RUNTIME_DATA_DIR_NAME} 恢复程序缓存。`, { level:'warn' });
  if (restoredLegacyStore) addLog('检测到更新后当前任务库为空，已自动从历史 RuntimeData 恢复批次、任务、图片和视频任务。', { level:'warn' });
  startNetworkTimeSync();
  queue = new TaskQueue();
  queue.recoverInterruptedBatches();
  if (!SERVER_ONLY) {
    createWindow();
    createTray();
    registerConfiguredOpenAppShortcut();
  }
  startServer(Number(readConfig().port || 7861));
  const startupPublicCfg = readConfig();
  if (startupPublicCfg.public_enabled && (startupPublicCfg.public_provider || 'cloudflare') !== 'manual') {
    const tunnelRestoreTimer = setTimeout(() => {
      const latest = readConfig();
      startTunnelProcess({
        provider:latest.public_provider || 'cloudflare',
        public_password:latest.public_password || '',
        public_permission:latest.public_permission || 'generate'
      });
    }, 1800);
    if (typeof tunnelRestoreTimer.unref === 'function') tunnelRestoreTimer.unref();
  }
});
app.on('window-all-closed', () => { if (!SERVER_ONLY && process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (SERVER_ONLY) return;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  bringMainWindowToFront();
});
app.on('before-quit', () => { isAppQuitting = true; try { if (queue && typeof queue.clearAllRunning === 'function') queue.clearAllRunning(); } catch {} try { const db = getDB(); if (db && typeof db._flushSync === 'function') db._flushSync(); } catch {} try { mirrorRuntimeDataToOutputDir(); } catch {} try { stopTunnelProcess({ preserveConfig:true }); } catch {} try { if (server) server.close(); } catch {} });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} activeOpenAppShortcut = ''; try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch {} tray = null; });
