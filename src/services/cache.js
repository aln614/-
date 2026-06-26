const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const https = require('https');
const http = require('http');

function safeName(text, fallback = 'batch') {
  const s = String(text || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ');
  return (s || fallback).slice(0, 80);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeDirs(baseOutputDir, batchName) {
  const dir = ensureDir(path.join(baseOutputDir, safeName(batchName)));
  const thumbs = ensureDir(path.join(dir, '_thumbs'));
  return { dir, thumbs };
}

function createThumb(srcPath, thumbPath, size = 300) {
  try {
    const img = nativeImage.createFromPath(srcPath);
    if (img.isEmpty()) return null;
    const thumb = img.resize({ width: size, height: size, quality: 'good' });
    fs.writeFileSync(thumbPath, thumb.toPNG());
    return thumbPath;
  } catch (err) {
    return null;
  }
}

function fileToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  const b64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

function downloadWithNode(urlValue, outputPath) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlValue); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get({ protocol:u.protocol, hostname:u.hostname, port:u.port || (u.protocol === 'http:' ? 80 : 443), path:u.pathname + u.search, headers:{'User-Agent':'LocalApiImageGenerator/14.1'} }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return downloadWithNode(new URL(res.headers.location, urlValue).toString(), outputPath).then(resolve, reject);
      if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`download failed ${res.statusCode}`));
      ensureDir(path.dirname(outputPath));
      const ws = fs.createWriteStream(outputPath);
      res.pipe(ws);
      ws.on('finish', () => ws.close(()=>resolve(outputPath)));
      ws.on('error', reject);
    });
    req.setTimeout(120000, () => req.destroy(new Error('download timeout 120000ms')));
    req.on('error', reject);
  });
}
async function downloadToFile(url, outputPath) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, buf);
    return outputPath;
  } catch (e) {
    return downloadWithNode(url, outputPath);
  }
}

module.exports = { safeName, ensureDir, makeDirs, createThumb, fileToDataUrl, downloadToFile };
