'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-control-glass-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18790,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
(async()=>{
  let app;
  try {
    const packaged=process.env.GLASS_TEST_PACKAGED;
    app=await electron.launch({executablePath:packaged || require('electron'),args:packaged?[]:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const page=await app.firstWindow();
    await page.waitForURL('http://127.0.0.1:18790/**',{timeout:30000});
    await page.waitForFunction(()=>document.querySelector('.topbar>.liquid-backdrop') && document.querySelector('.sidebar>.liquid-backdrop'));
    const surfaceCount=await page.locator('[data-liquid-surface]').count();
    assert.ok(surfaceCount>=2 && surfaceCount<=12,'Liquid optics stay limited to navigation and floating layers: '+surfaceCount);
    assert.equal(await page.locator('#page-home .liquid-backdrop').count(),0,'Home content controls do not create nested refractive black blocks');
    for(const selector of ['.topbar','.sidebar']) {
      const style=await page.locator(selector).evaluate(el=>{const s=getComputedStyle(el),glass=getComputedStyle(el.querySelector(':scope>.liquid-backdrop'));return {radius:parseFloat(s.borderRadius),shadow:s.boxShadow,border:s.borderTopColor,backdrop:glass.backdropFilter};});
      assert.ok(style.radius>=20,selector+' has a continuous Apple-style corner');
      assert.notEqual(style.shadow,'none',selector+' has material depth');
      assert.notEqual(style.border,'rgba(0, 0, 0, 0)',selector+' has a fine material edge');
      assert.match(style.backdrop,/url\(/,selector+' uses the upstream refractive filter');
    }
    for(const selector of ['#page-home .card','.right-panel','.recent-upload-panel','.right-panel .stats>div']) {
      const style=await page.locator(selector).first().evaluate(el=>{const s=getComputedStyle(el);return {radius:parseFloat(s.borderRadius),background:s.backgroundColor,shadow:s.boxShadow};});
      assert.ok(style.radius>=17,selector+' keeps concentric rounded corners');
      assert.notEqual(style.background,'rgba(0, 0, 0, 0)',selector+' has a readable material fill');
      assert.notEqual(style.shadow,'none',selector+' has restrained depth');
    }
    const start=page.locator('#startBatchBtn');
    assert.equal(await start.evaluate(el=>getComputedStyle(el).borderRadius),'999px','Primary commands use a system pill shape');
    await page.locator('#apiKey').focus();
    const input=await page.locator('#apiKey').evaluate(el=>{const s=getComputedStyle(el);return {radius:parseFloat(s.borderRadius),shadow:s.boxShadow,backdrop:s.backdropFilter};});
    assert.ok(input.radius>=12,'Inputs use the rounded glass language');
    assert.notEqual(input.shadow,'none','Focused input has a glass focus ring');
    assert.equal(input.backdrop,'none','Inputs stay optically sharp inside the material card');
    const pages=['home','history','images','video','video-manage','chat','api','lan','public','logs','settings'];
    for(const name of pages) {
      const nav=page.locator('.nav[data-page="'+name+'"]');
      if(!await nav.count() || !await nav.isVisible()) continue;
      await nav.click();
      await page.waitForFunction(value=>document.getElementById('page-'+value)?.classList.contains('active'),name);
      const problems=await page.evaluate(()=>[...document.querySelectorAll('.page.active .card,.page.active .table-wrap,.page.active .batch-card,.page.active .dropzone,.page.active .recent-upload-panel,.page.active .recent-video-upload-panel')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&parseFloat(getComputedStyle(el).borderTopLeftRadius)<14;}).map(el=>({tag:el.tagName,id:el.id,className:el.className,radius:getComputedStyle(el).borderRadius})));
      assert.deepEqual(problems,[],name+' page has no square primary surfaces');
    }
    await page.locator('.nav[data-page="home"]').click();
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(root,'test-results','control-glass-main.png')});
    console.log('Apple material hierarchy:',JSON.stringify({surfaceCount,inputRadius:input.radius}));
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-control-glass-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
