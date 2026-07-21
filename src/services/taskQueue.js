const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getDB, nowISO, uuid, addLog } = require('./db');
const { generateOne } = require('./apiClient');
const { safeName, createThumb, ensureDir } = require('./cache');
const { isTerminalGenerationError } = require('./taskErrors');

function parseTimeMs(v) {
  if (!v) return Date.now();
  const str = String(v);
  const d = new Date(str.includes('T') ? str : str.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
}
function elapsedMsSince(v) { return Math.max(0, Date.now() - parseTimeMs(v)); }
function taskTimeoutMs(cfg) { return Math.max(1000, Number(cfg.timeoutMs || 0) || 20 * 60 * 1000); }
function isFlowRiskCooldownError(err) {
  const text = String(err && (err.message || err) || '').toLowerCase();
  return text.includes('recaptcha') && (
    text.includes('risk') ||
    text.includes('cooldown') ||
    text.includes('unusual_activity') ||
    text.includes('风控') ||
    text.includes('冷却')
  );
}
function flowRiskBackoffMs(err) {
  const text = String(err && (err.message || err) || '');
  const match = text.match(/(?:remaining|还剩(?:约)?|剩余)[^0-9]{0,16}([0-9]{1,4})\s*(?:s|秒)?/i);
  const seconds = match ? Number(match[1]) + 2 : 47;
  return Math.max(15_000, Math.min(300_000, seconds * 1000));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class TaskQueue extends EventEmitter {
  constructor() {
    super();
    this.running = new Map();
    this.stopFlags = new Set();
    this.resetToken = 0;
    this.progressUpdateCache = new Map();
    this.claimedTasks = new Set();
    this.batchTaskCache = new Map();
    this.flow2ApiBackoffUntil = 0;
    this.flow2ApiRiskStreak = 0;
  }

  async waitForFlow2ApiBackoff(batchId, taskId, token) {
    while (Date.now() < this.flow2ApiBackoffUntil) {
      if (token !== this.resetToken || this.stopFlags.has(batchId)) return false;
      const remainingSeconds = Math.max(1, Math.ceil((this.flow2ApiBackoffUntil - Date.now()) / 1000));
      const db = getDB();
      db.prepare('UPDATE tasks SET progress=?, progress_text=?, updated_at=? WHERE id=?')
        .run(1, `Flow2API 会话恢复中，约 ${remainingSeconds} 秒后自动重试`, nowISO(), taskId);
      this.emit('changed');
      await sleep(Math.min(1000, Math.max(100, this.flow2ApiBackoffUntil - Date.now())));
    }
    return true;
  }

  clearAllRunning() {
    this.resetToken += 1;
    for (const batchId of this.running.keys()) this.stopFlags.add(batchId);
    this.running.clear();
    this.claimedTasks.clear();
    this.batchTaskCache.clear();
    this.emit('changed');
  }

  recoverInterruptedBatches({ resume = true } = {}) {
    const db = getDB();
    const now = nowISO();
    const activeStatuses = new Set(['等待中', '提交中', '提交生成中', '生成中', '查询中', '下载中']);
    const resumableBatchStatuses = new Set(['等待中', '提交中', '提交生成中', '生成中', '查询中', '下载中']);
    const recoveredBatchIds = [];
    let resetForSubmit = 0;
    let resumedRemote = 0;
    let changed = false;

    for (const batch of db._store.batches || []) {
      if (!batch || !resumableBatchStatuses.has(String(batch.status || ''))) continue;
      if (String(batch.model || '').toLowerCase() === 'midjourney') continue;
      const tasks = (db._store.tasks || []).filter(t => t.batch_id === batch.id);
      const normalTasks = tasks.filter(t => !t.mj_source && !t.mj_action);
      if (!normalTasks.length) continue;

      for (const task of normalTasks) {
        if (!activeStatuses.has(String(task.status || ''))) continue;
        const previousStatus = String(task.status || '');
        const hasRemote = !!String(task.remote_task_id || '').trim();
        task.status = hasRemote ? '生成中' : '等待中';
        if (!hasRemote && previousStatus !== '等待中') task.attempt = Math.max(0, Number(task.attempt || 0) - 1);
        task.progress = hasRemote ? Math.max(3, Number(task.progress || 0)) : 0;
        task.progress_text = hasRemote ? '程序重启，继续查询远端结果' : '程序重启，等待重新提交';
        task.error_message = '';
        task.updated_at = now;
        // 离线时间不计入单任务运行超时，但保留原始创建时间用于历史展示。
        task.recovery_started_at = now;
        if (hasRemote) resumedRemote += 1;
        else resetForSubmit += 1;
        changed = true;
      }

      const success = normalTasks.filter(t => t.status === '已完成').length;
      const failed = normalTasks.filter(t => t.status === '失败').length;
      const active = normalTasks.filter(t => activeStatuses.has(String(t.status || '')));
      const remoteActive = active.filter(t => String(t.remote_task_id || '').trim()).length;
      batch.success_count = success;
      batch.fail_count = failed;
      batch.running_count = remoteActive;
      batch.updated_at = now;
      if (active.length) {
        batch.status = '生成中';
        batch.finished_at = '';
        recoveredBatchIds.push(batch.id);
      } else {
        batch.status = failed > 0 && success > 0 ? '部分完成' : (failed > 0 ? '失败' : '已完成');
        batch.finished_at = batch.finished_at || now;
        changed = true;
      }
    }

    if (changed) db._save();
    if (recoveredBatchIds.length) {
      addLog(`启动恢复 ${recoveredBatchIds.length} 个批次：重新提交 ${resetForSubmit} 个任务，继续查询 ${resumedRemote} 个远端任务`);
      if (resume) {
        for (const batchId of recoveredBatchIds) {
          this.runBatch(batchId).catch(err => addLog(`恢复批次运行异常：${err.message}`, { batchId, level:'error' }));
        }
      }
      this.emit('changed');
    }
    return { batchCount: recoveredBatchIds.length, resetForSubmit, resumedRemote, batchIds: recoveredBatchIds };
  }

  createBatch(payload, cfg) {
    const ownerId = payload.ownerId || cfg.ownerId || 'local';
    const prompts = splitPrompts(payload.prompts || '', payload.promptMultilineTasks !== false);
    const mainImages = Array.isArray(payload.mainImages) ? payload.mainImages : [];
    const refImages = Array.isArray(payload.refImages) ? payload.refImages : [];
    const repeatCount = Math.max(1, Number(payload.repeatCount || cfg.repeatCount || 1));
    const concurrency = Math.max(1, Number(payload.concurrency || cfg.concurrency || 1));
    const taskPrompts = prompts.length ? prompts : [''];
    const batchId = uuid('batch_');
    const createdAt = nowISO();
    const name = payload.name || `Batch_${createdAt.replace(/[\s:]/g, '_')}`;
    const baseOut = payload.outputDir || cfg.outputDir || path.join(require('electron').app.getPath('pictures'), 'TENYING_AI_1_0');
    const outputDir = path.join(baseOut, safeName(name));
    const fullCfg = {
      ...cfg,
      ...payload,
      ownerId,
      concurrency,
      repeatCount,
      outputDir
    };

    const tasks = [];
    let idx = 1;
    for (const main of (mainImages.length ? mainImages : [''])) {
      for (const prompt of taskPrompts) {
        for (let r = 0; r < repeatCount; r++) {
          tasks.push({
            id: uuid('task_'), batch_id: batchId, owner_id: ownerId, task_index: idx++, prompt,
            main_image_path: main || '', ref_images_json: JSON.stringify(refImages), status: '等待中', attempt: 0,
            remote_task_id: '', result_path: '', thumb_path: '', error_message: '', created_at: createdAt, updated_at: createdAt, finished_at: ''
          });
        }
      }
    }

    const db = getDB();
    const insertBatch = db.prepare(`INSERT INTO batches(id,owner_id,name,note,status,model,size,image_size,concurrency,retry_times,repeat_count,task_count,success_count,fail_count,running_count,output_dir,config_json,created_at,updated_at,finished_at)
      VALUES(@id,@owner_id,@name,@note,@status,@model,@size,@image_size,@concurrency,@retry_times,@repeat_count,@task_count,0,0,0,@output_dir,@config_json,@created_at,@updated_at,'')`);
    const insertTask = db.prepare(`INSERT INTO tasks(id,batch_id,owner_id,task_index,prompt,main_image_path,ref_images_json,status,attempt,remote_task_id,result_path,thumb_path,error_message,created_at,updated_at,finished_at)
      VALUES(@id,@batch_id,@owner_id,@task_index,@prompt,@main_image_path,@ref_images_json,@status,@attempt,@remote_task_id,@result_path,@thumb_path,@error_message,@created_at,@updated_at,@finished_at)`);
    db.transaction(() => {
      insertBatch.run({
        id: batchId, owner_id: ownerId, name, note: '', status: '等待中', model: fullCfg.model, size: fullCfg.size,
        image_size: fullCfg.imageSize, concurrency, retry_times: Number(fullCfg.retryTimes || 0), repeat_count: repeatCount,
        task_count: tasks.length, output_dir:outputDir, config_json: JSON.stringify(fullCfg), created_at: createdAt, updated_at: createdAt
      });
      for (const t of tasks) insertTask.run(t);
    })();
    addLog(`创建批次 ${name}，共 ${tasks.length} 个任务`, { ownerId, batchId });
    setImmediate(() => this.runBatch(batchId).catch(err => addLog(`批次运行异常：${err.message}`, { ownerId, batchId, level: 'error' })));
    return { id: batchId, name, taskCount: tasks.length, outputDir };
  }

  stopBatch(batchId) {
    this.stopFlags.add(batchId);
    getDB().prepare('UPDATE batches SET status=?, updated_at=? WHERE id=?').run('已停止', nowISO(), batchId);
    this.emit('changed');
    return true;
  }

  async runBatch(batchId) {
    if (this.running.has(batchId)) return;
    const token = this.resetToken;
    this.running.set(batchId, true);
    try {
      const db = getDB();
      const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
      if (!batch) return;
      try {
        await Promise.all([
          fs.promises.mkdir(batch.output_dir, { recursive:true }),
          fs.promises.mkdir(path.join(batch.output_dir, '_thumbs'), { recursive:true })
        ]);
      } catch (error) {
        const message = `创建批次输出目录失败：${error.message || error}`;
        const now = nowISO();
        const storedBatch = (db._store.batches || []).find(row => row.id === batchId);
        const storedTasks = (db._store.tasks || []).filter(task => task.batch_id === batchId);
        for (const task of storedTasks) Object.assign(task, { status:'失败', progress:100, progress_text:message, error_message:message, updated_at:now, finished_at:now });
        if (storedBatch) Object.assign(storedBatch, { status:'失败', fail_count:storedTasks.length, running_count:0, updated_at:now, finished_at:now });
        db._save();
        addLog(message, { ownerId:batch.owner_id, batchId, level:'error' });
        this.emit('changed');
        return;
      }
      const cfg = JSON.parse(batch.config_json || '{}');
      const concurrency = Math.max(1, Number(batch.concurrency || cfg.concurrency || 1));
      const batchTasks = (db._store.tasks || [])
        .filter(task => task.batch_id === batchId)
        .sort((a, b) => Number(a.task_index) - Number(b.task_index));
      this.batchTaskCache.set(batchId, batchTasks);
      db.prepare('UPDATE batches SET status=?, updated_at=? WHERE id=?').run('生成中', nowISO(), batchId);
      this.emit('changed');
      addLog(`批次开始生成，并发：${concurrency}`, { ownerId: batch.owner_id, batchId });

      const workers = Array.from({ length: concurrency }, () => this.worker(batchId, token));
      await Promise.all(workers);
      if (token !== this.resetToken) return;
      const finalBatch = db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
      if (finalBatch.status !== '已停止') {
        const status = Number(finalBatch.fail_count || 0) >= Number(finalBatch.task_count || 0) && Number(finalBatch.success_count || 0) === 0
          ? '失败'
          : (finalBatch.fail_count > 0 && finalBatch.success_count < finalBatch.task_count ? '部分完成' : '已完成');
        db.prepare('UPDATE batches SET status=?, running_count=0, finished_at=?, updated_at=? WHERE id=?').run(status, nowISO(), nowISO(), batchId);
        addLog(`批次结束：成功 ${finalBatch.success_count}，失败 ${finalBatch.fail_count}`, { ownerId: batch.owner_id, batchId });
      }
      this.emit('changed');
    } finally {
      if (token === this.resetToken) {
        this.running.delete(batchId);
        this.stopFlags.delete(batchId);
        this.batchTaskCache.delete(batchId);
      }
    }
  }

  async worker(batchId, token = this.resetToken) {
    const db = getDB();
    while (!this.stopFlags.has(batchId) && token === this.resetToken) {
      const candidates = this.batchTaskCache.get(batchId) || [];
      const task = candidates.find(t =>
        !this.claimedTasks.has(t.id) && (t.status === '等待中' || (t.status === '生成中' && String(t.remote_task_id || '') !== ''))
      );
      if (!task) break;
      this.claimedTasks.add(task.id);
      try {
        const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
        const cfg = JSON.parse(batch.config_json || '{}');
        const limitMs = taskTimeoutMs(cfg);
        const elapsedBefore = elapsedMsSince(task.recovery_started_at || task.created_at);
        if (elapsedBefore >= limitMs) {
          db.transaction(() => {
            db.prepare('UPDATE tasks SET status=?, error_message=?, updated_at=?, finished_at=? WHERE id=?').run('失败', `单任务累计超时：${Math.round(elapsedBefore/1000)} 秒`, nowISO(), nowISO(), task.id);
            db.prepare('UPDATE batches SET fail_count=fail_count+1, updated_at=? WHERE id=?').run(nowISO(), batchId);
          })();
          addLog(`任务 ${task.task_index} 累计超时`, { ownerId: task.owner_id, batchId, level: 'error' });
          this.emit('changed');
          continue;
        }
        const flow2apiMode = String(cfg.imageApiPlatform || '').toLowerCase() === 'flow2api';
        if (flow2apiMode && this.flow2ApiBackoffUntil > Date.now()) {
          const canContinue = await this.waitForFlow2ApiBackoff(batchId, task.id, token);
          if (!canContinue) return;
        }
        const attempt = Number(task.attempt || 0) + (task.status === '生成中' && task.remote_task_id ? 0 : 1);
        const nextStatus = task.remote_task_id ? '生成中' : '提交生成中';
        const platformName = String(cfg.imageApiPlatform || '').toLowerCase() === 'flow2api' ? '本地 Flow2API' : 'APIMart';
        db.prepare('UPDATE tasks SET status=?, attempt=?, progress=?, progress_text=?, updated_at=? WHERE id=?').run(nextStatus, attempt, task.remote_task_id ? Math.max(3, Number(task.progress || 0)) : 1, task.remote_task_id ? '批量查询远端结果中' : `正在提交到 ${platformName}`, nowISO(), task.id);
        if (!(task.status === '生成中' && task.remote_task_id)) db.prepare('UPDATE batches SET running_count=running_count+1, updated_at=? WHERE id=?').run(nowISO(), batchId);
        this.emit('changed');
        try {
        const ext = '.png';
        const fileName = String(task.task_index).padStart(5, '0') + ext;
        const outPath = path.join(batch.output_dir, fileName);
        const refImages = JSON.parse(task.ref_images_json || '[]');
        const remainingMs = Math.max(1000, limitMs - elapsedMsSince(task.recovery_started_at || task.created_at));
        addLog(task.remote_task_id ? `任务 ${task.task_index} 并发查询结果ID：${task.remote_task_id}` : `任务 ${task.task_index} 提交 API`, { ownerId: task.owner_id, batchId });
        const result = await generateOne({
          cfg: {
            ...cfg,
            timeoutMs: remainingMs,
            deadlineAt: Date.now() + remainingMs,
            onSubmitLog: (info = {}) => {
              if (info.url) addLog(`${platformName} 图片实际提交：POST ${info.url}`, { ownerId: task.owner_id, batchId });
              if (info.payload) addLog(`${platformName} 图片提交参数：${info.payload}`, { ownerId: task.owner_id, batchId });
              if (info.taskId) addLog(`${platformName} 图片接口返回 task_id：${info.taskId}`, { ownerId: task.owner_id, batchId });
              if (info.response && !info.taskId) addLog(`${platformName} 图片接口响应：${info.response}`, { ownerId: task.owner_id, batchId });
            }
          },
          prompt: task.prompt,
          mainImagePath: task.main_image_path,
          refImages,
          outputPath: outPath,
          remoteTaskId: task.remote_task_id || '',
          onSubmitted: (remoteId) => {
            db.prepare('UPDATE tasks SET status=?, remote_task_id=?, progress=?, progress_text=?, updated_at=? WHERE id=?').run('生成中', remoteId || '', 5, '已提交，等待批量查询结果', nowISO(), task.id);
            db._save();
            addLog(`任务 ${task.task_index} 已提交，开始并发查询ID：${remoteId}`, { ownerId: task.owner_id, batchId });
            this.emit('changed');
          },
          onProgress: (info = {}) => {
            const mapped = friendlyImageProgress(info);
            const p = mapped.progress;
            const txt = mapped.text;
            const last = this.progressUpdateCache.get(task.id) || { at:0, progress:-1, text:'' };
            const nowMs = Date.now();
            // 进度展示要更平滑，同时避免过高频率写库。
            if (nowMs - last.at < 800 && Math.abs(p - last.progress) < 1 && txt === last.text) return;
            this.progressUpdateCache.set(task.id, { at:nowMs, progress:p, text:txt });
            db.prepare('UPDATE tasks SET progress=?, progress_text=?, updated_at=? WHERE id=?').run(p, txt, nowISO(), task.id);
            this.emit('changed');
          }
        });
        if (token !== this.resetToken || this.stopFlags.has(batchId)) return;
        const thumbPath = path.join(batch.output_dir, '_thumbs', String(task.task_index).padStart(5, '0') + '.png');
        ensureDir(path.dirname(thumbPath));
        createThumb(outPath, thumbPath, Number(cfg.thumbSize || 300));
        const stat = fs.existsSync(outPath) ? fs.statSync(outPath) : { size: 0 };
        const extraImages = Array.isArray(result.extraImages) ? result.extraImages : [];
        db.transaction(() => {
          db.prepare('UPDATE tasks SET progress=?, progress_text=?, updated_at=? WHERE id=?').run(100, '已完成', nowISO(), task.id);
          db.prepare('UPDATE tasks SET status=?, remote_task_id=?, result_path=?, thumb_path=?, updated_at=?, finished_at=? WHERE id=?').run('已完成', result.remoteTaskId || '', outPath, thumbPath, nowISO(), nowISO(), task.id);
          db.prepare('INSERT INTO images(id,batch_id,task_id,owner_id,file_path,thumb_path,size_bytes,created_at,remote_url) VALUES(?,?,?,?,?,?,?,?,?)').run(uuid('img_'), batchId, task.id, task.owner_id, outPath, thumbPath, stat.size || 0, nowISO(), result.imageUrl || '');
          this.progressUpdateCache.delete(task.id);
          for (let i = 0; i < extraImages.length; i++) {
            const extra = extraImages[i] || {};
            if (!extra.outputPath || !fs.existsSync(extra.outputPath)) continue;
            const extraThumb = path.join(batch.output_dir, '_thumbs', String(task.task_index).padStart(5, '0') + '_' + String(i+2).padStart(2, '0') + '.png');
            ensureDir(path.dirname(extraThumb));
            createThumb(extra.outputPath, extraThumb, Number(cfg.thumbSize || 300));
            const extraStat = fs.statSync(extra.outputPath);
            db.prepare('INSERT INTO images(id,batch_id,task_id,owner_id,file_path,thumb_path,size_bytes,created_at,remote_url) VALUES(?,?,?,?,?,?,?,?,?)').run(uuid('img_'), batchId, task.id, task.owner_id, extra.outputPath, extraThumb, extraStat.size || 0, nowISO(), extra.imageUrl || '');
          }
          db.prepare('UPDATE batches SET success_count=success_count+1, running_count=MAX(running_count-1,0), updated_at=? WHERE id=?').run(nowISO(), batchId);
        })();
        db._save();
        addLog(`任务 ${task.task_index} 完成${extraImages.length ? '，额外保存 ' + extraImages.length + ' 张' : ''}`, { ownerId: task.owner_id, batchId });
        if (flow2apiMode) {
          this.flow2ApiRiskStreak = 0;
          this.flow2ApiBackoffUntil = 0;
        }
        } catch (err) {
        if (token !== this.resetToken || this.stopFlags.has(batchId)) return;
        const maxRetry = Number(batch.retry_times || cfg.retryTimes || 0);
        const timedOut = elapsedMsSince(task.recovery_started_at || task.created_at) >= taskTimeoutMs(cfg);
        const flowRiskCooldown = flow2apiMode && isFlowRiskCooldownError(err);
        const terminalError = isTerminalGenerationError(err);
        if (flowRiskCooldown) {
          this.flow2ApiRiskStreak = Math.min(4, this.flow2ApiRiskStreak + 1);
          const adaptiveBackoff = Math.min(300_000, 45_000 * (2 ** (this.flow2ApiRiskStreak - 1)));
          this.flow2ApiBackoffUntil = Math.max(
            this.flow2ApiBackoffUntil,
            Date.now() + Math.max(flowRiskBackoffMs(err), adaptiveBackoff)
          );
        }
        const shouldRetry = !timedOut && !terminalError && (flowRiskCooldown || attempt <= maxRetry);
        const nextAttempt = flowRiskCooldown
          ? Math.max(0, attempt - 1)
          : (String(task.remote_task_id || '').trim() ? attempt + 1 : attempt);
        const retryError = flowRiskCooldown
          ? 'Flow2API reCAPTCHA 会话正在恢复，任务将在当前批次内自动重试'
          : (err.message || String(err));
        db.transaction(() => {
          db.prepare('UPDATE tasks SET status=?, attempt=?, error_message=?, updated_at=? WHERE id=?').run(shouldRetry ? '等待中' : '失败', nextAttempt, timedOut ? `单任务累计超时：${Math.round(elapsedMsSince(task.recovery_started_at || task.created_at)/1000)} 秒` : retryError, nowISO(), task.id);
          db.prepare('UPDATE batches SET fail_count=fail_count+?, running_count=MAX(running_count-1,0), updated_at=? WHERE id=?').run(shouldRetry ? 0 : 1, nowISO(), batchId);
        })();
        db._save();
        addLog(`任务 ${task.task_index} ${shouldRetry ? '失败重试' : '失败'}：${retryError}`, { ownerId: task.owner_id, batchId, level: shouldRetry ? 'warning' : 'error' });
      }
      this.emit('changed');
      } finally {
        this.claimedTasks.delete(task.id);
      }
    }
  }
}

function friendlyImageProgress(info = {}) {
  const statusText = String(info.statusText || '').toLowerCase();
  const rawProgress = Number.isFinite(Number(info.progress)) ? Number(info.progress) : 0;
  let progress = Math.max(0, Math.min(100, rawProgress));
  let text = '正在批量查询结果';
  if (['queued','queueing','pending','created','submitted'].includes(statusText)) {
    progress = Math.max(progress, 12);
    text = progress > 0 ? `远端排队中 ${progress}%` : '远端排队中';
  } else if (['processing','running','in_progress','generating'].includes(statusText)) {
    progress = Math.max(progress, 55);
    text = progress > 0 ? `远端生成中 ${progress}%` : '远端生成中';
  } else if (['completed','complete','succeeded','success','done','finished'].includes(statusText)) {
    progress = Math.max(progress, 98);
    text = '远端已完成，正在下载到本地';
  } else if (statusText) {
    progress = Math.max(progress, 8);
    text = `远端状态：${statusText}`;
  } else if (progress > 0) {
    text = `正在查询进度 ${progress}%`;
  }
  return { progress, text };
}

function splitPrompts(text, multiline = true) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  // V8.9 修复：关闭“提示词多行多任务”时，整个输入框必须作为一个完整提示词，绝不按换行或空行拆分。
  if (multiline === false) return [raw];
  const blankParts = raw.split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
  if (blankParts.length > 1) return blankParts;
  return raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
}

module.exports = { TaskQueue, splitPrompts };
