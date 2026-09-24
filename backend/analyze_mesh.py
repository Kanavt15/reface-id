"""Sorts every vertex of head.glb into one of 20 face regions (by position and normal, Y up, +Z front) and writes head_regions.json for the app."""

import trimesh
import numpy as np
import json
import os
import sys

# Half-width of the reference head; x thresholds below are in these units, so the shipped model classifies exactly as before.
REFERENCE_HALF_WIDTH = 0.9566180109977722

REGION_NAMES = [
    'SCALP', 'FOREHEAD', 'BROW', 'EYE_LEFT', 'EYE_RIGHT',
    'NOSE_BRIDGE', 'NOSE_TIP', 'NOSE_BASE',
    'CHEEKBONE', 'CHEEKS', 'UPPER_LIP', 'LOWER_LIP', 'MOUTH_AREA',
    'JAW', 'JAW_ANGLE', 'CHIN', 'EAR_LEFT', 'EAR_RIGHT',
    'NECK', 'BACK_HEAD',
]


def classify_vertices(vertices, normals):
    """Assigns each vertex a region ID from its position and normal."""
    n = len(vertices)
    regions = np.full(n, 9, dtype=np.int32)  # default = CHEEKS

    x = vertices[:, 0]
    y = vertices[:, 1]
    z = vertices[:, 2]

    nx = normals[:, 0]
    ny = normals[:, 1]
    nz = normals[:, 2]

    # ── Bounding box ──
    y_min, y_max = y.min(), y.max()
    z_min, z_max = z.min(), z.max()
    x_min, x_max = x.min(), x.max()

    height = y_max - y_min     # ~3.12
    depth  = z_max - z_min     # ~2.23
    width  = x_max - x_min     # ~1.91

    # Normalized coordinates 0..1
    rel_y = (y - y_min) / height     # 0 = bottom, 1 = top
    rel_z = (z - z_min) / depth      # 0 = back, 1 = front
    # Rescale x into reference-head units so the thresholds work on a head of any size.
    half_width = max(abs(x_min), abs(x_max)) or REFERENCE_HALF_WIDTH
    x_scale = REFERENCE_HALF_WIDTH / half_width
    xs = x * x_scale                 # signed, for the left/right splits
    abs_x = np.abs(xs)               # distance from the midline

    # ── Classification (applied bottom-up, later assignments override earlier) ──

    # 18: NECK – bottom portion
    regions[rel_y < 0.33] = 18

    # 19: BACK_HEAD – upper portion, behind face, normals pointing backward
    regions[(rel_y > 0.45) & (rel_z < 0.40) & (nz < 0.1)] = 19

    # 0: SCALP – top of head
    regions[(rel_y > 0.76) & (ny > -0.3)] = 0
    # Also back-top
    regions[(rel_y > 0.65) & (rel_z < 0.45) & (ny > -0.2)] = 0

    # 1: FOREHEAD – upper face, front-facing
    regions[(rel_y > 0.67) & (rel_y < 0.80) & (rel_z > 0.55) & (nz > 0.1)] = 1

    # 2: BROW – narrow ridge above eyes
    regions[(rel_y > 0.62) & (rel_y < 0.68) & (rel_z > 0.55) & (nz > 0.2) & (abs_x > 0.08) & (abs_x < 0.55)] = 2

    # 3, 4: EYE sockets
    eye_band = (rel_y > 0.56) & (rel_y < 0.63) & (rel_z > 0.55) & (abs_x > 0.08)
    regions[eye_band & (xs > 0.05)] = 3   # LEFT
    regions[eye_band & (xs < -0.05)] = 4  # RIGHT

    # 5: NOSE_BRIDGE
    regions[(rel_y > 0.52) & (rel_y < 0.60) & (abs_x < 0.12) & (rel_z > 0.65) & (nz > 0.3)] = 5

    # 6: NOSE_TIP – most protruding
    regions[(rel_y > 0.47) & (rel_y < 0.54) & (abs_x < 0.10) & (rel_z > 0.80)] = 6

    # 7: NOSE_BASE – nostrils
    regions[(rel_y > 0.43) & (rel_y < 0.48) & (abs_x < 0.22) & (rel_z > 0.65) & (nz > 0.0)] = 7

    # 8: CHEEKBONE
    regions[(rel_y > 0.50) & (rel_y < 0.62) & (abs_x > 0.25) & (rel_z > 0.45) & (nz > -0.2)] = 8

    # 14: JAW_ANGLE – side of jaw
    regions[(rel_y > 0.28) & (rel_y < 0.46) & (abs_x > 0.30) & (rel_z > 0.25) & (rel_z < 0.60)] = 14

    # 13: JAW – lower front face
    jaw = (rel_y > 0.30) & (rel_y < 0.40) & (abs_x < 0.40) & (rel_z > 0.40) & (nz > -0.3)
    regions[jaw] = 13

    # 12: MOUTH_AREA
    regions[(rel_y > 0.40) & (rel_y < 0.46) & (abs_x < 0.35) & (rel_z > 0.60)] = 12

    # 10: UPPER_LIP
    regions[(rel_y > 0.40) & (rel_y < 0.44) & (abs_x < 0.25) & (rel_z > 0.68) & (nz > 0.2)] = 10

    # 11: LOWER_LIP
    regions[(rel_y > 0.37) & (rel_y < 0.41) & (abs_x < 0.20) & (rel_z > 0.68) & (nz > 0.1)] = 11

    # 15: CHIN
    regions[(rel_y > 0.33) & (rel_y < 0.40) & (abs_x < 0.25) & (rel_z > 0.50) & (nz > 0.0)] = 15

    # 16, 17: EARS
    ear_band = (rel_y > 0.40) & (rel_y < 0.62) & (abs_x > 0.42)
    regions[ear_band & (xs > 0)] = 16  # LEFT
    regions[ear_band & (xs < 0)] = 17  # RIGHT

    # ── Post-fix: remove scalp leaking onto front face ──
    face_front = (rel_y > 0.40) & (rel_y < 0.78) & (rel_z > 0.55) & (nz > 0.3)
    regions[face_front & (regions == 0)] = 1  # push to forehead

    return regions


def main():
    """Rebuilds the region map; run `python backend/analyze_mesh.py [model.glb] [output.json]`."""
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    default_src = os.path.join(repo, 'assets', 'models', 'base', 'head.glb')
    default_dst = os.path.join(repo, 'assets', 'models', 'base', 'head_regions.json')

    src = sys.argv[1] if len(sys.argv) > 1 else default_src
    dst = sys.argv[2] if len(sys.argv) > 2 else default_dst

    print(f'Loading {src}...')
    scene = trimesh.load(src)
    if isinstance(scene, trimesh.Scene):
        geo = list(scene.geometry.values())[0]
    else:
        geo = scene

    vertices = np.array(geo.vertices)
    normals = np.array(geo.vertex_normals)
    n_verts = len(vertices)

    print(f'Vertices: {n_verts}, Faces: {len(geo.faces)}')
    bb = geo.bounds
    print(f'Bounds: X({bb[0][0]:.3f}, {bb[1][0]:.3f}), '
          f'Y({bb[0][1]:.3f}, {bb[1][1]:.3f}), '
          f'Z({bb[0][2]:.3f}, {bb[1][2]:.3f})')

    regions = classify_vertices(vertices, normals)

    # Build output
    region_indices = {}
    stats = {}
    for rid, name in enumerate(REGION_NAMES):
        idxs = np.where(regions == rid)[0].tolist()
        region_indices[name] = idxs
        stats[name] = len(idxs)

    center = ((bb[0] + bb[1]) / 2).tolist()
    size = (bb[1] - bb[0]).tolist()

    output = {
        'vertex_count': n_verts,
        'face_count': len(geo.faces),
        'coordinate_system': 'Y-up (X=right, Y=up, Z=front)',
        'bounding_box': {
            'min': bb[0].tolist(),
            'max': bb[1].tolist(),
            'center': center,
            'size': size,
        },
        'per_vertex_region': regions.tolist(),
        'region_indices': region_indices,
        'stats': stats,
    }

    with open(dst, 'w') as f:
        json.dump(output, f)

    print(f'\nSaved {dst} ({os.path.getsize(dst) / 1024:.0f} KB)')
    print('\nRegion stats:')
    for name in REGION_NAMES:
        cnt = stats[name]
        pct = cnt / n_verts * 100
        print(f'  {name:15s}: {cnt:5d} ({pct:5.1f}%)')


if __name__ == '__main__':
    main()
