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
assert(/video_limit[\s\S]{0,180}audio_limit[\s\S]{0,220}reference_image_limit/.test(main), 'Recent upload settings must retain independent video, audio, and reference-image limits');
assert(/Number\.MAX_SAFE_INTEGER/.test(main) && /Number\.isSafeInteger\(value\)/.test(main), 'Recent upload cache limits must accept any positive safe integer');
assert(!/openRecentUploadDb|RECENT_UPLOAD_DB_NAME|RECENT_UPLOAD_STORE/.test(app), 'Recent uploads must not retain the old IndexedDB implementation');
assert(/cacheRecentVideoUploadedFiles\(/.test(app), 'Video and audio uploads must be cached for reuse');
assert(/handleVideoFile\(files, options=\{\}\)/.test(app), 'Video restore must be able to skip recaching itself');
assert(/function recentUploadDragPayload\(/.test(app) && /application\/x-laig-recent-upload/.test(app), 'Recent uploads need an internal drag payload');
assert(/function setRecentUploadDragData\([\s\S]{0,900}setImageDragData\(event, \{ fullUrl:source, filename:name, skipNativeDrag:true \}\)/.test(app), 'Recent uploaded images must drag their original source rather than a thumbnail');
assert(/function handleRecentUploadDrop\([\s\S]{0,2600}handleVideoFile\(\[await recentUploadFileFromRow\(row\)\], \{cache:false\}\)/.test(app), 'Recent video and audio drops must restore the original file without recaching');
assert(/handleVideoRefs\(\[await recentUploadFileFromRow\(row\)\], \{cache:false, silent:true\}\)/.test(app), 'Recent reference-image drops must restore the original file without recaching');
assert(/handleRecentUploadDrop\(e, target\)[\s\S]{0,160}handleGeneratedImageDrop\(e, target\)/.test(app), 'Image upload zones must accept recent-upload drag payloads before generic image drops');
assert(/target === 'video_ref'[\s\S]{0,160}handleGeneratedImageDrop\(e, target\)/.test(app), 'Video reference zones must accept dragged recent and generated images');
assert(/addRecentVideoUploadToInputs\(/.test(app), 'Recent video panel must restore a source file into the editor');
assert(/openRecentVideoUploadSettings\(/.test(app) && /saveRecentVideoUploadSettings\(/.test(app), 'Video recent-upload settings must be configurable');
assert(/previewRecentUploadImage\([\s\S]{0,500}showPreview\(/.test(app), 'Recent uploaded images must support single-click preview');
assert(/grid\.addEventListener\('dblclick',[\s\S]{0,400}addRecentUploadAsMain/.test(app), 'Recent uploaded images must add to the main image list on double-click');
assert(/grid\.addEventListener\('contextmenu',[\s\S]{0,360}registerRecentUploadReferenceClick/.test(app) && /function addRecentUploadAsReference\(/.test(app), 'Recent uploaded images must add to reference images on a right-button double-click');
assert(/function addPendingRecentUploadItem\([\s\S]{0,700}URL\.createObjectURL/.test(app) && /cacheRecentMediaFiles\([\s\S]{0,340}addPendingRecentUploadItem/.test(app), 'Recent uploaded images must render an immediate local preview while their cache write finishes');
assert(/loading="eager" fetchpriority="high"/.test(app), 'Recent uploaded image previews must not be delayed by lazy loading');
assert(/refreshAll\(options = \{\}\)[\s\S]{0,1800}options\.forceBatches/.test(app) && /realtimeRefresh = \{immediate:true, forceBatches:true\}/.test(app), 'A submitted batch must trigger an immediate realtime refresh');
assert(/STATUS_CACHE_TTL_MS = 650/.test(main) && /function invalidateAppStatsCache\(/.test(main) && /queue\.createBatch\(mapped\.payload, mapped\.cfg\);\s*invalidateAppStatsCache\(deviceOwner\)/.test(main), 'A submitted batch must invalidate stale realtime status data');
assert(/function showRecentAudioPreview\(/.test(app) && /function closeRecentAudioPreview\(/.test(app), 'Recent uploaded audio needs a dedicated single-click preview');
assert(/row\.kind === 'audio'[\s\S]{0,160}showRecentAudioPreview\(/.test(app), 'Recent audio must open the audio player rather than being added on a single click');
assert(/videoPanel\.addEventListener\('dblclick',[\s\S]{0,360}addRecentVideoUploadToInputs/.test(app) && /if\(row\.kind === 'reference_image'\)[\s\S]{0,160}else await handleVideoFile\(\[file\], \{cache:false\}\)/.test(app), 'Recent audio must only be attached to the task through the double-click restore flow');
assert(/id="recentVideoUploadPanel"/.test(html), 'Video editor recent-upload panel is missing');
assert(/id="recentVideoUploadVideos"/.test(html) && /id="recentVideoUploadAudios"/.test(html) && /id="recentVideoUploadReferences"/.test(html), 'All three recent media lanes are required');
assert(/id="recentVideoUploadSettingsBtn"/.test(html) && /id="recentVideoUploadSettingsModal"/.test(html), 'Video recent-upload settings UI is missing');
assert(/id="recentAudioPreviewModal"/.test(html) && /id="recentAudioPreviewPlayer"/.test(html), 'Recent audio preview modal is missing');
assert(!/id="recentUploadLimitInput"[^>]*max=/.test(html) && !/id="recentVideoUploadLimitInput"[^>]*max=/.test(html), 'Recent-upload cache limits must not have an artificial maximum');
assert(/\.recent-video-upload-panel\{/.test(css), 'Recent video upload panel needs its CSS');
assert(/\.recent-upload-item\[draggable="true"\],\.recent-video-upload-item\[draggable="true"\]/.test(css), 'Recent upload cards need visible drag affordances');
assert(/\.recent-audio-preview-card\{/.test(css) && /\.recent-audio-preview-head\{/.test(css), 'Recent audio preview modal needs its CSS');
assert(/#mainThumbs \.thumb,[\s\S]{0,180}object-fit:contain!important/.test(css), 'Uploaded image thumbnails must use contain sizing rather than cropping');

console.log('[verify-recent-upload-cache] OK: output-directory cache and video/audio/reference reuse panel are wired.');
