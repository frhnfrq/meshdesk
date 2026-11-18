import bpy, json, sys, re, hashlib, io, traceback, contextlib
from mathutils import Vector
from pathlib import Path
job = Path(sys.argv[sys.argv.index('--') + 1])
config = json.loads((job / 'config.json').read_text())
source = Path(config['source']) if config.get('source') else None
asset_id = config.get('assetId', 'model')
def step(text): print('MESHDESK_STEP:' + text, flush=True)
mode = config.get('mode', 'edit')
settings = config.get('settings') or {}

def scene_meshes(): return [o for o in bpy.context.scene.objects if o.type == 'MESH']
def tri_count(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
def bounds(meshes):
    points = [o.matrix_world @ Vector(p) for o in meshes for p in o.bound_box]
    return [min(p[i] for p in points) for i in range(3)], [max(p[i] for p in points) for i in range(3)]
def scene_stats():
    meshes = scene_meshes()
    if not meshes: return {'meshes': 0, 'vertices': 0, 'triangles': 0, 'dimensions': [0, 0, 0], 'materials': 0}
    low, high = bounds(meshes)
    return {'meshes': len(meshes), 'vertices': sum(len(o.data.vertices) for o in meshes), 'triangles': sum(tri_count(o) for o in meshes),
            'dimensions': [high[i] - low[i] for i in range(3)], 'materials': len({m.name for o in meshes for m in o.data.materials if m})}
def mesh_table():
    return [{'name': o.name, 'vertices': len(o.data.vertices), 'triangles': tri_count(o), 'materials': [m.name for m in o.data.materials if m], 'uvLayers': len(o.data.uv_layers)} for o in scene_meshes()[:200]]

def readiness(missing_textures=()):
    """Game-readiness findings. Each has a level (error, warn, info), a plain message and, where useful, a request the agent can act on."""
    import bmesh
    issues = []
    def add(level, code, message, mesh=None, fix=None):
        issues.append({k: v for k, v in {'level': level, 'code': code, 'message': message, 'mesh': mesh, 'fix': fix}.items() if v})
    meshes = scene_meshes()
    if not meshes:
        add('error', 'empty', 'The scene has no meshes.'); return issues
    stats = scene_stats(); budget = settings.get('triangleBudget')
    if budget and stats['triangles'] > budget:
        add('warn', 'triangle-budget', f"{stats['triangles']:,} triangles is over the project budget of {int(budget):,}.", fix=f'Reduce the model to at most {int(budget)} triangles while keeping its silhouette.')
    for o in meshes:
        me = o.data
        if not me.polygons:
            add('warn', 'no-faces', 'This mesh has no faces.', o.name, 'Remove meshes that have no faces.'); continue
        if not me.uv_layers: add('error', 'no-uv', 'No UV map, so image textures cannot be applied.', o.name, 'Unwrap this mesh with sensible seams.')
        ngons = sum(1 for p in me.polygons if len(p.vertices) > 4)
        if ngons: add('info', 'ngons', f'{ngons} faces have more than four sides; game engines triangulate these unpredictably.', o.name, 'Triangulate the n-gons cleanly.')
        bm = bmesh.new(); bm.from_mesh(me)
        multi = sum(1 for e in bm.edges if len(e.link_faces) > 2)
        loose = sum(1 for v in bm.verts if not v.link_edges) + sum(1 for e in bm.edges if not e.link_faces)
        flat = sum(1 for f in bm.faces if f.calc_area() < 1e-10)
        bm.free()
        if multi: add('warn', 'non-manifold', f'{multi} edges are shared by more than two faces.', o.name, 'Fix the non-manifold edges.')
        if loose: add('warn', 'loose', f'{loose} loose vertices or edges are not part of any face.', o.name, 'Delete loose vertices and edges.')
        if flat: add('warn', 'zero-area', f'{flat} faces have no area.', o.name, 'Remove degenerate faces.')
        if any(v < 0 for v in o.scale): add('error', 'negative-scale', 'Negative scale flips normals in game engines.', o.name, 'Apply the scale and fix the normals.')
        elif any(abs(v - 1) > 1e-4 for v in o.scale): add('info' if max(o.scale) - min(o.scale) < 1e-6 else 'warn', 'unapplied-scale', 'Scale is not applied (' + ', '.join(f'{v:.3g}' for v in o.scale) + ').', o.name, 'Apply the scale.')
        if not [m for m in me.materials if m]: add('warn', 'no-material', 'No material assigned.', o.name, 'Assign a material.')
        elif len(me.materials) > 4: add('info', 'many-materials', f'{len(me.materials)} material slots; each one is a separate draw call.', o.name, 'Reduce the number of materials on this mesh.')
    low, high = bounds(meshes); size = [high[i] - low[i] for i in range(3)]; biggest = max(size)
    if biggest > 200 or biggest < 0.01: add('warn', 'scale', f'The model is {biggest:.3g} m across, which suggests a unit mismatch.', fix='Rescale the model to real-world size in metres and apply the scale.')
    if size[2] > 0 and abs(low[2]) > max(0.02, size[2] * 0.05): add('info', 'pivot', f'The lowest point is at {low[2]:.2f} m, so the model does not sit on the ground at the origin.', fix='Move the model so its base sits on the ground at the origin.')
    limit = settings.get('maxTextureSize') or 4096
    for image in bpy.data.images:
        if image.type != 'IMAGE' or not image.size[0]: continue
        w, h = image.size
        if w & (w - 1) or h & (h - 1): add('warn', 'texture-npot', f'{image.name} is {w}×{h}, not a power of two.', fix=f'Resize the texture {image.name} to a power-of-two size.')
        if max(w, h) > limit: add('warn', 'texture-large', f'{image.name} is {w}×{h}, larger than {limit} px.', fix=f'Downscale the texture {image.name} to {limit} px.')
    for name in sorted(set(missing_textures)): add('error', 'missing-texture', f'Texture file not found: {name}')
    vague = [o.name for o in meshes if re.search(r'\.\d{3}$', o.name) or re.match(r'^(Cube|Sphere|Cylinder|Plane|Mesh|Object)\b', o.name)]
    if vague: add('info', 'naming', 'Default-style mesh names: ' + ', '.join(vague[:6]) + ('…' if len(vague) > 6 else ''), fix='Give the meshes clear, descriptive names.')
    return issues

VIEWS = {'perspective': (40, 28), 'front': (0, 0), 'back': (180, 0), 'side': (90, 0), 'right': (90, 0), 'left': (270, 0), 'top': (0, 90), 'low': (35, 8), 'rear': (215, 28)}
def load_png(path):
    import numpy as np
    image = bpy.data.images.load(str(path)); w, h = image.size; pixels = np.empty(w * h * 4, dtype=np.float32); image.pixels.foreach_get(pixels); bpy.data.images.remove(image)
    return pixels.reshape(h, w, 4)[::-1]
def save_png(array, path):
    import numpy as np
    h, w = array.shape[:2]; out = bpy.data.images.new('MeshdeskOut', w, h, alpha=True); out.pixels.foreach_set(np.ascontiguousarray(array[::-1], dtype=np.float32).ravel())
    out.filepath_raw = str(path); out.file_format = 'PNG'; out.save()
    # Large sheets also get a JPEG copy: agents are sent that instead, because very large images are dropped on the way.
    try:
        if Path(path).name in ('review.png', 'compare.png') and Path(path).stat().st_size > 400000:
            flat = bpy.data.images.new('MeshdeskFlat', w, h, alpha=False); flat.pixels.foreach_set(np.ascontiguousarray(array[::-1], dtype=np.float32).ravel())
            flat.filepath_raw = str(Path(path).with_suffix('.jpg')); flat.file_format = 'JPEG'; flat.save(quality=82); bpy.data.images.remove(flat)
    except Exception: pass
    bpy.data.images.remove(out)
def hstack(paths, target):
    import numpy as np
    save_png(np.concatenate([load_png(p) for p in paths], axis=1), target)

def render_views(target, views=None, focus=None, style='studio', tile=384, band=None, overlay=None):
    """Renders the model into one image. views: names from VIEWS or [azimuth, elevation] pairs in degrees
    (azimuth 0 looks at the front, 90 at the right side). focus: mesh names to frame.
    style: studio (textured, flat light), lit (sun and sky), clay, wire."""
    import numpy as np, math
    meshes = scene_meshes()
    if not meshes: return False
    framed = [o for o in meshes if o.name in set(focus or [])] or meshes
    views = list(views or ['perspective', 'front', 'side', 'top'])[:6]
    scene = bpy.context.scene; render = scene.render
    low, high = bounds(framed); center = Vector([(low[i] + high[i]) / 2 for i in range(3)]); radius = max((Vector(high) - Vector(low)).length / 2, 1e-4)
    if band:
        # A horizontal slice of the model's height (0 = feet, 1 = top), for close-ups such as a face on a single-mesh character.
        bpy.context.view_layer.update(); deps = bpy.context.evaluated_depsgraph_get(); z0 = low[2] + (high[2] - low[2]) * min(band); z1 = low[2] + (high[2] - low[2]) * max(band); pts = []
        for o in framed:
            e = o.evaluated_get(deps); n = len(e.data.vertices)
            if not n: continue
            co = np.empty(n * 3, np.float32); e.data.vertices.foreach_get('co', co); co = co.reshape(n, 3) @ np.array(e.matrix_world.to_3x3(), np.float32).T + np.array(e.matrix_world.translation, np.float32)
            pts.append(co[(co[:, 2] >= z0) & (co[:, 2] <= z1)])
        pts = np.concatenate(pts) if pts else np.zeros((0, 3), np.float32)
        if len(pts):
            low, high = pts.min(axis=0).tolist(), pts.max(axis=0).tolist(); low[2], high[2] = z0, z1
            center = Vector([(low[i] + high[i]) / 2 for i in range(3)]); radius = max((Vector(high) - Vector(low)).length / 2, 1e-4)
    data = bpy.data.cameras.new('MeshdeskReview'); camera = bpy.data.objects.new('MeshdeskReview', data); scene.collection.objects.link(camera)
    data.type = 'ORTHO'; data.ortho_scale = radius * 2.15; data.clip_start = radius / 100; data.clip_end = radius * 40
    world = bpy.data.worlds.new('MeshdeskReview'); world.color = (.16, .17, .19); extra = []
    saved = (scene.camera, render.engine, render.resolution_x, render.resolution_y, render.resolution_percentage, render.filepath, scene.world, scene.view_settings.view_transform, render.image_settings.file_format)
    try:
        scene.camera = camera; scene.world = world; render.resolution_x = render.resolution_y = tile; render.resolution_percentage = 100; render.image_settings.file_format = 'PNG'
        try: scene.view_settings.view_transform = 'Standard'
        except Exception: pass
        if style == 'lit':
            render.engine = 'BLENDER_EEVEE'; world.color = (.55, .62, .72)
            # Headless EEVEE cannot build tangents for normal maps and renders those surfaces empty, so light them without the bump.
            for material in bpy.data.materials:
                if not material.node_tree: continue
                for link in [l for l in material.node_tree.links if l.to_socket.name == 'Normal' and l.to_node.type == 'BSDF_PRINCIPLED']: material.node_tree.links.remove(link)
            try:
                world.use_nodes = True; world.node_tree.nodes['Background'].inputs[0].default_value = (.55, .62, .72, 1); world.node_tree.nodes['Background'].inputs[1].default_value = .6
            except Exception: pass
            sun_data = bpy.data.lights.new('MeshdeskSun', 'SUN'); sun_data.energy = 2.5; sun = bpy.data.objects.new('MeshdeskSun', sun_data); scene.collection.objects.link(sun)
            sun.rotation_euler = (math.radians(50), 0, math.radians(35)); extra.append((sun, sun_data))
        else:
            try:
                render.engine = 'BLENDER_WORKBENCH'; scene.display.shading.light = 'STUDIO'; scene.display.shading.color_type = 'SINGLE' if style in ('clay', 'wire') else 'TEXTURE'
                if style in ('clay', 'wire'): scene.display.shading.single_color = (.78, .78, .8)
            except Exception:
                render.engine = 'CYCLES'; scene.cycles.samples = 12; scene.cycles.device = 'CPU'
            if style == 'wire':
                # Throwaway scene only: draw every edge as thin dark geometry.
                ink = bpy.data.materials.new('MeshdeskWire'); ink.diffuse_color = (.02, .02, .02, 1); scene.display.shading.color_type = 'MATERIAL'
                for o in meshes:
                    if o.data.users > 1: o.data = o.data.copy()
                    if not o.data.materials: o.data.materials.append(bpy.data.materials.new('MeshdeskClay'))
                    for m in o.data.materials:
                        if m: m.diffuse_color = (.78, .78, .8, 1)
                    o.data.materials.append(ink); wire = o.modifiers.new('MeshdeskWire', 'WIREFRAME'); wire.thickness = radius * .004; wire.use_replace = False; wire.use_even_offset = False; wire.material_offset = len(o.data.materials) - 1
        tiles = []
        for index, view in enumerate(views):
            azimuth, elevation = VIEWS.get(view, VIEWS['perspective']) if isinstance(view, str) else (float(view[0]), float(view[1]))
            az, el = math.radians(azimuth), math.radians(max(-89.9, min(89.9, elevation)))
            d = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))).normalized()
            camera.location = center + d * radius * 6; camera.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
            render.filepath = str(job / 'tmp' / f'view_{index}.png'); bpy.ops.render.render(write_still=True); tiles.append(load_png(render.filepath))
        if overlay:
            # Reference check: each view becomes a row of render | reference scaled to the model's silhouette | the two blended.
            rows = []
            for index, view in enumerate(views):
                shot = tiles[index]; spec = overlay.get(view if isinstance(view, str) else str(index)) if isinstance(overlay, dict) else None
                if not spec: continue
                try:
                    ref, ref_mask, (c0, r0, c1, r1) = md.subject_box(str(spec['path']), spec.get('box')); _, (x0, y0, x1, y1) = md._subject(shot[..., :3], None, .04)
                    scale = (y1 - y0) / max(r1 - r0, 1); width = max(2, int(round((c1 - c0) * scale))); height = y1 - y0
                    piece = md._resize(ref[r0:r1, c0:c1], width, height); mask = md._resize(ref_mask[r0:r1, c0:c1, None].astype(np.float32), width, height)
                    canvas = shot[..., :3].copy(); canvas[:] = shot[0, 0, :3]; alpha = np.zeros(shot.shape[:2] + (1,), np.float32); feet = lambda m: (lambda cols: (cols[0] + cols[-1]) / 2 if len(cols) else None)(np.where(m[int(len(m) * .9):].any(axis=0))[0])
                    _m, _ = md._subject(shot[..., :3], None, .04); fa = feet(_m[y0:y1, x0:x1]); fb = feet(mask[..., 0] > .5)
                    left = int(round(x0 + fa - fb)) if fa is not None and fb is not None else int(round((x0 + x1) / 2 - width / 2))
                    a0 = max(0, left); a1 = min(shot.shape[1], left + width)
                    if a1 > a0: canvas[y0:y1, a0:a1] = piece[:, a0 - left:a1 - left]; alpha[y0:y1, a0:a1] = mask[:, a0 - left:a1 - left]
                    canvas = canvas * alpha + shot[0, 0, :3] * (1 - alpha); blend = shot[..., :3] * .5 + canvas * .5
                    edge = np.abs(np.diff(alpha[..., 0], axis=0, prepend=0)) + np.abs(np.diff(alpha[..., 0], axis=1, prepend=0)) > .3; blend[edge] = (1, .2, .1)
                    one = np.ones(shot.shape[:2] + (1,), np.float32); rows.append(np.concatenate([np.dstack([shot[..., :3], one]), np.dstack([canvas, one]), np.dstack([blend, one])], axis=1))
                except Exception as error: print('Reference overlay skipped for', view, '-', error)
            if rows:
                save_png(np.concatenate(rows, axis=0), target); return True
        columns = 1 if len(tiles) == 1 else 2 if len(tiles) <= 4 else 3
        while len(tiles) % columns: tiles.append(np.full_like(tiles[0], .1))
        save_png(np.concatenate([np.concatenate(tiles[i:i + columns], axis=1) for i in range(0, len(tiles), columns)], axis=0), target)
    finally:
        scene.camera, render.engine, render.resolution_x, render.resolution_y, render.resolution_percentage, render.filepath, scene.world = saved[:7]
        try: scene.view_settings.view_transform = saved[7]
        except Exception: pass
        render.image_settings.file_format = saved[8]
        bpy.data.objects.remove(camera); bpy.data.cameras.remove(data); bpy.data.worlds.remove(world)
        for obj, light in extra: bpy.data.objects.remove(obj); bpy.data.lights.remove(light)
    return True
def render_sheet(target, tile=384): return render_views(target, tile=tile)

def uv_layout(target, focus=None, size=1024):
    """The UV islands of the meshes drawn over their base-colour texture (dimmed), to judge stretching, overlap and wasted space."""
    import numpy as np
    meshes = [o for o in scene_meshes() if not focus or o.name in set(focus)] or scene_meshes()
    canvas = np.full((size, size, 4), (.08, .08, .09, 1), dtype=np.float32)
    for o in meshes:
        for material in o.data.materials:
            node = next((n for n in material.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image and n.image.size[0] and any(l.to_socket.name == 'Base Color' for l in n.outputs['Color'].links)), None) if material and material.node_tree else None
            if node:
                copy = node.image.copy(); copy.scale(size, size); pixels = np.empty(size * size * 4, dtype=np.float32); copy.pixels.foreach_get(pixels); bpy.data.images.remove(copy)
                canvas = pixels.reshape(size, size, 4)[::-1] * .45; canvas[..., 3] = 1; break
        else: continue
        break
    t = np.linspace(0, 1, 96, dtype=np.float32)[None, :, None]; outside = 0
    for o in meshes:
        me = o.data
        if not me.uv_layers.active: continue
        uv = np.empty(len(me.loops) * 2, dtype=np.float32); me.uv_layers.active.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
        starts = []; ends = []
        for poly in me.polygons:
            idx = list(poly.loop_indices); starts += idx; ends += idx[1:] + idx[:1]
        a, b = uv[starts][:, None, :], uv[ends][:, None, :]; outside += int(((uv < -.001) | (uv > 1.001)).any(axis=1).sum())
        points = (a + (b - a) * t).reshape(-1, 2); points = points % 1.0
        x = np.clip((points[:, 0] * size).astype(int), 0, size - 1); y = np.clip(((1 - points[:, 1]) * size).astype(int), 0, size - 1)
        canvas[y, x] = (1, .75, .3, 1)
    save_png(canvas, target)
    return outside
step('Opening the model in Blender')
bpy.ops.wm.read_factory_settings(use_empty=True)
sys.path.insert(0, str(job))
import md
md.JOB = job
if mode == 'scene':
    # Assemble a scene from the models' previews and export it as one file. Scenes are Y-up metres;
    # each model is pivoted at the centre of its base, exactly as the scene editor shows it.
    import math, os
    from mathutils import Matrix, Euler
    spec = config['scene']; out = job / 'scene_export'; out.mkdir(exist_ok=True)
    convert = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
    for item in spec['items']:
        if not item.get('visible', True): continue
        step('Placing ' + item['name'])
        existing = set(bpy.data.objects); bpy.ops.import_scene.gltf(filepath=item['glb']); added = [o for o in bpy.data.objects if o not in existing]
        bpy.context.view_layer.update(); parts = [o for o in added if o.type == 'MESH']
        if parts:
            low, high = bounds(parts); pivot = Vector(((low[0] + high[0]) / 2, (low[1] + high[1]) / 2, low[2]))
        else: pivot = Vector((0, 0, 0))
        holder = bpy.data.objects.new(item['name'], None); bpy.context.scene.collection.objects.link(holder)
        for root in [o for o in added if o.parent is None]:
            world = root.matrix_world.copy(); root.parent = holder; root.matrix_parent_inverse = Matrix.Identity(4); root.matrix_world = Matrix.Translation(-pivot) @ world
        bpy.context.view_layer.update()
        rotation = Euler([math.radians(v) for v in item['rotation']], 'ZYX').to_matrix().to_4x4()
        placed = Matrix.Translation(item['position']) @ rotation @ Matrix.Diagonal((*item['scale'], 1))
        holder.matrix_world = convert @ placed @ convert.inverted()
    light = spec.get('lighting') or {}
    if light.get('sunIntensity', 0) > 0:
        az, el = math.radians(light.get('sunAzimuth', 135)), math.radians(light.get('sunElevation', 45))
        toward = convert.to_3x3() @ Vector((math.cos(el) * math.sin(az), math.sin(el), math.cos(el) * math.cos(az)))
        sun_data = bpy.data.lights.new('Sun', 'SUN'); sun_data.energy = light['sunIntensity']
        try: sun_data.color = [int(light.get('sunColor', '#ffffff')[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        except Exception: pass
        sun = bpy.data.objects.new('Sun', sun_data); bpy.context.scene.collection.objects.link(sun); sun.location = toward * 20; sun.rotation_euler = (-toward).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.view_layer.update()
    if spec.get('render'):
        # A look at the assembled scene for the agent: the same placements the viewer shows, drawn from a few angles.
        step('Rendering the scene'); wanted = spec['render']; names = set(wanted.get('focus') or [])
        def top(o):
            while o.parent: o = o.parent
            return o
        focus = [o.name for o in scene_meshes() if top(o).name in names] if names else None
        try: render_views(job / 'review.png', wanted.get('views') or ['perspective', 'top', 'front', 'side'], focus, wanted.get('style') or 'studio', int(wanted.get('tile') or 512))
        except Exception as error: (job / 'render_error.txt').write_text(str(error)[:500])
    if spec.get('format') == 'none':
        step('Scene render ready'); sys.stdout.flush(); os._exit(0)
    step('Exporting the scene')
    stem = spec['stem']
    if spec['format'] == 'fbx':
        bpy.ops.export_scene.fbx(filepath=str(out / (stem + '.fbx')), use_selection=False, object_types={'MESH', 'ARMATURE', 'EMPTY', 'LIGHT'}, path_mode='COPY', embed_textures=True, bake_anim=False)
    elif spec['format'] == 'blend':
        bpy.ops.file.pack_all(); bpy.ops.wm.save_as_mainfile(filepath=str(out / (stem + '.blend')))
    else:
        bpy.ops.export_scene.gltf(filepath=str(out / (stem + '.glb')), export_format='GLB', export_cameras=False, export_lights=True, export_yup=True)
    (out / 'layout.json').write_text(json.dumps({'name': spec.get('name'), 'units': 'metres, Y up, rotations in degrees (XYZ); each object is pivoted at the centre of its base', 'objects': [{k: item[k] for k in ('name', 'asset', 'position', 'rotation', 'scale', 'visible') if k in item} for item in spec['items']], 'lighting': spec.get('lighting'), 'environment': spec.get('environment')}, indent=2))
    step('Scene file ready'); sys.stdout.flush(); os._exit(0)
if source is None: pass
elif source.suffix.lower() == '.blend':
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
elif source.suffix.lower() in ['.glb', '.gltf']:
    try: bpy.ops.import_scene.gltf(filepath=str(source), disable_bone_shape=True)
    except TypeError: bpy.ops.import_scene.gltf(filepath=str(source))
elif source.suffix.lower() == '.obj':
    bpy.ops.wm.obj_import(filepath=str(source))
else:
    bpy.ops.import_scene.fbx(filepath=str(source), use_image_search=False)
# Resolve external files by their original name as well as any working filename.
textures = {}
by_stem = {}
for item in config['textures']:
    item = {'path': item, 'reference': Path(item).name} if isinstance(item, str) else item
    # Earlier entries win: the server lists textures from the model's own folder first.
    textures.setdefault(Path(item['path']).name, item['path'])
    textures.setdefault(item.get('reference', Path(item['path']).name), item['path'])
    # A model often names a .tga or .psd whose library copy was converted to another format.
    for name in (Path(item['path']).name, item.get('reference', '')):
        if name: by_stem.setdefault(Path(name).stem.lower(), item['path'])
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
        if not candidate: candidate = by_stem.get(Path(name).stem.lower())
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
bpy.context.view_layer.update()
before = scene_stats()
review = mode == 'edit' and source is not None and config.get('render', True) and not config.get('exportOptions')
if review:
    try: render_views(job / 'before.png', views=['perspective'])
    except Exception as error: print('Before render failed:', error, flush=True)
script_text = (job / 'edit.py').read_text()
captured = io.StringIO()
class Tee:
    def write(self, text): captured.write(text); sys.__stdout__.write(text); return len(text)
    def flush(self): sys.__stdout__.flush()
try:
    with contextlib.redirect_stdout(Tee()):
        exec(compile(script_text, 'edit.py', 'exec'), {'bpy': bpy, 'md': md, 'job_dir': str(job), '__name__': '__main__'})
except BaseException as error:
    # Hand the agent the failing line of its own script instead of Blender's whole log.
    lines = script_text.splitlines()
    frames = [f for f in traceback.extract_tb(error.__traceback__) if f.filename == 'edit.py']
    where = ''.join(f'  line {f.lineno}: {lines[f.lineno - 1].strip() if 0 < f.lineno <= len(lines) else ""}\n' for f in frames[-4:])
    if isinstance(error, SyntaxError): where = f'  line {error.lineno}: {(error.text or "").strip()}\n'
    (job / 'error.json').write_text(json.dumps({'message': f'{type(error).__name__}: {error}', 'where': where, 'output': captured.getvalue()[-3000:]}))
    sys.exit(1)
bpy.context.view_layer.update()
if bpy.context.object and bpy.context.object.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
# Materials the script replaced would otherwise export their textures too.
for leftover in [m for m in bpy.data.materials if m.users == 0]: bpy.data.materials.remove(leftover)
meshes = scene_meshes()
stats = scene_stats()
if mode in ('inspect', 'script'):
    # Read-only: report on the scene (after the script, whose changes are thrown away) and stop.
    result = {'stats': stats, 'before': before, 'meshes': mesh_table(), 'issues': readiness(missing), 'output': captured.getvalue()[-30000:], 'missingTextures': sorted(set(missing))}
    spec = config.get('render')
    if spec:
        step('Rendering review views'); spec = spec if isinstance(spec, dict) else {}
        try:
            if spec.get('style') == 'uv': result['uvsOutsideSquare'] = uv_layout(job / 'review.png', spec.get('focus')); result['render'] = True
            else: result['render'] = render_views(job / 'review.png', views=spec.get('views'), focus=spec.get('focus'), style=spec.get('style') or 'studio', tile=int(spec.get('tile') or 384), band=spec.get('band'), overlay=spec.get('overlay'))
        except Exception as error: result['renderError'] = str(error)[:300]
    (job / 'inspect.json').write_text(json.dumps(result))
    step('Inspection complete')
    sys.stdout.flush()
    import os
    os._exit(0)
if not meshes: raise RuntimeError('The edited scene contains no meshes.')
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
(job / 'metrics.json').write_text(json.dumps({**stats, 'before': before}))
(job / 'report.json').write_text(json.dumps({'meshes': mesh_table(), 'issues': readiness(missing), 'output': captured.getvalue()[-8000:]}))
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
    engine = options.get('engine') or ''
    # Unity: bake the axis conversion and unit scale so the prefab has no -90° rotation or 100× scale.
    # Unreal: its importer converts axes itself; it wants face smoothing and tangents. Godot reads the default axes.
    fbx_engine = {'unity': dict(axis_forward='-Z', axis_up='Y', apply_scale_options='FBX_SCALE_UNITS', bake_space_transform=True),
                  'unreal': dict(mesh_smooth_type='FACE', use_tspace=True, apply_scale_options='FBX_SCALE_NONE')}.get(engine, {})
    def texture_name(name): return 'T_' + name if engine == 'unreal' and not name.startswith('T_') else name
    def export_model(name):
        if fmt == 'fbx':
            bpy.ops.export_scene.fbx(filepath=str(target / (name + '.fbx')), use_selection=False,
                object_types={'MESH','ARMATURE','EMPTY'}, path_mode='COPY' if storage == 'embedded' else 'RELATIVE',
                embed_textures=storage == 'embedded', bake_anim=True, **fbx_engine)
        elif storage == 'embedded':
            bpy.ops.export_scene.gltf(filepath=str(target / (name + '.glb')), export_format='GLB', export_cameras=False, export_lights=False, export_yup=True)
        else:
            bpy.ops.export_scene.gltf(filepath=str(target / (name + '.gltf')), export_format='GLTF_SEPARATE', export_texture_dir='Textures',
                export_cameras=False, export_lights=False, export_yup=True)
    step('Preparing ' + fmt.upper() + ' with ' + storage + ' textures')
    for image in bpy.data.images:
        if image.name in exported:
            image.filepath = str(job / exported[image.name]['path'])
    if storage == 'separate' and fmt in ['fbx', 'blend']:
        (target / 'Textures').mkdir(exist_ok=True)
        for image in bpy.data.images:
            if image.name not in exported: continue
            original = job / exported[image.name]['path']
            dest = target / 'Textures' / texture_name(original.name)
            shutil.copyfile(original, dest)
            image.filepath = str(dest)
    if fmt == 'fbx': export_model(stem)
    elif fmt == 'gltf':
        if storage == 'embedded': shutil.copyfile(job / 'preview.glb', target / (stem + '.glb'))
        else: export_model(stem)
    elif fmt == 'blend':
        if storage == 'embedded': bpy.ops.file.pack_all()
        else:
            for image in bpy.data.images:
                if image.name in exported: image.filepath = '//Textures/' + texture_name(Path(exported[image.name]['path']).name)
        bpy.ops.wm.save_as_mainfile(filepath=str(target / (stem + '.blend')), relative_remap=False)
    else: raise RuntimeError('Unsupported export format')
    if fmt in ['fbx','blend']:
        portable = json.loads(json.dumps(manifest))
        portable['modelFile'] = stem + '.' + fmt
        portable['textureStorage'] = storage
        for texture in portable['textures']:
            texture['path'] = 'Textures/' + texture_name(Path(texture['path']).name) if storage == 'separate' else None
        for material in portable['materials']:
            for texture in material['textures']:
                texture['path'] = 'Textures/' + texture_name(Path(texture['path']).name) if storage == 'separate' else None
        (target / 'materials.json').write_text(json.dumps(portable, indent=2))
    lods = int(options.get('lods') or 0)
    if lods and fmt in ['fbx', 'gltf']:
        # Last step, because it halves the working scene's detail at every level.
        levels = [{'file': stem, 'level': 0, 'triangles': scene_stats()['triangles']}]
        for level in range(1, lods + 1):
            step(f'Building LOD{level} at {int(100 * 0.5 ** level)}% detail')
            for o in scene_meshes():
                if tri_count(o) < 32 or o.data.shape_keys: continue
                if o.data.users > 1: o.data = o.data.copy()
                modifier = o.modifiers.new('MeshdeskLOD', 'DECIMATE'); modifier.ratio = 0.5
                try:
                    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]): bpy.ops.object.modifier_apply(modifier=modifier.name)
                except Exception: o.modifiers.remove(modifier)
            export_model(f'{stem}_LOD{level}')
            levels.append({'file': f'{stem}_LOD{level}', 'level': level, 'triangles': scene_stats()['triangles']})
        (target / 'lods.json').write_text(json.dumps(levels, indent=2))
    step('Export file ready')
if mode == 'edit' and config.get('render', True) and not options:
    step('Rendering review views')
    try:
        render_sheet(job / 'review.png')
        if (job / 'before.png').exists():
            render_views(job / 'after.png', views=['perspective']); hstack([job / 'before.png', job / 'after.png'], job / 'compare.png')
    except Exception as error: print('Review render failed:', error, flush=True)

