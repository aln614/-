'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const snapshots = new WeakMap();

function parseIndex(raw) {
  const value = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  if (!value || !Array.isArray(value.groups) || !Array.isArray(value.assets)) throw new Error('Invalid asset index schema');
  for (const rows of [value.groups, value.assets]) {
    if (rows.some(row => !row || typeof row !== 'object' || !row.id)) throw new Error('Invalid asset row');
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate asset row');
  }
  return value;
}

function read(file, {filesDir, backupDir, now = () => new Date().toISOString()} = {}) {
  let db;
  try {
    db = parseIndex(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('资产库索引读取失败，已停止写入以保护原素材。请检查网络目录或联系主机恢复索引。', {cause:error});
    // Only a genuinely new library may start empty. A missing index is not an empty library.
    const evidenceDirs = [filesDir, backupDir, path.dirname(file)].filter(Boolean);
    for (const dir of evidenceDirs) {
      let entries;
      try { entries = fs.readdirSync(dir); }
      catch (e) { if (e.code === 'ENOENT') continue; throw new Error('资产库目录暂时无法访问，请检查网络连接后重试。', {cause:e}); }
      if (entries.length) throw new Error('资产库索引缺失，但原素材或备份仍存在，已停止创建空索引。请联系主机恢复。');
    }
    db = {groups:[], assets:[], created_at:now(), updated_at:now()};
  }
  snapshots.set(db, JSON.stringify(db));
  return db;
}

function replaceAtomically(file, data) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, data, {encoding:'utf8', flag:'wx'});
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function write(file, db, {backupDir, now = () => new Date().toISOString()} = {}) {
  parseIndex(JSON.stringify(db));
  if (snapshots.get(db) === JSON.stringify(db)) return db;
  let previous = null;
  try { previous = fs.readFileSync(file, 'utf8'); parseIndex(previous); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('资产库当前索引无法校验，已停止覆盖写入，请先恢复索引。', {cause:error});
  }
  // Backup is local and outside the evictable thumbnail cache. Never truncate the NAS index in place.
  if (previous !== null && backupDir) {
    fs.mkdirSync(backupDir, {recursive:true});
    const digest = crypto.createHash('sha256').update(previous).digest('hex');
    const backup = path.join(backupDir, `asset-index-${digest}.json`);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, previous, {encoding:'utf8',flag:'wx'});
  }
  const next = {...db, updated_at:now()};
  fs.mkdirSync(path.dirname(file), {recursive:true});
  replaceAtomically(file, JSON.stringify(next, null, 2));
  db.updated_at = next.updated_at;
  snapshots.set(db, JSON.stringify(db));
  if (backupDir) {
    // Prune only snapshots created by this module, keeping the latest 30 revisions per library.
    try {
      const backups = fs.readdirSync(backupDir).filter(name => /^asset-index-[a-f0-9]{64}\.json$/.test(name))
        .map(name => ({file:path.join(backupDir,name),time:fs.statSync(path.join(backupDir,name)).mtimeMs})).sort((a,b)=>b.time-a.time);
      backups.slice(30).forEach(item => {try {fs.unlinkSync(item.file);} catch {}});
    } catch {}
  }
  return db;
}

module.exports = {read, write, parseIndex};
