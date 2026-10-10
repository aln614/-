'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'apiClient.js'), 'utf8');
const catalogBlock = source.match(/const APIMART_RESPONSE_CHAT_MODELS = \[([\s\S]*?)\n\];/);
if (!catalogBlock) {
  console.error('[verify-chat-models] FAILED: built-in chat model catalog was not found.');
  process.exit(1);
}
const ids = [...catalogBlock[1].matchAll(/\{\s*id:\s*'([^']+)'/g)].map(match => match[1]);
const required = [
  'claude-haiku-5-5',
  'gpt-6.1-sol',
  'qwen3.8-max',
  'qwen3.8-max-0902',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'grok-4.7',
  'gemini-3.8-flash',
  'claude-fable-5.1',
  'glm-5.3',
  'kimi-k3',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-opus-4-8',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.6-sol'
];
const missing = required.filter(id => !ids.includes(id));
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

if (missing.length || duplicates.length) {
  console.error('[verify-chat-models] FAILED');
  if (missing.length) console.error('Missing required models:', missing.join(', '));
  if (duplicates.length) console.error('Duplicate model IDs:', [...new Set(duplicates)].join(', '));
  process.exit(1);
}

console.log(`[verify-chat-models] OK: ${ids.length} built-in chat models; October 10 additions are present.`);
