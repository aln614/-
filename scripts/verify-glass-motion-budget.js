'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-motion-budget-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18786,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  let app;
  try {
    app=await electron.launch({executablePath:process.env.GLASS_TEST_PACKAGED || require('electron'),args:process.env.GLASS_TEST_PACKAGED?['--background']:[root,'--background'],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const main=await app.firstWindow();
    await main.waitForURL('http://127.0.0.1:18786/**',{timeout:30000});
    await main.evaluate(()=>window.libraryPanel.open('asset'));
    let page;
    for(let i=0;i<100 && !page;i++){page=app.windows().find(p=>p.url().includes('library=asset'));if(!page)await pause(100);}
    await page.waitForSelector('#assetLibraryWindow > .liquid-backdrop');
    await page.evaluate(()=>{
      const grid=document.getElementById('assetGrid');
      grid.innerHTML=Array.from({length:1200},(_,i)=>'<article class="asset-card"><div class="asset-thumb"></div><div class="asset-info">Asset '+i+'</div></article>').join('');
    });
    await pause(400);
    const metrics=await page.evaluate(async()=>{
      let fullScans=0,styleReads=0;
      const query=Element.prototype.querySelectorAll,style=window.getComputedStyle;
      Element.prototype.querySelectorAll=function(selector){if(this===document.body && selector.includes('.topbar'))fullScans++;return query.call(this,selector);};
      window.getComputedStyle=function(...args){styleReads++;return style.apply(this,args);};
      const frames=[];
      let last=performance.now();
      for(let i=0;i<90;i++) {
        await new Promise(resolve=>requestAnimationFrame(now=>{frames.push(now-last);last=now;resolve();}));
        document.getElementById('assetGrid').scrollTop=i*12;
      }
      await new Promise(resolve=>requestAnimationFrame(resolve));
      Element.prototype.querySelectorAll=query;window.getComputedStyle=style;
      frames.sort((a,b)=>a-b);
      return {assets:1200,frames:frames.length,fullScans,styleReads,p95:frames[Math.floor(frames.length*.95)],max:frames.at(-1)};
    });
    console.log('Glass motion budget:',JSON.stringify(metrics));
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    fs.writeFileSync(path.join(root,'test-results','glass-motion-budget-'+(process.argv.includes('--baseline')?'before':'after')+'.json'),JSON.stringify(metrics,null,2));
    if(!process.argv.includes('--baseline')) {
      assert.equal(metrics.fullScans,0,'Backdrop motion must not rescan the full application DOM');
      assert.ok(metrics.styleReads<100,'Backdrop motion must not repeatedly measure glass hosts');
      assert.equal(await page.locator('.library-live-backdrop').count(),0,'Scrolling must not record the desktop');
    }
    await page.evaluate(()=>window.libraryPanel.hide());
    await main.evaluate(()=>window.libraryPanel.open('asset'));
    await page.waitForSelector('#assetLibraryWindow > .liquid-backdrop');
    console.log('Independent glass resumes correctly after hiding and reopening.');
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-motion-budget-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
