'use strict';
(() => {
  const key='tenying-local-appearance-v1';
  const defaults={mode:'board',theme:'auto',blur:0,revision:''};
  const modes=['board','none','custom'];
  const themes=['light','dark','auto'];
  const normalize=value=>({
    mode:modes.includes(value?.mode) ? value.mode : defaults.mode,
    theme:themes.includes(value?.theme) ? value.theme : defaults.theme,
    blur:Number.isFinite(Number(value?.blur)) ? Math.max(0,Math.min(40,Number(value.blur))) : 0,
    revision:typeof value?.revision==='string' ? value.revision : ''
  });
  function stored() { try { return normalize(JSON.parse(localStorage.getItem(key) || '{}')); } catch { return {...defaults}; } }
  let settings=stored(),databasePromise,media=null,objectUrl='',mediaRevision='',generation=0,saveTimer=0,nativeHidden=false;
  let writeChain=Promise.resolve();
  const layer=document.createElement('div');
  layer.id='localAppearanceBackground';
  layer.setAttribute('aria-hidden','true');
  document.body.prepend(layer);
  function database() {
    if(!databasePromise) databasePromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(key,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('media');
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(new Error('本地背景存储被占用，请关闭旧窗口后重试'));
    }).catch(error=>{databasePromise=null;throw error;});
    return databasePromise;
  }
  async function mediaRecord(operation,value) {
    const db=await database();
    return new Promise((resolve,reject)=>{
      const transaction=db.transaction('media',operation==='get' ? 'readonly' : 'readwrite');
      const store=transaction.objectStore('media');
      const request=operation==='get' ? store.get('background') : operation==='delete' ? store.delete('background') : store.put(value,'background');
      transaction.oncomplete=()=>resolve(request.result);
      transaction.onerror=()=>reject(transaction.error || request.error);
      transaction.onabort=()=>reject(transaction.error || request.error || new Error('本地背景保存已取消'));
    });
  }
  function message(text,error=false) {
    for(const output of document.querySelectorAll('[data-appearance-status]')) {
      output.textContent=text;output.classList.toggle('is-error',error);
    }
  }
  function releaseMedia() {
    if(media?.tagName==='VIDEO') {media.pause();media.removeAttribute('src');media.load();}
    media?.remove();media=null;
    if(objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl='';mediaRevision='';
  }
  function playback() {
    if(media?.tagName!=='VIDEO') return;
    if(document.hidden || nativeHidden || settings.mode!=='custom') media.pause();
    else media.play().catch(()=>message('视频暂未播放，请点击“自定义”重试',true));
  }
  function themeActual() {
    const hour=new Date().getHours();
    return settings.theme==='auto' ? (hour>=7 && hour<19 ? 'light' : 'dark') : settings.theme;
  }
  function render() {
    const body=document.body,actual=themeActual();
    body.classList.remove('theme-light','theme-dark','theme-auto','theme-auto-light','theme-auto-dark','theme-auto-auto');
    body.classList.add('theme-'+actual,'theme-auto-'+settings.theme);
    body.dataset.themeMode=settings.theme;body.dataset.themeActual=actual;body.dataset.backgroundMode=settings.mode;
    body.style.setProperty('--appearance-background-blur',settings.blur+'px');
    for(const button of document.querySelectorAll('[data-background-mode]')) {
      const active=button.dataset.backgroundMode===settings.mode;
      button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
    }
    for(const label of document.querySelectorAll('[data-background-board-label]')) label.textContent=actual==='dark' ? '黑板' : '白板';
    for(const button of document.querySelectorAll('#themePopover [data-theme]')) button.classList.toggle('active',button.dataset.theme===settings.theme);
    for(const select of document.querySelectorAll('#themeMode,#themeModeQuick')) select.value=settings.theme;
    for(const input of document.querySelectorAll('[data-background-blur]')) input.value=String(settings.blur);
    for(const output of document.querySelectorAll('[data-background-blur-value]')) output.textContent=settings.blur+' px';
    const name={board:actual==='dark' ? '黑板' : '白板',none:'无 · 液态玻璃',custom:'自定义背景'}[settings.mode];
    const summary=document.getElementById('themePanelCurrent');
    if(summary) summary.textContent=name+' · '+({light:'日间',dark:'深色',auto:'自动'}[settings.theme]);
    playback();
    window.dispatchEvent(new CustomEvent('local-appearance-change',{detail:{...settings,actual}}));
  }
  function persist() {
    clearTimeout(saveTimer);saveTimer=0;
    try {localStorage.setItem(key,JSON.stringify(settings));return true;}
    catch {message('本地存储不可用，当前外观无法保存',true);return false;}
  }
  async function restoreMedia() {
    const token=++generation;
    if(settings.mode!=='custom') {releaseMedia();return;}
    if(media && mediaRevision===settings.revision) {playback();return;}
    try {
      const record=await mediaRecord('get');
      if(token!==generation || settings.mode!=='custom') return;
      if(!record?.blob) {releaseMedia();settings={...settings,mode:'board',revision:''};persist();render();message('自定义背景已不存在，请重新上传',true);return;}
      releaseMedia();
      objectUrl=URL.createObjectURL(record.blob);
      media=document.createElement(record.type==='video/mp4' ? 'video' : 'img');
      media.className='appearance-custom-media';
      if(media.tagName==='VIDEO') {media.muted=true;media.defaultMuted=true;media.autoplay=true;media.loop=true;media.playsInline=true;media.preload='auto';}
      else media.alt='';
      media.onerror=()=>message('背景文件无法解码，请重新上传',true);
      media.src=objectUrl;mediaRevision=settings.revision;layer.appendChild(media);
      for(const output of document.querySelectorAll('[data-background-filename]')) output.textContent=record.name;
      playback();
    } catch {if(token===generation) message('无法读取本地背景，请重新上传',true);}
  }
  function update(next,{defer=false}={}) {
    const previous=settings;
    settings=normalize({...settings,...next});
    render();
    if(previous.mode!==settings.mode || previous.revision!==settings.revision) restoreMedia();
    if(defer) {clearTimeout(saveTimer);saveTimer=setTimeout(persist,120);}
    else persist();
  }
  function fileType(file) {
    if(/\.mp4$/i.test(file.name) && (!file.type || file.type==='video/mp4')) return 'video/mp4';
    if(/\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name) && (!file.type || /^image\//.test(file.type))) return file.type || 'image/'+file.name.split('.').pop().toLowerCase();
    throw new Error('请选择图片、GIF 或 MP4 文件');
  }
  async function validateMedia(file,type) {
    const url=URL.createObjectURL(file),element=document.createElement(type==='video/mp4' ? 'video' : 'img');
    try {
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('背景读取超时，请检查文件')),20000);
        const finish=callback=>()=>{clearTimeout(timer);callback();};
        element[type==='video/mp4' ? 'onloadedmetadata' : 'onload']=finish(resolve);
        element.onerror=finish(()=>reject(new Error('背景文件损坏或格式不受支持')));
        if(type==='video/mp4') {element.muted=true;element.preload='metadata';}
        element.src=url;
      });
    } finally {
      if(type==='video/mp4') {element.pause();element.removeAttribute('src');element.load();}
      URL.revokeObjectURL(url);
    }
  }
  function busy(value) {for(const button of document.querySelectorAll('[data-background-upload],[data-background-clear]')) button.disabled=value;}
  function importFile(file) {
    const operation=writeChain.catch(()=>{}).then(async()=>{
      busy(true);message('正在保存到本地…');
      try {
        const type=fileType(file);
        if(!file.size) throw new Error('背景文件为空');
        await validateMedia(file,type);
        const previous=await mediaRecord('get');
        await mediaRecord('put',{blob:file,name:file.name,type});
        const next=normalize({...settings,mode:'custom',revision:crypto.randomUUID?.() || Date.now()+'-'+Math.random()});
        try {localStorage.setItem(key,JSON.stringify(next));}
        catch(error) {await mediaRecord(previous ? 'put' : 'delete',previous);throw error;}
        settings=next;render();await restoreMedia();message('已保存到此设备');
      } catch(error) {
        message(error.name==='QuotaExceededError' ? '本地空间不足，请换一个较小的背景文件' : error.message || '背景保存失败',true);
        throw error;
      } finally {busy(false);}
    });
    writeChain=operation;
    return operation;
  }
  async function clearMedia() {
    const operation=writeChain.catch(()=>{}).then(async()=>{
      busy(true);
      try {
        await mediaRecord('delete');
        update({mode:settings.mode==='custom' ? 'board' : settings.mode,revision:''});
        for(const output of document.querySelectorAll('[data-background-filename]')) output.textContent='未选择文件';
        message('已移除本地背景');
      } catch {message('移除失败，请重试',true);}
      finally {busy(false);}
    });
    writeChain=operation;await operation;
  }
  const fileInput=document.getElementById('appearanceBackgroundFile');
  for(const button of document.querySelectorAll('[data-background-mode]')) button.addEventListener('click',()=>{
    if(button.dataset.backgroundMode==='custom' && !settings.revision) fileInput?.click();
    else {message('');update({mode:button.dataset.backgroundMode});}
  });
  for(const button of document.querySelectorAll('[data-background-upload]')) button.addEventListener('click',()=>fileInput?.click());
  for(const button of document.querySelectorAll('[data-background-clear]')) button.addEventListener('click',clearMedia);
  for(const input of document.querySelectorAll('[data-background-blur]')) {
    input.addEventListener('input',()=>update({blur:input.value},{defer:true}));
    input.addEventListener('change',persist);
  }
  fileInput?.addEventListener('change',async()=>{const file=fileInput.files?.[0];fileInput.value='';if(file) await importFile(file).catch(()=>{});});
  layer.addEventListener('click',playback);
  window.addEventListener('storage',event=>{
    if(event.key!==key && event.key!==null) return;
    const previous=settings;settings=stored();render();
    if(previous.mode!==settings.mode || previous.revision!==settings.revision) restoreMedia();
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) render();else playback();});
  window.desktopVisibility?.onChange(visible=>{nativeHidden=!visible;playback();});
  window.addEventListener('pagehide',()=>{if(saveTimer) persist();generation++;releaseMedia();});
  window.addEventListener('pageshow',()=>{if(settings.mode==='custom' && !media) restoreMedia();});
  const timer=setInterval(()=>{if(!document.hidden && !nativeHidden && themeActual()!==document.body.dataset.themeActual) render();},60000);
  timer.unref?.();
  window.localAppearance={get:()=>({...settings}),setMode:mode=>update({mode}),setTheme:theme=>update({theme}),applyTheme:theme=>{settings=normalize({...settings,theme});render();},refresh:render,importFile,clearMedia,ready:null};
  render();window.localAppearance.ready=restoreMedia();
})();
