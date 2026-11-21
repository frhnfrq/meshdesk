/**
 * Lets one Meshdesk use another's local model over the home or office network: a laptop borrowing a desktop's graphics card.
 *
 * The computer with the graphics card switches sharing on. It then answers discovery calls on the network and opens a small
 * second server that accepts only generation requests carrying its pairing code. Meshdesk's main server stays bound to this
 * machine alone, as before. The other Meshdesk finds it with "Find computers", is given the code once, and from then on its
 * local route sends pictures there. Traffic is plain HTTP, so this is for networks you trust, never the open internet.
 */
import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';
import {randomBytes,randomInt,timingSafeEqual} from 'node:crypto';
import {MODELS} from './local-models.mjs';

export const SHARE_PORT=8792,DISCOVERY_PORT=8793;
const PROBE='meshdesk-discover-1',LETTERS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newCode=()=>Array.from({length:8},()=>LETTERS[randomInt(LETTERS.length)]).join('');
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
/** The broadcast address of every network this machine is on, so a discovery call reaches each of them. */
export function broadcastAddresses(interfaces=os.networkInterfaces()){
 const found=new Set(['255.255.255.255']);
 for(const list of Object.values(interfaces))for(const entry of list||[]){if(entry.family!=='IPv4'||entry.internal||!entry.netmask)continue;const ip=entry.address.split('.').map(Number),mask=entry.netmask.split('.').map(Number);found.add(ip.map((part,i)=>(part|(~mask[i]&255))).join('.'));}
 return [...found];
}

export class Sharing{
 /** generators holds the saved settings; localModels runs the model that is shared. */
 constructor({generators,localModels,onChange=()=>{},port=SHARE_PORT,discoveryPort=DISCOVERY_PORT,host='0.0.0.0'}){Object.assign(this,{generators,localModels,onChange,port,discoveryPort,host});this.id=randomBytes(8).toString('hex');this.failures=new Map();this.error='';}
 get settings(){return this.generators.value.share;}
 model(){return this.generators.defaultModel('local');}
 async public(){const hardware=await this.localModels.hardware(),model=this.model();return {enabled:this.settings.enabled,name:this.settings.name,code:this.settings.code,port:this.port,running:!!this.server,error:this.error,model:model?MODELS[model].label:'',gpu:hardware.gpu.name,addresses:Object.values(os.networkInterfaces()).flat().filter(e=>e&&e.family==='IPv4'&&!e.internal).map(e=>e.address)};}
 /** What anyone on the network may learn without the code: that a Meshdesk is here, and what it can run. */
 async card(){const hardware=await this.localModels.hardware(),model=this.model();return {app:'meshdesk',id:this.id,name:this.settings.name,port:this.port,models:this.generators.models('local'),default:model,model:model?MODELS[model].label:'',gpu:hardware.gpu.name+(hardware.gpu.kind==='nvidia'&&hardware.gpu.vramGB?' · '+hardware.gpu.vramGB+' GB':''),ready:!!model};}
 async update(change={}){
  const next={};if(change.enabled!==undefined)next.enabled=!!change.enabled;if(change.name!==undefined)next.name=change.name;if(change.newCode)next.code=newCode();
  await this.generators.update({share:next});await this.apply();return this.public();
 }
 /** Opens or closes the shared server to match the setting. */
 async apply(){
  if(this.settings.enabled&&!this.server)await this.open().catch(error=>{this.error=error.code==='EADDRINUSE'?'Port '+this.port+' is already in use on this computer, so sharing could not start.':'Sharing could not start: '+error.message;});
  if(!this.settings.enabled)await this.close();
  this.onChange();
 }
 async open(){
  this.error='';const server=http.createServer((req,res)=>void this.handle(req,res).catch(error=>this.reply(res,500,{error:String(error.message||error).slice(0,300)})));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(this.port,this.host,resolve);});this.server=server;
  const socket=dgram.createSocket({type:'udp4',reuseAddr:true});socket.on('error',()=>{});
  socket.on('message',(message,from)=>{if(String(message)!==PROBE)return;void this.card().then(card=>socket.send(JSON.stringify(card),from.port,from.address,()=>{})).catch(()=>{});});
  await new Promise(resolve=>{socket.once('error',resolve);socket.bind(this.discoveryPort,resolve);});this.socket=socket;
 }
 async close(){const {server,socket}=this;this.server=null;this.socket=null;this.error='';try{socket?.close();}catch{}if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}}
 reply(res,status,body){if(res.headersSent)return;const data=JSON.stringify(body);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'X-Content-Type-Options':'nosniff'});res.end(data);}
 /** True when the request carries the pairing code. Ten wrong codes from one address lock it out for ten minutes. */
 allowed(req){
  const from=req.socket.remoteAddress||'',now=Date.now(),record=this.failures.get(from);
  if(record&&record.count>=10&&now-record.at<600000)return false;
  if(same(String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').replace(/[^A-Za-z0-9]/g,'').toUpperCase(),this.settings.code)){this.failures.delete(from);return true;}
  this.failures.set(from,{count:(record&&now-record.at<600000?record.count:0)+1,at:now});if(this.failures.size>500)this.failures.clear();return false;
 }
 async handle(req,res){
  const url=new URL(req.url,'http://meshdesk');
  if(req.method==='GET'&&url.pathname==='/health')return this.reply(res,200,{status:'healthy',...await this.card()});
  if(!this.allowed(req))return this.reply(res,401,{error:'The pairing code is wrong.'});
  if(req.method==='GET'&&url.pathname==='/check')return this.reply(res,200,{ok:true,...await this.card()});
  // A paired computer may also look after the models here: list them, install from Meshdesk's own recipes, cancel and remove.
  if(url.pathname==='/manage'&&req.method==='GET')return this.reply(res,200,{name:this.settings.name,...await this.localModels.public()});
  const manage=req.method==='POST'&&url.pathname.match(/^\/manage\/(install|cancel|remove)$/);
  if(manage){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)return this.reply(res,413,{error:'Request too large.'});chunks.push(chunk);}
   let body={};try{body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};}catch{return this.reply(res,400,{error:'Send JSON.'});}
   try{const id=String(body.id||'');const result=manage[1]==='install'?await this.localModels.install(id,{accept:body.accept===true}):manage[1]==='cancel'?this.localModels.cancelInstall():await this.localModels.remove(id);return this.reply(res,200,{name:this.settings.name,...result});}
   catch(error){return this.reply(res,400,{error:String(error.message||error).slice(0,400)});}}
  const model=this.model();if(!model)return this.reply(res,503,{error:this.settings.name+' has no local model installed.'});
  if(req.method==='POST'&&url.pathname==='/send'){
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>40*1024*1024)return this.reply(res,413,{error:'The picture is too large.'});chunks.push(chunk);}
   let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{return this.reply(res,400,{error:'Send JSON with a base64 image.'});}
   const wanted=body.model||model;if(!this.localModels.isInstalled(wanted))return this.reply(res,400,{error:this.settings.name+' does not have that model installed.'});
   // Into this computer's queue, shared with its own generations: answered at once, run when its turn comes.
   try{return this.reply(res,200,this.localModels.submit(wanted,body));}catch(error){return this.reply(res,409,{error:String(error.message||error).slice(0,300)});}
  }
  const status=req.method==='GET'&&url.pathname.match(/^\/status\/([a-f0-9-]{36})$/);
  if(status)return this.reply(res,200,this.localModels.status(status[1]));
  const cancel=req.method==='POST'&&url.pathname.match(/^\/cancel\/([a-f0-9-]{36})$/);
  if(cancel){for await(const chunk of req)void chunk;return this.reply(res,200,this.localModels.cancel(cancel[1]));}
  this.reply(res,404,{error:'Not found.'});
 }
 /** Calls out on every network this machine is on and collects the Meshdesks that answer within the wait. */
 async discover({wait=1500,addresses=broadcastAddresses()}={}){
  const socket=dgram.createSocket({type:'udp4',reuseAddr:true}),found=new Map();socket.on('error',()=>{});
  socket.on('message',(message,from)=>{try{const card=JSON.parse(String(message));if(card.app!=='meshdesk'||card.id===this.id||typeof card.port!=='number')return;found.set(card.id,{id:String(card.id).slice(0,40),name:String(card.name||from.address).slice(0,60),address:from.address,url:'http://'+from.address+':'+card.port,model:String(card.model||'').slice(0,60),gpu:String(card.gpu||'').slice(0,80),ready:!!card.ready});}catch{}});
  await new Promise(resolve=>{socket.once('error',resolve);socket.bind(0,resolve);});try{socket.setBroadcast(true);}catch{}
  const call=()=>{for(const address of addresses)socket.send(PROBE,this.discoveryPort,address,()=>{});};call();const again=setTimeout(call,wait/2);
  await new Promise(resolve=>setTimeout(resolve,wait));clearTimeout(again);try{socket.close();}catch{}
  return [...found.values()].sort((a,b)=>a.name.localeCompare(b.name));
 }
 async shutdown(){await this.close();}
}
