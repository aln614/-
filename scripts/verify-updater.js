const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const { createSoftwareUpdateNetwork } = require('../src/services/softwareUpdateNetwork');

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

assertIncludes('function parseSoftwareUpdateRuntimeTimestamp', 'Updater timezone-safe timestamp parser is missing.');
assertIncludes("require('./services/softwareUpdateNetwork')", 'Updater network is not routed through the system proxy module.');
assertIncludes('createSoftwareUpdateNetwork({ app, session, fs, path, ensureDir })', 'Updater system-proxy network is not initialized.');
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
assertIncludes('function pickSoftwareUpdateAsset', 'Platform-aware GitHub release asset selection is missing.');
assertIncludes("process.platform === 'darwin'", 'macOS release assets are not selected by platform.');

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

const updaterFlowStart = source.indexOf('async function downloadSoftwareUpdate');
const updaterFlowEnd = source.indexOf('\nasync function applyLatestSoftwareUpdate', updaterFlowStart);
const updaterFlow = source.slice(updaterFlowStart, updaterFlowEnd);
if (!updaterFlow.includes('downloadUrlToFileRobust(info.asset_url, dest')) throw new Error('Updater does not use the system-proxy download implementation.');
if (!updaterFlow.includes('正在通过系统代理下载新版 EXE')) throw new Error('Updater progress does not identify the system-proxy route.');
if (updaterFlow.includes('downloadUrlToFileWithSystemCurl') || updaterFlow.includes('直连 GitHub')) {
  throw new Error('Updater can still fall back to a direct GitHub download.');
}

const installStart = source.indexOf('function installSoftwareUpdate');
const installEnd = source.indexOf('function reconcileSoftwareUpdateAfterRestart', installStart);
const installSource = source.slice(installStart, installEnd);
const targetStart = source.indexOf('function softwareUpdateTemporaryRoots');
const targetEnd = source.indexOf('\nfunction installSoftwareUpdate', targetStart);
if (targetStart < 0 || targetEnd < 0) throw new Error('Persistent updater install-target resolver is missing.');
const targetSandbox = {
  os: { tmpdir: () => 'C:\\Temp' },
  path: path.win32,
  process: { platform: 'win32', env: {}, execPath: 'C:\\Temp\\TENYING_AI.exe' },
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
assertRendererIncludes('handleSoftwareUpdateAction', 'Platform-specific update action is missing.');
assertRendererIncludes('下载 macOS 安装包', 'macOS update action is not available in the release dialog.');
assertIndexIncludes('id="updateAutoCheck"', 'Settings auto-check checkbox is missing.');
assertIndexIncludes('id="softwareUpdateProgress"', 'Update progress markup is missing from the main document.');

async function verifySystemProxyUpdaterNetwork() {
  const proxyConfigs = [];
  const requests = [];
  const mockSession = {
    setProxy: async config => proxyConfigs.push(config),
    fetch: async (target, init) => {
      requests.push({ target, init });
      if (target.includes('api.github.com')) {
        return { ok:true, status:200, json:async () => ({ tag_name:'v9.9.9' }) };
      }
      let sent = false;
      return {
        ok:true,
        status:206,
        headers:{ get: name => ({ 'content-range':'bytes 3-5/6', 'content-length':'3' }[name.toLowerCase()] || null) },
        body:{
          getReader:()=>({
            read:async()=> sent ? { done:true } : (sent=true, { done:false, value:new Uint8Array(Buffer.from('def')) }),
            cancel:async()=>{}
          }),
          cancel:async()=>{}
        }
      };
    }
  };
  const network = createSoftwareUpdateNetwork({
    app:{ whenReady:async()=>{} },
    session:{ fromPartition:partition=>{ if(partition!=='tenying-software-updater') throw new Error('Updater did not use its isolated session.'); return mockSession; } },
    fs,
    path,
    ensureDir:dir=>fs.mkdirSync(dir,{recursive:true})
  });
  const release = await network.httpJson('https://api.github.com/repos/example/project/releases/latest');
  if (release.tag_name !== 'v9.9.9') throw new Error('System-proxy GitHub API response was not parsed.');
  if (proxyConfigs.length !== 1 || proxyConfigs[0].mode !== 'system') throw new Error('Updater did not explicitly select the OS system proxy.');
  if (requests[0].init.redirect !== 'follow') throw new Error('GitHub release checks do not follow redirects in the system-proxy session.');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenying-updater-system-proxy-'));
  try {
    const destination = path.join(testDir, 'update.exe');
    fs.writeFileSync(`${destination}.part`, 'abc');
    const progress = [];
    await network.downloadToFile('https://github.com/example/project/releases/download/v9.9.9/update.exe', destination, {
      total:6,
      onProgress:value=>progress.push(value)
    });
    if (fs.readFileSync(destination, 'utf8') !== 'abcdef') throw new Error('Resumed system-proxy download produced incorrect file content.');
    const downloadRequest = requests[1];
    if (downloadRequest.init.headers.Range !== 'bytes=3-') throw new Error('Updater did not resume a partial system-proxy download.');
    if (progress.at(-1)?.bytes !== 6 || progress.at(-1)?.source !== 'system-proxy') throw new Error('System-proxy download progress was not reported.');
    if (proxyConfigs.length !== 1) throw new Error('Updater recreated or changed the isolated proxy session between requests.');
  } finally {
    fs.rmSync(testDir, { recursive:true, force:true });
  }
}

verifySystemProxyUpdaterNetwork()
  .then(()=>console.log('[verify-updater] OK: updater uses the OS system proxy for GitHub checks and resumable downloads, with no direct fallback; runtime recovery and portable install checks passed.'))
  .catch(error=>{ console.error(error); process.exitCode=1; });
