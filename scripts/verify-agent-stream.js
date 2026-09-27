'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const AgentReplyStream = require('../src/renderer/static/agent-stream');
const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/static/app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
function extract(source, name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  assert.ok(match, name);
  return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}
const wait = ms => new Promise(resolve=>setTimeout(resolve, ms));
const event = data => 'data: ' + JSON.stringify(data) + '\n\n';

async function verifyParser() {
  const text = '你好，正在准备图片。\nQuoted "text", \\path, {braces} and \u{1f600}';
  for (const encoded of [JSON.stringify(text), JSON.stringify(text).replace('你好', '\\u4f60\\u597d')]) {
    const raw = '{"type":"final","message":' + encoded + '}';
    let sawPartial = false;
    for (let i = 1; i <= raw.length; i++) {
      const part = AgentReplyStream.read(raw.slice(0, i)).text;
      assert.ok(text.startsWith(part), JSON.stringify(part));
      if (part && part !== text) sawPartial = true;
    }
    assert.ok(sawPartial, 'Public text must be available before JSON is complete');
    assert.equal(AgentReplyStream.read(raw).text, text);
    assert.equal(AgentReplyStream.read('```json\n' + raw + '\n```').text, text);
  }
  const tool = JSON.stringify({type:'tool_call', message:'正在提交图片', tool:'create_image_batch',
    args:{message:'SECRET', content:'SECRET', nested:[{type:'final',message:'SECRET'}]}});
  for (let i = 1; i <= tool.length; i++) assert.ok(!AgentReplyStream.read(tool.slice(0, i)).text.includes('SECRET'));
  assert.equal(AgentReplyStream.read(tool).text, '正在提交图片');
  assert.equal(AgentReplyStream.read('{"args":{"message":"SECRET"},"type":"tool_call","tool":"x"}').text, '');
  assert.equal(AgentReplyStream.read('{"message":"Done","type":"final"}').text, 'Done');
  assert.equal(AgentReplyStream.read('{"type":"final","reasoning":"SECRET","content":"Done"}').text, 'Done');
  assert.equal(AgentReplyStream.read('Plain reply').text, 'Plain reply');
}

async function verifyClientStream() {
  const context = vm.createContext({TextDecoder, getClientId:()=> 'test', getPublicAccess:()=> '', fetch:null});
  vm.runInContext(extract(renderer, 'streamChatCompletionRequest'), context);
  const reply = '你好，图片已提交';
  const bytes = new TextEncoder().encode(': heartbeat\n\n' + event({delta:reply}) + event({done:true,content:reply}));
  let calls = 0;
  let cancelled = false;
  let released = false;
  context.fetch = async()=>({ok:true, body:{getReader:()=>({
    read:async()=>calls < bytes.length ? {value:bytes.slice(calls, ++calls),done:false} : {done:true},
    cancel:async()=>{cancelled=true;}, releaseLock:()=>{released=true;}
  })}});
  const live = [];
  assert.equal((await context.streamChatCompletionRequest({}, ev=>live.push(ev))).content, reply);
  assert.equal(live[0].delta, reply, 'UTF-8 byte boundaries must not corrupt Chinese');
  assert.ok(cancelled && released);
  for (const suffix of ['', event({error:'connection failed'})]) {
    context.fetch = async()=>new Response(event({delta:'partial'}) + suffix);
    await assert.rejects(context.streamChatCompletionRequest({}, ()=>{}), /中断|connection failed/);
  }
  context.fetch = async()=>new Response(event({done:true,content:''}));
  await assert.rejects(context.streamChatCompletionRequest({}, ()=>{}), /没有返回/);
  context.fetch = async()=>new Response(event({delta:'x'}) + event({done:true,content:'x'}));
  await assert.rejects(context.streamChatCompletionRequest({}, ()=>{throw new Error('paint failure');}), /paint failure/);
}

async function verifyLoop() {
  let elapsed = 0;
  let step = 0;
  let toolsCalled = 0;
  let activeIntervals = 0;
  const message = {role:'assistant',text:'',streaming:true};
  const status = [];
  const context = vm.createContext({
    AgentReplyStream, agentMessages:[message], agentConfig:{model:'test'}, $:()=>null,
    performance:{now:()=>elapsed+=80}, buildAgentMessages:()=>[],
    setTimeout, clearTimeout,
    agentApimartCredentials:()=>({api_endpoint:'https://unused.invalid',api_key:'test'}),
    persistAgentHistory:()=>{}, AGENT_TOOL_CATALOG:[{name:'create_image_batch',description:'提交图片。'}],
    updateAgentStreamingMessage:m=>status.push({text:m.text,status:m.stream_status}),
    setInterval:()=>{activeIntervals++;return 1;}, clearInterval:()=>{activeIntervals--;},
    runAgentTool:async()=>{toolsCalled++;return {id:'batch-test'};},
    attachAgentGenerationResult:m=>{m.generation_results=[{id:'batch-test'}];},
    streamChatCompletionRequest:async(payload, onEvent)=>{
      step++;
      if(step === 1) {
        onEvent({content:'{"type":"tool_call","message":"正在提交'});
        assert.equal(message.text, '正在提交', 'Tool action description should be visible immediately');
        assert.equal(toolsCalled, 0, 'Partial JSON must never trigger a tool');
        const raw = '{"type":"tool_call","message":"正在提交图片","tool":"create_image_batch","args":{"prompt":"SECRET"}}';
        onEvent({done:true,content:raw});
        return {content:raw};
      }
      onEvent({content:'{"type":"final","message":"已提交'});
      assert.ok(message.text.endsWith('已提交'), 'Final reply must render before the request finishes');
      assert.ok(message.generation_results.length, 'Text streaming must retain attached results');
      const raw = '{"type":"final","message":"已提交，等待生成。"}';
      onEvent({done:true,content:raw});
      return {content:raw};
    }
  });
  vm.runInContext(extract(renderer, 'parseAgentDirective') + '\n' + extract(renderer, 'runAgentLoop'), context);
  await context.runAgentLoop('test', message, {}, 0);
  assert.equal(toolsCalled, 1);
  assert.equal(message.text, '正在提交图片\n\n已提交，等待生成。');
  assert.ok(status.some(s=>/正在执行/.test(s.status)));
  assert.ok(status.every(s=>!s.text.includes('SECRET')));
  assert.equal(activeIntervals, 0);
  assert.equal(message.stream_status, undefined);

  context.streamChatCompletionRequest = async(payload, onEvent)=>{
    onEvent({content:'{"type":"tool_call","tool":"create_image_batch","args":{}}'});
    throw new Error('stream interrupted');
  };
  await assert.rejects(context.runAgentLoop('test', message, {}, 0), /interrupted/);
  assert.equal(toolsCalled, 1, 'Interrupted stream must not execute even a complete-looking directive');
  assert.equal(activeIntervals, 0);
}

async function verifyServerStream() {
  async function run(mode) {
    let spawns = 0;
    let killed = 0;
    const res = new EventEmitter();
    const sent = [];
    res.writeHead = ()=>{};
    res.flushHeaders = ()=>{};
    res.write = s=>sent.push(s);
    res.end = ()=>res.emit('close');
    const context = vm.createContext({
      process:{platform:'win32'}, setTimeout, clearTimeout, setInterval, clearInterval,
      normalizeChatStreamBase:()=> 'https://unused.invalid',
      applyChatStreamOptions:p=>p, chatStreamMessages:m=>m,
      getApimartProxyCandidates:()=>['proxy-1','proxy-2'], markGoodApimartProxy:()=>{},
      spawn:()=>{
        spawns++;
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = ()=>{killed++; child.emit('close',1);};
        child.stdin = {end:()=>setImmediate(async()=>{
          if(mode === 'disconnect') {res.emit('close');return;}
          let raw;
          if(mode === 'json') raw = JSON.stringify({choices:[{message:{content:'你好'}}]});
          else if(mode === 'empty') raw = 'data: [DONE]\n\n';
          else raw = event({choices:[{delta:{content:'你好'}}]});
          for(const byte of Buffer.from(raw)) child.stdout.write(Buffer.from([byte]));
          if(mode === 'normal' || mode === 'partial-error') {
            assert.ok(sent.some(s=>s.includes('你好')), 'Must forward bytes before curl exits');
            await wait(5);
          }
          if(mode === 'sse-error') child.stdout.write(event({error:{message:'upstream failed'}}));
          child.stdout.end();
          child.emit('close', mode === 'partial-error' ? 56 : 0);
        })};
        return child;
      }
    });
    vm.runInContext(extract(main, 'pickChatDeltaFromStreamJson') + '\n' + extract(main, 'streamChatCompletionsToClient'), context);
    assert.equal(context.pickChatDeltaFromStreamJson({choices:[{delta:{reasoning_content:'SECRET'}}]}), '');
    assert.equal(context.pickChatDeltaFromStreamJson({choices:[{delta:{content:[{type:'text',text:'ok'}]}}]}), 'ok');
    await context.streamChatCompletionsToClient(res, {messages:[],apiKey:'test'});
    return {spawns,killed,events:sent.filter(s=>s.startsWith('data:')).map(s=>JSON.parse(s.slice(5)))};
  }
  for(const mode of ['normal','json']) {
    const result = await run(mode);
    assert.equal(result.events[0].delta, '你好');
    assert.equal(result.events.at(-1).done, true);
    assert.equal(result.spawns, 1);
  }
  for(const mode of ['partial-error','sse-error']) {
    const result = await run(mode);
    assert.ok(result.events.at(-1).error);
    assert.equal(result.spawns, 1, 'Do not replay a request after delivering text');
  }
  const empty = await run('empty');
  assert.ok(empty.events.at(-1).error);
  assert.equal(empty.spawns, 2, 'Can still retry when no text was delivered');
  const disconnected = await run('disconnect');
  assert.ok(disconnected.killed > 0);
  assert.equal(disconnected.spawns, 1);
}

(async()=>{
  await verifyParser();
  await verifyClientStream();
  await verifyLoop();
  await verifyServerStream();
  console.log('Agent streaming passed: incremental public text, JSON isolation, UTF-8, tool timing, errors and disconnects.');
})().catch(error=>{console.error(error);process.exitCode=1;});
