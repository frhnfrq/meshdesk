import {useEffect,useRef,useState} from 'react';
import {Palette,X,Plus,Upload,ImagePlus,Pipette,StickyNote,Maximize,Minus,MessageSquare,Trash2,History,Check} from 'lucide-react';
import {fileBase64} from '../images.js';
const IMAGE=/\.(png|jpe?g|webp)$/i;
const LIBRARY_DRAG='application/x-meshdesk-image';
const ROLES=[['primary','Primary'],['accent','Accent'],['neutral','Neutrals']];
const newId=prefix=>prefix+'-'+Math.random().toString(36).slice(2,10);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
/** Older guides kept their rules as two blocks of free text; each sentence or line becomes one rule. */
function legacyRules(style){return [style.materialRules,style.notes].flatMap(text=>String(text||'').split(/\n+|(?<=[.!?])\s+/)).map(text=>text.trim().slice(0,240)).filter(Boolean).slice(0,40).map((text,i)=>({id:'rule-'+(i+1),text,on:true}));}
/** The guide as this page edits it. A guide saved before the canvas existed gets its images laid out in a grid. */
function normalise(style={}){return {
 palette:(style.palette||[]).map(c=>({name:c.name||'',color:c.color,role:c.role||'primary'})),
 texelDensity:style.texelDensity||0,
 rules:Array.isArray(style.rules)?style.rules.map(r=>({...r})):legacyRules(style),
 board:{items:style.board?.items?style.board.items.map(i=>({...i})):(style.references||[]).map((assetId,i)=>({id:'item-'+(i+1),kind:'image',assetId,x:(i%3)*290,y:Math.floor(i/3)*240,w:270}))}};}
const outgoing=draft=>({...draft,rules:draft.rules.filter(r=>r.text.trim()),materialRules:'',notes:''});
const loadImage=src=>new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>resolve(null);image.src=src;});
function wrapText(ctx,text,width){const lines=[];for(const paragraph of String(text).split('\n')){let line='';for(const word of paragraph.split(' ')){const next=line?line+' '+word:word;if(line&&ctx.measureText(next).width>width){lines.push(line);line=word;}else line=next;}lines.push(line);}return lines;}
/**
 * Draws the board as one JPEG, the way it is arranged, so an agent sees the same picture you do.
 * Returns null for an empty board.
 */
async function drawBoard(items,base){if(!items.length)return null;const probe=document.createElement('canvas').getContext('2d');probe.font='13px Inter, system-ui, sans-serif';
 const boxes=(await Promise.all(items.map(async item=>{if(item.kind==='image'){const image=await loadImage(base+'/library/'+item.assetId);return image?{item,image,h:item.w*image.naturalHeight/image.naturalWidth}:null;}if(item.kind==='note'){const lines=wrapText(probe,item.text,item.w-24);return {item,lines,h:lines.length*18+20};}return {item,h:30,w:170};}))).filter(Boolean);if(!boxes.length)return null;
 const x0=Math.min(...boxes.map(b=>b.item.x)),y0=Math.min(...boxes.map(b=>b.item.y)),x1=Math.max(...boxes.map(b=>b.item.x+(b.w||b.item.w))),y1=Math.max(...boxes.map(b=>b.item.y+b.h));
 for(const limit of [1800,1200,800]){const scale=Math.min(1.5,limit/Math.max(x1-x0,y1-y0)),pad=24,canvas=document.createElement('canvas');canvas.width=Math.ceil((x1-x0)*scale)+pad*2;canvas.height=Math.ceil((y1-y0)*scale)+pad*2;const ctx=canvas.getContext('2d');ctx.fillStyle='#0a0b0d';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.translate(pad,pad);ctx.scale(scale,scale);ctx.translate(-x0,-y0);
  for(const box of boxes){const {item}=box;if(box.image)ctx.drawImage(box.image,item.x,item.y,item.w,box.h);else if(item.kind==='note'){ctx.fillStyle='#2a2618';ctx.fillRect(item.x,item.y,item.w,box.h);ctx.fillStyle='#e9dcae';ctx.font='13px Inter, system-ui, sans-serif';ctx.textBaseline='top';box.lines.forEach((line,i)=>ctx.fillText(line,item.x+12,item.y+11+i*18));}else{ctx.fillStyle='#1d2025';ctx.fillRect(item.x,item.y,170,30);ctx.fillStyle=item.color;ctx.fillRect(item.x+8,item.y+8,14,14);ctx.fillStyle='#b6bac1';ctx.font='12px Inter, system-ui, sans-serif';ctx.textBaseline='middle';ctx.fillText((item.name||'')+' '+item.color,item.x+30,item.y+15);}}
  const data=canvas.toDataURL('image/jpeg',.85);if(data.length<5e6)return data;}
 return null;}

/**
 * The style guide as a page: a free canvas of reference images and notes beside the palette, the written rules and the budgets.
 * Everything saves as you edit. Agents read the palette and rules with every message and get a picture of the canvas.
 */
export default function StyleBoard({base,settings,catalog,request,onSave,onError,onClose,onAsk}){
 const [draft,setDraft]=useState(()=>normalise(settings?.style)),[maxTexture,setMaxTexture]=useState(settings?.maxTextureSize||''),[saveState,setSaveState]=useState('Saved'),[busy,setBusy]=useState(''),[versionsOpen,setVersionsOpen]=useState(false),[newRule,setNewRule]=useState('');
 const [view,setView]=useState({x:40,y:40,z:1}),[selected,setSelected]=useState(()=>new Set()),[picking,setPicking]=useState(false),[editing,setEditing]=useState(null),[over,setOver]=useState(false);
 const stage=useRef(null),world=useRef(null),fileInput=useRef(null),drag=useRef(null),latest=useRef(draft),texture=useRef(maxTexture),saveTimer=useRef(null),shotTimer=useRef(null),saving=useRef(false),ownKey=useRef(JSON.stringify(settings?.style||null)),fitted=useRef(false);
 latest.current=draft;texture.current=maxTexture;
 const incomingKey=JSON.stringify(settings?.style||null);
 // A change made elsewhere (an applied proposal, a restored version) replaces what is on screen; our own saves coming back do not.
 useEffect(()=>{if(incomingKey===ownKey.current||saving.current||saveTimer.current)return;ownKey.current=incomingKey;setDraft(normalise(settings?.style));setMaxTexture(settings?.maxTextureSize||'');clearTimeout(shotTimer.current);shotTimer.current=setTimeout(snapshot,1500);},[incomingKey]);
 async function saveNow(){clearTimeout(saveTimer.current);saveTimer.current=null;saving.current=true;setSaveState('Saving…');try{const value=await onSave({style:outgoing(latest.current),maxTextureSize:texture.current});ownKey.current=JSON.stringify(value.style||null);setSaveState('Saved');clearTimeout(shotTimer.current);shotTimer.current=setTimeout(snapshot,1500);}catch(e){setSaveState('Not saved');onError(e.message);}finally{saving.current=false;}}
 async function snapshot(){try{const image=await drawBoard(latest.current.board.items,base);if(image)await request(base+'/api/style/snapshot',{image});}catch{/* The picture is a convenience for agents; the guide itself is already saved. */}}
 function change(next){setDraft(old=>{const value=typeof next==='function'?next(old):{...old,...next};latest.current=value;return value;});setSaveState('Saving…');clearTimeout(saveTimer.current);saveTimer.current=setTimeout(saveNow,600);}
 // An agent may have changed the board while this page was closed, which drops the saved picture of it; draw a fresh one.
 useEffect(()=>{const timer=setTimeout(snapshot,2000);return()=>clearTimeout(timer);},[]);
 // Leaving the page with a save still queued sends it at once.
 useEffect(()=>()=>{if(saveTimer.current){clearTimeout(saveTimer.current);void onSave({style:outgoing(latest.current),maxTextureSize:texture.current}).catch(()=>{});}clearTimeout(shotTimer.current);},[]);
 const items=draft.board.items,setItems=fn=>change(old=>({...old,board:{items:fn(old.board.items)}}));
 const assetOf=id=>catalog.find(a=>a.id===id&&!a.removed);

 /* ---------- canvas ---------- */
 const centre=()=>{const r=stage.current.getBoundingClientRect();return {x:(r.width/2-view.x)/view.z,y:(r.height/2-view.y)/view.z};};
 function fit(){const r=stage.current?.getBoundingClientRect(),nodes=[...(world.current?.children||[])];if(!r||!nodes.length){setView({x:40,y:40,z:1});return;}let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const node of nodes){const item=items.find(i=>i.id===node.dataset.id);if(!item)continue;x0=Math.min(x0,item.x);y0=Math.min(y0,item.y);x1=Math.max(x1,item.x+node.offsetWidth);y1=Math.max(y1,item.y+node.offsetHeight);}if(!Number.isFinite(x0))return;const z=clamp(Math.min((r.width-80)/(x1-x0),(r.height-130)/(y1-y0)),.2,1.5);setView({z,x:(r.width-(x1-x0)*z)/2-x0*z,y:(r.height-60-(y1-y0)*z)/2-y0*z+10});}
 // Frame the board once its images have a size.
 useEffect(()=>{if(fitted.current||!items.length)return;const timer=setTimeout(()=>{fitted.current=true;fit();},350);return()=>clearTimeout(timer);},[items.length]);
 function zoom(factor,cx,cy){setView(v=>{const r=stage.current.getBoundingClientRect(),px=cx??r.width/2,py=cy??r.height/2,z=clamp(v.z*factor,.2,3);return {z,x:px-(px-v.x)*z/v.z,y:py-(py-v.y)*z/v.z};});}
 useEffect(()=>{const el=stage.current;if(!el)return;const wheel=e=>{e.preventDefault();const r=el.getBoundingClientRect();if(e.ctrlKey||e.metaKey)zoom(Math.exp(-e.deltaY*.01),e.clientX-r.left,e.clientY-r.top);else setView(v=>({...v,x:v.x-e.deltaX,y:v.y-e.deltaY}));};el.addEventListener('wheel',wheel,{passive:false});return()=>el.removeEventListener('wheel',wheel);},[]);
 function addColour(color){change(old=>old.palette.some(c=>c.color===color)||old.palette.length>=24?old:{...old,palette:[...old.palette,{name:'',color,role:'accent'}]});}
 function sample(node,e){const image=node.querySelector('img');if(!image?.naturalWidth)return;const r=image.getBoundingClientRect(),canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);try{const d=ctx.getImageData(clamp(Math.floor((e.clientX-r.left)/r.width*canvas.width),0,canvas.width-1),clamp(Math.floor((e.clientY-r.top)/r.height*canvas.height),0,canvas.height-1),1,1).data;addColour('#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join(''));}catch{onError('Could not read a colour from that image.');}setPicking(false);}
 function pointerDown(e){if(e.button!==0||e.target.closest('.board-dock,.board-selection,textarea'))return;const node=e.target.closest('.board-item'),handle=e.target.closest('.board-resize');stage.current.focus();
  if(node&&picking){sample(node,e);return;}
  stage.current.setPointerCapture(e.pointerId);
  if(node){const id=node.dataset.id;let next=selected;if(e.shiftKey){next=new Set(selected);next.has(id)?next.delete(id):next.add(id);}else if(!selected.has(id))next=new Set([id]);setSelected(next);const moving=items.filter(i=>next.has(i.id)).map(i=>({id:i.id,x:i.x,y:i.y,w:i.w}));drag.current=handle?{kind:'resize',sx:e.clientX,start:moving.filter(m=>m.id===id)}:{kind:'move',sx:e.clientX,sy:e.clientY,start:moving};}
  else drag.current={kind:'pan',sx:e.clientX,sy:e.clientY,vx:view.x,vy:view.y};}
 function pointerMove(e){const d=drag.current;if(!d)return;const dx=e.clientX-d.sx,dy=e.clientY-(d.sy||0);if(Math.abs(dx)+Math.abs(dy)>3)d.moved=true;if(!d.moved)return;
  if(d.kind==='pan')setView(v=>({...v,x:d.vx+dx,y:d.vy+dy}));
  else{const by=new Map(d.start.map(s=>[s.id,s]));setDraft(old=>{const value={...old,board:{items:old.board.items.map(i=>{const s=by.get(i.id);if(!s)return i;return d.kind==='resize'?{...i,w:clamp(Math.round(s.w+dx/view.z),60,2400)}:{...i,x:Math.round(s.x+dx/view.z),y:Math.round(s.y+dy/view.z)};})}};latest.current=value;return value;});}}
 function pointerUp(){const d=drag.current;drag.current=null;if(!d)return;if(d.kind==='pan'&&!d.moved)setSelected(new Set());if(d.kind!=='pan'&&d.moved)change(old=>old);}
 function removeSelected(){if(!selected.size)return;setItems(list=>list.filter(i=>!selected.has(i.id)));setSelected(new Set());}
 function addNote(){const c=centre(),id=newId('item');setItems(list=>[...list,{id,kind:'note',text:'',x:Math.round(c.x-110),y:Math.round(c.y-40),w:220}]);setSelected(new Set([id]));setEditing(id);}
 function addImage(assetId,at){const existing=items.find(i=>i.kind==='image'&&i.assetId===assetId);if(existing){setSelected(new Set([existing.id]));return;}if(items.length>=80){onError('The moodboard holds up to 80 items.');return;}const c=at||centre(),id=newId('item'),offset=at?0:(items.length%5)*60;setItems(list=>[...list,{id,kind:'image',assetId,x:Math.round(c.x-135+offset),y:Math.round(c.y-100+offset),w:270}]);setSelected(new Set([id]));}
 /** Images dropped or chosen from disk are imported as reference images, then placed on the board. */
 async function upload(files,at){const list=[...files].filter(f=>IMAGE.test(f.name));if(!list.length){onError('Drop PNG, JPG or WebP images.');return;}setBusy('Adding images…');try{let n=0;for(const file of list){const result=await request(base+'/api/import',{name:file.name,type:'reference',folder:'Style guide',data:await fileBase64(file)});addImage(result.id,at&&{x:at.x+n*30,y:at.y+n*30});n++;}}catch(e){onError(e.message);}finally{setBusy('');}}
 /** Takes an image dragged from the library list, or image files dragged from the desktop. */
 function drop(e){const id=e.dataTransfer.getData(LIBRARY_DRAG);if(!id&&!e.dataTransfer.files.length)return;e.preventDefault();e.stopPropagation();setOver(false);const r=stage.current.getBoundingClientRect(),at={x:(e.clientX-r.left-view.x)/view.z,y:(e.clientY-r.top-view.y)/view.z};if(id)addImage(id,at);else upload(e.dataTransfer.files,at);}
 async function ask(refs){if(saveTimer.current||saving.current)await saveNow();onAsk(refs);}
 const labelOf=item=>item.kind==='image'?assetOf(item.assetId)?.name||'Image':item.kind==='swatch'?item.name||item.color:'Note';
 const chosen=items.filter(i=>selected.has(i.id));

 /* ---------- rail ---------- */
 const setPalette=fn=>change(old=>({...old,palette:fn(old.palette)})),setRules=fn=>change(old=>({...old,rules:fn(old.rules)}));
 const versions=settings?.styleVersions||[];
 async function restore(at){setVersionsOpen(false);setBusy('Restoring…');try{await request(base+'/api/style/restore',{at});}catch(e){onError(e.message);}finally{setBusy('');}}
 return <div className="review-board style-page">
  <header className="board-heading"><span className="title-badge"><Palette size={15} strokeWidth={1.9}/></span><div><h1>Style guide</h1></div>
   <div className="board-actions"><span className={'style-save '+(saveState==='Not saved'?'failed':'')} role="status">{busy||<>{saveState==='Saved'&&<Check size={12}/>}{saveState}</>}</span>
    <div className="style-history"><button type="button" className="ghost-button" aria-expanded={versionsOpen} disabled={!versions.length} title={versions.length?'Earlier versions of this guide':'No earlier versions yet'} onClick={()=>setVersionsOpen(!versionsOpen)}><History size={13}/>History</button>
     {versionsOpen&&<div className="style-versions" role="menu">{versions.map(v=><button type="button" role="menuitem" key={v.at} onClick={()=>restore(v.at)}><span>{new Date(v.at).toLocaleString([],{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</span><small>by {v.by} · Restore</small></button>)}</div>}</div>
    <button className="tool-icon" aria-label="Close style guide" data-tip="Close" data-tip-align="end" onClick={onClose}><X size={16}/></button></div></header>
  <div className="style-layout">
   <section ref={stage} tabIndex={0} aria-label="Moodboard canvas. Drag items to move them, drag the background to pan." className={'board-stage'+(picking?' picking':'')+(over?' over':'')} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onKeyDown={e=>{if(e.target!==e.currentTarget)return;if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();removeSelected();}else if(e.key==='Escape'){setSelected(new Set());setPicking(false);}}} onDragOver={e=>{if([...e.dataTransfer.types].some(type=>type==='Files'||type===LIBRARY_DRAG)){e.preventDefault();e.dataTransfer.dropEffect='copy';e.stopPropagation();setOver(true);}}} onDragLeave={()=>setOver(false)} onDrop={drop} style={{backgroundPosition:view.x+'px '+view.y+'px',backgroundSize:22*view.z+'px '+22*view.z+'px'}}>
    <div className="board-world" ref={world} style={{transform:'translate('+view.x+'px,'+view.y+'px) scale('+view.z+')'}}>
     {items.map(item=>{const on=selected.has(item.id),single=on&&selected.size===1,style={left:item.x,top:item.y,width:item.kind==='swatch'?undefined:item.w};
      if(item.kind==='image'){const asset=assetOf(item.assetId);return <div key={item.id} data-id={item.id} className={'board-item image'+(on?' selected':'')} style={style}>{asset?<img src={base+'/library/'+item.assetId} alt={asset.name} draggable={false}/>:<div className="board-missing">This image is no longer in the library</div>}{single&&<i className="board-resize" aria-hidden="true"/>}</div>;}
      if(item.kind==='note')return <div key={item.id} data-id={item.id} className={'board-item note'+(on?' selected':'')} style={style} onDoubleClick={()=>setEditing(item.id)}>{editing===item.id?<textarea autoFocus aria-label="Note" maxLength={600} value={item.text} onChange={e=>setItems(list=>list.map(i=>i.id===item.id?{...i,text:e.target.value}:i))} onBlur={()=>{setEditing(null);if(!item.text.trim())setItems(list=>list.filter(i=>i.id!==item.id));}} onKeyDown={e=>{if(e.key==='Escape')e.target.blur();}}/>:<p>{item.text||'Double-click to write'}</p>}{single&&editing!==item.id&&<i className="board-resize" aria-hidden="true"/>}</div>;
      return <div key={item.id} data-id={item.id} className={'board-item swatch'+(on?' selected':'')} style={style}><i style={{background:item.color}}/>{item.name||item.color}</div>;})}
    </div>
    {!items.length&&<div className="board-empty"><ImagePlus size={22}/><strong>Pin the images that define the look</strong><span>Drag images here from the library on the left, or drop or upload your own. Then arrange them however makes sense to you.</span></div>}
    {!!chosen.length&&<div className="board-selection"><span>{chosen.length===1?labelOf(chosen[0]):chosen.length+' items selected'}</span><button type="button" className="primary-button" onClick={()=>ask(chosen.map(i=>({kind:'item',id:i.id,label:labelOf(i),...(i.kind==='swatch'?{color:i.color}:{})})))}><MessageSquare size={13}/>Ask about this</button><button type="button" className="tool-icon" aria-label="Remove from the moodboard" data-tip="Remove" data-tip-align="end" onClick={removeSelected}><Trash2 size={14}/></button></div>}
    <input hidden ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={e=>{const files=[...e.target.files];e.target.value='';upload(files);}}/>
    <div className="board-dock" role="toolbar" aria-label="Moodboard tools">
     <button type="button" className="tool-icon" aria-label="Zoom out" data-tip="Zoom out" data-tip-side="top" onClick={()=>zoom(1/1.2)}><Minus size={14}/></button><span className="board-zoom">{Math.round(view.z*100)}%</span><button type="button" className="tool-icon" aria-label="Zoom in" data-tip="Zoom in" data-tip-side="top" onClick={()=>zoom(1.2)}><Plus size={14}/></button>
     <button type="button" className="tool-icon" aria-label="Fit everything in view" data-tip="Fit" data-tip-side="top" onClick={fit}><Maximize size={14}/></button><i className="board-sep"/>
     <button type="button" className="ghost-button" disabled={!!busy} onClick={()=>fileInput.current.click()}><Upload size={13}/>Upload</button>
     <button type="button" className="ghost-button" onClick={addNote}><StickyNote size={13}/>Note</button>
     <button type="button" className={'ghost-button'+(picking?' active':'')} aria-pressed={picking} title="Click any image to add its colour to the palette" onClick={()=>setPicking(!picking)}><Pipette size={13}/>Pick colour</button>
    </div>
   </section>
   <aside className="style-rail">
    <section><h2>Palette</h2>
     {ROLES.map(([role,label])=>{const group=draft.palette.map((entry,index)=>({entry,index})).filter(({entry})=>entry.role===role);return <div className="palette-group" key={role}><div className="palette-group-heading"><span>{label}</span><button type="button" className="tool-icon" aria-label={'Add a colour to '+label} data-tip="Add colour" data-tip-align="end" disabled={draft.palette.length>=24} onClick={()=>setPalette(list=>[...list,{name:'',color:'#c8553d',role}])}><Plus size={13}/></button></div>
      {group.map(({entry,index})=><div className="palette-row" key={index}><label className="palette-dot" style={{background:entry.color}} title="Change colour"><input type="color" aria-label={'Colour '+(index+1)} value={entry.color} onChange={e=>setPalette(list=>list.map((c,j)=>j===index?{...c,color:e.target.value}:c))}/></label><input aria-label={'Name of colour '+(index+1)} placeholder="Name" maxLength={40} value={entry.name} onChange={e=>setPalette(list=>list.map((c,j)=>j===index?{...c,name:e.target.value}:c))}/><code>{entry.color}</code><select aria-label={'Group for colour '+(index+1)} value={entry.role} onChange={e=>setPalette(list=>list.map((c,j)=>j===index?{...c,role:e.target.value}:c))}>{ROLES.map(([value,name])=><option key={value} value={value}>{name}</option>)}</select><button type="button" className="tool-icon" aria-label={'Remove colour '+(index+1)} onClick={()=>setPalette(list=>list.filter((c,j)=>j!==index))}><X size={12}/></button></div>)}
      {!group.length&&<p className="palette-none">None yet</p>}</div>;})}
    </section>
    <section><h2>Rules</h2>
     <div className="rule-list">{draft.rules.map(rule=><div className={'rule-row'+(rule.on?'':' off')} key={rule.id}><input type="checkbox" className="style-toggle" aria-label={(rule.on?'Switch off: ':'Switch on: ')+rule.text} checked={rule.on} onChange={e=>setRules(list=>list.map(r=>r.id===rule.id?{...r,on:e.target.checked}:r))}/><input aria-label="Rule" maxLength={240} value={rule.text} onChange={e=>setRules(list=>list.map(r=>r.id===rule.id?{...r,text:e.target.value}:r))} onBlur={()=>{if(!rule.text.trim())setRules(list=>list.filter(r=>r.id!==rule.id));}}/><button type="button" className="tool-icon" aria-label="Ask about this rule" data-tip="Ask about this" data-tip-align="end" disabled={!rule.text.trim()} onClick={()=>ask([{kind:'rule',id:rule.id,label:rule.text.trim().slice(0,80)}])}><MessageSquare size={13}/></button><button type="button" className="tool-icon" aria-label="Remove rule" onClick={()=>setRules(list=>list.filter(r=>r.id!==rule.id))}><X size={12}/></button></div>)}</div>
     <form className="rule-add" onSubmit={e=>{e.preventDefault();const text=newRule.trim();if(!text||draft.rules.length>=40)return;setRules(list=>[...list,{id:newId('rule'),text,on:true}]);setNewRule('');}}><input aria-label="New rule" placeholder="Add a rule, for example: no photo textures" maxLength={240} value={newRule} onChange={e=>setNewRule(e.target.value)}/><button type="submit" className="ghost-button" disabled={!newRule.trim()}>Add</button></form>
    </section>
    <section><h2>Budgets</h2><div className="style-numbers"><label>Texel density<span><input type="number" min="0" step="32" placeholder="Not set" value={draft.texelDensity||''} onChange={e=>change({texelDensity:Number(e.target.value)||0})}/><em>px/m</em></span></label><label>Largest texture<span><input type="number" min="64" step="64" placeholder="4096" value={maxTexture} onChange={e=>{setMaxTexture(e.target.value);texture.current=e.target.value;change(old=>old);}}/><em>px</em></span></label></div></section>
   </aside>
  </div>
 </div>;
}
