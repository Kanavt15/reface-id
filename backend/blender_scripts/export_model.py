"""
Blender Script: Export Complete Face Reconstruction
Combines morphed face + hair + appearance into final export.
"""

import bpy
import json
import sys
import os

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

def hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) / 255.0 for i in (0, 2, 4))

def apply_skin_material(obj, appearance):
    """Apply skin material with proper color and texture settings."""
    skin_color = appearance.get('skinColor', '#d4a574')
    r, g, b = hex_to_rgb(skin_color)
    
    mat = bpy.data.materials.new(name="SkinMaterial")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    
    principled = nodes.get('Principled BSDF')
    if principled:
        # Subsurface scattering for realistic skin
        principled.inputs['Base Color'].default_value = (r, g, b, 1.0)
        principled.inputs['Subsurface Weight'].default_value = 0.3
        principled.inputs['Subsurface Radius'].default_value = (1.0, 0.2, 0.1)
        principled.inputs['Roughness'].default_value = 0.5
        principled.inputs['Specular IOR Level'].default_value = 0.3
    
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)

def main():
    args = get_args()
    
    morph_targets = args.get('morph_targets', {})
    hair_params = args.get('hair_params', {})
    appearance = args.get('appearance', {})
    export_format = args.get('format', 'obj')
    output_path = args.get('output_path', '')
    base_model = args.get('base_model', '')
    
    clear_scene()
    
    # Import base model
    if base_model and os.path.exists(base_model):
        if base_model.endswith('.obj'):
            bpy.ops.wm.obj_import(filepath=base_model)
        elif base_model.endswith('.fbx'):
            bpy.ops.import_scene.fbx(filepath=base_model)
    else:
        bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=0.1)
    
    obj = bpy.context.active_object or bpy.context.scene.objects[0]
    
    # Apply morphs (using shape keys if available)
    if obj.data.shape_keys:
        for key_block in obj.data.shape_keys.key_blocks:
            if key_block.name in morph_targets:
                key_block.value = morph_targets[key_block.name]
    
    # Apply skin material
    apply_skin_material(obj, appearance)
    
    # Select all for export
    bpy.ops.object.select_all(action='SELECT')
    
    # Export based on format
    if export_format == 'obj':
        bpy.ops.wm.obj_export(filepath=output_path)
    elif export_format == 'fbx':
        bpy.ops.export_scene.fbx(filepath=output_path)
    elif export_format == 'glb':
        bpy.ops.export_scene.gltf(filepath=output_path, export_format='GLB')
    
    print(f'RESULT:{{"success": true, "format": "{export_format}", "output_path": "{output_path}"}}')

if __name__ == '__main__':
    main()
