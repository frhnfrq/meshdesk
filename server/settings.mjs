import fs from 'node:fs/promises';
export const ENGINES=['','unity','unreal','godot'];
export const SETTING_DEFAULTS={context:'',reviewEdits:true,engine:'',triangleBudget:0,maxTextureSize:4096};
const whole=(value,max)=>{const n=Math.round(Number(value));return Number.isFinite(n)&&n>0?Math.min(n,max):0;};
export function cleanSettings(input={},base=SETTING_DEFAULTS){
 const value={...base};
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
 async init(){try{this.value=cleanSettings(JSON.parse(await fs.readFile(this.file,'utf8')));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError)&&!/^(Keep|Choose)/.test(error.message))throw error;}}
 get(){return {...this.value};}
 async update(input){this.value=cleanSettings(input,this.value);await fs.writeFile(this.file+'.tmp',JSON.stringify(this.value,null,2));await fs.rename(this.file+'.tmp',this.file);return this.get();}
}
