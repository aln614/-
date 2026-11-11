'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createIcnsFromIco} = require('./create-macos-icon');

const root = path.join(__dirname, '..');
const icon = createIcnsFromIco(fs.readFileSync(path.join(root, 'assets', 'rocket.ico')));
assert.equal(icon.toString('ascii', 0, 4), 'icns');
assert.equal(icon.readUInt32BE(4), icon.length);
const icnsTypes = new Set();
for (let offset = 8; offset < icon.length;) {
  const type = icon.toString('ascii', offset, offset + 4);
  const size = icon.readUInt32BE(offset + 4);
  assert.ok(size >= 16 && offset + size <= icon.length, `Invalid ICNS chunk: ${type}`);
  assert.deepEqual([...icon.subarray(offset + 8, offset + 16)], [137, 80, 78, 71, 13, 10, 26, 10]);
  icnsTypes.add(type);
  offset += size;
}
for (const type of ['icp4','icp5','icp6','ic07','ic08']) assert.ok(icnsTypes.has(type), `Missing macOS icon size: ${type}`);

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.build.mac.icon, 'build/rocket.icns');
assert.deepEqual(packageJson.build.mac.target, ['dmg','zip']);
assert.equal(packageJson.build.mac.identity, null);
assert.equal(packageJson.build.mac.hardenedRuntime, false);
assert.equal(packageJson.build.mac.notarize, false);

const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
assert.ok(mainSource.includes("app.getPath('appData')"), 'macOS application data directory is missing.');
assert.ok(mainSource.includes("app.getPath('cache')"), 'macOS cache directory is missing.');
assert.ok(mainSource.includes("'/usr/bin/sips'"), 'macOS preview generation is missing.');
const pickerStart = mainSource.indexOf('function pickSoftwareUpdateAsset');
const pickerEnd = mainSource.indexOf('\nasync function checkSoftwareUpdate', pickerStart);
assert.ok(pickerStart >= 0 && pickerEnd > pickerStart, 'Platform-aware update asset picker is missing.');
const context = vm.createContext({path, process:{platform:'darwin',arch:'arm64'}, String, Number, Array, RegExp});
vm.runInContext(`${mainSource.slice(pickerStart, pickerEnd)}\nthis.pickAsset = pickSoftwareUpdateAsset;`, context);
const release = {assets:[
  {name:'TENYING_AI-1.0.149-mac-arm64.dmg',state:'uploaded',size:10},
  {name:'TENYING_AI-1.0.149-mac-x64.dmg',state:'uploaded',size:10},
  {name:'TENYING_AI-1.0.149-mac-arm64.zip',state:'uploaded',size:10},
  {name:'TENYING_AI-1.0.149-win-x64.exe',state:'uploaded',size:10}
]};
assert.equal(context.pickAsset(release,'darwin','arm64').name,'TENYING_AI-1.0.149-mac-arm64.dmg');
assert.equal(context.pickAsset(release,'darwin','x64').name,'TENYING_AI-1.0.149-mac-x64.dmg');
assert.equal(context.pickAsset(release,'linux','x64'),null);

const workflow = fs.readFileSync(path.join(root,'.github','workflows','release.yml'),'utf8');
for (const expected of ['macos-15','macos-15-intel','arch: arm64','arch: x64','prepare-release','release: v','publish-release','merge-multiple: true']) {
  assert.ok(workflow.includes(expected), `Release workflow is missing ${expected}`);
}

const renderer = fs.readFileSync(path.join(root,'src','renderer','static','app.js'),'utf8');
assert.ok(renderer.includes('下载 macOS 安装包'));
assert.ok(renderer.includes("url.hostname !== 'github.com'"));
assert.ok(renderer.includes('handleSoftwareUpdateAction'));

console.log('macOS release checks passed: ICO-to-ICNS conversion, arm64/x64 DMG selection, manual install flow and cross-platform release workflow.');
