'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PNG}=require('pngjs');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');

(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:800}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(`<!doctype html><html><body class="desktop-shell" data-background-mode="none">
      <div class="app-shell"><header class="topbar glass"><button id="top">Top</button></header>
      <aside class="sidebar glass" id="sidebar"><button>Navigation</button></aside>
      <main class="main"><section class="page active" id="page-home"><div class="grid"><div class="card">Content</div></div></section></main>
      <aside class="right-panel glass"><div class="panel-head"><strong>Tasks</strong><button id="toggle">Toggle</button></div></aside></div>
      </body></html>`);
    for(const file of ['src/renderer/static/style.css','src/renderer/static/sidebar.css','src/renderer/static/clear-glass.css']) {
      await page.addStyleTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    }
    await page.addStyleTag({content:'body{background:#b4c2cc!important}.app-shell{height:800px}.right-panel{min-height:500px}'});
    await page.addScriptTag({path:path.join(root,'src/renderer/static/liquid-glass-bundle.js')});
    await page.waitForSelector('.right-panel > .liquid-backdrop',{state:'attached'});
    await page.waitForTimeout(700);
    const selectors=['.topbar','.sidebar','.right-panel','#page-home .card'];
    const geometry=()=>page.evaluate(selectors=>selectors.map(selector=>{
      const host=document.querySelector(selector),layer=host.querySelector(':scope > .liquid-backdrop');
      const style=getComputedStyle(layer),rect=layer.getBoundingClientRect();
      return {selector,scale:style.scale,translate:style.translate,transform:style.transform,clip:style.clipPath,
        x:rect.x,y:rect.y,width:rect.width,height:rect.height,elastic:layer.hasAttribute('data-liquid-elastic')};
    }),selectors);
    const before=await geometry();
    const baseline=PNG.sync.read(await page.screenshot());
    const panel=await page.locator('.right-panel').boundingBox();
    for(const [x,y] of [[12,12],[panel.width-12,12],[12,panel.height-12],[panel.width-12,panel.height-12]]) {
      await page.mouse.move(panel.x+x,panel.y+y);
      await page.waitForTimeout(250);
      const current=await geometry();
      assert.deepEqual(current,before,'Glass backgrounds retain their geometry on hover');
    }
    const after=PNG.sync.read(await page.screenshot());
    for(const [x,y] of [[panel.x,panel.y],[panel.x+panel.width-24,panel.y],
      [panel.x,panel.y+panel.height-24],[panel.x+panel.width-24,panel.y+panel.height-24]]) {
      let total=0;
      for(let dy=0;dy<24;dy++) for(let dx=0;dx<24;dx++) {
        const index=(Math.floor(y+dy)*baseline.width+Math.floor(x+dx))*4;
        for(let c=0;c<3;c++) total+=Math.abs(baseline.data[index+c]-after.data[index+c]);
      }
      assert.ok(total<3000,'Hover does not alter the corner pixels: '+total);
    }
    await page.evaluate(()=>document.getElementById('toggle').addEventListener('click',()=>document.body.dataset.clicked='yes'));
    await page.locator('#toggle').click();
    assert.equal(await page.locator('body').getAttribute('data-clicked'),'yes');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'passed',surfaces:selectors.length,corners:4,clickable:true,headless:true}));
  } finally {
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
