'use strict';
require('esbuild').buildSync({
  entryPoints:['src/renderer/liquid-glass-entry.jsx'],
  outfile:'src/renderer/static/liquid-glass-bundle.js',
  bundle:true,
  minify:true,
  define:{'process.env.NODE_ENV':'"production"'}
});
