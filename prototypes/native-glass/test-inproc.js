'use strict';
const path=require('path');
const fs=require('fs');
const os=require('os');
const {_electron:electron}=require('playwright');
const {PNG}=require('pngjs');
const root=path.resolve(__dirname,'../..');
const realUI=process.env.TENYING_TEST_REAL_UI==='1';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-inproc-test-'));
const data=path.join(temp,'data');fs.mkdirSync(data);
const metadata=path.join(path.dirname(require('electron')),'Microsoft.Graphics.Canvas.winmd');
if(fs.existsSync(metadata)) throw Error('Test metadata destination already exists');
fs.copyFileSync(path.join(os.tmpdir(),'tenying-composition-probe','Microsoft.Graphics.Canvas.winmd'),metadata,fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18819,shortcuts_enabled:false,update_auto_check:false,public_enabled:false}));
(async()=>{
 let app;
 try{
  app=await electron.launch({executablePath:require('electron'),args:[root,`--user-data-dir=${path.join(temp,'user')}`],env:{...process.env,APPDATA:temp,LOCALAPPDATA:temp,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
  const page=await app.firstWindow();await page.waitForURL('http://127.0.0.1:18819/**',{timeout:30000});
  await page.waitForFunction(()=>window.localAppearance);
  await page.evaluate(()=>{window.localAppearance.setTheme('light');window.localAppearance.setMode('none');});
  await page.waitForFunction(()=>document.body.dataset.nativeGlassMaterial==='acrylic');
  await app.evaluate(async({BrowserWindow},opts)=>{
   global.__compositionFixture=new BrowserWindow({width:1000,height:700,frame:false,transparent:true,backgroundColor:'#00000000',show:false,webPreferences:opts.realUI?{preload:opts.preload,contextIsolation:true,nodeIntegration:false,sandbox:false}:{}});
   await global.__compositionFixture.loadURL(opts.realUI?'http://127.0.0.1:18819/':'data:text/html,'+encodeURIComponent('<html style="background:transparent"><body style="background:transparent"><button id="control" style="position:absolute;left:20px;top:20px;width:140px;height:70px;background:rgb(255,0,0);color:white" onclick="document.title=\'clicked\'">TEST BUTTON</button></body></html>'));
  },{realUI,preload:path.join(root,'src/preload.js')});
  const result=await app.evaluate(({BrowserWindow},opts)=>{
   const k=process.getBuiltinModule('module').createRequire(process.execPath)(opts.koffi);
   const lib=k.load('mscoree.dll');
   const CorBind=lib.func('int32 CorBindToRuntimeEx(str16 version, str16 flavor, uint32 flags, void *clsid, void *iid, _Out_ void **host)');
   const guid=s=>{const b=Buffer.alloc(16),p=s.split('-');b.writeUInt32LE(parseInt(p[0],16),0);b.writeUInt16LE(parseInt(p[1],16),4);b.writeUInt16LE(parseInt(p[2],16),6);Buffer.from(p[3]+p[4],'hex').copy(b,8);return b;};
   const out=[null];
   const hr=CorBind('v4.0.30319','wks',0,guid('90f1a06e-7712-4762-86b5-7a5eba6bdb02'),guid('90f1a06c-7712-4762-86b5-7a5eba6bdb02'),out);
   if(hr) throw Error('CorBind '+(hr>>>0).toString(16));
   const host=out[0],vt=k.decode(host,'void *');
   const start=k.proto('int32 Start(void *host)');
   const run=k.proto('int32 Execute(void *host, str16 assembly, str16 type, str16 method, str16 arg, _Out_ uint32 *returnValue)');
   const st=k.call(k.decode(vt,3*8,'void *'),start,host);
   if(st) throw Error('CLR start '+(st>>>0).toString(16));
   const main=global.__compositionFixture;
   const handle=main.getNativeWindowHandle().readBigUInt64LE().toString();
   const retval=[0],argument=[handle,opts.manifest,opts.log].join('|');
   const rc=k.call(k.decode(vt,11*8,'void *'),run,host,opts.assembly,'NativeGlass','Init',argument,retval);
   global.__compositionTest={k,vt,run,host,handle,assembly:opts.assembly,main};
   return {rc:rc>>>0,result:retval[0]>>>0};
  },{koffi:path.join(root,'node_modules/koffi'),assembly:path.join(os.tmpdir(),'tenying-composition-probe',process.env.TENYING_TEST_SAFE_DLL==='1'?'inproc-safe.dll':'inproc.dll'),manifest:path.join(os.tmpdir(),'tenying-composition-probe','probe.exe.manifest'),log:path.join(temp,'native.log')});
  console.log(result,fs.existsSync(path.join(temp,'native.log'))?fs.readFileSync(path.join(temp,'native.log'),'utf8'):'');
  if(result.rc||result.result) throw Error('In-process initialization failed');
  if(process.env.TENYING_TEST_DISTORTION==='1') {
   const probe=await app.evaluate((_,log)=>{
    const c=global.__compositionTest,ret=[0];
    const hr=c.k.call(c.k.decode(c.vt,11*8,'void *'),c.run,c.host,c.assembly,'NativeGlass','TestDisplacement',log,ret);
    const transform=[0];
    const transformHr=c.k.call(c.k.decode(c.vt,11*8,'void *'),c.run,c.host,c.assembly,'NativeGlass','TestTransform',log,transform);
    return {displacement:{hr:hr>>>0,ret:ret[0]>>>0},transform:{hr:transformHr>>>0,ret:transform[0]>>>0}};
   },path.join(temp,'native.log'));
   console.log('Displacement support',probe,fs.readFileSync(path.join(temp,'native.log'),'utf8'));
   return;
  }
  await app.evaluate(async({BrowserWindow,screen})=>{
   const a=screen.getPrimaryDisplay().workArea;
   const bg=new BrowserWindow({x:a.x,y:a.y,width:a.width,height:a.height,frame:false,alwaysOnTop:true,skipTaskbar:true});
   await bg.loadURL('data:text/html,'+encodeURIComponent('<style>body{margin:0;background:repeating-linear-gradient(90deg,#111 0 6px,#eee 6px 12px)}</style>'));
   const m=global.__compositionTest.main;m.setBounds({x:a.x+40,y:a.y+40,width:1000,height:700});m.setAlwaysOnTop(true);m.show();m.focus();m.moveTop();
   global.__compositionTest.bg=bg;
  });
  const fixture=realUI?app.windows().filter(window=>window.url().startsWith('http://127.0.0.1:18819/')).at(-1):app.windows().find(window=>window.url().startsWith('data:text/html,'));
  if(!fixture) throw Error('Fixture window not found');
  if(realUI) {await fixture.waitForFunction(()=>window.localAppearance);await fixture.evaluate(()=>{window.localAppearance.setTheme('light');window.localAppearance.setMode('none');});await fixture.waitForTimeout(1000);}
  const setBlur=value=>app.evaluate((_,value)=>{
   const c=global.__compositionTest,ret=[0];
   const result=c.k.call(c.k.decode(c.vt,11*8,'void *'),c.run,c.host,c.assembly,'NativeGlass','SetBlur',`${c.handle}|${value}`,ret);
   return {hr:result>>>0,ret:ret[0]>>>0};
  },value);
  const capture=async()=>PNG.sync.read(Buffer.from(await app.evaluate(async({desktopCapturer,screen})=>{
   const w=global.__compositionTest.main,b=w.getBounds(),d=screen.getDisplayMatching(b);
   const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(d.bounds.width*d.scaleFactor),height:Math.round(d.bounds.height*d.scaleFactor)}});
   const im=sources.find(s=>s.display_id===String(d.id)).thumbnail,scale=im.getSize().width/d.bounds.width;
   return im.crop({x:Math.round((b.x-d.bounds.x)*scale),y:Math.round((b.y-d.bounds.y)*scale),width:Math.round(b.width*scale),height:Math.round(b.height*scale)}).toPNG().toString('base64');
  }),'base64'));
  const contrast=image=>{const values=[];for(let x=200;x<700;x++)values.push(image.data[(120*image.width+x)*4]);return Math.max(...values)-Math.min(...values);};
  console.log('set low',await setBlur(0));await page.waitForTimeout(900);const low=await capture();
  console.log('set high',await setBlur(30));await page.waitForTimeout(900);const high=await capture();
  if(realUI) {
   fs.writeFileSync(path.join(root,'test-results','inproc-real-low.png'),PNG.sync.write(low));
   fs.writeFileSync(path.join(root,'test-results','inproc-real-high.png'),PNG.sync.write(high));
   console.log('Real UI title',await fixture.title(),'viewport',await fixture.evaluate(()=>({w:innerWidth,h:innerHeight,mode:document.body.dataset.backgroundMode,material:document.body.dataset.nativeGlassMaterial})));
   const regionContrast=image=>{let min=255,max=0;for(let x=760;x<940;x++){const v=image.data[(150*image.width+x)*4];min=Math.min(min,v);max=Math.max(max,v);}return max-min;};
   console.log('Real UI pixel contrast',regionContrast(low),regionContrast(high));
   if(regionContrast(low)<8||regionContrast(high)>regionContrast(low)*.5)throw Error('Real UI did not show adjustable backdrop blur');
   await fixture.locator('[data-appearance-open]:visible').first().click();
   if(!await fixture.locator('#themePopover').isVisible())throw Error('Real UI appearance control did not open');
   await fixture.locator('#themePanelCloseBtn').click();
   await app.evaluate(()=>global.__compositionTest.bg.webContents.executeJavaScript("document.body.style.background='#1bc65a'"));
   await fixture.waitForTimeout(700);
   const changed=await capture(),p=(150*changed.width+800)*4;
   console.log('Real UI changed background pixel',Array.from(changed.data.subarray(p,p+3)));
   if(changed.data[p+1]-changed.data[p]<7 || changed.data[p+1]-changed.data[p] <= high.data[p+1]-high.data[p]+5)throw Error('Real UI backdrop did not update live');
   await app.evaluate(()=>global.__compositionTest.main.setBounds({x:100,y:100,width:1100,height:750}));
   await fixture.waitForTimeout(500);
   console.log('Real UI resized viewport',await fixture.evaluate(()=>[innerWidth,innerHeight]));
   if(await fixture.evaluate(()=>innerWidth)!==1100)throw Error('Real UI resize failed');
   await app.evaluate(()=>global.__compositionTest.main.maximize());
   await fixture.waitForTimeout(500);
   if(!await app.evaluate(()=>global.__compositionTest.main.isMaximized()))throw Error('Real UI maximize failed');
   await app.evaluate(()=>global.__compositionTest.main.unmaximize());
   await fixture.waitForTimeout(500);
   if(await app.evaluate(()=>global.__compositionTest.main.isMaximized()))throw Error('Real UI restore failed');
   await fixture.locator('[data-appearance-open]:visible').first().click();
   if(!await fixture.locator('#themePopover').isVisible())throw Error('Real UI control failed after resize and restore');
   console.log('Real UI interaction, live update, resize and maximize passed');
   if(process.env.TENYING_TEST_SAFE_DLL==='1') {
    const lifecycle=await app.evaluate(async({BrowserWindow})=>{
     const c=global.__compositionTest;
     const invoke=(method,arg)=>{const ret=[0],hr=c.k.call(c.k.decode(c.vt,11*8,'void *'),c.run,c.host,c.assembly,'NativeGlass',method,arg,ret);return {hr:hr>>>0,ret:ret[0]>>>0};};
     const second=new BrowserWindow({width:400,height:300,frame:false,transparent:true,show:false});
     await second.loadURL('data:text/html,<body style="background:transparent"><button>Second window</button></body>');
     const handle=second.getNativeWindowHandle().readBigUInt64LE().toString();
     const results=[invoke('AddWindow',handle),invoke('SetBlur',`${handle}|22`),invoke('RemoveWindow',handle),invoke('SetBlur',`${handle}|5`),invoke('AddWindow',handle),invoke('RemoveWindow',handle)];
     second.destroy();
     results.push(invoke('SetBlur',`${c.handle}|12`));
     return results;
    });
    console.log('Multiple window lifecycle',lifecycle);
    if(lifecycle.some((value,index)=>value.hr || (index===3?!value.ret:!!value.ret)))throw Error('Multiple window lifecycle failed');
   }
   return;
  }
  fs.writeFileSync(path.join(root,'test-results','inproc-low.png'),PNG.sync.write(low));
  fs.writeFileSync(path.join(root,'test-results','inproc-high.png'),PNG.sync.write(high));
  console.log('Pixel contrast',contrast(low),contrast(high));
  if(contrast(low)<60||contrast(high)>contrast(low)*.5)throw Error('Desktop blur did not visibly respond');
  const offset=(30*high.width+30)*4;
  console.log('Control pixel',Array.from(high.data.subarray(offset,offset+3)));
  if(high.data[offset]<180||high.data[offset+1]>100)throw Error('Foreground control was hidden or blurred by background layer');
  await fixture.locator('#control').click();
  if(await fixture.title()!=='clicked')throw Error('Foreground control did not receive click');
  await app.evaluate(()=>global.__compositionTest.bg.webContents.executeJavaScript("document.body.style.background='#1bc65a'"));
  await page.waitForTimeout(500);
  const green=await capture(),p=(120*green.width+500)*4;
  console.log('Changed background pixel',Array.from(green.data.subarray(p,p+3)));
  if(green.data[p+1]<green.data[p]+40)throw Error('Backdrop did not update live');
 }finally{
  if(app) await app.close();
  fs.unlinkSync(metadata);
  const relative=path.relative(os.tmpdir(),temp);if(!relative.startsWith('tenying-inproc-test-')||relative.includes(path.sep))throw Error('Unsafe cleanup');
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:6,retryDelay:200});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
