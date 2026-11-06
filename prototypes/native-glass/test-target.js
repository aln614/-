'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const cp = require('node:child_process');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-composition-target-'));
const data = path.join(temp, 'data');
fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({port:18819,shortcuts_enabled:false,update_auto_check:false,public_enabled:false}));
(async () => {
  let host, helper;
  try {
    host = await electron.launch({executablePath:require('electron'),args:[root,`--user-data-dir=${path.join(temp,'user')}`],env:{...process.env,APPDATA:temp,LOCALAPPDATA:temp,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const page = await host.firstWindow();
    await page.waitForURL('http://127.0.0.1:18819/**',{timeout:30000});
    const hwnd = await host.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
    helper = cp.spawn(path.join(os.tmpdir(),'tenying-composition-probe','probe.exe'),[hwnd],{windowsHide:true});
    const output = await new Promise((resolve,reject)=>{
      let text='';
      const timer=setTimeout(()=>{helper.kill();reject(new Error('Composition helper timed out: '+text));},10000);
      helper.stdout.on('data',chunk=>{
        text+=chunk.toString();
        if(text.includes('TARGET OK')) {clearTimeout(timer);resolve(text);}
      });
      helper.on('exit',code=>{clearTimeout(timer);reject(new Error('Composition helper exited '+code+': '+text));});
      helper.on('error',reject);
    });
    console.log(output);
  } finally {
    if(helper) helper.kill();
    if(host) await host.close();
    const relative=path.relative(os.tmpdir(),temp);
    if(!relative.startsWith('tenying-composition-target-') || relative.includes(path.sep)) throw Error('Unsafe cleanup');
    fs.rmSync(temp,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
