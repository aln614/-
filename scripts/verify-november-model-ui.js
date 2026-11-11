'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron:electron, chromium} = require('playwright');
const {createFallbackPricingCatalog} = require('../src/services/apimartPricing');

const root = path.resolve(__dirname,'..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'tenying-november-model-ui-'));
const runtime = path.join(temporary,'runtime');
const output = path.join(root,'test-results','november-model-ui');
fs.mkdirSync(runtime);
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(runtime,'config.json'),JSON.stringify({
  port:18797,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,
  output_dir:path.join(temporary,'outputs'),asset_library_dir:path.join(temporary,'assets')
}));

(async()=>{
  let app, browser;
  try {
    const packaged = process.env.MODEL_TEST_PACKAGED;
    app = await electron.launch({executablePath:packaged || require('electron'),args:packaged ? ['--background'] : [root,'--background'],
      env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:runtime}});
    const native = await app.firstWindow();
    await native.waitForURL('http://127.0.0.1:18797/**',{timeout:30000});
    browser = await chromium.launch({channel:'msedge',headless:true});
    const prices = createFallbackPricingCatalog();
    for (const [name,page,width] of [['host',native,1480],['browser',await browser.newPage(),640]]) {
      const errors = [];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/api/apimart/pricing**',route=>route.fulfill({json:prices}));
      await page.route('**/api/chat_models**',route=>route.fulfill({json:{models:[]}}));
      if(name==='browser') await page.goto('http://127.0.0.1:18797/');
      await page.waitForFunction(()=>typeof applyModelToUI==='function' && typeof currentApimartVideoRule==='function');
      await page.setViewportSize({width,height:1000});
      await page.evaluate(catalog=>{apimartPricingState={...catalog,modelAliases:catalog.model_aliases,status:'ready'};},prices);
      for (const model of ['gpt-image-2.6-flare','gpt-image-2.6-sunburst','gpt-image-2.6-ext','gpt-image-2.6-ext-sunburst','hy-image-v3.5-preview','muse-image-ext','seedream-5-5']) {
        await page.selectOption('#modelPreset',model);
        const state = await page.evaluate(()=>({model:$('#model').value,clarity:$('#clarity').value,disabled:$('#clarity').disabled,
          n:Number($('#imageN').value),qualityVisible:$('#officialImageOptions3').style.display!=='none',sizes:[...$('#size').options].map(x=>x.value)}));
        assert.equal(state.model,model);
        if(model==='muse-image-ext') {
          assert.equal(state.disabled,true);
          assert.equal(state.clarity,'auto');
          assert.ok(!state.sizes.includes('custom'));
        } else assert.equal(state.disabled,false);
        if(model==='seedream-5-5') {
          assert.equal(state.n,1);
          assert.ok(state.sizes.includes('custom'));
          assert.ok(state.sizes.includes('21:9'));
          assert.equal(await page.locator('#officialImageOptions').isVisible(),true);
        }
        if(model.includes('gpt-image')) assert.equal(state.qualityVisible,true);
        if(model.includes('-ext') || model.startsWith('hy-')) assert.equal(state.n,1);
      }
      await page.selectOption('#modelPreset','hy-image-v3.5-preview');
      await page.selectOption('#size','custom');
      await page.fill('#customWidth','2048'); await page.fill('#customHeight','2048');
      await page.evaluate(()=>updateSizeHint());
      assert.equal(await page.inputValue('#size'),'custom','HY custom pixel dimensions must survive UI guards');
      await page.selectOption('#modelPreset','gpt-image-2.6-ext-sunburst');
      await page.selectOption('#clarity','2K');
      await page.selectOption('#imageQuality','max');
      await page.evaluate(()=>renderModelUsageEstimate());
      const imageCost = await page.evaluate(()=>getCurrentModelUsageContext());
      assert.equal(imageCost.variant.credits,0.3);
      await page.selectOption('#modelPreset','gpt-image-2.6-flare');
      await page.selectOption('#outputFormat','gif');
      assert.equal(await page.locator('#gpt26GifFrames').isVisible(),true);
      await page.screenshot({path:path.join(output,`${name}-gpt26-gif.png`)});
      await page.selectOption('#outputFormat','svg');
      assert.equal(await page.locator('#gpt26SvgModel').isVisible(),true);
      assert.equal(await page.inputValue('#imageN'),'1');
      assert.equal(await page.locator('#imageN option[value="2"]').isDisabled(),true);
      await page.screenshot({path:path.join(output,`${name}-gpt26-svg.png`)});
      await page.selectOption('#outputFormat','png');
      await page.selectOption('#gpt26EditMode','markup');
      assert.equal(await page.locator('#gpt26EditFile').isVisible(),true);
      await page.screenshot({path:path.join(output,`${name}-gpt26-markup.png`)});
      await page.selectOption('#modelPreset','gpt-image-2.6-ext');
      assert.equal(await page.locator('#outputFormat option[value="svg"]').isDisabled(),true);
      await page.selectOption('#outputFormat','gif');
      assert.equal(await page.evaluate(()=>getCurrentModelUsageContext().formatPricingUnknown),true);
      await page.selectOption('#outputFormat','png');
      await page.selectOption('#modelPreset','gemini-3.1-flash-image-preview');
      assert.equal(await page.locator('#outputFormat option[value="gif"]').isDisabled(),true);
      await page.screenshot({path:path.join(output,`${name}-image.png`)});
      await page.selectOption('#modelPreset','seedream-5-5');
      await page.selectOption('#clarity','1.5K');
      await page.selectOption('#size','custom');
      await page.fill('#customWidth','2048'); await page.fill('#customHeight','1024');
      await page.evaluate(()=>updateSizeHint());
      assert.equal(await page.inputValue('#size'),'custom','Seedream 5.5 valid custom pixels must survive UI guards');
      await page.selectOption('#outputFormat','jpeg');
      await page.selectOption('#imageBackground','transparent');
      assert.equal(await page.inputValue('#outputFormat'),'png','transparent Seedream output must use PNG');
      assert.equal(await page.locator('#outputFormat option[value="jpeg"]').isDisabled(),true);
      assert.equal(await page.locator('#outputFormat option[value="webp"]').isDisabled(),true);
      assert.match(await page.locator('#sizeHint').innerText(),/不提交 resolution/);
      assert.doesNotMatch(await page.locator('#sizeHint').innerText(),/resolution=1\.5K/);
      assert.equal(await page.locator('#imageBackground option[value="transparent"]').innerText(),'transparent 透明');
      const seedreamEstimate = await page.evaluate(()=>{
        mainImages.length=0; refImages.length=0;
        mainImages.push({name:'main.png'}); refImages.push({name:'reference.png'});
        const result=getCurrentModelUsageContext();
        mainImages.length=0; refImages.length=0;
        return {price:result.variant?.credits,referenceImageCount:result.referenceImageCount,perTaskCredits:result.perTaskCredits};
      });
      assert.equal(seedreamEstimate.price,0.13);
      assert.equal(seedreamEstimate.referenceImageCount,2);
      assert.ok(Math.abs(seedreamEstimate.perTaskCredits - 0.234) < 1e-9);
      await page.screenshot({path:path.join(output,`${name}-seedream55.png`)});
      await page.evaluate(()=>setPage('video'));
      for (const [model,max] of [['kling-v4',30],['kling-v4-flash',20],['gemini-omni-1.2-flash',15],['gemini-omni-1.2-flash-ext',15],['muse-video-ext',10]]) {
        await page.selectOption('#videoModel',model);
        const state = await page.evaluate(()=>({max:currentApimartVideoRule().durations.at(-1),label:currentApimartVideoRule().label}));
        assert.equal(state.max,max,model);
      }
      await page.selectOption('#videoModel','muse-video-ext');
      assert.equal(await page.locator('#videoModeSelect option[value="first_frame"]').isDisabled(),true);
      assert.equal(await page.locator('#videoMultiFirstFrame').isDisabled(),true);
      assert.equal(await page.locator('#videoGenerateAudio').isChecked(),true);
      assert.equal(await page.locator('#videoGenerateAudio').isDisabled(),true);
      await page.evaluate(()=>{videoRefImages.push({name:'a.png'},{name:'b.png'});updateVideoModeUI();});
      assert.match(await page.locator('#videoModeHint').innerText(),/参考生成/);
      await page.selectOption('#videoModel','gemini-omni-1.2-flash-ext');
      const frameDuration = await page.evaluate(()=>{updateVideoDurationOptions();return currentVideoDurationSpec().values.at(-1);});
      assert.equal(frameDuration,10);
      await page.evaluate(()=>{videoRefImages.length=0;updateVideoDurationOptions();});
      assert.equal(await page.evaluate(()=>currentVideoDurationSpec().values.at(-1)),15);
      await page.selectOption('#videoModel','gemini-omni-1.2-flash');
      const officialEstimate = await page.evaluate(()=>getCurrentVideoModelUsageContext());
      assert.equal(officialEstimate.variant,null);
      await page.evaluate(()=>renderVideoModelUsageEstimate());
      assert.equal(await page.locator('#videoModelUsageEstimateValue').innerText(),'动态计费');
      await page.selectOption('#videoModel','kling-v4');
      const editCost = await page.evaluate(()=>{
        videoFilesData.push({name:'clip.mp4',duration_seconds:3.04});
        const context=getCurrentVideoModelUsageContext();videoFilesData.length=0;return context.perTaskCredits;
      });
      assert.equal(editCost,6.72,'Kling V4 input tier and rounded input+output seconds');
      await page.screenshot({path:path.join(output,`${name}-video.png`)});
      assert.deepEqual(errors,[],`${name} renderer errors`);
    }
    console.log('November model UI passed: isolated host and browser, all new choices, custom dimensions, mode switching, limits, audio, pricing and desktop/narrow screenshots.');
  } finally {
    if(browser) await browser.close();
    if(app) await app.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
