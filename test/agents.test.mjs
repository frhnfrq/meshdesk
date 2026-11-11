import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {FeedbackStore} from '../server/store.mjs';
import {Reviews} from '../server/reviews.mjs';
import {Agents,AgentSettings} from '../server/agents.mjs';
class FakeBridge extends EventEmitter{generation=1;calls=[];constructor(name){super();this.name=name;}status(){return {state:'ready'};}async connect(){}close(){}async listModels(){return [{id:this.name+'-model',label:'Model',efforts:['low','high']}];}async request(method,params){this.calls.push({method,params});if(method==='thread/start')return {thread:{id:this.name+'-thread'}};if(method==='thread/resume')return {thread:{id:params.threadId}};if(method==='turn/start')return {turn:{id:this.name+'-turn'}};return {};}}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await delay(10);}throw Error('Timed out');}
test('agent settings validate, remember a choice per agent and persist',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'meshdesk-agent-'));try{const file=path.join(root,'agent.json'),settings=new AgentSettings(file);await settings.init();assert.deepEqual(settings.current(),{provider:'codex',model:'',effort:''});
 await assert.rejects(()=>settings.update({provider:'other'}),/Codex or Claude/);await assert.rejects(()=>settings.update({model:'bad model!'}),/Invalid model/);await assert.rejects(()=>settings.update({effort:'HIGH'}),/Invalid reasoning/);
 await settings.update({model:'gpt-x',effort:'low'});await settings.update({provider:'claude',model:'claude-fable-5-1[1m]',effort:'high'});
 const restored=new AgentSettings(file);await restored.init();assert.deepEqual(restored.current(),{provider:'claude',model:'claude-fable-5-1[1m]',effort:'high'});await restored.update({provider:'codex'});assert.deepEqual(restored.current(),{provider:'codex',model:'gpt-x',effort:'low'});
 }finally{await fs.rm(root,{recursive:true,force:true});}});
test('switching agent starts a fresh thread with prior history and sends the chosen model and reasoning level',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'meshdesk-agent-'));const store=new FeedbackStore(root);await store.init();const codex=new FakeBridge('codex'),claude=new FakeBridge('claude'),agents=new Agents({bridges:{codex,claude},settings:new AgentSettings(path.join(root,'agent.json'))});
 const asset={id:'abcdef123456',type:'model',name:'Test model',path:'test.fbx',preview:'test.glb',inspection:{meshes:[]}};const reviews=new Reviews({agents,store,catalog:new Map([[asset.id,asset]]),assetRoot:'/tmp/library',broadcast:()=>{}});
 try{const session=store.get(asset.id);await reviews.submit(asset.id,{text:'First question',requestId:'agent-first-1234567'});await until(()=>session.turnId);assert.equal(session.messages[1].agent.provider,'codex');assert.equal('model' in codex.calls.find(c=>c.method==='turn/start').params,false);
  codex.emit('notification','item/completed',{threadId:'codex-thread',item:{id:'a',type:'agentMessage',phase:'final_answer',text:'Codex answer'}});claude.emit('notification','turn/completed',{threadId:'codex-thread',turn:{id:'x',status:'completed'}});assert.equal(session.busy,true);
  codex.emit('notification','turn/completed',{threadId:'codex-thread',turn:{id:'codex-turn',status:'completed'}});await until(()=>!session.busy);
  assert.equal((await agents.update({provider:'claude',model:'claude-model',effort:'high'})).label,'Claude');assert.equal((await agents.options()).providers.find(p=>p.id==='claude').models[0].id,'claude-model');
  await reviews.submit(asset.id,{text:'Second question',requestId:'agent-second-123456'});await until(()=>session.turnId);const turn=claude.calls.find(c=>c.method==='turn/start').params;
  assert.equal(session.threadId,'claude-thread');assert.equal(session.provider,'claude');assert.deepEqual(session.previousThreadIds,['codex-thread']);assert.equal(turn.model,'claude-model');assert.equal(turn.effort,'high');assert.match(turn.input[0].text,/PRIOR CONVERSATION[\s\S]*Codex answer/);assert.match(claude.calls.find(c=>c.method==='thread/start').params.developerInstructions,/^You are Claude,/);assert.equal(session.messages[3].agent.provider,'claude');
 }finally{await reviews.shutdown();await fs.rm(root,{recursive:true,force:true});}});
