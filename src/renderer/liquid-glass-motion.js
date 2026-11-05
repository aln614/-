// The upstream material is decorative; delegate elastic feedback to existing hit targets.
export function setupLiquidGlassMotion(getSettings) {
  const selector='button:not(:disabled),[role="button"]:not([aria-disabled="true"]),.dropzone,.asset-card,.pl-card,.image-card';
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const records=new Map();
  let control=null,surface=null,point=null,frame=0,pressed=false;
  const enabled=()=>getSettings().enabled && getSettings().elasticity>0 && !reduced.matches && !document.hidden;
  function remove(element) {
    const record=records.get(element);if(!record) return;
    clearTimeout(record.timer);
    element.removeAttribute('data-liquid-elastic');
    for(const key of ['--elastic-x','--elastic-y','--elastic-sx','--elastic-sy','--elastic-time']) element.style.removeProperty(key);
    records.delete(element);
  }
  function neutral(element,immediate=false) {
    if(!element || !records.has(element)) return;
    if(immediate) {remove(element);return;}
    element.style.setProperty('--elastic-time','420ms');
    element.style.setProperty('--elastic-x','0px');element.style.setProperty('--elastic-y','0px');
    element.style.setProperty('--elastic-sx','1');element.style.setProperty('--elastic-sy','1');
    const record=records.get(element);clearTimeout(record.timer);
    record.timer=setTimeout(()=>remove(element),450);
  }
  function reset(immediate=false) {
    if(frame) cancelAnimationFrame(frame);frame=0;pressed=false;point=null;
    for(const element of records.keys()) neutral(element,immediate);
    control=null;surface=null;
  }
  function target(element) {
    if(!element) return null;
    if(!records.has(element)) records.set(element,{timer:0});
    else clearTimeout(records.get(element).timer);
    element.setAttribute('data-liquid-elastic','');
    return element;
  }
  function select(event) {
    const nextControl=event.target.closest?.(selector) || null;
    const host=event.target.closest?.('[data-liquid-surface]');
    const nextSurface=host?.querySelector(':scope>.liquid-backdrop') || null;
    if(nextControl!==control) {neutral(control);control=target(nextControl);}
    if(nextSurface!==surface) {neutral(surface);surface=target(nextSurface);}
  }
  function paint(element,material) {
    if(!element?.isConnected) {remove(element);return;}
    const box=(material?element.parentElement:element).getBoundingClientRect();
    const dx=point.x-(box.left+box.width/2),dy=point.y-(box.top+box.height/2);
    const distance=Math.hypot(dx,dy),nx=distance?dx/distance:0,ny=distance?dy/distance:0;
    const strength=getSettings().elasticity*(material ? .18 : 1);
    const intensity=Math.min(distance/120,1)*strength;
    const compression=pressed ? (material ? .996 : .96) : 1;
    const maxScale=material?1.012:box.width>240?1.025:1.06;
    const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
    const sx=clamp((1+Math.abs(nx)*intensity*.3-Math.abs(ny)*intensity*.15)*compression,.94,maxScale);
    const sy=clamp((1+Math.abs(ny)*intensity*.3-Math.abs(nx)*intensity*.15)*compression,.94,maxScale);
    const limit=material ? .6 : 2;
    element.style.setProperty('--elastic-time',pressed?'90ms':'180ms');
    element.style.setProperty('--elastic-x',clamp(dx*strength*.06,-limit,limit)+'px');
    element.style.setProperty('--elastic-y',clamp(dy*strength*.06,-limit,limit)+'px');
    element.style.setProperty('--elastic-sx',String(sx));element.style.setProperty('--elastic-sy',String(sy));
  }
  function schedule(event) {
    point={x:event.clientX,y:event.clientY};
    if(!frame) frame=requestAnimationFrame(()=>{
      frame=0;
      if(!enabled() || !point) {reset(true);return;}
      if(control) paint(control,false);if(surface) paint(surface,true);
    });
  }
  document.addEventListener('pointerover',event=>{
    if(!enabled() || (event.pointerType!=='mouse' && event.pointerType!=='pen')) return;
    select(event);schedule(event);
  },{passive:true});
  document.addEventListener('pointermove',event=>{
    if(!control && !surface) return;
    if(!enabled() || event.buttons && !pressed) {reset(true);return;}
    schedule(event);
  },{passive:true});
  document.addEventListener('pointerdown',event=>{
    if(event.button!==0 || !enabled()) return;
    select(event);pressed=true;schedule(event);
  },{passive:true});
  document.addEventListener('pointerup',event=>{
    if(!pressed) return;
    pressed=false;
    if(event.pointerType==='touch') reset();else schedule(event);
  },{passive:true});
  document.addEventListener('pointerout',event=>{if(!event.relatedTarget) reset();},{passive:true});
  document.addEventListener('pointercancel',()=>reset(true),{passive:true});
  document.addEventListener('dragstart',()=>reset(true),true);
  document.addEventListener('scroll',()=>reset(true),{capture:true,passive:true});
  document.addEventListener('visibilitychange',()=>{if(document.hidden) reset(true);});
  window.addEventListener('blur',()=>reset(true));
  window.addEventListener('resize',()=>reset(true),{passive:true});
  reduced.addEventListener('change',()=>reset(true));
  window.desktopVisibility?.onChange(visible=>{if(!visible) reset(true);});
  return {refresh:()=>{if(!enabled()) reset(true);}};
}
