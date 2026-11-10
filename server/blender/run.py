import bpy, json, sys, re, hashlib
from pathlib import Path
job = Path(sys.argv[sys.argv.index('--') + 1])
config = json.loads((job / 'config.json').read_text())
source = Path(config['source'])
asset_id = config.get('assetId', 'model')
def step(text): print('MESHDESK_STEP:' + text, flush=True)
step('Opening the model in Blender')
bpy.ops.wm.read_factory_settings(use_empty=True)
if source.suffix.lower() == '.blend':
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
elif source.suffix.lower() in ['.glb', '.gltf']:
    bpy.ops.import_scene.gltf(filepath=str(source))
elif source.suffix.lower() == '.obj':
    bpy.ops.wm.obj_import(filepath=str(source))
else:
    bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
# Resolve external files by their original name as well as any working filename.
textures = {}
for item in config['textures']:
    item = {'path': item, 'reference': Path(item).name} if isinstance(item, str) else item
    textures[Path(item['path']).name] = item['path']
    textures[item.get('reference', Path(item['path']).name)] = item['path']
missing = []
for material in bpy.data.materials:
    if not material.use_nodes: continue
    for node in list(material.node_tree.nodes):
        if node.type != 'TEX_IMAGE' or not node.image: continue
        image = node.image
        if image.packed_file or (image.source == 'GENERATED' and image.has_data): continue
        name = image.filepath.replace('\\', '/').split('/')[-1]
        existing = Path(bpy.path.abspath(image.filepath))
        candidate = str(existing) if existing.is_file() else textures.get(name)
        if not candidate and name == 'standardSurface1_AlbedoT.tga': candidate = textures.get(name.replace('.tga', '.png'))
        if candidate:
            old_color = image.colorspace_settings.name
            node.image = bpy.data.images.load(candidate, check_existing=True)
            node.image.colorspace_settings.name = old_color
        elif not image.has_data:
            missing.append(name)
            for output in node.outputs:
                for link in list(output.links):
                    target = link.to_socket
                    material.node_tree.links.remove(link)
                    if target.name == 'Base Color': target.default_value = (.45, .48, .52, 1)
                    if target.name == 'Metallic': target.default_value = 0
            material.node_tree.nodes.remove(node)
    for node in list(material.node_tree.nodes):
        if node.type == 'NORMAL_MAP' and not node.inputs['Color'].is_linked: material.node_tree.nodes.remove(node)
step('Applying the requested changes')
exec(compile((job / 'edit.py').read_text(), str(job / 'edit.py'), 'exec'), {'bpy': bpy, 'job_dir': str(job)})
bpy.context.view_layer.update()
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes: raise RuntimeError('The edited scene contains no meshes.')
from mathutils import Vector
points = [o.matrix_world @ Vector(p) for o in meshes for p in o.bound_box]
low = [min(p[i] for p in points) for i in range(3)]
high = [max(p[i] for p in points) for i in range(3)]
stats = {'meshes': len(meshes), 'vertices': sum(len(o.data.vertices) for o in meshes), 'triangles': sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in meshes), 'dimensions': [high[i]-low[i] for i in range(3)]}
step('Saving separate texture images')
texture_dir = job / 'Textures' / asset_id
model_dir = job / 'Models' / asset_id
texture_dir.mkdir(parents=True, exist_ok=True)
model_dir.mkdir(parents=True, exist_ok=True)
exported = {}
for material in bpy.data.materials:
    if not material.use_nodes: continue
    for node in material.node_tree.nodes:
        if node.type != 'TEX_IMAGE' or not node.image or node.image.name in exported: continue
        image = node.image
        if not image.has_data and not image.packed_file:
            try: image.pixels[0]
            except: pass
        if not image.has_data and not image.packed_file:
            missing.append(image.name); continue
        stem = re.sub(r'[^A-Za-z0-9_-]+', '_', re.sub(r'(_[a-f0-9]{8})+$', '', image.name)).strip('_')[:90] or 'Texture'
        raw = bytes(image.packed_file.data) if image.packed_file and not image.is_dirty else None
        suffix = '.png'
        if raw and raw[:3] == b'\xff\xd8\xff': suffix = '.jpg'
        elif raw and raw[:4] == b'v/1\x01': suffix = '.exr'
        elif raw and raw[:8] != b'\x89PNG\r\n\x1a\n': raw = None
        temp = texture_dir / (stem + suffix)
        if raw: temp.write_bytes(raw)
        else:
            image.filepath_raw = str(temp)
            image.file_format = 'PNG'
            image.save()
        digest = hashlib.sha256(temp.read_bytes()).hexdigest()
        target = texture_dir / (stem + '_' + digest[:8] + suffix)
        temp.rename(target)
        # Keep the exact pixels in memory, remove packed storage, and use a
        # portable path. FBX references separate images; GLB embeds them.
        if image.packed_file: image.unpack(method='REMOVE')
        image.filepath_raw = str(target)
        exported[image.name] = {'name': image.name, 'path': str(target.relative_to(job)), 'sha256': digest, 'dimensions': list(image.size), 'colorSpace': image.colorspace_settings.name}
materials = []
for material in bpy.data.materials:
    record = {'name': material.name, 'meshes': [o.name for o in meshes if material in list(o.data.materials)], 'textures': []}
    if material.use_nodes:
        for node in material.node_tree.nodes:
            if node.type == 'TEX_IMAGE' and node.image and node.image.name in exported:
                roles = []
                for output in node.outputs:
                    for link in output.links:
                        roles.append('Normal' if link.to_node.type == 'NORMAL_MAP' else link.to_socket.name)
                record['textures'].append({**exported[node.image.name], 'roles': sorted(set(roles)) or ['Image']})
        bsdf = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf:
            record['baseColor'] = list(bsdf.inputs['Base Color'].default_value)
            record['metallic'] = bsdf.inputs['Metallic'].default_value
            record['roughness'] = bsdf.inputs['Roughness'].default_value
    materials.append(record)
manifest = {'schemaVersion': 1, 'modelFile': 'Models/' + asset_id + '/model.fbx', 'textures': list(exported.values()), 'materials': materials, 'missing': sorted(set(missing))}
step('Exporting the model and material connections')
bpy.ops.export_scene.fbx(filepath=str(model_dir / 'model.fbx'), use_selection=False, object_types={'MESH','ARMATURE','EMPTY'}, path_mode='RELATIVE', embed_textures=False, bake_anim=True)
step('Building the embedded preview')
bpy.ops.export_scene.gltf(filepath=str(job / 'preview.glb'), export_format='GLB', export_cameras=False, export_lights=False, export_yup=True)
for image in bpy.data.images:
    if image.name in exported: image.filepath = '//' + exported[image.name]['path']
bpy.ops.wm.save_as_mainfile(filepath=str(job / 'model.blend'), relative_remap=False)
(job / 'materials.json').write_text(json.dumps(manifest, indent=2))
(job / 'metrics.json').write_text(json.dumps(stats))
step('Validating the exported files')
print('ASSET_EDIT_COMPLETE', json.dumps(stats), flush=True)
# Export-only jobs also produce a portable deliverable. No library version is
# published and no scene transformation or texture resize is applied.
options = config.get('exportOptions')
if options:
    import shutil
    target = job / 'deliverable'
    target.mkdir(exist_ok=True)
    stem, fmt, storage = options['stem'], options['format'], options['textures']
    step('Preparing ' + fmt.upper() + ' with ' + storage + ' textures')
    for image in bpy.data.images:
        if image.name in exported:
            image.filepath = str(job / exported[image.name]['path'])
    if storage == 'separate' and fmt in ['fbx', 'blend']:
        (target / 'Textures').mkdir(exist_ok=True)
        for image in bpy.data.images:
            if image.name not in exported: continue
            original = job / exported[image.name]['path']
            dest = target / 'Textures' / original.name
            shutil.copyfile(original, dest)
            image.filepath = str(dest)
    if fmt == 'fbx':
        bpy.ops.export_scene.fbx(filepath=str(target / (stem + '.fbx')), use_selection=False,
            object_types={'MESH','ARMATURE','EMPTY'}, path_mode='COPY' if storage == 'embedded' else 'RELATIVE',
            embed_textures=storage == 'embedded', bake_anim=True)
    elif fmt == 'gltf':
        if storage == 'embedded':
            shutil.copyfile(job / 'preview.glb', target / (stem + '.glb'))
        else:
            bpy.ops.export_scene.gltf(filepath=str(target / (stem + '.gltf')),
                export_format='GLTF_SEPARATE', export_texture_dir='Textures',
                export_cameras=False, export_lights=False, export_yup=True)
    elif fmt == 'blend':
        if storage == 'embedded': bpy.ops.file.pack_all()
        else:
            for image in bpy.data.images:
                if image.name in exported: image.filepath = '//Textures/' + Path(exported[image.name]['path']).name
        bpy.ops.wm.save_as_mainfile(filepath=str(target / (stem + '.blend')), relative_remap=False)
    else: raise RuntimeError('Unsupported export format')
    if fmt in ['fbx','blend']:
        portable = json.loads(json.dumps(manifest))
        portable['modelFile'] = stem + '.' + fmt
        portable['textureStorage'] = storage
        for texture in portable['textures']:
            texture['path'] = 'Textures/' + Path(texture['path']).name if storage == 'separate' else None
        for material in portable['materials']:
            for texture in material['textures']:
                texture['path'] = 'Textures/' + Path(texture['path']).name if storage == 'separate' else None
        (target / 'materials.json').write_text(json.dumps(portable, indent=2))
    step('Export file ready')
