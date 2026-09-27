'use strict';

// Isolated Electron UI test. No production data, credentials or network access.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-agent-stream-')));
app.disableHardwareAcceleration();
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/static/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<(?:link|img|source)\b[^>]*>/gi, '');
const css = fs.readFileSync(path.join(root, 'src/renderer/static/style.css'), 'utf8');
const helper = fs.readFileSync(path.join(root, 'src/renderer/static/agent-stream.js'), 'utf8');
const functions = ['agentGenerationLabel','agentResultTextOutputsHtml','agentMessageMediaHtml',
  'renderAgentMessages','updateAgentStreamingMessage','parseAgentDirective','runAgentLoop',
  'streamChatCompletionRequest','closeAgentWindow','openAgentWindow'].map(name=>{
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  assert.ok(match, name);
  return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}).join('\n');

app.whenReady().then(async()=>{
  const win = new BrowserWindow({show:false,width:760,height:920,
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.on('console-message', event=>{ if(event.level === 'error') console.error('[renderer]', event.message); });
  win.webContents.session.webRequest.onBeforeRequest((details, cb)=>cb({cancel:!/^about:|^data:/.test(details.url)}));
  await win.loadURL('about:blank');
  await win.webContents.executeJavaScript('document.body.innerHTML=' + JSON.stringify(html));
  await win.webContents.insertCSS(css);
  await win.webContents.executeJavaScript(helper);
  await win.webContents.executeJavaScript("window.addEventListener('unhandledrejection', e=>console.error(e.reason?.stack || e.reason));");
  await win.webContents.executeJavaScript(`
    const $ = s=>document.querySelector(s), $$ = s=>[...document.querySelectorAll(s)];
    const escapeHtml = s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const reply = {role:'assistant',text:'',streaming:true};
    const agentMessages = [{role:'user',text:'请使用参考图生成产品图片，并告诉我执行进度。'},reply];
    let agentConfig = {model:'test'}, agentSending = true;
    let toolsCalled = 0, previewClicks = 0, historyLoads = 0;
    const AGENT_TOOL_CATALOG = [{name:'create_image_batch',description:'提交图片生成任务。'}];
    const buildAgentMessages = ()=>[], agentApimartCredentials = ()=>({});
    const getClientId = ()=> 'test', getPublicAccess = ()=> '';
    const persistAgentHistory = ()=>{}, showPreview = ()=>previewClicks++;
    const loadChatModels = async()=>{}, readAgentConfig = ()=>agentConfig;
    const restoreAgentWindowSize = ()=>{}, renderAgentModelOptions = ()=>{};
    const renderAgentGenerationModelOptions = ()=>{}, loadAgentHistory = ()=>historyLoads++;
    const updateAgentApiStatus = ()=>{}, bringFloatingLayer = ()=>{};
    const runAgentTool = async()=>{toolsCalled++;return {id:'batch-test'};};
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = previewCanvas.height = 64;
    const ctx = previewCanvas.getContext('2d');
    ctx.fillStyle = '#d5f5ed';ctx.fillRect(0,0,64,64);
    ctx.fillStyle = '#137c70';ctx.fillRect(20,16,24,36);
    const attachAgentGenerationResult = message=>{
      message.generation_results=[{kind:'image_batch',state:'completed',status:'已完成，返回 1 张',
        items:[{full_url:previewCanvas.toDataURL()}]}];
      renderAgentMessages();
    };
    let controllers = [];
    window.fetch = async()=>new Response(new ReadableStream({start(c){controllers.push(c);}}),
      {headers:{'Content-Type':'text/event-stream'}});
    const send = (index, ev)=>controllers[index].enqueue(new TextEncoder().encode('data: '+JSON.stringify(ev)+'\\n\\n'));
    const check = (ok,msg)=>{if(!ok)throw new Error(msg);};
    ${functions}
    $('#agentPopoutModal').classList.add('active');
    Object.assign($('#agentFloatingWindow').style,{left:'12px',top:'12px',width:'710px',height:'830px',maxHeight:'calc(100vh - 24px)'});
    renderAgentMessages();
    window.finished = runAgentLoop('test',reply,$('#agentThinkingBadge'),performance.now());
    true;
  `);
  await win.webContents.executeJavaScript(`
    send(0,{delta:'{"type":"tool_call","message":"正在为你提交'});
    true;
  `);
  await new Promise(resolve=>setTimeout(resolve, 100));
  await win.webContents.executeJavaScript(`(async()=>{
    check(reply.text === '正在为你提交', 'Tool prelude must stream before completion');
    check(toolsCalled === 0, 'No tool side effect from partial JSON');
    check($('#agentMessages').innerText.includes('正在为你提交'), 'Stream must be visible in the DOM');
    closeAgentWindow();
    await openAgentWindow();
    check(historyLoads === 0, 'Reopening cannot reload history over an active response');
    send(0,{delta:'图片","tool":"create_image_batch","args":{}}'});
    send(0,{done:true});controllers[0].close();
    return true;
  })()`);
  await new Promise(resolve=>setTimeout(resolve, 100));
  await win.webContents.executeJavaScript(`
    check(toolsCalled === 1, 'Tool executes once after completion');
    window.mediaNode = $('#agentMessages [data-agent-preview]');
    check(!!mediaNode, 'Generation result attached');
    send(1,{delta:'{"type":"final","message":"图片已提交，'});
    true;
  `);
  await new Promise(resolve=>setTimeout(resolve, 100));
  await win.webContents.executeJavaScript(`
    check($('#agentMessages').innerText.includes('图片已提交，'), 'Final text visible before the stream closes');
    check($('#agentMessages [data-agent-preview]') === mediaNode, 'Streaming must not replace result DOM');
    mediaNode.click();
    check(previewClicks === 1, 'Preview handler survives streaming updates');
    true;
  `);
  const output = path.join(root, '..', 'agent-stream-verification');
  fs.mkdirSync(output, {recursive:true});
  await win.webContents.executeJavaScript(`(async()=>{
    const image = mediaNode.querySelector('img');image.loading = 'eager';await image.decode();
    check(image.naturalWidth === 64, 'Preview bitmap must render');
  })()`);
  await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(output, 'agent-stream-desktop.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`
    Object.assign($('#agentFloatingWindow').style,{width:'350px',height:'800px'});
    true;
  `);
  win.setSize(390,880);
  await new Promise(resolve=>setTimeout(resolve, 100));
  await win.webContents.executeJavaScript(`(async()=>{
    const bubble = $('#agentMessages [data-agent-message-index="1"] .agent-message-bubble');
    check(bubble.scrollWidth <= bubble.clientWidth + 1, 'Narrow window must wrap reply/status text');
    send(1,{delta:'结果会自动显示。"}'});
    send(1,{done:true});controllers[1].close();
    await window.finished;
    reply.streaming = false;
    renderAgentMessages();
    check($('#agentMessages [data-agent-message-index="1"] .agent-message-status').hidden, 'Completed reply has no stuck progress indicator');
    check(reply.text === '正在为你提交图片\\n\\n图片已提交，结果会自动显示。', 'Final text is complete and not duplicated');
    return true;
  })()`);
  await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(output, 'agent-stream-narrow.png'), (await win.webContents.capturePage()).toPNG());
  win.destroy();
  console.log('Agent Electron UI passed: live text before completion, window reopen, persistent preview handlers and narrow layout.');
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
