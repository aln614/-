'use strict';
// Composite synthetic windows over a known backdrop, without capturing user content.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-native-glass-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18770,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,output_dir:path.join(temporary,'output')}));
(async()=>{
  let instance;
  try {
    instance=await electron.launch({executablePath:require('electron'),args:[root,'--background'],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    await (await instance.firstWindow()).waitForURL('http://127.0.0.1:18770/**',{timeout:30000});
    const results=await instance.evaluate(async({BrowserWindow,screen,desktopCapturer})=>{
      const fs=process.getBuiltinModule('fs'), path=process.getBuiltinModule('path');
      const display=screen.getPrimaryDisplay(), area=display.workArea;
      const x=area.x+60,y=area.y+60,width=800,height=560;
      const backdrop=new BrowserWindow({x,y,width,height,frame:false,alwaysOnTop:true,skipTaskbar:true,backgroundColor:'#38c68b',webPreferences:{nodeIntegration:false,contextIsolation:true}});
      const pause=ms=>new Promise(r=>setTimeout(r,ms));
      await backdrop.loadURL('data:text/html,'+encodeURIComponent('<style>html,body{margin:0;background:#38c68b;height:100%;}body{background-image:linear-gradient(90deg,transparent 49%,#567bd4 49%,#567bd4 51%,transparent 51%);background-size:80px 80px}</style>'));
      backdrop.show();
      const samples=[];
      for(const variant of [
        {name:'acrylic-transparent',transparent:true,thickFrame:true,material:'acrylic'},
        {name:'acrylic-opaque',transparent:false,thickFrame:true,material:'acrylic'},
        {name:'transparent-only',transparent:true,thickFrame:false}
      ]){
        const panel=new BrowserWindow({x:x+80,y:y+80,width:640,height:400,frame:false,show:false,skipTaskbar:true,alwaysOnTop:true,transparent:variant.transparent,thickFrame:variant.thickFrame,backgroundColor:'#00000000'});
        if(variant.material) panel.setBackgroundMaterial(variant.material);
        const radius=20,rects=[{x:0,y:radius,width:640,height:400-radius*2}];
        for(let row=0;row<radius;row++){
          const inset=Math.ceil(radius-Math.sqrt(radius*radius-(radius-row-.5)**2));
          rects.push({x:inset,y:row,width:640-inset*2,height:1},{x:inset,y:399-row,width:640-inset*2,height:1});
        }
        panel.setShape(rects);
        await panel.loadURL('data:text/html,'+encodeURIComponent('<style>html,body{margin:0;background:transparent;height:100%;}div{box-sizing:border-box;height:100%;border-radius:20px;background:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.8);}</style><div></div>'));
        panel.show();panel.moveTop();
        await pause(700);
        const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)}});
        const source=sources.find(s=>s.display_id===String(display.id));
        if(!source) throw Error('Test display not found');
        const sx=source.thumbnail.getSize().width/display.bounds.width;
        const crop=source.thumbnail.crop({x:Math.round((x-display.bounds.x+60)*sx),y:Math.round((y-display.bounds.y+60)*sx),width:Math.round(680*sx),height:Math.round(440*sx)});
        const bitmap=crop.toBitmap(),size=crop.getSize();
        const pixel=(px,py)=>{const i=(Math.round(py*sx)*size.width+Math.round(px*sx))*4;return [bitmap[i+2],bitmap[i+1],bitmap[i]];};
        const outside=pixel(5,5),corner=pixel(21,21),center=pixel(80,80);
        if(Math.abs(outside[0]-56)>5 || Math.abs(outside[1]-198)>5 || Math.abs(outside[2]-139)>5) throw Error('Controlled backdrop is obscured; refusing screenshot');
        const output=path.join(process.cwd(),'test-results','native-'+variant.name+'.png');
        fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,crop.toPNG());
        samples.push({variant:variant.name,outside,corner,center,scale:display.scaleFactor});
        panel.destroy();
      }
      backdrop.destroy();
      return samples;
    });
    console.log(JSON.stringify(results,null,2));
    const clean=results.find(r=>r.variant==='transparent-only');
    assert.deepEqual(clean.corner,clean.outside,'Transparent corners must show the test backdrop');
    const main=await instance.firstWindow();
    for(const kind of ['asset','prompt']){
      await main.evaluate(kind=>window.libraryPanel.open(kind),kind);
      let page;
      for(let i=0;i<100 && !page;i++){page=instance.windows().find(p=>p.url().includes('library='+kind));if(!page)await new Promise(r=>setTimeout(r,100));}
      assert.ok(page,kind+' window opens');
      await page.waitForSelector('body.standalone-'+kind+' #'+kind+'LibraryLayer.active');
      const native=await instance.evaluate(async({BrowserWindow,screen,desktopCapturer},kind)=>{
        const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path');
        const display=screen.getPrimaryDisplay(),work=display.workArea,baseX=work.x+20,baseY=work.y+20;
        const backdrop=new BrowserWindow({x:baseX,y:baseY,width:900,height:620,frame:false,alwaysOnTop:true,skipTaskbar:true,backgroundColor:'#38c68b'});
        await backdrop.loadURL('data:text/html,'+encodeURIComponent('<style>html,body{margin:0;width:100%;height:100%;background:#38c68b}.pattern{position:absolute;left:150px;right:100px;top:120px;bottom:100px;background:repeating-linear-gradient(90deg,#e44 0 10px,#49f 10px 20px)}</style><div class="pattern"></div>'));
        backdrop.show();
        const panel=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('library='+kind));
        panel.setBounds({x:baseX+50,y:baseY+50,width:800,height:520});
        panel.setAlwaysOnTop(true);panel.show();panel.moveTop();
        await new Promise(r=>setTimeout(r,900));
        const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)}});
        const image=sources.find(s=>s.display_id===String(display.id)).thumbnail;
        const ratio=image.getSize().width/display.bounds.width;
        const crop=image.crop({x:Math.round((baseX-display.bounds.x+30)*ratio),y:Math.round((baseY-display.bounds.y+30)*ratio),width:Math.round(840*ratio),height:Math.round(560*ratio)});
        const bitmap=crop.toBitmap(),size=crop.getSize();
        const pixel=(x,y)=>{const i=(Math.round(y*ratio)*size.width+Math.round(x*ratio))*4;return [bitmap[i+2],bitmap[i+1],bitmap[i]];};
        const stripeSamples=[pixel(390,300),pixel(400,300),pixel(410,300),pixel(420,300)];
        const result={background:pixel(4,4),corners:[pixel(20,20),pixel(819,20),pixel(20,539),pixel(819,539)],center:pixel(400,300),stripeSamples};
        if(result.background[0]!==56 || result.background[1]!==198 || result.background[2]!==139) throw Error('Controlled backdrop was obscured');
        fs.writeFileSync(path.join(process.cwd(),'test-results','native-real-'+kind+'.png'),crop.toPNG());
        panel.setAlwaysOnTop(false);panel.hide();backdrop.destroy();
        return result;
      },kind);
      for(const corner of native.corners) assert.deepEqual(corner,native.background,kind+' corner must be transparent');
      assert.notDeepEqual(native.center,native.background,kind+' panel must be visible');
      const bodyBackground=await page.evaluate(()=>getComputedStyle(document.body).backgroundImage);
      assert.match(bodyBackground,/^url\(/,kind+' must sample the desktop behind the standalone window');
      console.log(kind+' real window pixels:',JSON.stringify(native));
    }
  } finally {
    if(instance) await instance.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-native-glass-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
