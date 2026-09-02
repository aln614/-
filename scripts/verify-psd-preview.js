const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractEmbeddedPsdThumbnail } = require('../src/services/psdPreview');

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
const thumbnailData = Buffer.alloc(28 + jpeg.length);
thumbnailData.writeUInt32BE(1, 0);
thumbnailData.writeUInt32BE(160, 4);
thumbnailData.writeUInt32BE(90, 8);
thumbnailData.writeUInt32BE(480, 12);
thumbnailData.writeUInt32BE(160 * 90 * 3, 16);
thumbnailData.writeUInt32BE(jpeg.length, 20);
thumbnailData.writeUInt16BE(24, 24);
thumbnailData.writeUInt16BE(1, 26);
jpeg.copy(thumbnailData, 28);

const resource = Buffer.alloc(4 + 2 + 2 + 4 + thumbnailData.length + (thumbnailData.length % 2));
let offset = 0;
resource.write('8BIM', offset, 'ascii'); offset += 4;
resource.writeUInt16BE(1036, offset); offset += 2;
resource[offset++] = 0;
resource[offset++] = 0;
resource.writeUInt32BE(thumbnailData.length, offset); offset += 4;
thumbnailData.copy(resource, offset);

const header = Buffer.alloc(26);
header.write('8BPS', 0, 'ascii');
header.writeUInt16BE(1, 4);
header.writeUInt16BE(3, 12);
header.writeUInt32BE(90, 14);
header.writeUInt32BE(160, 18);
header.writeUInt16BE(8, 22);
header.writeUInt16BE(3, 24);
const lengths = Buffer.alloc(8);
lengths.writeUInt32BE(0, 0);
lengths.writeUInt32BE(resource.length, 4);

const fixture = path.join(os.tmpdir(), `tenying-psd-preview-${process.pid}-${Date.now()}.psd`);
try {
  fs.writeFileSync(fixture, Buffer.concat([header, lengths, resource]));
  const extracted = extractEmbeddedPsdThumbnail(fixture);
  assert(extracted, 'Embedded PSD thumbnail should be found');
  assert.deepStrictEqual(extracted, jpeg, 'Extracted PSD thumbnail bytes must match the embedded JPEG');
  fs.writeFileSync(fixture, Buffer.from('not a psd'));
  assert.strictEqual(extractEmbeddedPsdThumbnail(fixture), null, 'Malformed PSD files must fail safely');
} finally {
  fs.rmSync(fixture, { force:true });
}

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'static', 'app.js'), 'utf8');
assert(/ensureAssetDocumentPreviewThumbs\(db, cfg\)/.test(main), 'Asset library must repair PSD thumbnails while loading');
assert(/type === 'image' \|\| isPsdAssetFile\(original\)/.test(main), 'New PSD uploads must generate an embedded preview thumbnail');
assert(/const thumb = a\.thumb_url \|\| \(a\.type === 'image' \? a\.url : ''\)/.test(app), 'Document thumbnails must render on asset cards');
assert(/else if\(a\?\.thumb_url\) showPreview\(a\.thumb_url/.test(app), 'PSD cards must open their thumbnail preview instead of decoding the source file');

console.log('[verify-psd-preview] OK: embedded PSD thumbnails, safe fallback, asset repair, and file-aware previews are wired.');
