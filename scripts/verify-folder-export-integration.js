'use strict';
// Optional end-to-end test. Supply Playwright through NODE_PATH; uses isolated data only.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {spawn} = require('child_process');
const {once} = require('events');
const {chromium, _electron} = require('playwright');
const repo = path.resolve(__dirname,'..');

async function run() {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(),'tenying-folder-e2e-'));
  const data = path.join(temp,'runtime'), output = path.join(temp,'output'), destination = path.join(temp,'download');
  for(const dir of [path.join(data,'data'),output,destination]) await fs.promises.mkdir(dir,{recursive:true});
  const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64');
  const file = path.join(output,'original.png');
  await fs.promises.writeFile(file,original);
  const today=new Date().toISOString();
  await fs.promises.writeFile(path.join(data,'config.json'),JSON.stringify({output_dir:output,asset_library_dir:path.join(temp,'assets'),lan_enabled:true,public_enabled:false,update_auto_check:false,device_data_isolation:false,api_key:'',apimart_api_key:'',legacy_output_dirs:[],mascot_enabled:false,background_keepalive:false}));
  await fs.promises.writeFile(path.join(data,'data','store.json'),JSON.stringify({
    batches:[{id:'fixture-batch',name:'Folder Download Test',note:'Original Files',owner_id:'local',created_at:today,status:'已完成',model:'seedream-5-0-pro',size:'1:1',task_count:1,success_count:1,fail_count:0}],
    images:[{id:'fixture-image',batch_id:'fixture-batch',owner_id:'local',file_path:file,created_at:today}],
    video_tasks:[], tasks:[], logs:[], nextLogId:1, prompt_groups:[],prompt_templates:[]
  }));
  const portServer=http.createServer();
  await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));
  const port=portServer.address().port;
  await new Promise(resolve=>portServer.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['src/docker-server.js'],{cwd:repo,windowsHide:true,env:{...process.env,PORT:String(port),LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data,LAIG_OUTPUT_DIR:output,LAIG_DOWNLOAD_DIR:destination,LAIG_ASSET_DIR:path.join(temp,'assets'),TMPDIR:temp},stdio:['ignore','pipe','pipe']});
  let log=''; child.stdout.on('data',chunk=>{log+=chunk;});child.stderr.on('data',chunk=>{log+=chunk;});
  let browser, electron;
  try {
    let ready=false;
    for(let i=0;i<100;i++) {
      if(child.exitCode!==null) throw new Error('Test server exited: '+log.slice(-3000));
      try { const health=await fetch(origin+'/api/health'); if(health.ok){ready=true;break;} } catch {}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(ready,'Server not ready: '+log.slice(-3000));
    const manifestResponse=await fetch(origin+'/api/export_manifest',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({batch_ids:['fixture-batch']})});
    const manifest=await manifestResponse.json();
    assert.equal(manifest.ok,true,JSON.stringify(manifest));
    assert.equal(manifest.entries.length,1);
    assert.equal(manifest.entries[0].relativePath,'Original Files/original.png');
    const download=await fetch(origin+manifest.entries[0].url);
    assert.equal(download.headers.get('cache-control'),'private, no-store');
    assert.match(download.headers.get('content-disposition'),/original.png/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()),original);
    const csrf=await fetch(origin+'/api/export_manifest',{method:'POST',headers:{Origin:'https://wrong.example','Content-Type':'application/json'},body:'{}'});
    assert.equal(csrf.status,403);

    browser=await chromium.launch({headless:true,channel:process.env.EXPORT_TEST_BROWSER || 'chrome'});
    const page=await browser.newPage({viewport:{width:1464,height:960}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>typeof downloadToFolder==='function'&&typeof setPage==='function');
    await page.evaluate(()=>setPage('history'));
    await page.getByRole('button',{name:'下载全部',exact:true}).first().waitFor();
    await page.evaluate(()=>{
      window.exportTestRows=[];
      window.folderExport={
        onProgress:callback=>{window.exportTestProgress=callback;return()=>{};},
        start:payload=>{window.exportTestRows=payload.entries;window.exportTestProgress({id:payload.id,completed:0,total:payload.entries.length});return new Promise(resolve=>window.exportTestComplete=resolve);},
        cancel:()=>window.exportTestComplete?.({canceled:true,completed:0})
      };
    });
    await page.getByRole('button',{name:'下载全部',exact:true}).first().click();
    await page.locator('.folder-download-status').waitFor();
    await page.waitForFunction(()=>window.exportTestRows.length===1);
    await page.screenshot({path:path.join(temp,'history-folder-download.png')});
    assert.equal(await page.locator('.folder-download-status').innerText().then(x=>x.includes('0 / 1')),true);
    await page.evaluate(()=>window.exportTestComplete({completed:1}));
    await page.locator('.folder-download-status').waitFor({state:'detached'});
    await page.evaluate(()=>{ window.exportTestRows=[]; window.exportTestComplete=null; });
    await page.locator('.history-batch-check').first().check();
    await page.locator('#downloadSelectedBatchesBtn').click();
    await page.locator('.folder-download-status').waitFor();
    await page.waitForFunction(()=>window.exportTestRows.length===1);
    await page.evaluate(()=>window.exportTestComplete({completed:1}));
    await page.locator('.folder-download-status').waitFor({state:'detached'});
    await page.evaluate(()=>setPage('video'));
    await page.locator('#videoModel').selectOption('wan3.0-video-prime');
    assert.equal(await page.locator('#videoResolution').inputValue(),'1080P');
    await page.locator('#videoModel').selectOption('MiniMax-H3-Max');
    assert.ok((await page.locator('#videoResolution option').allTextContents()).some(s=>s.toUpperCase().includes('1080')));
    await page.screenshot({path:path.join(temp,'video-model-update.png')});
    assert.deepEqual(errors,[],'Renderer exceptions');
    await browser.close();browser=null;

    electron=await _electron.launch({executablePath:require('electron'),args:[path.join(repo,'scripts/fixtures/folder-export-electron.js')],env:{...process.env,EXPORT_TEST_ORIGIN:origin,EXPORT_TEST_DESTINATION:destination,EXPORT_TEST_PROFILE:path.join(temp,'electron')}});
    const nativePage=await electron.firstWindow();
    await nativePage.waitForFunction(()=>!!window.folderExport);
    const native=await nativePage.evaluate(entries=>window.folderExport.start({id:'native-test',entries}),manifest.entries);
    assert.equal(native.completed,1,JSON.stringify(native));
    assert.deepEqual(await fs.promises.readFile(path.join(native.directory,manifest.entries[0].relativePath)),original);
    await electron.close();electron=null;
    console.log('Folder end-to-end passed: real routes, CSRF, history click/progress, model controls, native Electron IPC + session.fetch.');
    console.log('Screenshots: '+temp);
  } finally {
    if(browser)await browser.close().catch(()=>{});
    if(electron)await electron.close().catch(()=>{});
    if(child.exitCode===null){child.kill();await once(child,'exit');}
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
