import {ShapeViewer,FlowViewer} from './shape-viewer.js';

const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
let activeMedia=null;
let autoplayRoot=null;
let manualPlaybackRoot=null;
let flowProgress=reducedMotion ? 1 : 0;
let preserveFlowProgress=false;
const flowVideoCache=new Map();
let flowItem=null,flowViewer=null,orbitEnabled=false;
const geometryViewers=[];
const manuallyPaused=new WeakSet();
let libraryVideos=[];
let libraryControl=null;

function playbackButton(label){
  const button=document.createElement('button');
  button.type='button';button.className='playback-toggle';
  button.dataset.mediaLabel=label;
  const icon=document.createElement('img');icon.alt='';button.append(icon);
  return button;
}

function updatePlaybackButton(button,playing,ended=false){
  const action=playing?'Pause':ended?'Replay':'Play';
  $('img',button).src=playing?'assets/vendor/icons/pause.svg':ended?'assets/vendor/icons/rotate-ccw.svg':'assets/vendor/icons/play.svg';
  button.setAttribute('aria-label',`${action} ${button.dataset.mediaLabel}`);
  button.setAttribute('aria-pressed',String(playing));button.title=button.getAttribute('aria-label');
}

function toggleMedia(video){
  if(video.paused)playMedia(video,{replay:true,manual:true});
  else{manuallyPaused.add(video);manualPlaybackRoot=null;video.pause();}
}

function videoPlaybackButton(video,label){
  const button=playbackButton(label);
  const update=()=>updatePlaybackButton(button,!video.paused&&!video.ended,video.ended);
  button.addEventListener('click',()=>toggleMedia(video));
  ['play','pause','ended','loadedmetadata'].forEach(event=>video.addEventListener(event,update));
  update();return button;
}

function flowState(progress){
  const frames=flowItem?.frameStates;
  return frames?.length?frames[Math.min(frames.length-1,Math.floor(progress*frames.length))]:0;
}
function showFlowPhase(progress){
  const state=flowState(progress),time=flowItem?.times?.[state]??1;
  $('.flow-timeline output').textContent=`t = ${time.toFixed(2)}`;
  if(orbitEnabled)flowViewer?.setState(state);
}

function setupTheme(){
  const button=$('#theme-toggle');
  const apply=dark=>{document.documentElement.dataset.theme=dark?'dark':'light';button.textContent=dark?'☀':'☾';button.setAttribute('aria-pressed',String(dark));button.setAttribute('aria-label',dark?'Switch to light reading mode':'Switch to dark reading mode');button.title=dark?'Light reading mode':'Dark reading mode';};
  let saved=null;try{saved=localStorage.getItem('asm6d-theme');}catch{}
  apply(saved==='dark');
  button.addEventListener('click',()=>{const dark=document.documentElement.dataset.theme!=='dark';apply(dark);try{localStorage.setItem('asm6d-theme',dark?'dark':'light');}catch{}});
}

function pauseOtherMedia(video){
  geometryViewers.forEach(viewer=>{viewer.suspended=true;});
  const synchronizedGrid=video.closest('.template-explorer');
  $$('video').forEach(candidate=>{
    if(candidate===video)return;
    if(synchronizedGrid&&candidate.closest('.template-explorer')===synchronizedGrid)return;
    candidate.pause();
  });
  activeMedia=video;
  autoplayRoot=video.closest('.template-explorer')||video.closest('.media-button')||video.closest('.main-video');
}

function isAutoplayTarget(video){
  return autoplayRoot!==null&&(video.closest('.template-explorer')||video.closest('.media-button'))===autoplayRoot;
}

function playMedia(video,{replay=false,manual=false}={}){
  if(video.dataset.loading==='true')return Promise.resolve();
  if(manual){manuallyPaused.delete(video);manualPlaybackRoot=video.closest('.template-explorer')||video.closest('.media-button');}
  else if(manuallyPaused.has(video))return Promise.resolve();
  pauseOtherMedia(video);
  if(video.id==='flow-video'&&(video.ended||(Number.isFinite(video.duration)&&video.currentTime>=video.duration-.001))){
    if(!replay)return Promise.resolve();
    video.currentTime=.001;flowProgress=0;$('#flow-scrubber').value='0';showFlowPhase(0);
  }
  return video.play().catch(()=>{});
}

function activate(group,button){
  $$('button',group).forEach(candidate=>{
    const selected=candidate===button;
    candidate.classList.toggle('active',selected);
    candidate.setAttribute('aria-selected',String(selected));
  });
}

function installKeys(group){
  group.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
    const buttons=$$('button',group);
    const current=Math.max(0,buttons.indexOf(document.activeElement));
    const next=(current+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    buttons[next].focus();buttons[next].click();event.preventDefault();
  });
}

function setVideo(video,src,poster,{autoplay=true}={}){
  video.pause();video.removeAttribute('src');
  if(src)video.src=src;
  if(poster)video.poster=poster;
  video.load();
  if(src&&autoplay&&!reducedMotion&&isAutoplayTarget(video))playMedia(video);
}

function buildTabs(group,items,onSelect,{previews=false}={}){
  group.replaceChildren();
  items.forEach((item,index)=>{
    const button=document.createElement('button');
    button.type='button';button.role='tab';
    if(previews&&item.poster){
      button.classList.add('preview-tab');
      const image=document.createElement('img');image.src=item.poster;image.alt='';image.loading='lazy';
      const label=document.createElement('span');label.textContent=item.label;button.append(image,label);
    }else button.textContent=item.label;
    button.dataset.index=String(index);
    if(index===0)button.classList.add('active');
    button.setAttribute('aria-selected',String(index===0));
    button.addEventListener('click',()=>{activate(group,button);onSelect(item,index);});
    group.append(button);
  });
  installKeys(group);
  if(items.length)onSelect(items[0],0);
}

function attachTimeline(container,video,{format}={}){
  const timeline=document.createElement('div');timeline.className='media-timeline has-playback-control';
  const range=document.createElement('input');range.type='range';range.min='0';range.max='1000';range.value='0';range.setAttribute('aria-label','Video progress');
  const output=document.createElement('output');output.textContent='0:00';
  const update=()=>{
    if(!Number.isFinite(video.duration)||video.duration<=0)return;
    const progress=video.currentTime/video.duration;
    range.value=String(Math.round(progress*1000));
    output.textContent=format?format(progress,video):`${Math.floor(video.currentTime/60)}:${String(Math.floor(video.currentTime%60)).padStart(2,'0')}`;
  };
  range.addEventListener('input',()=>{
    if(!Number.isFinite(video.duration))return;
    video.currentTime=(Number(range.value)/1000)*video.duration;update();
  });
  range.addEventListener('change',()=>{if(!reducedMotion)playMedia(video);});
  video.addEventListener('timeupdate',update);video.addEventListener('loadedmetadata',update);
  timeline.append(videoPlaybackButton(video,`${container.dataset.comparison||'video'} comparison`),range,output);container.append(timeline);
  return {range,output,update};
}

function setupMainMedia(main,overview){
  const video=$('#main-video');const placeholder=$('#main-video-placeholder');
  if(main?.available&&main.src){
    video.controls=true;setVideo(video,main.src,main.poster);placeholder.hidden=true;
    if(main.width&&main.height)$('#main-video-shell').style.aspectRatio=`${main.width}/${main.height}`;
    video.addEventListener('play',()=>pauseOtherMedia(video));
  }
  else{video.controls=false;video.removeAttribute('controls');if(main?.poster)video.poster=main.poster;}
  if(overview?.available&&overview.src){const figure=$('#method-overview');$('img',figure).src=overview.src;figure.hidden=false;}
}

function setupTemplates(items){
  const grid=$('#template-grid');const reel=$('#instance-reel');const reelVideo=$('video',reel);
  grid.replaceChildren();
  items.forEach((item,index)=>{
    const button=document.createElement('button');
    button.type='button';button.role='tab';button.className=`template-tile${index===0?' active':''}`;
    button.dataset.index=String(index);
    button.setAttribute('aria-selected',String(index===0));
    const video=document.createElement('video');video.muted=true;video.loop=true;video.playsInline=true;video.preload='none';video.dataset.autoplay='';
    video.src=item.mean.src;video.poster=item.mean.poster||'';
    const label=document.createElement('span');label.textContent=item.label;button.append(video,label);
    button.addEventListener('click',()=>{activate(grid,button);if(item.instances?.src){reel.hidden=false;setVideo(reelVideo,item.instances.src,item.instances.poster);}else reel.hidden=true;});
    grid.append(button);
  });
  installKeys(grid);const first=$('button',grid);if(first)first.click();
  libraryVideos=$$('video',grid);
  libraryControl=playbackButton('shape library');libraryControl.id='library-play';
  const update=()=>updatePlaybackButton(libraryControl,libraryVideos.some(video=>!video.paused));
  libraryVideos.forEach(video=>['play','pause'].forEach(event=>video.addEventListener(event,update)));
  libraryControl.addEventListener('click',()=>{
    const playing=libraryVideos.some(video=>!video.paused);
    libraryVideos.forEach(video=>{if(playing){manuallyPaused.add(video);video.pause();}else playMedia(video,{manual:true});});
  });
  $('.subhead',grid.closest('.template-explorer')).append(libraryControl);update();
  reelVideo.dataset.autoplay='';
  const instanceToolbar=document.createElement('div');instanceToolbar.className='media-toolbar instance-playback';
  instanceToolbar.append(videoPlaybackButton(reelVideo,'category instances'));$('.column-labels',reel).after(instanceToolbar);
}

function setupComparison(name,items){
  const section=$(`[data-comparison="${name}"]`);if(!section)return;
  const valid=(items||[]).filter(item=>item.continuous!==false);
  if(!valid.length){section.hidden=true;return;}section.hidden=false;
  const video=$('[data-video]',section);
  const duration=document.createElement('span');duration.className='media-duration';$('.comparison-head>div',section).append(duration);
  buildTabs($('[data-controls]',section),valid,item=>{
    setVideo(video,item.src,item.poster);duration.textContent=item.durationSeconds?`${item.durationSeconds.toFixed(1)} s`:'';
  },{previews:true});
  attachTimeline(section,video);
  const expand=document.createElement('button');
  expand.type='button';expand.className='expand-media';expand.textContent='Full screen';
  expand.setAttribute('aria-label',`Show ${name} comparison full screen`);
  expand.addEventListener('click',()=>{
    if(video.requestFullscreen)video.requestFullscreen();
    else video.webkitEnterFullscreen?.();
  });
  section.append(expand);
}

function renderContent(content){
  $('#benchmark-strip').innerHTML=content.comparisons.map(group=>`<article class="metric-comparison"><header><strong>${group.label}</strong></header><div class="score-heading"><span>Metric</span><span>${group.baseline}</span><span>${group.ours}</span></div>${group.metrics.map(metric=>`<div class="score-row"><span>${metric.label}</span><span>${metric.baseline}</span><strong>${metric.ours}</strong></div>`).join('')}<footer>${group.protocol}</footer></article>`).join('');
  $('#classification-metrics').innerHTML=content.classification.map(item=>`<div><strong>${item.value}</strong><span>${item.label}</span></div>`).join('');
  $('#latency-chart').innerHTML=content.runtime.map((item,index)=>`<div class="latency-row${index===0?' operating-point':''}"><span class="latency-label">${item.label}</span><div class="latency-track"><div class="latency-bar" style="width:${100*Number(item.fps)/35}%"></div><i class="realtime-marker">${index===0?'<span>30 FPS</span>':''}</i></div><span class="latency-value"><strong>${Number(item.fps).toFixed(1)} FPS</strong></span></div>`).join('');
}

function setupShapeViewer(items){
  if(!items?.length)return;let viewer;
  try{viewer=new ShapeViewer($('#shape-viewer'),{reducedMotion});geometryViewers.push(viewer);}
  catch(error){const root=$('#shape-viewer');$('canvas',root).hidden=true;$('.shape-fallback',root).hidden=false;buildTabs($('#shape-controls'),items,item=>{$('.shape-fallback',root).src=item.poster;});return;}
  buildTabs($('#shape-controls'),items,item=>viewer.load(item));
  $('#shape-play').textContent=viewer.playing?'Pause':'Play';
  $('#shape-play').setAttribute('aria-label',viewer.playing?'Pause automatic rotation':'Start automatic rotation');
  $('#shape-play').addEventListener('click',event=>{const playing=viewer.toggle();event.currentTarget.textContent=playing?'Pause':'Play';event.currentTarget.setAttribute('aria-label',playing?'Pause automatic rotation':'Start automatic rotation');});
  $('#shape-reset').addEventListener('click',()=>viewer.reset());
  $('#shape-fullscreen').addEventListener('click',()=>{
    const root=$('#shape-viewer');
    if(document.fullscreenElement)document.exitFullscreen();
    else root.requestFullscreen?.();
  });
}

function setupMediaButtons(){
  $$('.media-button').forEach(button=>{const video=$('video',button);if(video)button.addEventListener('click',event=>{if(event.target.closest('input'))return;toggleMedia(video);});});
}

function setupLightbox(){
  const dialog=$('#lightbox'),target=$('img',dialog);
  $$('[data-lightbox]').forEach(button=>button.addEventListener('click',()=>{const source=$('img',button);target.src=source.src;target.alt=source.alt;dialog.showModal();}));
  $('.icon-button',dialog).addEventListener('click',()=>dialog.close());dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
}

function setupViewportPlayback(){
  const visible=new Map();
  const choose=()=>{
    if(reducedMotion)return;
    const candidates=[...visible.entries()].filter(([element,visibility])=>visibility.ratio>.12&&!element.hidden&&
      (element.matches('.template-explorer,.shape-viewer,.flow-viewer')||$('video[data-autoplay]',element))).sort((a,b)=>b[1].area-a[1].area);
    if(!candidates.length){autoplayRoot=null;return;}
    const [element]=candidates.find(([candidate])=>candidate===manualPlaybackRoot)||candidates[0];
    autoplayRoot=element;
    geometryViewers.forEach(viewer=>{viewer.suspended=viewer.root!==element;});
    if(element.matches('.shape-viewer,.flow-viewer')){$$('video').forEach(video=>video.pause());activeMedia=null;return;}
    const videos=$$('video[data-autoplay]',element).filter(video=>!video.closest('[hidden]'));
    if(element.matches('.template-explorer')){
      $$('video').forEach(video=>{if(!video.closest('.template-explorer'))video.pause();});
      videos.filter(video=>!manuallyPaused.has(video)).forEach(video=>video.play().catch(()=>{}));activeMedia=videos[0]||null;
    }else if(videos[0]&&(videos[0]!==activeMedia||videos[0].paused))playMedia(videos[0]);
  };
  const observer=new IntersectionObserver(entries=>{entries.forEach(entry=>{entry.target.classList.toggle('is-visible',entry.isIntersecting);visible.set(entry.target,{ratio:entry.intersectionRatio,area:entry.intersectionRect.width*entry.intersectionRect.height});if(!entry.isIntersecting)$$('video',entry.target).forEach(video=>video.pause());});choose();},{rootMargin:'60px 0px',threshold:[0,.12,.35,.65]});
  $$('.media-button,.template-explorer,.shape-viewer,.flow-viewer').filter(element=>
    element.matches('.template-explorer')||!element.closest('.template-explorer')).forEach(element=>observer.observe(element));
}

function setupFlowScrubber(){
  const video=$('#flow-video'),range=$('#flow-scrubber'),output=$('.flow-timeline output');
  const timeline=$('.flow-timeline');timeline.classList.add('has-playback-control');
  timeline.prepend(videoPlaybackButton(video,'flow animation'));
  const showPhase=showFlowPhase;
  const update=()=>{
    if(preserveFlowProgress||!Number.isFinite(video.duration)||video.duration<=0)return;
    const raw=video.currentTime/video.duration;
    range.value=String(Math.round(raw*1000));
    flowProgress=raw;showPhase(raw);
  };
  range.addEventListener('input',()=>{flowProgress=Number(range.value)/1000;showPhase(flowProgress);if(orbitEnabled){video.pause();return;}preserveFlowProgress=true;if(Number.isFinite(video.duration)){video.pause();video.addEventListener('seeked',()=>{preserveFlowProgress=false;},{once:true});video.currentTime=flowProgress*video.duration;}});
  range.addEventListener('change',()=>{if(!reducedMotion&&!orbitEnabled)playMedia(video);});
  video.addEventListener('timeupdate',update);video.addEventListener('loadedmetadata',update);
  const button=video.closest('button');
  video.addEventListener('ended',()=>{update();button.setAttribute('aria-label','Replay flow animation');});
  video.addEventListener('play',()=>button.setAttribute('aria-label','Pause flow animation'));
  video.addEventListener('pause',()=>button.setAttribute('aria-label',video.ended?'Replay flow animation':'Play flow animation'));
}

function setupFlowExamples(items){
  if(!items?.length)return;
  const video=$('#flow-video'),range=$('#flow-scrubber'),output=$('.flow-timeline output'),rgb=$('#flow-rgb'),depth=$('#flow-depth');
  let requestId=0,loadEvents=null;
  const cachedSource=src=>{
    if(!flowVideoCache.has(src))flowVideoCache.set(src,fetch(src).then(response=>{if(!response.ok)throw new Error(`Flow media unavailable: ${src}`);return response.blob();}).then(blob=>URL.createObjectURL(blob)));
    return flowVideoCache.get(src);
  };
  buildTabs($('#flow-controls'),items,async item=>{
    const selected=++requestId;
    const progress=flowProgress;
    loadEvents?.abort();loadEvents=new AbortController();
    const signal=loadEvents.signal;
    preserveFlowProgress=true;video.dataset.loading='true';
    $('.flow-output').setAttribute('aria-busy','true');
    flowItem=item;showFlowPhase(progress);
    if(orbitEnabled)flowViewer.loadFlow(item).then(()=>showFlowPhase(flowProgress));
    rgb.src=item.inputs.rgb;depth.src=item.inputs.depth;
    rgb.alt=`RGB crop for the ${item.label.toLowerCase()} completion example`;
    depth.alt=`Metric depth crop for the ${item.label.toLowerCase()} completion example`;
    video.dataset.source=item.src;
    // Clear the old decoded frame before updating the conditioning crop.
    setVideo(video,null,item.poster,{autoplay:false});
    let source;
    try{source=await cachedSource(item.src);}catch{
      if(selected===requestId){preserveFlowProgress=false;delete video.dataset.loading;$('.flow-output').setAttribute('aria-busy','false');}
      return;
    }
    if(selected!==requestId)return;
    let restoring=false;
    const resume=()=>{if(selected!==requestId)return;preserveFlowProgress=false;delete video.dataset.loading;$('.flow-output').setAttribute('aria-busy','false');if(!reducedMotion&&!orbitEnabled&&isAutoplayTarget(video))playMedia(video);};
    const restore=()=>{
      if(selected!==requestId||restoring)return;
      if(!Number.isFinite(video.duration))return;
      restoring=true;
      const progress=flowProgress;
      video.pause();range.value=String(Math.round(progress*1000));
      showFlowPhase(progress);
      // A tiny nonzero seek clears the completed poster even when starting at t=1.
      const target=Math.max(.001,Math.min(progress*video.duration,video.duration-1/item.fps));
      if(video.readyState>=2&&Math.abs(video.currentTime-target)<.0001){resume();return;}
      video.addEventListener('seeked',resume,{once:true,signal});video.currentTime=target;
    };
    video.addEventListener('loadedmetadata',restore,{once:true,signal});
    video.addEventListener('canplay',()=>{if(preserveFlowProgress)restore();},{once:true,signal});
    setVideo(video,source,item.poster,{autoplay:false});
  });
  $('#flow-orbit').addEventListener('click',async event=>{
    orbitEnabled=!orbitEnabled;event.currentTarget.setAttribute('aria-pressed',String(orbitEnabled));event.currentTarget.textContent=orbitEnabled?'Animation':'Explore 3D';
    $('#flow-viewer').hidden=!orbitEnabled;$('.flow-media').hidden=orbitEnabled;
    if(orbitEnabled){video.pause();flowProgress=1;
      if(!flowViewer){try{flowViewer=new FlowViewer($('#flow-viewer'),{reducedMotion});geometryViewers.push(flowViewer);}catch(error){$('#flow-viewer').hidden=true;$('.flow-media').hidden=false;orbitEnabled=false;event.currentTarget.textContent='Explore 3D';event.currentTarget.setAttribute('aria-pressed','false');return;}}
      await flowViewer.loadFlow(flowItem);$('#flow-scrubber').value=String(Math.round(flowProgress*1000));showFlowPhase(flowProgress);
    }else if(Number.isFinite(video.duration)){video.currentTime=flowProgress*video.duration;if(!reducedMotion)playMedia(video);}
  });
}

async function init(){
  const [assetsResponse,contentResponse]=await Promise.all([fetch('data/assets.json',{cache:'no-cache'}),fetch('data/content.json',{cache:'no-cache'})]);
  if(!assetsResponse.ok||!contentResponse.ok)throw new Error('Site manifests unavailable');
  const [assets,content]=await Promise.all([assetsResponse.json(),contentResponse.json()]);
  if(assets.publication?.labMedia==='withheld'){
    $('#applications .section-heading h2').textContent='Track recovered geometry.';
    $('#applications .section-heading>p').textContent='Public-dataset tracking. Hardware demonstrations are withheld during review.';
  }
  setupMainMedia(assets.main,assets.methodOverview);setupTemplates(assets.templates||[]);
  setupFlowExamples(assets.flow||[]);
  setupComparison('rope',assets.rope);setupComparison('housecat',assets.housecat);setupComparison('tracking',assets.tracking);setupComparison('grasping',assets.grasping);
  buildTabs($('#ambiguity-controls'),assets.ambiguity||[],item=>{const image=$('#ambiguity-image');image.src=item.src;image.alt=item.alt;});
  renderContent(content);setupShapeViewer(assets.shape);setupFlowScrubber();setupMediaButtons();setupLightbox();setupViewportPlayback();setupTheme();
}

document.addEventListener('DOMContentLoaded',()=>init().catch(error=>{console.error(error);document.body.classList.add('manifest-error');}));
