"""
analyze_mesh.py – Trimesh-based facial region classification for head.glb

Coordinate system: Y-up (glTF standard)
  X = left / right  (symmetric)
  Y = up / down     (height, positive = top of head)
  Z = front / back  (positive = face front / nose)

Generates head_regions.json consumed by OBJMorpher.js and HairSystem.js.

Region IDs:
   0  SCALP        Top / back of head (hair growth area)
   1  FOREHEAD     Upper face between brows and scalp
   2  BROW         Brow ridge
   3  EYE_LEFT     Left eye socket
   4  EYE_RIGHT    Right eye socket
   5  NOSE_BRIDGE  Upper nose
   6  NOSE_TIP     Lower nose tip
   7  NOSE_BASE    Nostrils / base of nose
   8  CHEEKBONE    Upper cheek near eye
   9  CHEEKS       Mid / lower cheek
  10  UPPER_LIP    Above mouth
  11  LOWER_LIP    Below mouth
  12  MOUTH_AREA   Corners of mouth
  13  JAW          Lower jaw line
  14  JAW_ANGLE    Side of jaw
  15  CHIN         Bottom of chin
  16  EAR_LEFT     Left ear
  17  EAR_RIGHT    Right ear
  18  NECK         Neck below jaw
  19  BACK_HEAD    Back of skull
"""

import trimesh
import numpy as np
import json
import os
import sys

# Half-width of the reference head, measured off head.glb. Every lateral
# threshold in classify_vertices() is expressed in these units, so this is the
# number that makes x_scale exactly 1.0 for the mesh those thresholds were
# tuned against -- carrying the full precision keeps the reclassification of
# the shipped model at zero vertices rather than a handful of boundary flips.
REFERENCE_HALF_WIDTH = 0.9566180109977722

REGION_NAMES = [
    'SCALP', 'FOREHEAD', 'BROW', 'EYE_LEFT', 'EYE_RIGHT',
    'NOSE_BRIDGE', 'NOSE_TIP', 'NOSE_BASE',
    'CHEEKBONE', 'CHEEKS', 'UPPER_LIP', 'LOWER_LIP', 'MOUTH_AREA',
    'JAW', 'JAW_ANGLE', 'CHIN', 'EAR_LEFT', 'EAR_RIGHT',
    'NECK', 'BACK_HEAD',
]


def classify_vertices(vertices, normals):
    """Assign each vertex a region ID based on position + normal in Y-up coords."""
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
    # Lateral coordinates are rescaled into REFERENCE-HEAD units before any
    # threshold below sees them.
    #
    # rel_y and rel_z are normalised 0..1, but the x thresholds were raw
    # literals (0.08, 0.25, 0.42 ...) that silently assumed the reference
    # head's 1.913-unit width. On a mesh of any other scale every one of them
    # misclassifies -- which would have blocked a base-mesh swap, since the
    # region map has to be rebuilt for whatever mesh replaces head.glb.
    #
    # Rescaling here rather than renormalising the thresholds is deliberate:
    # on the reference head x_scale is exactly 1.0, so this is a no-op and the
    # shipped head_regions.json stays bit-identical. The literals also keep
    # their tuned meaning as measurements of a real head, instead of becoming
    # a table of six-decimal fractions nobody can sanity-check.
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
    """Regenerate the region map.

    Paths are arguments now, and default to the real location of the model.
    They were hardcoded to assets/models/head.glb, which stopped existing when
    the models were reorganised into base/ — so this script could not be run at
    all, which matters a great deal the moment the base mesh is replaced and
    the region map has to be rebuilt for it.

        python backend/analyze_mesh.py
        python backend/analyze_mesh.py candidate.glb candidate_regions.json
    """
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
