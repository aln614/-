const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'static', 'style.css'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/function recentUploadStorageMeta\(/.test(main), 'Recent uploads need a server-side storage resolver');
assert(/runtimeMirrorDir\(cfg\)[\s\S]{0,600}recent_uploads/.test(main), 'Recent uploads must use the configured output runtime directory');
assert(/listRecentUploads\(deviceOwner, cfg\)/.test(main) && /receiveRecentUpload\(req, parsed, deviceOwner, cfg\)/.test(main), 'Recent upload routes must be scoped to the current device owner');
assert(/receiveRecentUpload\([\s\S]{0,1600}pipeline\(req, limiter/.test(main), 'Recent uploads must stream source files to disk');
assert(/\/api\/recent_uploads\/source/.test(main), 'Recent upload source endpoint is missing');
assert(/trimRecentUploadIndex\(/.test(main), 'Recent upload FIFO trimming is missing');
assert(!/openRecentUploadDb|RECENT_UPLOAD_DB_NAME|RECENT_UPLOAD_STORE/.test(app), 'Recent uploads must not retain the old IndexedDB implementation');
assert(/cacheRecentVideoUploadedFiles\(/.test(app), 'Video and audio uploads must be cached for reuse');
assert(/handleVideoFile\(files, options=\{\}\)/.test(app), 'Video restore must be able to skip recaching itself');
assert(/addRecentVideoUploadToInputs\(/.test(app), 'Recent video panel must restore a source file into the editor');
assert(/id="recentVideoUploadPanel"/.test(html), 'Video editor recent-upload panel is missing');
assert(/id="recentVideoUploadVideos"/.test(html) && /id="recentVideoUploadAudios"/.test(html) && /id="recentVideoUploadReferences"/.test(html), 'All three recent media lanes are required');
assert(/\.recent-video-upload-panel\{/.test(css), 'Recent video upload panel needs its CSS');

console.log('[verify-recent-upload-cache] OK: output-directory cache and video/audio/reference reuse panel are wired.');
