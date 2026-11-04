'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-drag-coordinates-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18785,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  let app;
  try {
    app=await electron.launch({executablePath:process.env.GLASS_TEST_PACKAGED || require('electron'),args:process.env.GLASS_TEST_PACKAGED?['--background']:[root,'--background'],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const main=await app.firstWindow();
    await main.waitForURL('http://127.0.0.1:18785/**',{timeout:30000});
    for(const kind of ['asset','prompt']) {
      await main.evaluate(kind=>window.libraryPanel.open(kind),kind);
      let page;
      for(let i=0;i<100 && !page;i++){page=app.windows().find(p=>p.url().includes('library='+kind));if(!page)await pause(100);}
      assert.ok(page,kind+' opens');
      await page.waitForSelector('.'+kind+'-library-drag-region',{state:'visible'});
      await app.evaluate(({BrowserWindow},kind)=>{
        const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind));
        win.setBounds({x:80,y:80,width:720,height:500});win.show();
        const original=win.setPosition.bind(win);win.__positions=[];
        win.setPosition=(x,y,...rest)=>{win.__positions.push({x,y});return original(x,y,...rest);};
      },kind);
      await pause(400);
      await page.evaluate(()=>window.libraryPanel.startWindowDrag({x:150,y:110}));
      for(let i=1;i<=35;i++) {
        await page.evaluate(i=>window.libraryPanel.moveWindowDrag({x:150+i*4,y:110+i*2}),i);
        await pause(12);
      }
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='active',{timeout:15000});
      await page.evaluate(()=>{window.libraryPanel.moveWindowDrag({x:290,y:180});window.libraryPanel.endWindowDrag();});
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='active',{timeout:15000});
      const result=await app.evaluate(({BrowserWindow},kind)=>{
        const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind));
        return {bounds:win.getBounds(),positions:win.__positions};
      },kind);
      assert.deepEqual(result.bounds,{x:220,y:150,width:720,height:500},kind+' must stop at the event position');
      assert.ok(result.positions.length>=20,kind+' must respond throughout the drag');
      assert.ok(result.positions.every((p,i,list)=>!i || (p.x>=list[i-1].x && p.y>=list[i-1].y)),kind+' must never jump backwards');
      await main.evaluate(()=>{window.libraryPanel.startWindowDrag({x:0,y:0});window.libraryPanel.moveWindowDrag({x:1000,y:1000});window.libraryPanel.endWindowDrag();});
      await pause(100);
      assert.deepEqual(await app.evaluate(({BrowserWindow},kind)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind)).getBounds(),kind),result.bounds,'Main window cannot move an independent window through drag IPC');
      await page.evaluate(()=>window.libraryPanel.hide());
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='idle',{timeout:15000});
      console.log(kind+' event coordinates: '+result.positions.length+' moves, no reversal or release jump');
    }
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-drag-coordinates-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
