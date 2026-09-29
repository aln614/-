'use strict';

const SEEDANCE_MODELS = new Set(['seedance-2.5', 'doubao-seedance-2.5']);
const INHERITED_FIELDS = [
  'prompt', 'prompts', 'image_urls', 'image_with_roles', 'video_urls', 'audio_urls',
  'duration', 'size', 'aspect_ratio', 'seed', 'generate_audio', 'audio',
  'omni_reference_task_type', 'generation_type', 'camerafixed', 'camera_fixed',
  'web_search', 'tools', 'ref_images', 'ref_image_urls', 'video_file', 'video_files',
  'video_url', 'audio_file', 'audio_files', 'document_file', 'file_url', 'link_url',
  'local_video_path', 'local_video_paths', 'local_audio_paths', 'local_document_path'
];

function seedanceDraftSettings(body = {}) {
  const taskId = String(body.draft_task_id || '').trim();
  const draft = body.draft === true;
  if (!draft && !taskId) return { draft:false, taskId:'' };
  if (!SEEDANCE_MODELS.has(String(body.video_model || body.model || '').toLowerCase())) {
    throw new Error('样片模式仅支持 Seedance 2.5。');
  }
  if (draft && taskId) throw new Error('生成样片与样片转正式片不能同时使用。');
  if (Object.hasOwn(body, 'service_tier')) throw new Error('Seedance 2.5 样片模式不支持 service_tier。');
  if (taskId && !/^task_[A-Za-z0-9_-]+$/.test(taskId)) throw new Error('请填写有效的 APIMart 样片任务 ID，不是视频链接或本地 ID。');
  const resolution = taskId ? '1080p' : '480p';
  if (body.resolution && String(body.resolution).toLowerCase() !== resolution) {
    throw new Error(taskId ? '样片转正式片仅支持 1080p。' : '生成样片仅支持 480p。');
  }
  return { draft, taskId, resolution };
}

function validateSeedanceDraftRequest(body = {}) {
  const settings = seedanceDraftSettings(body);
  if (!settings.taskId) return settings;
  // Validate at the request boundary, before local uploads or batch expansion.
  const inherited = INHERITED_FIELDS.filter(key => Object.hasOwn(body, key));
  if (inherited.length || body.multi_first_frame || body.multi_video_reference || body.auto_duration) {
    throw new Error('正式片沿用样片参数，不能重新提交提示词、参考素材、时长、比例或声音设置。');
  }
  buildSeedanceFinalPayload(body);
  return settings;
}

function buildSeedanceFinalPayload(body = {}) {
  const { taskId } = seedanceDraftSettings(body);
  if (!taskId) throw new Error('缺少样片任务 ID。');
  const payload = { model:'seedance-2.5', draft_task_id:taskId, resolution:'1080p' };
  if (body.output_format !== undefined) {
    const format = String(body.output_format).toLowerCase();
    if (!['mp4','mov'].includes(format)) throw new Error('正式片输出格式仅支持 MP4 / MOV。');
    payload.output_format = format;
  }
  for (const key of ['watermark','return_last_frame']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw new Error(`${key} 必须是布尔值。`);
    payload[key] = body[key];
  }
  return payload;
}

module.exports = { seedanceDraftSettings, validateSeedanceDraftRequest, buildSeedanceFinalPayload };
