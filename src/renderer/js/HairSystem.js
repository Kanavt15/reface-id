/**
 * HairSystem.js – GLB model-based hair for forensic facial reconstruction.
 *
 * Loads 12 real hair GLB models (Hair1-12.glb) and aligns them to the head.
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

    // Head references
    this._headGroup = null;
    this._regionData = null;

    // State
    this.currentStyle = 'hair1';
    this.hairColor = '#2c1b0e';
    this.params = { length: 50, density: 50, volume: 50, curl: 0,
                     posx: 50, posy: 50, posz: 50, roty: 50, scale: 50 };
    this.beardStyle = 'none';
    this.beardParams = { scale: 100, posX: 100, posY: 100, posZ: 100, rotY: 100, rotZ: 100 };
    this.beardColor = '#2c1b0e';
    this.eyebrowParams = { thickness: 100, arch: 0, spacing: 42,
                           density: 70, posX: 51, posY: 72, posZ: 49,
                           rotation: 100, scale: 65,
                           straighten: 51, tiltX: 69,
                           length: 50, opacity: 85 };
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
    
    // Cached bbox data for performance
    this._hairBboxCache = null;
    this._eyebrowBboxCache = null;
    this._beardBboxCache = null;

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

    // Beard model
    this._beardContainer = null;
    this._beardGroup = new THREE.Group();
    this._beardGroup.name = 'BeardSystem';
    this.scene.add(this._beardGroup);

    this._beardMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.beardColor),
      roughness: 0.50,
      metalness: 0.08,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
    });

    // Hair model configs
    this.hairModels = {
      hair1: { file: '../../assets/models/hair/Hair1.glb', meshName: null },
      hair2: { file: '../../assets/models/hair/Hair2.glb', meshName: null },
      hair3: { file: '../../assets/models/hair/Hair3.glb', meshName: 'hair02_hair02_0' },
      hair4: { file: '../../assets/models/hair/Hair4.glb', meshName: 'hair11_hair11_0' },
      hair5: { file: '../../assets/models/hair/Hair5.glb', meshName: null },
      hair6: { file: '../../assets/models/hair/Hair6.glb', meshName: null },
      hair7: { file: '../../assets/models/hair/Hair7.glb', meshName: null },
      hair8: { file: '../../assets/models/hair/Hair8.glb', meshName: null },
      hair9: { file: '../../assets/models/hair/Hair9.glb', meshName: null },
      hair10: { file: '../../assets/models/hair/Hair10.glb', meshName: null },
      hair11: { file: '../../assets/models/hair/Hair11.glb', meshName: null },
      hair12: { file: '../../assets/models/hair/Hair12.glb', meshName: null },
      bald:  { file: null },
    };

    // Eyebrow model config
    this.eyebrowModel = { file: '../../assets/models/facial/eyebrows.glb', meshName: null };

    // Beard model configs
    this.beardModels = {
      none: { file: null },
      beard1: { file: '../../assets/models/facial/Beard1.glb', meshName: null },
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
  }

  refreshFromMesh() {
    if (!this._headGroup) return;
    this._computeHeadMetrics();
    if (this._hairContainer && this.currentStyle !== 'bald') {
      this._alignAndAdjust();
    }
    if (this._beardContainer) {
      this._alignAndAdjustBeard();
    }
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
    // Material is shared, color update applies to all meshes automatically
  }

  setParam(param, value) {
    this.params[param] = value;
    if (this._hairContainer) this._applyAdjustments();
  }

  setCustomParam(param, value) { /* no-op for model-based hair */ }

  // ── Main generation ──

  generate() {
    console.log('[HairSystem] generate() called for style:', this.currentStyle);
    this._clearGroup(this.hairGroup);
    this._hairContainer = null;

    const config = this.hairModels[this.currentStyle];
    if (!config || !config.file) {
      console.log('[HairSystem] No config or file for style:', this.currentStyle);
      return;
    }

    this._loadId++;
    const thisLoadId = this._loadId;

    if (this._modelCache[this.currentStyle]) {
      console.log('[HairSystem] Using cached hair model:', this.currentStyle);
      if (this._loadId !== thisLoadId) return;
      this._showCachedModel(this.currentStyle);
      return;
    }

    console.log('[HairSystem] Loading hair model from:', config.file);
    const loader = new THREE.GLBLoader();
    loader.load(
      config.file,
      (group) => {
        if (this._loadId !== thisLoadId) return;

        console.log('[HairSystem] Hair model loaded successfully:', config.file);
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
      (err) => { console.error('[HairSystem] Failed to load hair model:', config.file, err); }
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
        clone.material = this._hairMat;
        clone.castShadow = true;
        clone.receiveShadow = true;
        offsetGroup.add(clone);
      }
    });

    container.add(offsetGroup);
    this.hairGroup.add(container);
    this._hairContainer = container;
    
    // Clear bbox cache for new model
    this._hairBboxCache = null;

    this._alignAndAdjust();
  }

  _alignAndAdjust() {
    if (!this._hairContainer || !this._headGroup) return;

    const container = this._hairContainer;
    const offsetGroup = container.children[0];

    // Compute bbox only once and cache it
    if (!this._hairBboxCache) {
      // Reset transforms for bbox computation
      container.scale.set(1, 1, 1);
      container.position.set(0, 0, 0);
      container.rotation.set(0, 0, 0);
      offsetGroup.position.set(0, 0, 0);

      const hairBox = new THREE.Box3().setFromObject(container);
      const hairCenter = new THREE.Vector3();
      hairBox.getCenter(hairCenter);
      const hairSize = new THREE.Vector3();
      hairBox.getSize(hairSize);

      if (hairSize.x < 0.001) return;

      this._hairBboxCache = { center: hairCenter, size: hairSize };
      
      // Center hair at origin (only needed once)
      offsetGroup.position.set(-hairCenter.x, -hairCenter.y, -hairCenter.z);
    }

    const hairSize = this._hairBboxCache.size;

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
    // Material is shared, color update applies to all meshes automatically
  }

  setEyebrowParam(param, value) {
    this.eyebrowParams[param] = value;
    if (this._eyebrowContainer) this._alignAndAdjustEyebrows();
  }

  generateEyebrows() {
    console.log('[HairSystem] generateEyebrows() called');
    this._clearGroup(this._eyebrowGroup);
    this._eyebrowContainer = null;

    const config = this.eyebrowModel;
    if (!config || !config.file) {
      console.log('[HairSystem] No eyebrow config or file');
      return;
    }

    if (this._modelCache['eyebrows']) {
      console.log('[HairSystem] Using cached eyebrow model');
      this._showCachedEyebrows();
      return;
    }

    console.log('[HairSystem] Loading eyebrow model from:', config.file);
    const loader = new THREE.GLBLoader();
    loader.load(
      config.file,
      (group) => {
        console.log('[HairSystem] Eyebrow model loaded successfully');
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
      (err) => { console.error('[HairSystem] Failed to load eyebrow model:', config.file, err); }
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
        clone.material = this._eyebrowMat;
        clone.castShadow = true;
        clone.receiveShadow = true;
        offsetGroup.add(clone);
      }
    });

    container.add(offsetGroup);
    this._eyebrowGroup.add(container);
    this._eyebrowContainer = container;
    
    // Clear bbox cache for new model
    this._eyebrowBboxCache = null;

    this._alignAndAdjustEyebrows();
  }

  _alignAndAdjustEyebrows() {
    if (!this._eyebrowContainer || !this._headGroup) return;

    const container = this._eyebrowContainer;
    const offsetGroup = container.children[0];
    const ep = this.eyebrowParams;

    // Compute bbox only once and cache it
    if (!this._eyebrowBboxCache) {
      // Reset transforms for bbox computation
      container.scale.set(1, 1, 1);
      container.position.set(0, 0, 0);
      container.rotation.set(0, 0, 0);
      offsetGroup.position.set(0, 0, 0);

      const browBox = new THREE.Box3().setFromObject(container);
      const browCenter = new THREE.Vector3();
      browBox.getCenter(browCenter);
      const browSize = new THREE.Vector3();
      browBox.getSize(browSize);

      if (browSize.x < 0.001) return;

      this._eyebrowBboxCache = { center: browCenter, size: browSize };
      
      // Center eyebrow model at origin (only needed once)
      offsetGroup.position.set(-browCenter.x, -browCenter.y, -browCenter.z);
    }

    const browSize = this._eyebrowBboxCache.size;

    // Target: brow region on the head (from OBJMorpher landmarks)
    // brow_left/right_center Y≈0.40, Z≈1.00; outer brows span ~0.90 in X
    const browRegionWidth = 0.90;
    const browRegionY = 0.39;
    const browRegionZ = 1.02;

    // Base scale: match brow region width
    const baseScale = browRegionWidth / browSize.x;

    // Slider-driven adjustments
    const thicknessF = 0.5 + (ep.thickness / 100) * 1.0;       // Y-scale only
    const lengthF    = 0.3 + (ep.length / 100) * 1.4;          // Z-scale (brow hair length)
    const archF = ((ep.arch - 50) / 50) * 0.08;                 // Y-position adjustment
    const spacingOffset = ((ep.spacing - 50) / 50) * 0.15;      // X-position (closer/further)
    const density = ep.density;
    const scaleF = 0.5 + (ep.scale / 100) * 1.0;               // Overall XZ scale
    const opacityF = (ep.opacity ?? 85) / 100;                  // Manual opacity override
    
    // Rotations (each on different axis for clear control)
    const rotZ = ((ep.rotation - 50) / 50) * Math.PI;          // Z-axis: angle/tilt up-down
    const rotY = ((ep.straighten - 50) / 50) * (Math.PI / 3);  // Y-axis: twist/straighten
    const rotX = ((ep.tiltX - 50) / 50) * Math.PI;             // X-axis: forward/backward tilt

    // Position offsets (range ±0.3)
    const posOffsetX = ((ep.posX - 50) / 50) * 0.3;
    const posOffsetY = ((ep.posY - 50) / 50) * 0.3;
    const posOffsetZ = ((ep.posZ - 50) / 50) * 0.3;

    // Apply scale: X by overall scale, Y by thickness, Z by length
    container.scale.set(
      baseScale * scaleF,
      baseScale * thicknessF,
      baseScale * scaleF * lengthF
    );

    container.position.set(
      this.modelCenter.x + spacingOffset + posOffsetX,
      browRegionY + archF + posOffsetY,
      browRegionZ + posOffsetZ
    );

    // Apply rotations: X (fwd/back tilt), Y (180° base + twist), Z (angle)
    container.rotation.set(rotX, Math.PI + rotY, rotZ);

    // Density affects opacity; manual opacity slider overrides base level
    const opacity = Math.min(1.0, opacityF * (0.4 + (density / 100) * 0.6));
    this._eyebrowMat.opacity = opacity;
    this._eyebrowMat.transparent = opacity < 1.0;
  }

  clearEyebrows() {
    this._clearGroup(this._eyebrowGroup);
    this._eyebrowContainer = null;
    this._eyebrowBboxCache = null;
  }

  // ── Beard (GLB model) ──

  setBeardColor(color) {
    this.beardColor = color;
    this._beardMat.color.set(color);
    // Material is shared, color update applies to all meshes automatically
  }

  setBeardParam(param, value) {
    this.beardParams[param] = value;
    if (this._beardContainer) this._alignAndAdjustBeard();
  }

  setBeard(style) {
    this.beardStyle = style;
    this.generateBeard();
  }

  generateBeard() {
    this._clearGroup(this._beardGroup);
    this._beardContainer = null;

    if (this.beardStyle === 'none') return;

    const config = this.beardModels[this.beardStyle];
    if (!config || !config.file) return;

    const cacheKey = `beard_${this.beardStyle}`;
    if (this._modelCache[cacheKey]) {
      this._showCachedBeard();
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
          this._modelCache[cacheKey] = filtered;
        } else {
          this._modelCache[cacheKey] = group;
        }
        this._showCachedBeard();
      },
      null,
      (err) => { console.error('Failed to load beard model:', config.file, err); }
    );
  }

  _showCachedBeard() {
    this._clearGroup(this._beardGroup);
    const cacheKey = `beard_${this.beardStyle}`;
    const cached = this._modelCache[cacheKey];
    if (!cached) return;

    const container = new THREE.Group();
    container.name = 'BeardContainer';

    const offsetGroup = new THREE.Group();
    offsetGroup.name = 'BeardOffset';

    cached.traverse(child => {
      if (child.isMesh) {
        const clone = child.clone();
        clone.material = this._beardMat;
        clone.castShadow = true;
        clone.receiveShadow = true;
        offsetGroup.add(clone);
      }
    });

    container.add(offsetGroup);
    this._beardGroup.add(container);
    this._beardContainer = container;
    
    // Clear bbox cache for new model
    this._beardBboxCache = null;

    this._alignAndAdjustBeard();
  }

  _alignAndAdjustBeard() {
    if (!this._beardContainer || !this._headGroup) return;

    const container = this._beardContainer;
    const offsetGroup = container.children[0];
    const bp = this.beardParams;

    // Compute bbox only once and cache it
    if (!this._beardBboxCache) {
      // Reset transforms for bbox computation
      container.scale.set(1, 1, 1);
      container.position.set(0, 0, 0);
      container.rotation.set(0, 0, 0);
      offsetGroup.position.set(0, 0, 0);

      const beardBox = new THREE.Box3().setFromObject(container);
      const beardCenter = new THREE.Vector3();
      beardBox.getCenter(beardCenter);
      const beardSize = new THREE.Vector3();
      beardBox.getSize(beardSize);

      if (beardSize.x < 0.001) return;

      this._beardBboxCache = { center: beardCenter, size: beardSize };
      
      // Center beard model at origin (only needed once)
      offsetGroup.position.set(-beardCenter.x, -beardCenter.y, -beardCenter.z);
    }

    const beardSize = this._beardBboxCache.size;

    // Target: chin/mouth region on the head
    const beardRegionY = 0.15;  // Lower face position
    const beardRegionZ = 0.95;  // Forward position on face

    // Base scale: match head width (same approach as hair system)
    const baseScale = this.headWidth / Math.max(beardSize.x, beardSize.z);

    // Slider-driven adjustments (0-200 range, centered at 100)
    const scaleF = 0.5 + (bp.scale / 200) * 1.0;
    
    // Rotations (0-200 range, centered at 100)
    const rotY = ((bp.rotY - 100) / 100) * (Math.PI / 6);  // Y-axis: twist
    const rotZ = ((bp.rotZ - 100) / 100) * (Math.PI / 6);  // Z-axis: tilt

    // Position offsets (0-200 centered at 100)
    const posOffsetX = ((bp.posX - 100) / 100) * 0.3;
    const posOffsetY = ((bp.posY - 100) / 100) * 0.8;    // Up/Down: increased range ±0.8
    const posOffsetZ = ((bp.posZ - 100) / 100) * 0.8;    // Fwd/Back: increased range ±0.8

    container.scale.set(
      baseScale * scaleF,
      baseScale * scaleF,
      baseScale * scaleF
    );

    container.position.set(
      this.modelCenter.x + posOffsetX,
      beardRegionY + posOffsetY,
      beardRegionZ + posOffsetZ
    );

    container.rotation.set(0, rotY, rotZ);
  }

  clearBeard() {
    this._clearGroup(this._beardGroup);
    this._beardContainer = null;
    this._beardBboxCache = null;
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

  clearHair() { this._clearGroup(this.hairGroup); this._hairContainer = null; this._hairBboxCache = null; }

  getParams() {
    return {
      style: this.currentStyle, color: this.hairColor,
      length: this.params.length / 100, density: this.params.density / 100,
      volume: this.params.volume / 100, curl: this.params.curl / 100,
      posX: this.params.posx / 100, posY: this.params.posy / 100,
      posZ: this.params.posz / 100, rotY: this.params.roty / 100,
      hairScale: this.params.scale / 100,
      beard: { style: this.beardStyle, ...this.beardParams, color: this.beardColor },
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
    
    // Handle beard (new system) or legacy facialHair
    if (state.beard) {
      this.beardStyle = state.beard.style || 'none';
      for (const key of ['scale', 'posX', 'posY', 'posZ', 'rotY', 'rotZ']) {
        if (state.beard[key] !== undefined) this.beardParams[key] = state.beard[key];
      }
      if (state.beard.color) {
        this.beardColor = state.beard.color;
        this._beardMat.color.set(state.beard.color);
      }
    } else if (state.facialHair) {
      // Legacy support - just ignore old facial hair data
      console.log('Legacy facial hair data ignored - please use beard system');
    }
    
    if (state.eyebrows) {
      const eb = state.eyebrows;
      for (const key of ['thickness', 'arch', 'spacing', 'density', 'posX', 'posY', 'posZ', 'rotation', 'scale', 'straighten', 'tiltX', 'length', 'opacity']) {
        if (eb[key] !== undefined) this.eyebrowParams[key] = eb[key];
      }
      if (eb.color) {
        this.eyebrowColor = eb.color;
        this._eyebrowMat.color.set(eb.color);
      }
    }
    this.generate();
    this.generateBeard();
    this.generateEyebrows();
  }
}

window.HairSystem = HairSystem;