'use strict';
const path = require('path');
const {app, BrowserWindow, dialog} = require('electron');
const {registerFolderExport} = require('../../lan-client/folderExport');
let window;
app.setPath('userData', process.env.EXPORT_TEST_PROFILE);
registerFolderExport({getWindow:()=>window,isAllowedOrigin:url=>new URL(url).origin===process.env.EXPORT_TEST_ORIGIN});
dialog.showOpenDialog = async()=>({canceled:false,filePaths:[process.env.EXPORT_TEST_DESTINATION]});
app.whenReady().then(async()=>{
  window = new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../../src/preload.js'),contextIsolation:true,nodeIntegration:false}});
  await window.loadURL(process.env.EXPORT_TEST_ORIGIN + '/');
});
app.on('window-all-closed',()=>app.quit());

