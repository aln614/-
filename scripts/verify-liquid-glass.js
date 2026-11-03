'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { _electron:electron }=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-glass-test-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18769,output_dir:path.join(temporary,'output'),asset_library_dir:path.join(temporary,'assets'),update_auto_check:false,public_enabled:false,shortcuts_enabled:false}));
(async()=>{
  let instance;
  try {
    instance=await electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const main=await instance.firstWindow();
    await main.waitForURL('http://127.0.0.1:18769/**',{timeout:30000});
    await main.waitForFunction(()=>window.liquidGlassSettings && document.querySelector('.topbar feDisplacementMap'));
    await main.locator('[data-page="settings"]').click();
    await main.mouse.move(1000,120);
    await main.waitForTimeout(300);
    await main.locator('#liquidEnabled').scrollIntoViewIfNeeded();
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await main.screenshot({path:path.join(root,'test-results','liquid-glass-settings.png')});
    await main.evaluate(()=>{const el=document.getElementById('liquidDisplacement');el.value='95';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await main.waitForFunction(()=>document.querySelector('.topbar feDisplacementMap')?.getAttribute('scale')==='-95');
    await main.evaluate(()=>document.getElementById('liquidSave').click());
    await main.waitForFunction(()=>document.getElementById('liquidSaveStatus').textContent==='已保存');
    assert.equal(await main.evaluate(()=>fetch('/api/config').then(r=>r.json()).then(c=>c.liquid_glass.displacementScale)),95,'Saved parameters must be in the application configuration');
    await main.reload();
    await main.waitForFunction(()=>window.liquidGlassSettings?.get().displacementScale===95 && document.querySelector('.topbar feDisplacementMap')?.getAttribute('scale')==='-95');
    await main.evaluate(()=>window.libraryPanel.open('asset'));
    let asset;
    for(let i=0;i<100 && !asset;i++){asset=instance.windows().find(p=>p.url().includes('library=asset'));if(!asset) await new Promise(r=>setTimeout(r,100));}
    assert.ok(asset,'Asset window opens');
    await asset.waitForFunction(()=>document.querySelector('#assetLibraryHead feDisplacementMap')?.getAttribute('scale')==='-95');
    await main.evaluate(()=>window.libraryPanel.open('prompt'));
    let prompt;
    for(let i=0;i<100 && !prompt;i++){prompt=instance.windows().find(p=>p.url().includes('library=prompt'));if(!prompt) await new Promise(r=>setTimeout(r,100));}
    assert.ok(prompt,'Prompt window opens');
    await prompt.waitForFunction(()=>document.querySelector('#promptLibraryHead feDisplacementMap')?.getAttribute('scale')==='-95');
    await main.evaluate(()=>{const el=document.getElementById('liquidDisplacement');el.value='45';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await asset.waitForFunction(()=>document.querySelector('#assetLibraryHead feDisplacementMap')?.getAttribute('scale')==='-45');
    await prompt.waitForFunction(()=>document.querySelector('#promptLibraryHead feDisplacementMap')?.getAttribute('scale')==='-45');
    await main.evaluate(()=>{const el=document.getElementById('liquidEnabled');el.checked=false;el.dispatchEvent(new Event('change',{bubbles:true}));});
    await asset.waitForFunction(()=>!document.querySelector('#assetLibraryHead .glass__warp'));
    console.log('Liquid glass component: parameters, saving, reload, cross-window sync and disabling passed.');
  } finally {
    if(instance) await instance.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-glass-test-') || relative.includes(path.sep)) throw new Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
