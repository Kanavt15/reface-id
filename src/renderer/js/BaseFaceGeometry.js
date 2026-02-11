/**
 * BaseFaceGeometry.js
 * Generates a parametric human head mesh procedurally using Three.js.
 * This serves as the default base face when no OBJ model is loaded.
 * The geometry is built with vertex groups mapped to facial regions
 * so morph parameters can deform specific areas.
 */

class BaseFaceGeometry {
  constructor() {
    this.vertexRegions = {};
    this.originalPositions = null;
  }

  /**
   * Create a detailed parametric head geometry.
   * Returns a THREE.BufferGeometry with region metadata.
   */
  create() {
    // Use a refined sphere as base, then sculpt it into a head shape
    const geometry = new THREE.SphereGeometry(1, 64, 48, 0, Math.PI * 2, 0, Math.PI);
    const positions = geometry.attributes.position;
    const count = positions.count;

    // Region assignments for each vertex (by index)
    const regions = new Float32Array(count);

    // Region IDs
    const REGION = {
      SKULL: 0,
      FOREHEAD: 1,
      BROW: 2,
      EYES_LEFT: 3,
      EYES_RIGHT: 4,
      NOSE_BRIDGE: 5,
      NOSE_TIP: 6,
      NOSE_BASE: 7,
      CHEEKBONES: 8,
      CHEEKS: 9,
      UPPER_LIP: 10,
      LOWER_LIP: 11,
      MOUTH: 12,
      JAW: 13,
      JAW_ANGLE: 14,
      CHIN: 15,
      EARS_LEFT: 16,
      EARS_RIGHT: 17,
      NECK: 18,
    };

    this.REGION = REGION;

    // Sculpt the sphere into a head shape
    for (let i = 0; i < count; i++) {
      let x = positions.getX(i);
      let y = positions.getY(i);
      let z = positions.getZ(i);

      // Normalize to get direction
      const len = Math.sqrt(x * x + y * y + z * z);
      const nx = x / len;
      const ny = y / len;
      const nz = z / len;

      // Phi (vertical angle from top), Theta (horizontal angle)
      const phi = Math.acos(nz);
      const theta = Math.atan2(ny, nx);

      let scale = 1.0;
      let region = REGION.SKULL;

      // --- Head shaping ---

      // Flatten the back of head slightly
      if (ny < -0.3) {
        scale *= 0.92 + 0.08 * (1 + ny);
      }

      // Elongate vertically (head is taller than wide)
      z *= 1.15;

      // Narrow the lower part (jaw taper)
      if (nz < 0) {
        const jawFactor = Math.abs(nz);
        x *= 1.0 - jawFactor * 0.25;
        y *= 1.0 - jawFactor * 0.1;
      }

      // --- Region assignment based on position ---

      // Forehead (upper front)
      if (nz > 0.4 && ny > -0.2) {
        region = REGION.FOREHEAD;
        // Flatten forehead slightly
        if (ny > 0.3) {
          y *= 0.95;
        }
      }

      // Brow ridge
      if (nz > 0.2 && nz < 0.45 && ny > 0.3 && Math.abs(nx) < 0.7) {
        region = REGION.BROW;
        y += 0.03; // Slight protrusion
      }

      // Eyes
      if (nz > 0.05 && nz < 0.35 && ny > 0.4) {
        if (nx > 0.1 && nx < 0.5) {
          region = REGION.EYES_RIGHT;
          // Eye socket indent
          y -= 0.05;
        } else if (nx < -0.1 && nx > -0.5) {
          region = REGION.EYES_LEFT;
          y -= 0.05;
        }
      }

      // Nose bridge
      if (Math.abs(nx) < 0.12 && nz > 0 && nz < 0.25 && ny > 0.5) {
        region = REGION.NOSE_BRIDGE;
        y += 0.06;
      }

      // Nose tip
      if (Math.abs(nx) < 0.15 && nz > -0.15 && nz < 0.05 && ny > 0.6) {
        region = REGION.NOSE_TIP;
        y += 0.1;
      }

      // Nose base / nostrils
      if (Math.abs(nx) < 0.25 && nz > -0.2 && nz < -0.05 && ny > 0.5) {
        region = REGION.NOSE_BASE;
      }

      // Cheekbones
      if (Math.abs(nx) > 0.4 && Math.abs(nx) < 0.7 && nz > -0.1 && nz < 0.2 && ny > 0.2) {
        region = REGION.CHEEKBONES;
        y += 0.02;
      }

      // Cheeks
      if (Math.abs(nx) > 0.3 && Math.abs(nx) < 0.6 && nz > -0.3 && nz < 0 && ny > 0.1) {
        region = REGION.CHEEKS;
      }

      // Upper lip
      if (Math.abs(nx) < 0.25 && nz > -0.35 && nz < -0.2 && ny > 0.5) {
        region = REGION.UPPER_LIP;
        y += 0.02;
      }

      // Lower lip
      if (Math.abs(nx) < 0.25 && nz > -0.42 && nz < -0.32 && ny > 0.45) {
        region = REGION.LOWER_LIP;
        y += 0.025;
      }

      // Mouth region
      if (Math.abs(nx) < 0.35 && nz > -0.42 && nz < -0.2 && ny > 0.4) {
        if (region !== REGION.UPPER_LIP && region !== REGION.LOWER_LIP) {
          region = REGION.MOUTH;
        }
      }

      // Jaw
      if (nz < -0.3 && Math.abs(nx) > 0.2 && ny > -0.2) {
        region = REGION.JAW;
      }

      // Jaw angle
      if (nz < -0.2 && nz > -0.5 && Math.abs(nx) > 0.5 && ny > -0.1) {
        region = REGION.JAW_ANGLE;
      }

      // Chin
      if (nz < -0.4 && Math.abs(nx) < 0.25 && ny > 0.1) {
        region = REGION.CHIN;
        y += 0.03;
      }

      // Left ear
      if (nx < -0.7 && nz > -0.2 && nz < 0.15 && Math.abs(ny) < 0.3) {
        region = REGION.EARS_LEFT;
        x -= 0.06;
      }

      // Right ear
      if (nx > 0.7 && nz > -0.2 && nz < 0.15 && Math.abs(ny) < 0.3) {
        region = REGION.EARS_RIGHT;
        x += 0.06;
      }

      // Neck
      if (nz < -0.6) {
        region = REGION.NECK;
        x *= 0.65;
        y *= 0.65;
      }

      positions.setXYZ(i, x, y, z);
      regions[i] = region;
    }

    geometry.setAttribute('region', new THREE.BufferAttribute(regions, 1));
    geometry.computeVertexNormals();

    // Store original positions for morphing
    this.originalPositions = new Float32Array(positions.array);
    this.geometry = geometry;

    return geometry;
  }

  /**
   * Get vertex indices for a specific region
   */
  getRegionIndices(regionId) {
    if (!this.geometry) return [];
    const regions = this.geometry.attributes.region;
    const indices = [];
    for (let i = 0; i < regions.count; i++) {
      if (regions.getX(i) === regionId) {
        indices.push(i);
      }
    }
    return indices;
  }

  /**
   * Reset all vertices to original positions
   */
  resetToOriginal() {
    if (!this.originalPositions || !this.geometry) return;
    const positions = this.geometry.attributes.position;
    positions.array.set(this.originalPositions);
    positions.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}

// Export for use in other modules
window.BaseFaceGeometry = BaseFaceGeometry;
