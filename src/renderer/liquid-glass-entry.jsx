import React, {useLayoutEffect,useRef} from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';
import LiquidGlass from 'liquid-glass-react';
import glassSettings from '../services/liquidGlassSettings';

const {DEFAULT_LIQUID_GLASS:defaults,normalizeLiquidGlass:normalize}=glassSettings;
const key='tenying-liquid-glass-settings';
const controls={displacementScale:'liquidDisplacement',blurAmount:'liquidBlur',saturation:'liquidSaturation',aberrationIntensity:'liquidAberration',surfaceOpacity:'liquidOpacity'};
const selector=[
  '.topbar',
  '.asset-library-window','.prompt-library-window','.chat-floating-window','.announcement-panel',
  '#previewModal','.preview-toolbar','.preview-info','.video-preview-info',
  '.api-balance-dialog','.recent-audio-preview-card','.danger-confirm-card'
].join(',');
function stored() {
  try { const value=localStorage.getItem(key); return value ? normalize(JSON.parse(value)) : null; } catch { return null; }
}
let settings=stored() || {...defaults};
const surfaces=new Map();
const pendingHosts=new Set();
let frame=0;
let motionTimer=0;
let nativeHidden=false;
const stationaryMouse={x:0,y:0};
function motion() {
  if(document.hidden || nativeHidden || !settings.enabled) return;
  document.documentElement.classList.add('liquid-in-motion');
  clearTimeout(motionTimer);
  motionTimer=setTimeout(()=>document.documentElement.classList.remove('liquid-in-motion'),160);
}
const visibility=new IntersectionObserver(entries=>{
  for(const item of entries) {
    const surface=surfaces.get(item.target);
    if(surface) { surface.visible=item.isIntersecting; renderSurface(surface); }
  }
});
const resize=new ResizeObserver(entries=>{
  for(const item of entries) {
    const surface=surfaces.get(item.target);
    if(!surface) continue;
    const width=Math.round(item.contentRect.width),height=Math.round(item.contentRect.height);
    if(surface.width===width && surface.height===height) continue;
    const initialized=surface.width>0 && surface.height>0;
    surface.width=width;surface.height=height;
    clearTimeout(surface.resizeTimer);
    if(initialized && width>0 && height>0){motion();surface.resizeTimer=setTimeout(()=>renderSurface(surface),140);}
    else renderSurface(surface);
  }
});

function GlassSurface({host,...props}) {
  const layer=useRef(null);
  useLayoutEffect(()=>{
    const warp=layer.current?.querySelector('.glass__warp');
    const backdrop=host.querySelector(':scope > .liquid-backdrop');
    if(warp) {
      const match=warp.style.filter.match(/url\(["']?#([^)"']+)/);
      if(match && backdrop) backdrop.style.setProperty('--liquid-refraction',`url("#${match[1]}")`);
    }
  },[]);
  return <><div ref={layer} className="liquid-react-layer"><LiquidGlass {...props} /></div>{createPortal(<div className="liquid-backdrop" aria-hidden="true" />,host)}</>;
}

function renderSurface(surface) {
  const active=settings.enabled && !document.hidden && !nativeHidden && surface.visible && surface.width>0 && surface.height>0;
  const radius=parseFloat(getComputedStyle(surface.host).borderTopLeftRadius) || 0;
  const signature=JSON.stringify([active,settings,radius,surface.width,surface.height]);
  if(surface.signature===signature) return;
  surface.signature=signature;
  surface.host.classList.toggle('liquid-surface-active',active);
  const {enabled,surfaceOpacity,...props}=settings;
  // The library measures on mount/window resize; remount on container-only resizes too.
  surface.root.render(active ? <GlassSurface host={surface.host} key={surface.width+'x'+surface.height} {...props} globalMousePos={stationaryMouse} mouseOffset={stationaryMouse} overLight={false} cornerRadius={radius} elasticity={0} padding="0" style={{position:'absolute',top:'50%',left:'50%',width:'100%',height:'100%'}} /> : null);
}
function removeSurface(host) {
  const surface=surfaces.get(host);
  if(!surface) return;
  clearTimeout(surface.resizeTimer);surface.root.unmount();visibility.unobserve(host);resize.unobserve(host);surfaces.delete(host);
  host.classList.remove('liquid-surface-active');delete host.dataset.liquidSurface;
  host.querySelector(':scope > .liquid-glass-mount')?.remove();
  host.querySelector(':scope > .liquid-backdrop')?.remove();
}
function hostDisplayed(host) {
  if(document.body.classList.contains('standalone-library') && host.matches('.asset-library-window,.prompt-library-window')) return true;
  const style=getComputedStyle(host);
  return style.display!=='none' && style.visibility!=='hidden' && host.getClientRects().length>0;
}
function collectHosts(node) {
  if(node.nodeType!==1 || node.closest('.liquid-glass-mount,.liquid-backdrop')) return;
  const collect=host=>{if(hostDisplayed(host))pendingHosts.add(host);else removeSurface(host);};
  if(node.matches(selector)) collect(node);
  for(const host of node.querySelectorAll(selector)) collect(host);
}
function discoverSurfaces() {
  frame=0;
  for(const [host,surface] of surfaces) if(!host.isConnected) {
    removeSurface(host);
  }
  for(const host of pendingHosts) {
    if(!host.isConnected || surfaces.has(host) || host.closest('.liquid-glass-mount')) continue;
    host.dataset.liquidSurface='';
    if(getComputedStyle(host).position==='static') host.classList.add('liquid-static-host');
    const mount=document.createElement('div');
    mount.className='liquid-glass-mount';
    mount.setAttribute('aria-hidden','true');
    host.prepend(mount);
    const surface={host,root:createRoot(mount),width:0,height:0,visible:false,signature:''};
    surfaces.set(host,surface);visibility.observe(host);resize.observe(host);
  }
  pendingHosts.clear();
}
function scheduleDiscover() { if(!frame) frame=requestAnimationFrame(discoverSurfaces); }
new MutationObserver(records=>{
  let removed=false;
  for(const record of records){
    if(record.target.closest?.('.liquid-glass-mount,.liquid-backdrop')) continue;
    for(const node of record.addedNodes) collectHosts(node);
    for(const node of record.removedNodes) if(node.nodeType===1 && (node.matches('[data-liquid-surface]') || node.querySelector('[data-liquid-surface]'))) removed=true;
  }
  if(pendingHosts.size || removed) scheduleDiscover();
}).observe(document.body,{subtree:true,childList:true});
new MutationObserver(records=>{for(const record of records)collectHosts(record.target);if(pendingHosts.size)scheduleDiscover();}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','style','hidden','open','aria-hidden']});
function render() {
  document.body.classList.toggle('liquid-glass-enabled',settings.enabled);
  document.documentElement.style.setProperty('--liquid-opacity',settings.surfaceOpacity);
  document.documentElement.style.setProperty('--liquid-blur',(4+settings.blurAmount*32)+'px');
  document.documentElement.style.setProperty('--liquid-saturation',settings.saturation+'%');
  for(const surface of surfaces.values()) renderSurface(surface);
  const enabled=document.getElementById('liquidEnabled');
  if(enabled) enabled.checked=settings.enabled;
  for(const [name,id] of Object.entries(controls)) {
    const input=document.getElementById(id);
    if(input) { input.value=settings[name];input.disabled=!settings.enabled; }
    const output=document.getElementById(id+'Value');
    if(output) output.textContent=name==='surfaceOpacity' ? Math.round(settings[name]*100)+'%' : String(settings[name]);
  }
}
function status(text) { const element=document.getElementById('liquidSaveStatus');if(element) element.textContent=text; }
function publish(dirty=false) {
  try { localStorage.setItem(key,JSON.stringify(settings)); } catch {}
  if(dirty) status('未保存');
  render();
}
document.getElementById('liquidEnabled')?.addEventListener('change',e=>{settings.enabled=e.target.checked;publish(true);});
for(const [name,id] of Object.entries(controls)) document.getElementById(id)?.addEventListener('input',e=>{settings=normalize({...settings,[name]:e.target.value});publish(true);});
document.getElementById('liquidReset')?.addEventListener('click',()=>{settings={...defaults};publish(true);});
document.getElementById('liquidSave')?.addEventListener('click',async e=>{
  const snapshot={...settings},button=e.currentTarget;
  button.disabled=true;status('保存中');
  try {
    const response=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({liquid_glass:snapshot})});
    const result=await response.json();
    if(!response.ok || result.ok===false) throw new Error('save failed');
    status(JSON.stringify(snapshot)===JSON.stringify(settings) ? '已保存' : '未保存');
  } catch { status('保存失败，请重试'); }
  finally { button.disabled=false; }
});
window.addEventListener('storage',e=>{if(e.key===key){settings=stored() || {...defaults};render();}});
function updateVisibility() {
  const update=()=>{for(const surface of surfaces.values()) renderSurface(surface);};
  if(document.hidden || nativeHidden) flushSync(update); else update();
}
document.addEventListener('visibilitychange',updateVisibility);
window.desktopVisibility?.onChange(visible=>{nativeHidden=!visible;updateVisibility();});
document.addEventListener('scroll',motion,{capture:true,passive:true});
window.addEventListener('resize',motion,{passive:true});
let themeSignature='';
new MutationObserver(()=>{
  const signature=[document.body.dataset.skin,document.body.classList.contains('theme-dark')].join(':');
  if(signature===themeSignature) return;
  themeSignature=signature;
  for(const surface of surfaces.values()) renderSurface(surface);
}).observe(document.body,{attributes:true,attributeFilter:['class','data-skin']});
window.liquidGlassSettings={
  get:()=>({...settings}),
  motion,
  load:value=>{
    settings=new URLSearchParams(location.search).has('library') ? (stored() || normalize(value)) : normalize(value);
    publish();
  }
};
collectHosts(document.body);discoverSurfaces();render();
