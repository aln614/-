(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.PromptMentionCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  const tokenPattern = /@(?:Image[1-9]\d*\b|图[1-9]\d*)/g;
  const tokens = text => [...new Set(String(text || '').match(tokenPattern) || [])];
  function activeQuery(text, start, end = start){
    if(start !== end) return null;
    const before = String(text || '').slice(0, start);
    const match = /@([^@\s\[\]，。！？、；：]{0,80})$/u.exec(before);
    if(!match || /[a-zA-Z0-9_.+\-]/.test(before[match.index - 1] || '')) return null;
    return {start:match.index, end:start, query:match[1]};
  }
  function compile(prompt, mentions, mainImages, refImages, currentMain = ''){
    const refs = [...refImages];
    const replacements = new Map();
    let highestImage = 0;
    for(const token of tokens(prompt)){
      const matches = (Array.isArray(mentions) ? mentions : []).filter(row => row && row.token === token);
      const binding = matches[0];
      if(matches.length !== 1 || !['main','ref','current_main'].includes(binding?.kind) ||
        (binding.kind !== 'current_main' && (!Number.isSafeInteger(binding.index) || binding.index < 0))){
        throw new Error(`${token} 的素材引用无效，请重新选择素材`);
      }
      if(binding.kind === 'current_main' && (!currentMain || !mainImages.includes(currentMain))){
        throw new Error(`${token} 对应的主任务图片已移除，请重新添加主图`);
      }
      // A main-image mention follows the current task, not one selected batch input.
      const file = binding.kind === 'current_main' ? currentMain : (binding.kind === 'main' ? mainImages : refImages)[binding.index];
      if(!file) throw new Error(`${token} 对应的图片已移除，请重新选择素材`);
      let number;
      if(currentMain && file === currentMain) number = 1;
      else {
        let index = refs.indexOf(file);
        if(index < 0){ index = refs.length; refs.push(file); }
        number = index + 1 + (currentMain ? 1 : 0);
      }
      highestImage = Math.max(highestImage, number);
      replacements.set(token, token.startsWith('@Image') ? `Image ${number}` : `图${number}`);
    }
    return {prompt:String(prompt || '').replace(tokenPattern, token => replacements.get(token)), refImages:refs, highestImage};
  }
  return {tokens, activeQuery, compile};
});
