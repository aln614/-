'use strict';
const build=require('../../lan-client/package.json').build;
module.exports={
  ...build,
  directories:{output:'dist-native-experimental-client'},
  extraFiles:[{from:'../build/native-glass/Microsoft.Graphics.Canvas.winmd',to:'Microsoft.Graphics.Canvas.winmd'}],
  extraResources:[...build.extraResources,{from:'../build/native-glass',to:'native-glass'}],
  win:{...build.win,target:['dir']}
};
