import fs from 'node:fs/promises';
export const ENGINES=['','unity','unreal','godot'];
const whole=(value,max)=>{const n=Math.round(Number(value));return Number.isFinite(n)&&n>0?Math.min(n,max):0;};
export const STYLE_DEFAULTS={palette:[],texelDensity:0,materialRules:'',notes:'',references:[]};
export const SETTING_DEFAULTS={context:'',reviewEdits:true,engine:'',triangleBudget:0,maxTextureSize:4096,style:STYLE_DEFAULTS};
const prose=(value,label)=>{if(typeof value!=='string'||value.length>4000)throw Error('Keep the '+label+' under 4,000 characters.');return value;};
/** The project's art direction in a form both people and agents can check work against. */
export function cleanStyle(input={},base=STYLE_DEFAULTS){
 const value={...STYLE_DEFAULTS,...base};if(!input||typeof input!=='object')return value;
 if(input.palette!==undefined){if(!Array.isArray(input.palette)||input.palette.length>24)throw Error('Keep the palette to 24 colours.');value.palette=input.palette.map(entry=>{const color=String(entry?.color||'').toLowerCase();if(!/^#[0-9a-f]{6}$/.test(color))throw Error('Palette colours must be hex values such as #c8553d.');return {name:String(entry.name||'').replace(/[\x00-\x1f]/g,' ').trim().slice(0,40),color};});}
 if(input.texelDensity!==undefined)value.texelDensity=whole(input.texelDensity,8192);
 if(input.materialRules!==undefined)value.materialRules=prose(input.materialRules,'material rules');
 if(input.notes!==undefined)value.notes=prose(input.notes,'style notes');
 if(input.references!==undefined){if(!Array.isArray(input.references)||input.references.length>8||input.references.some(id=>!/^[a-f0-9]{12}$/.test(id)))throw Error('Choose up to 8 reference images from the library.');value.references=[...new Set(input.references)];}
 return value;
}
export const styleIsSet=style=>!!style&&!!(style.palette?.length||style.texelDensity||style.materialRules?.trim()||style.notes?.trim()||style.references?.length);
/** The style guide as a few plain sentences, for texture prompts. */
export function styleBrief(settings={}){const style=settings.style;if(!styleIsSet(style))return '';return [style.palette.length?'Use only this colour palette: '+style.palette.map(c=>(c.name?c.name+' ':'')+c.color).join(', ')+'.':'',style.materialRules.trim()?'Material rules: '+style.materialRules.trim():'',style.notes.trim()?'Style notes: '+style.notes.trim():''].filter(Boolean).join(' ').slice(0,2500);}
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
/** Per-project preferences: the brief every agent turn reads, the target engine, budgets, and whether edits wait for approval. */
export class ProjectSettings{
 constructor(file){this.file=file;this.value={...SETTING_DEFAULTS};}
 async init(){try{this.value=cleanSettings(JSON.parse(await fs.readFile(this.file,'utf8')));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError)&&!/^(Keep|Choose|Palette)/.test(error.message))throw error;}}
 get(){return {...this.value};}
 async update(input){this.value=cleanSettings(input,this.value);await fs.writeFile(this.file+'.tmp',JSON.stringify(this.value,null,2));await fs.rename(this.file+'.tmp',this.file);return this.get();}
}
