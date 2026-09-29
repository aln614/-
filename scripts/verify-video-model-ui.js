'use strict';

const {app, BrowserWindow} = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-video-model-ui-')));
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/static/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const page = html.slice(html.indexOf('<section class="page" id="page-video">'), html.indexOf('<section class="recent-video-upload-panel"')) + '</section>';
const css = fs.readFileSync(path.join(root, 'src/renderer/static/style.css'), 'utf8');
const rules = source.slice(source.indexOf('const APIMART_VIDEO_MODEL_RULES_UI ='), source.indexOf('function currentApimartVideoRule'));
function extract(name) {
  const start = source.indexOf('function '+name+'(');
  if(start < 0) throw new Error('Missing '+name);
  const line = source.slice(start,source.indexOf('\n',start)).trimEnd();
  return line.endsWith('}') ? line : source.slice(start,source.indexOf('\n}',start)+2);
}
const functions = [
  'currentApimartVideoRule','isSeedance25VideoModel','seedance25DraftEnabled',
  'seedance25VideoEditIsActive','seedance25RequiresAdaptiveAspect','currentVideoModeValue',
  'updateSeedance25Options','updateVideoResolutionOptions','agentVideoModelOptionsHtml',
  'canFinalizeSeedanceDraft','renderVideoCard'
].map(extract).join('\n');
const setupStart = source.indexOf('function setupVideoPage(){');
const controls = source.slice(setupStart, source.indexOf('  setVideoApiPlatform(',setupStart)) + '\n}';

app.whenReady().then(async()=>{
  const win = new BrowserWindow({show:false,width:1250,height:1020,webPreferences:{sandbox:true,contextIsolation:true}});
  win.webContents.session.webRequest.onBeforeRequest((details, callback)=>callback({cancel:!/^about:|^data:/.test(details.url)}));
  await win.loadURL('about:blank');
  await win.webContents.executeJavaScript(`
    document.head.innerHTML = '<style>' + ${JSON.stringify(css)} + '</style>';
    document.head.insertAdjacentHTML('beforeend', '<style>*,*::before,*::after{animation:none!important;transition:none!important}</style>');
    document.body.innerHTML = ${JSON.stringify(page)} + '<div id="testCards" style="width:220px"></div>';
    document.body.style.cssText = 'padding:16px;overflow:auto;height:auto';
    document.querySelector('#page-video').classList.add('active');
    const $ = s=>document.querySelector(s);
    const escapeHtml = s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    const currentVideoPlatform = ()=>'apimart';
    const hasReferenceVideo = ()=>false;
    const videoMultiFirstFrameEnabled = ()=>false;
    const videoRefImages = [], videoAudioFilesData = [];
    const videoSelectedIds = new Set(), seedanceFinalSubmissions = new Set();
    const videoPlayableUrl = ()=>'';
    ${rules}
    ${functions}
    ${controls}
    setupVideoPage();
    const check = (value,message)=>{if(!value)throw new Error(message);};
    $('#videoModel').innerHTML = apimartVideoModelOptionsHtml();
    check($('#videoModel').options.length === 51, '51 active video models');
    check(!$('#videoModel').querySelector('[value="sora-2"]'), 'Sora is not in new-task choices');
    const agent = document.createElement('select'); agent.innerHTML = agentVideoModelOptionsHtml();
    check(!agent.querySelector('[value="sora-2-pro"]'), 'Agent remaining rules must not restore removed models');
    $('#videoModel').value = 'doubao-seedance-2.5';
    updateVideoResolutionOptions(); updateSeedance25Options();
    $('#seedance25Draft').checked = true;
    updateVideoResolutionOptions();
    check($('#videoResolution').value === '480p' && $('#videoResolution').disabled, 'Draft must lock 480p');
    $('#seedance25Draft').checked = false; updateVideoResolutionOptions();
    check($('#videoResolution').options.length === 3 && !$('#videoResolution').disabled, 'Normal Seedance resolutions restored');
    $('#seedance25Draft').checked = true;
    $('#videoModel').value = 'wan3.0-video'; updateVideoResolutionOptions(); updateSeedance25Options();
    check(!$('#videoResolution').disabled && $('#videoResolution').options.length === 3, 'Other models unaffected');
    check($('#seedance25Options').classList.contains('hidden'), 'Hide draft for other models');
    $('#videoModel').value = 'doubao-seedance-2.5'; updateVideoResolutionOptions(); updateSeedance25Options();
    $('#testCards').innerHTML = renderVideoCard({id:'test',model:'seedance-2.5',draft:true,task_id:'task_test',status:'已完成',resolution:'480p',progress:100});
    check(!!$('#testCards [data-video-act="finalize-draft"]'), 'Completed draft exposes final action');
    window.checkLayout = ()=>{
      for(const node of [$('#seedance25Draft').closest('label'), $('#testCards [data-video-act="finalize-draft"]')]){
        check(node.offsetWidth>0 && node.scrollWidth <= node.clientWidth+1, 'New control text must fit');
      }
    };
    window.checkLayout();
  `);
  const out = path.resolve(root, '../model-catalog-verification-20260929');
  fs.mkdirSync(out, {recursive:true});
  for (const [name,width] of [['desktop',1250],['narrow',640]]) {
    win.setContentSize(width,1020);
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await win.webContents.executeJavaScript('window.checkLayout()');
    fs.writeFileSync(path.join(out, name+'.png'), (await win.webContents.capturePage()).toPNG());
  }
  await win.webContents.executeJavaScript('document.querySelector("#testCards").scrollIntoView()');
  fs.writeFileSync(path.join(out, 'final-action.png'), (await win.webContents.capturePage()).toPNG());
  console.log('[verify-video-model-ui] Passed: active catalogs, draft constraints, model switching, final action, desktop/narrow layout.');
  win.destroy(); app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
