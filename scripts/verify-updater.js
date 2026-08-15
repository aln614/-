const fs = require('fs');
const path = require('path');
const os = require('os');
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
assertIncludes('function parseSoftwareUpdateRuntimeTimestamp', 'Updater timezone-safe timestamp parser is missing.');
assertIncludes("'--continue-at', '-'", 'Updater no longer resumes partial EXE downloads.');
assertIncludes("'--speed-time'", 'Updater has no transfer idle protection.');
assertIncludes("'--noproxy', '*'", 'Direct GitHub updater route can still inherit an unrelated system proxy.');
assertIncludes('timeoutMs: 30 * 60 * 1000', 'Updater total download timeout is too short.');
assertIncludes('idleTimeoutMs: 75 * 1000', 'Updater should fail over quickly when a route receives no bytes.');
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
if (!statusSource.includes('parseSoftwareUpdateRuntimeTimestamp')) throw new Error('Update watchdog parses old timezone-less timestamps as local time.');

const parserStart = source.indexOf('function parseSoftwareUpdateRuntimeTimestamp');
const parserEnd = source.indexOf('\nfunction getSoftwareUpdateStatus', parserStart);
if (parserStart < 0 || parserEnd < 0) throw new Error('Updater runtime timestamp parser block is missing.');
const parserSandbox = { Date };
vm.createContext(parserSandbox);
vm.runInContext(`${source.slice(parserStart, parserEnd)}\nparsedLegacyRuntimeTime = parseSoftwareUpdateRuntimeTimestamp('2026-08-10 08:00:00');`, parserSandbox);
if (parserSandbox.parsedLegacyRuntimeTime !== Date.parse('2026-08-10T08:00:00.000Z')) {
  throw new Error('Timezone-less updater timestamps are not interpreted as UTC.');
}

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
vm.runInContext(`${source.slice(runtimeStart, runtimeEnd)}\nstaleUpdateStatus = getSoftwareUpdateStatus();\nfreshUpdateRuntime = beginSoftwareUpdateAttempt('aln614/-');\nsoftwareUpdateRuntime = { ...softwareUpdateRuntime, state:'downloading' };\nfreshUpdateStatus = getSoftwareUpdateStatus();\nsoftwareUpdateRuntime = { ...softwareUpdateRuntime, state:'downloading', started_at:'2026-08-10 08:00:00', last_progress_at:'2026-08-10 08:00:00' };\nlegacyTimestampStatus = getSoftwareUpdateStatus();`, runtimeSandbox);
if (runtimeSandbox.staleUpdateStatus.state !== 'failed') throw new Error('An interrupted persisted update is not recovered on the next launch.');
if (runtimeSandbox.freshUpdateStatus.state !== 'downloading') throw new Error('A fresh update attempt does not own its live runtime state.');
if (runtimeSandbox.freshUpdateStatus.attempt_id === 'interrupted-attempt') throw new Error('A fresh update attempt reused stale persisted timing.');
if (runtimeSandbox.legacyTimestampStatus.state !== 'downloading') throw new Error('A fresh timezone-less updater timestamp is incorrectly treated as expired.');

const proxyStart = source.indexOf('function updateDownloadProxyCandidates');
const proxyEnd = source.indexOf('\nfunction batchMediaUploadDir', proxyStart);
const proxySource = source.slice(proxyStart, proxyEnd);
if (proxySource.includes('lastGoodApimartProxy')) throw new Error('Updater incorrectly prioritizes the last APIMart API proxy.');
if (proxySource.indexOf("candidates.push('');") > proxySource.indexOf('add(cfg.update_proxy_url);')) {
  throw new Error('Updater should attempt direct GitHub download before an optional update proxy.');
}
if (proxySource.indexOf('add(cfg.apimart_proxy_url);') < proxySource.indexOf('add(process.env.HTTP_PROXY);')) {
  throw new Error('APIMart proxy must only be a final GitHub download fallback.');
}

const installStart = source.indexOf('function installSoftwareUpdate');
const installEnd = source.indexOf('function reconcileSoftwareUpdateAfterRestart', installStart);
const installSource = source.slice(installStart, installEnd);
const targetStart = source.indexOf('function softwareUpdateTemporaryRoots');
const targetEnd = source.indexOf('\nfunction installSoftwareUpdate', targetStart);
if (targetStart < 0 || targetEnd < 0) throw new Error('Persistent updater install-target resolver is missing.');
const targetSandbox = {
  os: { tmpdir: () => 'C:\\Temp' },
  path,
  process: { platform: process.platform, env: {}, execPath: 'C:\\Temp\\TENYING_AI.exe' },
  app: { getPath: () => 'C:\\Temp' },
  fs: { existsSync: value => /(?:Apps|Program Files)\\TENYING_AI\.exe$/i.test(String(value || '')), readdirSync: () => [], rmSync: () => {} },
  String,
  Array,
  Set
};
vm.createContext(targetSandbox);
vm.runInContext(`${source.slice(targetStart, targetEnd)}\nportableInstallTarget = resolveSoftwareUpdateInstallTarget({ portableExecutable:'C:\\\\Apps\\\\TENYING_AI.exe', runningExecutable:'C:\\\\Temp\\\\TENYING_AI.exe', tempRoots:['C:\\\\Temp'], exists:value => /Apps/.test(value) });\ntempOnlyInstallTarget = resolveSoftwareUpdateInstallTarget({ portableExecutable:'', runningExecutable:'C:\\\\Temp\\\\TENYING_AI.exe', tempRoots:['C:\\\\Temp'], exists:() => true });`, targetSandbox);
if (!/Apps\\TENYING_AI\.exe$/i.test(String(targetSandbox.portableInstallTarget?.path || ''))) throw new Error('Updater does not prefer the original portable launcher EXE.');
if (targetSandbox.tempOnlyInstallTarget?.path) throw new Error('Updater can still overwrite a temporary extraction EXE.');
const cleanupTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-updater-cleanup-'));
try {
  const downloadedPath = path.join(cleanupTestDir, 'TENYING_AI-1.0.72-win-x64.exe');
  const backupPath = path.join(cleanupTestDir, 'backup_previous_TENYING_AI.exe');
  const legacyBackupPath = path.join(cleanupTestDir, 'backup_legacy_TENYING_AI.exe');
  fs.writeFileSync(downloadedPath, 'downloaded');
  fs.writeFileSync(backupPath, 'backup');
  fs.writeFileSync(legacyBackupPath, 'legacy backup');
  const cleanupSandbox = {
    os,
    path,
    process: { platform: process.platform, env: {}, execPath: '' },
    app: { getPath: () => os.tmpdir() },
    fs,
    updateCacheDir: () => cleanupTestDir,
    String,
    Array,
    Set
  };
  cleanupSandbox.downloadedPath = downloadedPath;
  cleanupSandbox.backupPath = backupPath;
  vm.createContext(cleanupSandbox);
  vm.runInContext(`${source.slice(targetStart, targetEnd)}\ncleanupCount = cleanupCompletedSoftwareUpdateArtifacts({ downloaded_path:downloadedPath, backup_path:backupPath });`, cleanupSandbox);
  if (cleanupSandbox.cleanupCount !== 3 || fs.existsSync(downloadedPath) || fs.existsSync(backupPath) || fs.existsSync(legacyBackupPath)) {
    throw new Error('Confirmed updater cleanup leaves downloaded packages or old backups behind.');
  }
} finally {
  fs.rmSync(cleanupTestDir, { recursive:true, force:true });
}
if (!installSource.includes("spawn('wscript.exe', ['//B', '//NoLogo'")) throw new Error('Silent VBS update launcher is missing.');
if (!installSource.includes('isAppQuitting = true;')) throw new Error('Updater does not bypass the tray close handler before quitting.');
if (!installSource.includes('resolveSoftwareUpdateInstallTarget()')) throw new Error('Portable updater does not resolve a persistent original EXE.');
if (installSource.includes('const target = process.execPath')) throw new Error('Portable updater can still target Electron temporary extraction path.');
if (installSource.includes('If fso.FileExists(src) Then fso.DeleteFile src')) throw new Error('Updater deletes its rollback package before the new version confirms startup.');
if (installSource.includes("spawn('cmd.exe'") || installSource.includes('.bat')) throw new Error('Legacy visible cmd/batch updater path is still present.');

const reconcileStart = source.indexOf('function reconcileSoftwareUpdateAfterRestart');
const reconcileEnd = source.indexOf('\nfunction dataUrlToFile', reconcileStart);
const reconcileSource = source.slice(reconcileStart, reconcileEnd);
if (!reconcileSource.includes('cleanupCompletedSoftwareUpdateArtifacts(runtime)')) throw new Error('Confirmed update does not clean downloaded package and old backup.');

assertRendererIncludes('softwareUpdateProgress', 'Renderer update progress UI is missing.');
assertRendererIncludes('scheduleStartupSoftwareUpdateCheck', 'Startup update check scheduler is missing.');
assertRendererIncludes('softwareUpdateActionLabel', 'Updater stage-specific button labels are missing.');
assertIndexIncludes('id="updateAutoCheck"', 'Settings auto-check checkbox is missing.');
assertIndexIncludes('id="softwareUpdateProgress"', 'Update progress markup is missing from the main document.');

console.log('[verify-updater] OK: updater uses timezone-safe runtime state, direct-first resumable downloads, portable EXE replacement, visible progress, restart recovery, and startup auto-check control.');
