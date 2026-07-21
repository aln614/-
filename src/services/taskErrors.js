function isTerminalGenerationError(err) {
  if (err && (err.terminal === true || err.code === 'APIMART_INVALID_API_KEY')) return true;
  const text = String(err && (err.message || err) || '').toLowerCase();
  if (!text) return false;
  if (/moderation_blocked|safety_violations|safety system|content policy|content_policy|invalid prompt|unsupported model|invalid\s+(?:api\s+)?key|unauthori[sz]ed|authentication\s+(?:failed|error)|api key 无效/.test(text)) return true;
  const httpCode = Number((text.match(/\bhttp(?:\s+error)?\s*(4\d\d)\b/i) || [])[1] || 0);
  return httpCode >= 400 && httpCode < 500 && ![408, 409, 425, 429].includes(httpCode);
}

module.exports = { isTerminalGenerationError };
