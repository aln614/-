'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {_electron: electron, chromium} = require('playwright');
const {PNG} = require('pngjs');

const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-clipboard-'));
const runtime = path.join(temporary, 'runtime');
const output = path.join(temporary, 'output');
fs.mkdirSync(runtime);
fs.mkdirSync(output);
fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({
  port:18796, shortcuts_enabled:false, update_auto_check:false, public_enabled:false,
  output_dir:output, asset_library_dir:path.join(temporary, 'assets')
}));

(async () => {
  let app, browser, savedClipboard = false;
  try {
    const packaged = process.env.CLIPBOARD_TEST_PACKAGED;
    app = await electron.launch({
      executablePath:packaged || require('electron'),
      args:packaged ? ['--background'] : [root, '--background'],
      env:{...process.env, APPDATA:temporary, LOCALAPPDATA:temporary, LOCAL_API_IMAGE_GENERATOR_DATA_DIR:runtime}
    });
    const page = await app.firstWindow();
    await page.waitForURL('http://127.0.0.1:18796/**', {timeout:30000});
    await page.waitForFunction(() => typeof showPreview === 'function');
    await app.evaluate(async ({clipboard, ClipboardItem}) => {
      const items = await clipboard.read();
      global.__savedClipboard = await Promise.all(items.map(async item => {
        const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)]));
        return new ClipboardItem(Object.fromEntries(entries));
      }));
    });
    savedClipboard = true;
    const fixture = await app.evaluate(({app, BrowserWindow, clipboard, nativeImage, Menu}, output) => {
      const fs = process.getBuiltinModule('node:fs');
      const path = process.getBuiltinModule('node:path');
      const requireApp = process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(), 'package.json'));
      const width = 13, height = 7;
      const pixels = Buffer.alloc(width * height * 4);
      for (let i = 4; i < pixels.length; i += 4) {
        pixels[i] = 40; pixels[i + 1] = 130; pixels[i + 2] = 220; pixels[i + 3] = 255;
      }
      const image = nativeImage.createFromBitmap(pixels, {width, height});
      const original = path.join(output, 'original.png');
      const thumb = path.join(output, 'thumbnail.png');
      fs.writeFileSync(original, image.toPNG());
      fs.writeFileSync(thumb, image.resize({width:3, height:2}).toPNG());
      const db = requireApp('./src/services/db');
      db.getDB()._store.images.push({id:'clipboard-image', file_path:original, thumb_path:thumb, task_id:'clipboard-task'});
      db.getDB()._store.tasks.push({id:'clipboard-task', prompt:"Test 'quoted' prompt\n第二行"});
      const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('http://127.0.0.1:18796/'));
      global.__copyMenu = async (srcURL, index) => {
        let template;
        const build = Menu.buildFromTemplate;
        Menu.buildFromTemplate = items => {template = items; return {popup() {}};};
        try {
          win.webContents.emit('context-menu', {}, {srcURL});
          if (!template) throw new Error('Image context menu was not installed');
          await template[index].click();
        } finally {Menu.buildFromTemplate = build;}
      };
      global.__readTestImage = async () => {
        const items = await clipboard.read();
        const item = items.find(item => item.types.includes('image/png'));
        if (!item) throw new Error('PNG missing from clipboard');
        const blob = await item.getType('image/png');
        return Buffer.from(await blob.arrayBuffer()).toString('base64');
      };
      return {
        original:'http://127.0.0.1:18796/file?path=' + encodeURIComponent(original),
        thumb:'http://127.0.0.1:18796/file?path=' + encodeURIComponent(thumb),
        data:image.toDataURL(), width, height
      };
    }, output);
    await page.evaluate(() => {
      window.__clipboardMessages = [];
      window.__copyImageToast = message => window.__clipboardMessages.push(message);
    });
    for (const source of [fixture.original, fixture.thumb, fixture.data]) {
      await app.evaluate(async (_, source) => global.__copyMenu(source, 0), source);
      const actual = PNG.sync.read(Buffer.from(await app.evaluate(() => global.__readTestImage()), 'base64'));
      assert.equal(actual.width, fixture.width, 'Copy retains original dimensions, even from a thumbnail');
      assert.equal(actual.height, fixture.height);
      assert.equal(actual.data[3], 0, 'Copy retains transparency');
      assert.equal(actual.data[7], 255);
    }
    await app.evaluate(async (_, source) => global.__copyMenu(source, 1), fixture.original);
    assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), fixture.original);
    await app.evaluate(async (_, source) => global.__copyMenu(source, 2), fixture.thumb);
    assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), "Test 'quoted' prompt\n第二行");
    const failure = "clipboard busy 'test'\n请重试";
    for (const index of [0, 1, 2]) {
      await page.evaluate(() => {window.__clipboardMessages = [];});
      await app.evaluate(async ({clipboard}, {source, index, failure}) => {
        const method = index === 0 ? 'write' : 'writeText';
        const original = clipboard[method];
        clipboard[method] = async () => {throw new Error(failure);};
        try {await global.__copyMenu(source, index);}
        finally {clipboard[method] = original;}
      }, {source:fixture.thumb, index, failure});
      await page.waitForFunction(failure => window.__clipboardMessages.includes('复制失败：' + failure), failure);
      assert.equal(await page.evaluate(() => window.__clipboardMessages.some(message => message.includes('已复制'))), false);
    }
    await app.evaluate(async (_, source) => global.__copyMenu(source, 0), 'data:image/png;base64,invalid');
    assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), "Test 'quoted' prompt\n第二行", 'Decode failures leave the previous clipboard intact');

    browser = await chromium.launch({channel:'msedge', headless:true});
    const context = await browser.newContext({permissions:['clipboard-read', 'clipboard-write']});
    const web = await context.newPage();
    await web.goto('http://127.0.0.1:18796/');
    await web.waitForFunction(() => typeof copyImageFromUrl === 'function');
    assert.equal(await web.evaluate(source => copyImageFromUrl(source), fixture.original), 'image');
    const webSize = await web.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const png = await items[0].getType('image/png');
      const bitmap = await createImageBitmap(png);
      const size = {width:bitmap.width, height:bitmap.height};
      bitmap.close();
      return size;
    });
    assert.deepEqual(webSize, {width:fixture.width, height:fixture.height});
    console.log('Clipboard passed: native original/thumbnail/data URLs, transparency, text, rejected writes and browser image copy.');
  } finally {
    if (browser) await browser.close();
    if (app) {
      try {
        if (savedClipboard) await app.evaluate(async ({clipboard}) => {
          if (global.__savedClipboard.length) await clipboard.write(global.__savedClipboard);
          else clipboard.clear();
          delete global.__savedClipboard;
        });
      } finally {await app.close();}
    }
    const relative = path.relative(os.tmpdir(), temporary);
    if (!relative.startsWith('tenying-clipboard-') || relative.includes(path.sep)) throw new Error('Unsafe clipboard test cleanup');
    fs.rmSync(temporary, {recursive:true, force:true, maxRetries:6, retryDelay:200});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
