'use strict';
const assert = require('node:assert/strict');
const { checkClientUpdate } = require('../lan-client/updates');

async function check(current, assets) {
  return checkClientUpdate(current, async url => {
    assert.equal(url, 'https://api.github.com/repos/aln614/-/releases/latest');
    return {ok:true, json:async () => ({assets:assets.map(name => ({name}))})};
  });
}
(async () => {
  assert.equal((await check('1.0.61', ['TENYING_AI_LAN_Client-1.0.58-win-x64.exe'])).comparison, -1);
  assert.equal((await check('1.0.61', ['TENYING_AI_LAN_Client-1.0.61-win-x64.exe'])).comparison, 0);
  assert.equal((await check('1.0.61', ['TENYING_AI-9.0.0-win-x64.exe', 'TENYING_AI_LAN_Client-1.0.62-win-x64.exe'])).comparison, 1);
  await assert.rejects(check('1.0.61', ['TENYING_AI-9.0.0-win-x64.exe']), /未包含客户端/);
  console.log('LAN client update version comparison and asset isolation passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
