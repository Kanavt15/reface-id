"""
Blender Script: Render Realistic Scene
Imports head.glb + selected hair GLB, applies materials, lighting,
and renders a high-quality image using Cycles or EEVEE.
"""

import bpy
import json
import sys
import os
import math
import mathutils


def get_args():
    argv = sys.argv
    if '--' in argv:
        args_file = argv[argv.index('--') + 1]
        with open(args_file, 'r') as f:
            return json.load(f)
    return {}


# Debug log file alongside this script
_DEBUG_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'renders', 'render_debug.log')

def dlog(msg):
    """Print and also write to a debug log file."""
    print(msg)
    try:
        with open(_DEBUG_LOG, 'a') as f:
            f.write(msg + '\n')
    except Exception:
        pass


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    # Clear orphan data
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        if block.users == 0:
            bpy.data.materials.remove(block)


def hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) / 255.0 for i in (0, 2, 4))


def create_skin_material(skin_color='#d4a574'):
    """Create a realistic skin material with SSS."""
    r, g, b = hex_to_rgb(skin_color)

    mat = bpy.data.materials.new(name="REface_Skin")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links

    # Clear default nodes
    for node in nodes:
        nodes.remove(node)

    # Output
    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (400, 0)

    # Principled BSDF
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (0, 0)
    bsdf.inputs['Base Color'].default_value = (r, g, b, 1.0)
    bsdf.inputs['Subsurface Weight'].default_value = 0.35
    bsdf.inputs['Subsurface Radius'].default_value = (1.0, 0.2, 0.1)
    bsdf.inputs['Roughness'].default_value = 0.45
    bsdf.inputs['Specular IOR Level'].default_value = 0.3

    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    return mat


def create_hair_material(hair_color='#2c1b0e'):
    """Create a realistic hair material."""
    r, g, b = hex_to_rgb(hair_color)

    mat = bpy.data.materials.new(name="REface_Hair")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links

    for node in nodes:
        nodes.remove(node)

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (400, 0)

    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (0, 0)
    bsdf.inputs['Base Color'].default_value = (r, g, b, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.55
    bsdf.inputs['Specular IOR Level'].default_value = 0.5
    # Slight anisotropy for hair sheen
    bsdf.inputs['Anisotropic'].default_value = 0.3

    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    return mat


def setup_studio_lighting():
    """Create a 3-point studio lighting setup."""
    # Key light (warm, strong)
    key = bpy.data.lights.new(name="KeyLight", type='AREA')
    key.energy = 200
    key.color = (1.0, 0.95, 0.9)
    key.size = 3
    key_obj = bpy.data.objects.new("KeyLight", key)
    bpy.context.collection.objects.link(key_obj)
    key_obj.location = (2.5, -2.5, 3.0)
    key_obj.rotation_euler = (math.radians(45), 0, math.radians(45))

    # Fill light (cooler, softer)
    fill = bpy.data.lights.new(name="FillLight", type='AREA')
    fill.energy = 80
    fill.color = (0.85, 0.9, 1.0)
    fill.size = 4
    fill_obj = bpy.data.objects.new("FillLight", fill)
    bpy.context.collection.objects.link(fill_obj)
    fill_obj.location = (-2.5, -1.5, 2.0)
    fill_obj.rotation_euler = (math.radians(40), 0, math.radians(-50))

    # Rim/back light
    rim = bpy.data.lights.new(name="RimLight", type='AREA')
    rim.energy = 120
    rim.color = (1.0, 1.0, 1.0)
    rim.size = 2
    rim_obj = bpy.data.objects.new("RimLight", rim)
    bpy.context.collection.objects.link(rim_obj)
    rim_obj.location = (0, 3.0, 2.5)
    rim_obj.rotation_euler = (math.radians(-45), 0, math.radians(180))

    # Environment light (subtle)
    world = bpy.data.worlds.new(name="REface_World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs['Color'].default_value = (0.15, 0.17, 0.2, 1.0)
        bg.inputs['Strength'].default_value = 0.3


def setup_camera():
    """Set up camera aimed at the head, auto-framed to scene content."""
    cam_data = bpy.data.cameras.new(name="RenderCam")
    cam_data.lens = 50  # Natural portrait lens
    cam_data.clip_start = 0.01
    cam_data.clip_end = 100

    cam_obj = bpy.data.objects.new("RenderCam", cam_data)
    bpy.context.collection.objects.link(cam_obj)

    # Calculate scene bounding box to frame properly
    min_co = [1e9, 1e9, 1e9]
    max_co = [-1e9, -1e9, -1e9]
    found_mesh = False
    for obj in bpy.data.objects:
        if obj.type != 'MESH':
            continue
        found_mesh = True
        bbox = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
        for v in bbox:
            for i in range(3):
                min_co[i] = min(min_co[i], v[i])
                max_co[i] = max(max_co[i], v[i])

    if found_mesh:
        center_x = (min_co[0] + max_co[0]) / 2
        center_y = (min_co[1] + max_co[1]) / 2
        center_z = (min_co[2] + max_co[2]) / 2
        size_x = max_co[0] - min_co[0]
        size_z = max_co[2] - min_co[2]
        max_extent = max(size_x, size_z, 1.0)

        # Distance to frame entire head+hair with generous padding
        fov = 2 * math.atan(cam_data.sensor_width / (2 * cam_data.lens))
        cam_dist = (max_extent * 1.0) / math.tan(fov / 2)
        cam_dist = max(cam_dist, 3.5)  # minimum distance

        cam_obj.location = (center_x, center_y - cam_dist, center_z + max_extent * 0.02)
    else:
        cam_obj.location = (0, -4.5, 0.5)

    # Look at the center of the scene
    cam_obj.rotation_euler = (math.radians(90), 0, 0)

    bpy.context.scene.camera = cam_obj
    return cam_obj


def configure_render(engine='EEVEE', quality='medium', output_path=''):
    """Configure render settings."""
    scene = bpy.context.scene

    # Quality presets
    quality_settings = {
        'preview': {'res_x': 960, 'res_y': 540, 'samples': 32, 'eevee_samples': 16},
        'medium':  {'res_x': 1920, 'res_y': 1080, 'samples': 64, 'eevee_samples': 32},
        'high':    {'res_x': 2560, 'res_y': 1440, 'samples': 128, 'eevee_samples': 64},
    }
    q = quality_settings.get(quality, quality_settings['medium'])

    scene.render.resolution_x = q['res_x']
    scene.render.resolution_y = q['res_y']
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.filepath = output_path
    scene.render.film_transparent = True  # Transparent background

    if engine == 'CYCLES':
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = q['samples']
        scene.cycles.use_denoising = True
        # Use GPU if available
        prefs = bpy.context.preferences.addons.get('cycles')
        if prefs:
            try:
                prefs.preferences.compute_device_type = 'CUDA'
                bpy.context.preferences.addons['cycles'].preferences.get_devices()
                for device in bpy.context.preferences.addons['cycles'].preferences.devices:
                    device.use = True
                scene.cycles.device = 'GPU'
            except Exception:
                scene.cycles.device = 'CPU'
    else:
        scene.render.engine = 'BLENDER_EEVEE_NEXT'
        scene.eevee.taa_render_samples = q['eevee_samples']
        # Enable screen space reflections and AO
        scene.eevee.use_gtao = True


def import_glb(filepath):
    """Import a GLB file and return imported objects."""
    print(f"import_glb: importing {filepath}")
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=filepath)
    except Exception as e:
        print(f"import_glb: GLTF import failed: {e}")
        return []
    after = set(bpy.data.objects)
    new_objects = after - before
    print(f"import_glb: got {len(new_objects)} new objects: {[o.name for o in new_objects]}")
    # Ensure all new objects are linked into the scene collection
    scene_col = bpy.context.scene.collection
    for obj in new_objects:
        if obj.name not in scene_col.objects:
            try:
                scene_col.objects.link(obj)
            except RuntimeError:
                pass  # already linked
    return list(new_objects)


def import_obj(filepath):
    """Import an OBJ file and return imported objects."""
    print(f"import_obj: importing {filepath}")
    before = set(bpy.data.objects)
    try:
        bpy.ops.wm.obj_import(filepath=filepath)
    except Exception as e:
        print(f"import_obj: OBJ import failed: {e}")
        return []
    after = set(bpy.data.objects)
    new_objects = after - before
    print(f"import_obj: got {len(new_objects)} new objects: {[o.name for o in new_objects]}")
    return list(new_objects)


def main():
    args = get_args()

    # Clear debug log
    try:
        with open(_DEBUG_LOG, 'w') as f:
            f.write('=== Blender Render Debug Log ===\n')
    except Exception:
        pass

    hair_style = args.get('hairStyle', 'hair1')
    hair_color = args.get('hairColor', '#2c1b0e')
    skin_color = args.get('skinColor', '#d4a574')
    engine = args.get('engine', 'EEVEE')
    quality = args.get('quality', 'medium')
    output_path = args.get('output_path', '')
    models_dir = args.get('models_dir', '')
    morphed_mesh_path = args.get('morphed_mesh_path', '')
    hair_transform = args.get('hairTransform', None)

    dlog(f"Args: hairStyle={hair_style}, models_dir={models_dir}")
    dlog(f"morphed_mesh_path={morphed_mesh_path}")
    dlog(f"hairTransform={json.dumps(hair_transform) if hair_transform else 'None'}")

    clear_scene()

    # --- Import Head ---
    # Prefer the morphed mesh (includes slider + manual edits from the editor)
    # Fall back to the base head.glb if no morphed mesh was provided.
    head_objects = []
    if morphed_mesh_path and os.path.exists(morphed_mesh_path):
        head_objects = import_obj(morphed_mesh_path)
        print(f"Using MORPHED head mesh: {morphed_mesh_path}")
    else:
        head_path = os.path.join(models_dir, 'head.glb')
        if os.path.exists(head_path):
            head_objects = import_glb(head_path)
            print(f"Using base head.glb")
        else:
            print(f"WARNING: No head model found")

    if head_objects:
        skin_mat = create_skin_material(skin_color)
        for obj in head_objects:
            if obj.type == 'MESH':
                obj.data.materials.clear()
                obj.data.materials.append(skin_mat)
                # Enable smooth shading
                for poly in obj.data.polygons:
                    poly.use_smooth = True
                # Auto-smooth normals for better rendering
                if hasattr(obj.data, 'use_auto_smooth'):
                    obj.data.use_auto_smooth = True
                    obj.data.auto_smooth_angle = math.radians(60)
        print(f"Head has {len(head_objects)} objects")

    # --- Import Hair ---
    hair_file_map = {f'hair{i}': f'Hair{i}.glb' for i in range(1, 13)}

    # Which mesh to use for multi-mesh models
    hair_mesh_filter = {
        'hair3': 'hair02',
        'hair4': 'hair11',
    }

    dlog(f"Hair style requested: '{hair_style}'")
    dlog(f"Hair transform from frontend: {json.dumps(hair_transform) if hair_transform else 'None'}")
    hair_filename = hair_file_map.get(hair_style)
    if hair_filename:
        hair_path = os.path.join(models_dir, 'hair', hair_filename)
        dlog(f"Hair path: {hair_path}, exists: {os.path.exists(hair_path)}")
        if os.path.exists(hair_path):
            try:
                hair_objects = import_glb(hair_path)
                dlog(f"Hair import returned {len(hair_objects)} objects: {[f'{o.name}({o.type})' for o in hair_objects]}")
                hair_mat = create_hair_material(hair_color)

                mesh_filter = hair_mesh_filter.get(hair_style)
                kept_meshes = []
                glb_empties = []
                for obj in list(hair_objects):  # iterate copy to safely remove
                    if obj.type == 'MESH':
                        # Filter meshes for multi-mesh models
                        if mesh_filter and mesh_filter not in obj.name.lower():
                            dlog(f"  Removing filtered mesh: {obj.name}")
                            bpy.data.objects.remove(obj, do_unlink=True)
                            continue
                        obj.data.materials.clear()
                        obj.data.materials.append(hair_mat)
                        for poly in obj.data.polygons:
                            poly.use_smooth = True
                        obj.hide_render = False
                        obj.hide_viewport = False
                        kept_meshes.append(obj)
                        dlog(f"  Kept hair mesh: {obj.name}, parent={obj.parent.name if obj.parent else 'None'}, loc={tuple(round(v,4) for v in obj.location)}")
                    elif obj.type == 'EMPTY':
                        glb_empties.append(obj)
                        dlog(f"  GLB empty: {obj.name}")
                    else:
                        dlog(f"  Non-mesh hair object: {obj.name} (type={obj.type})")

                # Clear any GLB-imported parent hierarchy on kept meshes
                # so they are free-standing at their world position
                for mobj in kept_meshes:
                    if mobj.parent:
                        dlog(f"  Clearing parent of {mobj.name} (was {mobj.parent.name})")
                        world = mobj.matrix_world.copy()
                        mobj.parent = None
                        mobj.matrix_world = world

                # Now safely remove the GLB-imported empties
                for emp in glb_empties:
                    try:
                        bpy.data.objects.remove(emp, do_unlink=True)
                    except Exception:
                        pass

                # ── Apply the combined world transform from Three.js ──
                # The frontend sends either:
                #   1) A 4x4 matrix (combined container+offset world matrix)
                #   2) Raw slider parameters for Blender to compute alignment
                if hair_transform and kept_meshes:
                    ht = hair_transform
                    opa = ht.get('opacity', 1.0)
                    m = ht.get('matrix', None)

                    if m and len(m) == 16:
                        dlog("  Using matrix from frontend")
                        # Coordinate conversion: Three.js Y-up → Blender Z-up
                        conv = mathutils.Matrix((
                            (1,  0,  0, 0),
                            (0,  0, -1, 0),
                            (0,  1,  0, 0),
                            (0,  0,  0, 1),
                        ))

                        # Three.js matrix is column-major
                        threejs_mat = mathutils.Matrix((
                            (m[0], m[4], m[8],  m[12]),
                            (m[1], m[5], m[9],  m[13]),
                            (m[2], m[6], m[10], m[14]),
                            (m[3], m[7], m[11], m[15]),
                        ))

                        conv_inv = conv.inverted()
                        blender_mat = conv @ threejs_mat @ conv_inv

                        bl_pos = blender_mat.translation
                        dlog(f"  ThreeJS pos: [{m[12]:.4f}, {m[13]:.4f}, {m[14]:.4f}]")
                        dlog(f"  Blender pos: [{bl_pos.x:.4f}, {bl_pos.y:.4f}, {bl_pos.z:.4f}]")

                        hair_parent = bpy.data.objects.new("HairTransform", None)
                        bpy.context.scene.collection.objects.link(hair_parent)
                        hair_parent.matrix_world = blender_mat

                        for mobj in kept_meshes:
                            mobj.parent = hair_parent
                            mobj.matrix_parent_inverse.identity()
                            dlog(f"  Parented {mobj.name}")

                    else:
                        dlog("  No matrix — computing alignment from raw params")
                        # Replicate the Three.js _alignAndAdjust logic in
                        # Blender's Z-up coordinate space.
                        rp = ht.get('rawParams', {})

                        # ── Compute the hair model's bounding box ──
                        min_co = [1e9, 1e9, 1e9]
                        max_co = [-1e9, -1e9, -1e9]
                        for mobj in kept_meshes:
                            bbox = [mobj.matrix_world @ mathutils.Vector(c) for c in mobj.bound_box]
                            for v in bbox:
                                for i in range(3):
                                    min_co[i] = min(min_co[i], v[i])
                                    max_co[i] = max(max_co[i], v[i])

                        hair_cx = (min_co[0] + max_co[0]) / 2
                        hair_cy = (min_co[1] + max_co[1]) / 2
                        hair_cz = (min_co[2] + max_co[2]) / 2
                        hair_sx = max_co[0] - min_co[0]
                        hair_sy = max_co[1] - min_co[1]
                        hair_sz = max_co[2] - min_co[2]
                        dlog(f"  Hair bbox center: ({hair_cx:.3f}, {hair_cy:.3f}, {hair_cz:.3f})")
                        dlog(f"  Hair bbox size:   ({hair_sx:.3f}, {hair_sy:.3f}, {hair_sz:.3f})")

                        # ── Compute head metrics from head mesh ──
                        head_min = [1e9, 1e9, 1e9]
                        head_max = [-1e9, -1e9, -1e9]
                        for hobj in head_objects:
                            if hobj.type != 'MESH':
                                continue
                            bbox = [hobj.matrix_world @ mathutils.Vector(c) for c in hobj.bound_box]
                            for v in bbox:
                                for i in range(3):
                                    head_min[i] = min(head_min[i], v[i])
                                    head_max[i] = max(head_max[i], v[i])

                        head_cx = (head_min[0] + head_max[0]) / 2
                        head_cy = (head_min[1] + head_max[1]) / 2
                        head_cz = (head_min[2] + head_max[2]) / 2
                        head_width = head_max[0] - head_min[0]
                        head_height = head_max[2] - head_min[2]  # Z is up in Blender
                        head_top = head_max[2]
                        dlog(f"  Head center: ({head_cx:.3f}, {head_cy:.3f}, {head_cz:.3f})")
                        dlog(f"  Head width={head_width:.3f}, height={head_height:.3f}, top={head_top:.3f}")

                        # ── Replicate _alignAndAdjust ──
                        # In Blender Z-up: X=right, Y=forward, Z=up
                        # In Three.js Y-up: X=right, Y=up, Z=forward
                        # The GLB importer converts the hair model coordinates.

                        # baseScale matches head width to hair width
                        # In Three.js: baseScale = headWidth / max(hairSize.x, hairSize.z)
                        # In Blender Z-up: hairSize.x stays, hairSize.z → hairSize.y(forward)
                        baseScale = head_width / max(hair_sx, hair_sy, 0.001)

                        # Adjustment factors from sliders
                        length_f = rp.get('length', 50)
                        volume_f = rp.get('volume', 50)
                        curl_f   = rp.get('curl', 0)
                        density  = rp.get('density', 50)
                        posx     = rp.get('posx', 50)
                        posy     = rp.get('posy', 50)
                        posz     = rp.get('posz', 50)
                        roty_val = rp.get('roty', 50)
                        scale_f  = rp.get('scale', 50)

                        lengthF = 0.7 + (length_f / 100) * 0.6
                        volumeF = 0.7 + (volume_f / 100) * 0.6
                        curlF   = curl_f / 100
                        scaleF  = 0.3 + (scale_f / 100) * 1.7

                        # Position offsets (Three.js: ±0.8 world units)
                        posOffX = ((posx - 50) / 50) * 0.8
                        posOffY = ((posy - 50) / 50) * 0.8  # Three.js Y (up)
                        posOffZ = ((posz - 50) / 50) * 0.8  # Three.js Z (forward)

                        # Rotation
                        rotOffY = ((roty_val - 50) / 50) * (math.pi / 2)

                        # Scalp target (Three.js Y-up)
                        # In Three.js: scalpY = headTop - modelHeight * 0.12
                        # Convert to Blender: scalpZ = head_top - head_height * 0.12
                        scalpZ = head_top - head_height * 0.12

                        # Container scale:
                        # Three.js: (baseScale*volumeF*scaleF, baseScale*lengthF*scaleF, baseScale*volumeF*scaleF)
                        #   X=right, Y=up, Z=forward
                        # Blender: X=right, Y=forward, Z=up
                        sx = baseScale * volumeF * scaleF
                        sy = baseScale * volumeF * scaleF  # Blender Y = Three.js Z
                        sz = baseScale * lengthF * scaleF   # Blender Z = Three.js Y

                        # Container position:
                        # Three.js: (targetX + posOffX, scalpY + posOffY, targetZ + posOffZ)
                        # Blender: (targetX + posOffX, -(targetZ + posOffZ), scalpZ + posOffY)
                        # Since modelCenter.z is the Three.js Z (forward direction),
                        # in Blender forward = -Y
                        tx = head_cx + posOffX
                        ty = -(head_cy + posOffZ)  # head_cy in Blender ≈ -Three.js.z
                        # Actually head_cy in Blender IS the Blender Y for the head center
                        # Let's just use the head center directly
                        ty = head_cy - posOffZ  # offset forward
                        tz = scalpZ + posOffY

                        # Container rotation:
                        # Three.js rotation.y (around up) → Blender rotation around Z
                        rot_total = (curlF * 0.15 if curlF > 0 else 0) + rotOffY

                        # Offset = centering: move hair center to origin
                        # In Blender coords: (-hair_cx, -hair_cy, -hair_cz)
                        # (already in Blender space after import)
                        off_x = -hair_cx
                        off_y = -hair_cy
                        off_z = -hair_cz

                        dlog(f"  Computed: baseScale={baseScale:.4f}, sx={sx:.4f}, sy={sy:.4f}, sz={sz:.4f}")
                        dlog(f"  Position: ({tx:.4f}, {ty:.4f}, {tz:.4f})")
                        dlog(f"  Offset:   ({off_x:.4f}, {off_y:.4f}, {off_z:.4f})")
                        dlog(f"  Rotation Z: {rot_total:.4f}")

                        # Create container empty
                        container = bpy.data.objects.new("HairContainer", None)
                        bpy.context.scene.collection.objects.link(container)
                        container.location = (tx, ty, tz)
                        container.scale = (sx, sy, sz)
                        container.rotation_euler = (0, 0, rot_total)

                        # Create offset empty
                        offset_empty = bpy.data.objects.new("HairOffset", None)
                        bpy.context.scene.collection.objects.link(offset_empty)
                        offset_empty.parent = container
                        offset_empty.location = (off_x, off_y, off_z)

                        for mobj in kept_meshes:
                            mobj.parent = offset_empty
                            mobj.matrix_parent_inverse.identity()
                            dlog(f"  Parented {mobj.name}")

                    # Set opacity
                    if opa < 1.0:
                        for mobj in kept_meshes:
                            for mat_slot in mobj.data.materials:
                                if mat_slot and mat_slot.use_nodes:
                                    bsdf = mat_slot.node_tree.nodes.get('Principled BSDF')
                                    if bsdf:
                                        bsdf.inputs['Alpha'].default_value = opa
                                    if hasattr(mat_slot, 'blend_method'):
                                        mat_slot.blend_method = 'BLEND'
                else:
                    dlog("  WARNING: No hair transform from frontend — hair at default position")

                dlog(f"Hair import complete: kept {len(kept_meshes)} mesh(es)")
            except Exception as e:
                dlog(f"ERROR importing hair: {e}")
                import traceback
                traceback.print_exc()
        else:
            dlog(f"WARNING: Hair model not found at {hair_path}")
    else:
        print(f"No hair file mapped for style '{hair_style}' (bald or unknown)")

    # --- Setup Scene ---
    setup_studio_lighting()
    setup_camera()

    # Debug: list all objects in scene before render
    dlog("=== Scene objects before render ===")
    for obj in bpy.data.objects:
        wloc = tuple(round(v,3) for v in obj.matrix_world.translation)
        dlog(f"  {obj.name} (type={obj.type}, loc={tuple(round(v,3) for v in obj.location)}, world={wloc}, hide_render={obj.hide_render}, parent={obj.parent.name if obj.parent else 'None'})")
    dlog("=== End scene objects ===")

    configure_render(engine, quality, output_path)

    # --- Render ---
    bpy.ops.render.render(write_still=True)

    # Verify output
    if os.path.exists(output_path + '.png'):
        actual_path = output_path + '.png'
    elif os.path.exists(output_path):
        actual_path = output_path
    else:
        # Blender sometimes appends frame number
        for ext in ['.png', '0001.png']:
            test_path = output_path.rstrip('.png') + ext
            if os.path.exists(test_path):
                actual_path = test_path
                break
        else:
            actual_path = output_path

    result = {
        "success": True,
        "output_path": actual_path.replace('\\', '/'),
        "engine": engine,
        "quality": quality,
    }
    print(f'RESULT:{json.dumps(result)}')


if __name__ == '__main__':
    main()
