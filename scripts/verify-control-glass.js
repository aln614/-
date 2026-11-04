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
    await page.waitForFunction(()=>document.querySelector('#startBatchBtn>.liquid-backdrop') && document.querySelector('.right-panel .stats>div>.liquid-backdrop'));
    const surfaceCount=await page.locator('[data-liquid-surface]').count();
    assert.ok(surfaceCount>=18 && surfaceCount<=24,'Control surfaces stay within the intended bounded tier: '+surfaceCount);
    for(const selector of ['#startBatchBtn','.topbar .pill','.desktop-window-controls button','.right-panel .stats>div','#saveConfigBtn','#clearAllInputImagesBtn']) {
      const style=await page.locator(selector).first().evaluate(el=>{const s=getComputedStyle(el);return {radius:parseFloat(s.borderRadius),shadow:s.boxShadow,border:s.borderTopColor,backdrop:getComputedStyle(el.querySelector(':scope>.liquid-backdrop')).backdropFilter};});
      assert.ok(style.radius>=10,selector+' has a rounded liquid edge');
      assert.notEqual(style.shadow,'none',selector+' has glass depth');
      assert.notEqual(style.border,'rgba(0, 0, 0, 0)',selector+' has an edge highlight');
      assert.match(style.backdrop,/url\(/,selector+' uses the upstream refractive filter');
    }
    const start=page.locator('#startBatchBtn');
    const box=await start.boundingBox();
    await page.mouse.move(box.x+box.width*.72,box.y+box.height*.42);
    await page.waitForTimeout(80);
    assert.equal(await start.evaluate(el=>el.classList.contains('liquid-pointer-active')),true,'Pointer highlight activates through the shared rAF tracker');
    assert.notEqual(await start.evaluate(el=>el.style.getPropertyValue('--liquid-pointer-x')),'','Pointer highlight position is written without React remounts');
    await page.mouse.down();
    assert.equal(await start.evaluate(el=>el.classList.contains('liquid-control-pressed')),true,'Pressed glass state activates');
    await page.mouse.up();
    assert.equal(await start.evaluate(el=>el.classList.contains('liquid-control-pressed')),false,'Pressed glass state releases');
    await page.locator('#apiKey').focus();
    const input=await page.locator('#apiKey').evaluate(el=>{const s=getComputedStyle(el);return {radius:parseFloat(s.borderRadius),shadow:s.boxShadow,backdrop:s.backdropFilter};});
    assert.ok(input.radius>=12,'Inputs use the rounded glass language');
    assert.notEqual(input.shadow,'none','Focused input has a glass focus ring');
    assert.match(input.backdrop,/blur/,'Inputs keep lightweight blur without a React surface');
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(root,'test-results','control-glass-main.png')});
    console.log('Control glass:',JSON.stringify({surfaceCount,inputRadius:input.radius}));
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-control-glass-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
