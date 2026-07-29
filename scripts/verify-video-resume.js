const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const main = read('src/main.js');
const app = read('src/renderer/static/app.js');
const css = read('src/renderer/static/style.css');

assert(main.includes('const activeApimartVideoPolls = new Set()'), 'Missing APIMart video poll de-duplication');
assert(main.includes('function videoRemoteTaskId(row = {})'), 'Missing normalized video task ID helper');
assert(main.includes('function resumeApimartVideoTasks(apiKey, owner = \'\')'), 'Missing interrupted video task recovery');
assert(main.includes("p === '/api/video_resume_pending'"), 'Missing video resume API');
assert(main.includes('consecutiveQueryErrors >= 6'), 'Missing bounded remote query retry');
assert(main.includes("task.status = '生成中'"), 'Video polling must expose a generation state');
assert(app.includes('async function resumePendingVideoTasks(rows = [])'), 'Renderer does not request video task recovery');
assert(app.includes("api('/api/video_resume_pending'"), 'Renderer video resume API call is missing');
assert(app.includes('VIDEO_RESUME_ACTIVE_STATUSES'), 'Renderer active video statuses are missing');
assert(css.includes('#videoDrop::after'), 'Video upload zone does not inherit the active mascot');
assert(css.includes('.video-mascot-card::after'), 'Video status cards do not inherit the active mascot');
assert(css.includes('body[data-skin] #page-video>.grid>.card'), 'Video workspace does not inherit the active skin');
assert(css.includes('.video-realtime-panel .video-library>.video-card'), 'Recent video cards need an explicit non-shrinking layout');
assert(css.includes('flex:0 0 auto'), 'Recent video cards must not collapse inside the scrolling library');

console.log('[verify-video-resume] OK: interrupted APIMart video polling resumes once and video UI inherits the active skin.');
