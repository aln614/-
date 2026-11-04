'use strict';
// Coalesce native panel movement without reading or capturing the desktop.
(() => {
  if(typeof window.libraryPanel?.startWindowDrag!=='function' || window.lanClient) return;
  const kind=new URLSearchParams(location.search).get('library');
  let drag=null,dragFrame=0;
  function endDrag(event) {
    if(!drag) return;
    if(dragFrame) {cancelAnimationFrame(dragFrame);dragFrame=0;}
    window.libraryPanel.moveWindowDrag(drag.point);
    const {element,pointerId}=drag;
    drag=null;
    element.classList.remove('is-dragging');
    if(element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    window.libraryPanel.endWindowDrag();
  }
  for(const element of kind ? document.querySelectorAll('.asset-library-drag-region,.prompt-library-drag-region') : []) {
    element.addEventListener('pointerdown',event=>{
      if(event.button!==0 || !event.isPrimary || drag) return;
      event.preventDefault();
      drag={element,pointerId:event.pointerId,point:{x:event.screenX,y:event.screenY}};
      element.setPointerCapture(event.pointerId);
      element.classList.add('is-dragging');
      window.libraryPanel.startWindowDrag(drag.point);
    });
    element.addEventListener('pointermove',event=>{
      if(!drag || event.pointerId!==drag.pointerId) return;
      drag.point={x:event.screenX,y:event.screenY};
      if(!dragFrame) dragFrame=requestAnimationFrame(()=>{dragFrame=0;if(drag) window.libraryPanel.moveWindowDrag(drag.point);});
    });
    element.addEventListener('pointerup',event=>{if(drag && event.pointerId===drag.pointerId) endDrag(event);});
    element.addEventListener('pointercancel',endDrag);
    element.addEventListener('lostpointercapture',endDrag);
  }
  window.addEventListener('blur',endDrag);
  window.addEventListener('pagehide',endDrag);
  window.desktopVisibility?.onChange(visible=>{if(!visible) endDrag();});
})();
