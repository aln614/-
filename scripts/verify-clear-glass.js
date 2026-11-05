'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {PNG}=require('pngjs');
const {_electron:electron,chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-clear-glass-'));
const data=path.join(temporary,'runtime'),results=path.join(root,'test-results');
fs.mkdirSync(data);fs.mkdirSync(results,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({
  port:18793,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,
  asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')
}));
const change=(page,id,value)=>page.evaluate(({id,value})=>{
  const input=document.getElementById(id);
  if(input.type==='checkbox') input.checked=value;else input.value=String(value);
  input.dispatchEvent(new Event(input.type==='checkbox'?'change':'input',{bubbles:true}));
},{id,value});
const settle=page=>page.waitForTimeout(400);
const ready=page=>page.waitForFunction(version=>window.localAppearance && window.liquidGlassSettings && document.getElementById('appVersionText').textContent===version,require('../package.json').version);
async function optics(page,selector) {
  await page.waitForSelector(selector+' > .liquid-backdrop',{state:'attached'});
  await page.waitForFunction(selector=>{
    const backdrop=document.querySelector(selector+' > .liquid-backdrop');
    return backdrop && getComputedStyle(backdrop).backdropFilter.includes('url(');
  },selector);
  return page.locator(selector).evaluate(el=>{
    const s=getComputedStyle(el),backdrop=el.querySelector(':scope > .liquid-backdrop');
    return {radius:parseFloat(s.borderTopLeftRadius),filter:getComputedStyle(backdrop).backdropFilter,
      background:s.backgroundColor,opacity:getComputedStyle(backdrop).backgroundColor};
  });
}
(async()=>{
  let app,browser;
  try {
    const packaged=process.env.GLASS_TEST_PACKAGED;
    app=await electron.launch({executablePath:packaged || require('electron'),args:packaged?[]:[root],
      env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const page=await app.firstWindow(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
    await page.waitForURL('http://127.0.0.1:18793/**',{timeout:30000});await ready(page);
    await app.evaluate(({desktopCapturer})=>{
      global.__clearDesktopCaptures=0;
      const original=desktopCapturer.getSources.bind(desktopCapturer);
      desktopCapturer.getSources=(...args)=>{global.__clearDesktopCaptures++;return original(...args);};
    });
    await page.locator('#themeCycleBtn').click();await page.mouse.move(900,80);await settle(page);
    assert.match((await optics(page,'#themePopover')).filter,/url\(/,'Appearance popover uses the supplied component on whiteboard too');
    await change(page,'liquidDisplacement',95);
    await change(page,'liquidOpacity',.31);
    await change(page,'liquidEnabled',false);
    await page.locator('#themePopover [data-background-mode="none"]').click();
    await page.waitForFunction(()=>window.localAppearance.get().mode==='none' && window.liquidGlassSettings.get().enabled);
    assert.equal(await page.evaluate(()=>window.liquidGlassSettings.get().displacementScale),95,'Selecting none preserves optical parameters');
    assert.equal(await page.evaluate(()=>window.liquidGlassSettings.get().surfaceOpacity),.31);
    for(const selector of ['#page-home .card','.right-panel','#themePopover']) {
      const surface=await optics(page,selector+ (selector.endsWith('.card')?':first-child':''));
      assert.ok(surface.radius>=24,selector+' is rounded');
      assert.match(surface.filter,/url\(/,selector+' has upstream optics');
      assert.equal(surface.background,'rgba(0, 0, 0, 0)',selector+' has no opaque wrapper');
    }
    const clean=await page.evaluate(()=>({
      background:getComputedStyle(document.getElementById('localAppearanceBackground')).backgroundColor,
      overlay:getComputedStyle(document.getElementById('localAppearanceBackground'),'::after').content,
      shell:getComputedStyle(document.querySelector('.app-shell')).backgroundColor,
      native:document.body.dataset.nativeGlassMaterial,
      media:document.querySelectorAll('.appearance-custom-media').length
    }));
    assert.equal(clean.background,'rgba(255, 255, 255, 0.1)');
    assert.equal(clean.overlay,'none','None must not leave a full-window gray veil');
    assert.equal(clean.shell,'rgba(0, 0, 0, 0)');
    assert.equal(clean.native,'acrylic','Native blur must prevent other applications showing sharp text through the window');
    assert.equal(clean.media,0);
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>window.localAppearance.setTheme(theme),theme);await settle(page);
      const panel=await optics(page,'#themePopover');assert.ok(panel.radius>=24);assert.match(panel.filter,/url\(/);
      for(const selector of ['#themePanelCloseBtn','#themePopover [data-background-mode="none"]','#themePopover [data-background-upload]','#themePopover [data-background-blur]']) {
        assert.ok(await page.locator(selector).evaluate(el=>{
          const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight && (el===hit || el.contains(hit));
        }),selector+' remains clickable');
      }
      assert.equal(await page.evaluate(()=>document.body.dataset.nativeWindowShape),'native','Native composition owns the rounded outer edge');
      // An opaque test backing lets PNG viewers display alpha edges correctly.
      await page.evaluate(theme=>{
        const fixture=document.createElement('div');fixture.id='clearGlassVisualBacking';
        fixture.style.cssText='position:fixed;inset:0;z-index:0;pointer-events:none;background:'+(theme==='light'?'#dce7ef':'#24352f');
        document.body.prepend(fixture);
      },theme);
      await settle(page);
      await page.screenshot({path:path.join(results,'clear-glass-'+theme+'.png')});
      await page.evaluate(()=>document.getElementById('clearGlassVisualBacking').remove());
    }
    await page.evaluate(()=>{
      window.localAppearance.setTheme('light');
      const fixture=document.createElement('div');fixture.id='clearGlassOpticsFixture';
      fixture.style.cssText='position:fixed;inset:0;z-index:0;pointer-events:none;background:repeating-linear-gradient(90deg,#eecc77 0px,#eecc77 18px,#7799cc 18px,#7799cc 36px)';
      document.body.prepend(fixture);
    });
    await change(page,'liquidDisplacement',0);
    await page.waitForFunction(()=>document.querySelector('#themePopover feDisplacementMap')?.getAttribute('scale')==='0');await settle(page);
    const plain=PNG.sync.read(await page.locator('#themePopover').screenshot());
    await change(page,'liquidDisplacement',150);
    await page.waitForFunction(()=>document.querySelector('#themePopover feDisplacementMap')?.getAttribute('scale')==='-150');await settle(page);
    const distorted=PNG.sync.read(await page.locator('#themePopover').screenshot());
    let changed=0;
    for(let i=0;i<plain.data.length;i+=4)
      if(Math.abs(plain.data[i]-distorted.data[i])+Math.abs(plain.data[i+1]-distorted.data[i+1])+Math.abs(plain.data[i+2]-distorted.data[i+2])>15) changed++;
    assert.ok(changed>100,'The popover actually refracts internal content: '+changed);
    await page.locator('#themePopover').screenshot({path:path.join(results,'clear-glass-optical-proof.png')});
    await page.evaluate(()=>document.getElementById('clearGlassOpticsFixture').remove());
    await change(page,'liquidDisplacement',95);
    await page.reload();await ready(page);
    await page.waitForFunction(()=>document.querySelector('#page-home .card feDisplacementMap')?.getAttribute('scale')==='-23.75');
    assert.equal(await page.evaluate(()=>window.localAppearance.get().mode),'none','Clear mode survives reopening');
    for(let i=0;i<3;i++) {
      await page.evaluate(()=>window.localAppearance.setMode('board'));
      await page.waitForFunction(()=>!document.querySelector('#page-home .card>.liquid-backdrop'));
      await page.evaluate(()=>window.localAppearance.setMode('none'));
      await page.waitForSelector('#page-home .card>.liquid-backdrop',{state:'attached'});
    }
    await page.mouse.move(900,80);await settle(page);
    assert.equal(await page.locator('#page-home .card').first().locator(':scope>.liquid-glass-mount').count(),1,'Repeated switches never stack optical layers');
    assert.equal(await page.locator('#page-home .card').first().locator(':scope>.liquid-backdrop').count(),1);
    assert.equal(await page.locator('.main>.liquid-backdrop').count(),0,'No oversized lens surrounds the entire workspace');
    assert.ok(await page.locator('feDisplacementMap').count()<=15,'Clear mode uses only major surfaces with no per-button filters');
    await page.locator('#sidebar [data-page="history"]').click();
    await page.waitForFunction(()=>document.getElementById('page-history').classList.contains('active'));
    await page.locator('#sidebar [data-page="home"]').click();
    await page.waitForFunction(()=>document.getElementById('page-home').classList.contains('active'));
    await page.mouse.move(800,100);await settle(page);
    const button=page.locator('#page-home button.secondary').first();
    const rect=await button.boundingBox();
    const pointer={pointerType:'mouse',clientX:rect.x+8,clientY:rect.y+8,button:0,buttons:0};
    const layoutBefore=await button.evaluate(el=>({width:el.offsetWidth,height:el.offsetHeight,left:el.offsetLeft,top:el.offsetTop}));
    const countBefore=await page.locator('feDisplacementMap').count();
    await button.dispatchEvent('pointerover',pointer);await settle(page);
    assert.equal(await button.getAttribute('data-liquid-elastic'),'','Buttons receive elastic hover feedback');
    assert.notEqual(await button.evaluate(el=>getComputedStyle(el).scale),'1','Hover stretches the material');
    await button.dispatchEvent('pointerdown',{...pointer,buttons:1});await page.waitForTimeout(180);
    assert.ok(await button.evaluate(el=>parseFloat(getComputedStyle(el).scale)<1),'Press compresses the button');
    await button.dispatchEvent('pointerup',pointer);
    await button.dispatchEvent('pointerout',{...pointer,relatedTarget:null});await page.waitForTimeout(550);
    assert.deepEqual(await button.evaluate(el=>({width:el.offsetWidth,height:el.offsetHeight,left:el.offsetLeft,top:el.offsetTop})),layoutBefore,'Elastic feedback never changes layout');
    assert.equal(await button.getAttribute('data-liquid-elastic'),null,'Release settles and cleans up transforms');
    assert.equal(await page.locator('feDisplacementMap').count(),countBefore,'Hover never creates per-button optical components');
    await page.emulateMedia({reducedMotion:'reduce'});
    await button.dispatchEvent('pointerover',pointer);await settle(page);
    assert.equal(await button.getAttribute('data-liquid-elastic'),null,'Reduced motion disables deformation');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await change(page,'liquidElasticity',0);
    await button.dispatchEvent('pointerover',pointer);await settle(page);
    assert.equal(await button.getAttribute('data-liquid-elastic'),null,'Zero elasticity disables deformation');
    await change(page,'liquidElasticity',.2);
    await button.dispatchEvent('pointerover',pointer);await settle(page);
    await button.dispatchEvent('dragstart');
    assert.equal(await button.getAttribute('data-liquid-elastic'),null,'Dragging immediately cancels deformation');
    assert.equal(await app.evaluate(()=>global.__clearDesktopCaptures),0,'No desktop recording or frozen screenshot is introduced');

    browser=await chromium.launch({channel:'msedge',headless:true});
    for(const size of [{width:1280,height:800},{width:390,height:844}]) {
      const context=await browser.newContext({viewport:size,isMobile:size.width<768,hasTouch:size.width<768});
      const web=await context.newPage();await web.goto('http://127.0.0.1:18793/');await ready(web);
      await web.locator(size.width<768?'#mobileAppearanceBtn':'#themeCycleBtn').click();
      await web.locator('#themePopover [data-background-mode="none"]').click();await settle(web);
      assert.match((await optics(web,'#themePopover')).filter,/url\(/);
      assert.ok(await web.locator('#themePopover').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && el.scrollWidth<=el.clientWidth;}),'Clear panel fits '+size.width+'px viewport');
      await web.screenshot({path:path.join(results,'clear-glass-browser-'+size.width+'.png')});
      await context.close();
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'passed',transparent:clean,refractionPixelsChanged:changed,themes:2,browserWidths:[1280,390],desktopCaptures:0}));
  } finally {
    if(browser) await browser.close();if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-clear-glass-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
