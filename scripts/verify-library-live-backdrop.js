'use strict';
// Validate native transparent windows against a locally controlled backdrop.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-library-live-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18782,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  let app;
  try {
    app=await electron.launch({executablePath:process.env.GLASS_TEST_PACKAGED || require('electron'),args:process.env.GLASS_TEST_PACKAGED?['--background']:[root,'--background'],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const main=await app.firstWindow();
    await main.waitForURL('http://127.0.0.1:18782/**',{timeout:30000});
    await main.waitForFunction(()=>window.localAppearance);
    await main.evaluate(()=>window.localAppearance.setMode('none'));
    await app.evaluate(async({BrowserWindow,screen})=>{
      const area=screen.getPrimaryDisplay().workArea;
      const background=new BrowserWindow({x:area.x+30,y:area.y+30,width:1100,height:800,frame:false,alwaysOnTop:true,skipTaskbar:true,backgroundColor:'#3060c0'});
      await background.loadURL('data:text/html,'+encodeURIComponent('<style>html,body{margin:0;width:100%;height:100%;background:rgb(48,96,192)}body.green{background:rgb(25,190,80)}</style>'));
      background.show();global.__libraryTestBackground=background;
    });
    for(const kind of ['main','asset','prompt']){
      await app.evaluate(()=>global.__libraryTestBackground.webContents.executeJavaScript("document.body.className=''"));
      if(kind!=='main') await main.evaluate(kind=>window.libraryPanel.open(kind),kind);
      let page=kind==='main' ? main : null;
      for(let attempt=0;attempt<100 && !page;attempt++){page=app.windows().find(item=>item.url().includes('library='+kind));if(!page)await pause(100);}
      assert.ok(page,kind+' window opens');
      await page.waitForSelector(kind==='main' ? '#desktopLiveBackdrop' : '#'+kind+'LibraryWindow > .liquid-backdrop-static',{timeout:15000});
      await app.evaluate(({BrowserWindow,screen},kind)=>{
        const win=BrowserWindow.getAllWindows().find(item=>kind==='main' ? item.webContents.getURL().startsWith('http://127.0.0.1:18782/') && !item.webContents.getURL().includes('library=') : item.webContents.getURL().includes('library='+kind));
        const area=screen.getPrimaryDisplay().workArea;
        win.setBounds({x:area.x+90,y:area.y+90,width:kind==='main'?1180:720,height:kind==='main'?760:500});
        win.setAlwaysOnTop(true);win.show();win.focus();win.moveTop();
      },kind);
      await pause(500);
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='active',{timeout:15000});
      const readPixel=()=>page.evaluate(()=>{
        const video=document.querySelector('.library-live-backdrop');
        const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
        const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(video,0,0);
        const rect=video.getBoundingClientRect();
        const x=Math.round((120-rect.left)/rect.width*canvas.width),y=Math.round((120-rect.top)/rect.height*canvas.height);
        return {pixel:Array.from(context.getImageData(x,y,1,1).data).slice(0,3),trackId:video.srcObject.getVideoTracks()[0].id,settings:video.srcObject.getVideoTracks()[0].getSettings()};
      });
      const before=await readPixel();
      await app.evaluate(()=>global.__libraryTestBackground.webContents.executeJavaScript("document.body.className='green'"));
      await page.waitForTimeout(450);
      const after=await readPixel();
      assert.ok(after.pixel[1]>before.pixel[1]+30,kind+' live video must follow changes behind the window: '+JSON.stringify({before,after}));
      assert.ok(before.pixel[2]>before.pixel[0]+30,kind+' video must exclude its own window: '+JSON.stringify(before));
      assert.ok(after.settings.frameRate>=15,kind+' video must have a usable frame rate');
      await app.evaluate(({BrowserWindow},kind)=>{
        const win=BrowserWindow.getAllWindows().find(item=>kind==='main' ? item.webContents.getURL().startsWith('http://127.0.0.1:18782/') && !item.webContents.getURL().includes('library=') : item.webContents.getURL().includes('library='+kind));
        win.emit('moved');
      },kind);
      await pause(700);
      assert.equal(await page.evaluate(()=>document.body.dataset.libraryBackdropMotion),'active',kind+' must remain live after movement stops');
      await app.evaluate(()=>global.__libraryTestBackground.webContents.executeJavaScript("document.body.className=''"));
      await pause(450);
      const stationary=await readPixel();
      assert.ok(stationary.pixel[2]>stationary.pixel[1]+30,kind+' must show changing wallpaper while stationary: '+JSON.stringify(stationary));
      assert.equal(stationary.trackId,before.trackId,kind+' must keep the same stream after release');
      console.log(kind+' live while stationary:',JSON.stringify({before:before.pixel,after:after.pixel,stationary:stationary.pixel,fps:after.settings.frameRate}));
      await app.evaluate(({BrowserWindow},kind)=>BrowserWindow.getAllWindows().find(item=>kind==='main' ? item.webContents.getURL().startsWith('http://127.0.0.1:18782/') && !item.webContents.getURL().includes('library=') : item.webContents.getURL().includes('library='+kind)).minimize(),kind);
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='idle',{timeout:15000});
      assert.equal(await page.locator('.library-live-backdrop').count(),0,kind+' must release screen tracks while minimized');
      await app.evaluate(({BrowserWindow},kind)=>BrowserWindow.getAllWindows().find(item=>kind==='main' ? item.webContents.getURL().startsWith('http://127.0.0.1:18782/') && !item.webContents.getURL().includes('library=') : item.webContents.getURL().includes('library='+kind)).restore(),kind);
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='active',{timeout:15000});
      assert.notEqual((await readPixel()).trackId,before.trackId,kind+' must start a new stream after restore');
      await page.reload();
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='active',{timeout:15000});
      await app.evaluate(()=>global.__libraryTestBackground.webContents.executeJavaScript("document.body.className='green'"));
      await pause(450);
      assert.ok((await readPixel()).pixel[1]>130,kind+' must keep the backdrop attached after reloading');
      await app.evaluate(({BrowserWindow},kind)=>{
        const win=BrowserWindow.getAllWindows().find(item=>kind==='main' ? item.webContents.getURL().startsWith('http://127.0.0.1:18782/') && !item.webContents.getURL().includes('library=') : item.webContents.getURL().includes('library='+kind));
        win.setAlwaysOnTop(false);win.hide();
      },kind);
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='idle',{timeout:15000});
      assert.equal(await page.locator('.library-live-backdrop').count(),0,kind+' must release screen tracks while hidden');
      console.log(kind+' minimize/restore/reload/hide lifecycle passed');
    }
    await app.evaluate(()=>global.__libraryTestBackground.destroy());
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-library-live-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
