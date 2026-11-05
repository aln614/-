'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron,chromium}=require('playwright');
const {PNG}=require('pngjs');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-legibility-'));
const data=path.join(temporary,'runtime'),results=path.join(root,'test-results');
fs.mkdirSync(data);fs.mkdirSync(results,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18795,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function seedMedia(page) {
  await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=120;canvas.height=160;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#9dbbc3';ctx.fillRect(0,0,120,160);
    ctx.fillStyle='#e8f1ee';ctx.fillRect(22,35,76,94);ctx.fillStyle='#347489';ctx.fillRect(30,43,60,78);
    recentUploadItems=Array.from({length:10},(_,i)=>({id:'fixture-'+i,name:i%2?'reference-material-with-long-filename-'+i+'.png':'Product '+(i+1)+'.png',source:i%3?'main':'ref',source_url:canvas.toDataURL()}));
    renderRecentUploadPanel();
  });
}
async function verifyTiles(page) {
  await seedMedia(page);
  await page.locator('#recentUploadGrid').scrollIntoViewIfNeeded();
  const tiles=await page.locator('#recentUploadGrid .recent-upload-item').evaluateAll(items=>items.map(el=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el),img=el.querySelector('img'),name=el.querySelector('.recent-upload-item-name');
    return {width:el.offsetWidth,height:el.offsetHeight,radius:parseFloat(s.borderTopLeftRadius),media:img.offsetHeight,name:name.offsetHeight,fit:getComputedStyle(img).objectFit,overflow:el.scrollWidth>el.clientWidth};
  }));
  assert.equal(tiles.length,10);
  for(const tile of tiles) {
    assert.equal(tile.radius,16,'Media buttons must not inherit pill radii');
    assert.equal(tile.height,156);assert.equal(tile.media,100);assert.equal(tile.name,32);
    assert.equal(tile.fit,'contain');assert.equal(tile.overflow,false);
  }
  assert.ok(await page.locator('#recentUploadGrid').evaluate(el=>el.scrollWidth<=el.clientWidth),'No horizontal clipping');
  return tiles[0];
}
(async()=>{
  let app,browser;
  try {
    const packaged=process.env.GLASS_TEST_PACKAGED;
    app=await electron.launch({executablePath:packaged||require('electron'),args:packaged?[]:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const page=await app.firstWindow();
    await page.waitForURL('http://127.0.0.1:18795/**',{timeout:30000});
    await page.waitForFunction(()=>window.localAppearance && window.desktopAppearance);
    await page.evaluate(()=>{window.localAppearance.setTheme('light');window.localAppearance.setMode('none');});
    await page.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='acrylic');
    await app.evaluate(async({BrowserWindow,desktopCapturer,screen})=>{
      global.__legibilityWindow=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http://127.0.0.1:18795/'));
      global.__legibilityCapture=desktopCapturer.getSources.bind(desktopCapturer);
      global.__legibilityApplicationCaptures=0;
      desktopCapturer.getSources=(...args)=>{global.__legibilityApplicationCaptures++;return global.__legibilityCapture(...args);};
      const area=screen.getPrimaryDisplay().workArea;
      const backdrop=new BrowserWindow({x:area.x,y:area.y,width:area.width,height:area.height,frame:false,alwaysOnTop:true,skipTaskbar:true});
      await backdrop.loadURL('data:text/html,'+encodeURIComponent('<style>html,body{margin:0;width:100%;height:100%}body{background:repeating-linear-gradient(90deg,#111 0 6px,#eee 6px 12px)}body.blue{background:#3060c0}body.green{background:#19be50}</style>'));
      global.__legibilityBackdrop=backdrop;
      const win=global.__legibilityWindow;win.setBounds({x:area.x+40,y:area.y+40,width:1180,height:820});
      win.setAlwaysOnTop(true);win.show();win.focus();win.moveTop();
    });
    const capture=()=>app.evaluate(async({screen})=>{
      const win=global.__legibilityWindow,bounds=win.getBounds(),display=screen.getDisplayMatching(bounds);
      const sources=await global.__legibilityCapture({types:['screen'],thumbnailSize:{width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)}});
      const source=sources.find(s=>s.display_id===String(display.id)),image=source.thumbnail,scale=image.getSize().width/display.bounds.width;
      return image.crop({x:Math.round((bounds.x-display.bounds.x)*scale),y:Math.round((bounds.y-display.bounds.y)*scale),width:Math.round(bounds.width*scale),height:Math.round(bounds.height*scale)}).toPNG().toString('base64');
    });
    // The strip has no DOM content: measure the real compositor, not CSS declarations.
    await page.addStyleTag({content:'.app-shell{visibility:hidden!important}'});
    await app.evaluate(()=>global.__legibilityWindow.hide());
    await pause(700);const raw=PNG.sync.read(Buffer.from(await capture(),'base64'));
    await app.evaluate(()=>{global.__legibilityWindow.show();global.__legibilityWindow.focus();global.__legibilityWindow.moveTop();});
    await pause(1000);const glass=PNG.sync.read(Buffer.from(await capture(),'base64'));
    fs.writeFileSync(path.join(results,'native-glass-raw-proof.png'),PNG.sync.write(raw));
    fs.writeFileSync(path.join(results,'native-glass-blurred-proof.png'),PNG.sync.write(glass));
    const contrast=image=>{
      const values=[];for(let x=200;x<700;x++) values.push(image.data[(120*image.width+x)*4]);
      return Math.max(...values)-Math.min(...values);
    };
    const before=contrast(raw),after=contrast(glass);
    console.log(JSON.stringify({desktopStripeContrast:{before,after}}));
    assert.ok(before>80,'Fixture exposes unblurred desktop stripes');
    assert.ok(after<before*.35,'DWM must suppress high-frequency desktop detail');
    assert.ok(Math.abs(raw.data[0]-glass.data[0])<20,'Native corner leaves desktop visible, without a square acrylic fill');
    await page.addStyleTag({content:'.app-shell{visibility:visible!important}'});
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>window.localAppearance.setTheme(theme),theme);
      await app.evaluate(()=>global.__legibilityBackdrop.webContents.executeJavaScript("document.body.className='blue'"));
      await pause(800);
      await page.evaluate(()=>{document.querySelector('.main').style.scrollBehavior='auto';document.querySelector('.main').scrollTop=0;});
      await page.mouse.move(1100,65);await pause(200);
      await seedMedia(page);
      fs.writeFileSync(path.join(results,'native-glass-'+theme+'.png'),Buffer.from(await capture(),'base64'));
      await verifyTiles(page);await pause(300);
      fs.writeFileSync(path.join(results,'native-recent-media-'+theme+'.png'),Buffer.from(await capture(),'base64'));
    }
    assert.equal(await app.evaluate(()=>global.__legibilityApplicationCaptures),0);
    await app.evaluate(()=>{global.__legibilityBackdrop.destroy();global.__legibilityWindow.setAlwaysOnTop(false);global.__legibilityWindow.hide();});
    browser=await chromium.launch({channel:'msedge',headless:true});
    for(const width of [1280,390]) {
      const context=await browser.newContext({viewport:{width,height:900},isMobile:width<768,hasTouch:width<768});
      const web=await context.newPage();
      const recentLoaded=web.waitForResponse(r=>r.url().endsWith('/api/recent_uploads'));
      await web.goto('http://127.0.0.1:18795/');await recentLoaded;
      await web.waitForTimeout(250);
      await web.waitForFunction(()=>window.localAppearance);
      await web.evaluate(()=>window.localAppearance.setMode('none'));
      const fallback=await web.locator('#localAppearanceBackground').evaluate(el=>getComputedStyle(el).backgroundColor);
      assert.match(fallback,/0\.94\)/,'Browser keeps a readable background without native blur');
      const tile=await verifyTiles(web);
      await web.screenshot({path:path.join(results,'recent-media-web-'+width+'.png')});
      console.log(JSON.stringify({width,tile,fallback}));await context.close();
    }
    console.log('Native desktop blur and recent media layout passed.');
  } finally {
    if(browser) await browser.close();if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-legibility-')||relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
