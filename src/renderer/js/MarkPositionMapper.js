/**
 * MarkPositionMapper.js
 * Converts face region + offset coordinates (from AI) to 3D world positions on the face mesh.
 * Supports regions like "cheek", "nose", "chin" with normalized offsets (-1 to 1).
 */

class MarkPositionMapper {
  constructor(objMorpher) {
    this.morpher = objMorpher;
  }

  /**
   * Map a facial mark from region + side + offset to world position.
   *
   * @param {string} region - Region name (cheek, nose, chin, temple, forehead, jaw, mouth, ear, eye, brow, bridge)
   * @param {string} side - Side: 'left', 'right', or 'center'
   * @param {number} offsetX - Normalized offset X (-1 to 1, where 0 = center of region)
   * @param {number} offsetY - Normalized offset Y (-1 to 1, where 0 = center of region)
   * @param {number} size - Mark size (0.01-0.1)
   * @returns {object} { position: [x, y, z], normal: [nx, ny, nz] } or null if invalid
   */
  mapMarkPosition(region, side, offsetX, offsetY, size) {
    if (!this.morpher || !this.morpher.meshes) return null;

    // Validate and normalize offsets
    offsetX = Math.max(-1, Math.min(1, offsetX || 0));
    offsetY = Math.max(-1, Math.min(1, offsetY || 0));

    // Get landmark positions for the region
    const landmarks = this._getRegionLandmarks(region, side);
    if (!landmarks || landmarks.length === 0) return null;

    // Calculate center of region from landmarks
    const center = this._calculateRegionCenter(landmarks);
    if (!center) return null;

    // Calculate region bounds
    const bounds = this._calculateRegionBounds(landmarks);

    // Apply offset to center
    const offsetPos = new THREE.Vector3(center.x, center.y, center.z);
    offsetPos.x += offsetX * bounds.width * 0.5;
    offsetPos.y += offsetY * bounds.height * 0.5;

    // Project position onto face mesh surface
    const surfacePoint = this._projectOntoSurface(offsetPos);
    if (!surfacePoint) return null;

    // Estimate surface normal
    const normal = this._estimateSurfaceNormal(surfacePoint.position);
    if (!normal) return null;

    return {
      position: surfacePoint.position.toArray(),
      normal: normal.toArray(),
    };
  }

  _getRegionLandmarks(region, side) {
    const landmarks = OBJMorpher.LANDMARKS;
    const region_lower = region.toLowerCase();

    // Map region names to landmark names
    const regionMap = {
      cheek: ['cheek_left', 'cheek_right', 'cheekbone_left', 'cheekbone_right', 'lower_cheek_left', 'lower_cheek_right'],
      nose: ['nose_tip', 'nose_bridge', 'nose_bridge_top', 'nostril_left', 'nostril_right', 'nose_base', 'alar_left', 'alar_right'],
      chin: ['chin', 'chin_left', 'chin_right'],
      jaw: ['jaw_left', 'jaw_right', 'jaw_angle_left', 'jaw_angle_right'],
      temple: ['temple_left', 'temple_right', 'forehead_left', 'forehead_right'],
      forehead: ['forehead_center', 'forehead_left', 'forehead_right', 'hairline_center'],
      mouth: ['mouth_left', 'mouth_right', 'upper_lip_center', 'upper_lip_left', 'upper_lip_right', 'lower_lip_center', 'lower_lip_left', 'lower_lip_right'],
      ear: ['ear_left_top', 'ear_left_center', 'ear_left_bottom', 'ear_right_top', 'ear_right_center', 'ear_right_bottom'],
      eye: ['eye_left_outer', 'eye_left_inner', 'eye_left_center', 'eye_right_inner', 'eye_right_outer', 'eye_right_center'],
      brow: ['brow_left_inner', 'brow_left_center', 'brow_left_outer', 'brow_right_inner', 'brow_right_center', 'brow_right_outer'],
      bridge: ['nose_bridge', 'nose_bridge_top'],
    };

    let landmarkNames = regionMap[region_lower] || [];

    // Filter by side if specified
    if (side && side !== 'center') {
      const side_lower = side.toLowerCase();
      landmarkNames = landmarkNames.filter(name => {
        if (side_lower === 'left') return name.includes('_left') || !name.includes('_right');
        if (side_lower === 'right') return name.includes('_right') || !name.includes('_left');
        return true;
      });
    }

    // Convert landmark names to positions
    return landmarkNames
      .map(name => landmarks[name])
      .filter(pos => pos !== undefined);
  }

  _calculateRegionCenter(landmarks) {
    if (!landmarks || landmarks.length === 0) return null;

    const center = new THREE.Vector3();
    for (const lm of landmarks) {
      center.x += lm[0];
      center.y += lm[1];
      center.z += lm[2];
    }
    center.divideScalar(landmarks.length);
    return center;
  }

  _calculateRegionBounds(landmarks) {
    if (!landmarks || landmarks.length === 0) return { width: 0.1, height: 0.1 };

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const lm of landmarks) {
      minX = Math.min(minX, lm[0]);
      maxX = Math.max(maxX, lm[0]);
      minY = Math.min(minY, lm[1]);
      maxY = Math.max(maxY, lm[1]);
    }

    return {
      width: Math.max(0.05, maxX - minX),
      height: Math.max(0.05, maxY - minY),
    };
  }

  _projectOntoSurface(worldPos) {
    if (!this.morpher || !this.morpher.meshes) return null;

    // Use raycasting to find closest point on mesh surface
    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.copy(worldPos);
    raycaster.ray.direction.set(0, 0, 1).normalize();

    for (let m = 0; m < this.morpher.meshes.length; m++) {
      const mesh = this.morpher.meshes[m];
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length > 0) {
        return {
          position: hits[0].point,
          faceIndex: hits[0].faceIndex,
          object: mesh,
        };
      }
    }

    // Fallback: just return the world position
    return { position: worldPos.clone() };
  }

  _estimateSurfaceNormal(position) {
    if (!this.morpher || !this.morpher.meshes) return null;

    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.copy(position);
    raycaster.ray.direction.set(0, 0, 1).normalize();

    for (let m = 0; m < this.morpher.meshes.length; m++) {
      const mesh = this.morpher.meshes[m];
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length > 0) {
        const normal = hits[0].face.normal.clone();
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
        return normal.applyMatrix3(normalMatrix).normalize();
      }
    }

    return null;
  }
}

window.MarkPositionMapper = MarkPositionMapper;
