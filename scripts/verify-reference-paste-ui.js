'use strict';
// Run with Electron: isolated DOM and synthetic files, no user clipboard writes or API requests.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
process.on('uncaughtException', error => {console.error(error); app.exit(1);});
const {pasteSource} = require('./verify-reference-paste');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-paste-test-')));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

async function scenarios() {
  const check = (ok, message) => {if (!ok) throw new Error(message);};
  const key = options => document.dispatchEvent(new KeyboardEvent('keydown', {key:'V', code:'KeyV', ctrlKey:true, shiftKey:true, bubbles:true, ...options}));
  const paste = async (files = [new File(['test'], 'test.png', {type:'image/png'})], prevented = false) => {
    const data = new DataTransfer();
    files.forEach(file => data.items.add(file));
    if (!files.length) data.setData('text/plain', 'unchanged text');
    const event = new ClipboardEvent('paste', {clipboardData:data, bubbles:true, cancelable:true});
    if (prevented) event.preventDefault();
    document.dispatchEvent(event);
    await new Promise(resolve => setTimeout(resolve, 0));
    return event;
  };
  const last = () => calls.at(-1)?.target;
  key(); await paste(); check(last() === 'ref', 'Ctrl+Shift+V reference routing');
  await paste(); check(last() === 'main', 'Intent must be one-shot');
  key({shiftKey:false}); await paste(); check(last() === 'main', 'Ctrl+V stays main');
  key({altKey:true}); await paste(); check(last() === 'main', 'Extra modifiers must not match');
  key(); const count = calls.length; const text = await paste([]);
  check(calls.length === count && !text.defaultPrevented, 'Plain text must remain native');
  key(); await paste([new File(['a'], 'a.png', {type:'image/png'}), new File(['b'], 'b.jpg', {type:'image/jpeg'})]);
  check(last() === 'ref' && calls.at(-1).count === 2, 'Paste multiple images exactly once');
  key(); await paste(undefined, true); check(calls.length === count + 1, 'Respect previously handled paste');
  for (const event of [new Event('blur'), new PointerEvent('pointerdown'), new KeyboardEvent('keydown', {key:'x'})]) {
    key(); (event.type === 'blur' ? window : document).dispatchEvent(event); await paste();
    check(last() === 'main', 'Clear stale reference intent on ' + event.type);
  }
  key(); homepageReferencePasteUntil = Date.now() - 1; await paste(); check(last() === 'main', 'Expired intent');
  for (const id of ['assetLibraryLayer','promptLibraryLayer','agentPopoutModal','chatPopoutModal','shortcutSettingsLayer']) {
    const modal = document.getElementById(id); modal.classList.add('active'); key();
    check(!consumeHomepageReferencePaste(), 'Do not intercept ' + id);
    if (id === 'assetLibraryLayer') {await paste(); check(last() === 'asset', 'Preserve asset library paste');}
    modal.classList.remove('active');
  }
  shortcutState.recording = 'open_app'; key(); check(!consumeHomepageReferencePaste(), 'Recording must not trigger paste routing'); shortcutState.recording = '';
  document.getElementById('page-home').classList.remove('active');
  document.getElementById('page-video').classList.add('active'); key(); await paste(); check(last() === 'video-ref', 'Preserve video reference paste');
  document.getElementById('page-video').classList.remove('active');
  document.getElementById('page-chat').classList.add('active'); key(); await paste(); check(last() === 'chat', 'Preserve chat paste');
  document.getElementById('page-chat').classList.remove('active'); document.getElementById('page-home').classList.add('active');
  key(); document.dispatchEvent(new KeyboardEvent('keyup', {key:'Shift'})); await paste(); check(last() === 'ref', 'Allow IPC paste to arrive after modifier release');
  failUpload = true; key(); await paste(); check(messages.at(-1) === 'test upload failed', 'Show upload errors'); failUpload = false;
  return calls.length;
}

app.whenReady().then(async () => {
  for (const preload of ['src/preload.js', 'lan-client/preload.js', '']) {
    const win = new BrowserWindow({show:false, webPreferences:{...(preload ? {preload:path.resolve(__dirname, '..', preload)} : {}), sandbox:preload.startsWith('lan'), nodeIntegration:false, contextIsolation:true}});
    let nativeRequests = 0;
    win.webContents.on('ipc-message', (_event, channel) => {if(channel === 'reference-image-paste') nativeRequests++;});
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({cancel:!/^about:|^data:/.test(details.url)}));
    await win.loadURL('about:blank');
    await win.webContents.executeJavaScript(`
      document.body.innerHTML = '<div id="page-home" class="active"></div><div id="refDrop" tabindex="0"></div>' + ['page-video','page-chat','assetLibraryLayer','promptLibraryLayer','agentPopoutModal','chatPopoutModal','shortcutSettingsLayer'].map(id => '<div id="'+id+'"></div>').join('');
      const $ = selector => document.querySelector(selector);
      const shortcutState = {recording:''};
      const calls = [], messages = []; let failUpload = false;
      const addFiles = async (files,target) => {if(failUpload) throw new Error('test upload failed'); calls.push({target,count:files.length});};
      const assetUploadFiles = files => addFiles(files,'asset');
      const videoMultiFirstFrameEnabled = () => false;
      const handleVideoRefs = files => addFiles(files,'video-ref');
      const addChatImages = files => addFiles(files,'chat');
      const toast = text => messages.push(text);
      ${pasteSource}
    `);
    if (!preload) {
      await win.webContents.executeJavaScript(`(async () => {
        const check = (ok, message) => {if(!ok) throw new Error(message);};
        const key = () => document.dispatchEvent(new KeyboardEvent('keydown', {key:'V',code:'KeyV',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
        Object.defineProperty(window, 'isSecureContext', {value:false,configurable:true});
        check(!key(), 'HTTP must suppress plain-text paste and offer fallback');
        check(document.activeElement.id === 'refDrop', 'Focus reference drop target for Ctrl+V fallback');
        const data = new DataTransfer(); data.items.add(new File(['test'],'test.png',{type:'image/png'}));
        document.activeElement.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
        check(calls.at(-1)?.target === 'ref', 'HTTP Ctrl+V fallback');
        document.activeElement.blur();
        Object.defineProperty(window, 'isSecureContext', {value:true,configurable:true});
        let reads = 0;
        Object.defineProperty(navigator, 'clipboard', {value:{read:async () => {reads++; return [{types:['image/png'],getType:async () => new Blob(['test'],{type:'image/png'})}];}},configurable:true});
        key(); const empty = new DataTransfer(); empty.setData('text/plain','');
        document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:empty,bubbles:true,cancelable:true}));
        await new Promise(resolve => setTimeout(resolve,0));
        check(reads === 1 && calls.at(-1)?.target === 'ref', 'Secure browser clipboard image fallback');
        navigator.clipboard.read = async () => {throw new Error('permission denied');};
        key(); document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:empty,bubbles:true,cancelable:true}));
        await new Promise(resolve => setTimeout(resolve,0));
        check(messages.at(-1).includes('Ctrl+V'), 'Clipboard permission failure must explain fallback');
      })()`);
      console.log('[verify-reference-paste-ui] Browser HTTPS image path, permission errors and HTTP fallback passed.');
      win.destroy();
      continue;
    }
    const count = await win.webContents.executeJavaScript('(' + scenarios.toString() + ')()');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (nativeRequests < 1) throw new Error(preload + ': isolated renderer IPC did not reach desktop');
    const shellSource = fs.readFileSync(path.resolve(__dirname, '..', preload.replace('preload.js','main.js')), 'utf8');
    const gestureHandler = shellSource.match(/const referencePasteKey = input.control[\s\S]*?if\(input.type === 'keyDown'\) referencePasteGestureUntil = referencePasteKey \? Date.now\(\) \+ 1500 : 0;/)[0];
    const ipcHandler = shellSource.match(/mainWindow.webContents.on\('ipc-message', \(_event, channel\) => \{[\s\S]*?\n  \}\);/)[0];
    let nativePastes = 0;
    win.webContents.paste = () => {
      nativePastes++;
      win.webContents.executeJavaScript(`{
        const data = new DataTransfer(); data.items.add(new File(['test'],'native.png',{type:'image/png'}));
        document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
      }`);
    };
    vm.runInNewContext('let referencePasteGestureUntil = 0;\nmainWindow.webContents.on("before-input-event", (_event,input) => {' + gestureHandler + '});\n' + ipcHandler, {mainWindow:win});
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'V',modifiers:['control','shift']});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'V',modifiers:['control','shift']});
    await new Promise(resolve => setTimeout(resolve, 200));
    if(nativePastes !== 1 || !await win.webContents.executeJavaScript('calls.at(-1)?.target === "ref"')) throw new Error(preload + ': native key to reference paste round trip failed');
    console.log('[verify-reference-paste-ui] ' + preload + ': ' + count + ' paste cases and real IPC bridge passed.');
    win.destroy();
  }
  app.exit(0);
}).catch(error => {console.error(error); app.exit(1);});
