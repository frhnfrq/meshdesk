import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
export const LIGHTING={sunIntensity:3,sunColor:'#ffffff',sunAzimuth:135,sunElevation:45,ambientIntensity:1,ambientColor:'#dfe8ff',shadows:true,exposure:1};
export const ENVIRONMENT={type:'sky',color:'#15171b',topColor:'#6fa8ff',bottomColor:'#e8eef7',imageAssetId:'',turbidity:6,rayleigh:1.5,showBackground:true,ground:'grid'};
const number=(value,fallback,min=-100000,max=100000)=>{const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;};
const triple=(value,fallback,min,max)=>{const list=Array.isArray(value)?value:typeof value==='number'?[value,value,value]:[];return [0,1,2].map(i=>number(list[i],fallback[i],min,max));};
const color=(value,fallback)=>/^#[0-9a-f]{6}$/i.test(value||'')?value.toLowerCase():fallback;
const text=(value,fallback)=>String(value??'').replace(/[\x00-\x1f]/g,' ').trim().slice(0,120)||fallback;

/**
 * Scenes arrange library models with lighting and a sky. Units are metres with Y up; rotations are
 * degrees. Everything coming from the viewer or the agent goes through clean(), so stored scenes are always well-formed.
 */
export class Scenes{
 constructor({file,catalog,broadcast=()=>{}}){Object.assign(this,{file,catalog,broadcast});this.items=[];this.queue=Promise.resolve();}
 async init(){try{const saved=JSON.parse(await fs.readFile(this.file,'utf8'));this.items=(Array.isArray(saved)?saved:[]).filter(s=>/^[a-f0-9]{12}$/.test(s?.id)).map(s=>this.clean(s,s));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}}
 model(id){const asset=this.catalog.get(id);if(!asset||asset.type!=='model')throw Error('Scene objects must be models from this library. Use library_list for IDs.');return asset;}
 item(input,previous={}){const asset=this.model(input.assetId??previous.assetId);return {id:/^[a-f0-9]{8}$/.test(input.id||'')?input.id:previous.id||randomBytes(4).toString('hex'),assetId:asset.id,name:text(input.name??previous.name,asset.name),position:triple(input.position??previous.position,[0,0,0]),rotation:triple(input.rotation??previous.rotation,[0,0,0],-36000,36000),scale:triple(input.scale??previous.scale,[1,1,1],-1000,1000).map(v=>Math.abs(v)<.0001?.0001:v),visible:(input.visible??previous.visible)!==false};}
 lighting(input={},base=LIGHTING){return {sunIntensity:number(input.sunIntensity,base.sunIntensity,0,20),sunColor:color(input.sunColor,base.sunColor),sunAzimuth:number(input.sunAzimuth,base.sunAzimuth,-360,360),sunElevation:number(input.sunElevation,base.sunElevation,-10,90),ambientIntensity:number(input.ambientIntensity,base.ambientIntensity,0,10),ambientColor:color(input.ambientColor,base.ambientColor),shadows:input.shadows===undefined?base.shadows:!!input.shadows,exposure:number(input.exposure,base.exposure,.05,5)};}
 environment(input={},base=ENVIRONMENT){const image=input.imageAssetId===undefined?base.imageAssetId:String(input.imageAssetId||'');if(image&&!['texture','reference'].includes(this.catalog.get(image)?.type))throw Error('The environment image must be an image or texture from this library.');return {type:['sky','color','gradient','image'].includes(input.type)?input.type:base.type,color:color(input.color,base.color),topColor:color(input.topColor,base.topColor),bottomColor:color(input.bottomColor,base.bottomColor),imageAssetId:image,turbidity:number(input.turbidity,base.turbidity,0,20),rayleigh:number(input.rayleigh,base.rayleigh,0,6),showBackground:input.showBackground===undefined?base.showBackground:!!input.showBackground,ground:['grid','plane','none'].includes(input.ground)?input.ground:base.ground};}
 clean(input,previous={}){const items=Array.isArray(input.items)?input.items.slice(0,500):previous.items||[],seen=new Set(),kept=[];for(const raw of items){let item;try{item=this.item(raw);}catch{continue;}if(seen.has(item.id))item.id=randomBytes(4).toString('hex');seen.add(item.id);kept.push(item);}
  return {id:previous.id||randomBytes(6).toString('hex'),name:text(input.name??previous.name,'Untitled scene'),items:kept,lighting:this.lighting(input.lighting,previous.lighting||LIGHTING),environment:this.environment(input.environment,previous.environment||ENVIRONMENT),updatedAt:new Date().toISOString()};}
 list(){return structuredClone(this.items);}
 get(id){const scene=this.items.find(s=>s.id===id);if(!scene)throw Error('Scene not found. Use scene_list for IDs.');return scene;}
 has(id){return this.items.some(s=>s.id===id);}
 change(fn){const task=this.queue.then(async()=>{const result=await fn();await fs.writeFile(this.file+'.tmp',JSON.stringify(this.items,null,2));await fs.rename(this.file+'.tmp',this.file);this.broadcast({type:'scenes',scenes:this.list()});return structuredClone(result);});this.queue=task.catch(()=>{});return task;}
 create(input={}){return this.change(()=>{if(this.items.length>=200)throw Error('This project already has 200 scenes.');const scene=this.clean({...input,name:input.name||'Scene '+(this.items.length+1)});this.items.push(scene);return scene;});}
 replace(id,input){return this.change(()=>{const index=this.items.findIndex(s=>s.id===id);if(index<0)throw Error('Scene not found.');return this.items[index]=this.clean(input,this.items[index]);});}
 remove(id){return this.change(()=>{this.get(id);this.items=this.items.filter(s=>s.id!==id);return {id,removed:true};});}
 /** Applies a list of small operations, the form the agent uses. All of them succeed or none are saved. */
 apply(id,operations){return this.change(()=>{if(!Array.isArray(operations)||!operations.length||operations.length>200)throw Error('Supply between 1 and 200 scene changes.');const index=this.items.findIndex(s=>s.id===id);if(index<0)throw Error('Scene not found. Use scene_list for IDs.');const scene=structuredClone(this.items[index]);
  const find=ref=>{const item=scene.items.find(i=>i.id===ref)||scene.items.find(i=>i.name.toLowerCase()===String(ref||'').toLowerCase());if(!item)throw Error('No scene object "'+ref+'". Use the itemId values from scene_get.');return item;};
  for(const change of operations){if(!change||typeof change!=='object')throw Error('Each scene change must be an object with an "op".');
   switch(change.op){
    case 'add':if(scene.items.length>=500)throw Error('A scene holds up to 500 objects.');scene.items.push(this.item(change));break;
    case 'update':{const item=find(change.itemId??change.name);Object.assign(item,this.item({...change,id:item.id,name:change.newName??(change.itemId?change.name:undefined)??item.name,assetId:change.assetId??item.assetId},item));break;}
    case 'remove':{const item=find(change.itemId??change.name);scene.items=scene.items.filter(i=>i!==item);break;}
    case 'clear':scene.items=[];break;
    case 'lighting':scene.lighting=this.lighting(change,scene.lighting);break;
    case 'environment':scene.environment=this.environment(change,scene.environment);break;
    case 'rename':scene.name=text(change.name,scene.name);break;
    default:throw Error('Unknown scene change "'+change.op+'". Use add, update, remove, clear, lighting, environment or rename.');
   }}
  scene.updatedAt=new Date().toISOString();return this.items[index]=scene;});}
}
