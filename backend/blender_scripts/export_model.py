"""Blender script that combines the morphed face, hair, beard, eyebrows, eyes and eyelashes into one exported model, aligned by bounding boxes."""

import bpy
import json
import sys
import os
import math
import mathutils

# Enable GLTF addon
try:
    bpy.ops.preferences.addon_enable(module='io_scene_gltf2')
except Exception:
    pass


def get_args():
    """Reads the JSON arguments file passed after '--' on the Blender command line."""
    argv = sys.argv
    if '--' in argv:
        args_file = argv[argv.index('--') + 1]
        with open(args_file, 'r') as f:
            return json.load(f)
    return {}


def clear_scene():
    """Removes every object and orphaned mesh from the scene."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        if block.users == 0:
            bpy.data.materials.remove(block)


def hex_to_rgb(hex_color):
    """Converts a hex colour to RGB floats, with a skin-tone fallback."""
    if not hex_color:
        return (0.83, 0.65, 0.46)
    hex_color = hex_color.lstrip('#')
    if len(hex_color) != 6:
        return (0.83, 0.65, 0.46)
    return tuple(int(hex_color[i:i+2], 16) / 255.0 for i in (0, 2, 4))


def create_skin_material(skin_color='#d4a574'):
    """Creates the skin material."""
    r, g, b = hex_to_rgb(skin_color)
    mat = bpy.data.materials.new(name="SkinMaterial")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    principled = nodes.get('Principled BSDF')
    if principled:
        principled.inputs['Base Color'].default_value = (r, g, b, 1.0)
        principled.inputs['Subsurface Weight'].default_value = 0.3
        principled.inputs['Subsurface Radius'].default_value = (1.0, 0.2, 0.1)
        principled.inputs['Roughness'].default_value = 0.5
    return mat


def create_hair_material(color='#2c1b0e', name='HairMaterial'):
    """Creates a hair material in the given colour."""
    r, g, b = hex_to_rgb(color)
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    for node in nodes:
        nodes.remove(node)
    output = nodes.new('ShaderNodeOutputMaterial')
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = (r, g, b, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.55
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])
    return mat


def create_eye_material(color='#634e34', name='EyeMaterial'):
    """Creates an eye material in the given colour."""
    r, g, b = hex_to_rgb(color)
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    principled = nodes.get('Principled BSDF')
    if principled:
        principled.inputs['Base Color'].default_value = (r, g, b, 1.0)
        principled.inputs['Roughness'].default_value = 0.3
    return mat


def import_glb(filepath):
    """Imports a GLB file and returns the new objects."""
    if not os.path.exists(filepath):
        print(f"[Export] GLB not found: {filepath}")
        return []
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=filepath)
    except Exception as e:
        print(f"[Export] GLTF import failed: {e}")
        return []
    return list(set(bpy.data.objects) - before)


def import_obj(filepath):
    """Imports an OBJ file and returns the new objects."""
    if not os.path.exists(filepath):
        print(f"[Export] OBJ not found: {filepath}")
        return []
    before = set(bpy.data.objects)
    try:
        bpy.ops.wm.obj_import(filepath=filepath)
    except Exception as e:
        print(f"[Export] OBJ import failed: {e}")
        return []
    return list(set(bpy.data.objects) - before)


def get_bbox(objects):
    """Returns the world-space bounding box of some objects."""
    min_co = [1e9, 1e9, 1e9]
    max_co = [-1e9, -1e9, -1e9]
    for obj in objects:
        if obj.type != 'MESH':
            continue
        for v in obj.bound_box:
            world_v = obj.matrix_world @ mathutils.Vector(v)
            for i in range(3):
                min_co[i] = min(min_co[i], world_v[i])
                max_co[i] = max(max_co[i], world_v[i])
    if min_co[0] > 1e8:
        return None
    return {
        'min': min_co,
        'max': max_co,
        'center': [(min_co[i] + max_co[i]) / 2 for i in range(3)],
        'size': [max_co[i] - min_co[i] for i in range(3)],
    }


def process_glb_import(glb_objects, mesh_filter=None, material=None):
    """Keeps only the meshes from a GLB import, removes the empties and applies a material."""
    kept = []
    empties = []
    for obj in list(glb_objects):
        if obj.type == 'MESH':
            if mesh_filter and mesh_filter not in obj.name.lower():
                bpy.data.objects.remove(obj, do_unlink=True)
                continue
            if material:
                obj.data.materials.clear()
                obj.data.materials.append(material)
            for poly in obj.data.polygons:
                poly.use_smooth = True
            kept.append(obj)
        elif obj.type == 'EMPTY':
            empties.append(obj)

    # Clear parents and preserve world transform
    for obj in kept:
        if obj.parent:
            mat = obj.matrix_world.copy()
            obj.parent = None
            obj.matrix_world = mat

    # Remove empties
    for emp in empties:
        try:
            bpy.data.objects.remove(emp, do_unlink=True)
        except:
            pass

    return kept


def align_hair_to_head(hair_objects, head_bbox, hair_params=None):
    """Fits the hair to the head the same way the app's HairSystem does."""
    if not hair_objects or not head_bbox:
        return

    hair_bbox = get_bbox(hair_objects)
    if not hair_bbox:
        return

    # Head metrics
    head_cx = head_bbox['center'][0]
    head_cy = head_bbox['center'][1]
    head_top = head_bbox['max'][2]  # Z is up in Blender
    head_width = head_bbox['size'][0]
    head_height = head_bbox['size'][2]

    # Hair metrics
    hair_cx = hair_bbox['center'][0]
    hair_cy = hair_bbox['center'][1]
    hair_cz = hair_bbox['center'][2]
    hair_sx = hair_bbox['size'][0]
    hair_sy = hair_bbox['size'][1]
    hair_sz = hair_bbox['size'][2]

    # Get adjustment params (default to 50 = neutral)
    params = hair_params or {}
    length_f = params.get('length', 50)
    volume_f = params.get('volume', 50)
    scale_f = params.get('scale', 50)
    posx = params.get('posx', 50)
    posy = params.get('posy', 50)
    posz = params.get('posz', 50)

    # Calculate scale factors (same as Three.js)
    baseScale = head_width / max(hair_sx, hair_sy, 0.001)
    lengthF = 0.7 + (length_f / 100) * 0.6
    volumeF = 0.7 + (volume_f / 100) * 0.6
    scaleF = 0.3 + (scale_f / 100) * 1.7

    # Final scale
    sx = baseScale * volumeF * scaleF
    sy = baseScale * volumeF * scaleF
    sz = baseScale * lengthF * scaleF

    # Position offsets (±0.8 world units range)
    posOffX = ((posx - 50) / 50) * 0.8
    posOffY = ((posy - 50) / 50) * 0.8  # Up/down
    posOffZ = ((posz - 50) / 50) * 0.8  # Forward/back

    # Scalp position (slightly below head top)
    scalpZ = head_top - head_height * 0.12

    # Target position
    tx = head_cx + posOffX
    ty = head_cy - posOffZ  # Forward is -Y in Blender
    tz = scalpZ + posOffY

    # Offset to center hair (move hair center to origin before scaling)
    off_x = -hair_cx
    off_y = -hair_cy
    off_z = -hair_cz

    print(f"[Export] Hair align: baseScale={baseScale:.3f}, scale=({sx:.3f}, {sy:.3f}, {sz:.3f})")
    print(f"[Export] Hair target: ({tx:.3f}, {ty:.3f}, {tz:.3f})")

    # Create container empty for transform hierarchy
    container = bpy.data.objects.new("HairContainer", None)
    bpy.context.scene.collection.objects.link(container)
    container.location = (tx, ty, tz)
    container.scale = (sx, sy, sz)

    # Create offset empty
    offset_empty = bpy.data.objects.new("HairOffset", None)
    bpy.context.scene.collection.objects.link(offset_empty)
    offset_empty.parent = container
    offset_empty.location = (off_x, off_y, off_z)

    # Parent hair meshes to offset
    for obj in hair_objects:
        obj.parent = offset_empty
        obj.matrix_parent_inverse.identity()


def align_beard_to_head(beard_objects, head_bbox, beard_params=None):
    """Fits the beard to the lower face."""
    if not beard_objects or not head_bbox:
        return

    beard_bbox = get_bbox(beard_objects)
    if not beard_bbox:
        return

    # Head metrics
    head_cx = head_bbox['center'][0]
    head_cy = head_bbox['center'][1]
    head_cz = head_bbox['center'][2]
    head_front = head_bbox['max'][1]
    head_width = head_bbox['size'][0]
    head_height = head_bbox['size'][2]

    # Beard metrics
    beard_cx = beard_bbox['center'][0]
    beard_cy = beard_bbox['center'][1]
    beard_cz = beard_bbox['center'][2]
    beard_sx = beard_bbox['size'][0]
    beard_sy = beard_bbox['size'][1]

    # Get params
    params = beard_params or {}
    scale_f = params.get('scale', 50)
    posx = params.get('posx', 50)
    posy = params.get('posy', 50)
    posz = params.get('posz', 50)

    # Scale to fit face width
    baseScale = (head_width * 0.85) / max(beard_sx, 0.001)
    scaleF = 0.5 + (scale_f / 100) * 1.0
    s = baseScale * scaleF

    # Position offsets
    posOffX = ((posx - 50) / 50) * 0.3
    posOffY = ((posy - 50) / 50) * 0.3
    posOffZ = ((posz - 50) / 50) * 0.3

    # Target: lower face, front
    tx = head_cx + posOffX
    ty = head_front - 0.05 + posOffZ
    tz = head_cz - head_height * 0.25 + posOffY

    print(f"[Export] Beard align: scale={s:.3f}, target=({tx:.3f}, {ty:.3f}, {tz:.3f})")

    # Create container
    container = bpy.data.objects.new("BeardContainer", None)
    bpy.context.scene.collection.objects.link(container)
    container.location = (tx, ty, tz)
    container.scale = (s, s, s)

    # Offset
    offset_empty = bpy.data.objects.new("BeardOffset", None)
    bpy.context.scene.collection.objects.link(offset_empty)
    offset_empty.parent = container
    offset_empty.location = (-beard_cx, -beard_cy, -beard_cz)

    for obj in beard_objects:
        obj.parent = offset_empty
        obj.matrix_parent_inverse.identity()


def align_eyebrows_to_head(eyebrow_objects, head_bbox, eyebrow_params=None):
    """Fits the eyebrows to the brow area, matching the app's placement."""
    if not eyebrow_objects or not head_bbox:
        return

    eb_bbox = get_bbox(eyebrow_objects)
    if not eb_bbox:
        return

    # Head metrics
    head_cx = head_bbox['center'][0]
    head_bottom = head_bbox['min'][2]
    head_front = head_bbox['max'][1]
    head_width = head_bbox['size'][0]
    head_height = head_bbox['size'][2]
    head_depth = head_bbox['size'][1]

    # Eyebrow model metrics
    eb_cx = eb_bbox['center'][0]
    eb_cy = eb_bbox['center'][1]
    eb_cz = eb_bbox['center'][2]
    eb_sx = eb_bbox['size'][0]

    params = eyebrow_params or {}
    scale_f = params.get('scale', 50)
    thickness_f = params.get('thickness', 50)
    posX = params.get('posX', 50)
    posY = params.get('posY', 50)
    posZ = params.get('posZ', 50)

    # Match the app's brow width of 0.90, relative to the head width.
    browRegionWidth = head_width * 0.47  # 0.90 / ~1.9 head width
    baseScale = browRegionWidth / max(eb_sx, 0.001)
    scaleF = 0.5 + (scale_f / 100) * 1.0
    thicknessF = 0.5 + (thickness_f / 100) * 1.0

    # Position offsets (±0.3 range in frontend)
    posOffX = ((posX - 50) / 50) * 0.3
    posOffY = ((posY - 50) / 50) * 0.3
    posOffZ = ((posZ - 50) / 50) * 0.3

    # Target position: about 73% up the head and just behind the front surface.
    tx = head_cx + posOffX
    ty = head_front - head_depth * 0.08 + posOffZ  # Slightly behind front surface
    tz = head_bottom + head_height * 0.73 + posOffY  # Upper face area (73% up)

    print(f"[Export] Eyebrow align: baseScale={baseScale:.3f}, scaleF={scaleF:.3f}")
    print(f"[Export] Eyebrow target: ({tx:.3f}, {ty:.3f}, {tz:.3f})")

    container = bpy.data.objects.new("EyebrowContainer", None)
    bpy.context.scene.collection.objects.link(container)
    container.location = (tx, ty, tz)
    container.scale = (baseScale * scaleF, baseScale * scaleF, baseScale * thicknessF)
    # Rotate 180° around Z to flip orientation (like frontend's Math.PI + rotY)
    container.rotation_euler = (0, 0, math.pi)

    offset_empty = bpy.data.objects.new("EyebrowOffset", None)
    bpy.context.scene.collection.objects.link(offset_empty)
    offset_empty.parent = container
    offset_empty.location = (-eb_cx, -eb_cy, -eb_cz)

    for obj in eyebrow_objects:
        obj.parent = offset_empty
        obj.matrix_parent_inverse.identity()


def align_eyes_to_head(left_eye_objects, right_eye_objects, head_bbox, eye_params=None):
    """Places the eyes in the eye sockets, matching the app's EyeSystem."""
    if not head_bbox:
        return

    # Head metrics
    head_cx = head_bbox['center'][0]
    head_bottom = head_bbox['min'][2]
    head_front = head_bbox['max'][1]
    head_width = head_bbox['size'][0]
    head_height = head_bbox['size'][2]
    head_depth = head_bbox['size'][1]

    params = eye_params or {}
    scale_f = params.get('scale', 50)
    spacing_f = params.get('spacing', 50)
    posX = params.get('posX', 50)
    posY = params.get('posY', 50)
    posZ = params.get('posZ', 50)

    # Scale factor (eye scale is small - around 0.15 base in frontend)
    scaleF = 0.7 + (scale_f / 100) * 0.6
    eye_scale = 0.15 * scaleF

    # Eye spacing from the centre, as in the app.
    eyeOffsetX = head_width * 0.16 * (0.8 + (spacing_f / 100) * 0.4)

    # Position offsets
    posOffX = ((posX - 50) / 50) * 0.15
    posOffY = ((posY - 50) / 50) * 0.15
    posOffZ = ((posZ - 50) / 50) * 0.15

    # Eyes sit slightly behind the front of the face, 57% up the head.
    eye_y = head_front - head_depth * 0.12 + posOffZ
    eye_z = head_bottom + head_height * 0.57 + posOffY

    # Left eye
    if left_eye_objects:
        le_bbox = get_bbox(left_eye_objects)
        if le_bbox:
            le_cx, le_cy, le_cz = le_bbox['center']

            tx = head_cx - eyeOffsetX + posOffX
            ty = eye_y
            tz = eye_z

            print(f"[Export] Left eye: scale={eye_scale:.3f}, pos=({tx:.3f}, {ty:.3f}, {tz:.3f})")

            container = bpy.data.objects.new("LeftEyeContainer", None)
            bpy.context.scene.collection.objects.link(container)
            container.location = (tx, ty, tz)
            container.scale = (eye_scale, eye_scale, eye_scale)

            offset = bpy.data.objects.new("LeftEyeOffset", None)
            bpy.context.scene.collection.objects.link(offset)
            offset.parent = container
            offset.location = (-le_cx, -le_cy, -le_cz)

            for obj in left_eye_objects:
                obj.parent = offset
                obj.matrix_parent_inverse.identity()

    # Right eye
    if right_eye_objects:
        re_bbox = get_bbox(right_eye_objects)
        if re_bbox:
            re_cx, re_cy, re_cz = re_bbox['center']

            tx = head_cx + eyeOffsetX + posOffX
            ty = eye_y
            tz = eye_z

            print(f"[Export] Right eye: scale={eye_scale:.3f}, pos=({tx:.3f}, {ty:.3f}, {tz:.3f})")

            container = bpy.data.objects.new("RightEyeContainer", None)
            bpy.context.scene.collection.objects.link(container)
            container.location = (tx, ty, tz)
            container.scale = (eye_scale, eye_scale, eye_scale)

            offset = bpy.data.objects.new("RightEyeOffset", None)
            bpy.context.scene.collection.objects.link(offset)
            offset.parent = container
            offset.location = (-re_cx, -re_cy, -re_cz)

            for obj in right_eye_objects:
                obj.parent = offset
                obj.matrix_parent_inverse.identity()


def align_eyelashes_to_head(eyelash_objects, head_bbox, eyelash_params=None):
    """Fits the eyelashes around the eyes, a little below and in front of the brows."""
    if not eyelash_objects or not head_bbox:
        return

    lash_bbox = get_bbox(eyelash_objects)
    if not lash_bbox:
        return

    # Head metrics
    head_cx = head_bbox['center'][0]
    head_bottom = head_bbox['min'][2]
    head_front = head_bbox['max'][1]
    head_width = head_bbox['size'][0]
    head_height = head_bbox['size'][2]
    head_depth = head_bbox['size'][1]

    # Eyelash model metrics
    lash_cx = lash_bbox['center'][0]
    lash_cy = lash_bbox['center'][1]
    lash_cz = lash_bbox['center'][2]
    lash_sx = lash_bbox['size'][0]

    params = eyelash_params or {}
    scale_f = params.get('scale', 50)
    thickness_f = params.get('thickness', 50)
    posX = params.get('posX', 50)
    posY = params.get('posY', 50)
    posZ = params.get('posZ', 50)

    # Frontend uses lashRegionWidth=0.90 (similar to eyebrows)
    lashRegionWidth = head_width * 0.47  # 0.90 / ~1.9 head width
    baseScale = lashRegionWidth / max(lash_sx, 0.001)
    scaleF = 0.5 + (scale_f / 100) * 1.0
    thicknessF = 1.0 + ((thickness_f - 50) / 50) * 0.5

    # Position offsets
    posOffX = ((posX - 50) / 50) * 0.3
    posOffY = ((posY - 50) / 50) * 0.3
    posOffZ = ((posZ - 50) / 50) * 0.3

    # Target position: slightly below the eyebrows and a little further forward.
    tx = head_cx + posOffX
    ty = head_front - head_depth * 0.06 + posOffZ  # Slightly more forward than brows
    tz = head_bottom + head_height * 0.69 + posOffY  # Eye level (69% up)

    print(f"[Export] Eyelash align: baseScale={baseScale:.3f}, scaleF={scaleF:.3f}")
    print(f"[Export] Eyelash target: ({tx:.3f}, {ty:.3f}, {tz:.3f})")

    container = bpy.data.objects.new("EyelashContainer", None)
    bpy.context.scene.collection.objects.link(container)
    container.location = (tx, ty, tz)
    container.scale = (baseScale * scaleF, baseScale * thicknessF, baseScale * scaleF)
    # Rotate -90° around X to curve lashes upward (like frontend's BASE_ROT_X = -π/2)
    container.rotation_euler = (-math.pi / 2, 0, 0)

    offset = bpy.data.objects.new("EyelashOffset", None)
    bpy.context.scene.collection.objects.link(offset)
    offset.parent = container
    offset.location = (-lash_cx, -lash_cy, -lash_cz)

    for obj in eyelash_objects:
        obj.parent = offset
        obj.matrix_parent_inverse.identity()


def main():
    """Imports the head and every feature, fits them together and exports the combined model."""
    args = get_args()
    print("[Export] ========== EXPORT STARTED ==========")

    export_format = args.get('format', 'obj')
    output_path = args.get('output_path', '').replace('/', os.sep)
    morphed_mesh_path = args.get('morphed_mesh_path', '').replace('/', os.sep)
    base_model = args.get('base_model', '').replace('/', os.sep)
    models_dir = args.get('models_dir', '').replace('/', os.sep)

    # Appearance params
    hair_style = args.get('hairStyle', 'bald')
    hair_color = args.get('hairColor', '#2c1b0e')
    beard_style = args.get('beardStyle', 'none')
    beard_color = args.get('beardColor', '#2c1b0e')
    eyebrow_color = args.get('eyebrowColor', '#2c1b0e')
    eye_state = args.get('eyeState', {})
    eye_color = eye_state.get('color', '#634e34') if eye_state else '#634e34'
    skin_color = args.get('skinColor', '#d4a574')

    # Params from frontend (for fine-tuning positioning)
    hair_transform = args.get('hairTransform', {})
    beard_transform = args.get('beardTransform', {})
    eyebrow_transform = args.get('eyebrowTransform', {})
    eye_transforms = args.get('eyeTransforms', {})
    eyelash_transforms = args.get('eyelashTransforms', {})

    # Extract params (not matrices - we use bbox-based alignment)
    hair_params = hair_transform.get('rawParams', {}) if hair_transform else {}
    beard_params = beard_transform.get('params', {}) if beard_transform else {}
    eyebrow_params = eyebrow_transform.get('params', {}) if eyebrow_transform else {}
    eye_params = eye_transforms.get('params', {}) if eye_transforms else {}
    eyelash_params = eyelash_transforms.get('params', {}) if eyelash_transforms else {}

    print(f"[Export] Format: {export_format}, Hair: {hair_style}, Beard: {beard_style}")
    print(f"[Export] Skin: {skin_color}, Hair color: {hair_color}")

    clear_scene()
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # --- Import Head ---
    print("[Export] Importing head...")
    head_objects = []
    if morphed_mesh_path and os.path.exists(morphed_mesh_path):
        print(f"[Export] Using morphed mesh: {morphed_mesh_path}")
        head_objects = import_obj(morphed_mesh_path)
    elif base_model and os.path.exists(base_model):
        print(f"[Export] Using base model: {base_model}")
        head_objects = import_obj(base_model)

    # Apply skin material
    skin_mat = create_skin_material(skin_color)
    for obj in head_objects:
        if obj.type == 'MESH':
            obj.data.materials.clear()
            obj.data.materials.append(skin_mat)
            for poly in obj.data.polygons:
                poly.use_smooth = True

    # Get head bounding box for positioning all assets
    head_bbox = get_bbox(head_objects)
    if head_bbox:
        print(f"[Export] Head bbox: center=({head_bbox['center'][0]:.2f}, {head_bbox['center'][1]:.2f}, {head_bbox['center'][2]:.2f})")
        print(f"[Export] Head size: ({head_bbox['size'][0]:.2f}, {head_bbox['size'][1]:.2f}, {head_bbox['size'][2]:.2f})")
    else:
        print("[Export] WARNING: Could not compute head bounding box")

    # --- Hair ---
    hair_map = {f'hair{i}': f'Hair{i}.glb' for i in range(1, 13)}
    hair_filter = {'hair3': 'hair02', 'hair4': 'hair11'}

    print(f"[Export] Importing hair ({hair_style})...")
    if hair_style and hair_style != 'bald' and hair_style in hair_map:
        hair_path = os.path.join(models_dir, 'hair', hair_map[hair_style])
        if os.path.exists(hair_path):
            hair_objs = import_glb(hair_path)
            hair_mat = create_hair_material(hair_color, 'HairMat')
            kept_hair = process_glb_import(hair_objs, hair_filter.get(hair_style), hair_mat)

            if kept_hair and head_bbox:
                align_hair_to_head(kept_hair, head_bbox, hair_params)
                print(f"[Export] Hair: {len(kept_hair)} meshes aligned")
        else:
            print(f"[Export] Hair file not found: {hair_path}")

    # --- Beard ---
    print(f"[Export] Importing beard ({beard_style})...")
    if beard_style and beard_style != 'none':
        beard_path = os.path.join(models_dir, 'facial', 'Beard1.glb')
        if os.path.exists(beard_path):
            beard_objs = import_glb(beard_path)
            beard_mat = create_hair_material(beard_color, 'BeardMat')
            kept_beard = process_glb_import(beard_objs, None, beard_mat)

            if kept_beard and head_bbox:
                align_beard_to_head(kept_beard, head_bbox, beard_params)
                print(f"[Export] Beard: {len(kept_beard)} meshes aligned")

    # --- Eyebrows ---
    print("[Export] Importing eyebrows...")
    eyebrow_path = os.path.join(models_dir, 'facial', 'eyebrows.glb')
    if os.path.exists(eyebrow_path):
        eb_objs = import_glb(eyebrow_path)
        eb_mat = create_hair_material(eyebrow_color, 'EyebrowMat')
        kept_eb = process_glb_import(eb_objs, None, eb_mat)

        if kept_eb and head_bbox:
            align_eyebrows_to_head(kept_eb, head_bbox, eyebrow_params)
            print(f"[Export] Eyebrows: {len(kept_eb)} meshes aligned")

    # --- Eyes ---
    print("[Export] Importing eyes...")
    eye_mat = create_eye_material(eye_color, 'EyeMat')

    # Left eye
    left_eye_objects = []
    eye_left_path = os.path.join(models_dir, 'facial', 'EyeLeft.glb')
    if os.path.exists(eye_left_path):
        el_objs = import_glb(eye_left_path)
        left_eye_objects = process_glb_import(el_objs, None, eye_mat)

    # Right eye
    right_eye_objects = []
    eye_right_path = os.path.join(models_dir, 'facial', 'EyeRight.glb')
    if os.path.exists(eye_right_path):
        er_objs = import_glb(eye_right_path)
        er_mat = create_eye_material(eye_color, 'EyeMatR')
        right_eye_objects = process_glb_import(er_objs, None, er_mat)

    if (left_eye_objects or right_eye_objects) and head_bbox:
        align_eyes_to_head(left_eye_objects, right_eye_objects, head_bbox, eye_params)
        print(f"[Export] Eyes: L={len(left_eye_objects)}, R={len(right_eye_objects)} meshes aligned")

    # --- Eyelashes ---
    print("[Export] Importing eyelashes...")
    eyelash_path = os.path.join(models_dir, 'facial', 'eyelashes.glb')
    if os.path.exists(eyelash_path):
        lash_objs = import_glb(eyelash_path)
        lash_mat = create_hair_material('#0a0a0a', 'LashMat')
        kept_lash = process_glb_import(lash_objs, None, lash_mat)

        if kept_lash and head_bbox:
            align_eyelashes_to_head(kept_lash, head_bbox, eyelash_params)
            print(f"[Export] Eyelashes: {len(kept_lash)} meshes aligned")

    # --- Summary ---
    print("[Export] Scene objects:")
    mesh_count = 0
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            loc = obj.matrix_world.translation
            print(f"  {obj.name}: world_loc=({loc.x:.2f}, {loc.y:.2f}, {loc.z:.2f})")
            mesh_count += 1
    print(f"[Export] Total meshes: {mesh_count}")

    # --- Export ---
    bpy.ops.object.select_all(action='SELECT')

    try:
        if export_format == 'obj':
            bpy.ops.wm.obj_export(filepath=output_path)
        elif export_format == 'fbx':
            bpy.ops.export_scene.fbx(filepath=output_path)
        elif export_format == 'glb':
            bpy.ops.export_scene.gltf(filepath=output_path, export_format='GLB')

        if os.path.exists(output_path):
            size = os.path.getsize(output_path)
            print(f"[Export] SUCCESS - {size} bytes")
            print(f'RESULT:{{"success": true, "format": "{export_format}", "output_path": "{output_path.replace(chr(92), "/")}", "file_size": {size}}}')
        else:
            print(f'RESULT:{{"error": "File not created"}}')
    except Exception as e:
        print(f'RESULT:{{"error": "{str(e)}"}}')


if __name__ == '__main__':
    main()
