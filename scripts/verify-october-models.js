'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {sanitizeApimartImagePayload: sanitize, getApimartImageRule, sizeToAspect, generateOne} = require('../src/services/apiClient');
const {createFallbackPricingCatalog} = require('../src/services/apimartPricing');
const draft = require('../src/services/seedanceDraft');
const refs = Array.from({length:18}, (_,i)=>'https://example.com/'+i+'.png');

for (const model of ['gemini-nano-banana-2.1','gemini-nano-banana-2.1-ext']) {
  const ext = model.endsWith('-ext');
  const rule = getApimartImageRule(model);
  for (const resolution of rule.resolutions) {
    for (const size of rule.sizes) {
      const input = {prompt:'test',size,resolution,n:4,image_urls:refs};
      if (ext && resolution !== '1K' && ['1:4','4:1','1:8','8:1'].includes(size)) {
        assert.throws(()=>sanitize(input,model), /1K/);
      } else {
        const payload = sanitize(input,model);
        assert.equal(payload.model,model);
        assert.equal(payload.size,size);
        assert.equal(payload.resolution,resolution);
        assert.equal(payload.n,ext ? 1 : 4);
        assert.equal(payload.image_urls.length,18,'No invented reference-count cap');
      }
    }
  }
  assert.equal(sanitize({resolution:'0.5K'},model).resolution,'1K');
  assert.ok(!('official_fallback' in sanitize({},model)),'No automatic billing route change');
}
assert.equal(sanitize({official_fallback:true},'gemini-nano-banana-2.1-ext').official_fallback,true);
assert.ok(!('official_fallback' in sanitize({official_fallback:true},'gemini-nano-banana-2.1')));
for (const resolution of getApimartImageRule('flux-3-image').resolutions) {
  for (const size of getApimartImageRule('flux-3-image').sizes) {
    const result = sanitize({size:sizeToAspect(size,'flux-3-image'),resolution,n:3,image_urls:refs.slice(0,10),
      background:'transparent',quality:'high',output_format:'webp',negative_prompt:'test',grounding:false,safety_tolerance:6},'flux-3-image');
    assert.equal(result.aspect_ratio,size);
    assert.equal(result.resolution,resolution);
    assert.equal(result.n,1);
    assert.equal(result.grounding,false);
    assert.equal(result.safety_tolerance,4);
    for (const key of ['size','background','quality','output_format','negative_prompt']) assert.ok(!(key in result),key);
  }
}
assert.equal(sanitize({size:'1024x1024'},'flux-3-image').aspect_ratio,'auto');
assert.throws(()=>sanitize({image_urls:refs.slice(0,11)},'flux-3-image'),/10/);
for (const model of ['mai-image-2.6','mai-image-2.6-flash']) {
  for (const size of ['1536x1024','2048x1152','3072x768','1000x1000','7:5','4:1','1:4']) {
    assert.equal(sanitize({size:sizeToAspect(size,model)},model).size,size);
  }
  for (const size of ['512x512','2048x2048','8:1','1:8','0:0']) {
    assert.equal(sanitize({size},model).size,'1:1');
  }
  const editing = sanitize({size:'16:9',resolution:'2K',n:4,image_urls:refs.slice(0,5),
    quality:'high',background:'transparent',output_format:'webp',mask_url:refs[0],web_grounding:true},model);
  for (const key of ['size','resolution','quality','background','output_format','mask_url']) assert.ok(!(key in editing),key);
  assert.equal(editing.web_grounding,true);
  assert.equal(editing.n,1);
  assert.throws(()=>sanitize({image_urls:refs.slice(0,6)},model),/5/);
}
assert.ok(!('background' in sanitize({background:'transparent'},'gpt-image-2-official')));
assert.equal(sanitize({background:'transparent'},'gpt-image-1.5-official').background,'transparent');
const prices = createFallbackPricingCatalog().models;
assert.equal(prices['flux-3-image'].variants.find(x=>x.spec === '768SQ').credits,0.328);
assert.equal(prices['gemini-nano-banana-2.1-ext'].variants.find(x=>x.spec === '4K').credits,0.3);
assert.equal(prices['viduq4-preview'].variants.find(x=>x.spec === '2K').credits,1.624);
for (const model of ['mai-image-2.6','mai-image-2.6-flash','gemini-nano-banana-2.1']) assert.equal(prices[model].metered,true);

const main = fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
function extract(name, async = false) {
  const start = main.indexOf((async?'async ':'')+'function '+name+'(');
  assert.ok(start >= 0,'Missing '+name);
  const line = main.slice(start,main.indexOf('\n',start)).trimEnd();
  return line.endsWith('}') ? line : main.slice(start,main.indexOf('\n}',start)+2);
}

async function verify() {
  // Image limits must reject before attempting to read/upload fake paths.
  await assert.rejects(generateOne({cfg:{model:'flux-3-image'},prompt:'test',refImages:Array(11).fill('not-a-file')}),/10/);
  await assert.rejects(generateOne({cfg:{model:'mai-image-2.6'},prompt:'test',refImages:Array(6).fill('not-a-file')}),/5/);
  const store = {video_tasks:[]}, submitted = [];
  let uploads = 0;
  const context = vm.createContext({
    ...draft, path, console, optionalInt:v=>v === undefined ? undefined : Number(v),
    safeInt:(v,d)=>Number(v??d), safeFloat:(v,d)=>Number(v)||d,
    ensureVideoStore:()=>store, uuid:prefix=>prefix+store.video_tasks.length,
    beijingDateKey:()=> '2026-10-10', nowISO:()=>new Date().toISOString(),
    getDB:()=>({_save(){}}), addLog(){}, dataUrlToFile:item=>item.name,
    uploadImageToApimart:async(key,file)=>{uploads++;return 'https://example.com/'+file;},
    assertReferenceAudioFile(){}, buildPublicReferenceAudioUrlAuto:async file=>'https://example.com/'+file,
    postJsonApimart:async(endpoint,key,payload)=>{submitted.push(JSON.parse(JSON.stringify(payload)));return {task_id:'mock'};},
    pickTaskIdFromApimart:ret=>ret.task_id, pollApimartVideoTask:async()=>{},
    normalizeApimartVideoError:err=>err.message, isPermanentApimartVideoError:()=>true,
    isTransientApimartVideoTransportError:()=>false, closePublicVideoByPath(){},
    runLimited:async(items,limit,fn)=>{const out=[];for(const item of items) out.push(await fn(item));return out;},
    formatVideoTask:row=>row
  });
  vm.runInContext(main.slice(main.indexOf('const APIMART_VIDEO_MODEL_RULES ='),main.indexOf('function canonicalApimartVideoModel')),context);
  for (const name of ['canonicalApimartVideoModel','getApimartVideoRule','normalizeVideoMode',
    'resolveApimartVideoMode','validateViduQ4Input','apimartVideoModeLabel',
    'normalizeVideoResolution','normalizeVideoAspectRatio','normalizeVideoDurationForRule',
    'assertApimartVideoReferenceRules','assertApimartAudioReferenceRules',
    'assertApimartVideoOutputDurationRules','splitVideoPrompts']) vm.runInContext(extract(name),context);
  vm.runInContext(extract('createApimartVideoTask',true)+'\n'+extract('createApimartVideoBatch',true),context);
  const body = {api_key:'mock-key',video_model:'viduq4-preview',retry_times:0};
  const first = await context.createApimartVideoBatch({...body,ref_images:[{name:'first.png'}]},'owner',{},{});
  assert.equal(first.rows[0].status,'已提交',first.rows[0].error_message);
  assert.deepEqual(submitted[0],{model:'viduq4-preview',resolution:'720p',image_with_roles:[{url:'https://example.com/first.png',role:'first_frame'}],duration:5,audio:true});
  for (const [count,audio] of [[2,false],[15,false],[1,true],[1,false]]) {
    const row = await context.createApimartVideoTask({...body,ref_image_urls:refs.slice(0,count),
      prompt:'Reference scene', video_mode:'multi_reference',resolution:'4K',duration:16,generate_audio:false,
      audio_urls:audio ? ['https://example.com/speech.mp3'] : [],audio_durations:audio ? [{name:'speech.mp3',duration_seconds:12}] : []},'owner',{},{});
    assert.equal(row.status,'已提交',row.error_message);
    const payload = submitted.at(-1);
    assert.equal(payload.image_with_roles.length,count);
    assert.ok(payload.image_with_roles.every(x=>x.role === 'reference_image'));
    assert.equal(payload.resolution,'4K');
    assert.equal(payload.duration,16);
    assert.equal(payload.audio,false);
    assert.equal(payload.aspect_ratio,'16:9');
  }
  const auto = await context.createApimartVideoTask({...body,prompt:'test',ref_image_urls:refs.slice(0,2)},'owner',{},{});
  assert.equal(auto.status,'已提交',auto.error_message);
  assert.equal(submitted.at(-1).image_with_roles[0].role,'reference_image','Two images auto-select reference mode');
  for (const seed of [-1,0,12345]) {
    const seeded = await context.createApimartVideoTask({...body,ref_image_urls:[refs[0]],seed},'owner',{},{});
    assert.equal(seeded.status,'已提交',seeded.error_message);
    assert.equal(submitted.at(-1).seed,seed < 0 ? 0 : seed,'Vidu Q4 uses zero for random seeds');
  }
  const countBefore = submitted.length;
  const uploadsBefore = uploads;
  for (const invalid of [
    {}, {ref_images:[{name:'a.png'},{name:'b.png'}]},
    {ref_images:[{name:'a.png'}],video_mode:'first_last_frame',prompt:'test'},
    {ref_images:[{name:'a.png'}],video_mode:'text_to_video',prompt:'test'},
    {ref_images:Array(16).fill({name:'a.png'}),prompt:'test'},
    {ref_images:[{name:'a.png'}],audio_files:[{name:'x.wav',duration_seconds:5}],prompt:'test'},
    {ref_images:[{name:'a.png'}],audio_files:[{name:'x.mp3',duration_seconds:13}],prompt:'test'},
    {ref_images:[{name:'a.png'}],audio_files:Array(4).fill({name:'x.mp3',duration_seconds:5}),prompt:'test'},
    {ref_images:[{name:'a.png'}],video_mode:'first_frame',audio_files:[{name:'x.mp3',duration_seconds:5}],prompt:'test'},
    {ref_images:[{name:'a.png'}],video_url:'https://example.com/video.mp4',prompt:'test'}
  ]) await assert.rejects(context.createApimartVideoBatch({...body,...invalid},'owner',{},{}));
  assert.equal(submitted.length,countBefore);
  assert.equal(uploads,uploadsBefore,'Invalid Vidu inputs rejected before upload');
  const multi = await context.createApimartVideoBatch({...body,multi_first_frame:true,ref_images:[{name:'a.png'},{name:'b.png'}]},'owner',{},{});
  assert.equal(multi.count,2);
  assert.ok(multi.rows.every(x=>x.status === '已提交'));
  assert.ok(submitted.slice(-2).every(x=>x.image_with_roles.length === 1 && x.image_with_roles[0].role === 'first_frame'));
  console.log('October model contracts passed: five image variants, Vidu Q4 real task/batch assembly, limits, pricing and GPT Image 2 fields (mocked API, no charges).');
}
verify().catch(error=>{console.error(error);process.exitCode=1;});
