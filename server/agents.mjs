import fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';

export const PROVIDERS={codex:'Codex',claude:'Claude'};
export const LOGIN={codex:'codex login',claude:'claude auth login'};

/** The chosen agent, plus the model and reasoning level remembered for each agent. Shared by all open projects. */
export class AgentSettings {
  constructor(file){this.file=file;this.value={provider:'codex',choices:{}};}
  async init(){try{const saved=JSON.parse(await fs.readFile(this.file,'utf8'));if(PROVIDERS[saved.provider])this.value.provider=saved.provider;for(const id of Object.keys(PROVIDERS)){const choice=saved.choices?.[id];if(choice)this.value.choices[id]={model:clean(choice.model,MODEL),effort:clean(choice.effort,EFFORT)};}}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}}
  choice(provider){return {model:'',effort:'',...this.value.choices[provider]};}
  current(){return {provider:this.value.provider,...this.choice(this.value.provider)};}
  async update(body={}){
    const provider=body.provider===undefined?this.value.provider:body.provider;
    if(!Object.hasOwn(PROVIDERS,provider))throw new Error('Choose Codex or Claude.');
    const choice=this.choice(provider);
    if(body.model!==undefined){if(typeof body.model!=='string'||!MODEL.test(body.model))throw new Error('Invalid model.');choice.model=body.model;}
    if(body.effort!==undefined){if(typeof body.effort!=='string'||!EFFORT.test(body.effort))throw new Error('Invalid reasoning level.');choice.effort=body.effort;}
    this.value={provider,choices:{...this.value.choices,[provider]:choice}};
    if(this.file){await fs.writeFile(this.file+'.tmp',JSON.stringify(this.value,null,2),{mode:0o600});await fs.rename(this.file+'.tmp',this.file);}
    return this.current();
  }
}
const MODEL=/^[A-Za-z0-9._:\[\]-]{0,100}$/,EFFORT=/^[a-z]{0,12}$/;
function clean(value,pattern){return typeof value==='string'&&pattern.test(value)?value:'';}

/** Holds one bridge per agent and routes status, connection and model lists to the chosen one. */
export class Agents extends EventEmitter {
  constructor({bridges,settings}){super();this.bridges=bridges;this.settings=settings;for(const bridge of Object.values(bridges))bridge.on('status',()=>this.emit('status'));}
  current(){return this.settings.current();}
  bridge(provider=this.current().provider){return this.bridges[provider];}
  label(provider=this.current().provider){return PROVIDERS[provider]||'Codex';}
  status(){const current=this.current();return {...this.bridge().status(),...current,label:this.label()};}
  connect(){return this.bridge().connect();}
  async options(){
    const providers=await Promise.all(Object.entries(this.bridges).map(async([id,bridge])=>{let models=[];try{models=await bridge.listModels();}catch{}return {id,label:PROVIDERS[id],state:bridge.status().state,models,...this.settings.choice(id)};}));
    return {current:this.current(),providers};
  }
  async update(body){await this.settings.update(body);this.emit('status');void this.connect().catch(()=>{});return this.status();}
  close(){for(const bridge of Object.values(this.bridges))bridge.close();}
}
