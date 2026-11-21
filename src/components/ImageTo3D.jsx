import {useEffect,useRef,useState} from 'react';
import {Box,Check,CircleAlert,Cloud,ImagePlus,Laptop,Monitor,RefreshCw,Scissors,Server,Settings,X,Zap} from 'lucide-react';
import {splitSheet} from '../split.js';
import Picker from './Picker.jsx';

export const VIEWS=[['front','Front'],['left','Left side'],['back','Back'],['right','Right side']];
const readFile=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('That picture could not be read.'));reader.readAsDataURL(file);});

/** One to four pictures in, a model out: choose the pictures, the route and whether to texture it. */
/** Picks out which side a picture shows from its file name, such as "Ace-back.jpg". */
const slotFromName=name=>{const n=String(name).toLowerCase();return /back|rear/.test(n)?'back':/left/.test(n)?'left':/right/.test(n)?'right':/front/.test(n)?'front':'';};
const pictureAsData=async(base,id)=>{const blob=await fetch(base+'/library/'+id).then(r=>{if(!r.ok)throw Error('That picture could not be read.');return r.blob();});return readFile(blob);};

/**
 * One to four pictures in, a model out. Pictures first (a turnaround sheet is split into views), then the machine, then
 * one of that machine's models. It says which model is loaded, what switching costs, and how long it should take.
 */
export function ImageToModelForm({base,request,generators,localModels,catalog,projectBudget,onStarted,onOpenSettings,onGenerators=()=>{},onError}){
 const [views,setViews]=useState({}),[sheet,setSheet]=useState(null),[adjust,setAdjust]=useState(false),[name,setName]=useState(''),[machine,setMachine]=useState(''),[model,setModel]=useState(''),[remote,setRemote]=useState({}),[busy,setBusy]=useState(''),[over,setOver]=useState(false),input=useRef(null),slot=useRef('');
 const providers=generators?.providers||[],remotes=providers.filter(p=>p.kind==='remote'),cloud=providers.filter(p=>p.kind==='cloud'),[defaultBase,defaultModel]=String(generators?.route||'ask').split(':');
 useEffect(()=>{if(remotes.length)request(base+'/api/sharing/refresh').then(onGenerators).catch(()=>{});for(const pc of remotes)if(!pc.server)fetch(base+'/api/machines/'+pc.id).then(r=>r.ok?r.json():null).then(data=>data&&setRemote(old=>({...old,[pc.id]:data}))).catch(()=>{});},[]);
 // Every place a model can be made, each with its models, which is loaded, and whether it is busy.
 const machines=[];
 const local=localModels?.models?.filter(m=>m.installed)||[];
 if(local.length)machines.push({id:'local',label:'This computer',icon:'laptop',models:local,loaded:['running','starting'].includes(localModels.server?.state)?localModels.server.model:'',busy:!!localModels.queue?.running,waiting:localModels.queue?.waiting||0});
 for(const pc of remotes){const data=remote[pc.id];machines.push(pc.server?{id:pc.id,label:pc.label,icon:'server',server:true,models:[{id:'',label:'Model server',time:'',textured:false,multiview:false}]}
  :{id:pc.id,label:pc.label,icon:'desktop',models:data?data.models.filter(m=>m.installed):(pc.models||[]),loaded:data&&['running','starting'].includes(data.server?.state)?data.server.model:'',busy:!!data?.queue?.running,waiting:data?.queue?.waiting||0,known:!!data});}
 const readyCloud=cloud.filter(p=>p.ready);
 machines.push({id:'cloud',label:'Cloud',icon:'cloud',cloud:true,models:readyCloud.map(p=>({id:p.id,label:p.label,time:p.time,cost:p.cost,textured:p.texture!=='none',multiview:true}))});
 // With no default set, start on a machine that already has a model loaded, then on another computer (usually the stronger one), then here.
 const chosenMachine=machines.find(m=>m.id===machine)||machines.find(m=>m.id===defaultBase)||machines.find(m=>m.id===(['tripo','meshy'].includes(defaultBase)?'cloud':''))||machines.find(m=>m.loaded&&m.models.length)||machines.find(m=>!m.cloud&&m.id!=='local'&&m.models.length)||machines.find(m=>!m.cloud)||machines[0];
 const list=chosenMachine.models,chosen=list.find(m=>m.id===model)||list.find(m=>m.id===(chosenMachine.id===defaultBase?defaultModel:chosenMachine.cloud?defaultBase:''))||list.find(m=>m.id===chosenMachine.loaded)||list[0];
 const switching=chosen&&chosenMachine.loaded&&chosen.id!==chosenMachine.loaded?list.find(m=>m.id===chosenMachine.loaded):null,needsLoad=chosen&&!chosenMachine.cloud&&!chosenMachine.server&&chosen.id!==chosenMachine.loaded;
 const textureKey=chosenMachine.cloud||chosenMachine.server?'':chosenMachine.id+':'+chosen?.id,textureValue=generators?.textures?.[textureKey]||chosen?.defaultTexture||0;
 const given=Object.keys(views),extra=given.filter(v=>v!=='front');

 async function addFiles(files){const list=[...files].filter(f=>/^image\/(png|jpeg|webp)$/.test(f.type));if(!list.length)return onError('Use PNG, JPG or WebP pictures.');if(list.some(f=>f.size>20*1024*1024))return onError('Use pictures up to 20 MB.');onError('');
  const items=await Promise.all(list.map(async f=>({data:await readFile(f),label:f.name,hint:slotFromName(f.name)})));
  await addPictures(items,slot.current);slot.current='';}
 /** Puts pictures in their slots. One picture with several figures is treated as a sheet and split. */
 async function addPictures(items,target){
  if(items.length===1&&!target){setBusy('split');try{const split=await splitSheet(items[0].data);if(split){setViews(Object.fromEntries(split.views.map(v=>[v.slot,{data:v.data,label:items[0].label+' · '+v.slot}])));setSheet({label:items[0].label,views:split.views});if(!name)setName(cleanName(items[0].label));return;}}catch{}finally{setBusy('');}}
  setSheet(null);setViews(old=>{const next={...old},free=()=>VIEWS.map(v=>v[0]).find(v=>!next[v]);for(const item of items){const place=target||item.hint&&!next[item.hint]&&item.hint||(!next.front?'front':free());if(place)next[place]={data:item.data,label:item.label};target='';}return next;});
  if(!name)setName(cleanName(items[0].label));
 }
 const cleanName=label=>String(label).replace(/\.[^.]+$/,'').replace(/[-_ ]*(front|back|left|right|side|sheet|turnaround)$/i,'').slice(0,100);
 function reassign(index,place){setSheet(old=>{const next={...old,views:old.views.map((v,i)=>i===index?{...v,slot:place}:place&&v.slot===place?{...v,slot:old.views[index].slot}:v)};setViews(Object.fromEntries(next.views.filter(v=>v.slot).map(v=>[v.slot,{data:v.data,label:old.label+' · '+v.slot}])));return next;});}
 async function setTexture(size){onError('');try{onGenerators(await request(base+'/api/generators',{textures:{[textureKey]:size===chosen.defaultTexture?null:size}}));}catch(e){onError(e.message);}}
 async function start(event){event.preventDefault();if(!views.front)return onError('Add the front view first.');if(!chosen)return onError('Choose a model.');onError('');setBusy('start');
  try{const route=chosenMachine.cloud?chosen.id:chosenMachine.id;const job=await request(base+'/api/generations',{name,route,...(chosenMachine.cloud||chosenMachine.server?{}:{model:chosen.id}),texture:true,views:Object.fromEntries(Object.entries(views).map(([view,v])=>[view,v.data]))});onStarted(job);}catch(e){onError(e.message);}finally{setBusy('');}}

 if(machines.length===1&&!readyCloud.length)return <div className="settings-form"><div className="generator-empty"><Box size={22}/><strong>Set up a machine first</strong><p>Meshdesk can make a model from pictures on this computer, on another computer on your network, or through Tripo or Meshy. None is set up yet.</p><button type="button" className="primary-button" onClick={onOpenSettings}><Settings size={15}/>Set up 3D generation</button></div></div>;
 const images=(catalog||[]).filter(a=>['reference','texture'].includes(a.type)&&!a.removed);
 const warn=!views.front?{kind:'danger',text:'Add the front view first.'}:chosen&&!chosen.multiview&&extra.length?{kind:'warn',text:'Uses the front view only; '+extra.length+' other '+(extra.length===1?'view':'views')+' will be ignored.'}:chosen?.multiview&&extra.length?{kind:'ok',text:'All '+given.length+' views will be used.'}:chosen?.multiview&&!chosenMachine.cloud?{kind:'info',text:'Add side and back views: this model uses them.'}:null;
 const note=!chosen||chosenMachine.cloud||chosenMachine.server?null:chosenMachine.busy?'Busy with another generation'+(chosenMachine.waiting?' and '+chosenMachine.waiting+' waiting':'')+'. This one will wait its turn'+(needsLoad?', then load '+chosen.label:'')+'.':!needsLoad?'Already loaded, so it starts straight away.':switching?switching.label+' will be unloaded and '+chosen.label+' loaded first'+(chosen.loadTime?' ('+chosen.loadTime+')':'')+'.':chosen.label+' will be loaded first'+(chosen.loadTime?' ('+chosen.loadTime+')':'')+'.';
 const estimate=!chosen?'':(chosen.time?chosen.time.replace(/^about/i,'About'):'')+(needsLoad&&chosen.loadTime?(chosen.time?' plus ':'')+chosen.loadTime+' to load':'')+(chosenMachine.busy?', after the job ahead':'')+(chosen.time||needsLoad?' on '+chosenMachine.label:chosenMachine.cloud?chosen.cost:'');
 return <form className="settings-form gen-form" onSubmit={start}>
  <input ref={input} type="file" multiple accept="image/png,image/jpeg,image/webp" hidden onChange={e=>{addFiles(e.target.files);e.target.value='';}}/>
  <section className={'gen-pictures '+(over?'over':'')} onDragOver={e=>{e.preventDefault();setOver(true);}} onDragLeave={()=>setOver(false)} onDrop={e=>{e.preventDefault();setOver(false);slot.current='';addFiles(e.dataTransfer.files);}}>
   <div className="gen-label"><strong>Pictures</strong><span>Drop a turnaround sheet or separate views</span></div>
   <div className="view-slots">{VIEWS.map(([view,label])=>{const picked=views[view];return <div key={view} className={'view-slot '+(picked?'filled':'')}>
    <button type="button" className="view-pick" aria-label={(picked?'Replace the ':'Add the ')+label.toLowerCase()+' view'} onClick={()=>{slot.current=view;input.current.click();}}>{picked?<img src={picked.data} alt=""/>:<ImagePlus size={18}/>}</button>
    <span>{label}{view==='front'&&<em>required</em>}</span>
    {picked&&<button type="button" className="view-clear" aria-label={'Remove the '+label.toLowerCase()+' view'} onClick={()=>setViews(old=>{const next={...old};delete next[view];return next;})}><X size={12}/></button>}
   </div>;})}</div>
   <div className="gen-picture-actions">{busy==='split'?<span className="quiet">Looking for views…</span>:sheet?<span className="quiet"><Scissors size={12}/>Split {sheet.label} into {sheet.views.length} views <button type="button" className="link-button" onClick={()=>setAdjust(!adjust)}>{adjust?'Done':'Adjust'}</button></span>
    :<span className="quiet">Or add <button type="button" className="link-button" onClick={()=>{slot.current='';input.current.click();}}>pictures</button></span>}
    {images.length>0&&<Picker id="gen-library" className="view-library" label="Add a picture from the library" value="" options={[{value:'',label:'From library'},...images.slice(0,300).map(a=>({value:a.id,label:a.name}))]} onChange={async id=>{const asset=images.find(a=>a.id===id);if(!asset)return;try{await addPictures([{data:await pictureAsData(base,id),label:asset.name,hint:slotFromName(asset.name)}],'');}catch(e){onError(e.message);}}}/>}</div>
   {adjust&&sheet&&<div className="gen-adjust">{sheet.views.map((v,i)=><label key={i}><img src={v.data} alt=""/><select value={v.slot||''} onChange={e=>reassign(i,e.target.value)}>{VIEWS.map(([value,label])=><option key={value} value={value}>{label}</option>)}<option value="">Not used</option></select></label>)}</div>}
  </section>
  <section>
   <div className="gen-label"><strong>Generate on</strong><button type="button" className="link-button" onClick={onOpenSettings}>Manage</button></div>
   <div className="gen-machines">{machines.map(m=><button type="button" key={m.id} className={'gen-machine '+(m.id===chosenMachine.id?'on':'')} onClick={()=>{setMachine(m.id);setModel('');}}>
    <b>{m.icon==='laptop'?<Laptop size={13}/>:m.icon==='desktop'?<Monitor size={13}/>:m.icon==='server'?<Server size={13}/>:<Cloud size={13}/>}{m.label}</b>
    <small>{m.cloud?(m.models.length?m.models.map(x=>x.label).join(', '):'Not set up'):m.server?'Model server':m.busy?'Busy'+(m.loaded?' · '+m.models.find(x=>x.id===m.loaded)?.label:''):m.loaded?(m.models.find(x=>x.id===m.loaded)?.label||m.loaded)+' loaded':m.known===false?'Connecting…':'Nothing loaded'}</small></button>)}</div>
  </section>
  <section>
   <div className="gen-label"><strong>Model</strong></div>
   {list.length?<div className="gen-models" role="radiogroup" aria-label="Model">{list.map(m=><button type="button" role="radio" aria-checked={m.id===chosen?.id} key={m.id||'server'} className={'gen-model-row '+(m.id===chosen?.id?'on':'')} onClick={()=>setModel(m.id)}>
    <i className="gen-radio"/><span><b>{m.label}</b><small>{[m.textured?'Textured':'Shape',m.multiview&&!chosenMachine.cloud?'uses 4 views':'',m.time,m.cost].filter(Boolean).join(' · ')}</small></span>{m.id&&m.id===chosenMachine.loaded&&<span className="tag ok">Loaded</span>}</button>)}</div>
    :<p className="quiet gen-cloud-empty">{chosenMachine.cloud?<>Add a Tripo or Meshy key to use the cloud. <button type="button" className="link-button" onClick={onOpenSettings}>Set up</button></>:'No models installed there yet.'}</p>}
   {note&&<p className={'gen-hint '+(needsLoad||chosenMachine.busy?'':'ok')}>{needsLoad||chosenMachine.busy?<RefreshCw size={12}/>:<Zap size={12}/>}{note}</p>}
   {warn&&<p className={'gen-hint '+warn.kind}>{warn.kind==='ok'?<Check size={12}/>:<CircleAlert size={12}/>}{warn.text}</p>}
  </section>
  <div className="gen-name-row"><label>Name<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)} placeholder="Ace"/></label>
   {chosen?.textured&&chosen.defaultTexture>0&&<label>Texture<Picker id="gen-form-texture" label="Texture size" value={String(textureValue)} options={(generators.textureSizes||[512,1024,2048,4096]).map(size=>({value:String(size),label:size+' px',detail:size===chosen.defaultTexture?'Default':''}))} onChange={v=>setTexture(Number(v))}/></label>}</div>
  <div className="gen-footer"><span className="quiet">{estimate}{projectBudget?' · aims for '+Number(projectBudget).toLocaleString()+' triangles':''}</span><button className="primary-button" type="submit" disabled={busy==='start'||!views.front||!chosen}>{busy==='start'?'Starting…':'Generate'}</button></div>
 </form>;
}

/** Running and just-finished generations, shown in the corner so the dialog can close while they work. */
export function GenerationTray({jobs,onOpen,onCancel,onDismiss}){
 if(!jobs?.length)return null;
 return <div className="generation-tray" role="status">{jobs.map(job=>{const running=!['done','failed','cancelled'].includes(job.status);return <div key={job.id} className={'generation-job '+job.status}>
  {running?<span className="spinner small"/>:job.status==='done'?<Check size={14}/>:<CircleAlert size={14}/>}
  <span><b>{job.name}</b><small>{job.status==='failed'?job.error:job.status==='cancelled'?'Cancelled':job.status==='done'?'Ready · '+job.providerLabel:job.providerLabel+' · '+job.step+(job.progress?' · '+job.progress+'%':'')}</small>{running&&<i className="import-bar"><i style={{width:(job.progress||3)+'%'}}/></i>}</span>
  {job.status==='done'&&job.assetId&&<button className="ghost-button" onClick={()=>{onOpen(job.assetId);onDismiss(job.id);}}>Open</button>}
  {running?<button className="ghost-button" onClick={()=>onCancel(job.id)}>Cancel</button>:<button className="ghost-button" aria-label="Dismiss" onClick={()=>onDismiss(job.id)}><X size={13}/></button>}
 </div>;})}</div>;
}
