'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const {PNG} = require('pngjs');

const root = path.resolve(__dirname, '../..');
const native = path.join(os.tmpdir(), 'tenying-composition-probe');
const packaged = process.env.TENYING_TEST_PACKAGED === '1';
const hostDirectory=path.join(root,'dist-native-experimental-host','win-unpacked');
const clientDirectory=path.join(root,'lan-client','dist-native-experimental-client','win-unpacked');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-glass-integration-'));
const hostData = path.join(temp, 'host-data');
const clientData = path.join(temp, 'client-appdata', 'tenying-ai-lan-client');
const metadata = path.join(path.dirname(require('electron')), 'Microsoft.Graphics.Canvas.winmd');
fs.mkdirSync(hostData, {recursive:true});
fs.mkdirSync(clientData, {recursive:true});
if (!packaged) {
  if (fs.existsSync(metadata)) throw new Error('Metadata destination already exists');
  fs.copyFileSync(path.join(native, 'Microsoft.Graphics.Canvas.winmd'), metadata, fs.constants.COPYFILE_EXCL);
}
fs.writeFileSync(path.join(hostData, 'config.json'), JSON.stringify({
  port:18823, shortcuts_enabled:false, update_auto_check:false, public_enabled:false,
  asset_library_dir:path.join(temp,'assets'), output_dir:path.join(temp,'output')
}));
fs.writeFileSync(path.join(clientData, 'connection.json'), JSON.stringify({
  host_url:'http://127.0.0.1:18823', zoom_factor:1, shortcuts_enabled:false
}));
const env = {...process.env, TENYING_EXPERIMENTAL_NATIVE_GLASS:native};

async function check(app, page, label) {
  await page.waitForFunction(() => window.localAppearance && window.liquidGlassSettings);
  await page.evaluate(() => { window.localAppearance.setTheme('light'); window.localAppearance.setMode('none'); });
  await page.waitForFunction(() => document.body.dataset.nativeGlassMaterial === 'native-blur', null, {timeout:10000});
  await page.locator('[data-appearance-open]:visible').first().click();
  const slider = page.locator('#themePopover [data-shell-blur]');
  await slider.waitFor({state:'visible'});
  await app.evaluate(async({BrowserWindow,screen})=>{
    const area=screen.getPrimaryDisplay().workArea;
    const background=new BrowserWindow({x:area.x,y:area.y,width:area.width,height:area.height,frame:false,alwaysOnTop:true,skipTaskbar:true});
    await background.loadURL('data:text/html,<style>body{margin:0;background:repeating-linear-gradient(90deg,%23111 0 6px,%23eee 6px 12px)}</style>');
    const main=BrowserWindow.getAllWindows().find(window=>window!==background);
    main.setAlwaysOnTop(true);main.show();main.focus();main.moveTop();
    global.__glassTestBackground=background;
  });
  const capture=async()=>PNG.sync.read(Buffer.from(await app.evaluate(async({BrowserWindow,desktopCapturer,screen})=>{
    const win=BrowserWindow.getAllWindows().find(window=>window!==global.__glassTestBackground), bounds=win.getBounds();
    global.__glassTestBackground.moveTop();win.moveTop();
    await new Promise(resolve=>setTimeout(resolve,200));
    const display=screen.getDisplayMatching(bounds);
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)}});
    const image=sources.find(source=>source.display_id===String(display.id)).thumbnail;
    const scale=image.getSize().width/display.bounds.width;
    return image.crop({x:Math.round((bounds.x-display.bounds.x)*scale),y:Math.round((bounds.y-display.bounds.y)*scale),width:Math.round(bounds.width*scale),height:Math.round(bounds.height*scale)}).toPNG().toString('base64');
  }),'base64'));
  await slider.fill('0');
  await page.waitForFunction(() => window.localAppearance.get().shellBlur === 0);
  await page.waitForTimeout(600);
  const low=await capture();
  await slider.fill('30');
  await page.waitForFunction(() => window.localAppearance.get().shellBlur === 30);
  await page.waitForTimeout(600);
  const high=await capture();
  let difference=0,samples=0;
  for(let y=80;y<Math.min(low.height,high.height)-40;y+=7) for(let x=80;x<Math.min(low.width,high.width)-40;x+=7) {
    const a=(y*low.width+x)*4,b=(y*high.width+x)*4;
    difference+=Math.abs(low.data[a]-high.data[b]);samples++;
  }
  console.log(label,'screen pixel mean difference',difference/samples);
  assert.ok(difference/samples>1,'Changing the shell blur should change screen pixels');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window!==global.__glassTestBackground).hide());
  await page.waitForTimeout(400);
  const backing=await capture();
  await app.evaluate(({BrowserWindow})=>{
    const main=BrowserWindow.getAllWindows().find(window=>window!==global.__glassTestBackground);
    main.show();main.moveTop();
  });
  await page.waitForTimeout(500);
  const rounded=await capture();
  let cornerDifference=0,cornerSamples=0;
  for(const [originX,originY] of [[0,0],[rounded.width-5,0],[0,rounded.height-5],[rounded.width-5,rounded.height-5]]) {
    for(let y=1;y<4;y++) for(let x=1;x<4;x++) {
      const index=((originY+y)*rounded.width+originX+x)*4;
      for(let channel=0;channel<3;channel++) cornerDifference+=Math.abs(backing.data[index+channel]-rounded.data[index+channel]);
      cornerSamples+=3;
    }
  }
  console.log(label,'corner difference from uncovered background',cornerDifference/cornerSamples);
  assert.ok(cornerDifference/cornerSamples<20,'Window corners should not leave opaque square artifacts');
  await app.evaluate(()=>global.__glassTestBackground.webContents.executeJavaScript("document.body.style.background='#1bc65a'"));
  let tint=0,changed;
  for(let attempt=0;attempt<8;attempt++) {
    await page.waitForTimeout(400);
    changed=await capture();
    tint=0;
    for(let y=80;y<Math.min(high.height,changed.height)-40;y+=7) for(let x=80;x<Math.min(high.width,changed.width)-40;x+=7) {
      const a=(y*high.width+x)*4,b=(y*changed.width+x)*4;
      tint+=(changed.data[b+1]-changed.data[b])-(high.data[a+1]-high.data[a]);
    }
    if(tint/samples>0.5) break;
  }
  console.log(label,'live background green change',tint/samples);
  assert.ok(tint/samples>0.5,'Changing the background should update screen pixels');
  await app.evaluate(()=>{global.__glassTestBackground.destroy();delete global.__glassTestBackground;});
  await page.locator('#themePanelCloseBtn').click();
  await page.evaluate(()=>{
    window.__dragEvents=[];
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']) {
      document.addEventListener(type,event=>{
        if(window.__dragEvents.length<30) window.__dragEvents.push({type,target:event.target?.outerHTML?.slice(0,180),x:event.screenX,y:event.screenY,button:event.button});
      },true);
    }
  });
  const drag=await app.evaluate(async({BrowserWindow,screen},koffiPath)=>{
    const window=BrowserWindow.getAllWindows()[0],before=window.getBounds();
    window.show();window.focus();window.moveTop();
    await new Promise(resolve=>setTimeout(resolve,300));
    const display=screen.getDisplayMatching(before),scale=display.scaleFactor;
    const koffi=process.getBuiltinModule('module').createRequire(process.execPath)(koffiPath);
    const user=koffi.load('user32.dll');
    const position=user.func('bool SetCursorPos(int x,int y)');
    const mouse=user.func('void mouse_event(uint32 flags,uint32 dx,uint32 dy,uint32 data,uintptr_t extra)');
    const x=Math.round((before.x+85)*scale),y=Math.round((before.y+29)*scale);
    position(x,y);
    await new Promise(resolve=>setTimeout(resolve,120));
    mouse(2,0,0,0,0);
    await new Promise(resolve=>setTimeout(resolve,120));
    for(let i=1;i<=8;i++){position(x+i*8,y+i*5);await new Promise(resolve=>setTimeout(resolve,50));}
    mouse(4,0,0,0,0);
    await new Promise(resolve=>setTimeout(resolve,300));
    return {before,after:window.getBounds()};
  },path.join(root,'node_modules/koffi'));
  console.log(label,'physical drag',drag.before.x,drag.before.y,'=>',drag.after.x,drag.after.y);
  if(drag.before.x===drag.after.x && drag.before.y===drag.after.y) console.log(label,'drag events',await page.evaluate(()=>window.__dragEvents));
  assert.ok(drag.before.x!==drag.after.x || drag.before.y!==drag.after.y,'Window should move when dragged');
  const internal = await page.evaluate(() => window.liquidGlassSettings.get().blurAmount);
  await page.evaluate(() => window.localAppearance.setMode('board'));
  await page.waitForFunction(() => document.body.dataset.nativeGlassMaterial === 'none');
  await page.evaluate(() => window.localAppearance.setMode('none'));
  await page.waitForFunction(() => document.body.dataset.nativeGlassMaterial === 'native-blur');
  assert.equal(await page.evaluate(() => window.localAppearance.get().shellBlur), 30);
  assert.equal(await page.evaluate(() => window.liquidGlassSettings.get().blurAmount), internal);
  for(let i=0;i<5;i++) {
    await page.evaluate(()=>window.localAppearance.setMode('board'));
    await page.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='none');
    await page.evaluate(()=>window.localAppearance.setMode('none'));
    await page.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='native-blur');
  }
  await page.reload();
  await page.waitForFunction(()=>window.localAppearance && document.body.dataset.nativeGlassMaterial==='native-blur',{timeout:15000});
  assert.equal(await page.evaluate(()=>window.localAppearance.get().shellBlur),30);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].maximize());
  await page.waitForTimeout(400);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized()),true);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].unmaximize());
  await page.waitForTimeout(400);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized()),false);
  assert.equal(await page.evaluate(()=>document.body.dataset.nativeGlassMaterial),'native-blur');
  await page.screenshot({path:path.join(root, 'test-results', `integration-${label}.png`)});
  for(const [kind,button] of [['asset','#assetLibraryBtn'],['prompt','#promptLibraryBtn']]) {
    const opening=app.waitForEvent('window');
    await page.locator(button).click();
    const library=await opening;
    await library.waitForURL(`**/?library=${kind}`);
    await library.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='native-blur',{timeout:15000});
    assert.equal(await library.evaluate(()=>window.localAppearance.get().shellBlur),30);
    console.log(label,kind,'standalone window acquired the native backdrop');
    await app.evaluate(({BrowserWindow},url)=>{
      const window=BrowserWindow.getAllWindows().find(candidate=>candidate.webContents.getURL().endsWith(url));
      if(window) window.destroy();
    },`/?library=${kind}`);
  }
  console.log(label, 'slider, independent settings, and mode switching passed');
}

(async () => {
  let host, client;
  try {
    host = await electron.launch({
      executablePath:packaged?path.join(hostDirectory,'TENYING_AI.exe'):require('electron'), args:packaged?[`--user-data-dir=${path.join(temp,'host-user')}`]:[root, `--user-data-dir=${path.join(temp,'host-user')}`],
      env:{...env, TENYING_EXPERIMENTAL_NATIVE_GLASS:packaged?path.join(hostDirectory,'resources','native-glass'):native, APPDATA:path.join(temp,'host-appdata'), LOCALAPPDATA:path.join(temp,'host-local'), LOCAL_API_IMAGE_GENERATOR_DATA_DIR:hostData}
    });
    host.process().stderr?.on('data',data=>process.stderr.write(`[host] ${data}`));
    const hostPage = await host.firstWindow();
    await hostPage.waitForURL('http://127.0.0.1:18823/**', {timeout:30000});
    await check(host, hostPage, 'host');
    client = await electron.launch({
      executablePath:packaged?path.join(clientDirectory,'TENYING_AI_LAN_Client.exe'):require('electron'), args:packaged?[`--user-data-dir=${clientData}`]:[path.join(root,'lan-client'), `--user-data-dir=${clientData}`],
      env:{...env, TENYING_EXPERIMENTAL_NATIVE_GLASS:packaged?path.join(clientDirectory,'resources','native-glass'):native, APPDATA:path.join(temp,'client-appdata'), LOCALAPPDATA:path.join(temp,'client-local')}
    });
    client.process().stderr?.on('data',data=>process.stderr.write(`[client] ${data}`));
    const clientPage = await client.firstWindow();
    await clientPage.waitForURL('http://127.0.0.1:18823/**', {timeout:30000});
    await clientPage.waitForFunction(() => document.body.classList.contains('lan-desktop-shell'));
    await check(client, clientPage, 'client');
  } catch(error) {
    for(const directory of [hostData,path.join(temp,'host-user'),clientData]) {
      const log=path.join(directory,'native-glass.log');
      if(fs.existsSync(log)) console.error('Native diagnostics:',fs.readFileSync(log,'utf8'));
    }
    throw error;
  } finally {
    if (client) await client.close();
    if (host) await host.close();
    if (!packaged) fs.unlinkSync(metadata);
    const relative = path.relative(os.tmpdir(), temp);
    if (!relative.startsWith('tenying-glass-integration-') || relative.includes(path.sep)) throw new Error('Unsafe cleanup');
    fs.rmSync(temp, {recursive:true, force:true, maxRetries:6, retryDelay:200});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
