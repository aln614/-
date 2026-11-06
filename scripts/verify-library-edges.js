'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '..');
const css = ['style.css', 'sidebar.css', 'clear-glass.css', 'recent-media.css', 'form-controls.css']
  .map(name => fs.readFileSync(path.join(root, 'src/renderer/static', name), 'utf8')).join('\n');

(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1180, height: 730}});
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
      <div class="asset-library-window liquid-surface-active" id="asset">
        <div class="liquid-glass-mount"><div class="liquid-react-layer"><span></span></div></div>
        <div class="liquid-backdrop" style="--liquid-refraction:url('#fixture')"></div>
        <div class="asset-library-sidebar"><div class="asset-tree-title">
          <div><b>资产层级</b><span>先选库，再选分组</span></div></div>
          <button class="asset-sidebar-rail">资产库类目</button></div>
      </div>
      <div class="prompt-library-window liquid-surface-active" id="prompt">
        <div class="liquid-glass-mount"><div class="liquid-react-layer"><span></span></div></div>
        <div class="liquid-backdrop" style="--liquid-refraction:url('#fixture')"></div>
        <button class="prompt-sidebar-rail">分类</button>
      </div>
      <button class="panel-restore show" id="restorePanel"><span>展开实时面板</span></button>
      <div id="ordinary"><div class="liquid-backdrop" style="--liquid-refraction:url('#fixture')"></div></div>
      <div class="asset-main-head" id="statusHead"><div><h2>资产库</h2><p>53 个素材</p></div>
        <div class="asset-main-actions"><div class="asset-drop-status" id="assetDropStatus"></div></div>
      </div>
      <aside class="sidebar liquid-surface-active" id="sidebar">
        <div class="liquid-backdrop" style="--liquid-refraction:url('#fixture')"></div>
        <div class="nav-stack"><button class="nav"><span class="nav-icon"></span><span class="nav-label">首页生成</span></button></div>
      </aside>
      </body></html>`);
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--liquid-blur', '10px');
      document.documentElement.style.setProperty('--liquid-saturation', '140%');
    });
    for (const theme of ['light', 'dark']) {
      for (const mode of ['board', 'none']) {
        for (const library of ['asset', 'prompt']) {
          await page.evaluate(({theme, mode, library}) => {
            document.body.className = `standalone-library standalone-${library} liquid-glass-enabled ${theme === 'dark' ? 'theme-dark' : ''}`;
            document.body.dataset.backgroundMode = mode;
          }, {theme, mode, library});
          const result = await page.evaluate(library => {
            const host = document.getElementById(library);
            const backdrop = getComputedStyle(host.querySelector('.liquid-backdrop'));
            const highlight = getComputedStyle(host.querySelector('.liquid-react-layer > span'));
            const title = getComputedStyle(document.querySelector('.asset-tree-title b'));
            const subtitle = getComputedStyle(document.querySelector('.asset-tree-title span'));
            return {filter: backdrop.backdropFilter, opacity: highlight.opacity, title: title.color, subtitle: subtitle.color};
          }, library);
          assert.match(result.filter, /blur\(/);
          assert.doesNotMatch(result.filter, /url\(/);
          assert.equal(result.opacity, '0');
          assert.equal(result.title, theme === 'dark' ? 'rgb(245, 245, 247)' : 'rgb(17, 18, 20)');
          assert.notEqual(result.subtitle, result.title);
        }
      }
    }
    await page.evaluate(() => {
      document.body.className = 'desktop-shell liquid-glass-enabled theme-dark';
      document.body.dataset.backgroundMode = 'none';
    });
    const button = page.locator('#restorePanel');
    const box = await button.boundingBox();
    assert.ok(Math.abs(box.x + box.width - 1180) < 1, 'Restore button touches the right edge');
    await button.hover();
    const hover = await button.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return {right: rect.right, width: rect.width, hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === el || el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)), filter: getComputedStyle(el).backdropFilter};
    });
    assert.ok(Math.abs(hover.right - 1180) < 1);
    assert.equal(hover.width, box.width);
    assert.equal(hover.hit, true);
    assert.match(hover.filter, /blur\(/);
    await button.evaluate(el => el.addEventListener('click', () => el.dataset.clicked = 'yes'));
    await button.click();
    assert.equal(await button.getAttribute('data-clicked'), 'yes');
    assert.match(await page.locator('#ordinary > .liquid-backdrop').evaluate(el => getComputedStyle(el).backdropFilter), /url\(/, 'Other glass retains lens optics');
    const statusTexts = ['拖入文件到右侧任意位置即可上传', '共享资产为只读，只能查看、下载、复制资产和使用', '请先新建或选择一个资产库'];
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => {
        document.body.className = `desktop-shell liquid-glass-enabled ${theme === 'dark' ? 'theme-dark' : ''}`;
        document.body.dataset.backgroundMode = 'none';
      }, theme);
      for (const width of [720, 250]) {
        await page.locator('#statusHead').evaluate((el, width) => el.style.width = width + 'px', width);
        for (const text of statusTexts) {
          await page.locator('#assetDropStatus').evaluate((el, text) => el.textContent = text, text);
          const status = await page.locator('#assetDropStatus').evaluate(el => {
            const style = getComputedStyle(el), rect = el.getBoundingClientRect();
            const parent = el.closest('.asset-main-head').getBoundingClientRect();
            return {color: style.color, background: style.backgroundColor, filter: style.backdropFilter,
              fits: rect.left >= parent.left && rect.right <= parent.right && rect.bottom <= parent.bottom && el.scrollWidth <= el.clientWidth};
          });
          assert.equal(status.color, theme === 'dark' ? 'rgb(238, 242, 246)' : 'rgb(38, 52, 64)');
          assert.match(status.background, /0\.(82|86)\)/);
          assert.match(status.filter, /blur\(/);
          assert.equal(status.fits, true, `${theme} ${width}px status remains inside its heading`);
        }
      }
      const sidebar = page.locator('#sidebar');
      await page.mouse.move(800, 100);
      assert.match(await sidebar.locator('.liquid-backdrop').evaluate(el => getComputedStyle(el).backdropFilter), /url\(/, 'Collapsed sidebar keeps refraction');
      await sidebar.hover();
      const expanded = await sidebar.locator('.liquid-backdrop').evaluate(el => {
        const style = getComputedStyle(el);
        return {filter: style.backdropFilter, background: style.backgroundColor};
      });
      assert.match(expanded.filter, /blur\(/);
      assert.doesNotMatch(expanded.filter, /url\(/, 'Expanded sidebar does not refract text behind it');
      assert.match(expanded.background, /0\.94\)/);
    }
    console.log('Library title colors, neutral window edges and edge buttons passed.');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
