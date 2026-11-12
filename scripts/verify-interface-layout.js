'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..');
const results=process.env.UI_SCREENSHOT_DIR || path.join(root,'test-results');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'tenying-interface-'));
const data=path.join(temporary,'runtime');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({port:18784,shortcuts_enabled:false,update_auto_check:false,public_enabled:false,asset_library_dir:path.join(temporary,'assets'),output_dir:path.join(temporary,'output')}));
(async()=>{
  let app;
  try {
    app=await electron.launch({executablePath:process.env.GLASS_TEST_PACKAGED || require('electron'),args:process.env.GLASS_TEST_PACKAGED?[]:[root],env:{...process.env,APPDATA:temporary,LOCALAPPDATA:temporary,LOCAL_API_IMAGE_GENERATOR_DATA_DIR:data}});
    const page=await app.firstWindow();
    await page.waitForURL('http://127.0.0.1:18784/**',{timeout:30000});
    await page.waitForFunction(()=>window.liquidGlassSettings && document.querySelector('.topbar .liquid-backdrop'));
    const fallbackSource='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    const fallbackResult=await page.evaluate(source=>{
      const cell=document.createElement('div'),img=document.createElement('img');
      cell.className='mini-image-cell';img.dataset.fallbackUrls=JSON.stringify([source]);cell.appendChild(img);document.body.appendChild(cell);
      bindRecentMiniImageFallback(img);img.dispatchEvent(new Event('error'));
      const result=img.src;cell.remove();return result;
    },fallbackSource);
    assert.equal(fallbackResult,fallbackSource,'Recent image thumbnails retry their fallback source after a broken thumbnail URL');
    await page.emulateMedia({reducedMotion:'reduce'});
    const reducedMotion = await page.evaluate(()=>({
      animation:getComputedStyle(document.querySelector('#page-home')).animationName,
      transition:getComputedStyle(document.querySelector('#saveConfigBtn')).transitionDuration,
      promptOrbAnimation:getComputedStyle(document.querySelector('.prompt-library-orb')).animationName
    }));
    assert.equal(reducedMotion.animation,'none','Reduced motion must disable page entrance animation');
    assert.ok(reducedMotion.transition.split(',').every(value=>parseFloat(value)===0),'Reduced motion must disable button transitions');
    assert.equal(reducedMotion.promptOrbAnimation,'none','Reduced motion must disable the floating prompt-library animation');
    await page.emulateMedia({reducedMotion:'no-preference'});
    fs.mkdirSync(results,{recursive:true});
    const pageIds=['home','midjourney','history','images','video','video-manage','chat','api','lan','public','logs','settings'];
    const pageIssues=[];
    for(const mode of ['light','dark']) for(const size of [{width:1480,height:960},{width:1180,height:760}]) {
      await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('library=')).setSize(size.width,size.height),size);
      await page.evaluate(mode=>applyThemeMode(mode),mode);
      await page.mouse.move(size.width-12,70);
      await page.waitForTimeout(350);
      const issues=await page.evaluate(()=>{
        const ids=['apiKey','modelPreset','size','clarity','startBatchBtn','promptLibraryBtn','assetLibraryBtn','mainWindowClose'];
        const issues=ids.flatMap(id=>{
          const el=document.getElementById(id),r=el.getBoundingClientRect();
          if(!r.width || !r.height || r.left<0 || r.right>innerWidth || r.top<0 || r.bottom>innerHeight) return [id+' is outside the viewport'];
          const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return hit && (el===hit || el.contains(hit)) ? [] : [id+' is obscured'];
        });
        const model=document.getElementById('modelPreset');
        if(model && model.title!==model.selectedOptions[0]?.textContent.trim()) issues.push('selected model label is not available as a tooltip');
        const lan=document.getElementById('lanState');
        if(lan && (!lan.title || lan.title!==lan.textContent || lan.getAttribute('aria-label')!==lan.textContent)) issues.push('LAN address tooltip or accessible label is incomplete');
        const panel=document.querySelector('#realtimeTaskPanel');
        if(panel){
          const style=getComputedStyle(panel),edge=getComputedStyle(panel,'::after');
          if(style.borderTopWidth!=='0px' || style.outlineStyle!=='none' || style.backgroundColor!=='rgba(0, 0, 0, 0)' || style.backgroundImage!=='none' || style.boxShadow!=='none' || edge.display!=='none') issues.push('Live task panel outer divider is too prominent');
          const backdrop=panel.querySelector(':scope>.liquid-backdrop');
          if(backdrop){
            const optics=getComputedStyle(backdrop),opticalEdge=getComputedStyle(backdrop,'::after');
            if(optics.padding!=='0px' || (opticalEdge.display!=='none' && opticalEdge.content!=='none')) issues.push('Live task panel still paints an optical edge');
          }
          if(document.body.classList.contains('liquid-glass-enabled') && panel.classList.contains('liquid-surface-active') && !panel.querySelector('.liquid-backdrop')) issues.push('Live task panel lost its liquid-glass backdrop');
          const tiles=[...panel.querySelectorAll('.stats>div')];
          if(tiles.some(tile=>{const tileStyle=getComputedStyle(tile);return tileStyle.boxShadow!=='none' || tileStyle.backgroundColor!=='rgba(0, 0, 0, 0)'})) issues.push('Live task panel statistics still look like separate cards');
          const gallery=document.getElementById('miniImages'),cell=document.createElement('div'),image=document.createElement('img');
          cell.className='mini-image-cell';image.className='mini-draggable-image';cell.appendChild(image);gallery.appendChild(cell);
          if(getComputedStyle(image).objectFit!=='contain') issues.push('Recent image thumbnails crop the source image');
          cell.remove();
        }
        return issues;
      });
      assert.deepEqual(issues,[],mode+' '+size.width+'px controls must be visible and clickable');
      await page.screenshot({path:path.join(results,`interface-${mode}-${size.width}.png`)});

      for(const id of pageIds){
        await page.locator(`.nav[data-page="${id}"]`).click();
        await page.waitForFunction(id=>document.querySelector(`#page-${id}`)?.classList.contains('active'),id);
        await page.waitForTimeout(80);
        const result=await page.evaluate(()=>{
          const page=document.querySelector('.page.active');
          const clipped=[...page.querySelectorAll('p,span,label,h1,h2,h3,.field-help,.calc-box,.size-hint,.estimate')].flatMap(el=>{
            if(!el.getClientRects().length || !el.textContent.trim()) return [];
            const style=getComputedStyle(el),rect=el.getBoundingClientRect();
            if(style.overflowX!=='hidden' && style.overflowX!=='clip' && style.textOverflow!=='ellipsis' && el.scrollWidth<=el.clientWidth+2) return [];
            if(el.scrollWidth<=el.clientWidth+2 || style.textOverflow==='ellipsis') return [];
            return [{text:el.textContent.trim().replace(/\s+/g,' ').slice(0,70),width:Math.round(el.clientWidth),scrollWidth:el.scrollWidth,overflow:style.overflowX,rect:{left:Math.round(rect.left),right:Math.round(rect.right)}}];
          });
          const horizontalOverflow=page.scrollWidth>page.clientWidth+3;
          const blocked=[...page.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].flatMap(el=>{
            const r=el.getBoundingClientRect();
            if(!r.width || !r.height || r.left<0 || r.top<0 || r.right>innerWidth || r.bottom>innerHeight) return [];
            for(let parent=el.parentElement;parent;parent=parent.parentElement){
              const style=getComputedStyle(parent),clip=parent.getBoundingClientRect();
              if(['auto','scroll','hidden','clip'].includes(style.overflowY) && (r.top<clip.top-1 || r.bottom>clip.bottom+1)) return [];
              if(['auto','scroll','hidden','clip'].includes(style.overflowX) && (r.left<clip.left-1 || r.right>clip.right+1)) return [];
            }
            const x=r.left+r.width/2;
            const y=r.top+r.height/2;
            const hit=document.elementFromPoint(x,y);
            return hit && (hit===el || el.contains(hit)) ? [] : [{tag:el.tagName,id:el.id||'',text:(el.innerText||el.getAttribute('aria-label')||'').trim().slice(0,45),rect:{left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom)},hit:{tag:hit?.tagName||'',id:hit?.id||'',class:String(hit?.className||'').slice(0,80)}}];
          });
          return {id:page.id,horizontalOverflow,clipped,blocked};
        });
        await page.screenshot({path:path.join(results,`page-${mode}-${size.width}-${id}.png`)});
        await page.evaluate(()=>{const main=document.querySelector('.main');main.scrollTop=main.scrollHeight;});
        await page.waitForTimeout(50);
        const bottomBlocked=await page.evaluate(()=>{
          const page=document.querySelector('.page.active');
          return [...page.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].flatMap(el=>{
            const r=el.getBoundingClientRect();
            if(!r.width || !r.height || r.left<0 || r.top<0 || r.right>innerWidth || r.bottom>innerHeight) return [];
            for(let parent=el.parentElement;parent;parent=parent.parentElement){
              const style=getComputedStyle(parent),clip=parent.getBoundingClientRect();
              if(['auto','scroll','hidden','clip'].includes(style.overflowY) && (r.top<clip.top-1 || r.bottom>clip.bottom+1)) return [];
              if(['auto','scroll','hidden','clip'].includes(style.overflowX) && (r.left<clip.left-1 || r.right>clip.right+1)) return [];
            }
            const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
            return hit && (hit===el || el.contains(hit)) ? [] : [{tag:el.tagName,id:el.id||'',text:(el.innerText||el.getAttribute('aria-label')||'').trim().slice(0,45),hit:{tag:hit?.tagName||'',id:hit?.id||'',class:String(hit?.className||'').slice(0,80)}}];
          });
        });
        if(result.horizontalOverflow || result.clipped.length || result.blocked.length || bottomBlocked.length) pageIssues.push({mode,width:size.width,...result,bottomBlocked});
        await page.evaluate(()=>{const main=document.querySelector('.main');main.scrollTop=0;});
      }
      await page.locator('.nav[data-page="home"]').click();
      await page.waitForFunction(()=>document.querySelector('#page-home')?.classList.contains('active'));
    }
    console.log(JSON.stringify({result:pageIssues.length?'issues-found':'passed',pageCount:pageIds.length,viewports:[1480,1180],themes:2,issues:pageIssues},null,2));
    if(pageIssues.length) process.exitCode=1;
  } finally {
    if(app) await app.close();
    const relative=path.relative(os.tmpdir(),temporary);
    if(!relative.startsWith('tenying-interface-') || relative.includes(path.sep)) throw Error('Unsafe test cleanup');
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
