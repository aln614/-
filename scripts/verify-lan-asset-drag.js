'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createAssetDragCache,safeName}=require('../lan-client/assetDrag');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-client-drag-test-'));
let denied=false,calls=0;
const cache=createAssetDragCache({root,fetchFile:async(url,options)=>{
  calls++;
  assert.equal(new URL(url).origin,'http://example.test');
  assert.equal(new URL(url).pathname,'/api/assets/source');
  assert.equal(options.headers['X-Client-Id'],'client_test');
  assert.equal(options.redirect,'error');
  return denied ? new Response('denied',{status:403}) : new Response('original content',{headers:{'content-length':'16'}});
}});
const payload={id:'asset_123',clientId:'client_test',name:'original.txt',size:16,version:'v1'};
(async()=>{
  try {
    assert.equal(safeName('../file.txt'),'.._file.txt');
    assert.equal(safeName('CON.txt'),'_CON.txt');
    await assert.rejects(cache.prepare({...payload,id:'../escape'},'http://example.test'),/无效/);
    const [a,b]=await Promise.all([cache.prepare(payload,'http://example.test'),cache.prepare(payload,'http://example.test')]);
    assert.equal(a.filePath,b.filePath);
    assert.equal(calls,1);
    assert.equal(fs.readFileSync(a.filePath,'utf8'),'original content');
    fs.writeFileSync(a.filePath,'modified content');
    const repaired=await cache.prepare(payload,'http://example.test');
    assert.equal(fs.readFileSync(repaired.filePath,'utf8'),'original content');
    denied=true;
    await assert.rejects(cache.prepare(payload,'http://example.test'),/403/);
    denied=false;
    const updated=await cache.prepare({...payload,version:'v2'},'http://example.test');
    assert.notEqual(updated.filePath,a.filePath);
    console.log('LAN asset drag: permissions, concurrent preparation, cache integrity, versioning and filenames passed.');
  } finally {
    const relative=path.relative(os.tmpdir(),root);
    if(!relative.startsWith('tenying-client-drag-test-') || relative.includes(path.sep)) throw Error('Unsafe cleanup');
    fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
