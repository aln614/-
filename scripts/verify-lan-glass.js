'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-lan-glass-'));
const hostData=path.join(temp,'host-data');
const clientAppData=path.join(temp,'client-appdata');
const clientData=path.join(clientAppData,'tenying-ai-lan-client');
fs.mkdirSync(hostData,{recursive:true});
fs.mkdirSync(clientData,{recursive:true});
fs.writeFileSync(path.join(hostData,'config.json'),JSON.stringify({port:18803,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temp,'assets'),output_dir:path.join(temp,'output')}));
fs.writeFileSync(path.join(clientData,'connection.json'),JSON.stringify({host_url:'http://127.0.0.1:18803',zoom_factor:1,shortcuts_enabled:true,shortcut_settings:{open_app:'Ctrl+Alt+F5',toggle_asset_library:'Ctrl+Alt+F6',toggle_prompt_library:'Ctrl+Alt+F7',toggle_agent:'Ctrl+Alt+F8'}}));
(async()=>{
  let host,client;
  try {
    const packagedHost=process.env.HOST_TEST_PACKAGED;
    host=await electron.launch({executablePath:packagedHost||require('electron'),args:packagedHost?['--background',`--user-data-dir=${path.join(temp,'host-user')}`]:[root,'--background',`--user-data-dir=${path.join(temp,'host-user')}`],env:{...process.env,APPDATA:path.join(temp,'host-appdata'),LOCALAPPDATA:path.join(temp,'host-local'),LOCAL_API_IMAGE_GENERATOR_DATA_DIR:hostData}});
    const hostPage=await host.firstWindow();
    await hostPage.waitForURL('http://127.0.0.1:18803/**',{timeout:30000});
    const packaged=process.env.LAN_TEST_PACKAGED;
    client=await electron.launch({executablePath:packaged||require('electron'),args:packaged?[`--user-data-dir=${clientData}`]:[path.join(root,'lan-client'),`--user-data-dir=${clientData}`],env:{...process.env,APPDATA:clientAppData,LOCALAPPDATA:path.join(temp,'client-local')}});
    const page=await client.firstWindow();
    await page.waitForURL('http://127.0.0.1:18803/**',{timeout:30000});
    await page.waitForFunction(()=>window.localAppearance && document.body.classList.contains('lan-desktop-shell'));
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const updateCalls=[];
    page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/update/')) updateCalls.push(request.url());});
    assert.equal(await page.evaluate(()=>document.body.classList.contains('desktop-shell')),true);
    assert.equal(await hostPage.locator('#page-settings .liquid-settings').count(),1);
    await page.locator('#sidebar [data-page="settings"]').click();
    await page.waitForSelector('#page-lan-client-settings.active');
    assert.equal(await page.locator('#page-lan-client-settings h2').allTextContents().then(headings=>headings.join(',')),'液态玻璃,关于');
    await page.waitForFunction(()=>document.querySelector('#lanClientVersion').textContent!=='-');
    assert.equal(await page.locator('#lanClientVersion').textContent(),(await page.evaluate(()=>window.lanClient.getConfig())).client_version);
    assert.equal(await page.locator('#page-lan-client-settings #outputDir').count(),0);
    await page.evaluate(()=>window.localAppearance.setMode('none'));
    await page.waitForSelector('#sidebar > .liquid-backdrop',{state:'attached'});
    assert.match(await page.locator('#liquidBlur').locator('..').textContent(),/侧栏及内部玻璃模糊/);
    assert.match(await page.locator('#page-lan-client-settings [data-native-blur-note]').textContent(),/无法调节外壳模糊强度/);
    await page.locator('#liquidBlur').fill('0');
    const lowBlur=await page.locator('#sidebar > .liquid-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter);
    await page.locator('#liquidBlur').fill('1');
    const highBlur=await page.locator('#sidebar > .liquid-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter);
    assert.match(lowBlur,/blur\(4px\)/);
    assert.match(highBlur,/blur\(36px\)/);
    await page.locator('#liquidBlur').fill('0.4');
    await page.locator('#liquidSave').click();
    assert.equal(await page.locator('#liquidSaveStatus').textContent(),'已保存');
    await page.locator('#lanClientCheckUpdate').click();
    await page.waitForFunction(()=>!document.querySelector('#lanClientCheckUpdate').disabled,{timeout:20000});
    assert.notEqual((await page.locator('#lanClientUpdateStatus').textContent()).trim(),'');
    assert.deepEqual(updateCalls,[]);
    await page.reload();
    await page.waitForFunction(()=>window.liquidGlassSettings && document.body.classList.contains('lan-desktop-shell'));
    assert.equal(await page.evaluate(()=>window.liquidGlassSettings.get().blurAmount),0.4);
    await page.locator('#sidebar [data-page="settings"]').click();
    await page.waitForSelector('#page-lan-client-settings.active');
    await page.mouse.move(500, 55);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => {
      const sidebar=document.querySelector('#sidebar').getBoundingClientRect();
      const heading=document.querySelector('#page-lan-client-settings h1').getBoundingClientRect();
      return sidebar.right <= heading.left;
    }),true);
    await page.screenshot({path:path.join(root,'test-results','lan-client-settings.png')});
    await client.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,700));
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#liquidSave').isVisible(),true);
    assert.equal(await page.locator('#lanClientCheckUpdate').isVisible(),true);
    await client.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,920));
    await page.waitForTimeout(500);
    await page.locator('#sidebar [data-page="home"]').click();
    assert.deepEqual(await client.evaluate(({globalShortcut})=>['Ctrl+Alt+F6','Ctrl+Alt+F7'].map(key=>globalShortcut.isRegistered(key))),[true,true]);
    assert.equal((await page.evaluate(()=>window.lanClient.getShortcuts())).library_global_registered,true);
    assert.equal(await page.locator('.topbar').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    assert.equal(await page.locator('.topbar .window-drag-region').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    assert.equal(await page.locator('#mainWindowClose').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    if(process.platform==='win32') {
      await client.evaluate(({BrowserWindow})=>{
        const win=BrowserWindow.getAllWindows()[0];
        win.setAlwaysOnTop(true);win.show();win.focus();win.moveTop();
      });
      await page.evaluate(()=>{
        window.__nativeTopbarClicks=[];
        window.__nativePointerEvents=[];
        document.addEventListener('pointerdown',event=>window.__nativePointerEvents.push({target:event.target.id,x:event.clientX,y:event.clientY}),true);
        window.addEventListener('click',event=>{
          const button=event.target.closest('.topbar button');
          if(button) {
            window.__nativeTopbarClicks.push(button.id);
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        },true);
      });
      for(const id of ['promptLibraryBtn','agentBtn','assetLibraryBtn','announcementBtn','apiState','mainWindowMinimize','mainWindowMaximize','mainWindowClose']) {
        console.log('Testing native topbar click:',id);
        const box=await page.locator('#'+id).boundingBox();
        assert.ok(box,id+' must be visible for native input');
        const point={x:Math.round(box.x+box.width/2),y:Math.round(box.y+box.height/2)};
        await client.evaluate(async({BrowserWindow,screen},args)=>{
          const win=BrowserWindow.getAllWindows()[0],bounds=win.getContentBounds();
          const pixel=screen.dipToScreenPoint({x:Math.round(bounds.x+args.point.x),y:Math.round(bounds.y+args.point.y)});
          const koffi=process.getBuiltinModule('module').createRequire(process.execPath)(args.koffi);
          const user=koffi.load('user32.dll');
          const position=user.func('bool SetCursorPos(int x,int y)');
          const mouse=user.func('void mouse_event(uint32 flags,uint32 dx,uint32 dy,uint32 data,uintptr_t extra)');
          win.focus();win.moveTop();position(pixel.x,pixel.y);
          await new Promise(resolve=>setTimeout(resolve,80));
          mouse(2,0,0,0,0);await new Promise(resolve=>setTimeout(resolve,60));mouse(4,0,0,0,0);
        },{point,koffi:path.join(root,'node_modules/koffi')});
        await page.waitForFunction(id=>window.__nativeTopbarClicks.includes(id),id,{timeout:3000}).catch(async error=>{
          console.log('Native click diagnostics:',JSON.stringify({point,events:await page.evaluate(()=>window.__nativePointerEvents),hit:await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.outerHTML?.slice(0,300),point),window:await client.evaluate(({BrowserWindow,screen})=>({bounds:BrowserWindow.getAllWindows()[0].getContentBounds(),display:screen.getPrimaryDisplay()}))}));
          throw error;
        });
      }
      await page.evaluate(()=>{window.__nativeTopbarClicks=null;});
      await page.reload();
      await page.waitForFunction(()=>window.liquidGlassSettings && document.body.classList.contains('lan-desktop-shell'));
      for(const [id,modal,close] of [
        ['agentBtn','#agentPopoutModal.active','closeAgentWindow()'],
        ['announcementBtn','#announcementModal.show','hideAnnouncementModal()'],
        ['apiState','#apiBalanceModal.active','closeApimartBalanceModal()']
      ]) {
        const box=await page.locator('#'+id).boundingBox();
        await client.evaluate(async({BrowserWindow,screen},args)=>{
          const win=BrowserWindow.getAllWindows()[0],bounds=win.getContentBounds();
          const pixel=screen.dipToScreenPoint({x:Math.round(bounds.x+args.x),y:Math.round(bounds.y+args.y)});
          const koffi=process.getBuiltinModule('module').createRequire(process.execPath)(args.koffi);
          const user=koffi.load('user32.dll');
          const position=user.func('bool SetCursorPos(int x,int y)');
          const mouse=user.func('void mouse_event(uint32 flags,uint32 dx,uint32 dy,uint32 data,uintptr_t extra)');
          win.focus();win.moveTop();position(pixel.x,pixel.y);
          await new Promise(resolve=>setTimeout(resolve,80));
          mouse(2,0,0,0,0);await new Promise(resolve=>setTimeout(resolve,60));mouse(4,0,0,0,0);
        },{x:box.x+box.width/2,y:box.y+box.height/2,koffi:path.join(root,'node_modules/koffi')});
        await page.locator(modal).waitFor({state:'visible',timeout:15000});
        await page.evaluate(close=>Function(close)(),close);
      }
      const brand=await page.locator('.window-drag-region').boundingBox();
      const movement=await client.evaluate(async({BrowserWindow,screen},args)=>{
        const win=BrowserWindow.getAllWindows()[0],before=win.getBounds(),content=win.getContentBounds();
        const pixel=screen.dipToScreenPoint({x:Math.round(content.x+args.x),y:Math.round(content.y+args.y)});
        const koffi=process.getBuiltinModule('module').createRequire(process.execPath)(args.koffi);
        const user=koffi.load('user32.dll');
        const position=user.func('bool SetCursorPos(int x,int y)');
        const mouse=user.func('void mouse_event(uint32 flags,uint32 dx,uint32 dy,uint32 data,uintptr_t extra)');
        win.focus();win.moveTop();position(pixel.x,pixel.y);
        await new Promise(resolve=>setTimeout(resolve,100));mouse(2,0,0,0,0);
        await new Promise(resolve=>setTimeout(resolve,100));
        for(let i=1;i<=8;i++){position(pixel.x+i*6,pixel.y+i*4);await new Promise(resolve=>setTimeout(resolve,30));}
        mouse(4,0,0,0,0);await new Promise(resolve=>setTimeout(resolve,250));
        return {before,after:win.getBounds()};
      },{x:brand.x+Math.min(brand.width/2,60),y:brand.y+brand.height/2,koffi:path.join(root,'node_modules/koffi')});
      assert.ok(movement.before.x!==movement.after.x || movement.before.y!==movement.after.y,'Window should remain draggable from brand area: '+JSON.stringify({movement,brand}));
      await client.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setAlwaysOnTop(false));
    }
    for(const theme of ['light','dark']) for(const mode of ['board','none']) {
      await page.evaluate(({theme,mode})=>{window.localAppearance.setTheme(theme);window.localAppearance.setMode(mode);},{theme,mode});
      if(mode==='none') await page.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='acrylic');
      await page.waitForTimeout(1200);
      assert.equal(await page.locator('#mainWindowClose').isVisible(),true);
      assert.equal(await page.locator('#mainWindowMaximize').isVisible(),true);
      assert.equal(await page.locator('#sidebar [data-page="home"]').isVisible(),true);
      await page.screenshot({path:path.join(root,'test-results',`lan-glass-${theme}-${mode}.png`)});
    }
    await page.locator('#mainWindowMaximize').click();
    await page.waitForFunction(()=>document.getElementById('mainWindowMaximize').classList.contains('is-maximized'));
    await page.locator('#mainWindowMaximize').click();
    await page.waitForFunction(()=>!document.getElementById('mainWindowMaximize').classList.contains('is-maximized'));
    await page.locator('#themeCycleBtn').click();
    await page.locator('[data-liquid-quick="blurAmount"]').fill('0.5');
    assert.equal(await page.evaluate(()=>window.liquidGlassSettings.get().blurAmount),0.5);
    await page.locator('#themePanelCloseBtn').click();
    for(const [kind,button,layer] of [['asset','#assetLibraryBtn','#assetLibraryLayer'],['prompt','#promptLibraryBtn','#promptLibraryLayer']]) {
      const newWindow=client.waitForEvent('window');
      await page.locator(button).click();
      const panel=await newWindow;
      await panel.waitForURL(`**/?library=${kind}`);
      await panel.waitForSelector(`body.standalone-${kind} ${layer}.active`);
      await panel.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='acrylic');
      assert.equal(await panel.evaluate(()=>document.body.classList.contains('desktop-shell')),false);
      const selector=kind==='asset'?'#assetLibraryWindow':'#promptLibraryWindow';
      await panel.waitForSelector(selector+' > .liquid-backdrop',{state:'attached'});
      assert.equal(await panel.locator(kind==='asset'?'#assetLibrarySearch':'#promptLibrarySearch').isVisible(),true);
      if(kind==='asset') {
        const asset=await panel.evaluate(async()=>{
          const created=await api('/api/assets/groups/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Drag test'})});
          const group=created.group;
          const upload=await api('/api/assets/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
            group_id:group.id,files:[{name:'drag-test.txt',data:'data:text/plain;base64,aW5kZXBlbmRlbnQgY29weQ=='}]
          })});
          return upload.assets[0];
        });
        assert.ok(asset?.id);
        await client.evaluate(({BrowserWindow})=>{
          const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library=asset'));
          win.webContents.startDrag=payload=>{global.__testDraggedFile=payload.file;};
        });
        const payload={id:asset.id,name:asset.original_name,size:asset.size,version:asset.updated_at,
          clientId:await panel.evaluate(()=>getClientId()),publicAccess:''};
        assert.equal((await panel.evaluate(payload=>window.electronAPI.prepareAssetDrag(payload),payload)).ok,true);
        assert.equal((await panel.evaluate(payload=>window.electronAPI.startAssetDrag(payload),payload)).ok,true);
        const dragged=await client.evaluate(()=>global.__testDraggedFile);
        assert.notEqual(path.resolve(dragged),path.resolve(asset.local_path));
        assert.equal(fs.readFileSync(dragged,'utf8'),'independent copy');
        fs.writeFileSync(dragged,'changed copy');
        assert.equal(fs.readFileSync(asset.local_path,'utf8'),'independent copy');
        assert.equal((await panel.evaluate(payload=>window.electronAPI.prepareAssetDrag({...payload,id:'../invalid'}),payload)).ok,false);
      }
      await panel.screenshot({path:path.join(root,'test-results',`lan-library-${kind}.png`)});
      assert.equal(await panel.evaluate(()=>window.libraryPanel.hide()),true);
      assert.equal(await client.evaluate(({BrowserWindow},kind)=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes(`library=${kind}`)).isVisible(),kind),false);
      assert.equal(await page.evaluate(kind=>window.libraryPanel.open(kind),kind),true);
      await panel.waitForFunction(()=>!document.hidden);
      if(kind==='prompt') {
        assert.equal(await panel.evaluate(()=>window.libraryPanel.applyPrompt('LAN library test')),true);
        await page.waitForFunction(()=>document.querySelector('#prompts').value==='LAN library test');
      }
    }
    const oldAsset=await client.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library=asset')).id);
    await page.evaluate(()=>{window.lanClient.saveHost('http://localhost:18803').catch(()=>{});});
    await page.waitForURL('http://localhost:18803/**',{timeout:30000});
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(()=>window.localAppearance && document.body.classList.contains('lan-desktop-shell'));
    const replacementOpening=client.waitForEvent('window');
    assert.equal(await page.evaluate(()=>window.libraryPanel.open('asset')),true);
    const replacement=await replacementOpening;
    assert.ok(replacement,'Asset library should reopen after switching hosts');
    await replacement.waitForURL('http://localhost:18803/?library=asset',{timeout:30000});
    assert.equal(await client.evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id)===null,oldAsset),true);
    await replacement.waitForSelector('body.standalone-asset #assetLibraryLayer.active');
    await page.evaluate(()=>{window.lanClient.openSettings();});
    await page.waitForURL('file:**/settings.html');
    assert.equal(await page.locator('.client-titlebar [data-action="close"]').isVisible(),true);
    await page.locator('#backBtn').click();
    await page.waitForURL('http://localhost:18803/**',{timeout:30000});
    assert.deepEqual(errors,[]);
    console.log('LAN client: host layout, native glass, themes, window controls, local settings and glass adjustment passed.');
  } finally {
    if(client) await client.close();if(host) await host.close();
    const relative=path.relative(os.tmpdir(),temp);
    if(!relative.startsWith('tenying-lan-glass-')||relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temp,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
