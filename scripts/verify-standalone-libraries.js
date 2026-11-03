'use strict';
// Runs against an isolated Electron profile and never sends generation requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const { _electron:electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-library-test-'));
const data = path.join(temporary, 'runtime');
fs.mkdirSync(data, {recursive:true});
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  port:18768, output_dir:path.join(temporary, 'output'), asset_library_dir:path.join(temporary, 'assets'),
  shortcuts_enabled:true, update_auto_check:false, public_enabled:false, theme_mode:'light',
  shortcut_settings:{open_app:'Ctrl+Alt+F9',toggle_asset_library:'Ctrl+Alt+F10',toggle_prompt_library:'Ctrl+Alt+F11',toggle_agent:'Ctrl+Alt+F12'}
}));

(async()=>{
  let instance;
  try {
    const testEnv={...process.env, APPDATA:temporary, LOCALAPPDATA:temporary, LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data};
    instance = await electron.launch({executablePath:require('electron'), args:[root,'--background'], env:testEnv});
    const main = await instance.firstWindow();
    await main.waitForURL('http://127.0.0.1:18768/**', {timeout:30000});
    await main.waitForFunction(()=>window.libraryPanel && document.querySelector('#assetLibraryBtn'));
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()), false, 'Background startup hides the main window');
    const second = spawn(require('electron'), [root], {env:testEnv,windowsHide:true,stdio:'ignore'});
    const secondExit = await Promise.race([
      new Promise((resolve,reject)=>{second.once('error',reject);second.once('exit',resolve);}),
      new Promise((_,reject)=>{const timer=setTimeout(()=>{second.kill();reject(new Error('Second instance did not exit'));},10000);timer.unref();})
    ]);
    assert.equal(secondExit,0,'A second launch must exit after notifying the background instance');
    await main.waitForFunction(()=>!document.hidden);
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true,'A second launch restores the original main window');
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
    const registrations = await instance.evaluate(({globalShortcut})=>['Ctrl+Alt+F9','Ctrl+Alt+F10','Ctrl+Alt+F11'].map(key=>globalShortcut.isRegistered(key)));
    assert.deepEqual(registrations, [true,true,true], 'Main and both library shortcuts are registered globally');
    assert.equal(await instance.evaluate(({globalShortcut})=>globalShortcut.register('Ctrl+Alt+F8',()=>{})),true);
    const conflict = await main.evaluate(async()=>fetch('/api/shortcuts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shortcuts_enabled:true,shortcut_settings:{open_app:'Ctrl+Alt+F9',toggle_asset_library:'Ctrl+Alt+F8',toggle_prompt_library:'Ctrl+Alt+F11',toggle_agent:'Ctrl+Alt+F12'}})}).then(async r=>({status:r.status,body:await r.json()})));
    assert.equal(conflict.status,409,'A shortcut used by another owner must be rejected');
    assert.deepEqual(await instance.evaluate(({globalShortcut})=>['Ctrl+Alt+F9','Ctrl+Alt+F10','Ctrl+Alt+F11'].map(key=>globalShortcut.isRegistered(key))),[true,true,true],'A failed update restores existing registrations');
    await instance.evaluate(({globalShortcut})=>globalShortcut.unregister('Ctrl+Alt+F8'));
    const swap = await main.evaluate(async()=>fetch('/api/shortcuts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({shortcuts_enabled:true,shortcut_settings:{open_app:'Ctrl+Alt+F10',toggle_asset_library:'Ctrl+Alt+F9',toggle_prompt_library:'Ctrl+Alt+F11',toggle_agent:'Ctrl+Alt+F12'}})}).then(r=>r.json()));
    assert.equal(swap.ok,true,'Existing bindings can be exchanged in one save');
    const create = await main.evaluate(async()=>fetch('/api/prompt_library/template',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Test template',content:'Sample prompt',group_id:'uncategorized',type:'通用'})}).then(r=>r.json()));
    assert.equal(create.ok, true);
    const assetFixture = await main.evaluate(async()=>{
      const post = (url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
      const group=await post('/api/assets/groups/create',{name:'Test assets'});
      const upload=await post('/api/assets/upload',{group_id:group.group.id,files:[{name:'fixture.png',data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDAAAAABJRU5ErkJggg=='}]});
      return {group,upload};
    });
    assert.equal(assetFixture.group.ok,true); assert.equal(assetFixture.upload.ok,true);
    const waitForLibrary = async kind => {
      for(let attempt=0;attempt<150;attempt++){
        const page=instance.windows().find(item=>item.url().includes(`library=${kind}`));
        if(page) return page;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error(`Library window did not load: ${kind}`);
    };

    assert.equal(await main.evaluate(()=>window.libraryPanel.open('asset')), true);
    const asset = await waitForLibrary('asset');
    assert.ok(asset, 'Asset library opens in a separate native window');
    await asset.waitForSelector('body.standalone-asset #assetLibraryLayer.active', {timeout:15000});
    await asset.getByText('fixture.png',{exact:true}).waitFor();
    const appearance=await instance.evaluate(({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('library=asset'));
      return {background:win.getBackgroundColor(), resizable:win.isResizable(),bounds:win.getBounds()};
    });
    assert.match(appearance.background,/^#00/i,'Independent panels must have a transparent native background');
    assert.equal(appearance.resizable,true,'Independent panels must remain resizable');
    assert.equal(await asset.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgba(0, 0, 0, 0)');
    assert.equal(await asset.locator('#assetLibraryHead').evaluate(el=>getComputedStyle(el).webkitAppRegion),'drag','The header must drag the native window');
    assert.equal(await asset.locator('#assetLibrarySearch').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag','Search stays interactive in the draggable header');
    const glassAlpha=await instance.evaluate(async({BrowserWindow})=>{
      const panel=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('library=asset'));
      const image=await panel.webContents.capturePage();
      const bitmap=image.toBitmap(), size=image.getSize(), offset=(Math.floor(size.height*.55)*size.width+Math.floor(size.width*.7))*4;
      return bitmap[offset+3];
    });
    assert.ok(glassAlpha < 245,`Panel background should remain translucent, alpha ${glassAlpha}`);
    const handle=asset.locator('#assetLibraryResize');
    await handle.waitFor({state:'visible'});
    const grip=await handle.boundingBox();
    await asset.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);
    await asset.mouse.down(); await asset.mouse.move(grip.x+grip.width/2+80,grip.y+grip.height/2+50,{steps:4}); await asset.mouse.up();
    await asset.waitForTimeout(150);
    const resized=await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('library=asset')).getBounds());
    assert.ok(resized.width > appearance.bounds.width && resized.height > appearance.bounds.height,'The resize grip must change the native window size');
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await asset.screenshot({path:path.join(root,'test-results','standalone-asset-library.png')});
    await asset.locator('.asset-card').first().click();
    await asset.locator('#previewModal.active').waitFor();
    await asset.evaluate(()=>closePreview());
    const size = await asset.locator('#assetLibraryWindow').evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,innerWidth,innerHeight};});
    assert.equal(size.x,0); assert.equal(size.y,0); assert.equal(size.width,size.innerWidth); assert.equal(size.height,size.innerHeight);
    assert.equal(await main.evaluate(()=>document.querySelector('#assetLibraryLayer').classList.contains('active')),false);
    await asset.locator('#closeAssetLibraryWindow').click();
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().includes('library=asset')).isVisible()),false);
    assert.equal(await main.evaluate(()=>window.libraryPanel.open('asset')), true);
    await asset.waitForFunction(()=>!document.hidden);

    assert.equal(await main.evaluate(()=>window.libraryPanel.open('prompt')), true);
    const prompt = await waitForLibrary('prompt');
    assert.ok(prompt, 'Prompt library opens in a separate native window');
    await prompt.waitForSelector('body.standalone-prompt #promptLibraryLayer.active', {timeout:15000});
    await prompt.getByText('Test template', {exact:true}).waitFor();
    assert.equal(await prompt.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgba(0, 0, 0, 0)');
    assert.equal(await prompt.locator('#promptLibraryHead').evaluate(el=>getComputedStyle(el).webkitAppRegion),'drag');
    assert.equal(await prompt.locator('#promptLibrarySearch').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    await prompt.locator('#promptLibraryResize').waitFor({state:'visible'});
    await prompt.screenshot({path:path.join(root,'test-results','standalone-prompt-library.png')});
    await prompt.locator('.pl-card').filter({hasText:'Test template'}).getByText('应用',{exact:true}).click();
    await main.waitForFunction(()=>document.querySelector('#prompts').value === 'Sample prompt');
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>!win.webContents.getURL().includes('library=')).isVisible()),true,'Apply brings the main window forward');
    await prompt.locator('#closePromptLibraryWindow').click();
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().includes('library=prompt')).isVisible()),false);
    console.log('Standalone libraries: background startup, global shortcut registrations, separate windows, hide/reopen and prompt application passed.');
  } finally {
    if(instance) await instance.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-library-test-') || relative.includes(path.sep)) throw new Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
