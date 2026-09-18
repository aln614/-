'use strict';

let folderDownloadActive = false;
async function downloadToFolder(selection) {
  if (folderDownloadActive) return toast('已有文件夹导出正在进行');
  const native = window.folderExport;
  if (!native && !window.showDirectoryPicker) return toast('此连接不支持保存文件夹，请使用新版局域网客户端，或在 Chrome/Edge 中通过 HTTPS 访问。');
  folderDownloadActive = true;
  const controller = new AbortController();
  const id = crypto.randomUUID();
  const panel = document.createElement('div');
  panel.className = 'folder-download-status glass-panel';
  panel.setAttribute('role', 'status');
  const label = document.createElement('span'); label.textContent = '选择保存文件夹…';
  const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = '取消';
  panel.append(label, cancel); document.body.append(panel);
  let unsubscribe = null;
  const update = value => { label.textContent = `保存原文件 ${value.completed} / ${value.total}${value.bytes ? ' · ' + prettyBytes(value.bytes) : ''}`; };
  cancel.onclick = () => { controller.abort(); native?.cancel(id); cancel.disabled = true; label.textContent = '正在取消…'; };
  try {
    // Directory access must be requested during the original click gesture.
    const directory = native ? null : await window.showDirectoryPicker({mode:'readwrite'});
    label.textContent = '读取下载列表…';
    const manifest = await api('/api/export_manifest', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(selection), signal:controller.signal});
    if (!manifest.entries?.length) throw new Error('没有可下载的原文件；文件可能仍在生成或下载中');
    const entries = manifest.entries.map(entry => ({...entry, url:withPublicAccess(entry.url)}));
    let result;
    if (native) {
      unsubscribe = native.onProgress(value => {if (value.id === id) update(value);});
      if (controller.signal.aborted) return;
      result = await native.start({id, entries});
    } else {
      const root = await directory.getDirectoryHandle(`TENYING_Export_${new Date().toISOString().replace(/[:.]/g, '-')}_${id.slice(0,8)}`, {create:true});
      result = {completed:0, total:entries.length, errors:[]};
      let bytes = 0, lastProgress = 0;
      for (const entry of entries) {
        if (controller.signal.aborted) break;
        let writable, parent, filename, created = false;
        try {
          const parts = entry.relativePath.split('/');
          if (parts.some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part))) throw new Error('无效文件名');
          parent = root; filename = parts.at(-1);
          for (const part of parts.slice(0,-1)) parent = await parent.getDirectoryHandle(part, {create:true});
          const response = await fetch(entry.url, {signal:AbortSignal.any([controller.signal, AbortSignal.timeout(600000)]), credentials:'same-origin', redirect:'error'});
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          const file = await parent.getFileHandle(filename, {create:true});
          created = true;
          writable = await file.createWritable();
          let received = 0;
          const reader = response.body.getReader();
          try {
            while (true) {
              const {done, value} = await reader.read(); if (done) break;
              await writable.write(value); received += value.byteLength; bytes += value.byteLength;
              if (Date.now() - lastProgress > 150) { lastProgress = Date.now(); update({...result, bytes}); }
            }
          } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
          if (entry.size > 0 && received !== entry.size) throw new Error('文件大小不匹配');
          await writable.close(); writable = null;
          result.completed++; update({...result, bytes});
        } catch (error) {
          if (writable) await writable.abort().catch(()=>{});
          if (created) await parent.removeEntry(filename).catch(()=>{});
          if (!controller.signal.aborted) result.errors.push({name:entry.relativePath, error:error.message});
        }
      }
      result.canceled = controller.signal.aborted;
    }
    const failed = (manifest.skipped?.length || 0) + (result.errors?.length || 0);
    toast(`${result.canceled ? '已取消，已保存' : '已保存'} ${result.completed || 0} 个原文件${failed ? `；${failed} 个未保存，请稍后重试` : ''}${result.directory ? '：' + result.directory : ''}`);
  } catch (error) {
    toast(error.name === 'AbortError' ? '已取消保存' : error.message || '保存文件夹失败');
  } finally {
    unsubscribe?.(); panel.remove(); folderDownloadActive = false;
  }
}
