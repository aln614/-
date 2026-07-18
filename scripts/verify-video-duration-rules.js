const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function registrationLines(source, marker) {
  const map = new Map();
  let cursor = 0;
  while (true) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) break;
    const end = source.indexOf(']);', start);
    assert(end > start, `Cannot find registration block end: ${marker}`);
    for (const line of source.slice(start, end).split(/\r?\n/)) {
      const match = line.match(/model:'([^']+)'/);
      if (match) map.set(match[1].toLowerCase(), line.trim());
    }
    cursor = end + 3;
  }
  assert(map.size > 0, `Cannot find registration block: ${marker}`);
  return map;
}

function durationSpec(line) {
  if (/supportsDuration:false/.test(line)) return { mode:'auto' };
  const range = line.match(/durationRange:\[(\d+),(\d+)\]/) || line.match(/durationMin:(\d+),\s*durationMax:(\d+)/);
  if (range) return { mode:'range', min:Number(range[1]), max:Number(range[2]) };
  const discrete = line.match(/durations:\[([^\]]+)\]/);
  if (discrete) return { mode:'discrete', values:discrete[1].split(',').map(Number) };
  return { mode:'default' };
}

const backend = registrationLines(main, 'registerApimartVideoRules([');
const frontend = registrationLines(app, 'registerApimartVideoUiRules([');
const pickerBlock = app.slice(app.indexOf('const APIMART_VIDEO_MODEL_GROUPS_UI'), app.indexOf('function apimartVideoModelOptionsHtml'));
const picker = new Set();
for (const group of pickerBlock.matchAll(/\['[^']+',\s*\[([^\]]+)\]\]/g)) {
  for (const model of group[1].matchAll(/'([^']+)'/g)) picker.add(model[1].toLowerCase());
}

assert(backend.size === 38, `Expected 38 official backend models, found ${backend.size}`);
assert(picker.size === backend.size, `Model picker/backend count mismatch: picker=${picker.size}, backend=${backend.size}`);
for (const model of picker) assert(backend.has(model), `Model picker has no backend rule: ${model}`);
for (const model of backend.keys()) assert(picker.has(model), `Backend model is missing from picker: ${model}`);

for (const [model, backendLine] of backend) {
  if (model === 'omni-flash-ext') continue;
  const frontendLine = frontend.get(model);
  assert(frontendLine, `Frontend duration rule missing for ${model}`);
  const expected = durationSpec(backendLine);
  const actual = durationSpec(frontendLine);
  assert(JSON.stringify(actual) === JSON.stringify(expected), `Duration rule mismatch for ${model}: backend=${JSON.stringify(expected)} frontend=${JSON.stringify(actual)}`);
}

assert(/'doubao-seedance-1-0-pro-fast'[\s\S]*?durationRange:\s*\[2,12\],\s*defaultDuration:\s*5/.test(main), 'Seedance 1.0 Pro Fast must support 2-12 seconds with default 5');
assert(/'doubao-seedance-1-0-pro-quality'[\s\S]*?durationRange:\s*\[2,12\],\s*defaultDuration:\s*5/.test(main), 'Seedance 1.0 Pro Quality must support 2-12 seconds with default 5');
assert(/model:'doubao-seedance-1-5-pro'[^\n]*durationRange:\[4,12\][^\n]*audioParam:'audio'/.test(main), 'Seedance 1.5 Pro must support 4-12 seconds and audio');
assert(/model:'doubao-seedance-2\.0'[^\n]*aspectParam:'size'[^\n]*durationRange:\[4,15\][^\n]*videoParam:'video_urls'/.test(main), 'Seedance 2.0 must use size and support video references');
assert(/model:'grok-imagine-1\.5-video-apimart'[^\n]*durationRange:\[6,30\],\s*defaultDuration:6/.test(main), 'Grok Imagine 1.5 Video must support 6-30 seconds with default 6');
assert(/model:'grok-imagine-1\.5-video-apimart'[^\n]*durationMin:6,\s*durationMax:30,\s*defaultDuration:6/.test(app), 'Grok Imagine 1.5 Video slider must support 6-30 seconds with default 6');
assert(/model:'grok-imagine-1\.5-video-apimart'[^\n]*resolutionParam:'quality'[^\n]*aspectParam:'size'/.test(main), 'Grok must submit quality and size fields');
assert(/model:'sora-2'[^\n]*durations:\[4,8,12,16,20\],\s*defaultDuration:4/.test(main), 'Sora 2 default duration must be 4 seconds');
assert(/model:'veo3\.1-fast'[^\n]*durations:\[8\]/.test(main) && /model:'veo3\.1-quality'[^\n]*durations:\[8\]/.test(main), 'VEO3.1 generation must be fixed to 8 seconds');
assert(/model:'veo3\.1-lite'[^\n]*supportsImageUrls:false/.test(main), 'VEO3.1 Lite must reject reference images');
assert(/model:'wan2\.7-videoedit'[^\n]*durations:\[0,2,3,4,5,6,7,8,9,10\][^\n]*durationWithVideo:true/.test(main), 'Wan2.7 VideoEdit must allow 0 or 2-10 seconds and send duration with video');
assert(/model:'kling-v2-6-motion-control'[^\n]*supportsDuration:false/.test(main), 'Kling 2.6 Motion Control duration must follow the source video');
assert(/model:'kling-v3-motion-control'[^\n]*supportsDuration:false/.test(main), 'Kling v3 Motion Control duration must follow the source video');
assert(/model:'kling-video-o1'[^\n]*durations:\[5,10\]/.test(main), 'Kling Video O1 only supports 5 or 10 seconds');
assert(/model:'MiniMax-Hailuo-02'[^\n]*resolutions:\['512p','768p','1080p'\][^\n]*resolutionDurationRules:\{'1080p':\[5\]\}/.test(main), 'Hailuo 02 1080p must be fixed to 5 seconds');
assert(/model:'MiniMax-Hailuo-2\.3'[^\n]*durations:\[6,10\][^\n]*resolutionDurationRules:\{'1080p':\[6\]\}/.test(main), 'Hailuo 2.3 1080p must be fixed to 6 seconds');
assert(/model:'skyreels-v4-fast'[^\n]*durationRange:\[3,15\][^\n]*videoParam:'ref_videos'/.test(main), 'SkyReels V4 must support 3-15 seconds and tagged video references');
assert(/model:'happyhorse-1\.0'[^\n]*resolutions:\['720P','1080P'\][^\n]*aspectParam:'size'/.test(main), 'HappyHorse must preserve uppercase quality values and use size');
assert(/model:'wan2\.5-preview'[^\n]*durations:\[5,10\]/.test(main), 'Wan2.5 must support 5 or 10 seconds');
assert(/model:'wan2\.6'[^\n]*durations:\[5,10,15\]/.test(main), 'Wan2.6 must support 5, 10, or 15 seconds');
assert(/model:'wan2\.7-r2v'[^\n]*videoDurationRange:\[2,10\][^\n]*maxReferenceCount:5/.test(main), 'Wan2.7 R2V must constrain video edits to 2-10 seconds and five references');
assert(/model:'kling-v2-6'[^\n]*durations:\[5,10\][^\n]*modeFromResolution:true/.test(main), 'Kling 2.6 must support 5 or 10 seconds and map quality mode');
assert(/model:'kling-v3'[^\n]*durationRange:\[3,15\]/.test(main), 'Kling v3 must support 3-15 seconds');
assert(/model:'viduq3'[^\n]*durationRange:\[3,16\][^\n]*minImageCount:1/.test(main), 'Vidu Q3 standard must require images and support 3-16 seconds');
assert(/model:'pixverse-v6'[^\n]*durationRange:\[1,15\][^\n]*firstLastDurations:\[5,8\]/.test(main), 'Pixverse v6 must support 1-15 seconds and 5/8 second first-last mode');
assert(/model:'Omni-Flash-Ext'[^\n]*durations:\[4,6,8,10\][^\n]*durationWithVideo:false/.test(main), 'Omni Flash Ext must use 4/6/8/10 seconds and omit duration for video edit');
assert(/model:'gemini-omni-flash-preview'[^\n]*supportsDuration:false/.test(main), 'Gemini Omni Flash duration must be model-controlled');
assert(/model:'doubao-seedance-2\.0'[^\n]*aspectParam:'size'/.test(main), 'Seedance 2.0 must submit size instead of aspect_ratio');
assert(!/doubao-seedance-2\.0-face|doubao-seedance-2\.0-fast-face|wan2\.6-i2v|veo3\.1-fast-official/.test(app.slice(app.indexOf('const APIMART_VIDEO_MODEL_GROUPS_UI'), app.indexOf('function apimartVideoModelOptionsHtml'))), 'Undocumented legacy model variants must not appear in the model picker');
assert(/id="videoDuration"\s+type="range"/.test(html), 'Video duration must use a range input');
assert(!/<select\s+id="videoDuration"/.test(html), 'Legacy video duration select must not return');
assert(/function selectedVideoDuration\(\)/.test(app), 'Slider must translate its index to a supported duration value');
assert(/body\.duration = durationValue/.test(app), 'Video submit must use the translated duration value');
assert(/durationRule\.defaultDuration \?\? 6/.test(main), 'Backend must preserve zero-valued model defaults');
assert(/\/videos\/\$\{encodeURIComponent\(sourceTaskId\)\}\/remix/.test(main), 'VEO task remix endpoint must be available');
assert(/extend_from_task_id/.test(main), 'Pixverse/Gemini task extension must send extend_from_task_id');

console.log(`Video duration validation passed (${backend.size} backend models, ${frontend.size} frontend models).`);
