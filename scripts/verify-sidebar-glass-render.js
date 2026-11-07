'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const {PNG}=require('pngjs');
const root=path.resolve(__dirname,'..');
const render=path.join(root,'src','renderer');
const outputs=path.join(root,'test-results');
const types={'.css':'text/css','.js':'application/javascript','.html':'text/html','.png':'image/png','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')) {res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');return;}
  const file=url.pathname==='/' ? path.join(render,'index.html') : path.join(render,url.pathname.slice(1));
  if(!file.startsWith(render+path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':types[path.extname(file)] || 'application/octet-stream'});fs.createReadStream(file).pipe(res);
});
(async()=>{
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1480,height:960},deviceScaleFactor:1});
    await page.addInitScript(()=>{
      localStorage.setItem('tenying-local-appearance-v1',JSON.stringify({theme:'dark',mode:'none',blur:0}));
      window.mainWindowControls={onState(){},action:async()=>({maximized:false})};
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>document.querySelector('#sidebar .liquid-backdrop') && window.liquidGlassSettings,{timeout:15000});
    await page.evaluate(()=>{
      const background=document.querySelector('#localAppearanceBackground');
      background.style.setProperty('background','repeating-linear-gradient(0deg,#3e4e58 0px,#3e4e58 50px,#53636d 50px,#53636d 100px)','important');
    });
    await page.mouse.move(700,60);await page.waitForTimeout(500);
    const sidebar=page.locator('#sidebar');
    const snapshot=async(name)=>{
      const data=await sidebar.screenshot();fs.mkdirSync(outputs,{recursive:true});fs.writeFileSync(path.join(outputs,name),data);return PNG.sync.read(data);
    };
    const at=async(value)=>{
      await page.evaluate(value=>{const input=document.getElementById('liquidDisplacement');input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},value);
      await page.waitForFunction(value=>document.querySelector('#sidebar feDisplacementMap')?.getAttribute('scale')===String(-value),value);
      await page.waitForTimeout(500);
    };
    await at(0);const flat=await snapshot('sidebar-isolated-flat.png');
    await at(100);const distorted=await snapshot('sidebar-isolated-refraction.png');
    assert.equal(flat.width,distorted.width);assert.equal(flat.height,distorted.height);
    let changed=0;for(let i=0;i<flat.data.length;i+=4) if(Math.abs(flat.data[i]-distorted.data[i])+Math.abs(flat.data[i+1]-distorted.data[i+1])+Math.abs(flat.data[i+2]-distorted.data[i+2])>15)changed++;
    assert.ok(changed>30,'Adjusting displacement must visibly change sidebar pixels');
    await sidebar.hover();await page.waitForTimeout(600);
    const filter=await sidebar.locator('.liquid-backdrop').evaluate(el=>getComputedStyle(el).backdropFilter);
    assert.match(filter,/url\(/,'Expanded sidebar retains optical refraction');
    await snapshot('sidebar-isolated-expanded.png');
    const props=await sidebar.evaluate(el=>{
      const host=el.getBoundingClientRect(),back=el.querySelector('.liquid-backdrop').getBoundingClientRect();
      const nav=el.querySelector('.nav-stack').getBoundingClientRect(),bottom=el.querySelector('.nav-bottom').getBoundingClientRect();
      return {host:{x:host.x,y:host.y,width:host.width,height:host.height},back:{x:back.x,y:back.y,width:back.width,height:back.height},nav:{bottom:nav.bottom},bottom:{top:bottom.top},filter:getComputedStyle(el.querySelector('.liquid-backdrop')).backdropFilter};
    });
    assert.ok(Math.abs(props.host.width-props.back.width)<3,'Lens follows expanded sidebar width');
    console.log(JSON.stringify({changed,props}));
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
