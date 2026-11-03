const path = require('path');

function mediaRuntimeRoot(config = {}, dataRoot, paths = path) {
  const output = String(config.output_dir || '').trim();
  // A configured but unavailable output directory must fail at the write site,
  // never silently accumulate original media in the Windows profile.
  return output ? paths.join(output, '\u8fd0\u884c\u6570\u636e\u76ee\u5f55') : dataRoot;
}

function uploadDirectory(config, dataRoot, owner = 'local', paths = path) {
  const safeOwner = String(owner || 'local').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'local';
  return paths.join(mediaRuntimeRoot(config, dataRoot, paths), 'uploads', safeOwner);
}

function previewDirectory(config, dataRoot, paths = path) {
  return paths.join(mediaRuntimeRoot(config, dataRoot, paths), 'cache', 'preview_images');
}

function relocatedUploadPath(file, config, dataRoot, paths = path) {
  if (!String(config.output_dir || '').trim()) return file;
  const roots = [
    [paths.join(dataRoot, 'uploads'), paths.join(mediaRuntimeRoot(config, dataRoot, paths), 'uploads')],
    [paths.join(paths.dirname(dataRoot), 'LocalApiImageGenerator_RuntimeData_V1458', 'uploads'),
      paths.join(mediaRuntimeRoot(config, dataRoot, paths), 'uploads', 'legacy-v1458')]
  ];
  for (const [source, destination] of roots) {
    const relative = paths.relative(source, file);
    if (relative && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)) {
      return paths.join(destination, relative);
    }
  }
  return file;
}

function expendableDragFiles(files, { now = Date.now(), maxBytes = 256 * 1024 ** 2 } = {}) {
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const expired = [];
  for (const file of [...files].sort((a, b) => a.time - b.time)) {
    const age = now - file.time;
    // Targets may still be reading a dropped file; leave a one-hour grace period.
    if (age < 60 * 60 * 1000) continue;
    if (age < 24 * 60 * 60 * 1000 && total <= maxBytes) continue;
    expired.push(file.path);
    total -= file.size;
  }
  return expired;
}

module.exports = { mediaRuntimeRoot, uploadDirectory, previewDirectory, relocatedUploadPath, expendableDragFiles };
