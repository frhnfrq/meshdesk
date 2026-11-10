import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {FeedbackStore} from '../server/store.mjs';
import {Reviews} from '../server/reviews.mjs';
class FakeBridge extends EventEmitter{generation=1;calls=[];async connect(){}async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread-1'}};if(method==='thread/resume')return {thread:{id:params.threadId}};if(method==='turn/start')return {turn:{id:'turn-1'}};if(method==='turn/interrupt'){this.emit('notification','turn/completed',{threadId:params.threadId,turn:{id:params.turnId,status:'interrupted'}});return {};}}}
async function setup(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'asset-review-test-'));const store=new FeedbackStore(root);await store.init();const bridge=new FakeBridge(),events=[];const asset={id:'abcdef123456',type:'model',name:'Test model',path:'test.fbx',preview:'test.glb',inspection:{meshes:[]}};const reviews=new Reviews({bridge,store,catalog:new Map([[asset.id,asset]]),assetRoot:'/tmp/library',broadcast:event=>events.push(event)});return {root,store,bridge,asset,reviews,events};}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await delay(10);}throw Error('Timed out');}
test('streams final reply, deduplicates submits, and resumes persisted conversation',async()=>{const x=await setup();try{const body={text:'Check this model.',requestId:'first-request-123456'};await x.reviews.submit(x.asset.id,body);await until(()=>x.store.get(x.asset.id).turnId);const s=x.store.get(x.asset.id);assert.equal(s.busy,true);await x.reviews.submit(x.asset.id,body);assert.equal(s.messages.length,2);await assert.rejects(()=>x.reviews.submit(x.asset.id,{...body,requestId:'second-request-123456'}),/already/);
 x.bridge.emit('notification','item/completed',{threadId:s.threadId,item:{id:'comment',type:'agentMessage',phase:'commentary',text:'Checking…'}});
 x.bridge.emit('notification','item/started',{threadId:s.threadId,item:{id:'answer',type:'agentMessage',phase:'final_answer'}});
 x.bridge.emit('notification','item/agentMessage/delta',{threadId:s.threadId,itemId:'answer',delta:'The normal map is missing.'});
 x.bridge.emit('notification','item/completed',{threadId:s.threadId,item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'The normal map is missing.'}});
 x.bridge.emit('notification','turn/completed',{threadId:s.threadId,turn:{id:'turn-1',status:'completed'}});await until(()=>!s.busy);await x.store.flush();assert.equal(s.messages[1].text,'The normal map is missing.');assert.equal(s.messages[1].status,'complete');
 const newStore=new FeedbackStore(x.root);await newStore.init();assert.equal(newStore.get(x.asset.id).messages.length,2);const newBridge=new FakeBridge();const next=new Reviews({bridge:newBridge,store:newStore,catalog:x.reviews.catalog,assetRoot:'/tmp/library',broadcast:()=>{}});await next.submit(x.asset.id,{text:'What should I do next?',requestId:'followup-request-1234'});await until(()=>newBridge.calls.some(c=>c.method==='turn/start'));assert.equal(newBridge.calls.some(c=>c.method==='thread/resume'),true);assert.equal(newBridge.calls.some(c=>c.method==='thread/start'),false);await next.cancel(x.asset.id);await until(()=>!newStore.get(x.asset.id).busy);assert.equal(newStore.get(x.asset.id).messages.at(-1).status,'interrupted');await newStore.flush();
 }finally{await x.reviews.shutdown();await fs.rm(x.root,{recursive:true,force:true});}});
test('restart marks unfinished replies interrupted without losing the user message',async()=>{const x=await setup();try{const s=x.store.get(x.asset.id);s.busy=true;s.messages=[{role:'user',text:'Keep me',status:'complete'},{role:'assistant',text:'Partial',status:'streaming'}];await x.store.save(s);const restored=new FeedbackStore(x.root);await restored.init();assert.equal(restored.get(x.asset.id).messages[0].text,'Keep me');assert.equal(restored.get(x.asset.id).messages[1].status,'interrupted');assert.equal(restored.get(x.asset.id).busy,false);await restored.flush();}finally{await fs.rm(x.root,{recursive:true,force:true});}});
test('validates, saves and sends referenced models with trusted catalog context',async()=>{
 const x=await setup();
 try{
  const other={id:'123456abcdef',type:'model',name:'Other version',path:'characters/v2.fbx',preview:'previews/v2.glb',inspection:{meshes:[{vertices:42}]}};
  x.reviews.catalog.set(other.id,other);
  await assert.rejects(()=>x.reviews.submit(x.asset.id,{text:'Compare',requestId:'invalid-ref-123456',modelIds:['000000000000']}),/not in this library/);
  const request={text:'Compare these models',requestId:'reference-test-12345',modelIds:[other.id,other.id,x.asset.id]};
  await x.reviews.submit(x.asset.id,request);
  await until(()=>x.bridge.calls.some(c=>c.method==='turn/start'));
  const message=x.store.get(x.asset.id).messages[0];
  assert.deepEqual(message.references,[{id:other.id,name:other.name,path:other.path}]);
  const prompt=x.bridge.calls.find(c=>c.method==='turn/start').params.input[0].text;
  assert.match(prompt,/referencedModels/);assert.match(prompt,/characters\/v2.fbx/);assert.match(prompt,/"vertices": 42/);
  await x.store.flush();
  const persisted=JSON.parse(await fs.readFile(path.join(x.root,'feedback',x.asset.id+'.json'),'utf8'));
  assert.deepEqual(persisted.messages[0].references,message.references);
 }finally{await x.reviews.shutdown();await fs.rm(x.root,{recursive:true,force:true});}
});
test('registers app-owned editing tools and dispatches only for an active turn',async()=>{const x=await setup();try{const library={public:()=>[{id:x.asset.id,name:'Model',path:'test.fbx'}],file:()=>'/tmp/library/test.fbx',version:()=>({preview:'/tmp/library/test.glb'})};x.reviews.library=library;await assert.rejects(()=>x.bridge.toolHandler({threadId:'unknown',tool:'library_list',arguments:{query:''}}),/No active/);await x.reviews.submit(x.asset.id,{text:'Find this model',requestId:'tool-test-12345678'});await until(()=>x.store.get(x.asset.id).turnId);assert.ok(x.bridge.calls.find(c=>c.method==='thread/start').params.dynamicTools.some(t=>t.name==='blender_edit'));const response=await x.bridge.toolHandler({threadId:'thread-1',turnId:'turn-1',tool:'library_list',arguments:{query:'Model'}});assert.equal(response.success,true);assert.match(response.contentItems[0].text,/test.fbx/);await assert.rejects(()=>x.bridge.toolHandler({threadId:'thread-1',turnId:'stale',tool:'library_list',arguments:{}}),/Stale/);}finally{await x.reviews.shutdown();await fs.rm(x.root,{recursive:true,force:true});}});
test('uploads and selected mesh reach Codex; visible action steps survive saving',async()=>{const x=await setup();try{const name='12345678-1234-1234-1234-123456789012.jpg';await fs.writeFile(path.join(x.root,'captures',name),'test-image');await x.reviews.submit(x.asset.id,{text:'Look at this part',requestId:'upload-test-1234567',attachments:[{name,label:'Reference'}],selectedPart:{meshName:'Roof',materialName:'Tiles'}});await until(()=>x.bridge.calls.some(c=>c.method==='turn/start'));const input=x.bridge.calls.find(c=>c.method==='turn/start').params.input;assert.equal(input[1].type,'localImage');assert.match(input[0].text,/Roof/);const slot=x.reviews.active.get(x.asset.id);x.reviews.step(slot,'Exporting textures');await x.store.flush();assert.equal(JSON.parse(await fs.readFile(path.join(x.root,'feedback',x.asset.id+'.json'))).messages[1].steps[0].label,'Exporting textures');}finally{await x.reviews.shutdown();await fs.rm(x.root,{recursive:true,force:true});}});
