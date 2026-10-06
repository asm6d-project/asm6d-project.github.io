import * as THREE from './assets/vendor/three.module.min.js';

const COLORS=[0x8d959e,0xc8d5df,0x7190b0,0x173f6b];

export class ShapeViewer{
  constructor(root,{reducedMotion=false,panels=4,columns=4,flow=false}={}){
    this.root=root;this.canvas=root.querySelector('canvas');this.fallback=root.querySelector('.shape-fallback');
    this.renderer=new THREE.WebGLRenderer({canvas:this.canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
    this.renderer.setClearColor(0xffffff,1);this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    this.columns=columns;this.flow=flow;this.requestId=0;
    this.scenes=Array.from({length:panels},(_,i)=>this.makeScene(COLORS[i%4]));
    this.camera=new THREE.OrthographicCamera(-1.15,1.15,1.15,-1.15,.01,20);
    this.azimuth=.72;this.elevation=.34;this.zoom=1;this.playing=!reducedMotion;this.drag=null;this.last=performance.now();
    this.installEvents();this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(root);this.resize();
    this.visible=false;this.suspended=false;
    this.visibilityObserver=new IntersectionObserver(entries=>{this.visible=entries[0].isIntersecting;});this.visibilityObserver.observe(root);
    document.addEventListener('fullscreenchange',()=>requestAnimationFrame(()=>this.resize()));
    this.renderer.setAnimationLoop(time=>this.render(time));
  }

  makeScene(color){
    const scene=new THREE.Scene();scene.background=new THREE.Color(0xffffff);scene.add(new THREE.HemisphereLight(0xffffff,0xdbe2e8,1.7));
    const key=new THREE.DirectionalLight(0xffffff,2.1);key.position.set(3,4,5);scene.add(key);const group=new THREE.Group();scene.add(group);return{scene,group,color};
  }

  installEvents(){
    this.canvas.addEventListener('pointerdown',event=>{this.drag={x:event.clientX,y:event.clientY};this.canvas.setPointerCapture(event.pointerId);});
    this.canvas.addEventListener('pointermove',event=>{if(!this.drag)return;this.azimuth-=(event.clientX-this.drag.x)*.009;this.elevation=Math.max(-1.15,Math.min(1.15,this.elevation+(event.clientY-this.drag.y)*.007));this.drag={x:event.clientX,y:event.clientY};});
    this.canvas.addEventListener('pointerup',()=>{this.drag=null;});this.canvas.addEventListener('pointercancel',()=>{this.drag=null;});
    this.canvas.addEventListener('wheel',event=>{event.preventDefault();this.zoom=Math.max(.72,Math.min(2.1,this.zoom*Math.exp(-event.deltaY*.001)));},{passive:false});
    this.canvas.addEventListener('keydown',event=>{
      const step=.12;
      if(event.key==='ArrowLeft')this.azimuth+=step;
      else if(event.key==='ArrowRight')this.azimuth-=step;
      else if(event.key==='ArrowUp')this.elevation=Math.min(1.15,this.elevation+step);
      else if(event.key==='ArrowDown')this.elevation=Math.max(-1.15,this.elevation-step);
      else if(event.key==='+'||event.key==='=')this.zoom=Math.min(2.1,this.zoom*1.1);
      else if(event.key==='-')this.zoom=Math.max(.72,this.zoom/1.1);
      else return;
      event.preventDefault();
    });
    this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.contextLost=true;this.canvas.hidden=true;this.fallback.hidden=false;});
    this.canvas.addEventListener('webglcontextrestored',()=>{this.contextLost=false;this.canvas.hidden=false;this.fallback.hidden=true;});
  }

  async load(item){
    const request=++this.requestId;
    try{
      const [geometryResponse,colorResponse]=await Promise.all([fetch(item.geometry),fetch(item.colors)]);
      if(!geometryResponse.ok)throw new Error(`geometry fetch failed: ${geometryResponse.status}`);
      if(!colorResponse.ok)throw new Error(`color fetch failed: ${colorResponse.status}`);
      const values=new Float32Array(await geometryResponse.arrayBuffer());
      const colors=new Uint8Array(await colorResponse.arrayBuffer());
      const mesh=item.gtMesh;
      const meshValues=mesh?await Promise.all(['positions','indices','colors'].map(async key=>{
        const response=await fetch(mesh[key]);if(!response.ok)throw new Error('GT mesh unavailable');return response.arrayBuffer();
      })):null;
      if(request!==this.requestId)return;
      let offset=0,colorOffset=0;
      for(let index=0;index<this.scenes.length;index++){
        const count=item.counts[index],points=values.subarray(offset,offset+count*3),rgb=colors.subarray(colorOffset,colorOffset+count*3);
        offset+=count*3;colorOffset+=count*3;
        if(index===1&&meshValues)this.setMesh(this.scenes[index],meshValues);
        else this.setPoints(this.scenes[index],points,rgb,count,item.radius||.026);
        if(item.displayRotation){const r=item.displayRotation,m=new THREE.Matrix4();m.set(r[0][0],r[0][1],r[0][2],0,r[1][0],r[1][1],r[1][2],0,r[2][0],r[2][1],r[2][2],0,0,0,0,1);this.scenes[index].group.quaternion.setFromRotationMatrix(m);}
      }
      this.item=item;this.fallback.src=item.poster||'';this.fallback.alt=`Shape completion comparison for ${item.label}`;this.canvas.hidden=false;this.fallback.hidden=true;this.reset();
      this.root.dataset.object=item.label;this.root.dataset.mesh=String(Boolean(item.gtMesh));
      if(this.contextLost){this.canvas.hidden=true;this.fallback.hidden=false;}
    }catch(error){if(request!==this.requestId)return;console.error(error);this.fallback.src=item.poster||'';this.canvas.hidden=true;this.fallback.hidden=false;}
  }

  clearPanel(panel){
    for(const child of [...panel.group.children]){panel.group.remove(child);child.geometry.dispose();child.material.dispose();}
  }

  setMesh(panel,buffers){
    this.clearPanel(panel);
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(buffers[0]),3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(buffers[1]),1));
    const bytes=new Uint8Array(buffers[2]),rgb=new Float32Array(bytes.length),color=new THREE.Color();
    for(let i=0;i<bytes.length;i+=3){color.setRGB(bytes[i]/255,bytes[i+1]/255,bytes[i+2]/255,THREE.SRGBColorSpace);rgb.set([color.r,color.g,color.b],i);}
    geometry.setAttribute('color',new THREE.BufferAttribute(rgb,3));geometry.computeVertexNormals();
    panel.group.add(new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.82,side:THREE.DoubleSide})));
  }

  setPoints(panel,points,colors,count,radius){
    this.clearPanel(panel);
    const geometry=new THREE.SphereGeometry(radius,10,7),material=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.68,metalness:0});
    const cloud=new THREE.InstancedMesh(geometry,material,count),matrix=new THREE.Matrix4(),color=new THREE.Color();
    for(let i=0;i<count;i++){
      matrix.makeTranslation(points[3*i],points[3*i+1],points[3*i+2]);cloud.setMatrixAt(i,matrix);
      color.setRGB(colors[3*i]/255,colors[3*i+1]/255,colors[3*i+2]/255,THREE.SRGBColorSpace);cloud.setColorAt(i,color);
    }
    cloud.instanceMatrix.needsUpdate=true;cloud.instanceColor.needsUpdate=true;panel.group.add(cloud);
  }

  resize(){const width=Math.max(1,this.root.clientWidth),height=Math.max(1,this.root.clientHeight);this.renderer.setSize(width,height,false);this.width=width;this.height=height;}
  viewports(){
    const columns=this.flow?4:(matchMedia('(max-width:820px)').matches?2:this.columns),rows=Math.ceil(this.scenes.length/columns);
    return this.scenes.map((_,i)=>{const col=i%columns,row=Math.floor(i/columns);const x=Math.floor(col*this.width/columns),y=Math.floor((rows-row-1)*this.height/rows);return[x,y,Math.floor((col+1)*this.width/columns)-x,Math.floor((rows-row)*this.height/rows)-y];});
  }
  render(time){
    const dt=Math.min(.05,(time-this.last)/1000);this.last=time;if(!this.visible||this.root.hidden||this.canvas.hidden||this.contextLost)return;
    if(this.playing&&!this.drag&&!this.suspended)this.azimuth+=dt*.24;
    const radius=3.3,cos=Math.cos(this.elevation);this.camera.zoom=this.zoom;
    this.camera.position.set(radius*cos*Math.sin(this.azimuth),radius*Math.sin(this.elevation),radius*cos*Math.cos(this.azimuth));
    this.camera.lookAt(0,0,0);this.camera.updateMatrixWorld();this.renderer.setScissorTest(true);
    this.viewports().forEach((viewport,index)=>{const[x,y,w,h]=viewport;this.renderer.setViewport(x,y,w,h);this.renderer.setScissor(x,y,w,h);const aspect=w/h;if(aspect<1){this.camera.left=-1.15;this.camera.right=1.15;this.camera.top=1.15/aspect;this.camera.bottom=-1.15/aspect;}else{this.camera.left=-1.15*aspect;this.camera.right=1.15*aspect;this.camera.top=1.15;this.camera.bottom=-1.15;}this.camera.updateProjectionMatrix();this.renderer.render(this.scenes[index].scene,this.camera);});this.renderer.setScissorTest(false);
  }
  toggle(){this.playing=!this.playing;return this.playing;}reset(){this.azimuth=this.flow?0:.72;this.elevation=this.flow?0:.34;this.zoom=this.flow?1.35:1;}
}

export class FlowViewer extends ShapeViewer{
  constructor(root,options={}){super(root,{...options,panels:8,flow:true});this.playing=false;this.reset();}
  async loadFlow(item){
    const request=++this.requestId;
    try{
      const [response,colorResponse]=await Promise.all([fetch(item.geometry),fetch(item.colors)]);
      if(!response.ok||!colorResponse.ok)throw new Error('Flow geometry or correspondence colors unavailable');
      const [geometryBuffer,colorBuffer]=await Promise.all([response.arrayBuffer(),colorResponse.arrayBuffer()]);
      const states=new Float32Array(geometryBuffer),rgb=new Uint8Array(colorBuffer);if(request!==this.requestId)return;
      if(states.length!==item.seeds.length*item.trajectoryStates*item.pointCount*3||rgb.length!==item.pointCount*3)throw new Error('Invalid flow asset dimensions');
      this.states=states;this.item=item;this.state=-1;this.fallback.src=item.poster;
      this.scenes.forEach(panel=>this.setPoints(panel,new Float32Array(item.pointCount*3),rgb,item.pointCount,item.radius));
      this.canvas.hidden=false;this.fallback.hidden=true;this.setState(item.trajectoryStates-1);
      this.root.dataset.object=item.label;
      if(this.contextLost){this.canvas.hidden=true;this.fallback.hidden=false;}
    }catch(error){if(request!==this.requestId)return;this.canvas.hidden=true;this.fallback.src=item.poster;this.fallback.hidden=false;console.error(error);}
  }
  setState(state){
    if(!this.states||this.state===state)return;this.state=state;
    const matrix=new THREE.Matrix4(),count=this.item.pointCount;
    this.scenes.forEach((panel,seed)=>{const cloud=panel.group.children[0],offset=(seed*this.item.trajectoryStates+state)*count*3;
      for(let i=0;i<count;i++){const j=offset+i*3;matrix.makeTranslation(this.states[j],this.states[j+1],this.states[j+2]);cloud.setMatrixAt(i,matrix);}
      cloud.instanceMatrix.needsUpdate=true;cloud.computeBoundingSphere();
    });
  }
}
