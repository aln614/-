'use strict';

const fs = require('fs');
const path = require('path');

function cleanName(value, fallback = 'file') {
  const clean = String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 110).replace(/[. ]+$/g, '');
  return !clean || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(clean) ? fallback : clean;
}
function uniqueName(value, used) {
  const ext = path.extname(value), stem = value.slice(0, value.length - ext.length);
  let name = value, index = 2;
  while (used.has(name.toLowerCase())) name = `${stem}_${index++}${ext}`;
  used.add(name.toLowerCase());
  return name;
}
async function buildExportManifest(rows) {
  const entries = [], skipped = [], folders = new Map(), folderNames = new Set(), filenames = new Map(), seen = new Set();
  for (const row of rows) {
    const key = `${row.kind}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let stat;
    try { stat = await fs.promises.stat(row.file); if (!stat.isFile()) throw new Error('not a file'); }
    catch { skipped.push({id:row.id, name:row.name || row.id, reason:'原文件尚未保存或暂时无法读取'}); continue; }
    if (!folders.has(row.folderId)) folders.set(row.folderId, uniqueName(cleanName(row.folder, 'Batch'), folderNames));
    const folder = folders.get(row.folderId);
    if (!filenames.has(folder)) filenames.set(folder, new Set());
    const ext = path.extname(row.file);
    let name = cleanName(row.name || path.basename(row.file));
    if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
    name = uniqueName(name, filenames.get(folder));
    entries.push({relativePath:`${folder}/${name}`, size:stat.size,
      url:`/api/export_file?kind=${encodeURIComponent(row.kind)}&id=${encodeURIComponent(row.id)}`});
  }
  return {ok:true, entries, skipped};
}
module.exports = {buildExportManifest, cleanName, uniqueName};
