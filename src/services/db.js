const fs = require('fs');
const path = require('path');

let storePath = null;
let store = null;
let saveTimer = null;
let saveDirty = false;
let networkTimeOffsetMs = 0;
let networkTimeInfo = { source: 'local', offset_ms: 0, synced_at: '', server_time: '', ok: false };
function setNetworkTimeOffset(offsetMs = 0, info = {}) {
  networkTimeOffsetMs = Number(offsetMs || 0);
  networkTimeInfo = { source: info.source || 'network', offset_ms: networkTimeOffsetMs, synced_at: new Date().toISOString(), server_time: info.server_time || '', ok: true };
}
function getNetworkTimeInfo() { return { ...networkTimeInfo }; }

function emptyStore() {
  return { batches: [], tasks: [], images: [], logs: [], prompt_groups: [], prompt_templates: [], nextLogId: 1 };
}

function initDB(userDataDir) {
  const dataDir = path.join(userDataDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  storePath = path.join(dataDir, 'store.json');
  if (!fs.existsSync(storePath)) fs.writeFileSync(storePath, JSON.stringify(emptyStore(), null, 2), 'utf8');
  try {
    store = { ...emptyStore(), ...JSON.parse(fs.readFileSync(storePath, 'utf8')) };
  } catch (err) {
    store = emptyStore();
    save();
  }
  return getDB();
}

function flushSave() {
  if (!storePath || !store || !saveDirty) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveDirty = false;
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = storePath + '.tmp';
  // 生产环境不再格式化写入，减少 store.json 体积和磁盘写入时间。
  fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
  fs.renameSync(tmp, storePath);
}
function save() {
  if (!storePath || !store) return;
  saveDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { try { flushSave(); } catch {} }, 800);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}
function forceSave() {
  if (!storePath || !store) return;
  saveDirty = true;
  flushSave();
}
process.once('exit', () => { try { flushSave(); } catch {} });
process.once('SIGINT', () => { try { flushSave(); } catch {} process.exit(); });
process.once('SIGTERM', () => { try { flushSave(); } catch {} process.exit(); });

function getDB() {
  if (!store) throw new Error('database not initialized');
  return {
    prepare,
    transaction(fn) {
      return (...args) => {
        const out = fn(...args);
        save();
        return out;
      };
    },
    _store: store,
    _save: forceSave
  };
}

function nowISO() { return new Date(Date.now() + networkTimeOffsetMs).toISOString().replace('T', ' ').slice(0, 19); }
function uuid(prefix = '') { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

function addLog(message, opts = {}) {
  const msg = String(message || '').slice(0, Number(opts.maxLen || 1600));
  // 高频轮询日志容易拖慢界面；相同日志 1 秒内合并跳过。
  const last = store.logs[store.logs.length - 1];
  const now = nowISO();
  if (last && last.message === msg && last.level === (opts.level || 'info')) return;
  const row = {
    id: store.nextLogId++,
    owner_id: opts.ownerId || 'local',
    batch_id: opts.batchId || '',
    level: opts.level || 'info',
    message: msg,
    created_at: now
  };
  store.logs.push(row);
  if (store.logs.length > 2000) store.logs = store.logs.slice(-1200);
  save();
}

function listBatches({ ownerId = 'local', page = 1, pageSize = 50, status = '', keyword = '' } = {}) {
  let rows = store.batches.filter(b => !ownerId || b.owner_id === ownerId);
  if (status) rows = rows.filter(b => b.status === status);
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    rows = rows.filter(b => JSON.stringify([b.name, b.note, b.model]).toLowerCase().includes(kw));
  }
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const total = rows.length;
  const offset = (Number(page) - 1) * Number(pageSize);
  return { rows: rows.slice(offset, offset + Number(pageSize)), total, page: Number(page), pageSize: Number(pageSize) };
}

function listImages({ ownerId = 'local', batchId = '', page = 1, pageSize = 100 } = {}) {
  let rows = store.images.filter(i => !ownerId || i.owner_id === ownerId);
  if (batchId) rows = rows.filter(i => i.batch_id === batchId);
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const total = rows.length;
  const offset = (Number(page) - 1) * Number(pageSize);
  return { rows: rows.slice(offset, offset + Number(pageSize)), total, page: Number(page), pageSize: Number(pageSize) };
}

function listLogs({ ownerId = 'local', page = 1, pageSize = 200 } = {}) {
  const offset = (Number(page) - 1) * Number(pageSize);
  return store.logs.filter(l => !ownerId || l.owner_id === ownerId).sort((a,b)=>b.id-a.id).slice(offset, offset + Number(pageSize)).reverse();
}

function inc(row, key, amount) { row[key] = Math.max(0, Number(row[key] || 0) + Number(amount || 0)); }
function countTasks(ownerId, status) {
  return store.tasks.filter(t => t.owner_id === ownerId && (!status || (Array.isArray(status) ? status.includes(t.status) : t.status === status))).length;
}

function prepare(sql) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  return {
    run(...args) { return runSQL(s, args); },
    get(...args) { return getSQL(s, args); },
    all(...args) { return allSQL(s, args); }
  };
}

function runSQL(s, args) {
  // Named object inserts from taskQueue
  if (s.startsWith('INSERT INTO batches(')) {
    const r = { ...args[0] };
    r.success_count = Number(r.success_count || 0);
    r.fail_count = Number(r.fail_count || 0);
    r.running_count = Number(r.running_count || 0);
    store.batches.push(r); save(); return { changes: 1 };
  }
  if (s.startsWith('INSERT INTO tasks(')) { store.tasks.push({ progress: 0, progress_text: '', status_payload: null, ...args[0] }); save(); return { changes: 1 }; }
  if (s.startsWith('INSERT INTO images(')) {
    const vals = args;
    store.images.push({ id: vals[0], batch_id: vals[1], task_id: vals[2], owner_id: vals[3], file_path: vals[4], thumb_path: vals[5], size_bytes: vals[6], created_at: vals[7], remote_url: vals[8] || '' });
    save(); return { changes: 1 };
  }
  if (s.startsWith('INSERT INTO logs(')) { addLog(args[0]?.message || '', { ownerId: args[0]?.owner_id, batchId: args[0]?.batch_id, level: args[0]?.level }); return { changes: 1 }; }

  // Updates
  if (s.startsWith('UPDATE batches SET status=?, updated_at=? WHERE id=?')) {
    const [status, updated, id] = args; const b = store.batches.find(x => x.id === id); if (b) { b.status = status; b.updated_at = updated; save(); return { changes: 1 }; }
  }
  if (s.startsWith('UPDATE batches SET note=?, updated_at=? WHERE id=?')) {
    const [note, updated, id] = args; const b = store.batches.find(x => x.id === id); if (b) { b.note = note; b.updated_at = updated; save(); return { changes: 1 }; }
  }
  if (s.startsWith('UPDATE batches SET status=?, running_count=0, finished_at=?, updated_at=? WHERE id=?')) {
    const [status, fin, updated, id] = args; const b = store.batches.find(x => x.id === id); if (b) { b.status=status; b.running_count=0; b.finished_at=fin; b.updated_at=updated; save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE tasks SET status=?, attempt=?, progress=?, progress_text=?, updated_at=? WHERE id=?')) {
    const [status, attempt, progress, progress_text, updated, id] = args; const t = store.tasks.find(x=>x.id===id); if (t) { t.status=status; t.attempt=attempt; t.progress=Number(progress||0); t.progress_text=progress_text||''; t.updated_at=updated; save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE tasks SET status=?, attempt=?, updated_at=? WHERE id=?')) {
    const [status, attempt, updated, id] = args; const t = store.tasks.find(x=>x.id===id); if (t) { t.status=status; t.attempt=attempt; t.updated_at=updated; save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE batches SET running_count=running_count+1')) {
    const [updated, id] = args; const b = store.batches.find(x=>x.id===id); if (b) { inc(b,'running_count',1); b.updated_at=updated; save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE tasks SET status=?, remote_task_id=?, progress=?, progress_text=?, updated_at=? WHERE id=?')) {
    const [status, remote, progress, progress_text, updated, id] = args; const t = store.tasks.find(x=>x.id===id); if (t) { Object.assign(t,{status,remote_task_id:remote,progress:Number(progress||0),progress_text:progress_text||'',updated_at:updated}); save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE tasks SET status=?, remote_task_id=?, updated_at=? WHERE id=?')) {
    const [status, remote, updated, id] = args; const t = store.tasks.find(x=>x.id===id); if (t) { Object.assign(t,{status,remote_task_id:remote,updated_at:updated}); save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE tasks SET progress=?, progress_text=?, updated_at=? WHERE id=?')) {
    const [progress, progress_text, updated, id] = args; const t = store.tasks.find(x=>x.id===id); if (t) { t.progress=Number(progress||0); t.progress_text=progress_text||''; t.updated_at=updated; save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE tasks SET status=?, remote_task_id=?, result_path=?, thumb_path=?')) {
    const [status, remote, result, thumb, updated, finished, id] = args; const t = store.tasks.find(x=>x.id===id); if (t) { Object.assign(t,{status,remote_task_id:remote,result_path:result,thumb_path:thumb,updated_at:updated,finished_at:finished}); save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE batches SET success_count=success_count+1')) {
    const [updated, id] = args; const b = store.batches.find(x=>x.id===id); if (b) { inc(b,'success_count',1); inc(b,'running_count',-1); b.updated_at=updated; save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE tasks SET status=?, error_message=?, updated_at=? WHERE id=?')) {
    const [status, err, updated, id] = args; const t = store.tasks.find(x=>x.id===id); if (t) { t.status=status; t.error_message=err; if(status==='失败'){ t.progress=100; t.progress_text='失败'; } t.updated_at=updated; save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE batches SET fail_count=fail_count+1')) {
    const [updated, id] = args; const b = store.batches.find(x=>x.id===id); if (b) { inc(b,'fail_count',1); inc(b,'running_count',-1); b.updated_at=updated; save(); return {changes:1}; }
  }
  if (s.startsWith('UPDATE batches SET fail_count=fail_count+?')) {
    const [failInc, updated, id] = args; const b = store.batches.find(x=>x.id===id); if (b) { inc(b,'fail_count',Number(failInc)); inc(b,'running_count',-1); b.updated_at=updated; save(); return {changes:1}; }
  }
  return { changes: 0 };
}

function getSQL(s, args) {
  if (s.startsWith('SELECT COUNT(*) c FROM tasks WHERE owner_id=? AND status IN')) return { c: countTasks(args[0], ['提交生成中','生成中','下载中']) };
  if (s.startsWith('SELECT COUNT(*) c FROM tasks WHERE owner_id=? AND status=')) return { c: countTasks(args[0], s.includes("'已完成'") ? '已完成' : '失败') };
  if (s.startsWith('SELECT COUNT(*) c FROM tasks WHERE owner_id=?')) return { c: countTasks(args[0]) };
  if (s.startsWith('SELECT * FROM batches WHERE id=? AND owner_id=?')) return store.batches.find(b => b.id === args[0] && b.owner_id === args[1]);
  if (s.startsWith('SELECT * FROM batches WHERE id=?')) return store.batches.find(b => b.id === args[0]);
  if (s.startsWith("SELECT * FROM tasks WHERE batch_id=? AND (status='等待中' OR (status='生成中' AND remote_task_id!=''))")) {
    return store.tasks.filter(t => t.batch_id === args[0] && (t.status === '等待中' || (t.status === '生成中' && String(t.remote_task_id || '') !== ''))).sort((a,b)=>Number(a.task_index)-Number(b.task_index))[0];
  }
  if (s.startsWith("SELECT * FROM tasks WHERE batch_id=? AND status='等待中'")) {
    return store.tasks.filter(t => t.batch_id === args[0] && t.status === '等待中').sort((a,b)=>Number(a.task_index)-Number(b.task_index))[0];
  }
  if (s.startsWith('SELECT COUNT(*) c FROM batches')) return { c: 0 };
  if (s.startsWith('SELECT COUNT(*) c FROM images')) return { c: 0 };
  return undefined;
}

function allSQL(s, args) {
  if (s.startsWith('SELECT * FROM batches WHERE owner_id=? ORDER BY created_at DESC LIMIT 8')) return store.batches.filter(b=>b.owner_id===args[0]).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,8);
  if (s.startsWith('SELECT DISTINCT prompt FROM tasks WHERE batch_id=?')) {
    const seen = new Set();
    return store.tasks.filter(t=>t.batch_id===args[0]).sort((a,b)=>Number(a.task_index)-Number(b.task_index)).filter(t=>{ if(seen.has(t.prompt)) return false; seen.add(t.prompt); return true; }).map(t=>({prompt:t.prompt}));
  }
  if (s.startsWith('SELECT main_image_path FROM tasks WHERE batch_id=?')) {
    return store.tasks.filter(t=>t.batch_id===args[0] && t.main_image_path).map(t=>({main_image_path:t.main_image_path}));
  }
  if (s.startsWith('SELECT * FROM images WHERE batch_id=? AND owner_id=? ORDER BY created_at ASC')) {
    return store.images.filter(i=>i.batch_id===args[0] && i.owner_id===args[1]).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
  }
  return [];
}

module.exports = { initDB, getDB, nowISO, uuid, addLog, listBatches, listImages, listLogs, setNetworkTimeOffset, getNetworkTimeInfo };
