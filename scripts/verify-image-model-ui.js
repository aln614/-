'use strict';

// Run with Electron. This isolated hidden window never loads user data or calls APIMart.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-model-ui-')));
app.disableHardwareAcceleration();
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/static/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<(?:link|img|source)\b[^>]*>/gi, '');
const functions = [
  'imageModelKey','isOfficialImageModel','isGptImage25Model','isGptImage25ExtModel',
  'isSeedream5LiteModel','isSeedream5ProModel','isSeedream5OutputFormatModel',
  'isFluxKontextModel','isFlux2Model','isFluxImageModel','isLtx23TextImageModel',
  'isQwenImage3Model','isQwenImage2Model','isNanoBananaLiteModel','isZImageTurboModel',
  'isWan27ImageModel','isGrokAspectRatioImageModel','isGrokImagine2ExtModel',
  'clampImageOutputCount','applyDocumentedImageUiGuard','applyFluxImageUiGuard',
  'isMultiNImageModel','applyGptImage25UiGuard','applyQwenImage3UiGuard',
  'applySeedream5ProUiGuard','updateOfficialImageOptions'
].map(name => {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Missing ' + name);
  const firstLine = source.slice(start, source.indexOf('\n', start)).trimEnd();
  return firstLine.endsWith('}') ? firstLine : source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');

app.whenReady().then(async () => {
  const win = new BrowserWindow({show:false, webPreferences:{sandbox:true, nodeIntegration:false, contextIsolation:true}});
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({cancel:!/^about:|^data:/.test(details.url)}));
  await win.loadURL('about:blank');
  await win.webContents.executeJavaScript('document.body.innerHTML = ' + JSON.stringify(html));
  await win.webContents.executeJavaScript(`
    const $ = selector => document.querySelector(selector);
    const currentImagePlatform = () => 'apimart';
    const getSizeValue = () => $('#size').value;
    const applySizeToUI = value => { $('#size').value = value; };
    let apimartSizeOptionsHtml = '', apimartClarityOptionsHtml = '';
    let mainImages = [], refImages = [];
    const FLUX_IMAGE_SIZES = ['auto','custom','1:1','4:3','3:4','16:9','9:16','3:2','2:3','21:9','9:21'];
    ${functions}
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const selectModel = model => { $('#model').value = model; updateOfficialImageOptions(); };
    $('#imageN').value = '12';
    selectModel('gpt-image-2.5-ext');
    check($('#size').options.length === 11, 'Ext must offer auto and ten ratios');
    check(![...$('#size').options].some(x => x.value === 'custom'), 'Ext cannot offer custom pixels');
    check([...$('#clarity').options].map(x => x.value).join(',') === '1K,2K,4K', 'Ext resolutions');
    check($('#imageN').value === '4', 'Ext output count');
    check($('#officialImageOptions').style.display === 'none', 'Ext must hide output format and background');
    check($('#moderation').closest('div').style.display === 'none', 'Ext must hide moderation');
    selectModel('gpt-image-2.5-ext-sunburst');
    check(isMultiNImageModel($('#model').value), 'Sunburst supports multi-output');
    selectModel('flux-2-pro');
    check($('#clarity').value === '2MP', 'Switch Ext to Flux');
    selectModel('gpt-image-2.5-flare');
    check([...$('#size').options].some(x => x.value === 'custom'), 'Restore exact pixel controls');
    check($('#officialImageOptions3').style.display !== 'none', 'Restore quality controls');
    check(![...$('#imageQuality').options].find(x => x.value === 'max').disabled, 'Restore max quality');
    selectModel('grok-imagine-image-2.0');
    check($('#imageQuality').value === 'medium', 'Grok default quality');
    check([...$('#imageQuality').options].filter(x => !x.disabled).map(x => x.value).join(',') === 'low,medium', 'Grok quality choices');
    selectModel('gpt-image-2-official');
    check(![...$('#imageQuality').options].find(x => x.value === 'high').disabled, 'Restore official high quality');
    selectModel('gemini-2.5-flash-image-preview');
    check($('#clarity').value === '1K' && $('#imageN').value === '1', 'Nano Banana native constraints');
    mainImages = [{}];
    $('#clarity').value = '4K';
    selectModel('wan2.7-image-pro');
    check($('#clarity').value === '2K', 'Wan editing resolution');
  `);
  console.log('[verify-image-model-ui] Real Chromium model switching and form controls passed.');
  win.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
