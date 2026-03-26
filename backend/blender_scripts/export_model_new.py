"""
Blender Script: Export Complete Face Reconstruction
Combines morphed face + hair + beard + eyebrows + eyes + eyelashes into final export.
Uses bounding-box based alignment for accurate positioning.
"""

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
