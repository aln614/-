(function(root){
  'use strict';
  function create({input, getImages, loadAssets, attachAsset, onChange = ()=>{}, onError = ()=>{}}){
    const core = root.PromptMentionCore;
    const bindings = new Map();
    let active = 0, rows = [], query = null, composing = false, pending = false;
    let assets = [], loadedAt = 0, loading = null, loadError = '';
    const menu = document.createElement('div');
    menu.className = 'prompt-mention-menu';
    menu.id = `${input.id}-mentions`;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', '图片素材');
    menu.hidden = true;
    document.body.append(menu);
    input.setAttribute('aria-controls', menu.id);
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    function numberedImages(images = getImages()){
      const hasMain = images.some(row => row.kind === 'main');
      return images.map(row => {
        const number = row.kind === 'main' ? 1 : row.index + (hasMain ? 2 : 1);
        return {...row, label:`Image ${number}`, token:`@Image${number}`};
      });
    }
    function label(item){
      return numberedImages().find(row => row.item === item)?.label || '';
    }
    function remember(token, row){
      bindings.set(token, row.kind === 'main' ? {kind:'current_main'} : {kind:'ref', item:new WeakRef(row.item)});
    }
    function captureBindings(text, images, prune = false){
      const mentioned = new Set(core.tokens(text));
      if(prune) for(const token of bindings.keys()) if(!mentioned.has(token)) bindings.delete(token);
      const numbered = numberedImages(images);
      for(const token of mentioned){
        if(bindings.has(token)) continue;
        const row = numbered.find(entry => entry.token === token);
        if(row) remember(token, row);
      }
    }
    function close(){
      query = null; rows = []; menu.hidden = true; menu.replaceChildren();
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function position(){
      if(menu.hidden) return;
      const rect = input.getBoundingClientRect();
      if(rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth){close(); return;}
      const height = Math.min(300, Math.max(120, innerHeight - 24));
      const below = innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const useAbove = below < 180 && above > below;
      menu.style.width = `${Math.min(440, Math.max(220, rect.width), innerWidth - 24)}px`;
      menu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - menu.offsetWidth - 12))}px`;
      menu.style.maxHeight = `${Math.min(height, Math.max(80, useAbove ? above : below))}px`;
      const top = useAbove ? rect.top - menu.offsetHeight - 6 : rect.bottom + 6;
      menu.style.top = `${Math.max(12, Math.min(top, innerHeight - menu.offsetHeight - 12))}px`;
    }
    function render(){
      if(!query) return;
      const local = numberedImages().map(row => ({...row, source:'input'}));
      const attached = new Set(local.map(row => row.item.mention_asset_id).filter(Boolean));
      const candidates = [...local, ...assets.filter(row => !attached.has(row.id)).map(row => ({...row, source:'asset'}))];
      const term = query.query.trim().toLocaleLowerCase();
      rows = candidates.filter(row => [row.token, row.name, row.group, row.kind === 'main' ? '主图' : row.source === 'input' ? '参考图' : '资产库'].join(' ').toLocaleLowerCase().includes(term)).slice(0, 60);
      active = Math.max(0, Math.min(active, rows.length - 1));
      menu.replaceChildren();
      rows.forEach((row, index) => {
        const option = document.createElement('button');
        option.type = 'button'; option.className = 'prompt-mention-option';
        option.id = `${menu.id}-${index}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === active));
        option.tabIndex = -1;
        const img = document.createElement('img');
        img.src = row.src || ''; img.alt = ''; img.loading = 'lazy';
        const info = document.createElement('span'); info.className = 'prompt-mention-info';
        const name = document.createElement('strong'); name.textContent = row.source === 'input' ? `${row.token} · ${row.name || '图片'}` : row.name;
        const detail = document.createElement('small'); detail.textContent = row.source === 'input' ? (row.kind === 'main' ? '主图' : '参考图') : `资产库${row.group ? ' · ' + row.group : ''}`;
        info.append(name, detail); option.append(img, info);
        option.addEventListener('pointerdown', event => event.preventDefault());
        option.addEventListener('click', () => pick(index));
        menu.append(option);
      });
      const message = loading ? '正在读取资产库…' : loadError || (!rows.length ? '没有匹配的图片' : '');
      if(message){
        const status = document.createElement('div'); status.className = 'prompt-mention-status'; status.textContent = message; status.setAttribute('role','status'); menu.append(status);
      }
      menu.hidden = false; input.setAttribute('aria-expanded', 'true');
      if(rows.length) input.setAttribute('aria-activedescendant', `${menu.id}-${active}`);
      else input.removeAttribute('aria-activedescendant');
      position();
    }
    function refreshAssets(){
      if(loading || Date.now() - loadedAt < 20000) return;
      loadError = '';
      loading = Promise.resolve().then(loadAssets).then(value => {
        if(!Array.isArray(value)) throw new Error('资产库返回数据异常');
        assets = value; loadedAt = Date.now();
      }).catch(error => { loadError = error.message || '资产库读取失败'; }).finally(() => {loading = null; if(query) render();});
    }
    function update(){
      captureBindings(input.value, getImages(), true);
      if(composing || pending || document.activeElement !== input){ close(); return; }
      const next = core.activeQuery(input.value, input.selectionStart, input.selectionEnd);
      if(!next){ close(); return; }
      if(next.query !== query?.query || next.start !== query?.start) active = 0;
      query = next; refreshAssets(); render();
    }
    async function pick(index){
      if(pending || !query || !rows[index]) return;
      const row = rows[index], selectedQuery = {...query}, previous = input.value;
      close(); pending = true;
      try{
        const item = row.source === 'input' ? row.item : await attachAsset(row);
        const selected = numberedImages().find(entry => entry.item === item);
        if(!selected) throw new Error('图片已移除，请重新选择素材');
        const token = selected.token;
        if(input.value !== previous || document.activeElement !== input){ onError('素材已加入参考图，请在提示词中重新选择引用'); return; }
        const start = selectedQuery.start, end = selectedQuery.end;
        remember(token, selected);
        input.focus(); input.setSelectionRange(start, end);
        // Native insertion keeps the textarea's undo history when supported.
        if(!document.execCommand('insertText', false, `${token} `)) input.setRangeText(`${token} `, start, end, 'end');
        input.dispatchEvent(new Event('input', {bubbles:true}));
        onChange();
      }catch(error){ onError(error.message || '添加素材失败'); }
      finally{ pending = false; close(); }
    }
    function submission(images = getImages(), text = input.value){
      if(pending) throw new Error('素材正在加入参考图，请稍后提交');
      captureBindings(text, images);
      const numbered = numberedImages(images);
      return core.tokens(text).map(token => {
        const binding = bindings.get(token);
        const row = binding?.kind === 'current_main'
          ? numbered.find(entry => entry.kind === 'main')
          : numbered.find(entry => entry.kind === 'ref' && entry.item === binding?.item?.deref());
        if(!row) throw new Error(`${token} 对应的图片已移除或尚未选择，请重新 @ 选择素材`);
        if(row.token !== token) throw new Error(`${token} 对应的图片编号已变化，请重新 @ 选择素材`);
        return {token, kind:binding.kind, index:binding.kind === 'current_main' ? 0 : row.index};
      });
    }
    input.addEventListener('input', update);
    input.addEventListener('click', update);
    input.addEventListener('focus', update);
    input.addEventListener('blur', close);
    input.addEventListener('compositionstart', () => {composing = true; close();});
    input.addEventListener('compositionend', () => {composing = false; update();});
    input.addEventListener('keydown', event => {
      if(composing || event.isComposing || menu.hidden) return;
      if(event.key === 'Escape'){event.preventDefault(); event.stopPropagation(); close(); return;}
      if(event.key === 'Tab'){close(); return;}
      if(['ArrowDown','ArrowUp'].includes(event.key) && rows.length){
        event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        render(); document.getElementById(`${menu.id}-${active}`)?.scrollIntoView({block:'nearest'});
      }else if(event.key === 'Enter' && rows.length){ event.preventDefault(); event.stopPropagation(); pick(active); }
    });
    input.addEventListener('keyup', event => {if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) update();});
    document.addEventListener('pointerdown', event => {if(event.target !== input && !menu.contains(event.target)) close();});
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return {label, submission, close, refresh:update, get pending(){return pending;}};
  }
  root.PromptMentions = {create};
})(window);
