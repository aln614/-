'use strict';
(() => {
  const controls=window.mainWindowControls;
  if(!document.body.classList.contains('desktop-shell') || typeof controls?.startDrag!=='function') return;
  const titlebar=document.querySelector('.topbar');
  if(!titlebar) return;
  const interactive='button,input,select,textarea,a,[role="button"],[contenteditable="true"],.desktop-window-controls';
  let drag=null,frame=0;
  function finish(event) {
    if(!drag) return;
    if(frame) {cancelAnimationFrame(frame);frame=0;}
    controls.moveDrag(drag.point);
    const id=drag.id;
    drag=null;
    titlebar.classList.remove('is-window-dragging');
    if(titlebar.hasPointerCapture(id)) titlebar.releasePointerCapture(id);
    controls.endDrag();
  }
  titlebar.addEventListener('pointerdown',event=>{
    if(event.button!==0 || !event.isPrimary || drag || event.target.closest(interactive)) return;
    event.preventDefault();
    drag={id:event.pointerId,point:{x:event.screenX,y:event.screenY}};
    titlebar.setPointerCapture(event.pointerId);
    titlebar.classList.add('is-window-dragging');
    controls.startDrag(drag.point);
  });
  titlebar.addEventListener('pointermove',event=>{
    if(!drag || event.pointerId!==drag.id) return;
    drag.point={x:event.screenX,y:event.screenY};
    if(!frame) frame=requestAnimationFrame(()=>{frame=0;if(drag) controls.moveDrag(drag.point);});
  });
  titlebar.addEventListener('pointerup',event=>{if(drag && event.pointerId===drag.id) finish(event);});
  titlebar.addEventListener('pointercancel',finish);
  titlebar.addEventListener('lostpointercapture',finish);
  titlebar.addEventListener('dblclick',event=>{
    if(event.target.closest(interactive)) return;
    event.preventDefault();finish();controls.action('maximize');
  });
  window.addEventListener('blur',finish);
  window.addEventListener('pagehide',finish);
  window.desktopVisibility?.onChange(visible=>{if(!visible) finish();});
})();
