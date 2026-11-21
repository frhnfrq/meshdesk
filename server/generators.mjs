/**
 * Image-to-3D: turns one to four pictures of a subject into a GLB through one of three routes. "local" is a Hunyuan3D
 * API server on this machine or network, and "tripo" and "meshy" are hosted services. Which routes are on, their keys
 * and the default route are shared by every project and kept in the app's data folder, never in a project.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {imageInfo} from './web-images.mjs';
import {MODEL_IDS,MODELS} from './local-models.mjs';
import {newCode} from './sharing.mjs';
import os from 'node:os';

export const VIEWS=['front','left','back','right'];
const TRIPO='https://openapi.tripo3d.ai/v3',MESHY='https://api.meshy.ai/openapi/v1';
const TEXTURES={
 local:[{value:'none',label:'Shape only',detail:'Fastest · the only choice on a Mac'},{value:'standard',label:'Textured',detail:'Needs a server with texturing'}],
 tripo:[{value:'none',label:'Shape only',detail:'$0.20 per model'},{value:'standard',label:'Standard',detail:'$0.30 per model'},{value:'detailed',label:'HD',detail:'$0.40 per model'}],
 meshy:[{value:'none',label:'Shape only',detail:'20 credits per model'},{value:'standard',label:'Textured with PBR maps',detail:'30 credits per model'}]
};
const INFO={
 local:{label:'Local model',kind:'local',multiview:false,about:'Free. Runs an open model on this computer, or on another one on your network.',pricing:'No cost per model. Shape only, from the front view.',time:'A few minutes on a graphics card, around ten on a Mac.'},
 tripo:{label:'Tripo',kind:'cloud',multiview:true,keyUrl:'https://developers.tripo3d.ai/en/keys',about:'Hosted. Pay as you go, with a labelled slot for each view.',pricing:'Billed per model from prepaid API credits (1 credit is $0.01, top up from $1). Failed and cancelled generations are not charged.',time:'Usually one to three minutes.'},
 meshy:{label:'Meshy',kind:'cloud',multiview:true,keyUrl:'https://www.meshy.ai/developers/keys',about:'Hosted. Uses the credits of a paid Meshy plan.',pricing:'Needs a Pro plan or higher; the free plan has no API access. 30 credits is about $0.60 on Pro. Failed generations are refunded.',time:'Usually two to five minutes.'}
};
export const ROUTES=Object.keys(INFO);
const cleanModels=list=>(Array.isArray(list)?list:[]).filter(m=>m&&/^[a-z0-9-]{1,30}$/.test(m.id||'')).slice(0,20).map(m=>({id:m.id,label:String(m.label||m.id).replace(/[\x00-\x1f<>]/g,' ').trim().slice(0,60),multiview:!!m.multiview,...(m.textured?{textured:true}:{})}));
const REMOTE_TIME='About a minute on a graphics card.',plainName=value=>String(value||'').replace(/[\x00-\x1f<>]/g,' ').trim().slice(0,80);
export const TEXTURE_SIZES=[512,1024,2048,4096];
const DEFAULTS={route:'ask',hfToken:'',modelsDirectory:'',textures:{},remotes:[],share:{enabled:false,name:'',code:''},providers:{local:{enabled:false,managed:'',url:'http://127.0.0.1:8080',code:'',texture:'none'},tripo:{enabled:false,apiKey:'',texture:'standard',model:'v3.1-20260211'},meshy:{enabled:false,apiKey:'',texture:'standard',model:'latest'}}};
const cost=(id,texture)=>id==='local'?'Free':TEXTURES[id].find(t=>t.value===texture)?.detail||'';
const cleanUrl=value=>{const text=String(value||'').trim().replace(/\/+$/,'');if(!text)return '';let url;try{url=new URL(text);}catch{throw Error('The server address must look like http://127.0.0.1:8080.');}if(!['http:','https:'].includes(url.protocol))throw Error('The server address must start with http:// or https://.');return text.slice(0,300);};
const cleanKey=value=>{const key=String(value||'').trim();if(/\s/.test(key)||key.length>300)throw Error('That does not look like an API key.');return key;};

export class Generators{
 constructor(file,env=process.env){this.file=file;this.env=env;this.value=structuredClone(DEFAULTS);}
 async init(){try{this.value=this.clean({...JSON.parse(await fs.readFile(this.file,'utf8')),stored:true},structuredClone(DEFAULTS));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError)&&!/^(The server|That does|Choose)/.test(error.message))throw error;}this.identify();}
 /** Every Meshdesk has a name and a pairing code for sharing its local model, made once and kept. */
 identify(){this.value.share.name||=os.hostname().replace(/\.local$/,'').replace(/[^\w .-]/g,' ').trim().slice(0,40)||'Meshdesk';this.value.share.code||=newCode();}
 clean(input={},base){
  const value=structuredClone(base);
  for(const id of ROUTES){const change=input.providers?.[id];if(!change||typeof change!=='object')continue;const mine=value.providers[id];
   if(change.enabled!==undefined)mine.enabled=!!change.enabled;
   if(change.texture!==undefined){if(!TEXTURES[id].some(t=>t.value===change.texture))throw Error('Choose a texture setting from the list.');mine.texture=change.texture;}
   if(id==='local'&&change.url!==undefined)mine.url=cleanUrl(change.url);
   if(id==='local'&&change.code!==undefined)mine.code=String(change.code).replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,16);
   if(id==='local'&&change.managed!==undefined){if(change.managed!==''&&!MODEL_IDS.includes(change.managed))throw Error('Choose a local model from the list.');mine.managed=change.managed;}
   if(id!=='local'&&change.apiKey!==undefined)mine.apiKey=cleanKey(change.apiKey);
   if(id!=='local'&&typeof change.model==='string'&&/^[A-Za-z0-9._-]{1,60}$/.test(change.model))mine.model=change.model;}
  if(input.share&&typeof input.share==='object'){const share=input.share;if(share.enabled!==undefined)value.share.enabled=!!share.enabled;if(share.name!==undefined){const name=String(share.name).replace(/[^\w .-]/g,' ').trim().slice(0,40);if(!name)throw Error('Choose a name for this computer.');value.share.name=name;}if(typeof share.code==='string'&&/^[A-Z0-9]{8}$/.test(share.code))value.share.code=share.code;}
  if(input.hfToken!==undefined)value.hfToken=cleanKey(input.hfToken);
  // The texture size to ask for, per model on a machine ("local:trellis2", "pc-1a2b3c4d5e:trellis"). Missing means the model's own default.
  if(input.textures&&typeof input.textures==='object'){const next={...value.textures};for(const [key,size] of Object.entries(input.textures)){if(!/^[a-z0-9-]{1,30}:[a-z0-9-]{1,30}$/.test(key))throw Error('Unknown model.');if(size===null||size===0||size==='')delete next[key];else if(TEXTURE_SIZES.includes(Number(size)))next[key]=Number(size);else throw Error('Choose a texture size from the list.');}value.textures=Object.fromEntries(Object.entries(next).slice(-60));}
  if(input.modelsDirectory!==undefined){const dir=String(input.modelsDirectory||'').trim();if(dir&&(!path.isAbsolute(dir)||/[\x00-\x1f]/.test(dir)||dir.length>400))throw Error('Enter the full path of a folder, such as D:\\MeshdeskModels.');value.modelsDirectory=dir;}
  // Paired computers are only read back from the saved file; the app adds and removes them through pair and forget.
  if(input.stored===true&&Array.isArray(input.remotes))value.remotes=input.remotes.flatMap(pc=>{try{return /^[a-f0-9]{10}$/.test(pc?.id)&&cleanUrl(pc.url)?[{id:pc.id,name:plainName(pc.name)||pc.url,url:cleanUrl(pc.url),code:String(pc.code||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,16),model:/^[a-z0-9-]{1,30}$/.test(pc.model||'')?pc.model:'',models:cleanModels(pc.models),gpu:plainName(pc.gpu),...(pc.server?{server:true}:{})}]:[];}catch{return [];}}).slice(0,12);
  if(input.route!==undefined){const [base,model]=String(input.route).split(':');if(input.route!=='ask'&&(!/^[a-z0-9-]{0,30}$/.test(model||'')||!ROUTES.includes(base)&&!value.remotes.some(pc=>'pc-'+pc.id===base)))throw Error('Choose a default from the list.');value.route=String(input.route);
   // Choosing a model on this computer as the default also makes it this computer's own default, which it offers when shared.
   if(base==='local'&&model)value.providers.local={...value.providers.local,enabled:true,managed:model};}
  return value;
 }
 /** A key typed in the app wins; otherwise TRIPO_API_KEY or MESHY_API_KEY from the environment. */
 key(id){return this.value.providers[id].apiKey||this.env[id.toUpperCase()+'_API_KEY']||'';}
 /** Sent with model downloads from Hugging Face. Only needed for models that ask for an account. */
 hfToken(){return this.value.hfToken||this.env.HF_TOKEN||'';}
 /**
  * A machine can have several models installed. A route may name one after a colon, as in "local:triposg" or
  * "pc-1a2b3c4d5e:hunyuan-mv"; without it the machine's default model is used.
  */
 models(base){const pc=this.remote(base);if(pc)return pc.models||[];if(base!=='local'||!this.local)return [];return MODEL_IDS.filter(id=>this.local.isInstalled(id)).map(id=>({id,label:MODELS[id].label,multiview:!!MODELS[id].multiview,...(MODELS[id].textured?{textured:true}:{})}));}
 defaultModel(base){const list=this.models(base),wanted=base==='local'?this.value.providers.local.managed:this.remote(base)?.model;return (list.find(m=>m.id===wanted)||list[0])?.id||'';}
 split(route){const [base,model='']=String(route||'').split(':');return {base,model};}
 /** A paired computer on the network is a route of its own, named "pc-" and its id, so it can be chosen like any other. */
 remote(id){return this.value.remotes.find(pc=>'pc-'+pc.id===id);}
 routes(){return [...ROUTES,...this.value.remotes.map(pc=>'pc-'+pc.id)];}
 /** The local route is ready with a model Meshdesk installed itself, or with the address of a server elsewhere. */
 ready(id){if(this.remote(id))return true;const mine=this.value.providers[id];return !!mine?.enabled&&!!(id==='local'?(mine.managed?this.models('local').length>0:mine.url):this.key(id));}
 label(route){const {base:id,model}=this.split(route),list=this.models(id),chosen=list.find(m=>m.id===(model||this.defaultModel(id)));const pc=this.remote(id);if(pc)return pc.name+(chosen&&(model||list.length>1)?' · '+chosen.label:'');const mine=this.value.providers[id];return id==='local'&&mine.managed&&chosen?'This computer ('+chosen.label+')':INFO[id].label;}
 price(id){return this.remote(id)?'Free':cost(id,this.value.providers[id].texture);}
 config(id){const pc=this.remote(id);if(pc)return {url:pc.url,code:pc.code,managed:'',texture:'none'};return {...this.value.providers[id],apiKey:id==='local'?undefined:this.key(id)};}
 async save(){if(this.file){await fs.writeFile(this.file+'.tmp',JSON.stringify(this.value,null,2),{mode:0o600});await fs.rename(this.file+'.tmp',this.file);}}
 async update(input){this.value=this.clean(input,this.value);this.identify();const route=this.value.route.split(':')[0];if(route!=='ask'&&(!this.routes().includes(route)||(ROUTES.includes(route)&&!this.value.providers[route].enabled)))this.value.route='ask';await this.save();return this.public();}
 /** What the app shows. Keys, codes and tokens never leave the server: only whether one is saved and its last four characters. */
 public(){const token=this.hfToken();return {route:this.value.route,hfTokenHint:token?token.slice(-4):'',modelsDirectory:this.value.modelsDirectory,textures:{...this.value.textures},textureSizes:TEXTURE_SIZES,providers:[...ROUTES.map(id=>{const mine=this.value.providers[id],key=id==='local'?'':this.key(id);return {id,...INFO[id],label:this.label(id),enabled:mine.enabled,ready:this.ready(id),texture:mine.texture,textureOptions:TEXTURES[id],cost:cost(id,mine.texture),...(id==='local'?{url:mine.url,managed:mine.managed,paired:!!mine.code,...(mine.managed?{models:this.models('local'),model:this.defaultModel('local'),multiview:!!this.models('local').find(m=>m.id===this.defaultModel('local'))?.multiview}:{})}:{keyHint:key?key.slice(-4):''})};}),
  ...this.value.remotes.map(pc=>({id:'pc-'+pc.id,kind:'remote',server:!!pc.server,gpu:pc.gpu,label:pc.name,about:((pc.models||[]).map(m=>m.label).join(', ')||'A local model')+' on '+(pc.gpu||'its graphics card'),url:pc.url,enabled:true,ready:true,models:pc.models||[],model:this.defaultModel('pc-'+pc.id),multiview:!!(pc.models||[]).find(m=>m.id===this.defaultModel('pc-'+pc.id))?.multiview,texture:'none',textureOptions:[],cost:'Free',pricing:'',time:REMOTE_TIME}))]};}
 /** What an agent is told each turn: the routes it may use and what they cost. Nothing when none is ready. */
 brief(){const ready=this.routes().filter(id=>this.ready(id));if(!ready.length)return undefined;return {defaultRoute:this.value.route==='ask'&&ready.length>1?'the user chooses each time: ask them':this.value.route==='ask'?ready[0]:this.value.route,routes:ready.flatMap(id=>{const list=this.models(id);if(list.length<2)return [{route:id,name:this.label(id),cost:this.price(id),views:INFO[id]?.multiview||list[0]?.multiview?'front, left, back, right':'front only',usualTime:INFO[id]?.time||REMOTE_TIME}];return list.map(m=>({route:id+':'+m.id,name:this.label(id+':'+m.id),cost:'Free',views:m.multiview?'front, left, back, right':'front only',usualTime:this.remote(id)?REMOTE_TIME:INFO.local.time}));})};}
 /** The route a request runs on: the one asked for, else the default, else the only one that is ready. */
 choose(wanted){
  const all=this.routes(),ready=all.filter(id=>this.ready(id)),names=ready.map(id=>id+' ('+this.label(id)+', '+this.price(id)+')').join(', ');
  if(!ready.length)throw Error('Image-to-3D is not set up. The user can switch on a route (a local model, another computer, Tripo or Meshy) under Project settings, 3D generation.');
  const asked=String(wanted||'').trim().toLowerCase(),{base:route,model}=this.split(asked);
  if(route&&model){if(all.includes(route)&&ready.includes(route)&&!this.models(route).some(m=>m.id===model))throw Error('"'+model+'" is not installed on '+this.label(route)+'. Installed there: '+(this.models(route).map(m=>m.id).join(', ')||'nothing')+'.');}
  if(route){if(!all.includes(route))throw Error('Unknown route "'+route+'". Routes that are ready: '+names+'.');if(!ready.includes(route))throw Error(INFO[route].label+' is not switched on or has no '+(route==='local'?'model or server address':'API key')+'. Routes that are ready: '+names+'.');return model?route+':'+model:route;}
  const preferred=this.split(this.value.route);
  if(this.value.route!=='ask'&&ready.includes(preferred.base)&&(!preferred.model||this.models(preferred.base).some(m=>m.id===preferred.model)))return this.value.route;
  if(this.value.route!=='ask'&&ready.includes(preferred.base))return preferred.base;
  if(ready.length===1)return ready[0];
  throw Error('The user wants to choose the route each time. Ask them which to use, then call again with route set. Routes that are ready: '+names+'.');
 }
 /** Checks another Meshdesk at an address: that it answers, that the pairing code is right and that it has a model. */
 async reach(url,code,fetcher=fetch){
  const limit=()=>AbortSignal.timeout(15000);let response;try{response=await fetcher(url+'/health',{signal:limit()});}catch{throw Error('Nothing answered at '+url+'. Check that the other computer is on, running Meshdesk and sharing its model.');}
  const health=await response.json().catch(()=>({}));if(health.app!=='meshdesk')return {response,health:null};
  const check=await fetcher(url+'/check',{headers:auth(code),signal:limit()}).catch(()=>null);if(!check?.ok)throw Error(check?.status===401?'The pairing code for '+health.name+' is wrong.':'Could not check the pairing code with '+health.name+'.');
  if(!health.ready)throw Error(health.name+' has no local model installed yet. Install one there first.');
  return {response,health,message:'Connected to '+health.name+' · '+health.model+' on '+health.gpu};
 }
 /** Pairs with a sharing computer and keeps it as a route. Pairing again with the same address replaces the old entry. */
 async pair({url,code},fetcher=fetch){
  const address=cleanUrl(url),clean=String(code||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,16);if(!address)throw Error('Choose a computer first.');
  const {health,message}=await this.reach(address,clean,fetcher);if(!health)throw Error('That address is not a Meshdesk sharing its model.');
  const id=createHash('sha256').update(address).digest('hex').slice(0,10),entry={id,name:plainName(health.name)||address,url:address,code:clean,model:/^[a-z0-9-]{1,30}$/.test(health.default||'')?health.default:'',models:cleanModels(health.models),gpu:plainName(health.gpu)};
  if(this.value.remotes.length>=12&&!this.remote('pc-'+id))throw Error('Twelve computers are already paired. Forget one first.');
  this.value.remotes=[...this.value.remotes.filter(pc=>pc.id!==id),entry];await this.save();return {message,id:'pc-'+id};
 }
 /** Asks each paired computer what it has installed now, so the list of models to choose from stays true. */
 async refresh(fetcher=fetch){let changed=false;await Promise.all(this.value.remotes.map(async pc=>{try{const health=await (await fetcher(pc.url+'/health',{signal:AbortSignal.timeout(2500)})).json();if(health.app!=='meshdesk')return;const next={name:plainName(health.name)||pc.name,models:cleanModels(health.models),model:/^[a-z0-9-]{1,30}$/.test(health.default||'')?health.default:'',gpu:plainName(health.gpu)||pc.gpu};if(JSON.stringify(next)!==JSON.stringify({name:pc.name,models:pc.models,model:pc.model,gpu:pc.gpu})){Object.assign(pc,next);changed=true;}}catch{}}));if(changed)await this.save();return changed;}
 /** A model server Meshdesk did not install, such as a Hunyuan3D server someone runs by hand. It becomes a machine of its own. */
 async addServer(url,fetcher=fetch){
  const address=cleanUrl(url);if(!address)throw Error('Enter the server address.');
  let response;try{response=await fetcher(address+'/health',{signal:AbortSignal.timeout(15000)});}catch{throw Error('Nothing answered at '+address+'.');}
  const health=await response.json().catch(()=>({}));if(health.app==='meshdesk')throw Error('That is a Meshdesk sharing its models. Pair with it under Add a computer instead.');
  const id=createHash('sha256').update(address).digest('hex').slice(0,10);if(this.value.remotes.length>=12&&!this.remote('pc-'+id))throw Error('Twelve computers are already added. Forget one first.');
  this.value.remotes=[...this.value.remotes.filter(pc=>pc.id!==id),{id,name:new URL(address).host,url:address,code:'',model:'',models:[],gpu:'Model server',server:true}];await this.save();return {id:'pc-'+id,message:'Server is running'};
 }
 /**
  * Looks after the models on a paired computer: action is "list", "install", "cancel" or "remove". The other computer
  * does the work and checks everything again itself; this side only passes the request on with the pairing code.
  */
 async manage(id,action,body={},fetcher=fetch){
  const pc=this.remote(id);if(!pc)throw Error('That computer is not paired.');if(pc.server)throw Error(pc.name+' is a model server, not a Meshdesk: its models are managed where it runs.');
  if(!['list','install','cancel','remove'].includes(action))throw Error('Unknown action.');
  let response;try{response=await fetcher(pc.url+'/manage'+(action==='list'?'':'/'+action),{method:action==='list'?'GET':'POST',headers:{...auth(pc.code),'Content-Type':'application/json'},...(action==='list'?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});}
  catch{throw Object.assign(Error(pc.name+' did not answer. Check that it is on and Meshdesk is running there.'),{offline:true});}
  const data=await response.json().catch(()=>({}));
  if(response.status===401)throw Error('The pairing code for '+pc.name+' is no longer right. Forget it and pair again.');
  if(response.status===404)throw Error(pc.name+' runs an older Meshdesk that cannot manage its models from here. Update it there.');
  if(!response.ok)throw Error(String(data.error||pc.name+' refused the request.').slice(0,400));
  return data;
 }
 async forget(id){if(!this.remote(id))throw Error('That computer is not paired.');this.value.remotes=this.value.remotes.filter(pc=>'pc-'+pc.id!==id);if(this.value.route===id)this.value.route='ask';await this.save();return this.public();}
 async test(id,fetcher=fetch){
  if(!this.routes().includes(id))throw Error('Unknown route.');const mine=this.config(id),limit=()=>AbortSignal.timeout(15000);
  if(this.remote(id)){const {message,health}=await this.reach(mine.url,mine.code,fetcher);if(!health)throw Error('That address no longer answers as a Meshdesk.');return {message};}
  if(id==='local'&&mine.managed){if(!this.local?.isInstalled(mine.managed))throw Error('Install the model first.');const url=await this.local.start(mine.managed),health=await fetcher(url+'/health',{signal:limit()}).then(r=>r.json()).catch(()=>({}));return {message:MODELS[mine.managed].label+' is running'+(health.loaded?' on '+health.device:'')};}
  if(id==='local'){if(!mine.url)throw Error('Enter the server address first.');const {response,health,message}=await this.reach(mine.url,mine.code,fetcher);if(health)return {message};return {message:response.ok?'Server is running':'A server answered, but without a health check (status '+response.status+')'};}
  if(!mine.apiKey)throw Error('Paste an API key first.');
  if(id==='tripo'){const body=await call(fetcher,TRIPO+'/account/balance',{headers:auth(mine.apiKey),signal:limit()},tripoError);const balance=Number(body.data?.balance)||0;return {message:'Key works · '+balance.toLocaleString('en-US')+' credits ($'+(balance/100).toFixed(2)+')'};}
  const body=await call(fetcher,MESHY+'/balance',{headers:auth(mine.apiKey),signal:limit()},meshyError);return {message:'Key works · '+(Number(body.balance)||0).toLocaleString('en-US')+' credits'};
 }
 /**
  * Makes the model. views maps front, left, back and right to {bytes, extension}; front is required.
  * Returns {bytes, route, credits}. progress(step, percent) reports where it has got to.
  */
 async generate({route:full,views,texture=true,faceLimit=0,signal,progress=()=>{},fetcher=fetch,wait=sleep}){
  const {base:route,model:asked}=this.split(full),model=asked||this.defaultModel(route);
  if(!this.routes().includes(route)||!this.ready(route))throw Error(INFO[route]?.label?INFO[route].label+' is not set up.':'Unknown route.');
  if(!views?.front)throw Error('The front view is required.');
  // Models installed here go through this computer's queue, which loads the right one when its turn comes.
  const mine=this.config(route);if(route==='local'&&mine.managed){if(!this.local.isInstalled(model))throw Error('That model is not installed on this computer.');mine.client={send:async body=>this.local.submit(model,body),status:async uid=>this.local.status(uid),cancel:async uid=>this.local.cancel(uid)};mine.texture='none';}
  mine.model=model;mine.multiview=!!this.models(route).find(m=>m.id===model)?.multiview;mine.textureSize=model?this.value.textures[route+':'+model]||0:0;
  const quality=texture?mine.texture:'none',context={mine,views,quality,faceLimit:Math.round(Number(faceLimit))||0,signal,progress,fetcher,wait,name:this.remote(route)?.name||'the local server'};
  const made=await (this.remote(route)?local:{local,tripo,meshy}[route])(context);
  if(made.bytes.length<20||made.bytes.toString('latin1',0,4)!=='glTF')throw Error(INFO[route].label+' returned a file that is not a GLB model.');
  return {...made,route:full};
 }
}

const sleep=(ms,signal)=>new Promise((resolve,reject)=>{if(signal?.aborted)return reject(Error('Operation cancelled.'));const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms),stop=()=>{clearTimeout(timer);reject(Error('Operation cancelled.'));};signal?.addEventListener('abort',stop,{once:true});});
const auth=key=>({Authorization:'Bearer '+key});
const within=(signal,ms)=>signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);
const mime=extension=>extension==='.jpg'?'image/jpeg':extension==='.webp'?'image/webp':'image/png';
const tripoError=(status,body)=>status===401?'Tripo rejected the API key.':body.code===2010?'The Tripo account has no credits left. Top it up and try again.':status===429?'Tripo is busy with other generations on this account. Try again in a minute.':'Tripo: '+String(body.message||'request failed ('+status+')').slice(0,300)+(body.suggestion?' '+String(body.suggestion).slice(0,200):'');
const meshyError=(status,body)=>status===401?'Meshy rejected the API key.':status===402?'Meshy needs a paid plan with credits left to generate through the API.':status===429?'Meshy is busy with other generations on this account. Try again in a minute.':'Meshy: '+String(body.message||'request failed ('+status+')').slice(0,300);
/** One JSON request. Network failures and error replies become one plain sentence. */
async function call(fetcher,url,options,describe){
 let response;try{response=await fetcher(url,options);}catch(error){if(options.signal?.aborted&&error.name!=='TimeoutError')throw Error('Operation cancelled.');throw Error('Could not reach '+new URL(url).host+'. Check the connection and try again.');}
 const body=await response.json().catch(()=>({}));if(!response.ok)throw Error(describe(response.status,body));return Object.assign(body,{retryAfter:Number(response.headers?.get?.('retry-after'))||0});
}
async function download(fetcher,url,signal,label){let response;try{response=await fetcher(url,{signal:within(signal,300000)});}catch{if(signal?.aborted)throw Error('Operation cancelled.');throw Error('The model from '+label+' could not be downloaded.');}if(!response.ok)throw Error('The model from '+label+' could not be downloaded ('+response.status+').');return Buffer.from(await response.arrayBuffer());}

async function tripo({mine,views,quality,faceLimit,signal,progress,fetcher,wait}){
 const given=VIEWS.filter(view=>views[view]),tokens={};
 for(const [index,view] of given.entries()){
  progress('Uploading the '+view+' view',Math.round(index/given.length*8));
  const form=new FormData();form.append('file',new Blob([views[view].bytes],{type:mime(views[view].extension)}),view+views[view].extension);
  const body=await call(fetcher,TRIPO+'/files',{method:'POST',headers:auth(mine.apiKey),body:form,signal:within(signal,120000)},tripoError);
  tokens[view]=body.data?.file_token;if(!tokens[view])throw Error('Tripo did not accept the '+view+' view.');
 }
 const options={model:mine.model,texture:quality!=='none',pbr:quality!=='none',...(quality==='detailed'?{texture_quality:'detailed'}:{}),...(faceLimit?{face_limit:Math.min(500000,Math.max(1000,faceLimit))}:{})};
 const request=given.length>1?['/generation/multiview-to-model',{inputs:given.map(view=>({[view]:tokens[view]})),...options}]:['/generation/image-to-model',{input:tokens.front,...options}];
 progress('Starting the generation',8);
 const created=await call(fetcher,TRIPO+request[0],{method:'POST',headers:{...auth(mine.apiKey),'Content-Type':'application/json'},body:JSON.stringify(request[1]),signal:within(signal,60000)},tripoError),id=created.data?.task_id;
 if(!id)throw Error('Tripo did not start the generation.');
 for(const started=Date.now();;){
  if(Date.now()-started>20*60000)throw Error('Tripo took longer than 20 minutes. Nothing was charged if it did not finish.');
  await wait(2500,signal);
  let task;try{task=(await call(fetcher,TRIPO+'/tasks/'+id,{headers:auth(mine.apiKey),signal:within(signal,30000)},tripoError)).data||{};}catch(error){if(/cancelled|rejected the API key/.test(error.message))throw error;continue;}
  if(task.status==='success'){const url=task.output?.model_url;if(!url)throw Error('Tripo finished without a model.');progress('Downloading the model',96);return {bytes:await download(fetcher,url,signal,'Tripo'),credits:Number(task.credits_consumed)||undefined};}
  if(['failed','cancelled','banned','expired'].includes(task.status))throw Error('Tripo could not make this model'+(task.error_message?': '+String(task.error_message).slice(0,300):task.status==='banned'?': the pictures were refused by its content rules.':'.')+' Nothing was charged.');
  progress(task.status==='queued'?'Waiting in Tripo’s queue':'Generating',8+Math.round((Number(task.progress)||0)*.86));
 }
}

async function meshy({mine,views,quality,faceLimit,signal,progress,fetcher,wait}){
 const given=VIEWS.filter(view=>views[view]),uri=view=>'data:'+mime(views[view].extension)+';base64,'+views[view].bytes.toString('base64');
 const options={ai_model:mine.model,should_texture:quality!=='none',...(quality!=='none'?{enable_pbr:true}:{}),target_formats:['glb'],...(faceLimit?{should_remesh:true,target_polycount:Math.min(300000,Math.max(100,faceLimit))}:{})};
 const kind=given.length>1?'multi-image-to-3d':'image-to-3d',body=given.length>1?{image_urls:given.map(uri),...options}:{image_url:uri('front'),...options};
 progress('Sending the pictures',4);
 const created=await call(fetcher,MESHY+'/'+kind,{method:'POST',headers:{...auth(mine.apiKey),'Content-Type':'application/json'},body:JSON.stringify(body),signal:within(signal,180000)},meshyError),id=created.result;
 if(!id)throw Error('Meshy did not start the generation.');
 let pause=5000;
 for(const started=Date.now();;){
  if(Date.now()-started>60*60000)throw Error('Meshy took longer than an hour.');
  await wait(pause,signal);
  let task;try{task=await call(fetcher,MESHY+'/'+kind+'/'+id,{headers:auth(mine.apiKey),signal:within(signal,30000)},meshyError);}catch(error){if(/cancelled|rejected the API key/.test(error.message))throw error;continue;}
  pause=Math.min(15000,Math.max(2000,(task.retryAfter||5)*1000));
  if(task.status==='SUCCEEDED'){const url=task.model_urls?.glb;if(!url)throw Error('Meshy finished without a GLB model.');progress('Downloading the model',96);return {bytes:await download(fetcher,url,signal,'Meshy'),credits:Number(task.consumed_credits)||undefined};}
  if(['FAILED','CANCELED'].includes(task.status))throw Error('Meshy could not make this model'+(task.task_error?.message?': '+String(task.task_error.message).slice(0,300):'.')+' The credits were refunded.');
  progress(task.status==='PENDING'?'Waiting in Meshy’s queue':'Generating',8+Math.round((Number(task.progress)||0)*.86));
 }
}

/** The Hunyuan3D API server protocol: POST /send starts a task, GET /status/{uid} returns the GLB as base64 when it is done. */
async function local({mine,views,quality,faceLimit,signal,progress,fetcher,wait,name='the local server'}){
 const headers={'Content-Type':'application/json',...(mine.code&&!mine.managed?auth(mine.code):{})},describe=(status,body)=>status===401?'The pairing code for the other computer is wrong. Connect to it again under 3D generation.':'The local server refused the request'+(body.text||body.error||body.message||body.detail?': '+String(body.text||body.error||body.message||JSON.stringify(body.detail)).slice(0,300):' ('+status+').');
 progress('Sending the picture',2);
 const client=mine.client||{send:async body=>call(fetcher,mine.url+'/send',{method:'POST',headers,body:JSON.stringify(body),signal:within(signal,120000)},describe),status:async uid=>call(fetcher,mine.url+'/status/'+uid,{headers,signal:within(signal,120000)},describe),
  // A model server Meshdesk did not install may have no cancel; then the machine finishes the job and the result is dropped.
  cancel:async uid=>{await fetcher(mine.url+'/cancel/'+uid,{method:'POST',headers,signal:AbortSignal.timeout(10000)});}};
 let created;try{created=await client.send({image:views.front.bytes.toString('base64'),...(mine.model?{model:mine.model}:{}),...(mine.multiview?{views:Object.fromEntries(VIEWS.filter(view=>view!=='front'&&views[view]).map(view=>[view,views[view].bytes.toString('base64')]))}:{}),...(mine.textureSize?{texture_size:mine.textureSize}:{}),texture:quality!=='none',remove_background:true,face_count:faceLimit?Math.min(300000,Math.max(1000,faceLimit)):150000});}catch(error){if(/^Could not reach/.test(error.message))throw Error(name+' did not answer at '+mine.url+'. Check that it is on, running Meshdesk and sharing its model, then try again.');throw error;}
 if(!created.uid)throw Error('The local server did not start the generation.');
 for(const started=Date.now();;){
  if(Date.now()-started>3*60*60000)throw Error('The generation took longer than three hours, counting the wait for others.');
  // Cancelling here also cancels it on the machine doing the work, so it does not run on after nobody wants it.
  try{await wait(3000,signal);}catch(error){await client.cancel(created.uid).catch(()=>{});throw error;}
  let task;try{task=await client.status(created.uid);}catch(error){if(/cancelled/.test(error.message))throw error;continue;}
  if(task.status==='completed'&&task.model_base64){progress('Reading the model',96);return {bytes:Buffer.from(task.model_base64,'base64')};}
  if(task.status==='error'&&task.cancelled)throw Error('Cancelled on '+name+'.');
  if(task.status==='error')throw Error('The local server could not make this model'+(task.message?': '+String(task.message).slice(0,300):'.'));
  progress(String(task.message||(task.status==='texturing'?'Texturing':'Generating')).slice(0,80),Math.min(95,task.queued!==undefined?0:Math.round(Number(task.progress))||Math.round((Date.now()-started)/8000)+4));
 }
}

const FINAL=['done','failed','cancelled'];
/**
 * Generations started from the app for one project. They run in the background and are announced as they progress.
 * importModel(name, bytes) adds the finished GLB to the library and returns {id}; readImage(id) returns the bytes of a library picture.
 */
export class Generations{
 constructor({generators,importModel,readImage,broadcast=()=>{},budget=()=>0,file}){Object.assign(this,{generators,importModel,readImage,broadcast,budget,file});this.jobs=[];this.controllers=new Map();}
 /** Reads the jobs kept from last time. One that was still running when Meshdesk stopped cannot be picked up again, so it is shown as interrupted rather than vanishing. */
 async init(){if(!this.file)return;try{const saved=JSON.parse(await fs.readFile(this.file,'utf8'));this.jobs=(Array.isArray(saved)?saved:[]).filter(job=>job&&typeof job.id==='string').slice(-12).map(job=>FINAL.includes(job.status)?job:{...job,status:'failed',error:'Interrupted when Meshdesk stopped. Generate it again.'});}catch{}}
 list(){return this.jobs.map(job=>({...job}));}
 keep(){if(this.file)void fs.writeFile(this.file,JSON.stringify(this.jobs)).catch(()=>{});}
 announce(){this.broadcast({type:'generations',generations:this.list()});}
 /** Reads each chosen view, from an uploaded picture or a library asset id, and checks it is a picture. */
 async pictures(views={}){
  const result={};
  for(const view of VIEWS){const value=views[view];if(!value)continue;let bytes;
   if(typeof value==='string'&&/^[a-f0-9]{12}$/.test(value))bytes=await this.readImage(value);
   else{const match=typeof value==='string'&&value.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);if(!match)throw Error('The '+view+' view must be a PNG, JPG or WebP picture.');bytes=Buffer.from(match[1],'base64');}
   const info=imageInfo(bytes);if(!info||bytes.length>20*1024*1024)throw Error('The '+view+' view must be a PNG, JPG or WebP picture up to 20 MB.');result[view]={bytes,extension:info.extension};}
  if(!result.front)throw Error('Add the front view first.');
  return result;
 }
 /** Generates and imports in one go. Used by the app's own jobs and by the agent's tool. */
 async make({name,route,views,texture=true},signal,progress=()=>{}){
  const made=await this.generators.generate({route,views,texture,faceLimit:this.budget(),signal,progress});
  if(signal?.aborted)throw Error('Operation cancelled.');
  progress('Adding it to the library',98);
  const stem=String(name||'').replace(/[^a-zA-Z0-9 _.-]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,100)||'Generated model',added=await this.importModel(stem+'.glb',made.bytes);
  return {assetId:added.id,duplicate:!!added.duplicate,route,credits:made.credits};
 }
 async start({name,route,model,texture,views}={}){
  if(this.jobs.filter(job=>!FINAL.includes(job.status)).length>=4)throw Error('Four generations are already running. Wait for one to finish.');
  const chosen=this.generators.choose(model&&route?String(route).split(':')[0]+':'+model:route),pictures=await this.pictures(views),label=this.generators.label(chosen);
  const job={id:randomUUID(),name:String(name||'').trim().slice(0,100)||'Generated model',route:chosen,providerLabel:label,status:'running',step:'Starting',progress:0,startedAt:new Date().toISOString()},controller=new AbortController();
  this.jobs=[...this.jobs.filter(old=>!FINAL.includes(old.status)||Date.now()-Date.parse(old.startedAt)<24*3600000).slice(-11),job];this.controllers.set(job.id,controller);this.keep();this.announce();
  void this.make({name:job.name,route:chosen,views:pictures,texture:texture!==false},controller.signal,(step,percent)=>{if(FINAL.includes(job.status))return;const next=Math.max(job.progress,Math.min(99,Math.round(percent)||0));if(step===job.step&&next===job.progress)return;job.step=step;job.progress=next;this.announce();})
   .then(result=>Object.assign(job,{status:'done',progress:100,assetId:result.assetId,credits:result.credits}),error=>Object.assign(job,controller.signal.aborted?{status:'cancelled'}:{status:'failed',error:String(error.message||error).slice(0,400)}))
   .finally(()=>{this.controllers.delete(job.id);this.keep();this.announce();});
  return {...job};
 }
 cancel(id){const controller=this.controllers.get(id);if(!controller)throw Error('That generation is no longer running.');controller.abort();return {ok:true};}
 dismiss(id){const job=this.jobs.find(j=>j.id===id);if(job&&!FINAL.includes(job.status))throw Error('Cancel the generation first.');this.jobs=this.jobs.filter(j=>j.id!==id);this.keep();this.announce();return {ok:true};}
 shutdown(){for(const controller of this.controllers.values())controller.abort();}
}
