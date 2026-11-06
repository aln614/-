'use strict';

// This bridge is opt-in until packaging, fallback and window-shape validation
// are complete. It is never loaded in the normal production configuration.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function createNativeGlass() {
  let directory = process.env.TENYING_EXPERIMENTAL_NATIVE_GLASS;
  if (process.platform !== 'win32' || !directory) return null;
  const userData=require('electron').app.getPath('userData');
  if(directory.length>180) {
    const files=['inproc-safe.dll','Microsoft.Graphics.Canvas.dll','Microsoft.Graphics.Canvas.winmd','probe.exe.manifest',
      'concrt140_app.dll','msvcp140_1_app.dll','msvcp140_2_app.dll','msvcp140_app.dll','msvcp140_atomic_wait_app.dll',
      'vcamp140_app.dll','vccorlib140_app.dll','vcomp140_app.dll','vcruntime140_1_app.dll','vcruntime140_app.dll'];
    const hash=crypto.createHash('sha256');
    for(const name of files) hash.update(name).update(fs.readFileSync(path.join(directory,name)));
    const staged=path.join(userData,'native-glass-runtime-'+hash.digest('hex').slice(0,16));
    if(staged.length>180) throw new Error('Native glass runtime path is too long');
    fs.mkdirSync(staged,{recursive:true});
    for(const name of files) {
      const source=path.join(directory,name),target=path.join(staged,name);
      try {fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);}
      catch(error) {if(error.code!=='EEXIST') throw error;}
      const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if(digest(source)!==digest(target)) throw new Error(`Native glass runtime verification failed: ${name}`);
    }
    directory=staged;
  }
  const koffi = require('koffi');
  // CLR initialization can exceed Koffi's default foreign-call stack.
  koffi.config({sync_stack_size:16*1024*1024});
  const kernel = koffi.load('kernel32.dll');
  const getShortPath = kernel.func('uint32 GetShortPathNameW(str16 source, _Out_ uint16_t *destination, uint32 size)');
  const buffer = Buffer.alloc(32768 * 2);
  const length = getShortPath(directory, buffer, 32768);
  const nativeDirectory = length > 0 && length < 32768 ? buffer.toString('utf16le',0,length*2) : directory;
  const runtime = koffi.load('mscoree.dll');
  const bind = runtime.func('int32 CorBindToRuntimeEx(str16 version, str16 flavor, uint32 flags, void *clsid, void *iid, _Out_ void **host)');
  const guid = value => {
    const bytes = Buffer.alloc(16), parts = value.split('-');
    bytes.writeUInt32LE(parseInt(parts[0], 16), 0);
    bytes.writeUInt16LE(parseInt(parts[1], 16), 4);
    bytes.writeUInt16LE(parseInt(parts[2], 16), 6);
    Buffer.from(parts[3] + parts[4], 'hex').copy(bytes, 8);
    return bytes;
  };
  const hostOut = [null];
  const bindResult = bind('v4.0.30319', 'wks', 0,
    guid('90f1a06e-7712-4762-86b5-7a5eba6bdb02'),
    guid('90f1a06c-7712-4762-86b5-7a5eba6bdb02'), hostOut);
  if (bindResult) throw new Error(`CLR binding failed: ${bindResult >>> 0}`);
  const host = hostOut[0], vtable = koffi.decode(host, 'void *');
  const start = koffi.proto('int32 Start(void *host)');
  const execute = koffi.proto('int32 Execute(void *host, str16 assembly, str16 type, str16 method, str16 arg, _Out_ uint32 *returnValue)');
  const startResult = koffi.call(koffi.decode(vtable, 3 * 8, 'void *'), start, host);
  if (startResult) throw new Error(`CLR start failed: ${startResult >>> 0}`);
  const assembly = path.join(nativeDirectory, 'inproc-safe.dll');
  const manifest = path.join(nativeDirectory, 'probe.exe.manifest');
  const log = path.join(userData, 'native-glass.log');
  fs.mkdirSync(path.dirname(log),{recursive:true});
  let initialized = false;
  const attached = new Map();
  const observed = new WeakSet();
  function call(method, argument) {
    const result = [0];
    const hr = koffi.call(koffi.decode(vtable, 11 * 8, 'void *'), execute, host, assembly, 'NativeGlass', method, argument, result);
    if (hr || result[0]) throw new Error(`Native glass ${method} failed: ${(hr || result[0]) >>> 0}`);
  }
  function detach(win) {
    const handle = attached.get(win);
    if (!handle) return;
    attached.delete(win);
    call('RemoveWindow', handle);
  }
  return {
    apply(win, enabled, blur) {
      if (!enabled) { detach(win); return false; }
      let handle = attached.get(win);
      if (!handle) {
        handle = win.getNativeWindowHandle().readBigUInt64LE().toString();
        call(initialized ? 'AddWindow' : 'Init', initialized ? handle : [handle, manifest, log].join('|'));
        initialized = true;
        attached.set(win, handle);
        if(!observed.has(win)) {
          observed.add(win);
          const resize=()=>{
            const current=attached.get(win);
            if(current && !win.isDestroyed()) {
              try {call('Resize',`${current}|${win.isMaximized()?1:0}`);} catch(error) {console.error(error);}
            }
          };
          for(const event of ['resize','maximize','unmaximize']) win.on(event,resize);
          win.once('closed', () => { try { detach(win); } catch (error) { console.error(error); } });
        }
      }
      call('Resize',`${handle}|${win.isMaximized()?1:0}`);
      call('SetBlur', `${handle}|${Math.max(0, Math.min(40, Number(blur) || 0))}`);
      return true;
    }
  };
}

module.exports = { createNativeGlass };
