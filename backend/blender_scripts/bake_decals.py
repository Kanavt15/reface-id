"""Blender script that bakes decal images into the face's skin texture and exports the OBJ with the baked texture; run as `blender --background --python bake_decals.py -- args.json`."""

import bpy
import json
import sys
import os
import base64
import tempfile


def get_args():
    """Reads the JSON arguments file passed after '--' on the Blender command line."""
    argv = sys.argv
    if '--' in argv:
        args_file = argv[argv.index('--') + 1]
        with open(args_file, 'r') as f:
            return json.load(f)
    return {}


def clear_scene():
    """Removes every object and unused mesh from the scene."""
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
    """Converts a hex colour to RGB floats, with a skin-tone fallback."""
    if not hex_color:
        return (0.83, 0.65, 0.46)
    hex_color = hex_color.lstrip('#')
    if len(hex_color) != 6:
        return (0.83, 0.65, 0.46)
    return tuple(int(hex_color[i:i+2], 16) / 255.0 for i in (0, 2, 4))


def data_url_to_image(data_url, name="decal"):
    """Turns a data URL into a Blender image."""
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
    """Makes sure the mesh has a UV map, creating one if needed."""
    if not obj.data.uv_layers:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=66, island_margin=0.02)
        bpy.ops.object.mode_set(mode='OBJECT')
    return obj.data.uv_layers[0]


def create_base_texture(texture_size, skin_color):
    """Creates a base texture filled with the skin colour."""
    img = bpy.data.images.new("baked_skin", width=texture_size, height=texture_size, alpha=True)
    r, g, b = hex_to_rgb(skin_color)
    pixels = [r, g, b, 1.0] * (texture_size * texture_size)
    img.pixels = pixels
    img.update()
    return img


def bake_texture(obj, base_image, texture_size):
    """Bakes the material into a new texture image."""
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
    """Loads the face, layers each decal over the skin texture, bakes it and exports the result."""
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

    # Remove the decal nodes and connect the baked texture directly for export.
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
