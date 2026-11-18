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

# ---- Characters: imported files, skeletons and animation clips ----
def import_model(path):
    """Import a GLB, FBX or OBJ file into the scene. Returns the objects it added."""
    before = set(bpy.data.objects); p = str(path); ext = p.lower().rsplit('.', 1)[-1]
    if ext in ('glb', 'gltf'):
        try: bpy.ops.import_scene.gltf(filepath=p, disable_bone_shape=True)
        except TypeError: bpy.ops.import_scene.gltf(filepath=p)
    elif ext == 'obj': bpy.ops.wm.obj_import(filepath=p)
    else: bpy.ops.import_scene.fbx(filepath=p, use_image_search=False)
    return [o for o in bpy.data.objects if o not in before]

def armature():
    """The model's skeleton, or None when it has no rig."""
    return next((o for o in bpy.context.scene.objects if o.type == 'ARMATURE'), None)

def _rig_actions(rig):
    data = rig.animation_data; found = []
    if not data: return found
    if data.action: found.append(data.action)
    for track in data.nla_tracks:
        for strip in track.strips:
            if strip.action and strip.action not in found: found.append(strip.action)
    return found

def clips():
    """Names of the animation clips on the model's skeleton."""
    rig = armature()
    return [t.name for t in rig.animation_data.nla_tracks] if rig and rig.animation_data else []

def _store(rig, action, name):
    """Keep an action on the rig as a named, muted NLA track so it is exported as its own clip and the rest pose stays visible."""
    data = rig.animation_data or rig.animation_data_create()
    for track in list(data.nla_tracks):
        if track.name == name: data.nla_tracks.remove(track)
    action.name = name; action.use_fake_user = True
    track = data.nla_tracks.new(); track.name = name
    strip = track.strips.new(name, int(action.frame_range[0]), action); strip.name = name
    try:
        if getattr(strip, 'action_slot', None) is None and len(action.slots): strip.action_slot = action.slots[0]
    except Exception: pass
    track.mute = True
    return track

def add_clips(path, names=None):
    """Copy the animations in another file of the SAME skeleton (same bone names) onto this model as clips.
    names: clip names in the file's order; missing ones keep the file's names. Returns the clip names added."""
    rig = armature()
    if not rig: raise RuntimeError('This model has no skeleton to animate. Rig it first.')
    if rig.animation_data and rig.animation_data.action:
        own = rig.animation_data.action; rig.animation_data.action = None; _store(rig, own, own.name)
    added = import_model(path); found = []
    for o in added:
        if o.type == 'ARMATURE': found += [a for a in _rig_actions(o) if a not in found]
    for a in found: a.use_fake_user = True
    for o in added: bpy.data.objects.remove(o, do_unlink=True)
    out = []
    for index, action in enumerate(found):
        name = (list(names or [])[index:index + 1] or [action.name])[0]; _store(rig, action, name); out.append(name)
    bpy.data.orphans_purge(do_recursive=True)
    return out

def pose(clip=None, frame=None):
    """Put the character in a pose for a render: clip is a clip name from md.clips() (None for the rest pose),
    frame a frame number, or a fraction 0..1 of the way through the clip."""
    rig = armature()
    if not rig or not rig.animation_data: return
    data = rig.animation_data; data.action = None
    for track in data.nla_tracks: track.is_solo = False; track.mute = True
    if clip is None: bpy.context.scene.frame_set(1); return
    track = next((t for t in data.nla_tracks if t.name == clip), None)
    if not track: raise KeyError(f'No clip named {clip!r}. Clips: ' + ', '.join(clips()))
    track.mute = False; strip = track.strips[0]; start, end = strip.frame_start, strip.frame_end
    at = start if frame is None else start + (end - start) * frame if isinstance(frame, float) and 0 <= frame <= 1 else frame
    bpy.context.scene.frame_set(int(round(at))); bpy.context.view_layer.update()

def fit_height(height):
    """Scale the whole model (skeleton included) so it stands this many metres tall, feet on the ground at the origin."""
    low, high = bounds(); current = high.z - low.z
    if current > 1e-6 and abs(height / current - 1) > .01:
        for o in bpy.context.scene.objects:
            if o.parent is None: o.scale = o.scale * (height / current); o.location = o.location * (height / current)
        bpy.context.view_layer.update()
    ground()

def crop_image(path, box, target):
    """Save part of a picture as a PNG. box is (left, top, right, bottom) as fractions of the picture, measured from its top-left."""
    image = bpy.data.images.load(str(path)); w, h = image.size; a = np.empty(w * h * 4, np.float32); image.pixels.foreach_get(a); a = a.reshape(h, w, 4)[::-1]
    x0, y0, x1, y1 = [min(1, max(0, float(v))) for v in box]; x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1))
    part = a[int(y0 * h):max(int(y0 * h) + 2, int(round(y1 * h))), int(x0 * w):max(int(x0 * w) + 2, int(round(x1 * w)))]
    ph, pw = part.shape[:2]; out = bpy.data.images.new('MeshdeskCrop', pw, ph, alpha=True); out.colorspace_settings.name = image.colorspace_settings.name
    out.pixels.foreach_set(np.ascontiguousarray(part[::-1]).ravel()); out.filepath_raw = str(target); out.file_format = 'PNG'; out.save()
    bpy.data.images.remove(out); bpy.data.images.remove(image)
    return pw, ph

# ───────────── characters and organic shapes ─────────────
# Build a character the way a sculptor does: block out connected volumes, fuse them into one skin, push and pull the
# surface with brushes, add clothing and hair as their own pieces, paint the reference onto the result, then rig it.
def ramp(v, lo, hi):
    """Smooth 0..1 ramp of an array between lo and hi (hi may be below lo for a falling ramp). The building block for `where` masks."""
    t = np.clip((np.asarray(v, np.float32) - lo) / (hi - lo if hi != lo else 1e-9), 0, 1)
    return t * t * (3 - 2 * t)

def _new_mesh(name, verts, faces, material_=None):
    me = bpy.data.meshes.new(name); me.from_pydata([tuple(map(float, v)) for v in verts], [], faces); me.update()
    bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(me); bm.free(); me.update()
    o = bpy.data.objects.new(name, me); _link(o)
    for p in me.polygons: p.use_smooth = True
    if material_ is not None: me.materials.append(_mat(material_))
    return o

def ellipsoid(name, center=(0, 0, 1), radii=(.1, .1, .1), rotation=(0, 0, 0), material=None, segments=32):
    """A smooth ellipsoid volume: heads, torsos, hair buns, hands, shoes. radii are (x, y, z) half-sizes; rotation in degrees."""
    rings = max(8, segments // 2); verts = [(0, 0, 1)]; faces = []
    for r in range(1, rings):
        phi = math.pi * r / rings
        for s in range(segments):
            th = 2 * math.pi * s / segments; verts.append((math.sin(phi) * math.cos(th), math.sin(phi) * math.sin(th), math.cos(phi)))
    verts.append((0, 0, -1)); last = len(verts) - 1
    for s in range(segments): faces.append((0, 1 + s, 1 + (s + 1) % segments))
    for r in range(rings - 2):
        a = 1 + r * segments; b = a + segments
        for s in range(segments): faces.append((a + s, b + s, b + (s + 1) % segments, a + (s + 1) % segments))
    a = 1 + (rings - 2) * segments
    for s in range(segments): faces.append((last, a + (s + 1) % segments, a + s))
    rot = Matrix.Rotation(math.radians(rotation[2]), 3, 'Z') @ Matrix.Rotation(math.radians(rotation[1]), 3, 'Y') @ Matrix.Rotation(math.radians(rotation[0]), 3, 'X')
    pts = [rot @ Vector((v[0] * radii[0], v[1] * radii[1], v[2] * radii[2])) + Vector(center) for v in verts]
    return _new_mesh(name, pts, faces, material)

def tube(name, points, radii=.05, material=None, segments=20, flatten=1.0, flat_axis=(0, 1, 0)):
    """A rounded tube swept along points, closed at both ends: limbs, necks, fingers, straps, scarves, hair locks.
    radii: one radius or one per point (so it can taper). flatten < 1 squashes the cross-section along flat_axis
    (0.3 gives a ribbon: straps, scarf tails, belts)."""
    pts = [Vector(p) for p in points]
    if len(pts) < 2: raise ValueError('tube needs at least two points')
    rad = [float(radii)] * len(pts) if isinstance(radii, (int, float)) else [float(r) for r in radii]
    if len(rad) != len(pts): raise ValueError('give one radius, or one per point')
    # Smooth the path so bends are round, then add a rounded cap at each end.
    path = []; widths = []
    for i in range(len(pts) - 1):
        steps = max(1, int((pts[i + 1] - pts[i]).length / max(min(rad) * .8, .004)))
        for k in range(steps):
            t = k / steps; path.append(pts[i].lerp(pts[i + 1], t)); widths.append(rad[i] + (rad[i + 1] - rad[i]) * t)
    path.append(pts[-1]); widths.append(rad[-1])
    d0 = (path[1] - path[0]).normalized(); d1 = (path[-1] - path[-2]).normalized(); cap = 5
    head = [(path[0] - d0 * widths[0] * math.sin(math.pi / 2 * (1 - k / cap)), widths[0] * math.cos(math.pi / 2 * (1 - k / cap))) for k in range(1, cap)]
    tail = [(path[-1] + d1 * widths[-1] * math.sin(math.pi / 2 * k / cap), widths[-1] * math.cos(math.pi / 2 * k / cap)) for k in range(1, cap)]
    rings = head + list(zip(path, widths)) + tail
    axis = Vector(flat_axis).normalized(); verts = []; faces = []
    tangent = d0; side = tangent.orthogonal().normalized()
    for index, (centre, width) in enumerate(rings):
        near = rings[min(index + 1, len(rings) - 1)][0] - rings[max(index - 1, 0)][0]
        if near.length > 1e-9:
            new = near.normalized(); turn = tangent.rotation_difference(new); side = (turn @ side).normalized(); tangent = new
        up = tangent.cross(side).normalized()
        for s in range(segments):
            th = 2 * math.pi * s / segments; offset = (side * math.cos(th) + up * math.sin(th)) * width
            if flatten != 1.0: offset -= axis * offset.dot(axis) * (1 - flatten)
            verts.append(centre + offset)
    for r in range(len(rings) - 1):
        a = r * segments; b = a + segments
        for s in range(segments): faces.append((a + s, a + (s + 1) % segments, b + (s + 1) % segments, b + s))
    start = len(verts); verts.append(path[0] - d0 * widths[0]); verts.append(path[-1] + d1 * widths[-1]); a = (len(rings) - 1) * segments
    for s in range(segments): faces.append((start, (s + 1) % segments, s)); faces.append((start + 1, a + s, a + (s + 1) % segments))
    return _new_mesh(name, verts, faces, material)

def _coords(o):
    n = len(o.data.vertices); co = np.empty(n * 3, np.float32); o.data.vertices.foreach_get('co', co); co = co.reshape(n, 3)
    m = np.array(o.matrix_world, np.float32); return co @ m[:3, :3].T + m[:3, 3]

def _set_coords(o, world):
    m = np.array(o.matrix_world.inverted(), np.float32); local = world @ m[:3, :3].T + m[:3, 3]
    o.data.vertices.foreach_set('co', np.ascontiguousarray(local, np.float32).ravel()); o.data.update()

def _normals(o):
    n = len(o.data.vertices); out = np.empty(n * 3, np.float32)
    try: o.data.vertex_normals.foreach_get('vector', out)
    except Exception: o.data.vertices.foreach_get('normal', out)
    out = out.reshape(n, 3) @ np.array(o.matrix_world.to_3x3().inverted().transposed(), np.float32).T
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-9)

def _edges(o):
    e = np.empty(len(o.data.edges) * 2, np.int32); o.data.edges.foreach_get('vertices', e); return e.reshape(-1, 2)

def _relax(co, edges, weight, iterations):
    """Laplacian smoothing of the weighted vertices."""
    w = np.clip(weight, 0, 1)[:, None]
    for _ in range(int(iterations)):
        total = np.zeros_like(co); count = np.zeros(len(co), np.float32)
        np.add.at(total, edges[:, 0], co[edges[:, 1]]); np.add.at(total, edges[:, 1], co[edges[:, 0]]); np.add.at(count, edges[:, 0], 1); np.add.at(count, edges[:, 1], 1)
        co = co + (total / np.maximum(count, 1)[:, None] - co) * w
    return co

def remesh(target, voxel=.008, smooth=3):
    """Rebuild a mesh as one even, watertight skin (voxel remesh). Use after adding volume so there is fresh surface to sculpt.
    voxel is the detail size in metres (0.008 for a body, 0.004 for a head you want to sculpt finely)."""
    o = _objs(target)[0]; mats = list(o.data.materials); _select([o]); o.data.remesh_voxel_size = voxel; o.data.remesh_voxel_adaptivity = 0
    bpy.ops.object.voxel_remesh()
    if not o.data.materials:
        for m in mats: o.data.materials.append(m)
    if smooth: _set_coords(o, _relax(_coords(o), _edges(o), np.ones(len(o.data.vertices), np.float32) * .6, smooth))
    for p in o.data.polygons: p.use_smooth = True
    return o

def fuse(parts, name='Body', voxel=.008, smooth=4, material=None):
    """Melt overlapping volumes into ONE connected, watertight skin (their union, with soft blends where they meet).
    This is how separate ellipsoids and tubes become a body, a head with nose and ears, or a mass of hair."""
    objs = _objs(parts); first = objs[0]; mat = _mat(material) if material is not None else (first.data.materials[0] if first.data.materials else None)
    apply_transforms(objs, location=True); _select(objs); bpy.ops.object.join(); o = bpy.context.view_layer.objects.active; o.name = name; o.data.name = name
    o.data.materials.clear()
    if mat: o.data.materials.append(mat)
    return remesh(o, voxel, smooth)

def quads(target, faces=6000):
    """Retopologise a sculpt into an even quad mesh of about `faces` faces that bends well (QuadriFlow); falls back to a
    clean decimation if that fails. Do this after sculpting and before painting and rigging."""
    out = []
    for o in _objs(target):
        _select([o]); before = len(o.data.polygons)
        try:
            bpy.ops.object.quadriflow_remesh(mode='FACES', target_faces=int(faces), use_mesh_symmetry=False, use_preserve_sharp=False, use_preserve_boundary=True, smooth_normals=True)
            if len(o.data.polygons) < 20 or len(o.data.polygons) == before: raise RuntimeError('no change')
        except Exception:
            decimate_to(o, triangles=int(faces) * 2)
        for p in o.data.polygons: p.use_smooth = True
        out.append(o)
    return out[0] if len(out) == 1 else out

def sculpt(target, brush, at, radius=.05, strength=.01, direction=None, mirror=True, iterations=1):
    """A sculpt brush stroke on a mesh, in world metres. at: one point (x, y, z) or a list of points for a stroke.
    brush: 'draw' (raise along the surface normal by `strength` metres; negative carves), 'inflate' (same, swelling the
    whole area), 'grab' (drag the area by the vector `direction`, in metres), 'smooth' (relax; strength 0..1),
    'flatten' (press toward the local plane; 0..1), 'pinch' (pull toward the stroke; 0..1, sharpens creases and edges),
    'scale' (grow or shrink the area about its centre; strength .2 is 20% bigger, direction limits it to those axes).
    mirror=True repeats the stroke on the other side of the body (across X). Returns the mesh."""
    o = _objs(target)[0]; co = _coords(o); edges = _edges(o) if brush == 'smooth' else None
    points = [Vector(at)] if isinstance(at[0], (int, float)) else [Vector(p) for p in at]
    strokes = [(points, 1)] + ([([Vector((-p.x, p.y, p.z)) for p in points], -1)] if mirror and any(abs(p.x) > 1e-4 for p in points) else [])
    for _ in range(max(1, int(iterations))):
        for stroke, sign in strokes:
            for p in stroke:
                centre = np.array(p, np.float32); dist = np.linalg.norm(co - centre, axis=1); w = ramp(dist, radius, 0)
                if not w.any(): continue
                if brush in ('draw', 'inflate'):
                    o.data.vertices.foreach_set('co', np.ascontiguousarray(co @ np.array(o.matrix_world.inverted().to_3x3(), np.float32).T + np.array(o.matrix_world.inverted().translation, np.float32)).ravel()); o.data.update()
                    normals = _normals(o)
                    if brush == 'draw':
                        avg = (normals * w[:, None]).sum(axis=0); avg /= max(np.linalg.norm(avg), 1e-9); co += avg * (strength * w)[:, None]
                    else: co += normals * (strength * w)[:, None]
                elif brush == 'grab':
                    d = np.array(direction if direction is not None else (0, 0, 0), np.float32) * (np.array((sign, 1, 1), np.float32)); co += d * (strength if direction is None else 1) * w[:, None]
                elif brush == 'smooth': co = _relax(co, edges, w * min(1, abs(strength)), 3)
                elif brush == 'flatten':
                    o.data.vertices.foreach_set('co', np.ascontiguousarray(co @ np.array(o.matrix_world.inverted().to_3x3(), np.float32).T + np.array(o.matrix_world.inverted().translation, np.float32)).ravel()); o.data.update()
                    normals = _normals(o); total = max(w.sum(), 1e-9); mid = (co * w[:, None]).sum(axis=0) / total; n = (normals * w[:, None]).sum(axis=0); n /= max(np.linalg.norm(n), 1e-9)
                    co -= n * (((co - mid) @ n) * w * min(1, abs(strength)))[:, None]
                elif brush == 'pinch': co += (centre - co) * (w * min(1, abs(strength)) * .5)[:, None]
                elif brush == 'scale':
                    axes = np.array([1 if a else 0 for a in direction], np.float32) if direction is not None else np.ones(3, np.float32); co += (co - centre) * axes * (strength * w)[:, None]
                else: raise ValueError("brush must be draw, inflate, grab, smooth, flatten, pinch or scale")
    _set_coords(o, co); return o

def deform(target, where, move=(0, 0, 0), inflate=0.0, scale=(1, 1, 1), pivot=None, smooth=0):
    """Reshape a whole region at once. where(x, y, z) receives the vertex positions as arrays and returns a 0..1 weight
    per vertex (build it with md.ramp, e.g. lambda x, y, z: md.ramp(z, 1.0, 1.2) for "from 1.0 m upward, blending in").
    move: metres to shift the region; inflate: metres outward along the normals (negative thins); scale: (x, y, z)
    factors about pivot (default the region's centre): (1.3, 1.3, 1) flares a hem, (1, .8, 1) flattens a chest front to back;
    smooth: relax iterations. Use it for proportions: longer legs, narrower waist, bigger head, flared tunic."""
    for o in _objs(target):
        co = _coords(o); w = np.clip(np.asarray(where(co[:, 0], co[:, 1], co[:, 2]), np.float32), 0, 1)
        if not w.any(): continue
        if inflate: co += _normals(o) * (inflate * w)[:, None]
        s = np.array(scale, np.float32)
        if not np.allclose(s, 1):
            centre = np.array(pivot, np.float32) if pivot is not None else (co * w[:, None]).sum(axis=0) / max(w.sum(), 1e-9); co += (co - centre) * (s - 1) * w[:, None]
        co += np.array(move, np.float32) * w[:, None]
        if smooth: co = _relax(co, _edges(o), w, smooth)
        _set_coords(o, co)

def shell(source, name, where, offset=.012, thickness=.008, material=None, smooth=6):
    """Clothing that follows the body: copies the part of `source` where where(x, y, z) is true (arrays in, booleans out),
    lifts it `offset` metres off the skin and gives it `thickness`. Shape it afterwards with deform (flare a hem, loosen
    trouser legs) and sculpt. Examples: a tunic is the torso between hip and shoulder height plus the upper arms;
    trousers are everything from ankle to waist height. Returns the new object."""
    src = _objs(source)[0]; co = _coords(src); keep = np.asarray(where(co[:, 0], co[:, 1], co[:, 2])).astype(bool)
    if not keep.any(): raise ValueError('where() selected nothing; check the heights against md.bounds()')
    bm = bmesh.new(); bm.from_mesh(src.data); bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not keep[v.index]], context='VERTS')
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context='EDGES'); bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); o = bpy.data.objects.new(name, me); _link(o); o.matrix_world = src.matrix_world.copy()
    if material is not None: me.materials.append(_mat(material))
    elif src.data.materials: me.materials.append(src.data.materials[0])
    # Even out the cut edge, which follows the mesh's polygons and would otherwise be jagged.
    world = _coords(o); edges = _edges(o); bm = bmesh.new(); bm.from_mesh(me); border = np.zeros(len(me.vertices), np.float32); rim = []
    for e in bm.edges:
        if e.is_boundary: border[e.verts[0].index] = border[e.verts[1].index] = 1; rim.append((e.verts[0].index, e.verts[1].index))
    bm.free()
    if rim and smooth: world = _relax(world, np.array(rim, np.int32), border, smooth)
    _set_coords(o, world); world = _coords(o) + _normals(o) * offset; world = _relax(world, edges, 1 - border, 2); _set_coords(o, world)
    if thickness:
        mod = o.modifiers.new('Thickness', 'SOLIDIFY'); mod.thickness = thickness; mod.offset = 1; _select([o]); bpy.ops.object.modifier_apply(modifier=mod.name)
    for p in o.data.polygons: p.use_smooth = True
    return o

def body(height=1.7, head=.26, arm_angle=40, shoulders=1.0, hips=1.0, waist=1.0, chest=1.0, limbs=1.0, legs=1.0, neck=1.0, hands=1.0, feet=1.0, stance=1.05, material=None, voxel=None, name='Body'):
    """A connected humanoid base mesh (one watertight skin: torso, neck, head, arms with mitten hands and thumbs, legs, feet)
    standing on the ground, facing the front (-Y). height in metres; head is the head's height in metres (0.22 realistic,
    0.26 to 0.34 stylised); arm_angle is degrees below horizontal (0 = T-pose, 40 = A-pose). The other values are
    multipliers on a neutral build: shoulders and hips (width), waist and chest (girth), limbs (arm and leg thickness),
    legs (length; the torso takes up the rest), neck, hands, feet; stance is how far apart the feet are compared with
    the hips (1 = straight down, 1.7 = a wide, planted stance). Returns the object; md.joints() gives the skeleton
    positions it was built on. Sculpt it, then add clothing with shell() and hair with ellipsoid()/tube()/fuse()."""
    H = float(height); mat = material if material is not None else globals()['material']('Skin', (.72, .47, .34), roughness=.75)
    top = H; head_c = top - head / 2; chin = top - head; neck_base = chin - .035 * H * neck; shoulder_z = neck_base - .01 * H
    hip_z = H * .49 * legs + (1 - legs) * 0; hip_z = min(hip_z, shoulder_z - .22 * H); knee_z = hip_z * .52; ankle_z = .045 * H
    sx = .105 * H * shoulders; hx = .052 * H * hips; down = math.radians(arm_angle)
    upper = .15 * H; fore = .135 * H; hand_len = .09 * H * hands
    def arm(length_, start): return Vector((start[0] + math.cos(down) * length_, start[1], start[2] - math.sin(down) * length_))
    shoulder = Vector((sx, 0, shoulder_z)); elbow = arm(upper, shoulder); wrist = arm(fore, elbow); tip = arm(hand_len, wrist)
    hip = Vector((hx, 0, hip_z)); knee = Vector((hx * (1 + (stance - 1) * .55), -.005 * H, knee_z)); ankle = Vector((hx * stance, .01 * H, ankle_z)); toe = Vector((hx * stance * 1.05, -.085 * H * feet, .02 * H))
    waist_z = hip_z + (shoulder_z - hip_z) * .42; chest_z = hip_z + (shoulder_z - hip_z) * .74
    L = limbs; parts = []
    def add(o): parts.append(o); return o
    add(ellipsoid('p', (0, .006 * H, hip_z + .015 * H), (.1 * H * hips, .07 * H * hips, .07 * H)))
    add(tube('p', [(0, 0, hip_z), (0, 0, waist_z), (0, -.002 * H, chest_z), (0, 0, shoulder_z - .035 * H)], [.092 * H * hips, .078 * H * waist, .098 * H * chest, .088 * H * chest], flatten=.68, segments=28))
    add(tube('p', [(-sx * .9, 0, shoulder_z - .015 * H), (sx * .9, 0, shoulder_z - .015 * H)], .042 * H * chest))
    add(tube('p', [(0, 0, shoulder_z - .01 * H), (0, -.004 * H, chin + .03 * H)], .028 * H * neck))
    add(ellipsoid('p', (0, 0, head_c), (head * .40, head * .44, head * .5)))
    add(ellipsoid('p', (0, -head * .1, head_c - head * .2), (head * .31, head * .33, head * .3)))
    for s in (1, -1):
        m = lambda v: (v[0] * s, v[1], v[2])
        add(tube('p', [m(shoulder), m(elbow), m(wrist)], [.036 * H * L, .03 * H * L, .022 * H * L]))
        palm = wrist.lerp(tip, .5); add(ellipsoid('p', m(palm), (hand_len * .5, .012 * H * hands, .03 * H * hands), rotation=(0, math.degrees(down) * s, 0)))
        thumb = wrist.lerp(tip, .3) + Vector((0, -.022 * H * hands, -.004 * H)); add(tube('p', [m(wrist.lerp(tip, .12)), m(thumb + Vector((.02 * H * hands * math.cos(down), -.012 * H, -.02 * H * hands * math.sin(down))))], .0085 * H * hands))
        add(tube('p', [m(hip), m(knee), m(ankle)], [.062 * H * L, .044 * H * L, .03 * H * L]))
        add(ellipsoid('p', m(Vector((ankle.x, -.03 * H * feet, .022 * H))), (.034 * H * feet, .08 * H * feet, .026 * H)))
    o = fuse(parts, name, voxel or H / 230, smooth=5, material=mat)
    # Voxel union sinks the surface a little and can leave the soles off the ground.
    low, high = bounds(o); o.location.z -= low.z; apply_transforms(o, location=True)
    j = {'hips': (0, 0, hip_z), 'spine': (0, 0, waist_z), 'chest': (0, 0, chest_z), 'neck': (0, 0, neck_base), 'head': (0, 0, chin + .01 * H), 'head_top': (0, 0, top),
         'shoulder': tuple(shoulder), 'elbow': tuple(elbow), 'wrist': tuple(wrist), 'hand_tip': tuple(tip), 'hip': tuple(hip), 'knee': tuple(knee), 'ankle': tuple(ankle), 'toe': tuple(toe), 'clavicle': (sx * .25, 0, shoulder_z)}
    import json as _json
    bpy.context.scene['md_joints'] = _json.dumps(j)
    return o

def joints():
    """The joint positions md.body() used, as {name: (x, y, z)} for the character's LEFT side (+X) and the spine.
    Use them to place clothing, hair and brush strokes: joints()['head'] is the chin, ['head_top'] the crown."""
    import json as _json
    raw = bpy.context.scene.get('md_joints')
    if not raw: raise RuntimeError('No joints recorded. Build the body with md.body() first, or pass joints to md.rig().')
    return {k: tuple(v) for k, v in _json.loads(raw).items()}

# ───────────── painting the reference onto the model ─────────────
def _srgb(c): c = np.clip(np.asarray(c, np.float32), 0, 1); return np.where(c <= .0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - .055)
def _color(value):
    """'#rrggbb' or a linear RGB tuple, as sRGB texture values."""
    if isinstance(value, str): h = value.lstrip('#'); return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)
    return _srgb(value[:3])

def _dilate(rgb, mask, steps):
    """Spread known colours into unknown neighbours, so edges never pick up background."""
    rgb = rgb.copy(); mask = mask.copy()
    for _ in range(int(steps)):
        if mask.all(): break
        total = np.zeros_like(rgb); count = np.zeros(mask.shape, np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            m = np.roll(mask, (dy, dx), (0, 1)); c = np.roll(rgb, (dy, dx), (0, 1))
            if dy == 1: m[0] = False
            if dy == -1: m[-1] = False
            if dx == 1: m[:, 0] = False
            if dx == -1: m[:, -1] = False
            total += c * m[..., None]; count += m
        grow = (~mask) & (count > 0); rgb[grow] = total[grow] / count[grow][:, None]; mask |= grow
    return rgb

def subject_box(image, box=None, threshold=.07):
    """Where the subject sits in a picture with a plain background. Returns (rgb array row 0 = top, mask, (left, top, right, bottom) in pixels)."""
    img = load_image(image) if isinstance(image, str) else image; w, h = img.size; a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a); a = a.reshape(h, w, 4)[::-1]
    if box: l, t, r, b = box; a = a[int(t * h):max(int(t * h) + 2, int(b * h)), int(l * w):max(int(l * w) + 2, int(r * w))]
    rgb = a[..., :3]; mask, found = _subject(rgb, a[..., 3], threshold)
    return rgb, mask, found

def _subject(rgb, alpha=None, threshold=.07):
    k = max(2, min(rgb.shape[:2]) // 40); corners = np.concatenate([rgb[:k, :k].reshape(-1, 3), rgb[:k, -k:].reshape(-1, 3), rgb[-k:, :k].reshape(-1, 3), rgb[-k:, -k:].reshape(-1, 3)])
    mask = np.abs(rgb - np.median(corners, axis=0)).max(axis=2) > threshold
    if alpha is not None and alpha.min() < .99: mask &= alpha > .5
    # Background is only what connects to the picture's edge: pale clothing inside the figure stays part of the subject.
    open_ = ~mask; reach = np.zeros_like(mask); reach[0] = open_[0]; reach[-1] = open_[-1]; reach[:, 0] = open_[:, 0]; reach[:, -1] = open_[:, -1]
    for _ in range(64):
        before = reach.sum()
        for axis in (0, 1):
            for flip in (False, True):
                r = np.flip(reach, axis) if flip else reach; o = np.flip(open_, axis) if flip else open_
                # carry "reached" along each run of open pixels
                blocks = np.cumsum(~o, axis=axis); key = blocks * 2 + 0; first = np.maximum.accumulate(np.where(r, blocks, -1), axis=axis)
                r = o & (first == blocks); reach |= np.flip(r, axis) if flip else r
        if reach.sum() == before: break
    mask = ~reach
    rows = np.where(mask.mean(axis=1) > .01)[0]; cols = np.where(mask.mean(axis=0) > .004)[0]
    if not len(rows) or not len(cols): raise ValueError('No subject found against the background of this picture.')
    return mask, (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)

def _resize(rgb, width, height):
    h, w = rgb.shape[:2]; col = np.clip((np.arange(width) + .5) * w / width - .5, 0, w - 1.001); row = np.clip((np.arange(height) + .5) * h / height - .5, 0, h - 1.001)
    ci = col.astype(np.int32); ri = row.astype(np.int32); fc = (col - ci)[None, :, None]; fr = (row - ri)[:, None, None]
    return (rgb[ri][:, ci] * (1 - fc) + rgb[ri][:, ci + 1] * fc) * (1 - fr) + (rgb[ri + 1][:, ci] * (1 - fc) + rgb[ri + 1][:, ci + 1] * fc) * fr

_VIEW = {'front': (0, 1, 1, -1), 'back': (0, -1, 1, 1), 'right': (1, 1, 0, 1), 'left': (1, -1, 0, -1)}  # (u axis, u sign, facing axis, facing sign)

class Painter:
    """Paints a character's colour texture directly in texture space. Joins the target meshes into ONE object with one
    UV atlas and one texture, starting from each part's material colour. Then layer on:
      p.fill(color, where)                      flat colour on a region
      p.project(image, view, where, ...)        a reference picture projected straight onto the surface it shows
      p.finish()                                writes the texture and material (with soft ambient shading)
    `where` is a function of the painter that returns a mask, for example
      lambda p: p.part('Tunic') & (p.z > 0.9)      or      lambda p: (p.z > 1.3) & (p.ny < 0)
    using p.x, p.y, p.z (position in metres), p.nx, p.ny, p.nz (surface direction) and p.part(name) (the piece that was
    built with that object or material name). Rig the character BEFORE painting so every piece keeps its weights."""
    def __init__(self, target=None, size=2048, name='Character'):
        objs = _objs(target); names = []
        for o in objs:
            if not o.data.materials: o.data.materials.append(material(o.name, (.6, .6, .6)))
            if len(o.data.materials) == 1 and o.data.materials[0].users > 1 or o.data.materials[0].name != o.name:
                copy = o.data.materials[0].copy(); copy.name = o.name; o.data.materials[0] = copy
        rigged = next((o for o in objs if any(m.type == 'ARMATURE' for m in o.modifiers)), None)
        if rigged: objs = [rigged] + [o for o in objs if o is not rigged]
        _select(objs); bpy.ops.object.join(); o = bpy.context.view_layer.objects.active; o.name = name; self.o = o; self.size = size; me = o.data
        while len(me.uv_layers): me.uv_layers.remove(me.uv_layers[0])
        me.uv_layers.new(name='UVMap'); _select([o]); bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=.004); bpy.ops.object.mode_set(mode='OBJECT')
        self.parts = [m.name for m in me.materials]; base = [np.array(_bsdf(m).inputs['Base Color'].default_value[:3], np.float32) for m in me.materials]
        low, high = bounds(o); self.low = np.array(low, np.float32) - .01; self.high = np.array(high, np.float32) + .01; span = self.high - self.low
        def position(tree, index):
            geo = tree.nodes.new('ShaderNodeNewGeometry'); sub = tree.nodes.new('ShaderNodeVectorMath'); sub.operation = 'SUBTRACT'; sub.inputs[1].default_value = tuple(self.low)
            div = tree.nodes.new('ShaderNodeVectorMath'); div.operation = 'DIVIDE'; div.inputs[1].default_value = tuple(span); tree.links.new(geo.outputs['Position'], sub.inputs[0]); tree.links.new(sub.outputs[0], div.inputs[0]); return div.outputs[0]
        def normal(tree, index):
            geo = tree.nodes.new('ShaderNodeNewGeometry'); mul = tree.nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY_ADD'; mul.inputs[1].default_value = (.5, .5, .5); mul.inputs[2].default_value = (.5, .5, .5)
            tree.links.new(geo.outputs['Normal'], mul.inputs[0]); return mul.outputs[0]
        def ident(tree, index):
            rgb = tree.nodes.new('ShaderNodeRGB'); rgb.outputs[0].default_value = ((index + 1) / 64, 1, 0, 1); return rgb.outputs[0]
        pos = self._emit(position); nor = self._emit(normal); ids = self._emit(ident)
        self.valid = ids[..., 1] > .5; self.id = np.rint(ids[..., 0] * 64).astype(np.int32) - 1
        p = pos * span + self.low; self.x, self.y, self.z = p[..., 0], p[..., 1], p[..., 2]; n = nor * 2 - 1; self.nx, self.ny, self.nz = n[..., 0], n[..., 1], n[..., 2]
        self.color = np.zeros((size, size, 3), np.float32)
        for index, c in enumerate(base): self.color[self.id == index] = _srgb(c)
        self.base = self.color.copy()
    def _emit(self, build):
        o = self.o; me = o.data; originals = list(me.materials); image = bpy.data.images.new('MeshdeskBake', self.size, self.size, alpha=False, float_buffer=True); image.colorspace_settings.name = 'Non-Color'; temps = []
        for index in range(len(originals)):
            mat = bpy.data.materials.new('MeshdeskBake'); mat.use_nodes = True; tree = mat.node_tree; tree.nodes.clear()
            out = tree.nodes.new('ShaderNodeOutputMaterial'); emit = tree.nodes.new('ShaderNodeEmission'); tree.links.new(emit.outputs[0], out.inputs['Surface']); tree.links.new(build(tree, index), emit.inputs['Color'])
            node = tree.nodes.new('ShaderNodeTexImage'); node.image = image; tree.nodes.active = node; node.select = True; me.materials[index] = mat; temps.append(mat)
        saved = _bake_setup(1); scene = bpy.context.scene; view = scene.view_settings.view_transform
        try:
            _select([o]); bpy.ops.object.bake(type='EMIT', margin=0, use_clear=True)
        finally:
            scene.render.engine = saved
            for index, mat in enumerate(originals): me.materials[index] = mat
            for mat in temps: bpy.data.materials.remove(mat)
        a = np.empty(self.size * self.size * 4, np.float32); image.pixels.foreach_get(a); bpy.data.images.remove(image)
        return a.reshape(self.size, self.size, 4)[..., :3].copy()
    def part(self, name):
        """Mask of the piece built as the object or material called `name`."""
        hits = [i for i, n in enumerate(self.parts) if n == name or n.split('.')[0] == name]
        if not hits: raise KeyError(f'No part named {name!r}. Parts: ' + ', '.join(self.parts))
        return np.isin(self.id, hits)
    def _mask(self, where):
        m = self.valid if where is None else np.asarray(where(self)) if callable(where) else np.asarray(where)
        return (m.astype(np.float32) if m.dtype != bool else m.astype(np.float32)) * self.valid
    def fill(self, color, where=None, opacity=1.0):
        """Flat colour ('#rrggbb' or linear RGB) on the region."""
        w = (self._mask(where) * opacity)[..., None]; self.color = self.color * (1 - w) + _color(color) * w; return self
    def project(self, image, view='front', where=None, box=None, fit=None, facing=.25, opacity=1.0, flip=False, threshold=.07, subject=None):
        """Project a reference picture onto the surface it shows. view: where the picture was drawn from: 'front',
        'back', 'left' (the camera on the character's right, character facing the right of the picture) or 'right'.
        The subject in the picture (found against its plain background; box=(left, top, right, bottom) fractions limits
        the search to part of the picture) is stretched over the region chosen by `where` (default: the whole model), so
        the model's silhouette should already match the picture's. To place a detail picture, such as a face close-up,
        pass where= the region it covers (e.g. the head) or fit=(u_min, u_max, z_min, z_max) in metres across and up.
        If the picture has things the model lacks (a flowing scarf, a prop) the automatic fit is thrown off: pass
        subject=(left, top, right, bottom) fractions of the picture for the rectangle that matches the region instead.
        Only surfaces turned toward that view are painted (facing = how square-on, 0..1). flip mirrors the picture."""
        rgb, mask, (c0, r0, c1, r1) = subject_box(image, box, threshold); axis, usign, faxis, fsign = _VIEW[view]
        if subject: c0, r0, c1, r1 = int(subject[0] * rgb.shape[1]), int(subject[1] * rgb.shape[0]), int(subject[2] * rgb.shape[1]), int(subject[3] * rgb.shape[0])
        if flip: rgb = rgb[:, ::-1]; mask = mask[:, ::-1]; c0, c1 = rgb.shape[1] - c1, rgb.shape[1] - c0
        k = max(2, min(rgb.shape[:2]) // 40); backdrop = np.median(np.concatenate([rgb[:k, :k].reshape(-1, 3), rgb[:k, -k:].reshape(-1, 3)]), axis=0)
        empty = np.abs(rgb - backdrop).max(axis=2) < threshold * 2.4
        for _ in range(3): empty = empty | np.roll(empty, 1, 0) | np.roll(empty, -1, 0) | np.roll(empty, 1, 1) | np.roll(empty, -1, 1)
        rgb = _dilate(rgb, mask, 40); region = self._mask(where); on = region > 0
        if not on.any(): raise ValueError('where selected nothing to project onto')
        u = (self.x if axis == 0 else self.y) * usign
        if fit is None: fit = (float(u[on].min()), float(u[on].max()), float(self.z[on].min()), float(self.z[on].max()))
        s = (u - fit[0]) / max(fit[1] - fit[0], 1e-6); t = (self.z - fit[2]) / max(fit[3] - fit[2], 1e-6)
        col = np.clip(c0 + s * (c1 - c0), 0, rgb.shape[1] - 1.001); row = np.clip(r1 - t * (r1 - r0), 0, rgb.shape[0] - 1.001)
        ci = col.astype(np.int32); ri = row.astype(np.int32); fc = (col - ci)[..., None]; fr = (row - ri)[..., None]
        sample = (rgb[ri, ci] * (1 - fc) + rgb[ri, ci + 1] * fc) * (1 - fr) + (rgb[ri + 1, ci] * (1 - fc) + rgb[ri + 1, ci + 1] * fc) * fr
        toward = (self.nx if faxis == 0 else self.ny) * fsign; inside = (s > -.02) & (s < 1.02) & (t > -.02) & (t < 1.02)
        # Only the surface nearest the viewer receives the picture: whatever sits behind it (the far arm, hair behind the head) is left alone.
        depth = -(self.y if faxis == 1 else self.x) * fsign; cells = 384; seen = self.valid & inside & (toward > 0)
        cu = np.clip((s * (cells - 1)).astype(np.int32), 0, cells - 1); cz = np.clip((t * (cells - 1)).astype(np.int32), 0, cells - 1); nearest = np.full((cells, cells), np.inf, np.float32)
        np.minimum.at(nearest, (cz[seen], cu[seen]), depth[seen])
        for shift in ((0, 1), (0, -1), (1, 0), (-1, 0)): nearest = np.minimum(nearest, np.roll(nearest, shift, (0, 1)) + .004)
        inside &= depth <= nearest[cz, cu] + .02
        # Where the picture shows only its backdrop but this piece is some other colour, the shapes do not line up there: keep the piece's own colour.
        stray = empty[np.rint(row).astype(np.int32), np.rint(col).astype(np.int32)] & (np.abs(self.base - backdrop).max(axis=2) > .16)
        w = (ramp(toward, facing, facing + .3) * region * inside * opacity * ~stray)[..., None]; self.color = self.color * (1 - w) + sample * w; return self
    def finish(self, name=None, shading=.35, roughness=.8):
        """Write the texture and make it the model's only material. shading: how much soft ambient shadow to bake into
        the colour (0 none), which gives folds and creases depth. Returns the object."""
        o = self.o; me = o.data; name = name or o.name; color = self.color
        if shading:
            ao = bake(o, 'ao', self.size, samples=24, margin=0); a = np.empty(self.size * self.size * 4, np.float32); ao.pixels.foreach_get(a); bpy.data.images.remove(ao)
            color = color * (1 - shading * (1 - np.clip(a.reshape(self.size, self.size, 4)[..., :1] * 1.15, 0, 1)))
        color = _dilate(color, self.valid, 12); image = image_from_array(name + '_BaseColor', color[::-1])
        mat = bpy.data.materials.new(name); b = _bsdf(mat); b.inputs['Roughness'].default_value = roughness; assign_texture(mat, image, 'base_color')
        me.materials.clear(); me.materials.append(mat); me.polygons.foreach_set('material_index', np.zeros(len(me.polygons), np.int32)); me.update()
        return o

# ───────────── skeleton, skin weights and motion ─────────────
_BONES = [('Hips', None, 'hips', 'spine', 0), ('Spine', 'Hips', 'spine', 'chest', 0), ('Chest', 'Spine', 'chest', 'neck', 0), ('Neck', 'Chest', 'neck', 'head', 0), ('Head', 'Neck', 'head', 'head_top', 0),
          ('Shoulder', 'Chest', 'clavicle', 'shoulder', 1), ('UpperArm', 'Shoulder', 'shoulder', 'elbow', 1), ('LowerArm', 'UpperArm', 'elbow', 'wrist', 1), ('Hand', 'LowerArm', 'wrist', 'hand_tip', 1),
          ('UpperLeg', 'Hips', 'hip', 'knee', 1), ('LowerLeg', 'UpperLeg', 'knee', 'ankle', 1), ('Foot', 'LowerLeg', 'ankle', 'toe', 1)]

def _group_weights(o, names):
    w = np.zeros((len(o.data.vertices), len(names)), np.float32); index = {o.vertex_groups[n].index: i for i, n in enumerate(names) if n in o.vertex_groups}
    for v in o.data.vertices:
        for g in v.groups:
            if g.group in index: w[v.index, index[g.group]] = g.weight
    return w

def _set_weights(o, names, w):
    for n in names:
        if n in o.vertex_groups: o.vertex_groups.remove(o.vertex_groups[n])
    for i, n in enumerate(names):
        group = o.vertex_groups.new(name=n); col = w[:, i]
        for value in np.unique(np.round(col[col > .004], 2)):
            group.add(np.where(np.round(col, 2) == value)[0].tolist(), float(value), 'REPLACE')

def _segment_weights(co, segments):
    """Fallback skinning: each vertex follows the nearest bones."""
    d = np.empty((len(co), len(segments)), np.float32)
    for i, (a, b) in enumerate(segments):
        a = np.array(a, np.float32); ab = np.array(b, np.float32) - a; t = np.clip(((co - a) @ ab) / max(ab @ ab, 1e-9), 0, 1); d[:, i] = np.linalg.norm(co - (a + t[:, None] * ab), axis=1)
    w = 1 / (d ** 4 + 1e-9); w[w < w.max(axis=1, keepdims=True) * .05] = 0; return w / w.sum(axis=1, keepdims=True)

def rig(target=None, joints_=None, body_name='Body'):
    """Give the character a humanoid skeleton and skin weights. Uses the joints md.body() recorded (or pass joints_ in the
    same format as md.joints()). The body (the mesh named body_name, else the largest) is weighted automatically; clothing,
    hair and accessories copy the weights of the body beneath them so they move with it. Do this BEFORE trim_hidden
    (the clothes need the skin under them to copy from) and BEFORE Painter.
    Bones: Hips, Spine, Chest, Neck, Head, and Shoulder/UpperArm/LowerArm/Hand/UpperLeg/LowerLeg/Foot with .L and .R.
    Returns the armature object. Then add motion with md.animate_run() / md.animate_idle() and check it with md.pose()."""
    j = dict(joints_ or joints()); objs = _objs(target); old = armature()
    if old: bpy.data.objects.remove(old, do_unlink=True)
    apply_transforms(objs, location=True)
    data = bpy.data.armatures.new('Armature'); rig_ = bpy.data.objects.new('Armature', data); _link(rig_); _select([rig_]); bpy.ops.object.mode_set(mode='EDIT'); segments = []; names = []
    for name, parent, a, b, sided in _BONES:
        for suffix, sign in ((('.L', 1), ('.R', -1)) if sided else (('', 1),)):
            bone = data.edit_bones.new(name + suffix); bone.head = (j[a][0] * sign, j[a][1], j[a][2]); bone.tail = (j[b][0] * sign, j[b][1], j[b][2])
            if parent:
                bone.parent = data.edit_bones[parent + (suffix if parent + suffix in data.edit_bones else '')]; bone.use_connect = (Vector(bone.parent.tail) - Vector(bone.head)).length < 1e-4
            segments.append((tuple(bone.head), tuple(bone.tail))); names.append(bone.name)
    bpy.ops.object.mode_set(mode='OBJECT')
    main = next((o for o in objs if o.name == body_name), None) or max(objs, key=lambda o: len(o.data.vertices))
    for o in objs:
        for m in [m for m in o.modifiers if m.type == 'ARMATURE']: o.modifiers.remove(m)
    _select([main, rig_]); bpy.context.view_layer.objects.active = rig_
    try: bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    except Exception: pass
    w = _group_weights(main, names)
    if (w.sum(axis=1) < .5).mean() > .02:
        w = _segment_weights(_coords(main), segments); _set_weights(main, names, w)
        if not any(m.type == 'ARMATURE' for m in main.modifiers): main.modifiers.new('Armature', 'ARMATURE').object = rig_; main.parent = rig_
    from mathutils import kdtree
    co = _coords(main); facing = _normals(main); tree = kdtree.KDTree(len(co))
    for i, p in enumerate(co): tree.insert(p, i)
    tree.balance()
    for o in objs:
        if o is main: continue
        pts = _coords(o); own = _normals(o); out = np.zeros((len(pts), len(names)), np.float32)
        for i, p in enumerate(pts):
            # Follow the skin that faces the same way: a tunic's side follows the ribs under it, not the arm hanging beside it.
            near = tree.find_n(p, 16); same = [n for n in near if facing[n[1]] @ own[i] > .2][:4] or near[:4]; total = 0
            for _, index, dist in same: k = 1 / (dist + 1e-4); out[i] += w[index] * k; total += k
            out[i] /= max(total, 1e-9)
        out /= np.maximum(out.sum(axis=1, keepdims=True), 1e-9); _set_weights(o, names, out)
        o.modifiers.new('Armature', 'ARMATURE').object = rig_; o.parent = rig_
    return rig_

def rigid(target, bone):
    """Make a piece follow ONE bone rigidly (a hair bun on 'Head', a bag on 'Hips', shoes on 'Foot.L'), replacing its weights."""
    for o in _objs(target):
        for g in list(o.vertex_groups): o.vertex_groups.remove(g)
        o.vertex_groups.new(name=bone).add(list(range(len(o.data.vertices))), 1.0, 'REPLACE')

def _keyed(rig_, name, frames, pose_at, location_at=None):
    """Keyframes a clip from pose_at(t) -> {bone: world-space rotation relative to the rest pose (Matrix)}; children inherit correctly."""
    data = rig_.animation_data or rig_.animation_data_create(); data.action = None
    for track in data.nla_tracks: track.mute = True
    rest = {b.name: b.bone.matrix_local.to_3x3() for b in rig_.pose.bones}
    for b in rig_.pose.bones: b.rotation_mode = 'QUATERNION'
    for frame in range(1, frames + 2):
        t = (frame - 1) / frames; deltas = pose_at(t)
        def world(bone):
            while bone:
                if bone.name in deltas: return deltas[bone.name]
                bone = bone.parent
            return Matrix.Identity(3)
        for b in rig_.pose.bones:
            mine = world(b); above = world(b.parent) if b.parent else Matrix.Identity(3)
            b.rotation_quaternion = (rest[b.name].inverted() @ above.inverted() @ mine @ rest[b.name]).to_quaternion(); b.keyframe_insert('rotation_quaternion', frame=frame)
        if location_at:
            hips = rig_.pose.bones['Hips']; hips.location = rest['Hips'].inverted() @ Vector(location_at(t)); hips.keyframe_insert('location', frame=frame)
    action = data.action; data.action = None
    for b in rig_.pose.bones: b.rotation_quaternion = (1, 0, 0, 0); b.location = (0, 0, 0)
    _store(rig_, action, name); bpy.context.scene.frame_start = 1; bpy.context.scene.frame_end = max(bpy.context.scene.frame_end if bpy.context.scene.frame_end != 250 else 1, frames); bpy.context.scene.render.fps = 30
    return name

def _hang(rig_):
    """Rotation that brings each arm from its rest angle down to the character's side."""
    out = {}
    for suffix, sign in (('.L', 1), ('.R', -1)):
        bone = rig_.data.bones['UpperArm' + suffix]; d = (bone.tail_local - bone.head_local).normalized(); below = math.degrees(math.asin(max(-1, min(1, -d.z))))
        out[suffix] = math.radians((80 - below) * sign)
    return out

def animate_run(name='Run', frames=20, stride=1.0, lean=10):
    """Add a looping run clip to the rigged character (procedural: legs, arms, torso lean, hip bounce). stride scales how
    far the limbs swing; lean is the forward lean in degrees. Returns the clip name; look at it with md.pose(name, 0.25)."""
    rig_ = armature()
    if not rig_: raise RuntimeError('Rig the character first with md.rig().')
    X = lambda deg: Matrix.Rotation(math.radians(-deg), 3, 'X'); Z = lambda deg: Matrix.Rotation(math.radians(deg), 3, 'Z'); hang = _hang(rig_); height = bounds()[1].z
    def pose_at(t):
        out = {}; phase = 2 * math.pi * t; twist = 9 * math.sin(phase) * stride
        out['Hips'] = Z(twist) @ X(lean * .6); out['Spine'] = X(lean * .8); out['Chest'] = Z(-twist) @ X(lean); out['Neck'] = X(lean * .4); out['Head'] = X(0)
        for suffix, offset in (('.L', 0), ('.R', math.pi)):
            p = phase + offset; thigh = 42 * math.sin(p) * stride + 12; bend = 14 + 85 * (.5 + .5 * math.cos(p - math.radians(330))) ** 2
            out['UpperLeg' + suffix] = X(thigh); out['LowerLeg' + suffix] = X(thigh - bend); out['Foot' + suffix] = X(thigh - bend + 18 * math.sin(p))
            swing = -38 * math.sin(p) * stride; down = Matrix.Rotation(hang[suffix], 3, 'Y'); elbow = 80 + 12 * math.sin(p)
            out['Shoulder' + suffix] = Z(-twist) @ X(lean); out['UpperArm' + suffix] = X(swing) @ down; out['LowerArm' + suffix] = X(swing + elbow) @ down; out['Hand' + suffix] = X(swing + elbow) @ down
        return out
    return _keyed(rig_, name, frames, pose_at, lambda t: (0, 0, height * (.012 * math.cos(4 * math.pi * t) - .03)))

def animate_idle(name='Idle', frames=60):
    """Add a looping idle clip: arms relaxed at the sides, gentle breathing and weight shift."""
    rig_ = armature()
    if not rig_: raise RuntimeError('Rig the character first with md.rig().')
    X = lambda deg: Matrix.Rotation(math.radians(-deg), 3, 'X'); Z = lambda deg: Matrix.Rotation(math.radians(deg), 3, 'Z'); hang = _hang(rig_)
    def pose_at(t):
        s = math.sin(2 * math.pi * t); out = {'Hips': Z(1.5 * s), 'Spine': X(1 + s), 'Chest': X(2 + 1.5 * s), 'Neck': X(-1), 'Head': X(-2 - s)}
        for suffix in ('.L', '.R'):
            down = Matrix.Rotation(hang[suffix] * (.97 + .02 * s), 3, 'Y'); out['Shoulder' + suffix] = X(2 + 1.5 * s); out['UpperArm' + suffix] = X(4) @ down; out['LowerArm' + suffix] = X(16 + 2 * s) @ down; out['Hand' + suffix] = X(20) @ down
            out['UpperLeg' + suffix] = X(0); out['LowerLeg' + suffix] = X(0); out['Foot' + suffix] = X(0)
        return out
    return _keyed(rig_, name, frames, pose_at)

def animate(name, frames, pose_at, location_at=None):
    """Author your own looping clip. pose_at(t) with t from 0 to 1 returns {bone name: Matrix} where each matrix is that
    bone's rotation in world axes relative to the rest pose (use Matrix.Rotation(radians, 3, 'X')); bones you leave out
    follow their parent. location_at(t), optional, returns the hips' (x, y, z) offset in metres. X is sideways, -Y is forward."""
    rig_ = armature()
    if not rig_: raise RuntimeError('Rig the character first with md.rig().')
    return _keyed(rig_, name, frames, pose_at, location_at)

def trim_hidden(target, covers, margin=.006):
    """Delete the parts of a mesh that are buried inside other pieces (skin under clothing, scalp under hair), so they
    cannot poke through when the character moves and do not waste triangles. margin: how deep inside, in metres."""
    from mathutils import bvhtree
    deps = bpy.context.evaluated_depsgraph_get(); trees = [bvhtree.BVHTree.FromObject(c, deps) for c in _objs(covers)]; mats = [c.matrix_world for c in _objs(covers)]
    for o in _objs(target):
        co = _coords(o); buried = np.zeros(len(co), bool)
        for tree, mat in zip(trees, mats):
            inv = mat.inverted()
            for i, p in enumerate(co):
                if buried[i]: continue
                hit = tree.find_nearest(inv @ Vector(p))
                if hit[0] is not None and (inv @ Vector(p) - hit[0]).dot(hit[1]) < -margin: buried[i] = True
        if not buried.any(): continue
        bm = bmesh.new(); bm.from_mesh(o.data); bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if all(buried[v.index] for v in f.verts)], context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS'); bm.to_mesh(o.data); bm.free(); o.data.update()

def sample_color(image, at=(.5, .5), radius=.01):
    """The colour of a picture at a spot, as linear RGB ready for md.material(): at=(across, down) as fractions from the
    top-left, radius the size of the patch averaged. Use it so skin, cloth and hair start from the reference's own colours."""
    img = load_image(image) if isinstance(image, str) else image; w, h = img.size; a = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(a); a = a.reshape(h, w, 4)[::-1]
    r = max(1, int(radius * min(w, h))); x = int(at[0] * (w - 1)); y = int(at[1] * (h - 1)); c = a[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1, :3].reshape(-1, 3).mean(axis=0)
    return tuple(float(v) for v in np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4))

CHARACTER_TOOLS = ['body', 'joints', 'ellipsoid', 'tube', 'fuse', 'remesh', 'sculpt', 'deform', 'shell', 'trim_hidden', 'quads', 'ramp', 'sample_color', 'subject_box', 'rig', 'rigid', 'animate_run', 'animate_idle', 'animate', 'pose', 'clips', 'fit_height', 'decimate_to', 'bounds']
CHARACTER_GUIDE = '''CHARACTER RECIPE (one model_create script, then refine with blender_edit). Z is up, -Y is the front, the character's left is +X.
Measure the reference first: for each view note where head, shoulders, hands, hem, knees and feet sit as fractions of the
figure's height, and convert to metres. Build to those numbers, then check with blender_render overlay and correct.

skin = md.material('Skin', md.sample_color(FRONT, (.52, .09)))            # colours taken from the picture
b = md.body(height=1.63, head=.25, arm_angle=74, shoulders=.85, chest=.75, waist=.72, stance=1.7, material=skin)
j = md.joints(); top = j['head_top'][2]; chin = j['head'][2]; mid = (top + chin) / 2
md.sculpt(b, 'draw', (0, -.11, mid - .03), radius=.022, strength=.016)   # nose; then brow, cheeks, chin, lips
b = md.fuse([b, ear_left, ear_right], 'Body', voxel=.006)                # add ears or other volumes, re-skin
hair = md.fuse([md.ellipsoid('h', ...), md.ellipsoid('h', ...), md.tube('h', [...], [...])], 'Hair', voxel=.006, material=hair_mat)
tunic = md.fuse([md.tube('t', spine_points, radii, flatten=.7), sleeve_l, sleeve_r], 'Tunic', voxel=.007, material=cloth)   # loose clothing = its own volumes, slightly larger than the body
tights = md.shell(b, 'Tights', lambda x, y, z: (z > .1) & (z < .9), offset=.004)                                             # tight clothing = a shell lifted off the skin
# ... shoes, scarf, bag, belt the same way: ellipsoids and tubes fused per piece, each with its own flat material
b = md.quads(b, 4500); tunic = md.quads(tunic, 2200); md.decimate_to(hair, triangles=3500)      # game-weight topology
md.rig(); md.rigid(hair, 'Head'); md.rigid(bag, 'Spine')                  # skeleton + weights; rigid pieces follow one bone
md.trim_hidden(b, [tunic, trousers, shoes, hair])                         # after rig: remove skin buried under clothes
md.animate_run(); md.animate_idle()
p = md.Painter(size=2048)                                                 # joins everything; one atlas texture
hand = ...; crown = ...                                                   # the model's half-width at the hands and its top, measured before joining
p.project(FRONT, 'front', where=lambda p: ~p.part('Hair') & ~p.part('Scarf'), subject=(l, t, r, b), fit=(-hand, hand, 0, crown))
p.project(BACK, 'back', where=..., subject=(...), fit=(-hand, hand, 0, crown))
p.project(SIDE, 'left', where=lambda p: p.z < 1.25, facing=.55, subject=(...), fit=(...)); p.project(SIDE, 'right', flip=True, ...)
p.finish()

Rules that decide the result:
- The projection only looks right where the model's silhouette matches the picture. Check EVERY view with blender_render
  overlay and fix proportions (md.body arguments, md.deform, md.sculpt) until the red outline sits on the model.
- subject= is the rectangle in the picture, fit= the matching rectangle on the model (metres across, metres up). Match the
  same landmarks in both: outer edge of the hands, top of the hair, soles of the shoes. Leave flowing extras (scarf tails,
  props) out of both rectangles.
- Project detail (faces, patterns, shoes, stitching); keep plain pieces (hair, a plain scarf) as flat colour, or the
  picture's neighbours smear onto them. Limit a projection with where= (by part, height or side) when it lands on the wrong piece.
- Give the face real depth before painting: nose, brow ridge, eye sockets, cheeks, lips, chin and jaw, checked from the
  side and three-quarter views, not only the front. A flat face with a painted face on it looks wrong from every other angle.
- After rigging, render md.pose('Run', .25), .5 and .75 from the front and side. Stretching accessories need md.rigid; skin
  showing through cloth means the cloth is too tight there (md.deform ... inflate) or trim_hidden was skipped.
'''
