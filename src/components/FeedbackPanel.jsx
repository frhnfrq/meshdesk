import {useEffect,useRef,useState} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {Paperclip,Sparkles,X,AtSign,Camera,ArrowUp,ArrowUpRight,Square,ListChecks,Box,RefreshCw,MousePointerClick,SlidersHorizontal} from 'lucide-react';
import {imageData} from '../images.js';
import PanelResize from './PanelResize.jsx';
import Picker from './Picker.jsx';
import {AgentLogo} from './AgentLogo.jsx';
const AGENTS={codex:'Codex',claude:'Claude'};
const SCENE_SUGGESTIONS=['Lay out a street corner using models from my library','Give this scene warm late-afternoon lighting','Space the objects out so nothing overlaps'];
const SUGGESTIONS=['What should we improve first on this model?','Check the topology and UVs for game-readiness','Reduce the polygon count without changing the silhouette'];
const STATES={ready:'Connected',connecting:'Connecting',offline:'Offline','signed-out':'Signed out'};
const EFFORTS={low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max',ultra:'Ultra',minimal:'Minimal',none:'None'};
const markdownComponents={
 a:({children,href})=>/^https?:\/\//.test(href||'')?<a href={href} target="_blank" rel="noreferrer">{children}</a>:<span>{children}</span>,
 img:({alt})=><span>{alt}</span>,
 table:({children})=><div className="markdown-table" tabIndex={0}><table>{children}</table></div>
};
export default function FeedbackPanel({asset,catalog,panel,base='',draftState={},onDraftChange,onUpload,selectedPart,onOpenModel,conversation,connection,onSend,onCancel,onClose,onRestore,capture,previewReady,onReconnect,agentOptions,onAgentChange,sideTab,onSideTab,onInspectorHost}){
 const drafts={[asset.id]:draftState.text||''},references={[asset.id]:draftState.ids||[]};const setDrafts=fn=>onDraftChange({...draftState,text:fn(drafts)[asset.id]});const setReferences=fn=>onDraftChange({...draftState,ids:fn(references)[asset.id]});const [uploading,setUploading]=useState(false);const uploadInput=useRef(null);const [attach,setAttach]=useState(true),[sending,setSending]=useState({}),[errors,setErrors]=useState({});
 const [picker,setPicker]=useState(false),[query,setQuery]=useState(''),[mention,setMention]=useState(null),[active,setActive]=useState(0);
 const scroll=useRef(null),follow=useRef(true),composer=useRef(null);
 const messages=conversation?.messages||[],busy=!!conversation?.busy||!!sending[asset.id],text=drafts[asset.id]||'',error=errors[asset.id]||'',ids=references[asset.id]||[];
 const matches=catalog.filter(a=>a.type==='model'&&!a.removed&&a.id!==asset.id&&!ids.includes(a.id)&&(a.name+' '+a.group).toLowerCase().includes(query.toLowerCase()));
 useEffect(()=>{follow.current=true;setPicker(false);setMention(null);setTimeout(()=>scroll.current?.scrollTo({top:scroll.current.scrollHeight}),0);},[asset.id]);
 useEffect(()=>{if(follow.current)scroll.current?.scrollTo({top:scroll.current.scrollHeight});},[conversation]);
 function changeText(e){const value=e.target.value;setDrafts(old=>({...old,[asset.id]:value}));const end=e.target.selectionStart;const match=value.slice(0,end).match(/(?:^|\s)@([^@\n]*)$/);if(match&&ids.length<8){setMention({start:end-match[1].length-1,end});setQuery(match[1]);setPicker(true);setActive(0);}else if(mention){setPicker(false);setMention(null);}}
 function addModel(model){if(ids.length>=8)return;setReferences(old=>({...old,[asset.id]:[...ids,model.id]}));if(mention)setDrafts(old=>({...old,[asset.id]:text.slice(0,mention.start)+'@'+model.name+' '+text.slice(mention.end)}));setPicker(false);setMention(null);setQuery('');composer.current?.focus();}
 function pickerKey(e){if(e.key==='Escape'){e.preventDefault();setPicker(false);setMention(null);}else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setActive(i=>Math.max(0,Math.min(matches.length-1,i+(e.key==='ArrowDown'?1:-1))));}else if(e.key==='Enter'&&!e.metaKey&&!e.ctrlKey&&matches[active]){e.preventDefault();addModel(matches[active]);}}
 async function submit(event){event?.preventDefault();if(!text.trim()||busy)return;const id=asset.id;setErrors(old=>({...old,[id]:''}));setSending(old=>({...old,[id]:true}));try{const context=previewReady?capture():{};if(!attach)delete context.snapshot;await onSend(id,{text,requestId:crypto.randomUUID(),modelIds:ids,attachments:draftState.attachments||[],selectedPart,...context});onDraftChange({text:'',ids:[],attachments:[]});setPicker(false);setMention(null);follow.current=true;}catch(e){setErrors(old=>({...old,[id]:e.message}));}finally{setSending(old=>({...old,[id]:false}));}}
 async function upload(files){setUploading(true);try{const attached=[...(draftState.attachments||[])];for(const file of [...files]){if(attached.length>=4)throw Error('Attach up to four screenshots.');const image=await imageData(file);attached.push(await onUpload({name:file.name,image}));}onDraftChange({...draftState,attachments:attached});}catch(e){setErrors(old=>({...old,[asset.id]:e.message}));}finally{setUploading(false);}}
 const ready=connection.state==='ready',provider=connection.provider||'codex',agentName=connection.label||AGENTS[provider];
 const providers=agentOptions?.providers||[{id:provider,label:agentName,models:[]}],chosen=providers.find(p=>p.id===provider)||providers[0],models=(chosen.models||[]).filter(m=>m.id!=='default');
 const model=connection.model||'',effort=connection.effort||'',activeModel=(chosen.models||[]).find(m=>m.id===model)||(chosen.models||[]).find(m=>m.id==='default'||m.isDefault)||(chosen.models||[])[0];
 const modelOptions=[{value:'',label:'Default model'},...models.map(m=>({value:m.id,label:m.label,detail:m.detail})),...(model&&!models.some(m=>m.id===model)?[{value:model,label:model}]:[])];
 const efforts=activeModel?.efforts||[],effortOptions=[{value:'',label:'Auto'},...efforts.map(e=>({value:e,label:EFFORTS[e]||e})),...(effort&&!efforts.includes(effort)?[{value:effort,label:EFFORTS[effort]||effort}]:[])];
 const changeAgent=change=>onAgentChange(change).catch(e=>setErrors(old=>({...old,[asset.id]:e.message})));
 function changeModel(value){const next=(chosen.models||[]).find(m=>m.id===value);changeAgent({model:value,...(effort&&next&&!next.efforts.includes(effort)?{effort:''}:{})});}
 const live=message=>['pending','streaming'].includes(message.status),nameOf=message=>AGENTS[message.agent?.provider]||'Codex';
 return <aside onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(e.dataTransfer.files.length)upload(e.dataTransfer.files);}} className={'feedback-panel'+(sideTab==='inspector'?' show-inspector':'')} aria-label={agentName+' panel'}>
  <PanelResize width={panel.width} max={panel.max} onResize={panel.update}/>
  <header className="chat-heading">
   {sideTab?<div className="side-tabs" role="tablist" aria-label="Side panel"><button type="button" role="tab" aria-selected={sideTab==='inspector'} className={sideTab==='inspector'?'active':''} onClick={()=>onSideTab('inspector')}><SlidersHorizontal size={13}/>Inspector</button><button type="button" role="tab" aria-selected={sideTab==='chat'} className={sideTab==='chat'?'active':''} onClick={()=>onSideTab('chat')}><AgentLogo provider={provider} size={13}/>{agentName}{busy&&<i className="pulse"/>}</button></div>:<><span className={'agent-avatar '+provider} aria-hidden="true"><AgentLogo provider={provider} size={16}/></span>
   <div className="chat-title"><strong>{agentName}</strong><span title={asset.path}>{asset.name}</span></div></>}
   <span hidden={sideTab==='inspector'} className={'status-pill '+(sideTab?'compact ':'')+connection.state} title={agentName+' connection: '+connection.state}><i/>{STATES[connection.state]||'Disconnected'}</span>
   <button type="button" className="tool-icon" data-tip="Close panel" data-tip-align="end" onClick={onClose} aria-label={sideTab?'Close side panel':'Close '+agentName+' panel'}><X size={16}/></button>
  </header>
  {sideTab&&<><div className="inspector-host" ref={onInspectorHost} hidden={sideTab!=='inspector'}/></>}
  <div className="conversation" ref={scroll} onScroll={()=>{const el=scroll.current;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;}} aria-label={agentName+' conversation'}>
   {!messages.length&&<div className="chat-empty">
    <span className={'agent-avatar large '+provider} aria-hidden="true"><AgentLogo provider={provider} size={28}/></span>
    <h3>A second pair of eyes</h3>
    <p>{asset.type==='scene'?'Ask for models to be added, arranged or lit in this scene.':'Ask about this model, request a Blender edit, or organize your library.'} Type <kbd>@</kbd> to reference another model.</p>
    <div className="suggestions">{(asset.type==='scene'?SCENE_SUGGESTIONS:SUGGESTIONS).map(suggestion=><button type="button" className="suggestion" key={suggestion} onClick={()=>{setDrafts(old=>({...old,[asset.id]:suggestion}));composer.current?.focus();}}>{suggestion}<ArrowUpRight size={14}/></button>)}</div>
   </div>}
   {messages.map(message=><article key={message.id} className={'message '+message.role+(live(message)?' live':'')}>
    <div className="message-author">{message.role==='assistant'&&<span className={'agent-avatar small '+(message.agent?.provider||'codex')} aria-hidden="true"><AgentLogo provider={message.agent?.provider||'codex'} size={12}/></span>}<strong>{message.role==='user'?'You':nameOf(message)}</strong><time>{new Date(message.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div>
    {message.capture&&<button type="button" className="capture-card" onClick={()=>onRestore(message.view)} title="Restore this camera angle"><img src={base+'/captures/'+message.capture} alt="Model view attached to this feedback"/><span><Camera size={12}/>View attached<em>Restore angle</em></span></button>}
    {!!message.references?.length&&<div className="reference-chips saved">{message.references.map(model=><button key={model.id} type="button" title={model.path} onClick={()=>onOpenModel(model.id)}><Box size={12}/>{model.name}<ArrowUpRight size={12}/></button>)}</div>}
    {!!message.attachments?.length&&<div className="uploaded-images">{message.attachments.map(a=><a href={base+'/captures/'+a.name} target="_blank" rel="noreferrer" key={a.name}><img src={base+'/captures/'+a.name} alt={a.label}/></a>)}</div>}
    {message.selectedPart&&<div className="part-chip"><MousePointerClick size={12}/>{message.selectedPart.meshName} · {message.selectedPart.materialName}</div>}
    {!!message.steps?.length&&<details className="activity" open={live(message)}><summary><ListChecks size={13}/>{message.steps.length} {message.steps.length===1?'step':'steps'}</summary><div className="steps">{message.steps.map((s,i)=><div key={i} className={'step '+s.status}><i/>{s.label}</div>)}</div></details>}
    {!!message.updates?.length&&<details className="activity updates" open={live(message)}><summary><Sparkles size={13}/>{nameOf(message)} notes</summary><div className="steps">{message.updates.map((u,i)=><Markdown key={i} remarkPlugins={[remarkGfm]} components={markdownComponents}>{u}</Markdown>)}</div></details>}
    {message.text&&<div className="message-body">{message.role==='assistant'?<Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{message.text}</Markdown>:<div className="user-text">{message.text}</div>}</div>}
    {live(message)&&<div className="reply-progress"><span className="shimmer">{conversation.progress||'Thinking…'}</span></div>}
    {message.status==='interrupted'&&<div className="reply-note">Reply stopped. You can send a follow-up.</div>}
    {message.error&&<div className="reply-error">{message.error}</div>}
   </article>)}
  </div>
  <form className="composer" onSubmit={submit}>
   {error&&<div className="form-error" role="alert">{error}</div>}
   {!ready&&<div className="connection-message"><span>{connection.state==='connecting'?'Connecting to your '+agentName+' sign-in…':connection.state==='offline'?'Local server disconnected. Reconnecting…':connection.state==='signed-out'?<>{agentName} is signed out. Run <code>{provider==='claude'?'claude auth login':'codex login'}</code> in Terminal.</>:agentName+' is disconnected.'}</span>{!['connecting','offline'].includes(connection.state)&&<button type="button" onClick={()=>onReconnect().catch(e=>setErrors(old=>({...old,[asset.id]:e.message})))}><RefreshCw size={12}/>Reconnect</button>}</div>}
   {picker&&<div className="model-mention-picker" role="dialog" aria-label="Reference a model"><div className="mention-heading"><strong>Reference a model</strong><button type="button" className="tool-icon" aria-label="Close model picker" onClick={()=>{setPicker(false);setMention(null);}}><X size={14}/></button></div><input autoFocus={!mention} type="search" aria-label="Search models to reference" placeholder="Search by model or folder…" value={query} onChange={e=>{setQuery(e.target.value);setActive(0);}} onKeyDown={pickerKey}/><div className="mention-results" role="listbox" aria-label="Matching models">{matches.map((model,index)=><button type="button" role="option" aria-selected={index===active} key={model.id} onClick={()=>addModel(model)}><Box size={14}/><span><strong>{model.name}</strong><small>{model.group.replaceAll('/',' / ')}</small></span></button>)}{!matches.length&&<p>No matching models.</p>}</div></div>}
   <div className="composer-box">
    {(!!ids.length||selectedPart||!!draftState.attachments?.length)&&<div className="composer-context">
     {!!draftState.attachments?.length&&<div className="pending-images">{draftState.attachments.map(a=><div key={a.name}><img src={base+'/captures/'+a.name} alt={a.label}/><button type="button" aria-label={'Remove '+a.label} onClick={()=>onDraftChange({...draftState,attachments:draftState.attachments.filter(t=>t.name!==a.name)})}><X size={10}/></button></div>)}</div>}
     {(!!ids.length||selectedPart)&&<div className="reference-chips">{selectedPart&&<span className="part-chip"><MousePointerClick size={12}/>{selectedPart.meshName} · {selectedPart.materialName}</span>}{ids.map(id=>{const model=catalog.find(a=>a.id===id);return <button key={id} type="button" title={model?.path} aria-label={'Remove reference '+model?.name} onClick={()=>setReferences(old=>({...old,[asset.id]:ids.filter(i=>i!==id)}))}><Box size={12}/>{model?.name}<X size={11}/></button>;})}</div>}
    </div>}
    <input hidden ref={uploadInput} type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={e=>{upload(e.target.files);e.target.value='';}}/>
    <textarea rows={1} onPaste={e=>{const images=[...e.clipboardData.files].filter(f=>f.type.startsWith('image/'));if(images.length){e.preventDefault();upload(images);}}} ref={composer} aria-label="Feedback message" placeholder={'Ask '+agentName+' about this '+(asset.type==='scene'?'scene':'model')+'…'} value={text} maxLength={12000} onChange={changeText} onKeyDown={e=>{if(picker){pickerKey(e);if(e.defaultPrevented)return;}if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();submit();}}}/>
    <div className="composer-actions">
     <div className="attachment-actions">
      <button className="tool-icon" type="button" data-tip="Attach screenshots" data-tip-side="top" data-tip-align="start" aria-label="Upload screenshots" disabled={uploading} onClick={()=>uploadInput.current.click()}><Paperclip size={15}/></button>
      <button className="tool-icon" type="button" data-tip="Reference a model" data-tip-side="top" aria-label="Reference another model" disabled={ids.length>=8} aria-expanded={picker} onClick={()=>{setPicker(!picker);setMention(null);setQuery('');setActive(0);}}><AtSign size={15}/></button>
      <label className="attach-toggle" title="Send a screenshot of the current view with your message"><input type="checkbox" checked={attach} onChange={e=>setAttach(e.target.checked)}/><Camera size={13}/>Current view</label>
     </div>
     <div className="send-actions"><kbd className="composer-hint">⌘↵</kbd>{busy?<button type="button" className="stop-button" aria-label="Stop reply" data-tip="Stop" data-tip-side="top" data-tip-align="end" onClick={()=>onCancel(asset.id).catch(e=>setErrors(old=>({...old,[asset.id]:e.message})))}><Square size={11} fill="currentColor"/></button>:<button className="send-button" type="submit" aria-label="Send message" disabled={uploading||!text.trim()||(attach&&!previewReady)||connection.state==='offline'}><ArrowUp size={16} strokeWidth={2.4}/></button>}</div>
    </div>
   </div>
   <div className="agent-settings" role="group" aria-label="Agent settings" data-provider={provider}><Picker className="ghost" id="agent-provider" label="Agent" options={providers.map(p=>({value:p.id,label:p.label}))} value={provider} onChange={value=>changeAgent({provider:value})}/><Picker className="ghost" id="agent-model" label="Model" options={modelOptions} value={model} onChange={changeModel}/><Picker className="ghost" id="agent-effort" label="Reasoning level" options={effortOptions} value={effort} onChange={value=>changeAgent({effort:value})}/></div>
  </form>
 </aside>;
}
