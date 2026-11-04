'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-main-glass-perf-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18777,output_dir:path.join(temporary,'output'),asset_library_dir:path.join(temporary,'assets'),shortcuts_enabled:false,update_auto_check:false,public_enabled:false}));
(async()=>{
 let app;
 try{
  app=await electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
  const page=await app.firstWindow();page.setDefaultTimeout(15000);
  await page.waitForURL('http://127.0.0.1:18777/**');
  await page.waitForFunction(()=>document.querySelector('.topbar feDisplacementMap'));
  const before=await page.evaluate(()=>({
    surfaces:document.querySelectorAll('[data-liquid-surface]').length,
    filters:document.querySelectorAll('feDisplacementMap').length,
    large:[...document.querySelectorAll('[data-liquid-surface]')].filter(el=>{const r=el.getBoundingClientRect();return r.width*r.height>150000}).length,
    selectors:[...document.querySelectorAll('[data-liquid-surface]')].map(el=>el.id||el.className).slice(0,40)
  }));
  await page.evaluate(()=>{
    window.__mainPerf={frames:[],longTasks:0,mounts:0};
    const observer=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1)window.__mainPerf.mounts+=(node.matches('.liquid-react-layer')?1:0)+node.querySelectorAll('.liquid-react-layer').length;});
    observer.observe(document.body,{childList:true,subtree:true});
    new PerformanceObserver(entries=>window.__mainPerf.longTasks+=entries.getEntries().length).observe({entryTypes:['longtask']});
    let last=performance.now();const frame=now=>{window.__mainPerf.frames.push(now-last);last=now;window.__mainPerf.raf=requestAnimationFrame(frame)};window.__mainPerf.raf=requestAnimationFrame(frame);
  });
  for(const target of ['history','images','video-manage','home','settings','home']){
    const nav=page.locator(`[data-page="${target}"]`);if(await nav.count()){await nav.click();await page.waitForTimeout(140);}
  }
  const main=page.locator('.main');
  for(let i=0;i<40;i++){await main.evaluate((el,i)=>el.scrollTop=i%2?el.scrollHeight:0,i);await page.waitForTimeout(10);}
  await page.waitForTimeout(350);
  const metrics=await page.evaluate(()=>{cancelAnimationFrame(window.__mainPerf.raf);const f=window.__mainPerf.frames.sort((a,b)=>a-b);return{frames:f.length,p95:f[Math.floor(f.length*.95)],p99:f[Math.floor(f.length*.99)],longTasks:window.__mainPerf.longTasks,mounts:window.__mainPerf.mounts,surfaces:document.querySelectorAll('[data-liquid-surface]').length,filters:document.querySelectorAll('feDisplacementMap').length};});
  const result={before,metrics};console.log(JSON.stringify(result,null,2));
  fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
  const label=process.env.MAIN_GLASS_BASELINE?'before':'after';fs.writeFileSync(path.join(root,'test-results','main-glass-perf-'+label+'.json'),JSON.stringify(result,null,2));
  await page.screenshot({path:path.join(root,'test-results','main-glass-perf-'+label+'.png')});
  if(!process.env.MAIN_GLASS_BASELINE){
    assert.ok(metrics.filters<=3,'One visible liquid-glass component uses three chromatic displacement passes');
    assert.ok(before.large<=4,'Main interface must limit large refracted surfaces');
    assert.ok(metrics.mounts<=4,'Page switching must not rebuild many glass components');
    assert.match(await page.locator('.topbar > .liquid-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter),/url\(/);
    assert.equal(await page.locator('#page-home .card').first().evaluate(el=>getComputedStyle(el).backgroundColor!=='rgba(0, 0, 0, 0)' || getComputedStyle(el).backgroundImage!=='none'),true,'Content cards keep a lightweight glass tint');
  }
 }finally{if(app)await app.close();const rel=path.relative(os.tmpdir(),temporary);if(!rel.startsWith('tenying-main-glass-perf-')||rel.includes(path.sep))throw Error('Unsafe cleanup');fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
