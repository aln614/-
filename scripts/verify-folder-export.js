'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const {exportFiles, validateEntries, registerFolderExport} = require('../lan-client/folderExport');
const {buildExportManifest, cleanName} = require('../src/services/exportManifest');
const repo = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(repo, 'src/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(repo, 'src/renderer/static/app.js'), 'utf8');
const script = fs.readFileSync(path.join(repo, 'src/renderer/static/folder-download.js'), 'utf8');
const sourceFunction = (source, name, next) => source.slice(source.indexOf('function ' + name + '('), source.indexOf(next, source.indexOf('function ' + name + '(')));

function checkOwnership() {
  const store = {
    batches:[{id:'b1', owner_id:'alice', name:'Batch'}, {id:'b2', owner_id:'bob', name:'Private'}],
    images:[{id:'i1', batch_id:'b1', owner_id:'alice', file_path:'original.png'}, {id:'i2', batch_id:'b2', owner_id:'bob', file_path:'secret.png'}, {id:'input', batch_id:'b1', owner_id:'alice', file_path:'input.png', is_input:true}],
    video_tasks:[{id:'v1', owner_id:'alice', file_path:'original.mp4', video_batch_name:'Video'}]
  };
  const context = vm.createContext({path, getDB:()=>({_store:store}), readAssetDb:()=>({groups:[]}), assetClientId:(_l,id)=>id,
    visibleAssets:(_db,local,owner)=>[{id:'a1', owner_id:'alice', shared:true, local_path:'original.psd', name:'Source.psd'}, {id:'a2',owner_id:'bob',local_path:'private.psd'}].filter(a=>local||a.shared||a.owner_id===owner)});
  vm.runInContext(sourceFunction(main, 'selectedExportRows', '\nfunction isExportableGeneratedImage'), context);
  const select = (body, local=false) => context.selectedExportRows(body, local, {}, 'alice', 'alice');
  assert.equal(select({batch_ids:['b1'], image_ids:['i1'], video_ids:['v1'], asset_ids:['a1']}).length, 3);
  assert.equal(select({batch_ids:['b1']})[0].file, 'original.png');
  for (const body of [{batch_ids:['b2']},{image_ids:['i2']},{asset_ids:['a2']},{image_ids:['i2'],all_owners:true}]) assert.throws(()=>select(body), /权限/);
  assert.equal(select({image_ids:['i2'],all_owners:true}, true)[0].file, 'secret.png');
  assert.throws(()=>select({image_ids:'i1'}), /无效/);
}

async function checkBrowser() {
  const saved = new Map(), removed = [], order = [], toasts = [], panels = [];
  const directory = prefix => ({
    getDirectoryHandle:async name=>directory(prefix + name + '/'),
    getFileHandle:async name=>({createWritable:async()=>({
      write:async value=>saved.set(prefix + name, Buffer.concat([saved.get(prefix + name)||Buffer.alloc(0), Buffer.from(value)])),
      close:async()=>{}, abort:async()=>{}
    })}),
    removeEntry:async name=>{removed.push(name); saved.delete(prefix + name);}
  });
  const context = vm.createContext({AbortController, AbortSignal, crypto:require('crypto').webcrypto, Date,
    window:{showDirectoryPicker:async()=>{order.push('picker'); return directory('');}},
    document:{createElement:()=>({setAttribute(){},append(){},remove(){}}), body:{append:panel=>panels.push(panel)}},
    toast:value=>toasts.push(value), prettyBytes:value=>String(value), withPublicAccess:url=>url,
    api:async()=>{order.push('manifest'); return {entries:[{relativePath:'Batch/image.png', size:3, url:'/api/export_file?kind=image&id=1'}]};},
    fetch:async()=>new Response('abc')
  });
  vm.runInContext(script, context);
  await context.downloadToFolder({batch_ids:['b1']});
  assert.deepEqual(order, ['picker','manifest']);
  assert.equal([...saved.values()][0].toString(), 'abc');
  assert.match(toasts.at(-1), /已保存 1/);
  context.fetch = async()=>new Response('bad length');
  await context.downloadToFolder({batch_ids:['b1']});
  assert.deepEqual(removed, ['image.png']);
  assert.match(toasts.at(-1), /1 个未保存/);
  let payload;
  context.window = {folderExport:{start:async p=>{payload=p;return {completed:1};},onProgress:()=>()=>{},cancel:()=>{}}};
  await context.downloadToFolder({batch_ids:['b1']});
  assert.equal(payload.entries[0].relativePath, 'Batch/image.png');
  context.window = {};
  await context.downloadToFolder({});
  assert.match(toasts.at(-1), /HTTPS/);
  assert.ok(!/export_\w*zip|\.blob\(/.test(script));
}

function checkIpc() {
  const Module = require('module'), original = Module._load, handlers = {};
  const frame = {url:'http://host:7868/'};
  const sender = {mainFrame:frame}, window = {webContents:sender};
  Module._load = function(name) {
    if (name === 'electron') return {ipcMain:{on:(id,fn)=>handlers[id]=fn, handle:(id,fn)=>handlers[id]=fn},dialog:{}};
    return original.apply(this, arguments);
  };
  try { registerFolderExport({getWindow:()=>window, isAllowedOrigin:()=>true}); }
  finally { Module._load = original; }
  assert.doesNotThrow(()=>handlers['folder-export:cancel']({sender:{}, senderFrame:frame}, 'wrong'));
  return assert.rejects(handlers['folder-export:start']({sender:{}, senderFrame:frame}), /Untrusted/);
}

async function run() {
  checkOwnership();
  await checkBrowser();
  await checkIpc();
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tenying-folder-test-'));
  const bytes = Buffer.alloc(2 * 1024 * 1024, 93);
  const source = path.join(temp, 'original.png');
  await fs.promises.writeFile(source, bytes);
  const rows = [
    {kind:'image',id:'i1',file:source,name:'Photo.png',folderId:'b1',folder:'Batch'},
    {kind:'image',id:'i2',file:source,name:'photo.png',folderId:'b1',folder:'Batch'},
    {kind:'video',id:'v1',file:source,name:'Source',folderId:'b2',folder:'Batch'},
    {kind:'asset',id:'a1',file:path.join(temp,'missing'),name:'missing',folderId:'b3',folder:'../CON'}
  ];
  const manifest = await buildExportManifest([...rows,rows[0]]);
  assert.equal(manifest.entries.length, 3);
  assert.equal(manifest.skipped.length, 1);
  assert.deepEqual(manifest.entries.map(e=>e.relativePath), ['Batch/Photo.png','Batch/photo_2.png','Batch_2/Source.png']);
  assert.ok(!JSON.stringify(manifest).includes(temp));
  assert.equal(cleanName('CON.png'), 'file');
  assert.ok(!/[. ]$/.test(cleanName('x'.repeat(109)+'. tail')));
  const server = http.createServer((req,res)=>{
    if (req.url.includes('id=broken')) {res.writeHead(500);res.end('error');}
    else if(req.url.includes('id=short')) res.end('short');
    else if(req.url.includes('id=slow')) {res.writeHead(200);res.write('x');}
    else {res.writeHead(200,{'Content-Length':bytes.length});res.end(bytes);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    for(const relativePath of ['../outside.png','Batch/../../out','Batch/C:\\out','Batch/CON.png','Batch/.','Batch/name.']) {
      assert.throws(()=>validateEntries([{relativePath,url:'/api/export_file'}],origin), /filename/);
    }
    assert.throws(()=>validateEntries([{relativePath:'b/x',url:'https://untrusted.example/api/export_file'}],origin),/source/);
    assert.throws(()=>validateEntries([{relativePath:'b/x',url:'/file?path=secret'}],origin),/source/);
    assert.throws(()=>validateEntries([...manifest.entries,manifest.entries[0]],origin), /Duplicate/);
    const progress=[];
    const options={entries:manifest.entries,directory:temp,origin,fetchFile:fetch,progress:p=>progress.push(p)};
    const first=await exportFiles(options);
    assert.equal(first.completed, 3);
    assert.equal(first.errors.length, 0);
    for(const entry of manifest.entries) assert.deepEqual(await fs.promises.readFile(path.join(first.directory,entry.relativePath)),bytes);
    assert.deepEqual(await fs.promises.readFile(source),bytes,'Source must remain unchanged');
    const second=await exportFiles(options);
    assert.notEqual(first.directory,second.directory);
    assert.ok(progress.at(-1).bytes >= bytes.length * 3);
    const bad = id=>({relativePath:'Batch/'+id+'.png',url:'/api/export_file?kind=image&id='+id,size:bytes.length});
    const failures=await exportFiles({...options,entries:[bad('broken'),bad('short'),manifest.entries[0]]});
    assert.equal(failures.completed,1);
    assert.equal(failures.errors.length,2);
    assert.deepEqual(await fs.promises.readdir(path.join(failures.directory,'Batch')),['Photo.png']);
    const controller = new AbortController();
    const cancelTimer = setTimeout(()=>controller.abort(),80);
    const canceled=await exportFiles({...options,entries:[bad('slow')],signal:controller.signal});
    clearTimeout(cancelTimer);
    assert.equal(canceled.canceled,true);
    assert.equal(canceled.completed,0);
    assert.equal(canceled.errors.length,0);
    assert.deepEqual(await fs.promises.readdir(path.join(canceled.directory,'Batch')),[]);
    const timeout=await exportFiles({...options,entries:[bad('slow')],timeoutMs:80});
    assert.equal(timeout.errors.length,1);
    assert.deepEqual(await fs.promises.readdir(path.join(timeout.directory,'Batch')),[]);
    assert.ok(renderer.includes('downloadToFolder({batch_ids:'));
    assert.ok(renderer.includes('downloadToFolder({video_ids:'));
    assert.ok(renderer.includes('downloadToFolder({image_ids:'));
    assert.ok(renderer.includes('downloadToFolder({asset_ids:'));
    const pkg = require('../package.json');
    assert.ok(pkg.build.files.includes('lan-client/folderExport.js'));
    console.log('Folder exports passed: original bytes, batch folders, permissions, streaming, names, cancellation, timeout, browser and IPC.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    const absolute = path.resolve(temp);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('tenying-folder-test-'));
    await fs.promises.rm(absolute,{recursive:true,force:true});
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});

