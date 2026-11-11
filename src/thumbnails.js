import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';

/** Small model previews for the library list: rendered one at a time on a shared offscreen renderer, then cached. */
const SIZE=144,STORE='meshdesk-thumbnails-v1';
const memory=new Map(),queue=[];let stage=null,working=false;

function setup(){
  if(stage)return stage;
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});
  renderer.setSize(SIZE,SIZE,false);renderer.setClearColor(0x000000,0);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(32,1,.01,100);scene.add(new THREE.HemisphereLight(0xe4efff,0x64605b,2.5));
  for(const [p,intensity]of[[[3,6,5],3],[[-4,3,-3],1.8]]){const l=new THREE.DirectionalLight(0xffffff,intensity);l.position.set(...p);scene.add(l);}
  return stage={renderer,scene,camera};
}
function dispose(root){root.traverse(o=>{if(!o.isMesh)return;o.geometry?.dispose();for(const m of(Array.isArray(o.material)?o.material:[o.material])){for(const value of Object.values(m))if(value?.isTexture)value.dispose();m.dispose();}});}
async function render(url,size=SIZE){
  const {renderer,scene,camera}=setup();renderer.setSize(size,size,false);const gltf=await new GLTFLoader().loadAsync(url),root=gltf.scene;
  try{
    const bounds=new THREE.Box3().setFromObject(root),sphere=bounds.getBoundingSphere(new THREE.Sphere()),radius=Math.max(sphere.radius,.0001);
    const distance=radius/Math.sin(THREE.MathUtils.degToRad(camera.fov/2))*1.02;
    camera.position.copy(sphere.center).add(new THREE.Vector3(.72,.42,1).normalize().multiplyScalar(distance));camera.near=distance/100;camera.far=distance*10;camera.lookAt(sphere.center);camera.updateProjectionMatrix();
    scene.add(root);renderer.render(scene,camera);
    return await new Promise((resolve,reject)=>renderer.domElement.toBlob(blob=>blob?resolve(blob):reject(new Error('No thumbnail.')),'image/webp',.86));
  }finally{scene.remove(root);dispose(root);}
}
async function stored(key){try{const cache=await caches.open(STORE),hit=await cache.match(key);return hit?await hit.blob():null;}catch{return null;}}
async function store(key,blob){try{const cache=await caches.open(STORE);await cache.put(key,new Response(blob,{headers:{'Content-Type':blob.type}}));}catch{}}
async function work(){
  if(working)return;working=true;
  while(queue.length){const job=queue.shift();try{job.resolve(await render(job.url,job.size));}catch(error){job.reject(error);}await new Promise(resolve=>setTimeout(resolve,0));}
  working=false;
}

/** Resolves to an image URL for the model's current look, or rejects when it cannot be drawn. */
export function modelThumbnail(base,asset,which='current',size=SIZE){
  const live=which==='current',version=live?asset.currentVersion||'original':which,key=`${base}/thumbnails/${asset.id}?version=${encodeURIComponent(version)}&revision=${live?asset.revision||0:0}&size=${size}`;
  if(!memory.has(key))memory.set(key,(async()=>{
    let blob=await stored(key);
    if(!blob){blob=await new Promise((resolve,reject)=>{queue.push({url:`${base}/previews/${asset.id}?version=${encodeURIComponent(live?'current':version)}&revision=${asset.revision||0}`,size,resolve,reject});void work();});void store(key,blob);}
    return URL.createObjectURL(blob);
  })().catch(error=>{memory.delete(key);throw error;}));
  return memory.get(key);
}
