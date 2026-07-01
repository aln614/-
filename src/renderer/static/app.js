const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
let mainImages = [];
let refImages = [];
let batches = [];
let historyBatches = [];
let selectedImages = new Set();
let selectedHistoryBatches = new Set();
let currentImageBatch = '';
let currentBatchFilter = 'all';
let previewScale = 1;
const PREVIEW_MIN_SCALE = 0.001; // V8.8: 取消固定缩放限制，仅保留 0.1% 安全下限避免图片完全消失
const PREVIEW_MAX_SCALE = Number.POSITIVE_INFINITY; // V8.8: 不限制放大上限
let lastMiniImagesSignature = '';
let refreshAllInFlight = false;
let refreshAllQueued = false;
let lastLogsLoadAt = 0;
let previewX = 0;
let previewY = 0;
let previewFitScale = 1;
let previewNaturalWidth = 0;
let previewNaturalHeight = 0;
let previewDragging = false;
let previewStart = {x:0,y:0,px:0,py:0};
let isLocalClient = true;
let isPublicClient = false;
let isInlineNoteEditing = false;
let wakeLock = null;
let keepAliveTimer = null;
let chatMessages = [];
let chatImages = [];
let imageMetaMap = new Map();
let chatCardPlaceholder = null;
let currentPreviewMeta = {};
const PREVIEW_BG_STORAGE_KEY = 'LAIG_PREVIEW_BG_SETTINGS';
let previewBgSettings = { color:'black', opacity:0 };
let softwareUpdateInfo = null;
let softwareUpdateBusy = false;
let softwareUpdateModalVisible = false;
let softwareUpdatePollTimer = null;
const mjRegionState = { meta:null, button:null, drawing:false, erase:false, brushSize:42, zoom:1, fitScale:1, panX:0, panY:0, panning:false, panPointerId:null, panStartX:0, panStartY:0, panOriginX:0, panOriginY:0, spacePressed:false, cursorVisible:false, submitting:false, undoStack:[], redoStack:[], strokeChanged:false };

function normalizeAnnouncementItems(items=[], opts={}){
  const arr = Array.isArray(items) ? items : [];
  return arr.map((it,idx)=>({ title:String(it?.title||'').trim(), content:String(it?.content||'').trim(), tag:String(it?.tag||'自定义').trim() || '自定义', _id:String(it?._id || `ann_${Date.now()}_${idx}`) })).filter(it=>opts.keepEmpty || it.title || it.content);
}
function getAnnouncementEditorItemsFromDom(){
  return Array.from(document.querySelectorAll('#announcementCustomList .announcement-item-card')).map((card, idx)=>({
    _id: card.dataset.annId || `ann_${idx}`,
    title: card.querySelector('[data-ann-field="title"]')?.value?.trim() || '',
    tag: card.querySelector('[data-ann-field="tag"]')?.value?.trim() || '自定义',
    content: card.querySelector('[data-ann-field="content"]')?.value || ''
  })).filter(it=>it.title || it.content);
}
function renderAnnouncementCustomEditor(items=[]){
  const box = $('#announcementCustomList');
  if(!box) return;
  const rows = normalizeAnnouncementItems(items, {keepEmpty:true});
  if(!rows.length){
    box.innerHTML = '<div class="announcement-empty-card">暂无自定义公告，点击“新增一条自定义公告”。</div>';
    return;
  }
  box.innerHTML = rows.map((it,idx)=>`<div class="announcement-item-card" data-ann-id="${escapeHtml(it._id || `ann_${idx}`)}"><div class="announcement-item-head"><strong>公告 ${idx+1}</strong><button class="danger" type="button" data-remove-announcement="${escapeHtml(it._id || `ann_${idx}`)}">删除此条</button></div><div class="row"><div><label>公告标题</label><input data-ann-field="title" value="${escapeHtml(it.title||'')}" placeholder="例如：内部通知 / 操作说明" /></div><div><label>公告标签</label><input data-ann-field="tag" value="${escapeHtml(it.tag||'自定义')}" placeholder="自定义" /></div></div><div><label>公告内容</label><textarea data-ann-field="content" placeholder="这里填写公告内容，保存后会显示在顶部公告弹窗最上方。">${escapeHtml(it.content||'')}</textarea></div></div>`).join('');
}
let chatConversations = [];
let currentChatId = '';
let chatModelCatalog = [];
let chatContextFullscreen = false;
let chatThinkingTimer = null;
let chatThinkingStart = 0;
let aiOrbDragging = false;
let aiOrbDrag = {sx:0, sy:0, sl:0, st:0};
const CHAT_CONFIG_KEY = 'local_api_image_generator_chat_config_v1498';
const CHAT_HISTORY_KEY = 'local_api_image_generator_chat_conversations_v1498';
const CHAT_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const CLIENT_CONFIG_KEY = 'local_api_image_generator_client_config_v1498';
const CURRENT_SETTINGS_KEY = 'LAIG_CLIENT_SETTINGS_V1';
const PUBLIC_ACCESS_KEY = 'local_api_image_generator_public_access_v1498';
const urlParams = new URLSearchParams(location.search);
function rememberPublicAccess(token, days = 7){
  const expiresAt = Date.now() + Number(days || 7) * 24 * 60 * 60 * 1000;
  localStorage.setItem(PUBLIC_ACCESS_KEY, JSON.stringify({token, expiresAt}));
  // 图片标签、下载链接、右键复制图片不会自动带自定义 Header，所以公网访问密码也写入 Cookie。
  // Cookie 只在当前公网域名下有效，默认记住 7 天。
  document.cookie = `local_api_public_access=${encodeURIComponent(token)}; Max-Age=${Math.max(1, Number(days || 7)) * 24 * 60 * 60}; Path=/; SameSite=Lax`;
}
if(urlParams.get('access')) rememberPublicAccess(urlParams.get('access'), 7);
function getPublicAccess(){
  const fromUrl = urlParams.get('access');
  if(fromUrl) return fromUrl;
  try{
    const raw = JSON.parse(localStorage.getItem(PUBLIC_ACCESS_KEY) || '{}');
    if(raw.token && Number(raw.expiresAt || 0) > Date.now()) return raw.token;
    if(raw.token) localStorage.removeItem(PUBLIC_ACCESS_KEY);
  }catch(e){
    const old = localStorage.getItem(PUBLIC_ACCESS_KEY);
    if(old && old[0] !== '{') return old;
  }
  return '';
}
function clearPublicAccess(){ localStorage.removeItem(PUBLIC_ACCESS_KEY); document.cookie='local_api_public_access=; Max-Age=0; Path=/; SameSite=Lax'; }


function updateApiKeyWarning(){
  const keyEl = $('#apiKey');
  const warn = $('#apiKeyWarning');
  const startBtn = $('#startBatchBtn');
  if(!keyEl || !warn) return;
  const empty = !String(keyEl.value || '').trim();
  warn.classList.toggle('show', empty);
  if(startBtn){
    startBtn.disabled = empty;
    startBtn.classList.toggle('disabled', empty);
    startBtn.title = empty ? 'API Key 未填写，不能开始生成新批次' : '';
  }
}

function getClientId(){
  let id = localStorage.getItem('LAIG_ASSET_CLIENT_ID') || localStorage.getItem('local_api_image_generator_client_id_v1498');
  if(!id){
    id = 'client_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  localStorage.setItem('LAIG_ASSET_CLIENT_ID', id);
  localStorage.setItem('local_api_image_generator_client_id_v1498', id);
  return id;
}

async function api(path, opts = {}) {
  opts = {...opts};
  const cid = getClientId();
  opts.headers = {...(opts.headers || {}), 'X-Client-Id': cid, 'X-LAIG-Client-ID': cid, 'X-Public-Access': getPublicAccess()};
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg).error || msg; } catch(e) {}
    throw new Error(msg);
  }
  const data = await res.json();
  if(data && data.ok === false) throw new Error(data.error || '操作失败');
  return data;
}

function bindSoftwareUpdateModal(modal){
  if(!modal || modal.dataset.bound === '1') return modal;
  modal.dataset.bound = '1';
  modal.addEventListener('click', e=>{ if(e.target === modal) closeSoftwareUpdateModal(); });
  modal.querySelector('#softwareUpdateModalCloseBtn')?.addEventListener('click', closeSoftwareUpdateModal);
  modal.querySelector('#softwareUpdateModalInstallBtn')?.addEventListener('click', ()=>applySoftwareUpdateOta());
  return modal;
}
function ensureSoftwareUpdateModal(){
  let modal = $('#softwareUpdateModal');
  if(modal) return bindSoftwareUpdateModal(modal);
  modal = document.createElement('div');
  modal.id = 'softwareUpdateModal';
  modal.className = 'modal software-update-modal';
  modal.innerHTML = `<div class="software-update-dialog glass-modal"><div class="software-update-head"><div><h2 id="softwareUpdateModalTitle">版本更新</h2><div class="software-update-sub" id="softwareUpdateModalSub">检查更新后会在这里显示新版本内容。</div></div><div class="software-update-badge" id="softwareUpdateBadge">-</div></div><div class="software-update-body"><div class="software-update-line"><span>当前版本</span><b id="softwareUpdateCurrentVersion">-</b></div><div class="software-update-line"><span>最新版本</span><b id="softwareUpdateLatestVersion">-</b></div><div class="software-update-line"><span>Release</span><a id="softwareUpdateReleaseUrl" href="#" target="_blank" rel="noreferrer">-</a></div><div class="software-update-line"><span>EXE</span><b id="softwareUpdateAssetName">-</b></div><div class="software-update-notes" id="softwareUpdateNotes">暂无更新内容。</div></div><div class="software-update-actions"><button class="secondary" id="softwareUpdateModalCloseBtn" type="button">关闭</button><button class="danger" id="softwareUpdateModalInstallBtn" type="button">立即更新</button></div></div>`;
  document.body.appendChild(modal);
  return bindSoftwareUpdateModal(modal);
}
function openSoftwareUpdateModal(){
  const modal = ensureSoftwareUpdateModal();
  modal.classList.add('active');
  modal.setAttribute('aria-hidden','false');
  softwareUpdateModalVisible = true;
}
function closeSoftwareUpdateModal(){
  const modal = $('#softwareUpdateModal');
  modal?.classList.remove('active');
  modal?.setAttribute('aria-hidden','true');
  softwareUpdateModalVisible = false;
}
function softwareVersionCompare(a='', b=''){
  const pa = String(a || '').replace(/^v/i,'').split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b || '').replace(/^v/i,'').split(/[^\d]+/).filter(Boolean).map(Number);
  for(let i = 0; i < Math.max(pa.length, pb.length); i++){
    const da = pa[i] || 0, db = pb[i] || 0;
    if(da > db) return 1;
    if(da < db) return -1;
  }
  return 0;
}
function normalizeSoftwareUpdateInfo(info = null){
  if(!info) return null;
  const current = info.current_version || info.currentVersion || '';
  const latest = info.latest_version || info.latestVersion || '';
  const versionHasUpdate = current && latest ? softwareVersionCompare(latest, current) > 0 : !!info.has_update;
  const assetUrl = info.asset_url || info.assetUrl || '';
  return {
    ...info,
    current_version: current,
    latest_version: latest,
    has_update: versionHasUpdate,
    update_ready: versionHasUpdate && !!assetUrl && info.update_status !== 'waiting_asset',
    asset_url: assetUrl
  };
}
function renderSoftwareUpdateModal(info = null){
  const modal = ensureSoftwareUpdateModal();
  info = normalizeSoftwareUpdateInfo(info);
  const has = !!info?.has_update;
  const current = $('#softwareUpdateCurrentVersion');
  const latest = $('#softwareUpdateLatestVersion');
  const release = $('#softwareUpdateReleaseUrl');
  const asset = $('#softwareUpdateAssetName');
  const notes = $('#softwareUpdateNotes');
  const badge = $('#softwareUpdateBadge');
  const sub = $('#softwareUpdateModalSub');
  if(current) current.textContent = info?.current_version || '-';
  if(latest) latest.textContent = info?.latest_version || '-';
  if(release){
    const url = info?.release_url || '';
    release.textContent = url || '-';
    release.href = url || '#';
    release.classList.toggle('muted-link', !url);
  }
  if(asset) asset.textContent = info?.asset_name || '未找到 .exe 资产';
  if(notes) notes.innerHTML = info?.notes ? escapeHtml(String(info.notes).slice(0, 3000)).replace(/\n/g, '<br>') : '暂无更新内容。';
  const ready = !!(has && info?.asset_url && info?.update_status !== 'waiting_asset');
  const runtime = info?.update_runtime || info?.runtime || null;
  const runtimeFailed = runtime?.state === 'failed';
  if(asset) asset.textContent = info?.asset_name || (has ? '安装包未就绪，等待 GitHub Actions 上传 EXE' : '-');
  if(badge) badge.textContent = info ? (has ? (runtimeFailed ? '更新失败' : (ready ? '发现新版本' : '构建中')) : '当前最新') : '-';
  if(sub) sub.textContent = runtime?.message || info?.message || (info ? (has ? (ready ? '检测到新版本，确认后即可直接下载并原地更新。' : '检测到新版本，但安装包还未上传完成，请稍后再检查。') : '当前软件已经是最新版本。') : '检查更新后会在这里显示新版本内容。');
  const updateBtn = $('#softwareUpdateModalInstallBtn');
  if(updateBtn){
    updateBtn.disabled = (softwareUpdateBusy && !runtimeFailed) || !ready;
    const progress = Number(runtime?.progress || 0);
    const state = runtime?.state || '';
    updateBtn.textContent = runtimeFailed ? '重新更新' : (softwareUpdateBusy ? (progress ? `下载中 ${progress}%` : (state === 'installing' ? '正在安装...' : '正在更新...')) : (has ? (ready ? '立即更新' : '等待安装包') : '已是最新版本'));
    updateBtn.classList.toggle('loading', softwareUpdateBusy && !runtimeFailed);
  }
}
function renderSoftwareUpdateInfo(info = null){
  if(!info){
    renderSoftwareUpdateModal(null);
    return;
  }
  renderSoftwareUpdateModal(info);
}
function renderSoftwareUpdateError(message){
  const info = {
    current_version: softwareUpdateInfo?.current_version || '-',
    latest_version: softwareUpdateInfo?.latest_version || '-',
    release_url: softwareUpdateInfo?.release_url || '',
    asset_name: softwareUpdateInfo?.asset_name || '',
    notes: message || '检查更新失败',
    has_update: false
  };
  renderSoftwareUpdateModal(info);
  openSoftwareUpdateModal();
}
async function checkSoftwareUpdate(){
  const repo = softwareUpdateInfo?.repo || '';
  try{
    const btn = $('#checkUpdateBtn');
    if(btn) btn.disabled = true;
    const info = await api('/api/update/check', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repo})});
    softwareUpdateInfo = info;
    renderSoftwareUpdateInfo(info);
    openSoftwareUpdateModal();
    toast(info.has_update ? '发现新版本' : '当前已是最新版本');
  }catch(e){
    softwareUpdateInfo = null;
    renderSoftwareUpdateError(e.message || '检查更新失败');
    openSoftwareUpdateModal();
    toast(e.message || '检查更新失败');
  }
  finally{ const btn = $('#checkUpdateBtn'); if(btn) btn.disabled = false; }
}
function stopSoftwareUpdatePolling(){
  if(softwareUpdatePollTimer){
    clearInterval(softwareUpdatePollTimer);
    softwareUpdatePollTimer = null;
  }
}
async function pollSoftwareUpdateStatus(){
  try{
    const status = await api('/api/update/status');
    const base = softwareUpdateInfo || status.last_check || {};
    softwareUpdateInfo = { ...base, update_runtime:status, runtime:status };
    softwareUpdateBusy = ['queued','downloading','downloaded','installing'].includes(status.state);
    renderSoftwareUpdateInfo(softwareUpdateInfo);
    if(status.state === 'failed'){
      stopSoftwareUpdatePolling();
      softwareUpdateBusy = false;
      renderSoftwareUpdateInfo(softwareUpdateInfo);
      toast(status.message || '更新失败');
    }else if(!softwareUpdateBusy){
      stopSoftwareUpdatePolling();
    }
  }catch(e){
    stopSoftwareUpdatePolling();
    softwareUpdateBusy = false;
    renderSoftwareUpdateError(e.message || '读取更新状态失败');
  }
}
function startSoftwareUpdatePolling(){
  stopSoftwareUpdatePolling();
  softwareUpdatePollTimer = setInterval(pollSoftwareUpdateStatus, 2000);
  pollSoftwareUpdateStatus();
}
async function applySoftwareUpdateOta(){
  const repo = softwareUpdateInfo?.repo || '';
  try{
    softwareUpdateInfo = normalizeSoftwareUpdateInfo(softwareUpdateInfo);
    if(!softwareUpdateInfo?.has_update || !softwareUpdateInfo?.asset_url || softwareUpdateInfo?.update_status === 'waiting_asset'){
      toast('安装包还未就绪，请稍后重新检查更新');
      renderSoftwareUpdateInfo(softwareUpdateInfo);
      return;
    }
    softwareUpdateBusy = true;
    $('#checkUpdateBtn')?.toggleAttribute('disabled', true);
    renderSoftwareUpdateInfo(softwareUpdateInfo);
    const info = await api('/api/update/apply_latest', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repo})});
    softwareUpdateInfo = { ...info, update_runtime:info.update_runtime || info.runtime || null };
    renderSoftwareUpdateInfo(softwareUpdateInfo);
    openSoftwareUpdateModal();
    toast(info.message || '更新已开始，下载完成后会自动替换并重启');
    startSoftwareUpdatePolling();
  }catch(e){
    softwareUpdateBusy = false;
    softwareUpdateInfo = null;
    renderSoftwareUpdateError(e.message || 'OTA 更新失败');
    openSoftwareUpdateModal();
    toast(e.message || 'OTA 更新失败');
  }finally{
    $('#checkUpdateBtn')?.toggleAttribute('disabled', false);
  }
}
function withPublicAccess(url){
  if(!url || /^data:/i.test(url) || /^blob:/i.test(url)) return url;
  try{
    const u = new URL(url, location.href);
    const needsLocalParams = (u.pathname === '/file' || u.pathname === '/download' || u.pathname === '/video-file' || u.pathname === '/api/assets/source');
    if(needsLocalParams){
      // V12.9：公网/局域网都和 API 请求一样携带设备ID，保证图片/视频数据隔离下也能正确预览。
      if(!u.searchParams.get('client_id')) u.searchParams.set('client_id', getClientId());
      const token = getPublicAccess();
      if(token && !u.searchParams.get('access')) u.searchParams.set('access', token);
    }
    return u.pathname + u.search + u.hash;
  }catch(e){ return url; }
}
function isPromptMultilineTasksEnabled(){
  const el = $('#promptMultilineTasks');
  return !!(el && el.checked === true);
}

async function copyTextSmart(text, label='内容'){
  const value = String(text || '');
  try{
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(value);
      return true;
    }
  }catch(e){}
  try{
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly','');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if(ok) return true;
  }catch(e){}
  window.prompt('请手动复制' + label, value);
  return false;
}
async function tryExecCommandCopyImage(src){
  return new Promise((resolve)=>{
    const box = document.createElement('div');
    box.contentEditable = 'true';
    box.style.position = 'fixed';
    box.style.left = '-10000px';
    box.style.top = '0';
    box.style.width = '1px';
    box.style.height = '1px';
    box.style.overflow = 'hidden';
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try{
        box.appendChild(img);
        document.body.appendChild(box);
        const range = document.createRange();
        range.selectNode(img);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = document.execCommand('copy');
        sel.removeAllRanges();
        box.remove();
        resolve(!!ok);
      }catch(e){ try{ box.remove(); }catch(_){} resolve(false); }
    };
    img.onerror = () => { try{ box.remove(); }catch(_){} resolve(false); };
    img.src = src;
  });
}
function assetSourceHeaders(){
  const cid = getClientId();
  return {'X-Public-Access':getPublicAccess(), 'X-Client-Id':cid, 'X-LAIG-Client-ID':cid};
}
async function imageBlobAsPng(blob){
  if(String(blob?.type || '').toLowerCase() === 'image/png') return blob;
  const objectUrl = URL.createObjectURL(blob);
  try{
    const img = await new Promise((resolve,reject)=>{
      const el = new Image();
      el.onload = ()=>resolve(el);
      el.onerror = ()=>reject(new Error('图片解码失败'));
      el.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, img.naturalWidth || img.width || 1);
    canvas.height = Math.max(1, img.naturalHeight || img.height || 1);
    canvas.getContext('2d').drawImage(img, 0, 0);
    return await new Promise((resolve,reject)=>canvas.toBlob(v=>v?resolve(v):reject(new Error('PNG 转换失败')), 'image/png'));
  }finally{ URL.revokeObjectURL(objectUrl); }
}
async function copyImageFromUrl(url){
  const src = withPublicAccess(url);
  const res = await fetch(src, {headers:assetSourceHeaders()});
  if(!res.ok) throw new Error('图片读取失败：' + res.status);
  const blob = await res.blob();
  if(navigator.clipboard && window.ClipboardItem){
    try{
      const png = await imageBlobAsPng(blob);
      await navigator.clipboard.write([new ClipboardItem({'image/png': png})]);
      return 'image';
    }catch(e){}
  }
  const objectUrl = URL.createObjectURL(blob);
  try{
    const ok = await tryExecCommandCopyImage(objectUrl);
    if(ok) return 'image';
  }finally{
    setTimeout(()=>URL.revokeObjectURL(objectUrl), 5000);
  }
  await copyTextSmart(src, '图片链接');
  return 'link';
}

function isLanClient(){ return !isLocalClient && !isPublicClient; }
function originalImageUrlFromMeta(meta = {}){ return meta.fullUrl || meta.url || meta.originalUrl || ''; }
async function imageUrlToDataItem(url, fallbackName='generated-image.png'){
  const src = withPublicAccess(url);
  const res = await fetch(src, {headers:assetSourceHeaders()});
  if(!res.ok) throw new Error('原图读取失败：' + res.status);
  const blob = await res.blob();
  const name = decodeURIComponent((new URL(src, location.href).searchParams.get('path') || '').split(/[\\/]/).pop() || fallbackName || 'generated-image.png');
  return await new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = () => resolve({name, type:blob.type || 'image/png', size:blob.size || 0, data:reader.result});
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
function setImageDragData(e, meta = {}){
  if(e && e.__originalImageDragHandled) return;
  if(e) e.__originalImageDragHandled = true;
  const fullUrl = originalImageUrlFromMeta(meta);
  if(!fullUrl) return;
  const payload = JSON.stringify({fullUrl, remoteUrl:meta.remoteUrl || '', prompt:meta.prompt || '', name:meta.filename || 'generated-image.png'});
  try{ e.dataTransfer.setData('application/x-local-generated-image', payload); }catch{}
  try{ e.dataTransfer.setData('text/uri-list', withPublicAccess(meta.remoteUrl || fullUrl)); }catch{}
  try{ e.dataTransfer.setData('text/plain', withPublicAccess(meta.remoteUrl || fullUrl)); }catch{}
  try{
    const url = withPublicAccess(meta.remoteUrl || fullUrl);
    const filename = meta.filename || 'generated-image.png';
    e.dataTransfer.setData('DownloadURL', `image/png:${filename}:${new URL(url, location.href).href}`);
  }catch{}
  try{ e.dataTransfer.effectAllowed = 'copy'; }catch{}
  // 桌面 EXE 环境：外部拖到文件夹/PS 等，直接由 Electron 把原图文件作为系统拖拽文件抛出去。
  if(meta.skipNativeDrag !== true){
    try{ window.electronAPI?.startImageDrag?.({fullUrl, remoteUrl:meta.remoteUrl || '', name:meta.filename || 'generated-image.png'}); }catch{}
  }
  toast('拖动中：将使用原图');
}
function getDraggedGeneratedImage(dt){
  try{
    const raw = dt.getData('application/x-local-generated-image');
    if(raw) return JSON.parse(raw);
  }catch{}
  return null;
}
function showDragOriginalBadge(e){
  let b = $('#dragOriginalBadge');
  if(!b){ b = document.createElement('div'); b.id = 'dragOriginalBadge'; b.className = 'drag-original-badge'; b.textContent = '拖动中：将使用原图'; document.body.appendChild(b); }
  b.style.left = (e.clientX || 0) + 'px';
  b.style.top = (e.clientY || 0) + 'px';
}
function hideDragOriginalBadge(){ $('#dragOriginalBadge')?.remove(); }
function findGeneratedThumbMetaFromElement(el){
  if(!el) return null;
  const card = el.closest?.('.image-card');
  if(card){
    const id = card.dataset.id;
    return imageMetaMap.get(id) || {fullUrl:card.dataset.url || card.querySelector('[data-full-url]')?.dataset.fullUrl || '', filename:card.querySelector('.cap')?.textContent || 'generated-image.png'};
  }
  const thumb = el.closest?.('[data-full-url]');
  if(thumb){
    const id = thumb.dataset.id;
    return imageMetaMap.get(id) || {fullUrl:thumb.dataset.fullUrl || thumb.src || '', filename:thumb.dataset.name || 'generated-image.png'};
  }
  return null;
}
// V8.0：所有生成缩略图统一支持拖动；右侧最近图片、图片管理、预览图都走同一套原图拖拽。
document.addEventListener('dragstart', e=>{
  const meta = findGeneratedThumbMetaFromElement(e.target);
  if(!meta || !originalImageUrlFromMeta(meta)) return;
  setImageDragData(e, meta);
  showDragOriginalBadge(e);
}, true);
document.addEventListener('dragover', e=>{ if($('#dragOriginalBadge')) showDragOriginalBadge(e); }, true);
document.addEventListener('dragend', hideDragOriginalBadge, true);
document.addEventListener('drop', hideDragOriginalBadge, true);
async function handleGeneratedImageDrop(e, target){
  const payload = getDraggedGeneratedImage(e.dataTransfer);
  if(!payload || !payload.fullUrl) return false;
  e.preventDefault();
  const item = await imageUrlToDataItem(payload.fullUrl, payload.name || 'generated-image.png');
  if(target === 'chat'){
    chatImages.push(item);
    renderChatAttachments();
    saveChatConfig();
  }else if(target === 'main'){
    mainImages.push(item); renderThumbs(); calcEstimate();
  }else{
    refImages.push(item); renderThumbs(); calcEstimate();
  }
  toast(target === 'main' ? '已作为主图加入（原图）' : target === 'ref' ? '已作为参考图加入（原图）' : '已加入聊天附件（原图）');
  return true;
}

function escapeHtml(str='') { return String(str).replace(/[&<>'"]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[s])); }
function percent(b){ return b.task_count ? Math.round(((b.success_count + b.fail_count) / b.task_count) * 100) : 0; }
function statusClass(s){ if(s==='已完成') return 'ok'; if(['生成中','提交生成中','等待中'].includes(s)) return 'run'; return 'warn'; }

function parseBatchTimeToMs(v){
  if(!v) return 0;
  const s = String(v).trim();
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}
function parseUTCDisplayDate(v){
  if(!v) return null;
  const s = String(v).trim();
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}
function formatBeijingTime(v){
  const d = parseUTCDisplayDate(v);
  if(!d) return v || '';
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2,'0');
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth()+1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(bj.getUTCSeconds())}`;
}
function videoBeijingDayInfo(v){
  const raw = v.created_at || v.finished_at || v.updated_at || '';
  const d = parseUTCDisplayDate(raw);
  const pad = n => String(n).padStart(2,'0');
  if(!d) return { key:'unknown', title:'未知日期' };
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const key = `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth()+1)}-${pad(bj.getUTCDate())}`;
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const todayKey = `${today.getUTCFullYear()}-${pad(today.getUTCMonth()+1)}-${pad(today.getUTCDate())}`;
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = `${yesterday.getUTCFullYear()}-${pad(yesterday.getUTCMonth()+1)}-${pad(yesterday.getUTCDate())}`;
  const title = key === todayKey ? `今天 ${key}` : (key === yesterdayKey ? `昨天 ${key}` : key);
  return { key, title };
}
function groupVideosByBeijingDay(rows){
  const map = new Map();
  for(const v of rows){
    const info = videoBeijingDayInfo(v);
    if(!map.has(info.key)) map.set(info.key, { ...info, rows:[] });
    map.get(info.key).rows.push(v);
  }
  return [...map.values()].sort((a,b)=>String(b.key).localeCompare(String(a.key)));
}
function batchDurationInfo(b){
  const start = parseBatchTimeToMs(b.created_at);
  const finish = parseBatchTimeToMs(b.finished_at);
  const running = ['等待中','提交生成中','生成中','下载中'].includes(String(b.status||''));
  const base = running ? Date.now() : (finish || parseBatchTimeToMs(b.updated_at) || Date.now());
  const sec = Math.max(0, (base - (start || base)) / 1000);
  const label = running ? '生成中' : (String(b.status||'').includes('失败') ? '失败' : '耗时');
  return {label, sec, running, start, finish};
}
function formatMiniElapsed(createdAt){
  const start = parseBatchTimeToMs(createdAt);
  if(!start) return '0.0秒';
  const sec = Math.max(0, (Date.now() - start) / 1000);
  if(sec < 60) return `${sec.toFixed(1)}秒`;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if(h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function updateMiniTaskElapsedBadges(){
  $$('.mini-task-elapsed').forEach(el=>{
    const createdAt = el.dataset.createdAt || '';
    el.textContent = formatMiniElapsed(createdAt);
  });
}

function batchDurationMarkup(b){
  const d = batchDurationInfo(b);
  return `<span class="batch-duration" data-status="${escapeHtml(b.status||'')}" data-start="${d.start||''}" data-finish="${d.finish||''}">${d.label} / ${d.sec.toFixed(1)} 秒</span>`;
}
function updateBatchDurationBadges(){
  $$('.batch-duration').forEach(el=>{
    const status = el.dataset.status || '';
    const start = Number(el.dataset.start || 0);
    if(!start) return;
    const running = ['等待中','提交生成中','生成中','下载中'].includes(status);
    const finish = Number(el.dataset.finish || 0);
    const end = running ? Date.now() : (finish || Date.now());
    const label = running ? '生成中' : (status.includes('失败') ? '失败' : '耗时');
    el.textContent = `${label} / ${Math.max(0,(end-start)/1000).toFixed(1)} 秒`;
  });
}
setInterval(updateBatchDurationBadges, 250);
setInterval(updateMiniTaskElapsedBadges, 250);
function toast(msg){ const t=$('#toast'); if(!t) return; t.textContent=msg; t.classList.add('show'); clearTimeout(toast._timer); toast._timer=setTimeout(()=>t.classList.remove('show'),2600); }
window.__copyImageToast = toast;

function normalizeImagePlatformValue(platform='apimart'){
  const p = String(platform || '').toLowerCase();
  return (p === 'legacy' || p === 'grsai' || p === 'flow2api') ? 'flow2api' : 'apimart';
}
const IMAGE_PLATFORM_CONFIG_PREFIX = CLIENT_CONFIG_KEY + '_image_platform_';
const IMAGE_PLATFORM_ACTIVE_KEY = CLIENT_CONFIG_KEY + '_active_image_platform';
const APIMART_MODEL_OPTIONS = [
  ['gemini-3.1-flash-image-preview','Gemini-3.1-Flash-Image-preview（Nano banana2）'],
  ['gemini-3.1-flash-image-preview-official','Gemini-3.1-Flash-Image-preview 官方'],
  ['gemini-3-pro-image-preview','Gemini-3-Pro-Image-preview（Nano banana Pro）'],
  ['gemini-3-pro-image-preview-official','Gemini-3-Pro-Image-preview 官方'],
  ['gemini-2.5-flash-image-preview','Gemini-2.5-Flash-Image-preview（Nano banana）'],
  ['gemini-2.5-flash-image-preview-official','Gemini-2.5-Flash-Image-preview 官方'],
  ['imagen-4.0-apimart','Imagen-4.0'],
  ['gpt-image-1-official','GPT-Image-1 Official'],
  ['gpt-image-1.5-official','GPT-Image-1.5 Official'],
  ['gpt-image-2','GPT-Image-2'],
  ['gpt-image-2-official','GPT-Image-2 Official'],
  ['doubao-seedance-4-0','doubao-seedance-4-0 / Seedream-4.0'],
  ['seedream-4.5','Seedream-4.5'],
  ['doubao-seedream-5-0-lite','doubao-seedream-5-0-lite'],
  ['qwen-image-2.0','Qwen Image 2.0'],
  ['z-image-turbo','Z-Image-Turbo'],
  ['grok-imagine-1.5-apimart','grok-imagine-1.5-apimart'],
  ['grok-imagine-1.5-edit-apimart','grok-imagine-1.5-edit-apimart'],
  ['wan2.7-image','wan2.7-image'],
  ['wan2.7-image-pro','wan2.7-image-pro']
];
const FLOW2API_MODEL_OPTIONS = [
  ['gemini-3.0-pro-image','Nano Banana Pro（gemini-3.0-pro-image）'],
  ['gemini-3.1-flash-image','Nano Banana 2（gemini-3.1-flash-image）']
];
function normalizeFlow2ApiBaseModel(model=''){
  const value = String(model || '').trim().toLowerCase();
  if(value.startsWith('gemini-3.0-pro-image')) return 'gemini-3.0-pro-image';
  if(value.startsWith('gemini-3.1-flash-image')) return 'gemini-3.1-flash-image';
  return 'gemini-3.1-flash-image';
}
function platformConfigKey(platform='apimart'){ return IMAGE_PLATFORM_CONFIG_PREFIX + normalizeImagePlatformValue(platform); }
function loadLegacyClientConfig(){ try{ return JSON.parse(localStorage.getItem(CLIENT_CONFIG_KEY) || '{}'); }catch(e){ return {}; } }
function readClientSettings(){
  try{ return JSON.parse(localStorage.getItem(CURRENT_SETTINGS_KEY) || '{}') || {}; }catch(e){ return {}; }
}
function collectMjCurrentSettings(){
  const fields = {};
  document.querySelectorAll('#mjFormContainer [data-mj-field]').forEach(el=>{
    const name = el.dataset.mjField;
    if(!name || el.type === 'file') return;
    fields[name] = el.type === 'checkbox' ? !!el.checked : (el.value || '');
  });
  return { tab: mjState?.tab || 'imagine', fields };
}
function saveCurrentClientSettings(cfg = {}){
  const existing = readClientSettings();
  const allowed = ['image_api_platform','api_endpoint','legacy_api_endpoint','api_key','model','size','clarity','quality','background','moderation','output_format','output_compression','image_n','theme_mode','concurrency','retry_times','repeat_count','poll_interval_ms','timeout_seconds','background_keepalive','prompt_multiline_tasks'];
  const next = { ...existing };
  allowed.forEach(k=>{ if(typeof cfg[k] !== 'undefined') next[k] = cfg[k]; });
  const mj = cfg.mj_settings || collectMjCurrentSettings();
  if(mj && mj.tab){
    next.mj_tab = mj.tab;
    next.mj_settings = { ...(existing.mj_settings || {}), by_tab:{ ...((existing.mj_settings || {}).by_tab || {}), [mj.tab]: mj.fields || {} } };
  }
  localStorage.setItem(CURRENT_SETTINGS_KEY, JSON.stringify(next));
  return next;
}
function mergeClientSettings(serverCfg = {}){
  const localCfg = readClientSettings();
  const merged = { ...serverCfg, ...localCfg };
  if(localCfg.api_key) merged.api_key = localCfg.api_key;
  return merged;
}
function loadClientConfig(platform=''){
  const p = platform ? normalizeImagePlatformValue(platform) : (localStorage.getItem(IMAGE_PLATFORM_ACTIVE_KEY) || 'apimart');
  try{ return JSON.parse(localStorage.getItem(platformConfigKey(p)) || '{}'); }catch(e){ return {}; }
}
function saveClientConfig(cfg){
  const p = normalizeImagePlatformValue(cfg.image_api_platform || currentImagePlatform());
  const safeCfg = sanitizePlatformEndpoint(cfg || {}, p);
  localStorage.setItem(IMAGE_PLATFORM_ACTIVE_KEY, p);
  const allowed = ['image_api_platform','api_endpoint','legacy_api_endpoint','api_key','model','size','clarity','quality','background','moderation','output_format','output_compression','image_n','mask_url','theme_mode','concurrency','retry_times','repeat_count','poll_interval_ms','timeout_seconds','background_keepalive','prompt_multiline_tasks'];
  const cleaned = { image_api_platform:p };
  allowed.forEach(k => { if(typeof safeCfg[k] !== 'undefined') cleaned[k] = safeCfg[k]; });
  localStorage.setItem(platformConfigKey(p), JSON.stringify(cleaned));
  saveCurrentClientSettings(cleaned);
  // 兼容旧读取：只保存当前激活平台名，不再把两个平台配置混到同一个对象里。
  localStorage.setItem(CLIENT_CONFIG_KEY, JSON.stringify({ image_api_platform:p }));
}
function platformDefaultApiEndpoint(platform='apimart'){
  return normalizeImagePlatformValue(platform) === 'flow2api' ? 'http://127.0.0.1:38000' : 'https://api.apimart.ai';
}
function isFlow2ApiEndpoint(v=''){ return /(?:127\.0\.0\.1|localhost):38000/i.test(String(v || '')); }
function isGrsAIEndpoint(v=''){ return /grsaiapi\.com|grsai\.dakka\.com\.cn/i.test(String(v || '')); }
function isApimartEndpoint(v=''){ return /api\.apimart\.ai|apimart\.ai/i.test(String(v || '')); }
function sanitizePlatformEndpoint(cfg = {}, platform='apimart'){
  const p = normalizeImagePlatformValue(platform || cfg.image_api_platform);
  const out = { ...(cfg || {}), image_api_platform:p };
  const current = String(out.api_endpoint || '').trim();
  // 平台切换时 API 地址必须跟随当前平台，但允许每个平台保存自己的自定义地址。
  // 只在发现明显串台时强制恢复当前平台默认地址。
  if(!current) out.api_endpoint = platformDefaultApiEndpoint(p);
  else if(p === 'flow2api' && (isApimartEndpoint(current) || isGrsAIEndpoint(current))) out.api_endpoint = platformDefaultApiEndpoint('flow2api');
  else if(p === 'apimart' && (isGrsAIEndpoint(current) || isFlow2ApiEndpoint(current))) out.api_endpoint = platformDefaultApiEndpoint('apimart');
  if(p === 'flow2api') out.legacy_api_endpoint = out.api_endpoint || platformDefaultApiEndpoint('flow2api');
  return out;
}
function defaultPlatformConfig(platform='apimart'){
  const p = normalizeImagePlatformValue(platform);
  return p === 'flow2api'
    ? { image_api_platform:'flow2api', api_endpoint:platformDefaultApiEndpoint('flow2api'), legacy_api_endpoint:platformDefaultApiEndpoint('flow2api'), api_key:'', model:'gemini-3.1-flash-image', size:'16:9', clarity:'1K', image_n:1, quality:'auto', background:'auto', moderation:'auto', output_format:'png', output_compression:90 }
    : { image_api_platform:'apimart', api_endpoint:platformDefaultApiEndpoint('apimart'), api_key:'', model:'gemini-3.1-flash-image-preview', size:'auto', clarity:'1K', image_n:1, quality:'auto', background:'auto', moderation:'auto', output_format:'png', output_compression:90 };
}
let apimartSizeOptionsHtml = '';
let apimartClarityOptionsHtml = '';
function rebuildImageParameterOptions(platform='apimart'){
  const size = $('#size');
  const clarity = $('#clarity');
  if(!size || !clarity) return;
  if(!apimartSizeOptionsHtml) apimartSizeOptionsHtml = size.innerHTML;
  if(!apimartClarityOptionsHtml) apimartClarityOptionsHtml = clarity.innerHTML;
  if(normalizeImagePlatformValue(platform) === 'flow2api'){
    size.innerHTML = '<option value="16:9">16:9 横屏</option><option value="4:3">4:3 横图</option><option value="1:1">1:1 方图</option><option value="3:4">3:4 竖图</option><option value="9:16">9:16 竖屏</option>';
    clarity.innerHTML = '<option value="1K">1K 标准</option><option value="2K">2K 高清</option><option value="4K">4K 超清</option>';
  }else{
    size.innerHTML = apimartSizeOptionsHtml;
    clarity.innerHTML = apimartClarityOptionsHtml;
  }
}
function currentImagePlatform(){ return normalizeImagePlatformValue($('#imageApiPlatformSwitch .platform-btn.active')?.dataset?.platform || localStorage.getItem(IMAGE_PLATFORM_ACTIVE_KEY) || 'apimart'); }
function rebuildModelPresetOptions(platform='apimart'){
  const p = normalizeImagePlatformValue(platform);
  const select = $('#modelPreset');
  if(!select) return;
  const list = p === 'flow2api' ? FLOW2API_MODEL_OPTIONS : APIMART_MODEL_OPTIONS;
  const label = p === 'flow2api' ? '本地 Flow2API 图像模型' : 'APIMart 图像系列';
  const customOption = p === 'flow2api' ? '' : '<option value="custom">自定义 APIMart 模型...</option>';
  select.innerHTML = `<optgroup label="${label}">${list.map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}${customOption}</optgroup>`;
}
function readCurrentImageFormConfig(){
  const p = currentImagePlatform();
  return {
    image_api_platform:p,
    api_endpoint: $('#apiEndpoint')?.value?.trim() || platformDefaultApiEndpoint(p),
    legacy_api_endpoint: p === 'flow2api' ? ($('#apiEndpoint')?.value?.trim() || platformDefaultApiEndpoint('flow2api')) : (loadClientConfig('flow2api').api_endpoint || platformDefaultApiEndpoint('flow2api')),
    api_key: $('#apiKey')?.value?.trim() || '',
    model: p === 'flow2api' ? normalizeFlow2ApiBaseModel($('#model')?.value) : ($('#model')?.value?.trim() || 'gemini-3.1-flash-image-preview'),
    size: getSizeValue ? getSizeValue() : ($('#size')?.value || 'auto'),
    clarity: $('#clarity')?.value || $('#claritySettings')?.value || '1K',
    quality: $('#imageQuality')?.value || 'auto',
    background: $('#imageBackground')?.value || 'auto',
    moderation: $('#moderation')?.value || 'auto',
    output_format: $('#outputFormat')?.value || 'png',
    output_compression: Number($('#outputCompression')?.value || 90),
    image_n: Math.max(1, Math.min(15, Number($('#imageN')?.value || 1)))
  };
}
function applyImagePlatformFields(cfg = {}, platform='apimart'){
  const p = normalizeImagePlatformValue(platform || cfg.image_api_platform);
  const merged = sanitizePlatformEndpoint({ ...defaultPlatformConfig(p), ...cfg, image_api_platform:p }, p);
  if(p === 'flow2api'){
    merged.model = normalizeFlow2ApiBaseModel(merged.model);
    if(merged.api_key === 'laig-flow2api-local-2026') merged.api_key = '';
  }
  if($('#apiEndpoint')) $('#apiEndpoint').value = merged.api_endpoint || platformDefaultApiEndpoint(p);
  if($('#apiKey')) $('#apiKey').value = merged.api_key || '';
  rebuildModelPresetOptions(p);
  rebuildImageParameterOptions(p);
  applyModelToUI(merged.model || (p === 'flow2api' ? 'gemini-3.1-flash-image' : 'gemini-3.1-flash-image-preview'));
  applySizeToUI(merged.size || 'auto');
  if($('#clarity')) $('#clarity').value = merged.clarity || '1K';
  if($('#claritySettings')) $('#claritySettings').value = merged.clarity || '1K';
  if($('#imageQuality')) $('#imageQuality').value = merged.quality || 'auto';
  if($('#imageBackground')) $('#imageBackground').value = merged.background || 'auto';
  if($('#moderation')) $('#moderation').value = merged.moderation || 'auto';
  if($('#outputFormat')) $('#outputFormat').value = merged.output_format || 'png';
  if($('#outputCompression')) $('#outputCompression').value = merged.output_compression || 90;
  if($('#imageN')) $('#imageN').value = String(merged.image_n || 1);
  updateApiKeyWarning();
}
function setImageApiPlatform(platform='apimart', silent=false, skipSaveCurrent=false){
  const p = normalizeImagePlatformValue(platform);
  const old = currentImagePlatform();
  if(!skipSaveCurrent && old && old !== p){
    try{ saveClientConfig(readCurrentImageFormConfig()); }catch(e){}
  }
  $$('#imageApiPlatformSwitch .platform-btn').forEach(btn=>btn.classList.toggle('active', normalizeImagePlatformValue(btn.dataset.platform) === p));
  localStorage.setItem(IMAGE_PLATFORM_ACTIVE_KEY, p);
  $('#modelPreset')?.classList.toggle('legacy-mode', p === 'flow2api');
  const saved = loadClientConfig(p);
  const legacy = loadLegacyClientConfig();
  let merged = sanitizePlatformEndpoint({ ...defaultPlatformConfig(p), ...(Object.keys(saved).length ? saved : {} ) }, p);
  // 首次升级：没有平台独立配置时，从旧单配置里迁移当前平台一次。
  const legacyPlatformRaw = String(legacy.image_api_platform || '').toLowerCase();
  if(!Object.keys(saved).length && normalizeImagePlatformValue(legacyPlatformRaw) === p && !(p === 'flow2api' && ['legacy','grsai'].includes(legacyPlatformRaw))){
    merged = sanitizePlatformEndpoint({ ...merged, ...legacy, image_api_platform:p }, p);
  }
  applyImagePlatformFields(merged, p);
  if(p === 'flow2api'){
    if($('#model')) $('#model').placeholder = 'Flow2API 模型由上方列表选择';
    if($('#apiKey')) $('#apiKey').placeholder = '请输入本地 Flow2API API Key';
    if(!silent) toast('已切换到本地 Flow2API');
  }else{
    if($('#model')) $('#model').placeholder = '自定义 APIMart 图像模型 ID';
    if($('#apiKey')) $('#apiKey').placeholder = '请输入 APIMart API Key / Bearer Token';
    if(!silent) toast('已切换到 APIMart，只显示 APIMart 模型和配置');
  }
  updateOfficialImageOptions();
  updateSizeHint();
}
function bindImageApiPlatformSwitch(){
  $$('#imageApiPlatformSwitch .platform-btn').forEach(btn=>btn.addEventListener('click',()=>setImageApiPlatform(btn.dataset.platform || 'apimart')));
}

function updateAppTitle(name){
  const appName = (name || 'TENYING_AI 1.0').trim() || 'TENYING_AI 1.0';
  if($('#appBrand')) $('#appBrand').textContent = appName;
  if($('#appSubtitle')) $('#appSubtitle').textContent = 'APIMart / GrsAI 双平台 · 并发生成 · 多批次 · 视频编辑';
  document.title = appName;
}

function timeBasedTheme(){
  const hour = new Date().getHours();
  // 24小时制：07:00-18:59 为日间，19:00-06:59 为深色。
  return (hour >= 7 && hour < 19) ? 'light' : 'dark';
}
function applyThemeMode(mode){
  const value = ['light','dark','auto'].includes(mode) ? mode : 'auto';
  const actual = value === 'auto' ? timeBasedTheme() : value;
  document.body.classList.remove('theme-light','theme-dark','theme-auto');
  document.body.classList.add('theme-' + actual, 'theme-auto-' + value);
  document.body.dataset.themeMode = value;
  document.body.dataset.themeActual = actual;
  if($('#themeMode')) $('#themeMode').value = value;
  if($('#themeModeQuick')) $('#themeModeQuick').value = value;
  updateThemeCycleLabel(value);
}
function updateThemeCycleLabel(mode){
  const m = mode || document.body.dataset.themeMode || 'auto';
  const map = {light:'日间模式', dark:'深色模式', auto:'自动主题'};
  if($('#themeCycleLabel')) $('#themeCycleLabel').textContent = map[m] || '布局主题';
}
function setThemeModeAndSave(next){
  if(!['light','dark','auto'].includes(next)) next = 'auto';
  if($('#themeMode')) $('#themeMode').value = next;
  if($('#themeModeQuick')) $('#themeModeQuick').value = next;
  applyThemeMode(next);
  handleConfigSave({...collectConfig(), theme_mode: next}, '主题已切换').catch(()=>{});
}
function cycleThemeMode(){
  const pop = $('#themePopover');
  if(!pop) return setThemeModeAndSave('auto');
  pop.classList.toggle('show');
}
setInterval(()=>{
  if((document.body.dataset.themeMode || 'auto') === 'auto') applyThemeMode('auto');
}, 60000);
async function enableKeepAlive(enabled){
  if(keepAliveTimer){ clearInterval(keepAliveTimer); keepAliveTimer = null; }
  if(enabled){
    keepAliveTimer = setInterval(()=>{ fetch('/api/health', {cache:'no-store'}).catch(()=>{}); }, 10000);
    fetch('/api/health', {cache:'no-store'}).catch(()=>{});
    if('wakeLock' in navigator){
      try{ wakeLock = await navigator.wakeLock.request('screen'); }catch(e){}
    }
  }else if(wakeLock){
    try{ await wakeLock.release(); }catch(e){}
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible' && $('#backgroundKeepalive')?.checked) enableKeepAlive(true);
});

function imageModelKey(model){ return String(model || '').toLowerCase(); }
function isOfficialImageModel(model){
  return ['gpt-image-2-official','gpt-image-1-official','gpt-image-1.5-official'].includes(imageModelKey(model));
}
function isSeedream5LiteModel(model){
  return ['doubao-seedream-5-0-lite','doubao-seedream-5.0-lite','seedream-5.0-lite'].includes(imageModelKey(model));
}
function isMultiNImageModel(model){
  const m = imageModelKey(model);
  return isOfficialImageModel(m) || ['doubao-seedance-4-0','doubao-seedream-4.0','doubao-seedream-4-0','seedream-4.0','seedream-4.5','doubao-seedream-5-0-lite','doubao-seedream-5.0-lite','seedream-5.0-lite','grok-imagine-1.5-apimart','grok-imagine-1.0','grok-imagine-1.5-edit-apimart','grok-imagine-1.0-edit-apimart','grok-imagine-1.0-edit'].includes(m);
}
function updateOfficialImageOptions(){
  const platform = currentImagePlatform();
  const model = $('#model')?.value || $('#modelPreset')?.value || '';
  const grsai = platform === 'grsai';
  const official = !grsai && isOfficialImageModel(model);
  const showOutput = !grsai && (official || isSeedream5LiteModel(model));
  const showN = !grsai && isMultiNImageModel(model);
  const showQuality = !grsai && official;
  const row1 = $('#officialImageOptions'); if(row1) row1.style.display = showOutput ? '' : 'none';
  const row2 = $('#officialImageOptions2'); if(row2) row2.style.display = showN ? '' : 'none';
  const row3 = $('#officialImageOptions3'); if(row3) row3.style.display = showQuality ? '' : 'none';
  const fmt = String($('#outputFormat')?.value || 'png').toLowerCase();
  const compWrap = $('#outputCompression')?.closest('div');
  if(compWrap) compWrap.style.opacity = (fmt === 'jpeg' || fmt === 'webp') ? '1' : '.45';
}
function applyModelToUI(model){
  const v = model || 'gemini-3.1-flash-image-preview';
  const opts = $$('#modelPreset option').map(o=>o.value);
  if(opts.includes(v) && v !== 'custom'){
    $('#modelPreset').value = v;
    $('#model').value = v;
    $('#model').classList.remove('show');
  }else{
    $('#modelPreset').value = 'custom';
    $('#model').value = v;
    $('#model').classList.add('show');
  }
  updateOfficialImageOptions();
}
function updateModelFromPreset(){
  const v = $('#modelPreset').value;
  if(v === 'custom'){ $('#model').classList.add('show'); $('#model').focus(); }
  else { $('#model').value = v; $('#model').classList.remove('show'); }
  updateSizeHint();
  updateOfficialImageOptions();
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
function resolveModelSize(model, size, clarity){
  const raw = normalizeSize(size);
  if(!raw || raw === 'auto') return 'auto';
  if(/^\d+x\d+$/.test(raw)) return raw;
  const m = String(model || '').toLowerCase();
  const q = String(clarity || '1K').toUpperCase();
  if(m === 'gpt-image-2-vip') return GPT_IMAGE_2_VIP_SIZES[raw]?.[q] || GPT_IMAGE_2_VIP_SIZES[raw]?.['1K'] || raw;
  if(m === 'gpt-image-2') return GPT_IMAGE_2_SIZES[raw] || raw;
  return raw;
}

function normalizeSize(v){ return String(v || 'auto').replace('×','x').replace(/\s+/g,'').toLowerCase(); }
function getSizeValue(){
  const sel = $('#size').value;
  if(sel === 'custom'){
    const w = Number($('#customWidth').value || 0);
    const h = Number($('#customHeight').value || 0);
    if(!w || !h) return 'auto';
    return `${Math.round(w)}x${Math.round(h)}`;
  }
  return sel || 'auto';
}
function applySizeToUI(sizeValue){
  const raw = normalizeSize(sizeValue);
  const options = $$('#size option').map(o => o.value);
  if(options.includes(raw)){
    $('#size').value = raw;
    $('#customWidth').value = '';
    $('#customHeight').value = '';
  }else{
    const m = raw.match(/^(\d{2,5})x(\d{2,5})$/);
    $('#size').value = m ? 'custom' : 'auto';
    $('#customWidth').value = m ? m[1] : '';
    $('#customHeight').value = m ? m[2] : '';
  }
  updateSizeHint();
}
function updateSizeHint(){
  const v = getSizeValue();
  const model = $('#model')?.value || $('#modelPreset')?.value || 'gemini-3.1-flash-image-preview';
  const clarity = $('#clarity')?.value || $('#claritySettings')?.value || '1K';
  const actual = resolveModelSize(model, v, clarity);
  $('#customSizeRow').classList.toggle('show', currentImagePlatform() !== 'flow2api' && $('#size').value === 'custom');
  if(currentImagePlatform() === 'flow2api'){
    const resolvedModel = `${normalizeFlow2ApiBaseModel(model)}-${v === '1:1' ? 'square' : v === '4:3' ? 'four-three' : v === '3:4' ? 'three-four' : v === '9:16' ? 'portrait' : 'landscape'}${String(clarity).toUpperCase() === '1K' ? '' : `-${String(clarity).toLowerCase()}`}`;
    $('#sizeHint').textContent = `Flow2API 提交模型：${resolvedModel}`;
    return;
  }
  const supportNote = String(model||'').startsWith('imagen-4.0') ? '（Imagen-4.0 仅支持文生图，上传参考图会被拦截）' : (imageModelKey(model).includes('grok-imagine') ? '（Grok 生成不传 resolution；Grok Edit 会走 /v1/images/edits）' : '');
  $('#sizeHint').textContent = `当前比例：${v}；APIMart 提交参数 size=${actual}，resolution=${clarity}${supportNote}`;
}

function updateLanDisplay(c = {}){
  const port = c.port || Number($('#servicePort')?.value || 7861);
  const localUrl = c.local_url || `http://127.0.0.1:${port}`;
  const lanUrl = c.lan_url || `http://${c.local_ip || '本机IP'}:${port}`;
  if($('#servicePort')) $('#servicePort').value = port;
  if($('#localUrl')) $('#localUrl').textContent = localUrl;
  if($('#lanUrl')) $('#lanUrl').textContent = lanUrl;
  $('#lanState').textContent = c.lan_enabled ? `局域网：${lanUrl}` : '局域网：未开启';
}


function syncToolConfigFromHome(){
  if($('#toolEndpoint')) $('#toolEndpoint').value = $('#apiEndpoint')?.value || 'https://api.apimart.ai';
  if($('#toolApiKey')) $('#toolApiKey').value = $('#apiKey')?.value || '';
  if($('#toolTargetApiKey') && !$('#toolTargetApiKey').value) $('#toolTargetApiKey').value = $('#apiKey')?.value || '';
  if($('#toolModel')) $('#toolModel').value = $('#model')?.value || 'gemini-3.1-flash-image-preview';
}

function readToolJson(){
  const raw = ($('#toolJson')?.value || '').trim();
  if(!raw) return {};
  try{ return JSON.parse(raw); }
  catch(e){ throw new Error('请求体 JSON 格式错误：' + e.message); }
}

async function runGrsaiTool(action, extra = {}){
  const btn = document.activeElement;
  const oldText = btn && btn.tagName === 'BUTTON' ? btn.textContent : '';
  try{
    if(btn && btn.tagName === 'BUTTON'){ btn.disabled = true; btn.textContent = '请求中...'; }
    const bodyJson = readToolJson();
    const payload = {
      action,
      api_endpoint: $('#toolEndpoint')?.value || $('#apiEndpoint')?.value || 'https://api.apimart.ai',
      api_key: $('#toolApiKey')?.value || $('#apiKey')?.value || '',
      target_api_key: $('#toolTargetApiKey')?.value || $('#toolApiKey')?.value || $('#apiKey')?.value || '',
      model: $('#toolModel')?.value || $('#model')?.value || 'gemini-3.1-flash-image-preview',
      timeout_seconds: Number($('#timeoutSeconds')?.value || 1200),
      apimart_proxy_url: $('#apimartProxyUrl')?.value?.trim() || '',
      body: {...bodyJson, ...extra}
    };
    const ret = await api('/api/grsai_tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    $('#toolResult').textContent = JSON.stringify(ret, null, 2);
    toast('接口请求完成');
  }catch(e){
    if($('#toolResult')) $('#toolResult').textContent = String(e.message || e);
    alert(e.message || '接口请求失败');
  }finally{
    if(btn && btn.tagName === 'BUTTON'){ btn.disabled = false; btn.textContent = oldText; }
  }
}


function renderChatModelPresetOptions(filterKeyword = ''){
  const sel = $('#chatModelPreset');
  if(!sel) return;
  const current = $('#chatModel')?.value || sel.value || 'gpt-5';
  const q = String(filterKeyword || '').trim().toLowerCase();
  let models = Array.isArray(chatModelCatalog) ? [...chatModelCatalog] : [];
  if(q){
    models = models.filter(m => {
      const id = String(m.id || '').toLowerCase();
      const name = String(m.name || '').toLowerCase();
      return id.includes(q) || name.includes(q);
    });
  }
  if(!models.length) models = Array.isArray(chatModelCatalog) ? [...chatModelCatalog] : [];
  sel.innerHTML = models.map(m=>`<option value="${escapeHtml(m.id || m.name)}">${escapeHtml(m.name || m.id)}</option>`).join('') + '<option value="custom">自定义模型...</option>';
  applyChatModelToUI(current);
}
async function loadChatModels(){
  const sel = $('#chatModelPreset');
  if(!sel) return;
  try{
    const ret = await api('/api/chat_models');
    const models = Array.isArray(ret.models) ? ret.models : [];
    if(models.length){
      chatModelCatalog = models;
      renderChatModelPresetOptions($('#chatModelSearch')?.value || '');
      return;
    }
  }catch(e){
    console.warn('加载聊天模型失败，使用内置模型列表', e);
  }
  renderChatModelPresetOptions($('#chatModelSearch')?.value || '');
}
function normalizeChatNumber(v, fallback = ''){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function collectChatOptions(){
  const model = $('#chatModel')?.value || 'gpt-5.5';
  const isGPTLike = /^(gpt-|o\d|chatgpt-)/i.test(model);
  const opts = {
    max_tokens: normalizeChatNumber($('#chatMaxTokens')?.value, ''),
    temperature: normalizeChatNumber($('#chatTemperature')?.value, ''),
    top_p: normalizeChatNumber($('#chatTopP')?.value, ''),
    presence_penalty: normalizeChatNumber($('#chatPresencePenalty')?.value, ''),
    frequency_penalty: normalizeChatNumber($('#chatFrequencyPenalty')?.value, '')
  };
  const topK = normalizeChatNumber($('#chatTopK')?.value, '');
  if(topK !== '' && !isGPTLike) opts.top_k = topK;
  return Object.fromEntries(Object.entries(opts).filter(([,v]) => v !== '' && v !== null && typeof v !== 'undefined'));
}
function loadChatConfig(serverConfig = {}){
  let local = {};
  try{ local = JSON.parse(localStorage.getItem(CHAT_CONFIG_KEY) || '{}'); }catch(e){}
  const oldModel = String(local.model || '');
  const m = oldModel || serverConfig.chat_model || 'gpt-5.5';
  applyChatModelToUI(m);
  loadChatModels();
  if($('#chatSystemPrompt')) $('#chatSystemPrompt').value = local.system_prompt || '';
  if($('#chatStream')) $('#chatStream').checked = true;
  if($('#chatMaxTokens')) $('#chatMaxTokens').value = local.max_tokens || 12000;
  if($('#chatTemperature')) $('#chatTemperature').value = typeof local.temperature !== 'undefined' ? local.temperature : 1;
  if($('#chatTopP')) $('#chatTopP').value = typeof local.top_p !== 'undefined' ? local.top_p : 1;
  if($('#chatTopK')) $('#chatTopK').value = typeof local.top_k !== 'undefined' ? local.top_k : 50;
  if($('#chatPresencePenalty')) $('#chatPresencePenalty').value = typeof local.presence_penalty !== 'undefined' ? local.presence_penalty : 0;
  if($('#chatFrequencyPenalty')) $('#chatFrequencyPenalty').value = typeof local.frequency_penalty !== 'undefined' ? local.frequency_penalty : 0;
  loadChatConversations();
  renderChatList();
  renderChat();
}
function saveChatConfig(){
  const opts = collectChatOptions();
  const cfg = {
    model: $('#chatModel')?.value || 'gpt-5.5',
    system_prompt: $('#chatSystemPrompt')?.value || '',
    stream: true,
    max_tokens: opts.max_tokens || '',
    temperature: opts.temperature,
    top_p: opts.top_p,
    top_k: normalizeChatNumber($('#chatTopK')?.value, 50),
    presence_penalty: opts.presence_penalty,
    frequency_penalty: opts.frequency_penalty
  };
  localStorage.setItem(CHAT_CONFIG_KEY, JSON.stringify(cfg));
  toast('聊天模型、Stream 与参数已保存到本设备');
}
function applyChatModelToUI(model){
  if(!$('#chatModelPreset') || !$('#chatModel')) return;
  const v = model || 'gpt-5';
  const opts = $$('#chatModelPreset option').map(o=>o.value);
  if(opts.includes(v) && v !== 'custom'){
    $('#chatModelPreset').value = v;
    $('#chatModel').value = v;
    $('#chatModel').classList.remove('show');
  }else{
    $('#chatModelPreset').value = 'custom';
    $('#chatModel').value = v;
    $('#chatModel').classList.add('show');
  }
}
function updateChatModelFromPreset(){
  const v = $('#chatModelPreset')?.value || 'gpt-5';
  if(v === 'custom'){ $('#chatModel')?.classList.add('show'); $('#chatModel')?.focus(); }
  else { $('#chatModel').value = v; $('#chatModel').classList.remove('show'); }
}
function handleChatModelSearchInput(){
  renderChatModelPresetOptions($('#chatModelSearch')?.value || '');
}
function syncChatConfigFromHome(){
  // AI聊天共用首页 APIMart API 地址与 API Key。
  if($('#chatApiHint')) $('#chatApiHint').textContent = `使用设置中心 API：${$('#apiEndpoint')?.value || 'https://api.apimart.ai'} · /v1/chat/completions`;
}
function pruneChatConversations(list){
  const now = Date.now();
  return (list || []).filter(c => (now - Number(c.updated_at || c.created_at || 0)) <= CHAT_TTL_MS);
}
function loadChatConversations(){
  try{ chatConversations = JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) || '[]'); }catch(e){ chatConversations = []; }
  chatConversations = pruneChatConversations(chatConversations);
  if(!chatConversations.length) createNewChat(false);
  if(!currentChatId || !chatConversations.some(c=>c.id===currentChatId)) currentChatId = chatConversations[0]?.id || '';
  persistChatHistory();
}
function persistChatHistory(){
  chatConversations = pruneChatConversations(chatConversations);
  try{ localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(chatConversations.slice(0, 80))); }catch(e){
    // 本地缓存容量不足时，降级只保留最近 20 个聊天的文字内容。
    const compact = chatConversations.slice(0,20).map(c=>({...c, messages:(c.messages||[]).slice(-30).map(m=>({role:m.role,text:m.text,thinkSeconds:m.thinkSeconds,created_at:m.created_at}))}));
    try{ localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(compact)); }catch(_e){}
  }
}
function getCurrentChat(){
  let c = chatConversations.find(x=>x.id===currentChatId);
  if(!c){ c = createNewChat(false); }
  chatMessages = c.messages || [];
  return c;
}
function chatTitleFromText(text){
  const t = (text || '').replace(/\s+/g,' ').trim();
  return t ? t.slice(0, 24) : '新聊天';
}
function createNewChat(render = true){
  const now = Date.now();
  const c = {id:'chat-' + Math.random().toString(36).slice(2) + now.toString(36), title:'新聊天', created_at:now, updated_at:now, messages:[]};
  chatConversations.unshift(c);
  currentChatId = c.id;
  chatImages = [];
  chatMessages = c.messages;
  persistChatHistory();
  if(render){ renderChatList(); renderChat(); }
  return c;
}
function switchChat(id){
  currentChatId = id;
  chatImages = [];
  getCurrentChat();
  renderChatList();
  renderChat();
}
function renderChatList(){
  const box = $('#chatList');
  if(!box) return;
  chatConversations = pruneChatConversations(chatConversations);
  if(!chatConversations.length) createNewChat(false);
  box.innerHTML = chatConversations.map(c=>{
    const active = c.id === currentChatId ? ' active' : '';
    const count = (c.messages || []).length;
    const time = new Date(Number(c.updated_at || c.created_at || Date.now())).toLocaleString();
    const model = c.model || $('#chatModel')?.value || 'gpt-5';
    return `<div class="chat-list-item${active}" data-id="${c.id}"><div class="chat-list-main"><div class="chat-list-title">${escapeHtml(c.title || '新聊天')}</div><div class="chat-list-meta">${count} 条 · ${escapeHtml(time)} · ${escapeHtml(model)}</div></div><button class="chat-delete-btn" data-id="${c.id}" title="删除聊天">×</button></div>`;
  }).join('');
  $$('#chatList .chat-list-main').forEach(el=>el.addEventListener('click',()=>switchChat(el.closest('.chat-list-item').dataset.id)));
  $$('#chatList .chat-delete-btn').forEach(btn=>btn.addEventListener('click',e=>{ e.stopPropagation(); deleteChatConversation(btn.dataset.id); }));
}
function deleteChatConversation(id){
  const c = chatConversations.find(x=>x.id===id);
  if(!c) return;
  if(!confirm(`确定删除聊天“${c.title || '新聊天'}”？
删除后会同时清除本地聊天消息和附件缓存。`)) return;
  chatConversations = chatConversations.filter(x=>x.id !== id);
  if(currentChatId === id){ currentChatId = chatConversations[0]?.id || ''; chatImages = []; }
  if(!chatConversations.length) createNewChat(false);
  persistChatHistory();
  renderChatList();
  renderChat();
  toast('聊天已删除');
}

function renderChat(){
  const box = $('#chatMessages');
  if(!box) return;
  const c = getCurrentChat();
  if($('#currentChatTitle')) $('#currentChatTitle').textContent = c.title || '聊天窗口';
  if(!chatMessages.length){
    box.innerHTML = '<div class="chat-empty">暂无聊天记录。输入问题或添加附件后点击发送。</div>';
  }else{
    box.innerHTML = chatMessages.map(m=>{
      const time = m.created_at ? new Date(Number(m.created_at)).toLocaleTimeString() : '';
      const think = m.thinkSeconds ? `<div class="chat-meta-small">${m.role === 'user' ? '本次思考用时' : '思考用时'}：${Number(m.thinkSeconds).toFixed(1)} 秒</div>` : '';
      const atts = Array.isArray(m.attachments) ? m.attachments : [];
      const attachHtml = (!chatContextFullscreen && atts.length) ? `<div class="chat-msg-files">${atts.map(a=>{
        if(String(a.type||'').startsWith('image/') && a.data){ return `<div class="chat-msg-file image"><img loading="lazy" src="${a.data}" data-preview="${a.data}"><span>${escapeHtml(a.name||'图片')}</span></div>`; }
        return `<div class="chat-msg-file"><b>${fileIcon(a)}</b><span>${escapeHtml(a.name||'文件')} · ${prettyBytes(a.size)}</span></div>`;
      }).join('')}</div>` : '';
      return `<div class="chat-msg ${m.role}"><div class="chat-role">${m.role === 'user' ? '你' : 'AI'}</div><div class="chat-bubble">${escapeHtml(m.text || '').replace(/\n/g,'<br>')}${attachHtml}${think}<div class="chat-time">${escapeHtml(time)}</div></div></div>`;
    }).join('');
    $$('#chatMessages img[data-preview]').forEach(img=>img.addEventListener('click',()=>showPreview(img.dataset.preview)));
  }
  box.scrollTop = box.scrollHeight;
  renderChatAttachments();
}
function renderChatAttachments(){
  const box = $('#chatAttachments');
  if(!box) return;
  box.innerHTML = chatImages.map((it,i)=>{
    const isImg = String(it.type || '').startsWith('image/');
    const preview = isImg ? `<img class="chat-file-thumb" loading="lazy" src="${it.data}" data-preview="${it.data}">` : `<div class="chat-file-icon">${fileIcon(it)}</div>`;
    return `<div class="chat-file-card">${preview}<div class="chat-file-info"><b>${escapeHtml(it.name||'文件')}</b><span>${escapeHtml(it.type||'未知类型')} · ${prettyBytes(it.size)}</span></div><button class="thumb-del" data-i="${i}">×</button></div>`;
  }).join('');
  $$('#chatAttachments [data-preview]').forEach(img=>img.addEventListener('click',()=>showPreview(img.dataset.preview)));
  $$('#chatAttachments .thumb-del').forEach(btn=>btn.addEventListener('click',e=>{ e.stopPropagation(); chatImages.splice(Number(btn.dataset.i),1); renderChatAttachments(); }));
}
async function addChatImages(files){
  const list = [...files].filter(Boolean);
  const arr = [];
  for(const f of list){
    const item = await fileToData(f);
    if(isTextLike(f)) item.textContent = await fileToText(f);
    arr.push(item);
  }
  chatImages.push(...arr);
  renderChatAttachments();
}
function buildChatApiMessages(userText, historyMessages){
  const system = ($('#chatSystemPrompt')?.value || '').trim();
  const messages = [];
  if(system) messages.push({role:'system', content:system});
  // 只带最近几轮有效上下文；过滤旧版 bug 产生的 raw JSON / 请求失败文本，避免再次传给 /v1/chat/completions。
  (historyMessages || []).slice(-10).forEach(m=>{
    const text = String(m.text || '').trim();
    if(!text) return;
    if(/^请求失败[:：]/.test(text)) return;
    if(/^\{\s*"raw"\s*:/i.test(text) || /^\[\s*\{\s*"raw"\s*:/i.test(text)) return;
    if(text.length > 6000) return;
    const role = (m.role === 'assistant' || m.role === 'user' || m.role === 'system') ? m.role : 'user';
    messages.push({role, content:text});
  });
  if(chatImages.length){
    const content = [{type:'input_text', text:userText}];
    chatImages.forEach(file=>{
      if(String(file.type||'').startsWith('image/')){
        content.push({type:'input_image', image_url:file.data});
      }else{
        const textPreview = file.textContent ? `\n内容预览：\n${file.textContent}` : '\n说明：该文件已作为附件上传；如果模型不支持非图片二进制文件，请根据文件名和用户描述进行回答。';
        const info = `\n\n[附件文件] ${file.name || '未命名'}\n类型：${file.type || 'unknown'}\n大小：${prettyBytes(file.size)}${textPreview}`;
        content.push({type:'text', text:info});
      }
    });
    messages.push({role:'user', content});
  }else{
    messages.push({role:'user', content:userText});
  }
  return messages;
}
function startThinkingTimer(){
  stopThinkingTimer('');
  chatThinkingStart = performance.now();
  const badge = $('#chatThinkingBadge');
  if(!badge) return;
  badge.textContent = '思考中 0.0s';
  badge.classList.add('show');
  chatThinkingTimer = setInterval(()=>{
    const sec = (performance.now() - chatThinkingStart) / 1000;
    badge.textContent = `思考中 ${sec.toFixed(1)}s`;
  }, 100);
}
function stopThinkingTimer(finalText){
  if(chatThinkingTimer){ clearInterval(chatThinkingTimer); chatThinkingTimer = null; }
  const badge = $('#chatThinkingBadge');
  if(badge){ badge.textContent = finalText || ''; badge.classList.toggle('show', !!finalText); }
}

async function streamChatCompletionRequest(payload, onEvent){
  const res = await fetch('/api/chat_completions_stream', {
    method:'POST',
    headers:{'Content-Type':'application/json','X-Client-Id':getClientId(),'X-Public-Access':getPublicAccess()},
    body:JSON.stringify(payload)
  });
  if(!res.ok){
    let msg = await res.text();
    try{ msg = JSON.parse(msg).error || msg; }catch(e){}
    throw new Error(msg || 'Stream 请求失败');
  }
  const reader = res.body?.getReader();
  if(!reader) throw new Error('当前环境不支持 Stream 读取');
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let content = '';
  let finalElapsed = 0;
  let errorText = '';
  const handleLine = (line) => {
    const m = String(line || '').match(/^\s*data:\s*(.*)\s*$/);
    if(!m) return;
    const raw = m[1].trim();
    if(!raw || raw === '[DONE]') return;
    try{
      const ev = JSON.parse(raw);
      if(ev.error){ errorText = ev.error; return; }
      if(ev.delta){
        content += ev.delta;
        onEvent && onEvent({delta:ev.delta, content, elapsed:Number(ev.elapsed || 0)});
      }
      if(ev.elapsed) finalElapsed = Number(ev.elapsed || finalElapsed);
      if(ev.done){
        if(ev.content && !content) content = ev.content;
        onEvent && onEvent({done:true, content, elapsed:Number(ev.elapsed || finalElapsed || 0)});
      }
    }catch(e){}
  };
  while(true){
    const {value, done} = await reader.read();
    if(done) break;
    buf += decoder.decode(value, {stream:true});
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for(const line of lines) handleLine(line);
  }
  if(buf) handleLine(buf);
  if(errorText) throw new Error(errorText);
  return {content, elapsed:finalElapsed};
}

async function sendChat(){
  const input = $('#chatInput');
  const text = (input?.value || '').trim();
  if(!text && !chatImages.length) return toast('请输入问题或添加附件');
  const c = getCurrentChat();
  const history = (c.messages || []).slice();
  const sendBtn = $('#sendChatBtn');
  if(sendBtn){ sendBtn.disabled = true; sendBtn.classList.add('sending'); sendBtn.setAttribute('aria-label','发送中'); }
  const userText = text || '请分析这些附件';
  const attachments = chatImages.map(f=>({name:f.name,type:f.type,size:f.size,data:String(f.type||'').startsWith('image/')?f.data:''}));
  const imageCount = chatImages.length;
  const payloadMessages = buildChatApiMessages(userText, history);
  const now = Date.now();
  const userMessage = {role:'user', text:userText, imageCount, attachments, created_at:now};
  c.messages.push(userMessage);
  if(c.title === '新聊天') c.title = chatTitleFromText(userText);
  c.updated_at = now;
  chatMessages = c.messages;
  input.value = '';
  renderChatList();
  renderChat();
  startThinkingTimer();
  const started = performance.now();
  try{
    const payload = {
      api_endpoint: $('#apiEndpoint')?.value || 'https://api.apimart.ai',
      api_key: $('#apiKey')?.value || '',
      model: $('#chatModel')?.value || 'gpt-5.5',
      messages: payloadMessages,
      attachments: chatImages,
      stream: true,
      options: collectChatOptions()
    };
    const shouldStream = !!payload.stream;
    if(shouldStream){
      const assistantMessage = {role:'assistant', text:'', streaming:true, created_at:Date.now()};
      c.messages.push(assistantMessage);
      chatMessages = c.messages;
      renderChat();
      let lastPaint = 0;
      const ret = await streamChatCompletionRequest(payload, (ev = {}) => {
        const elapsed = Number(ev.elapsed || ((performance.now() - started) / 1000));
        userMessage.thinkSeconds = elapsed;
        if(typeof ev.content === 'string') assistantMessage.text = ev.content;
        if(ev.delta && !ev.content) assistantMessage.text += ev.delta;
        c.updated_at = Date.now();
        const nowMs = performance.now();
        if(ev.done || nowMs - lastPaint > 120){
          lastPaint = nowMs;
          chatMessages = c.messages;
          renderChat();
          updateThinkingBadge(`Stream 输出中 ${elapsed.toFixed(1)}s`);
        }
      });
      const thinkSeconds = (performance.now() - started) / 1000;
      userMessage.thinkSeconds = thinkSeconds;
      assistantMessage.streaming = false;
      assistantMessage.text = assistantMessage.text || ret.content || 'Stream 已结束，但没有解析到文本回复。请查看实时日志。';
      c.updated_at = Date.now();
      chatImages = [];
      chatMessages = c.messages;
      persistChatHistory();
      renderChatList();
      renderChat();
      stopThinkingTimer(`消耗时长 ${thinkSeconds.toFixed(1)}s`);
      setTimeout(()=>stopThinkingTimer(''), 2600);
    }else{
      const ret = await api('/api/chat_completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const thinkSeconds = (performance.now() - started) / 1000;
      const reply = ret.content || ret?.response?.content || '接口已返回，但没有解析到文本回复。请查看实时日志。';
      userMessage.thinkSeconds = thinkSeconds;
      c.messages.push({role:'assistant', text:reply, created_at:Date.now()});
      c.updated_at = Date.now();
      chatImages = [];
      chatMessages = c.messages;
      persistChatHistory();
      renderChatList();
      renderChat();
      stopThinkingTimer(`消耗时长 ${thinkSeconds.toFixed(1)}s`);
      setTimeout(()=>stopThinkingTimer(''), 2600);
    }
  }catch(e){
    const thinkSeconds = (performance.now() - started) / 1000;
    userMessage.thinkSeconds = thinkSeconds;
    c.messages.push({role:'assistant', text:'请求失败：' + (e.message || e), created_at:Date.now()});
    c.updated_at = Date.now();
    chatMessages = c.messages;
    persistChatHistory();
    renderChatList();
    renderChat();
    stopThinkingTimer('请求失败');
    setTimeout(()=>stopThinkingTimer(''), 2600);
  }finally{
    if(sendBtn){ sendBtn.disabled = false; sendBtn.classList.remove('sending'); sendBtn.setAttribute('aria-label','发送'); }
  }
}
function clearChat(){
  const c = getCurrentChat();
  if(!confirm('确定清空当前聊天？')) return;
  c.messages = [];
  c.updated_at = Date.now();
  chatImages = [];
  chatMessages = c.messages;
  persistChatHistory();
  renderChatList();
  renderChat();
}
function clearChatImages(){ chatImages = []; renderChatAttachments(); }


function applyPermissionUI(){
  document.body.classList.toggle('remote-client', !isLocalClient);
  const blocked = ['lan','settings']; // 公网访问页允许局域网/公网访问端查看只读信息
  $$('.nav').forEach(btn => {
    if(blocked.includes(btn.dataset.page)) btn.style.display = isLocalClient ? '' : 'none';
  });
  // 手机端主要用于局域网/公网访问，永远不显示设置入口；本机管理设置请使用 PC 端。
  $$('.mobile-ui .nav[data-page="settings"]').forEach(btn => btn.style.display = 'none');
  ['saveLanBtn','saveSettingsBtn','startPublicBtn','stopPublicBtn','checkUpdateBtn'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.disabled = !isLocalClient;
  });
  const clearAllBtn = $('#clearAllCacheBtn');
  if(clearAllBtn){
    clearAllBtn.disabled = !isLocalClient;
    clearAllBtn.title = isLocalClient ? '清除软件所有数据' : '只有主机端可以清除所有数据';
    clearAllBtn.textContent = isLocalClient ? '清除软件所有数据' : '只有主机端可以清除所有数据';
  }
  ['publicProvider','publicPassword','publicPermission','cloudflaredPath','ngrokPath','manualPublicUrl','lanEnabled','servicePort','appName','outputDir'].forEach(id => {
    const el = document.getElementById(id);
    if(el && !isLocalClient) el.disabled = true;
  });
  if($('#saveConfigBtn')) $('#saveConfigBtn').textContent = '保存当前设置';
  $('#publicHelpCard')?.classList.toggle('hidden', !isLocalClient);
  $('#publicAdminGrid')?.classList.toggle('hidden', !isLocalClient);
  $('#publicReadonlyCard')?.classList.toggle('hidden', isLocalClient);
  if(!isLocalClient && ($('#page-lan')?.classList.contains('active') || $('#page-settings')?.classList.contains('active'))){
    setPage('home');
  }
}

function setPage(name){
  $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  repairMobileBottomNav();
  setRealtimePanelMode((name === 'video' || name === 'video-manage') ? 'video' : 'image');
  if(name === 'images') loadImages();
  if(name === 'video'){ syncVideoApiKeyFromHome(); loadVideoTasks(); }
  if(name === 'video-manage') loadVideoTasks();
  if(name === 'history') { currentBatchFilter = currentBatchFilter || 'all'; loadBatches().finally(forceRenderHistory); }
  if(name === 'api') loadLogs();
  if(name === 'logs') loadLogs();
  if(name === 'tools') syncToolConfigFromHome();
  if(name === 'chat') { syncChatConfigFromHome(); renderChat(); setPanelCollapsed(true); }
  if(name === 'public') refreshPublicStatus();
}

$$('.nav[data-page]').forEach(btn => btn.addEventListener('click', () => setPage(btn.dataset.page === 'batches' ? 'history' : btn.dataset.page)));
$('#themeCycleBtn')?.addEventListener('click', cycleThemeMode);
$$('#themePopover [data-theme]').forEach(btn=>btn.addEventListener('click',()=>{ $('#themePopover')?.classList.remove('show'); setThemeModeAndSave(btn.dataset.theme); }));
document.addEventListener('click', e=>{ if(!e.target.closest('#themeCycleBtn') && !e.target.closest('#themePopover')) $('#themePopover')?.classList.remove('show'); });
document.addEventListener('click', async e=>{ const btn=e.target.closest('.icon-copy[data-copy-target]'); if(!btn) return; e.preventDefault(); const el=$('#'+btn.dataset.copyTarget); await copyTextSmart(el?.value || el?.textContent || '', '内容'); toast('已复制'); });


function ensurePublicLoginUI(){
  let box = $('#publicLoginOverlay');
  if(box) return box;
  box = document.createElement('div');
  box.id = 'publicLoginOverlay';
  box.className = 'public-login-overlay';
  box.innerHTML = `<div class="public-login-card">
    <div class="brand">公网访问验证</div>
    <p>请输入访问密码，验证通过后本设备 7 天内不用重复输入。</p>
    <input id="publicLoginPassword" type="password" placeholder="访问密码" />
    <button id="publicLoginBtn" class="primary">进入系统</button>
    <div id="publicLoginError" class="public-login-error"></div>
  </div>`;
  document.body.appendChild(box);
  $('#publicLoginBtn').addEventListener('click', submitPublicLogin);
  $('#publicLoginPassword').addEventListener('keydown', e=>{ if(e.key==='Enter') submitPublicLogin(); });
  return box;
}
function showPublicLogin(message=''){
  const box = ensurePublicLoginUI();
  box.classList.add('active');
  if($('#publicLoginError')) $('#publicLoginError').textContent = message || '';
  setTimeout(()=>$('#publicLoginPassword')?.focus(), 80);
}
function hidePublicLogin(){ $('#publicLoginOverlay')?.classList.remove('active'); }
async function submitPublicLogin(){
  const password = $('#publicLoginPassword')?.value || '';
  try{
    const res = await fetch('/api/public_login', {method:'POST', headers:{'Content-Type':'application/json','X-Client-Id':getClientId()}, body:JSON.stringify({password})});
    const data = await res.json().catch(()=>({}));
    if(!res.ok || !data.ok) throw new Error(data.error || '密码验证失败');
    rememberPublicAccess(password, data.remember_days || 7);
    hidePublicLogin();
    await startup();
    toast('公网访问已登录，本设备 7 天内免输入密码');
  }catch(e){
    if($('#publicLoginError')) $('#publicLoginError').textContent = e.message || '密码错误';
  }
}

async function loadConfig(){
  let c = await api('/api/config');
  isLocalClient = c.is_local_client !== false;
  isPublicClient = c.is_public_client === true;
  c = mergeClientSettings(c);
  if(c.mj_tab) mjState.tab = c.mj_tab;
  // 局域网访问端使用自己的本地 API Key 配置，不覆盖服务端全局设置。
  if(!isLocalClient){
    const localDeviceCfg = loadClientConfig();
    c = {...c, ...localDeviceCfg, api_key: localDeviceCfg.api_key || c.api_key || ''};
    c.public_password = '';
  }
  const rootClientCfg = loadLegacyClientConfig();
  const initialPlatform = normalizeImagePlatformValue(localStorage.getItem(IMAGE_PLATFORM_ACTIVE_KEY) || 'apimart');
  $$('#imageApiPlatformSwitch .platform-btn').forEach(btn=>btn.classList.toggle('active', normalizeImagePlatformValue(btn.dataset.platform) === initialPlatform));
  localStorage.setItem(IMAGE_PLATFORM_ACTIVE_KEY, initialPlatform);
  const savedPlatformCfg = loadClientConfig(initialPlatform);
  const serverPlatform = normalizeImagePlatformValue(c.image_api_platform || (/grsaiapi\.com|grsai\.dakka\.com\.cn/i.test(c.api_endpoint || '') ? 'grsai' : 'apimart'));
  const useServerAsSeed = isLocalClient && serverPlatform === initialPlatform && !Object.keys(savedPlatformCfg).length;
  const platformCfg = sanitizePlatformEndpoint({ ...defaultPlatformConfig(initialPlatform), ...(useServerAsSeed ? c : {}), ...savedPlatformCfg, image_api_platform: initialPlatform }, initialPlatform);
  applyImagePlatformFields(platformCfg, initialPlatform);
  updateOfficialImageOptions();
  applyThemeMode(c.theme_mode || 'auto');
  $('#concurrency').value = c.concurrency || 30;
  $('#retryTimes').value = c.retry_times || 2;
  $('#repeatCount').value = c.repeat_count || 1;
  $('#lanEnabled').checked = !!c.lan_enabled;
  if($('#appName')) $('#appName').value = c.app_name || 'TENYING_AI 1.0';
  $('#outputDir').value = c.output_dir || '';
  $('#logKeepDays').value = c.log_keep_days || 3;
  $('#pollInterval').value = c.poll_interval_ms || 800;
  $('#timeoutSeconds').value = c.timeout_seconds || 1200;
  if($('#apimartProxyUrl')) $('#apimartProxyUrl').value = c.apimart_proxy_url || '';
  if($('#backgroundKeepalive')) $('#backgroundKeepalive').checked = c.background_keepalive !== false;
  if($('#deviceDataIsolation')) $('#deviceDataIsolation').checked = c.device_data_isolation !== false;
  if($('#promptMultilineTasks')) $('#promptMultilineTasks').checked = c.prompt_multiline_tasks !== false;
  if($('#promptLibraryPermissionShared')) $('#promptLibraryPermissionShared').checked = c.prompt_library_permission_shared === true;
  if($('#announcementUrl')) $('#announcementUrl').value = c.announcement_url || 'https://apimart.ai/zh/log-updates';
  if($('#announcementCustomEnabled')) $('#announcementCustomEnabled').checked = c.announcement_custom_enabled === true;
  if($('#appVersionText')) $('#appVersionText').textContent = c.app_version || c.version || '-';
  if(c.update_last_check){
    softwareUpdateInfo = c.update_last_check;
    renderSoftwareUpdateInfo(c.update_last_check);
  }
  renderAnnouncementCustomEditor(Array.isArray(c.announcement_custom_items) && c.announcement_custom_items.length ? c.announcement_custom_items : ((c.announcement_custom_title || c.announcement_custom_content) ? [{ title:c.announcement_custom_title || '', content:c.announcement_custom_content || '', tag:'自定义' }] : []));
  updateAppTitle(c.app_name || 'TENYING_AI 1.0');
  updateLanDisplay(c);
  if($('#publicProvider')) $('#publicProvider').value = c.public_provider || 'cloudflare';
  if($('#publicPassword')) $('#publicPassword').value = c.public_password || '';
  if($('#publicPermission')) $('#publicPermission').value = c.public_permission || 'generate';
  if($('#cloudflaredPath')) $('#cloudflaredPath').value = c.cloudflared_path || 'cloudflared';
  if($('#ngrokPath')) $('#ngrokPath').value = c.ngrok_path || 'ngrok';
  if($('#manualPublicUrl')) $('#manualPublicUrl').value = (c.public_url || '').split('?')[0] || '';
  updatePublicStatus(c.public_status || {running: !!c.public_enabled, url: c.public_url || '', logs: []}, c);
  syncToolConfigFromHome();
  loadChatConfig(c);
  applyPermissionUI();
  enableKeepAlive($('#backgroundKeepalive')?.checked);
}

function fileToData(file){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = () => resolve({name:file.name, type:file.type, size:file.size || 0, data:reader.result});
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function getVideoDurationSeconds(file){
  return new Promise((resolve)=>{
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let done = false;
    let triedSeek = false;
    const finish = (val)=>{
      if(done) return;
      const n = Number(val);
      if(!Number.isFinite(n) || n <= 0) return;
      done=true; clearTimeout(timer); URL.revokeObjectURL(url); resolve(n);
    };
    const giveUp = ()=>{ if(done) return; done=true; URL.revokeObjectURL(url); resolve(NaN); };
    const tryRead = ()=>{
      if(done) return;
      if(Number.isFinite(Number(v.duration)) && Number(v.duration) > 0) return finish(v.duration);
      // 部分 mp4/mov 在 Windows/Electron loadedmetadata 会先返回 0/Infinity，seek 到极大时间后才给真实 duration。
      if(!triedSeek){
        triedSeek = true;
        try { v.currentTime = 1e101; } catch {}
        setTimeout(()=>finish(v.duration), 900);
      }
    };
    const timer = setTimeout(giveUp, 15000);
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = tryRead;
    v.onloadeddata = tryRead;
    v.oncanplay = tryRead;
    v.ondurationchange = tryRead;
    v.ontimeupdate = tryRead;
    v.onerror = ()=>giveUp();
    v.src = url;
  });
}
function videoDurationText(sec){
  if(!Number.isFinite(Number(sec))) return '';
  return `${Number(sec).toFixed(1)} 秒`;
}
function fileToText(file){
  return new Promise((resolve)=>{
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').slice(0, 120000));
    reader.onerror = () => resolve('');
    reader.readAsText(file);
  });
}
function isTextLike(file){
  const name = (file.name || '').toLowerCase();
  return /^text\//.test(file.type || '') || /\.(txt|md|csv|json|xml|html|css|js|ts|py|log|yaml|yml)$/i.test(name);
}
function prettyBytes(n){
  n = Number(n || 0);
  if(n < 1024) return n + ' B';
  if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/1024/1024).toFixed(1) + ' MB';
}
function mjFileKey(file){ return [file?.name || '', file?.size || 0, file?.lastModified || 0, file?.type || ''].join('::'); }
function getMjInputFiles(input){ return Array.isArray(input?._mjFiles) ? input._mjFiles.slice() : Array.from(input?.files || []); }
function setMjInputFiles(input, files=[]){
  if(!input) return;
  const dt = new DataTransfer();
  const list = Array.isArray(files) ? files : [];
  list.forEach(file=>{ try{ dt.items.add(file); }catch{} });
  input.files = dt.files;
  input._mjFiles = list.slice();
}
function mergeMjInputFiles(input, incoming=[]){
  if(!input) return;
  const base = input.multiple ? getMjInputFiles(input) : [];
  const seen = new Set(base.map(mjFileKey));
  const list = input.multiple ? base.slice() : [];
  Array.from(incoming || []).forEach(file=>{
    const key = mjFileKey(file);
    if(input.multiple){ if(seen.has(key)) return; seen.add(key); list.push(file); }
    else { list.splice(0, list.length, file); }
  });
  setMjInputFiles(input, list);
  try { input.value = ''; } catch {}
}
function removeMjInputFile(input, idx){
  if(!input) return;
  const list = getMjInputFiles(input);
  list.splice(Number(idx || 0), 1);
  setMjInputFiles(input, list);
  try { input.value = ''; } catch {}
}
function fileIcon(it){
  const t = String(it.type || '').toLowerCase();
  const n = String(it.name || '').toLowerCase();
  if(t.startsWith('image/')) return '🖼';
  if(t.includes('pdf') || n.endsWith('.pdf')) return '📕';
  if(/\.(doc|docx)$/i.test(n)) return '📘';
  if(/\.(xls|xlsx|csv)$/i.test(n)) return '📊';
  if(/\.(zip|rar|7z)$/i.test(n)) return '🗜';
  return '📄';
}

async function addFiles(files, target){
  const arr = await Promise.all([...files].filter(f => f.type.startsWith('image/')).map(fileToData));
  if(target === 'main') mainImages.push(...arr); else refImages.push(...arr);
  renderThumbs(); calcEstimate();
}

function renderThumbs(){
  renderThumbList('#mainThumbs', mainImages, 'main');
  renderThumbList('#refThumbs', refImages, 'ref');
}
function renderThumbList(sel, arr, type){
  $(sel).innerHTML = arr.map((it,i)=>`<div class="thumb-wrap"><img class="thumb draggable-generated-thumb" draggable="true" src="${it.data}" data-preview="${it.data}" data-full-url="${it.data}" data-id="input_${type}_${i}" data-name="${escapeHtml(it.name||'input-image.png')}"><button class="thumb-del" data-type="${type}" data-i="${i}">×</button></div>`).join('');
  $$(sel+' .thumb').forEach(img => img.addEventListener('click', () => showPreview(img.dataset.preview)));
  $$(sel+' .thumb').forEach(img => img.addEventListener('dragstart', e => {
    setImageDragData(e, {fullUrl: img.dataset.fullUrl || img.dataset.preview, filename: img.dataset.name || 'input-image.png'});
  }));
  $$(sel+' .thumb-del').forEach(btn => btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    const i = Number(btn.dataset.i);
    if(btn.dataset.type === 'main') mainImages.splice(i,1); else refImages.splice(i,1);
    renderThumbs(); calcEstimate();
  }));
}

function getPromptUnits(){
  const promptsRaw = $('#prompts').value.trim();
  const multi = isPromptMultilineTasksEnabled();
  if(!promptsRaw) return {count:1, mode: multi ? '多行多任务' : '完整提示词'};
  if(!multi) return {count:1, mode:'完整提示词'};
  const blankParts = promptsRaw.split(/\n\s*\n+/).map(x=>x.trim()).filter(Boolean);
  const lineParts = promptsRaw.split('\n').map(x=>x.trim()).filter(Boolean);
  return {count:(blankParts.length > 1 ? blankParts.length : (lineParts.length || 1)), mode:'多行多任务'};
}
function calcEstimate(){
  const promptInfo = getPromptUnits();
  const mainCount = Math.max(1, mainImages.length);
  const repeatCount = Math.max(1, Number($('#repeatCount').value || 1));
  $('#taskEstimate').textContent = `当前模式：${promptInfo.mode}｜预计任务：${mainCount} × ${promptInfo.count} × ${repeatCount} = ${mainCount * promptInfo.count * repeatCount}`;
}

$('#clearMainImagesBtn')?.addEventListener('click',()=>{ mainImages=[]; renderThumbs(); calcEstimate(); toast('主图已清空'); });
$('#clearRefImagesBtn')?.addEventListener('click',()=>{ refImages=[]; renderThumbs(); calcEstimate(); toast('参考图已清空'); });
$('#clearAllInputImagesBtn')?.addEventListener('click',()=>{ mainImages=[]; refImages=[]; renderThumbs(); calcEstimate(); toast('全部图片已清空'); });

$('#prompts').addEventListener('input', calcEstimate);
$('#promptMultilineTasks')?.addEventListener('change', calcEstimate);
$('#repeatCount').addEventListener('input', calcEstimate);
$('#modelPreset').addEventListener('change', updateModelFromPreset);
$('#model')?.addEventListener('input', ()=>{ updateSizeHint(); updateOfficialImageOptions(); });
$('#size').addEventListener('change', updateSizeHint);
$('#customWidth').addEventListener('input', updateSizeHint);
$('#customHeight').addEventListener('input', updateSizeHint);
$('#servicePort')?.addEventListener('input', ()=>updateLanDisplay({lan_enabled: $('#lanEnabled').checked, port:Number($('#servicePort').value||7868)}));
$('#backgroundKeepalive')?.addEventListener('change', ()=>enableKeepAlive($('#backgroundKeepalive').checked));
$('#themeMode')?.addEventListener('change', ()=>{ if($('#themeModeQuick')) $('#themeModeQuick').value = $('#themeMode').value; applyThemeMode($('#themeMode').value); });
$('#themeModeQuick')?.addEventListener('change', ()=>{ $('#themeMode').value = $('#themeModeQuick').value; applyThemeMode($('#themeModeQuick').value); });
$('#clarity')?.addEventListener('change', ()=>{ if($('#claritySettings')) $('#claritySettings').value = $('#clarity').value; updateSizeHint(); });
$('#claritySettings')?.addEventListener('change', ()=>{ if($('#clarity')) $('#clarity').value = $('#claritySettings').value; updateSizeHint(); });
$('#outputFormat')?.addEventListener('change', updateOfficialImageOptions);
$('#apiEndpoint')?.addEventListener('change', ()=>{ try{ saveClientConfig(readCurrentImageFormConfig()); }catch(e){} });
$('#addAnnouncementItemBtn')?.addEventListener('click', ()=>{
  const enabled = $('#announcementCustomEnabled');
  if(enabled) enabled.checked = true;
  const items = getAnnouncementEditorItemsFromDom();
  items.push({_id:`ann_${Date.now()}`, title:'', tag:'自定义', content:''});
  renderAnnouncementCustomEditor(items);
  const cards = $$('#announcementCustomList .announcement-item-card');
  cards[cards.length - 1]?.querySelector('[data-ann-field="title"]')?.focus();
});
document.addEventListener('click', (e)=>{ const btn=e.target.closest('[data-remove-announcement]'); if(!btn) return; const items=getAnnouncementEditorItemsFromDom().filter(it=>it._id !== btn.dataset.removeAnnouncement); renderAnnouncementCustomEditor(items); });

function setupDrop(id, inputId, target){
  const dz = $(id), input = $(inputId);
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', async e => { e.preventDefault(); dz.classList.remove('drag'); if(await handleGeneratedImageDrop(e, target)) return; addFiles(e.dataTransfer.files, target); });
  input.addEventListener('change', () => addFiles(input.files, target));
}
setupDrop('#mainDrop', '#mainFiles', 'main');
setupDrop('#refDrop', '#refFiles', 'ref');
function setupChatDrop(){
  const dz = $('#chatDrop'), input = $('#chatFiles');
  if(!dz || !input) return;
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', async e => { e.preventDefault(); dz.classList.remove('drag'); if(await handleGeneratedImageDrop(e, 'chat')) return; addChatImages(e.dataTransfer.files); });
  input.addEventListener('change', () => addChatImages(input.files));
}
setupChatDrop();

document.addEventListener('paste', async e => {
  const items = [...(e.clipboardData?.items || [])];
  const clipboardFiles = [...(e.clipboardData?.files || [])];
  if(!items.length && !clipboardFiles.length) return;
  if($('#assetLibraryLayer')?.classList.contains('active')){
    const assetFiles = [...clipboardFiles];
    if(!assetFiles.length){
      items.forEach(it=>{ const file = typeof it.getAsFile === 'function' ? it.getAsFile() : null; if(file) assetFiles.push(file); });
    }
    if(assetFiles.length){
      e.preventDefault();
      e.stopImmediatePropagation();
      await assetUploadFiles(assetFiles);
    }
    return;
  }
  const imageFiles = [];
  const videoFiles = [];
  for(const it of items){
    const type = String(it.type || '').toLowerCase();
    const file = typeof it.getAsFile === 'function' ? it.getAsFile() : null;
    if(!file) continue;
    if(type.startsWith('image/')) imageFiles.push(file);
    else if(type.startsWith('video/')) videoFiles.push(file);
  }
  if(!imageFiles.length && !videoFiles.length) return;

  if($('#page-video')?.classList.contains('active')){
    e.preventDefault();
    let addedVideo = 0, addedImage = 0;
    if(videoFiles.length){
      await handleVideoFile(videoFiles);
      addedVideo = videoFiles.length;
    }
    if(imageFiles.length){
      await handleVideoRefs(imageFiles);
      addedImage = imageFiles.length;
    }
    if(addedVideo || addedImage){
      const msg = [];
      if(addedVideo) msg.push(`主任务视频 ${addedVideo} 个`);
      if(addedImage) msg.push(`参考图 ${addedImage} 张`);
      toast(`已通过粘贴加入：${msg.join('，')}`);
    }
    return;
  }

  if($('#page-chat')?.classList.contains('active')){
    e.preventDefault();
    await addChatImages([...imageFiles, ...videoFiles]);
    return;
  }
  if(!imageFiles.length) return;
  e.preventDefault();
  addFiles(imageFiles, 'main');
});


function normalizePublicAccessUrl(raw=''){
  const s = String(raw || '').trim();
  if(!s) return '';
  try{
    const u = new URL(s, location.origin);
    if(!/^https?:$/i.test(u.protocol)) return s;
    return u.origin;
  }catch{
    return s.replace(/(https?:\/\/[^\s\/]+).*/i, '$1');
  }
}

function updatePublicStatus(status = {}, cfg = {}){
  const running = !!(status.running || cfg.public_enabled || isPublicClient);
  // 公网访问端始终显示当前浏览器打开的访问端链接；主机端只显示公网访问入口 origin，不显示 /public-video 临时上传链接。
  const url = isPublicClient ? window.location.origin : normalizePublicAccessUrl(status.url || cfg.public_url || '');
  const provider = status.provider || cfg.public_provider || '';
  if($('#publicStatusBox')) $('#publicStatusBox').textContent = running ? `已开启：${provider}` : '未开启';
  if($('#publicUrl')) $('#publicUrl').value = url || '';
  if($('#publicLogs')) $('#publicLogs').textContent = (status.logs || []).join('\n') || status.last_error || '-';
  if($('#publicReadonlyStatus')) $('#publicReadonlyStatus').value = running ? `已开启${provider ? '：' + provider : ''}` : '未开启';
  if($('#publicReadonlyUrl')) $('#publicReadonlyUrl').value = url || '';
  if($('#publicReadonlyPassword')) $('#publicReadonlyPassword').value = isLocalClient ? (cfg.public_password || '') : '已通过访问密码验证';
  // 局域网/公网访问公网页面只看公网访问状态，不展示使用说明和本机配置。
  $('#publicHelpCard')?.classList.toggle('hidden', !isLocalClient);
}
async function refreshPublicStatus(){
  // 局域网/公网访问端也允许查看公网状态，但只显示只读区域。
  try{
    const ret = await api('/api/public_status');
    updatePublicStatus(ret.status, ret.config);
  }catch(e){ if($('#publicLogs')) $('#publicLogs').textContent = e.message || String(e); }
}
function collectPublicConfig(){
  return {
    provider: $('#publicProvider')?.value || 'cloudflare',
    public_password: $('#publicPassword')?.value?.trim() || '',
    public_permission: $('#publicPermission')?.value || 'generate',
    cloudflared_path: $('#cloudflaredPath')?.value?.trim() || 'cloudflared',
    ngrok_path: $('#ngrokPath')?.value?.trim() || 'ngrok',
    manual_url: $('#manualPublicUrl')?.value?.trim() || ''
  };
}

function collectConfig(){
  const imagePlatform = currentImagePlatform();
  const endpointValue = $('#apiEndpoint')?.value?.trim() || (imagePlatform === 'grsai' ? 'https://grsaiapi.com' : 'https://api.apimart.ai');
  const announcementItems = normalizeAnnouncementItems(getAnnouncementEditorItemsFromDom());
  return {
    image_api_platform: imagePlatform,
    legacy_api_endpoint: imagePlatform === 'grsai' ? endpointValue : (loadClientConfig().legacy_api_endpoint || 'https://grsaiapi.com'),
    api_endpoint: endpointValue,
    api_key: $('#apiKey')?.value?.trim() || '',
    model: $('#model').value.trim() || 'gemini-3.1-flash-image-preview',
    size: getSizeValue(),
    clarity: $('#clarity')?.value || $('#claritySettings')?.value || '1K',
    quality: $('#imageQuality')?.value || 'auto',
    background: $('#imageBackground')?.value || 'auto',
    moderation: $('#moderation')?.value || 'auto',
    output_format: $('#outputFormat')?.value || 'png',
    output_compression: Number($('#outputCompression')?.value || 90),
    image_n: Math.max(1, Math.min(15, Number($('#imageN')?.value || 1))),
    theme_mode: $('#themeMode')?.value || $('#themeModeQuick')?.value || 'auto',
    concurrency: Number($('#concurrency').value || 30),
    retry_times: Number($('#retryTimes').value || 0),
    repeat_count: Math.max(1, Number($('#repeatCount').value || 1)),
    poll_interval_ms: Number($('#pollInterval').value || 800),
    timeout_seconds: Number($('#timeoutSeconds').value || 1200),
    apimart_proxy_url: $('#apimartProxyUrl')?.value?.trim() || '',
    app_name: $('#appName')?.value?.trim() || 'TENYING_AI 1.0',
    background_keepalive: $('#backgroundKeepalive') ? $('#backgroundKeepalive').checked : true,
    device_data_isolation: $('#deviceDataIsolation') ? $('#deviceDataIsolation').checked : true,
    prompt_multiline_tasks: isPromptMultilineTasksEnabled(),
    prompt_library_permission_shared: $('#promptLibraryPermissionShared') ? $('#promptLibraryPermissionShared').checked : false,
    announcement_url: $('#announcementUrl')?.value?.trim() || 'https://apimart.ai/zh/log-updates',
    announcement_custom_enabled: $('#announcementCustomEnabled') ? $('#announcementCustomEnabled').checked : false,
    announcement_custom_items: announcementItems,
    announcement_custom_title: announcementItems[0]?.title || '',
    announcement_custom_content: announcementItems[0]?.content || '',
    mj_settings: collectMjCurrentSettings(),
    mj_tab: mjState?.tab || 'imagine',
    output_dir: $('#outputDir').value.trim(),
    log_keep_days: Number($('#logKeepDays').value || 3),
    lan_enabled: $('#lanEnabled').checked,
    port: Number($('#servicePort')?.value || 7861)
  };
}

async function handleConfigSave(payload, successMsg='当前设置已保存'){
  try{
    const currentApiKey = $('#apiKey')?.value?.trim() || payload.api_key || '';
    payload = { ...payload, api_key: currentApiKey };
    saveClientConfig(payload);
    saveCurrentClientSettings(payload);
    if(!isLocalClient){
      toast('当前设置已保存到此设备浏览器，不会共享给其他用户');
      return {ok:true, client_only:true};
    }
    const ret = await api('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    toast(successMsg || '当前设置已保存到主机本地');
    if(ret.config){
      updateLanDisplay(ret.config);
      updateAppTitle(ret.config.app_name || payload.app_name || 'TENYING_AI 1.0');
      if($('#appName')) $('#appName').value = ret.config.app_name || payload.app_name || 'TENYING_AI 1.0';
      if($('#backgroundKeepalive')) $('#backgroundKeepalive').checked = ret.config.background_keepalive !== false;
      if($('#clarity')) $('#clarity').value = ret.config.clarity || payload.clarity || '1K';
      if($('#claritySettings')) $('#claritySettings').value = ret.config.clarity || payload.clarity || '1K';
      applyThemeMode(ret.config.theme_mode || payload.theme_mode || 'auto');
      enableKeepAlive($('#backgroundKeepalive')?.checked);
      loadAnnouncements(true, false).catch(()=>{});
    }
    if($('#apiKey') && currentApiKey) $('#apiKey').value = currentApiKey;
    updateApiKeyWarning();
    if(ret.runtime?.port_changed && ret.config?.port){
      const target = `${window.location.protocol}//${window.location.hostname}:${ret.config.port}`;
      toast(`端口已切换到 ${ret.config.port}，正在自动跳转...`);
      setTimeout(()=>{ window.location.href = target; }, 1800);
      return ret;
    }
    return ret;
  }catch(e){
    alert(e.message || '保存失败');
    throw e;
  }
}

$('#apiKey')?.addEventListener('input', updateApiKeyWarning);
$('#saveConfigBtn').addEventListener('click', async()=>{ updateApiKeyWarning(); await handleConfigSave(collectConfig(), isLocalClient ? '当前设置已保存到主机本地' : '当前设置已保存到此设备浏览器，不会共享给其他用户'); });
$('#saveLanBtn').addEventListener('click', async()=>{ await handleConfigSave({lan_enabled:$('#lanEnabled').checked, port:Number($('#servicePort').value||7868)}, '局域网设置已保存，已立即生效'); });
$('#saveSettingsBtn').addEventListener('click', async()=>{ await handleConfigSave(collectConfig(), '设置已保存'); });
$('#checkUpdateBtn')?.addEventListener('click', checkSoftwareUpdate);
const CLEAR_ALL_CONFIRM_TEXT = '清空所有数据';
function setClearAllModalError(text=''){
  const el = $('#clearAllDataError');
  if(!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}
function updateClearAllConfirmButton(){
  const input = $('#clearAllDataConfirmInput');
  const btn = $('#confirmClearAllDataBtn');
  if(btn) btn.disabled = !isLocalClient || (input?.value || '').trim() !== CLEAR_ALL_CONFIRM_TEXT;
}
function openClearAllDataModal(){
  if(!isLocalClient){ toast('只有主机端可以清除所有数据'); return; }
  setClearAllModalError('');
  const input = $('#clearAllDataConfirmInput');
  const btn = $('#confirmClearAllDataBtn');
  if(input) input.value = '';
  if(btn){ btn.disabled = true; btn.textContent = '确认清空'; }
  $('#clearAllDataModal')?.classList.add('active');
  setTimeout(()=>input?.focus(), 80);
}
function closeClearAllDataModal(){
  $('#clearAllDataModal')?.classList.remove('active');
  setClearAllModalError('');
}
async function clearBrowserProjectCaches(){
  try{
    localStorage.clear();
    sessionStorage.clear();
    document.cookie.split(';').forEach(c=>{ document.cookie = c.replace(/^ +/,'').replace(/=.*/, '=;expires=' + new Date(0).toUTCString() + ';path=/'); });
    if(window.indexedDB && indexedDB.databases){
      const dbs = await indexedDB.databases().catch(()=>[]);
      for(const db of dbs || []) if(db && db.name) indexedDB.deleteDatabase(db.name);
    }
  }catch(_e){}
}
async function executeClearAllData(){
  const input = $('#clearAllDataConfirmInput');
  const btn = $('#confirmClearAllDataBtn');
  const text = (input?.value || '').trim();
  if(text !== CLEAR_ALL_CONFIRM_TEXT) { updateClearAllConfirmButton(); return; }
  setClearAllModalError('');
  if(btn){ btn.disabled = true; btn.textContent = '清空中...'; }
  try{
    const ret = await api('/api/clear_all_cache',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm_text:CLEAR_ALL_CONFIRM_TEXT})});
    await clearBrowserProjectCaches();
    selectedImages?.clear?.();
    mainImages = [];
    refImages = [];
    chatImages = [];
    chatConversations = [];
    currentChatId = '';
    batches = [];
    $('#batchList') && ($('#batchList').innerHTML = '');
    $('#historyRows') && ($('#historyRows').innerHTML = '');
    $('#imageGrid') && ($('#imageGrid').innerHTML = '');
    $('#miniBatches') && ($('#miniBatches').innerHTML = '');
    $('#miniImages') && ($('#miniImages').innerHTML = '');
    $('#bottomLogs') && ($('#bottomLogs').innerHTML = '');
    $('#statTotal').textContent = '0';
    $('#statDone').textContent = '0';
    $('#statFail').textContent = '0';
    $('#statRunning').textContent = '0';
    closeClearAllDataModal();
    toast('所有数据已清除，正在恢复默认状态...');
    setTimeout(()=>window.location.reload(), 1000);
  }catch(e){
    setClearAllModalError(e.message || '清除失败');
    if(btn){ btn.disabled = false; btn.textContent = '确认清空'; }
    updateClearAllConfirmButton();
  }
}
$('#clearAllCacheBtn')?.addEventListener('click', openClearAllDataModal);
$('#cancelClearAllDataBtn')?.addEventListener('click', closeClearAllDataModal);
$('#clearAllDataConfirmInput')?.addEventListener('input', updateClearAllConfirmButton);
$('#confirmClearAllDataBtn')?.addEventListener('click', executeClearAllData);
$('#clearAllDataModal')?.addEventListener('click', (e)=>{ if(e.target?.id === 'clearAllDataModal') closeClearAllDataModal(); });
$('#startPublicBtn')?.addEventListener('click', async()=>{
  try{
    const ret = await api('/api/public_start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(collectPublicConfig())});
    updatePublicStatus(ret, ret.config || {});
    toast('公网访问已启动，等待公网链接生成');
    setTimeout(refreshPublicStatus, 2500);
    setTimeout(refreshPublicStatus, 6000);
  }catch(e){ alert(e.message || '开启失败'); }
});
$('#stopPublicBtn')?.addEventListener('click', async()=>{
  try{ const ret = await api('/api/public_stop',{method:'POST'}); updatePublicStatus(ret.status || {}, {}); toast('公网访问已关闭'); }
  catch(e){ alert(e.message || '关闭失败'); }
});
$('#refreshPublicBtn')?.addEventListener('click', refreshPublicStatus);
$('#copyPublicUrlBtn')?.addEventListener('click', async()=>{
  const u = $('#publicUrl')?.value || '';
  if(!u) return alert('还没有公网链接');
  await copyTextSmart(u, '公网链接'); toast('公网链接已复制');
});
$('#openPublicUrlBtn')?.addEventListener('click', ()=>{
  const u = $('#publicUrl')?.value || '';
  if(u) window.open(u, '_blank');
});
$('#fillToolConfigBtn')?.addEventListener('click', ()=>{ syncToolConfigFromHome(); toast('已同步首页 API 配置'); });
$('#checkModelStatusBtn')?.addEventListener('click', ()=>runGrsaiTool('model_status'));
$('#checkAccountCreditsBtn')?.addEventListener('click', ()=>runGrsaiTool('account_credits'));
$('#checkApiKeyCreditsBtn')?.addEventListener('click', ()=>runGrsaiTool('api_key_credits'));
$$('.tool-action').forEach(btn=>btn.addEventListener('click', ()=>runGrsaiTool(btn.dataset.action)));
$('#chatModelPreset')?.addEventListener('change', ()=>{ updateChatModelFromPreset(); saveChatConfig(); });
$('#chatModelSearch')?.addEventListener('input', handleChatModelSearchInput);
$$('#chatStream,#chatMaxTokens,#chatTemperature,#chatTopP,#chatTopK,#chatPresencePenalty,#chatFrequencyPenalty,#chatModel,#chatSystemPrompt').forEach(el=>el?.addEventListener('change', saveChatConfig));
$('#chatFullscreenBtn')?.addEventListener('click', toggleChatContextFullscreen);
$('#toggleChatWindowMax')?.addEventListener('click', toggleChatContextFullscreen);
$('#sendChatBtn')?.addEventListener('click', sendChat);
$('#clearChatBtn')?.addEventListener('click', clearChat);
$('#newChatBtn')?.addEventListener('click', ()=>createNewChat(true));
$('#clearChatImagesBtn')?.addEventListener('click', clearChatImages);
$('#chatInput')?.addEventListener('keydown', e=>{ if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); sendChat(); } });

$('#startBatchBtn').addEventListener('click', async()=>{
  updateApiKeyWarning();
  if(!($('#apiKey')?.value || '').trim()){
    toast('API Key 未填写，请先填写后再开始生成');
    return;
  }
  const body = {...collectConfig(), client_id:getClientId(), prompts: $('#prompts').value, prompt_multiline_tasks: isPromptMultilineTasksEnabled(), main_images: mainImages, reference_images: refImages};
  $('#startBatchBtn').disabled = true; $('#startBatchBtn').textContent = '提交中...';
  try{
    const ret = await api('/api/batches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    await refreshAll();
    toast(`批次已创建：${ret.task_count} 个任务，已在右侧实时面板运行`);
  }catch(e){ alert('创建失败：'+e.message); }
  finally{ $('#startBatchBtn').disabled = false; $('#startBatchBtn').textContent = '开始生成新批次'; }
});

async function refreshAll(){
  // V14.5.6：防止 3 秒定时刷新发生重入。网络慢/下载多时，旧版会堆叠多个 refreshAll，导致界面无响应。
  if(refreshAllInFlight){ refreshAllQueued = true; return; }
  refreshAllInFlight = true;
  try{
    const logsActive = $('#page-api')?.classList.contains('active') || $('#page-logs')?.classList.contains('active');
    const needLogs = logsActive || Date.now() - lastLogsLoadAt > 9000;
    const jobs = isInlineNoteEditing ? [loadStatus()] : [loadStatus(), loadBatches()];
    if(needLogs){ lastLogsLoadAt = Date.now(); jobs.push(loadLogs()); }
    await Promise.all(jobs);
    const imagesActive = $('#page-images')?.classList.contains('active');
    if(imagesActive && !document.body.classList.contains('mobile-ui')) await loadImages();
    if($('#page-history')?.classList.contains('active')) renderHistory();
    if($('#page-video')?.classList.contains('active')) await loadVideoTasks();
  } finally {
    refreshAllInFlight = false;
    if(refreshAllQueued){ refreshAllQueued = false; setTimeout(refreshAll, 600); }
  }
}


function isVideoRealtimeMode(){ return !$('#videoRealtimePanel')?.classList.contains('hidden'); }
function setRightPanelStatLabels(video=false){
  const stats = $$('.right-panel .stats div span');
  if(stats[0]) stats[0].textContent = video ? '今日视频任务' : '今日总任务';
  if(stats[1]) stats[1].textContent = '今日已完成';
  if(stats[2]) stats[2].textContent = '今日失败';
  if(stats[3]) stats[3].textContent = '今日生成中';
}
function updateRightPanelStats(data, video=false){
  setRightPanelStatLabels(video);
  $('#statTotal').textContent = data?.total ?? 0;
  $('#statDone').textContent = data?.done ?? 0;
  $('#statFail').textContent = data?.fail ?? 0;
  $('#statRunning').textContent = data?.running ?? 0;
}
async function loadStatus(){
  const s = await api('/api/status');
  if(isVideoRealtimeMode() && s.video_stats) updateRightPanelStats(s.video_stats, true);
  else updateRightPanelStats(s, false);
  $('#apiState').textContent = `API：${s.api.status}`;
  $('#runningState').textContent = `运行：${s.running}`;
  $('#apiMetricStatus').textContent = s.api.status;
  const hc = s.host_cumulative || {};
  $('#apiMetricRunning').textContent = typeof hc.running_tasks !== 'undefined' ? hc.running_tasks : s.running;
  $('#apiMetricDone').textContent = typeof hc.completed_tasks !== 'undefined' ? hc.completed_tasks : s.done;
  if($('#apiMetricImages')) $('#apiMetricImages').textContent = typeof hc.total_tasks !== 'undefined' ? hc.total_tasks : 0;
  $('#apiMetricFail').textContent = typeof hc.failed_tasks !== 'undefined' ? hc.failed_tasks : s.fail;
  if(typeof s.is_local_client !== 'undefined'){ isLocalClient = s.is_local_client !== false; isPublicClient = s.is_public_client === true; applyPermissionUI(); }
  if(s.local_url || s.lan_url) updateLanDisplay({lan_enabled: $('#lanEnabled').checked, ...s});
  // V9.1: API监控中心保持简化；右侧实时任务面板保留最近图片和最近批次。
  renderMiniBatches(s.batches || []);
  renderImageTaskProgress(s.image_task_progress || []);
  loadMiniImages(s.image_task_progress || []);
}

async function loadBatches(){
  const next = await api('/api/batches');
  try { historyBatches = await api('/api/history_batches'); }
  catch { historyBatches = next.map(b=>({...b,batch_type:'image'})); }
  const sig = stableSig(next.map(b=>[b.id,b.status,b.task_count,b.success_count,b.fail_count,b.running_count,b.note,b.updated_at]));
  batches = next;
  if(sig !== lastBatchesSignature){
    lastBatchesSignature = sig;
    renderBatches();
    fillBatchSelect();
  } else {
    updateBatchDurationBadges();
  }
}
function renderBatches(){
  if(!$('#batchList')) return;
  let list = batches;
  if(currentBatchFilter !== 'all') list = list.filter(b => b.status === currentBatchFilter || (currentBatchFilter==='生成中' && ['生成中','等待中'].includes(b.status)));
  $('#batchList').innerHTML = list.map(batchCard).join('') || '<div class="card">暂无批次</div>';
  $$('.act-delete').forEach(b=>b.addEventListener('click',()=>deleteBatch(b.dataset.id, b)));
  $$('.act-repeat').forEach(b=>b.addEventListener('click',()=>repeatBatch(b.dataset.id)));
  $$('.act-zip').forEach(b=>b.addEventListener('click',()=>exportZip(b.dataset.id)));
  $$('.act-images').forEach(b=>b.addEventListener('click',()=>{ currentImageBatch=b.dataset.id; setPage('images'); loadImages(); }));
  $$('.batch-edit-note').forEach(el=>el.addEventListener('dblclick',()=>beginInlineNoteEdit(el, el.dataset.id))); 
  updateBatchDurationBadges();
}
function batchCard(b){
  const p = percent(b);
  const note = (b.note || '').trim();
  return `<div class="batch-card">
    <div class="batch-top"><div><div class="batch-name batch-edit-note" data-id="${b.id}" title="双击修改备注">${escapeHtml(b.name)}</div><div class="batch-meta">创建：${formatBeijingTime(b.created_at)}</div><div class="batch-note batch-edit-note" data-id="${b.id}" title="双击修改备注">备注：${escapeHtml(note || '双击这里添加备注名')}</div></div><div class="batch-top-status">${batchDurationMarkup(b)}<span class="status ${statusClass(b.status)}">${b.status}</span></div></div>
    <div class="progress"><div class="bar" style="width:${p}%"></div></div>
    <div class="batch-meta"><span>模型：${escapeHtml(b.model)}</span><span>尺寸：${b.size}</span><span>并发：${b.concurrency}</span><span>任务：${b.task_count}</span><span>成功：${b.success_count}</span><span>失败：${b.fail_count}</span><span>进度：${p}%</span></div>
    <div class="actions"><button class="secondary act-images" data-id="${b.id}">查看图片</button><button class="secondary act-repeat" data-id="${b.id}">重复批次</button><button class="primary act-zip" data-id="${b.id}">导出全部ZIP</button><button class="danger act-delete" data-id="${b.id}">删除</button></div>
  </div>`;
}
$$('.filters:not(.history-filters) .chip').forEach(c=>c.addEventListener('click',()=>{ $$('.filters:not(.history-filters) .chip').forEach(x=>x.classList.remove('active')); c.classList.add('active'); currentBatchFilter = c.dataset.filter; renderBatches(); }));
async function deleteBatch(id, btn){
  if(!id) return;
  const now = Date.now();
  if(!btn || btn.dataset.confirmDelete !== '1' || now > Number(btn.dataset.confirmUntil || 0)){
    if(btn){
      btn.dataset.confirmDelete = '1';
      btn.dataset.confirmUntil = String(now + 3000);
      btn.textContent = '再次点击确认删除';
      btn.classList.add('confirming');
      setTimeout(()=>{ if(btn.dataset.confirmDelete === '1' && Date.now() > Number(btn.dataset.confirmUntil || 0)){ btn.dataset.confirmDelete='0'; btn.textContent='删除'; btn.classList.remove('confirming'); } }, 3100);
    }
    return;
  }
  btn.disabled = true;
  btn.textContent = '删除中...';
  try{
    await api('/api/delete_batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch_id:id})});
    toast('批次及对应图片缓存已删除');
    await refreshAll();
  }catch(e){ alert(e.message || '删除失败'); btn.disabled=false; btn.textContent='删除'; btn.dataset.confirmDelete='0'; }
}
async function stopBatch(id){ return deleteBatch(id); }
async function repeatBatch(id){ const r = await api('/api/repeat_batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch_id:id, api_key:$('#apiKey')?.value?.trim() || ''})}); await refreshAll(); toast('已重复创建新批次'); }
async function exportZip(id){ const r = await api('/api/export_zip?batch_id='+id); if(r.url) window.open(withPublicAccess(r.url),'_blank'); }
async function exportDescribeXlsx(id){
  const r = await api('/api/export_describe_xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch_id:id})});
  if(r.url) window.open(withPublicAccess(r.url),'_blank');
}
function ensureDescribeResultModal(){
  let modal = $('#describeResultModal');
  if(modal) return modal;
  modal = document.createElement('div');
  modal.id = 'describeResultModal';
  modal.className = 'describe-result-modal';
  modal.innerHTML = `<div class="describe-result-card"><button class="describe-result-close" type="button">×</button><div class="describe-result-head"><div><h2>图生文提示词结果</h2><div class="describe-result-summary" id="describeResultSummary"></div></div><button class="primary" id="describeResultExportBtn" type="button">下载表格</button></div><div class="describe-result-list" id="describeResultList"></div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('.describe-result-close')?.addEventListener('click',()=>modal.classList.remove('active'));
  modal.addEventListener('click', e=>{ if(e.target === modal) modal.classList.remove('active'); });
  return modal;
}
async function showDescribeBatchResults(id){
  const modal = ensureDescribeResultModal();
  const list = modal.querySelector('#describeResultList');
  modal.dataset.batchId = id;
  list.innerHTML = '<div class="mj-inline-note">正在加载图生文结果...</div>';
  modal.classList.add('active');
  const exportBtn = $('#describeResultExportBtn');
  if(exportBtn) exportBtn.onclick = ()=>exportDescribeXlsx(modal.dataset.batchId || id);
  try{
    const ret = await api('/api/mj_describe_batch?batch_id=' + encodeURIComponent(id));
    const rows = Array.isArray(ret.rows) ? ret.rows : [];
    const done = rows.filter(r=>/已完成|success|completed|done/i.test(String(r.status||''))).length;
    const fail = rows.filter(r=>/失败|fail|error|cancel/i.test(String(r.status||''))).length;
    const summary = $('#describeResultSummary');
    if(summary) summary.textContent = `批次：${ret.batch?.note || ret.batch?.name || id} · 总图片数：${rows.length} · 已完成：${done} · 失败：${fail}`;
    list.innerHTML = rows.map((row, idx)=>{
      const texts = Array.isArray(row.result_texts) ? row.result_texts : [];
      const fullUrl = row.full_url ? withPublicAccess(row.full_url) : '';
      return `<div class="describe-result-item">
        <div class="describe-result-thumb-wrap" ${fullUrl ? `data-full-url="${escapeHtml(fullUrl)}"` : ''}>${row.thumb_url ? `<img src="${withPublicAccess(row.thumb_url)}" loading="lazy" onerror="this.replaceWith(document.createTextNode('图片加载失败'))" />` : '<span>无预览图</span>'}</div>
        <div class="describe-result-body">
          <h3>图片 ${idx+1}</h3>
          <div class="small-note">状态：${escapeHtml(row.status || '-')} · 任务ID：${escapeHtml(row.task_id || row.local_task_id || '-')}</div>
          ${row.error_message ? `<div class="describe-error">${escapeHtml(row.error_message)}</div>` : ''}
          <div class="describe-prompts"><h4>提示词结果：</h4>${texts.map((txt,i)=>`<div class="describe-prompt-row"><b>${i+1}.</b><p>${escapeHtml(txt)}</p></div>`).join('') || '<div class="mj-inline-note">暂无提示词结果</div>'}</div>
          <div class="describe-copy-actions">${texts.map((txt,i)=>`<button class="secondary" type="button" data-copy-describe="${escapeHtml(txt)}">复制结果${i+1}</button>`).join('')}<button class="secondary" type="button" data-copy-describe="${escapeHtml(texts.join('\\n\\n'))}">复制全部</button></div>
        </div>
      </div>`;
    }).join('') || '<div class="mj-inline-note">该批次暂无图生文结果</div>';
    list.querySelectorAll('[data-copy-describe]').forEach(btn=>btn.addEventListener('click',()=>copyTextSmart(btn.dataset.copyDescribe || '', '提示词结果')));
    list.querySelectorAll('.describe-result-thumb-wrap[data-full-url]').forEach(el=>el.addEventListener('click',()=>showPreview(el.dataset.fullUrl, {fullUrl:el.dataset.fullUrl, model:'Midjourney Describe'})));
  }catch(e){
    list.innerHTML = `<div class="describe-error">${escapeHtml(e.message || '加载失败')}</div>`;
  }
}
async function exportSelectedBatchesZip(){
  const ids = Array.from(selectedHistoryBatches);
  if(!ids.length){ toast('请先选择批次'); return; }
  const btn = $('#downloadSelectedBatchesBtn');
  if(btn){ btn.disabled = true; btn.textContent = '正在打包...'; }
  try{
    const videoIds = ids.flatMap(id=>videoHistoryBatchById(id)?.video_ids || []);
    const imageIds = ids.filter(id=>!videoHistoryBatchById(id));
    if(videoIds.length && imageIds.length) toast('已选择图片批次和视频批次，将分别打包下载');
    if(imageIds.length){
      const r = await api('/api/export_batches_zip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch_ids:imageIds})});
      if(r.url) window.open(withPublicAccess(r.url),'_blank');
    }
    if(videoIds.length){
      const r = await api('/api/video_export_selected',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:videoIds})});
      if(r.url) window.open(withPublicAccess(r.url),'_blank');
    }
    toast(ids.length === 1 ? '选中批次已生成下载文件' : `已打包 ${ids.length} 个批次`);
  }catch(e){
    toast(e.message || '下载选中批次失败');
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '下载选中批次图片'; }
  }
}
function currentBatchNote(id){
  const b = batches.find(x=>x.id===id);
  return b?.note || '';
}

function beginInlineNoteEdit(el, id){
  if(!el || el.dataset.editing === '1') return;
  isInlineNoteEditing = true;
  el.dataset.editing = '1';
  const oldHTML = el.innerHTML;
  const input = document.createElement('input');
  input.className = 'inline-note-input';
  input.value = currentBatchNote(id);
  input.placeholder = '输入备注名，导出ZIP会使用这个名字';
  el.innerHTML = '';
  el.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  function restore(){
    done = true;
    isInlineNoteEditing = false;
    el.innerHTML = oldHTML;
    el.dataset.editing = '0';
  }
  async function save(){
    if(done) return;
    done = true;
    const val = input.value.trim();
    try{
      await api('/api/update_batch_note',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch_id:id,note:val})});
      isInlineNoteEditing = false;
      await refreshAll();
      toast('备注已更新');
    }catch(e){
      isInlineNoteEditing = false;
      el.innerHTML = oldHTML;
      el.dataset.editing = '0';
      alert(e.message || '备注保存失败');
    }
  }
  input.addEventListener('keydown', e=>{
    if(e.key === 'Enter') input.blur();
    if(e.key === 'Escape'){ restore(); }
  });
  input.addEventListener('blur', save, {once:true});
}

function renderHistory(){
  const q = ($('#historySearch').value || '').toLowerCase();
  const filter = currentBatchFilter || 'all';
  const list = batches.filter(b => {
    const status = String(b.status || '');
    const okFilter = filter === 'all' || status.includes(filter) || (filter === '生成中' && ['等待中','提交生成中','生成中'].includes(status));
    return okFilter && (!q || JSON.stringify(b).toLowerCase().includes(q));
  });
  const historySig = stableSig(list.map(b=>[b.id,b.status,b.task_count,b.success_count,b.fail_count,b.note,b.updated_at]));
  if(historySig === lastHistorySignature){ updateBatchDurationBadges(); return; }
  lastHistorySignature = historySig;
  $('#historyRows').innerHTML = list.map(b=>`<tr>
    <td>${formatBeijingTime(b.created_at)}</td>
    <td class="history-batch-cell history-edit-note" data-id="${b.id}" title="双击修改备注"><div>${escapeHtml(b.name)}</div><div class="small-note">备注：${escapeHtml((b.note||'').trim() || '双击添加备注名')}</div><div class="small-note history-duration-line">${batchDurationMarkup(b)} · 状态：${escapeHtml(b.status || '-')}</div></td>
    <td>${escapeHtml(b.model)}</td><td>${b.size}</td><td>${b.task_count}</td><td>${b.success_count}</td><td>${b.fail_count}</td>
    <td><button class="secondary" onclick="currentImageBatch='${b.id}';setPage('images');loadImages()">查看图片</button> <button class="secondary" onclick="repeatBatch('${b.id}')">重复</button> <button class="primary" onclick="exportZip('${b.id}')">下载全部</button> <button class="danger history-delete" data-id="${b.id}">删除</button></td>
  </tr>`).join('');
  $$('.history-edit-note').forEach(el=>el.addEventListener('dblclick',()=>beginInlineNoteEdit(el, el.dataset.id)));
  $$('.history-delete').forEach(btn=>btn.addEventListener('click',()=>deleteBatch(btn.dataset.id, btn)));
  updateBatchDurationBadges();
}
$('#historySearch').addEventListener('input', forceRenderHistory);
$$('.history-filters .chip').forEach(btn=>btn.addEventListener('click',()=>{ $$('.history-filters .chip').forEach(x=>x.classList.remove('active')); btn.classList.add('active'); currentBatchFilter = btn.dataset.filter || 'all'; forceRenderHistory(); }));

function updateHistorySelectionUi(){
  const count = selectedHistoryBatches.size;
  const bar = $('#historyBulkBar');
  if(bar) bar.classList.toggle('hidden', count === 0);
  if($('#historyBulkCount')) $('#historyBulkCount').textContent = `已选择 ${count} 个批次`;
  $$('.history-batch-check').forEach(ch=>{ ch.checked = selectedHistoryBatches.has(ch.dataset.historyBatchId); });
  $$('#historyRows tr[data-history-batch-id]').forEach(tr=>tr.classList.toggle('history-row-selected', selectedHistoryBatches.has(tr.dataset.historyBatchId)));
  const all = $('#historySelectAllBatches');
  if(all){
    const checks = $$('.history-batch-check');
    const checked = checks.filter(ch=>ch.checked).length;
    all.checked = checks.length > 0 && checked === checks.length;
    all.indeterminate = checked > 0 && checked < checks.length;
  }
}
function forceRenderHistory(){ lastHistorySignature = ''; renderHistory(); }
function isDescribeBatch(b={}){
  try{
    const cfg = JSON.parse(b.config_json || '{}') || {};
    return String(cfg.action || '').toLowerCase() === 'describe' || String(cfg.batch_type || '').toLowerCase() === 'mj_describe' || /^MJ_describe_/i.test(String(b.name || ''));
  }catch{
    return /^MJ_describe_/i.test(String(b.name || ''));
  }
}
function isVideoBatch(b={}){ return String(b.batch_type || '').toLowerCase() === 'video' || String(b.id || '').startsWith('video_batch_'); }
function videoHistoryBatchById(id){ return historyBatches.find(b=>b.id === id && isVideoBatch(b)) || null; }
async function openVideoBatchFromHistory(id){
  setPage('video-manage');
  await loadVideoTasks();
  setTimeout(()=>document.querySelector(`#videoManageGrid [data-video-batch="${CSS.escape(id)}"]`)?.scrollIntoView({behavior:'smooth', block:'start'}), 120);
}
async function exportVideoHistoryBatch(id){
  const b = videoHistoryBatchById(id);
  const ids = b?.video_ids || [];
  if(!ids.length) return toast('该视频批次没有可导出的视频任务');
  const r = await api('/api/video_export_selected',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
  if(r.url) window.open(withPublicAccess(r.url),'_blank');
}
async function deleteVideoHistoryBatch(id, btn){
  const b = videoHistoryBatchById(id);
  const ids = b?.video_ids || [];
  if(!ids.length) return toast('该视频批次没有可删除的视频任务');
  if(!confirm(`确定删除视频批次「${b.name || id}」里的 ${ids.length} 个视频任务吗？本地视频文件也会删除。`)) return;
  const old = btn?.textContent;
  if(btn){ btn.disabled = true; btn.textContent = '删除中'; }
  try{
    await api('/api/video_delete_selected',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
    selectedHistoryBatches.delete(id);
    await refreshAll();
    toast('视频批次已删除');
  }catch(e){
    if(btn){ btn.disabled = false; btn.textContent = old || '删除'; }
    alert(e.message || '删除视频批次失败');
  }
}
function historyBatchActions(b){
  if(isVideoBatch(b)){
    return `<button class="secondary" onclick="openVideoBatchFromHistory('${b.id}')">查看视频</button> <button class="primary" onclick="exportVideoHistoryBatch('${b.id}')">下载全部</button> <button class="danger history-video-delete" data-id="${b.id}">删除</button>`;
  }
  if(isDescribeBatch(b)){
    return `<button class="secondary" onclick="showDescribeBatchResults('${b.id}')">查看提示词结果</button> <button class="secondary" onclick="repeatBatch('${b.id}')">重复</button> <button class="primary" onclick="exportDescribeXlsx('${b.id}')">下载表格</button> <button class="danger history-delete" data-id="${b.id}">删除</button>`;
  }
  return `<button class="secondary" onclick="currentImageBatch='${b.id}';setPage('images');loadImages()">查看图片</button> <button class="secondary" onclick="repeatBatch('${b.id}')">重复</button> <button class="primary" onclick="exportZip('${b.id}')">下载全部</button> <button class="danger history-delete" data-id="${b.id}">删除</button>`;
}

function renderHistory(){
  const q = ($('#historySearch').value || '').toLowerCase();
  const filter = currentBatchFilter || 'all';
  const source = historyBatches.length ? historyBatches : batches.map(b=>({...b,batch_type:'image'}));
  const list = source.filter(b => {
    const status = String(b.status || '');
    const okFilter = filter === 'all' || status.includes(filter) || (filter === '生成中' && ['等待中','提交生成中','生成中'].includes(status));
    return okFilter && (!q || JSON.stringify(b).toLowerCase().includes(q));
  });
  selectedHistoryBatches.forEach(id=>{ if(!source.some(b=>b.id === id)) selectedHistoryBatches.delete(id); });
  const historySig = stableSig([q, filter, list.map(b=>[b.id,b.batch_type,b.status,b.task_count,b.success_count,b.fail_count,b.note,b.updated_at,selectedHistoryBatches.has(b.id)])]);
  if(historySig === lastHistorySignature){ updateBatchDurationBadges(); updateHistorySelectionUi(); return; }
  lastHistorySignature = historySig;
  $('#historyRows').innerHTML = list.map(b=>`<tr data-history-batch-id="${b.id}" class="${selectedHistoryBatches.has(b.id)?'history-row-selected':''}">
    <td class="history-select-col"><input type="checkbox" class="history-batch-check" data-history-batch-id="${b.id}" ${selectedHistoryBatches.has(b.id)?'checked':''} /></td>
    <td>${formatBeijingTime(b.created_at)}</td>
    <td class="history-batch-cell ${isVideoBatch(b)?'':'history-edit-note'}" data-id="${b.id}" title="${isVideoBatch(b)?'视频批次':'双击修改备注'}"><div>${escapeHtml(b.name)}</div><div class="small-note">类型：${isVideoBatch(b)?'视频生成 / 视频编辑':(isDescribeBatch(b)?'图生文 / Midjourney Describe':'图片生成')} · 备注：${escapeHtml((b.note||'').trim() || (isVideoBatch(b) ? '视频批次' : '双击添加备注名'))}</div><div class="small-note history-duration-line">${isVideoBatch(b)?`${b.task_count || 0} 个视频任务`:batchDurationMarkup(b)} · 状态：${escapeHtml(b.status || '-')}</div></td>
    <td>${escapeHtml(b.model)}</td><td>${b.size}</td><td>${b.task_count}</td><td>${b.success_count}</td><td>${b.fail_count}</td>
    <td>${historyBatchActions(b)}</td>
  </tr>`).join('');
  $$('.history-batch-check').forEach(ch=>ch.addEventListener('change',()=>{
    if(ch.checked) selectedHistoryBatches.add(ch.dataset.historyBatchId);
    else selectedHistoryBatches.delete(ch.dataset.historyBatchId);
    updateHistorySelectionUi();
  }));
  $$('.history-edit-note').forEach(el=>el.addEventListener('dblclick',()=>beginInlineNoteEdit(el, el.dataset.id)));
  $$('.history-delete').forEach(btn=>btn.addEventListener('click',()=>deleteBatch(btn.dataset.id, btn)));
  $$('.history-video-delete').forEach(btn=>btn.addEventListener('click',()=>deleteVideoHistoryBatch(btn.dataset.id, btn)));
  updateBatchDurationBadges();
  updateHistorySelectionUi();
}

$('#historySelectAllBatches')?.addEventListener('change', e=>{
  $$('.history-batch-check').forEach(ch=>{
    if(e.target.checked) selectedHistoryBatches.add(ch.dataset.historyBatchId);
    else selectedHistoryBatches.delete(ch.dataset.historyBatchId);
  });
  updateHistorySelectionUi();
});
$('#clearHistoryBatchSelectionBtn')?.addEventListener('click',()=>{ selectedHistoryBatches.clear(); updateHistorySelectionUi(); });
$('#downloadSelectedBatchesBtn')?.addEventListener('click', exportSelectedBatchesZip);

function fillBatchSelect(){
  const sel = $('#imageBatchSelect');
  const old = currentImageBatch || sel.value;
  sel.innerHTML = '<option value="">全部批次</option>' + batches.map(b=>`<option value="${b.id}">${escapeHtml((b.note||'').trim() || b.name)}</option>`).join('');
  if(old) sel.value = old;
}
$('#imageBatchSelect').addEventListener('change',()=>{ currentImageBatch = $('#imageBatchSelect').value; selectedImages.clear(); loadImages(); });

async function loadImages(){
  fillBatchSelect();
  if(currentImageBatch) $('#imageBatchSelect').value = currentImageBatch;
  const url = currentImageBatch ? ('/api/images?batch_id=' + encodeURIComponent(currentImageBatch)) : '/api/images?panel_only=1';
  const imgs = await api(url);
  renderImages(imgs);
}
function renderImages(imgs){
  imageMetaMap = new Map();
  $('#imageGrid').innerHTML = imgs.map(img=>{
    const thumb = withPublicAccess(img.thumb_url || img.url);
    const full = withPublicAccess(img.full_url || img.original_url || img.url);
    const meta = imageRowToPreviewMeta(img);
    imageMetaMap.set(img.id, meta);
    const selected = selectedImages.has(img.id) ? 'selected' : '';
    return '<div class="image-card ' + selected + '" draggable="true" data-id="' + img.id + '" data-url="' + full + '" title="???????????trl/Shift ??????????????????????????"><div class="check">' + (selectedImages.has(img.id) ? '?' : '') + '</div><img loading="lazy" src="' + thumb + '" draggable="false" data-full-url="' + full + '" data-id="' + img.id + '" alt="" title="???????????? / ????????? url ??????"><div class="img-fallback">???????</div><div class="cap">' + escapeHtml(img.filename) + '</div></div>';
  }).join('') || '<div class="card">????</div>';
  $$('.image-card').forEach(card=>{
    card.addEventListener('click',(e)=>{
      const id = card.dataset.id;
      if(e.ctrlKey || e.metaKey || e.shiftKey){ toggleImage(id); }
      else showPreview(card.dataset.url, imageMetaMap.get(id) || {});
    });
    card.addEventListener('dragstart', (e)=>{
      const id = card.dataset.id;
      const meta = imageMetaMap.get(id) || {fullUrl:card.dataset.url};
      setImageDragData(e, meta);
    });
    const img = card.querySelector('img');
    const fallback = card.querySelector('.img-fallback');
    if (img && fallback) {
      const showFallback = () => {
        img.classList.add('is-broken');
        fallback.classList.add('active');
      };
      img.addEventListener('error', showFallback, { once:true });
      img.addEventListener('load', () => fallback.classList.remove('active'), { once:true });
      if (img.complete && !img.naturalWidth) showFallback();
    }
  });
}
function toggleImage(id){ if(selectedImages.has(id)) selectedImages.delete(id); else selectedImages.add(id); loadImages(); }
$('#selectAllBtn').addEventListener('click',()=>{ $$('.image-card').forEach(c=>selectedImages.add(c.dataset.id)); loadImages(); });
$('#clearSelectBtn').addEventListener('click',()=>{ selectedImages.clear(); loadImages(); });
$('#invertSelectBtn').addEventListener('click',()=>{ $$('.image-card').forEach(c=> selectedImages.has(c.dataset.id) ? selectedImages.delete(c.dataset.id) : selectedImages.add(c.dataset.id)); loadImages(); });
$('#exportSelectedBtn').addEventListener('click',async()=>{
  if(!selectedImages.size) return alert('先选择图片');
  const r = await api('/api/export_selected_zip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch_id:currentImageBatch || '',image_ids:[...selectedImages]})});
  if(r.url) window.open(withPublicAccess(r.url),'_blank');
});
$('#deleteSelectedBtn').addEventListener('click',async()=>{
  if(!selectedImages.size) return alert('先选择图片');
  if(!confirm('确定删除选中图片？')) return;
  await api('/api/delete_images',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image_ids:[...selectedImages]})});
  selectedImages.clear(); loadImages();
});

async function loadMiniImages(activeTasks = []){
  const imgs = await api('/api/images?limit=6&panel_only=1');
  const active = (activeTasks || []).filter(shouldShowInRecentImages).slice(0, 6).map(t=>({ ...t, __kind:'task' }));
  const completed = imgs.slice(0, Math.max(0, 6 - active.length)).map(i=>({ ...i, __kind:'image' }));
  const items = [...active, ...completed].slice(0, 6);
  // V13.8: 右侧“最近图片”同时显示正在生成中的图片任务状态；无变化时不重绘，避免闪动。
  const signature = items.map(i => {
    if(i.__kind === 'task') return ['task', i.id, i.status, i.progress, i.progress_text, i.remote_task_id, i.updated_at].join('|');
    return ['img', i.id, i.thumb_url || i.url, i.full_url || i.original_url || i.url, i.filename || ''].join('|');
  }).join(';;');
  items.forEach(i=>{
    if(i.__kind !== 'image') return;
    const thumb = withPublicAccess(i.thumb_url || i.url);
    const full = withPublicAccess(i.full_url || i.original_url || i.url);
    const key = 'mini_' + i.id;
    imageMetaMap.set(key, imageRowToPreviewMeta(i));
  });
  if(signature === lastMiniImagesSignature){
    return;
  }
  lastMiniImagesSignature = signature;
  const miniHtml = items.map(i=>{
    if(i.__kind === 'task'){
      const meta = storeImageTaskPreview(i) || {};
      const p = Math.max(0, Math.min(100, Number(i.progress || 0)));
      const elapsed = formatMiniElapsed(i.created_at || i.updated_at || '');
      const taskId = meta.taskId || '';
      return `<div class="mini-task-card clickable" data-image-task-id="${escapeHtml(i.id)}" title="点击查看生成信息">
        <span class="mini-task-elapsed" data-created-at="${escapeHtml(i.created_at || i.updated_at || '')}">${escapeHtml(elapsed)}</span>
        ${taskId ? `<span class="mini-task-id" title="任务ID：${escapeHtml(taskId)}">ID：${escapeHtml(taskId)}</span>` : ''}
        <div class="mini-task-center">
          <div class="mini-task-percent">${p}%</div>
          <div class="mini-task-label">${escapeHtml(i.status || '生成中')}</div>
        </div>
        <div class="mini-task-progress"><i style="width:${p}%"></i></div>
      </div>`;
    }
    const thumb = withPublicAccess(i.thumb_url || i.url);
    const full = withPublicAccess(i.full_url || i.original_url || i.url);
    const key = 'mini_' + i.id;
    return `<img class="mini-draggable-image draggable-generated-thumb" draggable="true" loading="lazy" decoding="async" src="${thumb}" data-full-url="${full}" data-id="${key}" data-name="${escapeHtml(i.filename||'generated-image.png')}" title="拖动使用原图 / 右键复制返回 url 或提示词" onclick="showPreview('${full}', imageMetaMap.get('${key}') || {})">`;
  }).join('') || '<span class="hint">暂无图片</span>';
  if($('#miniImages')) $('#miniImages').innerHTML = miniHtml;
  if($('#mobileMiniImages')) $('#mobileMiniImages').innerHTML = miniHtml;
  $$('#miniImages .mini-draggable-image, #mobileMiniImages .mini-draggable-image').forEach(img=>{
    img.draggable = true;
    img.style.webkitUserDrag = 'element';
    img.addEventListener('dragstart', e=>{
      const meta = imageMetaMap.get(img.dataset.id) || {fullUrl:img.dataset.fullUrl, filename:img.dataset.name || 'generated-image.png'};
      setImageDragData(e, meta);
    });
  });
  // 右侧最近图片使用事件委托兜底，保证动态刷新后仍然可拖动，实际拖拽数据始终为原图。
  ['miniImages','mobileMiniImages'].forEach(id=>{
    const miniBox = $('#'+id);
    if(miniBox && !miniBox.dataset.dragDelegateBound){
      miniBox.dataset.dragDelegateBound = '1';
      miniBox.addEventListener('dragstart', e=>{
        const img = e.target?.closest?.('.mini-draggable-image,[data-full-url]');
        if(!img) return;
        const meta = imageMetaMap.get(img.dataset.id) || {fullUrl:img.dataset.fullUrl || img.src, filename:img.dataset.name || 'generated-image.png'};
        setImageDragData(e, meta);
      }, true);
    }
  });
}

function shouldShowInRecentImages(item = {}){
  const fields = [item.action, item.batch_type, item.mj_action, item.type, item.task_type, item.mj_source_type].map(v=>String(v || '').toLowerCase());
  if(fields.some(v => v === 'describe' || v === 'mj_describe' || v.includes('describe'))) return false;
  if(item.hidden_in_recent) return false;
  return true;
}

function storeImageTaskPreview(task = {}){
  if(!task || !task.id) return;
  const full = withPublicAccess(task.full_url || task.fullUrl || task.mj_grid_local_url || task.mj_grid_remote_url || task.remote_url || '');
  const meta = {
    id: task.id,
    taskId: task.remote_task_id || task.task_id || task.id,
    remote_task_id: task.remote_task_id || '',
    model: task.model || '',
    batch: task.batch_name || '',
    status: task.status || '',
    progress: Math.max(0, Math.min(100, Number(task.progress || 0))),
    progress_text: task.progress_text || '',
    prompt: task.prompt || '',
    created_at: task.created_at || '',
    updated_at: task.updated_at || '',
    time: formatBeijingTime(task.updated_at || task.created_at || ''),
    fullUrl: full,
    originalUrl: full,
    remoteUrl: task.remote_url || task.mj_grid_remote_url || '',
    mj_source: task.mj_source || '',
    mj_action: task.mj_action || '',
    mj_is_grid: !!task.mj_is_grid,
    mj_images: Array.isArray(task.mj_images) ? task.mj_images : [],
    mj_buttons: Array.isArray(task.mj_buttons) ? task.mj_buttons : [],
    mj_grid_remote_url: task.mj_grid_remote_url || '',
    mj_grid_local_url: task.mj_grid_local_url || ''
  };
  imageTaskPreviewMap.set(task.id, meta);
  return meta;
}
function showImageTaskPreviewById(id){
  const meta = imageTaskPreviewMap.get(id);
  if(!meta) return false;
  showPreview(meta.fullUrl || '', meta);
  return true;
}

document.addEventListener('click', (e)=>{
  const taskCard = e.target?.closest?.('[data-image-task-id]');
  if(!taskCard) return;
  const id = taskCard.dataset.imageTaskId || '';
  if(id && showImageTaskPreviewById(id)) e.preventDefault();
});

function renderImageTaskProgress(list = []){
  const box = $('#imageTaskProgressPanel');
  if(!box) return;
  const top = (list || []).slice(0, 8);
  const sig = stableSig(top.map(t=>[t.id,t.status,t.progress,t.progress_text,t.remote_task_id,t.updated_at]));
  if(sig === lastImageTaskProgressSignature) return;
  lastImageTaskProgressSignature = sig;
  if(!top.length){ box.innerHTML = '<span class="hint">暂无进行中的图片任务</span>'; return; }
  box.innerHTML = top.map(t=>{
    const meta = storeImageTaskPreview(t) || {};
    const p = Math.max(0, Math.min(100, Number(t.progress || 0)));
    const title = t.batch_name ? `${t.batch_name} · #${t.task_index}` : `任务 #${t.task_index}`;
    return `<div class="task-progress-item clickable" data-image-task-id="${escapeHtml(t.id)}" title="点击查看生成信息">
      <div class="task-progress-top"><b>${escapeHtml(title)}</b><span>${escapeHtml(t.status || '')}</span></div>
      <div class="progress"><div class="bar" style="width:${p}%"></div></div>
      <div class="task-progress-meta"><span>${p}%</span><span>${escapeHtml(t.progress_text || '')}</span></div>
      ${(meta.taskId || t.remote_task_id) ? `<small>ID：${escapeHtml(meta.taskId || t.remote_task_id)}</small>` : ''}
    </div>`;
  }).join('');
}

function renderMiniBatches(list){
  const top = list.slice(0,4);
  const sig = stableSig(top.map(b=>[b.id,b.status,b.success_count,b.task_count,b.fail_count,b.updated_at]));
  if(sig === lastMiniBatchesSignature) return;
  lastMiniBatchesSignature = sig;
  const html = top.map(b=>`<div class="mini-batch clickable" role="button" tabindex="0" data-mini-batch-id="${escapeHtml(b.id)}" title="点击进入该批次的图片管理"><strong>${escapeHtml(b.name)}</strong><div class="progress"><div class="bar" style="width:${percent(b)}%"></div></div><small>${b.status} · ${b.success_count}/${b.task_count}</small></div>`).join('') || '<span class="hint">暂无批次</span>';
  if($('#miniBatches')) $('#miniBatches').innerHTML = html;
  if($('#mobileMiniBatches')) $('#mobileMiniBatches').innerHTML = html;
}

function openImageBatch(batchId){
  if(!batchId) return;
  currentImageBatch = batchId;
  selectedImages.clear();
  setPage('images');
  loadImages();
}
document.addEventListener('click', e=>{
  const card = e.target?.closest?.('[data-mini-batch-id]');
  if(card) openImageBatch(card.dataset.miniBatchId || '');
});
document.addEventListener('keydown', e=>{
  const card = e.target?.closest?.('[data-mini-batch-id]');
  if(card && (e.key === 'Enter' || e.key === ' ')){
    e.preventDefault();
    openImageBatch(card.dataset.miniBatchId || '');
  }
});

async function loadLogs(){
  const logs = await api('/api/logs?limit=60');
  const sig = stableSig(logs.map(l=>[l.id,l.level,l.message,l.created_at]));
  if(sig === lastLogsSignature) return;
  lastLogsSignature = sig;
  const html = logs.map(l=>`<div class="log-${l.level}">[${formatBeijingTime(l.created_at)}] ${escapeHtml(l.message)}</div>`).join('');
  if($('#bottomLogs')) $('#bottomLogs').innerHTML = html || '暂无日志';
  if($('#apiLogs')) $('#apiLogs').innerHTML = html || '暂无日志';
  if($('#pageLogs')) $('#pageLogs').innerHTML = html || '暂无日志';
}

function removeImageContextMenu(){ document.querySelector('.img-context-menu')?.remove(); }
function showImageContextMenu(e, fullUrl, remoteUrl, promptText=''){
  e.preventDefault();
  removeImageContextMenu();
  const menu = document.createElement('div');
  menu.className = 'img-context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  const allowCopyOriginal = isLocalClient || isPublicClient;
  menu.innerHTML = `${allowCopyOriginal ? '<button data-act="copy-img">复制图片（原图）</button>' : ''}<button data-act="copy-url">复制图片链接（返回 url）</button><button data-act="copy-prompt">复制提示词</button><button data-act="preview">打开预览</button>`;
  document.body.appendChild(menu);
  const close = () => setTimeout(removeImageContextMenu, 0);
  menu.querySelector('[data-act="copy-url"]').onclick = async () => {
    await copyTextSmart(remoteUrl || fullUrl, '图片链接');
    toast('图片链接已复制'); close();
  };
  menu.querySelector('[data-act="copy-prompt"]').onclick = async () => {
    await copyTextSmart(promptText || '', '提示词');
    toast(promptText ? '提示词已复制' : '该图片没有记录提示词'); close();
  };
  menu.querySelector('[data-act="preview"]').onclick = async () => { showPreview(fullUrl, {fullUrl, remoteUrl, prompt:promptText}); close(); };
  const copyImgBtn = menu.querySelector('[data-act="copy-img"]');
  if(copyImgBtn) copyImgBtn.onclick = async () => {
    try{ const mode = await copyImageFromUrl(fullUrl); toast(mode === 'image' ? '原图已复制到剪贴板' : '浏览器限制无法直接复制图片，已复制图片链接'); }
    catch(err){ await copyTextSmart(remoteUrl || fullUrl, '图片链接'); toast('浏览器限制无法直接复制图片，已复制图片链接'); }
    close();
  };
}
document.addEventListener('click', removeImageContextMenu);
document.addEventListener('contextmenu', e => {
  const img = e.target.closest('img[data-full-url], .image-card[data-url]');
  if(!img) return;
  const card = img.closest('.image-card');
  const key = img.dataset.id || card?.dataset.id || '';
  const meta = imageMetaMap.get(key) || {};
  const full = img.dataset.fullUrl || img.dataset.url || card?.dataset.url || img.getAttribute('src');
  const remote = meta.remoteUrl || img.dataset.remoteUrl || '';
  showImageContextMenu(e, full, remote, meta.prompt || '');
});

function previewZoomLabel(){
  const pct = previewScale * 100;
  return pct >= 10000 ? `${(pct/100).toFixed(1)}x` : `${Math.round(pct)}%`;
}
function applyPreviewTransform(){
  const img = $('#previewImg');
  if(img) img.style.transform = `translate(${previewX}px, ${previewY}px) scale(${previewScale})`;
  const reset = $('#zoomReset');
  if(reset) reset.textContent = previewZoomLabel();
}
function clampPreviewBgOpacity(value){
  const n = Number(value);
  if(!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function loadPreviewBgSettings(){
  try{
    const raw = JSON.parse(localStorage.getItem(PREVIEW_BG_STORAGE_KEY) || '{}');
    previewBgSettings = {
      color: raw.color === 'white' ? 'white' : 'black',
      opacity: clampPreviewBgOpacity(raw.opacity)
    };
  }catch(_e){
    previewBgSettings = { color:'black', opacity:0 };
  }
}
function savePreviewBgSettings(){
  try{ localStorage.setItem(PREVIEW_BG_STORAGE_KEY, JSON.stringify(previewBgSettings)); }catch(_e){}
}
function applyPreviewBgSettings(){
  const stage = $('#previewStage');
  const opacity = clampPreviewBgOpacity(previewBgSettings.opacity);
  previewBgSettings.opacity = opacity;
  const rgb = previewBgSettings.color === 'white' ? '255,255,255' : '0,0,0';
  if(stage) stage.style.setProperty('--preview-bg', `rgba(${rgb},${opacity / 100})`);
  const input = $('#previewBgOpacity');
  if(input && document.activeElement !== input) input.value = String(opacity);
  $('#previewBgBlack')?.classList.toggle('active', previewBgSettings.color !== 'white');
  $('#previewBgWhite')?.classList.toggle('active', previewBgSettings.color === 'white');
}
function setPreviewBgColor(color){
  previewBgSettings.color = color === 'white' ? 'white' : 'black';
  applyPreviewBgSettings();
  savePreviewBgSettings();
}
function getPreviewViewportRect(){
  const stage = $('#previewStage');
  return stage ? stage.getBoundingClientRect() : { width: window.innerWidth * .82, height: window.innerHeight * .82, left:0, top:0 };
}
function fitPreviewToViewport(){
  const img = $('#previewImg');
  if(!img || img.classList.contains('hidden')) return;
  const rect = getPreviewViewportRect();
  const naturalW = previewNaturalWidth || img.naturalWidth || 1;
  const naturalH = previewNaturalHeight || img.naturalHeight || 1;
  const maxW = Math.max(1, Math.min(rect.width, window.innerWidth * .82));
  const maxH = Math.max(1, Math.min(rect.height, window.innerHeight * .82));
  previewFitScale = Math.min(maxW / naturalW, maxH / naturalH, 1);
  previewScale = previewFitScale;
  previewX = (rect.width - naturalW * previewScale) / 2;
  previewY = (rect.height - naturalH * previewScale) / 2;
  applyPreviewTransform();
}
function clampPreviewScale(value){
  if(!Number.isFinite(value) || value <= 0) return Math.max(PREVIEW_MIN_SCALE, previewFitScale * .5 || PREVIEW_MIN_SCALE);
  const minScale = Math.max(PREVIEW_MIN_SCALE, (previewFitScale || 1) * .5);
  const maxScale = Number.isFinite(PREVIEW_MAX_SCALE) ? PREVIEW_MAX_SCALE : 12;
  return Math.min(maxScale, Math.max(minScale, value));
}
function zoomPreviewAt(viewportX, viewportY, nextScale){
  const oldScale = previewScale || previewFitScale || 1;
  const imageX = (viewportX - previewX) / oldScale;
  const imageY = (viewportY - previewY) / oldScale;
  previewScale = clampPreviewScale(nextScale);
  previewX = viewportX - imageX * previewScale;
  previewY = viewportY - imageY * previewScale;
  applyPreviewTransform();
}
function isMjRegionButton(item={}){
  const label = String(item?.label || '').trim().toLowerCase();
  return /vary\s*\(region\)|vary\s*region|局部重绘/.test(label);
}
function isMjUpscaleContext(meta={}){
  const action = String(meta.mj_action || '').toLowerCase();
  return !meta.mj_is_grid && (/upscale/.test(action) || Number(meta.mj_variant_index || 0) === 0);
}
function isMjSingleActionContext(meta={}){
  return !!meta.mj_is_jump_single || isMjUpscaleContext(meta);
}
function isMjGridAllowedButton(item={}){
  const label = String(item?.label || '').trim();
  const combo = `${label} ${item?.custom_id || ''}`.toLowerCase();
  return /^u[1-4]$/i.test(label) || /^v[1-4]$/i.test(label) || /reroll|re-roll|redo/.test(combo);
}
function isMjUpscaleOnlyButton(item={}){
  const label = String(item?.label || '').trim().toLowerCase();
  const combo = `${label} ${item?.custom_id || ''}`.toLowerCase();
  return isMjRegionButton(item) || /vary|variation|zoom|pan|remix|customzoom/.test(combo);
}
function filterMjButtonsForPreview(meta={}, buttons=[]){
  const list = Array.isArray(buttons) ? buttons.filter(Boolean) : [];
  if(meta.mj_is_grid) return list.filter(isMjGridAllowedButton);
  if(isMjSingleActionContext(meta)){
    return mergeMjSingleButtons(list);
  }
  return list.filter(btn => !isMjRegionButton(btn) && !isMjUpscaleOnlyButton(btn));
}
function buildMjSingleFallbackButtons(){
  return [
    {label:'Vary Region（局部重绘）'},
    {label:'Vary Strong（强变体）'},
    {label:'Vary Subtle（弱变体）'},
    {label:'Zoom Out 1.5x（缩放扩图 1.5x）'},
    {label:'Zoom Out 2x（缩放扩图 2x）'},
    {label:'Pan Left（向左扩展）'},
    {label:'Pan Right（向右扩展）'},
    {label:'Pan Up（向上扩展）'},
    {label:'Pan Down（向下扩展）'},
    {label:'Remix Strong（强重塑）'},
    {label:'Remix Subtle（弱重塑）'}
  ];
}
function mjButtonDisplayLabel(item={}){
  const label = String(item?.label || '').trim();
  const combo = `${label} ${item?.custom_id || ''}`.toLowerCase();
  if(/vary\s*\(region\)|vary\s*region|inpaint|局部重绘/.test(combo)) return 'Vary Region（局部重绘）';
  if(/strong/.test(combo) && /vary|variation/.test(combo)) return 'Vary Strong（强变体）';
  if(/subtle|weak|low/.test(combo) && /vary|variation/.test(combo)) return 'Vary Subtle（弱变体）';
  if(/zoom/.test(combo) && /1\.5/.test(combo)) return 'Zoom Out 1.5x（缩放扩图 1.5x）';
  if(/zoom/.test(combo) && /2/.test(combo)) return 'Zoom Out 2x（缩放扩图 2x）';
  if(/pan_left|left|←/.test(combo)) return 'Pan Left（向左扩展）';
  if(/pan_right|right|→/.test(combo)) return 'Pan Right（向右扩展）';
  if(/pan_up|up|↑/.test(combo)) return 'Pan Up（向上扩展）';
  if(/pan_down|down|↓/.test(combo)) return 'Pan Down（向下扩展）';
  if(/remix/.test(combo) && /subtle|weak|low/.test(combo)) return 'Remix Subtle（弱重塑）';
  if(/remix/.test(combo)) return 'Remix Strong（强重塑）';
  return label || 'MJ';
}
function mjButtonKey(item={}){
  const label = mjButtonDisplayLabel(item).toLowerCase();
  if(label.includes('vary region')) return 'vary-region';
  if(label.includes('vary strong')) return 'vary-strong';
  if(label.includes('vary subtle')) return 'vary-subtle';
  if(label.includes('1.5') && label.includes('zoom')) return 'zoom-1.5';
  if(label.includes('2') && label.includes('zoom')) return 'zoom-2';
  if(label.includes('pan left')) return 'pan-left';
  if(label.includes('pan right')) return 'pan-right';
  if(label.includes('pan up')) return 'pan-up';
  if(label.includes('pan down')) return 'pan-down';
  if(label.includes('remix subtle')) return 'remix-subtle';
  if(label.includes('remix strong')) return 'remix-strong';
  return String(item?.custom_id || item?.label || label || Math.random()).toLowerCase();
}
function mergeMjSingleButtons(buttons=[]){
  const out = [];
  const seen = new Set();
  const add = (item)=>{
    if(!item) return;
    const key = mjButtonKey(item);
    if(seen.has(key)) return;
    seen.add(key);
    out.push({...item, display_label:mjButtonDisplayLabel(item)});
  };
  buildMjSingleFallbackButtons().forEach(add);
  (Array.isArray(buttons) ? buttons : []).filter(Boolean).forEach(add);
  return out;
}
function imageRowToPreviewMeta(img={}){
  const full = img.full_url || img.url || '';
  return {id:img.id, fullUrl:full, originalUrl:img.original_url||full, remoteUrl:img.remote_url||'', prompt:img.prompt||'', model:img.model||'', size:img.size||'', imageSize:img.image_size||'', batch:img.batch_name||'', time:formatBeijingTime(img.generated_at||''), filename:img.filename||'generated-image.png', status:img.status||'', progress:img.progress||0, progress_text:img.progress_text||'', taskId:img.task_id||'', local_task_id:img.local_task_id||'', batch_id:img.batch_id||'', mj_source:img.mj_source||'', mj_action:img.mj_action||'', mj_parent_task_id:img.mj_parent_task_id||'', mj_parent_remote_task_id:img.mj_parent_remote_task_id||'', mj_is_grid:!!img.mj_is_grid, mj_variant_index:img.mj_variant_index||0, mj_images:img.mj_images||[], mj_buttons:img.mj_buttons||[], mj_executed_buttons:img.mj_executed_buttons||[], mj_grid_remote_url:img.mj_grid_remote_url||'', mj_grid_local_url:img.mj_grid_local_url||''};
}
function openMjJumpImage(meta={}, index=1){
  const idx = Number(index || 1);
  const images = Array.isArray(meta.mj_images) ? meta.mj_images.filter(Boolean) : [];
  const item = images[idx - 1] || null;
  const url = item ? (item.full_url || item.url || item.remote_url || item.local_url || item.local_path || '') : '';
  if(!url) return toast(`跳转图片 ${idx} 不存在`);
  const parentTaskId = meta.taskId || meta.remote_task_id || meta.remoteTaskId || '';
  const gridUrl = meta.mj_grid_local_url || meta.mj_grid_remote_url || meta.mj_parent_grid_url || meta.parentGridUrl || '';
  const singleMeta = {
    ...meta,
    id: item.image_id || item.id || meta.id,
    fullUrl: withPublicAccess(url),
    originalUrl: withPublicAccess(url),
    remoteUrl: item.remote_url || url,
    filename: item.filename || `mj-image-${idx}.png`,
    mj_is_grid: false,
    mj_is_jump_single: true,
    view_type: 'mj_single',
    image_index: idx,
    mj_variant_index: idx,
    mj_jump_label: `跳转图片 ${idx}`,
    mj_action: 'image_url_single',
    mj_buttons: Array.isArray(meta.mj_buttons) ? meta.mj_buttons : [],
    mj_parent_grid_url: gridUrl,
    parentGridUrl: gridUrl,
    parent_task_id: parentTaskId,
    parent_local_task_id: meta.local_task_id || meta.mj_parent_task_id || '',
    taskId: parentTaskId,
    local_task_id: meta.local_task_id || '',
    mj_parent_task_id: meta.local_task_id || meta.mj_parent_task_id || '',
    mj_parent_remote_task_id: parentTaskId
  };
  showPreview(singleMeta.fullUrl || url, singleMeta);
  return singleMeta;
}
function openMjGridFromSingle(meta={}){
  const gridUrl = meta.mj_parent_grid_url || meta.parentGridUrl || meta.mj_grid_local_url || meta.mj_grid_remote_url || (meta.mj_is_grid ? (meta.fullUrl || meta.originalUrl || meta.remoteUrl || '') : '');
  if(!gridUrl) return toast('当前任务没有可回到的四宫格图');
  const gridMeta = {
    ...meta,
    fullUrl: withPublicAccess(gridUrl),
    originalUrl: withPublicAccess(gridUrl),
    remoteUrl: meta.mj_grid_remote_url || gridUrl,
    mj_is_grid: true,
    mj_is_jump_single: false,
    view_type: 'mj_grid',
    image_index: 0,
    mj_variant_index: 0,
    mj_action: 'imagine',
    taskId: meta.mj_parent_remote_task_id || meta.parent_task_id || meta.taskId || '',
    local_task_id: meta.mj_parent_task_id || meta.parent_local_task_id || meta.local_task_id || ''
  };
  showPreview(gridMeta.fullUrl || gridUrl, gridMeta);
  return gridMeta;
}
function mjApiKey(){ return $('#apiKey')?.value?.trim() || $('#videoApiKey')?.value?.trim() || ''; }
async function submitMjDirect(body={}){
  const payload = { ...(body || {}), api_key: mjApiKey() };
  if(!payload.api_key) throw new Error('请先在首页填写并保存 APIMart API Key');
  return api('/api/mj_submit', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
}
function setMjRegionStatus(text=''){ if($('#mjRegionStatus')) $('#mjRegionStatus').textContent = text || ''; }
function updateMjRegionPanCursor(){
  const wrap = $('#mjRegionCanvasWrap'); const stage = $('#mjRegionStage');
  const panReady = !!mjRegionState.spacePressed;
  const panning = !!mjRegionState.panning;
  wrap?.classList.toggle('mj-pan-ready', panReady && !panning);
  wrap?.classList.toggle('mj-panning', panning);
  stage?.classList.toggle('mj-pan-ready', panReady && !panning);
  stage?.classList.toggle('mj-panning', panning);
}
function syncMjRegionBrushUi(){
  const size = Math.max(1, Number(mjRegionState.brushSize || 42));
  if($('#mjRegionBrushSize')) $('#mjRegionBrushSize').value = String(size);
  if($('#mjRegionBrushSizeValue')) $('#mjRegionBrushSizeValue').textContent = `${size} px`;
  $('#mjRegionBrushBtn')?.classList.toggle('active', !mjRegionState.erase);
  $('#mjRegionEraseBtn')?.classList.toggle('active', !!mjRegionState.erase);
  updateMjRegionPanCursor();
  if(!mjRegionState.spacePressed && !mjRegionState.panning) updateMjRegionBrushCursor(); else hideMjRegionBrushCursor();
}
function mjRegionCanvas(){ return $('#mjRegionMaskCanvas'); }
function mjRegionCanvasCtx(){ return mjRegionCanvas()?.getContext('2d'); }
function mjRegionBrushCursor(){ return $('#mjRegionBrushCursor'); }
function updateMjRegionBrushCursor(evt=null){
  const cursor = mjRegionBrushCursor(); const canvas = mjRegionCanvas(); const wrap = $('#mjRegionCanvasWrap');
  if(!cursor || !canvas || !wrap) return;
  if(!$('#mjRegionModal')?.classList.contains('active') || mjRegionState.spacePressed || mjRegionState.panning){ cursor.classList.add('hidden'); return; }
  const wrapRect = wrap.getBoundingClientRect();
  const z = Math.max(0.05, Number(mjRegionState.zoom || 1));
  const diameter = Math.max(8, Math.max(1, Number(mjRegionState.brushSize || 42)) * z);
  cursor.style.width = `${diameter}px`; cursor.style.height = `${diameter}px`;
  if(evt){
    const point = evt.touches?.[0] || evt.changedTouches?.[0] || evt;
    const x = Math.max(0, Math.min(wrapRect.width, point.clientX - wrapRect.left));
    const y = Math.max(0, Math.min(wrapRect.height, point.clientY - wrapRect.top));
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    cursor.classList.remove('hidden');
    mjRegionState.cursorVisible = true;
  }else if(mjRegionState.cursorVisible){
    cursor.classList.remove('hidden');
  }
}
function hideMjRegionBrushCursor(){ const cursor = mjRegionBrushCursor(); if(cursor) cursor.classList.add('hidden'); mjRegionState.cursorVisible = false; }
function getMjRegionPointerPos(evt){
  const wrap = $('#mjRegionCanvasWrap');
  if(!wrap) return {x:0,y:0};
  const rect = wrap.getBoundingClientRect();
  const point = evt.touches?.[0] || evt.changedTouches?.[0] || evt;
  const z = Math.max(0.05, Number(mjRegionState.zoom || 1));
  const x = (point.clientX - rect.left - Number(mjRegionState.panX || 0)) / z;
  const y = (point.clientY - rect.top - Number(mjRegionState.panY || 0)) / z;
  return { x, y };
}
function paintMjRegionPoint(x, y, prev=null){
  const ctx = mjRegionCanvasCtx();
  if(!ctx) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, Number(mjRegionState.brushSize || 42));
  if(mjRegionState.erase){
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  }else{
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(0,0,0,0.26)';
  }
  ctx.beginPath();
  if(prev){ ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); }
  else { ctx.moveTo(x, y); ctx.lineTo(x + 0.01, y + 0.01); }
  ctx.stroke();
  ctx.restore();
}
function clearMjRegionMask(){ const ctx = mjRegionCanvasCtx(); if(ctx){ ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height); } }
function getMjRegionSnapshot(){
  const canvas = mjRegionCanvas();
  if(!canvas || !canvas.width || !canvas.height) return null;
  try { return canvas.toDataURL('image/png'); } catch { return null; }
}
function restoreMjRegionSnapshot(dataUrl=''){
  const canvas = mjRegionCanvas(); const ctx = mjRegionCanvasCtx();
  if(!canvas || !ctx) return;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!dataUrl) { updateMjRegionHistoryButtons(); return; }
  const img = new Image();
  img.onload = ()=>{ ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0,canvas.width,canvas.height); updateMjRegionHistoryButtons(); };
  img.src = dataUrl;
}
function updateMjRegionHistoryButtons(){
  const undo = $('#mjRegionUndoBtn'); const redo = $('#mjRegionRedoBtn');
  if(undo) undo.disabled = mjRegionState.undoStack.length <= 1;
  if(redo) redo.disabled = mjRegionState.redoStack.length <= 0;
}
function resetMjRegionHistory(){
  mjRegionState.undoStack = [];
  mjRegionState.redoStack = [];
  const snap = getMjRegionSnapshot();
  if(snap) mjRegionState.undoStack.push(snap);
  updateMjRegionHistoryButtons();
}
function pushMjRegionHistory(){
  const snap = getMjRegionSnapshot();
  if(!snap) return;
  const last = mjRegionState.undoStack[mjRegionState.undoStack.length - 1];
  if(last === snap) { updateMjRegionHistoryButtons(); return; }
  mjRegionState.undoStack.push(snap);
  if(mjRegionState.undoStack.length > 60) mjRegionState.undoStack.shift();
  mjRegionState.redoStack = [];
  updateMjRegionHistoryButtons();
}
function undoMjRegionMask(){
  if(mjRegionState.undoStack.length <= 1) return;
  const current = mjRegionState.undoStack.pop();
  if(current) mjRegionState.redoStack.push(current);
  restoreMjRegionSnapshot(mjRegionState.undoStack[mjRegionState.undoStack.length - 1] || '');
  updateMjRegionHistoryButtons();
}
function redoMjRegionMask(){
  const next = mjRegionState.redoStack.pop();
  if(!next) return;
  mjRegionState.undoStack.push(next);
  restoreMjRegionSnapshot(next);
  updateMjRegionHistoryButtons();
}
function hasMjRegionMask(){
  const canvas = mjRegionCanvas(); const ctx = mjRegionCanvasCtx();
  if(!canvas || !ctx || !canvas.width || !canvas.height) return false;
  const data = ctx.getImageData(0,0,canvas.width,canvas.height).data;
  for(let i=3;i<data.length;i+=4){ if(data[i] > 8) return true; }
  return false;
}
async function exportMjRegionMaskToData(){
  const canvas = mjRegionCanvas(); const ctx = mjRegionCanvasCtx();
  if(!canvas || !ctx || !hasMjRegionMask()) return null;
  const mask = document.createElement('canvas');
  mask.width = canvas.width; mask.height = canvas.height;
  const mctx = mask.getContext('2d');
  mctx.fillStyle = '#000';
  mctx.fillRect(0,0,mask.width,mask.height);
  const src = ctx.getImageData(0,0,canvas.width,canvas.height);
  const out = mctx.getImageData(0,0,mask.width,mask.height);
  const s = src.data, d = out.data;
  for(let i=0;i<s.length;i+=4){
    const a = s[i+3];
    if(a > 8){ d[i]=255; d[i+1]=255; d[i+2]=255; d[i+3]=255; }
    else { d[i]=0; d[i+1]=0; d[i+2]=0; d[i+3]=255; }
  }
  mctx.putImageData(out,0,0);
  const blob = await new Promise(resolve=>mask.toBlob(resolve,'image/png'));
  if(!blob) return null;
  const file = new File([blob], 'mj-region-mask.png', { type:'image/png' });
  return fileToData(file);
}
function clampMjRegionPan(){
  const stage = $('#mjRegionStage'); const wrap = $('#mjRegionCanvasWrap');
  if(!stage || !wrap) return;
  const z = Math.max(0.05, Number(mjRegionState.zoom || 1));
  const wrapRect = wrap.getBoundingClientRect();
  const baseW = parseFloat(stage.style.width) || stage.offsetWidth || 1;
  const baseH = parseFloat(stage.style.height) || stage.offsetHeight || 1;
  const scaledW = baseW * z;
  const scaledH = baseH * z;
  if(scaledW <= wrapRect.width) mjRegionState.panX = (wrapRect.width - scaledW) / 2;
  else mjRegionState.panX = Math.max(wrapRect.width - scaledW - 12, Math.min(12, Number(mjRegionState.panX || 0)));
  if(scaledH <= wrapRect.height) mjRegionState.panY = (wrapRect.height - scaledH) / 2;
  else mjRegionState.panY = Math.max(wrapRect.height - scaledH - 12, Math.min(12, Number(mjRegionState.panY || 0)));
}
function applyMjRegionZoom(){
  const z = Math.max(0.05, Number(mjRegionState.zoom || 1));
  const stage = $('#mjRegionStage');
  clampMjRegionPan();
  if(stage) stage.style.transform = `translate(${Number(mjRegionState.panX || 0)}px, ${Number(mjRegionState.panY || 0)}px) scale(${z})`;
  if($('#mjRegionZoomSlider')) $('#mjRegionZoomSlider').value = String(Math.round(z * 100));
  if($('#mjRegionZoomValue')) $('#mjRegionZoomValue').textContent = `${Math.round(z * 100)}%`;
  updateMjRegionPanCursor();
}
function setMjRegionZoom(value){
  mjRegionState.zoom = Math.max(0.05, Math.min(20, Number(value || 1)));
  applyMjRegionZoom();
}
function stepMjRegionZoom(delta){ setMjRegionZoom((mjRegionState.zoom || 1) * (delta > 0 ? 1.18 : 1/1.18)); }

function fitMjRegionCanvas(){
  const img = $('#mjRegionBaseImg'); const canvas = mjRegionCanvas(); const wrap = $('#mjRegionCanvasWrap'); const stage = $('#mjRegionStage');
  if(!img || !canvas || !wrap || !stage || !img.naturalWidth || !img.naturalHeight) return;
  const rect = wrap.getBoundingClientRect();
  const safeW = Math.max(120, rect.width || wrap.clientWidth || 640);
  const safeH = Math.max(120, rect.height || wrap.clientHeight || 480);
  let fitScale = Math.min(safeW / img.naturalWidth, safeH / img.naturalHeight, 1) * 0.98;
  fitScale = Math.max(0.05, Math.min(fitScale, 1));
  stage.style.width = `${img.naturalWidth}px`;
  stage.style.height = `${img.naturalHeight}px`;
  stage.style.left = '0';
  stage.style.top = '0';
  img.style.width = `${img.naturalWidth}px`;
  img.style.height = `${img.naturalHeight}px`;
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  const sameCanvasSize = canvas.width === img.naturalWidth && canvas.height === img.naturalHeight;
  const keepMask = sameCanvasSize ? getMjRegionSnapshot() : null;
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.style.width = `${img.naturalWidth}px`;
  canvas.style.height = `${img.naturalHeight}px`;
  mjRegionState.zoom = fitScale;
  mjRegionState.fitScale = fitScale;
  mjRegionState.panX = (safeW - img.naturalWidth * fitScale) / 2;
  mjRegionState.panY = (safeH - img.naturalHeight * fitScale) / 2;
  if(keepMask) restoreMjRegionSnapshot(keepMask);
  else { clearMjRegionMask(); resetMjRegionHistory(); }
  applyMjRegionZoom();
}
function fitMjRegionToViewport(){
  const img = $('#mjRegionBaseImg');
  if(img && img.naturalWidth) fitMjRegionCanvas();
}
function closeMjRegionModal(){
  mjRegionState.meta = null; mjRegionState.button = null; mjRegionState.drawing = false; mjRegionState.panning = false; mjRegionState.spacePressed = false; mjRegionState.cursorVisible = false; mjRegionState.panX = 0; mjRegionState.panY = 0; mjRegionState.submitting = false; mjRegionState.strokeChanged = false; mjRegionState.undoStack = []; mjRegionState.redoStack = [];
  $('#mjRegionModal')?.classList.remove('active');
  clearMjRegionMask();
  if($('#mjRegionBaseImg')){ $('#mjRegionBaseImg').removeAttribute('src'); $('#mjRegionBaseImg').style.width=''; $('#mjRegionBaseImg').style.height=''; }
  if($('#mjRegionStage')){ $('#mjRegionStage').style.transform=''; $('#mjRegionStage').style.width=''; $('#mjRegionStage').style.height=''; $('#mjRegionStage').style.left=''; $('#mjRegionStage').style.top=''; }
  if(mjRegionCanvas()){ mjRegionCanvas().style.width=''; mjRegionCanvas().style.height=''; }
  updateMjRegionPanCursor();
  updateMjRegionHistoryButtons();
}
function openMjRegionModal(meta={}, button={}){
  if(!isMjSingleActionContext(meta)){
    toast('Vary Region 需要基于单图执行，请先从四宫格点击“跳转图片 1/2/3/4”进入单图详情。');
    return;
  }
  const src = meta.originalUrl || meta.original_url || meta.fullUrl || meta.full_url || meta.remoteUrl || '';
  if(!src) return toast('当前图片还没有可用的预览图，无法打开变化区域编辑器');
  closePreview();
  mjRegionState.meta = meta; mjRegionState.button = button; mjRegionState.erase = false; mjRegionState.brushSize = 42; mjRegionState.zoom = 1; mjRegionState.panX = 0; mjRegionState.panY = 0; mjRegionState.panning = false; mjRegionState.spacePressed = false; mjRegionState.cursorVisible = false; mjRegionState.submitting = false; mjRegionState.strokeChanged = false; mjRegionState.undoStack = []; mjRegionState.redoStack = [];
  syncMjRegionBrushUi();
  if($('#mjRegionPrompt')) $('#mjRegionPrompt').value = '';
  if($('#mjRegionSpeed')) $('#mjRegionSpeed').value = 'relax';
  if($('#mjRegionSourceTask')) $('#mjRegionSourceTask').textContent = meta.taskId || meta.remote_task_id || meta.remoteTaskId || '-';
  if($('#mjRegionActionLabel')) $('#mjRegionActionLabel').textContent = button?.label || 'Vary (Region)';
  setMjRegionStatus('请直接在原图上涂抹需要变化的区域。编辑器使用原图像素渲染，缩放不会基于缩略图放大；提交时自动导出黑白遮罩图并上传。按住空格可拖动图片。');
  const img = $('#mjRegionBaseImg');
  img.onload = ()=>{ requestAnimationFrame(()=>{ requestAnimationFrame(()=>{ fitMjRegionCanvas(); setTimeout(fitMjRegionCanvas, 80); setTimeout(fitMjRegionCanvas, 220); setTimeout(fitMjRegionCanvas, 520); }); }); };
  $('#mjRegionModal')?.classList.add('active');
  img.src = withPublicAccess(src);
}
function mjTaskHasModalStatus(obj){
  let found = false;
  const seen = new Set();
  const walk = (x)=>{
    if(found || !x) return;
    if(typeof x === 'string'){ if(/modal/i.test(x)) found = true; return; }
    if(typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    if(/modal/i.test(String(x.status || x.action || x.state || ''))) { found = true; return; }
    Object.values(x).forEach(walk);
  };
  walk(obj);
  return found;
}

async function waitForMjModalReady(taskId='', localTaskId=''){
  const id = String(taskId || '').trim();
  if(!id) throw new Error('局部重绘入口没有返回 task_id');
  for(let i=0;i<600;i++){
    const ret = await api('/api/mj_task', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ task_id:id, local_task_id: localTaskId || '', api_key: mjApiKey() }) });
    const st = String(ret.status || '').toLowerCase();
    if(/modal/.test(st) || mjTaskHasModalStatus(ret.raw || ret)) return ret;
    if(/failed|fail|error|cancel/.test(st)) throw new Error(ret.error || ret.status || '局部重绘入口执行失败');
    const hint = i >= 10 ? '\\n提示：APIMart 文档要求 Vary (Region) 的父任务通常是已完成的 Upscale 单图；如果源任务不是单图，可能一直无法进入 MODAL。' : '';
    setMjRegionStatus(`正在等待变化区域任务进入 MODAL 状态...（${i+1}/600）
当前状态：${ret.status || '处理中'}  进度：${typeof ret.progress !== 'undefined' ? ret.progress + '%' : '-'}${hint}`);
    await new Promise(r=>setTimeout(r, 3000));
  }
  throw new Error('等待变化区域进入 MODAL 状态超时。请确认来源任务是已完成的 Upscale 单图，并稍后在任务面板中继续查询。');
}

async function submitMjRegionModal(){
  if(mjRegionState.submitting) return;
  const meta = mjRegionState.meta || {}; const button = mjRegionState.button || {};
  const sourceTaskId = meta.taskId || meta.remote_task_id || meta.remoteTaskId || '';
  const sourceLocalTaskId = meta.local_task_id || '';
  const batchId = meta.batch_id || '';
  if(!sourceTaskId) return toast('当前图片没有任务 ID，无法执行变化区域');
  const prompt = $('#mjRegionPrompt')?.value?.trim() || '';
  const speed = $('#mjRegionSpeed')?.value?.trim() || 'relax';
  if(!hasMjRegionMask()) return toast('请先在图上涂抹需要变化的区域');
  const maskData = await exportMjRegionMaskToData();
  if(!maskData) return toast('遮罩图导出失败，请重试');
  mjRegionState.submitting = true;
  $('#mjRegionGoBtn') && ($('#mjRegionGoBtn').disabled = true);
  try{
    setMjRegionStatus('第一步：正在提交变化区域入口...');
    const regionPayload = { action:'inpaint', task_id: sourceTaskId, local_task_id: sourceLocalTaskId, source_task_local_id: sourceLocalTaskId, batch_id: batchId, custom_id: button.custom_id || '', button_label: button.label || 'Vary (Region)', speed };
    if(!regionPayload.custom_id) regionPayload.index = Number(meta.mj_variant_index || 0) || '';
    const first = await submitMjDirect(regionPayload);
    const firstTaskId = first.task_id || '';
    const firstLocalTaskId = first.local_task_id || '';
    if(firstTaskId) startMjPolling(firstTaskId, firstLocalTaskId);
    const modalReady = mjTaskHasModalStatus(first.raw || first) ? first : await waitForMjModalReady(firstTaskId, firstLocalTaskId);
    const modalTaskId = modalReady.task_id || firstTaskId;
    setMjRegionStatus('第二步：正在提交遮罩图与提示词...');
    const second = await submitMjDirect({ action:'modal', task_id: modalTaskId, modal_task_id: modalTaskId, local_task_id: firstLocalTaskId, source_task_local_id: firstLocalTaskId || sourceLocalTaskId, batch_id: batchId || first.batch_id || '', modal_prompt: prompt, prompt, speed, modal_speed: speed, modal_mask: maskData });
    mjState.lastJson = second;
    if(second.task_id) mjState.lastTaskId = second.task_id;
    if(second.local_task_id) mjState.lastLocalTaskId = second.local_task_id;
    if(second.batch_id) mjState.lastBatchId = second.batch_id;
    updateMjStatus('submitted', 0, second.task_id ? '已提交局部重绘' : '已提交局部重绘', second.batch_name || second.batch_id || '', second.task_id || '');
    if(second.task_id) startMjPolling(second.task_id, second.local_task_id || '');
    toast('变化区域任务已提交');
    closeMjRegionModal();
    refreshAll();
  }catch(e){
    setMjRegionStatus(`提交失败：${e.message || e}`);
    toast(e.message || '变化区域提交失败');
  }finally{
    mjRegionState.submitting = false;
    $('#mjRegionGoBtn') && ($('#mjRegionGoBtn').disabled = false);
  }
}
function initMjRegionModal(){
  const wrap = $('#mjRegionCanvasWrap');
  const cursor = $('#mjRegionBrushCursor');
  if(wrap && cursor && cursor.parentElement !== wrap) wrap.appendChild(cursor);
  $('#closeMjRegionModal')?.addEventListener('click', closeMjRegionModal);
  $('#cancelMjRegionBtn')?.addEventListener('click', closeMjRegionModal);
  $('#mjRegionBrushBtn')?.addEventListener('click', ()=>{ mjRegionState.erase = false; syncMjRegionBrushUi(); });
  $('#mjRegionEraseBtn')?.addEventListener('click', ()=>{ mjRegionState.erase = true; syncMjRegionBrushUi(); });
  $('#mjRegionUndoBtn')?.addEventListener('click', undoMjRegionMask);
  $('#mjRegionRedoBtn')?.addEventListener('click', redoMjRegionMask);
  $('#mjRegionClearBtn')?.addEventListener('click', ()=>{ clearMjRegionMask(); pushMjRegionHistory(); setMjRegionStatus('遮罩已清空，请继续在原图上重新涂抹需要变化的区域。'); hideMjRegionBrushCursor(); });
  $('#mjRegionBrushSize')?.addEventListener('input', (e)=>{ mjRegionState.brushSize = Number(e.target.value || 42) || 42; syncMjRegionBrushUi(); });
  $('#mjRegionGoBtn')?.addEventListener('click', submitMjRegionModal);
  $('#mjRegionZoomIn')?.addEventListener('click', ()=>stepMjRegionZoom(1));
  $('#mjRegionZoomOut')?.addEventListener('click', ()=>stepMjRegionZoom(-1));
  $('#mjRegionFitBtn')?.addEventListener('click', fitMjRegionToViewport);
  $('#mjRegionZoomSlider')?.addEventListener('input', (e)=>setMjRegionZoom(Number(e.target.value || 100) / 100));
  $('#mjRegionCanvasWrap')?.addEventListener('wheel', (e)=>{ if($('#mjRegionModal')?.classList.contains('active')){ e.preventDefault(); stepMjRegionZoom(e.deltaY < 0 ? 1 : -1); } }, { passive:false });
  const beginPan = (evt)=>{
    if(!$('#mjRegionModal')?.classList.contains('active')) return false;
    if(!mjRegionState.spacePressed || mjRegionState.submitting) return false;
    const point = evt.touches?.[0] || evt;
    mjRegionState.panning = true;
    mjRegionState.panStartX = point.clientX;
    mjRegionState.panStartY = point.clientY;
    mjRegionState.panOriginX = Number(mjRegionState.panX || 0);
    mjRegionState.panOriginY = Number(mjRegionState.panY || 0);
    updateMjRegionPanCursor();
    return true;
  };
  const doPan = (evt)=>{
    if(!mjRegionState.panning) return false;
    const point = evt.touches?.[0] || evt;
    mjRegionState.panX = mjRegionState.panOriginX + (point.clientX - mjRegionState.panStartX);
    mjRegionState.panY = mjRegionState.panOriginY + (point.clientY - mjRegionState.panStartY);
    applyMjRegionZoom();
    return true;
  };
  const endPan = ()=>{ if(mjRegionState.panning){ mjRegionState.panning = false; updateMjRegionPanCursor(); } };
  const canvas = $('#mjRegionMaskCanvas');
  if(canvas){
    let prev = null;
    const start = (evt)=>{ evt.preventDefault(); if(mjRegionState.submitting) return; updateMjRegionBrushCursor(evt); if(beginPan(evt)){ prev = null; return; } mjRegionState.drawing = true; mjRegionState.strokeChanged = true; prev = getMjRegionPointerPos(evt); paintMjRegionPoint(prev.x, prev.y, null); };
    const move = (evt)=>{ updateMjRegionBrushCursor(evt); if(mjRegionState.panning){ evt.preventDefault(); doPan(evt); return; } if(!mjRegionState.drawing) return; evt.preventDefault(); const cur = getMjRegionPointerPos(evt); paintMjRegionPoint(cur.x, cur.y, prev); prev = cur; mjRegionState.strokeChanged = true; };
    const end = ()=>{ if(mjRegionState.drawing && mjRegionState.strokeChanged) pushMjRegionHistory(); mjRegionState.drawing = false; mjRegionState.strokeChanged = false; prev = null; endPan(); };
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseenter', updateMjRegionBrushCursor);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', ()=>{ if(!mjRegionState.panning){ mjRegionState.drawing = false; prev = null; } hideMjRegionBrushCursor(); });
    canvas.addEventListener('touchstart', start, { passive:false });
    canvas.addEventListener('touchmove', move, { passive:false });
    window.addEventListener('touchend', ()=>{ end(); hideMjRegionBrushCursor(); }, { passive:false });
  }
  window.addEventListener('keydown', (e)=>{
    if($('#mjRegionModal')?.classList.contains('active') && (e.ctrlKey || e.metaKey) && e.code === 'KeyZ'){
      e.preventDefault();
      if(e.shiftKey) redoMjRegionMask(); else undoMjRegionMask();
      return;
    }
    if(e.code === 'Space' && $('#mjRegionModal')?.classList.contains('active')){ e.preventDefault(); mjRegionState.spacePressed = true; updateMjRegionPanCursor(); hideMjRegionBrushCursor(); }
  });
  window.addEventListener('keyup', (e)=>{
    if(e.code === 'Space'){ mjRegionState.spacePressed = false; endPan(); updateMjRegionPanCursor(); }
  });
  window.addEventListener('blur', ()=>{ mjRegionState.spacePressed = false; endPan(); updateMjRegionPanCursor(); hideMjRegionBrushCursor(); });
  window.addEventListener('resize', ()=>{ if($('#mjRegionModal')?.classList.contains('active')){ const img = $('#mjRegionBaseImg'); if(img && img.naturalWidth) fitMjRegionCanvas(); } });
}

function renderPreviewMjExtras(meta = {}){
  const jumpRow = $('#previewMjJumpRow');
  const jumpBox = $('#previewMjJump');
  const btnRow = $('#previewMjButtonsRow');
  const btnBox = $('#previewMjButtons');
  if(jumpBox) jumpBox.innerHTML = '';
  if(btnBox) btnBox.innerHTML = '';
  const mjImages = Array.isArray(meta.mj_images) ? meta.mj_images.filter(Boolean) : [];
  const isMj = !!meta.mj_source || !!mjImages.length;
  const canJump = isMj && mjImages.length > 0;
  if(jumpRow) jumpRow.classList.toggle('hidden', !canJump);
  const visibleButtons = filterMjButtonsForPreview(meta, meta.mj_buttons);
  if(btnRow) btnRow.classList.toggle('hidden', !isMj || !visibleButtons.length);
  if(jumpBox && canJump){
    const gridBtn = document.createElement('button');
    gridBtn.textContent = '宫格';
    gridBtn.title = '回到四宫格图';
    gridBtn.classList.toggle('active', !!meta.mj_is_grid);
    gridBtn.addEventListener('click', ()=>openMjGridFromSingle(meta));
    jumpBox.appendChild(gridBtn);
    [1,2,3,4].forEach((idx)=>{
      const btn = document.createElement('button');
      btn.textContent = String(idx);
      btn.title = `打开 image_urls 第 ${idx} 张单图`;
      btn.classList.toggle('active', !meta.mj_is_grid && Number(meta.mj_variant_index || meta.image_index || 0) === idx);
      btn.addEventListener('click', async()=>{
        jumpBox.querySelectorAll('button').forEach(x=>x.classList.remove('mj-last-clicked'));
        btn.classList.add('mj-last-clicked');
        try { openMjJumpImage(meta, idx); }
        catch(e){ toast(e.message || `跳转图片 ${idx} 失败`); btn.classList.remove('mj-last-clicked'); }
      });
      jumpBox.appendChild(btn);
    });
  }
  if(btnBox && visibleButtons.length){
    visibleButtons.forEach((item)=>{
      const btn = document.createElement('button');
      btn.textContent = item.display_label || mjButtonDisplayLabel(item);
      btn.addEventListener('click', async()=>{
        if(isMjRegionButton(item)){
          openMjRegionModal(meta, item);
          return;
        }
        btnBox.querySelectorAll('button').forEach(x=>x.classList.remove('mj-last-clicked'));
        btn.classList.add('mj-last-clicked');
        try{
          const actionPayload = { task_id: meta.taskId || meta.remote_task_id || meta.remoteTaskId || '', local_task_id: meta.local_task_id || '', source_task_local_id: meta.local_task_id || '', batch_id: meta.batch_id || '', custom_id: item.custom_id || '', button_label: item.label || '' };
          if(!actionPayload.custom_id) actionPayload.index = Number(meta.mj_variant_index || 0) || '';
          await submitMjAction('button', actionPayload);
          refreshAll();
        }catch(e){ btn.classList.remove('mj-last-clicked'); }
      });
      btnBox.appendChild(btn);
    });
  }
}
function setPreviewInfo(meta = {}){
  currentPreviewMeta = meta || {};
  if($('#previewModel')) $('#previewModel').textContent = meta.model || '-';
  if($('#previewSize')) $('#previewSize').textContent = [meta.size, meta.imageSize].filter(Boolean).join(' / ') || '-';
  if($('#previewBatch')) $('#previewBatch').textContent = meta.taskId || meta.remote_task_id || meta.remoteTaskId || meta.id || '-';
  if($('#previewStatus')) $('#previewStatus').textContent = meta.status || '-';
  if($('#previewProgress')) $('#previewProgress').textContent = (meta.progress_text || typeof meta.progress !== 'undefined') ? [typeof meta.progress !== 'undefined' ? `${meta.progress}%` : '', meta.progress_text || ''].filter(Boolean).join(' · ') : '-';
  if($('#previewTaskId')) $('#previewTaskId').textContent = meta.taskId || meta.remote_task_id || meta.remoteTaskId || meta.id || '-';
  if($('#previewTime')) $('#previewTime').textContent = meta.time || formatBeijingTime(meta.created_at || meta.updated_at || '') || '-';
  if($('#previewPrompt')) $('#previewPrompt').textContent = meta.prompt || '该图片没有记录提示词';
  $('#previewPromptBox')?.classList.add('collapsed');
  if($('#togglePreviewPrompt')) $('#togglePreviewPrompt').textContent = '展开提示词';
  renderPreviewMjExtras(meta);
}
function showPreview(src, meta = {}){
  previewScale = 1; previewFitScale = 1; previewX = 0; previewY = 0; previewNaturalWidth = 0; previewNaturalHeight = 0;
  applyPreviewBgSettings();
  const img = $('#previewImg');
  const empty = $('#previewEmptyNote');
  const finalSrc = src || meta.fullUrl || '';
  if(img){
    img.onload = null;
    if(finalSrc){
      img.onload = ()=>{
        previewNaturalWidth = img.naturalWidth || previewNaturalWidth || 1;
        previewNaturalHeight = img.naturalHeight || previewNaturalHeight || 1;
        requestAnimationFrame(fitPreviewToViewport);
      };
      img.src = withPublicAccess(finalSrc);
      img.classList.remove('hidden');
    }else{
      img.removeAttribute('src');
      img.classList.add('hidden');
    }
  }
  if(empty){
    if(finalSrc){
      empty.classList.add('hidden');
      empty.textContent = '';
    }else{
      const statusText = meta.status === '失败' ? '该任务生成失败，当前没有可预览图片。' : '该任务仍在生成中，当前还没有可预览图片。';
      empty.textContent = `${statusText}

你仍然可以在右侧查看完整生成信息与任务 ID。任务完成后，图片会自动出现在“最近图片”里。`;
      empty.classList.remove('hidden');
    }
  }
  setPreviewInfo({...meta, fullUrl:finalSrc});
  $('#previewModal').classList.add('active');
  if(finalSrc && img?.complete && img.naturalWidth){
    previewNaturalWidth = img.naturalWidth;
    previewNaturalHeight = img.naturalHeight;
    requestAnimationFrame(fitPreviewToViewport);
  }else{
    applyPreviewTransform();
  }
}
function closePreview(){ const img=$('#previewImg'); if(img){ img.classList.remove('hidden'); } $('#previewEmptyNote')?.classList.add('hidden'); $('#previewModal').classList.remove('active'); }
function zoomPreview(delta){
  const factor = delta > 0 ? 1.25 : 0.8;
  const rect = getPreviewViewportRect();
  zoomPreviewAt(rect.width / 2, rect.height / 2, previewScale * factor);
}

$('#togglePreviewPrompt')?.addEventListener('click',()=>{ const box=$('#previewPromptBox'); if(!box) return; const collapsed=box.classList.toggle('collapsed'); $('#togglePreviewPrompt').textContent = collapsed ? '展开提示词' : '折叠提示词'; });
$('#copyPreviewPromptBtn')?.addEventListener('click',async()=>{ await copyTextSmart(currentPreviewMeta.prompt || '', '提示词'); toast(currentPreviewMeta.prompt ? '提示词已复制' : '该图片没有记录提示词'); });
$('#copyPreviewUrlBtn')?.addEventListener('click',async()=>{ await copyTextSmart(currentPreviewMeta.remoteUrl || currentPreviewMeta.fullUrl || $('#previewImg')?.src || '', '图片链接'); toast('图片链接已复制'); });
function applyChatContextFullscreen(enabled){
  chatContextFullscreen = !!enabled;
  // 只在当前聊天卡片内部进入“上下文全屏”，不再覆盖整个程序窗口；
  // 单独窗口中也只在自定义窗口尺寸内部展示聊天上下文。
  document.body.classList.toggle('chat-context-fullscreen', chatContextFullscreen);
  $('#chatMainCard')?.classList.toggle('context-fullscreen', chatContextFullscreen);
  $('#chatFloatingWindow')?.classList.toggle('context-only', chatContextFullscreen && $('#chatPopoutModal')?.classList.contains('active'));
  const icon = chatContextFullscreen ? '▣' : '⛶';
  const title = chatContextFullscreen ? '缩小还原' : '只看聊天上下文';
  if($('#chatFullscreenBtn')){ $('#chatFullscreenBtn').textContent = icon; $('#chatFullscreenBtn').title = title; }
  if($('#toggleChatWindowMax')){ $('#toggleChatWindowMax').textContent = icon; $('#toggleChatWindowMax').title = title; }
  renderChat();
}
function toggleChatContextFullscreen(){
  applyChatContextFullscreen(!chatContextFullscreen);
}

function openChatWindow(){
  const modal = $('#chatPopoutModal'), wrap = $('#chatPopoutWrap'), card = $('#chatMainCard'), win = $('#chatFloatingWindow');
  if(!modal || !wrap || !card || !win) return;
  if(!chatCardPlaceholder && card.parentNode){ chatCardPlaceholder = document.createComment('chat-card-placeholder'); card.parentNode.insertBefore(chatCardPlaceholder, card); }
  wrap.appendChild(card);
  modal.classList.add('active');
  card.classList.add('in-popout');
  win.classList.toggle('context-only', chatContextFullscreen);
  win.style.display = '';
  $('#aiOrb')?.classList.remove('show');
  win.style.left = win.style.left || 'calc(100vw - 760px)';
  win.style.top = win.style.top || '92px';
}
function minimizeChatWindow(){
  const modal = $('#chatPopoutModal'), win = $('#chatFloatingWindow'), orb = $('#aiOrb');
  if(!modal?.classList.contains('active')) openChatWindow();
  if(win) win.style.display = 'none';
  if(orb) orb.classList.add('show');
}
function restoreChatWindowFromOrb(){
  const modal = $('#chatPopoutModal'), win = $('#chatFloatingWindow'), orb = $('#aiOrb');
  if(!modal?.classList.contains('active')) openChatWindow();
  if(win) win.style.display = '';
  if(orb) orb.classList.remove('show');
}
function closeChatWindow(){
  const modal = $('#chatPopoutModal'), card = $('#chatMainCard');
  if(chatCardPlaceholder && card && chatCardPlaceholder.parentNode){ chatCardPlaceholder.parentNode.insertBefore(card, chatCardPlaceholder); }
  modal?.classList.remove('active'); card?.classList.remove('in-popout');
  $('#chatFloatingWindow')?.classList.remove('maximized','context-only');
  $('#aiOrb')?.classList.remove('show');
}
function setupChatFloatingWindow(){
  const win = $('#chatFloatingWindow'), head = $('#chatFloatingHead'), orb = $('#aiOrb');
  if(win && head && !win.dataset.dragReady){
    win.dataset.dragReady = '1';
    let dragging=false, sx=0, sy=0, sl=0, st=0;
    head.addEventListener('mousedown', e=>{
      if(e.target.closest('button')) return;
      dragging=true; sx=e.clientX; sy=e.clientY; const r=win.getBoundingClientRect(); sl=r.left; st=r.top; e.preventDefault();
    });
    document.addEventListener('mousemove', e=>{
      if(!dragging) return;
      const maxL = Math.max(0, window.innerWidth - 120), maxT = Math.max(0, window.innerHeight - 80);
      win.style.left = Math.min(maxL, Math.max(0, sl + e.clientX - sx)) + 'px';
      win.style.top = Math.min(maxT, Math.max(0, st + e.clientY - sy)) + 'px';
    });
    document.addEventListener('mouseup', ()=>dragging=false);
  }
  const resize = $('#chatFloatingResize');
  if(win && resize && !resize.dataset.resizeReady){
    resize.dataset.resizeReady = '1';
    let resizing=false, sx=0, sy=0, sw=0, sh=0;
    resize.addEventListener('mousedown', e=>{
      resizing=true; sx=e.clientX; sy=e.clientY; const r=win.getBoundingClientRect(); sw=r.width; sh=r.height; e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener('mousemove', e=>{
      if(!resizing) return;
      const nw = Math.max(520, Math.min(window.innerWidth - 20, sw + e.clientX - sx));
      const nh = Math.max(480, Math.min(window.innerHeight - 20, sh + e.clientY - sy));
      win.style.width = nw + 'px';
      win.style.height = nh + 'px';
    });
    document.addEventListener('mouseup', ()=>{ resizing=false; });
  }
  if(orb && !orb.dataset.dragReady){
    orb.dataset.dragReady = '1';
    orb.addEventListener('mousedown', e=>{
      aiOrbDragging = true;
      const r = orb.getBoundingClientRect();
      aiOrbDrag = {sx:e.clientX, sy:e.clientY, sl:r.left, st:r.top};
      e.preventDefault();
    });
    orb.addEventListener('click', e=>{
      if(Math.abs(e.clientX-aiOrbDrag.sx) < 4 && Math.abs(e.clientY-aiOrbDrag.sy) < 4) restoreChatWindowFromOrb();
    });
    document.addEventListener('mousemove', e=>{
      if(!aiOrbDragging) return;
      const maxL = Math.max(0, window.innerWidth - 72), maxT = Math.max(0, window.innerHeight - 72);
      orb.style.left = Math.min(maxL, Math.max(0, aiOrbDrag.sl + e.clientX - aiOrbDrag.sx)) + 'px';
      orb.style.top = Math.min(maxT, Math.max(0, aiOrbDrag.st + e.clientY - aiOrbDrag.sy)) + 'px';
      orb.style.right = 'auto'; orb.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', ()=>{ aiOrbDragging=false; });
  }
}
$('#openChatWindowBtn')?.addEventListener('click', ()=>{ setupChatFloatingWindow(); openChatWindow(); });
$('#closeChatWindow')?.addEventListener('click', closeChatWindow);
$('#minimizeChatWindow')?.addEventListener('click', minimizeChatWindow);
$('#aiOrb')?.addEventListener('dblclick', restoreChatWindowFromOrb);

$('#closePreview').addEventListener('click', closePreview);
$('#zoomIn').addEventListener('click',()=>zoomPreview(0.25));
$('#zoomOut').addEventListener('click',()=>zoomPreview(-0.25));
$('#zoomReset').addEventListener('click',fitPreviewToViewport);
$('#previewBgOpacity')?.addEventListener('input', e=>{
  previewBgSettings.opacity = clampPreviewBgOpacity(e.target.value);
  applyPreviewBgSettings();
});
$('#previewBgOpacity')?.addEventListener('blur', e=>{
  previewBgSettings.opacity = clampPreviewBgOpacity(e.target.value);
  applyPreviewBgSettings();
  savePreviewBgSettings();
});
$('#previewBgBlack')?.addEventListener('click',()=>setPreviewBgColor('black'));
$('#previewBgWhite')?.addEventListener('click',()=>setPreviewBgColor('white'));
$('#previewModal').addEventListener('click',e=>{ if(e.target.id === 'previewModal' || e.target.id === 'previewStage') closePreview(); });
$('#previewStage').addEventListener('wheel',e=>{
  e.preventDefault();
  const rect = $('#previewStage').getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  zoomPreviewAt(mouseX, mouseY, previewScale * factor);
}, {passive:false});

$('#previewImg')?.addEventListener('dragstart', e=>{
  const meta = currentPreviewMeta || {};
  const fullUrl = meta.fullUrl || $('#previewImg')?.src || '';
  setImageDragData(e, {...meta, fullUrl});
});
$('#previewImg').addEventListener('mousedown',e=>{ e.preventDefault(); previewDragging=true; previewStart={x:e.clientX,y:e.clientY,px:previewX,py:previewY}; $('#previewImg').classList.add('dragging'); });
$('#previewImg').addEventListener('dblclick',e=>{ e.preventDefault(); fitPreviewToViewport(); });
document.addEventListener('mousemove',e=>{ if(!previewDragging) return; previewX=previewStart.px+(e.clientX-previewStart.x); previewY=previewStart.py+(e.clientY-previewStart.y); applyPreviewTransform(); });
document.addEventListener('mouseup',()=>{ previewDragging=false; $('#previewImg').classList.remove('dragging'); });
window.addEventListener('resize',()=>{ if($('#previewModal')?.classList.contains('active')) fitPreviewToViewport(); });


// V8.6: mobile preview gestures: pinch zoom, one-finger pan, double tap reset/zoom.
let previewTouchState = {mode:'', startDist:0, startScale:1, startX:0, startY:0, startPX:0, startPY:0, lastTap:0, lastTapX:0, lastTapY:0};
function touchDistance(touches){
  const a = touches[0], b = touches[1];
  return Math.hypot((a.clientX-b.clientX), (a.clientY-b.clientY));
}
$('#previewStage')?.addEventListener('touchstart', e=>{
  if(!$('#previewModal')?.classList.contains('active')) return;
  if(e.touches.length === 2){
    e.preventDefault();
    previewTouchState.mode='pinch';
    previewTouchState.startDist=touchDistance(e.touches);
    previewTouchState.startScale=previewScale;
  }else if(e.touches.length === 1){
    const t=e.touches[0];
    const now=Date.now();
    if(now-previewTouchState.lastTap < 300 && Math.hypot(t.clientX-previewTouchState.lastTapX,t.clientY-previewTouchState.lastTapY)<38){
      e.preventDefault();
      if(previewScale > (previewFitScale || 1) * 1.15) fitPreviewToViewport();
      else {
        const rect = $('#previewStage').getBoundingClientRect();
        zoomPreviewAt(t.clientX - rect.left, t.clientY - rect.top, Math.max((previewFitScale || 1) * 2.2, 1));
      }
      previewTouchState.lastTap=0;
      return;
    }
    previewTouchState.lastTap=now; previewTouchState.lastTapX=t.clientX; previewTouchState.lastTapY=t.clientY;
    previewTouchState.mode='pan';
    previewTouchState.startX=t.clientX; previewTouchState.startY=t.clientY; previewTouchState.startPX=previewX; previewTouchState.startPY=previewY;
  }
},{passive:false});
$('#previewStage')?.addEventListener('touchmove', e=>{
  if(!$('#previewModal')?.classList.contains('active')) return;
  if(e.touches.length === 2 && previewTouchState.mode==='pinch'){
    e.preventDefault();
    const ratio = touchDistance(e.touches) / Math.max(1, previewTouchState.startDist);
    const rect = $('#previewStage').getBoundingClientRect();
    const cx = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - rect.left;
    const cy = ((e.touches[0].clientY + e.touches[1].clientY) / 2) - rect.top;
    zoomPreviewAt(cx, cy, previewTouchState.startScale * ratio);
  }else if(e.touches.length === 1 && previewTouchState.mode==='pan' && previewScale > 1.01){
    e.preventDefault();
    const t=e.touches[0];
    previewX = previewTouchState.startPX + (t.clientX-previewTouchState.startX);
    previewY = previewTouchState.startPY + (t.clientY-previewTouchState.startY);
    applyPreviewTransform();
  }
},{passive:false});
$('#previewStage')?.addEventListener('touchend', e=>{ if(e.touches.length===0) previewTouchState.mode=''; }, {passive:true});

// V10.1 Video Editing / Omni-Flash-Ext
let videoRefImages = [];
let videoFilesData = [];
let videoTasksCache = [];
let videoSelectedIds = new Set();
let lastBatchesSignature = '';
let lastHistorySignature = '';
let lastLogsSignature = '';
let lastMiniBatchesSignature = '';
let lastImageTaskProgressSignature = '';
let lastVideoTasksSignature = '';
let lastVideoRightSignature = '';
let lastVideoManageSignature = '';
let lastVideoBatchSignature = '';
function stableSig(obj){ try{return JSON.stringify(obj);}catch{return String(Date.now());} }
let currentVideoPreviewMeta = null;
const imageTaskPreviewMap = new Map();
function getHomeApiKey(){ return ($('#apiKey')?.value || '').trim(); }
const VIDEO_PLATFORM_KEY = CLIENT_CONFIG_KEY + '_active_video_platform';
function currentVideoPlatform(){ return ($('#videoApiPlatformSwitch .platform-btn.active')?.dataset?.platform || localStorage.getItem(VIDEO_PLATFORM_KEY) || 'apimart') === 'flow2api' ? 'flow2api' : 'apimart'; }
const APIMART_VIDEO_MODEL_RULES_UI = {
  'omni-flash-ext': {
    label:'Omni Flash（视频编辑）',
    resolutions:['720p','1080p','4k'], defaultResolution:'1080p',
    aspects:['16:9','9:16','1:1','4:3','3:4'], defaultAspect:'9:16',
    durations:[4,6,8,10], defaultDuration:'6'
  },
  'doubao-seedance-1-0-pro-fast': {
    label:'Doubao Seedance 1.0 Pro Fast',
    resolutions:['480p','720p','1080p'], defaultResolution:'1080p',
    aspects:['16:9','9:16','1:1','4:3','3:4','21:9'], defaultAspect:'16:9',
    durations:[2,3,4,5,6,7,8,9,10,11,12], defaultDuration:'5'
  },
  'doubao-seedance-1-0-pro-quality': {
    label:'Doubao Seedance 1.0 Pro Quality',
    resolutions:['480p','720p','1080p'], defaultResolution:'1080p',
    aspects:['16:9','9:16','1:1','4:3','3:4','21:9'], defaultAspect:'16:9',
    durations:[2,3,4,5,6,7,8,9,10,11,12], defaultDuration:'5'
  }
};
function videoRange(min, max){ return Array.from({length:Math.max(0, max - min + 1)}, (_, i)=>min + i); }
function registerApimartVideoUiRules(items = []){
  items.forEach(item=>{
    const model = String(item.model || '').trim();
    if(!model) return;
    APIMART_VIDEO_MODEL_RULES_UI[model.toLowerCase()] = {
      label:item.label || model,
      resolutions:item.resolutions || ['720p'],
      defaultResolution:item.defaultResolution || (item.resolutions || ['720p'])[0],
      aspects:item.aspects || ['16:9','9:16','1:1'],
      defaultAspect:item.defaultAspect || '16:9',
      durations:item.durations || videoRange(item.durationMin || 4, item.durationMax || 10),
      defaultDuration:String(item.defaultDuration || 5),
      note:item.note || ''
    };
  });
}
registerApimartVideoUiRules([
  { model:'doubao-seedance-1-5-pro', label:'Doubao Seedance 1.5 Pro', resolutions:['480p','720p','1080p'], defaultResolution:'720p', aspects:['16:9','9:16','1:1'], durationMin:4, durationMax:12 },
  { model:'doubao-seedance-2.0', label:'Doubao Seedance 2.0', resolutions:['480p','720p','1080p','4k'], aspects:['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'], durationMin:4, durationMax:15 },
  { model:'doubao-seedance-2.0-fast', label:'Doubao Seedance 2.0 Fast', resolutions:['480p','720p'], aspects:['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'], durationMin:4, durationMax:15 },
  { model:'doubao-seedance-2.0-face', label:'Doubao Seedance 2.0 Face', resolutions:['480p','720p','1080p'], aspects:['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'], durationMin:4, durationMax:15 },
  { model:'doubao-seedance-2.0-fast-face', label:'Doubao Seedance 2.0 Fast Face', resolutions:['480p','720p'], aspects:['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'], durationMin:4, durationMax:15 },
  { model:'doubao-seedance-2.0-mini', label:'Doubao Seedance 2.0 Mini', resolutions:['480p','720p'], aspects:['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'], durationMin:4, durationMax:15 },
  { model:'sora-2', label:'Sora 2', resolutions:['720p'], aspects:['16:9','9:16'], durations:[4,8,12,16,20], defaultDuration:8 },
  { model:'sora-2-pro', label:'Sora 2 Pro', resolutions:['720p','1024p','1080p'], aspects:['16:9','9:16'], durations:[4,8,12,16,20], defaultDuration:8 },
  { model:'veo3.1-fast', label:'VEO3.1 Fast', resolutions:['720p','1080p','4k'], durations:[8], defaultDuration:8 },
  { model:'veo3.1-quality', label:'VEO3.1 Quality', resolutions:['720p','1080p','4k'], durations:[8], defaultDuration:8 },
  { model:'veo3.1-lite', label:'VEO3.1 Lite', resolutions:['720p','1080p','4k'], durations:[8], defaultDuration:8 },
  { model:'veo3.1-fast-official', label:'VEO3.1 Official Fast', resolutions:['720p','1080p','4k'], durations:[4,6,8], defaultDuration:8 },
  { model:'veo3.1-quality-official', label:'VEO3.1 Official Quality', resolutions:['720p','1080p','4k'], durations:[4,6,8], defaultDuration:8 },
  { model:'MiniMax-Hailuo-02', label:'MiniMax Hailuo 02', resolutions:['768p','1080p'], defaultResolution:'768p', durations:[5,10] },
  { model:'MiniMax-Hailuo-2.3', label:'MiniMax Hailuo 2.3', resolutions:['768p','1080p'], defaultResolution:'768p', durations:[6,10], defaultDuration:6 },
  { model:'MiniMax-Hailuo-2.3-Fast', label:'MiniMax Hailuo 2.3 Fast', resolutions:['768p','1080p'], defaultResolution:'768p', durations:[6,10], defaultDuration:6 },
  { model:'skyreels-v4-fast', label:'SkyReels V4 Fast', resolutions:['480p','720p','1080p'], durationMin:3, durationMax:15 },
  { model:'skyreels-v4-std', label:'SkyReels V4 Std', resolutions:['480p','720p','1080p'], durationMin:3, durationMax:15 },
  { model:'happyhorse-1.0', label:'HappyHorse 1.0', resolutions:['720p','1080p'], durationMin:3, durationMax:15 },
  { model:'happyhorse-1.1', label:'HappyHorse 1.1', resolutions:['720p','1080p'], durationMin:3, durationMax:15 },
  { model:'wan2.5-preview', label:'Wan2.5 Preview', resolutions:['480p','720p','1080p'], aspects:['16:9','9:16','1:1','4:3','3:4'], durations:[5,10] },
  { model:'wan2.6', label:'Wan2.6', resolutions:['720p','1080p'], durations:[5,10,15] },
  { model:'wan2.6-i2v', label:'Wan2.6 I2V', resolutions:['720p','1080p'], durationMin:2, durationMax:15 },
  { model:'wan2.6-i2v-flash', label:'Wan2.6 I2V Flash', resolutions:['720p','1080p'], defaultResolution:'1080p', durationMin:2, durationMax:15 },
  { model:'wan2.7', label:'Wan2.7', resolutions:['720p','1080p'], durationMin:2, durationMax:15 },
  { model:'wan2.7-r2v', label:'Wan2.7 R2V', resolutions:['720p','1080p'], defaultResolution:'1080p', durationMin:2, durationMax:15 },
  { model:'wan2.7-videoedit', label:'Wan2.7 VideoEdit', resolutions:['720p','1080p'], defaultResolution:'1080p', durations:[0,2,3,4,5,6,7,8,9,10], defaultDuration:0 },
  { model:'kling-v2-6', label:'Kling 2.6', resolutions:['720p','1080p'], durations:[5,10] },
  { model:'kling-v2-6-motion-control', label:'Kling 2.6 Motion Control', resolutions:['720p','1080p'], durationMin:3, durationMax:30 },
  { model:'kling-v3', label:'Kling v3', resolutions:['720p','1080p','4k'], durationMin:3, durationMax:15 },
  { model:'kling-v3-motion-control', label:'Kling v3 Motion Control', resolutions:['720p','1080p'], durationMin:3, durationMax:30 },
  { model:'kling-v3-omni', label:'Kling v3 Omni', resolutions:['720p','1080p','4k'], durationMin:3, durationMax:15 },
  { model:'kling-video-o1', label:'Kling Video O1', resolutions:['720p','1080p'], durationMin:3, durationMax:15 },
  { model:'kling-3.0-turbo', label:'Kling 3.0 Turbo', resolutions:['720p','1080p'], durationMin:3, durationMax:15 },
  { model:'viduq3', label:'Vidu Q3', resolutions:['540p','720p','1080p'], durationMin:3, durationMax:16 },
  { model:'viduq3-mix', label:'Vidu Q3 Mix', resolutions:['720p','1080p'], durationMin:1, durationMax:16 },
  { model:'viduq3-pro', label:'Vidu Q3 Pro', resolutions:['540p','720p','1080p'], durationMin:1, durationMax:16 },
  { model:'viduq3-turbo', label:'Vidu Q3 Turbo', resolutions:['540p','720p','1080p'], durationMin:1, durationMax:16 },
  { model:'grok-imagine-1.5-video-apimart', label:'Grok Imagine 1.5 Video', resolutions:['480p','720p'], defaultResolution:'480p', durationMin:3, durationMax:15 },
  { model:'pixverse-v6', label:'Pixverse v6', resolutions:['360p','540p','720p','1080p'], durationMin:1, durationMax:15 }
]);
const APIMART_VIDEO_MODEL_GROUPS_UI = [
  ['Omni / Google', ['omni-flash-ext','veo3.1-fast','veo3.1-quality','veo3.1-lite','veo3.1-fast-official','veo3.1-quality-official']],
  ['Doubao Seedance', ['doubao-seedance-1-0-pro-fast','doubao-seedance-1-0-pro-quality','doubao-seedance-1-5-pro','doubao-seedance-2.0','doubao-seedance-2.0-fast','doubao-seedance-2.0-face','doubao-seedance-2.0-fast-face','doubao-seedance-2.0-mini']],
  ['Sora / MiniMax / SkyReels', ['sora-2','sora-2-pro','MiniMax-Hailuo-02','MiniMax-Hailuo-2.3','MiniMax-Hailuo-2.3-Fast','skyreels-v4-fast','skyreels-v4-std']],
  ['HappyHorse / Wan', ['happyhorse-1.0','happyhorse-1.1','wan2.5-preview','wan2.6','wan2.6-i2v','wan2.6-i2v-flash','wan2.7','wan2.7-r2v','wan2.7-videoedit']],
  ['Kling', ['kling-v2-6','kling-v2-6-motion-control','kling-v3','kling-v3-motion-control','kling-v3-omni','kling-video-o1','kling-3.0-turbo']],
  ['Vidu / Grok / Pixverse', ['viduq3','viduq3-mix','viduq3-pro','viduq3-turbo','grok-imagine-1.5-video-apimart','pixverse-v6']]
];
function apimartVideoModelOptionsHtml(){
  return APIMART_VIDEO_MODEL_GROUPS_UI.map(([label, models])=>{
    const opts = models.map(value=>{
      const rule = APIMART_VIDEO_MODEL_RULES_UI[String(value).toLowerCase()];
      return rule ? `<option value="${value}">${escapeHtml(rule.label || value)}</option>` : '';
    }).join('');
    return `<optgroup label="${escapeHtml(label)}">${opts}</optgroup>`;
  }).join('');
}
function currentApimartVideoRule(){
  const key = ($('#videoModel')?.value || 'omni-flash-ext').toLowerCase();
  return APIMART_VIDEO_MODEL_RULES_UI[key] || APIMART_VIDEO_MODEL_RULES_UI['omni-flash-ext'];
}
function videoModeAutoLabel(){
  const hasVideo = hasReferenceVideo();
  const images = videoRefImages.length;
  if(hasVideo) return '上传视频编辑';
  if(images > 2) return '多素材生成';
  if(images === 2) return '首尾帧生成';
  if(images === 1) return '首帧生成';
  return '文生视频';
}
function currentVideoModeValue(){
  const v = $('#videoModeSelect')?.value || 'auto';
  return v === 'auto' ? 'auto' : v;
}
function videoModeLabel(v){
  return ({auto:`自动识别：${videoModeAutoLabel()}`,text_to_video:'文生视频',first_frame:'首帧生成',first_last_frame:'首尾帧生成',multi_reference:'多素材生成',video_edit:'上传视频编辑'})[v || 'auto'] || videoModeAutoLabel();
}
function videoPlatformApiKey(platform=currentVideoPlatform()){
  const p = platform === 'flow2api' ? 'flow2api' : 'apimart';
  const own = localStorage.getItem(`${CLIENT_CONFIG_KEY}_video_key_${p}`) || '';
  const saved = loadClientConfig(p)?.api_key || '';
  const live = currentImagePlatform() === p ? getHomeApiKey() : '';
  if(p === 'apimart') return live || saved || own;
  return own || live || saved;
}
function rebuildVideoPlatformOptions(){
  const platform = currentVideoPlatform();
  const model = $('#videoModel');
  const resolution = $('#videoResolution');
  const duration = $('#videoDuration');
  const aspect = $('#videoAspect');
  if(platform === 'flow2api'){
    if(model) model.innerHTML = '<option value="omni" selected>Omni Flash</option><option value="lite">Veo 3.1 Lite</option><option value="fast">Veo 3.1 Fast</option><option value="quality">Veo 3.1 Quality</option><option value="lite-low">Veo 3.1 Lite [Lower Priority]</option>';
    if(duration) duration.innerHTML = '<option value="4" selected>4 秒</option><option value="6">6 秒</option><option value="8">8 秒</option><option value="10">10 秒</option>';
    if(aspect) aspect.innerHTML = '<option value="16:9" selected>16:9 横屏</option><option value="9:16">9:16 竖屏</option>';
  }else{
    if(model) {
      const oldModel = model.value;
      model.innerHTML = apimartVideoModelOptionsHtml();
      if([...model.options].some(option=>option.value === oldModel)) model.value = oldModel;
    }
    const rule = currentApimartVideoRule();
    if(duration) duration.innerHTML = rule.durations.map(v=>`<option value="${v}" ${String(v)===String(rule.defaultDuration)?'selected':''}>${v} 秒</option>`).join('');
    if(aspect) aspect.innerHTML = rule.aspects.map(v=>`<option value="${v}" ${v===rule.defaultAspect?'selected':''}>${v}</option>`).join('');
  }
  updateVideoResolutionOptions();
}
function updateVideoDurationOptions(){
  const duration = $('#videoDuration');
  if(!duration) return;
  const old = duration.value;
  if(currentVideoPlatform() === 'apimart'){
    const rule = currentApimartVideoRule();
    duration.innerHTML = rule.durations.map(v=>`<option value="${v}">${v} 秒</option>`).join('');
    duration.value = [...duration.options].some(o=>o.value===old) ? old : rule.defaultDuration;
    return;
  }
  const omni = $('#videoModel')?.value === 'omni';
  duration.innerHTML = omni
    ? '<option value="4">4 秒</option><option value="6">6 秒</option><option value="8">8 秒</option><option value="10">10 秒</option>'
    : '<option value="4">4 秒</option><option value="6">6 秒</option><option value="8">8 秒</option>';
  duration.value = [...duration.options].some(o=>o.value===old) ? old : (omni ? '4' : '8');
}
function updateVideoResolutionOptions(){
  const resolution = $('#videoResolution');
  if(!resolution) return;
  const old = resolution.value;
  if(currentVideoPlatform() === 'apimart'){
    const rule = currentApimartVideoRule();
    resolution.innerHTML = rule.resolutions.map(v=>`<option value="${v}">${v.toUpperCase()}</option>`).join('');
    resolution.value = [...resolution.options].some(o=>o.value===old) ? old : rule.defaultResolution;
    const aspect = $('#videoAspect');
    if(aspect){
      const oldAspect = aspect.value;
      aspect.innerHTML = rule.aspects.map(v=>`<option value="${v}">${v}</option>`).join('');
      aspect.value = [...aspect.options].some(o=>o.value===oldAspect) ? oldAspect : rule.defaultAspect;
    }
    return;
  }
  const flowQuality = currentVideoPlatform() === 'flow2api' && $('#videoModel')?.value === 'quality';
  resolution.innerHTML = currentVideoPlatform() === 'apimart' || flowQuality
    ? '<option value="720p">720p</option><option value="1080p">1080p</option><option value="4k">4K</option>'
    : '<option value="720p">720p</option>';
  resolution.value = [...resolution.options].some(o=>o.value===old) ? old : (currentVideoPlatform() === 'apimart' ? '1080p' : '720p');
}
function flow2VideoModelSupportsUploadedVideo(){
  return ($('#videoModel')?.value || '') === 'omni';
}
function syncFlow2VideoEditModel(){
  const model = $('#videoModel');
  if(!model || currentVideoPlatform() !== 'flow2api') return;
  const hasVideo = hasReferenceVideo();
  if(hasVideo){
    if(model.value !== 'omni') model.dataset.flow2PreviousModel = model.value;
    model.value = 'omni';
    model.disabled = true;
    model.title = '本地 Flow2API 只有 Omni Flash 支持上传视频编辑';
  }else{
    const previous = model.dataset.flow2PreviousModel;
    model.disabled = false;
    model.title = '';
    if(previous && [...model.options].some(option=>option.value === previous)) model.value = previous;
    delete model.dataset.flow2PreviousModel;
  }
}
function updateVideoModeUI(){
  const platform = currentVideoPlatform();
  const hasVideo = hasReferenceVideo();
  syncFlow2VideoEditModel();
  const images = videoRefImages.length;
  const selectedMode = currentVideoModeValue();
  let mode = selectedMode === 'auto' ? videoModeAutoLabel() : videoModeLabel(selectedMode);
  if($('#videoModeHint')) $('#videoModeHint').textContent = selectedMode === 'auto' ? `当前：${mode}` : `已手动选择：${mode}`;
  const apimartRule = currentApimartVideoRule();
  if($('#videoPlatformState')) $('#videoPlatformState').textContent = platform === 'flow2api'
    ? `本地 Flow2API · ${mode} · 流式进度反馈`
    : `APIMart · ${apimartRule.label} · ${mode}`;
  if($('#videoPlatformWarning')) $('#videoPlatformWarning').textContent = platform === 'flow2api'
    ? (hasVideo
      ? '本地 Flow2API：上传视频编辑仅支持 Omni Flash。中文提示词会原样直接提交给 Google Flow，不会调用翻译服务。'
      : '本地 Flow2API：Omni Flash 支持文生、首帧、多素材及上传视频编辑；Veo 3.1 仅支持文生 / 图生视频。')
    : ($('#videoModel')?.value || '').startsWith('omni')
      ? 'Omni Flash 支持 4/6/8/10 秒及直接上传视频编辑；公网视频 URL 必须是 APIMart 云端可访问的 HTTP/HTTPS 直链。'
      : 'APIMart 视频系列已按官方文档匹配模型、时长、比例和分辨率；上传视频编辑仅对支持 video_url / video_urls 的模型开放。'
  if(platform === 'flow2api' && images > 7){
    toast('本地 Flow2API Omni Flash 最多支持 7 张图片素材');
  }else if(platform === 'flow2api' && images > 2 && $('#videoModel')?.value !== 'fast' && $('#videoModel')?.value !== 'omni'){
    $('#videoModel').value = 'fast';
    updateVideoResolutionOptions();
  }
}
function setVideoApiPlatform(platform='apimart', silent=false){
  const p = platform === 'flow2api' ? 'flow2api' : 'apimart';
  $$('#videoApiPlatformSwitch .platform-btn').forEach(btn=>btn.classList.toggle('active', btn.dataset.platform === p));
  localStorage.setItem(VIDEO_PLATFORM_KEY, p);
  rebuildVideoPlatformOptions();
  syncVideoApiKeyFromHome();
  if($('#videoParameterTitle')) $('#videoParameterTitle').textContent = p === 'flow2api' ? '本地 Flow2API 视频参数' : 'APIMart 视频参数';
  if($('#videoApiKeyLabel')) $('#videoApiKeyLabel').textContent = p === 'flow2api' ? 'Flow2API API Key' : 'APIMart API Key';
  if($('#videoPlatformWarning')) $('#videoPlatformWarning').textContent = p === 'flow2api'
    ? '本地 Flow2API 已支持 Omni Flash：文生、首帧、多素材及直接上传视频编辑；编辑结果时长跟随源视频。'
    : 'Omni Flash 支持 4/6/8/10 秒及直接上传视频编辑；公网视频 URL 必须是 APIMart 云端可访问的 HTTP/HTTPS 直链。';
  $('#videoUrlWrap')?.classList.remove('hidden');
  updateVideoDurationVisibility();
  updateVideoModeUI();
  updateVideoTaskEstimate();
}
function syncVideoApiKeyFromHome(){
  const platform = currentVideoPlatform();
  const key = videoPlatformApiKey(platform);
  const input = $('#videoApiKey');
  if(input){
    input.value = key;
    input.placeholder = platform === 'flow2api' ? '请输入本地 Flow2API API Key' : '与首页 APIMart API Key 同步，可在这里填写';
    input.readOnly = false;
    input.disabled = false;
  }
  const btn = $('#startVideoBtn');
  if(btn){
    btn.disabled = !key;
    btn.title = key ? `使用${platform === 'flow2api' ? '本地 Flow2API' : 'APIMart'}提交视频任务` : `请先填写${platform === 'flow2api' ? ' Flow2API' : ' APIMart'} API Key`;
  }
}
function syncVideoApiKeyToHome(value=''){
  const key = String(value || '');
  if(currentVideoPlatform() !== 'apimart') return;
  if($('#apiKey')) $('#apiKey').value = key;
  localStorage.removeItem(`${CLIENT_CONFIG_KEY}_video_key_apimart`);
  const cfg = { ...loadClientConfig('apimart'), image_api_platform:'apimart', api_endpoint:platformDefaultApiEndpoint('apimart'), api_key:key };
  saveClientConfig(cfg);
  updateApiKeyWarning();
}
function hasReferenceVideo(){ return !!(videoFilesData.length || ($('#videoUrlInput')?.value || '').trim()); }
function updateVideoDurationVisibility(){
  const refVideo = hasReferenceVideo() || currentVideoModeValue() === 'video_edit';
  $('#videoDurationWrap')?.classList.toggle('hidden', refVideo);
  updateVideoModeUI();
}
function splitVideoPromptInput(){
  const raw = ($('#videoPrompt')?.value || '').trim();
  if(!raw) return [];
  const multi = $('#videoPromptMultilineTasks') ? $('#videoPromptMultilineTasks').checked : false;
  if(!multi) return [raw];
  const blank = raw.split(/\n\s*\n+/).map(x=>x.trim()).filter(Boolean);
  if(blank.length > 1) return blank;
  return raw.split(/\n+/).map(x=>x.trim()).filter(Boolean);
}
function updateVideoTaskEstimate(){
  const prompts = splitVideoPromptInput();
  const videoCount = videoFilesData.length || (($('#videoUrlInput')?.value || '').trim() ? 1 : 1);
  const repeats = Math.max(1, Number($('#videoRepeatCount')?.value || 1));
  const retries = Math.max(0, Number($('#videoRetryTimes')?.value || 0));
  const total = Math.max(1, prompts.length || 1) * Math.max(1, videoCount) * repeats;
  const el = $('#videoTaskEstimate'); if(el) el.textContent = `预计任务：提示词 ${Math.max(1,prompts.length||1)} × 主任务视频 ${Math.max(1,videoCount)} × 重复 ${repeats} × 失败重试 ${retries} = ${total}`;
}
function renderVideoInputs(){
  const vf = $('#videoFilePreview');
  if(vf){
    vf.innerHTML = videoFilesData.map((f,i)=>`<div class="video-file-thumb upload-video-thumb" data-upload-index="${i}" title="主任务视频：${escapeHtml(f.name||'')}，时长 ${escapeHtml(videoDurationText(f.duration_seconds)||'-')}"><div class="video-click-zone upload-video-click-zone" data-upload-index="${i}" title="左键点击画中画预览；左右键同时点击显示视频信息"><div class="video-first-frame" data-upload-index="${i}" data-src="${escapeHtml(f.data||'')}"><div class="video-lazy-icon">▶</div><small>懒加载第一帧</small></div></div><small title="${escapeHtml(f.name||'')}">${escapeHtml(f.name||'')}</small><em>${escapeHtml(videoDurationText(f.duration_seconds)||'')}</em><button type="button" onclick="videoFilesData.splice(${i},1);renderVideoInputs()">×</button></div>`).join('');
    initLazyVideoFirstFrames(vf);
  }
  const box = $('#videoRefThumbs');
  if(box){
    box.innerHTML = videoRefImages.map((f,i)=>`<div class="video-ref-thumb"><img src="${f.data}" data-preview="${f.data}" title="点击预览参考图" /><button type="button" onclick="videoRefImages.splice(${i},1);renderVideoInputs()">×</button></div>`).join('');
    $$('#videoRefThumbs img[data-preview]').forEach(img=>img.addEventListener('click',()=>showPreview(img.dataset.preview)));
  }
  updateVideoDurationVisibility();
  updateVideoTaskEstimate();
}
async function handleVideoFile(files){
  const list = [...(files || [])];
  if(!list.length) return;
  if(currentVideoPlatform() === 'flow2api' && !flow2VideoModelSupportsUploadedVideo()){
    if($('#videoModel')) $('#videoModel').value = 'omni';
    toast('本地 Flow2API 上传视频编辑仅支持 Omni Flash，已切换模型');
  }
  for(const f of list){
    const name = (f.name || '').toLowerCase();
    if(!(/\.mp4$|\.mov$/.test(name))) { toast('已跳过非 mp4/mov 视频：' + (f.name||'')); continue; }
    if(f.size > 100 * 1024 * 1024) { toast('已跳过超过 100MB 的视频：' + (f.name||'')); continue; }
    const duration = await getVideoDurationSeconds(f);
    // 不再因为本地元数据读取失败/读成 0 秒而跳过。真实可用性交给 APIMart 远端校验。
    if(!Number.isFinite(duration) || duration <= 0) toast(`提示：${f.name||''} 本地未能准确读取视频时长，仍会继续提交。`);
    else if(duration < 2.5 || duration > 10.5) toast(`提示：${f.name||''} 读取到的视频时长为 ${duration.toFixed(1)} 秒，仍会继续提交，若超出 APIMart 限制会显示远端真实错误。`);
    const item = await fileToData(f);
    item.duration_seconds = (Number.isFinite(duration) && duration > 0) ? Number(duration.toFixed(3)) : '';
    videoFilesData.push(item);
  }
  renderVideoInputs();
}
async function handleVideoRefs(files){
  const arr = await Promise.all([...files].map(fileToData));
  videoRefImages.push(...arr);
  toast(`已加入 ${arr.length} 张视频参考图，当前共 ${videoRefImages.length} 张`);
  renderVideoInputs();
}
function clearVideoInputs(){ videoFilesData=[]; videoRefImages=[]; $('#videoPrompt').value=''; $('#videoUrlInput').value=''; renderVideoInputs(); }
async function submitVideoTask(){
  syncVideoApiKeyFromHome();
  const platform = currentVideoPlatform();
  const apiKey = ($('#videoApiKey')?.value || '').trim();
  if(!apiKey) return toast(`请先填写${platform === 'flow2api' ? ' Flow2API' : '首页 APIMart'} API Key，填写后才能开始生成视频`);
  const prompts = splitVideoPromptInput();
  if(!prompts.length) return toast('请输入视频提示词');
  // V14.5.5：取消前端提交前硬拦截，避免元数据误读导致 5 秒视频被拒。
  // 视频真实可用性由 APIMart 远端返回结果决定，本地只负责提交与显示真实错误。
  localStorage.setItem(`${CLIENT_CONFIG_KEY}_video_key_${platform}`, apiKey);
  const refVideoMode = hasReferenceVideo();
  if(currentVideoModeValue() === 'video_edit' && !refVideoMode) return toast('已选择“上传视频编辑”，请先上传主任务视频或填写公开视频 URL');
  if(platform === 'flow2api' && refVideoMode && !flow2VideoModelSupportsUploadedVideo()) {
    return toast('本地 Flow2API 上传视频编辑仅支持 Omni Flash，请切换模型后重试');
  }
  const platformCfg = loadClientConfig(platform) || {};
  const body = { video_platform:platform, api_endpoint:platform === 'flow2api' ? (platformCfg.api_endpoint || 'http://127.0.0.1:38000') : 'https://api.apimart.ai', api_key:apiKey, video_model:$('#videoModel')?.value || '', video_mode:currentVideoModeValue(), seed:$('#videoSeed')?.value?.trim() || '', copies:Number($('#videoRepeatCount')?.value || 1), retry_times:Number($('#videoRetryTimes')?.value || 0), prompts:$('#videoPrompt').value, prompt_multiline_tasks: $('#videoPromptMultilineTasks') ? $('#videoPromptMultilineTasks').checked : false, resolution:$('#videoResolution').value, aspect_ratio:$('#videoAspect').value, video_url:$('#videoUrlInput').value.trim(), video_files:videoFilesData, ref_images:videoRefImages };
  if(!refVideoMode) body.duration = $('#videoDuration').value;
  $('#startVideoBtn').disabled = true; $('#startVideoBtn').textContent = '批量提交中...';
  try{
    const r = await api('/api/video_batch_submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    toast(`${platform === 'flow2api' ? 'Flow2API' : 'APIMart'} 视频任务已提交：成功 ${r.success || 0} / ${r.count || 0}`);
    await loadVideoTasks();
    setTimeout(loadVideoTasks, 800);
    setTimeout(loadVideoTasks, 2500);
  }catch(e){ alert(e.message || '视频任务提交失败'); }
  finally{ $('#startVideoBtn').disabled=false; $('#startVideoBtn').textContent='开始生成视频'; syncVideoApiKeyFromHome(); }
}
async function loadVideoTasks(){
  try{
    const r = await api('/api/video_tasks');
    const rows = r.rows || [];
    if(isVideoRealtimeMode()) updateRightPanelStats(r.video_stats || {total:rows.length, done:rows.filter(v=>v.status==='已完成').length, fail:rows.filter(v=>v.status==='失败').length, running:rows.filter(v=>['等待中','提交中','提交生成中','生成中','查询中','下载中'].includes(v.status)).length}, true);
    const sig = stableSig(rows.map(v=>[v.id,v.status,v.progress,v.progress_text,v.url,v.stream_url,v.download_url,v.remote_url,v.error_message,v.updated_at]));
    videoTasksCache = rows;
    if(sig !== lastVideoTasksSignature){
      lastVideoTasksSignature = sig;
      renderVideoLibrary();
    }
  }catch(e){ console.warn(e); }
}
function videoTaskById(id){ return videoTasksCache.find(v=>v.id===id) || null; }
function absoluteAppUrl(u){
  if(!u) return '';
  const s=String(u);
  if(/^https?:\/\//i.test(s) || /^data:/i.test(s) || /^blob:/i.test(s)) return s;
  const path=s.startsWith('/')?s:'/'+s;
  return location.origin + path;
}
function publicCopyUrl(u){ return absoluteAppUrl(withPublicAccess(u || '')); }
function videoPlayableUrl(meta = {}){
  return meta.stream_url || meta.url || meta.download_url || meta.remote_url || '';
}
async function openVideoPictureInPicture(meta = {}){
  const url = videoPlayableUrl(meta);
  if(!url){ toast('该视频还没有可预览的视频链接'); showVideoPreview(meta); return; }
  let player = document.getElementById('videoPipPlayer');
  if(!player){
    player = document.createElement('video');
    player.id = 'videoPipPlayer';
    player.controls = true;
    player.playsInline = true;
    player.preload = 'metadata';
    player.style.position = 'fixed';
    player.style.left = '-99999px';
    player.style.width = '320px';
    player.style.height = '180px';
    document.body.appendChild(player);
  }
  try{
    if(document.pictureInPictureElement) await document.exitPictureInPicture().catch(()=>{});
    player.pause?.();
    player.src = withPublicAccess(url);
    await player.play().catch(()=>{});
    if(player.requestPictureInPicture){ await player.requestPictureInPicture(); toast('已打开画中画预览'); }
    else { window.open(withPublicAccess(url), '_blank'); toast('当前环境不支持画中画，已打开视频链接'); }
  }catch(e){
    console.warn(e);
    window.open(withPublicAccess(url), '_blank');
    toast('画中画打开失败，已尝试打开视频链接');
  }
}

function showVideoPreview(meta = {}){
  currentVideoPreviewMeta = meta || {};
  const url = videoPlayableUrl(meta);
  const player = $('#videoPreviewPlayer');
  const err = $('#videoPlayerError');
  if(err) err.classList.add('hidden');
  if(player){
    player.pause?.();
    player.removeAttribute('src');
    player.load?.();
    if(url){
      player.src = withPublicAccess(url);
      player.onerror = ()=>{ $('#videoPlayerError')?.classList.remove('hidden'); };
      player.onloadedmetadata = ()=>{ $('#videoPlayerError')?.classList.add('hidden'); };
      setTimeout(()=>player.play?.().catch(()=>{}), 60);
    }
  }
  if($('#videoPreviewStatus')) $('#videoPreviewStatus').textContent = [meta.status || '-', meta.progress_text || ''].filter(Boolean).join(' · ');
  if($('#videoPreviewModel')) $('#videoPreviewModel').textContent = `${meta.platform === 'flow2api' ? '本地 Flow2API' : 'APIMart'} · ${meta.model || 'Omni-Flash-Ext'}`;
  if($('#videoPreviewSize')) $('#videoPreviewSize').textContent = [meta.resolution, meta.aspect_ratio].filter(Boolean).join(' / ') || '-';
  if($('#videoPreviewDuration')) $('#videoPreviewDuration').textContent = meta.duration ? `${meta.duration} 秒` : (meta.video_url ? '参考视频模式：不传时长' : '-');
  if($('#videoPreviewProgress')) $('#videoPreviewProgress').textContent = typeof meta.progress !== 'undefined' ? `${meta.progress}%` : '-';
  if($('#videoPreviewTaskId')) $('#videoPreviewTaskId').textContent = meta.task_id || meta.remote_task_id || meta.remoteTaskId || meta.id || '-';
  if($('#videoPreviewTime')) $('#videoPreviewTime').textContent = formatBeijingTime(meta.created_at || meta.updated_at || '');
  if($('#videoPreviewPrompt')) $('#videoPreviewPrompt').textContent = meta.prompt || '该视频没有记录提示词';
  $('#videoPreviewModal')?.classList.add('active');
}
function closeVideoPreview(){ const p=$('#videoPreviewPlayer'); if(p){p.pause?.(); p.removeAttribute('src'); p.load?.();} $('#videoPreviewModal')?.classList.remove('active'); }
function renderVideoCard(v, opts = {}){
  const selectable = !!opts.selectable;
  const compact = !!opts.compact;
  const selected = selectable && videoSelectedIds.has(v.id);
  const playable = videoPlayableUrl(v);
  const previewTitle = selectable ? '左键点击视频预览；Shift + 鼠标右键选择视频；左右键同时点击显示生成信息' : '左键点击视频预览；左右键同时点击显示生成信息';
  const progress = Math.max(0, Math.min(100, Number(v.progress || 0)));
  const progressText = v.progress_text || (v.status === '已完成' ? '已完成' : '');
  const failed = String(v.status || '').includes('失败');
  return `<div class="video-card ${selected?'selected':''} ${compact?'compact':''}" data-video-id="${escapeHtml(v.id)}" title="${previewTitle}">
    ${selectable ? `<div class="video-select-badge">${selected?'✓ 已选择':'Shift + 右键选择'}</div>` : ''}
    <div class="video-click-zone" data-video-act="preview" data-video-id="${escapeHtml(v.id)}" title="${previewTitle}">
      ${playable ? `<div class="video-first-frame" data-video-id="${escapeHtml(v.id)}" data-src="${escapeHtml(playable)}"><div class="video-lazy-icon">▶</div><small>懒加载第一帧</small></div>` : `<div class="video-pending ${failed?'failed':''}"><strong>${escapeHtml(v.status || '生成中')}</strong><span>${failed ? '!' : `${progress}%`}</span><small>${escapeHtml(failed ? '任务失败，点击查看生成信息' : (progressText || '左右键同时点击查看生成信息'))}</small></div>`}
    </div>
    <div class="video-meta"><b>${escapeHtml(v.status || '')}</b><span>${escapeHtml(v.platform === 'flow2api' ? '本地 Flow2API' : 'APIMart')} · ${escapeHtml(v.mode||'')} · ${escapeHtml(v.resolution||'')} · ${escapeHtml(v.aspect_ratio||'')}</span></div>
    <div class="video-progress-wrap"><div class="video-progress-head"><span>${escapeHtml(progressText || '等待进度')}</span><b>${progress}%</b></div><div class="video-progress-bar"><i style="width:${progress}%"></i></div></div>
    <div class="video-prompt" title="${escapeHtml(v.prompt||'')}">${escapeHtml(v.prompt||'')}</div>
    <div class="actions no-margin">
      ${(v.remote_url||v.url||v.stream_url)?`<button type="button" class="secondary" data-video-act="copyvideo" data-video-id="${escapeHtml(v.id)}">复制视频</button>`:''}
      ${v.download_url?`<button type="button" class="secondary" data-video-act="download" data-video-id="${escapeHtml(v.id)}">下载</button>`:''}
      ${(v.remote_url||v.url)?`<button type="button" class="secondary" data-video-act="copy" data-video-id="${escapeHtml(v.id)}" title="复制可直接打开的完整视频链接">复制链接</button>`:''}
    </div>
    ${v.error_message?`<div class="warning">${escapeHtml(v.error_message)}</div>`:''}
  </div>`;
}

function videoBatchKey(v = {}){
  if(v.video_batch_id) return String(v.video_batch_id);
  const day = formatBeijingTime(v.created_at || '').slice(0, 10) || 'unknown';
  const minute = formatBeijingTime(v.created_at || '').slice(11, 16).replace(':', '') || '0000';
  return `legacy_${day}_${minute}`;
}
function videoBatchTitle(rows = [], key = ''){
  const first = rows[0] || {};
  return first.video_batch_name || first.batch_name || (key.startsWith('legacy_') ? `视频批次 ${formatBeijingTime(first.created_at || '').slice(0, 16)}` : key);
}
function groupVideosByBatch(rows = []){
  const map = new Map();
  rows.forEach(v=>{
    const key = videoBatchKey(v);
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  });
  return [...map.entries()].map(([key, rows])=>{
    rows.sort((a,b)=>String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const done = rows.filter(v=>String(v.status || '') === '已完成').length;
    const fail = rows.filter(v=>String(v.status || '').includes('失败')).length;
    const progress = rows.length ? Math.round(rows.reduce((s,v)=>s+Number(v.progress || 0),0)/rows.length) : 0;
    return { key, title:videoBatchTitle(rows,key), rows, done, fail, progress, created_at:rows[0]?.created_at || '' };
  }).sort((a,b)=>String(b.created_at || '').localeCompare(String(a.created_at || '')));
}
function videoBatchSelectionState(rows = []){
  const ids = rows.map(v=>v.id).filter(Boolean);
  const selected = ids.filter(id=>videoSelectedIds.has(id)).length;
  return { total:ids.length, selected, all:ids.length > 0 && selected === ids.length };
}
function toggleVideoBatchSelection(key){
  const rows = groupVideosByBatch(videoTasksCache).find(g=>g.key === key)?.rows || [];
  const state = videoBatchSelectionState(rows);
  rows.forEach(v=>{ if(!v.id) return; state.all ? videoSelectedIds.delete(v.id) : videoSelectedIds.add(v.id); });
  lastVideoManageSignature = '';
  renderVideoLibrary();
}
function videoBatchHeadHtml(g){
  const state = videoBatchSelectionState(g.rows);
  return `<div class="video-day-head"><div><strong>${escapeHtml(g.title)}</strong><small>${escapeHtml(formatBeijingTime(g.created_at || ''))}</small></div><div class="video-batch-head-actions"><span>${g.rows.length} 个视频 · 已完成 ${g.done}${g.fail ? ` · 失败 ${g.fail}` : ''}</span><button type="button" class="video-batch-select ${state.all?'active':''}" data-video-batch-select="${escapeHtml(g.key)}">${state.all?'已全选':'选择本批'}${state.selected ? ` · ${state.selected}/${state.total}` : ''}</button></div></div>`;
}
function renderVideoRecentBatches(batches = []){
  const box = $('#videoRecentBatchPanel');
  if(!box) return;
  const top = batches.slice(0,6);
  box.innerHTML = top.map(b=>`<div class="mini-batch video-mini-batch" data-video-batch="${escapeHtml(b.key)}"><strong>${escapeHtml(b.title)}</strong><div class="progress"><div class="bar" style="width:${b.progress}%"></div></div><small>${b.done}/${b.rows.length} 已完成${b.fail ? ` · ${b.fail} 失败` : ''}</small></div>`).join('') || '<span class="hint">暂无视频批次</span>';
}

let videoFirstFrameObserver = null;
function videoFirstFrameUrl(raw){
  if(!raw) return '';
  let u = withPublicAccess(raw);
  if(/^data:|^blob:/i.test(u)) return u;
  if(/#t=/.test(u)) return u;
  return u + (u.includes('#') ? '' : '#t=0.1');
}
function ensureVideoFirstFrameObserver(){
  if(videoFirstFrameObserver) return videoFirstFrameObserver;
  videoFirstFrameObserver = new IntersectionObserver(entries=>{
    entries.forEach(entry=>{
      if(!entry.isIntersecting) return;
      const el = entry.target;
      videoFirstFrameObserver.unobserve(el);
      loadVideoFirstFrame(el);
    });
  }, { root:null, rootMargin:'260px', threshold:0.01 });
  return videoFirstFrameObserver;
}
function initLazyVideoFirstFrames(root=document){
  const obs = ensureVideoFirstFrameObserver();
  root.querySelectorAll?.('.video-first-frame[data-src]:not(.video-first-observed):not(.loaded)').forEach(el=>{
    el.classList.add('video-first-observed');
    obs.observe(el);
  });
}
function loadVideoFirstFrame(el){
  if(!el || el.classList.contains('loaded')) return;
  const src = el.dataset.src || '';
  if(!src) return;
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'metadata';
  v.controls = false;
  v.disablePictureInPicture = true;
  v.tabIndex = -1;
  v.className = 'video-first-frame-media';
  const done = ()=>{
    el.innerHTML = '';
    el.appendChild(v);
    el.classList.add('loaded');
  };
  v.addEventListener('loadeddata', done, {once:true});
  v.addEventListener('loadedmetadata', ()=>{ try{ if(v.currentTime < 0.05) v.currentTime = Math.min(0.1, Math.max(0, (v.duration||1)-0.05)); }catch{}; setTimeout(()=>{ if(!el.classList.contains('loaded')) done(); }, 350); }, {once:true});
  v.addEventListener('error', ()=>{ el.classList.add('load-error'); el.innerHTML = '<div class="video-lazy-icon">▶</div><small>点击预览视频</small>'; }, {once:true});
  v.src = videoFirstFrameUrl(src);
}
function showVideoInfoById(id){
  const v = videoTaskById(id);
  if(!v) return false;
  showVideoPreview(v);
  return true;
}
function uploadVideoMetaByIndex(index){
  const f = videoFilesData[Number(index)];
  if(!f) return null;
  return { id:`upload_${index}`, status:'已上传待提交', model:'Omni-Flash-Ext', mode:'主任务参考视频', url:f.data, stream_url:f.data, filename:f.name||'uploaded-video.mp4', source_video_name:f.name||'', source_video_duration:f.duration_seconds||'', duration:f.duration_seconds||'', progress:0, prompt:$('#videoPrompt')?.value || '', created_at:'' };
}
function showUploadedVideoInfo(index){
  const meta = uploadVideoMetaByIndex(index);
  if(!meta) return false;
  showVideoPreview(meta);
  return true;
}
function openUploadedVideoPip(index){
  const meta = uploadVideoMetaByIndex(index);
  if(!meta) return false;
  openVideoPictureInPicture(meta);
  return true;
}

function renderVideoLibrary(){
  const rightBox = $('#videoLibraryPanel');
  const manageBox = $('#videoManageGrid');
  const batches = groupVideosByBatch(videoTasksCache);
  if(!videoTasksCache.length){
    if(rightBox) rightBox.innerHTML = '<div class="hint">暂无最近视频</div>';
    if(manageBox) manageBox.innerHTML = '<div class="card">暂无视频</div>';
    renderVideoRecentBatches([]);
    return;
  }
  // 右侧视频生成库只显示最近 6 条，并且不显示选择入口。
  if(rightBox){
    const rightRows = videoTasksCache.slice(0,6);
    const rightSig = stableSig(rightRows.map(v=>[v.id,v.status,v.progress,v.progress_text,v.url,v.stream_url,v.download_url,v.remote_url,v.error_message,v.updated_at]));
    if(rightSig !== lastVideoRightSignature){ lastVideoRightSignature = rightSig; rightBox.innerHTML = rightRows.map(v=>renderVideoCard(v,{compact:true,selectable:false})).join(''); initLazyVideoFirstFrames(rightBox); }
  }
  const batchSig = stableSig(batches.map(b=>[b.key,b.rows.length,b.done,b.fail,b.progress,b.title]));
  if(batchSig !== lastVideoBatchSignature){ lastVideoBatchSignature = batchSig; renderVideoRecentBatches(batches); }
  // 视频管理页按视频批次分组；选择方式和图片管理保持一致：Shift + 鼠标右键选择。
  if(manageBox){
    const manageRows = videoTasksCache.slice(0,500);
    const manageSig = stableSig(manageRows.map(v=>[v.id,v.video_batch_id,v.video_batch_name,v.status,v.progress,v.progress_text,v.url,v.stream_url,v.download_url,v.remote_url,v.error_message,v.created_at,v.updated_at,videoSelectedIds.has(v.id)]));
    if(manageSig !== lastVideoManageSignature){
      lastVideoManageSignature = manageSig;
      const groups = groupVideosByBatch(manageRows);
      manageBox.innerHTML = groups.map(g=>`<section class="video-day-group video-batch-group" data-video-batch="${escapeHtml(g.key)}">${videoBatchHeadHtml(g)}<div class="video-batch-progress"><i style="width:${g.progress}%"></i></div><div class="video-day-grid">${g.rows.map(v=>renderVideoCard(v,{selectable:true})).join('')}</div></section>`).join('');
      initLazyVideoFirstFrames(manageBox);
      manageBox.querySelectorAll('[data-video-batch-select]').forEach(btn=>btn.addEventListener('click', e=>{ e.stopPropagation(); toggleVideoBatchSelection(btn.dataset.videoBatchSelect || ''); }));
    }
  }
}
function toggleVideoSelection(id){
  if(!id) return;
  if(videoSelectedIds.has(id)) videoSelectedIds.delete(id); else videoSelectedIds.add(id);
  renderVideoLibrary();
}
function setRealtimePanelMode(mode){
  const video = mode === 'video';
  $('#imageRealtimePanel')?.classList.toggle('hidden', video);
  $('#videoRealtimePanel')?.classList.toggle('hidden', !video);
  const title = document.querySelector('.right-panel .panel-head strong');
  if(title) title.textContent = video ? '视频生成库' : '实时任务面板';
  setRightPanelStatLabels(video);
  if(video) loadVideoTasks();
  else loadStatus();
}

function downloadVideoTask(meta){
  const u = meta?.download_url || meta?.url || meta?.remote_url || '';
  if(!u){ toast('没有可下载的视频链接'); return; }
  const a=document.createElement('a');
  a.href=publicCopyUrl(u);
  a.download=meta?.filename || 'generated-video.mp4';
  a.target='_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copyVideoFileOrLink(meta = {}){
  if(!meta) return;
  try{
    if(meta.id && !String(meta.id).startsWith('upload_')){
      await api('/api/video_copy_file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:meta.id})});
      toast('视频文件已复制到剪贴板，可以直接粘贴');
      return;
    }
  }catch(err){
    const link = meta.remote_url || publicCopyUrl(meta.share_url || meta.stream_url || meta.url || meta.download_url || '');
    if(link){ await copyTextSmart(link, '视频链接'); toast('复制视频文件失败，已复制视频链接'); return; }
    toast(err.message || '复制视频文件失败');
    return;
  }
  const link = meta.remote_url || publicCopyUrl(meta.share_url || meta.stream_url || meta.url || meta.download_url || '');
  if(link){ await copyTextSmart(link, '视频链接'); toast('视频链接已复制'); }
}

function ensureVideoContextMenu(){
  let menu = $('#videoContextMenu');
  if(menu) return menu;
  menu = document.createElement('div');
  menu.id = 'videoContextMenu';
  menu.className = 'video-context-menu hidden';
  menu.innerHTML = `<button data-video-menu-act="copyvideo">复制视频</button><button data-video-menu-act="download">下载</button><button data-video-menu-act="copylink">复制链接</button>`;
  document.body.appendChild(menu);
  menu.addEventListener('click', async e=>{
    const act = e.target.closest('button')?.dataset.videoMenuAct;
    const id = menu.dataset.videoId;
    const v = videoTaskById(id);
    hideVideoContextMenu();
    if(!v || !act) return;
    if(act === 'copyvideo') return copyVideoFileOrLink(v);
    if(act === 'download') return downloadVideoTask(v);
    const link = v.remote_url || publicCopyUrl(v.share_url || v.stream_url || v.url || v.download_url || '');
    if(link) await copyTextSmart(link, '视频链接').then(()=>toast('视频链接已复制'));
  });
  document.addEventListener('click', hideVideoContextMenu);
  return menu;
}
function hideVideoContextMenu(){ $('#videoContextMenu')?.classList.add('hidden'); }
function showVideoContextMenu(e, id){
  const menu = ensureVideoContextMenu();
  menu.dataset.videoId = id || '';
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 132)}px`;
  menu.classList.remove('hidden');
}

function setupVideoPage(){
  setVideoApiPlatform(localStorage.getItem(VIDEO_PLATFORM_KEY) || 'apimart', true);
  $('#apiKey')?.addEventListener('input', syncVideoApiKeyFromHome);
  $$('#videoApiPlatformSwitch .platform-btn').forEach(btn=>btn.addEventListener('click',()=>setVideoApiPlatform(btn.dataset.platform || 'apimart')));
  $('#videoApiKey')?.addEventListener('input', e=>{
    if(currentVideoPlatform() === 'flow2api'){
      localStorage.setItem(`${CLIENT_CONFIG_KEY}_video_key_flow2api`, e.target.value || '');
      syncVideoApiKeyFromHome();
    }else{
      syncVideoApiKeyToHome(e.target.value || '');
      syncVideoApiKeyFromHome();
    }
  });
  $('#videoModel')?.addEventListener('change', ()=>{ updateVideoDurationOptions(); updateVideoResolutionOptions(); updateVideoModeUI(); updateVideoTaskEstimate(); });
  $('#videoModeSelect')?.addEventListener('change', ()=>{ updateVideoModeUI(); updateVideoDurationVisibility(); updateVideoTaskEstimate(); });
  $('#videoSeed')?.addEventListener('input', updateVideoTaskEstimate);
  $('#videoRepeatCount')?.addEventListener('input', updateVideoTaskEstimate);
  if($('#openVideoUrlBtn')) $('#openVideoUrlBtn').textContent = '复制视频';
  const videoPanel = $('#videoRealtimePanel');
  if(videoPanel && !$('#videoRecentBatchPanel')){
    videoPanel.insertAdjacentHTML('beforeend', '<h3 class="video-recent-batch-title">最近批次</h3><div id="videoRecentBatchPanel" class="video-recent-batches"></div>');
  }
  $('#videoRecentBatchPanel')?.addEventListener('click', e=>{
    const row = e.target.closest('[data-video-batch]');
    if(!row) return;
    const key = row.dataset.videoBatch;
    setPage('video-manage');
    setTimeout(()=>document.querySelector(`#videoManageGrid [data-video-batch="${CSS.escape(key)}"]`)?.scrollIntoView({behavior:'smooth', block:'start'}), 80);
  });
  $('#videoFile')?.addEventListener('change', e=>handleVideoFile(e.target.files));
  $('#videoPrompt')?.addEventListener('input', updateVideoTaskEstimate);
  $('#videoPromptMultilineTasks')?.addEventListener('change', updateVideoTaskEstimate);
  $('#videoUrlInput')?.addEventListener('input', ()=>{
    updateVideoDurationVisibility();
  });
  $('#videoRefFiles')?.addEventListener('change', e=>handleVideoRefs(e.target.files));
  $('#startVideoBtn')?.addEventListener('click', submitVideoTask);
  $('#clearVideoInputsBtn')?.addEventListener('click', clearVideoInputs);
  const handleVideoCardClick = async e=>{
    const btn=e.target.closest('[data-video-act]');
    const card=e.target.closest('.video-card');
    const id=(btn||card)?.dataset?.videoId;
    const v=videoTaskById(id);
    if(!v) return;
    e.preventDefault();
    if(btn) e.stopPropagation();
    const act=btn?.dataset?.videoAct || 'preview';
    if((e.shiftKey || e.ctrlKey || e.metaKey) && card && card.closest('#videoManageGrid')){ toggleVideoSelection(v.id); return; }
    if(act==='copyvideo'){
      return copyVideoFileOrLink(v);
    }
    if(act==='copy'){ const link = v.remote_url || publicCopyUrl(v.share_url || v.stream_url || v.url || v.download_url || ''); copyTextSmart(link, '视频链接').then(()=>toast('视频链接已复制')); return; }
    if(act==='download'){ downloadVideoTask(v); return; }
    if(videoPlayableUrl(v)) openVideoPictureInPicture(v); else showVideoPreview(v);
  };
  $('#videoLibraryPanel')?.addEventListener('click', handleVideoCardClick);
  $('#videoManageGrid')?.addEventListener('click', handleVideoCardClick);
  const dualState = { left:false, id:'', timer:null };
  const handleVideoDualMouse = e=>{
    const zone = e.target.closest?.('.video-click-zone');
    if(!zone) return;
    const id = zone.dataset.videoId;
    if(!id) return;
    if(e.type === 'mousedown'){
      if(e.button === 0){
        dualState.left = true; dualState.id = id;
        clearTimeout(dualState.timer);
        dualState.timer = setTimeout(()=>{ dualState.left=false; dualState.id=''; }, 900);
      }
      if(e.buttons === 3 || (e.button === 2 && dualState.left && dualState.id === id)){
        e.preventDefault(); e.stopPropagation();
        clearTimeout(dualState.timer); dualState.left=false; dualState.id='';
        showVideoInfoById(id);
      }
    }
    if(e.type === 'contextmenu'){
      if(dualState.left && dualState.id === id){
        e.preventDefault(); e.stopPropagation();
        clearTimeout(dualState.timer); dualState.left=false; dualState.id='';
        showVideoInfoById(id);
      }
    }
  };
  $('#videoLibraryPanel')?.addEventListener('mousedown', handleVideoDualMouse, true);
  $('#videoManageGrid')?.addEventListener('mousedown', handleVideoDualMouse, true);
  $('#videoLibraryPanel')?.addEventListener('contextmenu', handleVideoDualMouse, true);
  $('#videoManageGrid')?.addEventListener('contextmenu', handleVideoDualMouse, true);
  const uploadDualState = { left:false, index:'', timer:null };
  const handleUploadVideoMouse = e=>{
    const zone = e.target.closest?.('.upload-video-click-zone');
    if(!zone) return;
    const idx = zone.dataset.uploadIndex;
    if(e.type === 'click'){
      if(e.button === 0 && !(e.buttons === 3)) openUploadedVideoPip(idx);
    }
    if(e.type === 'mousedown'){
      if(e.button === 0){
        uploadDualState.left = true; uploadDualState.index = idx;
        clearTimeout(uploadDualState.timer);
        uploadDualState.timer = setTimeout(()=>{ uploadDualState.left=false; uploadDualState.index=''; }, 900);
      }
      if(e.buttons === 3 || (e.button === 2 && uploadDualState.left && uploadDualState.index === idx)){
        e.preventDefault(); e.stopPropagation();
        clearTimeout(uploadDualState.timer); uploadDualState.left=false; uploadDualState.index='';
        showUploadedVideoInfo(idx);
      }
    }
    if(e.type === 'contextmenu'){
      if(uploadDualState.left && uploadDualState.index === idx){
        e.preventDefault(); e.stopPropagation();
        clearTimeout(uploadDualState.timer); uploadDualState.left=false; uploadDualState.index='';
        showUploadedVideoInfo(idx);
      }
    }
  };
  $('#videoFilePreview')?.addEventListener('click', handleUploadVideoMouse, true);
  $('#videoFilePreview')?.addEventListener('mousedown', handleUploadVideoMouse, true);
  $('#videoFilePreview')?.addEventListener('contextmenu', handleUploadVideoMouse, true);
  $('#videoManageGrid')?.addEventListener('contextmenu', e=>{
    const card = e.target.closest('.video-card');
    if(!card) return;
    if(e.shiftKey){ e.preventDefault(); e.stopPropagation(); toggleVideoSelection(card.dataset.videoId); }
    else { e.preventDefault(); e.stopPropagation(); showVideoContextMenu(e, card.dataset.videoId); }
  });
  $('#videoLibraryPanel')?.addEventListener('contextmenu', e=>{
    const card = e.target.closest('.video-card');
    if(!card) return;
    e.preventDefault(); e.stopPropagation(); showVideoContextMenu(e, card.dataset.videoId);
  });
  $('#refreshVideoManageBtn')?.addEventListener('click', loadVideoTasks);
  $('#selectAllVideosBtn')?.addEventListener('click', ()=>{ videoTasksCache.forEach(v=>videoSelectedIds.add(v.id)); renderVideoLibrary(); });
  $('#invertVideoSelectBtn')?.addEventListener('click', ()=>{ videoTasksCache.forEach(v=> videoSelectedIds.has(v.id) ? videoSelectedIds.delete(v.id) : videoSelectedIds.add(v.id)); renderVideoLibrary(); });
  $('#clearVideoSelectBtn')?.addEventListener('click', ()=>{ videoSelectedIds.clear(); renderVideoLibrary(); });
  $('#exportSelectedVideosBtn')?.addEventListener('click', async()=>{ const ids=[...videoSelectedIds]; if(!ids.length) return toast('请先选择要导出的视频'); try{ const r=await api('/api/video_export_selected',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})}); if(r.url) window.open(withPublicAccess(r.url),'_blank'); }catch(e){ toast(e.message||'导出视频失败'); } });
  $('#deleteSelectedVideosBtn')?.addEventListener('click', async()=>{ const ids=[...videoSelectedIds]; if(!ids.length) return toast('请先选择要删除的视频'); if(!confirm(`确定删除选中的 ${ids.length} 个视频吗？本地视频文件也会删除。`)) return; try{ await api('/api/video_delete_selected',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})}); videoSelectedIds.clear(); await loadVideoTasks(); toast('已删除选中视频'); }catch(e){ toast(e.message||'删除视频失败'); } });
  $('#copySelectedVideoLinksBtn')?.addEventListener('click', async()=>{ const links=videoTasksCache.map(v=>v.remote_url || publicCopyUrl(v.share_url||v.stream_url||v.url||v.download_url||'')).filter(Boolean).join('\n'); if(!links) return toast('暂无可复制的视频链接'); await copyTextSmart(links,'全部视频链接'); });
  $('#openVideoOutputDirBtn')?.addEventListener('click', ()=>toast('视频文件保存在设置中心的输出目录，与图片输出目录一致'));
  $('#closeVideoPreview')?.addEventListener('click', closeVideoPreview);
  $('#videoPreviewModal')?.addEventListener('click', e=>{ if(e.target.id==='videoPreviewModal') closeVideoPreview(); });
  $('#copyVideoPromptBtn')?.addEventListener('click', async()=>{ await copyTextSmart(currentVideoPreviewMeta?.prompt||'', '视频提示词'); });
  $('#copyVideoUrlBtn')?.addEventListener('click', async()=>{ await copyTextSmart(currentVideoPreviewMeta?.remote_url || publicCopyUrl(currentVideoPreviewMeta?.share_url||currentVideoPreviewMeta?.stream_url||currentVideoPreviewMeta?.url||currentVideoPreviewMeta?.download_url||''), '视频链接'); });
  $('#openVideoUrlBtn')?.addEventListener('click', ()=>copyVideoFileOrLink(currentVideoPreviewMeta || {}));
  ['videoDrop','videoRefDrop'].forEach(id=>{
    const el=$('#'+id); if(!el) return;
    el.addEventListener('dragover', e=>{e.preventDefault(); el.classList.add('drag');});
    el.addEventListener('dragleave', ()=>el.classList.remove('drag'));
    el.addEventListener('drop', e=>{e.preventDefault(); el.classList.remove('drag'); id==='videoDrop'?handleVideoFile(e.dataTransfer.files):handleVideoRefs(e.dataTransfer.files);});
  });
}

document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closePreview(); closeVideoPreview?.(); } });

function setPanelCollapsed(collapsed){
  $('.right-panel')?.classList.toggle('collapsed', collapsed);
  $('.app-shell')?.classList.toggle('panel-collapsed', collapsed);
  $('#restorePanel')?.classList.toggle('show', collapsed);
}
$('#collapsePanel').addEventListener('click',()=>setPanelCollapsed(true));
$('#restorePanel').addEventListener('click',()=>setPanelCollapsed(false));



// V7.1: 强制左侧导航使用内联 SVG，避免 CSS mask 在部分 Windows/Electron 环境不显示。
function normalizeNavIcons(){
  const svg = {
    home:'<svg viewBox="0 0 24 24"><path d="M3.5 11.2 12 4l8.5 7.2V20a1.5 1.5 0 0 1-1.5 1.5h-4.2v-6.2H9.2v6.2H5A1.5 1.5 0 0 1 3.5 20z"/></svg>',
    history:'<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 1-7.45 5.1H2.6V5.2h5.2v5.2H5.9A6.2 6.2 0 1 0 12 5.8zm-.9 3.4h1.9v5.2l4.1 2.5-.95 1.55-5.05-3.05z"/></svg>',
    images:'<svg viewBox="0 0 24 24"><path d="M5.5 5h13A2.5 2.5 0 0 1 21 7.5v9A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9A2.5 2.5 0 0 1 5.5 5m.9 10.7h11.2l-3.7-4.5-3 3.8-1.9-2.4z"/></svg>',
    chat:'<svg viewBox="0 0 24 24"><path d="M5.5 4h13A2.5 2.5 0 0 1 21 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-5.2 4v-4.1A2.5 2.5 0 0 1 3 14.5v-8A2.5 2.5 0 0 1 5.5 4z"/></svg>',
    api:'<svg viewBox="0 0 24 24"><path d="M13.2 2.8 4.8 13.5h6.1L9.8 21.2l9.4-12.1h-6.1z"/></svg>',
    video:'<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h8A2.5 2.5 0 0 1 17 5.5v1.4l3.8-2.2v14.6L17 17.1v1.4a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 4 18.5z"/></svg>',
    tools:'<svg viewBox="0 0 24 24"><path d="M4 6h16v3H4zm2.5 5h11v3h-11zM9 16h6v3H9z"/></svg>',
    lan:'<svg viewBox="0 0 24 24"><path d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19m6.8 8.6h-3a15 15 0 0 0-1-4.5 7.7 7.7 0 0 1 4 4.5M12 4.4c.8 1.1 1.5 3 1.8 6.7h-3.6c.3-3.7 1-5.6 1.8-6.7m-2.8 2.2a15 15 0 0 0-1 4.5h-3a7.7 7.7 0 0 1 4-4.5m-4 6.3h3c.2 1.8.5 3.5 1 4.5a7.7 7.7 0 0 1-4-4.5M12 19.6c-.8-1.1-1.5-3-1.8-6.7h3.6c-.3 3.7-1 5.6-1.8 6.7m2.8-2.2c.5-1 .8-2.7 1-4.5h3a7.7 7.7 0 0 1-4 4.5"/></svg>',
    public:'<svg viewBox="0 0 24 24"><path d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19m6.8 8.6h-3a15 15 0 0 0-1-4.5 7.7 7.7 0 0 1 4 4.5M12 4.4c.8 1.1 1.5 3 1.8 6.7h-3.6c.3-3.7 1-5.6 1.8-6.7m-2.8 2.2a15 15 0 0 0-1 4.5h-3a7.7 7.7 0 0 1 4-4.5m-4 6.3h3c.2 1.8.5 3.5 1 4.5a7.7 7.7 0 0 1-4-4.5M12 19.6c-.8-1.1-1.5-3-1.8-6.7h3.6c-.3 3.7-1 5.6-1.8 6.7m2.8-2.2c.5-1 .8-2.7 1-4.5h3a7.7 7.7 0 0 1-4 4.5"/></svg>',
    logs:'<svg viewBox="0 0 24 24"><path d="M6 3.5h12A1.5 1.5 0 0 1 19.5 5v14A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5m2.2 4v2h7.6v-2zm0 4v2h7.6v-2zm0 4v2h5.6v-2z"/></svg>',
    settings:'<svg viewBox="0 0 24 24"><path d="m19.2 13.7 1.5 1.1-1.9 3.3-1.8-.8c-.45.35-.95.65-1.5.85L15.2 20h-4.4l-.3-1.85c-.55-.2-1.05-.5-1.5-.85l-1.8.8-1.9-3.3 1.5-1.1a6.2 6.2 0 0 1 0-1.4l-1.5-1.1 1.9-3.3 1.8.8c.45-.35.95-.65 1.5-.85L10.8 5h4.4l.3 1.85c.55.2 1.05.5 1.5.85l1.8-.8 1.9 3.3-1.5 1.1a6.2 6.2 0 0 1 0 1.4M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6"/></svg>',
    theme:'<svg viewBox="0 0 24 24"><path d="M21 14.4A8.7 8.7 0 1 1 9.6 3 7.1 7.1 0 0 0 21 14.4z"/></svg>',
    device:'<svg viewBox="0 0 24 24"><path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 3v11h10V6H7Zm4 12v1h2v-1h-2Z"/></svg>'
  };
  const clsToKey = [['icon-home','home'],['icon-history','history'],['icon-images','images'],['icon-video','video'],['icon-chat','chat'],['icon-api','api'],['icon-tools','tools'],['icon-lan','lan'],['icon-public','public'],['icon-logs','logs'],['icon-settings','settings'],['icon-theme','theme'],['icon-device','device']];
  document.querySelectorAll('.nav-icon').forEach(el=>{
    const item = clsToKey.find(([cls])=>el.classList.contains(cls));
    if(item) el.innerHTML = svg[item[1]];
  });
}
normalizeNavIcons();

// V7.2: use fixed-position smart tooltip so help text is never clipped by cards/scroll areas.
function setupSmartTooltips(){
  let tip = document.querySelector('.smart-tooltip');
  if(!tip){
    tip = document.createElement('div');
    tip.className = 'smart-tooltip';
    document.body.appendChild(tip);
  }
  function show(el){
    const text = el.getAttribute('data-tip') || el.getAttribute('title') || '';
    if(!text.trim()) return;
    tip.textContent = text;
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth || 360;
    const th = tip.offsetHeight || 60;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - tw - 12));
    let top = r.top - th - 12;
    if(top < 12) top = r.bottom + 12;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hide(){ tip.classList.remove('show'); }
  document.addEventListener('mouseover', e=>{
    const el = e.target.closest && e.target.closest('.info-dot[data-tip]');
    if(el) show(el);
  });
  document.addEventListener('mouseout', e=>{
    const el = e.target.closest && e.target.closest('.info-dot[data-tip]');
    if(el) hide();
  });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
setupSmartTooltips();






// V10.6: robust in-app input dialog for prompt library groups. Native prompt can be blocked/hidden in Electron, causing "click no response".
function promptLibraryInputDialog(title, defaultValue = ''){
  return new Promise(resolve=>{
    let modal = document.getElementById('promptLibraryInputDialog');
    if(!modal){
      modal = document.createElement('div');
      modal.id = 'promptLibraryInputDialog';
      modal.className = 'pl-input-dialog';
      modal.innerHTML = `<div class="pl-input-box glass"><h3 id="plInputTitle"></h3><input id="plInputValue" /><div class="actions"><button class="primary" id="plInputOk">确定</button><button class="secondary" id="plInputCancel">取消</button></div></div>`;
      document.body.appendChild(modal);
    }
    const titleEl = modal.querySelector('#plInputTitle');
    const input = modal.querySelector('#plInputValue');
    const ok = modal.querySelector('#plInputOk');
    const cancel = modal.querySelector('#plInputCancel');
    titleEl.textContent = title;
    input.value = defaultValue || '';
    modal.classList.add('active');
    input.focus();
    input.select();
    const done = (value)=>{
      modal.classList.remove('active');
      ok.onclick = cancel.onclick = null;
      input.onkeydown = null;
      resolve(value);
    };
    ok.onclick = ()=>done(input.value.trim());
    cancel.onclick = ()=>done('');
    input.onkeydown = e=>{ if(e.key === 'Enter') done(input.value.trim()); if(e.key === 'Escape') done(''); };
  });
}
async function promptLibraryCreateGroup(){
  if(!plCanWrite()) return alert('当前没有新建分组权限，请在设置中心开启“提示词库权限共享”，或在本机管理端操作。');
  const name = await promptLibraryInputDialog('新建分组', '');
  if(!name) return;
  try{
    await api('/api/prompt_library/group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name, action:'create'})});
    await loadPromptLibrary();
    toast('分组已创建');
  }catch(err){ alert(err.message || '新建分组失败'); }
}
async function promptLibraryRenameGroup(id, oldName=''){
  if(!plCanWrite()) return alert('当前没有分组编辑权限，请在设置中心开启“提示词库权限共享”，或在本机管理端操作。');
  if(!id || id === 'all') return alert('“全部”是筛选入口，不能重命名。');
  const name = await promptLibraryInputDialog('重命名分组', oldName || '');
  if(!name) return;
  try{
    await api('/api/prompt_library/group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id, name, action:'update'})});
    await loadPromptLibrary();
    toast('分组已重命名');
  }catch(err){ alert(err.message || '分组重命名失败'); }
}
async function promptLibraryDeleteGroup(id, oldName=''){
  if(!plCanWrite()) return alert('当前没有分组删除权限，请在设置中心开启“提示词库权限共享”，或在本机管理端操作。');
  if(!id || id === 'all') return alert('“全部”是筛选入口，不能删除。');
  if(!confirm(`确定删除「${oldName || '该分组'}」？\n分组里的提示词模板会自动移动到其他分组，不会删除模板。`)) return;
  try{
    await api('/api/prompt_library/group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id, action:'delete'})});
    promptLibraryCurrentGroup='all';
    await loadPromptLibrary();
    toast('分组已删除');
  }catch(err){ alert(err.message || '分组删除失败'); }
}
function setupPromptLibraryHardBindings(){
  if(document.body.dataset.promptLibraryHardBindings === '1') return;
  document.body.dataset.promptLibraryHardBindings = '1';
  document.addEventListener('click', async e=>{
    const newBtn = e.target.closest('#newPromptLibraryGroupBtn');
    if(newBtn){ e.preventDefault(); e.stopPropagation(); await promptLibraryCreateGroup(); return; }
    const icon = e.target.closest('#promptLibraryGroups .pl-icon-btn[data-act]');
    if(icon){
      e.preventDefault(); e.stopPropagation();
      const group = icon.closest('.pl-group');
      const id = icon.dataset.id || group?.dataset.id || '';
      const oldName = group?.querySelector('.pl-group-name')?.textContent?.trim() || '';
      if(icon.dataset.act === 'rename') await promptLibraryRenameGroup(id, oldName);
      if(icon.dataset.act === 'delete') await promptLibraryDeleteGroup(id, oldName);
      return;
    }
  }, true);
}

// V10.3: Prompt Library floating window.
let promptLibraryData = { groups:[], templates:[], can_write:false, can_manage:false };
let promptLibraryCurrentGroup = 'all';
let promptLibraryEditingId = '';
function plCanWrite(){ return !!promptLibraryData.can_write; }
function plGroups(){ return (promptLibraryData.groups || []).filter(g=>g.id !== 'all' || true); }
async function loadPromptLibrary(){
  try{ promptLibraryData = await api('/api/prompt_library'); renderPromptLibrary(); }
  catch(e){ toast(e.message || '提示词库加载失败'); }
}
function openPromptLibrary(){ $('#promptLibraryLayer')?.classList.add('active'); $('#promptLibraryOrb')?.classList.remove('show'); bringFloatingLayer('#promptLibraryLayer', '#promptLibraryWindow'); loadPromptLibrary(); }
function closePromptLibrary(){ $('#promptLibraryLayer')?.classList.remove('active'); $('#promptLibraryOrb')?.classList.remove('show'); }
function minimizePromptLibrary(){ $('#promptLibraryLayer')?.classList.remove('active'); $('#promptLibraryOrb')?.classList.add('show'); }
function renderPromptLibrary(){
  const groups = promptLibraryData.groups || [];
  const canWrite = plCanWrite();
  const gbox = $('#promptLibraryGroups');
  if(gbox){
    gbox.innerHTML = groups.map(g=>{
      const actions = (canWrite && !g.virtual) ? `<span class="pl-group-actions"><button class="pl-icon-btn" data-act="rename" data-id="${g.id}" title="重命名分组" aria-label="重命名分组">✎</button><button class="pl-icon-btn danger" data-act="delete" data-id="${g.id}" title="删除分组" aria-label="删除分组">×</button></span>` : '';
      return `<div class="pl-group ${promptLibraryCurrentGroup===g.id?'active':''}" data-id="${g.id}"><span class="pl-group-name" data-act="select" data-id="${g.id}">${escapeHtml(g.name)}</span>${actions}</div>`;
    }).join('');
    if(!gbox.dataset.delegateBound){
      gbox.dataset.delegateBound = '1';
      gbox.addEventListener('click', async e=>{
        const btn = e.target.closest('[data-act]');
        if(!btn) return;
        const act = btn.dataset.act;
        const id = btn.dataset.id || btn.closest('.pl-group')?.dataset.id;
        if(!id) return;
        e.stopPropagation();
        if(act==='select'){
          promptLibraryCurrentGroup = id;
          renderPromptLibrary();
          return;
        }
        if(act==='rename'){
          if(!plCanWrite()) return alert('当前没有分组编辑权限，请在设置中心开启“提示词库权限共享”，或在本机管理端操作。');
          const oldName = btn.closest('.pl-group')?.querySelector('.pl-group-name')?.textContent || '';
          const name = prompt('请输入新的分组名称', oldName);
          if(!name || !name.trim()) return;
          try{
            await api('/api/prompt_library/group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id, name:name.trim(), action:'update'})});
            await loadPromptLibrary();
            toast('分组已重命名');
          }catch(err){ alert(err.message || '分组重命名失败'); }
          return;
        }
        if(act==='delete'){
          if(!plCanWrite()) return alert('当前没有分组删除权限，请在设置中心开启“提示词库权限共享”，或在本机管理端操作。');
          const oldName = btn.closest('.pl-group')?.querySelector('.pl-group-name')?.textContent || '该分组';
          if(!confirm(`确定删除「${oldName}」？\n分组里的提示词模板会自动移动到其他分组，不会删除模板。`)) return;
          try{
            await api('/api/prompt_library/group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id, action:'delete'})});
            promptLibraryCurrentGroup='all';
            await loadPromptLibrary();
            toast('分组已删除');
          }catch(err){ alert(err.message || '分组删除失败'); }
          return;
        }
      });
    }
  }
  const select = $('#plGroup'); if(select) select.innerHTML = groups.filter(g=>!g.virtual).map(g=>`<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
  const q=($('#promptLibrarySearch')?.value||'').toLowerCase(); const type=$('#promptLibraryTypeFilter')?.value||'';
  let list=(promptLibraryData.templates||[]).filter(t=> promptLibraryCurrentGroup==='all' || t.group_id===promptLibraryCurrentGroup);
  if(type) list=list.filter(t=>t.type===type);
  if(q) list=list.filter(t=>JSON.stringify([t.title,t.content,t.tags,t.type]).toLowerCase().includes(q));
  const lbox=$('#promptLibraryList');
  if(lbox) lbox.innerHTML = list.map(t=>`<article class="pl-card"><div class="pl-card-head"><b>${escapeHtml(t.title)}</b><span>${escapeHtml(t.type||'通用')}</span></div><div class="pl-tags">${(t.tags||[]).map(x=>`<em>${escapeHtml(x)}</em>`).join('')}</div><pre>${escapeHtml(t.content||'')}</pre><div class="actions"><button class="primary" data-act="apply" data-id="${t.id}">应用</button><button class="secondary" data-act="copy" data-id="${t.id}">复制</button>${canWrite?`<button class="secondary" data-act="edit" data-id="${t.id}">编辑</button><button class="danger" data-act="delete" data-id="${t.id}">删除</button>`:''}</div></article>`).join('') || '<div class="announcement-empty">暂无提示词模板</div>';
  lbox?.querySelectorAll('button[data-act]').forEach(btn=>btn.addEventListener('click',async()=>{
    const t=(promptLibraryData.templates||[]).find(x=>x.id===btn.dataset.id); if(!t) return;
    const act=btn.dataset.act;
    if(act==='copy'){ await copyTextSmart(t.content||'', '提示词'); toast('提示词已复制'); }
    if(act==='apply'){
      const el=$('#prompts'); if(!el) return;
      if(el.value.trim()) { const mode=confirm('当前提示词不为空，确定替换吗？\n点击“取消”则追加到末尾。')?'replace':'append'; el.value = mode==='replace' ? t.content : (el.value.trim()+"\n\n"+t.content); }
      else el.value=t.content;
      calcEstimate(); setPage('home'); toast('已应用到首页提示词');
    }
    if(act==='edit'){ showPromptLibraryEditor(t); }
    if(act==='delete'){ if(confirm('确定删除这个提示词模板？')){ await api('/api/prompt_library/template',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:t.id, action:'delete'})}); await loadPromptLibrary(); } }
  }));
  $('#newPromptLibraryTemplateBtn')?.classList.toggle('hidden', !canWrite); $('#newPromptLibraryGroupBtn')?.classList.toggle('hidden', !canWrite);
}
function showPromptLibraryEditor(t={}){
  promptLibraryEditingId=t.id||''; $('#promptLibraryEditor')?.classList.add('show'); $('#promptLibraryEditorTitle').textContent=t.id?'编辑模板':'新建模板';
  $('#plTitle').value=t.title||''; $('#plGroup').value=t.group_id||'uncategorized'; $('#plType').value=t.type||'通用'; $('#plTags').value=(t.tags||[]).join(', '); $('#plContent').value=t.content||''; $('#plNote').value=t.note||'';
}
function hidePromptLibraryEditor(){ promptLibraryEditingId=''; $('#promptLibraryEditor')?.classList.remove('show'); }
function setupPromptLibrary(){
  $('#promptLibraryBtn')?.addEventListener('click', openPromptLibrary);
  $('#closePromptLibraryWindow')?.addEventListener('click', closePromptLibrary);
  $('#minimizePromptLibraryWindow')?.addEventListener('click', minimizePromptLibrary);
  $('#promptLibraryOrb')?.addEventListener('click', openPromptLibrary);
  $('#promptLibrarySearch')?.addEventListener('input', renderPromptLibrary);
  $('#promptLibraryTypeFilter')?.addEventListener('change', renderPromptLibrary);
  $('#newPromptLibraryTemplateBtn')?.addEventListener('click',()=>showPromptLibraryEditor({group_id:promptLibraryCurrentGroup==='all'?'uncategorized':promptLibraryCurrentGroup}));
  $('#cancelPromptLibraryEditBtn')?.addEventListener('click', hidePromptLibraryEditor);
  $('#newPromptLibraryGroupBtn')?.addEventListener('click', promptLibraryCreateGroup);
  $('#savePromptLibraryTemplateBtn')?.addEventListener('click',async()=>{ const body={ id:promptLibraryEditingId, title:$('#plTitle').value, group_id:$('#plGroup').value, type:$('#plType').value, tags:$('#plTags').value, content:$('#plContent').value, note:$('#plNote').value }; await api('/api/prompt_library/template',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); hidePromptLibraryEditor(); await loadPromptLibrary(); toast('提示词模板已保存'); });
  makeFloatingBox('promptLibraryWindow','promptLibraryHead','promptLibraryResize');
  makeFloatingBox('promptLibraryOrb','promptLibraryOrb',null);
  setupPromptLibraryHardBindings();
}
let floatingZIndex = 420;
function bringFloatingLayer(layerSelector, windowSelector){
  floatingZIndex += 2;
  const layer = $(layerSelector);
  const win = $(windowSelector);
  if(layer) layer.style.zIndex = String(floatingZIndex);
  if(win) win.style.zIndex = String(floatingZIndex + 1);
}
function makeFloatingBox(boxId, headId, resizeId){
  const box=$('#'+boxId), head=$('#'+headId), resize=resizeId?$('#'+resizeId):null; if(!box||!head||box.dataset.floatReady) return; box.dataset.floatReady='1';
  const bring = ()=>{ const layer = box.closest('.prompt-library-layer,.asset-library-layer,.chat-popout-modal'); if(layer){ floatingZIndex += 2; layer.style.zIndex = String(floatingZIndex); box.style.zIndex = String(floatingZIndex + 1); } };
  box.addEventListener('mousedown', bring, true);
  let dragging=false, sx=0, sy=0, sl=0, st=0; head.addEventListener('mousedown',e=>{ bring(); if(e.target.closest('button,input,select,textarea')) return; dragging=true; sx=e.clientX; sy=e.clientY; const r=box.getBoundingClientRect(); sl=r.left; st=r.top; e.preventDefault(); });
  document.addEventListener('mousemove',e=>{ if(!dragging) return; box.style.left=Math.max(0,sl+e.clientX-sx)+'px'; box.style.top=Math.max(0,st+e.clientY-sy)+'px'; }); document.addEventListener('mouseup',()=>dragging=false);
  if(resize){ let rs=false,rw=0,rh=0; resize.addEventListener('mousedown',e=>{rs=true; sx=e.clientX; sy=e.clientY; const r=box.getBoundingClientRect(); rw=r.width; rh=r.height; e.preventDefault();}); document.addEventListener('mousemove',e=>{ if(!rs) return; box.style.width=Math.max(520,rw+e.clientX-sx)+'px'; box.style.height=Math.max(420,rh+e.clientY-sy)+'px';}); document.addEventListener('mouseup',()=>rs=false); }
}

// V14.10.33 Asset Library
const ASSET_SIDEBAR_PIN_KEY = 'LAIG_ASSET_SIDEBAR_PINNED';
const assetState = { ready:false, groups:[], assets:[], allAssets:[], currentGroup:'', selected:new Set(), batch:false, isHost:false, settings:{}, clientId:'', sidebarPinned:localStorage.getItem(ASSET_SIDEBAR_PIN_KEY)==='1', editingGroupId:'', collapsedGroups:new Set() };
function assetGroupById(id){ return (assetState.groups||[]).find(g=>g.id===id) || {}; }
function assetCanEdit(row={}){ return assetState.isHost || row.permission === 'host' || row.permission === 'owner' || row.owner_client_id === assetState.clientId; }
function assetCanUploadToCurrentGroup(){ const g = assetGroupById(assetState.currentGroup); return !!assetState.currentGroup && assetCanEdit(g); }
function assetDescendantGroupIds(groupId){
  const start = String(groupId || '');
  const out = new Set();
  const walk = (id)=>{
    if(!id || out.has(id)) return;
    out.add(id);
    (assetState.groups || []).filter(g=>String(g.parent_id || '') === id).forEach(g=>walk(g.id));
  };
  walk(start);
  return out;
}
function assetRecursiveCountMap(){
  const direct = new Map();
  (assetState.allAssets || []).forEach(a=>direct.set(a.group_id,(direct.get(a.group_id)||0)+1));
  const memo = new Map();
  const count = (id)=>{
    if(memo.has(id)) return memo.get(id);
    let n = direct.get(id) || 0;
    (assetState.groups || []).filter(g=>String(g.parent_id || '') === id).forEach(g=>{ n += count(g.id); });
    memo.set(id, n);
    return n;
  };
  (assetState.groups || []).forEach(g=>count(g.id));
  return memo;
}
function assetFormatSize(n=0){ n=Number(n||0); if(n>1024*1024) return (n/1024/1024).toFixed(1)+' MB'; if(n>1024) return (n/1024).toFixed(1)+' KB'; return n+' B'; }
function assetIcon(type){ return type==='video'?'🎬':type==='image'?'🖼':'📄'; }
function assetActionSvg(type){
  if(type === 'copy') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h10v12H8zM6 16H4V4h12v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  if(type === 'download') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0l-4-4m4 4l4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6m4-6v6M9 7l1-3h4l1 3m-8 0l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
async function loadAssetLibrary(){
  try{
    const ret = await api('/api/assets/init');
    assetState.ready = true; assetState.groups = ret.groups || []; assetState.allAssets = ret.assets || []; assetState.assets = ret.assets || []; assetState.isHost = !!ret.is_host; assetState.clientId = ret.client_id || ''; assetState.settings = ret.settings || {};
    if(!assetState.currentGroup || !assetState.groups.some(g=>g.id===assetState.currentGroup)) assetState.currentGroup = assetState.groups[0]?.id || '';
    if($('#assetLibraryDir')) $('#assetLibraryDir').value = assetState.settings.dir || '';
    renderAssetLibrary();
    await loadAssetAssets();
  }catch(e){ toast(e.message || '资产库加载失败'); }
}
async function loadAssetAssets(){
  if(!assetState.currentGroup) return renderAssetLibrary();
  const q = ($('#assetLibrarySearch')?.value || '').trim();
  const ret = await api('/api/assets/list?group_id='+encodeURIComponent(assetState.currentGroup)+'&search='+encodeURIComponent(q));
  assetState.assets = ret.assets || [];
  const visibleIds = new Set(assetState.assets.map(a=>a.id));
  assetState.selected.forEach(id=>{ if(!visibleIds.has(id)) assetState.selected.delete(id); });
  renderAssetLibrary();
}
function openAssetLibrary(){ $('#assetLibraryLayer')?.classList.add('active'); $('#assetLibraryOrb')?.classList.remove('show'); bringFloatingLayer('#assetLibraryLayer', '#assetLibraryWindow'); loadAssetLibrary(); }
function closeAssetLibrary(){ $('#assetLibraryLayer')?.classList.remove('active'); $('#assetLibraryOrb')?.classList.remove('show'); }
function minimizeAssetLibrary(){ $('#assetLibraryLayer')?.classList.remove('active'); $('#assetLibraryOrb')?.classList.add('show'); }
function renderAssetLibrary(){
  const groupCounts = assetRecursiveCountMap();
  const tree = $('#assetGroupTree');
  if(tree){
    const groups = assetState.groups || [];
    const rows = [];
    const renderSection = (title, subtitle, predicate, showHeader=true) => {
      const sectionGroups = groups.filter(predicate);
      if(!sectionGroups.length) return;
      const ids = new Set(sectionGroups.map(g=>g.id));
      if(showHeader) rows.push(`<div class="asset-tree-section"><b>${escapeHtml(title)}</b>${subtitle?`<span>${escapeHtml(subtitle)}</span>`:''}</div>`);
      const walk = (parent='', level=0) => {
        sectionGroups.filter(g=>(g.parent_id||'')===parent || (level===0 && g.parent_id && !ids.has(g.parent_id))).sort((a,b)=>Number(a.sort_order||0)-Number(b.sort_order||0)).forEach(g=>{
          const readonly = g.readonly || g.permission === 'shared_viewer';
          const owner = g.owner_name || g.owner_client_id || '';
          const prefix = level > 0 ? '-'.repeat(level * 2) : '';
          const hasChildren = sectionGroups.some(child=>String(child.parent_id || '') === String(g.id || ''));
          const collapsed = hasChildren && assetState.collapsedGroups.has(g.id);
          const namePart = assetState.editingGroupId === g.id && !readonly
            ? `<input class="asset-group-name-edit" data-group-edit value="${escapeHtml(g.name||'未命名')}" />`
            : `<span class="asset-group-name">${escapeHtml(g.name||'未命名')}</span>`;
          const toggle = hasChildren ? `<button class="asset-group-toggle ${collapsed?'collapsed':''}" data-group-toggle="${escapeHtml(g.id)}" title="${collapsed?'展开子级':'折叠子级'}" aria-label="${collapsed?'展开子级':'折叠子级'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 10l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : '';
          rows.push(`<div class="asset-group-row ${assetState.currentGroup===g.id?'active':''} ${readonly?'readonly':''} ${hasChildren?'has-children':''}" data-id="${escapeHtml(g.id)}" style="padding-left:${10+level*16}px"><span class="asset-folder-icon">${prefix}</span>${namePart}${g.shared?'<em class="asset-share-mark">共享</em>':''}${readonly?`<em class="asset-readonly-mark">只读</em>`:''}<span class="count">${groupCounts.get(g.id)||0}</span>${toggle}${owner && readonly ? `<span class="asset-owner-tip" title="来自 ${escapeHtml(owner)}">${escapeHtml(owner)}</span>` : ''}</div>`);
          if(!collapsed) walk(g.id, level+1);
        });
      };
      walk('');
    };
    if(assetState.isHost){
      renderSection('', '', ()=>true, false);
    }else{
      renderSection('我的资产', '只能自己管理', g=>assetCanEdit(g));
      renderSection('共享给我的资产', '只读查看 / 下载 / 使用', g=>!assetCanEdit(g) && (g.shared || g.permission === 'shared_viewer'));
    }
    if(!rows.length){
      rows.push('<div class="asset-empty">暂无分组，点击 + 新建分组。</div>');
    }
    tree.innerHTML = rows.join('');
    const editInput = tree.querySelector('[data-group-edit]');
    if(editInput){ setTimeout(()=>{ editInput.focus(); editInput.select(); }, 0); }
  }
  const g = assetGroupById(assetState.currentGroup);
  if($('#assetCurrentGroupTitle')) $('#assetCurrentGroupTitle').textContent = g.name || '暂无资产库';
  if($('#assetCurrentGroupMeta')) $('#assetCurrentGroupMeta').textContent = assetState.currentGroup ? `${assetState.assets.length} 个素材` : '暂无资产库，点击新建分组';
  if($('#assetClientBadge')) $('#assetClientBadge').textContent = assetState.isHost ? '主机' : '访问端';
  const canManageCurrentGroup = assetCanEdit(g);
  $('#assetShareCurrentGroupBtn')?.classList.toggle('active', !!g.shared);
  if($('#assetShareCurrentGroupBtn')) $('#assetShareCurrentGroupBtn').disabled = !assetState.currentGroup || !canManageCurrentGroup;
  if($('#assetNewChildGroupBtn')) $('#assetNewChildGroupBtn').disabled = !assetState.currentGroup || !canManageCurrentGroup;
  if($('#assetRenameGroupBtn')) $('#assetRenameGroupBtn').disabled = !assetState.currentGroup || !canManageCurrentGroup;
  if($('#assetDeleteGroupBtn')) $('#assetDeleteGroupBtn').disabled = !assetState.currentGroup || !canManageCurrentGroup;
  if($('#assetNewChildGroupBtn')) $('#assetNewChildGroupBtn').disabled = false;
  if($('#assetUploadTopBtn')) $('#assetUploadTopBtn').disabled = !assetCanUploadToCurrentGroup();
  $('#assetLibraryWindow')?.classList.toggle('asset-sidebar-pinned', !!assetState.sidebarPinned);
  $('#assetLibraryWindow')?.classList.toggle('asset-sidebar-collapsed', !assetState.sidebarPinned);
  $('#assetSidebarPinBtn')?.classList.toggle('active', !!assetState.sidebarPinned);
  $('#assetLibraryWindow')?.classList.toggle('asset-readonly-current', !assetCanUploadToCurrentGroup());
  if($('#assetDropStatus')) $('#assetDropStatus').textContent = assetState.currentGroup ? (assetCanUploadToCurrentGroup() ? '拖入文件到右侧任意位置即可上传' : '共享资产为只读，只能查看、下载、复制资产和使用') : '请先新建或选择一个资产库';
  $('#assetLibraryWindow')?.classList.toggle('batch-mode', assetState.batch);
  $('#assetBulkBar')?.classList.toggle('hidden', !assetState.batch);
  if($('#assetBulkCount')) $('#assetBulkCount').textContent = `已选择 ${assetState.selected.size} 个素材`;
  const grid = $('#assetGrid');
  if(grid){
    grid.innerHTML = (assetState.assets||[]).map(a=>{
      const thumb = a.type === 'image' ? (a.thumb_url || a.url) : (a.type === 'video' ? (a.thumb_url || '') : '');
      const readonly = !assetCanEdit(a);
      const ownerText = a.owner_name || a.owner_client_id || '';
      const selected = assetState.selected.has(a.id);
      const badge = readonly ? `<span class="asset-shared-badge readonly">共享 · 来自 ${escapeHtml(ownerText)} · 只读</span>` : (a.shared ? '<span class="asset-shared-badge">已共享</span>' : '');
      const media = thumb ? `<img src="${withPublicAccess(thumb)}" loading="lazy" />` : (a.type==='video' ? `<video class="asset-video-thumb" data-asset-video-thumb src="${withPublicAccess(a.url)}" muted playsinline preload="metadata"></video><span class="asset-file-icon asset-video-fallback">${assetIcon(a.type)}</span>` : `<span class="asset-file-icon">${assetIcon(a.type)}</span>`);
      const groupName = assetGroupById(a.group_id).name || '';
      return `<article class="asset-card ${a.type==='video'?'video':''} ${selected?'selected':''} ${readonly?'readonly':''}" data-id="${escapeHtml(a.id)}" draggable="true">${selected?'<div class="asset-card-check">✓</div>':''}${badge}<div class="asset-thumb">${media}</div><div class="asset-info"><div class="asset-name" data-asset-name title="${readonly?'共享素材只读':'双击重命名'}">${escapeHtml(a.name||'未命名素材')}</div><div class="asset-meta">${escapeHtml(a.type||'file')} · ${groupName?escapeHtml(groupName)+' · ':''}${assetFormatSize(a.size)} · ${escapeHtml(formatBeijingTime(a.created_at)||'')}</div></div><div class="asset-card-actions"><button class="asset-card-icon-btn" data-act="copy" title="复制资产源文件" aria-label="复制资产源文件">${assetActionSvg('copy')}</button><button class="asset-card-icon-btn" data-act="download" title="下载" aria-label="下载">${assetActionSvg('download')}</button>${assetCanEdit(a)?`<button class="asset-card-icon-btn danger" data-act="delete" title="删除" aria-label="删除">${assetActionSvg('delete')}</button>`:''}</div></article>`;
    }).join('') || '<div class="asset-empty">暂无素材，点击右上角“上传素材”或拖拽文件到这里。</div>';
    assetHydrateVideoThumbs();
  }
}
async function assetCreateGroup(parentId=''){
  const isProject = !parentId;
  const ret = await api('/api/assets/groups/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:isProject?'新建项目库':'新建分组',parent_id:parentId || null})});
  if(ret.group?.id) assetState.currentGroup = ret.group.id;
  assetState.editingGroupId = ret.group?.id || '';
  await loadAssetLibrary(); toast('分组已创建，请输入名称');
}
function assetStartGroupRename(id){ const g=assetGroupById(id); if(!g.id) return toast('请先选择资产库类目'); if(!assetCanEdit(g)) return toast('没有权限重命名该分组'); assetState.editingGroupId = id; renderAssetLibrary(); }
async function assetSaveGroupName(id, name){
  const clean = String(name || '').trim();
  const g = assetGroupById(id);
  assetState.editingGroupId = '';
  if(!clean || clean === g.name){ renderAssetLibrary(); return; }
  await api('/api/assets/groups/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({group_id:id,name:clean})});
  await loadAssetLibrary(); toast('分组已重命名');
}
async function assetDeleteGroup(id){ if(!confirm('删除后该分组及其子分组、素材将被移除，此操作不可恢复。')) return; await api('/api/assets/groups/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({group_id:id})}); const idx = assetState.groups.findIndex(g=>g.id===id); const next = assetState.groups[idx-1] || assetState.groups[idx+1] || null; assetState.currentGroup = next ? next.id : ''; assetState.editingGroupId=''; await loadAssetLibrary(); toast('库/分组已删除'); }
async function assetUploadFiles(files){
  const list=[...files]; if(!list.length) return;
  if(!assetCanUploadToCurrentGroup()) return toast('共享资产为只读，不能上传到该分组');
  const items=[];
  for(const f of list.slice(0,50)) {
    const item = await fileToData(f);
    if(/^video\//i.test(f.type || '') || /\.(mp4|mov|webm|m4v)$/i.test(f.name || '')){
      try{ item.thumb_data = await assetMakeVideoThumbData(f); }catch(e){}
    }
    items.push(item);
  }
  await api('/api/assets/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({group_id:assetState.currentGroup, files:items})});
  await loadAssetLibrary(); toast(`已上传 ${items.length} 个素材`);
}
function assetSelectedIds(){ return [...assetState.selected]; }
async function assetDeleteIds(ids){ if(!ids.length) return toast('请先选择素材'); if(!confirm(`确定删除 ${ids.length} 个素材吗？`)) return; await api('/api/assets/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})}); ids.forEach(id=>assetState.selected.delete(id)); await loadAssetLibrary(); toast('素材已删除'); }
async function assetShareIds(ids, shared=true){ if(!ids.length) return toast('请先选择素材'); await api(shared?'/api/assets/share':'/api/assets/unshare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})}); await loadAssetLibrary(); toast(shared?'素材已共享':'已取消共享'); }
async function assetDownloadIds(ids){ if(!ids.length) return toast('请先选择素材'); const r=await api('/api/assets/export_zip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})}); if(r.url) window.open(withPublicAccess(r.url),'_blank'); }
async function assetSaveDir(migrate=false){ const dir=($('#assetLibraryDir')?.value||'').trim(); const ret=await api('/api/assets/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir,migrate})}); if(ret.dir && $('#assetLibraryDir')) $('#assetLibraryDir').value=ret.dir; toast(migrate?'资产库目录已迁移':'资产库目录已保存'); }
async function assetToggleCurrentGroupShared(){
  const g = assetGroupById(assetState.currentGroup);
  if(!g.id) return toast('请先选择资产库类目');
  const nextShared = !g.shared;
  await api(nextShared?'/api/assets/share':'/api/assets/unshare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({group_ids:[g.id]})});
  await loadAssetLibrary();
  toast(nextShared ? '当前类目已共享' : '当前类目已取消共享');
}
async function assetRenameAsset(id, name){
  const clean = String(name || '').trim();
  if(!id || !clean) return;
  await api('/api/assets/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name:clean})});
  await loadAssetAssets();
  toast('素材已重命名');
}
async function assetCopyAsset(a){
  if(!a) return;
  const source = a.source_url || a.url || a.download_url || '';
  if(isLocalClient){
    try{
      await api('/api/assets/copy_source',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:a.id})});
      toast('资产源文件已复制到剪贴板');
      return;
    }catch(e){}
  }
  if(a.type === 'image'){
    try{
      const mode = await copyImageFromUrl(source);
      toast(mode === 'image' ? '原图素材已复制' : '浏览器未开放图片剪贴板，已复制源文件链接');
      return;
    }catch(e){
      toast('原图读取失败：' + (e.message || e));
      return;
    }
  }
  window.open(withPublicAccess(a.download_url || source), '_blank');
  toast('浏览器不允许把文件直接写入系统剪贴板，已下载资产源文件');
}
async function assetCopyLink(a){
  if(!a) return;
  await copyTextSmart(publicCopyUrl(a.url || a.download_url || ''), '资产链接');
  toast('资产链接已复制');
}
async function assetMoveIds(ids, groupId){
  const cleanIds = [...new Set((ids || []).filter(Boolean))];
  if(!cleanIds.length || !groupId) return;
  await api('/api/assets/move',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:cleanIds,group_id:groupId})});
  assetState.selected.clear();
  await loadAssetLibrary();
  toast(`已移动 ${cleanIds.length} 个资产源文件`);
}
function ensureAssetContextMenu(){
  let menu = $('#assetContextMenu');
  if(menu) return menu;
  menu = document.createElement('div');
  menu.id = 'assetContextMenu';
  menu.className = 'asset-context-menu hidden';
  menu.innerHTML = '<button data-asset-menu="copy">复制资产</button><button data-asset-menu="copylink">复制资产链接</button><button data-asset-menu="download">下载资产</button>';
  document.body.appendChild(menu);
  menu.addEventListener('click', async e=>{
    const act = e.target.closest('button')?.dataset.assetMenu;
    const a = assetState.assets.find(x=>x.id === menu.dataset.assetId);
    hideAssetContextMenu();
    if(!a || !act) return;
    if(act === 'copy') return assetCopyAsset(a);
    if(act === 'copylink') return assetCopyLink(a);
    if(act === 'download') window.open(withPublicAccess(a.download_url || a.url), '_blank');
  });
  document.addEventListener('click', hideAssetContextMenu);
  return menu;
}
function hideAssetContextMenu(){ $('#assetContextMenu')?.classList.add('hidden'); }
function showAssetContextMenu(e, id){
  const menu = ensureAssetContextMenu();
  menu.dataset.assetId = id || '';
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 176)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 138)}px`;
  menu.classList.remove('hidden');
}
function assetMakeVideoThumbData(file){
  return new Promise((resolve, reject)=>{
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let done = false;
    const cleanup = ()=>{ URL.revokeObjectURL(url); video.remove(); };
    const fail = (err)=>{ if(done) return; done = true; cleanup(); reject(err || new Error('视频缩略图生成失败')); };
    const ok = ()=>{
      if(done) return;
      try{
        const w = video.videoWidth || 640;
        const h = video.videoHeight || 360;
        const max = 420;
        const scale = Math.min(max / Math.max(w, h), 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        done = true;
        const data = canvas.toDataURL('image/webp', .82);
        cleanup();
        resolve(data);
      }catch(e){ fail(e); }
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.addEventListener('loadedmetadata', ()=>{
      try{ video.currentTime = Math.min(0.1, Math.max(0, (video.duration || 0.1) / 20)); }
      catch(e){ ok(); }
    }, {once:true});
    video.addEventListener('loadeddata', ()=>{ if(!video.seeking) setTimeout(ok, 50); }, {once:true});
    video.addEventListener('seeked', ok, {once:true});
    video.addEventListener('error', ()=>fail(new Error('视频无法读取')), {once:true});
    setTimeout(()=>fail(new Error('视频缩略图生成超时')), 3500);
    video.src = url;
  });
}
function assetHydrateVideoThumbs(){
  requestAnimationFrame(()=>{
    $$('.asset-video-thumb[data-asset-video-thumb]').forEach(v=>{
      if(v.dataset.ready) return;
      v.dataset.ready = '1';
      v.addEventListener('loadeddata', ()=>{
        try{ v.currentTime = Math.min(0.2, v.duration || 0.2); }catch(e){}
      }, {once:true});
      v.addEventListener('seeked', ()=>{
        try{
          const canvas = document.createElement('canvas');
          canvas.width = v.videoWidth || 320;
          canvas.height = v.videoHeight || 180;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          v.poster = canvas.toDataURL('image/jpeg', .82);
          v.pause();
          v.removeAttribute('data-asset-video-thumb');
        }catch(e){}
      }, {once:true});
      try{ v.load(); }catch(e){}
    });
  });
}
function assetBeginRename(card){
  const id = card?.dataset?.id;
  const a = assetState.assets.find(x=>x.id===id);
  if(!a || !assetCanEdit(a)) return toast('没有权限重命名该素材');
  const nameEl = card.querySelector('[data-asset-name]');
  if(!nameEl || nameEl.querySelector('input')) return;
  const old = a.name || '';
  nameEl.innerHTML = `<input class="asset-name-edit" value="${escapeHtml(old)}" />`;
  const input = nameEl.querySelector('input');
  input.focus(); input.select();
  let done = false;
  const finish = async(save=true)=>{
    if(done) return; done = true;
    const next = input.value.trim();
    if(save && next && next !== old) {
      try{ await assetRenameAsset(id, next); }
      catch(e){ toast(e.message || '重命名失败'); nameEl.textContent = old || '未命名素材'; }
    } else {
      nameEl.textContent = old || '未命名素材';
    }
  };
  input.addEventListener('keydown', e=>{
    if(e.key === 'Enter'){ e.preventDefault(); finish(true); }
    if(e.key === 'Escape'){ e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', ()=>finish(true));
}
function setupAssetLibrary(){
  $('#assetLibraryBtn')?.addEventListener('click', openAssetLibrary);
  $('#assetLibraryWindow')?.addEventListener('pointerdown', ()=>bringFloatingLayer('#assetLibraryLayer', '#assetLibraryWindow'), true);
  $('#promptLibraryWindow')?.addEventListener('pointerdown', ()=>bringFloatingLayer('#promptLibraryLayer', '#promptLibraryWindow'), true);
  $('#closeAssetLibraryWindow')?.addEventListener('click', closeAssetLibrary);
  $('#minimizeAssetLibraryWindow')?.addEventListener('click', minimizeAssetLibrary);
  $('#assetLibraryOrb')?.addEventListener('click', openAssetLibrary);
  $('#assetLibrarySearch')?.addEventListener('input', ()=>loadAssetAssets().catch(e=>toast(e.message||'搜索失败')));
  $('#assetBatchToggleBtn')?.addEventListener('click',()=>{assetState.batch=!assetState.batch; assetState.selected.clear(); renderAssetLibrary();});
  $('#assetSidebarToggleBtn')?.addEventListener('click',e=>{ e.stopPropagation(); $('#assetLibraryWindow')?.classList.toggle('asset-sidebar-peek'); });
  $('#assetSidebarPinBtn')?.addEventListener('click',e=>{ e.stopPropagation(); assetState.sidebarPinned = !assetState.sidebarPinned; localStorage.setItem(ASSET_SIDEBAR_PIN_KEY, assetState.sidebarPinned?'1':'0'); renderAssetLibrary(); });
  $('#assetNewChildGroupBtn')?.addEventListener('click',()=>{ const g=assetGroupById(assetState.currentGroup); assetCreateGroup(g.id && assetCanEdit(g) ? g.id : ''); });
  $('#assetNewProjectBtn')?.addEventListener('click',()=>assetCreateGroup(''));
  $('#assetRenameGroupBtn')?.addEventListener('click',()=>assetState.currentGroup && assetStartGroupRename(assetState.currentGroup));
  $('#assetDeleteGroupBtn')?.addEventListener('click',()=>assetState.currentGroup && assetDeleteGroup(assetState.currentGroup));
  $('#assetShareCurrentGroupBtn')?.addEventListener('click',()=>assetToggleCurrentGroupShared().catch(e=>toast(e.message||'共享失败')));
  $('#assetFileInput')?.addEventListener('change',async e=>{ await assetUploadFiles(e.target.files||[]); e.target.value=''; });
  $('#assetUploadTopBtn')?.addEventListener('click',()=>$('#assetFileInput')?.click());
  const drop=$('#assetDropZone');
  drop?.addEventListener('click',()=>$('#assetFileInput')?.click());
  const sidebar=$('.asset-library-sidebar');
  sidebar?.addEventListener('mouseenter',()=>{ if(!assetState.sidebarPinned) $('#assetLibraryWindow')?.classList.add('asset-sidebar-peek'); });
  sidebar?.addEventListener('mouseleave',()=>{ if(!assetState.sidebarPinned) $('#assetLibraryWindow')?.classList.remove('asset-sidebar-peek'); });
  const dropArea=$('.asset-library-main');
  if(dropArea){
    dropArea.addEventListener('dragover',e=>{e.preventDefault(); dropArea.classList.add('drag');});
    dropArea.addEventListener('dragleave',e=>{ if(!dropArea.contains(e.relatedTarget)) dropArea.classList.remove('drag'); });
    dropArea.addEventListener('drop',e=>{e.preventDefault(); dropArea.classList.remove('drag'); assetUploadFiles(e.dataTransfer.files||[]);});
  }
  $('#assetGroupTree')?.addEventListener('click',async e=>{
    const toggle = e.target.closest('[data-group-toggle]');
    if(toggle){
      e.preventDefault();
      e.stopPropagation();
      const id = toggle.dataset.groupToggle;
      assetState.collapsedGroups.has(id) ? assetState.collapsedGroups.delete(id) : assetState.collapsedGroups.add(id);
      renderAssetLibrary();
      return;
    }
    if(e.target.closest('[data-group-edit]')) return;
    const row=e.target.closest('.asset-group-row');
    if(!row) return;
    const id=row.dataset.id;
    assetState.currentGroup=id;
    assetState.selected.clear();
    await loadAssetAssets();
  });
  $('#assetGroupTree')?.addEventListener('dblclick',e=>{ const row=e.target.closest('.asset-group-row'); if(!row) return; e.preventDefault(); assetStartGroupRename(row.dataset.id); });
  $('#assetGroupTree')?.addEventListener('keydown',e=>{ const input=e.target.closest('[data-group-edit]'); if(!input) return; const row=input.closest('.asset-group-row'); if(e.key==='Enter'){ e.preventDefault(); assetSaveGroupName(row.dataset.id, input.value).catch(err=>toast(err.message||'重命名失败')); } if(e.key==='Escape'){ e.preventDefault(); assetState.editingGroupId=''; renderAssetLibrary(); } });
  $('#assetGroupTree')?.addEventListener('focusout',e=>{ const input=e.target.closest('[data-group-edit]'); if(!input) return; const row=input.closest('.asset-group-row'); setTimeout(()=>{ if(assetState.editingGroupId === row.dataset.id) assetSaveGroupName(row.dataset.id, input.value).catch(err=>toast(err.message||'重命名失败')); }, 0); });
  $('#assetGrid')?.addEventListener('click',async e=>{ const card=e.target.closest('.asset-card'); if(!card) return; if(e.target.closest('[data-asset-name],.asset-name-edit')) return; const id=card.dataset.id; const a=assetState.assets.find(x=>x.id===id); const act=e.target.closest('button[data-act]')?.dataset.act; if(act==='copy'){ await assetCopyAsset(a); return; } if(act==='download'){ window.open(withPublicAccess(a.download_url||a.url),'_blank'); return; } if(act==='delete'){ return assetDeleteIds([id]); } if(assetState.batch){ assetState.selected.has(id)?assetState.selected.delete(id):assetState.selected.add(id); renderAssetLibrary(); return; } if(a?.type==='image') showPreview(a.url,{model:'资产库',fullUrl:a.url,filename:a.name}); else if(a?.type==='video') showVideoPreview({url:a.url,stream_url:a.url,download_url:a.download_url,filename:a.name,model:'资产库视频'}); else window.open(withPublicAccess(a.download_url||a.url),'_blank'); });
  $('#assetGrid')?.addEventListener('contextmenu',e=>{ const card=e.target.closest('.asset-card'); if(!card) return; e.preventDefault(); e.stopPropagation(); showAssetContextMenu(e,card.dataset.id); });
  $('#assetGrid')?.addEventListener('dragstart',e=>{
    const card=e.target.closest('.asset-card[draggable="true"]');
    if(!card) return;
    const asset=assetState.assets.find(x=>x.id===card.dataset.id);
    if(!asset) return;
    const sourceUrl = withPublicAccess(asset.source_url || asset.url || asset.download_url || '');
    if(asset.type === 'image') setImageDragData(e,{fullUrl:sourceUrl, filename:asset.name || 'asset.png', skipNativeDrag:true});
    else {
      try{ e.dataTransfer.setData('text/uri-list', new URL(sourceUrl, location.href).href); }catch{}
      try{ e.dataTransfer.setData('text/plain', new URL(sourceUrl, location.href).href); }catch{}
      try{ e.dataTransfer.setData('DownloadURL', `${asset.mime_type || 'application/octet-stream'}:${asset.name || 'asset'}:${new URL(sourceUrl, location.href).href}`); }catch{}
    }
    if(assetCanEdit(asset)){
      const ids=assetState.selected.has(card.dataset.id)?assetSelectedIds():[card.dataset.id];
      e.dataTransfer.setData('application/x-laig-assets',JSON.stringify(ids));
      e.dataTransfer.effectAllowed='copyMove';
    }else e.dataTransfer.effectAllowed='copy';
    card.classList.add('dragging');
  });
  $('#assetGrid')?.addEventListener('dragend',e=>{ e.target.closest('.asset-card')?.classList.remove('dragging'); $$('.asset-group-row.asset-drop-target').forEach(x=>x.classList.remove('asset-drop-target')); });
  $('#assetGroupTree')?.addEventListener('dragover',e=>{ const row=e.target.closest('.asset-group-row'); if(!row || !e.dataTransfer.types.includes('application/x-laig-assets')) return; e.preventDefault(); e.dataTransfer.dropEffect='move'; $$('.asset-group-row.asset-drop-target').forEach(x=>x.classList.remove('asset-drop-target')); row.classList.add('asset-drop-target'); });
  $('#assetGroupTree')?.addEventListener('dragleave',e=>{ const row=e.target.closest('.asset-group-row'); if(row && !row.contains(e.relatedTarget)) row.classList.remove('asset-drop-target'); });
  $('#assetGroupTree')?.addEventListener('drop',e=>{ const row=e.target.closest('.asset-group-row'); if(!row) return; e.preventDefault(); row.classList.remove('asset-drop-target'); let ids=[]; try{ ids=JSON.parse(e.dataTransfer.getData('application/x-laig-assets')||'[]'); }catch{} assetMoveIds(ids,row.dataset.id).catch(err=>toast(err.message||'移动资产失败')); });
  $('#assetGrid')?.addEventListener('dblclick',e=>{ const card=e.target.closest('.asset-card'); if(!card || !e.target.closest('[data-asset-name]')) return; e.preventDefault(); e.stopPropagation(); assetBeginRename(card); });
  $('#assetSelectAllBtn')?.addEventListener('click',()=>{assetState.assets.forEach(a=>assetState.selected.add(a.id)); renderAssetLibrary();});
  $('#assetInvertBtn')?.addEventListener('click',()=>{assetState.assets.forEach(a=>assetState.selected.has(a.id)?assetState.selected.delete(a.id):assetState.selected.add(a.id)); renderAssetLibrary();});
  $('#assetClearSelectionBtn')?.addEventListener('click',()=>{assetState.selected.clear(); renderAssetLibrary();});
  $('#assetDeleteSelectedBtn')?.addEventListener('click',()=>assetDeleteIds(assetSelectedIds()));
  $('#assetDownloadSelectedBtn')?.addEventListener('click',()=>assetDownloadIds(assetSelectedIds()));
  $('#assetShareSelectedBtn')?.addEventListener('click',()=>assetShareIds(assetSelectedIds(),true));
  $('#assetDirDefaultBtn')?.addEventListener('click',()=>{$('#assetLibraryDir').value='';});
  $('#assetDirSaveBtn')?.addEventListener('click',()=>assetSaveDir(false).catch(e=>toast(e.message||'保存失败')));
  $('#assetDirMigrateBtn')?.addEventListener('click',()=>assetSaveDir(true).catch(e=>toast(e.message||'迁移失败')));
  makeFloatingBox('assetLibraryWindow','assetLibraryHead','assetLibraryResize');
  makeFloatingBox('assetLibraryOrb','assetLibraryOrb',null);
  $('#assetLibraryWindow')?.addEventListener('click',e=>{ if(!assetState.sidebarPinned && !e.target.closest('.asset-library-sidebar')) $('#assetLibraryWindow')?.classList.remove('asset-sidebar-peek'); }, true);
}

// V14.5.9: APIMart announcement center, source URL and custom announcement are configurable in settings.
const ANNOUNCEMENT_SEEN_KEY = 'local_api_image_generator_seen_announcement_v1498';
let announcementPollTimer = null;
function announcementKey(item){ return item ? String(item.id || `${item.date || ''}_${item.title || ''}`) : ''; }
function renderAnnouncements(data){
  const list = $('#announcementList');
  if(!list) return;
  const items = data && Array.isArray(data.items) ? data.items : [];
  if($('#announcementFetchTime')) $('#announcementFetchTime').textContent = data && data.fetched_at ? `实时获取：${data.fetched_at} · 来源：${data.source_url || '自定义公告'}` : '实时获取平台公告，不跳转外部网页。';
  if($('#announcementModalTitle')) $('#announcementModalTitle').textContent = (data && data.source_url && /apimart/i.test(data.source_url)) ? 'APIMart 平台公告' : '平台公告';
  if(!items.length){
    list.innerHTML = `<div class="announcement-empty">${escapeHtml(data?.error || '暂无公告，或当前网络无法获取公告。')}</div>`;
    return;
  }
  list.innerHTML = items.map(item => `
    <article class="announcement-card">
      <h3>${escapeHtml(item.title || '未命名公告')}${item.tag ? `<span class="announcement-tag">${escapeHtml(item.tag)}</span>` : ''}</h3>
      <div class="announcement-date">${escapeHtml(item.date || '')}</div>
      <div class="announcement-content">${escapeHtml(item.content || '')}</div>
      ${item.link ? `<a class="announcement-link" href="${escapeHtml(item.link)}" target="_blank">打开详情</a>` : ''}
    </article>
  `).join('');
}
let announcementCacheClient = null;
function showAnnouncementModal(){ $('#announcementModal')?.classList.add('show'); }
function hideAnnouncementModal(){ $('#announcementModal')?.classList.remove('show'); }
function renderAnnouncementLoading(){
  renderAnnouncements({ok:true, fetched_at:'', source_url:$('#announcementUrl')?.value || 'https://apimart.ai/zh/log-updates', items:[
    { id:'loading', title:'公告', tag:'加载中', content:'正在后台刷新公告内容。无需等待，也可以直接点击“打开链接”查看完整更新日志。', date:'' }
  ]});
}
async function loadAnnouncements(force=false, openAfter=false){
  if(openAfter){
    if(announcementCacheClient) renderAnnouncements(announcementCacheClient);
    else renderAnnouncementLoading();
    showAnnouncementModal();
  }
  try{
    const data = await api('/api/announcements' + (force ? '?force=1' : ''));
    announcementCacheClient = data;
    renderAnnouncements(data);
    const latest = announcementKey(data.latest);
    const seen = localStorage.getItem(ANNOUNCEMENT_SEEN_KEY) || '';
    const badge = $('#announcementBadge');
    if(badge){
      if(latest && latest !== seen){ badge.textContent = '新'; badge.classList.remove('zero'); }
      else { badge.textContent = ''; badge.classList.add('zero'); }
    }
    if(latest && seen && latest !== seen && !openAfter){
      toast('发现新的平台公告');
    }
    if(openAfter){
      if(latest) localStorage.setItem(ANNOUNCEMENT_SEEN_KEY, latest);
      if(badge){ badge.textContent=''; badge.classList.add('zero'); }
    } else if(latest && !seen){
      localStorage.setItem(ANNOUNCEMENT_SEEN_KEY, latest);
    }
    return data;
  }catch(e){
    if(openAfter && !announcementCacheClient){
      renderAnnouncements({ok:false, error:e.message || String(e), items:[
        { id:'fallback', title:'公告读取较慢', tag:'链接', content:'已优化为先打开弹窗，再后台刷新。点击“打开链接”查看完整公告页面。', date:'' }
      ]});
    }
    return announcementCacheClient;
  }
}
function setupAnnouncements(){
  $('#announcementBtn')?.addEventListener('click', ()=>loadAnnouncements(false, true));
  $('#refreshAnnouncementsBtn')?.addEventListener('click', ()=>loadAnnouncements(true, true));
  $('#openAnnouncementSourceBtn')?.addEventListener('click', ()=>{ const url = announcementCacheClient?.source_url || $('#announcementUrl')?.value || 'https://apimart.ai/zh/log-updates'; if(url) window.open(url, '_blank'); });
  $('#closeAnnouncementModal')?.addEventListener('click', hideAnnouncementModal);
  $('#announcementModal')?.addEventListener('click', e=>{ if(e.target.id === 'announcementModal') hideAnnouncementModal(); });
  setTimeout(()=>loadAnnouncements(false, false), 800);
  if(announcementPollTimer) clearInterval(announcementPollTimer);
  announcementPollTimer = setInterval(()=>loadAnnouncements(false, false), 10 * 60 * 1000);
}



// V8.8: mobile bottom navigation repair - only keep 首页/历史/图片/任务/AI and keep it full-width.
function repairMobileBottomNav(){
  const isMobile = document.body.classList.contains('mobile-ui');
  const allowed = new Set(['home','history','images','video','api','chat']);
  const labels = {home:'首页', history:'历史', images:'图片', video:'视频', api:'任务', chat:'AI'};
  $$('.sidebar .nav[data-page]').forEach(btn=>{
    const page = btn.dataset.page;
    if(isMobile){
      btn.style.display = allowed.has(page) ? 'flex' : 'none';
      const label = btn.querySelector('.nav-label');
      if(label && labels[page]) label.textContent = labels[page];
    }else{
      btn.style.display = '';
      const label = btn.querySelector('.nav-label');
      if(label && page === 'api') label.textContent = 'API监控';
      if(label && page === 'home') label.textContent = '首页生成';
      if(label && page === 'history') label.textContent = '历史记录';
      if(label && page === 'images') label.textContent = '图片管理';
      if(label && page === 'chat') label.textContent = 'AI聊天';
      if(label && page === 'video') label.textContent = '视频编辑';
    }
  });
}

// V8.6: automatic PC / tablet / mobile UI allocation only. No manual desktop/mobile switch.
function detectPreferredDeviceUI(){
  const isTouch = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer:coarse)').matches;
  const ua = navigator.userAgent || '';
  const isMobileUA = /Android|iPhone|iPod|Mobile|Windows Phone/i.test(ua);
  const width = window.innerWidth || document.documentElement.clientWidth || 1440;
  let mode = 'desktop';
  if(width < 768 || (isTouch && width < 900) || isMobileUA) mode = 'mobile';
  else if(width < 1024 && isTouch) mode = 'mobile';
  document.body.classList.toggle('mobile-ui', mode === 'mobile');
  document.body.classList.toggle('desktop-ui', mode !== 'mobile');
  document.body.classList.toggle('tablet-ui', mode === 'mobile' && width >= 768);
  const apiNavLabel = document.querySelector('.nav[data-page="api"] .nav-label');
  if(apiNavLabel) apiNavLabel.textContent = mode === 'mobile' ? '任务' : 'API监控';
  repairMobileBottomNav();
  applyPermissionUI();
  return mode;
}
function setupDeviceUI(){
  detectPreferredDeviceUI();
  let t=null;
  window.addEventListener('resize', ()=>{ clearTimeout(t); t=setTimeout(detectPreferredDeviceUI,120); });
  window.addEventListener('orientationchange', ()=>setTimeout(detectPreferredDeviceUI,250));
}
setupDeviceUI();



// V12.2: 提示词库最小化“提”字图标可拖动
function setupPromptTemplateOrbDrag(){
  const orb = document.getElementById('promptTemplateOrb');
  if(!orb || orb.dataset.dragReady) return;
  orb.dataset.dragReady = '1';
  let dragging=false, moved=false, sx=0, sy=0, ox=0, oy=0;
  function getPos(){
    const r=orb.getBoundingClientRect();
    return {left:r.left, top:r.top};
  }
  function down(e){
    const p=e.touches?e.touches[0]:e;
    dragging=true; moved=false; sx=p.clientX; sy=p.clientY;
    const pos=getPos(); ox=pos.left; oy=pos.top;
    orb.style.left=ox+'px'; orb.style.top=oy+'px'; orb.style.right='auto'; orb.style.bottom='auto';
    e.preventDefault?.();
  }
  function move(e){
    if(!dragging) return;
    const p=e.touches?e.touches[0]:e;
    const dx=p.clientX-sx, dy=p.clientY-sy;
    if(Math.abs(dx)+Math.abs(dy)>4) moved=true;
    const left=Math.max(8, Math.min(window.innerWidth-orb.offsetWidth-8, ox+dx));
    const top=Math.max(8, Math.min(window.innerHeight-orb.offsetHeight-8, oy+dy));
    orb.style.left=left+'px'; orb.style.top=top+'px';
    try{ localStorage.setItem('prompt_template_orb_pos', JSON.stringify({left,top})); }catch{}
    e.preventDefault?.();
  }
  function up(){ dragging=false; setTimeout(()=>{moved=false;},0); }
  try{
    const saved=JSON.parse(localStorage.getItem('prompt_template_orb_pos')||'null');
    if(saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)){
      orb.style.left=Math.max(8, Math.min(window.innerWidth-orb.offsetWidth-8, saved.left))+'px';
      orb.style.top=Math.max(8, Math.min(window.innerHeight-orb.offsetHeight-8, saved.top))+'px';
      orb.style.right='auto'; orb.style.bottom='auto';
    }
  }catch{}
  orb.addEventListener('mousedown', down);
  orb.addEventListener('touchstart', down, {passive:false});
  window.addEventListener('mousemove', move, {passive:false});
  window.addEventListener('touchmove', move, {passive:false});
  window.addEventListener('mouseup', up);
  window.addEventListener('touchend', up);
  orb.addEventListener('click', e=>{ if(moved){ e.preventDefault(); e.stopPropagation(); } }, true);
}


const MJ_TABS = [
  { key:'imagine', label:'文生图', endpoint:'POST /v1/midjourney/generations' },
  { key:'blend', label:'多图融合', endpoint:'POST /v1/midjourney/generations/blend' },
  { key:'describe', label:'图生文', endpoint:'POST /v1/midjourney/generations/describe' },
  { key:'edits', label:'图片编辑', endpoint:'POST /v1/midjourney/generations/edits' },
  { key:'upscale', label:'放大', endpoint:'POST /v1/midjourney/generations/upscale' },
  { key:'variation', label:'变体', endpoint:'POST /v1/midjourney/generations/variation' },
  { key:'high_variation', label:'强变体', endpoint:'POST /v1/midjourney/generations/high-variation' },
  { key:'low_variation', label:'弱变体', endpoint:'POST /v1/midjourney/generations/low-variation' },
  { key:'reroll', label:'重新生成', endpoint:'POST /v1/midjourney/generations/reroll' },
  { key:'inpaint', label:'局部重绘', endpoint:'POST /v1/midjourney/generations/inpaint / modal' },
  { key:'zoom', label:'缩放', endpoint:'POST /v1/midjourney/generations/zoom' },
  { key:'pan', label:'平移', endpoint:'POST /v1/midjourney/generations/pan' },
  { key:'remix', label:'重塑', endpoint:'POST /v1/midjourney/generations/remix-strong|subtle' }
];
const mjState = { init:false, tab:'imagine', lastTaskId:'', lastLocalTaskId:'', lastBatchId:'', pollingTimer:null, lastJson:null };
function mjOptionHtml(options=[], selected='', fieldName=''){
  const mapLabel = (val)=>{
    const v=String(val||'');
    if(v==='relax') return 'Relax（慢速）';
    if(v==='fast') return 'Fast（快速）';
    if(v==='turbo') return 'Turbo（极速）';
    if(['index','image_no','image_index'].includes(fieldName)){
      if(v==='1') return '1（左上）';
      if(v==='2') return '2（右上）';
      if(v==='3') return '3（左下）';
      if(v==='4') return '4（右下）';
    }
    if(v==='custom') return '自定义';
    return v;
  };
  return options.map(opt=>{
    if(typeof opt === 'string') return `<option value="${opt}" ${String(selected)===String(opt)?'selected':''}>${mapLabel(opt)}</option>`;
    return `<option value="${opt.value}" ${String(selected)===String(opt.value)?'selected':''}>${opt.label || mapLabel(opt.value)}</option>`;
  }).join('');
}
function mjFieldLabel(field){
  const tip = field.tip || field.help || '';
  return `<label class="mj-field-label">${field.label || ''}${tip ? `<span class="mj-info-tip" title="${String(tip).replace(/"/g,'&quot;')}">!</span>` : ''}</label>`;
}
function mjReqAttr(field){
  return field.requires ? ` data-mj-requires="${field.requires}"` : '';
}
function mjRenderField(field){
  if(!field) return '';
  if(field.type === 'row') return `<div class="mj-row ${field.columns===3?'mj-row-3':''}">${(field.fields||[]).map(mjRenderField).join('')}</div>`;
  if(field.type === 'note') return `<div class="mj-inline-note">${field.text||''}</div>`;
  if(field.type === 'textarea') return `<div class="mj-field-group"${mjReqAttr(field)}>${mjFieldLabel(field)}<textarea data-mj-field="${field.name}" placeholder="${field.placeholder||''}">${field.value||''}</textarea>${field.help?`<div class="mj-field-help">${field.help}</div>`:''}</div>`;
  if(field.type === 'text' || field.type === 'number') return `<div class="mj-field-group ${field.customAspect?'mj-custom-aspect hidden':''}"${mjReqAttr(field)}>${mjFieldLabel(field)}<input data-mj-field="${field.name}" type="${field.type}" value="${field.value ?? ''}" placeholder="${field.placeholder||''}" ${field.min!==undefined?`min="${field.min}"`:''} ${field.max!==undefined?`max="${field.max}"`:''} ${field.step!==undefined?`step="${field.step}"`:''} />${field.help?`<div class="mj-field-help">${field.help}</div>`:''}</div>`;
  if(field.type === 'select') return `<div class="mj-field-group"${mjReqAttr(field)}>${mjFieldLabel(field)}<select data-mj-field="${field.name}">${mjOptionHtml(field.options||[], field.value, field.name)}</select>${field.help?`<div class="mj-field-help">${field.help}</div>`:''}</div>`;
  if(field.type === 'checkbox') return `<label class="mj-check-item"${mjReqAttr(field)}><input data-mj-field="${field.name}" type="checkbox" ${field.checked?'checked':''} ${field.requires?`data-mj-requires="${field.requires}"`:''} /> <span>${field.label}</span>${(field.tip||field.help)?`<i class="mj-info-tip" title="${String(field.tip||field.help).replace(/"/g,'&quot;')}">!</i>`:''}</label>`;
  if(field.type === 'checkgrid') return `<div class="mj-field-group">${mjFieldLabel(field)}<div class="mj-check-grid">${(field.items||[]).map(item=>mjRenderField({type:'checkbox', ...(item||{})})).join('')}</div>${field.help?`<div class="mj-field-help">${field.help}</div>`:''}</div>`;
  if(field.type === 'file') return `<div class="mj-field-group"${mjReqAttr(field)}>${mjFieldLabel(field)}<div class="mj-drop"><strong>${field.dropLabel||'点击或拖拽上传文件'}</strong><span>${field.help || '支持多文件上传；文件会自动上传到 APIMart 图床后再提交。'}</span><input data-mj-field="${field.name}" type="file" ${field.multiple===false?'':'multiple'} ${field.accept?`accept="${field.accept}"`:''} /></div><div class="mj-file-list" data-mj-file-list="${field.name}"><span class="mj-inline-note">未选择文件</span></div></div>`;
  if(field.type === 'hybrid_image'){
    const mode = field.defaultMode || 'upload';
    const urlField = field.urlName || `${field.name}_url`;
    const uploadField = field.uploadName || field.name;
    const urlInput = field.urlMultiline ? `<textarea data-mj-field="${urlField}" placeholder="${field.placeholder || '一行一个图片 URL'}">${field.value || ''}</textarea>` : `<input data-mj-field="${urlField}" type="text" value="${field.value || ''}" placeholder="${field.placeholder || 'https://example.com/image.png'}" />`;
    return `<div class="mj-field-group"${mjReqAttr(field)}>${mjFieldLabel(field)}<div class="mj-field-hybrid" data-mj-hybrid="${uploadField}" data-url-field="${urlField}" data-default-mode="${mode}"><div class="mj-input-switch"><button type="button" class="${mode==='upload'?'active':''}" data-mj-hybrid-mode="upload">上传图片</button><button type="button" class="${mode==='url'?'active':''}" data-mj-hybrid-mode="url">图片 URL</button></div><div class="mj-upload-area ${mode==='url'?'hidden':''}" data-mj-hybrid-upload><div class="mj-drop"><strong>${field.dropLabel||'点击或拖拽上传图片'}</strong><span>${field.uploadHelp || '上传后程序会自动转成可提交的图片地址。'}</span><input data-mj-field="${uploadField}" type="file" ${field.multiple===false?'':'multiple'} ${field.accept?`accept="${field.accept}"`:''} /></div><div class="mj-file-list" data-mj-file-list="${uploadField}"><span class="mj-inline-note">未选择文件</span></div></div><div class="mj-url-area ${mode==='upload'?'hidden':''}" data-mj-hybrid-url>${urlInput}<div class="mj-field-help">${field.urlHelp || '如已填写 URL，会自动隐藏上传框；上传后也会自动隐藏 URL 输入框。'}</div></div></div>${field.help?`<div class="mj-field-help">${field.help}</div>`:''}</div>`;
  }
  return '';
}
const MJ_STANDARD_VERSION_OPTIONS = ['8.1','7','6.1','5.2','5.1'];
const MJ_NIJI_VERSION_OPTIONS = [
  { value:'niji7', label:'niji 7' },
  { value:'niji6', label:'niji 6' }
];

function mjPromptCommonFields(){
  return [
    { type:'textarea', name:'prompt', label:'提示词', placeholder:'A futuristic cyberpunk city at night, neon lights, rain reflections...' },
    { type:'textarea', name:'negative_prompt', label:'负向提示词', placeholder:'模糊，低质量，水印', help:'会自动拼接为 --no ... 形式。' },
    { type:'checkgrid', label:'快捷参数', items:[
      { name:'niji', label:'Niji（动漫）', tip:'开启后从版本选择 Niji 风格，并提交为 prompt 参数 --niji。' },
      { name:'tile', label:'平铺 Tile', tip:'生成无缝平铺图案。' },
      { name:'raw', label:'Raw 原始', tip:'Raw 风格参数，减少 MJ 后期加工；注意：与 style-raw 不是同一个 flag。' },
      { name:'draft', label:'Draft 草图', requires:'v7plus', tip:'草图模式 --draft，V7+ 可用；快速低消耗预览，后续可继续操作。' },
      { name:'hd', label:'HD 高清', requires:'v8', tip:'HD 高清 --hd，仅 V8 / V8.1 可用，生成时间更长。' }
    ] },
    { type:'row', fields:[
      { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}], tip:'Relax 慢速；Fast 快速；Turbo 极速。' },
      { type:'select', name:'version', label:'版本', value:'8.1', options:MJ_STANDARD_VERSION_OPTIONS, tip:'勾选 Niji（动漫）后，版本只显示 niji 7 / niji 6。' }
    ]},
    { type:'row', fields:[
      { type:'select', name:'aspect_ratio', label:'宽高比', value:'1:1', options:[
        {value:'1:1',label:'1:1'},
        {value:'16:9',label:'16:9'},
        {value:'9:16',label:'9:16'},
        {value:'4:3',label:'4:3'},
        {value:'3:2',label:'3:2'},
        {value:'2:3',label:'2:3'},
        {value:'custom',label:'自定义'}
      ], tip:'默认使用固定比例；选择“自定义”后会显示自定义宽高比输入框。' },
      { type:'text', name:'custom_aspect_ratio', label:'自定义宽高比', placeholder:'例如 4:5 / 21:9 / 3:4', customAspect:true, tip:'仅选择“自定义”时可用。' },
      { type:'select', name:'image_quality', label:'画质', value:'1', options:['0.25','0.5','1','2'], tip:'画质参数 --q，数值越高消耗越高。' }
    ]},
    { type:'row', columns:3, fields:[
      { type:'number', name:'stylize', label:'风格化强度', value:100, min:0, max:1000, tip:'--s，控制 MJ 风格化强度。' },
      { type:'number', name:'chaos', label:'混乱度', value:0, min:0, max:100, tip:'--chaos，值越高变化越大。' },
      { type:'number', name:'weirdness', label:'怪异度', value:0, min:0, max:3000, tip:'--weird，增加怪异和实验效果。' }
    ]},
    { type:'row', fields:[
      { type:'text', name:'seed', label:'随机种子（可选）', placeholder:'例如 123456', tip:'--seed，用于复现相似结果。' },
      { type:'number', name:'stop', label:'Stop (10-100)', placeholder:'例如 60', min:10, max:100, requires:'stop_v5_6', tip:'在百分比进度前停止 --stop，仅 v5-6.1 / niji5-6 可用。' }
    ]},
    { type:'hybrid_image', name:'cref_images', uploadName:'cref_images', urlName:'cref', label:'角色参考（--cref）', accept:'image/*', multiple:false, defaultMode:'url', placeholder:'https://...', dropLabel:'上传角色参考图', tip:'角色参考图，用于保持人物/角色一致。上传或 URL 二选一。' },
    { type:'hybrid_image', name:'sref_images', uploadName:'sref_images', urlName:'sref', label:'风格参考（--sref）', accept:'image/*', multiple:false, defaultMode:'url', placeholder:'https://...', dropLabel:'上传风格参考图', tip:'风格参考图，用于保持整体画风。上传或 URL 二选一。' },
    { type:'hybrid_image', name:'dref_images', uploadName:'dref_images', urlName:'dref', label:'深度参考（--dref）', accept:'image/*', multiple:false, defaultMode:'url', placeholder:'https://...', dropLabel:'上传深度参考图', tip:'深度参考图，用于保持构图/空间深度。上传或 URL 二选一。' },
    { type:'row', fields:[
      { type:'number', name:'repeat', label:'重复生成 (2-40)', placeholder:'可选', min:2, max:40, tip:'--repeat，重复生成次数。' },
      { type:'text', name:'extra_flag', label:'额外 flag', placeholder:'--my-flag value', tip:'手动补充其它 MJ 参数。' }
    ]}
  ];
}

const MJ_FORM_CONFIG = {
  imagine: {
    title:'Midjourney 文生图',
    endpoint:'POST /v1/midjourney/generations',
    fields:[{ type:'hybrid_image', name:'imagine_images', uploadName:'imagine_images', urlName:'image_urls_text', label:'参考图（可选）', accept:'image/*', multiple:true, defaultMode:'upload', dropLabel:'Click to upload images', uploadHelp:'JPEG / PNG / WebP / GIF（max 12MB each, up to 4 images）', placeholder:'可填写 1 个或多个图片 URL，换行分隔', urlHelp:'可直接填写参考图 URL；填写后自动隐藏上传框。', tip:'图像：最多 4 张参考图。MJ 控制参考图对结果的影响强度。' }, ...mjPromptCommonFields()],
    actions:[{label:'run ✈ 提交任务', action:'imagine', style:'primary'}]
  },
  blend: {
    title:'Midjourney 多图融合',
    endpoint:'POST /v1/midjourney/generations/blend',
    fields:[
      { type:'file', name:'blend_images', label:'图片（2-4 张）', accept:'image/*', multiple:true, help:'上传 2 到 4 张图片进行 Midjourney 融合。' },
      { type:'row', fields:[
        { type:'select', name:'dimensions', label:'比例', value:'SQUARE', options:['SQUARE','PORTRAIT','LANDSCAPE'] },
        { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}] }
      ]}
    ],
    actions:[{label:'run ✈ 提交融合', action:'blend', style:'primary'}]
  },
  describe: {
    title:'Midjourney 图生文',
    endpoint:'POST /v1/midjourney/generations/describe',
    fields:[
      { type:'note', text:'<div class="mj-describe-mode"><button type="button" class="active" data-mj-describe-mode="single">单图生成</button><button type="button" data-mj-describe-mode="multi">多图生成</button><input type="hidden" data-mj-field="describe_mode" value="single" /></div>' },
      { type:'hybrid_image', name:'describe_images', uploadName:'describe_images', urlName:'image_urls_text', label:'图片', accept:'image/*', multiple:true, defaultMode:'upload', dropLabel:'上传图片', urlMultiline:true, placeholder:'一行一个图片 URL，可填写多个', urlHelp:'多图生成模式下支持多行 URL；上传图片和 URL 可以混合提交。', help:'单图生成默认使用第一张图片；切换多图生成后，每张图会作为同一批次下的独立 Describe 子任务。' },
      { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}] }
    ],
    actions:[{label:'run ✈ 提交识图', action:'describe', style:'primary'}]
  },
  edits: {
    title:'Midjourney 图片编辑',
    endpoint:'POST /v1/midjourney/generations/edits',
    fields:[
      { type:'hybrid_image', name:'edit_images', uploadName:'edit_images', urlName:'image_urls_text', label:'源图片', accept:'image/*', multiple:true, defaultMode:'upload', dropLabel:'上传源图片', placeholder:'可填写 1 个或多个图片 URL，换行分隔', urlHelp:'如果填写了图片 URL，就只用 URL 提交；上传图片后会自动隐藏 URL 输入框。', help:'上传或填写可编辑的源图片，产品替换/背景替换等。' },
      ...mjPromptCommonFields()
    ],
    actions:[{label:'run ✈ 提交编辑', action:'edits', style:'primary'}]
  },
  upscale: {
    title:'Midjourney 放大',
    endpoint:'POST /v1/midjourney/generations/upscale',
    fields:[
      { type:'text', name:'task_id', label:'任务 ID', placeholder:'task_01JWXXXXXXXXXXXX' },
      { type:'row', fields:[
        { type:'select', name:'index', label:'图片序号', value:'1', options:['1','2','3','4'] },
        { type:'text', name:'custom_id', label:'Custom ID（高级）', placeholder:'MJ::JOB::upscale::1::abc...' }
      ]},
      { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}] }
    ],
    actions:[{label:'run ✈ 提交放大', action:'upscale', style:'primary'}]
  },
  variation: {
    title:'Midjourney 变体',
    endpoint:'POST /v1/midjourney/generations/variation',
    fields:[
      { type:'text', name:'task_id', label:'任务 ID', placeholder:'task_01JWXXXXXXXXXXXX' },
      { type:'row', fields:[
        { type:'select', name:'index', label:'图片序号', value:'1', options:['1','2','3','4'] },
        { type:'text', name:'custom_id', label:'Custom ID（高级）', placeholder:'MJ::JOB::variation::1::abc...' }
      ]},
      { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}] }
    ],
    actions:[{label:'run ✈ 提交变体', action:'variation', style:'primary'}]
  },
  high_variation: {
    title:'Midjourney 强变体',
    endpoint:'POST /v1/midjourney/generations/high-variation',
    fields:[
      { type:'text', name:'task_id', label:'任务 ID', placeholder:'task_01JWXXXXXXXXXXXX' },
      { type:'row', fields:[
        { type:'select', name:'index', label:'图片序号', value:'1', options:['1','2','3','4'] },
        { type:'text', name:'custom_id', label:'Custom ID（高级）', placeholder:'MJ::JOB::high-variation::1::abc...' }
      ]},
      { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}] }
    ],
    actions:[{label:'run ✈ 提交强变体', action:'high_variation', style:'primary'}]
  },
  low_variation: {
    title:'Midjourney 弱变体',
    endpoint:'POST /v1/midjourney/generations/low-variation',
    fields:[
      { type:'text', name:'task_id', label:'任务 ID', placeholder:'task_01JWXXXXXXXXXXXX' },
      { type:'row', fields:[
        { type:'select', name:'index', label:'图片序号', value:'1', options:['1','2','3','4'] },
        { type:'text', name:'custom_id', label:'Custom ID（高级）', placeholder:'MJ::JOB::low-variation::1::abc...' }
      ]},
      { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}] }
    ],
    actions:[{label:'run ✈ 提交弱变体', action:'low_variation', style:'primary'}]
  },
  reroll: {
    title:'Midjourney 重新生成',
    endpoint:'POST /v1/midjourney/generations/reroll',
    fields:[
      { type:'text', name:'task_id', label:'任务 ID', placeholder:'task_01JWXXXXXXXXXXXX' },
      { type:'textarea', name:'prompt', label:'提示词（可选）', placeholder:'例如：改成水彩风格' },
      { type:'row', fields:[
        { type:'text', name:'custom_id', label:'Custom ID（高级）', placeholder:'MJ::JOB::reroll::0::abc...' },
        { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}] }
      ]}
    ],
    actions:[{label:'run ✈ 重新生成', action:'reroll', style:'primary'}]
  },
  zoom: {
    title:'Midjourney 缩放扩展',
    endpoint:'POST /v1/midjourney/generations/zoom',
    fields:[
      { type:'text', name:'task_id', label:'任务 ID', placeholder:'task_01JWXXXXXXXXXXXX' },
      { type:'row', fields:[
        { type:'select', name:'zoom_ratio', label:'缩放倍数', value:'2', options:['1.5','2'] },
        { type:'select', name:'index', label:'图片序号', value:'1', options:['1','2','3','4'] }
      ]},
      { type:'row', fields:[
        { type:'text', name:'custom_id', label:'Custom ID（高级）', placeholder:'MJ::JOB::CustomZoom::...' },
        { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}] }
      ]}
    ],
    actions:[{label:'run ✈ 提交缩放', action:'zoom', style:'primary'}]
  },
  pan: {
    title:'Midjourney 平移扩展',
    endpoint:'POST /v1/midjourney/generations/pan',
    fields:[
      { type:'text', name:'task_id', label:'任务 ID', placeholder:'task_01JWXXXXXXXXXXXX' },
      { type:'row', fields:[
        { type:'select', name:'direction', label:'方向', value:'left', options:[{value:'left',label:'left'},{value:'right',label:'right'},{value:'up',label:'up'},{value:'down',label:'down'}] },
        { type:'select', name:'index', label:'图片序号', value:'1', options:['1','2','3','4','auto'] }
      ]},
      { type:'row', fields:[
        { type:'text', name:'custom_id', label:'Custom ID（高级）', placeholder:'MJ::JOB::pan_left::1::abc...' },
        { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}] }
      ]}
    ],
    actions:[{label:'run ✈ 提交平移', action:'pan', style:'primary'}]
  },
  remix: {
    title:'Midjourney 重塑',
    endpoint:'POST /v1/midjourney/generations/remix-strong | remix-subtle',
    fields:[
      { type:'select', name:'remix_strength', label:'重塑力度', value:'strong', options:[{value:'strong',label:'strong'},{value:'subtle',label:'subtle'}] },
      { type:'text', name:'task_id', label:'任务 ID', placeholder:'task_01JWXXXXXXXXXXXX' },
      { type:'select', name:'index', label:'图片序号', value:'1', options:['1','2','3','4'] },
      { type:'textarea', name:'prompt', label:'提示词（可选）', placeholder:'例如：改成水彩风格' },
      { type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}] }
    ],
    actions:[{label:'run ✈ 提交重塑', action:'remix', style:'primary'}]
  }
};
const MJ_SUBMIT_LABELS = {
  imagine:'提交生成',
  blend:'提交融合',
  describe:'提交识图',
  edits:'提交编辑',
  upscale:'提交放大',
  variation:'提交变体',
  high_variation:'提交强变体',
  low_variation:'提交弱变体',
  reroll:'提交重绘',
  inpaint:'提交局部重绘',
  zoom:'提交缩放',
  pan:'提交平移',
  remix:'提交重塑',
  modal:'提交 Modal'
};
function getMjFloatingAction(){
  if(mjState.tab === 'inpaint') return 'inpaint';
  return (MJ_FORM_CONFIG[mjState.tab]?.actions || [])[0]?.action || mjState.tab || 'imagine';
}
function updateMjFloatingSubmit(){
  const btn = $('#mjFloatingSubmitBtn');
  if(!btn) return;
  const action = getMjFloatingAction();
  btn.dataset.mjSubmitAction = action;
  btn.textContent = MJ_SUBMIT_LABELS[mjState.tab] || MJ_SUBMIT_LABELS[action] || '提交任务';
}
function applyMjSavedFormSettings(){
  const saved = readClientSettings().mj_settings || {};
  const fields = (saved.by_tab || {})[mjState.tab] || {};
  Object.entries(fields).forEach(([name, value])=>{
    const el = document.querySelector(`#mjFormContainer [data-mj-field="${CSS.escape(name)}"]`);
    if(!el || el.type === 'file') return;
    if(el.type === 'checkbox') el.checked = !!value;
    else el.value = value;
    syncMjHybridByValue(el);
  });
}
function renderMjInpaintForm(){
  return `
    <div class="mj-fields">
      <div class="mj-subsection" style="margin-top:0;padding-top:0;border-top:none">
        <div class="mj-card-head"><h3>第一步：进入局部重绘（Vary Region）</h3></div>
        ${mjRenderField({type:'text', name:'task_id', label:'任务 ID', placeholder:'task_01JWXXXXXXXXXXXX'})}
        <div class="mj-row">
          ${mjRenderField({type:'select', name:'index', label:'图片序号', value:'1', options:['1','2','3','4']})}
          ${mjRenderField({type:'select', name:'speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}]})}
        </div>
        ${mjRenderField({type:'text', name:'custom_id', label:'Custom ID（高级）', placeholder:'MJ::Inpaint::1::abc...'})}
        <div class="mj-inline-note">两步流程：1）先提交局部重绘入口进入 MODAL 状态；2）再为该任务上传遮罩图 + prompt 完成重绘。</div>
      </div>
      <div class="mj-subsection">
        <div class="mj-card-head"><h3>第二步：提交 Modal 补充参数</h3></div>
        ${mjRenderField({type:'text', name:'modal_task_id', label:'Modal 任务 ID', placeholder:'task_MODAL_TASK_ID'})}
        ${mjRenderField({type:'textarea', name:'modal_prompt', label:'提示词（可选）', placeholder:'在此处放一只金毛犬'})}
        ${mjRenderField({type:'hybrid_image', name:'modal_mask', uploadName:'modal_mask', urlName:'modal_mask_url', label:'遮罩图（可选）', accept:'image/png', multiple:false, defaultMode:'upload', dropLabel:'点击或拖拽上传 PNG 遮罩图', urlHelp:'如填写遮罩图 URL，则上传框自动隐藏。'})}
        ${mjRenderField({type:'select', name:'modal_speed', label:'速度模式', value:'relax', options:[{value:'relax',label:'Relax（慢速）'},{value:'fast',label:'Fast（快速）'},{value:'turbo',label:'Turbo（极速）'}]})}
      </div>
    </div>`;
}
function renderMjFormByTab(tab){
  const conf = MJ_FORM_CONFIG[tab];
  if(tab === 'inpaint') return renderMjInpaintForm();
  if(!conf) return '<div class="mj-api-note">未找到表单配置。</div>';
  const fieldsHtml = (conf.fields||[]).map(mjRenderField).join('');
  return `<div class="mj-fields">${fieldsHtml}</div>`;
}
function updateMjFileList(input){
  const name = input?.dataset?.mjField;
  const box = document.querySelector(`[data-mj-file-list="${name}"]`);
  const files = getMjInputFiles(input);
  if(box){
    box.innerHTML = '';
    if(!files.length) box.innerHTML = '<span class="mj-inline-note">未选择文件</span>';
    else files.forEach((file, idx)=>{
      const chip = document.createElement('span');
      chip.className = 'mj-file-chip';
      chip.innerHTML = `<span>${escapeHtml(file.name)} · ${escapeHtml(prettyBytes(file.size||0))}</span><button type="button" title="删除此图" data-mj-remove-file="${idx}" data-mj-remove-field="${escapeHtml(name || '')}">×</button>`;
      box.appendChild(chip);
    });
  }
  const hybrid = input?.closest('[data-mj-hybrid]');
  if(hybrid && files.length) setMjHybridMode(hybrid, 'upload');
}
function setMjHybridMode(root, mode='upload'){
  if(!root) return;
  root.dataset.mode = mode;
  root.querySelectorAll('[data-mj-hybrid-mode]').forEach(btn=>btn.classList.toggle('active', btn.dataset.mjHybridMode === mode));
  root.querySelector('[data-mj-hybrid-upload]')?.classList.toggle('hidden', mode !== 'upload');
  root.querySelector('[data-mj-hybrid-url]')?.classList.toggle('hidden', mode !== 'url');
}
function syncMjHybridByValue(el){
  const hybrid = el?.closest('[data-mj-hybrid]');
  if(!hybrid) return;
  const urlField = hybrid.dataset.urlField || '';
  const uploadField = hybrid.dataset.mjHybrid || '';
  if(el.dataset.mjField === urlField && String(el.value || '').trim()) setMjHybridMode(hybrid, 'url');
  const fileInput = hybrid.querySelector(`[data-mj-field="${uploadField}"]`);
  if(el.dataset.mjField === uploadField && fileInput && Array.from(fileInput.files || []).length) setMjHybridMode(hybrid, 'upload');
}
function syncMjVersionOptions(){
  const versionEl = $('#mjFormContainer [data-mj-field="version"]');
  const nijiEl = $('#mjFormContainer [data-mj-field="niji"]');
  if(!versionEl) return;
  const isNiji = !!(nijiEl && nijiEl.checked);
  const options = isNiji ? MJ_NIJI_VERSION_OPTIONS : MJ_STANDARD_VERSION_OPTIONS;
  const current = String(versionEl.value || '').trim();
  versionEl.innerHTML = mjOptionHtml(options, current, 'version');
  const validValues = options.map(opt => typeof opt === 'string' ? opt : String(opt.value || ''));
  if(!validValues.includes(current)) versionEl.value = isNiji ? 'niji7' : '8.1';
}
function mjVersionOK(req, version){
  const v = String(version || '').toLowerCase();
  if(!req) return true;
  if(req === 'v8') return v === '8.1';
  if(req === 'v7plus') return v === '8.1' || v === '7' || v === 'niji7';
  if(req === 'stop_v5_6') return v === '6.1' || v === '5.2' || v === '5.1' || v === 'niji6';
  return true;
}
function applyMjVersionRules(){
  syncMjVersionOptions();
  const version = $('#mjFormContainer [data-mj-field="version"]')?.value || '';
  document.querySelectorAll('#mjFormContainer [data-mj-requires]').forEach(el=>{
    const req = el.dataset.mjRequires || '';
    const ok = mjVersionOK(req, version);
    el.classList.toggle('mj-disabled-by-version', !ok);
    el.querySelectorAll('input,select,textarea,button').forEach(ctrl=>{
      if(ctrl.dataset.mjField === 'version') return;
      ctrl.disabled = !ok;
      if(!ok && ctrl.type === 'checkbox') ctrl.checked = false;
    });
    if(el.matches('input,select,textarea,button')){
      el.disabled = !ok;
      if(!ok && el.type === 'checkbox') el.checked = false;
    }
  });
}
function updateMjCustomAspect(){
  const v = $('#mjFormContainer [data-mj-field="aspect_ratio"]')?.value || '';
  const wrap = $('#mjFormContainer .mj-custom-aspect');
  const input = $('#mjFormContainer [data-mj-field="custom_aspect_ratio"]');
  const show = v === 'custom';
  if(wrap) wrap.classList.toggle('hidden', !show);
  if(input) input.disabled = !show;
}

function initMidjourneyPage(){
  const page = $('#page-midjourney');
  if(!page) return;
  if(!page.dataset.mjReady){
    page.dataset.mjReady = '1';
    const tabs = $('#mjTabs');
    tabs.innerHTML = MJ_TABS.map(tab=>`<button type="button" class="mj-tab ${tab.key===mjState.tab?'active':''}" data-mj-tab="${tab.key}">${tab.label}</button>`).join('');
    page.addEventListener('click', async (e)=>{
      const tabBtn = e.target.closest('[data-mj-tab]');
      if(tabBtn){ mjState.tab = tabBtn.dataset.mjTab; renderMidjourneyTab(); return; }
      const hybridBtn = e.target.closest('[data-mj-hybrid-mode]');
      if(hybridBtn){ setMjHybridMode(hybridBtn.closest('[data-mj-hybrid]'), hybridBtn.dataset.mjHybridMode); return; }
      const describeModeBtn = e.target.closest('[data-mj-describe-mode]');
      if(describeModeBtn){
        const mode = describeModeBtn.dataset.mjDescribeMode || 'single';
        page.querySelectorAll('[data-mj-describe-mode]').forEach(btn=>btn.classList.toggle('active', btn === describeModeBtn));
        const input = page.querySelector('[data-mj-field="describe_mode"]');
        if(input) input.value = mode;
        return;
      }
      const removeFileBtn = e.target.closest('[data-mj-remove-file][data-mj-remove-field]');
      if(removeFileBtn){ const input = page.querySelector(`input[type="file"][data-mj-field="${removeFileBtn.dataset.mjRemoveField}"]`); removeMjInputFile(input, removeFileBtn.dataset.mjRemoveFile); updateMjFileList(input); return; }
      const descThumb = e.target.closest('.mj-describe-thumb[data-full-url]');
      if(descThumb){ const u = descThumb.dataset.fullUrl || ''; if(u) showPreview(u, {model:'Midjourney Describe', fullUrl:u}); return; }
      const submitBtn = e.target.closest('[data-mj-submit-action]');
      if(submitBtn){ await submitMjAction(submitBtn.dataset.mjSubmitAction); return; }
    });
    page.addEventListener('change', (e)=>{
      const el = e.target;
      if(el && el.matches('input[type="file"][data-mj-field]')){ mergeMjInputFiles(el, el.files || []); updateMjFileList(el); }
      if(el && el.matches('[data-mj-field]')){ syncMjHybridByValue(el); if(el.dataset.mjField === 'version' || el.dataset.mjField === 'niji') applyMjVersionRules(); if(el.dataset.mjField === 'aspect_ratio') updateMjCustomAspect(); }
    });
    page.addEventListener('input', (e)=>{
      const el = e.target;
      if(el && el.matches('[data-mj-field]')){ syncMjHybridByValue(el); if(el.dataset.mjField === 'version' || el.dataset.mjField === 'niji') applyMjVersionRules(); if(el.dataset.mjField === 'aspect_ratio') updateMjCustomAspect(); }
    });
  }
  renderMidjourneyTab();
}
function renderMidjourneyTab(){
  const conf = MJ_FORM_CONFIG[mjState.tab] || { title:'Midjourney', endpoint:'' };
  const endpoint = MJ_TABS.find(t=>t.key===mjState.tab)?.endpoint || conf.endpoint || '';
  document.querySelectorAll('#mjTabs .mj-tab').forEach(btn=>btn.classList.toggle('active', btn.dataset.mjTab === mjState.tab));
  if($('#mjFormTitle')) $('#mjFormTitle').textContent = mjState.tab === 'inpaint' ? 'Midjourney 局部重绘' : (conf.title || 'Midjourney');
  if($('#mjCurrentEndpoint')) $('#mjCurrentEndpoint').textContent = endpoint;
  if($('#mjFormContainer')) $('#mjFormContainer').innerHTML = renderMjFormByTab(mjState.tab);
  document.querySelectorAll('#mjFormContainer [data-mj-hybrid]').forEach(root=>setMjHybridMode(root, root.dataset.defaultMode || 'upload'));
  document.querySelectorAll('#mjFormContainer input[type="file"][data-mj-field]').forEach(input=>updateMjFileList(input));
  applyMjSavedFormSettings();
  applyMjVersionRules();
  updateMjCustomAspect();
  updateMjFloatingSubmit();
  document.body.classList.toggle('mj-describe-tab-active', mjState.tab === 'describe');
  const desc = $('#mjDescribeOutput');
  if(desc){ desc.classList.toggle('hidden', mjState.tab !== 'describe'); if(mjState.tab === 'describe') loadMjDescribeOutput(); }
}

async function loadMjDescribeOutput(){
  const box = $('#mjDescribeList');
  if(!box) return;
  try{
    const ret = await api('/api/mj_describe_recent?limit=30');
    const rows = Array.isArray(ret.rows) ? ret.rows : [];
    if(!rows.length){ box.innerHTML = '<div class="mj-inline-note">暂无图生文任务结果。</div>'; return; }
    box.innerHTML = rows.map(row=>{
      const text = (Array.isArray(row.text_outputs) && row.text_outputs.length) ? row.text_outputs.join('\n\n') : '等待返回文本结果...';
      const img = row.thumb_url || row.full_url || '';
      return `<div class="mj-describe-item collapsed" data-desc-id="${escapeHtml(row.local_task_id || row.task_id || '')}">
        <div class="mj-describe-thumb" ${row.full_url ? `data-full-url="${escapeHtml(row.full_url||'')}"` : ''}>${img ? `<img src="${withPublicAccess(img)}" loading="lazy" />` : '<span>无缩略图</span>'}</div>
        <div class="mj-describe-text" title="双击展开 / 再次双击折叠"><b>${escapeHtml(row.status || 'processing')}</b><p>${escapeHtml(text)}</p><small>${escapeHtml(row.task_id || row.local_task_id || '')}</small></div>
      </div>`;
    }).join('');
    box.querySelectorAll('.mj-describe-text').forEach(el=>{
      el.addEventListener('dblclick', ()=>{
        const item = el.closest('.mj-describe-item');
        const willOpen = !item.classList.contains('expanded');
        box.querySelectorAll('.mj-describe-item.expanded').forEach(x=>{ if(x!==item){ x.classList.remove('expanded'); x.classList.add('collapsed'); } });
        item.classList.toggle('expanded', willOpen);
        item.classList.toggle('collapsed', !willOpen);
      });
    });
  }catch(e){ box.innerHTML = `<div class="mj-inline-note">加载图生文记录失败：${escapeHtml(e.message || e)}</div>`; }
}

async function collectMjFormData(){
  const box = $('#mjFormContainer');
  const data = {};
  if(!box) return data;
  const els = box.querySelectorAll('[data-mj-field]');
  for(const el of els){
    const name = el.dataset.mjField;
    if(!name) continue;
    const hybrid = el.closest('[data-mj-hybrid]');
    if(hybrid){
      const activeMode = hybrid.dataset.mode || hybrid.dataset.defaultMode || 'upload';
      const urlField = hybrid.dataset.urlField || '';
      const uploadField = hybrid.dataset.mjHybrid || '';
      if(activeMode === 'upload' && name === urlField) continue;
      if(activeMode === 'url' && name === uploadField) continue;
    }
    if(el.type === 'checkbox'){ data[name] = !!el.checked; continue; }
    if(el.type === 'file'){
      const files = getMjInputFiles(el);
      if(!files.length){ data[name] = name === 'modal_mask' ? null : []; continue; }
      const arr = [];
      for(const file of files) arr.push(await fileToData(file));
      data[name] = name === 'modal_mask' ? (arr[0] || null) : arr;
      continue;
    }
    data[name] = el.value;
  }
  if(data.aspect_ratio === 'custom') data.aspect_ratio = String(data.custom_aspect_ratio || '').trim() || '1:1';
  delete data.custom_aspect_ratio;
  return data;
}
async function submitMjAction(action, extra={}){
  try{
    updateMjStatus('submitting', 0, '提交中...');
    const body = await collectMjFormData();
    Object.assign(body, extra || {});
    body.action = action;
    body.api_key = $('#apiKey')?.value?.trim() || $('#videoApiKey')?.value?.trim() || '';
    if(!body.api_key) return toast('请先在首页填写并保存 APIMart API Key');
    const ret = await api('/api/mj_submit', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    mjState.lastJson = ret;
    if(ret.multi && Array.isArray(ret.tasks)){
      mjState.lastBatchId = ret.batch_id || mjState.lastBatchId || '';
      updateMjStatus('submitted', 0, `已提交 ${ret.task_count || ret.tasks.length} 个 Describe 子任务`, ret.batch_id || '', ret.batch_id || '');
      toast(`已提交 ${ret.task_count || ret.tasks.length} 个图生文任务`);
      startMjPollingMulti(ret.tasks);
      if(mjState.tab === 'describe') loadMjDescribeOutput();
      refreshAll();
      return;
    }
    const taskId = ret.task_id || ret?.raw?.task_id || '';
    mjState.lastTaskId = taskId || mjState.lastTaskId || '';
    mjState.lastLocalTaskId = ret.local_task_id || '';
    mjState.lastBatchId = ret.batch_id || mjState.lastBatchId || '';
      updateMjStatus('submitted', 0, taskId ? '已提交' : '已提交，等待任务 ID', ret.batch_name || ret.batch_id || '', taskId || '');
    toast(taskId ? 'Midjourney 任务已提交' : '任务已提交，请稍后查询');
    if(taskId) startMjPolling(taskId, ret.local_task_id || '');
    if(mjState.tab === 'describe') loadMjDescribeOutput();
    refreshAll();
  }catch(e){
    updateMjStatus('failed', 0, e.message || '提交失败');
    toast(e.message || 'Midjourney 提交失败');
  }
}
function mjStatusLabel(status='', progress=0){
  const raw = String(status || '').trim();
  const st = raw.toLowerCase();
  if(/completed|succeeded|success|done|finish|已完成/.test(st)) return '已完成';
  if(/failed|fail|error|cancel|失败|取消/.test(st)) return '失败';
  if(/queued|queue|pending/.test(st)) return '排队中';
  if(/submitted|created/.test(st)) return '已提交';
  if(/processing|running|in_progress|generating|生成中/.test(st)) return '生成中';
  if(Number(progress || 0) > 0 && Number(progress || 0) < 100) return '生成中';
  return raw || '未提交';
}
function mjStatusProgress(status='', progress=0){
  const st = String(status || '').toLowerCase();
  if(/completed|succeeded|success|done|finish|failed|fail|error|cancel|已完成|失败|取消/.test(st)) return 100;
  return Math.max(0, Math.min(100, Number(progress || 0)));
}
function updateMjStatus(status='pending', progress=0, label='', batchLabel='', taskId=''){
  const safeProgress = mjStatusProgress(status, progress);
  const safeLabel = label || mjStatusLabel(status, safeProgress);
  if($('#mjTaskStatus')) $('#mjTaskStatus').textContent = `状态：${safeLabel}`;
  if($('#mjTaskProgress')) $('#mjTaskProgress').textContent = `进度：${safeProgress.toFixed(0)}%`;
  if($('#mjTaskBatch')) $('#mjTaskBatch').textContent = `任务ID：${taskId || mjState.lastTaskId || '-'}`;
}
function mjStatusFinished(status=''){
  return /completed|succeeded|success|done|finish|failed|fail|error|cancel|已完成|失败|取消/i.test(String(status||''));
}
async function queryMjTask(taskId, localTaskId=''){
  try{
    const ret = await api('/api/mj_task', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ task_id:taskId, local_task_id: localTaskId || mjState.lastLocalTaskId || '', api_key: $('#apiKey')?.value?.trim() || $('#videoApiKey')?.value?.trim() || '' }) });
    mjState.lastTaskId = taskId;
    if(ret.local_task_id) mjState.lastLocalTaskId = ret.local_task_id;
    if(ret.batch_id) mjState.lastBatchId = ret.batch_id;
    const displayProgress = mjStatusProgress(ret.status || 'processing', ret.progress || 0);
    updateMjStatus(ret.status || 'processing', displayProgress, mjStatusLabel(ret.status || 'processing', displayProgress), ret.batch_name || ret.batch_id || '', ret.task_id || taskId || '');
    mjState.lastJson = ret;
    if(mjState.tab === 'describe') loadMjDescribeOutput();
    refreshAll();
    return ret;
  }catch(e){
    updateMjStatus('failed', 0, e.message || '查询失败');
    throw e;
  }
}
function startMjPolling(taskId, localTaskId=''){
  clearInterval(mjState.pollingTimer);
  const poll = async()=>{
    try{
      const ret = await queryMjTask(taskId, localTaskId);
      const st = String(ret.status || '').toLowerCase();
      if(mjStatusFinished(st)) clearInterval(mjState.pollingTimer);
    }catch{}
  };
  poll();
  mjState.pollingTimer = setInterval(poll, 5000);
}
function startMjPollingMulti(tasks=[]){
  clearInterval(mjState.pollingTimer);
  const pending = new Map((tasks || []).filter(t=>t.task_id).map(t=>[t.task_id, t.local_task_id || '']));
  const poll = async()=>{
    for(const [taskId, localTaskId] of Array.from(pending.entries())){
      try{
        const ret = await queryMjTask(taskId, localTaskId);
        if(mjStatusFinished(ret.status || '')) pending.delete(taskId);
      }catch{}
    }
    if(!pending.size) clearInterval(mjState.pollingTimer);
  };
  poll();
  mjState.pollingTimer = setInterval(poll, 5000);
}

async function startup(){
  try{
    loadPreviewBgSettings();
    applyPreviewBgSettings();
    await loadConfig();
    calcEstimate();
    await refreshAll();
    setupVideoPage();
    bindImageApiPlatformSwitch();
    setupPromptLibrary();
    setupAssetLibrary();
    setupAnnouncements();
    initMidjourneyPage();
    initMjRegionModal();
  }catch(e){
    const msg = String(e.message || e);
    if(msg.includes('公网访问密码') || msg.includes('密码') || msg.includes('403')) showPublicLogin(msg);
    else showFatalOverlay(msg);
  }
}
startup();
setInterval(()=>{ if(!isInlineNoteEditing && !$('#publicLoginOverlay')?.classList.contains('active')) refreshAll(); }, 5000);

