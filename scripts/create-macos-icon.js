'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ICO_PATH = path.join(__dirname, '..', 'assets', 'rocket.ico');
const ICNS_TYPES = new Map([[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08']]);

function createIcnsFromIco(ico) {
  if (!Buffer.isBuffer(ico) || ico.length < 22 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error('Expected a valid ICO file.');
  }
  const count = ico.readUInt16LE(4);
  const chunks = [];
  const seen = new Set();
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    if (entry + 16 > ico.length) throw new Error('ICO directory is truncated.');
    const width = ico[entry] || 256;
    const height = ico[entry + 1] || 256;
    const type = ICNS_TYPES.get(width);
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    if (!type || width !== height || seen.has(type) || offset + size > ico.length) continue;
    const png = ico.subarray(offset, offset + size);
    if (png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) continue;
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, 4, 'ascii');
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    chunks.push(chunk);
    seen.add(type);
  }
  if (!seen.has('ic08')) throw new Error('The source ICO must include an embedded 256x256 PNG icon.');
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(header.length + body.length, 4);
  return Buffer.concat([header, body]);
}

if (require.main === module) {
  const outputPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'build', 'rocket.icns'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, createIcnsFromIco(fs.readFileSync(ICO_PATH)));
  process.stdout.write(`Created ${outputPath}\n`);
}

module.exports = { createIcnsFromIco };
