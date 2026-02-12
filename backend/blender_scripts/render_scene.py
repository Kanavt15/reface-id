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

        # Distance to frame entire head+hair with some padding
        fov = 2 * math.atan(cam_data.sensor_width / (2 * cam_data.lens))
        cam_dist = (max_extent * 0.65) / math.tan(fov / 2)
        cam_dist = max(cam_dist, 2.5)  # minimum distance

        cam_obj.location = (center_x, center_y - cam_dist, center_z + max_extent * 0.05)
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
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=filepath)
    after = set(bpy.data.objects)
    new_objects = after - before
    return list(new_objects)


def main():
    args = get_args()

    hair_style = args.get('hairStyle', 'hair1')
    hair_color = args.get('hairColor', '#2c1b0e')
    skin_color = args.get('skinColor', '#d4a574')
    engine = args.get('engine', 'EEVEE')
    quality = args.get('quality', 'medium')
    output_path = args.get('output_path', '')
    models_dir = args.get('models_dir', '')

    clear_scene()

    # --- Import Head ---
    head_path = os.path.join(models_dir, 'head.glb')
    if os.path.exists(head_path):
        head_objects = import_glb(head_path)
        skin_mat = create_skin_material(skin_color)
        for obj in head_objects:
            if obj.type == 'MESH':
                obj.data.materials.clear()
                obj.data.materials.append(skin_mat)
                # Enable smooth shading
                for poly in obj.data.polygons:
                    poly.use_smooth = True
        print(f"Imported head with {len(head_objects)} objects")
    else:
        print(f"WARNING: Head model not found at {head_path}")

    # --- Import Hair ---
    hair_file_map = {
        'hair1': 'Hair1.glb',
        'hair2': 'Hair2.glb',
        'hair3': 'Hair3.glb',
        'hair4': 'Hair4.glb',
    }

    # Which mesh to use for multi-mesh models
    hair_mesh_filter = {
        'hair3': 'hair02',
        'hair4': 'hair11',
    }

    hair_filename = hair_file_map.get(hair_style)
    if hair_filename:
        hair_path = os.path.join(models_dir, hair_filename)
        if os.path.exists(hair_path):
            hair_objects = import_glb(hair_path)
            hair_mat = create_hair_material(hair_color)

            mesh_filter = hair_mesh_filter.get(hair_style)
            for obj in hair_objects:
                if obj.type == 'MESH':
                    # Filter meshes for multi-mesh models
                    if mesh_filter and mesh_filter not in obj.name.lower():
                        bpy.data.objects.remove(obj, do_unlink=True)
                        continue
                    obj.data.materials.clear()
                    obj.data.materials.append(hair_mat)
                    for poly in obj.data.polygons:
                        poly.use_smooth = True

            print(f"Imported hair: {hair_filename}")
        else:
            print(f"WARNING: Hair model not found at {hair_path}")

    # --- Setup Scene ---
    setup_studio_lighting()
    setup_camera()
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
