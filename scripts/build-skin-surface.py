"""Author the facial crease layers and an editable Blender skin study.

Run with Blender in background mode:
  blender --background --factory-startup --python scripts/build-skin-surface.py

The app samples the same authored surface fields in undeformed head coordinates.
The existing head and its morph topology are preserved.
"""
from pathlib import Path
import json
import math
import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'textures' / 'skin'
STUDY = ROOT / 'art' / 'skin'
OUT.mkdir(parents=True, exist_ok=True)
STUDY.mkdir(parents=True, exist_ok=True)
RES = 2048
BOUNDS = (-1.05, 1.05, -1.80, 1.45)
x0, x1, y0, y1 = BOUNDS
xs = np.linspace(x0, x1, RES, dtype=np.float32)
ys = np.linspace(y0, y1, RES, dtype=np.float32)
X, Y = np.meshgrid(xs, ys)
fine = np.zeros_like(X)
mature = np.zeros_like(X)


def stroke(field, points, width, depth, ridge=0.16):
    """Tapered, curved crease with a narrow trough and a soft raised shoulder."""
    points = np.asarray(points, dtype=np.float32)
    margin = width * 5
    ix0 = max(0, int((points[:, 0].min() - margin - x0) / (x1 - x0) * (RES - 1)))
    ix1 = min(RES, int((points[:, 0].max() + margin - x0) / (x1 - x0) * (RES - 1)) + 2)
    iy0 = max(0, int((points[:, 1].min() - margin - y0) / (y1 - y0) * (RES - 1)))
    iy1 = min(RES, int((points[:, 1].max() + margin - y0) / (y1 - y0) * (RES - 1)) + 2)
    xx, yy = X[iy0:iy1, ix0:ix1], Y[iy0:iy1, ix0:ix1]
    nearest = np.full_like(xx, 1e5)
    along = np.zeros_like(xx)
    for i, (a, b) in enumerate(zip(points[:-1], points[1:])):
        d = b - a
        t = np.clip(((xx - a[0]) * d[0] + (yy - a[1]) * d[1]) / max(float(d @ d), 1e-12), 0, 1)
        distance = np.square(xx - a[0] - t * d[0]) + np.square(yy - a[1] - t * d[1])
        closer = distance < nearest
        along = np.where(closer, (i + t) / (len(points) - 1), along)
        nearest = np.minimum(nearest, distance)
    taper = np.maximum(0, np.sin(np.pi * np.clip(along, 0, 1))) ** 0.6
    # A broad shoulder avoids the engraved, perfectly sharp line of a scratch.
    trough = np.exp(-nearest / (2 * width * width))
    shoulder = np.exp(-nearest / (2 * (width * 2.8) ** 2))
    field[iy0:iy1, ix0:ix1] += depth * taper * (ridge * shoulder - trough)


# Forehead: uneven arcs, shorter interrupted branches and a softer upper fold.
for i, (cy, half_width, depth, width) in enumerate([
    (0.53, 0.48, 0.0048, 0.0065),
    (0.665, 0.53, 0.0058, 0.0075),
    (0.80, 0.46, 0.0042, 0.0060),
    (0.91, 0.34, 0.0023, 0.0045),
]):
    xx = np.linspace(-half_width, half_width, 35)
    yy = cy + 0.035 * (xx / half_width) ** 2 + 0.009 * np.sin(xx * 17 + i * 1.7)
    yy += 0.007 * np.sin(xx * 37 + i * 0.9)
    stroke(mature, np.column_stack([xx, yy]), width, depth)
    stroke(fine, np.column_stack([xx[5:-4], yy[5:-4] + 0.016]), 0.0022, 0.00024)

for side in [-1, 1]:
    # Glabella folds follow the vertical brow compression, with unequal lengths.
    yy = np.linspace(0.33, 0.53 if side == 1 else 0.49, 22)
    xx = side * (0.041 + 0.014 * np.sin((yy - 0.33) * 15))
    stroke(mature, np.column_stack([xx, yy]), 0.0042, 0.0037)

    # Under-eye arcs follow the lower lid rather than crossing the cheek.
    for i in range(4):
        t = np.linspace(-1, 1, 28)
        xx = side * (0.315 + t * (0.135 + i * 0.013))
        yy = 0.175 - i * 0.024 - (0.035 + i * 0.004) * (1 - t * t)
        yy += 0.0028 * np.sin(t * 13 + i * 2 + side)
        stroke(fine if i < 2 else mature, np.column_stack([xx, yy]),
               0.0028 if i < 2 else 0.0034, 0.00065 if i < 2 else 0.0017)

    # Short crow's-feet, with individually curved and tapered ends.
    for i in range(5):
        t = np.linspace(0, 1, 25)
        xx = side * (0.45 + t * (0.13 + 0.022 * (i % 2)))
        yy = 0.23 + t * (0.077 - i * 0.036) - t * t * 0.022
        yy += 0.002 * np.sin(t * 14 + i + side)
        stroke(mature, np.column_stack([xx, yy]), 0.0028 + i * 0.0002, 0.0019)

    # Nasolabial fold: curls around the mouth; it never cuts through the lip.
    t = np.linspace(0, 1, 45)
    xx = side * (0.115 + 0.20 * t - 0.060 * t * t)
    yy = -0.035 - 0.37 * t
    stroke(mature, np.column_stack([xx, yy]), 0.0090, 0.0043, ridge=0.25)
    xx = side * (0.238 + 0.016 * np.sin(t * 3))
    yy = -0.36 - t * 0.17
    stroke(mature, np.column_stack([xx, yy]), 0.0055, 0.0020)

    # Fine oblique cheek creases, irregular and sparse rather than a grid.
    for i in range(14):
        t = np.linspace(0, 1, 14)
        anchor_x = 0.36 + (i % 4) * 0.042
        anchor_y = 0.025 - (i // 4) * 0.073 + 0.011 * math.sin(i * 3.1)
        xx = side * (anchor_x + t * (0.035 + 0.016 * math.sin(i)))
        yy = anchor_y - t * 0.018 + 0.002 * np.sin(t * 9 + i)
        stroke(mature, np.column_stack([xx, yy]), 0.0017, 0.00072)

# Lip vermilion: short vertical creases and gentle branching near the border.
for i in range(29):
    cx = -0.19 + i * 0.0136 + 0.0018 * math.sin(i * 7)
    span = 0.035 * math.sqrt(max(0.01, 1 - (cx / 0.205) ** 2))
    yy = np.linspace(-0.31 - span, -0.285 + span * 0.8, 16)
    xx = cx + 0.0024 * np.sin((yy + 0.3) * 95 + i * 1.3)
    stroke(fine, np.column_stack([xx, yy]), 0.0014 + (i % 3) * 0.0003, 0.00060)

# Neck creases are gentle curved folds, separate from cast shadows.
for i in range(2):
    xx = np.linspace(-0.32, 0.32, 35)
    yy = -0.95 - i * 0.22 + 0.065 * (xx / 0.32) ** 2
    stroke(mature, np.column_stack([xx, yy]), 0.006, 0.0015)


def save_image(name, array, float_buffer=False):
    assert np.isfinite(array).all(), f'Non-finite surface values in {name}'
    image = bpy.data.images.new(name, width=array.shape[1], height=array.shape[0], alpha=True, float_buffer=float_buffer)
    image.colorspace_settings.name = 'Non-Color'
    image.pixels.foreach_set(np.ascontiguousarray(array, dtype=np.float32).ravel())
    image.file_format = 'OPEN_EXR' if float_buffer else 'PNG'
    image.filepath_raw = str(OUT / name)
    image.save()
    return image


def encode(field, name):
    gy, gx = np.gradient(field, (y1 - y0) / (RES - 1), (x1 - x0) / (RES - 1))
    data = np.ones((RES, RES, 4), dtype=np.float32)
    data[:, :, 0] = 0.5 - np.clip(gx, -1, 1) * 0.5
    data[:, :, 1] = 0.5 - np.clip(gy, -1, 1) * 0.5
    data[:, :, 2] = np.clip(-field / 0.006, 0, 1)
    # Keep alpha opaque: browser image decoding must not premultiply data RGB.
    return save_image(name, data)


encode(fine, 'anatomy-fine-v1.png')
encode(mature, 'anatomy-age-v1.png')
metadata = {'bounds': list(BOUNDS), 'resolution': RES,
            'channels': {'r': 'negative dHeight/dX, encoded 0..1', 'g': 'negative dHeight/dY, encoded 0..1',
                         'b': 'crease depth / 0.006 model units', 'a': 'opaque'},
            'coordinates': 'original head Y-up positions; image bottom = y minimum',
            'source': 'Original authored curved surface fields; cosmetic, not a subject scan.'}
(OUT / 'anatomy-v1.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')

# A native Blender study of the same surface fields, with editable modifiers.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(ROOT / 'assets/models/base/head.glb'))
head = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
bpy.context.view_layer.objects.active = head
head.select_set(True)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
head.name = 'Skin study - original head topology'
sub = head.modifiers.new('Surface subdivision', 'SUBSURF')
sub.levels = sub.render_levels = 1
bpy.ops.object.modifier_apply(modifier=sub.name)
head.shape_key_add(name='Basis')
sculpt = head.shape_key_add(name='Mature crease study')


def sample(field, px, py):
    u = np.clip((px - x0) / (x1 - x0) * (RES - 1), 0, RES - 1.001)
    v = np.clip((py - y0) / (y1 - y0) * (RES - 1), 0, RES - 1.001)
    ix, iy = int(u), int(v)
    tx, ty = u - ix, v - iy
    return float((field[iy, ix] * (1 - tx) + field[iy, ix + 1] * tx) * (1 - ty)
                 + (field[iy + 1, ix] * (1 - tx) + field[iy + 1, ix + 1] * tx) * ty)


for v in head.data.vertices:
    # glTF Y-up becomes Blender Z-up on import.
    px, py, pz = v.co.x, v.co.z, -v.co.y
    front = max(0, min(1, (pz - 0.05) / 0.5))
    amount = (sample(fine, px, py) + sample(mature, px, py) * 0.5) * front
    sculpt.data[v.index].co = v.co + v.normal * amount
sculpt.value = 1.0
for poly in head.data.polygons:
    poly.use_smooth = True
mat = bpy.data.materials.new('Skin - editable surface study')
mat.use_nodes = True
bsdf = mat.node_tree.nodes.get('Principled BSDF')
bsdf.inputs['Base Color'].default_value = (0.43, 0.255, 0.18, 1)
bsdf.inputs['Roughness'].default_value = 0.62
bsdf.inputs['Subsurface Weight'].default_value = 0.08
bsdf.inputs['Subsurface Scale'].default_value = 0.025
bsdf.inputs['Subsurface Radius'].default_value = (1.0, 0.4, 0.2)
# The same original pore source is packed into this editable native material.
# Object-space box projection avoids stretching the nose's small UV island.
nodes, links = mat.node_tree.nodes, mat.node_tree.links
coords = nodes.new('ShaderNodeTexCoord')
coords.location = (-850, 0)
scale = nodes.new('ShaderNodeVectorMath')
scale.operation = 'SCALE'
scale.inputs[3].default_value = 1 / 0.48
scale.location = (-650, 0)
links.new(coords.outputs['Object'], scale.inputs[0])
pore = nodes.new('ShaderNodeTexImage')
pore.name = 'Original cheek pores - 48mm tile'
pore.image = bpy.data.images.load(str(OUT / 'cheek-skin-v2.png'))
pore.image.pack()
pore.projection = 'BOX'
pore.projection_blend = 0.35
pore.extension = 'REPEAT'
pore.location = (-450, 0)
links.new(scale.outputs['Vector'], pore.inputs['Vector'])
bump = nodes.new('ShaderNodeBump')
bump.inputs['Strength'].default_value = 0.35
bump.inputs['Distance'].default_value = 0.015
bump.location = (-160, -150)
links.new(pore.outputs['Color'], bump.inputs['Height'])
# Preserve narrow creases between mesh vertices using the full-resolution
# height field as a bump layer, in addition to the editable shape key.
height_data = np.ones((RES, RES, 4), dtype=np.float32)
height_data[:, :, :3] = (0.5 + (fine + mature * 0.5) / 0.025)[:, :, None]
height_image = bpy.data.images.new('Authored anatomy height - packed', width=RES, height=RES, alpha=True, float_buffer=True)
height_image.colorspace_settings.name = 'Non-Color'
height_image.pixels.foreach_set(height_data.ravel())
height_image.pack()
split = nodes.new('ShaderNodeSeparateXYZ')
links.new(coords.outputs['Object'], split.inputs[0])
xy = nodes.new('ShaderNodeCombineXYZ')
links.new(split.outputs['X'], xy.inputs['X'])
links.new(split.outputs['Z'], xy.inputs['Y'])
uv_scale = nodes.new('ShaderNodeVectorMath')
uv_scale.operation = 'MULTIPLY'
uv_scale.inputs[1].default_value = (1 / (x1 - x0), 1 / (y1 - y0), 1)
links.new(xy.outputs[0], uv_scale.inputs[0])
uv_offset = nodes.new('ShaderNodeVectorMath')
uv_offset.operation = 'ADD'
uv_offset.inputs[1].default_value = (-x0 / (x1 - x0), -y0 / (y1 - y0), 0)
links.new(uv_scale.outputs[0], uv_offset.inputs[0])
height_tex = nodes.new('ShaderNodeTexImage')
height_tex.image = height_image
height_tex.extension = 'EXTEND'
links.new(uv_offset.outputs[0], height_tex.inputs['Vector'])
front = nodes.new('ShaderNodeMapRange')
front.inputs['From Min'].default_value = -0.10
front.inputs['From Max'].default_value = -0.60
front.clamp = True
links.new(split.outputs['Y'], front.inputs['Value'])
height_mask = nodes.new('ShaderNodeMixRGB')
height_mask.inputs[1].default_value = (0.5, 0.5, 0.5, 1)
links.new(front.outputs[0], height_mask.inputs[0])
links.new(height_tex.outputs['Color'], height_mask.inputs[2])
crease_bump = nodes.new('ShaderNodeBump')
crease_bump.inputs['Strength'].default_value = 1
crease_bump.inputs['Distance'].default_value = 0.025
links.new(height_mask.outputs[0], crease_bump.inputs['Height'])
links.new(bump.outputs['Normal'], crease_bump.inputs['Normal'])
links.new(crease_bump.outputs['Normal'], bsdf.inputs['Normal'])
for i, node in enumerate([split, xy, uv_scale, uv_offset, height_tex, front, height_mask, crease_bump]):
    node.location = (-1200 + (i % 4) * 250, -500 - (i // 4) * 300)
colour = nodes.new('ShaderNodeMixRGB')
colour.blend_type = 'MULTIPLY'
colour.inputs[0].default_value = 0.20
colour.inputs[1].default_value = (0.48, 0.29, 0.205, 1)
colour.location = (-150, 180)
links.new(pore.outputs['Color'], colour.inputs[2])
links.new(colour.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.location = (80, 100)
head.data.materials.clear()
head.data.materials.append(mat)
mat['note'] = 'Creases are authored geometry in the shape key. Runtime maps share the same height fields. Packed pore image with editable box projection and bump; the web shader is a separate implementation.'
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.world.color = (0.12, 0.12, 0.12)
for name, location, energy, size in [('Key', (2.5, -4, 4), 350, 3), ('Fill', (-3, -2, 1.5), 140, 3)]:
    data = bpy.data.lights.new(name, 'AREA')
    data.energy, data.shape, data.size = energy, 'DISK', size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector((0, 0, 0)) - obj.location).to_track_quat('-Z', 'Y').to_euler()
bpy.ops.object.camera_add(location=(0, -5.5, 0.15))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, 0.1)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.lens = 60
scene.camera = camera
scene.render.resolution_x = scene.render.resolution_y = 1024
scene.render.resolution_percentage = 100
bpy.ops.wm.save_as_mainfile(filepath=str(STUDY / 'skin-surface-v1.blend'))
print('SKIN_SURFACE_BUILT', json.dumps(metadata))
