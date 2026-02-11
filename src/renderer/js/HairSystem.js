/**
 * HairSystem.js – GLB model-based hair for forensic facial reconstruction.
 *
 * Loads 4 real hair GLB models (Hair1-4.glb) and aligns them to the head.
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
    this.params = { length: 50, density: 50, volume: 50, curl: 0 };
    this.facialHairStyle = 'none';
    this.eyebrowParams = { thickness: 50, arch: 50, spacing: 50 };

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

    container.scale.set(baseScale * volumeF, baseScale * lengthF, baseScale * volumeF);
    container.position.copy(targetPos);

    if (curlF > 0) container.rotation.y = curlF * 0.15;
    else container.rotation.y = 0;

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
      facialHair: { style: this.facialHairStyle },
      eyebrows: { ...this.eyebrowParams },
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
    if (state.facialHair) this.facialHairStyle = state.facialHair.style || 'none';
    this.generate();
    this.generateFacialHair();
  }
}

window.HairSystem = HairSystem;