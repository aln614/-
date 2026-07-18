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
  const start = source.indexOf(marker);
  const end = source.indexOf(']);', start);
  assert(start >= 0 && end > start, `Cannot find registration block: ${marker}`);
  const map = new Map();
  for (const line of source.slice(start, end).split(/\r?\n/)) {
    const match = line.match(/model:'([^']+)'/);
    if (match) map.set(match[1].toLowerCase(), line.trim());
  }
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
assert(/model:'grok-imagine-1\.5-video-apimart'[^\n]*durationRange:\[6,30\],\s*defaultDuration:6/.test(main), 'Grok Imagine 1.5 Video must support 6-30 seconds with default 6');
assert(/model:'grok-imagine-1\.5-video-apimart'[^\n]*durationMin:6,\s*durationMax:30,\s*defaultDuration:6/.test(app), 'Grok Imagine 1.5 Video slider must support 6-30 seconds with default 6');
assert(/id="videoDuration"\s+type="range"/.test(html), 'Video duration must use a range input');
assert(!/<select\s+id="videoDuration"/.test(html), 'Legacy video duration select must not return');
assert(/function selectedVideoDuration\(\)/.test(app), 'Slider must translate its index to a supported duration value');
assert(/body\.duration = durationValue/.test(app), 'Video submit must use the translated duration value');
assert(/rule\.defaultDuration \?\? 6/.test(main), 'Backend must preserve zero-valued model defaults');

console.log(`Video duration validation passed (${backend.size} backend models, ${frontend.size} frontend models).`);
