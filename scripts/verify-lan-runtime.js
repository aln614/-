'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-lan-runtime-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18776,output_dir:path.join(temporary,'output'),shortcuts_enabled:false,update_auto_check:false,public_enabled:false}));
for(const name of ['tenying-ai-lan-client','TENYING_AI_LAN_Client']) {
  const clientProfile=path.join(temporary,name);
  fs.mkdirSync(clientProfile);
  fs.writeFileSync(path.join(clientProfile,'connection.json'),JSON.stringify({host_url:'http://127.0.0.1:18776',shortcuts_enabled:false,zoom_factor:1}));
}
const env={...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data};
(async()=>{
  let host,client,second;
  try {
    host=await electron.launch({executablePath:require('electron'),args:[root,'--background'],env});
    await (await host.firstWindow()).waitForURL('http://127.0.0.1:18776/**');
    const executablePath=process.env.LAN_TEST_PACKAGED || require('electron');
    const args=[...(process.env.LAN_TEST_PACKAGED ? [] : [path.join(root,'lan-client')]),`--user-data-dir=${path.join(temporary,'tenying-ai-lan-client')}`];
    client=await electron.launch({executablePath,args,env});
    const page=await client.firstWindow();page.setDefaultTimeout(15000);
    console.log('LAN test profile:',await client.evaluate(({app})=>app.getPath('userData')));
    await page.waitForURL('http://127.0.0.1:18776/**');
    await page.waitForFunction(()=>document.querySelector('.topbar feDisplacementMap'));
    await client.evaluate(async({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows()[0];
      for(let i=0;i<100 && !win.isVisible();i++) await new Promise(r=>setTimeout(r,50));
      if(!win.isVisible()) throw Error('Client did not finish showing');
    });
    assert.equal(await page.evaluate(()=>window.lanClient.getConfig().then(c=>c.client_version)),require('../lan-client/package.json').version);
    assert.ok(await page.locator('link[rel=stylesheet]').getAttribute('href').then(url=>url.includes(require('../package.json').version)),'The client loads the updated host renderer');
    await page.locator('#assetLibraryBtn').click();
    await page.locator('#assetLibraryLayer.active').waitFor();
    await page.locator('#closeAssetLibraryWindow').click();
    await page.locator('#promptLibraryBtn').click();
    await page.locator('#promptLibraryLayer.active').waitFor();
    await page.locator('#closePromptLibraryWindow').click();
    await page.evaluate(()=>document.dispatchEvent(new Event('scroll')));
    assert.ok(await page.evaluate(()=>document.documentElement.classList.contains('liquid-in-motion')));
    await page.waitForFunction(()=>!document.documentElement.classList.contains('liquid-in-motion'));
    assert.match(await page.locator('.topbar > .liquid-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter),/url\(/);
    console.log('Hide client:',await client.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.hide();return {visible:win.isVisible(),windows:BrowserWindow.getAllWindows().map(w=>w.webContents.getURL())};}));
    await page.waitForFunction(()=>!document.querySelector('.topbar .glass__warp'),null,{polling:100});
    second=spawn(executablePath,args,{env,windowsHide:true,stdio:'ignore'});
    const exit=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{second.kill();reject(Error('Duplicate client did not exit'));},10000);
      second.once('exit',code=>{clearTimeout(timer);resolve(code);});
      second.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    assert.equal(exit,0,'A duplicate launch exits');
    await page.waitForFunction(()=>!document.hidden && document.querySelector('.topbar .glass__warp'),null,{polling:100});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('.topbar feDisplacementMap'));
    assert.deepEqual(errors,[]);
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(root,'test-results','lan-client-performance.png')});
    console.log('LAN runtime passed: updated renderer, library buttons, lightweight scrolling, hidden-window suspension, duplicate launch and reload.');
  } finally {
    if(second && second.exitCode===null) second.kill();
    if(client) await client.close();
    if(host) await host.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-lan-runtime-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
