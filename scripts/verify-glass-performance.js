'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const {PNG}=require('pngjs');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-glass-perf-'));
const data = path.join(temporary, 'runtime');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({port:18775, output_dir:path.join(temporary,'output'), asset_library_dir:path.join(temporary,'assets'), shortcuts_enabled:false, update_auto_check:false, public_enabled:false}));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let instance;
  try {
    instance = await electron.launch({executablePath:require('electron'), args:[root,'--background'], env:{...process.env, APPDATA:temporary, LOCALAPPDATA:temporary, LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const main = await instance.firstWindow();
    await main.waitForURL('http://127.0.0.1:18775/**');
    await instance.context().addInitScript(()=>{
      navigator.mediaDevices.getUserMedia=async()=>{
        const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;
        const context=canvas.getContext('2d');
        for(let x=0;x<960;x+=10){context.fillStyle=Math.floor(x/10)%2?'#4499ff':'#ee4444';context.fillRect(x,0,10,540);}
        return canvas.captureStream(60);
      };
    });
    await instance.evaluate(({desktopCapturer,nativeImage,screen,BrowserWindow}) => {
      // Use synthetic pixels instead of capturing the user's desktop during tests.
      const bitmap = Buffer.alloc(960*540*4);
      for(let y=0;y<540;y++) for(let x=0;x<960;x++) {
        const i=(y*960+x)*4, odd=Math.floor(x/10)%2;
        bitmap[i]=odd?255:68; bitmap[i+1]=odd?153:68; bitmap[i+2]=odd?68:238; bitmap[i+3]=255;
      }
      const thumbnail=nativeImage.createFromBitmap(bitmap,{width:960,height:540});
      global.__backdropMessages=[];
      desktopCapturer.getSources=async()=>[{id:'screen:999999:0',display_id:String(screen.getPrimaryDisplay().id),thumbnail}];
      const original=BrowserWindow.prototype.setShape;
      BrowserWindow.prototype.setShape=function(rects){this.__shape=rects;return original.call(this,rects);};
    });
    await main.evaluate(()=>window.libraryPanel.open('asset'));
    let asset;
    for(let i=0;i<100 && !asset;i++){asset=instance.windows().find(p=>p.url().includes('library=asset'));if(!asset)await pause(50);}
    await asset.waitForSelector('#assetLibraryWindow > .liquid-backdrop-static');
    await asset.waitForFunction(()=>document.querySelector('#assetLibraryWindow > .liquid-backdrop-static')?.style.getPropertyValue('--library-backdrop-image').startsWith('url('));
    await pause(600);
    await instance.evaluate(({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library=asset'));
      const original=win.webContents.send.bind(win.webContents);
      win.webContents.send=(channel,...args)=>{
        if(channel==='library:backdrop') global.__backdropMessages.push({bytes:Buffer.byteLength(JSON.stringify(args)),image:!!args[0]?.image});
        return original(channel,...args);
      };
    });
    await asset.evaluate(()=>{
      window.__perf={mounts:0,backgroundWrites:0,frames:[]};
      const observer=new MutationObserver(records=>{
        for(const record of records) for(const node of record.addedNodes) {
          if(node.nodeType===1) window.__perf.mounts+=(node.matches('.liquid-react-layer')?1:0)+node.querySelectorAll('.liquid-react-layer').length;
        }
      });
      observer.observe(document.body,{subtree:true,childList:true});
      const original=CSSStyleDeclaration.prototype.setProperty;
      const layerStyle=document.querySelector('#assetLibraryWindow > .liquid-backdrop-static').style;
      CSSStyleDeclaration.prototype.setProperty=function(name,...args){if(this===layerStyle && ['background-image','--library-backdrop-image'].includes(name)) window.__perf.backgroundWrites++;return original.call(this,name,...args);};
      let last=performance.now();
      const frame=now=>{window.__perf.frames.push(now-last);last=now;window.__perf.frame=requestAnimationFrame(frame);};
      window.__perf.frame=requestAnimationFrame(frame);
    });
    await asset.evaluate(()=>window.libraryPanel.startWindowDrag({x:window.screenX,y:window.screenY}));
    await instance.evaluate(async({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library=asset'));
      const start=win.getBounds();
      for(let i=0;i<60;i++) { win.setPosition(start.x+i%30,start.y+i%20); win.emit('move'); await new Promise(r=>setTimeout(r,8)); }
      win.emit('moved');
    });
    const whileMoving=await asset.evaluate(()=>({backgroundWrites:window.__perf.backgroundWrites}));
    const movingMessages=await instance.evaluate(()=>global.__backdropMessages.filter(m=>m.image).length);
    await asset.evaluate(()=>window.libraryPanel.endWindowDrag());
    await pause(500);
    await instance.evaluate(async({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library=asset'));
      for(let i=0;i<60;i++) { win.setSize(1000+i*3,620+i*2); await new Promise(r=>setTimeout(r,8)); }
    });
    await pause(400);
    const metrics=await asset.evaluate(()=>{
      cancelAnimationFrame(window.__perf.frame);
      const frames=window.__perf.frames.sort((a,b)=>a-b);
      const backdrop=document.querySelector('#assetLibraryWindow > .liquid-backdrop');
      const filter=getComputedStyle(backdrop,'::before').filter;
      return {mounts:window.__perf.mounts,backgroundWrites:window.__perf.backgroundWrites,frameP95:frames[Math.floor(frames.length*.95)],frames:frames.length,filter:filter==='none'?getComputedStyle(backdrop).backdropFilter:filter};
    });
    const native=await instance.evaluate(({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library=asset'));
      return {messages:global.__backdropMessages.length,bytes:global.__backdropMessages.filter(m=>!m.image).reduce((sum,m)=>sum+m.bytes,0),imageMessages:global.__backdropMessages.filter(m=>m.image).length,bounds:win.getBounds(),shape:win.__shape};
    });
    const result={...metrics,...native}; delete result.shape;
    console.log(JSON.stringify(result,null,2));
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    const label=process.env.GLASS_PERF_BASELINE ? 'before' : 'after';
    fs.writeFileSync(path.join(root,'test-results','glass-perf-'+label+'.json'),JSON.stringify(result,null,2));
    await asset.screenshot({path:path.join(root,'test-results','glass-perf-'+label+'.png')});
    if(!process.env.GLASS_PERF_BASELINE){
      assert.equal(movingMessages,0,'Moving must not retransmit the cached desktop image');
      assert.equal(whileMoving.backgroundWrites,0,'Moving must not reassign the cached desktop image');
      assert.ok(native.imageMessages<=1,'Release may refresh the cached desktop image once');
      assert.ok(metrics.backgroundWrites<=1,'Release may update the cached desktop image once');
      assert.ok(native.bytes<30000,'Movement IPC must stay bounded');
      assert.ok(metrics.mounts<=4,'Continuous resizing must coalesce glass component remounts');
      assert.doesNotMatch(metrics.filter,/url\(/,'Standalone glass must not run chromatic displacement across the full window');
      assert.equal(await asset.locator('#assetLibraryWindow feDisplacementMap').count(),0,'Standalone glass uses a neutral cached layer without RGB fringe filters');
      assert.ok(native.shape && !native.shape.some(r=>r.x===0 && r.y===0),'Native clipping remains rounded');
      const capture=async value=>{
        await asset.evaluate(value=>{const input=document.getElementById('liquidDisplacement');input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},value);
        await pause(200);
        return PNG.sync.read(await asset.screenshot());
      };
      const flat=await capture(0),refracted=await capture(150);
      let changed=0;
      for(let i=0;i<flat.data.length;i+=4) if(Math.abs(flat.data[i]-refracted.data[i])+Math.abs(flat.data[i+1]-refracted.data[i+1])+Math.abs(flat.data[i+2]-refracted.data[i+2])>20) changed++;
      assert.ok(changed<100,'Standalone neutral glass must ignore chromatic displacement changes');
      console.log('Standalone neutral glass changed pixels:',changed);
      await asset.reload();
      await asset.waitForFunction(()=>document.querySelector('#assetLibraryWindow > .liquid-backdrop-static')?.style.getPropertyValue('--library-backdrop-image').startsWith('url('));
    }
  } finally {
    if(instance) await instance.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-glass-perf-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
