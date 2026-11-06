'use strict';

const RELEASE_URL = 'https://github.com/aln614/-/releases/latest';
const API_URL = 'https://api.github.com/repos/aln614/-/releases/latest';

function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

async function checkClientUpdate(currentVersion, fetchRelease) {
  const response = await fetchRelease(API_URL, {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'TENYING-AI-LAN-Client' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}）`);
  const release = await response.json();
  const versions = (Array.isArray(release.assets) ? release.assets : [])
    .map(asset => /^TENYING_AI_LAN_Client-(\d+\.\d+\.\d+)-win-(?:x64|ia32|arm64)\.exe$/i.exec(String(asset.name || ''))?.[1])
    .filter(Boolean)
    .sort((a, b) => compareVersions(b, a));
  if (!versions.length) throw new Error('最新发布版未包含客户端安装包，请稍后再试。');
  return { currentVersion, latestVersion: versions[0], comparison: compareVersions(versions[0], currentVersion) };
}

module.exports = { RELEASE_URL, compareVersions, checkClientUpdate };
