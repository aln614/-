const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDB, getDB, nowISO } = require('../src/services/db');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app:{ getPath:() => os.tmpdir() },
      nativeImage:{ createFromPath:() => ({ isEmpty:() => true }) }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { TaskQueue } = require('../src/services/taskQueue');
Module._load = originalLoad;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-status-recovery-'));
  initDB(root);
  const db = getDB();
  const now = nowISO();
  db._store.batches.push({
    id:'batch_test', owner_id:'local', model:'gemini-test', status:'部分完成',
    task_count:2, success_count:1, fail_count:1, running_count:0,
    concurrency:30, retry_times:2, output_dir:path.join(root, 'output'),
    config_json:'{}', created_at:now, updated_at:now, finished_at:now
  });
  db._store.tasks.push(
    { id:'task_done', batch_id:'batch_test', owner_id:'local', task_index:1, status:'已完成', created_at:now, updated_at:now },
    {
      id:'task_download', batch_id:'batch_test', owner_id:'local', task_index:2,
      status:'失败', progress:100, remote_task_id:'remote_123', created_at:now, updated_at:now,
      error_message:'远端结果已生成，但下载到本地失败：network timeout'
    }
  );

  const queue = new TaskQueue();
  assert.strictEqual(queue.normalizeRemoteDownloadFailures(), 1);
  assert.strictEqual(db._store.tasks[1].status, '下载待恢复');
  assert.strictEqual(db._store.tasks[1].progress, 99);
  assert.strictEqual(db._store.batches[0].status, '下载待恢复');
  assert.strictEqual(db._store.batches[0].fail_count, 0);

  const started = [];
  queue.runBatch = async batchId => { started.push(batchId); };
  const recovered = await queue.retryRemoteDownloadFailures();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(recovered, { taskCount:1, batchCount:1 });
  assert.strictEqual(db._store.tasks[1].status, '下载中');
  assert.strictEqual(db._store.batches[0].running_count, 1);
  assert.deepStrictEqual(started, ['batch_test']);
  queue.stopRemoteDownloadRecovery();
  fs.rmSync(root, { recursive:true, force:true });
  console.log('Status refresh/download recovery verification passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
