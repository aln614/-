const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

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
assertIncludes('attempt_id', 'Updater attempts are not tracked independently.');
assertIncludes('last_progress_at', 'Updater does not track the last real download progress.');
assertIncludes('beginSoftwareUpdateAttempt', 'Updater does not reset runtime fields for a fresh update attempt.');
assertIncludes('isLiveSoftwareUpdateRuntime', 'Updater does not distinguish the current process from persisted runtime state.');
assertIncludes('recoverInterruptedSoftwareUpdateRuntime', 'Interrupted updater state is not recovered after restart.');
assertIncludes('SOFTWARE_UPDATE_STALLED_DOWNLOAD_TIMEOUT_MS', 'Updater stalled-download watchdog is missing.');

const statusStart = source.indexOf('function getSoftwareUpdateStatus');
const statusEnd = source.indexOf('\nfunction httpJson', statusStart);
const statusSource = source.slice(statusStart, statusEnd);
if (!statusSource.includes('if (isLiveSoftwareUpdateRuntime())')) throw new Error('Persisted updater state can still be treated as a live download.');
if (!statusSource.includes('runtime.last_progress_at')) throw new Error('Update watchdog does not use a real progress timestamp.');
if (!statusSource.includes('recoverInterruptedSoftwareUpdateRuntime(runtime)')) throw new Error('Stale persisted download states are not converted to a recoverable result.');

const runtimeStart = source.indexOf('let softwareUpdateRuntime = {');
const runtimeEnd = source.indexOf('\nfunction httpJson', runtimeStart);
if (runtimeStart < 0 || runtimeEnd < 0) throw new Error('Updater runtime block is missing.');
let fakeNow = Date.parse('2026-08-10T08:00:00.000Z');
let persistedConfig = {
  update_runtime: {
    state: 'downloading',
    attempt_id: 'interrupted-attempt',
    started_at: '2026-08-10T06:00:00.000Z',
    updated_at: '2026-08-10T06:00:00.000Z',
    bytes: 0,
    total: 81600000,
    progress: 0
  },
  update_last_check: { latest_version: '1.0.68' }
};
const runtimeSandbox = {
  crypto,
  Date: class MockDate extends Date {
    constructor(...args) { super(args.length ? args[0] : fakeNow); }
    static now() { return fakeNow; }
    static parse(value) { return Date.parse(value); }
  },
  nowISO: () => new Date(fakeNow).toISOString(),
  readConfig: () => persistedConfig,
  saveConfig: patch => { persistedConfig = { ...persistedConfig, ...patch }; },
  Math,
  Number,
  String,
  Set
};
vm.createContext(runtimeSandbox);
vm.runInContext(`${source.slice(runtimeStart, runtimeEnd)}\nstaleUpdateStatus = getSoftwareUpdateStatus();\nfreshUpdateRuntime = beginSoftwareUpdateAttempt('aln614/-');\nsoftwareUpdateRuntime = { ...softwareUpdateRuntime, state:'downloading' };\nfreshUpdateStatus = getSoftwareUpdateStatus();`, runtimeSandbox);
if (runtimeSandbox.staleUpdateStatus.state !== 'failed') throw new Error('An interrupted persisted update is not recovered on the next launch.');
if (runtimeSandbox.freshUpdateStatus.state !== 'downloading') throw new Error('A fresh update attempt does not own its live runtime state.');
if (runtimeSandbox.freshUpdateStatus.attempt_id === 'interrupted-attempt') throw new Error('A fresh update attempt reused stale persisted timing.');

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
