const fs = require('fs');
const path = require('path');

const mainPath = path.join(__dirname, '..', 'src', 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const rendererPath = path.join(__dirname, '..', 'src', 'renderer', 'static', 'app.js');
const rendererSource = fs.readFileSync(rendererPath, 'utf8');
const indexPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const indexSource = fs.readFileSync(indexPath, 'utf8');

function assertIncludes(fragment, message) {
  if (!source.includes(fragment)) throw new Error(message);
}

function assertRendererIncludes(fragment, message) {
  if (!rendererSource.includes(fragment)) throw new Error(message);
}

function assertIndexIncludes(fragment, message) {
  if (!indexSource.includes(fragment)) throw new Error(message);
}

assertIncludes('function updateDownloadProxyCandidates', 'Update proxy candidate helper is missing.');
assertIncludes('add(cfg.apimart_proxy_url);', 'Updater does not reuse the configured network proxy.');
assertIncludes("'--continue-at', '-'", 'Updater no longer resumes partial EXE downloads.');
assertIncludes("'--speed-time'", 'Updater has no transfer idle protection.');
assertIncludes('timeoutMs: 30 * 60 * 1000', 'Updater total download timeout is too short.');
assertIncludes('idleTimeoutMs: 4 * 60 * 1000', 'Updater transfer idle timeout is too short.');
assertIncludes('reportSoftwareUpdateDownloadProgress', 'Updater progress persistence throttle is missing.');
assertIncludes('35 * 60 * 1000', 'Updater stale-download recovery timeout is too short.');
assertIncludes('update_auto_check: true', 'Startup update check setting default is missing.');
assertIncludes('SOFTWARE_UPDATE_ACTIVE_STATES', 'Updater active-state tracking is missing.');
assertIncludes('reconcileSoftwareUpdateAfterRestart', 'Updater restart reconciliation is missing.');

const installStart = source.indexOf('function installSoftwareUpdate');
const installEnd = source.indexOf('function reconcileSoftwareUpdateAfterRestart', installStart);
const installSource = source.slice(installStart, installEnd);
if (!installSource.includes("spawn('wscript.exe', ['//B', '//NoLogo'")) throw new Error('Silent VBS update launcher is missing.');
if (!installSource.includes('isAppQuitting = true;')) throw new Error('Updater does not bypass the tray close handler before quitting.');
if (installSource.includes("spawn('cmd.exe'") || installSource.includes('.bat')) throw new Error('Legacy visible cmd/batch updater path is still present.');

assertRendererIncludes('softwareUpdateProgress', 'Renderer update progress UI is missing.');
assertRendererIncludes('scheduleStartupSoftwareUpdateCheck', 'Startup update check scheduler is missing.');
assertRendererIncludes('softwareUpdateActionLabel', 'Updater stage-specific button labels are missing.');
assertIndexIncludes('id="updateAutoCheck"', 'Settings auto-check checkbox is missing.');
assertIndexIncludes('id="softwareUpdateProgress"', 'Update progress markup is missing from the main document.');

console.log('[verify-updater] OK: updater supports proxy-aware resumable downloads, visible progress, silent replacement, restart recovery, and startup auto-check control.');
