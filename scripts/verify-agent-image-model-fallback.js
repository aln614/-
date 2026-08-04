'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(renderer.includes('const AGENT_IMAGE_MODEL_PLACEHOLDERS'), 'renderer model placeholder list is missing');
assert(renderer.includes("'自由选择'"), 'renderer does not block the free-selection label');
assert(renderer.includes("'gpt-image-2'"), 'renderer fallback model is missing');
assert(renderer.includes('function resolveAgentImageModel'), 'renderer Agent image model resolver is missing');
assert(renderer.includes('body.model = resolveAgentImageModel(body.model);'), 'Agent batch creation does not normalize the requested model');
assert(renderer.includes('禁止把“自由选择”、“Agent 自由选择”或“auto”写入 model 参数'), 'Agent system prompt does not prohibit UI-state model IDs');

assert(main.includes('APIMART_IMAGE_MODELS } = require'), 'main process does not import the APIMart image model list');
assert(main.includes('const AGENT_IMAGE_MODEL_PLACEHOLDER_VALUES'), 'main process placeholder list is missing');
assert(main.includes('function resolveBatchImageModel'), 'main process model resolver is missing');
assert(main.includes("return platform === 'apimart' ? 'gpt-image-2' : 'gemini-3.1-flash-image';"), 'main process fallback models are missing');
assert(main.includes('model: resolveBatchImageModel(body.model, cfg.model, imageApiPlatform),'), 'batch payload does not enforce model normalization');

console.log('[verify-agent-image-model-fallback] OK: Agent free-selection UI state cannot be submitted as an APIMart model.');
