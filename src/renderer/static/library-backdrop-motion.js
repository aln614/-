'use strict';
// Keep dynamic desktops live while the panel is visible; release tracks when hidden.
(() => {
  if(!['asset','prompt'].includes(new URLSearchParams(location.search).get('library')) ||
     typeof window.libraryPanel?.onBackdropMotion!=='function') return;
  let generation=0,stream=null,video=null,sourceId='';
  let drag=null,dragFrame=0;
  function endDrag(event) {
    if(!drag) return;
    if(event?.type==='pointerup' && event.pointerId===drag.pointerId) drag.point={x:event.screenX,y:event.screenY};
    if(dragFrame) {cancelAnimationFrame(dragFrame);dragFrame=0;}
    window.libraryPanel.moveWindowDrag(drag.point);
    const {element,pointerId}=drag;
    drag=null;
    element.classList.remove('is-dragging');
    if(element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    window.libraryPanel.endWindowDrag();
  }
  for(const element of document.querySelectorAll('.asset-library-drag-region,.prompt-library-drag-region')) {
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
  function stop(status='idle') {
    generation++;
    if(stream) for(const track of stream.getTracks()) track.stop();
    stream=null;sourceId='';
    if(video) {video.srcObject=null;video.remove();video=null;}
    document.body.dataset.libraryBackdropMotion=status;
  }
  async function start(payload) {
    if(!payload?.active) {stop();return;}
    if(!payload.sourceId || !navigator.mediaDevices?.getUserMedia) {stop('unavailable');window.libraryPanel.backdropUnavailable();return;}
    if(sourceId===payload.sourceId && (stream?.active || document.body.dataset.libraryBackdropMotion==='starting')) return;
    stop('starting');
    const token=generation;
    sourceId=payload.sourceId;
    const body=document.body;
    window.dispatchEvent(new CustomEvent('library-backdrop-update',{detail:payload}));
    try {
      const next=await navigator.mediaDevices.getUserMedia({
        audio:false,video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:payload.sourceId,maxWidth:960,maxHeight:600,maxFrameRate:60}}
      });
      if(token!==generation) {for(const track of next.getTracks()) track.stop();return;}
      const layer=document.querySelector('body.standalone-library .asset-library-window > .liquid-backdrop-static,body.standalone-library .prompt-library-window > .liquid-backdrop-static');
      if(!layer) {for(const track of next.getTracks()) track.stop();stop('unavailable');window.libraryPanel.backdropUnavailable();return;}
      stream=next;
      video=document.createElement('video');
      video.className='library-live-backdrop';
      video.setAttribute('aria-hidden','true');
      video.muted=true;video.autoplay=true;video.playsInline=true;video.srcObject=next;
      layer.appendChild(video);
      await video.play();
      if(typeof video.requestVideoFrameCallback==='function') {
        await new Promise(resolve=>{video.requestVideoFrameCallback(resolve);setTimeout(resolve,500);});
      }
      if(token!==generation) return;
      video.classList.add('is-ready');
      body.dataset.libraryBackdropMotion='active';
      for(const track of next.getTracks()) track.addEventListener('ended',()=>{
        if(token===generation) {stop('unavailable');window.libraryPanel.backdropUnavailable();}
      },{once:true});
    } catch(error) {
      if(token===generation) {console.warn('Live library backdrop unavailable:',error);stop('unavailable');window.libraryPanel.backdropUnavailable();}
    }
  }
  window.libraryPanel.onBackdropMotion(start);
  function updateVisibility() {
    if(document.hidden) {endDrag();stop();}
    window.libraryPanel.setBackdropVisible(!document.hidden);
  }
  window.addEventListener('library-backdrop-ready',()=>{
    const layer=document.querySelector('#'+new URLSearchParams(location.search).get('library')+'LibraryWindow > .liquid-backdrop-static');
    if(video && layer && video.parentElement!==layer) layer.appendChild(video);
    updateVisibility();
  });
  document.addEventListener('visibilitychange',updateVisibility);
  window.addEventListener('pagehide',()=>{endDrag();stop();});
  window.desktopVisibility?.onChange(visible=>{if(!visible){endDrag();stop();}});
  updateVisibility();
})();
