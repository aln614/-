'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'../..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-glass-fallback-'));
const data=path.join(temp,'data');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18827,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temp,'assets'),output_dir:path.join(temp,'output')}));
(async()=>{
  let app;
  try {
    const packaged=process.env.TENYING_TEST_PACKAGED==='1';
    app=await electron.launch({
      executablePath:packaged?path.join(root,'dist-native-experimental-host','win-unpacked','TENYING_AI.exe'):require('electron'),
      args:packaged?[]:[root],
      env:{...process.env,APPDATA:temp,LOCALAPPDATA:temp,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data,TENYING_EXPERIMENTAL_NATIVE_GLASS:path.join(temp,'missing-runtime')}
    });
    const page=await app.firstWindow();
    await page.waitForURL('http://127.0.0.1:18827/**',{timeout:30000});
    await page.waitForFunction(()=>window.localAppearance);
    await page.evaluate(()=>{window.localAppearance.setTheme('light');window.localAppearance.setMode('none');});
    await page.waitForTimeout(1000);
    assert.equal(await page.evaluate(()=>document.body.dataset.nativeGlassMaterial),'none');
    assert.equal(await page.locator('#localAppearanceBackground').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(255, 255, 255, 0.94)');
    await page.locator('[data-appearance-open]:visible').first().click();
    assert.equal(await page.locator('#themePopover [data-shell-blur]').isVisible(),false);
    assert.equal(await page.locator('#themePopover [data-native-blur-note]').isVisible(),true);
    await page.locator('#themePanelCloseBtn').click();
    console.log('Missing runtime: readable fallback and controls passed');
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temp);
    if(!relative.startsWith('tenying-glass-fallback-')||relative.includes(path.sep)) throw Error('Unsafe cleanup');
    fs.rmSync(temp,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
