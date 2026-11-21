import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,Box,CircleAlert,CircleCheck,Cloud,Cpu,Download,ExternalLink,Laptop,Monitor,Plus,Radar,RefreshCw,Server,SlidersHorizontal,Trash2,X} from 'lucide-react';
import Picker from './Picker.jsx';

const spaced=code=>String(code||'').replace(/(.{4})(?=.)/g,'$1-');
const hardwareLine=h=>!h?'':[h.gpu.kind==='none'?h.gpu.name:h.gpu.name+(h.gpu.kind==='nvidia'&&h.gpu.vramGB?' · '+h.gpu.vramGB+' GB':''),h.memoryGB+' GB memory',h.freeDiskGB!=null?h.freeDiskGB+' GB free':''].filter(Boolean).join(' · ');

/**
 * Where 3D models are generated, as one page: this computer, paired computers and model servers, and the cloud services.
 * Pick one on the left; everything about it is on the right, including installing models on a paired computer.
 */
export default function GenerationPage({base,request,generators,localModels,sharing,onGenerators,onLocalModels,onSharing,onError,onClose}){
 const [selected,setSelected]=useState('local'),[remote,setRemote]=useState({}),timer=useRef(null);
 const providers=generators?.providers||[],machines=providers.filter(p=>p.kind==='remote'),cloud=providers.filter(p=>p.kind==='cloud');
 const call=useCallback(async(path,body)=>request(base+path,body),[request,base]);
 // Load one paired computer's models. Errors are kept per computer so the sidebar can show it as offline.
 const loadRemote=useCallback(async id=>{try{const data=await fetch(base+'/api/machines/'+id).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error);return d;});setRemote(old=>({...old,[id]:{data,error:''}}));return data;}catch(e){setRemote(old=>({...old,[id]:{...old[id],error:e.message}}));return null;}},[base]);
 useEffect(()=>{call('/api/sharing/refresh').then(onGenerators).catch(()=>{});},[]);
 useEffect(()=>{for(const pc of machines)if(!pc.server&&!remote[pc.id])loadRemote(pc.id);},[machines.map(p=>p.id).join()]);
 // While a paired computer is installing, ask it every few seconds; when it finishes, refresh what it offers.
 useEffect(()=>{clearTimeout(timer.current);const pc=machines.find(p=>p.id===selected);const busy=pc&&remote[pc.id]?.data?.installing&&!remote[pc.id].data.installing.error;
  if(busy)timer.current=setTimeout(async()=>{const data=await loadRemote(pc.id);if(data&&!data.installing)call('/api/sharing/refresh').then(onGenerators).catch(()=>{});},2500);
  return()=>clearTimeout(timer.current);},[selected,remote]);
 if(!generators||!localModels)return <div className="review-board gen-page"><p className="quiet" style={{padding:20}}>Loading…</p></div>;

 const defaults=[{value:'ask',label:'Ask each time',detail:'Choose when generating'},
  ...(generators.providers.find(p=>p.id==='local')?.models||[]).map(m=>({value:'local:'+m.id,label:'This computer · '+m.label,detail:m.textured?'Textured':'Shape only'})),
  ...machines.flatMap(pc=>pc.models?.length?pc.models.map(m=>({value:pc.id+':'+m.id,label:pc.label+' · '+m.label,detail:m.textured?'Textured':'Shape only'})):[{value:pc.id,label:pc.label,detail:'Model server'}]),
  ...cloud.filter(p=>p.ready).map(p=>({value:p.id,label:p.label,detail:p.cost}))];
 const current=defaults.some(d=>d.value===generators.route)?generators.route:defaults.find(d=>d.value.split(':')[0]===generators.route)?.value||'ask';
 async function setDefault(route){onError('');try{onGenerators(await call('/api/generators',{route}));}catch(e){onError(e.message);}}
 // Texture size is a preference of this computer, per model on a machine, and is sent with each generation.
 const texture={sizes:generators.textureSizes||[512,1024,2048,4096],chosen:generators.textures||{},set:async(key,size)=>{onError('');try{onGenerators(await call('/api/generators',{textures:{[key]:size||null}}));}catch(e){onError(e.message);}}};
 const localCount=localModels.models.filter(m=>m.installed).length;
 const status=pc=>pc.server?'unknown':remote[pc.id]?.error?'offline':remote[pc.id]?.data?'online':'unknown';
 const item=(id,icon,label,sub,dot)=><button type="button" key={id} className={'gen-item '+(selected===id?'on':'')} onClick={()=>{onError('');setSelected(id);if(machines.some(p=>p.id===id))loadRemote(id);}}>{icon}<span><b>{label}</b>{sub&&<small>{sub}</small>}</span>{dot&&<i className={'gen-dot '+dot}/>}</button>;
 const pc=machines.find(p=>p.id===selected),service=cloud.find(p=>p.id===selected);

 return <div className="review-board gen-page">
  <header className="board-heading"><button type="button" className="ghost-button gen-back" aria-label="Back" onClick={onClose}><ArrowLeft size={15}/></button><span className="title-badge"><Box size={15} strokeWidth={1.9}/></span><div><h1>3D generation</h1></div>
   <div className="gen-default"><span>Default</span><Picker id="gen-default" label="Default model" value={current} options={defaults} onChange={setDefault}/></div></header>
  <div className="gen-layout">
   <nav className="gen-side" aria-label="Machines and services">
    <span className="gen-group">Machines</span>
    {item('local',<Laptop size={16}/>,'This computer',localModels.installing&&!localModels.installing.error?'Installing…':localCount?localCount+(localCount===1?' model':' models'):'No models yet','online')}
    {machines.map(m=>item(m.id,m.server?<Server size={16}/>:<Monitor size={16}/>,m.label,m.server?'Model server':remote[m.id]?.data?.installing&&!remote[m.id].data.installing.error?'Installing…':(m.models?.length||0)+((m.models?.length||0)===1?' model':' models'),status(m)))}
    {item('add',<Plus size={16}/>,'Add a computer')}
    <span className="gen-group">Cloud services</span>
    {cloud.map(p=>item(p.id,<Cloud size={16}/>,p.label,p.ready?p.cost:'Not set up',p.ready?'online':''))}
    <span className="gen-fill"/>
    {item('advanced',<SlidersHorizontal size={16}/>,'Advanced')}
   </nav>
   <main className="gen-main">
    {selected==='local'?<Machine machine="local" texture={texture} data={localModels} title="This computer" act={async(action,body)=>{onLocalModels(await call('/api/machines/local/'+action,body));}} onError={onError}
      extra={<LocalExtras base={base} call={call} localModels={localModels} sharing={sharing} onLocalModels={onLocalModels} onSharing={onSharing} onError={onError}/>}/>
    :pc?.server?<ServerPane pc={pc} call={call} onGenerators={onGenerators} onForget={()=>setSelected('local')} onError={onError}/>
    :pc?<Machine machine={pc.id} texture={texture} data={remote[pc.id]?.data} offline={remote[pc.id]?.error} title={pc.label} remote
      act={async(action,body)=>{await call('/api/machines/'+pc.id+'/'+action,body);await loadRemote(pc.id);if(action==='remove')call('/api/sharing/refresh').then(onGenerators).catch(()=>{});}} onError={onError}
      header={<RemoteActions pc={pc} call={call} onGenerators={onGenerators} onForget={()=>setSelected('local')} onRetry={()=>loadRemote(pc.id)} onError={onError}/>}/>
    :selected==='add'?<AddComputer call={call} known={machines} onAdded={(value,id)=>{onGenerators(value);setSelected(id);}} onError={onError}/>
    :service?<CloudPane service={service} call={call} onGenerators={onGenerators} onError={onError}/>
    :selected==='advanced'?<Advanced generators={generators} localModels={localModels} call={call} onGenerators={onGenerators} onAdded={(value,id)=>{onGenerators(value);setSelected(id);}} onError={onError}/>:null}
   </main>
  </div>
 </div>;
}

/** One machine's models: installed, installing, available and not available here. Works the same for this computer and a paired one. */
function Machine({machine,texture,data,title,remote,offline,act,extra,header,onError}){
 const [busy,setBusy]=useState(''),[accepted,setAccepted]=useState({});
 const run=async(label,action,body)=>{onError('');setBusy(label);try{await act(action,body);}catch(e){onError(e.message);}finally{setBusy('');}};
 if(!data)return <section className="gen-pane"><PaneHead title={title} sub={offline?'Offline':'Connecting…'} actions={header}/>{offline&&<p className="generator-result failed"><CircleAlert size={13}/>{offline}</p>}</section>;
 const {models,installing,hardware,server}=data,installed=models.filter(m=>m.installed),available=models.filter(m=>!m.installed&&m.ok&&installing?.model!==m.id),blocked=models.filter(m=>!m.installed&&!m.ok);
 const where=remote?' on '+title:'';
 return <section className="gen-pane">
  <PaneHead title={title} sub={hardwareLine(hardware)+(remote?' · Online':'')} icon={<Cpu size={13}/>} actions={header}/>
  <h3 className="gen-section">Installed</h3>
  {installed.length?installed.map(m=><div className="gen-row" key={m.id}><ModelInfo m={m}/>
   <div className="gen-actions">{m.textured&&m.defaultTexture>0&&<TextureSize id={'tex-'+machine+'-'+m.id} value={texture.chosen[machine+':'+m.id]||0} fallback={m.defaultTexture} sizes={texture.sizes} onChange={size=>texture.set(machine+':'+m.id,size)}/>}{server?.model===m.id&&['running','starting'].includes(server.state)&&<span className="generator-result ok"><CircleCheck size={13}/>{server.state==='starting'?'Starting':'Loaded'}</span>}
    <button type="button" className="ghost-button" disabled={!!busy} onClick={()=>{if(window.confirm('Remove '+m.label+where+'? This frees about '+m.diskGB+' GB. You can install it again later.'))run('remove','remove',{id:m.id});}}><Trash2 size={12}/>Remove</button></div></div>)
   :<p className="quiet gen-empty">No models installed{where} yet. Install one below.</p>}
  {installing&&<><h3 className="gen-section">Installing{where}</h3>
   <div className="gen-row"><div className="gen-model"><b>{models.find(m=>m.id===installing.model)?.label||installing.model}</b>
    {installing.error?<span className="generator-result failed"><CircleAlert size={13}/>{installing.error}</span>:<><small>{installing.step} · {installing.progress}%</small><i className="import-bar"><i style={{width:Math.max(2,installing.progress)+'%'}}/></i></>}</div>
    <div className="gen-actions">{installing.error?<><button type="button" className="ghost-button" disabled={!!busy} onClick={async()=>{await run('cancel','cancel');run('install','install',{id:installing.model,accept:true});}}>Try again</button><button type="button" className="ghost-button" onClick={()=>run('cancel','cancel')}>Dismiss</button></>
     :<button type="button" className="ghost-button" onClick={()=>run('cancel','cancel')}>Cancel</button>}</div></div>
   {!installing.error&&<p className="quiet gen-note">Safe to cancel: installing again picks up where the download stopped.</p>}</>}
  {available.length>0&&<><h3 className="gen-section">Available{remote?' for '+title:' for this computer'}</h3>
   {available.map(m=><div className="gen-row gen-available" key={m.id}><div className="gen-line"><ModelInfo m={m} extra={m.diskGB+' GB'+(m.note&&!m.tested?' · '+m.note:'')}/>
     <div className="gen-actions"><button type="button" className="ghost-button" disabled={!!busy||(!!installing&&!installing.error)||(m.licence?.accept&&!accepted[m.id])} title={installing&&!installing.error?'One install at a time':m.licence?.accept&&!accepted[m.id]?'Accept the licence first':''} onClick={()=>run('install','install',{id:m.id,accept:!!accepted[m.id]})}><Download size={12}/>{busy==='install'?'Starting…':'Install'}</button></div></div>
    {m.licence?.accept&&<label className="gen-licence"><input type="checkbox" checked={!!accepted[m.id]} onChange={e=>setAccepted({...accepted,[m.id]:e.target.checked})}/><span>{m.licence.accept} <a href={m.licence.url} target="_blank" rel="noreferrer">Read the licence</a></span></label>}</div>)}</>}
  {blocked.length>0&&<><h3 className="gen-section">Not available here</h3>
   {blocked.map(m=><div className="gen-row muted" key={m.id}><div className="gen-model"><b>{m.label}</b><small>{m.reason}</small></div></div>)}</>}
  {extra}
 </section>;
}

/** The texture size asked of a textured model. "Default" leaves it to the model. Bigger takes longer to bake and makes a bigger file. */
function TextureSize({id,value,fallback,sizes,onChange}){
 return <div className="gen-texture" title="Texture size. Bigger takes longer and makes a bigger file."><Picker id={id} label="Texture size" value={String(value)} options={[{value:'0',label:'Texture '+fallback+' px',detail:'The model\u2019s default'},...sizes.filter(s=>s!==fallback).map(s=>({value:String(s),label:'Texture '+s+' px',detail:s>fallback?'Sharper, slower to bake':'Smaller file, faster'}))]} onChange={v=>onChange(Number(v))}/></div>;
}

function PaneHead({title,sub,icon,actions}){return <div className="gen-head"><div><h2>{title}</h2>{sub&&<p>{icon}{sub}</p>}</div>{actions&&<div className="gen-actions">{actions}</div>}</div>;}

function ModelInfo({m,extra}){return <div className="gen-model"><b>{m.label}<span className="tag">{m.textured?'Textured':'Shape'}</span>{m.multiview&&<span className="tag">4 views</span>}</b><small>{[m.time,m.strength].filter(Boolean).join(' · ')||m.about}</small>{extra&&<small>{extra}</small>}</div>;}

/** Sharing and the install log, which only make sense for this computer. */
function LocalExtras({call,localModels,sharing,onSharing,onError}){
 const [log,setLog]=useState(false),share=async change=>{onError('');try{onSharing(await call('/api/sharing',change));}catch(e){onError(e.message);}};
 return <>
  <h3 className="gen-section">Sharing</h3>
  {sharing&&<div className="gen-row"><label className="gen-switch"><input type="checkbox" checked={sharing.enabled} onChange={e=>share({enabled:e.target.checked})}/><span><b>Let other computers use this one</b><small>Paired computers on your network can generate here, and install or remove models here. Only for networks you trust.</small></span></label></div>}
  {sharing?.enabled&&(sharing.error?<p className="generator-result failed"><CircleAlert size={13}/>{sharing.error}</p>:<div className="share-card gen-share"><span><small>Shown to others as</small><b>{sharing.name}</b></span><span><small>Pairing code</small><code>{spaced(sharing.code)}</code></span><button type="button" className="ghost-button" title="Computers already paired will need to pair again" onClick={()=>share({newCode:true})}><RefreshCw size={11}/>New code</button></div>)}
  {localModels.log?.length>0&&<><button type="button" className="local-log-toggle" onClick={()=>setLog(!log)}>{log?'Hide':'Show'} the install log</button>{log&&<pre className="local-log">{localModels.log.join('\n')}</pre>}</>}
 </>;
}

function RemoteActions({pc,call,onGenerators,onForget,onRetry,onError}){
 const [result,setResult]=useState(null);
 async function test(){onError('');setResult({state:'running'});try{setResult({state:'ok',...await call('/api/generators/test',{id:pc.id})});onRetry();}catch(e){setResult({state:'failed',message:e.message});}}
 async function forget(){if(!window.confirm('Stop using '+pc.label+'? You can pair with it again later.'))return;onError('');try{onGenerators(await call('/api/sharing/forget',{id:pc.id}));onForget();}catch(e){onError(e.message);}}
 return <>{result?.state==='ok'&&<span className="generator-result ok"><CircleCheck size={13}/>Connected</span>}{result?.state==='failed'&&<span className="generator-result failed" title={result.message}><CircleAlert size={13}/>Not reachable</span>}
  <button type="button" className="ghost-button" disabled={result?.state==='running'} onClick={test}>{result?.state==='running'?'Testing…':'Test'}</button><button type="button" className="ghost-button" onClick={forget}>Forget</button></>;
}

function ServerPane({pc,call,onGenerators,onForget,onError}){
 return <section className="gen-pane"><PaneHead title={pc.label} sub={'Model server at '+pc.url} actions={<RemoteActions pc={pc} call={call} onGenerators={onGenerators} onForget={onForget} onRetry={()=>{}} onError={onError}/>}/>
  <p className="quiet gen-note">A model server Meshdesk did not install, such as a Hunyuan3D server run by hand. Its models are managed where it runs; Meshdesk sends it the front view and gets the model back.</p></section>;
}

/** Finding a computer on the network and pairing with it once. */
function AddComputer({call,known,onAdded,onError}){
 const [busy,setBusy]=useState(''),[found,setFound]=useState(null),[pairing,setPairing]=useState(null);
 async function find(){onError('');setBusy('find');setPairing(null);try{setFound(await call('/api/sharing/discover'));}catch(e){onError(e.message);}finally{setBusy('');}}
 async function pair(event){event.preventDefault();onError('');setBusy('pair');try{const result=await call('/api/sharing/connect',{url:pairing.url,code:pairing.code});onAdded(result.generators,result.id);}catch(e){onError(e.message);}finally{setBusy('');}}
 const fresh=(found||[]).filter(pc=>!known.some(k=>k.url===pc.url));
 return <section className="gen-pane"><PaneHead title="Add a computer" sub="Use another computer's graphics card. Turn on sharing in Meshdesk there first."/>
  <div className="gen-actions gen-start"><button type="button" className="ghost-button" disabled={busy==='find'} onClick={find}><Radar size={12}/>{busy==='find'?'Looking…':'Find on my network'}</button></div>
  {found&&(fresh.length?fresh.map(pc=><div className="gen-row" key={pc.id}><div className="gen-model"><b>{pc.name}</b><small>{pc.ready?pc.model+' · '+pc.gpu:'No models installed yet · '+pc.gpu}</small></div>
   {pairing?.url===pc.url?<form className="remote-pair" onSubmit={pair}><input autoFocus aria-label={'Pairing code for '+pc.name} value={pairing.code} onChange={e=>setPairing({...pairing,code:e.target.value})} placeholder="Pairing code" spellCheck={false} autoComplete="off"/><button type="submit" className="ghost-button" disabled={busy==='pair'||pairing.code.replace(/[^A-Za-z0-9]/g,'').length<8}>{busy==='pair'?'Pairing…':'Pair'}</button></form>
    :<button type="button" className="ghost-button" onClick={()=>setPairing({url:pc.url,code:''})}>Pair</button>}</div>)
   :<p className="quiet gen-note">{found.length?'Every computer that answered is already added.':'No computer answered. On the other computer, open Meshdesk, go to 3D generation, open This computer and turn on sharing. Both must be on the same network, and its firewall must allow Meshdesk.'}</p>)}
  <p className="quiet gen-note">Pairing gives this computer the right to generate there and to install or remove models there.</p>
 </section>;
}

function CloudPane({service,call,onGenerators,onError}){
 const [key,setKey]=useState(''),[texture,setTexture]=useState(service.texture),[result,setResult]=useState(null);
 useEffect(()=>{setKey('');setResult(null);setTexture(service.texture);},[service.id]);
 async function save(){onError('');setResult({state:'running'});try{onGenerators(await call('/api/generators',{providers:{[service.id]:{enabled:true,texture,...(key?{apiKey:key}:{})}}}));setKey('');setResult({state:'ok',...await call('/api/generators/test',{id:service.id})});}catch(e){setResult({state:'failed',message:e.message});}}
 async function off(){onError('');try{onGenerators(await call('/api/generators',{providers:{[service.id]:{enabled:false}}}));setResult(null);}catch(e){onError(e.message);}}
 return <section className="gen-pane"><PaneHead title={service.label} sub={service.about}/>
  <p className="quiet gen-note">{service.pricing}</p>
  <label className="gen-field">API key<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder={service.keyHint?'Saved · ends in '+service.keyHint+' · paste a new key to replace it':'Paste your '+service.label+' API key'} spellCheck={false}/></label>
  <label className="gen-field">Texture<Picker id={'gen-texture-'+service.id} label="Texture" value={texture} options={service.textureOptions} onChange={setTexture}/></label>
  <div className="gen-actions gen-start"><button type="button" className="primary-button" disabled={result?.state==='running'||(!key&&!service.keyHint)} onClick={save}>{result?.state==='running'?'Testing…':'Save and test'}</button>
   {service.keyUrl&&<a className="ghost-button" href={service.keyUrl} target="_blank" rel="noreferrer">Get a key<ExternalLink size={12}/></a>}
   {service.enabled&&<button type="button" className="ghost-button" onClick={off}>Turn off</button>}
   {result?.state==='ok'&&<span className="generator-result ok"><CircleCheck size={13}/>{result.message}</span>}{result?.state==='failed'&&<span className="generator-result failed"><CircleAlert size={13}/>{result.message}</span>}</div>
 </section>;
}

function Advanced({generators,localModels,call,onGenerators,onAdded,onError}){
 const [folder,setFolder]=useState(generators.modelsDirectory||''),[token,setToken]=useState(''),[server,setServer]=useState(''),[saved,setSaved]=useState('');
 async function save(change,label){onError('');try{onGenerators(await call('/api/generators',change));setSaved(label);}catch(e){onError(e.message);}}
 async function add(){onError('');try{const result=await call('/api/sharing/server',{url:server});setServer('');onAdded(result.generators,result.id);}catch(e){onError(e.message);}}
 return <section className="gen-pane"><PaneHead title="Advanced"/>
  <label className="gen-field">Models folder on this computer<div className="gen-inline"><input value={folder} onChange={e=>setFolder(e.target.value)} placeholder={localModels.root} spellCheck={false}/><button type="button" className="ghost-button" onClick={()=>save({modelsDirectory:folder},'folder')}>Save</button></div></label>
  <p className="quiet gen-note">Now: {localModels.root}. A new folder is used from the next start of Meshdesk; models already installed in the old one keep working.{saved==='folder'?' Saved.':''}</p>
  <label className="gen-field">Hugging Face token<div className="gen-inline"><input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} placeholder={generators.hfTokenHint?'Saved · ends in '+generators.hfTokenHint:'Only for models that need an account'} spellCheck={false}/><button type="button" className="ghost-button" disabled={!token} onClick={()=>{save({hfToken:token},'token');setToken('');}}>Save</button></div></label>
  {saved==='token'&&<p className="quiet gen-note">Saved.</p>}
  <label className="gen-field">Model server at an address<div className="gen-inline"><input value={server} onChange={e=>setServer(e.target.value)} placeholder="http://192.168.1.20:8080" spellCheck={false}/><button type="button" className="ghost-button" disabled={!server.trim()} onClick={add}><Plus size={12}/>Add</button></div></label>
  <p className="quiet gen-note">For a Hunyuan3D server you run yourself, outside Meshdesk. It appears under Machines.</p>
 </section>;
}
