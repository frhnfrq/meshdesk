import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const ENDED=['done','failed','cancelled'];
/** What the agent is told for each model of a batch. The style guide itself arrives with every turn's project context. */
export function restylePrompt(instruction){return 'Restyle this model so it matches the project\'s style guide.'+(instruction?'\nWhat I want: '+instruction:'')+'\nKeep its shape, real-world scale, pivot and object names; change materials, colours and textures. Work on this model only. Check the result image against the style guide and fix what does not match. Finish with a short summary of what you changed and anything that still does not fit the guide.';}
/**
 * A batch gives the same instruction to many models. Each model gets its own conversation and its own
 * proposed change, a few at a time in the background, so one failure or a cancel does not affect the rest.
 */
export class Batches{
 constructor({file,conversations,store,library,catalog,broadcast=()=>{},concurrency=2}){Object.assign(this,{file,conversations,store,library,catalog,broadcast,concurrency});this.items=[];this.saving=Promise.resolve();}
 async init(){try{const saved=JSON.parse(await fs.readFile(this.file,'utf8'));this.items=Array.isArray(saved)?saved.filter(b=>/^[a-f0-9-]{36}$/.test(b?.id)&&Array.isArray(b.items)):[];}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  let changed=false;for(const batch of this.items)for(const item of batch.items)if(!ENDED.includes(item.status)){item.status='cancelled';item.error='Meshdesk was restarted before this model was reached.';changed=true;}if(changed)await this.save();}
 list(){return structuredClone(this.items.slice(-20));}
 save(){const snapshot=JSON.stringify(this.items.slice(-50),null,2);this.saving=this.saving.catch(()=>{}).then(async()=>{await fs.writeFile(this.file+'.tmp',snapshot);await fs.rename(this.file+'.tmp',this.file);});this.broadcast({type:'batches',batches:this.list()});return this.saving;}
 active(){return this.items.flatMap(batch=>batch.items.map(item=>({batch,item}))).filter(({item})=>!ENDED.includes(item.status));}
 /** Queues one conversation per model. kind "restyle" wraps the instruction in the restyle brief; "ask" sends it as written. */
 async start({assetIds,instruction='',kind='restyle',title}={}){const text=String(instruction||'').replace(/[\x00-\x08\x0b-\x1f]/g,' ').trim();if(text.length>4000)throw Error('Keep the instruction under 4,000 characters.');if(kind!=='restyle'&&!text)throw Error('Write what the agent should do.');
  const ids=[...new Set(Array.isArray(assetIds)?assetIds:[])],models=ids.map(id=>this.catalog.get(id)).filter(a=>a?.type==='model'&&!a.removed);if(!models.length)throw Error('Select at least one model.');if(models.length>200)throw Error('A batch holds up to 200 models.');
  const busy=new Set(this.active().map(({item})=>item.assetId)),queued=models.filter(a=>!busy.has(a.id));if(!queued.length)throw Error(models.length===1?'"'+models[0].name+'" is already in a running batch.':'These models are already in a running batch.');
  const batch={id:randomUUID(),kind:kind==='restyle'?'restyle':'ask',title:String(title||'').slice(0,80)||(kind==='restyle'?'Restyle':'Batch'),instruction:text,createdAt:new Date().toISOString(),items:queued.map(a=>({assetId:a.id,name:a.name,status:'queued'}))};this.items.push(batch);
  if(this.library?.setReview)await this.library.setReview(queued.filter(a=>(a.review||'not-started')==='not-started').map(a=>a.id),'in-progress');await this.save();void this.pump();return structuredClone(batch);}
 /** Starts queued models while there is room. Called again whenever a conversation ends. */
 async pump(){if(this.pumping)return;this.pumping=true;try{for(;;){const active=this.active(),running=active.filter(({item})=>item.status==='running').length,next=active.find(({item})=>item.status==='queued');if(!next||running>=this.concurrency)break;const {batch,item}=next,asset=this.catalog.get(item.assetId);
   if(!asset||asset.removed){item.status='failed';item.error='This model is no longer in the library.';continue;}
   item.status='running';item.startedAt=new Date().toISOString();
   try{const conversation=await this.conversations.submit('new',{text:batch.kind==='restyle'?restylePrompt(batch.instruction):batch.instruction,title:batch.title+': '+asset.name,requestId:randomUUID(),focusId:asset.id,batchId:batch.id});item.conversationId=conversation.id;}
   catch(error){if(error.status===429){item.status='queued';delete item.startedAt;break;}item.status='failed';item.error=String(error.message).slice(0,300);}
  }}finally{this.pumping=false;await this.save();}}
 /** A conversation's reply ended: record how its model went and start the next one. */
 async finished(session,reply){const found=this.items.find(b=>b.id===session.batchId)?.items.find(i=>i.conversationId===session.id);if(found&&found.status==='running'){const asset=this.catalog.get(found.assetId);found.finishedAt=new Date().toISOString();if(reply.status==='complete'){found.status='done';found.proposed=!!asset?.pendingVersion&&asset.pendingConversation===session.id;if(!reply.checkpoints?.length)found.note='No change was made. Open the conversation to see why.';}else if(reply.status==='interrupted'){found.status='cancelled';found.error='Stopped.';}else{found.status='failed';found.error=String(reply.error||'The reply failed.').slice(0,300);}}
  await this.pump();}
 /** Stops a batch: models not yet started are skipped, the ones running are interrupted. */
 async cancel(id){const batch=this.items.find(b=>b.id===id);if(!batch)throw Error('Batch not found.');for(const item of batch.items){if(item.status==='queued'){item.status='cancelled';item.error='Cancelled before it started.';}else if(item.status==='running'&&item.conversationId){try{await this.conversations.cancel(item.conversationId);}catch{}if(item.status==='running'&&!this.store?.get(item.conversationId)?.busy){item.status='cancelled';item.error='Stopped.';}}}await this.save();void this.pump();return structuredClone(batch);}
 /** Removes a finished batch from the list. Its conversations and proposals stay. */
 async dismiss(id){const batch=this.items.find(b=>b.id===id);if(!batch)throw Error('Batch not found.');if(batch.items.some(i=>!ENDED.includes(i.status)))throw Error('Cancel the batch before clearing it.');this.items=this.items.filter(b=>b!==batch);await this.save();return {id};}
}
