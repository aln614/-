'use strict';

function createSoftwareUpdateNetwork({ app, session, fs, path, ensureDir }) {
  let updaterSessionPromise = null;

  async function getUpdaterSession() {
    if (!updaterSessionPromise) {
      updaterSessionPromise = app.whenReady().then(async () => {
        const updaterSession = session.fromPartition('tenying-software-updater');
        await updaterSession.setProxy({ mode:'system' });
        return updaterSession;
      }).catch(error => {
        updaterSessionPromise = null;
        throw error;
      });
    }
    return updaterSessionPromise;
  }

  async function httpJson(target, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('GitHub 更新检查超时')), timeoutMs);
    try {
      const updaterSession = await getUpdaterSession();
      const response = await updaterSession.fetch(target, {
        headers:{ 'User-Agent':'LocalApiImageGenerator-Updater', 'Accept':'application/vnd.github+json' },
        redirect:'follow',
        signal:controller.signal
      });
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('GitHub 更新检查失败：未找到 Release。请确认仓库已公开、已创建 Release，并且 Release 中包含 Windows EXE 附件。');
        }
        throw new Error(`GitHub 更新检查失败：HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason || new Error('GitHub 更新检查超时');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function downloadToFile(target, dest, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs || 30 * 60 * 1000);
    const idleTimeoutMs = Number(opts.idleTimeoutMs || 120000);
    const expectedTotal = Number(opts.total || 0);
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    ensureDir(path.dirname(dest));
    const tmp = `${dest}.part`;
    let existingBytes = 0;
    try { existingBytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0; } catch {}
    if (expectedTotal > 0 && existingBytes > expectedTotal) {
      try { fs.rmSync(tmp, { force:true }); } catch {}
      existingBytes = 0;
    }
    if (expectedTotal > 0 && existingBytes === expectedTotal) {
      try { fs.rmSync(dest, { force:true }); } catch {}
      await fs.promises.rename(tmp, dest);
      return dest;
    }
    const canResume = existingBytes > 0 && expectedTotal > existingBytes && !opts.disableResume;
    if (!canResume && existingBytes) {
      try { fs.rmSync(tmp, { force:true }); } catch {}
      existingBytes = 0;
    }

    const controller = new AbortController();
    let totalTimer = null;
    let idleTimer = null;
    let reader = null;
    let file = null;
    const abort = message => {
      if (!controller.signal.aborted) controller.abort(new Error(message));
    };
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort('新版 EXE 下载长时间没有数据响应，请检查系统代理或网络后重试'), idleTimeoutMs);
    };
    totalTimer = setTimeout(() => abort('新版 EXE 下载超过 30 分钟，请检查系统代理或网络后重试'), timeoutMs);
    resetIdleTimer();

    try {
      const updaterSession = await getUpdaterSession();
      const headers = { 'User-Agent':'LocalApiImageGenerator-Updater', 'Accept':'application/octet-stream' };
      if (canResume) headers.Range = `bytes=${existingBytes}-`;
      const response = await updaterSession.fetch(target, { headers, redirect:'follow', signal:controller.signal });

      if (response.status === 416 && canResume && !opts.disableResume) {
        await response.body?.cancel();
        try { fs.rmSync(tmp, { force:true }); } catch {}
        clearTimeout(totalTimer);
        clearTimeout(idleTimer);
        return await downloadToFile(target, dest, { ...opts, disableResume:true });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`新版 EXE 下载失败：HTTP ${response.status}`);
      }

      let append = false;
      let baseBytes = 0;
      let contentRangeTotal = 0;
      if (response.status === 206) {
        const range = String(response.headers.get('content-range') || '').match(/^bytes\s+(\d+)-\d+\/(\d+|\*)$/i);
        if (canResume && range && Number(range[1]) === existingBytes) {
          append = true;
          baseBytes = existingBytes;
          contentRangeTotal = Number(range[2]) || 0;
        } else if (canResume && !opts.disableResume) {
          await response.body?.cancel();
          try { fs.rmSync(tmp, { force:true }); } catch {}
          clearTimeout(totalTimer);
          clearTimeout(idleTimer);
          return await downloadToFile(target, dest, { ...opts, disableResume:true });
        } else {
          await response.body?.cancel();
          throw new Error('系统代理返回了无效的断点续传响应');
        }
      } else if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new Error(`新版 EXE 下载失败：HTTP ${response.status}`);
      }

      const contentLength = Number(response.headers.get('content-length') || 0);
      const total = expectedTotal || contentRangeTotal || (contentLength ? contentLength + baseBytes : 0);
      if (!response.body) throw new Error('系统代理返回了空下载流');
      reader = response.body.getReader();
      file = await fs.promises.open(tmp, append ? 'a' : 'w');
      let bytes = baseBytes;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        resetIdleTimer();
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await file.write(chunk, offset, chunk.length - offset);
          offset += result.bytesWritten;
        }
        bytes += chunk.length;
        if (onProgress) onProgress({ bytes, total, source:'system-proxy' });
      }
      await file.close();
      file = null;
      const stat = fs.statSync(tmp);
      if (!stat.size) throw new Error('新版 EXE 下载为空文件');
      const verifiedTotal = expectedTotal || total;
      if (verifiedTotal > 0 && stat.size !== verifiedTotal) {
        throw new Error(`新版 EXE 下载大小不完整：${stat.size}/${verifiedTotal}`);
      }
      try { fs.rmSync(dest, { force:true }); } catch {}
      await fs.promises.rename(tmp, dest);
      return dest;
    } catch (error) {
      try { await reader?.cancel(error); } catch {}
      try { await file?.close(); } catch {}
      if (controller.signal.aborted) throw controller.signal.reason || error;
      throw error;
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
    }
  }

  return { getUpdaterSession, httpJson, downloadToFile };
}

module.exports = { createSoftwareUpdateNetwork };
