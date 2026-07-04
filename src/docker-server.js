'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

process.env.LAIG_DOCKER = process.env.LAIG_DOCKER || '1';
process.env.LAIG_SERVER_ONLY = process.env.LAIG_SERVER_ONLY || '1';
process.env.LOCAL_API_IMAGE_GENERATOR_DATA_DIR = process.env.LOCAL_API_IMAGE_GENERATOR_DATA_DIR || '/data/runtime';
process.env.LAIG_OUTPUT_DIR = process.env.LAIG_OUTPUT_DIR || '/data/output';
process.env.LAIG_DOWNLOAD_DIR = process.env.LAIG_DOWNLOAD_DIR || '/data/downloads';

for (const dir of [
  process.env.LOCAL_API_IMAGE_GENERATOR_DATA_DIR,
  process.env.LAIG_OUTPUT_DIR,
  process.env.LAIG_DOWNLOAD_DIR,
  process.env.LAIG_ASSET_DIR || path.join(process.env.LOCAL_API_IMAGE_GENERATOR_DATA_DIR, 'assets_library')
]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

const appPaths = new Map([
  ['userData', process.env.LOCAL_API_IMAGE_GENERATOR_DATA_DIR],
  ['pictures', process.env.LAIG_OUTPUT_DIR],
  ['downloads', process.env.LAIG_DOWNLOAD_DIR],
  ['temp', process.env.TMPDIR || '/tmp'],
  ['home', process.env.HOME || '/data']
]);

class EmptyNativeImage {
  isEmpty() { return true; }
  resize() { return this; }
  toPNG() { return Buffer.alloc(0); }
}

class HeadlessBrowserWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new EventEmitter();
    this.webContents.session = {};
    this.webContents.loadURL = async () => {};
    this.webContents.executeJavaScript = async () => {};
    this.webContents.setWindowOpenHandler = () => {};
    this.webContents.on = this.webContents.on.bind(this.webContents);
  }
  loadURL() { return Promise.resolve(); }
  isDestroyed() { return false; }
  destroy() {}
}

const electronShim = {
  app: {
    setAppUserModelId() {},
    setPath(name, value) { if (name && value) appPaths.set(name, value); },
    getPath(name) { return appPaths.get(name) || appPaths.get('home') || '/data'; },
    getVersion() {
      try { return require('../package.json').version || '0.0.0'; }
      catch { return '0.0.0'; }
    },
    whenReady() { return Promise.resolve(); },
    on() {},
    once() {},
    quit() { process.exit(0); }
  },
  BrowserWindow: HeadlessBrowserWindow,
  shell: { openExternal: async () => false },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  clipboard: { writeImage() {}, writeText() {} },
  nativeImage: {
    createFromPath: () => new EmptyNativeImage(),
    createFromDataURL: () => new EmptyNativeImage(),
    createFromBuffer: () => new EmptyNativeImage()
  },
  ipcMain: { on() {}, handle() {}, removeHandler() {} }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronShim;
  return originalLoad.apply(this, arguments);
};

require('./main');
