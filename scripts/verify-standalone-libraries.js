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
    const packaged=process.env.GLASS_TEST_PACKAGED;
    instance = await electron.launch({executablePath:packaged || require('electron'), args:packaged ? ['--background'] : [root,'--background'], env:testEnv});
    const main = await instance.firstWindow();
    await main.waitForURL('http://127.0.0.1:18768/**', {timeout:30000});
    await main.waitForFunction(()=>window.libraryPanel && document.querySelector('#assetLibraryBtn'));
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()), false, 'Background startup hides the main window');
    const second = spawn(packaged || require('electron'), packaged ? [] : [root], {env:testEnv,windowsHide:true,stdio:'ignore'});
    const secondExit = await Promise.race([
      new Promise((resolve,reject)=>{second.once('error',reject);second.once('exit',resolve);}),
      new Promise((_,reject)=>{const timer=setTimeout(()=>{second.kill();reject(new Error('Second instance did not exit'));},10000);timer.unref();})
    ]);
    assert.equal(secondExit,0,'A second launch must exit after notifying the background instance');
    await main.waitForFunction(()=>!document.hidden);
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true,'A second launch restores the original main window');
    await main.waitForFunction(()=>document.body.classList.contains('desktop-shell') && document.querySelector('.topbar .glass__warp'));
    await main.waitForFunction(()=>getComputedStyle(document.querySelector('.topbar .liquid-backdrop')).backdropFilter.includes('url('));
    assert.match(await main.locator('.topbar .liquid-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter),/url\(/,'The installed glass component must refract the actual backdrop');
    await main.evaluate(()=>{const slider=document.querySelector('#liquidDisplacement');slider.value='95';slider.dispatchEvent(new Event('input',{bubbles:true}));});
    await main.waitForFunction(()=>document.querySelector('.topbar feDisplacementMap')?.getAttribute('scale')==='-95');
    assert.equal(await main.locator('.topbar').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag','The full main header must not swallow control clicks');
    assert.equal(await main.locator('.window-drag-region').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag','Pointer dragging keeps header controls interactive');
    assert.equal(await main.locator('#promptLibraryBtn').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag','Top status controls must remain clickable');
    assert.equal(await main.locator('#mainWindowClose').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag','Window controls must remain clickable');
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMenuBarVisible()),false,'The native menu bar must be removed');
    const topbarFit=await main.locator('.topbar').evaluate(el=>{
      const header=el.getBoundingClientRect(), controls=document.querySelector('.desktop-window-controls').getBoundingClientRect(), status=document.querySelector('.top-status').getBoundingClientRect();
      return {fit:controls.right<=header.right && status.right<=controls.left && controls.top>=header.top && controls.bottom<=header.bottom};
    });
    assert.equal(topbarFit.fit,true,'Header controls must not overlap or overflow');
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await main.screenshot({path:path.join(root,'test-results','liquid-glass-main.png')});
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1180,760));
    await main.waitForFunction(()=>innerWidth<=1180);
    const narrowFit=await main.locator('.topbar').evaluate(el=>{
      const header=el.getBoundingClientRect(), controls=document.querySelector('.desktop-window-controls').getBoundingClientRect(), status=document.querySelector('.top-status').getBoundingClientRect(), brand=document.querySelector('.skin-brand-shell').getBoundingClientRect();
      return controls.right<=header.right && status.right<=controls.left && brand.right<=status.left && controls.bottom<=header.bottom;
    });
    assert.equal(narrowFit,true,'Header must fit at the minimum desktop window size');
    await main.screenshot({path:path.join(root,'test-results','liquid-glass-narrow.png')});
    await main.evaluate(()=>applyThemeMode('dark'));
    await main.screenshot({path:path.join(root,'test-results','liquid-glass-dark.png')});
    await main.evaluate(()=>applyThemeMode('light'));
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1480,960));
    await main.locator('#mainWindowMaximize').click();
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized()),true);
    await main.locator('#mainWindowMaximize.is-maximized').waitFor();
    assert.equal(await main.locator('#mainWindowMaximize').getAttribute('aria-label'),'还原窗口');
    await main.locator('#mainWindowMaximize').click();
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized()),false);
    await main.locator('#mainWindowMinimize').click();
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized()),true);
    await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].restore());
    await main.waitForFunction(()=>!document.hidden,null,{polling:100});
    await main.locator('#mainWindowClose').click();
    for(let attempt=0;attempt<30;attempt++){
      if(!await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())) await main.evaluate(()=>window.mainWindowControls.action('close'));
    assert.equal(await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false,`Close must keep the background tray running; close control: ${await main.locator('#mainWindowClose').evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,180);})}`);
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
    await instance.evaluate(({BrowserWindow})=>{
      const original=BrowserWindow.prototype.setShape;
      BrowserWindow.prototype.setShape=function(rectangles){const result=original.call(this,rectangles);this.__testShape=rectangles;return result;};
    });
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

    await main.evaluate(()=>window.localAppearance.setMode('none'));
    assert.equal(await main.evaluate(()=>window.libraryPanel.open('asset')), true);
    const asset = await waitForLibrary('asset');
    assert.ok(asset, 'Asset library opens in a separate native window');
    await asset.waitForSelector('body.standalone-asset #assetLibraryLayer.active', {timeout:15000});
    await asset.waitForSelector('#assetLibraryWindow > .liquid-backdrop-static');
    assert.equal(await asset.locator('#assetLibraryWindow feDisplacementMap').count(),0,'Standalone asset glass is neutral and avoids full-window chromatic filters');
    await asset.getByText('fixture.png',{exact:true}).waitFor();
    const appearance=await instance.evaluate(({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('library=asset'));
      return {background:win.getBackgroundColor(), resizable:win.isResizable(),bounds:win.getBounds(),shape:win.__testShape};
    });
    assert.match(appearance.background,/^#00/i,'Independent panels must have a transparent native background');
    assert.equal(appearance.resizable,true,'Independent panels must remain resizable');
    const inside=(shape,x,y)=>shape.some(rect=>x>=rect.x && y>=rect.y && x<rect.x+rect.width && y<rect.y+rect.height);
    assert.ok(appearance.shape?.length > 1,'A rounded native window shape is applied');
    assert.equal(inside(appearance.shape,0,0),false,'The upper-left corner must not draw a square background');
    assert.equal(inside(appearance.shape,appearance.bounds.width-1,0),false,'The upper-right corner must not draw a square background');
    assert.equal(inside(appearance.shape,0,appearance.bounds.height-1),false,'The lower-left corner must not draw a square background');
    assert.equal(inside(appearance.shape,appearance.bounds.width-1,appearance.bounds.height-1),false,'The lower-right corner must not draw a square background');
    assert.equal(inside(appearance.shape,appearance.bounds.width/2,appearance.bounds.height/2),true);
    assert.equal(await asset.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgba(0, 0, 0, 0)');
    assert.equal(await asset.locator('#assetLibraryHead').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag','The full asset header must not swallow control clicks');
    assert.equal(await asset.locator('.asset-library-drag-region').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag','The asset title uses controlled pointer dragging');
    assert.equal(await asset.locator('#assetLibrarySearch').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag','Search stays interactive in the draggable header');
    assert.equal(await asset.locator('#assetBatchToggleBtn').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    assert.equal(await asset.locator('#assetUploadTopBtn').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    assert.equal(await asset.locator('#assetLibraryWindow').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px','Standalone asset window has no outer border line');
    assert.equal(await asset.locator('#assetLibraryHead').evaluate(el=>getComputedStyle(el).borderBottomWidth),'0px','Standalone asset header has no divider line');
    assert.match(await asset.locator('#assetLibraryWindow > .liquid-backdrop-static').evaluate(el=>getComputedStyle(el,'::before').backgroundImage),/^url\(/,'Standalone glass must use the sampled desktop as its neutral background source');
    const handle=asset.locator('#assetLibraryResize');
    await handle.waitFor({state:'visible'});
    const grip=await handle.boundingBox();
    await asset.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);
    await asset.mouse.down(); await asset.mouse.move(grip.x+grip.width/2+80,grip.y+grip.height/2+50,{steps:4}); await asset.mouse.up();
    await asset.waitForTimeout(150);
    const resized=await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('library=asset')).getBounds());
    assert.ok(resized.width > appearance.bounds.width && resized.height > appearance.bounds.height,`The resize grip must change the native window size: ${JSON.stringify({before:appearance.bounds,after:resized,grip,element:await handle.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,160)})})}`);
    const resizedShape=await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('library=asset')).__testShape);
    assert.equal(inside(resizedShape,resized.width-1,resized.height-1),false,'Rounded clipping must follow the resized window');
    assert.equal(inside(resizedShape,resized.width/2,resized.height/2),true);
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await asset.screenshot({path:path.join(root,'test-results','standalone-asset-library.png')});
    await asset.locator('.asset-card').first().click();
    await asset.locator('#previewModal.active').waitFor();
    await asset.locator('#previewModal > .liquid-backdrop').waitFor({state:'attached'});
    await asset.locator('#previewInfo > .liquid-backdrop').waitFor({state:'attached'});
    assert.equal(await asset.locator('.preview-toolbar').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag','Preview toolbar must stay clickable');
    const zoomBefore=await asset.locator('#zoomReset').textContent();
    await asset.locator('#zoomIn').click();
    await asset.waitForFunction(before=>document.querySelector('#zoomReset').textContent!==before,zoomBefore);
    await asset.locator('#zoomOut').click();
    await asset.locator('#zoomReset').click();
    await asset.locator('#previewBgWhite').click();
    assert.equal(await asset.locator('#previewBgWhite').evaluate(el=>el.classList.contains('active')),true,'Preview background controls must receive clicks');
    await asset.locator('#previewBgBlack').click();
    assert.equal(await asset.locator('#previewBgBlack').evaluate(el=>el.classList.contains('active')),true);
    await asset.screenshot({path:path.join(root,'test-results','liquid-glass-image-preview.png')});
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
    await prompt.waitForSelector('#promptLibraryWindow > .liquid-backdrop-static');
    assert.equal(await prompt.locator('#promptLibraryWindow feDisplacementMap').count(),0);
    await prompt.getByText('Test template', {exact:true}).waitFor();
    assert.equal(await prompt.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgba(0, 0, 0, 0)');
    const promptShape=await instance.evaluate(({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('library=prompt'));
      return {bounds:win.getBounds(),shape:win.__testShape};
    });
    assert.ok(promptShape.shape?.length > 1,'The prompt window also has rounded native clipping');
    assert.equal(inside(promptShape.shape,0,0),false);
    assert.equal(inside(promptShape.shape,promptShape.bounds.width-1,promptShape.bounds.height-1),false);
    assert.equal(await prompt.locator('#promptLibraryHead').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    assert.equal(await prompt.locator('.prompt-library-drag-region').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    assert.equal(await prompt.locator('#promptLibrarySearch').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    assert.equal(await prompt.locator('#newPromptLibraryTemplateBtn').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    assert.equal(await prompt.locator('#promptLibraryWindow').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
    assert.equal(await prompt.locator('#promptLibraryHead').evaluate(el=>getComputedStyle(el).borderBottomWidth),'0px');
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
