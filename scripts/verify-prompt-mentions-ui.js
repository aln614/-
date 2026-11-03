'use strict';
// Hidden, isolated renderer with synthetic media and a stubbed batch endpoint.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-mention-ui-'));
app.setPath('userData', temp);
app.disableHardwareAcceleration();
const source = fs.readFileSync(path.join(root, 'src/renderer/static/app.js'), 'utf8');
function functionSource(name){
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  if(start < 0) throw new Error('Missing function ' + name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const core = fs.readFileSync(path.join(root, 'src/renderer/static/prompt-mention-core.js'), 'utf8');
const menu = fs.readFileSync(path.join(root, 'src/renderer/static/prompt-mentions.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/renderer/static/style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
const functions = ['imageMentionRows','setupImagePromptMentions','renderThumbs','renderThumbList','batchUploadStateMarkup','submitCurrentImageBatch'].map(functionSource).join('\n');

async function scenario(){
  const check = (value, message) => {if(!value) throw new Error(message);};
  const tick = () => new Promise(resolve => setTimeout(resolve, 15));
  const input = document.getElementById('prompts');
  const popup = document.getElementById('prompts-mentions');
  const type = (text, caret = text.length) => {input.focus(); input.value = text; input.setSelectionRange(caret, caret); input.dispatchEvent(new Event('input', {bubbles:true}));};
  const key = (value, options = {}) => input.dispatchEvent(new KeyboardEvent('keydown', {key:value, bubbles:true, cancelable:true, ...options}));
  type('把@'); await tick();
  check(popup.querySelectorAll('[role=option]').length === 3, 'Two uploaded images plus one supported library image');
  check(!popup.textContent.includes('source.psd'), 'Do not offer unsupported source documents as image references');
  check(popup.textContent.includes('@Image1') && popup.textContent.includes('@Image2'), 'Same filename must have distinct English image numbers');
  key('Enter'); await tick();
  check(input.value === '把@Image1 ', 'Insert mention at caret');
  type('前文@后文', 3); key('ArrowDown'); key('Enter'); await tick();
  check(input.value === '前文@Image2 后文', 'Middle insertion preserves following text');
  type('test@example.com'); check(popup.hidden, 'Email addresses must not open picker');
  type('@'); key('Escape'); check(popup.hidden, 'Escape dismisses picker');
  type('@'); key('Tab'); check(popup.hidden, 'Tab dismisses without replacing text');
  type('@'); input.dispatchEvent(new CompositionEvent('compositionstart'));
  key('Enter', {isComposing:true}); check(input.value === '@', 'IME Enter must not select');
  input.dispatchEvent(new CompositionEvent('compositionend')); await tick();
  check(!popup.hidden, 'Picker returns after IME composition');
  type('@美国'); await tick();
  check(popup.querySelectorAll('[role=option]').length === 1, 'Search by full country/category path');
  const assetOption = popup.querySelector('button');
  assetOption.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,cancelable:true})); assetOption.click();
  let guarded = false;
  try{imagePromptMentions.submission();}catch(error){guarded = /正在加入/.test(error.message);}
  check(guarded, 'Submitting during asset attachment must wait for the source image');
  await tick();
  check(refImages.length === 3 && input.value === '@Image3 ', 'Asset selection attaches an actual image');
  check(sourceReads === 1, 'Library selection reads original source exactly once');
  type('@flag'); await tick(); key('Enter'); await tick();
  check(refImages.length === 3 && sourceReads === 1 && input.value === '@Image3 ', 'Repeated mention reuses attachment');
  type('@Image1 在 @Image2 里，旗帜是 @Image3'); imagePromptMentions.close();
  await submitCurrentImageBatch();
  check(submitted.main_images.length === 0 && submitted.reference_images.length === 3 && submitted.prompt_mentions.length === 3, 'Local submission carries image objects and bindings');
  check(submitted.prompt_mentions[2].index === 2, 'Reference index is aligned with payload');
  isPublicClient = true;
  renderThumbs();
  const labelRect = document.querySelector('.input-image-label').getBoundingClientRect();
  const uploadRect = document.querySelector('.batch-upload-state').getBoundingClientRect();
  check(labelRect.bottom <= uploadRect.top, 'Image number must not overlap public upload status');
  uploadHook = () => {refImages.unshift({name:'concurrent.png', data:png});};
  await submitCurrentImageBatch();
  check(submitted.reference_image_upload_ids.length === 3 && submitted.reference_images.length === 0 && submitted.prompt_mentions[2].index === 2, 'Public pre-upload keeps a stable snapshot if inputs change while uploading');
  uploadHook = null; isPublicClient = false; refImages.shift();
  const removed = refImages.shift(); renderThumbs();
  let missing = false;
  try{imagePromptMentions.submission();}catch(error){missing = /已移除/.test(error.message);}
  check(missing, 'Deleting a mentioned image must block submission');
  refImages.push({name:removed.name, data:png}); renderThumbs();
  check(imagePromptMentions.label(refImages.at(-1)) === 'Image 3', 'Reference labels follow the current image order');
  missing = false;
  try{imagePromptMentions.submission();}catch(error){missing = /已移除/.test(error.message);}
  check(missing, 'A new image at an old position must not silently replace a deleted mention');
  type('');
  mainImages = ['main-a.png','main-b.png','main-c.png'].map(name => ({name,data:png})); renderThumbs();
  check([...document.querySelectorAll('#mainThumbs .input-image-label')].map(el => el.textContent).join(',') === 'Image 1,Image 1,Image 1', 'Every independent main task is Image 1');
  check([...document.querySelectorAll('#refThumbs .input-image-label')].map(el => el.textContent).join(',') === 'Image 2,Image 3,Image 4', 'Shared references begin at Image 2');
  for(const wrap of document.querySelectorAll('#mainThumbs .thumb-wrap,#refThumbs .thumb-wrap')){
    const badge=wrap.querySelector('.input-image-label').getBoundingClientRect(), remove=wrap.querySelector('.thumb-del').getBoundingClientRect();
    check(badge.right <= remove.left || badge.bottom <= remove.top, 'English image label must not overlap delete button');
  }
  type('@main-b'); key('Enter'); await tick();
  check(input.value === '@Image1 ', 'Selecting any main image mentions the current task image');
  check(imagePromptMentions.submission()[0].kind === 'current_main', 'Main binding must not pin the selected batch image');
  type('Put @Image1 in @Image2'); imagePromptMentions.close(); await submitCurrentImageBatch();
  check(submitted.main_images.length === 3 && submitted.reference_images.length === 3 && submitted.prompt_mentions[0].kind === 'current_main', 'Batch submission preserves all independent main tasks');
  for(const item of submitted.main_images){
    const resolved=window.PromptMentionCore.compile(submitted.prompts,submitted.prompt_mentions,submitted.main_images,submitted.reference_images,item);
    check(resolved.prompt === 'Put Image 1 in Image 2' && resolved.refImages.length === 3, 'Each task resolves Image 1 locally without adding another main image');
  }
  type('@'); key('ArrowDown'); key('ArrowDown');
  const bounds = popup.getBoundingClientRect();
  check(bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight, 'Picker must stay inside viewport');
  check([...popup.querySelectorAll('.prompt-mention-info')].every(el => el.scrollWidth <= el.clientWidth + 1), 'Long asset names must wrap');
  check(alerts.every(message => message.startsWith('批次已创建')), 'No unexpected user-facing errors');
  // A failed or late library request must not remove the local choices or reopen a dismissed picker.
  const probe = document.createElement('textarea'); probe.id = 'mention-error-probe'; document.body.prepend(probe);
  let rejectLoad;
  const controller = window.PromptMentions.create({input:probe,getImages:imageMentionRows,
    loadAssets:() => new Promise((_resolve,reject) => {rejectLoad=reject;}), attachAsset:async () => {throw new Error('not used');}});
  probe.focus(); probe.value='@';probe.setSelectionRange(1,1);probe.dispatchEvent(new Event('input',{bubbles:true}));await tick();
  check(document.querySelectorAll('#mention-error-probe-mentions [role=option]').length === 6, 'Local choices appear before the library loads');
  controller.close();rejectLoad(new Error('Network unavailable'));await tick();
  check(document.getElementById('mention-error-probe-mentions').hidden, 'Late error must not reopen dismissed picker');
  check(document.getElementById('mention-error-probe-mentions').childElementCount === 0, 'Dismissed picker releases thumbnail DOM');
  probe.remove();
  type('@');
  return {options:popup.querySelectorAll('[role=option]').length, submittedBindings:submitted.prompt_mentions.length};
}

app.whenReady().then(async () => {
  let win;
  try{
    win = new BrowserWindow({show:false,width:1464,height:950,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({cancel:!/^data:|^about:/.test(details.url)}));
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await win.webContents.insertCSS(css);
    await win.webContents.executeJavaScript(core + '\n' + menu);
    await win.webContents.executeJavaScript(`
      const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
      const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDAAAAABJRU5ErkJggg==';
      let mainImages=[], refImages=[{name:'image.png',data:png},{name:'image.png',data:png}], imagePromptMentions=null, isPublicClient=false, sourceReads=0, submitted, uploadHook=null;
      const alerts=[];
      const toast=message=>alerts.push(message), calcEstimate=()=>{}, prestagePublicBatchMedia=()=>{}, showPreview=()=>{}, setImageDragData=()=>{}, releaseBatchMediaItem=()=>{};
      const escapeHtml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
      const withPublicAccess=value=>value, assetSourceHeaders=()=>({'X-Client-Id':'fixture'}), batchImageFileToItem=async file=>({name:file.name,data:png,type:file.type});
      const api=async (url,options)=>{
        if(url==='/api/assets/init') return {groups:[{id:'usa',name:'美国'},{id:'flag',name:'国旗',parent_id:'usa'}], assets:[{id:'flag1',type:'image',mime_type:'image/png',name:'flag.png',url:'/api/assets/source?id=flag1',thumb_url:png,group_id:'flag'},{id:'psd',type:'file',name:'source.psd'}]};
        if(url==='/api/batches'){submitted=JSON.parse(options.body);return {ok:true,task_count:1};}
        throw new Error('Unexpected request '+url);
      };
      const fetch=async url=>{if(url==='/api/assets/source?id=flag1'){sourceReads++;return {ok:true,blob:async()=>new Blob(['fixture'],{type:'image/png'})};} throw new Error('Unexpected media request');};
      const updateApiKeyWarning=()=>({ok:true}), isLtx23TextImageModel=()=>false, collectConfig=()=>({model:'gpt-image-2'}), getClientId=()=> 'fixture', isPromptMultilineTasksEnabled=()=>false, refreshAll=async()=>{};
      const ensurePublicBatchMediaUploaded=async items=>{items.forEach((item,i)=>item.batch_upload_id='upload-'+i);if(uploadHook)uploadHook();};
      ${functions}
      setupImagePromptMentions();
    `);
    console.log(await win.webContents.executeJavaScript('(' + scenario.toString() + ')()'));
    await new Promise(resolve => setTimeout(resolve, 150));
    const results = path.join(root, 'test-results'); fs.mkdirSync(results, {recursive:true});
    fs.writeFileSync(path.join(results, 'prompt-mentions-desktop.png'), (await win.webContents.capturePage()).toPNG());
    win.setSize(420, 800);
    await win.webContents.insertCSS('#prompts{position:fixed;left:16px;bottom:30px;width:388px;height:140px;z-index:10000}');
    await win.webContents.executeJavaScript(`
      const input=$('#prompts');input.focus();input.value='@';input.setSelectionRange(1,1);input.dispatchEvent(new Event('input',{bubbles:true}));
    `);
    await new Promise(resolve => setTimeout(resolve, 100));
    const fits = await win.webContents.executeJavaScript(`(()=>{const r=$('#prompts-mentions').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;})()`);
    if(!fits) throw new Error('Narrow viewport popup overflow');
    fs.writeFileSync(path.join(results, 'prompt-mentions-narrow.png'), (await win.webContents.capturePage()).toPNG());
    console.log('Prompt mention UI: keyboard, caret, IME, search, library attachments, duplicate/deleted images, private/public submission and narrow layout passed.');
    win.destroy(); app.exit(0);
  }catch(error){console.error(error);win?.destroy();app.exit(1);}
});
