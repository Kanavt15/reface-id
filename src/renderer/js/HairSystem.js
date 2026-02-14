/**
 * HairSystem.js – GLB model-based hair for forensic facial reconstruction.
 *
 * Loads 4 real hair GLB models (Hair1-4.glb) and aligns them to the head.
 * Loads eyebrow GLB model and aligns to brow region.
 * Adjustment sliders (length, density, volume, curl) control transforms.
 * Facial hair remains procedural (region-based from trimesh data).
 * Auto-refreshes when head morphs change.
 */

class HairSystem {
  constructor(scene) {
    this.scene = scene;

    // Hair groups
    this.hairGroup = new THREE.Group();
    this.hairGroup.name = 'HairSystem';
    this.scene.add(this.hairGroup);

    this.facialHairGroup = new THREE.Group();
    this.facialHairGroup.name = 'FacialHair';
    this.scene.add(this.facialHairGroup);

    // Head references
    this._headGroup = null;
    this._regionData = null;

    // State
    this.currentStyle = 'hair1';
    this.hairColor = '#2c1b0e';
    this.params = { length: 50, density: 50, volume: 50, curl: 0,
                     posx: 50, posy: 50, posz: 50, roty: 50, scale: 50 };
    this.facialHairStyle = 'none';
    this.eyebrowParams = { thickness: 50, arch: 50, spacing: 50,
                           density: 70, posX: 50, posY: 50, posZ: 50,
                           rotation: 50, scale: 50,
                           straighten: 50, tiltX: 50 };
    this.eyebrowColor = '#2c1b0e';

    // Head metrics (updated on morph)
    this.modelCenter = new THREE.Vector3();
    this.modelHeight = 2.0;
    this.headTop = 1.4;
    this.headWidth = 1.9;

    // GLB model cache: { styleName: THREE.Group }
    this._modelCache = {};
    this._loadId = 0;

    // Current hair container
    this._hairContainer = null;
    this._alignmentScale = 1;

    // Eyebrow model
    this._eyebrowContainer = null;
    this._eyebrowGroup = new THREE.Group();
    this._eyebrowGroup.name = 'EyebrowSystem';
    this.scene.add(this._eyebrowGroup);

    this._eyebrowMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.eyebrowColor),
      roughness: 0.50,
      metalness: 0.08,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
    });

    // Facial hair vertex data
    this.scalpVerts = [];
    this.chinVerts = [];

    // Hair model configs
    this.hairModels = {
      hair1: { file: '../../assets/models/Hair1.glb', meshName: null },
      hair2: { file: '../../assets/models/Hair2.glb', meshName: null },
      hair3: { file: '../../assets/models/Hair3.glb', meshName: 'hair02_hair02_0' },
      hair4: { file: '../../assets/models/Hair4.glb', meshName: 'hair11_hair11_0' },
      bald:  { file: null },
    };

    // Eyebrow model config
    this.eyebrowModel = { file: '../../assets/models/eyebrows.glb', meshName: null };

    // Hair material
    this._hairMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.hairColor),
      roughness: 0.45,
      metalness: 0.12,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
    });
  }

  // ── Head binding ──

  setHeadMesh(headGroup, regionData) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._computeHeadMetrics();
    this._extractFacialHairVerts();
  }

  refreshFromMesh() {
    if (!this._headGroup) return;
    this._computeHeadMetrics();
    this._extractFacialHairVerts();
    if (this._hairContainer && this.currentStyle !== 'bald') {
      this._alignAndAdjust();
    }
    this.generateFacialHair();
    if (this._eyebrowContainer) {
      this._alignAndAdjustEyebrows();
    }
  }

  _computeHeadMetrics() {
    const box = new THREE.Box3().setFromObject(this._headGroup);
    box.getCenter(this.modelCenter);
    this.modelHeight = box.max.y - box.min.y;
    this.headTop = box.max.y;
    this.headWidth = box.max.x - box.min.x;
  }

  // ── Public API ──

  setStyle(style) {
    this.currentStyle = style;
    this.generate();
  }

  setColor(color) {
    this.hairColor = color;
    this._hairMat.color.set(color);
    this.hairGroup.traverse(child => {
      if (child.isMesh && child.material) child.material.color.set(color);
    });
    this.facialHairGroup.traverse(child => {
      if (child.isMesh && child.material) child.material.color.set(color);
      if (child.isLine && child.material) child.material.color.set(color);
    });
  }

  setParam(param, value) {
    this.params[param] = value;
    if (this._hairContainer) this._applyAdjustments();
  }

  setCustomParam(param, value) { /* no-op for model-based hair */ }

  // ── Main generation ──

  generate() {
    this._clearGroup(this.hairGroup);
    this._hairContainer = null;

    const config = this.hairModels[this.currentStyle];
    if (!config || !config.file) return;

    this._loadId++;
    const thisLoadId = this._loadId;

    if (this._modelCache[this.currentStyle]) {
      if (this._loadId !== thisLoadId) return;
      this._showCachedModel(this.currentStyle);
      return;
    }

    const loader = new THREE.GLBLoader();
    loader.load(
      config.file,
      (group) => {
        if (this._loadId !== thisLoadId) return;

        if (config.meshName) {
          const filtered = new THREE.Group();
          filtered.name = group.name;
          group.traverse(child => {
            if (child.isMesh && child.name === config.meshName) {
              filtered.add(child.clone());
            }
          });
          this._modelCache[this.currentStyle] = filtered;
        } else {
          this._modelCache[this.currentStyle] = group;
        }

        this._showCachedModel(this.currentStyle);
      },
      null,
      (err) => { console.error('Failed to load hair model:', config.file, err); }
    );
  }

  _showCachedModel(style) {
    this._clearGroup(this.hairGroup);
    const cached = this._modelCache[style];
    if (!cached) return;

    const container = new THREE.Group();
    container.name = 'HairContainer';

    const offsetGroup = new THREE.Group();
    offsetGroup.name = 'HairOffset';

    cached.traverse(child => {
      if (child.isMesh) {
        const clone = child.clone();
        clone.material = this._hairMat.clone();
        clone.material.color.set(this.hairColor);
        clone.castShadow = true;
        clone.receiveShadow = true;
        offsetGroup.add(clone);
      }
    });

    container.add(offsetGroup);
    this.hairGroup.add(container);
    this._hairContainer = container;

    this._alignAndAdjust();
  }

  _alignAndAdjust() {
    if (!this._hairContainer || !this._headGroup) return;

    const container = this._hairContainer;
    const offsetGroup = container.children[0];

    // Reset transforms for bbox computation
    container.scale.set(1, 1, 1);
    container.position.set(0, 0, 0);
    container.rotation.set(0, 0, 0);
    offsetGroup.position.set(0, 0, 0);

    // Compute hair bounding box
    const hairBox = new THREE.Box3().setFromObject(container);
    const hairCenter = new THREE.Vector3();
    hairBox.getCenter(hairCenter);
    const hairSize = new THREE.Vector3();
    hairBox.getSize(hairSize);

    if (hairSize.x < 0.001) return;

    // Center hair at origin
    offsetGroup.position.set(-hairCenter.x, -hairCenter.y, -hairCenter.z);

    // Alignment scale: match head width
    const baseScale = this.headWidth / Math.max(hairSize.x, hairSize.z);
    this._alignmentScale = baseScale;

    // Target: scalp center
    const scalpY = this.headTop - this.modelHeight * 0.12;
    const targetPos = new THREE.Vector3(this.modelCenter.x, scalpY, this.modelCenter.z);

    // Adjustment factors
    const lengthF = 0.7 + (this.params.length / 100) * 0.6;
    const volumeF = 0.7 + (this.params.volume / 100) * 0.6;
    const curlF   = this.params.curl / 100;
    const density  = this.params.density;

    // User position offsets (slider 50 = center, range ±0.8 world units)
    const posOffsetX = ((this.params.posx - 50) / 50) * 0.8;
    const posOffsetY = ((this.params.posy - 50) / 50) * 0.8;
    const posOffsetZ = ((this.params.posz - 50) / 50) * 0.8;

    // User rotation (slider 50 = 0, range ±90 degrees)
    const rotOffsetY = ((this.params.roty - 50) / 50) * (Math.PI / 2);

    // User scale (slider 50 = 1.0, range 0.3 – 2.0)
    const scaleF = 0.3 + (this.params.scale / 100) * 1.7;

    container.scale.set(baseScale * volumeF * scaleF, baseScale * lengthF * scaleF, baseScale * volumeF * scaleF);
    container.position.set(
      targetPos.x + posOffsetX,
      targetPos.y + posOffsetY,
      targetPos.z + posOffsetZ
    );

    // Rotation: curl + user rotation
    container.rotation.y = (curlF > 0 ? curlF * 0.15 : 0) + rotOffsetY;

    // Density → opacity
    const opacity = 0.5 + (density / 100) * 0.5;
    container.traverse(child => {
      if (child.isMesh && child.material) {
        child.material.opacity = opacity;
        child.material.transparent = opacity < 1.0;
      }
    });
  }

  _applyAdjustments() {
    this._alignAndAdjust();
  }

  // ── Eyebrows (GLB model) ──

  setEyebrowColor(color) {
    this.eyebrowColor = color;
    this._eyebrowMat.color.set(color);
    this._eyebrowGroup.traverse(child => {
      if (child.isMesh && child.material) child.material.color.set(color);
    });
  }

  setEyebrowParam(param, value) {
    this.eyebrowParams[param] = value;
    if (this._eyebrowContainer) this._alignAndAdjustEyebrows();
  }

  generateEyebrows() {
    this._clearGroup(this._eyebrowGroup);
    this._eyebrowContainer = null;

    const config = this.eyebrowModel;
    if (!config || !config.file) return;

    if (this._modelCache['eyebrows']) {
      this._showCachedEyebrows();
      return;
    }

    const loader = new THREE.GLBLoader();
    loader.load(
      config.file,
      (group) => {
        if (config.meshName) {
          const filtered = new THREE.Group();
          filtered.name = group.name;
          group.traverse(child => {
            if (child.isMesh && child.name === config.meshName) {
              filtered.add(child.clone());
            }
          });
          this._modelCache['eyebrows'] = filtered;
        } else {
          this._modelCache['eyebrows'] = group;
        }
        this._showCachedEyebrows();
      },
      null,
      (err) => { console.error('Failed to load eyebrow model:', config.file, err); }
    );
  }

  _showCachedEyebrows() {
    this._clearGroup(this._eyebrowGroup);
    const cached = this._modelCache['eyebrows'];
    if (!cached) return;

    const container = new THREE.Group();
    container.name = 'EyebrowContainer';

    const offsetGroup = new THREE.Group();
    offsetGroup.name = 'EyebrowOffset';

    cached.traverse(child => {
      if (child.isMesh) {
        const clone = child.clone();
        clone.material = this._eyebrowMat.clone();
        clone.material.color.set(this.eyebrowColor);
        clone.castShadow = true;
        clone.receiveShadow = true;
        offsetGroup.add(clone);
      }
    });

    container.add(offsetGroup);
    this._eyebrowGroup.add(container);
    this._eyebrowContainer = container;

    this._alignAndAdjustEyebrows();
  }

  _alignAndAdjustEyebrows() {
    if (!this._eyebrowContainer || !this._headGroup) return;

    const container = this._eyebrowContainer;
    const offsetGroup = container.children[0];
    const ep = this.eyebrowParams;

    // Reset transforms for bbox computation
    container.scale.set(1, 1, 1);
    container.position.set(0, 0, 0);
    container.rotation.set(0, 0, 0);
    offsetGroup.position.set(0, 0, 0);

    // Compute eyebrow model bounding box
    const browBox = new THREE.Box3().setFromObject(container);
    const browCenter = new THREE.Vector3();
    browBox.getCenter(browCenter);
    const browSize = new THREE.Vector3();
    browBox.getSize(browSize);

    if (browSize.x < 0.001) return;

    // Center eyebrow model at origin
    offsetGroup.position.set(-browCenter.x, -browCenter.y, -browCenter.z);

    // Target: brow region on the head (from OBJMorpher landmarks)
    // brow_left/right_center Y≈0.40, Z≈1.00; outer brows span ~0.90 in X
    const browRegionWidth = 0.90;
    const browRegionY = 0.39;
    const browRegionZ = 1.02;

    // Base scale: match brow region width
    const baseScale = browRegionWidth / browSize.x;

    // Slider-driven adjustments
    const thicknessF = 0.5 + (ep.thickness / 100) * 1.0;
    const archF = ((ep.arch - 50) / 50) * 0.08;
    const spacingOffset = ((ep.spacing - 50) / 50) * 0.15;
    const density = ep.density;
    const scaleF = 0.5 + (ep.scale / 100) * 1.0;
    const rotZ = ((ep.rotation - 50) / 50) * (Math.PI / 6);
    // Straighten: X-rotation flattens the natural arch curve (±45°)
    const straightenF = ((ep.straighten - 50) / 50) * (Math.PI / 4);
    // Tilt X: forward/backward tilt (±30°)
    const tiltXF = ((ep.tiltX - 50) / 50) * (Math.PI / 6);

    // Position offsets (range ±0.3)
    const posOffsetX = ((ep.posX - 50) / 50) * 0.3;
    const posOffsetY = ((ep.posY - 50) / 50) * 0.3;
    const posOffsetZ = ((ep.posZ - 50) / 50) * 0.3;

    container.scale.set(
      baseScale * scaleF,
      baseScale * thicknessF * scaleF,
      baseScale * scaleF
    );

    container.position.set(
      this.modelCenter.x + spacingOffset + posOffsetX,
      browRegionY + archF + posOffsetY,
      browRegionZ + posOffsetZ
    );

    container.rotation.set(straightenF + tiltXF, 0, rotZ);

    // Density → opacity
    const opacity = 0.4 + (density / 100) * 0.6;
    container.traverse(child => {
      if (child.isMesh && child.material) {
        child.material.opacity = opacity;
        child.material.transparent = opacity < 1.0;
      }
    });
  }

  clearEyebrows() {
    this._clearGroup(this._eyebrowGroup);
    this._eyebrowContainer = null;
  }

  // ── Facial Hair (procedural) ──

  _extractFacialHairVerts() {
    this.scalpVerts = [];
    this.chinVerts = [];
    if (!this._headGroup || !this._regionData) return;

    const group = this._headGroup;
    const regionMap = this._regionData.per_vertex_region;
    const chinRegions = [9, 11, 12, 13, 14, 15];

    let globalIdx = 0;
    group.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      const pos = child.geometry.attributes.position;
      const norm = child.geometry.attributes.normal;
      if (!pos || !norm) return;

      child.updateWorldMatrix(true, false);
      const mat4 = child.matrixWorld;
      const nMat = new THREE.Matrix3().getNormalMatrix(mat4);

      for (let i = 0; i < pos.count; i++) {
        const rid = regionMap[globalIdx];
        const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mat4);
        const n = new THREE.Vector3(norm.getX(i), norm.getY(i), norm.getZ(i)).applyMatrix3(nMat).normalize();

        if (rid === 0) this.scalpVerts.push({ position: v, normal: n });
        else if (chinRegions.includes(rid)) this.chinVerts.push({ position: v, normal: n });
        globalIdx++;
      }
    });
  }

  setFacialHair(style) { this.facialHairStyle = style; this.generateFacialHair(); }

  generateFacialHair() {
    this._clearGroup(this.facialHairGroup);
    if (this.facialHairStyle === 'none' || this.chinVerts.length === 0) return;

    const configs = {
      stubble:     { count: 2500, length: 0.008 },
      short_beard: { count: 3000, length: 0.025 },
      full_beard:  { count: 4000, length: 0.060 },
      goatee:      { count: 1200, length: 0.035 },
      mustache:    { count: 800,  length: 0.020 },
      sideburns:   { count: 1000, length: 0.025 },
    };
    const cfg = configs[this.facialHairStyle] || configs.stubble;
    const roots = this._filterChinRoots();

    for (let i = 0; i < cfg.count; i++) {
      if (!roots.length) break;
      const r = roots[Math.floor(this._rand(i + 80000) * roots.length)];
      const s = r.position.clone().addScaledVector(r.normal, 0.001);
      const d = r.normal.clone();
      d.y -= 0.35; d.normalize();

      const len = cfg.length * (0.4 + this._rand(i + 90000) * 0.6);
      const tip = s.clone().addScaledVector(d, len);
      const mid = s.clone().lerp(tip, 0.5);
      mid.x += (this._rand(i + 95000) - 0.5) * 0.003;

      const geo = new THREE.BufferGeometry().setFromPoints([s, mid, tip]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: new THREE.Color(this.hairColor),
        transparent: true, opacity: 0.75,
      }));
      this.facialHairGroup.add(line);
    }
  }

  _filterChinRoots() {
    const cx = this.modelCenter.x;
    switch (this.facialHairStyle) {
      case 'mustache':
        return this.chinVerts.filter(v => {
          const relY = (v.position.y - (this.modelCenter.y - this.modelHeight / 2)) / this.modelHeight;
          return relY > 0.42 && relY < 0.52 && Math.abs(v.position.x - cx) < 0.25;
        });
      case 'goatee':
        return this.chinVerts.filter(v => Math.abs(v.position.x - cx) < 0.2);
      case 'sideburns':
        return this.chinVerts.filter(v => Math.abs(v.position.x - cx) > 0.25);
      default: return this.chinVerts;
    }
  }

  // ── Utility ──

  _rand(seed) {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  updateColor() { this.setColor(this.hairColor); }

  _clearGroup(group) {
    while (group.children.length) {
      const c = group.children[0];
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
      group.remove(c);
    }
  }

  clearHair() { this._clearGroup(this.hairGroup); this._hairContainer = null; }

  getParams() {
    return {
      style: this.currentStyle, color: this.hairColor,
      length: this.params.length / 100, density: this.params.density / 100,
      volume: this.params.volume / 100, curl: this.params.curl / 100,
      posX: this.params.posx / 100, posY: this.params.posy / 100,
      posZ: this.params.posz / 100, rotY: this.params.roty / 100,
      hairScale: this.params.scale / 100,
      facialHair: { style: this.facialHairStyle },
      eyebrows: { ...this.eyebrowParams, color: this.eyebrowColor },
    };
  }

  /**
   * Return the final world-space transform so Blender can replicate it.
   * Computes the combined matrix of container * offsetGroup and decomposes
   * it into position, quaternion, scale so Blender can apply it directly.
   * Falls back to raw slider parameters if the container isn't ready.
   */
  getRenderTransform() {
    // Always include the raw params so Blender can recompute if needed
    const raw = {
      length: this.params.length,
      density: this.params.density,
      volume: this.params.volume,
      curl: this.params.curl,
      posx: this.params.posx,
      posy: this.params.posy,
      posz: this.params.posz,
      roty: this.params.roty,
      scale: this.params.scale,
      headWidth: this.headWidth,
      headTop: this.headTop,
      modelCenterX: this.modelCenter.x,
      modelCenterY: this.modelCenter.y,
      modelCenterZ: this.modelCenter.z,
      modelHeight: this.modelHeight,
      opacity: 0.5 + (this.params.density / 100) * 0.5,
    };

    if (!this._hairContainer || !this._headGroup || this.currentStyle === 'bald') {
      // Return raw params so Blender can compute alignment itself
      return { rawParams: raw, matrix: null };
    }

    const c = this._hairContainer;
    const o = c.children[0]; // offsetGroup

    // Compute the combined world matrix of container → offset
    c.updateWorldMatrix(true, false);
    o.updateWorldMatrix(true, false);
    const combinedMatrix = o.matrixWorld;

    return {
      // Raw matrix elements (column-major, as Three.js stores them)
      matrix: Array.from(combinedMatrix.elements),
      rawParams: raw,
      opacity: raw.opacity,
    };
  }

  loadState(state) {
    if (!state) return;
    if (state.style) this.currentStyle = state.style;
    if (state.color) { this.hairColor = state.color; this._hairMat.color.set(state.color); }
    if (state.length !== undefined) this.params.length = Math.round(state.length * 100);
    if (state.density !== undefined) this.params.density = Math.round(state.density * 100);
    if (state.volume !== undefined) this.params.volume = Math.round(state.volume * 100);
    if (state.curl !== undefined) this.params.curl = Math.round(state.curl * 100);
    if (state.posX !== undefined) this.params.posx = Math.round(state.posX * 100);
    if (state.posY !== undefined) this.params.posy = Math.round(state.posY * 100);
    if (state.posZ !== undefined) this.params.posz = Math.round(state.posZ * 100);
    if (state.rotY !== undefined) this.params.roty = Math.round(state.rotY * 100);
    if (state.hairScale !== undefined) this.params.scale = Math.round(state.hairScale * 100);
    if (state.facialHair) this.facialHairStyle = state.facialHair.style || 'none';
    if (state.eyebrows) {
      const eb = state.eyebrows;
      for (const key of ['thickness', 'arch', 'spacing', 'density', 'posX', 'posY', 'posZ', 'rotation', 'scale', 'straighten', 'tiltX']) {
        if (eb[key] !== undefined) this.eyebrowParams[key] = eb[key];
      }
      if (eb.color) {
        this.eyebrowColor = eb.color;
        this._eyebrowMat.color.set(eb.color);
      }
    }
    this.generate();
    this.generateFacialHair();
    this.generateEyebrows();
  }
}

window.HairSystem = HairSystem;