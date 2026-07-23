const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const skinIds = ['starlight', 'cloud', 'sakura', 'academy', 'hangar', 'classic'];
const assets = [
  'anime-assistant-atlas.png',
  'mascot-cloud-atlas.png',
  'mascot-sakura-atlas.png',
  'mascot-academy-atlas.png',
  'mascot-hangar-atlas.png',
  'mascot-classic-atlas.png',
  ...skinIds.map((id) => `skin-${id}.png`)
];

const main = read('src/main.js');
const html = read('src/renderer/index.html');
const app = read('src/renderer/static/app.js');
const css = read('src/renderer/static/style.css');

for (const id of skinIds) {
  assert(html.includes(`data-skin="${id}"`), `Missing skin card: ${id}`);
  assert(app.includes(`'${id}'`), `Missing renderer skin registration: ${id}`);
  assert(css.includes(`body[data-skin="${id}"]`), `Missing skin styles: ${id}`);
}

for (const asset of assets) {
  const file = path.join(root, 'src', 'renderer', 'static', 'assets', 'skins', asset);
  assert(fs.existsSync(file), `Missing skin asset: ${asset}`);
  assert(fs.statSync(file).size > 1024, `Skin asset is unexpectedly small: ${asset}`);
}

assert(main.includes("skin_id: 'classic'"), 'Missing default skin configuration');
assert(main.includes('mascot_enabled: true'), 'Missing default mascot configuration');
assert(app.includes('applySkinSettings'), 'Missing skin application logic');
assert(app.includes('persistAppearanceSettings'), 'Missing skin persistence logic');
assert(html.includes('id="themeSkinGrid"'), 'Missing skin selector');
assert(html.includes('id="themeMascotEnabled"'), 'Missing mascot switch');
assert(css.includes('*::-webkit-scrollbar{width:4px!important;height:4px!important'), 'Missing global slim scrollbar rule');
assert(css.includes('*::-webkit-scrollbar-button{display:none!important'), 'Scrollbar buttons must remain hidden');
assert(css.includes("--skin-atlas:url('/static/assets/skins/mascot-cloud-atlas.png')"), 'Cloud skin must use its own mascot atlas');

console.log('Skin system verification passed.');
