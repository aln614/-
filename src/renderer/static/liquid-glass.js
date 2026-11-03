// Edge-refraction approach adapted from rdev/liquid-glass-react (MIT).
// See licenses/liquid-glass-react.txt for the original copyright and license.
(function(){
  'use strict';
  if(!window.mainWindowControls || new URLSearchParams(location.search).has('library') || window.lanClient) return;
  const svgNS='http://www.w3.org/2000/svg';
  const canvas=document.createElement('canvas');
  canvas.width=canvas.height=128;
  const context=canvas.getContext('2d');
  if(!context) return;
  const image=context.createImageData(canvas.width,canvas.height);
  for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++){
    const u=(x+.5)/canvas.width, v=(y+.5)/canvas.height;
    const distance=Math.min(u,1-u,v,1-v);
    const t=Math.max(0,Math.min(1,distance/.17));
    const edge=1-t*t*(3-2*t);
    const dx=.5-u, dy=.5-v, magnitude=Math.hypot(dx,dy) || 1;
    const i=(y*canvas.width+x)*4;
    image.data[i]=Math.round(127.5+dx/magnitude*edge*90);
    image.data[i+1]=image.data[i+2]=Math.round(127.5+dy/magnitude*edge*90);
    image.data[i+3]=255;
  }
  context.putImageData(image,0,0);
  const svg=document.createElementNS(svgNS,'svg');
  svg.setAttribute('aria-hidden','true');
  svg.setAttribute('width','0'); svg.setAttribute('height','0');
  svg.style.position='absolute'; svg.style.pointerEvents='none';
  const defs=document.createElementNS(svgNS,'defs');
  const filter=document.createElementNS(svgNS,'filter');
  filter.id='tenying-liquid-refraction';
  filter.setAttribute('x','-10%'); filter.setAttribute('y','-10%');
  filter.setAttribute('width','120%'); filter.setAttribute('height','120%');
  filter.setAttribute('color-interpolation-filters','sRGB');
  const map=document.createElementNS(svgNS,'feImage');
  map.setAttribute('href',canvas.toDataURL());
  map.setAttribute('x','0'); map.setAttribute('y','0');
  map.setAttribute('width','100%'); map.setAttribute('height','100%');
  map.setAttribute('preserveAspectRatio','none'); map.setAttribute('result','refraction');
  const displacement=document.createElementNS(svgNS,'feDisplacementMap');
  displacement.setAttribute('in','SourceGraphic'); displacement.setAttribute('in2','refraction');
  displacement.setAttribute('scale','10'); displacement.setAttribute('xChannelSelector','R'); displacement.setAttribute('yChannelSelector','B');
  filter.append(map,displacement); defs.append(filter); svg.append(defs); document.body.append(svg);
  document.body.classList.add('liquid-refraction-ready');
})();
