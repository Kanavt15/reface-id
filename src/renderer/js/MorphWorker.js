/**
 * MorphWorker.js
 * Web Worker that computes vertex morph offsets off the main thread.
 * Receives morph config + values, returns computed position arrays.
 *
 * Messages IN:
 *   { type: 'init', data: { allVerts, faceMask, landmarkPositions, meshVertCounts, totalVertices, config, params } }
 *   { type: 'morph', data: { morphValues, defaultValue } }
 *
 * Messages OUT:
 *   { type: 'ready' }
 *   { type: 'result', positions: Float32Array[] }  (Transferable)
 */

// ─── State ──────────────────────────────────────────────────────────────
let _allVerts = null;      // Float64Array — original vertex positions
let _faceMask = null;      // Float64Array — per-vertex face boundary mask
let _landmarkPositions = {};
let _meshVertCounts = [];  // number of vertices per sub-mesh
let _totalVertices = 0;
let _config = {};
let _params = [];
let _offsetsBuffer = null; // Float64Array — reusable offsets accumulator
let _weightCache = new Map();
let _originalPositions = []; // Float32Array[] — per-mesh original positions
let _vertexOffsets = [];     // int[] — starting global index of each mesh

// ─── Message handler ────────────────────────────────────────────────────
self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === 'init') {
    const d = msg.data;
    _allVerts = new Float64Array(d.allVerts);
    _faceMask = new Float64Array(d.faceMask);
    _landmarkPositions = d.landmarkPositions;
    _meshVertCounts = d.meshVertCounts;
    _totalVertices = d.totalVertices;
    _config = d.config;
    _params = d.params;
    _offsetsBuffer = new Float64Array(_totalVertices * 3);

    // Reconstruct per-mesh original position arrays and offsets
    _originalPositions = [];
    _vertexOffsets = [];
    let offset = 0;
    for (let m = 0; m < _meshVertCounts.length; m++) {
      const count = _meshVertCounts[m];
      const posArray = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const gi = offset + i;
        posArray[i * 3]     = _allVerts[gi * 3];
        posArray[i * 3 + 1] = _allVerts[gi * 3 + 1];
        posArray[i * 3 + 2] = _allVerts[gi * 3 + 2];
      }
      _originalPositions.push(posArray);
      _vertexOffsets.push(offset);
      offset += count;
    }

    _weightCache.clear();
    self.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'morph') {
    const { morphValues, defaultValue } = msg.data;
    const results = computeMorphPositions(morphValues, defaultValue);
    // Transfer the buffers (zero-copy) back to main thread
    self.postMessage({ type: 'result', positions: results }, results.map(r => r.buffer));
    return;
  }
};

// ─── Weight functions (mirror of OBJMorpher) ────────────────────────────

function _getRegionWeights(landmarkNames, radius) {
  const cacheKey = landmarkNames.slice().sort().join(',') + ':' + radius;
  const cached = _weightCache.get(cacheKey);
  if (cached) return cached;

  radius *= _config.radius_scale;
  const N = _totalVertices;
  const weights = new Float64Array(N);
  const verts = _allVerts;
  const twoR2 = 2 * radius * radius;

  for (const name of landmarkNames) {
    const lp = _landmarkPositions[name];
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
  for (let i = 0; i < N; i++) weights[i] *= _faceMask[i];
  _weightCache.set(cacheKey, weights);
  return weights;
}

function _getDirectionalWeights(landmarkNames, radius) {
  const cacheKey = 'D:' + landmarkNames.slice().sort().join(',') + ':' + radius;
  const cached = _weightCache.get(cacheKey);
  if (cached) return cached;

  const weights = _getRegionWeights(landmarkNames, radius);
  const N = _totalVertices;
  const directions = new Float64Array(N);
  const tw = _config.transition_width;
  for (let i = 0; i < N; i++) directions[i] = Math.tanh(_allVerts[i * 3] / tw);

  const result = { weights, directions };
  _weightCache.set(cacheKey, result);
  return result;
}

// ─── Main morph computation (mirror of OBJMorpher.applyAllMorphs) ───────

function computeMorphPositions(morphValues, defaultValue) {
  const N = _totalVertices;
  const cfg = _config;
  const scale = cfg.scale_factor;
  const zDir = cfg.z_front_direction;
  const offsets = _offsetsBuffer;
  offsets.fill(0);

  // Collect active morphs
  const active = {};
  for (const p of _params) {
    const v = morphValues[p];
    if (v !== undefined && v !== defaultValue) {
      active[p] = (v - defaultValue) / 50;
    }
  }

  if (Object.keys(active).length > 0) {
    // ── JAW & CHIN
    if (active.jawWidth !== undefined) {
      const t = active.jawWidth;
      const { weights, directions } = _getDirectionalWeights(
        ['jaw_left', 'jaw_right', 'jaw_angle_left', 'jaw_angle_right'], 0.12);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.chinHeight !== undefined) {
      const t = active.chinHeight;
      const weights = _getRegionWeights(['chin', 'chin_left', 'chin_right'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] -= weights[i] * disp;
    }
    if (active.chinWidth !== undefined) {
      const t = active.chinWidth;
      const { weights, directions } = _getDirectionalWeights(
        ['chin', 'chin_left', 'chin_right'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.chinProtrusion !== undefined) {
      const t = active.chinProtrusion;
      const weights = _getRegionWeights(['chin', 'chin_left', 'chin_right'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }
    if (active.jawDefinition !== undefined) {
      const t = active.jawDefinition;
      const { weights, directions } = _getDirectionalWeights(
        ['jaw_angle_left', 'jaw_angle_right'], 0.10);
      const disp = t * scale;
      for (let i = 0; i < N; i++) {
        offsets[i*3]   += directions[i] * weights[i] * disp * 0.7;
        offsets[i*3+1] -= weights[i] * disp * 0.3;
      }
    }

    // ── NOSE
    if (active.noseLength !== undefined) {
      const t = active.noseLength;
      const weights = _getRegionWeights(['nose_tip', 'nose_base'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }
    if (active.noseWidth !== undefined) {
      const t = active.noseWidth;
      const { weights, directions } = _getDirectionalWeights(
        ['nostril_left', 'nostril_right', 'alar_left', 'alar_right'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.noseBridgeWidth !== undefined) {
      const t = active.noseBridgeWidth;
      const { weights, directions } = _getDirectionalWeights(
        ['nose_bridge', 'nose_bridge_top'], 0.05);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.noseBridgeHeight !== undefined) {
      const t = active.noseBridgeHeight;
      const weights = _getRegionWeights(['nose_bridge', 'nose_bridge_top'], 0.05);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }
    if (active.noseTipHeight !== undefined) {
      const t = active.noseTipHeight;
      const weights = _getRegionWeights(['nose_tip'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }
    if (active.noseTipWidth !== undefined) {
      const t = active.noseTipWidth;
      const { weights, directions } = _getDirectionalWeights(['nose_tip'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.nostrilFlare !== undefined) {
      const t = active.nostrilFlare;
      const { weights, directions } = _getDirectionalWeights(
        ['nostril_left', 'nostril_right', 'alar_left', 'alar_right'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }

    // ── EYES
    if (active.eyeSpacing !== undefined) {
      const t = active.eyeSpacing;
      const { weights, directions } = _getDirectionalWeights(
        ['eye_left_center', 'eye_right_center',
         'eye_left_inner', 'eye_right_inner',
         'eye_left_outer', 'eye_right_outer'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.eyeHeight !== undefined) {
      const t = active.eyeHeight;
      const weights = _getRegionWeights(['eye_left_center', 'eye_right_center'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }
    if (active.eyeDepth !== undefined) {
      const t = active.eyeDepth;
      const weights = _getRegionWeights(['eye_left_center', 'eye_right_center'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] -= zDir * weights[i] * disp;
    }
    if (active.eyeSize !== undefined) {
      const t = active.eyeSize;
      const disp = t * 0.15;
      for (const side of ['left', 'right']) {
        const cp = _landmarkPositions['eye_' + side + '_center'];
        if (!cp) continue;
        const landmarks = [
          'eye_' + side + '_center', 'eye_' + side + '_inner',
          'eye_' + side + '_outer', 'eye_' + side + '_upper', 'eye_' + side + '_lower'];
        const weights = _getRegionWeights(landmarks, 0.05);
        for (let i = 0; i < N; i++) {
          if (weights[i] < 0.001) continue;
          offsets[i*3]   += (_allVerts[i*3]   - cp[0]) * weights[i] * disp;
          offsets[i*3+1] += (_allVerts[i*3+1] - cp[1]) * weights[i] * disp;
          offsets[i*3+2] += (_allVerts[i*3+2] - cp[2]) * weights[i] * disp;
        }
      }
    }
    if (active.eyeTilt !== undefined) {
      const t = active.eyeTilt;
      const disp = t * scale * 0.5;
      const wO = _getRegionWeights(['eye_left_outer', 'eye_right_outer'], 0.04);
      const wI = _getRegionWeights(['eye_left_inner', 'eye_right_inner'], 0.04);
      for (let i = 0; i < N; i++) {
        offsets[i*3+1] += wO[i] * disp;
        offsets[i*3+1] -= wI[i] * disp * 0.5;
      }
    }
    if (active.eyeOpenness !== undefined) {
      const t = active.eyeOpenness;
      const disp = t * scale * 0.3;
      const wU = _getRegionWeights(['eye_left_upper', 'eye_right_upper'], 0.03);
      const wL = _getRegionWeights(['eye_left_lower', 'eye_right_lower'], 0.03);
      for (let i = 0; i < N; i++) {
        offsets[i*3+1] += wU[i] * disp;
        offsets[i*3+1] -= wL[i] * disp;
      }
    }

    // ── BROWS
    if (active.browHeight !== undefined) {
      const t = active.browHeight;
      const weights = _getRegionWeights(
        ['brow_left_center', 'brow_right_center',
         'brow_left_inner', 'brow_right_inner',
         'brow_left_outer', 'brow_right_outer'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }
    if (active.browSpacing !== undefined) {
      const t = active.browSpacing;
      const { weights, directions } = _getDirectionalWeights(
        ['brow_left_center', 'brow_right_center',
         'brow_left_inner', 'brow_right_inner'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.browProminence !== undefined) {
      const t = active.browProminence;
      const weights = _getRegionWeights(
        ['brow_left_center', 'brow_right_center', 'glabella'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }
    if (active.browArch !== undefined) {
      const t = active.browArch;
      const weights = _getRegionWeights(
        ['brow_left_center', 'brow_right_center'], 0.04);
      const disp = t * scale * 0.5;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }
    if (active.browThickness !== undefined) {
      const t = active.browThickness;
      const weights = _getRegionWeights(
        ['brow_left_center', 'brow_right_center'], 0.06);
      const disp = t * scale * 0.5;
      for (let i = 0; i < N; i++) {
        offsets[i*3+2] += zDir * weights[i] * disp;
        offsets[i*3+1] += weights[i] * disp * 0.3;
      }
    }

    // ── FOREHEAD
    if (active.foreheadHeight !== undefined) {
      const t = active.foreheadHeight;
      const weights = _getRegionWeights(
        ['forehead_center', 'forehead_left', 'forehead_right', 'hairline_center'], 0.12);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }
    if (active.foreheadSlope !== undefined) {
      const t = active.foreheadSlope;
      const weights = _getRegionWeights(
        ['forehead_center', 'forehead_left', 'forehead_right'], 0.10);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }
    if (active.foreheadWidth !== undefined) {
      const t = active.foreheadWidth;
      const { weights, directions } = _getDirectionalWeights(
        ['forehead_left', 'forehead_right'], 0.10);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.templeWidth !== undefined) {
      const t = active.templeWidth;
      const { weights, directions } = _getDirectionalWeights(
        ['temple_left', 'temple_right'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.foreheadBulge !== undefined) {
      const t = active.foreheadBulge;
      const weights = _getRegionWeights(['forehead_center'], 0.10);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }

    // ── CHEEKS
    if (active.cheekFullness !== undefined) {
      const t = active.cheekFullness;
      const weights = _getRegionWeights(
        ['cheek_left', 'cheek_right', 'lower_cheek_left', 'lower_cheek_right'], 0.10);
      const disp = t * scale;
      const tw = cfg.transition_width;
      for (let i = 0; i < N; i++) {
        const dir = Math.tanh(_allVerts[i*3] / tw);
        offsets[i*3]   += dir * weights[i] * disp * 0.7;
        offsets[i*3+2] += zDir * weights[i] * disp * 0.5;
      }
    }
    if (active.cheekboneProminence !== undefined) {
      const t = active.cheekboneProminence;
      const weights = _getRegionWeights(['cheekbone_left', 'cheekbone_right'], 0.08);
      const disp = t * scale;
      const tw = cfg.transition_width;
      for (let i = 0; i < N; i++) {
        const dir = Math.tanh(_allVerts[i*3] / tw);
        offsets[i*3]   += dir * weights[i] * disp * 0.6;
        offsets[i*3+2] += zDir * weights[i] * disp * 0.4;
      }
    }
    if (active.cheekHeight !== undefined) {
      const t = active.cheekHeight;
      const weights = _getRegionWeights(
        ['cheek_left', 'cheek_right', 'cheekbone_left', 'cheekbone_right'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }
    if (active.nasolabialDepth !== undefined) {
      const t = active.nasolabialDepth;
      const weights = _getRegionWeights(['lower_cheek_left', 'lower_cheek_right'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] -= zDir * weights[i] * disp;
    }

    // ── MOUTH & LIPS
    if (active.mouthWidth !== undefined) {
      const t = active.mouthWidth;
      const { weights, directions } = _getDirectionalWeights(
        ['mouth_left', 'mouth_right'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.mouthHeight !== undefined) {
      const t = active.mouthHeight;
      const weights = _getRegionWeights(
        ['mouth_left', 'mouth_right', 'upper_lip_center', 'lower_lip_center'], 0.08);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }
    if (active.lipProtrusion !== undefined) {
      const t = active.lipProtrusion;
      const weights = _getRegionWeights(
        ['upper_lip_center', 'lower_lip_center',
         'upper_lip_left', 'upper_lip_right',
         'lower_lip_left', 'lower_lip_right'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] += zDir * weights[i] * disp;
    }
    if (active.upperLipThickness !== undefined) {
      const t = active.upperLipThickness;
      const weights = _getRegionWeights(
        ['upper_lip_center', 'upper_lip_left', 'upper_lip_right'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) {
        offsets[i*3+2] += zDir * weights[i] * disp * 0.5;
        offsets[i*3+1] += weights[i] * disp * 0.3;
      }
    }
    if (active.lowerLipThickness !== undefined) {
      const t = active.lowerLipThickness;
      const weights = _getRegionWeights(
        ['lower_lip_center', 'lower_lip_left', 'lower_lip_right'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) {
        offsets[i*3+2] += zDir * weights[i] * disp * 0.5;
        offsets[i*3+1] -= weights[i] * disp * 0.3;
      }
    }
    if (active.cupidBow !== undefined) {
      const t = active.cupidBow;
      const weights = _getRegionWeights(['cupid_bow_left', 'cupid_bow_right'], 0.03);
      const disp = t * scale * 0.5;
      for (let i = 0; i < N; i++) {
        offsets[i*3+1] += weights[i] * disp;
        offsets[i*3+2] += zDir * weights[i] * disp * 0.3;
      }
    }
    if (active.philtrumDepth !== undefined) {
      const t = active.philtrumDepth;
      const weights = _getRegionWeights(['philtrum_top', 'philtrum_bottom'], 0.03);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] -= zDir * weights[i] * disp;
    }
    if (active.philtrumWidth !== undefined) {
      const t = active.philtrumWidth;
      const { weights, directions } = _getDirectionalWeights(
        ['philtrum_top', 'philtrum_bottom'], 0.03);
      const disp = t * scale * 0.5;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.lipCornerAngle !== undefined) {
      const t = active.lipCornerAngle;
      const weights = _getRegionWeights(['mouth_left', 'mouth_right'], 0.04);
      const disp = t * scale * 0.5;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }

    // ── EARS
    if (active.earSize !== undefined) {
      const t = active.earSize;
      const disp = t * 0.15;
      for (const side of ['left', 'right']) {
        const cp = _landmarkPositions['ear_' + side + '_center'];
        if (!cp) continue;
        const landmarks = [
          'ear_' + side + '_top', 'ear_' + side + '_center',
          'ear_' + side + '_bottom', 'tragus_' + side];
        const weights = _getRegionWeights(landmarks, 0.06);
        for (let i = 0; i < N; i++) {
          if (weights[i] < 0.001) continue;
          offsets[i*3]   += (_allVerts[i*3]   - cp[0]) * weights[i] * disp;
          offsets[i*3+1] += (_allVerts[i*3+1] - cp[1]) * weights[i] * disp;
          offsets[i*3+2] += (_allVerts[i*3+2] - cp[2]) * weights[i] * disp;
        }
      }
    }
    if (active.earProtrusion !== undefined) {
      const t = active.earProtrusion;
      const { weights, directions } = _getDirectionalWeights(
        ['ear_left_center', 'ear_right_center', 'ear_left_top', 'ear_right_top'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.earHeight !== undefined) {
      const t = active.earHeight;
      const weights = _getRegionWeights(
        ['ear_left_center', 'ear_right_center',
         'ear_left_top', 'ear_right_top',
         'ear_left_bottom', 'ear_right_bottom'], 0.06);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] += weights[i] * disp;
    }
    if (active.earlobeSize !== undefined) {
      const t = active.earlobeSize;
      const weights = _getRegionWeights(['ear_left_bottom', 'ear_right_bottom'], 0.04);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+1] -= weights[i] * disp;
    }

    // ── OVERALL HEAD / FACE
    if (active.faceWidth !== undefined) {
      const t = active.faceWidth;
      const disp = t * 0.1;
      for (let i = 0; i < N; i++) {
        offsets[i*3] += _allVerts[i*3] * _faceMask[i] * disp;
      }
    }
    if (active.faceLength !== undefined) {
      const t = active.faceLength;
      const disp = t * 0.1;
      let sumY = 0;
      for (let i = 0; i < N; i++) sumY += _allVerts[i*3+1];
      const meanY = sumY / N;
      for (let i = 0; i < N; i++) {
        offsets[i*3+1] += (_allVerts[i*3+1] - meanY) * _faceMask[i] * disp;
      }
    }
    if (active.headWidth !== undefined) {
      const t = active.headWidth;
      const { weights, directions } = _getDirectionalWeights(
        ['skull_left', 'skull_right', 'temple_left', 'temple_right'], 0.15);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3] += directions[i] * weights[i] * disp;
    }
    if (active.headLength !== undefined) {
      const t = active.headLength;
      const weights = _getRegionWeights(['occiput', 'crown'], 0.15);
      const disp = t * scale;
      for (let i = 0; i < N; i++) offsets[i*3+2] -= zDir * weights[i] * disp;
    }
    if (active.faceTaper !== undefined) {
      const t = active.faceTaper;
      const yRange = cfg.face_y_max - cfg.face_y_min;
      const tw = cfg.transition_width;
      const disp = t * scale;
      for (let i = 0; i < N; i++) {
        const yNorm = 1 - (_allVerts[i*3+1] - cfg.face_y_min) / yRange;
        const yf = Math.max(0, Math.min(1, yNorm));
        const yf2 = yf * yf;
        const dir = Math.tanh(_allVerts[i*3] / tw);
        offsets[i*3] -= dir * yf2 * _faceMask[i] * disp;
      }
    }
  }

  // ── Build result position arrays (original + offsets) ──
  const results = [];
  for (let m = 0; m < _meshVertCounts.length; m++) {
    const count = _meshVertCounts[m];
    const out = new Float32Array(count * 3);
    const orig = _originalPositions[m];
    const baseOffset = _vertexOffsets[m];

    for (let i = 0; i < count; i++) {
      const gi = baseOffset + i;
      out[i * 3]     = orig[i * 3]     + offsets[gi * 3];
      out[i * 3 + 1] = orig[i * 3 + 1] + offsets[gi * 3 + 1];
      out[i * 3 + 2] = orig[i * 3 + 2] + offsets[gi * 3 + 2];
    }
    results.push(out);
  }

  return results;
}
