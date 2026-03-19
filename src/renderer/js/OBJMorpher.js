/**
 * OBJMorpher.js
 * Landmark-based vertex deformation for loaded GLB/OBJ face meshes.
 * Ported from the proven Python FaceDeformer logic with Gaussian weight
 * falloff, smooth directional functions, and face mask boundaries.
 *
 * Coordinate system: Y-up (glTF standard)
 *   X = left(-) / right(+)
 *   Y = down(-) / up(+)  (height)
 *   Z = back(-) / front(+)  (positive Z = face front / nose tip)
 */

class OBJMorpher {
  constructor() {
    this.meshGroup = null;
    this.originalPositions = [];
    this.meshes = [];
    this.vertexOffsets = [];
    this.totalVertices = 0;

    this._allVerts = null;
    this._faceMask = null;
    this._landmarkIndices = {};
    this._landmarkPositions = {};

    this.onMorphApplied = null;
    this.skinMarkSystem = null; // Reference to SkinMarkSystem for mark repositioning

    this.defaultValue = 50;
    this.morphValues = {};

    this.regionData = null;
    this.perVertexRegion = null;

    this.params = [
      'faceWidth', 'faceLength', 'headWidth', 'headLength', 'faceTaper',
      'foreheadHeight', 'foreheadSlope', 'foreheadWidth', 'templeWidth', 'foreheadBulge',
      'browHeight', 'browSpacing', 'browProminence', 'browArch', 'browThickness',
      'eyeSpacing', 'eyeHeight', 'eyeDepth', 'eyeSize', 'eyeTilt', 'eyeOpenness',
      'noseLength', 'noseWidth', 'noseBridgeWidth', 'noseBridgeHeight',
      'noseTipHeight', 'noseTipWidth', 'nostrilFlare',
      'cheekFullness', 'cheekboneProminence', 'cheekHeight', 'nasolabialDepth',
      'mouthWidth', 'mouthHeight', 'lipProtrusion',
      'upperLipThickness', 'lowerLipThickness',
      'cupidBow', 'philtrumDepth', 'philtrumWidth', 'lipCornerAngle',
      'jawWidth', 'chinHeight', 'chinWidth', 'chinProtrusion', 'jawDefinition',
      'earSize', 'earProtrusion', 'earHeight', 'earlobeSize',
    ];
    this.params.forEach(p => this.morphValues[p] = this.defaultValue);
  }

  static get MODEL_CONFIG() {
    return {
      face_y_min: -0.80,
      face_y_max:  1.30,
      scale_factor: 0.19,
      z_front_direction: 1,
      radius_scale: 3.5,
      transition_width: 0.075,
      boundary_falloff: 0.19,
    };
  }

  static get LANDMARKS() {
    return {
      chin:             [0.0, -0.60, 1.08],
      chin_left:        [-0.15, -0.55, 1.06],
      chin_right:       [0.15, -0.55, 1.06],
      jaw_left:         [-0.45, -0.45, 0.85],
      jaw_right:        [0.45, -0.45, 0.85],
      jaw_angle_left:   [-0.60, -0.35, 0.60],
      jaw_angle_right:  [0.60, -0.35, 0.60],

      cheek_left:         [-0.40, -0.15, 0.95],
      cheek_right:        [0.40, -0.15, 0.95],
      cheekbone_left:     [-0.50, 0.05, 0.90],
      cheekbone_right:    [0.50, 0.05, 0.90],
      lower_cheek_left:   [-0.35, -0.30, 1.00],
      lower_cheek_right:  [0.35, -0.30, 1.00],

      nose_tip:           [0.0, 0.02, 1.30],
      nose_bridge:        [0.0, 0.20, 1.19],
      nose_bridge_top:    [0.0, 0.30, 1.14],
      nostril_left:       [-0.12, -0.05, 1.15],
      nostril_right:      [0.12, -0.05, 1.15],
      nose_base:          [0.0, -0.08, 1.18],
      alar_left:          [-0.16, -0.03, 1.12],
      alar_right:         [0.16, -0.03, 1.12],

      eye_left_outer:     [-0.45, 0.22, 0.95],
      eye_left_inner:     [-0.15, 0.22, 1.05],
      eye_right_inner:    [0.15, 0.22, 1.05],
      eye_right_outer:    [0.45, 0.22, 0.95],
      eye_left_center:    [-0.30, 0.22, 1.00],
      eye_right_center:   [0.30, 0.22, 1.00],
      eye_left_upper:     [-0.30, 0.28, 1.02],
      eye_left_lower:     [-0.30, 0.16, 0.98],
      eye_right_upper:    [0.30, 0.28, 1.02],
      eye_right_lower:    [0.30, 0.16, 0.98],

      brow_left_inner:    [-0.15, 0.38, 1.06],
      brow_left_center:   [-0.30, 0.40, 1.00],
      brow_left_outer:    [-0.45, 0.38, 0.90],
      brow_right_inner:   [0.15, 0.38, 1.06],
      brow_right_center:  [0.30, 0.40, 1.00],
      brow_right_outer:   [0.45, 0.38, 0.90],
      glabella:           [0.0, 0.38, 1.08],

      forehead_center:    [0.0, 0.60, 1.07],
      forehead_left:      [-0.35, 0.58, 0.98],
      forehead_right:     [0.35, 0.58, 0.98],
      temple_left:        [-0.60, 0.35, 0.70],
      temple_right:       [0.60, 0.35, 0.70],
      hairline_center:    [0.0, 0.90, 0.98],

      mouth_left:         [-0.20, -0.30, 1.10],
      mouth_right:        [0.20, -0.30, 1.10],
      upper_lip_center:   [0.0, -0.25, 1.15],
      upper_lip_left:     [-0.08, -0.25, 1.14],
      upper_lip_right:    [0.08, -0.25, 1.14],
      lower_lip_center:   [0.0, -0.35, 1.13],
      lower_lip_left:     [-0.08, -0.35, 1.12],
      lower_lip_right:    [0.08, -0.35, 1.12],
      cupid_bow_left:     [-0.06, -0.23, 1.16],
      cupid_bow_right:    [0.06, -0.23, 1.16],
      philtrum_top:       [0.0, -0.15, 1.14],
      philtrum_bottom:    [0.0, -0.22, 1.16],

      ear_left_top:       [-0.78, 0.30, -0.05],
      ear_left_center:    [-0.85, 0.15, -0.10],
      ear_left_bottom:    [-0.78, 0.00, -0.05],
      ear_right_top:      [0.78, 0.30, -0.05],
      ear_right_center:   [0.85, 0.15, -0.10],
      ear_right_bottom:   [0.78, 0.00, -0.05],
      tragus_left:        [-0.72, 0.15, 0.10],
      tragus_right:       [0.72, 0.15, 0.10],

      crown:              [0.0, 1.35, 0.10],
      occiput:            [0.0, 0.50, -0.80],
      skull_left:         [-0.75, 0.50, -0.20],
      skull_right:        [0.75, 0.50, -0.20],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SETUP
  // ═══════════════════════════════════════════════════════════════════════

  setMeshGroup(group) {
    this.meshGroup = group;
    this.meshes = [];
    this.originalPositions = [];
    this.vertexOffsets = [];
    let offset = 0;

    group.traverse((child) => {
      if (child.isMesh && child.geometry) {
        this.meshes.push(child);
        const pos = child.geometry.attributes.position;
        this.originalPositions.push(new Float32Array(pos.array));
        this.vertexOffsets.push(offset);
        offset += pos.count;
      }
    });

    this.totalVertices = offset;
    console.log(`OBJMorpher: bound ${this.meshes.length} mesh(es), ${offset} total vertices`);

    this._buildVertexArray();
    this._detectLandmarks();
    this._createFaceMask();
  }

  setRegionData(data) {
    this.regionData = data;
    this.perVertexRegion = data.per_vertex_region;
    console.log(`OBJMorpher: region data loaded, ${data.vertex_count} vertices`);
  }

  _buildVertexArray() {
    const N = this.totalVertices;
    this._allVerts = new Float64Array(N * 3);
    for (let m = 0; m < this.meshes.length; m++) {
      const orig = this.originalPositions[m];
      const off = this.vertexOffsets[m];
      for (let i = 0; i < orig.length / 3; i++) {
        const gi = off + i;
        this._allVerts[gi * 3]     = orig[i * 3];
        this._allVerts[gi * 3 + 1] = orig[i * 3 + 1];
        this._allVerts[gi * 3 + 2] = orig[i * 3 + 2];
      }
    }
  }

  _detectLandmarks() {
    const verts = this._allVerts;
    const N = this.totalVertices;

    for (const [name, pos] of Object.entries(OBJMorpher.LANDMARKS)) {
      let bestDist = Infinity;
      let bestIdx = 0;
      const px = pos[0], py = pos[1], pz = pos[2];

      for (let i = 0; i < N; i++) {
        const dx = verts[i * 3] - px;
        const dy = verts[i * 3 + 1] - py;
        const dz = verts[i * 3 + 2] - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDist) {
          bestDist = d2;
          bestIdx = i;
        }
      }

      this._landmarkIndices[name] = bestIdx;
      this._landmarkPositions[name] = [
        verts[bestIdx * 3],
        verts[bestIdx * 3 + 1],
        verts[bestIdx * 3 + 2],
      ];
    }

    console.log(`OBJMorpher: detected ${Object.keys(this._landmarkPositions).length} landmarks`);
  }

  _createFaceMask() {
    const N = this.totalVertices;
    const cfg = OBJMorpher.MODEL_CONFIG;
    const yMin = cfg.face_y_min;
    const yMax = cfg.face_y_max;
    const falloff = cfg.boundary_falloff;
    this._faceMask = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      const y = this._allVerts[i * 3 + 1];
      let mask = 1.0;
      if (y < yMin + falloff) {
        mask = Math.max(0, Math.min(1, (y - yMin) / falloff));
      }
      if (y > yMax - falloff) {
        mask = Math.min(mask, Math.max(0, Math.min(1, (yMax - y) / falloff)));
      }
      this._faceMask[i] = mask;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WEIGHT FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════

  _getRegionWeights(landmarkNames, radius) {
    const cfg = OBJMorpher.MODEL_CONFIG;
    radius *= cfg.radius_scale;
    const N = this.totalVertices;
    const weights = new Float64Array(N);
    const verts = this._allVerts;
    const twoR2 = 2 * radius * radius;

    for (const name of landmarkNames) {
      const lp = this._landmarkPositions[name];
      if (!lp) continue;
      const lx = lp[0], ly = lp[1], lz = lp[2];

      for (let i = 0; i < N; i++) {
        const dx = verts[i * 3] - lx;
        const dy = verts[i * 3 + 1] - ly;
        const dz = verts[i * 3 + 2] - lz;
        const d2 = dx * dx + dy * dy + dz * dz;
        const w = Math.exp(-d2 / twoR2);
        if (w > weights[i]) weights[i] = w;
      }
    }

    for (let i = 0; i < N; i++) {
      weights[i] *= this._faceMask[i];
    }
    return weights;
  }

  _getDirectionalWeights(landmarkNames, radius) {
    const weights = this._getRegionWeights(landmarkNames, radius);
    const N = this.totalVertices;
    const directions = new Float64Array(N);
    const tw = OBJMorpher.MODEL_CONFIG.transition_width;
    const verts = this._allVerts;

    for (let i = 0; i < N; i++) {
      directions[i] = Math.tanh(verts[i * 3] / tw);
    }
    return { weights, directions };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MORPH APPLICATION
  // ═══════════════════════════════════════════════════════════════════════

  setMorphValue(param, value) {
    if (this.params.includes(param)) {
      this.morphValues[param] = value;
      this.applyAllMorphs();
    }
  }

  getModifiedCount() {
    return Object.values(this.morphValues).filter(v => v !== this.defaultValue).length;
  }

  resetAll() {
    this.params.forEach(p => this.morphValues[p] = this.defaultValue);
    this.applyAllMorphs();
  }

  resetGroup(groupName) {
    const groupMap = {
      skull:    ['faceWidth', 'faceLength', 'headWidth', 'headLength', 'faceTaper'],
      forehead: ['foreheadHeight', 'foreheadSlope', 'foreheadWidth', 'templeWidth', 'foreheadBulge'],
      brows:    ['browHeight', 'browSpacing', 'browProminence', 'browArch', 'browThickness'],
      eyes:     ['eyeSpacing', 'eyeHeight', 'eyeDepth', 'eyeSize', 'eyeTilt', 'eyeOpenness'],
      nose:     ['noseLength', 'noseWidth', 'noseBridgeWidth', 'noseBridgeHeight',
                 'noseTipHeight', 'noseTipWidth', 'nostrilFlare'],
      cheeks:   ['cheekFullness', 'cheekboneProminence', 'cheekHeight', 'nasolabialDepth'],
      mouth:    ['mouthWidth', 'mouthHeight', 'lipProtrusion',
                 'upperLipThickness', 'lowerLipThickness',
                 'cupidBow', 'philtrumDepth', 'philtrumWidth', 'lipCornerAngle'],
      jaw:      ['jawWidth', 'chinHeight', 'chinWidth', 'chinProtrusion', 'jawDefinition'],
      ears:     ['earSize', 'earProtrusion', 'earHeight', 'earlobeSize'],
    };
    const params = groupMap[groupName] || [];
    params.forEach(p => this.morphValues[p] = this.defaultValue);
    this.applyAllMorphs();
  }

  applyAllMorphs() {
    if (!this.meshes.length || !this._allVerts) return;

    // Reset to originals
    for (let m = 0; m < this.meshes.length; m++) {
      this.meshes[m].geometry.attributes.position.array.set(this.originalPositions[m]);
    }

    const cfg = OBJMorpher.MODEL_CONFIG;
    const scale = cfg.scale_factor;
    const zDir = cfg.z_front_direction;

    const active = {};
    for (const [p, v] of Object.entries(this.morphValues)) {
      if (v !== this.defaultValue) {
        active[p] = (v - this.defaultValue) / 50;
      }
    }

    if (Object.keys(active).length === 0) {
      this._finalizeGeometry();
      return;
    }

    const N = this.totalVertices;
    const offsets = new Float64Array(N * 3);

    // ─── JAW & CHIN ────────────────────────────────────────────────────

    if (active.jawWidth !== undefined) {
      const t = active.jawWidth;
      const { weights, directions } = this._getDirectionalWeights(
        ['jaw_left', 'jaw_right', 'jaw_angle_left', 'jaw_angle_right'], 0.12);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.chinHeight !== undefined) {
      const t = active.chinHeight;
      const weights = this._getRegionWeights(['chin', 'chin_left', 'chin_right'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] -= weights[i] * disp;
    }

    if (active.chinWidth !== undefined) {
      const t = active.chinWidth;
      const { weights, directions } = this._getDirectionalWeights(
        ['chin', 'chin_left', 'chin_right'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.chinProtrusion !== undefined) {
      const t = active.chinProtrusion;
      const weights = this._getRegionWeights(['chin', 'chin_left', 'chin_right'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }

    if (active.jawDefinition !== undefined) {
      const t = active.jawDefinition;
      const { weights, directions } = this._getDirectionalWeights(
        ['jaw_angle_left', 'jaw_angle_right'], 0.10);
      const disp = t * scale;
      for (let i = 0; i < N; i++) {
        offsets[i*3]   += directions[i] * weights[i] * disp * 0.7;
        offsets[i*3+1] -= weights[i] * disp * 0.3;
      }
    }

    // ─── NOSE ──────────────────────────────────────────────────────────

    if (active.noseLength !== undefined) {
      const t = active.noseLength;
      const weights = this._getRegionWeights(['nose_tip', 'nose_base'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }

    if (active.noseWidth !== undefined) {
      const t = active.noseWidth;
      const { weights, directions } = this._getDirectionalWeights(
        ['nostril_left', 'nostril_right', 'alar_left', 'alar_right'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.noseBridgeWidth !== undefined) {
      const t = active.noseBridgeWidth;
      const { weights, directions } = this._getDirectionalWeights(
        ['nose_bridge', 'nose_bridge_top'], 0.05);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.noseBridgeHeight !== undefined) {
      const t = active.noseBridgeHeight;
      const weights = this._getRegionWeights(['nose_bridge', 'nose_bridge_top'], 0.05);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }

    if (active.noseTipHeight !== undefined) {
      const t = active.noseTipHeight;
      const weights = this._getRegionWeights(['nose_tip'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }

    if (active.noseTipWidth !== undefined) {
      const t = active.noseTipWidth;
      const { weights, directions } = this._getDirectionalWeights(['nose_tip'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.nostrilFlare !== undefined) {
      const t = active.nostrilFlare;
      const { weights, directions } = this._getDirectionalWeights(
        ['nostril_left', 'nostril_right', 'alar_left', 'alar_right'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    // ─── EYES ──────────────────────────────────────────────────────────

    if (active.eyeSpacing !== undefined) {
      const t = active.eyeSpacing;
      const { weights, directions } = this._getDirectionalWeights(
        ['eye_left_center', 'eye_right_center',
         'eye_left_inner', 'eye_right_inner',
         'eye_left_outer', 'eye_right_outer'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.eyeHeight !== undefined) {
      const t = active.eyeHeight;
      const weights = this._getRegionWeights(['eye_left_center', 'eye_right_center'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }

    if (active.eyeDepth !== undefined) {
      const t = active.eyeDepth;
      const weights = this._getRegionWeights(['eye_left_center', 'eye_right_center'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] -= zDir * weights[i] * disp;
    }

    if (active.eyeSize !== undefined) {
      const t = active.eyeSize;
      const disp = t * 0.15;
      for (const side of ['left', 'right']) {
        const cp = this._landmarkPositions[`eye_${side}_center`];
        if (!cp) continue;
        const landmarks = [
          `eye_${side}_center`, `eye_${side}_inner`,
          `eye_${side}_outer`, `eye_${side}_upper`, `eye_${side}_lower`];
        const weights = this._getRegionWeights(landmarks, 0.05);
        for (let i = 0; i < N; i++) {
          if (weights[i] < 0.001) continue;
          offsets[i*3]   += (this._allVerts[i*3]   - cp[0]) * weights[i] * disp;
          offsets[i*3+1] += (this._allVerts[i*3+1] - cp[1]) * weights[i] * disp;
          offsets[i*3+2] += (this._allVerts[i*3+2] - cp[2]) * weights[i] * disp;
        }
      }
    }

    if (active.eyeTilt !== undefined) {
      const t = active.eyeTilt;
      const disp = t * scale * 0.5;
      const wO = this._getRegionWeights(['eye_left_outer', 'eye_right_outer'], 0.04);
      const wI = this._getRegionWeights(['eye_left_inner', 'eye_right_inner'], 0.04);
      for (let i = 0; i < N; i++) {
        offsets[i*3+1] += wO[i] * disp;
        offsets[i*3+1] -= wI[i] * disp * 0.5;
      }
    }

    if (active.eyeOpenness !== undefined) {
      const t = active.eyeOpenness;
      const disp = t * scale * 0.3;
      const wU = this._getRegionWeights(['eye_left_upper', 'eye_right_upper'], 0.03);
      const wL = this._getRegionWeights(['eye_left_lower', 'eye_right_lower'], 0.03);
      for (let i = 0; i < N; i++) {
        offsets[i*3+1] += wU[i] * disp;
        offsets[i*3+1] -= wL[i] * disp;
      }
    }

    // ─── BROWS ─────────────────────────────────────────────────────────

    if (active.browHeight !== undefined) {
      const t = active.browHeight;
      const weights = this._getRegionWeights(
        ['brow_left_center', 'brow_right_center',
         'brow_left_inner', 'brow_right_inner',
         'brow_left_outer', 'brow_right_outer'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }

    if (active.browSpacing !== undefined) {
      const t = active.browSpacing;
      const { weights, directions } = this._getDirectionalWeights(
        ['brow_left_center', 'brow_right_center',
         'brow_left_inner', 'brow_right_inner'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.browProminence !== undefined) {
      const t = active.browProminence;
      const weights = this._getRegionWeights(
        ['brow_left_center', 'brow_right_center', 'glabella'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }

    if (active.browArch !== undefined) {
      const t = active.browArch;
      const weights = this._getRegionWeights(
        ['brow_left_center', 'brow_right_center'], 0.04);
      const disp = t * scale * 0.5;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }

    if (active.browThickness !== undefined) {
      const t = active.browThickness;
      const weights = this._getRegionWeights(
        ['brow_left_center', 'brow_right_center'], 0.06);
      const disp = t * scale * 0.5;
      for (let i = 0; i < N; i++) {
        offsets[i*3+2] += zDir * weights[i] * disp;
        offsets[i*3+1] += weights[i] * disp * 0.3;
      }
    }

    // ─── FOREHEAD ──────────────────────────────────────────────────────

    if (active.foreheadHeight !== undefined) {
      const t = active.foreheadHeight;
      const weights = this._getRegionWeights(
        ['forehead_center', 'forehead_left', 'forehead_right', 'hairline_center'], 0.12);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }

    if (active.foreheadSlope !== undefined) {
      const t = active.foreheadSlope;
      const weights = this._getRegionWeights(
        ['forehead_center', 'forehead_left', 'forehead_right'], 0.10);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }

    if (active.foreheadWidth !== undefined) {
      const t = active.foreheadWidth;
      const { weights, directions } = this._getDirectionalWeights(
        ['forehead_left', 'forehead_right'], 0.10);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.templeWidth !== undefined) {
      const t = active.templeWidth;
      const { weights, directions } = this._getDirectionalWeights(
        ['temple_left', 'temple_right'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.foreheadBulge !== undefined) {
      const t = active.foreheadBulge;
      const weights = this._getRegionWeights(['forehead_center'], 0.10);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }

    // ─── CHEEKS ────────────────────────────────────────────────────────

    if (active.cheekFullness !== undefined) {
      const t = active.cheekFullness;
      const weights = this._getRegionWeights(
        ['cheek_left', 'cheek_right', 'lower_cheek_left', 'lower_cheek_right'], 0.10);
      const disp = t * scale;
      const tw = OBJMorpher.MODEL_CONFIG.transition_width;
      for (let i = 0; i < N; i++) {
        const dir = Math.tanh(this._allVerts[i*3] / tw);
        offsets[i*3]   += dir * weights[i] * disp * 0.7;
        offsets[i*3+2] += zDir * weights[i] * disp * 0.5;
      }
    }

    if (active.cheekboneProminence !== undefined) {
      const t = active.cheekboneProminence;
      const weights = this._getRegionWeights(['cheekbone_left', 'cheekbone_right'], 0.08);
      const disp = t * scale;
      const tw = OBJMorpher.MODEL_CONFIG.transition_width;
      for (let i = 0; i < N; i++) {
        const dir = Math.tanh(this._allVerts[i*3] / tw);
        offsets[i*3]   += dir * weights[i] * disp * 0.6;
        offsets[i*3+2] += zDir * weights[i] * disp * 0.4;
      }
    }

    if (active.cheekHeight !== undefined) {
      const t = active.cheekHeight;
      const weights = this._getRegionWeights(
        ['cheek_left', 'cheek_right', 'cheekbone_left', 'cheekbone_right'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }

    if (active.nasolabialDepth !== undefined) {
      const t = active.nasolabialDepth;
      const weights = this._getRegionWeights(['lower_cheek_left', 'lower_cheek_right'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] -= zDir * weights[i] * disp;
    }

    // ─── MOUTH & LIPS ─────────────────────────────────────────────────

    if (active.mouthWidth !== undefined) {
      const t = active.mouthWidth;
      const { weights, directions } = this._getDirectionalWeights(
        ['mouth_left', 'mouth_right'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.mouthHeight !== undefined) {
      const t = active.mouthHeight;
      const weights = this._getRegionWeights(
        ['mouth_left', 'mouth_right', 'upper_lip_center', 'lower_lip_center'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }

    if (active.lipProtrusion !== undefined) {
      const t = active.lipProtrusion;
      const weights = this._getRegionWeights(
        ['upper_lip_center', 'lower_lip_center',
         'upper_lip_left', 'upper_lip_right',
         'lower_lip_left', 'lower_lip_right'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }

    if (active.upperLipThickness !== undefined) {
      const t = active.upperLipThickness;
      const weights = this._getRegionWeights(
        ['upper_lip_center', 'upper_lip_left', 'upper_lip_right'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) {
        offsets[i*3+2] += zDir * weights[i] * disp * 0.5;
        offsets[i*3+1] += weights[i] * disp * 0.3;
      }
    }

    if (active.lowerLipThickness !== undefined) {
      const t = active.lowerLipThickness;
      const weights = this._getRegionWeights(
        ['lower_lip_center', 'lower_lip_left', 'lower_lip_right'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) {
        offsets[i*3+2] += zDir * weights[i] * disp * 0.5;
        offsets[i*3+1] -= weights[i] * disp * 0.3;
      }
    }

    if (active.cupidBow !== undefined) {
      const t = active.cupidBow;
      const weights = this._getRegionWeights(['cupid_bow_left', 'cupid_bow_right'], 0.03);
      const disp = t * scale * 0.5;
      for (let i = 0; i < N; i++) {
        offsets[i*3+1] += weights[i] * disp;
        offsets[i*3+2] += zDir * weights[i] * disp * 0.3;
      }
    }

    if (active.philtrumDepth !== undefined) {
      const t = active.philtrumDepth;
      const weights = this._getRegionWeights(['philtrum_top', 'philtrum_bottom'], 0.03);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] -= zDir * weights[i] * disp;
    }

    if (active.philtrumWidth !== undefined) {
      const t = active.philtrumWidth;
      const { weights, directions } = this._getDirectionalWeights(
        ['philtrum_top', 'philtrum_bottom'], 0.03);
      const disp = t * scale * 0.5;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.lipCornerAngle !== undefined) {
      const t = active.lipCornerAngle;
      const weights = this._getRegionWeights(['mouth_left', 'mouth_right'], 0.04);
      const disp = t * scale * 0.5;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }

    // ─── EARS ──────────────────────────────────────────────────────────

    if (active.earSize !== undefined) {
      const t = active.earSize;
      const disp = t * 0.15;
      for (const side of ['left', 'right']) {
        const cp = this._landmarkPositions[`ear_${side}_center`];
        if (!cp) continue;
        const landmarks = [
          `ear_${side}_top`, `ear_${side}_center`,
          `ear_${side}_bottom`, `tragus_${side}`];
        const weights = this._getRegionWeights(landmarks, 0.06);
        for (let i = 0; i < N; i++) {
          if (weights[i] < 0.001) continue;
          offsets[i*3]   += (this._allVerts[i*3]   - cp[0]) * weights[i] * disp;
          offsets[i*3+1] += (this._allVerts[i*3+1] - cp[1]) * weights[i] * disp;
          offsets[i*3+2] += (this._allVerts[i*3+2] - cp[2]) * weights[i] * disp;
        }
      }
    }

    if (active.earProtrusion !== undefined) {
      const t = active.earProtrusion;
      const { weights, directions } = this._getDirectionalWeights(
        ['ear_left_center', 'ear_right_center', 'ear_left_top', 'ear_right_top'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.earHeight !== undefined) {
      const t = active.earHeight;
      const weights = this._getRegionWeights(
        ['ear_left_center', 'ear_right_center',
         'ear_left_top', 'ear_right_top',
         'ear_left_bottom', 'ear_right_bottom'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }

    if (active.earlobeSize !== undefined) {
      const t = active.earlobeSize;
      const weights = this._getRegionWeights(['ear_left_bottom', 'ear_right_bottom'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] -= weights[i] * disp;
    }

    // ─── OVERALL HEAD / FACE ───────────────────────────────────────────

    if (active.faceWidth !== undefined) {
      const t = active.faceWidth;
      const disp = t * 0.1;
      for (let i = 0; i < N; i++) {
        offsets[i*3] += this._allVerts[i*3] * this._faceMask[i] * disp;
      }
    }

    if (active.faceLength !== undefined) {
      const t = active.faceLength;
      const disp = t * 0.1;
      let sumY = 0;
      for (let i = 0; i < N; i++) sumY += this._allVerts[i*3+1];
      const meanY = sumY / N;
      for (let i = 0; i < N; i++) {
        offsets[i*3+1] += (this._allVerts[i*3+1] - meanY) * this._faceMask[i] * disp;
      }
    }

    if (active.headWidth !== undefined) {
      const t = active.headWidth;
      const { weights, directions } = this._getDirectionalWeights(
        ['skull_left', 'skull_right', 'temple_left', 'temple_right'], 0.15);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    if (active.headLength !== undefined) {
      const t = active.headLength;
      const weights = this._getRegionWeights(['occiput', 'crown'], 0.15);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] -= zDir * weights[i] * disp;
    }

    if (active.faceTaper !== undefined) {
      const t = active.faceTaper;
      const yRange = cfg.face_y_max - cfg.face_y_min;
      const tw = cfg.transition_width;
      const disp = t * scale;
      for (let i = 0; i < N; i++) {
        const yNorm = 1 - (this._allVerts[i*3+1] - cfg.face_y_min) / yRange;
        const yf = Math.max(0, Math.min(1, yNorm));
        const yf2 = yf * yf;
        const dir = Math.tanh(this._allVerts[i*3] / tw);
        offsets[i*3] -= dir * yf2 * this._faceMask[i] * disp;
      }
    }

    // ─── APPLY OFFSETS ─────────────────────────────────────────────────

    for (let m = 0; m < this.meshes.length; m++) {
      const positions = this.meshes[m].geometry.attributes.position;
      const baseOffset = this.vertexOffsets[m];

      for (let i = 0; i < positions.count; i++) {
        const gi = baseOffset + i;
        positions.setXYZ(
          i,
          positions.getX(i) + offsets[gi*3],
          positions.getY(i) + offsets[gi*3+1],
          positions.getZ(i) + offsets[gi*3+2],
        );
      }
    }

    this._finalizeGeometry();
  }

  _finalizeGeometry() {
    for (let m = 0; m < this.meshes.length; m++) {
      this.meshes[m].geometry.attributes.position.needsUpdate = true;
      this.meshes[m].geometry.computeVertexNormals();
      this.meshes[m].geometry.computeBoundingBox();
      this.meshes[m].geometry.computeBoundingSphere();
    }

    // Refresh skin marks after morphing is complete
    if (this.skinMarkSystem && typeof this.skinMarkSystem.refreshMarksAfterMorph === 'function') {
      this.skinMarkSystem.refreshMarksAfterMorph();
    }

    if (typeof this.onMorphApplied === 'function') this.onMorphApplied();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get the current (post-morph) position of a named landmark vertex.
   * Returns [x, y, z] or null if not found.
   */
  getCurrentLandmarkPosition(name) {
    const idx = this._landmarkIndices[name];
    if (idx === undefined) return null;
    // Find which mesh contains this global vertex index
    for (let m = 0; m < this.meshes.length; m++) {
      const baseOffset = this.vertexOffsets[m];
      const count = this.meshes[m].geometry.attributes.position.count;
      if (idx >= baseOffset && idx < baseOffset + count) {
        const localIdx = idx - baseOffset;
        const pos = this.meshes[m].geometry.attributes.position;
        return [pos.getX(localIdx), pos.getY(localIdx), pos.getZ(localIdx)];
      }
    }
    return null;
  }

  exportState() { return { ...this.morphValues }; }

  loadState(state) {
    if (!state) return;
    for (const [key, value] of Object.entries(state)) {
      if (this.params.includes(key)) {
        this.morphValues[key] = typeof value === 'number' && value <= 1
          ? Math.round(value * 100) : value;
      }
    }
    this.applyAllMorphs();
  }
}

window.OBJMorpher = OBJMorpher;
