'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const index = require('../src/services/assetIndex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'tenying-asset-index-test-'));
const file = path.join(dir,'meta','assets_db.json');
const filesDir = path.join(dir,'files');
const backupDir = path.join(dir,'backups');
fs.mkdirSync(filesDir); fs.mkdirSync(path.dirname(file));
const options = {filesDir,backupDir,now:()=>new Date().toISOString()};
const fresh = index.read(file,options);
assert.equal(fresh.assets.length,0);
index.write(file,fresh,options);
assert(!fs.existsSync(file),'Opening a fresh library must not write a blank index');
fresh.groups.push({id:'group',name:'Library'});
fresh.assets.push({id:'asset',group_id:'group',name:'Original'});
index.write(file,fresh,options);
const original = fs.readFileSync(file,'utf8');
const mtime = fs.statSync(file).mtimeMs;
index.write(file,index.read(file,options),options);
assert.equal(fs.statSync(file).mtimeMs,mtime,'No-op reads must not rewrite the index');
const changed = index.read(file,options); changed.assets[0].name='Changed';
const rename = fs.renameSync;
try {
  fs.renameSync = () => {const e=new Error('NAS rename denied');e.code='EACCES';throw e;};
  assert.throws(()=>index.write(file,changed,options),/NAS rename denied/);
} finally {fs.renameSync=rename;}
assert.equal(fs.readFileSync(file,'utf8'),original,'Failed replacement must preserve the original');
assert.equal(fs.readdirSync(path.dirname(file)).filter(name=>name.endsWith('.tmp')).length,0);
assert.equal(fs.readdirSync(backupDir).length,1,'A local backup must precede overwrite');
index.write(file,changed,options);
assert.equal(index.read(file,options).assets[0].name,'Changed');
const valid = fs.readFileSync(file,'utf8');
for (const invalid of ['{broken', '{}', '{"groups":null,"assets":[]}','{"groups":[null],"assets":[]}']) {
  fs.writeFileSync(file,invalid);
  assert.throws(()=>index.read(file,options),/停止写入/);
  assert.equal(fs.readFileSync(file,'utf8'),invalid,'Invalid data must not be replaced with empty arrays');
}
fs.writeFileSync(file,valid);
const deleted=index.read(file,options); deleted.groups=[]; deleted.assets=[]; index.write(file,deleted,options);
assert.equal(index.read(file,options).assets.length,0,'Explicit deletion remains valid; never auto-resurrect backups');
fs.unlinkSync(file);
assert.throws(()=>index.read(file,options),/停止创建空索引/,'Missing index with backups must fail closed');
fs.mkdirSync(path.join(filesDir,'host'));
assert.throws(()=>index.read(file,{filesDir}),/停止创建空索引/,'Existing originals must prevent empty initialization');

const source=fs.readFileSync(path.join(__dirname,'../src/renderer/static/app.js'),'utf8');
const start=source.indexOf('let assetLibraryLoadSequence = 0;');
const end=source.indexOf('async function loadAssetAssets(',start);
const nodes=new Map();
const $=id=>{if(!nodes.has(id)) nodes.set(id,{textContent:'',innerHTML:'',classList:{toggle(){}}}); return nodes.get(id);};
const pending=[];
const state={ready:false,groups:[],assets:[],allAssets:[],currentGroup:''};
const context=vm.createContext({assetState:state,$,api:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),assetApplyLoadedFilter(){},renderAssetLibrary(){},toast(){}});
vm.runInContext(source.slice(start,end),context);
async function checkRenderer() {
  const first=vm.runInContext('loadAssetLibrary()',context);
  pending.shift().reject(new Error('network unavailable')); await first;
  assert.equal($('#assetCurrentGroupTitle').textContent,'资产库暂时无法读取');
  assert.equal($('#assetLoadRetryBtn').hidden,false);
  const next=vm.runInContext('loadAssetLibrary()',context);
  pending.shift().resolve({groups:[{id:'g'}],assets:[{id:'a'}],settings:{dir:'example'}}); await next;
  assert.equal(state.assets.length,1); assert.equal($('#assetLoadStatus').hidden,true);
  const bad=vm.runInContext('loadAssetLibrary()',context); pending.shift().resolve({ok:true}); await bad;
  assert.equal(state.assets.length,1,'Malformed refresh must retain the previous assets');
  const stale=vm.runInContext('loadAssetLibrary()',context);
  const recent=vm.runInContext('loadAssetLibrary()',context);
  const old=pending.shift(),latest=pending.shift();
  latest.resolve({groups:[{id:'latest'}],assets:[{id:'latest'}]}); await recent;
  old.resolve({groups:[],assets:[]}); await stale;
  assert.equal(state.assets[0].id,'latest','Late responses must not clear newer data');
  console.log('[verify-asset-index] Atomic writes, local backups, read-failure protection, empty-index safeguards and UI recovery passed.');
}
async function checkMirror() {
  const main=fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
  const start=main.indexOf('async function copyRuntimeMirrorFile(');
  const end=main.indexOf('\n}',start)+2;
  const context=vm.createContext({fs,path,crypto:require('node:crypto'),process,runtimeMirrorSignatures:new Map()});
  vm.runInContext(main.slice(start,end),context);
  const source=path.join(dir,'mirror-source.json'), destination=path.join(dir,'mirror-destination.json');
  fs.writeFileSync(source,'{broken'); fs.writeFileSync(destination,valid);
  await assert.rejects(context.copyRuntimeMirrorFile(source,destination,index.parseIndex));
  assert.equal(fs.readFileSync(destination,'utf8'),valid,'Invalid primary must not overwrite the output-directory mirror');
  fs.writeFileSync(source,original);
  await context.copyRuntimeMirrorFile(source,destination,index.parseIndex);
  assert.equal(fs.readFileSync(destination,'utf8'),original);
  console.log('[verify-asset-index] Validated atomic asset mirrors passed.');
}
checkRenderer().then(checkMirror).catch(error=>{console.error(error);process.exitCode=1;});
