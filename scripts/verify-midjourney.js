const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

function fail(message) {
  console.error(`[verify-midjourney] ${message}`);
  process.exit(1);
}

const expectedTabs = [
  'imagine',
  'blend',
  'describe',
  'edits',
  'upscale',
  'variation',
  'high_variation',
  'low_variation',
  'reroll',
  'inpaint',
  'zoom',
  'pan',
  'remix',
  'video'
];

const tabBlock = appJs.match(/const\s+MJ_TABS\s*=\s*\[([\s\S]*?)\];/);
if (!tabBlock) fail('MJ_TABS not found');
const tabs = Array.from(tabBlock[1].matchAll(/key\s*:\s*'([^']+)'/g)).map(m => m[1]);

const formBlock = appJs.match(/const\s+MJ_FORM_CONFIG\s*=\s*\{([\s\S]*?)\n\};/);
if (!formBlock) fail('MJ_FORM_CONFIG not found');

const labelBlock = appJs.match(/const\s+MJ_SUBMIT_LABELS\s*=\s*\{([\s\S]*?)\n\};/);
if (!labelBlock) fail('MJ_SUBMIT_LABELS not found');

const endpointBlock = mainJs.match(/const\s+endpointMap\s*=\s*\{([^}]+)\s*\};/);
if (!endpointBlock) fail('backend endpointMap not found');

for (const key of expectedTabs) {
  if (!tabs.includes(key)) fail(`frontend MJ_TABS missing ${key}`);
  if (key === 'inpaint') {
    if (!appJs.includes('function renderMjInpaintForm')) fail('frontend inpaint special renderer missing');
  } else if (!new RegExp(`\\b${key}\\s*:`).test(formBlock[1])) {
    fail(`frontend MJ_FORM_CONFIG missing ${key}`);
  }
  if (!new RegExp(`\\b${key}\\s*:`).test(labelBlock[1])) fail(`frontend MJ_SUBMIT_LABELS missing ${key}`);
  if (key !== 'remix' && !new RegExp(`\\b${key}\\s*:`).test(endpointBlock[1])) fail(`backend endpointMap missing ${key}`);
}

if (!appJs.includes("POST /v1/midjourney/generations/video")) fail('MJ video endpoint missing from UI');
if (!mainJs.includes("'/midjourney/generations/video'")) fail('MJ video endpoint missing from backend');
if (!mainJs.includes("pickApimartVideoUrls(raw)")) fail('MJ task normalization no longer exposes video_urls');
if (!mainJs.includes('function buildMidjourneyStructuredFields')) fail('MJ structured request-field builder is missing');
for (const field of ['negative_prompt','stylize','chaos','weird','iw','cw','sw','dw','cref','sref','dref','repeat']) {
  if (!mainJs.includes(`'${field}'`)) fail(`MJ structured field ${field} is missing`);
}
if (!/out\.niji\s*=\s*true/.test(mainJs)) fail('MJ structured field niji is missing');
const structuredStart = mainJs.indexOf('function buildMidjourneyStructuredFields');
const structuredEnd = mainJs.indexOf('\nfunction compressImageFileToMaxMiB', structuredStart);
if (structuredStart < 0 || structuredEnd < 0) fail('MJ structured request-field builder cannot be evaluated');
const structuredSandbox = {};
vm.runInNewContext(`${mainJs.slice(structuredStart, structuredEnd)}\nstructuredResult = buildMidjourneyStructuredFields({version:'niji7'});`, structuredSandbox);
if (structuredSandbox.structuredResult?.version !== '7' || structuredSandbox.structuredResult?.niji !== true) fail('Legacy niji7/niji6 settings are not normalized to niji=true');
if (!/payload=\{ prompt, image_urls:imageUrls, speed, \.\.\.structured \}/.test(mainJs)) fail('Imagine/Edits no longer submit structured image_urls payloads');
if (!appJs.includes("{ value:'7', label:'niji 7' }") || !appJs.includes("{ value:'6', label:'niji 6' }")) fail('Niji versions must submit version 7/6 with niji=true');
if (!appJs.includes("name:'iw'") || !appJs.includes("name:'cw'") || !appJs.includes("name:'sw'") || !appJs.includes("name:'dw'")) fail('MJ reference-weight controls are incomplete');
for (const videoType of ['vid_1.1_i2v_480','vid_1.1_i2v_720','vid_1.1_i2v_start_end_480','vid_1.1_i2v_start_end_720']) {
  if (!appJs.includes(videoType) || !mainJs.includes(videoType)) fail(`MJ documented video_type ${videoType} is missing`);
}
if (!appJs.includes("name:'animate_mode'") || !mainJs.includes('animate_mode:animateMode')) fail('MJ video animate_mode is missing');
if (!mainJs.includes("const batchSize = [1,2,4].includes(batchSizeRaw)")) fail('MJ video batch_size validation is missing');
if (!mainJs.includes("if(!taskId && !prompt) throw new Error('直接上传起始帧生成视频时必须填写视频提示词')")) fail('MJ direct-image video prompt validation is missing');
if (mainJs.indexOf('const ctx=ensureMjBatchAndTask(body, owner)') < mainJs.indexOf("if(!taskId && !prompt) throw new Error('直接上传起始帧生成视频时必须填写视频提示词')")) fail('MJ local tasks are created before request validation finishes');
if (!mainJs.includes("if(!remoteTaskId) throw new Error('APIMart Midjourney 提交成功但未返回 task_id')")) fail('MJ submit response does not require a task_id');
if (!appJs.includes("label:'遮罩图（必填）'")) fail('MJ Modal mask is not marked required in the UI');
if (!mainJs.includes("task.status='等待补充参数'")) fail('MJ MODAL state handling is missing');
if (!mainJs.includes("if (action === 'modal')") || !mainJs.includes('return { batch:reusableBatch, task:reusableTask, reused:true }')) fail('MJ Modal submission does not reuse the Inpaint task and batch');
if (!mainJs.includes("if(isModal) batch.status='等待补充参数'")) fail('MJ MODAL batch waiting state is missing');
if (!appJs.includes('modal|等待补充参数')) fail('MJ renderer does not stop polling in MODAL state');
if (!appJs.includes('btn.textContent = MJ_SUBMIT_LABELS[action]')) fail('MJ floating submit label does not follow the active Modal action');
if (!mainJs.includes('splitMidjourneyDescribeSuggestions')) fail('Describe numbered-prompt splitting is missing');
const describeSplitStart = mainJs.indexOf('function splitMidjourneyDescribeSuggestions');
const describeSplitEnd = mainJs.indexOf('\nfunction pickMidjourneyTextOutputs', describeSplitStart);
if (describeSplitStart < 0 || describeSplitEnd < 0) fail('Describe numbered-prompt splitter cannot be evaluated');
const describeSandbox = {};
vm.runInNewContext(`${mainJs.slice(describeSplitStart, describeSplitEnd)}\ndescribeResult = splitMidjourneyDescribeSuggestions('1\uFE0F\u20E3 prompt one\\n2\uFE0F\u20E3 prompt two\\n3\uFE0F\u20E3 prompt three\\n4\uFE0F\u20E3 prompt four');`, describeSandbox);
if (!Array.isArray(describeSandbox.describeResult) || describeSandbox.describeResult.length !== 4) fail('Describe numbered prompts are not split into four results');
const describeNormalizerEnd = mainJs.indexOf('\nfunction sanitizeMjPayload', describeSplitStart);
const describeNormalizerSandbox = {};
vm.runInNewContext(`${mainJs.slice(describeSplitStart, describeNormalizerEnd)}\ndescribeNormalized = normalizeDescribePromptTexts(['SUCCESS', 'DESCRIBE', '1\uFE0F\u20E3 repeated prompt text\\n2\uFE0F\u20E3 repeated prompt text\\n3\uFE0F\u20E3 repeated prompt text\\n4\uFE0F\u20E3 repeated prompt text']);`, describeNormalizerSandbox);
if (!Array.isArray(describeNormalizerSandbox.describeNormalized) || describeNormalizerSandbox.describeNormalized.length !== 4) fail('Describe numbered positions are lost when suggestions have identical text');
if (!mainJs.includes('texts = normalizeDescribePromptTexts(texts.length ? texts : pickMidjourneyTextOutputs(raw))')) fail('Describe recent-history endpoint does not normalize legacy text outputs');
if (/action==='reroll' && prompt/.test(mainJs)) fail('Reroll must not submit an unsupported prompt field');
if (!mainJs.includes('const nestedError = json && json.error')) fail('Nested APIMart error response validation is missing');

console.log(`[verify-midjourney] OK: ${expectedTabs.length} tabs, documented fields, video modes, MODAL flow, and Describe parsing are aligned.`);
