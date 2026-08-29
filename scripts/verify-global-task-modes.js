const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');

assert(main.includes('allTasks.length + allVideoTasks.length'), 'API monitor total must combine image and video tasks');
assert(main.includes('global_active_tasks'), 'status API must expose a global active-task count');
assert(main.includes("parsed.query.summary === '1'"), 'status API must provide a lightweight realtime summary');
assert(main.includes("p === '/api/delete_batches'"), 'mixed history batch deletion endpoint is missing');
assert(main.includes('function deleteHistoryBatches'), 'mixed image/video batch deletion implementation is missing');

assert(html.includes('id="deleteSelectedBatchesBtn"'), 'history bulk delete button is missing');
assert(html.includes('id="videoMultiFirstFrame"'), 'multi-first-frame switch is missing');
const videoFileInput = html.match(/<input id="videoFile"[^>]*>/)?.[0] || '';
assert(videoFileInput, 'video main-file input is missing');
assert(!/\saccept=/.test(videoFileInput), 'video main-file input must allow every non-image file before runtime classification');

assert(app.includes('videoMultiFirstFrameEnabled'), 'multi-first-frame frontend state is missing');
assert(app.includes('multi_first_frame:multiFirstFrame'), 'multi-first-frame flag is not submitted');
assert(app.includes("video_files:multiFirstFrame ? [] : videoFilesData"), 'multi-first-frame mode must ignore main video files');
assert(main.includes('ref_image_urls:[imageUrl]'), 'backend must split each reference image into one task');
assert(main.includes("video_mode:multiFirstFrame ? 'first_frame'"), 'backend must force first-frame mode');

console.log('Global task monitor, history bulk delete, and multi-first-frame verification passed.');
