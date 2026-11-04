'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {PNG}=require('pngjs');
const {normalizeLiquidGlass}=require('../src/services/liquidGlassSettings');
assert.deepEqual(normalizeLiquidGlass({displacementScale:-200,blurAmount:7,saturation:'not-a-number',surfaceOpacity:0}),{enabled:true,displacementScale:0,blurAmount:1,saturation:140,aberrationIntensity:2,surfaceOpacity:.15});
const { _electron:electron }=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-glass-test-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18769,output_dir:path.join(temporary,'output'),asset_library_dir:path.join(temporary,'assets'),update_auto_check:false,public_enabled:false,shortcuts_enabled:false}));
(async()=>{
  let instance;
  try {
    const packaged=process.env.GLASS_TEST_PACKAGED;
    instance=await electron.launch({executablePath:packaged || require('electron'),args:packaged ? [] : [root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const main=await instance.firstWindow();
    main.setDefaultTimeout(15000);
    await main.waitForURL('http://127.0.0.1:18769/**',{timeout:30000});
    await main.waitForFunction(()=>window.liquidGlassSettings && document.querySelector('.topbar feDisplacementMap'));
    assert.equal(await main.locator('.sidebar > .liquid-backdrop').count(),1,'Sidebar uses one bounded liquid surface');
    assert.equal(await main.locator('#page-home > .grid > .card > .liquid-backdrop').count(),0,'Main cards avoid whole-card displacement filters');
    assert.equal(await main.locator('#page-home .liquid-backdrop').count(),0,'Home controls avoid nested displacement filters');
    assert.ok(await main.locator('[data-liquid-surface]').count()<=12,'The main page keeps a bounded number of liquid surfaces');
    assert.notEqual(await main.locator('#page-home > .grid > .card').first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','Main content keeps a readable material fill');
    await main.locator('[data-page="settings"]').click();
    await main.mouse.move(1000,120);
    await main.waitForTimeout(300);
    await main.locator('#liquidEnabled').scrollIntoViewIfNeeded();
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await main.screenshot({path:path.join(root,'test-results','liquid-glass-settings.png')});
    assert.match(await main.locator('.topbar > .liquid-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter),/url\(/);
    await main.evaluate(()=>{
      document.getElementById('localAppearanceBackground').style.setProperty('background','repeating-linear-gradient(90deg,#eecc77 0px,#eecc77 18px,#7799cc 18px,#7799cc 36px)','important');
      const slider=document.getElementById('liquidDisplacement');slider.value='0';slider.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await main.waitForFunction(()=>document.querySelector('.topbar feDisplacementMap')?.getAttribute('scale')==='0');
    await main.waitForTimeout(400);
    const undistorted=PNG.sync.read(await main.locator('.topbar').screenshot());
    await main.evaluate(()=>{const slider=document.getElementById('liquidDisplacement');slider.value='150';slider.dispatchEvent(new Event('input',{bubbles:true}));});
    await main.waitForFunction(()=>document.querySelector('.topbar feDisplacementMap')?.getAttribute('scale')==='-150');
    await main.waitForTimeout(400);
    const distorted=PNG.sync.read(await main.locator('.topbar').screenshot());
    let changed=0;
    for(let i=0;i<undistorted.data.length;i+=4) if(Math.abs(undistorted.data[i]-distorted.data[i])+Math.abs(undistorted.data[i+1]-distorted.data[i+1])+Math.abs(undistorted.data[i+2]-distorted.data[i+2])>15) changed++;
    assert.ok(changed>100,'Changing refraction must change rendered background pixels, not only SVG attributes');
    console.log('Changed refraction pixels:',changed);
    await main.evaluate(()=>document.getElementById('localAppearanceBackground').style.removeProperty('background'));
    for(const mode of ['light','dark']) {
      const state=await main.evaluate(mode=>{
        window.localAppearance.setTheme(mode);
        const header=document.querySelector('.topbar');
        return {background:getComputedStyle(header).backgroundColor,glass:getComputedStyle(header.querySelector('.liquid-backdrop')).backgroundColor};
      },mode);
      assert.equal(state.background,'rgba(0, 0, 0, 0)',mode+' mode must not hide the glass');
      assert.notEqual(state.glass,'rgba(0, 0, 0, 0)',mode+' mode has a visible glass tint');
    }
    const preview=await main.evaluate(async()=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=220;
      const context=canvas.getContext('2d');context.fillStyle='#177a7e';context.fillRect(0,0,320,220);context.fillStyle='#ecb268';context.fillRect(40,30,90,130);
      await showPreview(canvas.toDataURL(),'');
      return document.querySelector('#previewModal').classList.contains('active');
    });
    assert.equal(preview,true);
    await main.waitForSelector('#previewInfo > .liquid-backdrop',{state:'attached'});
    await main.screenshot({path:path.join(root,'test-results','liquid-glass-main-preview.png')});
    await main.evaluate(()=>closePreview());
    await main.evaluate(()=>{const el=document.getElementById('liquidDisplacement');el.value='95';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await main.waitForFunction(()=>document.querySelector('.topbar feDisplacementMap')?.getAttribute('scale')==='-95');
    await main.evaluate(()=>{const el=document.getElementById('liquidOpacity');el.value='0.31';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await main.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--liquid-opacity').trim()==='0.31');
    const navigationOpacity=await main.locator('.sidebar > .liquid-backdrop').evaluate(el=>getComputedStyle(el).backgroundColor);
    await main.evaluate(()=>{const el=document.getElementById('liquidOpacity');el.value='0.8';el.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.notEqual(await main.locator('.sidebar > .liquid-backdrop').evaluate(el=>getComputedStyle(el).backgroundColor),navigationOpacity,'Navigation glass responds to opacity changes');
    await main.evaluate(()=>{const el=document.getElementById('liquidOpacity');el.value='0.31';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await main.evaluate(()=>document.getElementById('liquidSave').click());
    await main.waitForFunction(()=>document.getElementById('liquidSaveStatus').textContent==='已保存');
    assert.equal(await main.evaluate(()=>JSON.parse(localStorage.getItem('tenying-liquid-glass-settings')).displacementScale),95,'Parameters persist in the local profile');
    assert.equal(await main.evaluate(()=>JSON.parse(localStorage.getItem('tenying-liquid-glass-settings')).surfaceOpacity),.31,'Opacity persists locally');
    assert.notEqual(await main.evaluate(()=>fetch('/api/config').then(r=>r.json()).then(c=>c.liquid_glass.surfaceOpacity)),.31,'Glass preferences do not change shared configuration');
    await main.reload();
    await main.waitForFunction(()=>window.liquidGlassSettings?.get().displacementScale===95 && document.querySelector('.topbar feDisplacementMap')?.getAttribute('scale')==='-95');
    await main.evaluate(()=>{window.localAppearance.setMode('none');window.libraryPanel.open('asset');});
    let asset;
    for(let i=0;i<100 && !asset;i++){asset=instance.windows().find(p=>p.url().includes('library=asset'));if(!asset) await new Promise(r=>setTimeout(r,100));}
    assert.ok(asset,'Asset window opens');
    asset.setDefaultTimeout(15000);
    await asset.waitForSelector('#assetLibraryWindow > .liquid-backdrop');
    await asset.waitForFunction(()=>document.querySelector('#assetLibraryWindow feDisplacementMap')?.getAttribute('scale')==='-95');
    assert.match(await asset.locator('#assetLibraryWindow > .liquid-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter),/url\(/,'Asset library uses the upstream optical filter');
    await main.evaluate(()=>window.libraryPanel.open('prompt'));
    let prompt;
    for(let i=0;i<100 && !prompt;i++){prompt=instance.windows().find(p=>p.url().includes('library=prompt'));if(!prompt) await new Promise(r=>setTimeout(r,100));}
    assert.ok(prompt,'Prompt window opens');
    prompt.setDefaultTimeout(15000);
    await prompt.waitForSelector('#promptLibraryWindow > .liquid-backdrop');
    await prompt.waitForFunction(()=>document.querySelector('#promptLibraryWindow feDisplacementMap')?.getAttribute('scale')==='-95');
    await main.evaluate(()=>{const el=document.getElementById('liquidDisplacement');el.value='45';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await asset.waitForFunction(()=>document.querySelector('#assetLibraryWindow feDisplacementMap')?.getAttribute('scale')==='-45');
    await prompt.waitForFunction(()=>document.querySelector('#promptLibraryWindow feDisplacementMap')?.getAttribute('scale')==='-45');
    await main.evaluate(()=>{const el=document.getElementById('liquidEnabled');el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}));});
    await asset.waitForFunction(()=>!document.querySelector('#assetLibraryWindow > .liquid-backdrop'));
    console.log('Liquid glass component: parameters, saving, reload, cross-window sync and disabling passed.');
  } finally {
    if(instance) await instance.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-glass-test-') || relative.includes(path.sep)) throw new Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
