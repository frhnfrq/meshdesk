import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {EventEmitter} from 'node:events';

/** JSON-RPC over a private child-process pipe. Credentials stay inside Codex CLI. */
export class CodexBridge extends EventEmitter {
  constructor({binary='codex'}={}){super();this.binary=binary;this.pending=new Map();this.nextId=1;this.state='disconnected';this.generation=0;}
  async connect(){
    if(this.state==='ready')return;
    if(this.connecting)return this.connecting;
    this.connecting=this.open().catch(error=>{this.child?.kill('SIGTERM');throw error;}).finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  async open(){
    this.state='connecting';this.emit('status');
    const child=spawn(this.binary,['app-server','--listen','stdio://'],{stdio:['pipe','pipe','pipe'],env:process.env});
    this.child=child;this.generation++;
    child.stderr.on('data',()=>{}); // Never forward auth/config output to the browser.
    const reader=createInterface({input:child.stdout});
    reader.on('line',line=>{let message;try{message=JSON.parse(line);}catch{return;}
      if(message.id!=null && !message.method){const request=this.pending.get(message.id);if(!request)return;clearTimeout(request.timer);this.pending.delete(message.id);message.error?request.reject(new Error(message.error.message||'Codex request failed')):request.resolve(message.result);}
      else if(message.id!=null && message.method){
        // Mutations are restricted to app-owned library tools; general shell stays read-only.
        if(message.method==='item/tool/call'&&this.toolHandler){const origin=child;void this.toolHandler(message.params).then(result=>{if(this.child===origin)this.write({id:message.id,result});}).catch(error=>{if(this.child===origin)this.write({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:String(error.message)}]}});});}
        else if(message.method.endsWith('/requestApproval'))this.write({id:message.id,result:{decision:'decline'}});
        else this.write({id:message.id,error:{code:-32601,message:'Interactive tool requests are not supported in this review client.'}});
      }else if(message.method)this.emit('notification',message.method,message.params||{});
    });
    const closed=()=>{if(this.child!==child)return;this.child=null;this.state='disconnected';for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('Codex connection ended. Try sending again.'));}this.pending.clear();this.emit('disconnect');this.emit('status');};
    child.on('error',closed);child.on('exit',closed);
    await this.request('initialize',{clientInfo:{name:'metro_hustle_asset_review',title:'Metro Hustle Asset Review',version:'2.0.0'},capabilities:{experimentalApi:true}},30000);
    this.write({method:'initialized',params:{}});
    const {account}=await this.request('account/read',{refreshToken:false});
    this.accountType=account?.type||null;this.signedIn=!!account;
    if(!account){this.state='signed-out';this.emit('status');throw new Error('Codex CLI is signed out. Run codex login in Terminal, then restart this app.');}
    this.state='ready';this.emit('status');
  }
  write(message){if(!this.child?.stdin.writable)throw new Error('Codex is not connected.');this.child.stdin.write(JSON.stringify(message)+'\n');}
  request(method,params={},timeout=45000){return new Promise((resolve,reject)=>{const id=this.nextId++;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex ${method} timed out. Please try again.`));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});}
  async listModels(){await this.connect();const {data}=await this.request('model/list',{});return (data||[]).filter(m=>!m.hidden).map(m=>({id:m.model||m.id,label:m.displayName||m.model||m.id,detail:m.description||'',efforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort),defaultEffort:m.defaultReasoningEffort||'',isDefault:!!m.isDefault}));}
  status(){return {state:this.state,signedIn:!!this.signedIn,accountType:this.accountType||null};}
  close(){this.child?.kill('SIGTERM');}
}
