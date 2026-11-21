import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';
import {CodexBridge} from './codex.mjs';
import {ClaudeBridge} from './claude.mjs';
import {Agents,AgentSettings} from './agents.mjs';
import {ConversationStore} from './store.mjs';
import {Conversations} from './conversations.mjs';
import {ExportManager} from './exports.mjs';
import {AssetLibrary} from './library.mjs';
import {captureHandler} from './captures.mjs';
import {ProjectSettings,styleIsSet,activeRules,addBoardItems} from './settings.mjs';
import {imageInfo} from './web-images.mjs';
import {AgentBrowser} from './browser.mjs';
import {existsSync} from 'node:fs';
import {Scenes,blockManifest} from './scenes.mjs';
import {Batches} from './batches.mjs';
import {SharedMaterials} from './materials.mjs';
import {Consistency} from './consistency.mjs';
import {Handoff} from './handoff.mjs';
import {Generators,Generations} from './generators.mjs';
import {LocalModels} from './local-models.mjs';
import {Sharing} from './sharing.mjs';
import {imageConfig} from './textures.mjs';
import {presetEdit,presetList} from './presets.mjs';
import {resolveLibraryFile,sameLocalOrigin} from './validation.mjs';
const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let config={};try{config=JSON.parse(await fs.readFile(path.join(projectRoot,'config.local.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const dataRoot=path.resolve(process.env.ASSET_REVIEW_DATA||path.join(projectRoot,'.data'));
const port=Number(process.env.PORT||8790),development=process.argv.includes('--dev');
import {Projects,readJson,writeJson,importAsset,developerBundle,createModel,collect} from './projects.mjs';
import {zipSync} from 'fflate';
import {executeEditTool} from './edit-tools.mjs';
import {validateMessage} from './validation.mjs';
const projects=new Projects(dataRoot,process.env.ASSET_LIBRARY_PATH||config.assetLibraryPath,config.projectsDirectory);await projects.init();
const agentSettings=new AgentSettings(path.join(dataRoot,'agent.json'));await agentSettings.init();
const generators=new Generators(path.join(dataRoot,'generators.json'));await generators.init();
const runtimes=new Map();
const tellAll=event=>{for(const pending of runtimes.values())void pending.then(r=>r.broadcast(event)).catch(()=>{});};
/** Local models Meshdesk installs and runs itself. Installing one switches the local route on and points it at that model. */
// The models folder: the environment wins, then the folder chosen in the app (used from the next start), then config.local.json.
const localModels=new LocalModels({root:process.env.MESHDESK_MODELS_DIR||generators.value.modelsDirectory||config.modelsDirectory||path.join(dataRoot,'local-models'),olderRoots:[path.join(dataRoot,'local-models'),config.modelsDirectory].filter(Boolean),onChange:()=>void localModels.public().then(value=>tellAll({type:'localModels',localModels:value})).catch(()=>{})});await localModels.init();generators.local=localModels;localModels.token=()=>generators.hfToken();
const shareGenerators=()=>{const value=generators.public();tellAll({type:'generators',generators:value});return value;};
/** Sharing this computer's local model with other Meshdesks on the network, and finding theirs. Off until switched on. */
const sharing=new Sharing({generators,localModels,onChange:()=>void sharing.public().then(value=>tellAll({type:'sharing',sharing:value})).catch(()=>{})});await sharing.apply();
localModels.onInstalled=id=>void generators.update({providers:{local:{enabled:true,managed:id}}}).then(shareGenerators).catch(()=>{});
localModels.onRemoved=id=>{if(generators.value.providers.local.managed===id)void generators.update({providers:{local:{managed:localModels.installed.values().next().value||''}}}).then(shareGenerators).catch(()=>{});};
const browserProfiles=path.join(dataRoot,'browser-profiles');
async function runtime(id){if(runtimes.has(id))return runtimes.get(id);const pending=projects.resolve(id).then(buildRuntime);runtimes.set(id,pending);try{return await pending;}catch(e){runtimes.delete(id);throw e;}}
/** First start after versions and checkpoints were separated: collapse old iteration lists and show the steps in the chat that made them. */
async function linkLegacy(library,store){const made=await library.migrateVersions(assetId=>store.list().find(s=>s.legacyAssetId===assetId)?.id);const changed=new Set();for(const record of made){const session=store.list().find(s=>s.legacyAssetId===record.assetId);if(!session)continue;const replies=session.messages.filter(m=>m.role==='assistant'),reply=replies.findLast(m=>Date.parse(m.createdAt)<=Date.parse(record.at))||replies[0];if(!reply)continue;reply.checkpoints??=[];if(!reply.checkpoints.some(c=>c.versionId===record.versionId))reply.checkpoints.push(record);changed.add(session);}for(const session of changed)await store.save(session);}
async function buildRuntime(project){
 const assetRoot=project.source,dataRoot=project.data;
 const entries=await readJson(path.join(assetRoot,'05_Catalog/inventory.json'),[]);
 for(const a of entries){if(!/^[a-f0-9]{12}$/.test(a.id))throw Error('Invalid asset ID.');resolveLibraryFile(assetRoot,a.path);if(a.preview)resolveLibraryFile(assetRoot,a.preview);}
 const catalog=new Map(entries.map(a=>[a.id,a])),bridge=new Agents({bridges:{codex:new CodexBridge({binary:process.env.CODEX_BIN||config.codexBinary||'codex'}),claude:new ClaudeBridge({binary:process.env.CLAUDE_BIN||config.claudeBinary})},settings:agentSettings}),store=new ConversationStore(dataRoot);await store.init();
 const clients=new Set();function broadcast(event){for(const res of clients)if(!res.destroyed)res.write(JSON.stringify(event)+'\n');}
 const settings=new ProjectSettings(path.join(dataRoot,'project-settings.json'));await settings.init();const images=imageConfig(config);
 const library=new AssetLibrary({root:path.join(dataRoot,'library'),originalRoot:assetRoot,catalog,broadcast,blender:config.blenderBinary,settings:()=>settings.get()});await library.init();
 const scenes=new Scenes({file:path.join(dataRoot,'scenes.json'),catalog,broadcast});await scenes.init();
 const conversations=new Conversations({agents:bridge,store,catalog,assetRoot,broadcast,library,scenes,settings:()=>settings.get(),extras:{imageConfig:images,createModel:(options,signal,onProgress)=>createModel(result,options,signal,onProgress),importTexture:(name,bytes)=>importAsset(result,{name,type:'texture',data:Buffer.from(bytes).toString('base64')}),importImage:(name,bytes,{sourceUrl}={})=>importAsset(result,{name,type:'reference',folder:'Agent',sourceUrl,data:Buffer.from(bytes).toString('base64')})}});bridge.on('status',()=>broadcast({type:'connection',connection:bridge.status()}));
 await linkLegacy(library,store);
 const styleReferences=current=>(current.style?.references||[]).map(id=>catalog.get(id)).filter(a=>a&&!a.removed&&['reference','texture'].includes(a.type));
 conversations.projectBrief=current=>styleIsSet(current.style)?{styleGuide:{palette:current.style.palette.length?current.style.palette:undefined,texelDensityPxPerMetre:current.style.texelDensity||undefined,maxTextureSize:current.maxTextureSize||undefined,rules:Array.isArray(current.style.rules)?current.style.rules.filter(r=>r.on).map(r=>({id:r.id,text:r.text})):activeRules(current.style).map(text=>({text})),moodboardItems:(current.style.board?.items||[]).map(i=>({id:i.id,kind:i.kind,x:i.x,y:i.y,w:i.w,...(i.kind==='image'?{assetId:i.assetId,name:catalog.get(i.assetId)?.name}:i.kind==='swatch'?{color:i.color,name:i.name||undefined}:{text:i.text.slice(0,80)})})),moodboardNotes:(current.style.board?.items||[]).filter(i=>i.kind==='note'&&i.text.trim()).map(i=>i.text.trim()),referenceImages:styleReferences(current).map(a=>({id:a.id,name:a.name,absolutePath:library.file(a)}))}}:{};
 const boardPicture=path.join(dataRoot,'style-board.jpg');
 conversations.styleSnapshot=()=>settings.get().style?.board?.items?.length&&existsSync(boardPicture)?boardPicture:null;
 conversations.styleImages=current=>conversations.styleSnapshot()?[boardPicture]:styleReferences(current).filter(a=>/\.(png|jpe?g|webp)$/i.test(a.path)).map(a=>library.file(a));
 const shareSettings=()=>{const value=publicSettings();broadcast({type:'settings',settings:value});return value;};
 conversations.applyStyle=async(style,by)=>{const before=JSON.stringify(settings.get().style?.board||null);await settings.update({style},{by});if(JSON.stringify(settings.get().style?.board||null)!==before)await fs.rm(boardPicture,{force:true}).catch(()=>{});shareSettings();};
 // The browser profile lives in the app's own data folder, not in the project, so it is never committed or archived with it.
 const browser=new AgentBrowser({profile:path.join(browserProfiles,String(project.id).replace(/[^a-zA-Z0-9_-]/g,'_')),mode:()=>settings.get().browserWindow==='background'?'background':'visible'});conversations.extras.browser=browser;
 const pictureSize=async asset=>{if(asset?.dimensions?.[0]>0)return asset.dimensions;try{const handle=await fs.open(library.file(asset));try{const {buffer,bytesRead}=await handle.read(Buffer.alloc(1024*1024),0,1024*1024,0),info=imageInfo(buffer.subarray(0,bytesRead));return info?.width?[info.width,info.height]:null;}finally{await handle.close();}}catch{return null;}};
 /** An agent adding to the moodboard. The saved picture of the board is dropped because it no longer matches; the app redraws it when the Style page is next open. */
 conversations.extras.board={add:async(items,by)=>{const current=settings.get().style||{},sizes={};for(const id of new Set([...(current.board?.items||[]),...items].map(i=>i.assetId).filter(Boolean))){const size=await pictureSize(catalog.get(id));if(size)sizes[id]=size;}const {style,added}=addBoardItems(current,items,sizes);await conversations.applyStyle(style,by);return added;}};
 conversations.onFinish=slot=>library.settleTurn(slot.session.id,(slot.reply.checkpoints||[]).map(c=>c.assetId));
 conversations.onSettle=async session=>{const pruned=await library.prune(session.id),gone=new Set(pruned.map(p=>p.versionId));if(gone.size)for(const m of session.messages)for(const c of m.checkpoints||[])if(gone.has(c.versionId))c.pruned=true;};
 const materials=new SharedMaterials({file:path.join(dataRoot,'materials.json'),catalog,library,broadcast});await materials.init();conversations.extras.materials=materials;
 const consistency=new Consistency({file:path.join(dataRoot,'consistency.json'),library,catalog,settings:()=>settings.get(),materials,broadcast});await consistency.init();
 const batches=new Batches({file:path.join(dataRoot,'batches.json'),conversations,store,library,catalog,broadcast});await batches.init();conversations.onIdle=slot=>void batches.finished(slot.session,slot.reply).catch(()=>{});
 const router=express.Router(),app=router,result={};
 app.get('/snapshots/:name',(req,res)=>{if(!/^[a-f0-9-]{36}\.meshdesk\.zip$/.test(req.params.name))return res.sendStatus(404);res.download(path.join(project.snapshots,req.params.name),project.name+'.meshdesk.zip',{dotfiles:'allow'});});
 const exporter=new ExportManager({library,project,broadcast});await exporter.init();
 const exportSceneFiles=(scene,format)=>{const stem=scene.name.replace(/[^a-zA-Z0-9 _-]/g,'_').trim().slice(0,80)||'Scene';return library.transaction(async()=>{const job=path.join(library.root,'jobs',randomUUID());await fs.mkdir(job,{recursive:true});try{const items=scene.items.map(item=>{const asset=library.require(item.assetId);return {...item,asset:asset.name,glb:library.version(asset).preview};});const output=await library.runner({job,source:null,script:'pass',mode:'scene',scene:{stem,format,name:scene.name,items,lighting:scene.lighting,environment:scene.environment},libraryRoot:library.originalRoot,workingRoot:library.root,binary:library.blender});return await collect(output.directory);}finally{await fs.rm(job,{recursive:true,force:true}).catch(()=>{});}});};
 /** Draws a scene for the agent. Returns {image, renderError}. */
 const renderScene=(scene,render,signal,onProgress)=>library.transaction(async()=>{const job=path.join(library.root,'jobs',randomUUID());await fs.mkdir(job,{recursive:true});try{const items=scene.items.map(item=>{const asset=library.require(item.assetId);return {...item,asset:asset.name,glb:library.version(asset).preview};});return await library.runner({job,source:null,script:'pass',mode:'scene',scene:{stem:'scene',format:'none',render,name:scene.name,items,lighting:scene.lighting,environment:scene.environment},libraryRoot:library.originalRoot,workingRoot:library.root,binary:library.blender,signal,onProgress});}finally{await fs.rm(job,{recursive:true,force:true}).catch(()=>{});}});conversations.extras.renderScene=renderScene;
 const handoff=new Handoff({file:path.join(dataRoot,'handoffs.json'),project,library,catalog,scenes,exporter,settings:()=>settings.get(),exportScene:exportSceneFiles});await handoff.init();
 const publicSettings=()=>({...settings.get(),styleVersions:settings.versions(),textureGeneration:!!images.apiKey,presets:presetList()});
 Object.assign(result,{browser,exporter,router,library,conversations,bridge,store,clients,catalog,assetRoot,dataRoot,broadcast,scenes,settings});
 /** Image-to-3D jobs for this project. The routes and their keys are shared by every project. */
 const generations=new Generations({generators,importModel:(name,bytes)=>importAsset(result,{name,folder:'Generated',data:Buffer.from(bytes).toString('base64')}),readImage:async id=>{const asset=library.require(id);if(!['reference','texture'].includes(asset.type)||asset.removed)throw Error('Choose a picture that is in the library.');return fs.readFile(library.file(asset));},broadcast,budget:()=>settings.get().triangleBudget||0,file:path.join(dataRoot,'generations.json')});await generations.init();conversations.extras.generations=generations;result.generations=generations;
 app.get('/api/generators',(req,res)=>res.json(generators.public()));
 app.post('/api/generators',(req,res)=>reply(res,async()=>{await generators.update(req.body);return shareGenerators();}));
 app.get('/api/sharing',(req,res)=>reply(res,()=>sharing.public()));
 app.post('/api/sharing',(req,res)=>reply(res,()=>sharing.update(req.body)));
 app.post('/api/sharing/discover',(req,res)=>reply(res,()=>sharing.discover()));
 app.post('/api/sharing/connect',(req,res)=>reply(res,async()=>{const result=await generators.pair({url:String(req.body.url||''),code:String(req.body.code||'')});return {...result,generators:shareGenerators()};}));
 app.post('/api/sharing/refresh',(req,res)=>reply(res,async()=>{await generators.refresh();return shareGenerators();}));
 app.post('/api/sharing/forget',(req,res)=>reply(res,async()=>{await generators.forget(String(req.body.id||''));return shareGenerators();}));
 /** One machine's models, here or on a paired computer, and the actions on them. "local" is this computer. */
 app.get('/api/machines/:id',(req,res)=>reply(res,()=>req.params.id==='local'?localModels.public():generators.manage(req.params.id,'list')));
 app.post('/api/machines/:id/:action',(req,res)=>reply(res,async()=>{if(!['install','cancel','remove'].includes(req.params.action))throw Error('Unknown action.');const body={id:String(req.body.id||''),accept:req.body.accept===true};if(req.params.id!=='local')return generators.manage(req.params.id,req.params.action,body);return req.params.action==='install'?localModels.install(body.id,{accept:body.accept}):req.params.action==='cancel'?localModels.cancelInstall():localModels.remove(body.id);}));
 app.post('/api/sharing/server',(req,res)=>reply(res,async()=>{const result=await generators.addServer(String(req.body.url||''));return {...result,generators:shareGenerators()};}));
 app.get('/api/local-models',(req,res)=>reply(res,()=>localModels.public()));
 app.post('/api/local-models/install',(req,res)=>reply(res,()=>localModels.install(String(req.body.id||''),{accept:req.body.accept===true})));
 app.post('/api/local-models/cancel',(req,res)=>reply(res,()=>localModels.cancelInstall()));
 app.post('/api/local-models/remove',(req,res)=>reply(res,()=>localModels.remove(String(req.body.id||''))));
 app.post('/api/local-models/start',(req,res)=>reply(res,async()=>{await localModels.start(String(req.body.id||''));return localModels.public();}));
 app.post('/api/local-models/stop',(req,res)=>reply(res,async()=>{await localModels.stop();return localModels.public();}));
 app.post('/api/generators/test',(req,res)=>reply(res,()=>generators.test(String(req.body.id||''))));
 app.get('/api/generations',(req,res)=>res.json(generations.list()));
 app.post('/api/generations',(req,res)=>reply(res,()=>generations.start(req.body)));
 app.post('/api/generations/:id/cancel',(req,res)=>reply(res,()=>generations.cancel(req.params.id)));
 app.post('/api/generations/:id/dismiss',(req,res)=>reply(res,()=>generations.dismiss(req.params.id)));
 app.get('/api/bootstrap',async(req,res)=>res.json({catalog:library.public(),token,connection:bridge.status(),libraryName:project.name,project,base:'/p/'+project.id,scenes:scenes.list(),batches:batches.list(),materials:materials.list(),settings:publicSettings(),generators:generators.public(),generations:generations.list(),localModels:await localModels.public(),sharing:await sharing.public(),workspace:await readJson(path.join(dataRoot,'workspace.json'),{})}));
app.get('/api/health',(req,res)=>res.json({ok:true,app:'metro-hustle-assets',connection:bridge.status()}));
app.get('/api/events',(req,res)=>{res.status(200).set({'Content-Type':'application/x-ndjson','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();clients.add(res);res.write(JSON.stringify({type:'catalog',catalog:library.public()})+'\n');res.write(JSON.stringify({type:'connection',connection:bridge.status()})+'\n');res.write(JSON.stringify({type:'scenes',scenes:scenes.list()})+'\n');res.write(JSON.stringify({type:'batches',batches:batches.list()})+'\n');res.write(JSON.stringify({type:'materials',materials:materials.list()})+'\n');for(const session of store.sessions.values())res.write(JSON.stringify({type:'conversation',conversation:store.public(session)})+'\n');const heartbeat=setInterval(()=>res.write('{"type":"heartbeat"}\n'),15000);req.on('close',()=>{clearInterval(heartbeat);clients.delete(res);});});
app.get('/api/conversations',(req,res)=>res.json(store.list().map(s=>store.public(s))));
app.post('/api/conversations/:id/messages',async(req,res)=>{try{res.status(202).json(await conversations.submit(req.params.id,req.body));}catch(error){res.status(error.status||400).json({error:error.message});}});
app.post('/api/conversations/:id/cancel',async(req,res)=>{try{await conversations.cancel(req.params.id);res.json({ok:true});}catch(error){res.status(500).json({error:conversations.friendly(error)});}});
app.post('/api/conversations/:id',async(req,res)=>{try{res.json(await conversations.update(req.params.id,req.body));}catch(error){res.status(error.status||400).json({error:error.message});}});
app.post('/api/reconnect',async(req,res)=>{try{await bridge.connect();res.json(bridge.status());}catch(error){res.status(503).json({error:conversations.friendly(error)});}});
app.get('/api/agent',async(req,res)=>res.json(await bridge.options()));
app.post('/api/agent',async(req,res)=>{try{res.json(await bridge.update(req.body));}catch(error){res.status(400).json({error:error.message});}});
app.get('/library/:id',(req,res)=>{const asset=catalog.get(req.params.id);if(!asset)return res.sendStatus(404);const filename=library.file(asset);if(req.query.download==='1')return res.download(filename,path.basename(filename),{dotfiles:'allow'});res.sendFile(path.basename(filename),{root:path.dirname(filename)});});
app.get('/previews/:id',(req,res)=>{const asset=catalog.get(req.params.id);if(!asset?.preview)return res.sendStatus(404);try{const version=library.version(asset,req.query.version);res.set('Cache-Control','no-store');res.sendFile(path.basename(version.preview),{root:path.dirname(version.preview)});}catch{res.sendStatus(404);}});
app.get('/versions/:id/:version/:format',(req,res)=>{try{const asset=library.require(req.params.id),version=library.version(asset,req.params.version);const format=req.params.format;if(!['fbx','blend'].includes(format)||format==='blend'&&!version.blend)return res.sendStatus(404);const filename=format==='blend'?version.blend:version.file;res.download(filename,asset.name+'.'+format,{dotfiles:'allow'});}catch{res.sendStatus(404);}});
app.post('/api/library/bulk',(req,res)=>reply(res,async()=>{const ids=[...new Set(Array.isArray(req.body.ids)?req.body.ids:[])].filter(id=>typeof id==='string'&&catalog.has(id)).slice(0,2000),action=String(req.body.action||'');if(!ids.length)throw Error('Select at least one asset.');if(action==='status')return {changed:await library.setReview(ids,String(req.body.status||'')),failed:[]};if(!['remove','restore','approve','reject'].includes(action))throw Error('Unknown action.');const changed=[],failed=[];for(const id of ids){try{if(action==='approve'){if(catalog.get(id).pendingVersion)await library.accept(id);await library.setReview([id],'approved');}else if(action==='reject'){if(catalog.get(id).pendingVersion)await library.discard(id);await library.setReview([id],'not-started');}else await library[action](id);changed.push(id);}catch(error){failed.push({id,name:catalog.get(id)?.name,error:String(error.message).slice(0,300)});}}return {changed,failed};}));
app.post('/api/library/:id/rename',(req,res)=>reply(res,()=>library.rename(req.params.id,req.body.name)));
app.post('/api/library/:id/share',(req,res)=>reply(res,()=>library.share(req.params.id)));
app.post('/api/library/:id/restore',async(req,res)=>{try{res.json(await library.restore(req.params.id));}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/library/:id/version',async(req,res)=>{try{res.json(await library.useVersion(req.params.id,req.body.versionId));}catch(e){res.status(400).json({error:e.message});}});
app.get('/captures/:name',captureHandler(dataRoot));
const reply=(res,work,status=400)=>Promise.resolve().then(work).then(data=>res.json(data)).catch(e=>res.status(status).json({error:String(e.message).slice(0,2000)}));
app.post('/api/library/:id/accept',(req,res)=>reply(res,()=>library.accept(req.params.id,{name:req.body.name})));
app.post('/api/library/:id/versions/:version',(req,res)=>reply(res,()=>library.renameVersion(req.params.id,req.params.version,req.body.label)));
app.post('/api/library/:id/discard',(req,res)=>reply(res,()=>library.discard(req.params.id)));
app.post('/api/library/:id/optimize',(req,res)=>reply(res,async()=>{const current=settings.get(),{image,report,...saved}=await library.edit(req.params.id,{...presetEdit(String(req.body.preset||''),{targetTriangles:req.body.targetTriangles||current.triangleBudget}),draft:current.reviewEdits});return saved;}));
app.get('/api/check/:id',(req,res)=>reply(res,async()=>{const {image,output,...report}=await library.inspect(req.params.id,{versionId:typeof req.query.version==='string'&&req.query.version?req.query.version:undefined});return {...report,budget:settings.get().triangleBudget||0};}));
app.post('/api/models',(req,res)=>reply(res,async()=>{const created=await createModel(result,{name:req.body.name});return {id:created.id};}));
app.post('/api/textures/:id/pbr',(req,res)=>reply(res,()=>executeEditTool(library,'texture_pbr',{textureId:req.params.id,strength:String(req.body.strength||'')},null,()=>{},conversations.extras)));
app.post('/api/scenes/:id/export',(req,res)=>reply(res,async()=>{const scene=scenes.get(req.params.id),format=['glb','fbx','blend'].includes(req.body.format)?req.body.format:'glb';if(!scene.items.some(i=>i.visible!==false))throw Error('Add a model to the scene before exporting it.');const stem=scene.name.replace(/[^a-zA-Z0-9 _-]/g,'_').trim().slice(0,80)||(scene.kind==='block'?'Block':'Scene');
 const files=await exportSceneFiles(scene,format);if(scene.kind==='block')files['block.json']=Buffer.from(JSON.stringify(blockManifest(scene,item=>catalog.get(item.assetId)?.name||null),null,2)); const directory=path.join(dataRoot,'scene-exports');await fs.mkdir(directory,{recursive:true});const name=randomUUID()+'.zip';await fs.writeFile(path.join(directory,name),zipSync(files,{level:1}));return {url:'/p/'+project.id+'/scene-exports/'+name+'?name='+encodeURIComponent(stem),files:Object.keys(files)};}));
app.get('/scene-exports/:name',(req,res)=>{if(!/^[a-f0-9-]{36}\.zip$/.test(req.params.name))return res.sendStatus(404);res.download(path.join(dataRoot,'scene-exports',req.params.name),String(req.query.name||'Scene').replace(/[^a-zA-Z0-9 _-]/g,'_').slice(0,80)+'.zip',{dotfiles:'allow'},error=>{if(error&&!res.headersSent)res.sendStatus(404);});});
app.get('/api/shared-materials',(req,res)=>res.json(materials.list()));
app.post('/api/shared-materials',(req,res)=>reply(res,()=>materials.create(req.body)));
app.post('/api/shared-materials/:id',(req,res)=>reply(res,()=>materials.update(req.params.id,req.body)));
app.post('/api/shared-materials/:id/delete',(req,res)=>reply(res,()=>materials.remove(req.params.id)));
app.get('/api/shared-materials/:id/users',(req,res)=>reply(res,()=>materials.users(req.params.id)));
app.post('/api/shared-materials/:id/apply',(req,res)=>reply(res,async()=>{const {image,compare,report,...saved}=await materials.apply(String(req.body.assetId||''),req.params.id,String(req.body.slot||''),{draft:!!settings.get().reviewEdits});broadcast({type:'materials',materials:materials.list()});return saved;}));
app.post('/api/shared-materials/:id/propagate',(req,res)=>reply(res,async()=>{const result=await materials.propagate(req.params.id,{assetIds:Array.isArray(req.body.assetIds)?req.body.assetIds:undefined});if(result.updated.length)await library.setReview(result.updated,'needs-review');broadcast({type:'materials',materials:materials.list()});return result;}));
app.get('/api/consistency',(req,res)=>res.json(consistency.report()));
app.post('/api/consistency/check',(req,res)=>reply(res,()=>consistency.start(req.body.assetIds)));
app.post('/api/consistency/cancel',(req,res)=>reply(res,()=>consistency.cancel()));
app.get('/api/consistency/:id',(req,res)=>reply(res,async()=>{const asset=library.require(req.params.id);return consistency.fresh(asset)||await consistency.check(asset.id);}));
app.get('/api/handoff',(req,res)=>reply(res,()=>handoff.plan()));
app.post('/api/handoff',(req,res)=>reply(res,()=>handoff.start(req.body)));
app.get('/api/batches',(req,res)=>res.json(batches.list()));
app.post('/api/batches',(req,res)=>reply(res,()=>batches.start(req.body)));
app.post('/api/batches/:id/cancel',(req,res)=>reply(res,()=>batches.cancel(req.params.id)));
app.post('/api/batches/:id/dismiss',(req,res)=>reply(res,()=>batches.dismiss(req.params.id)));
app.get('/api/settings',(req,res)=>res.json(publicSettings()));
app.post('/api/settings',(req,res)=>reply(res,async()=>{await settings.update(req.body);return shareSettings();}));
app.post('/api/style/restore',(req,res)=>reply(res,async()=>{await settings.restore(String(req.body.at||''));return shareSettings();}));
// A picture of the moodboard as the user arranged it, drawn by the viewer. Agents get it instead of separate images.
app.post('/api/style/snapshot',(req,res)=>reply(res,async()=>{const match=String(req.body.image||'').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);if(!match)throw Error('The moodboard picture must be a JPEG.');const bytes=Buffer.from(match[1],'base64');if(bytes.length>4*1024*1024||bytes[0]!==255||bytes[1]!==216)throw Error('The moodboard picture is too large or not a JPEG.');await fs.writeFile(boardPicture+'.tmp',bytes);await fs.rename(boardPicture+'.tmp',boardPicture);return {ok:true};}));
app.post('/api/conversations/:id/proposals/:proposal',(req,res)=>reply(res,()=>conversations.decide(req.params.id,req.params.proposal,String(req.body.action||''))));
app.get('/api/scenes',(req,res)=>res.json(scenes.list()));
app.post('/api/scenes',(req,res)=>reply(res,()=>scenes.create({name:req.body.name,kind:req.body.kind==='block'?'block':'scene'})));
app.post('/api/scenes/:id',(req,res)=>reply(res,()=>scenes.replace(req.params.id,req.body)));
app.post('/api/scenes/:id/delete',(req,res)=>reply(res,()=>scenes.remove(req.params.id)));
app.get('/06_Preview/',(req,res)=>res.redirect('/'));

app.post('/api/workspace',async(req,res)=>{await writeJson(path.join(dataRoot,'workspace.json'),req.body);res.json({ok:true});});
app.post('/api/save',async(req,res)=>{try{const file=await projects.snapshot(project,result);res.json({url:'/p/'+project.id+'/snapshots/'+file,projects:projects.public()});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/import',async(req,res)=>{try{res.json(await importAsset(result,req.body));}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/upload',async(req,res)=>{try{const parsed=validateMessage({text:'upload',requestId:randomBytes(16).toString('hex'),snapshot:req.body.image});if(!parsed.image)throw Error('Choose an image.');const name=randomUUID()+'.'+parsed.image.extension;await fs.writeFile(path.join(dataRoot,'captures',name),parsed.image.bytes);res.json({name,label:String(req.body.name||'Screenshot').slice(0,150)});}catch(e){res.status(400).json({error:e.message});}});
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
app.post('/api/projects/open-file',async(req,res)=>{try{const {loadProject}=await import('./project-format.mjs');const candidate=await loadProject(req.body.path);const old=await runtimes.get(candidate.id);if(old&&(old.assetRoot!==candidate.source||old.dataRoot!==candidate.data)&&(old.conversations.active.size||old.exporter.tasks.size))throw Error('Wait for this project’s running edits before reopening it from another folder.');const p=await projects.register(candidate.file);if(old&&(old.assetRoot!==p.source||old.dataRoot!==p.data)){await old.conversations.shutdown();for(const client of old.clients)client.end();old.bridge.close();runtimes.delete(p.id);}res.json({id:p.id,file:p.file});}catch(e){res.status(400).json({error:e.code==='ENOENT'?'Project file or required project folder not found.':e.message});}});
app.post('/api/projects/open',async(req,res,next)=>{try{const p=await projects.create('',Buffer.isBuffer(req.body)?req.body:Buffer.from(req.body.archive,'base64'));res.json({id:p.id});}catch(e){res.status(400).json({error:e.message});}});
app.get('/snapshots/:name',async(req,res)=>{if(!/^[a-f0-9-]{36}\.meshdesk\.zip$/.test(req.params.name))return res.sendStatus(404);for(const item of projects.items){try{const p=await projects.resolve(item.id),file=path.join(p.snapshots,req.params.name);await fs.access(file);return res.download(file,p.name+'.meshdesk.zip',{dotfiles:'allow'});}catch{}}res.sendStatus(404);});
app.use('/p/:project',async(req,res,next)=>{try{(await runtime(req.params.project)).router(req,res,next);}catch(e){res.status(400).json({error:e.message});}});
let vite;
if(development){const {createServer}=await import('vite');vite=await createServer({root:projectRoot,server:{middlewareMode:true},appType:'spa'});app.use(vite.middlewares);}
else{app.use(express.static(path.join(projectRoot,'dist')));app.get('/',(req,res)=>res.sendFile(path.join(projectRoot,'dist/index.html')));}
app.use((error,req,res,next)=>{if(res.headersSent)return next(error);res.status(error.status||500).json({error:error.type==='entity.too.large'?'Message or screenshot is too large.':'The local server could not process this request.'});});
const server=app.listen(port,'127.0.0.1',()=>{console.log(`Meshdesk\nhttp://127.0.0.1:${port}\nProjects: ${projects.projectsRoot}\nRegistry: ${dataRoot}/projects.json`);});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Open http://127.0.0.1:${port} or set PORT to another port.`:error.message);process.exit(1);});
let closing=false;async function shutdown(){if(closing)return;closing=true;for(const pending of runtimes.values()){const r=await pending;await r.conversations.shutdown();await r.exporter.shutdown();r.generations?.shutdown();for(const res of r.clients)res.end();r.bridge.close();await r.browser?.close();}localModels.shutdown();await sharing.shutdown();await vite?.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
