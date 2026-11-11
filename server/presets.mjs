/** Ready-made Blender scripts for common optimisation steps. Each one runs as a normal edit and becomes a version. */
const HEADER=`import bpy, bmesh
from mathutils import Vector
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
def tris(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
def apply_modifier(o, modifier):
    if o.data.users > 1: o.data = o.data.copy()
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]): bpy.ops.object.modifier_apply(modifier=modifier.name)
total = sum(tris(o) for o in meshes)
`;
const decimate=ratio=>`${HEADER}ratio = ${ratio}
for o in meshes:
    if tris(o) < 32 or o.data.shape_keys: continue
    modifier = o.modifiers.new('MeshdeskDecimate', 'DECIMATE'); modifier.ratio = max(0.02, min(1, ratio))
    try: apply_modifier(o, modifier)
    except Exception as error:
        o.modifiers.remove(modifier); print('Skipped', o.name, error)
print('Triangles', total, '->', sum(tris(o) for o in meshes))
`;
export const PRESETS={
 cleanup:{label:'Clean up geometry',detail:'Merge duplicate vertices, delete loose and zero-area geometry, fix normals',script:()=>`${HEADER}for o in meshes:
    bm = bmesh.new(); bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0001)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-10], context='FACES')
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context='EDGES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_edges], context='VERTS')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data); bm.free(); o.data.update()
print('Vertices now', sum(len(o.data.vertices) for o in meshes))
`},
 decimate_75:{label:'Reduce to 75% triangles',detail:'Light reduction, barely visible',script:()=>decimate(.75)},
 decimate_50:{label:'Reduce to 50% triangles',detail:'Good for mid-distance props',script:()=>decimate(.5)},
 decimate_25:{label:'Reduce to 25% triangles',detail:'Background and mobile',script:()=>decimate(.25)},
 target:{label:'Reduce to a triangle target',detail:'Uses the project triangle budget',script:({targetTriangles})=>{const target=Math.round(Number(targetTriangles));if(!(target>=12&&target<=20000000))throw Error('Set a triangle target (or a project triangle budget) between 12 and 20,000,000.');return decimate(`min(1, ${target} / max(total, 1))`);},label_:({targetTriangles})=>'Reduce to '+Math.round(Number(targetTriangles)).toLocaleString('en-US')+' triangles'},
 apply_transforms:{label:'Apply scale and rotation',detail:'Bake object transforms into the mesh',script:()=>`${HEADER}for o in meshes:
    if o.parent and o.parent.type == 'ARMATURE': continue
    if o.data.users > 1: o.data = o.data.copy()
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]): bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
`},
 ground:{label:'Sit on the ground at the origin',detail:'Centre the model and put its base at height zero',script:()=>`${HEADER}points = [o.matrix_world @ Vector(p) for o in meshes for p in o.bound_box]
low = [min(p[i] for p in points) for i in range(3)]; high = [max(p[i] for p in points) for i in range(3)]
offset = Vector((-(low[0] + high[0]) / 2, -(low[1] + high[1]) / 2, -low[2]))
for o in bpy.context.scene.objects:
    if o.parent is None: o.matrix_world.translation += offset
`}
};
export function presetEdit(preset,options={}){const entry=PRESETS[preset];if(!entry)throw Error('Unknown preset. Use one of: '+Object.keys(PRESETS).join(', ')+'.');return {script:entry.script(options),label:entry.label_?.(options)||entry.label};}
export const presetList=()=>Object.entries(PRESETS).map(([id,{label,detail}])=>({id,label,detail}));
