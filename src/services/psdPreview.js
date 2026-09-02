const fs = require('fs');

const PSD_SIGNATURE = '8BPS';
const RESOURCE_SIGNATURES = new Set(['8BIM', 'MeSa']);
const THUMBNAIL_RESOURCE_IDS = new Set([1033, 1036]);
const MAX_THUMBNAIL_BYTES = 32 * 1024 * 1024;

function readAt(fd, size, position) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_THUMBNAIL_BYTES) return null;
  const buffer = Buffer.allocUnsafe(size);
  const bytes = fs.readSync(fd, buffer, 0, size, position);
  return bytes === size ? buffer : null;
}

function extractEmbeddedPsdThumbnail(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    const header = readAt(fd, 26, 0);
    if (!header || header.toString('ascii', 0, 4) !== PSD_SIGNATURE) return null;
    const version = header.readUInt16BE(4);
    if (version !== 1 && version !== 2) return null;

    const colorLengthBuffer = readAt(fd, 4, 26);
    if (!colorLengthBuffer) return null;
    const colorLength = colorLengthBuffer.readUInt32BE(0);
    const resourcesLengthOffset = 30 + colorLength;
    if (resourcesLengthOffset + 4 > fileSize) return null;

    const resourcesLengthBuffer = readAt(fd, 4, resourcesLengthOffset);
    if (!resourcesLengthBuffer) return null;
    const resourcesLength = resourcesLengthBuffer.readUInt32BE(0);
    let position = resourcesLengthOffset + 4;
    const resourcesEnd = position + resourcesLength;
    if (resourcesEnd > fileSize || resourcesEnd < position) return null;

    let legacyThumbnail = null;
    while (position + 12 <= resourcesEnd) {
      const signatureBuffer = readAt(fd, 4, position);
      if (!signatureBuffer || !RESOURCE_SIGNATURES.has(signatureBuffer.toString('ascii'))) break;
      position += 4;

      const idBuffer = readAt(fd, 2, position);
      if (!idBuffer) break;
      const resourceId = idBuffer.readUInt16BE(0);
      position += 2;

      const nameLengthBuffer = readAt(fd, 1, position);
      if (!nameLengthBuffer) break;
      const pascalNameBytes = 1 + nameLengthBuffer[0];
      position += pascalNameBytes + (pascalNameBytes % 2);
      if (position + 4 > resourcesEnd) break;

      const dataLengthBuffer = readAt(fd, 4, position);
      if (!dataLengthBuffer) break;
      const dataLength = dataLengthBuffer.readUInt32BE(0);
      position += 4;
      if (position + dataLength > resourcesEnd || position + dataLength < position) break;

      if (THUMBNAIL_RESOURCE_IDS.has(resourceId) && dataLength >= 28 && dataLength <= MAX_THUMBNAIL_BYTES) {
        const thumbnailHeader = readAt(fd, 28, position);
        if (thumbnailHeader && thumbnailHeader.readUInt32BE(0) === 1) {
          const jpegLength = thumbnailHeader.readUInt32BE(20);
          if (jpegLength > 4 && jpegLength <= dataLength - 28 && jpegLength <= MAX_THUMBNAIL_BYTES) {
            const jpeg = readAt(fd, jpegLength, position + 28);
            if (jpeg && jpeg[0] === 0xff && jpeg[1] === 0xd8) {
              if (resourceId === 1036) return jpeg;
              legacyThumbnail = jpeg;
            }
          }
        }
      }
      position += dataLength + (dataLength % 2);
    }
    return legacyThumbnail;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

module.exports = { extractEmbeddedPsdThumbnail };
