// Explicit maintenance tool: copies and verifies media; never deletes sources.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Writable } = require('stream');

function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function hash(file) {
  const digest = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), new Writable({
    write(chunk, encoding, done) { digest.update(chunk); done(); }
  }));
  return digest.digest('hex');
}

async function walk(root) {
  const files = [];
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing linked path: ${file}`);
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

function rewriteValue(value, mappings, touched = new Set(), allowedSources = null) {
  if (Array.isArray(value)) return value.map(item => rewriteValue(item, mappings, touched, allowedSources));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteValue(item, mappings, touched, allowedSources)]));
  }
  if (typeof value !== 'string') return value;
  // Several database columns store structured JSON inside a string.
  if (/^\s*[\[{"]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      const before = touched.size;
      const rewritten = rewriteValue(parsed, mappings, touched, allowedSources);
      const result = JSON.stringify(rewritten);
      if (touched.size !== before || result !== JSON.stringify(parsed)) return result;
    } catch {}
  }
  for (const mapping of mappings) {
    const source = path.resolve(mapping.source);
    const normalized = value.replace(/\//g, path.sep);
    if (normalized.toLowerCase().startsWith(`${source.toLowerCase()}${path.sep}`) && inside(source, normalized)) {
      const dest = path.join(mapping.destination, path.relative(source, normalized));
      touched.add(normalized);
      if (allowedSources && !allowedSources.has(path.resolve(normalized).toLowerCase())) return value;
      return dest;
    }
  }
  // File-serving links in chat/agent history may contain a URL-encoded path.
  if (/^(?:https?:\/\/[^/]+)?\/(?:api\/)?(?:file|media|preview|download|image)[/?]/i.test(value)) {
    try {
      const parsed = new URL(value, 'http://local.invalid');
      let changed = false;
      for (const [key, item] of parsed.searchParams) {
        const rewritten = rewriteValue(item, mappings, touched, allowedSources);
        if (rewritten !== item) { parsed.searchParams.set(key, rewritten); changed = true; }
      }
      if (changed) return /^https?:/.test(value) ? parsed.href : `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {}
  }
  return value;
}

function atomicJson(file, value) {
  const tmp = `${file}.migration-next`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
}

async function main() {
  const [mode, dataRootArg, workArg] = process.argv.slice(2);
  if (!['copy', 'rewrite', 'audit'].includes(mode) || !dataRootArg || !workArg) {
    throw new Error('Usage: node migrate-media-storage.js copy|rewrite|audit DATA_ROOT MIGRATION_DIR');
  }
  const dataRoot = path.resolve(dataRootArg);
  const cfg = JSON.parse(fs.readFileSync(path.join(dataRoot, 'config.json'), 'utf8'));
  if (!cfg.output_dir || !fs.statSync(cfg.output_dir).isDirectory()) throw new Error('Output directory unavailable');
  const runtimeRoot = path.join(cfg.output_dir, '\u8fd0\u884c\u6570\u636e\u76ee\u5f55');
  const work = path.resolve(workArg);
  if (!inside(runtimeRoot, work)) throw new Error('Migration records must be inside output runtime directory');
  fs.mkdirSync(work, { recursive: true });
  const manifestPath = path.join(work, 'manifest.json');
  const mappings = [
    { source: path.join(dataRoot, 'uploads'), destination: path.join(runtimeRoot, 'uploads') },
    { source: path.join(path.dirname(dataRoot), 'LocalApiImageGenerator_RuntimeData_V1458', 'uploads'),
      destination: path.join(runtimeRoot, 'uploads', 'legacy-v1458') }
  ];
  if (mode === 'copy') {
    const records = [];
    for (const mapping of mappings) {
      if (!fs.existsSync(mapping.source)) continue;
      for (const source of await walk(mapping.source)) {
        const stat = fs.statSync(source);
        records.push({ source, destination: path.join(mapping.destination, path.relative(mapping.source, source)),
          size: stat.size, mtimeMs: stat.mtimeMs, verified: false });
      }
    }
    const manifest = { dataRoot, mappings, createdAt: new Date().toISOString(), records };
    atomicJson(manifestPath, manifest);
    const totalBytes = records.reduce((sum, row) => sum + row.size, 0);
    const disk = fs.statfsSync(runtimeRoot);
    if (disk.bavail * disk.bsize < totalBytes + 1024 ** 3) throw new Error('Insufficient destination space');
    console.log(JSON.stringify({ files: records.length, bytes: totalBytes, mode }));
    let index = 0;
    let done = 0;
    let bytes = 0;
    let lastLog = Date.now();
    const failures = [];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (index < records.length) {
        const row = records[index++];
        try {
          fs.mkdirSync(path.dirname(row.destination), { recursive: true });
          const sourceHash = await hash(row.source);
          if (fs.existsSync(row.destination)) {
            if (fs.statSync(row.destination).size !== row.size || await hash(row.destination) !== sourceHash) {
              throw new Error(`Destination conflict (kept untouched): ${row.destination}`);
            }
          } else {
            const tmp = `${row.destination}.migrating-${process.pid}`;
            await fs.promises.copyFile(row.source, tmp, fs.constants.COPYFILE_EXCL);
            if (fs.statSync(tmp).size !== row.size || await hash(tmp) !== sourceHash) throw new Error('Copy checksum mismatch');
            await fs.promises.rename(tmp, row.destination);
            await fs.promises.utimes(row.destination, new Date(row.mtimeMs), new Date(row.mtimeMs));
          }
          const after = fs.statSync(row.source);
          if (after.size !== row.size || after.mtimeMs !== row.mtimeMs) throw new Error('Source changed during copy');
          row.sha256 = sourceHash;
          row.verified = true;
          bytes += row.size;
        } catch (error) {
          row.error = error.message;
          failures.push(row.source);
        }
        done++;
        if (done % 250 === 0 || Date.now() - lastLog > 15000 || done === records.length) {
          atomicJson(manifestPath, manifest);
          console.log(JSON.stringify({ done, total: records.length, verifiedGiB: +(bytes / 1024 ** 3).toFixed(3), errors: failures.length }));
          lastLog = Date.now();
        }
      }
    }));
    atomicJson(manifestPath, manifest);
    if (failures.length) throw new Error(`${failures.length} files not verified; sources preserved`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.records.some(row => !row.verified)) throw new Error('Incomplete copy manifest');
  const files = [];
  const roots = [dataRoot, path.join(path.dirname(dataRoot), 'LocalApiImageGenerator_RuntimeData_V1458'),
    runtimeRoot, path.join(cfg.output_dir, '.TENYING_AI_RuntimeData'), cfg.asset_library_dir];
  for (const root of roots.filter(Boolean)) {
    if (!fs.existsSync(root)) continue;
    // Only inspect metadata, never media or Chromium databases.
    const scan = async dir => {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (['uploads', 'files', 'media', 'cache', 'hot_cache', 'HotCache', 'updates',
            'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage',
            'Local Storage', 'Session Storage', 'Network', 'shared_proto_db'].includes(entry.name) || inside(work, file) || file === work) continue;
          await scan(file);
        } else if (entry.isFile() && /\.json$/i.test(entry.name)) files.push(file);
      }
    };
    await scan(root);
  }
  const uniqueFiles = [...new Set(files)];
  const changes = [];
  const unresolved = [];
  let verifiedReferences = 0;
  const verified = new Map(manifest.records.map(row => [path.resolve(row.source).toLowerCase(), row]));
  const checkedDestinations = new Set();
  for (const file of uniqueFiles) {
    let original, value;
    try { original = fs.readFileSync(file, 'utf8'); value = JSON.parse(original.replace(/^\uFEFF/, '')); }
    catch (error) { throw new Error(`Cannot parse metadata ${file}: ${error.message}`); }
    const touched = new Set();
    const next = rewriteValue(value, mappings, touched, verified);
    if (!touched.size) continue;
    for (const source of touched) {
      const row = verified.get(path.resolve(source).toLowerCase());
      // Previously missing media stays as a historical broken reference; do not invent a replacement.
      if (!row) unresolved.push({ file, source });
      else {
        if (!checkedDestinations.has(row.destination)) {
          if (!fs.existsSync(row.destination) || fs.statSync(row.destination).size !== row.size) throw new Error(`Verified destination missing or changed: ${row.destination}`);
          checkedDestinations.add(row.destination);
        }
        verifiedReferences++;
      }
    }
    if (mode === 'rewrite') {
      if (JSON.stringify(next) === JSON.stringify(value)) continue;
      const backup = path.join(work, 'metadata-backups', crypto.createHash('sha256').update(file).digest('hex') + '.json');
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      atomicJson(file, next);
      changes.push({ file, backup, references: touched.size });
    } else changes.push({ file, references: touched.size });
  }
  const report = { mode, at: new Date().toISOString(), filesScanned: uniqueFiles.length, changes, unresolved, verifiedReferences };
  atomicJson(path.join(work, `${mode}-report.json`), report);
  console.log(JSON.stringify({ mode, filesScanned: uniqueFiles.length, changedFiles: changes.length,
    references: changes.reduce((sum, row) => sum + row.references, 0), verifiedReferences, unresolved: unresolved.length }));
}

module.exports = { inside, hash, rewriteValue, walk };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
