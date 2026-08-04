const fs = require('fs');
const path = require('path');

const mainPath = path.join(__dirname, '..', 'src', 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');

function assertIncludes(fragment, message) {
  if (!source.includes(fragment)) throw new Error(message);
}

assertIncludes('function updateDownloadProxyCandidates', 'Update proxy candidate helper is missing.');
assertIncludes('add(cfg.apimart_proxy_url);', 'Updater does not reuse the configured network proxy.');
assertIncludes("'--continue-at', '-'", 'Updater no longer resumes partial EXE downloads.');
assertIncludes("'--speed-time'", 'Updater has no transfer idle protection.');
assertIncludes('timeoutMs: 30 * 60 * 1000', 'Updater total download timeout is too short.');
assertIncludes('idleTimeoutMs: 4 * 60 * 1000', 'Updater transfer idle timeout is too short.');
assertIncludes('reportSoftwareUpdateDownloadProgress', 'Updater progress persistence throttle is missing.');
assertIncludes('35 * 60 * 1000', 'Updater stale-download recovery timeout is too short.');

console.log('[verify-updater] OK: proxy-aware, resumable update download safeguards are wired.');
