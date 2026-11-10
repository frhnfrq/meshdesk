import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';
import {CodexBridge} from './codex.mjs';
import {FeedbackStore} from './store.mjs';
import {Reviews} from './reviews.mjs';
import {ExportManager} from './exports.mjs';
import {AssetLibrary} from './library.mjs';
import {captureHandler} from './captures.mjs';
import {resolveLibraryFile,sameLocalOrigin} from './validation.mjs';
const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let config={};try{config=JSON.parse(await fs.readFile(path.join(projectRoot,'config.local.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const dataRoot=path.resolve(process.env.ASSET_REVIEW_DATA||path.join(projectRoot,'.data'));
const port=Number(process.env.PORT||8790),development=process.argv.includes('--dev');
import {Projects,readJson,writeJson,importAsset,developerBundle} from './projects.mjs';
import {validateFeedback} from './validation.mjs';
const projects=new Projects(dataRoot,process.env.ASSET_LIBRARY_PATH||config.assetLibraryPath,config.projectsDirectory);await projects.init();
const runtimes=new Map();
async function runtime(id){if(runtimes.has(id))return runtimes.get(id);const pending=projects.resolve(id).then(buildRuntime);runtimes.set(id,pending);try{return await pending;}catch(e){runtimes.delete(id);throw e;}}
async function buildRuntime(project){
 const assetRoot=project.source,dataRoot=project.data;
 const entries=await readJson(path.join(assetRoot,'05_Catalog/inventory.json'),[]);
 for(const a of entries){if(!/^[a-f0-9]{12}$/.test(a.id))throw Error('Invalid asset ID.');resolveLibraryFile(assetRoot,a.path);if(a.preview)resolveLibraryFile(assetRoot,a.preview);}
 const catalog=new Map(entries.map(a=>[a.id,a])),bridge=new CodexBridge({binary:process.env.CODEX_BIN||config.codexBinary||'codex'}),store=new FeedbackStore(dataRoot);await store.init();
 const clients=new Set();function broadcast(event){for(const res of clients)if(!res.destroyed)res.write(JSON.stringify(event)+'\n');}
 const library=new AssetLibrary({root:path.join(dataRoot,'library'),originalRoot:assetRoot,catalog,broadcast,blender:config.blenderBinary});await library.init();
 const reviews=new Reviews({bridge,store,catalog,assetRoot,broadcast,library});bridge.on('status',()=>broadcast({type:'connection',connection:bridge.status()}));
 const router=express.Router(),app=router;
 app.get('/snapshots/:name',(req,res)=>{if(!/^[a-f0-9-]{36}\.meshdesk\.zip$/.test(req.params.name))return res.sendStatus(404);res.download(path.join(project.snapshots,req.params.name),project.name+'.meshdesk.zip',{dotfiles:'allow'});});
 const exporter=new ExportManager({library,project,broadcast});await exporter.init();
 const result={exporter,router,library,reviews,bridge,store,clients,catalog,assetRoot,dataRoot,broadcast};
 app.get('/api/bootstrap',async(req,res)=>res.json({catalog:library.public(),token,connection:bridge.status(),libraryName:project.name,project,base:'/p/'+project.id,workspace:await readJson(path.join(dataRoot,'workspace.json'),{})}));
app.get('/api/health',(req,res)=>res.json({ok:true,app:'metro-hustle-assets',connection:bridge.status()}));
app.get('/api/events',(req,res)=>{res.status(200).set({'Content-Type':'application/x-ndjson','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();clients.add(res);res.write(JSON.stringify({type:'catalog',catalog:library.public()})+'\n');res.write(JSON.stringify({type:'connection',connection:bridge.status()})+'\n');for(const session of store.sessions.values())res.write(JSON.stringify({type:'conversation',conversation:store.public(session)})+'\n');const heartbeat=setInterval(()=>res.write('{"type":"heartbeat"}\n'),15000);req.on('close',()=>{clearInterval(heartbeat);clients.delete(res);});});
app.get('/api/feedback/:id',(req,res)=>{if(!catalog.has(req.params.id))return res.status(404).json({error:'Asset not found.'});res.json(store.public(store.get(req.params.id)));});
app.post('/api/feedback/:id',async(req,res)=>{try{res.status(202).json(await reviews.submit(req.params.id,req.body));}catch(error){res.status(error.status||400).json({error:error.message});}});
app.post('/api/feedback/:id/cancel',async(req,res)=>{try{await reviews.cancel(req.params.id);res.json({ok:true});}catch(error){res.status(500).json({error:reviews.friendly(error)});}});
app.post('/api/reconnect',async(req,res)=>{try{await bridge.connect();res.json(bridge.status());}catch(error){res.status(503).json({error:reviews.friendly(error)});}});
app.get('/library/:id',(req,res)=>{const asset=catalog.get(req.params.id);if(!asset)return res.sendStatus(404);const filename=library.file(asset);if(req.query.download==='1')return res.download(filename,path.basename(filename),{dotfiles:'allow'});res.sendFile(path.basename(filename),{root:path.dirname(filename)});});
app.get('/previews/:id',(req,res)=>{const asset=catalog.get(req.params.id);if(!asset?.preview)return res.sendStatus(404);try{const version=library.version(asset,req.query.version);res.set('Cache-Control','no-store');res.sendFile(path.basename(version.preview),{root:path.dirname(version.preview)});}catch{res.sendStatus(404);}});
app.get('/versions/:id/:version/:format',(req,res)=>{try{const asset=library.require(req.params.id),version=library.version(asset,req.params.version);const format=req.params.format;if(!['fbx','blend'].includes(format)||format==='blend'&&!version.blend)return res.sendStatus(404);const filename=format==='blend'?version.blend:version.file;res.download(filename,asset.name+'.'+format,{dotfiles:'allow'});}catch{res.sendStatus(404);}});
app.post('/api/library/:id/restore',async(req,res)=>{try{res.json(await library.restore(req.params.id));}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/library/:id/version',async(req,res)=>{try{res.json(await library.useVersion(req.params.id,req.body.versionId));}catch(e){res.status(400).json({error:e.message});}});
app.get('/captures/:name',captureHandler(dataRoot));
app.get('/06_Preview/',(req,res)=>res.redirect('/'));

app.post('/api/workspace',async(req,res)=>{await writeJson(path.join(dataRoot,'workspace.json'),req.body);res.json({ok:true});});
app.post('/api/save',async(req,res)=>{try{const file=await projects.snapshot(project,result);res.json({url:'/p/'+project.id+'/snapshots/'+file,projects:projects.public()});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/import',async(req,res)=>{try{res.json(await importAsset(result,req.body));}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/upload',async(req,res)=>{try{const parsed=validateFeedback({text:'upload',requestId:randomBytes(16).toString('hex'),snapshot:req.body.image});if(!parsed.image)throw Error('Choose an image.');const name=randomUUID()+'.'+parsed.image.extension;await fs.writeFile(path.join(dataRoot,'captures',name),parsed.image.bytes);res.json({name,label:String(req.body.name||'Screenshot').slice(0,150)});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/materials/:id',async(req,res)=>{try{res.json(await library.materialInfo(req.params.id,req.query.version));}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/history/:id',(req,res)=>{try{res.json(library.history(req.params.id));}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/export-settings',async(req,res)=>res.json(await exporter.settings()));
app.post('/api/exports/check',async(req,res)=>{try{res.json(await exporter.check(req.body));}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/exports/:id',(req,res)=>{try{res.json(exporter.public(exporter.get(req.params.id)));}catch(e){res.status(404).json({error:e.message});}});
for(const operation of ['start','retry'])app.post('/api/exports/:id/'+operation,async(req,res)=>{try{res.status(202).json(await exporter.start(req.params.id,{allowWarnings:req.body.allowWarnings,retry:operation==='retry'}));}catch(e){res.status(400).json({error:e.message});}});
app.get('/exports/:id/download',(req,res)=>{try{const job=exporter.get(req.params.id);if(!job.hasArchive)return res.sendStatus(404);res.download(path.join(exporter.outputRoot,job.id+'.zip'),'Meshdesk-'+project.name.replace(/[^a-zA-Z0-9 _-]/g,'_')+'-export.zip',{dotfiles:'allow'});}catch{res.sendStatus(404);}});
app.get('/export/:id',async(req,res)=>{try{const bytes=await developerBundle(result,req.params.id,req.query.version);res.type('application/zip').attachment(library.require(req.params.id).name+'-developer.zip').send(Buffer.from(bytes));}catch(e){res.status(400).json({error:e.message});}});

 void bridge.connect().catch(()=>{});return result;
}
const app=express();app.disable('x-powered-by');
app.use((req,res,next)=>{if(!sameLocalOrigin(req,port))return res.status(403).json({error:'Only the local viewer can use this service.'});res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('Cross-Origin-Resource-Policy','same-origin');next();});
const token=randomBytes(32).toString('hex');
app.use((req,res,next)=>{res.set('Cache-Control','no-store');if(!['GET','HEAD'].includes(req.method)){const supplied=req.get('X-Session-Token')||'';if(Buffer.byteLength(supplied)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))return res.status(403).json({error:'Refresh the viewer to reconnect securely.'});}next();});
app.use('/api/projects/open',express.raw({type:'application/zip',limit:'1gb'}));
app.use(express.json({limit:'220mb'}));
app.get('/api/bootstrap',(req,res)=>res.json({token,projects:projects.public()}));
app.get('/api/health',(req,res)=>res.json({ok:true,app:'meshdesk'}));
app.get('/api/projects',(req,res)=>res.json(projects.public()));
app.post('/api/projects',async(req,res,next)=>{try{const p=await projects.create(req.body.name);res.json({id:p.id});}catch(e){next(e);}});
app.post('/api/projects/open-file',async(req,res)=>{try{const {loadProject}=await import('./project-format.mjs');const candidate=await loadProject(req.body.path);const old=await runtimes.get(candidate.id);if(old&&(old.assetRoot!==candidate.source||old.dataRoot!==candidate.data)&&(old.reviews.active.size||old.exporter.tasks.size))throw Error('Wait for this project’s running edits before reopening it from another folder.');const p=await projects.register(candidate.file);if(old&&(old.assetRoot!==p.source||old.dataRoot!==p.data)){await old.reviews.shutdown();for(const client of old.clients)client.end();old.bridge.close();runtimes.delete(p.id);}res.json({id:p.id,file:p.file});}catch(e){res.status(400).json({error:e.code==='ENOENT'?'Project file or required project folder not found.':e.message});}});
app.post('/api/projects/open',async(req,res,next)=>{try{const p=await projects.create('',Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body.archive,'base64'));res.json({id:p.id});}catch(e){res.status(400).json({error:e.message});}});
app.get('/snapshots/:name',async(req,res)=>{if(!/^[a-f0-9-]{36}\.meshdesk\.zip$/.test(req.params.name))return res.sendStatus(404);for(const item of projects.items){try{const p=await projects.resolve(item.id),file=path.join(p.snapshots,req.params.name);await fs.access(file);return res.download(file,p.name+'.meshdesk.zip',{dotfiles:'allow'});}catch{}}res.sendStatus(404);});
app.use('/p/:project',async(req,res,next)=>{try{(await runtime(req.params.project)).router(req,res,next);}catch(e){res.status(400).json({error:e.message});}});
let vite;
if(development){const {createServer}=await import('vite');vite=await createServer({root:projectRoot,server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);}
else{app.use(express.static(path.join(projectRoot,'dist')));app.get('/',(req,res)=>res.sendFile(path.join(projectRoot,'dist/index.html')));}
app.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(error.status||500).json({error:error.type==='entity.too.large'?'Message or screenshot is too large.':'The local server could not process this request.'});});
const server=app.listen(port,'127.0.0.1',()=>{console.log(`Meshdesk\nhttp://127.0.0.1:${port}\nProjects: ${projects.projectsRoot}\nRegistry: ${dataRoot}/projects.json`);});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Open http://127.0.0.1:${port} or set PORT to another port.`:error.message);process.exit(1);});
let closing=false;async function shutdown(){if(closing)return;closing=true;for(const pending of runtimes.values()){const r=await pending;await r.reviews.shutdown();await r.exporter.shutdown();for(const res of r.clients)res.end();r.bridge.close();}await vite?.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
