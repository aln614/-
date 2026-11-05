'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-visible-glass-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18791,lan_enabled:false,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  let app;
  try {
    const packaged=process.env.GLASS_TEST_PACKAGED;
    app=await electron.launch({executablePath:packaged || require('electron'),args:packaged?[]:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const main=await app.firstWindow();
    await main.waitForURL('http://127.0.0.1:18791/**',{timeout:30000});
    await main.waitForFunction(()=>window.localAppearance && window.desktopAppearance);
    await app.evaluate(async({BrowserWindow,desktopCapturer,screen})=>{
      global.__applicationScreenCaptures=0;global.__protectionCalls=[];
      global.__captureTestScreen=desktopCapturer.getSources.bind(desktopCapturer);
      desktopCapturer.getSources=(...args)=>{global.__applicationScreenCaptures++;return global.__captureTestScreen(...args);};
      const original=BrowserWindow.prototype.setContentProtection;
      BrowserWindow.prototype.setContentProtection=function(enabled){global.__protectionCalls.push(enabled);return original.call(this,enabled);};
      const area=screen.getPrimaryDisplay().workArea;
      const background=new BrowserWindow({x:area.x,y:area.y,width:area.width,height:area.height,frame:false,alwaysOnTop:true,skipTaskbar:true,backgroundColor:'#3060c0'});
      await background.loadURL('data:text/html,'+encodeURIComponent('<style>html,body{margin:0;width:100%;height:100%;background:rgb(48,96,192)}body.green{background:rgb(25,190,80)}</style>'));
      background.show();global.__visibleGlassBackground=background;
    });
    for(const kind of ['main','asset','prompt']) {
      let page=main;
      if(kind!=='main') {
        await main.evaluate(kind=>window.libraryPanel.open(kind),kind);
        for(let attempt=0;attempt<100;attempt++) {page=app.windows().find(item=>item.url().includes('library='+kind));if(page) break;await pause(50);}
      }
      assert.ok(page,kind+' opens');
      await page.waitForFunction(()=>window.localAppearance && window.desktopAppearance);
      await page.evaluate(()=>{window.localAppearance.setTheme('light');window.localAppearance.setMode('none');});
      await page.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='acrylic');
      await app.evaluate(({BrowserWindow,screen},kind)=>{
        const win=BrowserWindow.getAllWindows().find(item=>kind==='main' ? item.webContents.getURL().startsWith('http://127.0.0.1:18791/') && !item.webContents.getURL().includes('library=') : item.webContents.getURL().includes('library='+kind));
        const area=screen.getPrimaryDisplay().workArea;
        win.setBounds({x:area.x+80,y:area.y+70,width:kind==='main'?1180:720,height:kind==='main'?760:500});
        win.setAlwaysOnTop(true);win.show();win.focus();win.moveTop();
        global.__visibleGlassWindow=win;
      },kind);
      await page.evaluate(()=>{
        const marker=document.createElement('div');marker.id='captureVisibilityMarker';
        marker.style.cssText='position:fixed;left:110px;top:110px;width:80px;height:60px;background:rgb(243,37,211);z-index:2147483647;pointer-events:none';
        document.body.appendChild(marker);
      });
      const sample=()=>app.evaluate(async({screen})=>{
        const win=global.__visibleGlassWindow,display=screen.getDisplayMatching(win.getBounds()),bounds=win.getBounds();
        const sources=await global.__captureTestScreen({types:['screen'],thumbnailSize:{width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)}});
        const source=sources.find(item=>item.display_id===String(display.id)),size=source.thumbnail.getSize(),bitmap=source.thumbnail.toBitmap();
        const scale=size.width/display.bounds.width;
        const pixel=(x,y)=>{const offset=(Math.round((bounds.y-display.bounds.y+y)*scale)*size.width+Math.round((bounds.x-display.bounds.x+x)*scale))*4;return [bitmap[offset+2],bitmap[offset+1],bitmap[offset]];};
        return {marker:pixel(145,135),desktop:pixel(bounds.width-5,bounds.height/2),outside:pixel(-10,-10),corners:[pixel(0,0),pixel(bounds.width-1,0),pixel(0,bounds.height-1),pixel(bounds.width-1,bounds.height-1)],bounds};
      });
      await app.evaluate(()=>global.__visibleGlassBackground.webContents.executeJavaScript("document.body.className=''"));
      await pause(1000);const before=await sample();
      for(const corner of before.corners) {
        const ratios=corner.map((value,i)=>value/Math.max(1,before.outside[i]));
        // DWM's rounded shadow may dim the backdrop, but must not replace it with acrylic gray.
        assert.ok(Math.min(...ratios)>.65 && Math.max(...ratios)-Math.min(...ratios)<.10,kind+' must clip native acrylic at every corner: '+JSON.stringify(before));
      }
      assert.ok(before.marker[0]>before.marker[1]*3 && before.marker[2]>before.marker[1]*3 && before.marker[0]>50 && before.marker[2]>40,kind+' remains visible to screen sharing even when the OS dims the screen: '+JSON.stringify(before));
      await app.evaluate(()=>global.__visibleGlassBackground.webContents.executeJavaScript("document.body.className='green'"));
      await pause(1000);const after=await sample();
      console.log(kind+' screen visibility:',JSON.stringify({before:before.marker,after:after.marker,desktopBefore:before.desktop,desktopAfter:after.desktop}));
      assert.ok(after.desktop.reduce((sum,value,index)=>sum+Math.abs(value-before.desktop[index]),0)>8,kind+' backdrop updates without screen capture');
      assert.equal(await page.locator('.library-live-backdrop').count(),0,kind+' has no desktop video loop');
      await page.evaluate(()=>{document.getElementById('captureVisibilityMarker').remove();window.localAppearance.setMode('board');});
      await page.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='none');
      await page.evaluate(()=>window.localAppearance.setMode('none'));
      await page.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='acrylic');
      await app.evaluate(()=>{global.__visibleGlassWindow.setAlwaysOnTop(false);global.__visibleGlassWindow.hide();});
    }
    const instrumentation=await app.evaluate(()=>({captures:global.__applicationScreenCaptures,protection:global.__protectionCalls}));
    assert.equal(instrumentation.captures,0,'Application never records the desktop');
    assert.ok(instrumentation.protection.length>=3 && instrumentation.protection.every(value=>value===false),'Appearance changes never exclude the window from sharing');
    console.log('Main/asset/prompt windows: rounded native blur, live backdrop updates, screen sharing and zero application desktop capture passed.');
    await app.evaluate(()=>global.__visibleGlassBackground.destroy());
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-visible-glass-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
