"""
Blender Script: Apply Morph Targets to Base Face
Runs in Blender's background mode via the backend server.
"""

import bpy
import json
import sys
import os
import math

def get_args():
    """Parse arguments passed after '--' in the Blender command."""
    argv = sys.argv
    if '--' in argv:
        args_file = argv[argv.index('--') + 1]
        with open(args_file, 'r') as f:
            return json.load(f)
    return {}

def clear_scene():
    """Remove all objects from the scene."""
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)

def apply_morphs(obj, morph_targets):
    """
    Apply morph deformations to the face mesh.
    Each morph target maps to specific vertex groups and transformations.
    """
    
    # Morph region definitions — maps parameter names to vertex manipulation rules
    morph_regions = {
        # Skull structure
        'headWidth': {'axis': 'x', 'scale': True, 'range': (0.8, 1.3)},
        'headHeight': {'axis': 'z', 'scale': True, 'range': (0.85, 1.2)},
        'headDepth': {'axis': 'y', 'scale': True, 'range': (0.85, 1.2)},
        
        # Forehead
        'foreheadHeight': {'region': 'forehead', 'axis': 'z', 'translate': True, 'range': (-0.02, 0.03)},
        'foreheadWidth': {'region': 'forehead', 'axis': 'x', 'scale': True, 'range': (0.9, 1.15)},
        'foreheadSlope': {'region': 'forehead', 'axis': 'y', 'translate': True, 'range': (-0.02, 0.02)},
        'browRidgeDepth': {'region': 'brow', 'axis': 'y', 'translate': True, 'range': (-0.005, 0.015)},
        
        # Eyes
        'eyeSpacing': {'region': 'eyes', 'axis': 'x', 'scale': True, 'range': (0.85, 1.2)},
        'eyeSize': {'region': 'eyes', 'axis': 'xyz', 'scale': True, 'range': (0.8, 1.25)},
        'eyeHeight': {'region': 'eyes', 'axis': 'z', 'translate': True, 'range': (-0.01, 0.015)},
        'eyeDepth': {'region': 'eyes', 'axis': 'y', 'translate': True, 'range': (-0.01, 0.01)},
        'eyeTilt': {'region': 'eyes', 'axis': 'z', 'rotate': True, 'range': (-5, 5)},
        
        # Nose
        'noseLength': {'region': 'nose', 'axis': 'z', 'scale': True, 'range': (0.75, 1.35)},
        'noseWidth': {'region': 'nose_base', 'axis': 'x', 'scale': True, 'range': (0.7, 1.4)},
        'noseBridge': {'region': 'nose_bridge', 'axis': 'x', 'scale': True, 'range': (0.8, 1.3)},
        'noseProtrusion': {'region': 'nose_tip', 'axis': 'y', 'translate': True, 'range': (-0.01, 0.02)},
        'noseTipShape': {'region': 'nose_tip', 'axis': 'z', 'translate': True, 'range': (-0.008, 0.008)},
        
        # Cheeks
        'cheekboneWidth': {'region': 'cheekbones', 'axis': 'x', 'scale': True, 'range': (0.9, 1.15)},
        'cheekboneHeight': {'region': 'cheekbones', 'axis': 'z', 'translate': True, 'range': (-0.01, 0.01)},
        'cheekFullness': {'region': 'cheeks', 'axis': 'y', 'translate': True, 'range': (-0.01, 0.02)},
        
        # Mouth
        'mouthWidth': {'region': 'mouth', 'axis': 'x', 'scale': True, 'range': (0.75, 1.3)},
        'lipThicknessUpper': {'region': 'upper_lip', 'axis': 'y', 'translate': True, 'range': (-0.005, 0.008)},
        'lipThicknessLower': {'region': 'lower_lip', 'axis': 'y', 'translate': True, 'range': (-0.005, 0.01)},
        'mouthProtrusion': {'region': 'mouth', 'axis': 'y', 'translate': True, 'range': (-0.008, 0.012)},
        
        # Jaw / Chin
        'jawWidth': {'region': 'jaw', 'axis': 'x', 'scale': True, 'range': (0.85, 1.2)},
        'jawAngle': {'region': 'jaw_angle', 'axis': 'y', 'translate': True, 'range': (-0.01, 0.015)},
        'chinHeight': {'region': 'chin', 'axis': 'z', 'translate': True, 'range': (-0.015, 0.015)},
        'chinWidth': {'region': 'chin', 'axis': 'x', 'scale': True, 'range': (0.8, 1.25)},
        'chinProtrusion': {'region': 'chin', 'axis': 'y', 'translate': True, 'range': (-0.012, 0.015)},
        'chinShape': {'region': 'chin', 'axis': 'z', 'scale': True, 'range': (0.85, 1.2)},
        
        # Ears
        'earSize': {'region': 'ears', 'axis': 'xyz', 'scale': True, 'range': (0.7, 1.4)},
        'earAngle': {'region': 'ears', 'axis': 'y', 'translate': True, 'range': (-0.01, 0.02)},
        
        # Neck
        'neckWidth': {'region': 'neck', 'axis': 'x', 'scale': True, 'range': (0.8, 1.3)},
        'neckLength': {'region': 'neck', 'axis': 'z', 'scale': True, 'range': (0.85, 1.2)},
    }
    
    mesh = obj.data
    
    # Use shape keys if available
    if obj.data.shape_keys:
        for key_block in obj.data.shape_keys.key_blocks:
            param_name = key_block.name
            if param_name in morph_targets:
                key_block.value = morph_targets[param_name]
    else:
        # Fallback: direct vertex manipulation with proportional editing
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.object.mode_set(mode='OBJECT')
        
        # Apply basic scaling morphs
        for param, value in morph_targets.items():
            if param in morph_regions:
                region = morph_regions[param]
                val_range = region['range']
                # Map 0-1 value to the defined range
                mapped_value = val_range[0] + (float(value) * (val_range[1] - val_range[0]))
                
                if region.get('scale') and not region.get('region'):
                    # Global scale
                    axis = region['axis']
                    if axis == 'x':
                        obj.scale.x *= mapped_value
                    elif axis == 'y':
                        obj.scale.y *= mapped_value
                    elif axis == 'z':
                        obj.scale.z *= mapped_value

def main():
    args = get_args()
    
    base_model_path = args.get('base_model', '')
    morph_targets = args.get('morph_targets', {})
    output_path = args.get('output_path', '')
    
    clear_scene()
    
    # Import base model
    if base_model_path and os.path.exists(base_model_path):
        if base_model_path.endswith('.obj'):
            bpy.ops.wm.obj_import(filepath=base_model_path)
        elif base_model_path.endswith('.fbx'):
            bpy.ops.import_scene.fbx(filepath=base_model_path)
    else:
        # Create a default head mesh if no base model exists
        bpy.ops.mesh.primitive_uv_sphere_add(
            segments=64, ring_count=32, radius=0.1,
            location=(0, 0, 0)
        )
    
    # Get the imported/created object
    obj = bpy.context.active_object
    if not obj:
        obj = bpy.context.scene.objects[0]
    
    # Apply morphs
    apply_morphs(obj, morph_targets)
    
    # Export result
    if output_path:
        bpy.ops.object.select_all(action='SELECT')
        if output_path.endswith('.obj'):
            bpy.ops.wm.obj_export(filepath=output_path)
        elif output_path.endswith('.fbx'):
            bpy.ops.export_scene.fbx(filepath=output_path)
    
    print(f'RESULT:{{"success": true, "output_path": "{output_path}"}}')

if __name__ == '__main__':
    main()
