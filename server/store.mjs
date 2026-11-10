import fs from 'node:fs/promises';
import path from 'node:path';
export class FeedbackStore {
  constructor(root){this.root=root;this.sessions=new Map();this.queues=new Map();}
  async init(){await fs.mkdir(path.join(this.root,'feedback'),{recursive:true});await fs.mkdir(path.join(this.root,'captures'),{recursive:true});
    for(const name of await fs.readdir(path.join(this.root,'feedback'))){if(!/^[a-f0-9]{12}\.json$/.test(name))continue;const session=JSON.parse(await fs.readFile(path.join(this.root,'feedback',name),'utf8'));if(session.assetId!==name.slice(0,-5))throw Error('Invalid conversation asset ID.');let changed=false;for(const m of session.messages){if(m.status==='streaming'||m.status==='pending'){m.status='interrupted';m.error='The local server stopped before this reply finished.';changed=true;}}session.busy=false;session.progress='';session.turnId=null;this.sessions.set(session.assetId,session);if(changed)await this.save(session);}
  }
  get(assetId){if(!this.sessions.has(assetId))this.sessions.set(assetId,{assetId,threadId:null,messages:[],busy:false,progress:'',turnId:null});return this.sessions.get(assetId);}
  save(session){const snapshot=JSON.stringify(session,null,2);const destination=path.join(this.root,'feedback',session.assetId+'.json');const prior=this.queues.get(session.assetId)||Promise.resolve();const next=prior.catch(()=>{}).then(async()=>{await fs.writeFile(destination+'.tmp',snapshot,{mode:0o600});await fs.rename(destination+'.tmp',destination);});this.queues.set(session.assetId,next);return next;}
  public(session){return {assetId:session.assetId,messages:session.messages,busy:session.busy,progress:session.progress};}
  async flush(){await Promise.all([...this.queues.values()]);}
}
