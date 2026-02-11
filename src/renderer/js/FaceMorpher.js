/**
 * FaceMorpher.js
 * Handles real-time facial feature morphing in Three.js.
 * Manipulates vertex positions based on region assignments and morph parameters.
 * Provides instant visual feedback while Blender handles final high-quality output.
 */

class FaceMorpher {
  constructor(baseFaceGeometry) {
    this.baseFace = baseFaceGeometry;
    this.morphValues = {};
    this.defaultValue = 50; // 0-100 range, 50 = neutral

    // Initialize all morph parameters
    this.params = [
      // Skull
      'headWidth', 'headHeight', 'headDepth',
      // Forehead
      'foreheadHeight', 'foreheadWidth', 'foreheadSlope', 'browRidgeDepth',
      // Eyes
      'eyeSpacing', 'eyeSize', 'eyeHeight', 'eyeDepth', 'eyeTilt',
      // Nose
      'noseLength', 'noseWidth', 'noseBridge', 'noseProtrusion', 'noseTipShape',
      // Cheeks
      'cheekboneWidth', 'cheekboneHeight', 'cheekFullness',
      // Mouth
      'mouthWidth', 'lipThicknessUpper', 'lipThicknessLower', 'mouthProtrusion',
      // Jaw
      'jawWidth', 'jawAngle', 'chinHeight', 'chinWidth', 'chinProtrusion', 'chinShape',
      // Ears
      'earSize', 'earAngle',
      // Neck
      'neckWidth', 'neckLength',
    ];

    // Set all to default
    this.params.forEach(p => this.morphValues[p] = this.defaultValue);

    // Map parameters to regions and transformations
    this.morphMap = {
      headWidth:        { regions: null, axis: 'x', type: 'scale', range: [0.8, 1.3] },
      headHeight:       { regions: null, axis: 'z', type: 'scale', range: [0.85, 1.2] },
      headDepth:        { regions: null, axis: 'y', type: 'scale', range: [0.85, 1.2] },

      foreheadHeight:   { regions: [1], axis: 'z', type: 'translate', range: [-0.06, 0.08] },
      foreheadWidth:    { regions: [1], axis: 'x', type: 'scale', range: [0.9, 1.15] },
      foreheadSlope:    { regions: [1], axis: 'y', type: 'translate', range: [-0.05, 0.05] },
      browRidgeDepth:   { regions: [2], axis: 'y', type: 'translate', range: [-0.02, 0.06] },

      eyeSpacing:       { regions: [3, 4], axis: 'x', type: 'scale', range: [0.8, 1.25] },
      eyeSize:          { regions: [3, 4], axis: 'xyz', type: 'scale', range: [0.8, 1.25] },
      eyeHeight:        { regions: [3, 4], axis: 'z', type: 'translate', range: [-0.04, 0.06] },
      eyeDepth:         { regions: [3, 4], axis: 'y', type: 'translate', range: [-0.04, 0.04] },
      eyeTilt:          { regions: [3, 4], axis: 'z', type: 'tilt', range: [-0.03, 0.03] },

      noseLength:       { regions: [5, 6, 7], axis: 'z', type: 'scale', range: [0.75, 1.35] },
      noseWidth:        { regions: [7], axis: 'x', type: 'scale', range: [0.7, 1.4] },
      noseBridge:       { regions: [5], axis: 'x', type: 'scale', range: [0.8, 1.3] },
      noseProtrusion:   { regions: [6], axis: 'y', type: 'translate', range: [-0.03, 0.08] },
      noseTipShape:     { regions: [6], axis: 'z', type: 'translate', range: [-0.03, 0.03] },

      cheekboneWidth:   { regions: [8], axis: 'x', type: 'scale', range: [0.9, 1.15] },
      cheekboneHeight:  { regions: [8], axis: 'z', type: 'translate', range: [-0.04, 0.04] },
      cheekFullness:    { regions: [9], axis: 'y', type: 'translate', range: [-0.03, 0.06] },

      mouthWidth:       { regions: [10, 11, 12], axis: 'x', type: 'scale', range: [0.75, 1.3] },
      lipThicknessUpper:{ regions: [10], axis: 'y', type: 'translate', range: [-0.02, 0.04] },
      lipThicknessLower:{ regions: [11], axis: 'y', type: 'translate', range: [-0.02, 0.04] },
      mouthProtrusion:  { regions: [12, 10, 11], axis: 'y', type: 'translate', range: [-0.03, 0.05] },

      jawWidth:         { regions: [13, 14], axis: 'x', type: 'scale', range: [0.85, 1.2] },
      jawAngle:         { regions: [14], axis: 'y', type: 'translate', range: [-0.04, 0.06] },
      chinHeight:       { regions: [15], axis: 'z', type: 'translate', range: [-0.06, 0.06] },
      chinWidth:        { regions: [15], axis: 'x', type: 'scale', range: [0.8, 1.25] },
      chinProtrusion:   { regions: [15], axis: 'y', type: 'translate', range: [-0.05, 0.06] },
      chinShape:        { regions: [15], axis: 'z', type: 'scale', range: [0.85, 1.2] },

      earSize:          { regions: [16, 17], axis: 'xyz', type: 'scale', range: [0.7, 1.4] },
      earAngle:         { regions: [16, 17], axis: 'x', type: 'translate', range: [-0.04, 0.06] },

      neckWidth:        { regions: [18], axis: 'x', type: 'scale', range: [0.8, 1.3] },
      neckLength:       { regions: [18], axis: 'z', type: 'scale', range: [0.85, 1.2] },
    };
  }

  /**
   * Set a morph parameter value (0-100 range)
   */
  setMorphValue(param, value) {
    if (this.params.includes(param)) {
      this.morphValues[param] = value;
      this.applyAllMorphs();
    }
  }

  /**
   * Get all current morph values normalized to 0-1 for backend
   */
  getNormalizedValues() {
    const normalized = {};
    for (const [key, value] of Object.entries(this.morphValues)) {
      normalized[key] = value / 100;
    }
    return normalized;
  }

  /**
   * Get count of modified (non-default) parameters
   */
  getModifiedCount() {
    return Object.values(this.morphValues).filter(v => v !== this.defaultValue).length;
  }

  /**
   * Reset all morphs to default
   */
  resetAll() {
    this.params.forEach(p => this.morphValues[p] = this.defaultValue);
    this.baseFace.resetToOriginal();
  }

  /**
   * Reset a specific group of parameters
   */
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

  /**
   * Apply all morph values to the geometry
   */
  applyAllMorphs() {
    const geometry = this.baseFace.geometry;
    if (!geometry || !this.baseFace.originalPositions) return;

    const positions = geometry.attributes.position;
    const regions = geometry.attributes.region;
    const originalPos = this.baseFace.originalPositions;

    // Reset to original first
    positions.array.set(originalPos);

    // Apply each morph parameter
    for (const [param, value] of Object.entries(this.morphValues)) {
      if (value === this.defaultValue) continue; // Skip unchanged

      const morphDef = this.morphMap[param];
      if (!morphDef) continue;

      const t = (value - this.defaultValue) / 50; // -1 to 1
      const range = morphDef.range;
      const midVal = (range[0] + range[1]) / 2;
      const halfRange = (range[1] - range[0]) / 2;
      const factor = midVal + t * halfRange;

      for (let i = 0; i < positions.count; i++) {
        // Check if vertex belongs to the affected region
        if (morphDef.regions !== null) {
          const vertexRegion = regions.getX(i);
          if (!morphDef.regions.includes(vertexRegion)) continue;
        }

        let x = positions.getX(i);
        let y = positions.getY(i);
        let z = positions.getZ(i);

        const ox = originalPos[i * 3];
        const oy = originalPos[i * 3 + 1];
        const oz = originalPos[i * 3 + 2];

        if (morphDef.type === 'scale') {
          if (morphDef.axis.includes('x')) x = ox * factor;
          if (morphDef.axis.includes('y')) y = oy * factor;
          if (morphDef.axis.includes('z')) z = oz * factor;
        } else if (morphDef.type === 'translate') {
          const offset = t * halfRange;
          if (morphDef.axis === 'x') x = ox + offset;
          if (morphDef.axis === 'y') y = oy + offset;
          if (morphDef.axis === 'z') z = oz + offset;
        } else if (morphDef.type === 'tilt') {
          // Rotate slightly based on x position (left eye tilts opposite)
          const tiltAmount = t * halfRange;
          const vertexRegion = regions.getX(i);
          const sign = (vertexRegion === 3) ? -1 : 1; // Left vs right eye
          z = oz + sign * ox * tiltAmount;
        }

        positions.setXYZ(i, x, y, z);
      }
    }

    positions.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  /**
   * Load morph values from a saved state
   */
  loadState(state) {
    if (!state) return;
    for (const [key, value] of Object.entries(state)) {
      if (this.params.includes(key)) {
        this.morphValues[key] = Math.round(value * 100); // Convert from 0-1 to 0-100
      }
    }
    this.applyAllMorphs();
  }

  /**
   * Export current state
   */
  exportState() {
    return { ...this.morphValues };
  }
}

window.FaceMorpher = FaceMorpher;
