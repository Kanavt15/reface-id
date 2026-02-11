"""
Blender Script: Generate Hair Particle System
Creates realistic hair using Blender's particle system and converts to mesh for export.
Compatible with Blender 4.x and 5.x.
"""

import bpy
import json
import sys
import os
import math
import random

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

def blender_version():
    """Return Blender major version as int (e.g. 5 for 5.0.1)."""
    return bpy.app.version[0]

# Hair style presets
HAIR_PRESETS = {
    'short_cropped': {
        'hair_length': 0.02,
        'count': 15000,
        'segments': 3,
        'clump': 0.5,
        'roughness': 0.1,
    },
    'medium_straight': {
        'hair_length': 0.08,
        'count': 12000,
        'segments': 6,
        'clump': 0.3,
        'roughness': 0.15,
    },
    'medium_wavy': {
        'hair_length': 0.09,
        'count': 12000,
        'segments': 8,
        'clump': 0.4,
        'roughness': 0.3,
        'kink': 'WAVE',
        'kink_amplitude': 0.003,
        'kink_frequency': 2.0,
    },
    'long_straight': {
        'hair_length': 0.18,
        'count': 15000,
        'segments': 10,
        'clump': 0.3,
        'roughness': 0.1,
    },
    'long_curly': {
        'hair_length': 0.15,
        'count': 18000,
        'segments': 12,
        'clump': 0.6,
        'roughness': 0.4,
        'kink': 'CURL',
        'kink_amplitude': 0.005,
        'kink_frequency': 3.0,
    },
    'afro': {
        'hair_length': 0.1,
        'count': 25000,
        'segments': 10,
        'clump': 0.7,
        'roughness': 0.8,
        'kink': 'CURL',
        'kink_amplitude': 0.008,
        'kink_frequency': 5.0,
    },
    'buzz_cut': {
        'hair_length': 0.005,
        'count': 20000,
        'segments': 2,
        'clump': 0.2,
        'roughness': 0.05,
    },
    'pompadour': {
        'hair_length': 0.06,
        'count': 14000,
        'segments': 6,
        'clump': 0.5,
        'roughness': 0.15,
    },
    'mohawk': {
        'hair_length': 0.08,
        'count': 8000,
        'segments': 6,
        'clump': 0.6,
        'roughness': 0.2,
    },
    'bald': {
        'hair_length': 0,
        'count': 0,
        'segments': 0,
        'clump': 0,
        'roughness': 0,
    },
    'ponytail': {
        'hair_length': 0.2,
        'count': 14000,
        'segments': 10,
        'clump': 0.5,
        'roughness': 0.1,
    },
    'bun': {
        'hair_length': 0.15,
        'count': 14000,
        'segments': 8,
        'clump': 0.6,
        'roughness': 0.1,
    },
}

def create_scalp_vertex_group(obj):
    """Create a vertex group limiting hair to the upper scalp region."""
    mesh = obj.data
    vg = obj.vertex_groups.new(name="Scalp")

    # Find bounding box in local space
    min_z = min(v.co.z for v in mesh.vertices)
    max_z = max(v.co.z for v in mesh.vertices)
    height = max_z - min_z

    # Weight vertices: full weight at top, zero below ~60% height
    for v in mesh.vertices:
        rel_z = (v.co.z - min_z) / height
        if rel_z > 0.60:
            weight = min(1.0, (rel_z - 0.60) / 0.25)
            vg.add([v.index], weight, 'REPLACE')

    return vg

def create_hair_system(obj, hair_params):
    """Add a particle hair system to the head object."""
    
    style = hair_params.get('style', 'medium_straight')
    preset = HAIR_PRESETS.get(style, HAIR_PRESETS['medium_straight'])
    
    if preset['count'] == 0:
        return  # Bald — no hair
    
    # Override preset values with custom params
    length_mult = hair_params.get('length', 1.0)
    density_mult = hair_params.get('density', 1.0)
    hair_length = preset['hair_length'] * (length_mult * 2)  # scale factor
    hair_count = int(density_mult * preset['count'])
    
    # Create vertex group for scalp
    scalp_vg = create_scalp_vertex_group(obj)
    
    # Create particle system
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.particle_system_add()
    
    psys = obj.particle_systems[-1]
    psys.name = "Hair"
    pset = psys.settings
    
    pset.type = 'HAIR'
    pset.hair_length = hair_length
    pset.count = hair_count
    pset.hair_step = preset['segments']
    
    # Restrict to scalp vertex group
    psys.vertex_group_density = scalp_vg.name
    
    # Children for volume
    pset.child_type = 'INTERPOLATED'
    pset.child_nbr = 4
    pset.rendered_child_count = 50
    pset.child_length = 1.0
    
    # Clumping
    try:
        pset.clump_factor = preset['clump']
    except Exception:
        pass  # API may differ in Blender 5.x
    
    # Roughness
    try:
        pset.roughness_1 = preset['roughness']
        pset.roughness_2 = preset['roughness'] * 0.5
    except Exception:
        pass
    
    # Kink (for curly/wavy styles)
    if 'kink' in preset:
        try:
            pset.kink = preset['kink']
            pset.kink_amplitude = preset.get('kink_amplitude', 0.003)
            pset.kink_frequency = preset.get('kink_frequency', 2.0)
        except Exception:
            pass
    
    # Hair color via material
    color_hex = hair_params.get('color', '#2c1b0e')
    r, g, b = hex_to_rgb(color_hex)
    
    mat = bpy.data.materials.new(name="HairMaterial")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    principled = nodes.get('Principled BSDF')
    if principled:
        principled.inputs['Base Color'].default_value = (r, g, b, 1.0)
        principled.inputs['Roughness'].default_value = 0.6
    
    obj.data.materials.append(mat)
    pset.material_slot = obj.data.materials.find(mat.name) + 1

def create_facial_hair(obj, facial_hair_params):
    """Add facial hair (beard, mustache, etc.)."""
    style = facial_hair_params.get('style', 'none')
    
    if style == 'none':
        return
    
    # Facial hair presets
    facial_presets = {
        'stubble': {'length': 0.002, 'count': 8000, 'density': 0.8},
        'short_beard': {'length': 0.01, 'count': 10000, 'density': 1.0},
        'full_beard': {'length': 0.04, 'count': 12000, 'density': 1.0},
        'goatee': {'length': 0.02, 'count': 5000, 'density': 0.7},
        'mustache': {'length': 0.015, 'count': 3000, 'density': 0.8},
        'sideburns': {'length': 0.015, 'count': 4000, 'density': 0.7},
    }
    
    preset = facial_presets.get(style, facial_presets['stubble'])
    
    # Create a separate particle system for facial hair
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.particle_system_add()
    
    psys = obj.particle_systems[-1]
    psys.name = "FacialHair"
    pset = psys.settings
    
    pset.type = 'HAIR'
    pset.hair_length = preset['length']
    pset.count = preset['count']
    pset.hair_step = 4

def hex_to_rgb(hex_color):
    """Convert hex color to RGB floats."""
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) / 255.0 for i in (0, 2, 4))

def convert_particles_to_mesh(obj):
    """Convert particle system to mesh for export compatibility."""
    bpy.context.view_layer.objects.active = obj
    
    dg = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(dg)
    
    mesh = bpy.data.meshes.new_from_object(eval_obj)
    hair_obj = bpy.data.objects.new("HairMesh", mesh)
    bpy.context.collection.objects.link(hair_obj)
    
    return hair_obj

def main():
    args = get_args()
    
    base_model_path = args.get('base_model', '')
    hair_params = args.get('hair_params', {})
    output_path = args.get('output_path', '')
    
    clear_scene()
    
    # Import base model
    if base_model_path and os.path.exists(base_model_path):
        if base_model_path.endswith('.obj'):
            # Blender 4+/5+ use wm.obj_import; older used import_scene.obj
            try:
                bpy.ops.wm.obj_import(filepath=base_model_path)
            except AttributeError:
                bpy.ops.import_scene.obj(filepath=base_model_path)
    else:
        bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=0.1)
    
    obj = bpy.context.active_object or bpy.context.scene.objects[0]
    
    # Apply hair
    create_hair_system(obj, hair_params)
    
    # Apply facial hair if specified
    if 'facialHair' in hair_params:
        create_facial_hair(obj, hair_params['facialHair'])
    
    # Convert particles to mesh for export
    hair_mesh = convert_particles_to_mesh(obj)
    
    # Select only hair mesh for export
    bpy.ops.object.select_all(action='DESELECT')
    hair_mesh.select_set(True)
    bpy.context.view_layer.objects.active = hair_mesh
    
    if output_path:
        ext = os.path.splitext(output_path)[1].lower()
        if ext == '.obj':
            try:
                bpy.ops.wm.obj_export(
                    filepath=output_path,
                    export_selected_objects=True,
                    forward_axis='NEGATIVE_Z',
                    up_axis='Y'
                )
            except (AttributeError, TypeError):
                bpy.ops.wm.obj_export(filepath=output_path, export_selected_objects=True)
        elif ext == '.glb' or ext == '.gltf':
            bpy.ops.export_scene.gltf(filepath=output_path, use_selection=True)
    
    vertex_count = len(hair_mesh.data.vertices) if hair_mesh.data else 0
    print(f'RESULT:{{"success": true, "output_path": "{output_path}", "style": "{hair_params.get("style", "medium_straight")}", "vertices": {vertex_count}}}')
if __name__ == '__main__':
    main()
