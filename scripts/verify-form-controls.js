'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-form-controls-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18797,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
(async()=>{
  let app;
  try {
    const packaged=process.env.GLASS_TEST_PACKAGED;
    app=await electron.launch({executablePath:packaged||require('electron'),args:packaged?[]:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const page=await app.firstWindow();
    await page.waitForURL('http://127.0.0.1:18797/**',{timeout:30000});
    await page.waitForFunction(()=>window.localAppearance && document.querySelector('#size option'));
    assert.equal(await page.evaluate(()=>CSS.supports('appearance','base-select')),true,'Electron supports styled native picker');
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    for(const mode of ['light','dark']) for(const size of [{width:1480,height:960},{width:1180,height:760}]) {
      await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(size.width,size.height),size);
      await page.evaluate(mode=>window.localAppearance.setTheme(mode),mode);
      await page.locator('#size').click();
      await page.waitForTimeout(300);
      const styles=await page.locator('#size').evaluate(el=>{
        const picker=getComputedStyle(el,'::picker(select)');
        return {appearance:getComputedStyle(el).appearance,picker:picker.appearance,radius:picker.borderRadius,maxHeight:picker.maxHeight,display:picker.display};
      });
      assert.equal(styles.appearance,'base-select');
      assert.equal(styles.picker,'base-select');
      assert.equal(styles.radius,'14px');
      assert.equal(styles.display,'block');
      assert.ok(parseFloat(styles.maxHeight)<=360);
      await page.screenshot({path:path.join(root,'test-results',`form-picker-${mode}-${size.width}.png`)});
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }
    await page.locator('#size').focus();
    const old=await page.locator('#size').inputValue();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.notEqual(await page.locator('#size').inputValue(),old,'Keyboard navigation selects an option');
    await page.locator('#retryTimes').fill('1');
    await page.locator('#retryTimes').press('ArrowUp');
    assert.equal(await page.locator('#retryTimes').inputValue(),'2','Number keyboard stepping remains available');
    assert.equal(await page.locator('#retryTimes').evaluate(el=>getComputedStyle(el).appearance),'textfield');
    await page.locator('#size').selectOption('1:1');
    assert.equal(await page.locator('#size').inputValue(),'1:1','Programmatic native select remains functional');
    console.log('Styled native select and number inputs: light/dark, both window sizes, keyboard and selection passed.');
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-form-controls-')||relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
