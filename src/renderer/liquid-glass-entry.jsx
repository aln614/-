import React from 'react';
import { createRoot } from 'react-dom/client';
import LiquidGlass from 'liquid-glass-react';

const key = 'tenying-liquid-glass-settings';
const defaults = { enabled:true, displacementScale:70, blurAmount:0.0625, saturation:140, aberrationIntensity:2 };
const controls = { displacementScale:'liquidDisplacement', blurAmount:'liquidBlur', saturation:'liquidSaturation', aberrationIntensity:'liquidAberration' };
const limits = { displacementScale:[0,150], blurAmount:[0,1], saturation:[50,250], aberrationIntensity:[0,10] };
const clamp = (value, fallback, [min,max]) => Number.isFinite(Number(value)) ? Math.max(min,Math.min(max,Number(value))) : fallback;
function normalize(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const result = { enabled:value.enabled !== false };
  for (const name of Object.keys(controls)) result[name] = clamp(value[name] ?? defaults[name], defaults[name], limits[name]);
  return result;
}
function stored() {
  try { return normalize(JSON.parse(localStorage.getItem(key) || '{}')); } catch { return {...defaults}; }
}
let settings = stored();
const mounts = [];
for (const selector of ['.topbar .liquid-glass-mount','#assetLibraryHead','#promptLibraryHead']) {
  const target = document.querySelector(selector);
  if (!target) continue;
  let mount = target;
  if (!target.classList.contains('liquid-glass-mount')) {
    mount = document.createElement('span');
    mount.className = 'liquid-glass-mount';
    mount.setAttribute('aria-hidden','true');
    target.prepend(mount);
  }
  mounts.push(createRoot(mount));
}
function render() {
  document.body.classList.toggle('liquid-glass-enabled',settings.enabled);
  for (const root of mounts) root.render(settings.enabled ? <LiquidGlass {...settings} cornerRadius={16} elasticity={0} padding="0" style={{position:'absolute',top:'50%',left:'50%',width:'100%',height:'100%'}} /> : null);
  const enabled = document.getElementById('liquidEnabled');
  if (enabled) enabled.checked = settings.enabled;
  for (const [name,id] of Object.entries(controls)) {
    const input = document.getElementById(id);
    if (input) { input.value = settings[name]; input.disabled = !settings.enabled; }
    const output = document.getElementById(id+'Value');
    if (output) output.textContent = String(settings[name]);
  }
}
function publish() {
  try { localStorage.setItem(key,JSON.stringify(settings)); } catch {}
  render();
}
document.getElementById('liquidEnabled')?.addEventListener('change',e=>{ settings.enabled=e.target.checked; publish(); });
for (const [name,id] of Object.entries(controls)) document.getElementById(id)?.addEventListener('input',e=>{ settings=normalize({...settings,[name]:e.target.value}); publish(); });
document.getElementById('liquidReset')?.addEventListener('click',()=>{settings={...defaults}; publish();});
document.getElementById('liquidSave')?.addEventListener('click',async()=>{
  const status=document.getElementById('liquidSaveStatus');
  try {
    const response=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({liquid_glass:settings})});
    if(!response.ok) throw new Error('save failed');
    if(status) status.textContent='已保存';
  } catch { if(status) status.textContent='保存失败，请重试'; }
});
window.addEventListener('storage',e=>{ if(e.key===key){settings=stored(); render();} });
window.liquidGlassSettings = {
  get:()=>({...settings}),
  load:value=>{ if(!new URLSearchParams(location.search).has('library')) {settings=normalize(value); publish();} }
};
render();
