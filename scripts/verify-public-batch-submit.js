const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const rendererJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const queueJs = fs.readFileSync(path.join(root, 'src', 'services', 'taskQueue.js'), 'utf8');

function assert(value, message) {
  if (!value) throw new Error(message);
}

assert(mainJs.includes("p === '/api/batch_media_upload'"), 'binary public batch-media upload route is missing');
assert(mainJs.includes('receiveBatchMediaUpload(req, parsed, deviceOwner)'), 'batch media upload is not scoped to the current device');
assert(mainJs.includes('resolveBatchMediaUploadIds(body.main_image_upload_ids, owner)'), 'main-image upload IDs are not resolved server-side');
assert(mainJs.includes('await pipeline(req, limiter, fs.createWriteStream'), 'batch media upload is not streamed to disk');
assert(mainJs.includes("'--protocol', 'http2', '--edge-ip-version', '4'"), 'Cloudflare tunnel is not using stable HTTP/2 over IPv4');
assert(mainJs.includes("host === 'api.trycloudflare.com'"), 'Cloudflare control endpoint can still be mistaken for a public tunnel URL');
assert(mainJs.includes('tunnelRetryAttempt < 4'), 'failed quick tunnels are not retried with a finite limit');
assert(rendererJs.includes('function stagePublicBatchMedia'), 'public media pre-upload helper is missing');
assert(rendererJs.includes('body.main_image_upload_ids = mainImages.map'), 'public batch submit does not use staged main-image IDs');
assert(rendererJs.includes('body.main_images = []'), 'public batch request does not remove staged Base64 main images');
assert(rendererJs.includes('const PUBLIC_BATCH_UPLOAD_CONCURRENCY = 4'), 'public upload concurrency limit is missing');
assert(rendererJs.includes('publicBatchUploadsActive < PUBLIC_BATCH_UPLOAD_CONCURRENCY'), 'public pre-upload queue does not enforce its concurrency limit');
assert(rendererJs.includes("if(isPublicClient) refreshAll().catch(()=>{})"), 'public batch submit still waits for the full panel refresh');
assert(queueJs.includes('setImmediate(() => this.runBatch(batchId)'), 'batch work still starts before the create response can return');
assert(!queueJs.includes('const dirs = makeDirs(baseOut, name)'), 'NAS directories are still created synchronously in createBatch');
assert(queueJs.includes("fs.promises.mkdir(batch.output_dir"), 'batch output directory is not created asynchronously');

console.log('[verify-public-batch-submit] OK: binary pre-upload, lightweight create request, and deferred NAS startup are wired.');
