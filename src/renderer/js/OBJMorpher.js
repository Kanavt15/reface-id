/**
 * OBJMorpher.js
 * Region-based vertex deformation for loaded GLB/OBJ face meshes.
 * Uses trimesh-generated region data (head_regions.json) to identify
 * which vertices belong to which facial feature.
 *
 * Coordinate system: Y-up (glTF standard)
 *   X = right/left
 *   Y = up/down (height)
 *   Z = front/back (positive = face front)
 *
 * Region IDs (must match analyze_mesh.py):
 *   0=SCALP  1=FOREHEAD  2=BROW  3=EYE_LEFT  4=EYE_RIGHT
 *   5=NOSE_BRIDGE  6=NOSE_TIP  7=NOSE_BASE
 *   8=CHEEKBONE  9=CHEEKS  10=UPPER_LIP  11=LOWER_LIP  12=MOUTH_AREA
 *   13=JAW  14=JAW_ANGLE  15=CHIN  16=EAR_LEFT  17=EAR_RIGHT
 *   18=NECK  19=BACK_HEAD
 */

class OBJMorpher {
  constructor() {
    this.regionData = null;
    this.meshGroup = null;
    this.originalPositions = [];
    this.meshes = [];
    this.vertexOffsets = [];

    this.defaultValue = 50;
    this.morphValues = {};

    // Callback invoked after every applyAllMorphs() call (used for auto-hair-refresh)
    this.onMorphApplied = null;

    this.params = [
      'headWidth', 'headHeight', 'headDepth',
      'foreheadHeight', 'foreheadWidth', 'foreheadSlope', 'browRidgeDepth',
      'eyeSpacing', 'eyeSize', 'eyeHeight', 'eyeDepth', 'eyeTilt',
      'noseLength', 'noseWidth', 'noseBridge', 'noseProtrusion', 'noseTipShape',
      'cheekboneWidth', 'cheekboneHeight', 'cheekFullness',
      'mouthWidth', 'lipThicknessUpper', 'lipThicknessLower', 'mouthProtrusion',
      'jawWidth', 'jawAngle', 'chinHeight', 'chinWidth', 'chinProtrusion', 'chinShape',
      'earSize', 'earAngle',
      'neckWidth', 'neckLength',
    ];
    this.params.forEach(p => this.morphValues[p] = this.defaultValue);

    // Morph definitions — Y-up coordinate system
    // axis: x = left/right, y = up/down, z = front/back
    this.morphMap = {
      headWidth:         { regions: null,          axis: 'x',   type: 'scale',     range: [0.82, 1.25] },
      headHeight:        { regions: null,          axis: 'y',   type: 'scale',     range: [0.88, 1.18] },
      headDepth:         { regions: null,          axis: 'z',   type: 'scale',     range: [0.88, 1.18] },

      foreheadHeight:    { regions: [1],           axis: 'y',   type: 'translate', range: [-0.05, 0.07] },
      foreheadWidth:     { regions: [1],           axis: 'x',   type: 'scale',     range: [0.92, 1.12] },
      foreheadSlope:     { regions: [1],           axis: 'z',   type: 'translate', range: [-0.04, 0.04] },
      browRidgeDepth:    { regions: [2],           axis: 'z',   type: 'translate', range: [-0.02, 0.05] },

      eyeSpacing:        { regions: [3, 4],        axis: 'x',   type: 'scale',     range: [0.82, 1.22] },
      eyeSize:           { regions: [3, 4],        axis: 'xyz', type: 'scale',     range: [0.82, 1.22] },
      eyeHeight:         { regions: [3, 4],        axis: 'y',   type: 'translate', range: [-0.03, 0.05] },
      eyeDepth:          { regions: [3, 4],        axis: 'z',   type: 'translate', range: [-0.03, 0.03] },
      eyeTilt:           { regions: [3, 4],        axis: 'y',   type: 'tilt',      range: [-0.02, 0.02] },

      noseLength:        { regions: [5, 6, 7],     axis: 'y',   type: 'scale',     range: [0.78, 1.30] },
      noseWidth:         { regions: [7],           axis: 'x',   type: 'scale',     range: [0.72, 1.35] },
      noseBridge:        { regions: [5],           axis: 'x',   type: 'scale',     range: [0.82, 1.25] },
      noseProtrusion:    { regions: [6],           axis: 'z',   type: 'translate', range: [-0.02, 0.06] },
      noseTipShape:      { regions: [6],           axis: 'y',   type: 'translate', range: [-0.02, 0.02] },

      cheekboneWidth:    { regions: [8],           axis: 'x',   type: 'scale',     range: [0.92, 1.12] },
      cheekboneHeight:   { regions: [8],           axis: 'y',   type: 'translate', range: [-0.03, 0.03] },
      cheekFullness:     { regions: [9],           axis: 'z',   type: 'translate', range: [-0.02, 0.05] },

      mouthWidth:        { regions: [10, 11, 12],  axis: 'x',   type: 'scale',     range: [0.78, 1.25] },
      lipThicknessUpper: { regions: [10],          axis: 'z',   type: 'translate', range: [-0.015, 0.03] },
      lipThicknessLower: { regions: [11],          axis: 'z',   type: 'translate', range: [-0.015, 0.03] },
      mouthProtrusion:   { regions: [12, 10, 11],  axis: 'z',   type: 'translate', range: [-0.02, 0.04] },

      jawWidth:          { regions: [13, 14],      axis: 'x',   type: 'scale',     range: [0.88, 1.18] },
      jawAngle:          { regions: [14],          axis: 'z',   type: 'translate', range: [-0.03, 0.05] },
      chinHeight:        { regions: [15],          axis: 'y',   type: 'translate', range: [-0.04, 0.04] },
      chinWidth:         { regions: [15],          axis: 'x',   type: 'scale',     range: [0.82, 1.22] },
      chinProtrusion:    { regions: [15],          axis: 'z',   type: 'translate', range: [-0.04, 0.05] },
      chinShape:         { regions: [15],          axis: 'y',   type: 'scale',     range: [0.88, 1.18] },

      earSize:           { regions: [16, 17],      axis: 'xyz', type: 'scale',     range: [0.72, 1.35] },
      earAngle:          { regions: [16, 17],      axis: 'x',   type: 'translate', range: [-0.03, 0.05] },

      neckWidth:         { regions: [18],          axis: 'x',   type: 'scale',     range: [0.82, 1.25] },
      neckLength:        { regions: [18],          axis: 'y',   type: 'scale',     range: [0.88, 1.18] },
    };

    this._regionCentersBuilt = false;
    this._regionCentersCache = null;
  }

  setMeshGroup(group) {
    this.meshGroup = group;
    this.meshes = [];
    this.originalPositions = [];
    this.vertexOffsets = [];
    this._regionCentersBuilt = false;
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

    console.log(`OBJMorpher: bound ${this.meshes.length} mesh(es), ${offset} total vertices`);
  }

  setRegionData(data) {
    this.regionData = data;
    this.perVertexRegion = data.per_vertex_region;
    console.log(`OBJMorpher: region data loaded, ${data.vertex_count} vertices, ${Object.keys(data.stats).length} regions`);
  }

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
      skull: ['headWidth', 'headHeight', 'headDepth'],
      forehead: ['foreheadHeight', 'foreheadWidth', 'foreheadSlope', 'browRidgeDepth'],
      eyes: ['eyeSpacing', 'eyeSize', 'eyeHeight', 'eyeDepth', 'eyeTilt'],
      nose: ['noseLength', 'noseWidth', 'noseBridge', 'noseProtrusion', 'noseTipShape'],
      cheeks: ['cheekboneWidth', 'cheekboneHeight', 'cheekFullness'],
      mouth: ['mouthWidth', 'lipThicknessUpper', 'lipThicknessLower', 'mouthProtrusion'],
      jaw: ['jawWidth', 'jawAngle', 'chinHeight', 'chinWidth', 'chinProtrusion', 'chinShape'],
      ears: ['earSize', 'earAngle'],
      neck: ['neckWidth', 'neckLength'],
    };
    const params = groupMap[groupName] || [];
    params.forEach(p => this.morphValues[p] = this.defaultValue);
    this.applyAllMorphs();
  }

  applyAllMorphs() {
    if (!this.meshes.length || !this.perVertexRegion) return;

    // Reset positions to originals
    for (let m = 0; m < this.meshes.length; m++) {
      const positions = this.meshes[m].geometry.attributes.position;
      positions.array.set(this.originalPositions[m]);
    }

    // Bounding-box center
    const bb = this.regionData.bounding_box;
    const cx = bb.center[0];
    const cy = bb.center[1];
    const cz = bb.center[2];

    // Build region centers cache
    if (!this._regionCentersBuilt) {
      this._regionCentersCache = this._computeRegionCenters();
      this._regionCentersBuilt = true;
    }

    // Apply each active morph
    for (const [param, value] of Object.entries(this.morphValues)) {
      if (value === this.defaultValue) continue;

      const def = this.morphMap[param];
      if (!def) continue;

      const t = (value - this.defaultValue) / 50; // -1 to 1
      const halfRange = (def.range[1] - def.range[0]) / 2;
      const midVal = (def.range[0] + def.range[1]) / 2;
      const factor = midVal + t * halfRange;

      // Scale center: region center or global center
      let scx = cx, scy = cy, scz = cz;
      if (def.regions && this._regionCentersCache) {
        let sumX = 0, sumY = 0, sumZ = 0, cnt = 0;
        for (const rid of def.regions) {
          const rc = this._regionCentersCache[rid];
          if (rc) { sumX += rc[0]; sumY += rc[1]; sumZ += rc[2]; cnt++; }
        }
        if (cnt > 0) { scx = sumX / cnt; scy = sumY / cnt; scz = sumZ / cnt; }
      }

      for (let m = 0; m < this.meshes.length; m++) {
        const positions = this.meshes[m].geometry.attributes.position;
        const baseOffset = this.vertexOffsets[m];

        for (let i = 0; i < positions.count; i++) {
          const globalIdx = baseOffset + i;
          const vertexRegion = this.perVertexRegion[globalIdx];

          if (def.regions !== null && !def.regions.includes(vertexRegion)) continue;

          let x = positions.getX(i);
          let y = positions.getY(i);
          let z = positions.getZ(i);

          if (def.type === 'scale') {
            if (def.axis.includes('x')) x = scx + (x - scx) * factor;
            if (def.axis.includes('y')) y = scy + (y - scy) * factor;
            if (def.axis.includes('z')) z = scz + (z - scz) * factor;
          } else if (def.type === 'translate') {
            const offset = t * halfRange;
            if (def.axis === 'x') x += offset;
            if (def.axis === 'y') y += offset;
            if (def.axis === 'z') z += offset;
          } else if (def.type === 'tilt') {
            const tiltAmount = t * halfRange;
            const sign = (vertexRegion === 3) ? -1 : 1; // left vs right eye
            y += sign * (x - scx) * tiltAmount * 5;
          }

          positions.setXYZ(i, x, y, z);
        }
      }
    }

    // Finalize
    for (let m = 0; m < this.meshes.length; m++) {
      this.meshes[m].geometry.attributes.position.needsUpdate = true;
      this.meshes[m].geometry.computeVertexNormals();
      this.meshes[m].geometry.computeBoundingBox();
      this.meshes[m].geometry.computeBoundingSphere();
    }

    // Notify listeners (e.g. HairSystem)
    if (typeof this.onMorphApplied === 'function') this.onMorphApplied();
  }

  _computeRegionCenters() {
    const sums = {};
    for (let m = 0; m < this.meshes.length; m++) {
      const orig = this.originalPositions[m];
      const baseOffset = this.vertexOffsets[m];
      for (let i = 0; i < orig.length / 3; i++) {
        const globalIdx = baseOffset + i;
        const rid = this.perVertexRegion[globalIdx];
        if (rid === undefined) continue;
        if (!sums[rid]) sums[rid] = [0, 0, 0, 0];
        sums[rid][0] += orig[i * 3];
        sums[rid][1] += orig[i * 3 + 1];
        sums[rid][2] += orig[i * 3 + 2];
        sums[rid][3]++;
      }
    }
    const centers = {};
    for (const [rid, s] of Object.entries(sums)) {
      if (s[3] > 0) centers[rid] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    }
    return centers;
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
