import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const runner=fileURLToPath(new URL('./blender/run.py',import.meta.url));
export async function runBlender({job,source,textures,script,libraryRoot,workingRoot,binary,signal,assetId='model',exportOptions,onProgress=()=>{}}){
 if(typeof script!=='string'||!script.trim()||script.length>100000)throw Error('Supply a Blender Python edit script (up to 100 KB).');
 binary=await fs.realpath(binary);
 const realJob=await fs.realpath(job),realLibrary=await fs.realpath(libraryRoot),realWorking=await fs.realpath(workingRoot);
 await fs.mkdir(path.join(realJob,'tmp'),{recursive:true});
 await fs.copyFile(runner,path.join(realJob,'run.py'));
 await fs.writeFile(path.join(realJob,'edit.py'),script);
 await fs.writeFile(path.join(realJob,'config.json'),JSON.stringify({source,textures,assetId,exportOptions}));
 // Blender and any child inherit write access only to this disposable job.
 // Credentials and unrelated documents cannot be read; no network is allowed.
 const quote=s=>JSON.stringify(s);
 const readRoots=['/System','/usr','/bin','/private/preboot','/private/var/db/dyld','/dev','/Library','/Applications/Blender.app',realJob,realLibrary,realWorking];
 const profile=`(version 1) (allow default) (deny network*) (deny file-read-data) (allow file-read-data ${readRoots.map(p=>`(subpath ${quote(p)})`).join(' ')} (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")) (deny file-write*) (allow file-write* (subpath ${quote(realJob)}) (literal "/dev/null")) (deny process-exec) (allow process-exec (literal ${quote(binary)}))`;
 await fs.writeFile(path.join(realJob,'sandbox.sb'),profile);
 if(signal?.aborted)throw Error('Edit cancelled.');
 const output=await new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/sandbox-exec',['-f',path.join(realJob,'sandbox.sb'),binary,'--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',path.join(realJob,'run.py'),'--',realJob],{cwd:realJob,env:{PATH:'/usr/bin:/bin',HOME:realJob,TMPDIR:path.join(realJob,'tmp'),BLENDER_USER_CONFIG:path.join(realJob,'config'),BLENDER_USER_SCRIPTS:path.join(realJob,'scripts')},stdio:['ignore','pipe','pipe']});
  let log='',lines='',timedOut=false;const record=chunk=>{log=(log+chunk).slice(-16000);lines+=chunk;let n;while((n=lines.indexOf('\n'))>=0){const line=lines.slice(0,n);lines=lines.slice(n+1);if(line.startsWith('MESHDESK_STEP:'))onProgress(line.slice(14));}};child.stdout.on('data',record);child.stderr.on('data',record);
  const abort=()=>child.kill('SIGKILL');signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>{timedOut=true;abort();},240000);
  child.on('error',reject);child.on('close',(code,terminationSignal)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(signal?.aborted)return reject(Error('Edit cancelled.'));if(code!==0)return reject(Error(timedOut?'Blender timed out; no version was published.':'Blender failed ('+(terminationSignal||code)+'); no version was published.\n'+log.slice(-5000)));resolve(log);});
 });
 if(signal?.aborted)throw Error('Edit cancelled.');
 for(const name of ['preview.glb',`Models/${assetId}/model.fbx`,'model.blend','metrics.json','materials.json']){const stat=await fs.lstat(path.join(realJob,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0)throw Error('Blender did not produce a valid '+name);}
 const glb=await fs.readFile(path.join(realJob,'preview.glb'));if(glb.toString('ascii',0,4)!=='glTF'||glb.readUInt32LE(8)!==glb.length)throw Error('Invalid GLB preview.');
 await fs.writeFile(path.join(realJob,'blender.log'),output);
 const materials=JSON.parse(await fs.readFile(path.join(realJob,'materials.json'),'utf8'));for(const texture of materials.textures){if(!/^Textures\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(texture.path))throw Error('Invalid texture path.');const stat=await fs.lstat(path.join(realJob,texture.path));if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid exported texture.');}
 return {...JSON.parse(await fs.readFile(path.join(realJob,'metrics.json'),'utf8')),materialManifest:materials};
}
