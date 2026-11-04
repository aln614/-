'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-native-drag-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18783,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function nativeDrag(start,end,hold=1100,repeat=1,steps=12,stepMilliseconds=30) {
  const resultPath=path.join(temporary,'mouse-'+Date.now()+'.json');
  const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'test-native-pointer.ps1'),'-StartX',String(start.x),'-StartY',String(start.y),'-EndX',String(end.x),'-EndY',String(end.y),'-HoldMilliseconds',String(hold),'-Repeat',String(repeat),'-Steps',String(steps),'-StepMilliseconds',String(stepMilliseconds),'-ResultPath',resultPath],{windowsHide:true});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  return new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(fs.readFileSync(resultPath,'utf8').replace(/^\uFEFF/,''))):reject(Error('Native mouse test failed: '+stderr)));});
}
(async()=>{
  if(process.platform!=='win32') {console.log('Native drag test is Windows-only');return;}
  let app;
  try {
    app=await electron.launch({executablePath:process.env.GLASS_TEST_PACKAGED || require('electron'),args:process.env.GLASS_TEST_PACKAGED?['--background']:[root,'--background'],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const main=await app.firstWindow();
    await main.waitForURL('http://127.0.0.1:18783/**',{timeout:30000});
    await app.evaluate(({BrowserWindow})=>{
      const original=BrowserWindow.prototype.setContentProtection;
      BrowserWindow.prototype.setContentProtection=function(value){this.__captureProtection=value;return original.call(this,value);};
    });
    for(const kind of ['asset','prompt']) {
      await main.evaluate(kind=>window.libraryPanel.open(kind),kind);
      let page;
      for(let i=0;i<100 && !page;i++){page=app.windows().find(p=>p.url().includes('library='+kind));if(!page)await pause(100);}
      assert.ok(page,kind+' window opens');
      const title=page.locator('.'+kind+'-library-drag-region');
      await title.waitFor({state:'visible'});
      await app.evaluate(({BrowserWindow,screen},kind)=>{
        const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind));
        const area=screen.getPrimaryDisplay().workArea;
        win.setBounds({x:area.x+80,y:area.y+80,width:720,height:500});
        win.setAlwaysOnTop(true);win.show();win.focus();win.moveTop();
      },kind);
      await pause(500);
      const box=await title.boundingBox();
      const displayOrigin=await app.evaluate(({screen})=>{const {x,y}=screen.getPrimaryDisplay().bounds;return {x,y};});
      await page.evaluate(origin=>{
        window.__motionSamples=[];window.__movingSamples=[];
        let lastX=null,lastY=null;
        function sample(){
          if(document.querySelector('.is-dragging') && document.body.dataset.libraryBackdropMotion==='active') {
            const layer=document.querySelector('.liquid-backdrop-static');
            const x=parseFloat(layer?.style.getPropertyValue('--library-backdrop-x'));
            const y=parseFloat(layer?.style.getPropertyValue('--library-backdrop-y'));
            if(Number.isFinite(x) && Number.isFinite(y)) {
              const error=Math.max(Math.abs(x+window.screenX-origin.x),Math.abs(y+window.screenY-origin.y));
              window.__motionSamples.push(error);
              if(lastX!==null && (lastX!==window.screenX || lastY!==window.screenY)) window.__movingSamples.push(error);
              lastX=window.screenX;lastY=window.screenY;
            }
          }
          window.__motionFrame=requestAnimationFrame(sample);
        }
        window.__motionFrame=requestAnimationFrame(sample);
      },displayOrigin);
      const before=await app.evaluate(({BrowserWindow},kind)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind)).getBounds(),kind);
      const points=await app.evaluate(({screen},p)=>({start:screen.dipToScreenPoint(p.start),end:screen.dipToScreenPoint(p.end)}),{start:{x:Math.round(before.x+box.x+Math.min(box.width/2,60)),y:Math.round(before.y+box.y+box.height/2)},end:{x:Math.round(before.x+box.x+Math.min(box.width/2,60)+110),y:Math.round(before.y+box.y+box.height/2+65)}});
      const dragging=nativeDrag(points.start,points.end,1100,1,36,20);
      await page.waitForSelector('.is-dragging',{timeout:15000});
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='active',{timeout:15000});
      await page.evaluate(()=>{
        const video=document.querySelector('.library-live-backdrop');
        window.__videoFrames={count:0,start:performance.now(),last:0};
        const frame=now=>{window.__videoFrames.count++;window.__videoFrames.last=now;if(video.isConnected)video.requestVideoFrameCallback(frame);};
        if(video?.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
      });
      await pause(900);
      assert.equal(await page.evaluate(()=>document.body.dataset.libraryBackdropMotion),'active',kind+' must keep the live backdrop running while the pointer is held');
      const during=await app.evaluate(({BrowserWindow},kind)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind));return {bounds:win.getBounds(),protected:win.__captureProtection};},kind);
      assert.ok(during.bounds.x>before.x+30 && during.bounds.y>before.y+20,kind+' must move with native pointer input');
      assert.equal(during.protected,true,kind+' must exclude itself from the desktop stream');
      const mouseSamples=await dragging;
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='active',{timeout:15000});
      const after=await app.evaluate(({BrowserWindow},kind)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind));return {bounds:win.getBounds(),protected:win.__captureProtection};},kind);
      const release=mouseSamples.at(-1);
      assert.ok(Math.abs(release.x-release.expectedX)<=2 && Math.abs(release.y-release.expectedY)<=2,kind+' native pointer was moved externally during the test: '+JSON.stringify(release));
      assert.ok(Math.abs(after.bounds.x-before.x-110)<=5 && Math.abs(after.bounds.y-before.y-65)<=5,kind+' must reach the dragged position: '+JSON.stringify({before,during,after,points,release}));
      assert.deepEqual(after.bounds,during.bounds,kind+' must not move after the pointer stops');
      assert.equal(after.protected,true,kind+' must keep itself excluded while its live backdrop is visible');
      assert.equal(await page.locator('.library-live-backdrop').count(),1,kind+' must keep dynamic wallpapers live after release');
      const motion=await page.evaluate(()=>{cancelAnimationFrame(window.__motionFrame);const values=window.__motionSamples.sort((a,b)=>a-b),moving=window.__movingSamples.sort((a,b)=>a-b),video=window.__videoFrames;return {frames:values.length,p95:values[Math.floor(values.length*.95)]||0,max:values.at(-1)||0,movingFrames:moving.length,movingP95:moving[Math.floor(moving.length*.95)]||0,videoFrames:video.count,videoFps:video.last>video.start?Math.round(1000*video.count/(video.last-video.start)):0};});
      assert.ok(motion.frames>5,kind+' must render multiple live frames during a drag');
      assert.ok(motion.p95<=3,kind+' backdrop position must track the window: '+JSON.stringify(motion));
      assert.ok(motion.movingFrames>=5 && motion.movingP95<=3,kind+' backdrop position must track moving frames: '+JSON.stringify(motion));
      console.log(kind+' native drag:',JSON.stringify({before,during:during.bounds,after:after.bounds,motion}));
      const again=await app.evaluate(({screen},p)=>({start:screen.dipToScreenPoint(p.start),end:screen.dipToScreenPoint(p.end)}),{start:{x:Math.round(after.bounds.x+box.x+Math.min(box.width/2,60)),y:Math.round(after.bounds.y+box.y+box.height/2)},end:{x:Math.round(after.bounds.x+box.x+Math.min(box.width/2,60)+50),y:Math.round(after.bounds.y+box.y+box.height/2+25)}});
      await nativeDrag(again.start,again.end,60,2);
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='active',{timeout:15000});
      const repeated=await app.evaluate(({BrowserWindow},kind)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind));return {bounds:win.getBounds(),protected:win.__captureProtection};},kind);
      assert.ok(repeated.bounds.x>=after.bounds.x+80,kind+' must support rapid consecutive drags');
      assert.equal(repeated.protected,true,kind+' must keep live capture stable through a rapid redrag');
      await main.evaluate(()=>{const input=document.getElementById('liquidEnabled');input.checked=false;input.dispatchEvent(new Event('change',{bubbles:true}));});
      await page.waitForFunction(()=>!document.body.classList.contains('liquid-glass-enabled'));
      const disabled=await app.evaluate(({screen},p)=>({start:screen.dipToScreenPoint(p.start),end:screen.dipToScreenPoint(p.end)}),{start:{x:Math.round(repeated.bounds.x+box.x+Math.min(box.width/2,60)),y:Math.round(repeated.bounds.y+box.y+box.height/2)},end:{x:Math.round(repeated.bounds.x+box.x+Math.min(box.width/2,60)+35),y:Math.round(repeated.bounds.y+box.y+box.height/2+20)}});
      await nativeDrag(disabled.start,disabled.end,100);
      const noGlass=await app.evaluate(({BrowserWindow},kind)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind));return {bounds:win.getBounds(),protected:win.__captureProtection};},kind);
      assert.ok(noGlass.bounds.x>=repeated.bounds.x+25,kind+' remains draggable with glass disabled');
      assert.equal(noGlass.protected,false,kind+' does not capture the desktop with glass disabled');
      assert.equal(await page.locator('.library-live-backdrop').count(),0);
      await main.evaluate(()=>{const input=document.getElementById('liquidEnabled');input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));});
      await page.waitForFunction(()=>document.body.classList.contains('liquid-glass-enabled'));
      console.log(kind+' rapid redrag and disabled-glass drag passed');
      const hiding=await app.evaluate(({screen},p)=>({start:screen.dipToScreenPoint(p.start),end:screen.dipToScreenPoint(p.end)}),{start:{x:Math.round(noGlass.bounds.x+box.x+Math.min(box.width/2,60)),y:Math.round(noGlass.bounds.y+box.y+box.height/2)},end:{x:Math.round(noGlass.bounds.x+box.x+Math.min(box.width/2,60)+35),y:Math.round(noGlass.bounds.y+box.y+box.height/2+20)}});
      const dragWhileHiding=nativeDrag(hiding.start,hiding.end,1300);
      await page.waitForFunction(()=>document.body.dataset.libraryBackdropMotion==='active',{timeout:15000});
      await app.evaluate(({BrowserWindow},kind)=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind));win.setAlwaysOnTop(false);win.hide();},kind);
      await dragWhileHiding;
      assert.equal(await page.locator('.library-live-backdrop').count(),0,kind+' releases the stream when hidden');
      assert.equal(await app.evaluate(({BrowserWindow},kind)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind)).__captureProtection,kind),false,kind+' restores capture when hidden');
      console.log(kind+' hidden-during-drag cleanup passed');
    }
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-native-drag-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
