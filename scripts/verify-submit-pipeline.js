const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { performance } = require('perf_hooks');
const { initDB, nowISO } = require('../src/services/db');
const { createUploadCache } = require('../src/services/asyncWork');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('pipeline stalled')), 8000);
    })]);
  } finally { clearTimeout(timer); }
}
function loadService(name, overrides, extra = '') {
  const file = path.resolve(__dirname, '../src/services', name);
  const localRequire = createRequire(file);
  const sandbox = {
    module:{ exports:{} }, require:id => overrides[id] || localRequire(id),
    process, Buffer, URL, AbortController, setTimeout, clearTimeout, setImmediate, console
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + extra, sandbox, { filename:file });
  return sandbox.module.exports;
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-submit-pipeline-'));
  const db = initDB(temp);
  let generate;
  const cache = {
    safeName:value => value,
    createThumbAsync:async (_source, thumb) => { await fs.promises.writeFile(thumb, 'thumbnail'); return thumb; }
  };
  const { TaskQueue } = loadService('taskQueue.js', {
    './apiClient':{ generateOne:args => generate(args) }, './cache':cache
  });
  let serial = 0;
  function batch(count, concurrency = 10, retry = 2) {
    const id = `batch_${++serial}`;
    const output = path.join(temp, id);
    const row = {
      id, owner_id:'test', model:'gpt-image-2', status:'等待中', task_count:count,
      success_count:0, fail_count:0, running_count:0, concurrency, retry_times:retry,
      output_dir:output, config_json:JSON.stringify({ model:'gpt-image-2', timeoutMs:30000 }),
      created_at:nowISO(), updated_at:nowISO()
    };
    db._store.batches.push(row);
    const tasks = Array.from({ length:count }, (_, i) => ({
      id:`${id}_${i}`, batch_id:id, owner_id:'test', task_index:i+1,
      status:'等待中', attempt:0, prompt:`${i}`, ref_images_json:'[]', remote_task_id:'',
      // An old waiting batch must receive a fresh runtime budget when dispatched.
      created_at:'2020-01-01 00:00:00', updated_at:nowISO()
    }));
    db._store.tasks.push(...tasks);
    return { row, tasks };
  }
  async function result(args, remote) {
    await fs.promises.writeFile(args.outputPath, 'image');
    return { remoteTaskId:remote, imageUrl:`https://example.invalid/${remote}.png` };
  }
  try {
    const first = batch(100, 10);
    const queue = new TaskQueue();
    const accepted = deferred();
    const finish = deferred();
    let pending = 0, peak = 0, submits = 0;
    generate = async args => {
      pending += 1; peak = Math.max(peak, pending);
      await sleep(2);
      pending -= 1;
      submits += 1;
      const remote = `remote_${args.prompt}`;
      args.onSubmitted(remote);
      if (submits === 100) accepted.resolve();
      await finish.promise;
      return result(args, remote);
    };
    const start = performance.now();
    const run = queue.runBatch(first.row.id);
    let submissionMs;
    try {
      await bounded(accepted.promise);
      submissionMs = Math.round(performance.now() - start);
      assert.strictEqual(peak, 10, 'submit concurrency must match configuration');
      assert.strictEqual(first.row.running_count, 100, 'remote tasks remain active after freeing submit slots');
      assert.strictEqual(first.row.success_count, 0, 'all submissions must finish before any generated result is released');
      assert(first.tasks.every(t => t.remote_task_id && t.remote_submitted_at && t.execution_started_at_ms));
      assert.strictEqual(new Set(first.tasks.map(t => t.remote_task_id)).size, 100);
    } finally { finish.resolve(); await bounded(run); }
    assert.strictEqual(first.row.status, '已完成');
    assert.strictEqual(first.row.success_count, 100);
    assert.strictEqual(first.row.fail_count, 0);
    assert.strictEqual(first.row.running_count, 0);
    assert.strictEqual(db._store.images.filter(i => i.batch_id === first.row.id).length, 100);

    const retry = batch(4, 2);
    const calls = new Map();
    const posted = new Map();
    generate = async args => {
      const n = (calls.get(args.prompt) || 0) + 1; calls.set(args.prompt, n);
      if (args.prompt === '0' && n === 1) throw new Error('temporary upload error');
      if (args.prompt === '2') throw Object.assign(new Error('invalid prompt'), { terminal:true });
      let remote = args.remoteTaskId;
      if (!remote) {
        remote = `retry_${args.prompt}`;
        posted.set(args.prompt, (posted.get(args.prompt) || 0) + 1);
        args.onSubmitted(remote);
      }
      if (args.prompt === '1' && n === 1) throw new Error('temporary poll error');
      return result(args, remote);
    };
    await bounded(queue.runBatch(retry.row.id));
    assert.strictEqual(retry.row.success_count, 3);
    assert.strictEqual(retry.row.fail_count, 1);
    assert.strictEqual(retry.row.running_count, 0);
    assert.strictEqual(calls.get('0'), 2);
    assert.strictEqual(calls.get('1'), 2);
    assert.strictEqual(calls.get('2'), 1);
    assert.strictEqual(posted.get('1'), 1, 'poll retry must not submit a duplicate billable task');

    const resumed = batch(2, 1);
    resumed.tasks[0].status = '生成中'; resumed.tasks[0].remote_task_id = 'existing';
    resumed.tasks[0].attempt = 1;
    generate = async args => {
      if (args.prompt === '0') assert.strictEqual(args.remoteTaskId, 'existing');
      else args.onSubmitted('new');
      return result(args, args.remoteTaskId || 'new');
    };
    await bounded(queue.runBatch(resumed.row.id));
    assert.strictEqual(resumed.row.success_count, 2);
    assert.strictEqual(resumed.row.running_count, 0);
    assert.strictEqual(resumed.tasks[0].attempt, 1);

    const expiredTask = batch(1);
    expiredTask.tasks[0].execution_started_at_ms = Date.now() - 60000;
    generate = async () => { throw new Error('expired tasks must not reach the API'); };
    await bounded(queue.runBatch(expiredTask.row.id));
    assert.strictEqual(expiredTask.tasks[0].status, '失败');
    assert.strictEqual(expiredTask.row.fail_count, 1);
    assert.strictEqual(expiredTask.row.running_count, 0);

    const stopped = batch(100, 3);
    const started = deferred(), unblock = deferred();
    let entered = 0;
    generate = async args => {
      entered += 1;
      if (entered === 3) started.resolve();
      await unblock.promise;
      assert.strictEqual(args.cfg.shouldContinue(), false);
      throw new Error('stopped');
    };
    const stopping = queue.runBatch(stopped.row.id);
    try { await bounded(started.promise); queue.stopBatch(stopped.row.id); }
    finally { unblock.resolve(); await bounded(stopping); }
    assert.strictEqual(entered, 3, 'stopping must prevent all remaining queued submissions');
    assert.strictEqual(stopped.row.status, '已停止');
    assert.strictEqual(queue.claimedTasks.size, 0);

    const reset = batch(8, 1);
    const resetStarted = deferred(), resetContinue = deferred();
    generate = async args => {
      resetStarted.resolve(); await resetContinue.promise;
      args.onSubmitted('late-remote');
      args.onProgress({ progress:20 });
      throw new Error('reset');
    };
    const resetting = queue.runBatch(reset.row.id);
    try { await bounded(resetStarted.promise); queue.clearAllRunning(); }
    finally { resetContinue.resolve(); await bounded(resetting); }
    assert(reset.tasks.every(task => !task.remote_task_id), 'late callbacks must not mutate reset state');
    assert.strictEqual(queue.running.size, 0);

    const uploadFile = path.join(temp, 'reference.png');
    await fs.promises.writeFile(uploadFile, 'original');
    const reuse = createUploadCache();
    let uploads = 0;
    const upload = async () => { uploads += 1; await sleep(3); return 'https://example.invalid/ref.png'; };
    await Promise.all(Array.from({ length:100 }, () => reuse(uploadFile, upload)));
    assert.strictEqual(uploads, 1, 'shared reference upload should be single-flight');
    await reuse(uploadFile, upload); assert.strictEqual(uploads, 1);
    await fs.promises.writeFile(uploadFile, 'changed-reference');
    await reuse(uploadFile, upload); assert.strictEqual(uploads, 2);
    await createUploadCache()(uploadFile, upload); assert.strictEqual(uploads, 3, 'batch/account caches must be isolated');
    const failedUpload = createUploadCache();
    await assert.rejects(failedUpload(uploadFile, () => Promise.reject(new Error('upload failed'))));
    await failedUpload(uploadFile, upload); assert.strictEqual(uploads, 4);
    const expired = createUploadCache({ ttlMs:0 });
    await expired(uploadFile, upload); await expired(uploadFile, upload); assert.strictEqual(uploads, 6);

    const api = loadService('apiClient.js', { './cache':{} }, `
      module.exports.test = {
        query:queryApimartTaskBatchAware,
        setNetwork(value) { postJson=value.post; queryApimartTaskSingle=value.single; uploadImageToApimart=value.upload; }
      };
    `);
    let realSubmits = 0, realUploads = 0;
    api.test.setNetwork({
      post:async (_url, _key, payload) => {
        if (payload.task_ids) return { data:payload.task_ids.map(id => ({ id, status:'completed', b64_json:Buffer.from('result').toString('base64') })) };
        realSubmits += 1; return { task_id:'generated' };
      },
      single:async () => { throw new Error('unexpected single query'); },
      upload:async () => { realUploads += 1; return 'https://example.invalid/upload.png'; }
    });
    await api.generateOne({
      cfg:{ model:'gpt-image-2', timeoutMs:10000 }, remoteTaskId:'existing',
      mainImagePath:path.join(temp, 'missing-source.png'), refImages:[path.join(temp, 'missing-ref.png')],
      outputPath:path.join(temp, 'resumed.png')
    });
    assert.strictEqual(realSubmits, 0); assert.strictEqual(realUploads, 0, 'remote resume must not need source uploads');
    assert.strictEqual(await fs.promises.readFile(path.join(temp, 'resumed.png'), 'utf8'), 'result');

    let syncAccepted = false;
    api.test.setNetwork({ post:async () => ({ b64_json:Buffer.from('sync result').toString('base64') }) });
    await api.generateOne({
      cfg:{ model:'gpt-image-2', onSubmissionAccepted:() => { syncAccepted = true; },
        runResultDownload:fn => { assert(syncAccepted, 'synchronous results must free the submit slot before saving'); return fn(); } },
      outputPath:path.join(temp, 'sync.png')
    });

    const slow = deferred(), slowStarted = deferred();
    let queryActive = 0, queryPeak = 0;
    const chunkSizes = [];
    api.test.setNetwork({
      post:async (_url, _key, payload) => {
        chunkSizes.push(payload.task_ids.length);
        return { data:payload.task_ids.filter(id => !['slow','missing'].includes(id)).map(id => ({ id, status:'completed', result:{ image_url:`https://example.invalid/${id}.png` } })) };
      },
      single:async (_base, _key, id) => {
        queryActive += 1; queryPeak = Math.max(queryPeak, queryActive);
        try {
          if (id === 'slow') { slowStarted.resolve(); await slow.promise; }
          return { id, status:'pending' };
        } finally { queryActive -= 1; }
      }
    });
    const slowQuery = api.test.query('https://api.apimart.ai', 'test', 'slow');
    const missing = api.test.query('https://api.apimart.ai', 'test', 'missing');
    const ready = Promise.all(Array.from({ length:120 }, (_, i) => api.test.query('https://api.apimart.ai', 'test', `ready_${i}`)));
    try {
      await bounded(slowStarted.promise);
      assert.strictEqual((await bounded(ready)).length, 120, 'one slow fallback must not block other completed tasks');
      assert.strictEqual((await bounded(missing)).id, 'missing', 'missing batch task must use its own single result');
      assert(chunkSizes.every(size => size <= 50));
      assert.strictEqual(chunkSizes.reduce((a,b) => a+b, 0), 122);
      assert(queryPeak <= 4);
    } finally { slow.resolve(); await bounded(slowQuery); }

    queryPeak = 0;
    api.test.setNetwork({
      post:async () => { throw new Error('batch unavailable'); },
      single:async (_base, _key, id) => {
        queryActive += 1; queryPeak = Math.max(queryPeak, queryActive);
        await sleep(3); queryActive -= 1;
        return { id, status:'pending' };
      }
    });
    await bounded(Promise.all(Array.from({ length:20 }, (_, i) => api.test.query('https://api.apimart.ai', 'test', `fallback_${i}`))));
    assert.strictEqual(queryPeak, 4, 'fallback requests must run concurrently without flooding processes');

    console.log(`[verify-submit-pipeline] OK: 100/100 accepted before any result; peak submit concurrency 10; mock dispatch ${submissionMs}ms. Retries, stop, resume, upload reuse and independent polling passed.`);
  } finally {
    db._save(); await db._flush(); db._flushSync();
    const target = path.resolve(temp);
    assert(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(target, { recursive:true, force:true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
