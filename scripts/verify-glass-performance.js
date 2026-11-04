'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const {PNG}=require('pngjs');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-glass-perf-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18775,output_dir:path.join(temporary,'output'),asset_library_dir:path.join(temporary,'assets'),shortcuts_enabled:false,update_auto_check:false,public_enabled:false}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  let app;
  try {
    const packaged=process.env.GLASS_TEST_PACKAGED;
    app=await electron.launch({executablePath:packaged || require('electron'),args:packaged?[]:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const main=await app.firstWindow();
    await main.waitForURL('http://127.0.0.1:18775/**',{timeout:30000});
    await main.waitForFunction(()=>window.localAppearance);
    await main.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=1000;
      const context=canvas.getContext('2d');
      for(let x=0;x<1600;x+=22) {context.fillStyle=Math.floor(x/22)%2?'#4499ff':'#ee9966';context.fillRect(x,0,22,1000);}
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      await window.localAppearance.importFile(new File([blob],'optics-test.png',{type:'image/png'}));
      window.libraryPanel.open('asset');
    });
    let page;
    for(let i=0;i<100 && !page;i++){page=app.windows().find(p=>p.url().includes('library=asset'));if(!page)await pause(50);}
    assert.ok(page);
    await page.waitForSelector('#assetLibraryWindow > .liquid-backdrop');
    await page.waitForFunction(()=>document.querySelector('.appearance-custom-media')?.naturalWidth>0 && document.querySelector('#assetLibraryWindow feDisplacementMap'));
    await pause(350);
    const filterBefore=await page.locator('#assetLibraryWindow > .liquid-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter);
    assert.match(filterBefore,/url\(/,'The library uses the actual upstream optical filter');
    const capture=async value=>{
      await page.evaluate(value=>{const input=document.getElementById('liquidDisplacement');input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},value);
      await page.waitForFunction(value=>document.querySelector('#assetLibraryWindow feDisplacementMap')?.getAttribute('scale')===String(-value),value);
      await pause(180);return PNG.sync.read(await page.screenshot());
    };
    const controlsBefore=await page.locator('#assetLibrarySearch').boundingBox();
    const flat=await capture(0),refracted=await capture(150);
    let changed=0;
    for(let i=0;i<flat.data.length;i+=4) if(Math.abs(flat.data[i]-refracted.data[i])+Math.abs(flat.data[i+1]-refracted.data[i+1])+Math.abs(flat.data[i+2]-refracted.data[i+2])>20) changed++;
    assert.ok(changed>200,'Refraction must visibly bend the custom background: '+changed);
    assert.deepEqual(await page.locator('#assetLibrarySearch').boundingBox(),controlsBefore,'Optical changes leave text and controls stationary');
    await page.evaluate(()=>{
      const grid=document.getElementById('assetGrid');
      grid.innerHTML=Array.from({length:1200},(_,i)=>'<article class="asset-card"><div class="asset-thumb"></div><div class="asset-info">Asset '+i+'</div></article>').join('');
      window.__glassPerf={mounts:0,frames:[]};
      new MutationObserver(records=>{
        for(const record of records) for(const node of record.addedNodes) if(node.nodeType===1) window.__glassPerf.mounts+=(node.matches('.liquid-react-layer')?1:0)+node.querySelectorAll('.liquid-react-layer').length;
      }).observe(document.body,{childList:true,subtree:true});
      let last=performance.now();
      const frame=now=>{window.__glassPerf.frames.push(now-last);last=now;window.__glassPerf.raf=requestAnimationFrame(frame);};
      window.__glassPerf.raf=requestAnimationFrame(frame);
    });
    await app.evaluate(async({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library=asset')),start=win.getBounds();
      for(let i=0;i<60;i++){win.setPosition(start.x+i%30,start.y+i%20);await new Promise(resolve=>setTimeout(resolve,8));}
      for(let i=0;i<60;i++){win.setSize(1000+i*3,620+i*2);await new Promise(resolve=>setTimeout(resolve,8));}
    });
    await pause(400);
    const metrics=await page.evaluate(()=>{
      cancelAnimationFrame(window.__glassPerf.raf);
      const frames=window.__glassPerf.frames.sort((a,b)=>a-b);
      return {mounts:window.__glassPerf.mounts,frameP95:frames[Math.floor(frames.length*.95)],frames:frames.length,filters:document.querySelectorAll('#assetLibraryWindow feDisplacementMap').length,desktopVideos:document.querySelectorAll('.library-live-backdrop').length};
    });
    assert.ok(metrics.mounts<=4,'Continuous resize must coalesce optical component remounts');
    assert.equal(metrics.filters,3,'One shared window surface contains the upstream chromatic passes');
    assert.equal(metrics.desktopVideos,0,'Native movement never records the desktop');
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    fs.writeFileSync(path.join(root,'test-results','glass-perf-after.json'),JSON.stringify({...metrics,changed},null,2));
    await page.screenshot({path:path.join(root,'test-results','glass-perf-after.png')});
    console.log('Standalone optics and performance:',JSON.stringify({...metrics,changed}));
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-glass-perf-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
