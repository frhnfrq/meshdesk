import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const MAP_ROLES={baseColor:'base_color',normal:'normal',roughness:'roughness'};
const unit=(value,fallback)=>{const n=Number(value);return Number.isFinite(n)?Math.min(1,Math.max(0,n)):fallback;};
const linear=hex=>[1,3,5].map(i=>{const c=parseInt(hex.slice(i,i+2),16)/255;return Math.round((c<=.04045?c/12.92:((c+.055)/1.055)**2.4)*10000)/10000;});
/** Blender script that puts a shared material on a model: on the slots that use `slot`, or on every slot when it is empty. */
export function materialScript(material,slot,maps){return `import bpy
NAME = ${JSON.stringify(material.name)}; SLOT = ${JSON.stringify(slot||'')}; MAPS = ${JSON.stringify(maps)}; TILING = ${Number(material.tiling)||0}
names = [m.name for m in bpy.data.materials if m.users]
if SLOT and SLOT not in names: raise ValueError('No material named %r on this model. Materials: %s' % (SLOT, ', '.join(names)))
old = bpy.data.materials.get(SLOT) if SLOT else None
mat = md.material(NAME, ${JSON.stringify(linear(material.color))}, ${material.roughness}, ${material.metallic})
bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
# Start from the library definition: drop whatever images an earlier revision connected.
for socket in ('Base Color', 'Roughness', 'Metallic', 'Normal'):
    for link in list(bsdf.inputs[socket].links):
        node = link.from_node; mat.node_tree.links.remove(link)
        if node.type == 'NORMAL_MAP':
            for inner in list(node.inputs['Color'].links):
                source = inner.from_node; mat.node_tree.links.remove(inner)
                if not any(o.links for o in source.outputs): mat.node_tree.nodes.remove(source)
        if node.type in ('TEX_IMAGE', 'NORMAL_MAP') and not any(o.links for o in node.outputs): mat.node_tree.nodes.remove(node)
for role, path in MAPS.items(): md.assign_texture(mat, path, role)
mat['meshdesk_shared'] = ${JSON.stringify(material.id)}
used = []; mixed = []
for o in md.meshes():
    for s in o.material_slots:
        if s.material and s.material != mat and (not SLOT or s.material == old): s.material = mat
    if any(s.material == mat for s in o.material_slots):
        used.append(o)
        if any(s.material and s.material != mat for s in o.material_slots): mixed.append(o.name)
if not used: raise ValueError('Nothing on this model uses %r.' % (SLOT or NAME))
if TILING > 0 and MAPS:
    whole = [o for o in used if o.name not in mixed]
    if whole: md.box_project(whole, TILING)
    if mixed: print('Kept the existing UVs on objects that mix materials:', ', '.join(mixed[:20]))
print('Applied shared material %r to %d objects.' % (NAME, len(used)))
`;}
/**
 * Shared materials are the project's named surfaces (one "Brick", one "Painted metal") that many models use,
 * so changing one can update all of them. Each model version records which shared materials it carries and at which revision.
 */
export class SharedMaterials{
 constructor({file,catalog,library,broadcast=()=>{}}){Object.assign(this,{file,catalog,library,broadcast});this.items=[];this.queue=Promise.resolve();}
 async init(){try{const saved=JSON.parse(await fs.readFile(this.file,'utf8'));this.items=(Array.isArray(saved)?saved:[]).filter(m=>/^[a-f0-9]{12}$/.test(m?.id)&&typeof m.name==='string');}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}}
 texture(id,role){if(!id)return '';const asset=this.catalog.get(String(id));if(!asset||asset.type!=='texture'||asset.removed)throw Error('The '+role+' map must be a texture from this library. Use library_list for IDs.');if(this.library?.isPrivateTexture?.(asset))throw Error('"'+asset.name+'" is embedded in one model. Add it to the library before using it in a shared material.');return asset.id;}
 clean(input={},previous={}){const name=String(input.name??previous.name??'').replace(/[\x00-\x1f"\\]/g,' ').trim().slice(0,60);if(!name)throw Error('Give the material a name.');if(this.items.some(m=>m.id!==previous.id&&m.name.toLowerCase()===name.toLowerCase()))throw Error('A shared material is already called "'+name+'".');const color=String(input.color??previous.color??'#b8b8b8').toLowerCase();if(!/^#[0-9a-f]{6}$/.test(color))throw Error('The colour must be a hex value such as #c8553d.');const maps={};for(const key of Object.keys(MAP_ROLES)){const id=this.texture(input.maps?.[key]??previous.maps?.[key]??'',key);if(id)maps[key]=id;}
  return {id:previous.id||randomBytes(6).toString('hex'),name,color,roughness:unit(input.roughness??previous.roughness,.75),metallic:unit(input.metallic??previous.metallic,0),maps,tiling:Math.min(100,Math.max(0,Number(input.tiling??previous.tiling)||0)),notes:String(input.notes??previous.notes??'').slice(0,1000)};}
 look(m){return JSON.stringify([m.name,m.color,m.roughness,m.metallic,m.maps,m.tiling]);}
 change(fn){const task=this.queue.then(async()=>{const result=await fn();await fs.writeFile(this.file+'.tmp',JSON.stringify(this.items,null,2));await fs.rename(this.file+'.tmp',this.file);this.broadcast({type:'materials',materials:this.list()});return result;});this.queue=task.catch(()=>{});return task;}
 get(id){const material=this.items.find(m=>m.id===id)||this.items.find(m=>m.name.toLowerCase()===String(id||'').toLowerCase());if(!material)throw Error('Shared material not found. Use material_list for IDs.');return material;}
 /** Models whose live (or proposed) version carries this material, and whether they are behind its latest revision. */
 users(id){const material=this.get(id),out=[];for(const asset of this.catalog.values()){if(asset.type!=='model'||asset.removed)continue;const version=asset.versions?.find(v=>v.id===(asset.pendingVersion||asset.currentVersion)),entry=version?.sharedMaterials?.find(s=>s.id===material.id);if(entry)out.push({assetId:asset.id,name:asset.name,revision:entry.revision,slot:entry.name,outdated:entry.revision<material.revision,pending:!!asset.pendingVersion});}return out;}
 public(material){const users=this.users(material.id);return {...material,users:users.length,outdated:users.filter(u=>u.outdated).length};}
 list(){return this.items.map(m=>this.public(m));}
 create(input){return this.change(()=>{if(this.items.length>=300)throw Error('This project already has 300 shared materials.');const material={...this.clean(input),revision:1,updatedAt:new Date().toISOString()};this.items.push(material);return this.public(material);});}
 /** A change to how the material looks raises its revision, which marks the models using it as out of date. */
 update(id,input){return this.change(()=>{const index=this.items.findIndex(m=>m.id===id);if(index<0)throw Error('Shared material not found.');const previous=this.items[index],next=this.clean(input,previous);this.items[index]={...next,revision:previous.revision+(this.look(next)===this.look(previous)?0:1),updatedAt:new Date().toISOString()};return this.public(this.items[index]);});}
 remove(id){return this.change(()=>{const material=this.get(id);this.items=this.items.filter(m=>m!==material);return {id:material.id,removed:true};});}
 /** Puts the material on a model as a new version (a proposal when draft). slot is the model's material to replace, or "" for all of them. */
 async apply(assetId,materialId,slot='',{draft=true,conversationId,label}={},signal,onProgress){const material=this.get(materialId),maps=Object.fromEntries(Object.entries(material.maps).map(([key,id])=>[MAP_ROLES[key],this.library.file(this.library.require(id))]));
  return this.library.edit(assetId,{script:materialScript(material,slot,maps),label:label||'Shared material: '+material.name+(slot&&slot!==material.name?' on '+slot:''),draft,conversationId,shared:[{id:material.id,revision:material.revision,name:material.name}]},signal,onProgress);}
 /** Brings the models that use an older revision up to date, each as its own proposal. Returns what was updated and what failed. */
 async propagate(id,{assetIds,limit=200}={}){const material=this.get(id),wanted=assetIds?new Set(assetIds):null,targets=this.users(material.id).filter(u=>u.outdated&&(!wanted||wanted.has(u.assetId))).slice(0,limit),updated=[],failed=[];for(const user of targets){try{await this.apply(user.assetId,material.id,user.slot,{draft:true,label:'Update shared material: '+material.name});updated.push(user.assetId);}catch(error){failed.push({assetId:user.assetId,name:user.name,error:String(error.message).split('\n').slice(0,3).join(' ').slice(0,300)});}}return {updated,failed,remaining:this.users(material.id).filter(u=>u.outdated).length};}
}
