'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron:electron, chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-history-ui-'));
const runtime = path.join(temporary, 'runtime');
const results = path.join(root, 'test-results', 'history-ui');
fs.mkdirSync(runtime);
fs.mkdirSync(results, {recursive:true});
fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({
  port:18796, shortcuts_enabled:false, update_auto_check:false, public_enabled:false,
  asset_library_dir:path.join(temporary, 'assets'), output_dir:path.join(temporary, 'output')
}));

const rows = [
  {id:'image-1',name:'Batch_2026-11-09_06_31_50',batch_type:'image',model:'gemini-nano-banana-2.1-ext',size:'auto',status:'已完成',task_count:24,success_count:24,fail_count:0,note:'包装设计参考',created_at:'2026-11-09 06:31:50',finished_at:'2026-11-09 06:32:55'},
  {id:'describe-1',name:'MJ_describe_2026-11-09_06_43_47',batch_type:'image',model:'Midjourney',size:'4:3',status:'已完成',task_count:1,success_count:1,fail_count:0,note:'',created_at:'2026-11-09 06:43:47',finished_at:'2026-11-09 06:44:10'},
  {id:'video_batch_1',name:'视频批次_2026-11-09_06_52_46',batch_type:'video',model:'kling-v4',size:'16:9',status:'部分完成',task_count:3,success_count:2,fail_count:1,note:'动态素材',video_ids:['video-1','video-2','video-3'],created_at:'2026-11-09 06:52:46'},
  {id:'image-2',name:'A_very_long_batch_name_to_check_wrapping_and_keep_every_character_visible_2026',batch_type:'image',model:'example-extremely-long-model-name-for-layout-verification',size:'1024x1536',status:'生成中',task_count:100,success_count:56,fail_count:0,note:'较长备注需要完整显示，不应该遮挡其他字段或操作按钮。',created_at:'2026-11-09 07:19:13'}
];

async function installFixtures(page){
  await page.route('**/api/history_batches*',route=>route.fulfill({json:rows}));
  await page.route('**/api/batches?*',route=>route.fulfill({json:rows.filter(row=>row.batch_type!=='video')}));
  await page.route('**/api/delete_batch',route=>route.fulfill({json:{ok:true}}));
  await page.route('**/api/video_delete_selected',route=>route.fulfill({json:{ok:true}}));
  await page.route('**/api/delete_batches',route=>route.fulfill({json:{deleted_batch_ids:['image-1'],deleted_batches:1}}));
  await page.waitForFunction(()=>typeof setPage === 'function' && typeof forceRenderHistory === 'function');
  await page.evaluate(()=>setPage('history'));
  await page.waitForFunction(()=>document.querySelectorAll('#historyRows tr[data-history-batch-id]').length===4);
}

async function checkGeometry(page, mobile){
  const result = await page.evaluate(()=>{
    const wrap=document.querySelector('.history-table-wrap');
    const table=wrap.querySelector('table');
    const rows=[...document.querySelectorAll('#historyRows tr[data-history-batch-id]')];
    const overlaps=[];
    for(const row of rows){
      const cell=row.querySelector('.history-action-cell').getBoundingClientRect();
      const buttons=[...row.querySelectorAll('.history-action')];
      for(let i=0;i<buttons.length;i++){
        const r=buttons[i].getBoundingClientRect();
        if(r.left<cell.left-1 || r.right>cell.right+1) overlaps.push('action clipped');
        if(i && r.left<buttons[i-1].getBoundingClientRect().right-1) overlaps.push('action overlap');
        const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        if(r.top>=0 && r.bottom<=innerHeight && !(hit===buttons[i] || buttons[i].contains(hit))) overlaps.push('action blocked');
      }
      for(const value of row.querySelectorAll('.history-batch-cell,.history-model,.history-size')){
        if(value.scrollWidth>value.clientWidth+1) overlaps.push('text clipped');
      }
    }
    const heads=[...table.querySelectorAll('thead th')].map(th=>({text:th.textContent.trim(),height:th.getBoundingClientRect().height,whiteSpace:getComputedStyle(th).whiteSpace}));
    return {overlaps,heads,tableWidth:table.getBoundingClientRect().width,wrapWidth:wrap.clientWidth,
      grid:getComputedStyle(rows[0]).display,hasHorizontalOverflow:wrap.scrollWidth>wrap.clientWidth+1};
  });
  assert.deepEqual(result.overlaps,[], 'actions must remain visible, separate, and clickable');
  assert.equal(result.hasHorizontalOverflow,false,'the history table should fit its available width');
  if(mobile) assert.equal(result.grid,'grid','narrow layouts use labeled record rows');
  else {
    assert.equal(result.grid,'table-row');
    for(const name of ['任务','成功','失败']){
      const head=result.heads.find(item=>item.text===name);
      assert.equal(head.whiteSpace,'nowrap',name+' must not wrap vertically');
      assert.ok(head.height<55,name+' heading must stay compact');
    }
  }
}

(async()=>{
  let app,browser;
  try{
    const packaged=process.env.HISTORY_TEST_PACKAGED;
    app=await electron.launch({executablePath:packaged || require('electron'),args:packaged ? ['--background'] : [root,'--background'],
      env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:runtime}});
    const page=await app.firstWindow();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.waitForURL('http://127.0.0.1:18796/**',{timeout:30000});
    await installFixtures(page);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1480,960));
    for(const theme of ['dark','light']){
      await page.evaluate(theme=>{window.localAppearance.setTheme(theme);window.localAppearance.setMode('none');},theme);
      await page.mouse.move(700,80);
      await page.waitForTimeout(500);
      await checkGeometry(page,false);
      await page.screenshot({path:path.join(results,`desktop-${theme}.png`)});
    }
    await page.locator('#sidebar .nav[data-page="history"]').hover();
    await page.waitForTimeout(500);
    await checkGeometry(page,false);
    await page.screenshot({path:path.join(results,'desktop-expanded-sidebar.png')});
    await page.mouse.move(700,80);
    await page.waitForTimeout(400);

    await page.locator('#historySearch').fill('kling-v4');
    assert.equal(await page.locator('#historyRows tr[data-history-batch-id]').count(),1);
    assert.match(await page.locator('#historyResultSummary').innerText(),/1 条记录/);
    await page.locator('#historySearch').fill('not-a-model');
    assert.match(await page.locator('.history-empty-cell').innerText(),/没有找到/);
    await page.locator('#historySearch').fill('');
    await page.locator('.history-filters [data-filter="生成中"]').click();
    assert.equal(await page.locator('#historyRows tr[data-history-batch-id]').count(),1);
    await page.locator('.history-filters [data-filter="all"]').click();

    await page.locator('#historySelectAllBatches').check();
    assert.equal(await page.locator('.history-batch-check:checked').count(),4);
    assert.match(await page.locator('#historyBulkCount').innerText(),/4/);
    await page.locator('#clearHistoryBatchSelectionBtn').click();
    assert.equal(await page.locator('.history-batch-check:checked').count(),0);
    await page.locator('[data-history-batch-id="image-1"] .history-batch-cell').dblclick();
    assert.equal(await page.locator('.inline-note-input').inputValue(),'包装设计参考');
    await page.keyboard.press('Escape');

    await page.evaluate(()=>{
      window.historyActionCalls=[];
      repeatBatch=id=>window.historyActionCalls.push(['repeat',id]);
      exportZip=id=>window.historyActionCalls.push(['download-image',id]);
      exportVideoHistoryBatch=id=>window.historyActionCalls.push(['download-video',id]);
      exportDescribeXlsx=id=>window.historyActionCalls.push(['download-describe',id]);
      openVideoBatchFromHistory=id=>window.historyActionCalls.push(['view-video',id]);
      showDescribeBatchResults=id=>window.historyActionCalls.push(['view-describe',id]);
      downloadToFolder=payload=>window.historyActionCalls.push(['bulk-download',payload]);
      const originalSetPage=setPage;
      setPage=name=>name==='images' ? window.historyActionCalls.push(['navigate',name]) : originalSetPage(name);
      loadImages=()=>window.historyActionCalls.push(['load-images',currentImageBatch]);
    });
    for(const [id,action] of [['image-1','repeat'],['image-1','download-image'],['video_batch_1','view-video'],['video_batch_1','download-video'],['describe-1','view-describe'],['describe-1','download-describe']]){
      await page.locator(`tr[data-history-batch-id="${id}"] [data-history-action="${action}"]`).click();
    }
    assert.deepEqual(await page.evaluate(()=>window.historyActionCalls.slice(0,6)),[
      ['repeat','image-1'],['download-image','image-1'],['view-video','video_batch_1'],['download-video','video_batch_1'],['view-describe','describe-1'],['download-describe','describe-1']
    ]);
    await page.locator('tr[data-history-batch-id="image-1"] [data-history-action="view-image"]').click();
    assert.deepEqual(await page.evaluate(()=>window.historyActionCalls.slice(6,8)),[['navigate','images'],['load-images','image-1']]);
    await page.locator('tr[data-history-batch-id="image-1"] .history-batch-check').check();
    await page.locator('tr[data-history-batch-id="video_batch_1"] .history-batch-check').check();
    await page.locator('#downloadSelectedBatchesBtn').click();
    assert.deepEqual(await page.evaluate(()=>window.historyActionCalls.at(-1)),['bulk-download',{batch_ids:['image-1'],video_ids:['video-1','video-2','video-3']}]);
    await page.locator('#clearHistoryBatchSelectionBtn').click();
    page.on('dialog',dialog=>dialog.accept());
    const videoDelete=page.waitForRequest(request=>request.url().includes('/api/video_delete_selected') && request.method()==='POST');
    await page.locator('tr[data-history-batch-id="video_batch_1"] [data-history-action="delete-video"]').click();
    assert.deepEqual((await videoDelete).postDataJSON().ids,['video-1','video-2','video-3']);
    await page.locator('tr[data-history-batch-id="image-1"] .history-batch-check').check();
    const bulkDelete=page.waitForRequest(request=>request.url().endsWith('/api/delete_batches') && request.method()==='POST');
    await page.locator('#deleteSelectedBatchesBtn').click();
    assert.deepEqual((await bulkDelete).postDataJSON().batch_ids,['image-1']);
    await page.locator('#historyBulkBar').waitFor({state:'hidden'});
    const del=page.locator('tr[data-history-batch-id="image-1"] [data-history-action="delete-image"]');
    const before=await del.boundingBox();
    await del.click();
    assert.equal(await del.innerText(),'确认');
    assert.equal(await del.getAttribute('aria-label'),'再次点击确认删除');
    assert.equal((await del.boundingBox()).width,before.width,'confirmation must not shift the action row');
    const deletion=page.waitForRequest(request=>request.url().includes('/api/delete_batch') && request.method()==='POST');
    await del.click();
    assert.equal((await deletion).postDataJSON().batch_id,'image-1');
    assert.deepEqual(errors,[],'desktop must not raise renderer errors');

    browser=await chromium.launch({channel:'msedge',headless:true});
    for(const width of [1100,390]){
      const context=await browser.newContext({viewport:{width,height:900},isMobile:width===390,hasTouch:width===390});
      const web=await context.newPage();
      await web.goto('http://127.0.0.1:18796/');
      await installFixtures(web);
      await web.evaluate(()=>{window.localAppearance.setTheme('dark');window.localAppearance.setMode('none');});
      await web.waitForTimeout(400);
      await checkGeometry(web,true);
      await web.screenshot({path:path.join(results,`browser-${width}.png`)});
      await web.locator('#historySelectAllCompact').click();
      assert.equal(await web.locator('.history-batch-check:checked').count(),4);
      assert.equal(await web.locator('#historySelectAllCompact').getAttribute('aria-pressed'),'true');
      await web.locator('#historySelectAllCompact').click();
      assert.equal(await web.locator('.history-batch-check:checked').count(),0);
      await web.locator('tr[data-history-batch-id="image-1"] .history-batch-check').check();
      assert.match(await web.locator('#historyBulkCount').innerText(),/1/);
      await context.close();
    }
    console.log('History UI passed: desktop light/dark and expanded navigation, narrow browser layouts, search, filters, selection, note editing, actions and two-step deletion.');
  }finally{
    if(browser) await browser.close();
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-history-ui-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
