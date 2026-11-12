import fs from 'node:fs/promises';
export const ENGINES=['','unity','unreal','godot'];
const whole=(value,max)=>{const n=Math.round(Number(value));return Number.isFinite(n)&&n>0?Math.min(n,max):0;};
export const ROLES=['primary','accent','neutral'];
/** rules and board stay null until the guide is first saved from the canvas page; until then the older materialRules, notes and references apply. */
export const STYLE_DEFAULTS={palette:[],texelDensity:0,materialRules:'',notes:'',references:[],rules:null,board:null};
const plain=(value,max)=>String(value??'').replace(/[\x00-\x1f]/g,' ').trim().slice(0,max);
const itemId=value=>/^[a-z0-9-]{1,40}$/.test(String(value||''))?String(value):null;
const within=(value,min,max,fallback)=>{const n=Number(value);return Number.isFinite(n)?Math.min(max,Math.max(min,Math.round(n*10)/10)):fallback;};
const hexColour=value=>{const color=String(value||'').toLowerCase();if(!/^#[0-9a-f]{6}$/.test(color))throw Error('Palette colours must be hex values such as #c8553d.');return color;};
export const SETTING_DEFAULTS={context:'',reviewEdits:true,engine:'',triangleBudget:0,maxTextureSize:4096,style:STYLE_DEFAULTS};
const prose=(value,label)=>{if(typeof value!=='string'||value.length>4000)throw Error('Keep the '+label+' under 4,000 characters.');return value;};
/** The project's art direction in a form both people and agents can check work against. */
export function cleanStyle(input={},base=STYLE_DEFAULTS){
 const value={...STYLE_DEFAULTS,...base};if(!input||typeof input!=='object')return value;
 if(input.palette!==undefined){if(!Array.isArray(input.palette)||input.palette.length>24)throw Error('Keep the palette to 24 colours.');value.palette=input.palette.map(entry=>{const color=String(entry?.color||'').toLowerCase();if(!/^#[0-9a-f]{6}$/.test(color))throw Error('Palette colours must be hex values such as #c8553d.');return {name:plain(entry.name,40),color,role:ROLES.includes(entry.role)?entry.role:'primary'};});}
 if(input.texelDensity!==undefined)value.texelDensity=whole(input.texelDensity,8192);
 if(input.materialRules!==undefined)value.materialRules=prose(input.materialRules,'material rules');
 if(input.notes!==undefined)value.notes=prose(input.notes,'style notes');
 if(input.rules!==undefined&&input.rules!==null){if(!Array.isArray(input.rules)||input.rules.length>40)throw Error('Keep the style guide to 40 rules.');const seen=new Set();value.rules=input.rules.map((rule,index)=>{const text=plain(rule?.text,240);if(!text)throw Error('A rule cannot be empty.');let id=itemId(rule.id)||'rule-'+(index+1);while(seen.has(id))id+='x';seen.add(id);return {id,text,on:rule.on!==false};});}
 if(input.board!==undefined&&input.board!==null){const list=input.board?.items;if(!Array.isArray(list)||list.length>80)throw Error('Keep the moodboard to 80 items.');const seen=new Set();value.board={items:list.map((item,index)=>{let id=itemId(item?.id)||'item-'+(index+1);while(seen.has(id))id+='x';seen.add(id);const base={id,x:within(item.x,-20000,20000,0),y:within(item.y,-20000,20000,0),w:within(item.w,40,2400,240)};
   if(item.kind==='image'){if(!/^[a-f0-9]{12}$/.test(String(item.assetId||'')))throw Error('Moodboard images must come from the library.');return {...base,kind:'image',assetId:item.assetId};}
   if(item.kind==='swatch')return {...base,kind:'swatch',color:hexColour(item.color),name:plain(item.name,40)};
   if(item.kind==='note')return {...base,kind:'note',text:String(item.text??'').replace(/[\x00-\x08\x0b-\x1f]/g,' ').slice(0,600)};
   throw Error('Unknown moodboard item.');})};}
 if(input.references!==undefined&&!value.board){if(!Array.isArray(input.references)||input.references.length>8||input.references.some(id=>!/^[a-f0-9]{12}$/.test(id)))throw Error('Choose up to 8 reference images from the library.');value.references=[...new Set(input.references)];}
 if(value.board)value.references=[...new Set(value.board.items.filter(item=>item.kind==='image').map(item=>item.assetId))].slice(0,24);
 return value;
}
/** The written rules that currently apply: the switched-on rules, or the older free-text fields for a guide not yet saved from the canvas page. */
export function activeRules(style={}){if(Array.isArray(style.rules))return style.rules.filter(rule=>rule.on).map(rule=>rule.text);return [style.materialRules,style.notes].map(text=>String(text||'').trim()).filter(Boolean);}
export const styleIsSet=style=>!!style&&!!(style.palette?.length||style.texelDensity||activeRules(style).length||style.references?.length||style.board?.items?.length);
/**
 * Applies a set of changes an agent proposed to a style guide and returns the new guide. Colours and rules are matched by
 * name, hex value, id or text, ignoring case. Throws when a change cannot be applied, so a proposal is checked before it is shown.
 */
export function applyStyleChanges(style,changes={}){
 if(!changes||typeof changes!=='object'||Array.isArray(changes))throw Error('changes must be a JSON object.');
 const list=key=>{const v=changes[key];if(v===undefined)return [];if(!Array.isArray(v))throw Error(key+' must be an array.');return v;},same=(a,b)=>String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();
 const next={...style,palette:[...(style.palette||[])],rules:Array.isArray(style.rules)?style.rules.map(r=>({...r})):activeRules(style).map((text,i)=>({id:'rule-'+(i+1),text,on:true}))};
 for(const target of list('removeColors')){const index=next.palette.findIndex(c=>same(c.name,target)||same(c.color,target));if(index<0)throw Error('No palette colour matches "'+target+'".');next.palette.splice(index,1);}
 for(const entry of list('addColors')){const color=hexColour(entry?.color);if(next.palette.some(c=>c.color===color))throw Error(color+' is already in the palette.');next.palette.push({name:plain(entry.name,40),color,role:ROLES.includes(entry.role)?entry.role:'primary'});}
 const find=target=>{const index=next.rules.findIndex(r=>same(r.id,target)||same(r.text,target));if(index<0)throw Error('No rule matches "'+target+'".');return index;};
 for(const target of list('removeRules'))next.rules.splice(find(target),1);
 for(const edit of list('editRules')){const text=plain(edit?.to,240);if(!text)throw Error('An edited rule needs new text in "to".');next.rules[find(edit.from)].text=text;}
 for(const text of list('addRules')){const clean=plain(text,240);if(!clean)throw Error('A new rule cannot be empty.');let id='rule-'+(next.rules.length+1);while(next.rules.some(r=>r.id===id))id+='x';next.rules.push({id,text:clean,on:true});}
 if(changes.texelDensity!==undefined)next.texelDensity=whole(changes.texelDensity,8192);
 if(!['removeColors','addColors','removeRules','editRules','addRules'].some(key=>list(key).length)&&changes.texelDensity===undefined)throw Error('The proposal changes nothing. Use addColors, removeColors, addRules, editRules, removeRules or texelDensity.');
 return cleanStyle({...next,materialRules:'',notes:''},style);
}
/** The style guide as a few plain sentences, for texture prompts. */
export function styleBrief(settings={}){const style=settings.style;if(!styleIsSet(style))return '';return [style.palette.length?'Use only this colour palette: '+style.palette.map(c=>(c.name?c.name+' ':'')+c.color).join(', ')+'.':'',activeRules(style).length?'Style rules: '+activeRules(style).join(' '):''].filter(Boolean).join(' ').slice(0,2500);}
export function cleanSettings(input={},base=SETTING_DEFAULTS){
 const value={...base,style:cleanStyle({},base.style)};
 if(input.style!==undefined)value.style=cleanStyle(input.style,value.style);
 if(input.context!==undefined){if(typeof input.context!=='string'||input.context.length>8000)throw Error('Keep the project context under 8,000 characters.');value.context=input.context;}
 if(input.reviewEdits!==undefined)value.reviewEdits=!!input.reviewEdits;
 if(input.engine!==undefined){if(!ENGINES.includes(input.engine))throw Error('Choose Unity, Unreal, Godot or no engine.');value.engine=input.engine;}
 if(input.triangleBudget!==undefined)value.triangleBudget=whole(input.triangleBudget,20000000);
 if(input.maxTextureSize!==undefined)value.maxTextureSize=whole(input.maxTextureSize,16384)||SETTING_DEFAULTS.maxTextureSize;
 return value;
}
const HISTORY_LIMIT=20,COALESCE_MS=10*60*1000;
/** Per-project preferences: the brief every agent turn reads, the target engine, budgets, and whether edits wait for approval. */
export class ProjectSettings{
 constructor(file){this.file=file;this.value={...SETTING_DEFAULTS};this.history=[];}
 async init(){try{const raw=JSON.parse(await fs.readFile(this.file,'utf8'));this.value=cleanSettings(raw);this.author=plain(raw.styleAuthor,40)||'You';this.history=(Array.isArray(raw.styleHistory)?raw.styleHistory:[]).flatMap(entry=>{try{return [{at:String(entry.at),by:plain(entry.by,40)||'You',style:cleanStyle(entry.style)}];}catch{return [];}}).slice(-HISTORY_LIMIT);}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError)&&!/^(Keep|Choose|Palette|A rule|Moodboard|Unknown)/.test(error.message))throw error;}}
 get(){return {...this.value};}
 /** Earlier versions of the style guide, newest first, without their contents. */
 versions(){return this.history.map(({at,by})=>({at,by})).reverse();}
 /**
  * Saves a change. When the style guide changes, the version it replaces is kept so it can be restored. A run of your own
  * edits within ten minutes counts as one version; a change by an agent, or a restore, always keeps the version before it.
  */
 async update(input,{by='You',keep=false}={}){const before=this.value,next=cleanSettings(input,before);this.remember(before,next,by,keep);this.value=next;await this.persist();return this.get();}
 remember(before,next,by,keep){if(JSON.stringify(next.style)===JSON.stringify(before.style))return;const author=this.author||'You';
  if(styleIsSet(before.style)&&(keep||by!=='You'||author!=='You'||!(Date.now()-this.keptAt<COALESCE_MS))){this.history=[...this.history,{at:new Date().toISOString(),by:author,style:before.style}].slice(-HISTORY_LIMIT);this.keptAt=Date.now();}
  this.author=by;}
 /** Brings back an earlier version exactly as it was; the version it replaces is kept. */
 async restore(at){const entry=this.history.find(e=>e.at===at);if(!entry)throw Error('That version is no longer kept.');const before=this.value,next={...before,style:cleanStyle(entry.style)};this.remember(before,next,entry.by,true);this.value=next;await this.persist();return this.get();}
 async persist(){await fs.writeFile(this.file+'.tmp',JSON.stringify({...this.value,styleHistory:this.history,styleAuthor:this.author||'You'},null,2));await fs.rename(this.file+'.tmp',this.file);}
}
