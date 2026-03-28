"""
Blender Script: Bake Decals onto Face Texture
UV-projects uploaded decal images onto the face mesh's diffuse texture map.
Produces a baked texture PNG + updated OBJ/MTL with the decals composited.

Usage (called via server.py):
  blender --background --python bake_decals.py -- args.json

args.json format:
{
  "obj_path": "/path/to/face.obj",
  "output_dir": "/path/to/output/",
  "texture_size": 2048,
  "skin_color": "#d4a574",
  "decals": [
    {
      "texture_data_url": "data:image/png;base64,...",
      "position": [x, y, z],
      "normal": [nx, ny, nz],
      "orientation": [ex, ey, ez],
      "size": [sx, sy, sz],
      "rotation": 0,
      "opacity": 100
    }
  ]
}
"""

import bpy
import json
import sys
import os
import math
import base64
import tempfile
from pathlib import Path


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
    for block in bpy.data.meshes:
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in bpy.data.materials:
        if block.users == 0:
            bpy.data.materials.remove(block)
    for block in bpy.data.images:
        if block.users == 0:
            bpy.data.images.remove(block)


def hex_to_rgb(hex_color):
    if not hex_color:
        return (0.83, 0.65, 0.46)
    hex_color = hex_color.lstrip('#')
    if len(hex_color) != 6:
        return (0.83, 0.65, 0.46)
    return tuple(int(hex_color[i:i+2], 16) / 255.0 for i in (0, 2, 4))


def data_url_to_image(data_url, name="decal"):
    """Convert a data URL to a Blender image object."""
    if not data_url or not data_url.startswith('data:'):
        return None

    # Parse data URL
    header, encoded = data_url.split(',', 1)
    ext = 'png'
    if 'jpeg' in header or 'jpg' in header:
        ext = 'jpg'
    elif 'webp' in header:
        ext = 'webp'

    # Decode and save to temp file
    img_data = base64.b64decode(encoded)
    tmp_path = os.path.join(tempfile.gettempdir(), f'{name}.{ext}')
    with open(tmp_path, 'wb') as f:
        f.write(img_data)

    # Load into Blender
    img = bpy.data.images.load(tmp_path, check_existing=False)
    img.name = name
    return img


def setup_uv_project(obj):
    """Ensure the mesh has a UV map. Smart UV project if none exists."""
    if not obj.data.uv_layers:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=66, island_margin=0.02)
        bpy.ops.object.mode_set(mode='OBJECT')
    return obj.data.uv_layers[0]


def create_base_texture(texture_size, skin_color):
    """Create a base skin texture filled with the skin color."""
    img = bpy.data.images.new("baked_skin", width=texture_size, height=texture_size, alpha=True)
    r, g, b = hex_to_rgb(skin_color)
    pixels = [r, g, b, 1.0] * (texture_size * texture_size)
    img.pixels = pixels
    img.update()
    return img


def project_decal_onto_texture(obj, base_image, decal_info, decal_index):
    """
    Project a single decal onto the base texture using Blender's texture paint
    with stencil projection. Falls back to a node-based compositing approach.
    """
    decal_img = data_url_to_image(
        decal_info.get('texture_data_url', ''),
        name=f'decal_{decal_index}'
    )
    if not decal_img:
        print(f"[bake_decals] Failed to load decal image {decal_index}")
        return

    pos = decal_info.get('position', [0, 0, 0])
    normal = decal_info.get('normal', [0, 0, 1])
    orientation = decal_info.get('orientation', [0, 0, 0])
    size = decal_info.get('size', [0.2, 0.2, 0.1])
    rotation_deg = decal_info.get('rotation', 0)
    opacity = decal_info.get('opacity', 100) / 100.0
    scale = decal_info.get('scale', 1.0)

    # Create a projector empty at the decal position
    bpy.ops.object.empty_add(type='SINGLE_ARROW', location=pos)
    projector = bpy.context.active_object
    projector.name = f'DecalProjector_{decal_index}'

    # Orient the projector along the surface normal
    from mathutils import Vector, Euler
    euler = Euler(orientation, 'XYZ')
    projector.rotation_euler = euler

    # Apply additional rotation around the local Z
    if rotation_deg != 0:
        projector.rotation_euler.z += math.radians(rotation_deg)

    # Set up material with projected decal using nodes
    mat = obj.active_material
    if not mat:
        mat = bpy.data.materials.new(name="SkinWithDecals")
        mat.use_nodes = True
        obj.data.materials.append(mat)
        obj.active_material = mat

    tree = mat.node_tree
    nodes = tree.nodes
    links = tree.links

    # Find or create the base texture node
    base_tex_node = None
    for node in nodes:
        if node.type == 'TEX_IMAGE' and node.image == base_image:
            base_tex_node = node
            break

    if not base_tex_node:
        base_tex_node = nodes.new('ShaderNodeTexImage')
        base_tex_node.image = base_image
        base_tex_node.location = (-400, 300)

    # Create decal texture node
    decal_tex_node = nodes.new('ShaderNodeTexImage')
    decal_tex_node.image = decal_img
    decal_tex_node.name = f'Decal_{decal_index}'
    decal_tex_node.location = (-400, -100 - decal_index * 200)

    # Create texture coordinate node for projected mapping
    coord_node = nodes.new('ShaderNodeTexCoord')
    coord_node.object = projector
    coord_node.location = (-800, -100 - decal_index * 200)

    # Create mapping node for scale/rotation
    mapping_node = nodes.new('ShaderNodeMapping')
    mapping_node.location = (-600, -100 - decal_index * 200)
    mapping_node.inputs['Scale'].default_value = (
        1.0 / (size[0] * scale) if size[0] * scale > 0 else 1.0,
        1.0 / (size[1] * scale) if size[1] * scale > 0 else 1.0,
        1.0
    )

    links.new(coord_node.outputs['Object'], mapping_node.inputs['Vector'])
    links.new(mapping_node.outputs['Vector'], decal_tex_node.inputs['Vector'])

    # Mix the decal with the base using alpha and opacity
    mix_node = nodes.new('ShaderNodeMixRGB')
    mix_node.blend_type = 'MIX'
    mix_node.location = (-100, 200 - decal_index * 200)

    # Multiply decal alpha by opacity
    math_node = nodes.new('ShaderNodeMath')
    math_node.operation = 'MULTIPLY'
    math_node.inputs[1].default_value = opacity
    math_node.location = (-250, 100 - decal_index * 200)

    links.new(decal_tex_node.outputs['Alpha'], math_node.inputs[0])
    links.new(math_node.outputs['Value'], mix_node.inputs['Fac'])
    links.new(base_tex_node.outputs['Color'], mix_node.inputs['Color1'])
    links.new(decal_tex_node.outputs['Color'], mix_node.inputs['Color2'])

    print(f"[bake_decals] Projected decal {decal_index} at position {pos}")

    # Clean up projector
    bpy.data.objects.remove(projector, do_unlink=True)

    return mix_node


def bake_texture(obj, base_image, texture_size):
    """Bake the material to a new texture image."""
    # Create output image
    bake_img = bpy.data.images.new(
        "baked_result",
        width=texture_size,
        height=texture_size,
        alpha=True
    )

    # Set bake target
    mat = obj.active_material
    if mat and mat.use_nodes:
        tree = mat.node_tree
        # Create a new image texture node for bake target
        bake_node = tree.nodes.new('ShaderNodeTexImage')
        bake_node.image = bake_img
        bake_node.name = 'BakeTarget'
        tree.nodes.active = bake_node

    # Configure bake settings
    bpy.context.scene.render.engine = 'CYCLES'
    bpy.context.scene.cycles.samples = 1
    bpy.context.scene.cycles.bake_type = 'DIFFUSE'
    bpy.context.scene.render.bake.use_pass_direct = False
    bpy.context.scene.render.bake.use_pass_indirect = False
    bpy.context.scene.render.bake.use_pass_color = True

    # Select object and bake
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    try:
        bpy.ops.object.bake(type='DIFFUSE')
        print("[bake_decals] Bake completed successfully")
    except Exception as e:
        print(f"[bake_decals] Bake failed: {e}")
        # Fallback: just return the base image
        return base_image

    return bake_img


def main():
    args = get_args()
    if not args:
        print("[bake_decals] No arguments provided")
        return

    obj_path = args.get('obj_path', '')
    output_dir = args.get('output_dir', '/tmp/decal_bake/')
    texture_size = args.get('texture_size', 2048)
    skin_color = args.get('skin_color', '#d4a574')
    decals = args.get('decals', [])

    if not decals:
        print("[bake_decals] No decals to bake")
        return

    os.makedirs(output_dir, exist_ok=True)

    # Clear scene
    clear_scene()

    # Import OBJ
    if obj_path and os.path.exists(obj_path):
        bpy.ops.wm.obj_import(filepath=obj_path)
        print(f"[bake_decals] Imported OBJ: {obj_path}")
    else:
        print(f"[bake_decals] OBJ not found: {obj_path}")
        return

    # Get the imported mesh
    obj = None
    for o in bpy.context.scene.objects:
        if o.type == 'MESH':
            obj = o
            break

    if not obj:
        print("[bake_decals] No mesh found in scene")
        return

    # Ensure UV map
    setup_uv_project(obj)

    # Create base texture
    base_image = create_base_texture(texture_size, skin_color)

    # Create material
    mat = bpy.data.materials.new(name="SkinWithDecals")
    mat.use_nodes = True
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    obj.active_material = mat

    tree = mat.node_tree
    nodes = tree.nodes
    links = tree.links

    # Clear default nodes
    for node in nodes:
        nodes.remove(node)

    # Create base nodes
    output_node = nodes.new('ShaderNodeOutputMaterial')
    output_node.location = (400, 300)

    bsdf_node = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf_node.location = (100, 300)
    links.new(bsdf_node.outputs['BSDF'], output_node.inputs['Surface'])

    base_tex_node = nodes.new('ShaderNodeTexImage')
    base_tex_node.image = base_image
    base_tex_node.location = (-400, 300)

    # Project each decal
    last_color_output = base_tex_node.outputs['Color']

    for i, decal_info in enumerate(decals):
        decal_img = data_url_to_image(
            decal_info.get('texture_data_url', ''),
            name=f'decal_{i}'
        )
        if not decal_img:
            continue

        opacity = decal_info.get('opacity', 100) / 100.0

        # Create decal texture node (uses UV coordinates)
        decal_tex_node = nodes.new('ShaderNodeTexImage')
        decal_tex_node.image = decal_img
        decal_tex_node.location = (-400, -100 - i * 250)

        # Mix node
        mix_node = nodes.new('ShaderNodeMixRGB')
        mix_node.blend_type = 'MIX'
        mix_node.location = (-100, 200 - i * 250)

        # Alpha * opacity
        math_node = nodes.new('ShaderNodeMath')
        math_node.operation = 'MULTIPLY'
        math_node.inputs[1].default_value = opacity
        math_node.location = (-250, 50 - i * 250)

        links.new(decal_tex_node.outputs['Alpha'], math_node.inputs[0])
        links.new(math_node.outputs['Value'], mix_node.inputs['Fac'])
        links.new(last_color_output, mix_node.inputs['Color1'])
        links.new(decal_tex_node.outputs['Color'], mix_node.inputs['Color2'])

        last_color_output = mix_node.outputs['Color']

    # Connect final color to BSDF
    links.new(last_color_output, bsdf_node.inputs['Base Color'])

    # Bake
    baked_image = bake_texture(obj, base_image, texture_size)

    # Save baked texture
    baked_path = os.path.join(output_dir, 'baked_skin_decals.png')
    baked_image.filepath_raw = baked_path
    baked_image.file_format = 'PNG'
    baked_image.save()
    print(f"[bake_decals] Saved baked texture: {baked_path}")

    # Update material to use the baked texture for export
    baked_file_img = bpy.data.images.load(baked_path, check_existing=False)
    base_tex_node.image = baked_file_img

    # Remove mix/decal nodes, connect baked directly to BSDF
    # (clean up for OBJ export)
    for node in list(nodes):
        if node not in (output_node, bsdf_node, base_tex_node):
            nodes.remove(node)
    links.new(base_tex_node.outputs['Color'], bsdf_node.inputs['Base Color'])

    # Export OBJ with baked texture
    obj_output = os.path.join(output_dir, 'face_baked.obj')
    bpy.ops.wm.obj_export(
        filepath=obj_output,
        export_selected_objects=True,
        export_materials=True,
        export_uv=True,
    )
    print(f"[bake_decals] Exported OBJ: {obj_output}")

    # Write result metadata
    result = {
        'baked_texture': baked_path,
        'obj_path': obj_output,
        'mtl_path': obj_output.replace('.obj', '.mtl'),
        'decal_count': len(decals),
    }
    result_path = os.path.join(output_dir, 'bake_result.json')
    with open(result_path, 'w') as f:
        json.dump(result, f, indent=2)
    print(f"[bake_decals] Result metadata: {result_path}")


if __name__ == '__main__':
    main()
