'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-lan-runtime-'));
const results=process.env.UI_SCREENSHOT_DIR || path.join(root,'test-results');
const data=path.join(temporary,'runtime');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18776,output_dir:path.join(temporary,'output'),shortcuts_enabled:false,update_auto_check:false,public_enabled:false}));
for(const name of ['tenying-ai-lan-client','TENYING_AI_LAN_Client']) {
  const clientProfile=path.join(temporary,name);
  fs.mkdirSync(clientProfile);
  fs.writeFileSync(path.join(clientProfile,'connection.json'),JSON.stringify({host_url:'http://127.0.0.1:18776',shortcuts_enabled:false,zoom_factor:1}));
}
const env={...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data};
(async()=>{
  let host,client,second;
  try {
    host=await electron.launch({executablePath:require('electron'),args:[root,'--background'],env});
    const hostPage=await host.firstWindow();
    await hostPage.waitForURL('http://127.0.0.1:18776/**');
    assert.equal(await hostPage.evaluate(()=>document.body.classList.contains('lan-desktop-shell')),false,'The host does not acquire LAN client-only layout rules');
    assert.equal(await hostPage.evaluate(()=>!!document.querySelector('#page-video')),true,'The host retains the video page');
    const executablePath=process.env.LAN_TEST_PACKAGED || require('electron');
    const args=[...(process.env.LAN_TEST_PACKAGED ? [] : [path.join(root,'lan-client')]),`--user-data-dir=${path.join(temporary,'tenying-ai-lan-client')}`];
    client=await electron.launch({executablePath,args,env});
    const page=await client.firstWindow();page.setDefaultTimeout(15000);
    console.log('LAN test profile:',await client.evaluate(({app})=>app.getPath('userData')));
    await page.waitForURL('http://127.0.0.1:18776/**');
    await page.waitForFunction(()=>document.querySelector('.topbar feDisplacementMap'));
    assert.equal(await page.evaluate(()=>document.body.classList.contains('lan-desktop-shell')),true,'The LAN client receives its own desktop shell');
    assert.equal(await page.evaluate(()=>!!document.querySelector('#page-video')),true,'The LAN client retains the video page');
    await client.evaluate(async({BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows()[0];
      for(let i=0;i<100 && !win.isVisible();i++) await new Promise(r=>setTimeout(r,50));
      if(!win.isVisible()) throw Error('Client did not finish showing');
    });
    assert.equal(await page.evaluate(()=>window.lanClient.getConfig().then(c=>c.client_version)),require('../lan-client/package.json').version);
    assert.ok(await page.locator('link[rel=stylesheet]').evaluateAll((links,version)=>links.some(link=>link.href.includes(version)),require('../package.json').version),'The client loads the updated host renderer');
    await client.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(980,680));
    await page.waitForFunction(()=>innerWidth===980);
    assert.equal(await page.evaluate(()=>document.body.classList.contains('mobile-ui')),false,'A touch-capable LAN desktop keeps its desktop workspace at the minimum window width');
    assert.equal(await page.locator('.right-panel').evaluate(el=>getComputedStyle(el).display!=='none'),true,'The LAN desktop task panel remains available at 980px');
    const desktopFit=await page.evaluate(()=>{
      const ids=['promptLibraryBtn','agentBtn','assetLibraryBtn','announcementBtn','mainWindowClose','collapsePanel','startBatchBtn'];
      const hit=ids.map(id=>{
        const el=document.getElementById(id),rect=el.getBoundingClientRect();
        const target=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
        const style=getComputedStyle(el);
        return {id,visible:rect.width>0 && rect.height>0 && rect.left>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight,clickable:target===el || el.contains(target),rect:rect.toJSON(),display:style.display,visibility:style.visibility};
      });
      const rail=document.getElementById('sidebar').getBoundingClientRect();
      const main=document.querySelector('.main').getBoundingClientRect();
      const panel=document.querySelector('.right-panel'),restore=document.getElementById('restorePanel');
      return {hit,mainStartsAfterRail:main.left>=rail.right,overflow:document.documentElement.scrollWidth>innerWidth,panel:{className:panel.className,display:getComputedStyle(panel).display,rect:panel.getBoundingClientRect().toJSON()},restore:{className:restore.className,rect:restore.getBoundingClientRect().toJSON()},body:document.body.className};
    });
    assert.deepEqual(desktopFit.hit.filter(control=>!control.visible || !control.clickable),[],'Minimum-width LAN desktop controls remain visible and clickable: '+JSON.stringify(desktopFit));
    assert.equal(desktopFit.mainStartsAfterRail,true,'Desktop navigation cannot cover the working area');
    assert.equal(desktopFit.overflow,false,'Minimum-width LAN desktop has no horizontal overflow');
    await page.locator('#sidebar .nav[data-page="video"]').click();
    await page.waitForFunction(()=>document.getElementById('page-video')?.classList.contains('active'));
    const videoActive=await page.locator('#page-video').evaluate(el=>el.classList.contains('active'));
    assert.equal(videoActive,true,'The video page can be opened from the minimum-width LAN desktop');
    await page.locator('#sidebar .nav[data-page="home"]').click();
    await page.waitForFunction(()=>document.getElementById('page-home')?.classList.contains('active'));
    const trackExpanded=async()=>{
      const activeBefore=await page.locator('.page.active').getAttribute('id');
      await page.locator('#sidebar .nav[data-page="home"]').hover();
      await page.waitForFunction(()=>Math.round(document.getElementById('sidebar').getBoundingClientRect().width)===208);
      return page.evaluate(()=>{
        const rail=document.getElementById('sidebar'),bounds=rail.getBoundingClientRect();
        const home=rail.querySelector('.nav[data-page="home"]'),rect=home.getBoundingClientRect();
        const target=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
        const active=document.querySelector('.page.active');
        return {activePage:active?.id,rail:{left:bounds.left,right:bounds.right,width:bounds.width},main:document.querySelector('.main').getBoundingClientRect().toJSON(),homeHit:target===home||home.contains(target)};
      }).then(state=>({...state,activeBefore}));
    };
    const expanded=await trackExpanded();
    assert.equal(expanded.activePage,expanded.activeBefore,'Expanding navigation keeps the current page active');
    assert.ok(expanded.rail.right<expanded.main.left,'The expanded LAN navigation reserves space before the work area');
    assert.equal(expanded.homeHit,true,'Expanded navigation labels remain clickable');
    await page.screenshot({path:path.join(results,'lan-client-sidebar-expanded-980.png')});
    await page.mouse.move(480,100);
    await page.waitForFunction(()=>Math.round(document.getElementById('sidebar').getBoundingClientRect().width)===62);
    await page.screenshot({path:path.join(results,'lan-client-sidebar-collapsed-980.png')});
    await page.locator('#collapsePanel').click();
    await page.waitForFunction(()=>document.getElementById('restorePanel').classList.contains('show'));
    await page.locator('#restorePanel').click();
    await page.waitForFunction(()=>!document.getElementById('restorePanel').classList.contains('show'));
    fs.mkdirSync(results,{recursive:true});
    await page.screenshot({path:path.join(results,'lan-client-desktop-980.png')});
    await client.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,920));
    await page.waitForFunction(()=>innerWidth===1440);
    for(const kind of ['asset','prompt']) {
      const opening=client.waitForEvent('window');
      await page.locator(kind==='asset'?'#assetLibraryBtn':'#promptLibraryBtn').click();
      const library=await opening;
      await library.waitForURL(`**/?library=${kind}`);
      await library.waitForSelector(`body.standalone-${kind} #${kind==='asset'?'assetLibraryLayer':'promptLibraryLayer'}.active`);
      const libraryFit=await library.evaluate(kind=>{
        const header=document.querySelector(kind==='asset'?'.asset-library-head':'.prompt-library-head');
        const bounds=header.getBoundingClientRect();
        const controls=[...header.querySelectorAll('button,input,select')].filter(el=>el.getClientRects().length).map(el=>{
          const rect=el.getBoundingClientRect(),target=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
          return {visible:rect.left>=0 && rect.right<=innerWidth && rect.top>=bounds.top && rect.bottom<=bounds.bottom,clickable:target===el || el.contains(target)};
        });
        return {standalone:document.body.classList.contains(`standalone-${kind}`),desktopShell:document.body.classList.contains('desktop-shell'),headerFits:bounds.left>=0 && bounds.right<=innerWidth && bounds.bottom<=innerHeight,controls};
      },kind);
      assert.equal(libraryFit.standalone,true,`${kind} opens in its standalone library window`);
      assert.equal(libraryFit.desktopShell,false,`${kind} library does not inherit the LAN desktop shell`);
      assert.equal(libraryFit.headerFits,true,`${kind} library header fits the window`);
      assert.deepEqual(libraryFit.controls.filter(control=>!control.visible || !control.clickable),[],`${kind} library header controls remain clickable`);
      await library.screenshot({path:path.join(results,`lan-library-${kind}.png`)});
      await library.locator(kind==='asset'?'#closeAssetLibraryWindow':'#closePromptLibraryWindow').click();
      let hidden=false;
      for(let attempt=0;attempt<100 && !hidden;attempt++) {
        hidden=await client.evaluate(({BrowserWindow},kind)=>{
          const win=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes(`library=${kind}`));
          return !!win && !win.isVisible();
        },kind);
        if(!hidden) await page.waitForTimeout(50);
      }
      assert.equal(hidden,true,`${kind} library close hides its standalone window`);
    }
    await page.evaluate(()=>document.dispatchEvent(new Event('scroll')));
    assert.ok(await page.evaluate(()=>document.documentElement.classList.contains('liquid-in-motion')));
    await page.waitForFunction(()=>!document.documentElement.classList.contains('liquid-in-motion'));
    assert.match(await page.locator('.topbar > .liquid-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter),/url\(/);
    console.log('Hide client:',await client.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(item=>!item.webContents.getURL().includes('library='));if(!win)throw Error('LAN client main window was not found');win.hide();return {visible:win.isVisible(),windows:BrowserWindow.getAllWindows().map(w=>w.webContents.getURL())};}));
    await page.waitForFunction(()=>!document.querySelector('.topbar .glass__warp'),null,{polling:100});
    second=spawn(executablePath,args,{env,windowsHide:true,stdio:'ignore'});
    const exit=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{second.kill();reject(Error('Duplicate client did not exit'));},10000);
      second.once('exit',code=>{clearTimeout(timer);resolve(code);});
      second.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    assert.equal(exit,0,'A duplicate launch exits');
    await page.waitForFunction(()=>!document.hidden && document.querySelector('.topbar .glass__warp'),null,{polling:100});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('.topbar feDisplacementMap'));
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(results,'lan-client-performance.png')});
    console.log('LAN runtime passed: minimum-width desktop layout and control hit testing, panel open/close, updated renderer, library buttons, lightweight scrolling, hidden-window suspension, duplicate launch and reload.');
  } finally {
    if(second && second.exitCode===null) second.kill();
    if(client) await client.close();
    if(host) await host.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-lan-runtime-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
