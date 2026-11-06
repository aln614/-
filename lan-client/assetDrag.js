'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {Readable} = require('stream');
const {pipeline} = require('stream/promises');

const MAX_AGE = 24 * 60 * 60 * 1000;

async function fileDigest(file) {
  const hash=crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function safeName(value) {
  let name = String(value || 'asset').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = '_' + name;
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name || 'asset';
}

function createAssetDragCache({root, fetchFile}) {
  const pending = new Map();
  async function prepare(payload, origin) {
    const id = String(payload?.id || '');
    const clientId = String(payload?.clientId || '');
    const access = String(payload?.publicAccess || '');
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('资产 ID 无效');
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(clientId) || access.length > 2048 || /[\r\n]/.test(access)) throw new Error('访问身份无效');
    const name = safeName(payload.name);
    const expectedSize = Number(payload.size);
    const version = String(payload.version || '').slice(0, 160);
    const key = crypto.createHash('sha256').update(JSON.stringify([origin,id,clientId,access,name,expectedSize,version])).digest('hex');
    const directory = path.join(root,key);
    const target = path.join(directory,name);
    const digestPath = path.join(directory,`.${name}.sha256`);
    if (pending.has(key)) return pending.get(key);
    const task = (async()=>{
      const url = new URL('/api/assets/source',origin);
      url.searchParams.set('id',id);
      url.searchParams.set('download','1');
      const response = await fetchFile(url.href,{
        headers:{'X-Client-Id':clientId,'X-LAIG-Client-ID':clientId,'X-Public-Access':access},
        redirect:'error',signal:AbortSignal.timeout(600000)
      });
      if (!response.ok || !response.body) throw new Error(`读取资产失败（HTTP ${response.status}）`);
      await fs.promises.mkdir(root,{recursive:true});
      if (!(await fs.promises.lstat(root)).isDirectory()) throw new Error('资产缓存目录无效');
      await fs.promises.mkdir(directory,{recursive:true});
      if (!(await fs.promises.lstat(directory)).isDirectory()) throw new Error('资产缓存目录无效');
      try {
        const stat = await fs.promises.lstat(target);
        if (stat.isFile() && stat.size > 0 && (!Number.isFinite(expectedSize) || expectedSize <= 0 || stat.size === expectedSize)) {
          const digest=await fs.promises.readFile(digestPath,'utf8').catch(()=>'');
          if (/^[a-f0-9]{64}$/.test(digest) && digest===await fileDigest(target)) {
            await response.body.cancel();
            await fs.promises.utimes(target,new Date(),new Date());
            await fs.promises.utimes(digestPath,new Date(),new Date());
            return {filePath:target,name,size:stat.size};
          }
        }
        if (!stat.isFile()) throw new Error('资产缓存文件无效');
        await fs.promises.unlink(target);
      } catch(error) { if(error.code !== 'ENOENT') throw error; }
      const temp = path.join(directory,`.partial-${crypto.randomBytes(12).toString('hex')}`);
      try {
        await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(temp,{flags:'wx'}));
        const stat = await fs.promises.stat(temp);
        const declared = Number(response.headers.get('content-length'));
        if (!stat.size || (declared > 0 && stat.size !== declared) || (expectedSize > 0 && stat.size !== expectedSize)) throw new Error('资产副本大小不匹配');
        await fs.promises.copyFile(temp,target,fs.constants.COPYFILE_EXCL).catch(async error=>{
          if (error.code !== 'EEXIST') throw error;
          const existing=await fs.promises.stat(target);
          if (!existing.isFile() || existing.size !== stat.size) throw error;
        });
        await fs.promises.writeFile(digestPath,await fileDigest(target),'utf8');
        return {filePath:target,name,size:stat.size};
      } finally {
        await fs.promises.unlink(temp).catch(()=>{});
      }
    })().finally(()=>pending.delete(key));
    pending.set(key,task);
    return task;
  }
  async function cleanup() {
    let entries;
    try { entries=await fs.promises.readdir(root,{withFileTypes:true}); } catch { return; }
    for(const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const directory=path.join(root,entry.name);
      try {
        const files=await fs.promises.readdir(directory,{withFileTypes:true});
        const stats=await Promise.all(files.map(file=>fs.promises.lstat(path.join(directory,file.name))));
        if (stats.some(stat=>Date.now()-stat.mtimeMs<MAX_AGE)) continue;
        for(let i=0;i<files.length;i++) if(stats[i].isFile()) await fs.promises.unlink(path.join(directory,files[i].name));
        await fs.promises.rmdir(directory);
      } catch {}
    }
  }
  return {prepare,cleanup};
}

module.exports = {createAssetDragCache,safeName};
