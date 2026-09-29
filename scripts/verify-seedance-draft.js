'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const draft = require('../src/services/seedanceDraft');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/static/app.js'), 'utf8');
const request = { video_model:'doubao-seedance-2.5', draft_task_id:'task_example', api_key:'test-only' };

assert.deepEqual(draft.validateSeedanceDraftRequest(request), {draft:false, taskId:'task_example', resolution:'1080p'});
assert.equal(draft.seedanceDraftSettings({video_model:'seedance-2.5',draft:true}).resolution, '480p');
assert.deepEqual(draft.buildSeedanceFinalPayload(request), {model:'seedance-2.5', draft_task_id:'task_example', resolution:'1080p'});
for (const invalid of [
  {draft:true}, {resolution:'720p'}, {service_tier:'flex'}, {prompt:''}, {duration:5},
  {video_urls:[]}, {ref_images:[]}, {generate_audio:false}, {video_file:null},
  {seed:0}, {aspect_ratio:'16:9'}, {multi_first_frame:true}, {output_format:'webm'},
  {video_model:'wan3.0-video'}, {draft_task_id:'https://example.com/video.mp4'}
]) assert.throws(()=>draft.validateSeedanceDraftRequest({...request, ...invalid}), JSON.stringify(invalid));
assert.throws(()=>draft.seedanceDraftSettings({video_model:'seedance-2.5',draft:true,resolution:'1080p'}));
assert.equal(draft.buildSeedanceFinalPayload({...request,watermark:false,return_last_frame:true,output_format:'mov'}).watermark, false);

function extract(source, name, async = false) {
  const start = source.indexOf(`${async?'async ':''}function ${name}(`);
  assert.ok(start >= 0, 'Missing '+name);
  const firstLine = source.slice(start, source.indexOf('\n', start)).trimEnd();
  return firstLine.endsWith('}') ? firstLine : source.slice(start, source.indexOf('\n}', start) + 2);
}

async function verifyTaskSubmission() {
  const store = {video_tasks:[]};
  const submitted = [];
  const failUpload = ()=>{ throw new Error('Unexpected media upload'); };
  const context = vm.createContext({
    ...draft, console, path, optionalInt:()=>undefined, safeInt:(v,d)=>Number(v??d),
    ensureVideoStore:()=>store, uuid:prefix=>prefix+store.video_tasks.length,
    beijingDateKey:()=> '2026-09-29', nowISO:()=>new Date().toISOString(),
    getDB:()=>({_save(){}}), addLog(){},
    resolveApimartVideoMode:()=> 'text_to_video', apimartVideoModeLabel:()=> '文生视频',
    normalizeVideoResolution:(value)=>value || '720p', normalizeVideoAspectRatio:(value)=>value || '16:9',
    normalizeVideoDurationForRule:(value, fallback)=>value ?? fallback,
    assertApimartVideoReferenceRules(){}, assertApimartAudioReferenceRules(){},
    assertApimartVideoOutputDurationRules(){},
    dataUrlToFile:failUpload, uploadImageToApimart:failUpload,
    buildPublicVideoUrlAuto:failUpload, buildPublicReferenceAudioUrlAuto:failUpload,
    postJsonApimart:async(endpoint,key,payload)=>{ submitted.push(JSON.parse(JSON.stringify(payload))); return {task_id:'task_new'}; },
    pickTaskIdFromApimart:ret=>ret.task_id, pollApimartVideoTask:async()=>{},
    normalizeApimartVideoError:error=>error.message, isPermanentApimartVideoError:()=>true,
    closePublicVideoByPath(){}, splitVideoPrompts:value=>value ? [value] : [],
    runLimited:async(items, limit, run)=>{const rows=[]; for(const item of items) rows.push(await run(item)); return rows;},
    formatVideoTask:row=>row
  });
  vm.runInContext(main.slice(main.indexOf('const APIMART_VIDEO_MODEL_RULES ='), main.indexOf('function canonicalApimartVideoModel')), context);
  for (const name of ['canonicalApimartVideoModel','getApimartVideoRule']) vm.runInContext(extract(main,name),context);
  vm.runInContext(extract(main,'createApimartVideoTask',true)+'\n'+extract(main,'createApimartVideoBatch',true), context);
  const result = await context.createApimartVideoBatch({...request,output_format:'mov',retry_times:0}, 'owner', {}, {});
  assert.equal(result.count, 1);
  assert.equal(result.rows[0]?.status, '已提交', result.rows[0]?.error_message);
  assert.deepEqual(submitted[0], {model:'seedance-2.5',draft_task_id:'task_example',resolution:'1080p',output_format:'mov'});
  assert.equal(result.rows[0].draft_task_id, 'task_example');
  await assert.rejects(context.createApimartVideoBatch({...request,ref_images:[{data:'not-uploaded'}]}, 'owner', {}, {}));
  assert.equal(submitted.length, 1, 'Invalid final input must be rejected before any API call');
  const row = await context.createApimartVideoTask({video_model:'seedance-2.5',api_key:'test-only',prompt:'A landscape',draft:true,duration:6,retry_times:0}, 'owner', {}, {});
  assert.equal(row.status, '已提交', row.error_message);
  assert.equal(submitted[1].draft, true);
  assert.equal(submitted[1].resolution, '480p');
  assert.equal(submitted[1].prompt, 'A landscape');
  assert.equal(submitted[1].duration, 6);
  assert.equal(row.draft, true);
  assert.equal(row.mode, '480p 样片');
  await context.createApimartVideoTask({video_model:'seedance-2.5',api_key:'test-only',prompt:'Normal',resolution:'720p',retry_times:0}, 'owner', {}, {});
  assert.equal(submitted[2].resolution, '720p');
  assert.ok(!Object.hasOwn(submitted[2], 'draft'));
}

async function verifyFinalAction() {
  const requests = [];
  let confirmed = true;
  let release;
  const context = vm.createContext({
    videoPlatformApiKey:()=> 'test-only', confirm:()=>confirmed, toast(){}, loadVideoTasks:async()=>{},
    api:async(url, options)=>{ requests.push(JSON.parse(options.body)); await new Promise(resolve=>{release=resolve;}); return {success:1}; }
  });
  vm.runInContext('const seedanceFinalSubmissions = new Set();\n'+extract(renderer,'canFinalizeSeedanceDraft')+'\n'+extract(renderer,'finalizeSeedanceDraft',true), context);
  const row = {id:'video_local',model:'doubao-seedance-2.5',status:'已完成',task_id:'task_example',draft:true,submission_payload:{draft:true,prompt:'Do not resend',video_urls:['private'],output_format:'mov'}};
  const button = {disabled:false};
  assert.equal(context.canFinalizeSeedanceDraft({...row,status:'生成中'}),false);
  confirmed = false;
  await context.finalizeSeedanceDraft(row,button);
  assert.equal(requests.length,0,'Cancel must not submit');
  confirmed = true;
  const running = context.finalizeSeedanceDraft(row,button);
  assert.equal(button.disabled,true);
  await context.finalizeSeedanceDraft(row,button);
  assert.equal(requests.length,1,'Repeated clicks must not bill twice');
  assert.equal(requests[0].draft_task_id, 'task_example');
  assert.ok(!Object.hasOwn(requests[0],'prompt') && !Object.hasOwn(requests[0],'video_urls'));
  draft.validateSeedanceDraftRequest(requests[0]);
  release();
  await running;
  assert.equal(button.disabled,false);
}

(async()=>{
  await verifyTaskSubmission();
  await verifyFinalAction();
  console.log('Seedance draft validation passed: normal/draft/final submissions, no repeated media, cancellation and duplicate-click protection.');
})().catch(error=>{console.error(error);process.exitCode=1;});
