(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentReplyStream = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';

  // Decode only complete JSON escapes. Network chunks can split a Unicode escape.
  function stringPrefix(source, start) {
    let end = start + 1;
    while (end < source.length) {
      const ch = source[end];
      if (ch === '"') {
        try { return { value:JSON.parse(source.slice(start, end + 1)), end:end + 1, complete:true }; }
        catch { return null; }
      }
      if (ch === '\\') {
        if (end + 1 >= source.length) break;
        if (source[end + 1] === 'u') {
          if (end + 6 > source.length) break;
          if (!/^[0-9a-f]{4}$/i.test(source.slice(end + 2, end + 6))) return null;
          end += 6;
        } else {
          if (!'"\\/bfnrt'.includes(source[end + 1])) return null;
          end += 2;
        }
      } else {
        if (ch.charCodeAt(0) < 32) return null;
        end++;
      }
    }
    try {
      const value = JSON.parse(source.slice(start, end) + '"').replace(/[\uD800-\uDBFF]$/, '');
      return { value, end:source.length, complete:false };
    } catch { return null; }
  }

  function read(raw) {
    let source = String(raw || '').trimStart();
    if (!source) return { text:'', structured:false };
    if (source.startsWith('`')) {
      const fence = source.match(/^```(?:json)?\s*\n/i);
      if (!fence) return { text:'', structured:true };
      source = source.slice(fence[0].length).trimStart();
    }
    if (!source.startsWith('{')) return { text:source, structured:false };

    // Inspect only top-level string fields, never nested tool arguments or reasoning.
    const fields = Object.create(null);
    let depth = 1;
    let state = 'key';
    let key = '';
    for (let i = 1; i < source.length && depth > 0;) {
      const ch = source[i];
      if (ch === '"') {
        const token = stringPrefix(source, i);
        if (!token) break;
        if (depth === 1 && state === 'key' && token.complete) {
          key = token.value;
          state = 'colon';
        } else if (depth === 1 && state === 'value') {
          if (['type','action','message','content','tool'].includes(key)) fields[key] = token.value;
          state = 'after';
        }
        i = token.end;
        if (!token.complete) break;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      else if (depth === 1 && ch === ':') state = 'value';
      else if (depth === 1 && ch === ',') { state = 'key'; key = ''; }
      i++;
    }
    const type = fields.type || fields.action || (fields.tool ? 'tool_call' : '');
    const text = type === 'final' ? (fields.message || fields.content || '')
      : type === 'tool_call' ? (fields.message || '') : '';
    return { text, type, tool:fields.tool || '', structured:true };
  }

  return { read };
});
