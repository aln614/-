'use strict';

const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

function validateEntries(entries, origin) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 50000) throw new Error('Invalid export manifest');
  const seen = new Set();
  return entries.map(entry => {
    const parts = String(entry.relativePath || '').split('/');
    if (parts.length < 2 || parts.length > 8 || parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('Invalid export filename');
    const key = parts.join('/').toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate export filename');
    seen.add(key);
    const url = new URL(entry.url, origin);
    if (url.origin !== origin || url.pathname !== '/api/export_file' || url.username || url.password) throw new Error('Invalid export source');
    return { ...entry, parts, url:url.href };
  });
}

async function exportFiles({entries, directory, origin, fetchFile, signal, progress = () => {}, timeoutMs = 600000}) {
  const validated = validateEntries(entries, origin);
  let root;
  for (let i = 0; i < 100; i++) {
    root = path.join(directory, `TENYING_Export_${new Date().toISOString().replace(/[:.]/g, '-')}${i ? '_' + i : ''}`);
    try { await fs.promises.mkdir(root); break; }
    catch (error) { if (error.code !== 'EEXIST' || i === 99) throw error; }
  }
  let completed = 0, bytes = 0, lastProgress = 0;
  const errors = [];
  for (const entry of validated) {
    if (signal?.aborted) break;
    let temp = '', handle = null;
    const fileSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    try {
      let parent = root;
      for (const part of entry.parts.slice(0, -1)) {
        parent = path.join(parent, part);
        await fs.promises.mkdir(parent, {recursive:true});
        if ((await fs.promises.lstat(parent)).isSymbolicLink()) throw new Error('Symbolic links are not allowed');
      }
      const target = path.join(parent, entry.parts.at(-1));
      const response = await fetchFile(entry.url, {signal:fileSignal, redirect:'error'});
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      handle = await fs.promises.open(target + '.partial', 'wx');
      temp = target + '.partial';
      let received = 0;
      const counter = new Transform({transform(chunk, _encoding, done) {
        received += chunk.length; bytes += chunk.length;
        if (Date.now() - lastProgress > 150) { lastProgress = Date.now(); progress({completed, total:entries.length, bytes}); }
        done(null, chunk);
      }});
      await pipeline(Readable.fromWeb(response.body), counter, handle.createWriteStream(), {signal:fileSignal});
      if (Number(entry.size) > 0 && received !== Number(entry.size)) throw new Error('文件大小不匹配，请重试');
      // A fresh export root and exclusive creation preserve existing user files.
      await fs.promises.copyFile(temp, target, fs.constants.COPYFILE_EXCL);
      await fs.promises.unlink(temp); temp = '';
      completed++;
    } catch (error) {
      if (!signal?.aborted) errors.push({name:entry.relativePath, error:error.message});
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (temp) await fs.promises.unlink(temp).catch(() => {});
    }
    progress({completed, total:entries.length, bytes, failed:errors.length});
  }
  return {directory:root, completed, total:entries.length, errors, canceled:!!signal?.aborted};
}

function registerFolderExport({getWindow, isAllowedOrigin}) {
  const {ipcMain, dialog} = require('electron');
  let active = null;
  const trusted = event => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !isAllowedOrigin(event.senderFrame.url)) throw new Error('Untrusted export request');
    return window;
  };
  ipcMain.on('folder-export:cancel', (event, id) => {
    try { trusted(event); if (active?.id === id) active.controller.abort(); } catch {}
  });
  ipcMain.handle('folder-export:start', async (event, payload = {}) => {
    const window = trusted(event);
    if (active) throw new Error('已有文件夹导出正在进行');
    const origin = new URL(event.senderFrame.url).origin;
    validateEntries(payload.entries, origin);
    const controller = new AbortController();
    active = {id:payload.id, controller};
    const onNavigation = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) controller.abort(); };
    const onDestroyed = () => controller.abort();
    event.sender.on('did-start-navigation', onNavigation);
    event.sender.once('destroyed', onDestroyed);
    try {
      const selected = await dialog.showOpenDialog(window, {title:'选择保存文件夹', properties:['openDirectory', 'createDirectory']});
      if (selected.canceled || controller.signal.aborted) return {canceled:true, completed:0};
      return await exportFiles({entries:payload.entries, directory:selected.filePaths[0], origin,
        signal:controller.signal, fetchFile:(url, options) => event.sender.session.fetch(url, options),
        progress:value => { if (!event.sender.isDestroyed()) event.sender.send('folder-export:progress', {id:payload.id, ...value}); }
      });
    } finally {
      event.sender.removeListener('did-start-navigation', onNavigation);
      event.sender.removeListener('destroyed', onDestroyed);
      active = null;
    }
  });
}

module.exports = {validateEntries, exportFiles, registerFolderExport};
