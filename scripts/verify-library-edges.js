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
      </body></html>`);
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
    console.log('Library title colors, neutral window edges and edge buttons passed.');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
