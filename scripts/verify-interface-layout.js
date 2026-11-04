'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-interface-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18784,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
(async()=>{
  let app;
  try {
    app=await electron.launch({executablePath:process.env.GLASS_TEST_PACKAGED || require('electron'),args:process.env.GLASS_TEST_PACKAGED?[]:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const page=await app.firstWindow();
    await page.waitForURL('http://127.0.0.1:18784/**',{timeout:30000});
    await page.waitForFunction(()=>window.liquidGlassSettings && document.querySelector('.topbar .liquid-backdrop'));
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    for(const mode of ['light','dark']) for(const size of [{width:1480,height:960},{width:1180,height:760}]) {
      await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('library=')).setSize(size.width,size.height),size);
      await page.evaluate(mode=>applyThemeMode(mode),mode);
      await page.mouse.move(size.width-12,70);
      await page.waitForTimeout(350);
      const issues=await page.evaluate(()=>{
        const ids=['apiKey','modelPreset','size','clarity','startBatchBtn','promptLibraryBtn','assetLibraryBtn','mainWindowClose'];
        return ids.flatMap(id=>{
          const el=document.getElementById(id),r=el.getBoundingClientRect();
          if(!r.width || !r.height || r.left<0 || r.right>innerWidth || r.top<0 || r.bottom>innerHeight) return [id+' is outside the viewport'];
          const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return hit && (el===hit || el.contains(hit)) ? [] : [id+' is obscured'];
        });
      });
      assert.deepEqual(issues,[],mode+' '+size.width+'px controls must be visible and clickable');
      await page.screenshot({path:path.join(root,'test-results',`interface-${mode}-${size.width}.png`)});
    }
    console.log('Main interface: light/dark, 1480px/1180px and control hit targets passed.');
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-interface-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
