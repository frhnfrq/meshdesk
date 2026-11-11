import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const READ_TOOLS=['Read','Glob','Grep'];
const SERVER='meshdesk';
const sdk=()=>import('@anthropic-ai/claude-agent-sdk');
const timeout=(promise,ms,message)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]).finally(()=>clearTimeout(timer));};

/**
 * Claude Agent SDK adapter that speaks the same thread/turn protocol as CodexBridge,
 * so Conversations can drive either agent. Uses the local Claude Code sign-in; credentials
 * stay inside Claude Code and API-key variables are never forwarded.
 */
export class ClaudeBridge extends EventEmitter {
  constructor({binary}={}){super();this.binary=binary||'';this.state='disconnected';this.generation=1;this.threads=new Map();this.turns=new Map();this.dynamicTools=[];this.readRoots=[];this.models=null;}
  env(){const env={...process.env,CLAUDE_AGENT_SDK_CLIENT_APP:'meshdesk/1.0.0'};for(const name of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT'])delete env[name];return env;}
  base(){return {env:this.env(),settingSources:[],strictMcpConfig:true,...(this.binary?{pathToClaudeCodeExecutable:this.binary}:{})};}
  async connect(){
    if(this.state==='ready')return;
    if(this.connecting)return this.connecting;
    this.connecting=this.open().finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  async open(){
    this.state='connecting';this.emit('status');
    const auth=await this.authStatus();
    this.signedIn=auth?auth.loggedIn!==false:true;this.accountType=auth?.subscriptionType||auth?.authMethod||null;
    if(!this.signedIn){this.state='signed-out';this.emit('status');throw new Error('Claude Code is signed out. Run claude auth login in Terminal, then reconnect.');}
    this.state='ready';this.emit('status');
  }
  /** Asks the local CLI whether it is signed in. Returns null when the CLI cannot be queried. */
  authStatus(){return new Promise(resolve=>{let output='';let child;try{child=spawn(this.binary||'claude',['auth','status'],{stdio:['ignore','pipe','ignore'],env:this.env()});}catch{return resolve(null);}const timer=setTimeout(()=>{child.kill('SIGTERM');resolve(null);},15000);child.stdout.on('data',chunk=>{output+=chunk;});child.on('error',()=>{clearTimeout(timer);resolve(null);});child.on('exit',()=>{clearTimeout(timer);try{resolve(JSON.parse(output));}catch{resolve(null);}});});}
  async listModels(){
    if(this.models)return this.models;
    if(this.loadingModels)return this.loadingModels;
    this.loadingModels=(async()=>{const {query}=await sdk();const controller=new AbortController();let release;const idle=new Promise(resolve=>{release=resolve;});
      const q=query({prompt:(async function*(){await idle;})(),options:{...this.base(),abortController:controller,tools:[],persistSession:false}});
      try{const models=await timeout(q.supportedModels(),30000,'Claude model list timed out.');this.models=models.map(m=>({id:m.value,label:m.displayName||m.value,detail:m.description||'',efforts:m.supportsEffort===false?[]:m.supportedEffortLevels||[]}));return this.models;}
      finally{release();try{q.close();}catch{}controller.abort();}
    })().finally(()=>{this.loadingModels=null;});
    return this.loadingModels;
  }
  async request(method,params={}){
    if(method==='thread/start'){const id=randomUUID();this.threads.set(id,{instructions:params.developerInstructions||'',exists:false});return {thread:{id}};}
    if(method==='thread/resume'){this.threads.set(params.threadId,{instructions:params.developerInstructions||'',exists:true});return {thread:{id:params.threadId}};}
    if(method==='turn/start')return this.startTurn(params);
    if(method==='turn/interrupt'){this.turns.get(params.threadId)?.interrupt();return {};}
    throw new Error('Unsupported Claude request: '+method);
  }
  async content(input){const blocks=[];for(const item of input||[]){if(item.type==='text')blocks.push({type:'text',text:item.text});else if(item.type==='localImage'){const data=await fs.readFile(item.path);blocks.push({type:'image',source:{type:'base64',media_type:/\.png$/i.test(item.path)?'image/png':'image/jpeg',data:data.toString('base64')}});}}return blocks;}
  allowedPath(target,cwd){const resolved=path.resolve(cwd,String(target||'.'));return [cwd,...this.readRoots].filter(Boolean).some(root=>{const base=path.resolve(root);return resolved===base||resolved.startsWith(base+path.sep);});}
  async toolServer(threadId,turnId){
    if(!this.dynamicTools.length||!this.toolHandler)return null;
    const {createSdkMcpServer,tool}=await sdk();const {z}=await import('zod');
    return createSdkMcpServer({name:SERVER,version:'1.0.0',tools:this.dynamicTools.map(definition=>tool(definition.name,definition.description,Object.fromEntries(Object.keys(definition.inputSchema.properties).map(key=>[key,z.string()])),async args=>{
      try{const result=await this.toolHandler({threadId,turnId,tool:definition.name,arguments:args});return {content:(result.contentItems||[]).map(item=>item.type==='inputImage'?{type:'image',data:item.imageUrl.slice(item.imageUrl.indexOf(',')+1),mimeType:'image/png'}:{type:'text',text:String(item.text??'')}),isError:!result.success};}
      catch(error){return {content:[{type:'text',text:String(error.message)}],isError:true};}
    }))});
  }
  async startTurn({threadId,input,cwd,model,effort}){
    const thread=this.threads.get(threadId);if(!thread)throw new Error('Unknown Claude conversation.');
    if(this.turns.has(threadId))throw new Error('This conversation already has a reply in progress.');
    const turnId=randomUUID(),content=await this.content(input),server=await this.toolServer(threadId,turnId);
    const turn={id:turnId,controller:new AbortController(),interrupted:false,query:null,interrupt(){this.interrupted=true;const q=this.query;if(q)void Promise.resolve(q.interrupt()).catch(()=>{});setTimeout(()=>this.controller.abort(),3000).unref();}};
    this.turns.set(threadId,turn);
    setImmediate(()=>{void this.pump({thread,threadId,turn,content,server,cwd,model,effort});});
    return {turn:{id:turnId}};
  }
  async pump({thread,threadId,turn,content,server,cwd,model,effort}){
    const emit=(method,params)=>this.emit('notification',method,{threadId,...params});
    const finish=(status,error)=>{if(turn.finished)return;turn.finished=true;emit('turn/completed',{turn:{id:turn.id,status:turn.interrupted?'interrupted':status,error:error?{message:error}:undefined}});};
    const attempt=async resume=>{
      const {query}=await sdk();let release;const done=new Promise(resolve=>{release=resolve;});
      const prompt=(async function*(){yield {type:'user',message:{role:'user',content},parent_tool_use_id:null};await done;})();
      const q=query({prompt,options:{...this.base(),cwd,abortController:turn.controller,systemPrompt:thread.instructions,tools:READ_TOOLS,includePartialMessages:true,permissionMode:'default',
        ...(model?{model}:{}),...(effort?{effort}:{}),...(resume?{resume:threadId}:{sessionId:threadId}),...(server?{mcpServers:{[SERVER]:server}}:{}),
        canUseTool:async(name,toolInput)=>{
          if(name.startsWith('mcp__'+SERVER+'__'))return {behavior:'allow',updatedInput:toolInput};
          if(READ_TOOLS.includes(name)&&this.allowedPath(toolInput.file_path??toolInput.path,cwd))return {behavior:'allow',updatedInput:toolInput};
          return {behavior:'deny',message:'Meshdesk only allows reading files inside the asset library and using its library tools.'};
        }}});
      turn.query=q;if(turn.interrupted)turn.interrupt();
      const open=new Map(),items=[];let counter=0,streamed=false,produced=false;
      const settle=phase=>{for(const item of items){if(item.phase)continue;item.phase=phase;emit('item/completed',{item:{id:item.id,type:'agentMessage',phase,text:item.text}});}};
      const begin=(text='')=>{const item={id:turn.id+':'+(counter++),text};items.push(item);produced=true;emit('item/started',{item:{id:item.id,type:'agentMessage',text}});return item;};
      const usedTool=name=>{settle('commentary');produced=true;if(READ_TOOLS.includes(name))emit('item/started',{item:{id:turn.id+':tool:'+(counter++),type:'commandExecution'}});};
      try{
        for await(const message of q){
          if(message.type==='system'&&message.subtype==='init'){thread.exists=true;continue;}
          if(message.parent_tool_use_id)continue;
          if(message.type==='stream_event'){streamed=true;const event=message.event;
            if(event.type==='message_start')open.clear();
            else if(event.type==='content_block_start'){if(event.content_block.type==='text')open.set(event.index,begin(event.content_block.text||''));else if(event.content_block.type==='tool_use')usedTool(event.content_block.name);}
            else if(event.type==='content_block_delta'&&event.delta.type==='text_delta'){const item=open.get(event.index);if(item){item.text+=event.delta.text;emit('item/agentMessage/delta',{itemId:item.id,delta:event.delta.text});}}
          }else if(message.type==='assistant'&&!streamed){for(const block of message.message?.content||[]){if(block.type==='text'&&block.text)begin(block.text);else if(block.type==='tool_use')usedTool(block.name);}}
          else if(message.type==='result'){settle('final_answer');
            if(message.subtype==='success'&&!message.is_error)finish('completed');
            else finish('failed',String(message.result||(message.errors||[]).join(' ')||'Claude could not complete the reply.'));
            break;
          }
        }
        if(!turn.finished){settle('final_answer');finish(turn.interrupted?'interrupted':'failed','Claude ended the reply unexpectedly.');}
      }catch(error){
        if(resume&&!produced&&!turn.interrupted&&/no conversation found|session.*not.*found/i.test(String(error?.message)))return 'retry';
        settle('final_answer');finish(turn.interrupted||turn.controller.signal.aborted?'interrupted':'failed',String(error?.message||'Claude could not complete the reply.'));
      }finally{release();try{q.close();}catch{}}
    };
    try{if(await attempt(thread.exists)==='retry')await attempt(false);}
    catch(error){finish('failed',String(error?.message||'Claude could not start.'));}
    finally{if(this.turns.get(threadId)===turn)this.turns.delete(threadId);}
  }
  status(){return {state:this.state,signedIn:!!this.signedIn,accountType:this.accountType||null};}
  close(){for(const turn of this.turns.values()){turn.interrupted=true;turn.controller.abort();}}
}
