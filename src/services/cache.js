const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, nativeImage } = require('electron');
const https = require('https');
const http = require('http');
const { extractEmbeddedPsdThumbnail } = require('./psdPreview');

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
    const isPsd = /\.ps[db]$/i.test(path.extname(srcPath));
    const embedded = isPsd ? extractEmbeddedPsdThumbnail(srcPath) : null;
    const img = embedded?.length ? nativeImage.createFromBuffer(embedded) : nativeImage.createFromPath(srcPath);
    if (img.isEmpty()) return null;
    const dimensions = img.getSize();
    const resize = isPsd && dimensions.width && dimensions.height
      ? (dimensions.width >= dimensions.height ? { width:size, quality:'good' } : { height:size, quality:'good' })
      : { width:size, height:size, quality:'good' };
    const thumb = img.resize(resize);
    fs.writeFileSync(thumbPath, thumb.toPNG());
    return thumbPath;
  } catch (err) {
    return null;
  }
}

let chromiumImageConversionQueue = Promise.resolve();

async function convertImageWithChromium(srcPath, tempPath) {
  if (!app?.isReady?.() || typeof BrowserWindow !== 'function') throw new Error('Chromium 图片转换器尚未就绪');
  const run = async() => {
    const window = new BrowserWindow({
      show:false,
      webPreferences:{ nodeIntegration:true, contextIsolation:false, sandbox:false, backgroundThrottling:false }
    });
    try {
      await window.loadURL('data:text/html,<canvas id="canvas"></canvas>');
      return await window.webContents.executeJavaScript(`(async()=>{
        const fs=require('fs');
        const input=fs.readFileSync(${JSON.stringify(srcPath)});
        const bitmap=await createImageBitmap(new Blob([input]));
        const canvas=document.getElementById('canvas');
        canvas.width=bitmap.width; canvas.height=bitmap.height;
        canvas.getContext('2d',{alpha:true}).drawImage(bitmap,0,0); bitmap.close();
        const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('toBlob failed')),'image/png'));
        fs.writeFileSync(${JSON.stringify(tempPath)},Buffer.from(await blob.arrayBuffer()));
        return blob.size;
      })()`);
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  };
  const pending = chromiumImageConversionQueue.then(run, run);
  chromiumImageConversionQueue = pending.catch(()=>{});
  return pending;
}

async function convertImageToUploadPng(srcPath) {
  const source = String(srcPath || '').trim();
  if (!source || !fs.existsSync(source)) throw new Error('待转换图片不存在');
  const tempPath = path.join(
    os.tmpdir(),
    `tenying-apimart-upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  );
  try {
    const image = nativeImage?.createFromPath?.(source);
    const png = image && !image.isEmpty() ? image.toPNG() : null;
    if (png && png.length) fs.writeFileSync(tempPath, png);
    else await convertImageWithChromium(source, tempPath);
    if (!fs.existsSync(tempPath) || !fs.statSync(tempPath).size) throw new Error('图片转换 PNG 失败');
    return tempPath;
  } catch (error) {
    removeTemporaryUploadFile(tempPath);
    throw new Error(`当前图片无法解码或转换：${error.message || error}`);
  }
}

function removeTemporaryUploadFile(filePath = '') {
  if (!/^tenying-apimart-upload-/i.test(path.basename(String(filePath || '')))) return;
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
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

module.exports = { safeName, ensureDir, makeDirs, createThumb, convertImageToUploadPng, removeTemporaryUploadFile, fileToDataUrl, downloadToFile };
