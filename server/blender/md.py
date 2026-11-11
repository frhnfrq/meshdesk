"""Meshdesk helper library. Agent scripts get it as `md`.

Units are metres, Z is up, -Y is the front. Everything here is plain bpy underneath, so you can
mix these calls with your own bpy code. Functions that take `target` accept an object, an object
name, a list of either, or None for every mesh in the scene.
"""
import bpy, bmesh, math
import numpy as np
from mathutils import Vector, Matrix

JOB = None  # the job folder, set by the runner

# ───────────── scene access ─────────────
def meshes():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']

def get(name):
    o = bpy.data.objects.get(name)
    if not o: raise KeyError(f'No object named {name!r}. Objects: ' + ', '.join(x.name for x in list(bpy.context.scene.objects)[:40]))
    return o

def _objs(target):
    if target is None: return meshes()
    if isinstance(target, (str, bpy.types.Object)): target = [target]
    return [get(t) if isinstance(t, str) else t for t in target]

def _select(objs):
    if bpy.context.object and bpy.context.object.mode != 'OBJECT': bpy.ops.object.mode_set(mode='OBJECT')
    for o in bpy.context.view_layer.objects: o.select_set(False)
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]

def _link(o):
    bpy.context.scene.collection.objects.link(o)
    return o

def clear():
    """Delete every object (use at the start when building a model from scratch)."""
    for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for item in list(block):
            if item.users == 0: block.remove(item)

def tris(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)

def stats():
    """Print and return triangle counts per mesh and the overall size."""
    rows = [(o.name, tris(o), len(o.data.materials)) for o in meshes()]
    for name, count, mats in rows: print(f'{name}: {count} tris, {mats} materials')
    pts = [o.matrix_world @ Vector(c) for o in meshes() for c in o.bound_box]
    size = [max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3)] if pts else [0, 0, 0]
    print('total', sum(r[1] for r in rows), 'tris; size (x,y,z) m:', [round(v, 2) for v in size])
    return {'triangles': sum(r[1] for r in rows), 'size': size}

# ───────────── primitives (location is the centre of the BASE unless origin='center') ─────────────
def _finish(o, location, rotation, material_, origin, height):
    o.location = Vector(location) - (Vector((0, 0, height / 2)) if origin == 'center' else Vector((0, 0, 0)))
    o.rotation_euler = [math.radians(v) for v in rotation]
    _link(o)
    if material_ is not None: assign_material(o, material_)
    return o

def box(name, size=(1, 1, 1), location=(0, 0, 0), material=None, rotation=(0, 0, 0), origin='base'):
    """Box of `size` (x, y, z) metres."""
    me = bpy.data.meshes.new(name); bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co = Vector((v.co.x * size[0], v.co.y * size[1], (v.co.z + .5) * size[2]))
    bm.to_mesh(me); bm.free()
    return _finish(bpy.data.objects.new(name, me), location, rotation, material, origin, size[2])

def cylinder(name, radius=.5, height=1, location=(0, 0, 0), segments=16, material=None, rotation=(0, 0, 0), origin='base', radius_top=None):
    """Upright cylinder (or cone/taper with radius_top)."""
    me = bpy.data.meshes.new(name); bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius if radius_top is None else radius_top, depth=height)
    for v in bm.verts: v.co.z += height / 2
    bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = len(p.vertices) == 4
    return _finish(bpy.data.objects.new(name, me), location, rotation, material, origin, height)

def plane(name, size=(1, 1), location=(0, 0, 0), material=None, rotation=(0, 0, 0)):
    """Flat quad of `size` (x, y) metres, facing up."""
    me = bpy.data.meshes.new(name); x, y = size[0] / 2, size[1] / 2
    me.from_pydata([(-x, -y, 0), (x, -y, 0), (x, y, 0), (-x, y, 0)], [], [(0, 1, 2, 3)]); me.update()
    return _finish(bpy.data.objects.new(name, me), location, rotation, material, 'base', 0)

def prism(name, profile, length, location=(0, 0, 0), material=None, rotation=(0, 0, 0)):
    """Extrude a closed 2-D `profile` [(x, z), ...] along Y by `length`, centred on Y. Good for roofs, beams, kerbs, rails."""
    n = len(profile); half = length / 2
    verts = [(x, -half, z) for x, z in profile] + [(x, half, z) for x, z in profile]
    faces = [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)] + [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    me = bpy.data.meshes.new(name); me.from_pydata(verts, [], faces); me.update()
    bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
    return _finish(bpy.data.objects.new(name, me), location, rotation, material, 'base', 0)

def text(name, body, size=1, depth=.02, location=(0, 0, 0), rotation=(90, 0, 0), material=None, align='CENTER'):
    """Real 3-D lettering as a mesh, `size` metres tall. Default rotation stands it upright facing the front (-Y)."""
    curve = bpy.data.curves.new(name + '_curve', 'FONT'); curve.body = body; curve.size = size; curve.extrude = depth / 2; curve.align_x = align
    temp = _link(bpy.data.objects.new(name + '_curve', curve)); bpy.context.view_layer.update()
    me = bpy.data.meshes.new_from_object(temp.evaluated_get(bpy.context.evaluated_depsgraph_get())); me.name = name
    bpy.data.objects.remove(temp, do_unlink=True); bpy.data.curves.remove(curve)
    return _finish(bpy.data.objects.new(name, me), location, rotation, material, 'base', 0)

def array(obj, count, offset):
    """Copies of `obj` (sharing its mesh) every `offset` (x, y, z) metres. Returns all of them including the original."""
    out = [obj]
    for i in range(1, count):
        copy = obj.copy(); copy.name = f'{obj.name}_{i + 1:02d}'; copy.location = Vector(obj.location) + Vector(offset) * i; out.append(_link(copy))
    return out

# ───────────── materials ─────────────
def _bsdf(mat):
    try: mat.use_nodes = True
    except Exception: pass
    node = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not node:
        node = mat.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
        out = next((n for n in mat.node_tree.nodes if n.type == 'OUTPUT_MATERIAL'), None) or mat.node_tree.nodes.new('ShaderNodeOutputMaterial')
        mat.node_tree.links.new(node.outputs['BSDF'], out.inputs['Surface'])
    return node

def material(name, color=(.8, .8, .8), roughness=.7, metallic=0.0, emission=None):
    """Get or create a flat-colour PBR material. color is linear RGB 0..1."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name); b = _bsdf(mat)
    b.inputs['Base Color'].default_value = (*color[:3], 1); b.inputs['Roughness'].default_value = roughness; b.inputs['Metallic'].default_value = metallic
    mat.diffuse_color = (*color[:3], 1)
    if emission is not None:
        b.inputs['Emission Color'].default_value = (*emission[:3], 1); b.inputs['Emission Strength'].default_value = 1
    return mat

def _mat(mat):
    if isinstance(mat, str):
        found = bpy.data.materials.get(mat)
        if not found: raise KeyError(f'No material named {mat!r}. Materials: ' + ', '.join(m.name for m in bpy.data.materials))
        return found
    return mat

def assign_material(target, mat):
    """Make `mat` the only material on the target meshes."""
    mat = _mat(mat)
    for o in _objs(target): o.data.materials.clear(); o.data.materials.append(mat)

def load_image(path_or_image, non_color=False):
    image = bpy.data.images.load(str(path_or_image), check_existing=True) if isinstance(path_or_image, str) else path_or_image
    if non_color: image.colorspace_settings.name = 'Non-Color'
    return image

def assign_texture(mat, image, role='base_color', normal_strength=1.0):
    """Connect an image (file path or bpy image) to a material. role: base_color, roughness, metallic, normal, emission.
    Tiling comes from the UVs: use box_project(scale=...) rather than mapping nodes, which FBX cannot carry."""
    mat = _mat(mat); b = _bsdf(mat); tree = mat.node_tree
    image = load_image(image, non_color=role in ('roughness', 'metallic', 'normal'))
    socket = {'base_color': 'Base Color', 'roughness': 'Roughness', 'metallic': 'Metallic', 'emission': 'Emission Color', 'normal': 'Normal'}[role]
    for link in list(b.inputs[socket].links):
        old = link.from_node; tree.links.remove(link)
        if old.type in ('TEX_IMAGE', 'NORMAL_MAP') and not any(o.links for o in old.outputs): tree.nodes.remove(old)
    node = tree.nodes.new('ShaderNodeTexImage'); node.image = image; node.location = (-420, {'base_color': 300, 'roughness': 0, 'metallic': -150, 'normal': -320, 'emission': 150}[role])
    if role == 'normal':
        bump = tree.nodes.new('ShaderNodeNormalMap'); bump.inputs['Strength'].default_value = normal_strength; bump.location = (-180, -320)
        tree.links.new(node.outputs['Color'], bump.inputs['Color']); tree.links.new(bump.outputs['Normal'], b.inputs['Normal'])
    else:
        tree.links.new(node.outputs['Color'], b.inputs[socket])
        if role == 'emission': b.inputs['Emission Strength'].default_value = 1
    return node

# ───────────── UVs ─────────────
def unwrap(target=None, method='smart', angle=66, margin=.02):
    """Unwrap into the 0..1 square. method: smart (general), cube, lightmap."""
    for o in _objs(target):
        if not o.data.uv_layers: o.data.uv_layers.new(name='UVMap')
        _select([o]); bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
        if method == 'cube': bpy.ops.uv.cube_project(cube_size=1)
        elif method == 'lightmap': bpy.ops.uv.lightmap_pack(PREF_MARGIN_DIV=.1)
        else: bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin)
        bpy.ops.object.mode_set(mode='OBJECT')

def box_project(target=None, scale=1.0):
    """World-space box mapping for tiling textures: one repeat of the texture covers `scale` metres on every face,
    so texel density is even across all objects. Use this for walls, floors, roofs and other architecture."""
    for o in _objs(target):
        me = o.data; uv = me.uv_layers.active or me.uv_layers.new(name='UVMap'); world = o.matrix_world; rot = world.to_3x3().inverted().transposed()
        for poly in me.polygons:
            n = (rot @ poly.normal).normalized(); axis = max(range(3), key=lambda i: abs(n[i]))
            for li in poly.loop_indices:
                co = world @ me.vertices[me.loops[li].vertex_index].co
                uv.data[li].uv = ((co.y, co.z), (co.x, co.z), (co.x, co.y))[axis][0] / scale, ((co.y, co.z), (co.x, co.z), (co.x, co.y))[axis][1] / scale

# ───────────── geometry ─────────────
def apply_transforms(target=None, location=False):
    for o in _objs(target):
        if o.data.users > 1: o.data = o.data.copy()
        with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
            bpy.ops.object.transform_apply(location=location, rotation=True, scale=True)

def decimate_to(target=None, triangles=None, ratio=None):
    """Reduce detail. Give a total triangle target for the targets together, or a ratio 0..1."""
    objs = _objs(target); total = sum(tris(o) for o in objs)
    ratio = ratio if ratio is not None else min(1, (triangles or total) / max(total, 1))
    for o in objs:
        if tris(o) < 16 or o.data.shape_keys: continue
        if o.data.users > 1: o.data = o.data.copy()
        mod = o.modifiers.new('MeshdeskDecimate', 'DECIMATE'); mod.ratio = max(.02, min(1, ratio))
        with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]): bpy.ops.object.modifier_apply(modifier=mod.name)
    return sum(tris(o) for o in objs)

def join(target=None, name='Model'):
    """Merge the targets into one object."""
    objs = _objs(target)
    for o in objs:
        if o.data.users > 1: o.data = o.data.copy()
    _select(objs)
    if len(objs) > 1: bpy.ops.object.join()
    result = bpy.context.view_layer.objects.active; result.name = name; result.data.name = name
    return result

def triangulate(target=None):
    for o in _objs(target):
        bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.triangulate(bm, faces=bm.faces); bm.to_mesh(o.data); bm.free()

def shade(target=None, smooth=True):
    for o in _objs(target):
        for p in o.data.polygons: p.use_smooth = smooth

def bounds(target=None):
    pts = [o.matrix_world @ Vector(c) for o in _objs(target) for c in o.bound_box]
    return Vector([min(p[i] for p in pts) for i in range(3)]), Vector([max(p[i] for p in pts) for i in range(3)])

def ground(center=True):
    """Move the whole model so its base sits on the ground at the origin (the pivot a game engine expects)."""
    low, high = bounds(); offset = Vector((-(low.x + high.x) / 2 if center else 0, -(low.y + high.y) / 2 if center else 0, -low.z))
    for o in bpy.context.scene.objects:
        if o.parent is None: o.matrix_world.translation += offset

def set_pivot(obj, where='base'):
    """Move one object's origin to the centre of its base ('base'), its centre ('center') or a world point (x, y, z)."""
    o = get(obj) if isinstance(obj, str) else obj; low, high = bounds(o)
    point = Vector(where) if not isinstance(where, str) else Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z if where == 'base' else (low.z + high.z) / 2))
    if o.data.users > 1: o.data = o.data.copy()
    local = o.matrix_world.inverted() @ point; o.data.transform(Matrix.Translation(-local)); o.matrix_world = o.matrix_world @ Matrix.Translation(local)

# ───────────── procedural textures (numpy arrays: H×W or H×W×3, values 0..1, all tileable) ─────────────
def noise(size=512, scale=8, octaves=4, seed=0):
    """Tileable soft noise, H×W in 0..1. scale is the number of blobs across."""
    rng = np.random.default_rng(seed); out = np.zeros((size, size), np.float32); amp = 1.0; total = 0.0
    for octave in range(octaves):
        n = max(2, int(scale * 2 ** octave)); grid = rng.random((n, n), dtype=np.float32)
        x = np.linspace(0, n, size, endpoint=False); i = np.floor(x).astype(int); f = x - i; f = f * f * (3 - 2 * f); j = (i + 1) % n
        rows = grid[i] * (1 - f)[:, None] + grid[j] * f[:, None]
        out += amp * (rows[:, i] * (1 - f)[None, :] + rows[:, j] * f[None, :]); total += amp; amp *= .5
    return out / total

def _rgb(color, size): return np.broadcast_to(np.array(color[:3], np.float32), (size, size, 3)).copy()

def tex_plain(color=(.6, .6, .6), size=512, variation=.08, grain=24, seed=0):
    """Solid colour with soft mottling: plaster, painted metal, plastic. Returns (color, height)."""
    n = noise(size, grain, 4, seed); return np.clip(_rgb(color, size) * (1 + (n[..., None] - .5) * 2 * variation), 0, 1), n

def tex_concrete(color=(.55, .55, .53), size=1024, seed=0):
    """Concrete or asphalt with stains and fine pitting. Returns (color, height)."""
    big = noise(size, 3, 3, seed); fine = noise(size, 96, 2, seed + 1); pits = (noise(size, 200, 1, seed + 2) > .82).astype(np.float32)
    shade = 1 + (big - .5) * .35 + (fine - .5) * .18 - pits * .12
    return np.clip(_rgb(color, size) * shade[..., None], 0, 1), np.clip(.5 + (fine - .5) * .5 - pits * .4, 0, 1)

def tex_bricks(size=1024, rows=8, cols=4, brick=(.55, .22, .16), mortar=(.72, .7, .66), gap=.05, variation=.14, seed=0):
    """Running-bond brickwork. gap is the mortar width as a fraction of a brick's height. Returns (color, height)."""
    rng = np.random.default_rng(seed); y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size
    row = np.floor(y * rows).astype(int); fx = (x * cols + (row % 2) * .5) % cols; col = np.floor(fx).astype(int); u = fx - col; v = y * rows - row
    g = gap; gu = g * cols / rows; face = ((u > gu / 2) & (u < 1 - gu / 2) & (v > g / 2) & (v < 1 - g / 2)).astype(np.float32)
    tint = (rng.random((rows, cols), dtype=np.float32) - .5)[row, col] * 2 * variation; fine = noise(size, 64, 3, seed + 1)
    color = _rgb(brick, size) * (1 + tint + (fine - .5) * .15)[..., None] * face[..., None] + _rgb(mortar, size) * (1 + (fine[..., None] - .5) * .1) * (1 - face[..., None])
    return np.clip(color, 0, 1), np.clip(face * (.8 + (fine - .5) * .2) + (1 - face) * .25, 0, 1)

def tex_tiles(size=1024, rows=4, cols=4, color=(.8, .8, .78), color_b=None, grout=(.35, .35, .35), gap=.03, variation=.05, seed=0):
    """Square or rectangular tiles; give color_b for a checker pattern. Floors, platform paving, wall cladding. Returns (color, height)."""
    rng = np.random.default_rng(seed); y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size
    row = np.floor(y * rows).astype(int); col = np.floor(x * cols).astype(int); u = x * cols - col; v = y * rows - row
    gu = gap * cols / rows; face = ((u > gu / 2) & (u < 1 - gu / 2) & (v > gap / 2) & (v < 1 - gap / 2)).astype(np.float32)
    base = _rgb(color, size)
    if color_b is not None: base = np.where((((row + col) % 2) == 1)[..., None], _rgb(color_b, size), base)
    tint = (rng.random((rows, cols), dtype=np.float32) - .5)[row, col] * 2 * variation; fine = noise(size, 48, 3, seed + 1)
    out = base * (1 + tint + (fine - .5) * .06)[..., None] * face[..., None] + _rgb(grout, size) * (1 - face[..., None])
    return np.clip(out, 0, 1), np.clip(face * .85 + (1 - face) * .3, 0, 1)

def tex_stripes(colors=((.9, .75, .1), (.05, .05, .05)), size=512, count=8, vertical=True, diagonal=False, seed=0):
    """Even stripes cycling through `colors`: safety markings, awnings, hazard tape (diagonal=True). Returns (color, height)."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32) / size; t = (x + y if diagonal else x if vertical else y) * count
    index = np.floor(t).astype(int) % len(colors); out = np.array([c[:3] for c in colors], np.float32)[index]
    return np.clip(out * (1 + (noise(size, 32, 3, seed)[..., None] - .5) * .08), 0, 1), np.full((size, size), .5, np.float32)

def tex_metal(color=(.6, .62, .65), size=512, seed=0):
    """Brushed or corrugated-looking metal with fine horizontal streaks. Returns (color, height)."""
    rng = np.random.default_rng(seed); streak = np.repeat(rng.random((size, 1), dtype=np.float32), size, axis=1); soft = noise(size, 6, 3, seed)
    shade = 1 + (streak - .5) * .12 + (soft - .5) * .15
    return np.clip(_rgb(color, size) * shade[..., None], 0, 1), np.clip(.5 + (streak - .5) * .3, 0, 1)

def tex_corrugated(color=(.7, .72, .75), size=512, ribs=16, seed=0):
    """Corrugated roofing sheet with vertical ribs. Returns (color, height)."""
    x = np.mgrid[0:size, 0:size][1].astype(np.float32) / size; wave = .5 + .5 * np.sin(x * ribs * 2 * math.pi); soft = noise(size, 5, 3, seed)
    return np.clip(_rgb(color, size) * (.78 + wave * .3 + (soft - .5) * .14)[..., None], 0, 1), wave

def normal_from_height(height, strength=2.0):
    """Tangent-space normal map (H×W×3) from a height array."""
    h = np.asarray(height, np.float32); dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * strength; dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * strength
    n = np.dstack([-dx, dy, np.ones_like(h)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n * .5 + .5

def image_from_array(name, array, non_color=False):
    """Turn an array (row 0 = top) into a Blender image. Meshdesk saves it as a texture file automatically once a material uses it."""
    a = np.clip(np.asarray(array, np.float32), 0, 1)
    if a.ndim == 2: a = np.dstack([a, a, a])
    if a.shape[2] == 3: a = np.dstack([a, np.ones(a.shape[:2], np.float32)])
    h, w = a.shape[:2]; image = bpy.data.images.get(name) or bpy.data.images.new(name, w, h, alpha=False)
    if tuple(image.size) != (w, h): image.scale(w, h)
    image.pixels.foreach_set(np.ascontiguousarray(a[::-1]).ravel()); image.update()
    if non_color: image.colorspace_settings.name = 'Non-Color'
    return image

def pbr_material(name, color, height=None, roughness=.75, metallic=0.0, normal_strength=2.0):
    """Material with a full texture set built from arrays: base colour, plus normal and roughness maps when `height` is given.
    color/height are what the tex_* functions return, e.g. md.pbr_material('Brick', *md.tex_bricks()). roughness may be a number or an H×W array."""
    mat = material(name, (1, 1, 1), roughness if np.isscalar(roughness) else .75, metallic)
    assign_texture(mat, image_from_array(name + '_BaseColor', color), 'base_color')
    if height is not None:
        assign_texture(mat, image_from_array(name + '_Normal', normal_from_height(height, normal_strength), non_color=True), 'normal')
        if np.isscalar(roughness): roughness = np.clip(roughness + (.5 - np.asarray(height, np.float32)) * .25, .05, 1)
    if not np.isscalar(roughness): assign_texture(mat, image_from_array(name + '_Roughness', roughness, non_color=True), 'roughness')
    return mat

def array_from_image(image):
    """Read an image (file path or bpy image) into an H×W×3 array, row 0 = top."""
    image = load_image(image); w, h = image.size; a = np.empty(w * h * 4, np.float32); image.pixels.foreach_get(a)
    return a.reshape(h, w, 4)[::-1, :, :3].copy()

def pbr_from_color(image, name=None, normal_strength=2.0, roughness=.75):
    """Derive (normal, roughness) arrays from a colour image's brightness. Returns (color, height, normal, roughness)."""
    color = array_from_image(image); height = color @ np.array([.3, .59, .11], np.float32)
    return color, height, normal_from_height(height, normal_strength), np.clip(roughness + (.5 - height) * .3, .05, 1)

# ───────────── baking ─────────────
def _bake_setup(samples):
    scene = bpy.context.scene; saved = scene.render.engine; scene.render.engine = 'CYCLES'; scene.cycles.device = 'CPU'; scene.cycles.samples = samples
    return saved

def bake(obj, kind='ao', size=1024, name=None, samples=16, high_poly=None, cage=.05, margin=8):
    """Bake a map for `obj` into a new image using its active UVs and return the image. kind: ao, normal, color, roughness, combined.
    With high_poly (object or list) the detail of those meshes is projected onto obj (kind='normal' gives a normal map of the high-poly detail).
    The image is not connected to anything: use assign_texture() afterwards."""
    o = get(obj) if isinstance(obj, str) else obj
    if not o.data.uv_layers: unwrap(o)
    image = bpy.data.images.new(name or f'{o.name}_{kind}', size, size, alpha=False)
    if kind in ('normal', 'roughness', 'ao'): image.colorspace_settings.name = 'Non-Color'
    if not o.data.materials: o.data.materials.append(material(o.name + '_Material'))
    targets = []
    for mat in o.data.materials:
        _bsdf(mat); node = mat.node_tree.nodes.new('ShaderNodeTexImage'); node.image = image; mat.node_tree.nodes.active = node; node.select = True; targets.append((mat, node))
    saved = _bake_setup(samples); sources = _objs(high_poly) if high_poly else []
    try:
        _select(sources + [o]); bpy.context.view_layer.objects.active = o
        kwargs = dict(margin=margin, use_selected_to_active=bool(sources), cage_extrusion=cage)
        if kind == 'color': bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, **kwargs)
        else: bpy.ops.object.bake(type={'ao': 'AO', 'normal': 'NORMAL', 'roughness': 'ROUGHNESS', 'combined': 'COMBINED'}[kind], **kwargs)
    finally:
        bpy.context.scene.render.engine = saved
        for mat, node in targets: mat.node_tree.nodes.remove(node)
    return image

def atlas(target=None, size=2048, name='Model', margin=.01, samples=8):
    """Merge the targets into ONE object with ONE material and ONE base-colour texture (a texture atlas), baking all their
    existing colours and textures into it. Cuts draw calls for game engines. Returns the merged object."""
    o = join(target, name); me = o.data
    if not me.uv_layers: me.uv_layers.new(name='UVMap')
    old = me.uv_layers.active; old.active_render = True
    new = me.uv_layers.new(name='AtlasUV'); me.uv_layers.active = new
    _select([o]); bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=margin); bpy.ops.object.mode_set(mode='OBJECT')
    image = bpy.data.images.new(name + '_BaseColor', size, size, alpha=False); nodes = []; rough = []
    for mat in me.materials:
        if not mat: continue
        b = _bsdf(mat); rough.append(b.inputs['Roughness'].default_value); metal = b.inputs['Metallic'].default_value; b.inputs['Metallic'].default_value = 0
        node = mat.node_tree.nodes.new('ShaderNodeTexImage'); node.image = image; mat.node_tree.nodes.active = node; nodes.append((mat, node, b, metal))
    saved = _bake_setup(samples)
    try: bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, margin=8)
    finally:
        bpy.context.scene.render.engine = saved
        for mat, node, b, metal in nodes: mat.node_tree.nodes.remove(node); b.inputs['Metallic'].default_value = metal
    for layer in [l for l in me.uv_layers if l.name != 'AtlasUV']: me.uv_layers.remove(layer)
    me.uv_layers['AtlasUV'].name = 'UVMap'; me.uv_layers[0].active_render = True
    merged = material(name + '_Atlas', (1, 1, 1), sum(rough) / len(rough) if rough else .7); assign_texture(merged, image, 'base_color')
    me.materials.clear(); me.materials.append(merged)
    for p in me.polygons: p.material_index = 0
    return o
