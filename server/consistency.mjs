import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
/** Runs inside Blender on a throwaway copy: the colours each material really shows, texture sizes and texel density per mesh. */
export const CONSISTENCY_SCRIPT=String.raw`import bpy, json, math
import numpy as np
def to_srgb(v): return [int(round(max(0.0, min(1.0, x * 12.92 if x <= .0031308 else 1.055 * x ** (1 / 2.4) - .055)) * 255)) for x in list(v)[:3]]
def image_colours(image):
    w, h = image.size
    if not w or not h: return []
    px = np.empty(w * h * image.channels, np.float32); image.pixels.foreach_get(px); px = px.reshape(h, w, image.channels)
    step = max(1, int(max(w, h) / 96)); sample = np.clip(px[::step, ::step, :3].reshape(-1, 3), 0, 1)
    if image.is_float or image.colorspace_settings.name != 'sRGB': sample = np.where(sample <= .0031308, sample * 12.92, 1.055 * np.power(sample, 1 / 2.4) - .055)
    q = (sample * 255).astype(np.int32) >> 5; keys = q[:, 0] * 64 + q[:, 1] * 8 + q[:, 2]
    values, counts = np.unique(keys, return_counts=True); out = []
    for i in np.argsort(-counts)[:6]:
        out.append({'rgb': [int(round(x)) for x in sample[keys == values[i]].mean(axis=0) * 255], 'share': round(float(counts[i] / counts.sum()), 3)})
    return out
def base_image(mat):
    if not mat or not mat.node_tree: return None
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    links = bsdf.inputs['Base Color'].links if bsdf else []
    return links[0].from_node.image if links and links[0].from_node.type == 'TEX_IMAGE' else None
materials = []
for mat in bpy.data.materials:
    if not mat.users or not mat.node_tree: continue
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not bsdf: continue
    image = base_image(mat); entry = {'name': mat.name, 'shared': mat.get('meshdesk_shared') or None}
    if image and image.size[0]: entry['texture'] = image.name; entry['colours'] = image_colours(image)
    else: entry['colours'] = [{'rgb': to_srgb(bsdf.inputs['Base Color'].default_value), 'share': 1}]
    sizes = [max(n.image.size) for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image]
    entry['largestTexture'] = max(sizes) if sizes else 0
    materials.append(entry)
meshes = []
for o in bpy.context.scene.objects:
    if o.type != 'MESH' or not o.data.polygons or not o.data.uv_layers.active: continue
    me = o.data; uv = me.uv_layers.active.data; s = o.matrix_world.to_scale(); factor = (abs(s.x * s.y) + abs(s.y * s.z) + abs(s.x * s.z)) / 3
    sizes = {i: tuple(base_image(slot.material).size) for i, slot in enumerate(o.material_slots) if base_image(slot.material) and base_image(slot.material).size[0]}
    if not sizes: continue
    density = []; weight = []
    for poly in list(me.polygons)[:30000]:
        size = sizes.get(poly.material_index)
        if not size: continue
        pts = [uv[li].uv for li in poly.loop_indices]; area2 = abs(sum(pts[i].x * pts[(i + 1) % len(pts)].y - pts[(i + 1) % len(pts)].x * pts[i].y for i in range(len(pts)))) / 2; area3 = poly.area * factor
        if area3 < 1e-8 or area2 < 1e-12: continue
        density.append(math.sqrt(area2 * size[0] * size[1] / area3)); weight.append(area3)
    if not density: continue
    order = np.argsort(density); cumulative = np.cumsum(np.array(weight)[order]); median = float(np.array(density)[order][int(np.searchsorted(cumulative, cumulative[-1] / 2))])
    meshes.append({'name': o.name, 'texelDensity': round(median, 1)})
print('MESHDESK_CONSISTENCY:' + json.dumps({'materials': materials, 'meshes': meshes}))
`;
const lab=([r,g,b])=>{const f=v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;},[R,G,B]=[f(r),f(g),f(b)],x=(R*.4124+G*.3576+B*.1805)/.95047,y=R*.2126+G*.7152+B*.0722,z=(R*.0193+G*.1192+B*.9505)/1.08883,t=v=>v>.008856?Math.cbrt(v):7.787*v+16/116;return [116*t(y)-16,500*(t(x)-t(y)),200*(t(y)-t(z))];};
const rgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
const hex=c=>'#'+c.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
/** How far apart two colours look (CIE76). Under about 10 reads as the same colour; over 25 is clearly a different one. */
export function colourDistance(a,b){const [l1,a1,b1]=lab(a),[l2,a2,b2]=lab(b);return Math.hypot(l1-l2,a1-a2,b1-b2);}
export const OFF_PALETTE=25;
/** Turns what Blender measured into findings against the style guide. Each finding says what is wrong and how to fix it. */
export function evaluate(measured,{settings={},stats={},sharedCount=0}={}){const style=settings.style||{},issues=[],palette=(style.palette||[]).map(c=>({...c,rgb:rgb(c.color)}));
 if(settings.triangleBudget&&stats.triangles>settings.triangleBudget)issues.push({level:'error',code:'triangle-budget',message:stats.triangles.toLocaleString()+' triangles is over the '+settings.triangleBudget.toLocaleString()+' budget.',fix:'Reduce this model to at most '+settings.triangleBudget.toLocaleString()+' triangles without changing its silhouette.'});
 for(const material of measured.materials||[]){
  if(settings.maxTextureSize&&material.largestTexture>settings.maxTextureSize)issues.push({level:'error',code:'texture-size',material:material.name,message:'"'+material.name+'" uses a '+material.largestTexture+' px texture; the largest allowed is '+settings.maxTextureSize+' px.',fix:'Resize the textures of the material "'+material.name+'" to '+settings.maxTextureSize+' px or smaller.'});
  if(palette.length&&material.colours?.length){let off=0,worst=null;for(const colour of material.colours){const nearest=palette.map(p=>({p,d:colourDistance(colour.rgb,p.rgb)})).sort((x,y)=>x.d-y.d)[0];if(nearest.d>OFF_PALETTE){off+=colour.share;if(!worst||colour.share>worst.share)worst={...colour,nearest:nearest.p};}}const total=material.colours.reduce((sum,c)=>sum+c.share,0)||1,share=off/total;
   if(share>.4)issues.push({level:'warn',code:'off-palette',material:material.name,colour:hex(worst.rgb),nearest:worst.nearest.color,message:'"'+material.name+'" is '+Math.round(share*100)+'% off-palette (mostly '+hex(worst.rgb)+'; nearest palette colour is '+(worst.nearest.name?worst.nearest.name+' ':'')+worst.nearest.color+').',fix:'Recolour the material "'+material.name+'" so it uses the style guide palette (nearest: '+(worst.nearest.name?worst.nearest.name+' ':'')+worst.nearest.color+').'});}}
 if(style.texelDensity){const off=(measured.meshes||[]).filter(m=>m.texelDensity<style.texelDensity/2||m.texelDensity>style.texelDensity*2);for(const mesh of off.slice(0,8))issues.push({level:'warn',code:'texel-density',mesh:mesh.name,message:'"'+mesh.name+'" has about '+Math.round(mesh.texelDensity)+' px per metre; the style guide asks for '+style.texelDensity+'.',fix:'Rescale the UVs of "'+mesh.name+'" so its texel density is about '+style.texelDensity+' pixels per metre.'});if(off.length>8)issues.push({level:'warn',code:'texel-density',message:(off.length-8)+' more meshes are off the target texel density.',fix:'Bring every mesh to about '+style.texelDensity+' pixels per metre.'});}
 if(sharedCount){const own=(measured.materials||[]).filter(m=>!m.shared);if(own.length)issues.push({level:'info',code:'not-shared',message:own.length+' of '+measured.materials.length+' materials are not from the shared library: '+own.slice(0,6).map(m=>m.name).join(', ')+(own.length>6?'…':'')+'.',fix:'Replace these one-off materials with matching shared materials where one fits (use material_list and material_apply): '+own.slice(0,12).map(m=>m.name).join(', ')+'.'});}
 return issues;}
/**
 * Checks models against the style guide and remembers the result for each model version, so the project-wide
 * report is instant and only models that changed (or a changed style guide) need Blender again.
 */
export class Consistency{
 constructor({file,library,catalog,settings,materials,broadcast=()=>{}}){Object.assign(this,{file,library,catalog,settings,materials,broadcast});this.cache={};this.job=null;}
 async init(){try{this.cache=JSON.parse(await fs.readFile(this.file,'utf8'))||{};}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}}
 rules(){const s=this.settings()||{};return {settings:s,key:createHash('sha256').update(JSON.stringify([(s.style?.palette||[]).map(c=>c.color),s.style?.texelDensity||0,s.triangleBudget,s.maxTextureSize,(this.materials?.items||[]).length>0])).digest('hex').slice(0,16)};}
 fresh(asset,key=this.rules().key){const hit=this.cache[asset.id];return hit&&hit.versionId===(asset.currentVersion||'original')&&hit.rules===key?hit:null;}
 async save(){await fs.writeFile(this.file+'.tmp',JSON.stringify(this.cache));await fs.rename(this.file+'.tmp',this.file);}
 /** Measures one model's live version in Blender and judges it. */
 async check(assetId,signal){const asset=this.library.require(assetId);if(asset.type!=='model')throw Error('Choose a model to check.');const {settings,key}=this.rules(),versionId=asset.currentVersion||'original',result=await this.library.inspect(assetId,{script:CONSISTENCY_SCRIPT,versionId},signal),line=String(result.output||'').split('\n').find(l=>l.startsWith('MESHDESK_CONSISTENCY:'));if(!line)throw Error('The consistency check produced no measurements.');const measured=JSON.parse(line.slice(21)),issues=evaluate(measured,{settings,stats:result.stats,sharedCount:this.materials?.items.length||0});
  const entry={assetId,versionId,rules:key,checkedAt:new Date().toISOString(),triangles:result.stats?.triangles,materials:measured.materials.map(m=>({name:m.name,shared:m.shared,colours:m.colours.slice(0,3).map(c=>hex(c.rgb)),largestTexture:m.largestTexture})),issues};this.cache[assetId]=entry;await this.save();return entry;}
 /** Project-wide picture from what is already known. Models never checked, or changed since, are listed as unchecked. */
 report(){const {key,settings}=this.rules(),models=[...this.catalog.values()].filter(a=>a.type==='model'&&!a.removed),rows=models.map(asset=>{const hit=this.fresh(asset,key);return {assetId:asset.id,name:asset.name,review:asset.review||'not-started',checked:!!hit,checkedAt:hit?.checkedAt,issues:hit?.issues||[],errors:hit?hit.issues.filter(i=>i.level==='error').length:0,warnings:hit?hit.issues.filter(i=>i.level==='warn').length:0};}),counts={};for(const row of rows)for(const issue of row.issues)counts[issue.code]=(counts[issue.code]||0)+1;
  return {styleSet:!!(settings.style&&(settings.style.palette?.length||settings.style.texelDensity))||!!settings.triangleBudget,total:models.length,checked:rows.filter(r=>r.checked).length,clean:rows.filter(r=>r.checked&&!r.errors&&!r.warnings).length,counts,rows:rows.sort((a,b)=>b.errors-a.errors||b.warnings-a.warnings||a.name.localeCompare(b.name)),job:this.job&&{total:this.job.total,done:this.job.done,failed:this.job.failed,current:this.job.current}};}
 /** Checks several models one after another in the background, reporting progress as it goes. */
 start(assetIds){if(this.job)throw Error('A consistency check is already running.');const ids=[...new Set(assetIds||[])].filter(id=>this.catalog.get(id)?.type==='model'&&!this.catalog.get(id).removed);if(!ids.length)throw Error('Choose at least one model to check.');const controller=new AbortController(),job=this.job={total:ids.length,done:0,failed:0,current:'',controller};
  job.promise=(async()=>{for(const id of ids){if(controller.signal.aborted)break;job.current=this.catalog.get(id)?.name||'';this.broadcast({type:'consistency',report:this.report()});try{await this.check(id,controller.signal);}catch{job.failed++;}job.done++;}this.job=null;this.broadcast({type:'consistency',report:this.report()});})();return this.report();}
 cancel(){this.job?.controller.abort();return this.report();}
}
