import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const ID=/^[a-f0-9-]{36}$/;
/** A conversation's name when the user has not chosen one: the start of its first message. */
export function titleFrom(text){const clean=String(text||'').replace(/\s+/g,' ').trim();if(clean.length<=56)return clean||'New conversation';const cut=clean.slice(0,56),space=cut.lastIndexOf(' ');return (space>24?cut.slice(0,space):cut).replace(/[\s,.;:–-]+$/,'')+'…';}
/**
 * Conversations belong to the project, not to one asset. Each is one JSON file in conversations/.
 * Chats saved by earlier versions (feedback/<assetId>.json, one per model or scene) are converted on first start.
 */
export class ConversationStore {
  constructor(root){this.root=root;this.sessions=new Map();this.queues=new Map();}
  async init(){for(const dir of ['conversations','captures'])await fs.mkdir(path.join(this.root,dir),{recursive:true});
    for(const name of await fs.readdir(path.join(this.root,'conversations'))){if(!name.endsWith('.json')||!ID.test(name.slice(0,-5)))continue;const session=JSON.parse(await fs.readFile(path.join(this.root,'conversations',name),'utf8'));if(session.id!==name.slice(0,-5)||!Array.isArray(session.messages))throw Error('Invalid conversation file '+name+'.');let changed=false;for(const m of session.messages){if(m.status==='streaming'||m.status==='pending'){m.status='interrupted';m.error='The local server stopped before this reply finished.';changed=true;}}session.busy=false;session.progress='';session.turnId=null;session.touched??=[];this.sessions.set(session.id,session);if(changed)await this.save(session);}
    await this.migrate();
  }
  /** Turns each per-asset chat from before conversations existed into a conversation, and keeps the old file in feedback/migrated. */
  async migrate(){const legacy=path.join(this.root,'feedback');let names;try{names=await fs.readdir(legacy);}catch{return;}
    for(const name of names){if(!/^[a-f0-9]{12}\.json$/.test(name))continue;const file=path.join(legacy,name),assetId=name.slice(0,-5);let old;try{old=JSON.parse(await fs.readFile(file,'utf8'));}catch{continue;}
      const messages=Array.isArray(old.messages)?old.messages:[];if(messages.length&&![...this.sessions.values()].some(s=>s.legacyAssetId===assetId)){for(const m of messages){if(m.status==='streaming'||m.status==='pending'){m.status='interrupted';m.error='The local server stopped before this reply finished.';}if(m.role==='user')m.focus??={id:assetId};}
        const session={id:randomUUID(),legacyAssetId:assetId,title:titleFrom(messages.find(m=>m.role==='user')?.text),createdAt:messages[0].createdAt||new Date().toISOString(),updatedAt:messages.at(-1).createdAt||new Date().toISOString(),settled:false,provider:old.provider||messages.findLast(m=>m.agent)?.agent?.provider||'codex',threadId:old.threadId||null,toolsVersion:old.toolsVersion,previousThreadIds:old.previousThreadIds,touched:[...new Set([assetId,...messages.flatMap(m=>(m.references||[]).map(r=>r.id))])],messages,busy:false,progress:'',turnId:null};this.sessions.set(session.id,session);await this.save(session);}
      await fs.mkdir(path.join(legacy,'migrated'),{recursive:true});await fs.rename(file,path.join(legacy,'migrated',name));}
  }
  create({title='',provider='codex',...extra}={}){const now=new Date().toISOString(),session={id:randomUUID(),title:String(title).slice(0,120),createdAt:now,updatedAt:now,settled:false,provider,threadId:null,touched:[],messages:[],busy:false,progress:'',turnId:null,...extra};this.sessions.set(session.id,session);return session;}
  has(id){return this.sessions.has(id);}
  get(id){const session=this.sessions.get(id);if(!session)throw Object.assign(Error('Conversation not found.'),{status:404});return session;}
  list(){return [...this.sessions.values()];}
  touch(session,...ids){for(const id of ids)if(typeof id==='string'&&id&&!session.touched.includes(id))session.touched.push(id);}
  save(session){const snapshot=JSON.stringify(session,null,2);const destination=path.join(this.root,'conversations',session.id+'.json');const prior=this.queues.get(session.id)||Promise.resolve();const next=prior.catch(()=>{}).then(async()=>{await fs.writeFile(destination+'.tmp',snapshot,{mode:0o600});await fs.rename(destination+'.tmp',destination);});this.queues.set(session.id,next);return next;}
  async remove(id){const session=this.get(id);this.sessions.delete(id);await (this.queues.get(id)||Promise.resolve()).catch(()=>{});this.queues.delete(id);await fs.rm(path.join(this.root,'conversations',id+'.json'),{force:true});return session;}
  public(session){return {id:session.id,title:session.title||'New conversation',createdAt:session.createdAt,updatedAt:session.updatedAt,settled:!!session.settled,provider:session.provider||'codex',touched:session.touched||[],batchId:session.batchId,messages:session.messages,busy:session.busy,progress:session.progress};}
  async flush(){await Promise.all([...this.queues.values()]);}
}
