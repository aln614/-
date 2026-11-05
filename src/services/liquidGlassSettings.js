'use strict';
const DEFAULT_LIQUID_GLASS = Object.freeze({
  enabled:true, displacementScale:70, blurAmount:0.0625,
  saturation:140, aberrationIntensity:2, surfaceOpacity:0.48, elasticity:0.2
});
const LIQUID_GLASS_LIMITS = Object.freeze({
  displacementScale:[0,150], blurAmount:[0,1], saturation:[50,250],
  aberrationIntensity:[0,10], surfaceOpacity:[0.15,0.9], elasticity:[0,0.5]
});
function normalizeLiquidGlass(value) {
  const source=value && typeof value==='object' ? value : {};
  const result={enabled:source.enabled !== false};
  for(const [name,[min,max]] of Object.entries(LIQUID_GLASS_LIMITS)){
    const raw=source[name];
    const number=(typeof raw==='number' || (typeof raw==='string' && raw.trim())) ? Number(raw) : NaN;
    result[name]=Number.isFinite(number) ? Math.max(min,Math.min(max,number)) : DEFAULT_LIQUID_GLASS[name];
  }
  return result;
}
module.exports={DEFAULT_LIQUID_GLASS,LIQUID_GLASS_LIMITS,normalizeLiquidGlass};
