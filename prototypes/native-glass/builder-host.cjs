'use strict';
const build=require('../../package.json').build;
module.exports={
  ...build,
  directories:{output:'dist-native-experimental-host'},
  files:[...build.files,'lan-client/native-glass.js'],
  extraFiles:[{from:'build/native-glass/Microsoft.Graphics.Canvas.winmd',to:'Microsoft.Graphics.Canvas.winmd'}],
  extraResources:[{from:'build/native-glass',to:'native-glass'}],
  win:{...build.win,target:['dir']}
};
