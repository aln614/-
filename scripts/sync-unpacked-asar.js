const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const args = process.argv.slice(2);
const restartApp = args.includes('--restart');
const resourcesArg = args.find(x => !String(x || '').startsWith('--'));
const resourcesDir = path.resolve(resourcesArg || path.join(root, 'dist', 'win-unpacked', 'resources'));
const asarPath = path.join(resourcesDir, 'app.asar');
const nextAsarPath = path.join(resourcesDir, `app.asar.next_${process.pid}`);
const exePath = path.resolve(resourcesDir, '..', 'TENYING_AI.exe');
const asarCli = path.join(root, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');

function fail(message) {
  console.error(`[sync-unpacked-asar] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const ret = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (ret.status !== 0) {
    const detail = ret.error ? `; ${ret.error.message}` : (ret.signal ? `; signal ${ret.signal}` : '');
    fail(`${path.basename(command)} ${args.join(' ')} failed with code ${ret.status}${detail}`);
  }
}

function runAsar(args) {
  run(process.execPath, [asarCli, ...args]);
}

function copyRequiredFiles(stage) {
  fs.cpSync(path.join(root, 'src'), path.join(stage, 'src'), { recursive: true });
  fs.cpSync(path.join(root, 'assets'), path.join(stage, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
}

function stopRunningUnpackedApp() {
  if (!restartApp || process.platform !== 'win32' || !fs.existsSync(exePath)) return;
  const ps = `
$exe = [System.IO.Path]::GetFullPath('${exePath.replace(/'/g, "''")}')
Get-Process TENYING_AI -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -eq $exe)
} | Stop-Process -Force
`;
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, stdio: 'inherit' });
}

function startUnpackedApp() {
  if (!restartApp || process.platform !== 'win32' || !fs.existsSync(exePath)) return;
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Start-Process -FilePath '${exePath.replace(/'/g, "''")}'`], { windowsHide: true, stdio: 'inherit' });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function replaceAsarFile(backupPath) {
  stopRunningUnpackedApp();
  let lastError = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      fs.copyFileSync(asarPath, backupPath);
      fs.rmSync(asarPath, { force: true });
      fs.renameSync(nextAsarPath, asarPath);
      startUnpackedApp();
      return;
    } catch (error) {
      lastError = error;
      sleepMs(500);
    }
  }
  if (fs.existsSync(nextAsarPath)) fs.rmSync(nextAsarPath, { force: true });
  startUnpackedApp();
  fail(`Could not replace app.asar after waiting. Close TENYING_AI and retry. ${lastError ? lastError.message : ''}`);
}

function main() {
  if (!fs.existsSync(asarCli)) fail(`asar CLI not found: ${asarCli}. Run npm install first.`);
  if (!fs.existsSync(resourcesDir)) fail(`Unpacked resources folder not found: ${resourcesDir}. Run npm run dist:dir first.`);
  if (!fs.existsSync(asarPath)) fail(`app.asar not found: ${asarPath}. Run npm run dist:dir first.`);

  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const backupPath = path.join(resourcesDir, `app.asar.bak_${stamp}`);

  const stage = path.join(os.tmpdir(), `tenying_ai_asar_stage_${process.pid}_${Date.now()}`);
  const verifyDir = path.join(os.tmpdir(), `tenying_ai_asar_verify_${process.pid}_${Date.now()}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(verifyDir, { recursive: true, force: true });
  fs.rmSync(nextAsarPath, { force: true });
  fs.mkdirSync(stage, { recursive: true });
  try {
    copyRequiredFiles(stage);
    runAsar(['pack', stage, nextAsarPath]);
    runAsar(['extract', nextAsarPath, verifyDir]);
    run(process.execPath, [path.join(root, 'scripts', 'verify-image-models.js'), '--root', verifyDir]);
    replaceAsarFile(backupPath);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(verifyDir, { recursive: true, force: true });
    fs.rmSync(nextAsarPath, { force: true });
  }

  console.log(`[sync-unpacked-asar] Updated ${asarPath}`);
  console.log(`[sync-unpacked-asar] Backup saved to ${backupPath}`);
}

main();
