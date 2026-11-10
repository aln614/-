'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const {createRequire} = require('module');
const {sanitizeApimartImagePayload:sanitize, getApimartImageRule, generateOne} = require('../src/services/apiClient');
const {createFallbackPricingCatalog, createLivePricingCatalog, APP_IMAGE_PRICE_MODEL_MAP} = require('../src/services/apimartPricing');
const draft = require('../src/services/seedanceDraft');
const refs = Array.from({length:17}, (_,i)=>`https://example.com/${i}.png`);

for (const model of ['gpt-image-2.6-flare','gpt-image-2.6-sunburst']) {
  const rule = getApimartImageRule(model);
  for (const resolution of rule.resolutions) for (const quality of rule.qualities) {
    const payload = sanitize({prompt:'test',size:'1536x1024',resolution,quality,n:4,image_urls:refs.slice(0,16),output_format:'webp'},model);
    assert.equal(payload.model,model);
    assert.equal(payload.size,'1536x1024');
    assert.equal(payload.quality,quality);
    assert.equal(payload.n,4);
    assert.equal(payload.resolution,resolution);
  }
  assert.throws(()=>sanitize({image_urls:refs},model),/16/);
  assert.equal(sanitize({size:'1000x1000'},model).size,'auto');
}
for (const model of ['gpt-image-2.6-ext','gpt-image-2.6-ext-sunburst']) {
  for (const resolution of ['1K','2K','4K']) for (const quality of ['auto','low','medium','high','xhigh','max']) {
    const payload = sanitize({size:'16:9',resolution,quality,n:4,background:'transparent',moderation:'low',output_format:'webp',output_compression:90},model);
    assert.equal(payload.model,'gpt-image-2.6-ext');
    assert.equal(payload.version,model.endsWith('sunburst') ? 'sunburst' : 'flare');
    assert.equal(payload.n,1);
    assert.equal(payload.quality,quality);
    assert.equal(payload.resolution,resolution);
    assert.equal(payload.output_format,'webp');
    for (const key of ['background','moderation','output_compression']) assert.ok(!(key in payload));
  }
  assert.equal(sanitize({size:'1024x1024'},model).size,'auto');
}
for (const model of ['gpt-image-2.6-flare','gpt-image-2.6-sunburst']) {
  const gif = sanitize({prompt:'test',size:'16:9',n:2,output_format:'gif',frame_count:8,frame_duration_ms:200,complexity:'low',image_urls:refs.slice(0,1),background:'transparent'},model);
  assert.equal(gif.size,'auto');
  assert.equal(gif.frame_count,8);
  assert.equal(gif.frame_duration_ms,200);
  assert.equal(gif.complexity,'low');
  assert.equal(gif.image_urls.length,1);
  assert.ok(!('background' in gif));
  assert.throws(()=>sanitize({output_format:'gif',frame_count:17},model),/帧数/);
  assert.throws(()=>sanitize({output_format:'gif',frame_duration_ms:23},model),/帧时长/);
  assert.throws(()=>sanitize({output_format:'gif',mask_url:'https://example.com/mask.png'},model),/不支持蒙版/);
  const svg = sanitize({prompt:'test',n:1,output_format:'svg',svg_model:'gpt-5.4-mini',svg_effort:'high',image_urls:refs.slice(0,1)},model);
  assert.deepEqual(svg.svg,{model:'gpt-5.4-mini',reasoning:{effort:'high'}});
  assert.equal(svg.image_urls.length,1);
  assert.throws(()=>sanitize({output_format:'svg',n:2,svg_model:'gpt-5.4-mini'},model),/只能生成/);
  assert.throws(()=>sanitize({output_format:'svg'},model),/写作模型/);
  assert.throws(()=>sanitize({output_format:'svg',svg_model:'gpt-5.4-mini',markup_url:'https://example.com/m.png'},model),/不支持蒙版/);
  assert.equal(sanitize({image_urls:[refs[0]],markup_url:'https://example.com/m.png'},model).markup_url,'https://example.com/m.png');
  assert.throws(()=>sanitize({markup_url:'https://example.com/m.png'},model),/需要主图/);
  assert.throws(()=>sanitize({image_urls:[refs[0]],mask_url:'https://example.com/m.png',markup_url:'https://example.com/m.png'},model),/不能同时/);
}
assert.throws(()=>sanitize({output_format:'gif',image_urls:[refs[0]]},'gpt-image-2.6-ext'),/仅支持文生图/);
assert.throws(()=>sanitize({output_format:'svg'},'gpt-image-2.6-ext'),/不支持/);

async function verifyImageSubmission() {
  const file = path.join(__dirname,'../src/services/apiClient.js');
  const source = fs.readFileSync(file,'utf8');
  const submitted = [], downloaded = [];
  const context = vm.createContext({require:createRequire(file), module:{exports:{}}, process, Buffer, URL, AbortController, setTimeout, clearTimeout, setImmediate, console});
  vm.runInContext(source + `\nmodule.exports.__mockImageTransport = hooks => {
    uploadImageToApimart = hooks.upload;
    postJson = hooks.post;
    downloadResultToFile = hooks.download;
  };`,context);
  context.module.exports.__mockImageTransport({
    upload:async()=> 'https://example.com/ref.png',
    post:async(_url,_key,payload)=>{submitted.push(JSON.parse(JSON.stringify(payload)));return {data:[{url:['https://example.com/result.'+payload.output_format]}]};},
    download:async(url,target)=>{downloaded.push({url,target});await fs.promises.writeFile(target,'mock');}
  });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'tenying-gpt26-submit-'));
  try {
    const ref = path.join(temp,'ref.png'), edit = path.join(temp,'edit.png');
    fs.writeFileSync(ref,'reference'); fs.writeFileSync(edit,'mask');
    for (const [format,extra] of [
      ['gif',{frameCount:8,frameDurationMs:200}],
      ['svg',{svgModel:'gpt-5.4-mini',svgEffort:'high'}],
      ['png',{editMode:'markup',editImagePath:edit}],
      ['png',{editMode:'mask',editImagePath:edit}]
    ]) {
      await context.module.exports.generateOne({cfg:{model:'gpt-image-2.6-flare',outputFormat:format,complexity:'low',...extra},prompt:'test',mainImagePath:ref,outputPath:path.join(temp,'result.'+format)});
      const payload = submitted.at(-1);
      assert.equal(payload.output_format,format);
      assert.equal(payload.complexity,'low');
      if(format==='gif') assert.equal(payload.frame_count,8);
      if(format==='svg') assert.equal(payload.svg.reasoning.effort,'high');
      if(extra.editMode==='markup') assert.match(payload.markup_url,/^data:image\/png;base64,/);
      if(extra.editMode==='mask') assert.match(payload.mask_url,/^data:image\/png;base64,/);
    }
    assert.equal(downloaded.length,4);
    await assert.rejects(context.module.exports.generateOne({cfg:{model:'gpt-image-2.6-ext',outputFormat:'gif'},prompt:'test',mainImagePath:ref,outputPath:path.join(temp,'bad.gif')}),/仅支持文生图/);
    assert.equal(submitted.length,4);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}
const hy = 'hy-image-v3.5-preview';
assert.equal(sanitize({n:4,size:'2048x2048',resolution:'4K',seed:0,negative_prompt:'blur'},hy).size,'2048x2048');
assert.equal(sanitize({size:'8192x8192'},hy).size,'auto');
assert.equal(sanitize({seed:0},hy).seed,0);
assert.ok(!('seed' in sanitize({seed:-1},hy)));
assert.equal(sanitize({n:4},hy).n,1);
assert.throws(()=>sanitize({image_urls:refs.slice(0,6)},hy),/5/);
assert.deepEqual(sanitize({prompt:'test',n:4,size:'auto',resolution:'4K',quality:'max'},'muse-image-ext'),{model:'muse-image-ext',prompt:'test',n:1});
for (const aspect of ['1:1','16:9','9:16','4:3','3:4','3:2','2:3']) assert.equal(sanitize({size:aspect},'muse-image-ext').aspect_ratio,aspect);
assert.throws(()=>sanitize({image_urls:refs.slice(0,10)},'muse-image-ext'),/9/);

const prices = createFallbackPricingCatalog().models;
assert.equal(APP_IMAGE_PRICE_MODEL_MAP['gpt-image-2.6-ext-sunburst'],'gpt-image-2.6-ext');
assert.equal(prices['gpt-image-2.6-ext'].variants.find(x=>x.spec==='sunburst@2K').credits,0.3);
assert.equal(prices[hy].variants.find(x=>x.spec==='4K').credits,0.256);
assert.equal(prices['muse-image-ext'].variants[0].credits,0.048);
assert.equal(prices['muse-video-ext'].variants[0].unit,'次');
assert.equal(prices['muse-video-ext'].variants[0].credits,0.24);
assert.equal(prices['kling-v4'].variants.find(x=>x.spec==='720P-input').credits,0.84);
for (const id of ['gpt-image-2.6-flare','gpt-image-2.6-sunburst','gemini-omni-1.2-flash']) assert.equal(prices[id].metered,true);
const liveFixture = Array.from({length:16},(_,i)=>`<h3 title="demo-${i}">demo-${i}</h3><table><tbody><tr><th scope="row" title="default">default</th><td>1 Credits/张</td></tr></tbody></table>`).join('');
const conflicting = '<script>self.__next_f.push([1,'+JSON.stringify(JSON.stringify({video:[{id:'gemini-omni-1.2-flash',specification:'second',billing_type:'per_second',fixed_prices:{unit:'usd_per_second',dimension:'resolution',items:[{key:'720P',after_discount:0.06}]}}]}))+'])</script>';
assert.deepEqual(createLivePricingCatalog(liveFixture+conflicting).models['gemini-omni-1.2-flash'].variants,[]);

const main = fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
function extract(name, async = false) {
  const start = main.indexOf((async?'async ':'')+'function '+name+'(');
  assert.ok(start>=0,'Missing '+name);
  const line = main.slice(start,main.indexOf('\n',start)).trimEnd();
  return line.endsWith('}') ? line : main.slice(start,main.indexOf('\n}',start)+2);
}
async function verify() {
  await verifyImageSubmission();
  const submitted = [], store = {video_tasks:[]};
  let uploads = 0;
  const context = vm.createContext({
    ...draft, path, fs, Buffer, console,
    resolveMigratedUpload:file=>file,
    optionalInt:v=>v === undefined ? undefined : Number(v),
    safeInt:(v,d)=>Number(v??d), safeFloat:(v,d)=>Number(v)||d,
    ensureVideoStore:()=>store, uuid:prefix=>prefix+store.video_tasks.length,
    beijingDateKey:()=> '2026-11-09', nowISO:()=>new Date().toISOString(),
    getDB:()=>({_save(){}}), addLog(){}, dataUrlToFile:item=>item.name,
    uploadImageToApimart:async(key,file)=>{uploads++;return 'https://example.com/'+file;},
    probePublicVideoUrl:async()=>{}, probePublicVideoUrlWithRetry:async()=>{},
    postJsonApimart:async(endpoint,key,payload)=>{submitted.push(JSON.parse(JSON.stringify(payload)));return {task_id:'mock'};},
    pickTaskIdFromApimart:ret=>ret.task_id, pollApimartVideoTask:async()=>{},
    normalizeApimartVideoError:err=>err.message, isPermanentApimartVideoError:()=>true,
    isTransientApimartVideoTransportError:()=>false, closePublicVideoByPath(){},
    runLimited:async(items,limit,fn)=>{const out=[];for(const item of items) out.push(await fn(item));return out;},
    formatVideoTask:row=>row
  });
  vm.runInContext(main.slice(main.indexOf('const APIMART_VIDEO_MODEL_RULES ='),main.indexOf('function canonicalApimartVideoModel')),context);
  for (const name of ['canonicalApimartVideoModel','getApimartVideoRule','normalizeVideoMode','resolveApimartVideoMode',
    'apimartVideoModeLabel','normalizeVideoResolution','normalizeVideoAspectRatio','normalizeVideoDurationForRule',
    'assertApimartVideoReferenceRules','assertApimartAudioReferenceRules','assertApimartVideoOutputDurationRules',
    'assertApimartVideoInputDurationRules','assertApimartVideoImageBytes','buildApimartVideoImageRolePayload','splitVideoPrompts']) vm.runInContext(extract(name),context);
  vm.runInContext(extract('createApimartVideoTask',true)+'\n'+extract('createApimartVideoBatch',true),context);
  const submit = async(model,body={})=>{
    const row = await context.createApimartVideoTask({api_key:'mock-key',video_model:model,prompt:'test',retry_times:0,...body},'owner',{},{});
    assert.equal(row.status,'已提交',row.error_message);
    return submitted.at(-1);
  };
  for (const model of ['kling-v4','kling-v4-flash','gemini-omni-1.2-flash','gemini-omni-1.2-flash-ext']) {
    const text = await submit(model,{duration:30,seed:123});
    assert.equal(text.model,model);
    assert.ok(!('seed' in text));
    const first = await submit(model,{ref_image_urls:refs.slice(0,1)});
    if(model.endsWith('-ext')) assert.equal(first.first_frame_image,refs[0]);
    else assert.equal(first.image_with_roles[0].role,'first_frame');
    if(model.startsWith('kling-v4')) assert.ok(!('aspect_ratio' in first));
    const ref = await submit(model,{ref_image_urls:refs.slice(0,3),video_mode:'multi_reference'});
    assert.equal(ref.omni_reference_task_type,'reference');
    assert.deepEqual(ref.image_urls,refs.slice(0,3));
    const edit = await submit(model,{video_urls:['https://example.com/clip.mp4'],source_video_duration:8.1,duration:15});
    assert.equal(edit.omni_reference_task_type,'edit');
    assert.deepEqual(edit.video_urls,['https://example.com/clip.mp4']);
    assert.ok(!('duration' in edit));
    assert.ok(!('aspect_ratio' in edit));
    if(model !== 'kling-v4-flash') {
      const frames = await submit(model,{ref_image_urls:refs.slice(0,2),duration:15});
      assert.equal(frames.duration,model === 'kling-v4' ? 15 : 10);
      if(model.endsWith('-ext')) assert.equal(frames.last_frame_image,refs[1]);
      else assert.equal(frames.image_with_roles[1].role,'last_frame');
    }
  }
  assert.equal((await submit('kling-v4-flash',{duration:30})).duration,20);
  const flashAuto = await submit('kling-v4-flash',{ref_image_urls:refs.slice(0,2)});
  assert.equal(flashAuto.omni_reference_task_type,'reference');
  assert.deepEqual(flashAuto.image_urls,refs.slice(0,2));
  for (const count of [0,1,2,9]) {
    const muse = await submit('muse-video-ext',{ref_image_urls:refs.slice(0,count),duration:3,resolution:'4k',aspect_ratio:'auto',generate_audio:false});
    assert.equal(muse.duration,10);
    assert.equal(muse.resolution,'720p');
    assert.equal(muse.audio,true);
    assert.ok(!('aspect_ratio' in muse));
    assert.ok(!('image_with_roles' in muse));
    if(count) assert.deepEqual(muse.image_urls,refs.slice(0,count));
  }
  const before = submitted.length;
  for (const [model,body] of [
    ['kling-v4-flash',{ref_image_urls:refs.slice(0,2),video_mode:'first_last_frame'}],
    ['kling-v4',{ref_image_urls:refs.slice(0,3),video_mode:'first_frame'}],
    ['gemini-omni-1.2-flash',{prompt:''}],
    ['gemini-omni-1.2-flash-ext',{video_urls:['https://example.com/x.mp4'],ref_image_urls:[refs[0]]}],
    ['muse-video-ext',{ref_image_urls:[refs[0]],video_mode:'first_frame'}],
    ['muse-video-ext',{ref_image_urls:refs.slice(0,10)}],
    ['muse-video-ext',{video_urls:['https://example.com/x.mp4']}]
  ]) {
    const row = await context.createApimartVideoTask({api_key:'mock',video_model:model,prompt:'test',retry_times:0,...body},'owner',{},{});
    assert.notEqual(row.status,'已提交',model);
  }
  assert.equal(submitted.length,before,'Invalid requests never reach the generation endpoint');
  const uploadedBefore = uploads;
  await assert.rejects(context.createApimartVideoBatch({api_key:'mock',video_model:'muse-video-ext',multi_first_frame:true,ref_images:[{name:'a.png'}]},'owner',{},{}),/首帧/);
  const large = {name:'a.png',data:'data:image/png;base64,'+Buffer.alloc(11*1024*1024+1).toString('base64')};
  await assert.rejects(context.createApimartVideoBatch({api_key:'mock',video_model:'muse-video-ext',prompt:'test',ref_images:[large]},'owner',{},{}),/11MB/);
  assert.equal(uploads,uploadedBefore,'Muse limits are enforced before batch upload');
  const firstBatch = await context.createApimartVideoBatch({api_key:'mock',video_model:'kling-v4',ref_images:[{name:'a.png'}]},'owner',{},{});
  assert.equal(firstBatch.rows[0].status,'已提交',firstBatch.rows[0].error_message);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'tenying-model-limits-'));
  try {
    const file = path.join(temp,'large.png');
    fs.writeFileSync(file,Buffer.alloc(11*1024*1024+1));
    await assert.rejects(generateOne({cfg:{model:'muse-image-ext'},prompt:'test',refImages:[file]}),/11MB/);
    fs.truncateSync(file,20*1024*1024+1);
    await assert.rejects(generateOne({cfg:{model:'gpt-image-2.6-ext'},prompt:'test',refImages:[file]}),/20MB/);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
  console.log('November model contracts passed: six image choices, five video models, aliases, parameter limits, editing, fixed/token prices and pre-upload rejection (mocked API, no charges).');
}
verify().catch(error=>{console.error(error);process.exitCode=1;});
