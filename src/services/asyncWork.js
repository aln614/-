const fs = require('fs');
const path = require('path');

function createLimiter(value) {
  const limit = Number.isFinite(Number(value)) ? Math.max(1, Math.floor(Number(value))) : 1;
  let active = 0;
  const waiting = [];
  function acquire() {
    return new Promise(resolve => {
      const enter = () => {
        active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          active -= 1;
          const next = waiting.shift();
          if (next) next();
        });
      };
      if (active < limit) enter();
      else waiting.push(enter);
    });
  }
  async function run(fn) {
    const release = await acquire();
    try { return await fn(); }
    finally { release(); }
  }
  return { acquire, run };
}

// One cache per batch/account; only URLs and in-flight promises are retained.
function createUploadCache({ ttlMs = 10 * 60 * 1000 } = {}) {
  const entries = new Map();
  return async function reuseUpload(filePath, upload) {
    const source = path.resolve(filePath);
    const stat = await fs.promises.stat(source);
    const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = entries.get(source);
    if (cached && cached.fingerprint === fingerprint && Date.now() < cached.expiresAt) return cached.promise;
    const entry = { fingerprint, expiresAt:Infinity, promise:null };
    entry.promise = Promise.resolve().then(upload).then(url => {
      entry.expiresAt = Date.now() + ttlMs;
      return url;
    }, error => {
      if (entries.get(source) === entry) entries.delete(source);
      throw error;
    });
    entries.set(source, entry);
    return entry.promise;
  };
}

module.exports = { createLimiter, createUploadCache };
