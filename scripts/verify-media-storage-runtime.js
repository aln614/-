const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');
const { uploadDirectory } = require('../src/services/mediaStorage');
const { inside } = require('./migrate-media-storage');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-storage-runtime-'));
  const data = path.join(temp, 'profile');
  const out = path.join(temp, 'output');
  fs.mkdirSync(path.join(data, 'data'), { recursive: true });
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(data, 'data', 'skip_legacy_restore.json'), '{}');
  const portServer = net.createServer().listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const config = { port, output_dir: out, asset_library_dir: path.join(out, 'assets'),
    api_key: '', public_enabled: false, lan_enabled: true, update_auto_check: false };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  const videoFile = path.join(out, 'range-test.mp4');
  fs.writeFileSync(videoFile, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  fs.writeFileSync(path.join(data, 'data', 'store.json'), JSON.stringify({
    batches: [], tasks: [], images: [], logs: [], prompt_groups: [], prompt_templates: [],
    public_videos: [], video_tasks: [{ id: 'storage-video-test', owner_id: 'local',
      status: '\u5df2\u5b8c\u6210', file_path: videoFile, created_at: new Date().toISOString() }]
  }));
  const child = spawn(require('electron'), [path.resolve(__dirname, '..')], {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, LAIG_SERVER_ONLY: '1', LOCAL_API_IMAGE_GENERATOR_DATA_DIR: data, TENYING_AI_LOCAL_HOT_CACHE_DIR: path.join(temp, 'hot') }
  });
  const exited = once(child, 'exit');
  const base = `http://127.0.0.1:${port}`;
  const get = (url, options = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(10000) });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await get('/api/health')).ok) { ready = true; break; } } catch {}
      if (child.exitCode !== null) throw new Error(`Test host exited ${child.exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready, 'Isolated host did not start');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDAAAAABJRU5ErkJggg==', 'base64');
    const response = await get('/api/batch_media_upload?name=storage-smoke.png', {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png
    });
    const uploaded = await response.json();
    assert.ok(uploaded.ok, uploaded.error);
    const file = path.join(uploadDirectory(config, data, 'local'), uploaded.upload_id);
    assert.deepEqual(fs.readFileSync(file), png);
    assert.equal(fs.existsSync(path.join(data, 'uploads')), false);
    const legacy = path.join(data, 'uploads', 'local', uploaded.upload_id);
    const served = await get('/file?path=' + encodeURIComponent(legacy));
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
    const status = await (await get('/api/media_cache_status?path=' + encodeURIComponent(file))).json();
    assert.equal(status.ready, true, 'Direct output media must not wait for a disabled local cache');
    assert.equal(status.storage, 'output');
    assert.equal(fs.readdirSync(path.join(temp, 'hot', 'media')).length, 0);
    const preview = await get('/preview-image?path=' + encodeURIComponent(file));
    assert.equal(preview.status, 200);
    await preview.arrayBuffer();
    const previewRoot = path.join(out, '\u8fd0\u884c\u6570\u636e\u76ee\u5f55', 'cache', 'preview_images');
    assert.ok(fs.readdirSync(previewRoot).some(name => name.endsWith('.png')));
    const videos = await (await get('/api/video_tasks')).json();
    assert.equal(videos.rows[0].video_cache_ready, true);
    const range = await get('/video-file?id=storage-video-test', { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.from([2, 3, 4, 5]));
    assert.equal(fs.readdirSync(path.join(temp, 'hot', 'media')).length, 0);
    // Make the configured output unwritable; an upload must fail, not fall back.
    fs.renameSync(out, out + '-saved');
    fs.writeFileSync(out, 'not a directory');
    const failed = await get('/api/batch_media_upload?name=offline.png', {
      method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png
    });
    assert.equal(failed.status, 500);
    assert.equal(fs.existsSync(path.join(data, 'uploads')), false);
    console.log('Runtime smoke: NAS-style output layout, binary upload, old links, immediate preview readiness and no silent fallback: OK (no model requests)');
  } finally {
    child.kill();
    await exited;
    if (!inside(os.tmpdir(), temp) || !path.basename(temp).startsWith('tenying-storage-runtime-')) throw new Error('Unsafe test cleanup');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
