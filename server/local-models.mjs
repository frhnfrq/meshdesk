/**
 * Local image-to-3D models that Meshdesk installs and runs itself, so nobody has to set up Python by hand.
 *
 * Each model is a recipe: pinned source code, pinned Python packages and the weight files. Installing one downloads uv
 * (a single program that provides Python and installs packages) when it is not already on the machine, builds a private
 * environment inside Meshdesk's data folder and fetches the weights. Nothing touches the system's own Python, and Delete
 * removes it all again. A recipe is marked tested only on the platforms where the authors have actually run it.
 */
import fs from 'node:fs/promises';
import {createWriteStream,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

const UV_VERSION='0.13.8',PYTHON='3.11',U2NET='https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx';
/**
 * PyTorch is the one package that cannot be pinned the same everywhere: the build for an NVIDIA card depends on the driver
 * installed, and the newest PyTorch has no build for older drivers. So a Mac gets the exact version the recipes were
 * tested with, and an NVIDIA machine gets the newest matching pair that uv finds for its driver.
 */
export const torchPackages=hardware=>hardware.gpu.kind==='nvidia'?['torch>=2.6','torchvision>=0.21']:['torch==2.15.0','torchvision==0.29.2'];
const SHARED=['diffusers==0.35.2','transformers==4.57.6','accelerate==1.16.0','safetensors==0.8.0','huggingface-hub==0.36.2','einops==0.8.2','omegaconf==2.4.0','numpy==2.1.3','scipy==1.17.1','pillow==11.3.0','opencv-python-headless==5.1.0.95','scikit-image==0.26.0','trimesh==5.2.1','pymeshlab==2025.7.post1','rembg[cpu]==2.0.69','onnxruntime==1.32.0','tqdm','pyyaml','psutil'];
export const MODELS={
 hunyuan:{label:'Hunyuan3D 2.1',loadTimes:{'darwin-arm64':'about 2 min','win32-x64':'about 45 s'},strength:'detailed shape from one picture',times:{'darwin-arm64':'About 11 min','win32-x64':'About 1.5 min'},maker:'Tencent',about:'The most detailed shapes of the two. Not open source: its licence does not allow use in the EU, the UK or South Korea.',
  licence:{name:'Tencent Hunyuan 3D 2.1 Community License',url:'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE',accept:'I have read the licence and I am not in the European Union, the United Kingdom or South Korea.'},
  sources:[{dir:'port',repo:'VladimirTalyzin/hunyuan3d-2.1-mac',commit:'6f4b63bd6419406f40291bca23a7c849bcaae2a3'},{dir:'Hunyuan3D-2.1',repo:'Tencent-Hunyuan/Hunyuan3D-2.1',commit:'82920d643c0dc2f7bfd7255f45f62d386edfe60c'}],
  packages:[...SHARED,'torchdiffeq==0.2.5','timm==1.0.31','pymcubes==0.1.6','pytorch-lightning==2.6.6','torchmetrics==1.9.0'],
  weights:{repo:'tencent/Hunyuan3D-2.1',revision:'0b94677654c57bb9a6b6845cd7b704ccf551d327',dir:'weights/Hunyuan3D-2.1',files:[['hunyuan3d-dit-v2-1/config.yaml',2078],['hunyuan3d-dit-v2-1/model.fp16.ckpt',7366389768],['hunyuan3d-vae-v2-1/config.yaml',409],['hunyuan3d-vae-v2-1/model.fp16.ckpt',655648152]]},
  appleMemoryGB:16,nvidiaVramGB:8,ramGB:16,tested:{'darwin-arm64':'About 11 minutes per model on an M2 with 24 GB.','win32-x64':'About 1.5 minutes per model on an RTX 3070 Ti with 8 GB, in low-memory mode: part of the model waits in main memory.'}},
 triposg:{label:'TripoSG',loadTimes:{'darwin-arm64':'about 40 s','win32-x64':'about 1 min'},strength:'sharpest shape',times:{'darwin-arm64':'About 10 min','win32-x64':'About 1 min'},maker:'VAST AI Research',about:'Open source under the MIT licence, with no regional limits. Lighter than Hunyuan3D, so it suits 8 GB graphics cards.',
  licence:{name:'MIT',url:'https://github.com/VAST-AI-Research/TripoSG/blob/main/LICENSE'},
  sources:[{dir:'TripoSG',repo:'VAST-AI-Research/TripoSG',commit:'fc5c40990181e2a756c4e0b1c2f4d6b5202faf8c'}],
  packages:[...SHARED,'peft','jaxtyping','typeguard'],
  weights:{repo:'VAST-AI/TripoSG',revision:'2c1c516d22d58db486a058d98d31bb6177344e06',dir:'weights/TripoSG',files:[['model_index.json',0],['feature_extractor_dinov2/preprocessor_config.json',0],['image_encoder_dinov2/config.json',0],['image_encoder_dinov2/model.safetensors',1217500000],['scheduler/scheduler_config.json',0],['transformer/config.json',0],['transformer/diffusion_pytorch_model.safetensors',5758300000],['vae/config.json',0],['vae/diffusion_pytorch_model.safetensors',970700000]]},
  appleMemoryGB:16,nvidiaVramGB:8,tested:{'darwin-arm64':'About 10 minutes per model on an M2 with 24 GB.','win32-x64':'About 1 minute per model on an RTX 3070 Ti with 8 GB.'}},
 'hunyuan-mv':{label:'Hunyuan3D 2 multi-view',loadTimes:{'win32-x64':'about 1 min'},strength:'uses side and back views',times:{'win32-x64':'About 2 min'},maker:'Tencent',multiview:true,about:'Builds the shape from a front view plus left, back and right views, so the hidden sides are accurate instead of guessed. Not open source: its licence does not allow use in the EU, the UK or South Korea.',
  licence:{name:'Tencent Hunyuan 3D 2.0 Community License',url:'https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/LICENSE',accept:'I have read the licence and I am not in the European Union, the United Kingdom or South Korea.'},
  sources:[{dir:'Hunyuan3D-2',repo:'Tencent-Hunyuan/Hunyuan3D-2',commit:'f8db63096c8282cb27354314d896feba5ba6ff8a'}],
  packages:[...SHARED,'pygltflib','xatlas'],
  weights:{repo:'tencent/Hunyuan3D-2mv',revision:'3a761b539b29fe4ff64714813aa9560fd66f5de0',dir:'weights/tencent/Hunyuan3D-2mv',files:[['hunyuan3d-dit-v2-mv/config.yaml',1608],['hunyuan3d-dit-v2-mv/model.fp16.safetensors',4928151562]]},
  appleMemoryGB:16,nvidiaVramGB:8,tested:{'win32-x64':'About 2 minutes per model on an RTX 3070 Ti with 8 GB.'}},
 trellis:{label:'TRELLIS',loadTimes:{'win32-x64':'about 30 s'},defaultTexture:1024,strength:'fast colour, softer shape',times:{'win32-x64':'About 1 min'},maker:'Microsoft',multiview:true,textured:true,about:'Makes a textured model: shape and colour together, from one picture or several. Open source under the MIT licence. The shape is softer than the others. Windows with an NVIDIA card only, because it relies on prebuilt parts made by a community developer rather than by Microsoft.',
  licence:{name:'MIT',url:'https://github.com/microsoft/TRELLIS/blob/main/LICENSE',accept:'I understand this installs prebuilt program files from a community project (IgorAherne/trellis-stable-projectorz), not from Microsoft.'},
  only:{platform:'win32',gpu:'nvidia',reason:'TRELLIS is set up for Windows with an NVIDIA card only for now.'},
  // The second entry is a git submodule of the first; a source archive leaves submodules out, so it is fetched into its place.
  sources:[{dir:'trellis',repo:'IgorAherne/trellis-stable-projectorz',commit:'90c829db922cb4a4333442aa583a69e48ddc88bc'},{dir:'trellis/trellis/representations/mesh/flexicubes',repo:'IgorAherne/flexicubes-stable-projectorz',commit:'ce1dd2536f724f798df4817723fac4a0cf7e8a66'}],
  // Its compiled parts were built against PyTorch 2.7 for CUDA 12.8, so this model gets that exact pair instead of the newest.
  torch:{backend:'cu128',packages:['torch==2.7.0','torchvision==0.22.0','xformers==0.0.30']},
  wheels:['whl/cumm_cu128-0.7.13-cp311-cp311-win_amd64.whl','whl/spconv_cu128-2.3.8-cp311-cp311-win_amd64.whl','whl/nvdiffrast-0.3.3-cp311-cp311-win_amd64.whl','whl/diffoctreerast-0.0.0-cp311-cp311-win_amd64.whl','whl/diff_gaussian_rasterization-0.0.0-cp311-cp311-win_amd64.whl','whl/kaolin-0.17.0-cp311-cp311-win_amd64.whl'],
  packages:['setuptools<81','wheel','numpy==1.26.4','pillow','easydict','imageio','imageio-ffmpeg','opencv-python-headless','plyfile','pygltflib','pymatting','pymeshfix','pyvista','igraph','rembg[cpu]','onnxruntime','safetensors','scipy','tqdm','transformers==4.50.3','huggingface-hub','trimesh','xatlas','pymeshlab','psutil','utils3d @ https://github.com/EasternJournalist/utils3d/archive/9a4eb15e4021b67b12c460c7057d642626897ec8.zip'],
  weights:{repo:'microsoft/TRELLIS-image-large',revision:'25e0d31ffbebe4b5a97464dd851910efc3002d96',dir:'weights/TRELLIS-image-large',files:[['pipeline.json',1987],...[['ss_dec_conv3d_16l8_fp16',147591972],['ss_flow_img_dit_L_16l8_fp16',1130770840],['slat_dec_gs_swin8_B_64l8gs32_fp16',171450952],['slat_dec_rf_swin8_B_64l8r16_fp16',171450488],['slat_dec_mesh_swin8_B_64l8m256c_fp16',181903412],['slat_flow_img_dit_L_64l8p2_fp16',1203755136]].flatMap(([name,size])=>[['ckpts/'+name+'.json',500],['ckpts/'+name+'.safetensors',size]])]},
  appleMemoryGB:16,nvidiaVramGB:8,tested:{'win32-x64':'About 1 minute per textured model on an RTX 3070 Ti with 8 GB. The first run also downloads its image encoder (1.2 GB).'}},
 trellis2:{label:'TRELLIS.2',loadTimes:{'win32-x64':'about 4 min'},defaultTexture:4096,strength:'best overall, PBR materials',times:{'win32-x64':'About 2.5 min'},maker:'Microsoft',textured:true,about:'Microsoft\u2019s newest and most detailed model, with full PBR materials. Open source under the MIT licence. Built for 24 GB cards, but its low-memory mode runs it at 1024 resolution in under 6 GB of video memory; it needs 24 GB of main memory instead. Takes the front view only. Windows with an NVIDIA card only, with prebuilt parts from a community developer. Its image encoder needs a Hugging Face account with access to DINOv3.',
  licence:{name:'MIT',url:'https://github.com/microsoft/TRELLIS.2/blob/main/LICENSE',accept:'I understand this installs prebuilt program files from a community project (visualbruno/ComfyUI-Trellis2), not from Microsoft.'},
  only:{platform:'win32',gpu:'nvidia',reason:'TRELLIS.2 is set up for Windows with an NVIDIA card only for now.'},
  sources:[{dir:'TRELLIS.2',repo:'microsoft/TRELLIS.2',commit:'75fbf0183001ed9876c8dbb35de6b68552ee08bd'}],
  torch:{backend:'auto',packages:['torch==2.8.0','torchvision==0.23.0','xformers==0.0.32.post2']},
  wheels:['cumesh-1.0','flex_gemm-0.0.1','nvdiffrast-0.4.0','nvdiffrec_render-0.0.0','o_voxel-0.0.1'].map(name=>'https://raw.githubusercontent.com/visualbruno/ComfyUI-Trellis2/b0e84c0f29857a444e8bcb5b9be2ea218e96efd0/wheels/Windows/Torch280/'+name+'-cp311-cp311-win_amd64.whl'),
  packages:['setuptools<81','wheel','numpy<2.3','pillow','easydict','imageio','imageio-ffmpeg','opencv-python-headless','tqdm','trimesh','transformers>=4.56,<5','huggingface-hub','safetensors','scipy','kornia','timm','zstandard','pandas','lpips','rembg[cpu]','onnxruntime','pymeshlab','psutil','utils3d @ https://github.com/EasternJournalist/utils3d/archive/9a4eb15e4021b67b12c460c7057d642626897ec8.zip'],
  weights:[
   {repo:'microsoft/TRELLIS.2-4B',revision:'af44b45f2e35a493886929c6d786e563ec68364d',dir:'weights/TRELLIS.2-4B',files:[['pipeline.json',4186],...[['ss_flow_img_dit_1_3B_64_bf16',2584426920],['shape_dec_next_dc_f16c32_fp16',948490494],['slat_flow_img2shape_dit_1_3B_512_bf16',2584574424],['slat_flow_img2shape_dit_1_3B_1024_bf16',2584574424],['tex_dec_next_dc_f16c32_fp16',948458812],['slat_flow_imgshape2tex_dit_1_3B_1024_bf16',2584672728]].flatMap(([name,size])=>[['ckpts/'+name+'.json',500],['ckpts/'+name+'.safetensors',size]])]},
   {repo:'microsoft/TRELLIS-image-large',revision:'25e0d31ffbebe4b5a97464dd851910efc3002d96',dir:'weights/TRELLIS-image-large',files:[['ckpts/ss_dec_conv3d_16l8_fp16.json',245],['ckpts/ss_dec_conv3d_16l8_fp16.safetensors',147591972]]},
   {repo:'facebook/dinov3-vitl16-pretrain-lvd1689m',revision:'ea8dc2863c51be0a264bab82070e3e8836b02d51',dir:'weights/dinov3-vitl16-pretrain-lvd1689m',files:[['config.json',745],['preprocessor_config.json',585],['model.safetensors',1212559808]]}],
  appleMemoryGB:16,nvidiaVramGB:8,ramGB:24,tested:{'win32-x64':'About 2 to 3 minutes per model with PBR textures on an RTX 3070 Ti with 8 GB and 32 GB of memory, at 1024 resolution. Loading it takes a few minutes more.'}}
};
export const MODEL_IDS=Object.keys(MODELS);
/** A model's weights come from one Hugging Face repository or several. */
export const weightSets=model=>[MODELS[model].weights].flat();
const run=(file,args,options={})=>new Promise(resolve=>execFile(file,args,{timeout:8000,windowsHide:true,...options},(error,stdout)=>resolve(error?'':String(stdout).trim())));

/** What this machine has, read once: the graphics hardware decides whether a local model is worth installing at all. */
export async function detectHardware({platform=process.platform,arch=process.arch,exec=run,memory=os.totalmem(),disk}={}){
 const memoryGB=Math.round(memory/2**30);let gpu={kind:'none',name:'No supported graphics hardware found'};
 const smi=await exec('nvidia-smi',['--query-gpu=name,memory.total','--format=csv,noheader,nounits']);
 if(smi){const [name,megabytes]=smi.split('\n')[0].split(',').map(part=>part.trim());gpu={kind:'nvidia',name,vramGB:Math.round(Number(megabytes)/1024)||0};}
 else if(platform==='darwin'&&arch==='arm64')gpu={kind:'apple',name:await exec('sysctl',['-n','machdep.cpu.brand_string'])||'Apple Silicon',vramGB:memoryGB};
 let freeDiskGB=null;try{const stat=await fs.statfs(disk||os.homedir());freeDiskGB=Math.round(stat.bavail*stat.bsize/1e9);}catch{}
 return {platform,arch,key:platform+'-'+arch,memoryGB,gpu,freeDiskGB};
}
/** Disk a model takes: its weights plus the Python environment. PyTorch for NVIDIA is about 6 GB against 2 GB on a Mac; it is stored once and shared by every model. */
export const diskNeeded=(model,hardware)=>Math.ceil(weightSets(model).flatMap(set=>set.files).reduce((sum,[,size])=>sum+size,0)/1e9)+(hardware.gpu.kind==='nvidia'?7:2);
/** Whether a model can run here, in plain words, with a warning when it is likely to be slow or untried. */
export function suitability(model,hardware){
 const {gpu,memoryGB,freeDiskGB,key}=hardware,need=MODELS[model],tested=need.tested[key];
 if(need.only&&(hardware.platform!==need.only.platform||gpu.kind!==need.only.gpu))return {ok:false,reason:need.only.reason};
 if(gpu.kind==='none')return {ok:false,reason:hardware.platform==='darwin'?'Local models need an Apple Silicon Mac. Use Tripo or Meshy on this one.':'Local models need an NVIDIA graphics card. Use Tripo or Meshy on this machine.'};
 if(need.ramGB&&memoryGB<need.ramGB)return {ok:false,reason:'Needs '+need.ramGB+' GB of memory; this computer has '+memoryGB+' GB.'};
 if(gpu.kind==='apple'&&memoryGB<need.appleMemoryGB)return {ok:false,reason:'Needs '+need.appleMemoryGB+' GB of memory; this Mac has '+memoryGB+' GB.'};
 // A model that needs more video memory than the card has is refused, not warned about: unless it has a low-memory mode written for it, it spills into main memory and the page file, fills the disk and still fails.
 if(gpu.kind==='nvidia'&&gpu.vramGB&&gpu.vramGB<need.nvidiaVramGB)return {ok:false,reason:'Needs '+need.nvidiaVramGB+' GB of video memory; this card has '+gpu.vramGB+' GB.'};
 const disk=diskNeeded(model,hardware);
 if(freeDiskGB!==null&&freeDiskGB<disk+5)return {ok:false,reason:'Needs about '+disk+' GB of disk space and some room to spare; '+freeDiskGB+' GB is free.'};
 const notes=[];
 if(!tested)notes.push('Not yet tested by the Meshdesk authors on this kind of machine, so it may need fixing.');
 return {ok:true,tested:!!tested,note:[tested,...notes].filter(Boolean).join(' ')};
}

const uvAsset=(platform,arch)=>{const cpu=arch==='arm64'?'aarch64':'x86_64';return platform==='win32'?'uv-'+cpu+'-pc-windows-msvc.zip':platform==='darwin'?'uv-'+cpu+'-apple-darwin.tar.gz':'uv-'+cpu+'-unknown-linux-gnu.tar.gz';};
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.unref();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});
const cancelled=()=>Object.assign(Error('Cancelled.'),{cancelled:true});

export class LocalModels{
 /**
  * root: where models are installed. olderRoots: folders used before the models folder was moved (to another drive, say);
  * models already installed there keep working, and new ones go to root. onChange is called whenever something the app shows has changed.
  */
 constructor({root,olderRoots=[],serveScript=fileURLToPath(new URL('./local/serve.py',import.meta.url)),onChange=()=>{},fetcher=fetch,hardware,pollMs=2000}){
  Object.assign(this,{root,serveScript,onChange,fetcher,pollMs});this.jobs=new Map();this.waiting=[];this.running=null;this.olderRoots=olderRoots.filter(dir=>dir&&path.resolve(dir)!==path.resolve(root));this.homes=new Map();this.hardwareOverride=hardware;this.installing=null;this.server=null;this.installed=new Set();this.logLines=[];
 }
 /** The folder a model lives in: where it was found installed, or the current models folder. */
 base(id){return this.homes.get(id)||this.root;}
 async init(){for(const id of MODEL_IDS)for(const dir of [this.root,...this.olderRoots])if(!this.installed.has(id)&&existsSync(path.join(dir,id,'installed.json'))){this.installed.add(id);this.homes.set(id,dir);}await fs.rm(path.join(this.root,'.tmp'),{recursive:true,force:true}).catch(()=>{});}
 hardware(){return this.hardwareOverride?Promise.resolve(this.hardwareOverride):(this.detected??=detectHardware({disk:existsSync(this.root)?this.root:os.homedir()}));}
 isInstalled(id){return this.installed.has(id);}
 log(line){for(const part of String(line).split(/\r?\n|\r/)){const text=part.trimEnd();if(text)this.logLines.push(text.slice(0,400));}if(this.logLines.length>300)this.logLines.splice(0,this.logLines.length-300);}
 async public(){
  const hardware=await this.hardware();
  return {hardware,root:this.root,models:MODEL_IDS.map(id=>{const m=MODELS[id];return {id,label:m.label,maker:m.maker,about:m.about,strength:m.strength,time:m.times?.[hardware.key]||'',loadTime:m.loadTimes?.[hardware.key]||'',defaultTexture:m.defaultTexture||0,textured:!!m.textured,multiview:!!m.multiview,licence:m.licence,diskGB:diskNeeded(id,hardware),installed:this.installed.has(id),...suitability(id,hardware)};}),
   installing:this.installing&&{model:this.installing.model,step:this.installing.step,progress:this.installing.progress,error:this.installing.error},
   server:this.server?{model:this.server.model,state:this.server.state,port:this.server.port,error:this.server.error}:{state:'stopped'},
   queue:{running:this.running?{model:this.running.model,state:this.running.state}:null,waiting:this.waiting.length},log:this.logLines.slice(-40)};
 }
 changed(){this.onChange();}

 /** Starts an install in the background and returns at once; progress arrives through onChange. */
 async install(id,{accept=false}={}){
  const model=MODELS[id];if(!model)throw Error('Unknown model.');
  if(this.installing&&!this.installing.error)throw Error('Another install is running. Wait for it or cancel it first.');
  if(this.installed.has(id))throw Error(model.label+' is already installed.');
  const fit=suitability(id,await this.hardware());if(!fit.ok)throw Error(fit.reason);
  if(model.licence.accept&&accept!==true)throw Error('Accept the '+model.licence.name+' first.');
  const job={model:id,step:'Starting',progress:0,controller:new AbortController()};this.installing=job;this.logLines=[];this.changed();
  void this.runInstall(id,job).then(()=>{this.installed.add(id);this.installing=null;this.log(model.label+' is installed.');this.onInstalled?.(id);},error=>{if(error.cancelled||job.controller.signal.aborted)this.installing=null;else{job.error=String(error.message||error).slice(0,500);this.log('Install failed: '+job.error);}}).finally(()=>this.changed());
  return this.public();
 }
 cancelInstall(){if(!this.installing)throw Error('Nothing is being installed.');if(this.installing.error)this.installing=null;else this.installing.controller.abort();this.changed();return this.public();}
 async runInstall(id,job){
  const model=MODELS[id],hardware=await this.hardware(),home=path.join(this.root,id),signal=job.controller.signal,sets=weightSets(id),total=sets.flatMap(set=>set.files).reduce((sum,[,size])=>sum+size,0);
  let last=0;const at=(step,progress)=>{job.step=step;job.progress=Math.max(0,Math.min(99,Math.round(progress)));if(Date.now()-last>400||step!==job.shown){last=Date.now();job.shown=step;this.changed();}};
  await fs.mkdir(home,{recursive:true});
  at('Getting the installer',1);const uv=await this.uv(hardware,signal);
  for(const [index,source] of model.sources.entries()){at('Downloading the model code',3+index);await this.source(source,path.join(home,'src',source.dir),signal);}
  at('Setting up Python',6);// Packages are kept once in a cache beside the models and hard-linked into each model's environment, so a second model costs almost no extra disk. Delete clears the cache with the last model.
  const env={...process.env,UV_PYTHON_INSTALL_DIR:path.join(this.root,'python'),UV_CACHE_DIR:path.join(this.root,'package-cache')};delete env.VIRTUAL_ENV;
  const venv=path.join(home,'venv'),python=path.join(venv,hardware.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(!existsSync(python))await this.command(uv,['venv',venv,'--python',PYTHON],{env,signal});
  const packagesLabel='Installing Python packages (about '+(hardware.gpu.kind==='nvidia'?6:2)+' GB)';at(packagesLabel,9);
  const torch=model.torch||{backend:'auto',packages:torchPackages(hardware)},wheels=(model.wheels||[]).map(file=>/^https:\/\//.test(file)?file:path.join(home,'src',model.sources[0].dir,file));
  await this.command(uv,['pip','install','--python',python,'--torch-backend',torch.backend,...torch.packages,...model.packages,...wheels],{env,signal,onLine:line=>{const match=line.match(/Prepared (\d+) packages|Installed (\d+) packages|Resolved (\d+) packages/);if(match)at(packagesLabel,match[3]?12:match[1]?20:22);}});
  if(hardware.gpu.kind==='nvidia'){
   const usable=async()=>{const seen=await run(python,['-c','import torch;print("cuda" if torch.cuda.is_available() else "none", torch.__version__)'],{timeout:120000});this.log('PyTorch: '+(seen||'did not start'));return seen.startsWith('cuda');};
   at('Checking the graphics card',21);
   // An environment left with the CPU-only build keeps it unless told to replace it.
   if(!await usable()){at('Installing PyTorch for the graphics card (about 3 GB)',21);await this.command(uv,['pip','install','--python',python,'--torch-backend',torch.backend,'--reinstall-package','torch','--reinstall-package','torchvision',...torch.packages,...model.packages,...wheels],{env,signal});
    if(!await usable())throw Error('PyTorch was installed but cannot use the graphics card. Update the NVIDIA driver, then press Install again.');}
  }
  let done=0;
  for(const set of sets)for(const [file,size] of set.files){
   const target=path.join(home,set.dir,file),url='https://huggingface.co/'+set.repo+'/resolve/'+set.revision+'/'+file;
   await this.download(url,target,signal,bytes=>at('Downloading the model ('+((done+bytes)/1e9).toFixed(1)+' of '+(total/1e9).toFixed(1)+' GB)',23+75*(done+bytes)/total),size);done+=size;
  }
  // The background remover every model uses, fetched now and kept once for all of them, so the first generation does not sit waiting for it.
  at('Downloading the background remover',99);await this.download(U2NET,path.join(this.root,'u2net','u2net.onnx'),signal,()=>{},175000000).catch(error=>{if(error.cancelled)throw error;this.log('The background remover will download on first use instead: '+error.message);});
  at('Finishing',99);await fs.writeFile(path.join(home,'installed.json'),JSON.stringify({model:id,at:new Date().toISOString(),platform:hardware.key,gpu:hardware.gpu.name},null,2));
 }
 /** uv from the machine if it has one, otherwise a pinned copy downloaded into the models folder. */
 async uv(hardware,signal){
  const name=hardware.platform==='win32'?'uv.exe':'uv',own=path.join(this.root,'tools',name);
  if(existsSync(own))return own;
  if(!this.ownUv&&await run(name,['--version']))return name;
  const asset=uvAsset(hardware.platform,hardware.arch),folder=path.join(this.root,'.tmp','uv'),archive=path.join(folder,asset);
  await fs.rm(folder,{recursive:true,force:true});await fs.mkdir(folder,{recursive:true});
  await this.download('https://github.com/astral-sh/uv/releases/download/'+UV_VERSION+'/'+asset,archive,signal);
  await this.command('tar',['-xf',archive,'-C',folder],{signal});
  const found=(await fs.readdir(folder,{recursive:true})).find(entry=>path.basename(entry)===name);if(!found)throw Error('The installer download did not contain uv.');
  await fs.mkdir(path.dirname(own),{recursive:true});await fs.copyFile(path.join(folder,found),own);await fs.chmod(own,0o755);await fs.rm(folder,{recursive:true,force:true});return own;
 }
 /** One repository at one exact commit, fetched as an archive so git is not needed. */
 async source({repo,commit},target,signal){
  if(existsSync(path.join(target,'.meshdesk-commit'))&&(await fs.readFile(path.join(target,'.meshdesk-commit'),'utf8'))===commit)return;
  const folder=path.join(this.root,'.tmp',commit),archive=folder+'.tar.gz';await fs.rm(target,{recursive:true,force:true});await fs.mkdir(target,{recursive:true});await fs.mkdir(path.dirname(archive),{recursive:true});
  await this.download('https://codeload.github.com/'+repo+'/tar.gz/'+commit,archive,signal);
  await this.command('tar',['-xzf',archive,'-C',target,'--strip-components=1'],{signal});
  await fs.rm(archive,{force:true});await fs.writeFile(path.join(target,'.meshdesk-commit'),commit);
 }
 /**
  * Downloads one file, picking up where an interrupted download stopped. Large files come down as several pieces at once:
  * Hugging Face limits each connection on some networks to about 1 MB/s, and eight connections are several times faster.
  */
 async download(url,target,signal,onBytes=()=>{},expected=0){
  if(existsSync(target)&&(!expected||(await fs.stat(target)).size>=expected*0.98)&&!existsSync(target+'.part'))return;
  await fs.mkdir(path.dirname(target),{recursive:true});
  const token=/^https:\/\/huggingface\.co\//.test(url)?this.token?.():'',headers=token?{Authorization:'Bearer '+token}:{};
  const refuse=status=>Object.assign(Error(status===401||status===403?'Hugging Face refused the download of '+path.basename(target)+'. This model needs a Hugging Face token with access to it: add one under 3D generation.':'The download of '+path.basename(target)+' failed ('+status+').'),{fatal:status>=400&&status<500});
  let total=0;
  try{const probe=await this.fetcher(url,{signal,redirect:'follow',headers:{...headers,Range:'bytes=0-0'}});await probe.body?.cancel().catch(()=>{});if(!probe.ok)throw refuse(probe.status);total=probe.status===206?Number(/\/(\d+)\s*$/.exec(probe.headers.get('content-range')||'')?.[1])||0:0;}
  catch(error){if(signal?.aborted)throw cancelled();if(error.fatal)throw error;}
  if(total>=64*2**20)return this.pieces(url,target,total,signal,onBytes,headers,refuse);
  const part=target+'.part';
  for(let attempt=1;;attempt++){
   let have=0;try{have=(await fs.stat(part)).size;}catch{}
   try{
    const response=await this.fetcher(url,{signal,redirect:'follow',headers:{...headers,...(have?{Range:'bytes='+have+'-'}:{})}});
    if(response.status===416){await fs.rm(part,{force:true});continue;}
    if(!response.ok)throw refuse(response.status);
    if(have&&response.status!==206){have=0;}
    await this.save(response,part,have,bytes=>onBytes(bytes));
    await fs.rename(part,target);return;
   }catch(error){
    if(signal?.aborted)throw cancelled();
    if(error.fatal||attempt>=5)throw Error(error.fatal?error.message:'The download of '+path.basename(target)+' kept failing. Check the connection and press Install again; it resumes where it stopped.');
    this.log('Download interrupted, retrying ('+attempt+' of 5)…');await new Promise(resolve=>setTimeout(resolve,2000*attempt));
   }
  }
 }
 /** Writes a response to a file, appending when have is set. Calls onBytes with the file's size as it grows. */
 async save(response,file,have,onBytes){const out=createWriteStream(file,{flags:have?'a':'w'}),reader=response.body.getReader();let bytes=have,broken=null;out.on('error',error=>{broken=error;});try{for(;;){if(broken){await reader.cancel().catch(()=>{});throw Error('Could not write '+path.basename(file)+': '+broken.message);}
   // A connection can go quiet without closing, which would otherwise hang the install for good. Give up on it after a pause; the caller resumes from the bytes already saved.
   let timer;const {value,done}=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('The download stalled.')),this.stallMs||30000);})]).finally(()=>clearTimeout(timer)).catch(async error=>{await reader.cancel().catch(()=>{});throw error;});if(done)break;bytes+=value.length;if(!out.write(value))await new Promise(resolve=>out.once('drain',resolve));onBytes(bytes);}}finally{await new Promise(resolve=>broken?resolve():out.end(resolve));}if(broken)throw Error('Could not write '+path.basename(file)+': '+broken.message);return bytes;}
 /** One large file as up to eight pieces fetched together, each resumable on its own, then joined. */
 async pieces(url,target,total,signal,onBytes,headers,refuse){
  const count=Math.min(8,Math.ceil(total/(32*2**20))),size=Math.ceil(total/count),sizes=new Array(count).fill(0),stop=new AbortController(),both=signal?AbortSignal.any([signal,stop.signal]):stop.signal;
  const report=()=>onBytes(sizes.reduce((sum,value)=>sum+value,0));
  const piece=async index=>{
   const start=index*size,length=Math.min(total,start+size)-start,file=target+'.piece'+index;
   for(let attempt=1;;attempt++){
    let have=0;try{have=(await fs.stat(file)).size;}catch{}
    if(have>length){await fs.rm(file,{force:true});have=0;}
    if(have>sizes[index]+2**20)attempt=1;   // it got further than last time, so this is a slow link rather than a broken one
    sizes[index]=have;report();if(have===length)return;
    try{
     const response=await this.fetcher(url,{signal:both,redirect:'follow',headers:{...headers,Range:'bytes='+(start+have)+'-'+(start+length-1)}});
     if(response.status!==206)throw response.ok?Object.assign(Error('The server does not allow resuming.'),{fatal:true}):refuse(response.status);
     await this.save(response,file,have,bytes=>{sizes[index]=bytes;report();});
    }catch(error){
     if(both.aborted)throw cancelled();
     if(error.fatal||attempt>=8)throw Error(error.fatal?error.message:'The download of '+path.basename(target)+' kept failing. Check the connection and press Install again; it resumes where it stopped.');
     await new Promise(resolve=>setTimeout(resolve,1500*attempt));
    }
   }
  };
  try{await Promise.all(Array.from({length:count},(_,index)=>piece(index)));}catch(error){stop.abort();if(signal?.aborted)throw cancelled();throw error;}
  const part=target+'.part',out=createWriteStream(part);
  try{for(let index=0;index<count;index++){const handle=await fs.open(target+'.piece'+index);try{for await(const chunk of handle.createReadStream())if(!out.write(chunk))await new Promise(resolve=>out.once('drain',resolve));}finally{await handle.close();}}}finally{await new Promise(resolve=>out.end(resolve));}
  if((await fs.stat(part)).size!==total)throw Error('The download of '+path.basename(target)+' came out the wrong size. Press Install again.');
  await fs.rename(part,target);for(let index=0;index<count;index++)await fs.rm(target+'.piece'+index,{force:true});
 }
 /** Runs a program to the end, keeping its output in the log. */
 command(file,args,{env,signal,onLine=()=>{},cwd}={}){
  return new Promise((resolve,reject)=>{
   this.log('$ '+path.basename(file)+' '+args.slice(0,6).join(' ')+(args.length>6?' …':''));
   const child=spawn(file,args,{env,cwd,signal,windowsHide:true,stdio:['ignore','pipe','pipe']});let tail='';
   const take=chunk=>{const text=String(chunk);tail=(tail+text).slice(-2000);this.log(text);for(const line of text.split(/\r?\n|\r/))if(line.trim())onLine(line);};
   child.stdout.on('data',take);child.stderr.on('data',take);
   child.on('error',error=>reject(signal?.aborted?cancelled():Error(error.code==='ENOENT'?'Could not run '+path.basename(file)+' on this machine.':error.message)));
   child.on('close',code=>code===0?resolve():reject(signal?.aborted?cancelled():Error(path.basename(file)+' failed: '+(tail.trim().split(/\r?\n/).slice(-3).join(' ').slice(-400)||'exit code '+code))));
  });
 }

 /** Removes a model and everything installed for it. */
 async remove(id){
  if(!MODELS[id])throw Error('Unknown model.');if(this.installing?.model===id&&!this.installing.error)throw Error('Cancel the install first.');
  if(this.server?.model===id)await this.stop();if(this.installing?.model===id)this.installing=null;
  this.installed.delete(id);await fs.rm(path.join(this.base(id),id),{recursive:true,force:true});this.homes.delete(id);if(!this.installed.size)await fs.rm(path.join(this.root,'package-cache'),{recursive:true,force:true}).catch(()=>{});this.onRemoved?.(id);this.changed();return this.public();
 }
 /** Starts the model's server if it is not already running, and resolves with its address once it answers. */
 async start(id){
  if(!this.installed.has(id))throw Error(MODELS[id]?MODELS[id].label+' is not installed.':'Unknown model.');
  if(this.server?.model===id&&['starting','running'].includes(this.server.state))return this.server.ready;
  // One model is loaded at a time. Switching while the other is part way through a generation would throw that work away.
  if(this.server?.state==='running'){const busy=await this.fetcher(this.server.url+'/health',{signal:AbortSignal.timeout(3000)}).then(r=>r.json()).then(h=>!!h.busy).catch(()=>false);if(busy)throw Error(MODELS[this.server.model].label+' is in the middle of a generation on this computer. Try again when it finishes.');}
  if(this.server)await this.stop();
  const hardware=await this.hardware(),home=path.join(this.base(id),id),python=path.join(home,'venv',hardware.platform==='win32'?'Scripts/python.exe':'bin/python'),port=await freePort();
  const env={...process.env,U2NET_HOME:path.join(this.base(id),'u2net'),HF_HUB_OFFLINE:'1',PYTHONUNBUFFERED:'1'};delete env.VIRTUAL_ENV;delete env.PYTHONPATH;
  this.log('Starting '+MODELS[id].label+' on port '+port);
  const child=spawn(python,['-u',this.serveScript,'--model',id,'--root',home,'--port',String(port)],{env,cwd:home,windowsHide:true,stdio:['ignore','pipe','pipe']}),server={model:id,port,state:'starting',child,url:'http://127.0.0.1:'+port};this.server=server;
  child.stdout.on('data',chunk=>this.log(chunk));child.stderr.on('data',chunk=>this.log(chunk));
  child.on('error',error=>{server.state='failed';server.error=error.message;this.changed();});
  child.on('close',code=>{if(this.server!==server)return;if(server.state!=='stopping'){server.state='failed';server.error='The model server stopped unexpectedly'+(code?' (exit code '+code+')':'')+'. The log has the details.';}else this.server=null;this.changed();});
  server.ready=(async()=>{for(const started=Date.now();Date.now()-started<90000;){if(server.state==='failed')throw Error(server.error);try{const response=await this.fetcher(server.url+'/health',{signal:AbortSignal.timeout(2000)});if(response.ok){server.state='running';this.changed();return server.url;}}catch{}await new Promise(resolve=>setTimeout(resolve,500));}
   server.state='failed';server.error='The model server did not start within 90 seconds.';child.kill();this.changed();throw Error(server.error);})();
  server.ready.catch(()=>{});this.changed();return server.ready;
 }
 async stop(){const server=this.server;if(!server)return {ok:true};server.state='stopping';const gone=new Promise(resolve=>server.child.once('close',resolve));server.child.kill();await Promise.race([gone,new Promise(resolve=>setTimeout(resolve,4000))]);if(server.child.exitCode===null&&server.child.signalCode===null)server.child.kill('SIGKILL');if(this.server===server)this.server=null;this.changed();return {ok:true};}
 /**
  * Generations on this machine, one at a time, from this computer and from paired ones alike. A request is queued and
  * answered at once with a ticket; when its turn comes the right model is loaded (unloading another if need be), the
  * request is run, and its result is kept until asked for. status(ticket) reports where it is in that.
  */
 submit(model,body){
  if(!this.installed.has(model))throw Error(MODELS[model]?MODELS[model].label+' is not installed on this computer.':'Unknown model.');
  const job={id:randomUUID(),model,body,state:'queued',at:Date.now()};this.jobs.set(job.id,job);this.waiting.push(job);
  for(const [id,old] of this.jobs)if(old.state==='done'&&Date.now()-old.at>30*60000)this.jobs.delete(id);
  this.changed();void this.pump();return {uid:job.id};
 }
 status(id){
  const job=this.jobs.get(id);if(!job)return {status:'error',message:'That generation is no longer known to this computer.'};
  if(job.state==='queued'){const ahead=this.waiting.indexOf(job)+(this.running?1:0);return {status:'processing',progress:0,queued:ahead,message:'Waiting for '+(ahead===1?'another generation':ahead+' other generations')+' to finish'};}
  if(job.state==='loading')return {status:'processing',progress:1,message:job.switching?'Unloading '+MODELS[job.switching].label+' and loading '+MODELS[job.model].label:'Loading '+MODELS[job.model].label};
  if(job.state==='done'){const result=job.result;if(['completed','error'].includes(result.status))this.jobs.delete(id);return result;}
  // The model loads on the server's first request, so a switch shows up there as plain loading; name what is being swapped.
  const latest=job.latest||{status:'processing',progress:2,message:'Starting'};
  if(job.switching&&/^Loading the model|^Starting/.test(latest.message||''))return {...latest,message:'Unloading '+MODELS[job.switching].label+' and loading '+MODELS[job.model].label};
  return latest;
 }
 /** Cancels a generation: a waiting one leaves the queue; a running one stops at its next step and frees the machine. */
 cancel(id){
  const job=this.jobs.get(id);if(!job||job.state==='done')return {ok:true};
  if(job.state==='queued'){this.waiting=this.waiting.filter(other=>other!==job);job.state='done';job.at=Date.now();job.body=null;job.result={status:'error',message:'Cancelled.',cancelled:true};this.changed();return {ok:true};}
  job.cancelled=true;if(job.serveUid&&job.url)void this.fetcher(job.url+'/cancel/'+job.serveUid,{method:'POST',signal:AbortSignal.timeout(10000)}).catch(()=>{});
  return {ok:true};
 }
 async pump(){
  if(this.running||!this.waiting.length)return;
  const job=this.waiting.shift();this.running=job;this.changed();
  try{
   const loaded=this.server&&['starting','running'].includes(this.server.state)?this.server.model:'';job.switching=loaded&&loaded!==job.model?loaded:'';job.state='loading';
   const url=await this.start(job.model);job.url=url;
   if(job.cancelled)throw Object.assign(Error('Cancelled.'),{cancelled:true});
   const sent=await (await this.fetcher(url+'/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(job.body),signal:AbortSignal.timeout(120000)})).json();
   if(!sent.uid)throw Error(sent.error||'The model server did not start the generation.');
   job.serveUid=sent.uid;job.state='running';this.changed();
   if(job.cancelled)void this.fetcher(url+'/cancel/'+sent.uid,{method:'POST',signal:AbortSignal.timeout(10000)}).catch(()=>{});
   // Follow it here rather than leaving it to whoever asked, so the queue moves on even if they stop asking.
   for(const started=Date.now();;){
    if(Date.now()-started>60*60000)throw Error('The generation took longer than an hour.');
    await new Promise(resolve=>setTimeout(resolve,this.pollMs));
    let task;try{task=await (await this.fetcher(url+'/status/'+sent.uid,{signal:AbortSignal.timeout(120000)})).json();}catch{if(this.server?.state==='failed')throw Error(this.server.error);continue;}
    if(['completed','error'].includes(task.status)){job.result=task;break;}
    job.latest=task;
   }
  }catch(error){job.result={status:'error',message:String(error.message||error).slice(0,400),...(error.cancelled?{cancelled:true}:{})};}
  finally{job.state='done';job.at=Date.now();job.body=null;this.running=null;this.changed();void this.pump();}
 }
 shutdown(){this.installing?.controller?.abort();if(this.server){this.server.state='stopping';this.server.child.kill();}}
}
