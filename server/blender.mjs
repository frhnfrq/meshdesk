import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const runner=fileURLToPath(new URL('./blender/run.py',import.meta.url)),helpers=fileURLToPath(new URL('./blender/md.py',import.meta.url));
const exists=async file=>{try{await fs.access(file);return true;}catch{return false;}};
const quote=s=>JSON.stringify(s);
/** Longest a single Blender run may take. Baking and remeshing need far more than a simple material change. */
export const BLENDER_TIMEOUT=Math.min(3600,Math.max(30,Number(process.env.MESHDESK_BLENDER_TIMEOUT)||600))*1000;

/**
 * Wraps the Blender command so it has no network, can write only inside its disposable job
 * folder and can read only the libraries. macOS uses sandbox-exec and Linux uses bubblewrap.
 * Anywhere else Blender runs only when MESHDESK_UNSANDBOXED_BLENDER=1 says the risk is accepted.
 */
export async function sandboxCommand({binary,args,job,readRoots,platform=process.platform}){
 if(platform==='darwin'){
  const roots=['/System','/usr','/bin','/private/preboot','/private/var/db/dyld','/dev','/Library','/Applications/Blender.app',path.dirname(path.dirname(binary)),job,...readRoots];
  const profile=`(version 1) (allow default) (deny network*) (deny file-read-data) (allow file-read-data ${roots.map(p=>`(subpath ${quote(p)})`).join(' ')} (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")) (deny file-write*) (allow file-write* (subpath ${quote(job)}) (literal "/dev/null")) (deny process-exec) (allow process-exec (literal ${quote(binary)}))`;
  await fs.writeFile(path.join(job,'sandbox.sb'),profile);
  return {command:'/usr/bin/sandbox-exec',args:['-f',path.join(job,'sandbox.sb'),binary,...args]};
 }
 if(platform==='linux'){
  for(const bwrap of ['/usr/bin/bwrap','/bin/bwrap','/usr/local/bin/bwrap'])if(await exists(bwrap)){
   const binds=[];for(const root of ['/usr','/bin','/lib','/lib64','/etc/fonts','/etc/alternatives','/opt','/snap',path.dirname(binary),...readRoots])if(await exists(root))binds.push('--ro-bind',root,root);
   return {command:bwrap,args:['--unshare-all','--die-with-parent','--new-session','--proc','/proc','--dev','/dev','--tmpfs','/tmp',...binds,'--bind',job,job,'--chdir',job,binary,...args]};
  }
  if(process.env.MESHDESK_UNSANDBOXED_BLENDER!=='1')throw Error('Blender edits need bubblewrap on Linux. Install it (for example: sudo apt install bubblewrap), or set MESHDESK_UNSANDBOXED_BLENDER=1 to run Blender without isolation.');
 }else if(process.env.MESHDESK_UNSANDBOXED_BLENDER!=='1')throw Error('Meshdesk cannot isolate Blender on this system. Set MESHDESK_UNSANDBOXED_BLENDER=1 to run agent-written Blender scripts without isolation.');
 return {command:binary,args};
}

/**
 * Runs one Blender job. mode "edit" imports the model, applies the script and writes the FBX, BLEND,
 * GLB preview, textures and a review render. mode "inspect" applies the script to a throwaway copy
 * and only reports on the scene.
 */
export async function runBlender({job,source,textures,script,libraryRoot,workingRoot,binary,signal,assetId='model',exportOptions,mode='edit',render,settings,scene,timeout=BLENDER_TIMEOUT,onProgress=()=>{}}){
 if(typeof script!=='string'||script.length>100000||mode==='edit'&&!script.trim())throw Error('Supply a Blender Python script (up to 100 KB).');
 binary=await fs.realpath(binary);
 const realJob=await fs.realpath(job),realLibrary=await fs.realpath(libraryRoot),realWorking=await fs.realpath(workingRoot);
 await fs.mkdir(path.join(realJob,'tmp'),{recursive:true});
 await fs.copyFile(runner,path.join(realJob,'run.py'));await fs.copyFile(helpers,path.join(realJob,'md.py'));
 await fs.writeFile(path.join(realJob,'edit.py'),script);
 await fs.writeFile(path.join(realJob,'config.json'),JSON.stringify({source,textures:textures||[],assetId,exportOptions,mode,render,settings,scene}));
 const wrapped=await sandboxCommand({binary,job:realJob,readRoots:[realLibrary,realWorking],args:['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',path.join(realJob,'run.py'),'--',realJob]});
 if(signal?.aborted)throw Error('Edit cancelled.');
 const output=await new Promise((resolve,reject)=>{
  const child=spawn(wrapped.command,wrapped.args,{cwd:realJob,env:{PATH:'/usr/bin:/bin',HOME:realJob,TMPDIR:path.join(realJob,'tmp'),BLENDER_USER_CONFIG:path.join(realJob,'config'),BLENDER_USER_SCRIPTS:path.join(realJob,'scripts')},stdio:['ignore','pipe','pipe']});
  let log='',lines='',timedOut=false;const record=chunk=>{log=(log+chunk).slice(-16000);lines+=chunk;let n;while((n=lines.indexOf('\n'))>=0){const line=lines.slice(0,n);lines=lines.slice(n+1);if(line.startsWith('MESHDESK_STEP:'))onProgress(line.slice(14));}};child.stdout.on('data',record);child.stderr.on('data',record);
  const abort=()=>child.kill('SIGKILL');signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>{timedOut=true;abort();},timeout);
  child.on('error',reject);child.on('close',async(code,terminationSignal)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(signal?.aborted)return reject(Error('Edit cancelled.'));if(code===0)return resolve(log);
   if(timedOut)return reject(Error(`Blender ran longer than ${Math.round(timeout/60000)} minutes and was stopped; nothing was saved. Split the work into smaller steps.`));
   // A mistake in the agent's own script: report the failing line, not Blender's whole log.
   try{const failure=JSON.parse(await fs.readFile(path.join(realJob,'error.json'),'utf8'));return reject(Object.assign(Error('The Blender script failed; nothing was saved.\n'+failure.message+'\n'+failure.where+(failure.output?'Printed before the error:\n'+failure.output:'')),{scriptError:true}));}catch{}
   reject(Error('Blender failed ('+(terminationSignal||code)+'); nothing was saved.\n'+log.slice(-5000)));});
 });
 if(signal?.aborted)throw Error('Edit cancelled.');
 const image=async(name='review.png')=>{try{const bytes=await fs.readFile(path.join(realJob,name));return bytes.length&&bytes.toString('latin1',1,4)==='PNG'?bytes:null;}catch{return null;}};
 if(mode==='scene')return {directory:path.join(realJob,'scene_export')};
 if(mode==='inspect'||mode==='script')return {...JSON.parse(await fs.readFile(path.join(realJob,'inspect.json'),'utf8')),image:await image(),directory:realJob};
 for(const name of ['preview.glb',`Models/${assetId}/model.fbx`,'model.blend','metrics.json','materials.json']){const stat=await fs.lstat(path.join(realJob,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0)throw Error('Blender did not produce a valid '+name);}
 const glb=await fs.readFile(path.join(realJob,'preview.glb'));if(glb.toString('ascii',0,4)!=='glTF'||glb.readUInt32LE(8)!==glb.length)throw Error('Invalid GLB preview.');
 await fs.writeFile(path.join(realJob,'blender.log'),output);
 const materials=JSON.parse(await fs.readFile(path.join(realJob,'materials.json'),'utf8'));for(const texture of materials.textures){if(!/^Textures\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(texture.path))throw Error('Invalid texture path.');const stat=await fs.lstat(path.join(realJob,texture.path));if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid exported texture.');}
 let report=null;try{report=JSON.parse(await fs.readFile(path.join(realJob,'report.json'),'utf8'));}catch{}
 return {...JSON.parse(await fs.readFile(path.join(realJob,'metrics.json'),'utf8')),materialManifest:materials,report,image:await image(),compare:await image('compare.png')};
}
