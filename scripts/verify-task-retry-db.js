const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDB } = require('../src/services/db');
const { isTerminalGenerationError } = require('../src/services/taskErrors');

const failed = '\u5931\u8d25';
const generating = '\u751f\u6210\u4e2d';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-task-retry-'));

try {
  const db = initDB(tempDir);
  db.prepare('INSERT INTO tasks(id)').run({ id:'retry-test', status:generating, attempt:1 });
  const result = db.prepare('UPDATE tasks SET status=?, attempt=?, error_message=?, updated_at=? WHERE id=?')
    .run(failed, 2, 'moderation_blocked', '2026-07-18 12:00:00', 'retry-test');
  const task = db._store.tasks[0];

  if (result.changes !== 1 || task.status !== failed || task.attempt !== 2 || task.progress !== 100 || !task.finished_at) {
    throw new Error(`failed task state was not persisted: ${JSON.stringify(task)}`);
  }
  if (!isTerminalGenerationError(new Error('HTTP 400 moderation_blocked safety_violations=[sexual]'))) {
    throw new Error('moderation rejection must stop retrying');
  }
  if (isTerminalGenerationError(new Error('HTTP 429 rate limited'))) {
    throw new Error('rate limiting must remain retryable');
  }

  db._flushSync();
  console.log('[verify-task-retry-db] OK: terminal failures persist and stop retrying.');
} finally {
  fs.rmSync(tempDir, { recursive:true, force:true });
}
