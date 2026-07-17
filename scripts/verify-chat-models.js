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

console.log(`[verify-chat-models] OK: ${ids.length} built-in chat models; Claude 5 fallback is present.`);
