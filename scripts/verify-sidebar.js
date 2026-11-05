'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {PNG}=require('pngjs');
const {_electron:electron,chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-sidebar-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({
  port:18792,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,
  asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')
}));
const results=path.join(root,'test-results');
fs.mkdirSync(results,{recursive:true});

function pixelChanges(a,b) {
  assert.equal(a.width,b.width);assert.equal(a.height,b.height);
  let changed=0;
  for(let i=0;i<a.data.length;i+=4)
    if(Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2])>15) changed++;
  return changed;
}

(async()=>{
  let app,browser;
  try {
    const packaged=process.env.GLASS_TEST_PACKAGED;
    app=await electron.launch({executablePath:packaged || require('electron'),args:packaged?[]:[root],
      env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const page=await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForURL('http://127.0.0.1:18792/**',{timeout:30000});
    await page.waitForFunction(()=>document.querySelector('#sidebar feDisplacementMap'));
    const sidebar=page.locator('#sidebar');
    const nav=page.locator('#sidebar .nav[data-page]');
    const setSize=size=>app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('library=')).setSize(size.width,size.height),size);
    const settle=()=>page.waitForTimeout(500);
    const geometry=()=>page.evaluate(()=>{
      const rail=document.getElementById('sidebar'),button=rail.querySelector('.nav.active');
      const r=rail.getBoundingClientRect(),b=button.getBoundingClientRect(),icon=button.querySelector('.nav-icon').getBoundingClientRect();
      return {width:r.width,left:r.left,right:r.right,top:r.top,bottom:r.bottom,
        mainLeft:document.querySelector('.main').getBoundingClientRect().left,
        centered:Math.abs((icon.left+icon.right)/2-(b.left+b.right)/2),
        clipped:b.left<r.left || b.right>r.right,
        active:getComputedStyle(button).backgroundColor,color:getComputedStyle(button).color,
        labelOpacity:getComputedStyle(button.querySelector('.nav-label')).opacity,
        radius:parseFloat(getComputedStyle(rail).borderTopLeftRadius),
        backdrop:getComputedStyle(rail.querySelector('.liquid-backdrop')).backdropFilter};
    });
    for(const theme of ['light','dark']) {
      await setSize({width:1480,height:960});
      await page.evaluate(theme=>window.localAppearance.setTheme(theme),theme);
      await page.mouse.move(600,80);await settle();
      const collapsed=await geometry();
      assert.equal(collapsed.width,62,'Collapsed rail has a stable 62px width');
      assert.ok(collapsed.centered<1,'Collapsed icon is precisely centered');
      assert.equal(collapsed.clipped,false,'Navigation is inside the rounded rail');
      assert.ok(collapsed.mainLeft>=collapsed.right,'Rail cannot overlap the main content at rest');
      assert.ok(collapsed.radius>=24);
      assert.match(collapsed.backdrop,/url\(/);
      await page.screenshot({path:path.join(results,`sidebar-${theme}-collapsed.png`)});
      await page.locator('#sidebar .nav[data-page="home"]').hover();
      const highlightErrors=await sidebar.evaluate(async el=>{
        const errors=[];
        for(let i=0;i<16;i++) {
          await new Promise(requestAnimationFrame);
          const host=el.querySelector('.liquid-glass-mount').getBoundingClientRect();
          for(const span of el.querySelectorAll('.liquid-react-layer>span')) {
            const rect=span.getBoundingClientRect();
            if(Math.abs(rect.width-host.width)>1 || Math.abs(rect.height-host.height)>1) errors.push({width:rect.width,host:host.width});
          }
        }
        return errors;
      });
      assert.deepEqual(highlightErrors,[],'Glass edges follow the rail during animation');
      await settle();
      const expanded=await geometry();
      assert.equal(expanded.width,208,'Hover exposes navigation names');
      assert.equal(expanded.labelOpacity,'1');
      assert.equal(expanded.mainLeft,collapsed.mainLeft,'Expansion must not move the working area');
      assert.equal(expanded.active,collapsed.active,'Hovering the rail preserves selection');
      assert.equal(expanded.color,collapsed.color);
      await page.screenshot({path:path.join(results,`sidebar-${theme}-expanded.png`)});
      for(const button of await nav.all()) {
        const name=await button.getAttribute('data-page');
        await button.click();await settle();
        assert.equal(await page.locator('#page-'+name).evaluate(el=>el.classList.contains('active')),true,name+' opens');
        assert.equal(await button.getAttribute('aria-current'),'page');
        assert.equal(await page.locator('#sidebar [aria-current="page"]').count(),1);
      }
      await page.locator('#sidebar .nav[data-page="home"]').click();
      await page.mouse.move(600,80);await settle();
      assert.equal((await geometry()).width,62,'Mouse click focus must not leave the rail stuck open');
    }
    await setSize({width:1180,height:650});await settle();
    assert.equal(await page.locator('#sidebar .nav-stack').evaluate(el=>el.scrollHeight>el.clientHeight),true,'Short windows get a scrollable navigation stack');
    await page.locator('#sidebar .nav[data-page="logs"]').click();
    await page.waitForFunction(()=>document.getElementById('page-logs').classList.contains('active'));
    for(const id of ['shortcutSettingsBtn','themeCycleBtn']) {
      const hit=await page.locator('#'+id).evaluate(el=>{
        const r=el.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return r.bottom<=innerHeight && (h===el || el.contains(h));
      });
      assert.ok(hit,id+' stays reachable in short windows');
    }
    assert.equal(await page.locator('#sidebar .nav-stack').evaluate(el=>getComputedStyle(el).scrollbarWidth),'none','Native scrollbar arrows cannot reappear');
    await settle();
    await page.screenshot({path:path.join(results,'sidebar-short-window.png')});
    await setSize({width:1480,height:960});
    await page.locator('#sidebar .nav[data-page="home"]').click();
    await page.mouse.move(600,80);await settle();
    await page.locator('#sidebar .nav[data-page="home"]').focus();
    await page.keyboard.press('Tab');await settle();
    assert.equal((await geometry()).width,208,'Keyboard focus reveals labels too');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.getElementById('page-midjourney').classList.contains('active'));
    await page.locator('#sidebar .nav[data-page="settings"]').click();
    await page.mouse.move(600,80);await settle();

    // Pixel-test the actual sidebar filter, not just its SVG attributes.
    await page.evaluate(()=>{
      window.localAppearance.setTheme('light');window.localAppearance.setMode('custom');
      document.getElementById('localAppearanceBackground').style.setProperty('background','repeating-linear-gradient(90deg,#eecc77 0px,#eecc77 18px,#7799cc 18px,#7799cc 36px)','important');
      const input=document.getElementById('liquidDisplacement');input.value='0';input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await page.waitForFunction(()=>document.querySelector('#sidebar feDisplacementMap').getAttribute('scale')==='0');await settle();
    const plain=PNG.sync.read(await sidebar.screenshot());
    await page.evaluate(()=>{const input=document.getElementById('liquidDisplacement');input.value='150';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelector('#sidebar feDisplacementMap').getAttribute('scale')==='-150');await settle();
    const changed=pixelChanges(plain,PNG.sync.read(await sidebar.screenshot()));
    assert.ok(changed>100,'Refraction must visibly change sidebar pixels: '+changed);
    const beforeOpacity=await page.locator('#sidebar>.liquid-backdrop').evaluate(el=>getComputedStyle(el).backgroundColor);
    await page.evaluate(()=>{const input=document.getElementById('liquidOpacity');input.value='.8';input.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.notEqual(await page.locator('#sidebar>.liquid-backdrop').evaluate(el=>getComputedStyle(el).backgroundColor),beforeOpacity);
    await page.evaluate(()=>{const input=document.getElementById('liquidEnabled');input.checked=false;input.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.waitForFunction(()=>!document.querySelector('#sidebar>.liquid-backdrop'));
    assert.notEqual(await sidebar.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','Disabling glass keeps navigation readable');
    browser=await chromium.launch({channel:'msedge',headless:true});
    for(const size of [{width:1280,height:800},{width:390,height:844}]) {
      const context=await browser.newContext({viewport:size,isMobile:size.width<768,hasTouch:size.width<768});
      const web=await context.newPage();
      await web.goto('http://127.0.0.1:18792/');
      await web.waitForFunction(()=>document.querySelector('#sidebar feDisplacementMap'));
      await web.waitForTimeout(350);
      const mobile=size.width<768;
      assert.equal(await web.evaluate(()=>document.body.classList.contains('mobile-ui')),mobile);
      await web.locator('#sidebar .nav[data-page="history"]').click();
      await web.waitForFunction(()=>document.getElementById('page-history').classList.contains('active'));
      await web.waitForTimeout(350);
      const fits=await web.locator('#sidebar').evaluate(el=>{
        const r=el.getBoundingClientRect();
        return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;
      });
      assert.ok(fits,'Browser navigation stays inside the '+size.width+'px viewport');
      if(mobile) {
        assert.equal(await web.locator('#sidebar').evaluate(el=>getComputedStyle(el).position),'fixed','Mobile retains its bottom navigation');
        assert.ok(await web.locator('#sidebar').evaluate(el=>el.getBoundingClientRect().width>=innerWidth-18),'Mobile navigation spans the available width');
      }
      await web.screenshot({path:path.join(results,'sidebar-browser-'+size.width+'.png')});
      await context.close();
    }
    console.log(JSON.stringify({result:'passed',themes:2,navigationPages:await nav.count(),browserWidths:[1280,390],refractionPixelsChanged:changed}));
  } finally {
    if(browser) await browser.close();
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-sidebar-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
