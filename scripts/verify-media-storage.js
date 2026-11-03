const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { uploadDirectory, previewDirectory, relocatedUploadPath, expendableDragFiles } = require('../src/services/mediaStorage');
const { rewriteValue, inside } = require('./migrate-media-storage');

const win = path.win32;
const data = 'C:\\profile\\runtime';
const output = '\\\\nas\\share\\TENYING_AI';
assert.equal(uploadDirectory({ output_dir: output }, data, 'local', win), `${output}\\\u8fd0\u884c\u6570\u636e\u76ee\u5f55\\uploads\\local`);
assert.equal(uploadDirectory({}, data, '../../other', win), `${data}\\uploads\\______other`);
assert.ok(previewDirectory({ output_dir: output }, data, win).startsWith(output));
assert.equal(relocatedUploadPath(`${data}\\uploads\\local\\one.png`, { output_dir: output }, data, win),
  `${output}\\\u8fd0\u884c\u6570\u636e\u76ee\u5f55\\uploads\\local\\one.png`);
assert.equal(relocatedUploadPath(`${data}\\uploads\\..\\config.json`, { output_dir: output }, data, win),
  `${data}\\uploads\\..\\config.json`);
assert.equal(relocatedUploadPath('C:\\outside\\one.png', { output_dir: output }, data, win), 'C:\\outside\\one.png');
const now = 100 * 24 * 60 * 60 * 1000;
const files = [
  { path: 'active', time: now - 1000, size: 100 },
  { path: 'old', time: now - 2 * 24 * 60 * 60 * 1000, size: 100 },
  { path: 'recent', time: now - 2 * 60 * 60 * 1000, size: 100 }
];
assert.deepEqual(expendableDragFiles(files, { now, maxBytes: 1000 }), ['old']);
assert.deepEqual(expendableDragFiles(files, { now, maxBytes: 50 }), ['old', 'recent']);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-storage-test-'));
try {
  const root = path.join(temp, 'LocalApiImageGenerator_RuntimeData_V1498');
  const old = path.join(temp, 'LocalApiImageGenerator_RuntimeData_V1458');
  const out = path.join(temp, 'output');
  const runtime = path.join(out, '\u8fd0\u884c\u6570\u636e\u76ee\u5f55');
  const work = path.join(runtime, 'migration');
  for (const dir of [path.join(root, 'uploads', 'local'), path.join(old, 'uploads', 'local'), out, path.join(root, 'data')]) fs.mkdirSync(dir, { recursive: true });
  const source = path.join(root, 'uploads', 'local', 'image.png');
  const oldSource = path.join(old, 'uploads', 'local', 'image.png');
  const missing = path.join(root, 'uploads', 'local', 'missing.png');
  fs.writeFileSync(source, Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(oldSource, Buffer.from([4, 5, 6, 7]));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ output_dir: out }));
  const original = { tasks: [{ main_image_path: source, ref_images_json: JSON.stringify([oldSource, missing]) }],
    url: '/api/file?path=' + encodeURIComponent(source), prompt: 'Keep this text unchanged' };
  fs.writeFileSync(path.join(root, 'data', 'store.json'), JSON.stringify(original));
  const run = mode => {
    const result = spawnSync(process.execPath, [__filename.replace('verify-media-storage.js', 'migrate-media-storage.js'), mode, root, work], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  run('copy');
  run('rewrite');
  run('audit');
  const result = JSON.parse(fs.readFileSync(path.join(root, 'data', 'store.json'), 'utf8'));
  assert.ok(result.tasks[0].main_image_path.startsWith(runtime));
  assert.deepEqual(fs.readFileSync(result.tasks[0].main_image_path), fs.readFileSync(source));
  const refs = JSON.parse(result.tasks[0].ref_images_json);
  assert.ok(refs[0].includes('legacy-v1458'));
  assert.deepEqual(fs.readFileSync(refs[0]), fs.readFileSync(oldSource));
  assert.equal(refs[1], missing);
  assert.equal(result.prompt, original.prompt);
  assert.equal(new URL(result.url, 'http://local').searchParams.get('path'), result.tasks[0].main_image_path);
  assert.ok(fs.existsSync(source), 'Migration must not delete sources');
  const mappings = [{ source: path.join(root, 'uploads'), destination: path.join(runtime, 'uploads') }];
  assert.equal(rewriteValue(`${root}/uploads-other/test.png`, mappings), `${root}/uploads-other/test.png`);
  assert.equal(inside(root, path.join(root, '..', 'other')), false);
  fs.writeFileSync(result.tasks[0].main_image_path, 'conflict');
  const conflict = spawnSync(process.execPath, [path.join(__dirname, 'migrate-media-storage.js'), 'copy', root, work], { encoding: 'utf8' });
  assert.notEqual(conflict.status, 0);
  assert.equal(fs.readFileSync(result.tasks[0].main_image_path, 'utf8'), 'conflict');
  if (process.argv.includes('--cleanup')) {
    fs.writeFileSync(result.tasks[0].main_image_path, fs.readFileSync(source));
    run('copy');
    run('audit');
    fs.mkdirSync(path.join(root, 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Cache', 'test'), 'cache');
    fs.mkdirSync(path.join(root, 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Local Storage', 'keep'), 'settings');
    const cleanup = spawnSync(process.env.TENYING_TEST_POWERSHELL || 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'cleanup-migrated-media.ps1'), '-MigrationDirectory', work], {
      encoding: 'utf8', env: { ...process.env, APPDATA: temp, LOCALAPPDATA: path.join(temp, 'local') }
    });
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(oldSource), false);
    assert.equal(fs.existsSync(path.join(root, 'Cache')), false);
    assert.equal(fs.readFileSync(path.join(root, 'Local Storage', 'keep'), 'utf8'), 'settings');
    assert.deepEqual(fs.readFileSync(result.tasks[0].main_image_path), Buffer.from([0, 1, 2, 3]));
    const cleaned = JSON.parse(fs.readFileSync(path.join(work, 'cleanup-report.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(cleaned.removedFiles, 2);
    assert.equal(cleaned.mediaBytes, 8);
    assert.equal(cleaned.cacheBytes, 5);
    assert.equal(cleaned.remainingUploadFiles, 0);
    console.log('Native PowerShell cleanup integration: verified source removal, destination and settings preserved');
  }
  const unavailable = uploadDirectory({ output_dir: path.join(temp, 'absent') }, root);
  assert.throws(() => fs.writeFileSync(path.join(unavailable, 'test.png'), 'test'));
  console.log('Media storage, verified migration, nested references, collision protection and cache expiry: OK');
} finally {
  if (!inside(os.tmpdir(), temp) || !path.basename(temp).startsWith('tenying-storage-test-')) throw new Error('Unsafe test cleanup path');
  fs.rmSync(temp, { recursive: true, force: true });
}
