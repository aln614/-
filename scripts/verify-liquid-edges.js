'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {PNG}=require('pngjs');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-glass-edges-'));
const data=path.join(temporary,'runtime'),results=path.join(root,'test-results');
fs.mkdirSync(data);fs.mkdirSync(results,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18796,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
const pause=page=>page.waitForTimeout(500);
const rgba=(image,x,y)=>{const i=(Math.round(y)*image.width+Math.round(x))*4;return [...image.data.subarray(i,i+4)];};
const distance=(a,b)=>a.reduce((n,v,i)=>n+Math.abs(v-b[i]),0);
(async()=>{
  let app;
  try {
    const packaged=process.env.GLASS_TEST_PACKAGED;
    app=await electron.launch({executablePath:packaged||require('electron'),args:packaged?[]:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const page=await app.firstWindow();
    await page.waitForURL('http://127.0.0.1:18796/**',{timeout:30000});
    await page.waitForFunction(()=>window.localAppearance && window.liquidGlassSettings && document.querySelector('#sidebar feDisplacementMap'));
    await page.evaluate(()=>{window.localAppearance.setTheme('light');window.localAppearance.setMode('none');});
    await page.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='acrylic');
    await page.addStyleTag({content:`
      #localAppearanceBackground {background:rgb(209,218,227)!important}
      .app-shell {background:transparent!important;box-shadow:none!important}
      [data-edge-check] {box-shadow:none!important;transition:none!important}
      [data-edge-check]::after {content:none!important}
      [data-edge-check] > .liquid-backdrop {box-shadow:none!important}
      [data-edge-check] > :not(.liquid-backdrop):not(.liquid-glass-mount) {visibility:hidden!important}
      #sidebar.test-expanded {width:208px!important}
    `});
    const surfaces=['#sidebar','.topbar','#page-home .card:first-child','.right-panel','#themePopover'];
    await page.locator('#themeCycleBtn').click();await pause(page);
    for(const selector of surfaces) {
      const el=page.locator(selector).first();
      await el.evaluate(e=>e.setAttribute('data-edge-check',''));
      const rounds=selector==='#sidebar'?[false,true]:[false];
      for(const expanded of rounds) {
        await el.evaluate((e,value)=>e.classList.toggle('test-expanded',value),expanded);
        await pause(page);
        const geometry=await el.evaluate(e=>{
          const r=e.getBoundingClientRect(),s=getComputedStyle(e),back=e.querySelector(':scope>.liquid-backdrop'),mount=e.querySelector(':scope>.liquid-glass-mount');
          return {x:r.x,y:r.y,width:r.width,height:r.height,radius:parseFloat(s.borderTopLeftRadius),backClip:getComputedStyle(back).clipPath,mountClip:getComputedStyle(mount).clipPath};
        });
        assert.match(geometry.backClip,/round/);assert.match(geometry.mountClip,/round/);
        const rendered=PNG.sync.read(await page.screenshot());
        await el.evaluate(e=>e.style.setProperty('visibility','hidden','important'));
        await pause(page);
        const baseline=PNG.sync.read(await page.screenshot());
        await el.evaluate(e=>e.style.removeProperty('visibility'));
        const x=geometry.x,y=geometry.y,w=geometry.width,h=geometry.height;
        for(const [px,py] of [[x+1,y+1],[x+w-2,y+1],[x+1,y+h-2],[x+w-2,y+h-2]]) {
          const delta=distance(rgba(rendered,px,py),rgba(baseline,px,py));
          assert.ok(delta<55,selector+' corner leaks a square layer: '+JSON.stringify({expanded,px,py,delta}));
        }
        if(selector==='#sidebar' && expanded) fs.writeFileSync(path.join(results,'glass-edge-expanded.png'),PNG.sync.write(rendered));
      }
      await el.evaluate(e=>{e.removeAttribute('data-edge-check');e.classList.remove('test-expanded');});
    }
    const quick=page.locator('[data-liquid-quick="blurAmount"]');
    const custom=page.locator('#themePopover [data-background-blur]');
    assert.equal(await custom.isDisabled(),true,'Desktop mode does not pretend to adjust the custom image blur');
    assert.equal(await page.locator('[data-native-blur-note]').isVisible(),true);
    await page.evaluate(()=>{
      const fixture=document.createElement('div');fixture.id='blurOpticsFixture';
      fixture.style.cssText='position:fixed;inset:0;z-index:0;pointer-events:none;background:repeating-linear-gradient(90deg,#eecc77 0px,#eecc77 12px,#7799cc 12px,#7799cc 24px)';
      document.body.prepend(fixture);
    });
    await quick.fill('0');await pause(page);
    const low=await page.locator('#themePopover>.liquid-backdrop').evaluate(e=>getComputedStyle(e).backdropFilter);
    const lowImage=PNG.sync.read(await page.locator('#themePopover').screenshot());
    await quick.fill('1');await pause(page);
    const high=await page.locator('#themePopover>.liquid-backdrop').evaluate(e=>getComputedStyle(e).backdropFilter);
    const highImage=PNG.sync.read(await page.locator('#themePopover').screenshot());
    let changed=0;
    for(let i=0;i<lowImage.data.length;i+=4)
      if(distance(lowImage.data.subarray(i,i+3),highImage.data.subarray(i,i+3))>15) changed++;
    assert.ok(changed>100,'Glass blur must change rendered pixels: '+changed);
    assert.match(low,/blur\(4px\)/);assert.match(high,/blur\(36px\)/);
    assert.equal(await page.locator('#liquidBlur').inputValue(),'1','Quick control synchronizes with settings');
    await page.evaluate(()=>window.localAppearance.setMode('board'));
    assert.equal(await custom.isDisabled(),true);
    assert.equal(await page.locator('[data-native-blur-note]').isVisible(),false);
    console.log('Rounded glass corners and independent background/glass controls passed.');
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-glass-edges-')||relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
