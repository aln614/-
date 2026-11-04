'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-main-drag-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18788,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  let app;
  try {
    app=await electron.launch({executablePath:process.env.GLASS_TEST_PACKAGED || require('electron'),args:process.env.GLASS_TEST_PACKAGED?[]:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const page=await app.firstWindow();
    await page.waitForURL('http://127.0.0.1:18788/**',{timeout:30000});
    await page.waitForFunction(()=>document.body.classList.contains('desktop-shell'));
    const bounds=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('library=')).getBounds());
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({x:80,y:80,width:1180,height:760}));
    await pause(250);
    const start=await bounds();
    await page.evaluate(()=>window.mainWindowControls.startDrag({x:180,y:110}));
    for(let i=1;i<=20;i++) {
      await page.evaluate(i=>window.mainWindowControls.moveDrag({x:180+i*5,y:110+i*3}),i);
      await pause(10);
    }
    await page.evaluate(()=>window.mainWindowControls.endDrag());
    await pause(100);
    assert.deepEqual(await bounds(),{...start,x:start.x+100,y:start.y+60},'Main window follows event coordinates');
    const released=await bounds();
    await page.evaluate(()=>window.mainWindowControls.moveDrag({x:900,y:900}));
    await pause(50);
    assert.deepEqual(await bounds(),released,'A released drag cannot keep moving');
    await page.evaluate(()=>{window.mainWindowControls.startDrag({x:0,y:0});window.mainWindowControls.moveDrag({x:Infinity,y:200});window.mainWindowControls.endDrag();});
    await pause(50);
    assert.deepEqual(await bounds(),released,'Non-finite drag points are rejected');
    await page.evaluate(()=>window.mainWindowControls.action('maximize'));
    await pause(120);
    const maximized=await bounds();
    await page.evaluate(point=>{window.mainWindowControls.startDrag(point);window.mainWindowControls.moveDrag({x:point.x+100,y:point.y+60});window.mainWindowControls.endDrag();},{x:maximized.x+180,y:maximized.y+30});
    await pause(120);
    assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized()),false,'Dragging restores a maximized window');
    assert.equal((await bounds()).width,released.width,'Restore-on-drag preserves the normal window width');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({x:80,y:80,width:1180,height:760}));
    const title=page.locator('.window-drag-region');
    await title.dblclick();
    await page.waitForFunction(()=>document.getElementById('mainWindowMaximize').classList.contains('is-maximized'));
    await title.dblclick();
    await page.waitForFunction(()=>!document.getElementById('mainWindowMaximize').classList.contains('is-maximized'));
    await page.locator('#announcementBtn').click();
    await page.waitForSelector('#announcementModal.show');
    await page.evaluate(()=>document.getElementById('announcementModal').classList.remove('show'));
    await page.locator('#mainWindowMaximize').click();
    await page.waitForFunction(()=>document.getElementById('mainWindowMaximize').classList.contains('is-maximized'));
    await page.locator('#mainWindowMaximize').click();
    await page.waitForFunction(()=>!document.getElementById('mainWindowMaximize').classList.contains('is-maximized'));
    const pointerStart=await bounds();
    const box=await title.boundingBox();
    const origin={x:pointerStart.x+box.x+100,y:pointerStart.y+box.y+box.height/2};
    await page.mouse.move(origin.x-pointerStart.x,origin.y-pointerStart.y);
    await page.mouse.down();
    for(let i=1;i<=12;i++) {
      const current=await bounds();
      await page.mouse.move(origin.x+i*5-current.x,origin.y+i*3-current.y);
      await pause(25);
    }
    await page.mouse.up();
    await pause(80);
    const pointerEnd=await bounds();
    assert.ok(Math.abs(pointerEnd.x-pointerStart.x-60)<=3 && Math.abs(pointerEnd.y-pointerStart.y-36)<=3,'Titlebar pointer events must move the window: '+JSON.stringify({pointerStart,pointerEnd}));
    await page.evaluate(()=>window.libraryPanel.open('asset'));
    let library;
    for(let i=0;i<100 && !library;i++){library=app.windows().find(p=>p.url().includes('library=asset'));if(!library)await pause(50);}
    await library.waitForSelector('#assetLibraryHead');
    const isolated=await bounds();
    await library.evaluate(()=>{window.mainWindowControls.startDrag({x:0,y:0});window.mainWindowControls.moveDrag({x:1000,y:1000});window.mainWindowControls.endDrag();});
    await pause(100);
    assert.deepEqual(await bounds(),isolated,'Independent libraries cannot move the main window through IPC');
    await library.evaluate(()=>window.libraryPanel.hide());
    console.log('Main titlebar: pointer movement, release, maximize/restore drag, double-click, button clicks and sender isolation passed.');
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-main-drag-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
