'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {_electron:electron,chromium}=require('playwright');
const {PNG}=require('pngjs');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-glass-continuity-'));
const runtime=path.join(temporary,'runtime');
const results=process.env.GLASS_CONTINUITY_SCREENSHOT_DIR || path.join(root,'test-results','glass-continuity');
fs.mkdirSync(runtime);fs.mkdirSync(results,{recursive:true});
fs.writeFileSync(path.join(runtime,'config.json'),JSON.stringify({port:18798,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,
  output_dir:path.join(temporary,'output'),asset_library_dir:path.join(temporary,'assets')}));
(async()=>{
  let app,browser;
  try {
    const packaged=process.env.GLASS_TEST_PACKAGED;
    app=await electron.launch({executablePath:packaged||require('electron'),args:packaged?['--background']:[root,'--background'],
      env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:runtime}});
    const startup=await app.firstWindow();
    await startup.waitForURL('http://127.0.0.1:18798/**',{timeout:30000});
    const opened=app.waitForEvent('window');opened.catch(()=>{});
    await app.evaluate(async({BrowserWindow,app})=>{
      global.__continuityWindow=new BrowserWindow({width:1480,height:960,show:false,frame:false,transparent:true,backgroundColor:'#00000000',
        webPreferences:{offscreen:true,backgroundThrottling:false,preload:process.getBuiltinModule('node:path').join(app.getAppPath(),'src/preload.js')}});
      await global.__continuityWindow.loadURL('http://127.0.0.1:18798/?continuity');
    });
    const page=await opened;
    await page.waitForFunction(()=>window.localAppearance && window.liquidGlassSettings);
    await page.evaluate(()=>{
      window.localAppearance.setMode('none');window.localAppearance.setTheme('dark');
      document.querySelector('#localAppearanceBackground').style.setProperty('background','rgba(24,26,32,.10)','important');
      document.getElementById('apiKey').value='fixture-not-submitted';
      document.getElementById('apiKeyWarning')?.remove();
      applyModelToUI('hy-image-v3.5-preview');
      const canvas=document.createElement('canvas');canvas.width=90;canvas.height=45;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#506a75';ctx.fillRect(0,0,90,45);
      const src=canvas.toDataURL();
      document.getElementById('miniImages').innerHTML=Array.from({length:6},()=>`<div class="mini-image-cell"><img class="mini-draggable-image" src="${src}" alt="fixture"><span class="mini-image-fallback">unavailable</span></div>`).join('');
    });
    await page.mouse.move(700,70);
    for(const theme of ['dark','light']) {
    await page.evaluate(theme=>window.localAppearance.setTheme(theme),theme);
    for(const zoom of [1,.8,1.25]) {
      await app.evaluate((_,zoom)=>{
        const win=global.__continuityWindow;
        win.webContents.setBackgroundThrottling(false);
        win.setSize(1480,960);win.webContents.setZoomFactor(zoom);
        win.webContents.send('desktop:visibility',true);
      },zoom);
      await page.waitForSelector('.right-panel > .liquid-backdrop',{state:'attached'});
      await page.waitForTimeout(900);
      const geometry=await page.evaluate(()=>{
        const host=document.querySelector('.right-panel');
        const backdrop=host.querySelector(':scope > .liquid-backdrop');
        const material=host.querySelector(':scope > .liquid-material');
        const stat=host.querySelector('.stats>div');
        const content=host.querySelector('#imageRealtimePanel');
        const edge=getComputedStyle(backdrop,'::after');
        return {box:host.getBoundingClientRect().toJSON(),backdrop:backdrop.getBoundingClientRect().toJSON(),
          panelBackground:getComputedStyle(host).backgroundColor,
          backdropBackground:getComputedStyle(backdrop).backgroundColor,
          borderWidth:getComputedStyle(host).borderTopWidth,hostShadow:getComputedStyle(host).boxShadow,
          hostEdgeDisplay:getComputedStyle(host,'::after').display,backdropPadding:getComputedStyle(backdrop).padding,
          backdropEdgeDisplay:edge.display,backdropEdgeContent:edge.content,
          statBackground:getComputedStyle(stat).backgroundColor,statShadow:getComputedStyle(stat).boxShadow,
          recentImageFit:getComputedStyle(document.querySelector('#miniImages img')).objectFit,
          padding:getComputedStyle(host).padding,overflow:getComputedStyle(host).overflowY,
          material:material && {box:material.getBoundingClientRect().toJSON(),filter:getComputedStyle(material).backdropFilter,zIndex:getComputedStyle(material).zIndex,background:getComputedStyle(material).backgroundColor},
          filter:getComputedStyle(backdrop).backdropFilter,viewport:{width:innerWidth,height:innerHeight},
          contentBottom:content.getBoundingClientRect().bottom};
      });
      const png=Buffer.from(await app.evaluate(async()=>{
        const win=global.__continuityWindow;
        return (await win.webContents.capturePage()).toPNG().toString('base64');
      }),'base64');
      fs.writeFileSync(path.join(results,`panel-${theme}-${zoom}.png`),png);
      const shot=PNG.sync.read(png);
      const scale=shot.width/geometry.viewport.width;
      const start=Math.ceil((geometry.box.x+geometry.box.width*.25)*scale),end=Math.floor((geometry.box.x+geometry.box.width*.75)*scale);
      const top=Math.ceil((geometry.contentBottom+30)*scale),bottom=Math.floor((geometry.box.bottom-35)*scale);
      const luminance=y=>{
        let total=0;for(let x=start;x<end;x++){const i=(y*shot.width+x)*4;total+=shot.data[i]*.2126+shot.data[i+1]*.7152+shot.data[i+2]*.0722;}
        return total/(end-start);
      };
      let maximum={change:0,y:0};
      for(let y=top+1;y<bottom;y++) {
        const change=Math.abs(luminance(y)-luminance(y-1));
        if(change>maximum.change)maximum={change,y};
      }
      console.log(JSON.stringify({theme,zoom,maximum,scanRows:bottom-top}));
      assert.ok(bottom-top>80,'Scan the actual empty panel, not its decorative backdrop');
      assert.match(geometry.filter,/url\(/,'Retain optical glass');
      assert.ok(geometry.material,'Separate continuous material is present');
      assert.equal(geometry.padding,'0px','The scroller owns padding without adding a second inset');
      assert.equal(geometry.overflow,'hidden','Desktop host does not scroll its glass');
      assert.match(geometry.material.filter,/blur\(/,'Material retains adjustable blur');
      assert.ok(!geometry.material.filter.includes('url('),'Only the optical edge uses SVG refraction');
      assert.equal(geometry.material.zIndex,'-1','Material remains behind content');
      assert.ok(Math.abs(geometry.material.box.height-geometry.backdrop.height)<1,'Material covers the whole panel');
      assert.equal(geometry.panelBackground,'rgba(0, 0, 0, 0)','Task panel has no separate opaque wrapper');
      assert.equal(geometry.backdropBackground,'rgba(0, 0, 0, 0)','Liquid backdrop does not paint a full-panel tint');
      assert.equal(geometry.borderWidth,'0px','Task rail has no outer border');
      assert.equal(geometry.hostShadow,'none','Task rail has no separate card shadow');
      assert.equal(geometry.hostEdgeDisplay,'none','Task rail has no decorative outer edge');
      assert.equal(geometry.backdropPadding,'0px','Task rail has no optical ring inset');
      assert.ok(geometry.backdropEdgeDisplay==='none' || geometry.backdropEdgeContent==='none','Task rail has no refractive edge highlight');
      assert.equal(geometry.statBackground,'rgba(0, 0, 0, 0)','Task statistics do not render as separate cards');
      assert.equal(geometry.statShadow,'none','Task statistics have no floating shadows');
      assert.equal(geometry.recentImageFit,'contain','Recent landscape and portrait thumbnails are not cropped');
      assert.notEqual(geometry.material.background,'rgba(0, 0, 0, 0)','Glass fill is retained');
      assert.ok(maximum.change<6,`Horizontal seam at zoom ${zoom}, row ${maximum.y}: ${maximum.change}`);
    }
    }
    const bounds=()=>page.evaluate(()=>{
      const panel=document.querySelector('.right-panel');
      return ['.liquid-material','.liquid-backdrop'].map(selector=>panel.querySelector(selector).getBoundingClientRect().toJSON());
    });
    const fixedBefore=await bounds();
    await page.evaluate(()=>{
      const fixture=document.createElement('div');fixture.id='scrollFixture';fixture.style.height='1600px';
      document.getElementById('imageTaskProgressPanel').appendChild(fixture);
      document.querySelector('.right-panel-content').scrollTop=400;
    });
    await page.waitForTimeout(350);
    assert.deepEqual(await bounds(),fixedBefore,'Scrolling tasks never moves or truncates the material or lens');
    assert.equal(await page.locator('.right-panel').evaluate(el=>el.scrollTop),0);
    assert.ok(await page.locator('.right-panel-content').evaluate(el=>el.scrollTop)>=399);
    await page.evaluate(()=>{document.getElementById('scrollFixture').remove();document.querySelector('.right-panel-content').scrollTop=0;});
    await page.locator('#collapsePanel').click();
    await page.waitForSelector('.right-panel.collapsed');
    await page.locator('#restorePanel').click();
    await page.waitForFunction(()=>!document.querySelector('.right-panel').classList.contains('collapsed'));
    for(let i=0;i<2;i++) {
      await page.evaluate(()=>window.localAppearance.setMode('board'));
      await page.waitForFunction(()=>!document.querySelector('.right-panel > .liquid-material'));
      await page.evaluate(()=>window.localAppearance.setMode('none'));
      await page.waitForSelector('.right-panel > .liquid-material',{state:'attached'});
      assert.equal(await page.locator('.right-panel > .liquid-material').count(),1,'Mode changes never stack materials');
    }
    for(const [id,value] of [['liquidBlur','1'],['liquidOpacity','0.2']]) {
      await page.evaluate(({id,value})=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));},{id,value});
    }
    assert.match(await page.locator('.liquid-material').evaluate(el=>getComputedStyle(el).backdropFilter),/blur\(36px\)/,'The existing blur setting still controls the material');
    const lowAlpha=await page.locator('.liquid-material').evaluate(el=>Number(getComputedStyle(el).backgroundColor.match(/,\s*([\d.]+)\)$/)?.[1]));
    await page.evaluate(()=>{const el=document.getElementById('liquidOpacity');el.value='.8';el.dispatchEvent(new Event('input',{bubbles:true}));});
    const highAlpha=await page.locator('.liquid-material').evaluate(el=>Number(getComputedStyle(el).backgroundColor.match(/,\s*([\d.]+)\)$/)?.[1]));
    assert.ok(lowAlpha>0 && lowAlpha<.02 && highAlpha>lowAlpha && highAlpha<.05,'The opacity setting controls a subtle task-panel tint: '+lowAlpha+' -> '+highAlpha);
    browser=await chromium.launch({channel:'msedge',headless:true});
    const web=await browser.newPage({viewport:{width:1480,height:960}});
    await web.goto('http://127.0.0.1:18798/');
    await web.waitForFunction(()=>window.localAppearance && window.liquidGlassSettings);
    await web.evaluate(()=>window.localAppearance.setMode('none'));
    await web.waitForSelector('.right-panel > .liquid-material',{state:'attached'});
    assert.equal(await web.locator('.right-panel-content').evaluate(el=>getComputedStyle(el).overflowY),'auto','Browser uses the same independent scroller');
    assert.equal(await web.locator('.right-panel').evaluate(el=>getComputedStyle(el).overflowY),'hidden','The material host never scrolls');
    await web.locator('#collapsePanel').click();await web.locator('#restorePanel').click();
    await web.waitForFunction(()=>!document.querySelector('.right-panel').classList.contains('collapsed'));
    console.log('Glass continuity passed: two themes, three zoom levels, scrolling, collapse/restore, settings, cleanup and browser controls; no visible test windows.');
  } finally {if(browser)await browser.close();if(app)await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
