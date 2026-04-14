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
    this.hairTintColor = '#8b2500';  // default tint color (auburn)
    this.hairTintIntensity = 0;      // 0 = no tint, 1 = full tint
    this.params = { length: 50, density: 50, volume: 50, curl: 0,
                     posx: 50, posy: 50, posz: 50, roty: 50, scale: 50 };
    this.beardStyle = 'none';
    this.beardParams = { scale: 100, posX: 100, posY: 100, posZ: 100, rotY: 100, rotZ: 100 };
    this.beardColor = '#2c1b0e';
    this.beardTintColor = '#8b2500';  // default tint color
    this.beardTintIntensity = 0;      // 0 = no tint, 1 = full tint
    this.eyebrowParams = { thickness: 100, arch: 0, spacing: 42,
                           density: 70, posX: 51, posY: 72, posZ: 49,
                           rotation: 100, scale: 65,
                           straighten: 51, tiltX: 69,
                           length: 50, opacity: 85 };
    this.eyebrowColor = '#2c1b0e';
    this.eyebrowTintColor = '#8b2500'; // default tint color
    this.eyebrowTintIntensity = 0;     // 0 = no tint, 1 = full tint

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

    // Hair model configs with per-model default positions/scales
    // defaults: { posx, posy, posz, roty, scale } - calibrated values
    this.hairModels = {
      hair1: { file: '../../assets/models/hair/Hair1.glb', meshName: null,
               defaults: { posx: 49, posy: 38, posz: 41, roty: 50, scale: 48 } },
      hair2: { file: '../../assets/models/hair/Hair2.glb', meshName: null,
               defaults: { posx: 50, posy: 21, posz: 38, roty: 50, scale: 47 } },
      hair3: { file: '../../assets/models/hair/Hair3.glb', meshName: 'hair02_hair02_0',
               defaults: { posx: 50, posy: 13, posz: 36, roty: 50, scale: 61 } },
      hair4: { file: '../../assets/models/hair/Hair4.glb', meshName: 'hair11_hair11_0',
               defaults: { posx: 50, posy: 25, posz: 38, roty: 50, scale: 54 } },
      hair5: { file: '../../assets/models/hair/Hair5.glb', meshName: null,
               defaults: { posx: 50, posy: 37, posz: 41, roty: 50, scale: 55 } },
      hair6: { file: '../../assets/models/hair/Hair6.glb', meshName: null,
               defaults: { posx: 50, posy: 23, posz: 41, roty: 50, scale: 48 } },
      hair7: { file: '../../assets/models/hair/Hair7.glb', meshName: null,
               defaults: { posx: 52, posy: 21, posz: 35, roty: 50, scale: 60 } },
      hair8: { file: '../../assets/models/hair/Hair8.glb', meshName: null,
               defaults: { posx: 50, posy: 15, posz: 33, roty: 50, scale: 40 } },
      hair9: { file: '../../assets/models/hair/Hair9.glb', meshName: null,
               defaults: { posx: 49, posy: 17, posz: 48, roty: 50, scale: 49 } },
      hair10: { file: '../../assets/models/hair/Hair10.glb', meshName: null,
               defaults: { posx: 50, posy: 34, posz: 28, roty: 50, scale: 59 } },
      hair11: { file: '../../assets/models/hair/Hair11.glb', meshName: null,
               defaults: { posx: 50, posy: 21, posz: 40, roty: 50, scale: 47 } },
      hair12: { file: '../../assets/models/hair/Hair12.glb', meshName: null,
               defaults: { posx: 49, posy: 26, posz: 37, roty: 50, scale: 45 } },
      hair13: { file: '../../assets/models/hair/Hair13.glb', meshName: null,
               defaults: { posx: 48, posy: 23, posz: 38, roty: 50, scale: 53 } },
      bald:  { file: null, defaults: null },
    };

    // Eyebrow model config
    this.eyebrowModel = { file: '../../assets/models/facial/eyebrows.glb', meshName: null };

    // Beard model configs with per-model defaults
    // defaults: { scale, posX, posY, posZ, rotY, rotZ } - calibrated values
    this.beardModels = {
      none: { file: null, defaults: null },
      beard1: { file: '../../assets/models/facial/Beard1.glb', meshName: null,
                defaults: { scale: 70, posX: 103, posY: 44, posZ: 74, rotY: 98, rotZ: 107 } },
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

  setHeadMesh(headGroup, regionData, morpher) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._morpher = morpher;
    this._computeHeadMetrics();
  }

  refreshFromMesh(morphValues) {
    if (!this._headGroup) return;
    if (morphValues) this._faceMorphValues = morphValues;
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

    // Track eyebrow landmarks for automatic adjustment with face morphs
    if (this._morpher && typeof this._morpher.getCurrentLandmarkPosition === 'function') {
      try {
        // Get current eyebrow landmark positions (midpoint between left/right brow)
        const leftBrowPos = this._morpher.getCurrentLandmarkPosition('brow_left_center');
        const rightBrowPos = this._morpher.getCurrentLandmarkPosition('brow_right_center');
        
        if (leftBrowPos && rightBrowPos) {
          // Calculate midpoint for eyebrow center tracking
          const currentBrowCenter = new THREE.Vector3(
            (leftBrowPos.x + rightBrowPos.x) / 2,
            (leftBrowPos.y + rightBrowPos.y) / 2,
            (leftBrowPos.z + rightBrowPos.z) / 2
          );

          // Store initial position on first call
          if (!this._initialBrowCenter) {
            this._initialBrowCenter = currentBrowCenter.clone();
            this._initialBrowBaseY = 0.39; // Default browRegionY
          }

          // Calculate delta from initial to current position
          this._browLandmarkDelta = currentBrowCenter.clone().sub(this._initialBrowCenter);
        }
      } catch (e) {
        // Silently fail if landmarks aren't available - eyebrows will use default positioning
        console.warn('[HairSystem] Eyebrow landmark tracking unavailable:', e.message);
      }
    }
  }

  // ── Public API ──

  setStyle(style) {
    this.currentStyle = style;
    // Apply model-specific defaults if available
    const config = this.hairModels[style];
    if (config && config.defaults) {
      this.params.posx = config.defaults.posx;
      this.params.posy = config.defaults.posy;
      this.params.posz = config.defaults.posz;
      this.params.roty = config.defaults.roty;
      this.params.scale = config.defaults.scale;
    }
    this.generate();
    // Return the applied defaults so UI can update sliders
    return config?.defaults || null;
  }

  setColor(color) {
    this.hairColor = color;
    this._applyHairTint();
  }

  setHairTintColor(color) {
    this.hairTintColor = color;
    this._applyHairTint();
  }

  setHairTintIntensity(intensity) {
    this.hairTintIntensity = Math.max(0, Math.min(1, intensity));
    this._applyHairTint();
  }

  _applyHairTint() {
    const blended = this._blendColors(this.hairColor, this.hairTintColor, this.hairTintIntensity);
    this._hairMat.color.set(blended);
    // Refresh manual tint painter vertex colors if it has painted data
    if (this.hairTintPainter && this.hairTintPainter._hasAnyTintData('hair')) {
      this.hairTintPainter.refreshVertexColors('hair');
    }
  }

  setParam(param, value) {
    this.params[param] = value;
    if (this._hairContainer) this._applyAdjustments();
  }

  setCustomParam(param, value) { /* no-op for model-based hair */ }

  // ── Main generation ──

  generate() {
    console.log('[HairSystem] generate() called for style:', this.currentStyle);
    // Notify tint painter to clean up before clearing old meshes
    if (this.hairTintPainter) this.hairTintPainter.onModelChanged('hair');
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
    this._applyEyebrowTint();
  }

  setEyebrowTintColor(color) {
    this.eyebrowTintColor = color;
    this._applyEyebrowTint();
  }

  setEyebrowTintIntensity(intensity) {
    this.eyebrowTintIntensity = Math.max(0, Math.min(1, intensity));
    this._applyEyebrowTint();
  }

  _applyEyebrowTint() {
    const blended = this._blendColors(this.eyebrowColor, this.eyebrowTintColor, this.eyebrowTintIntensity);
    this._eyebrowMat.color.set(blended);
    if (this.hairTintPainter && this.hairTintPainter._hasAnyTintData('eyebrow')) {
      this.hairTintPainter.refreshVertexColors('eyebrow');
    }
  }

  setEyebrowParam(param, value) {
    this.eyebrowParams[param] = value;
    if (this._eyebrowContainer) this._alignAndAdjustEyebrows();
  }

  generateEyebrows() {
    console.log('[HairSystem] generateEyebrows() called');
    if (this.hairTintPainter) this.hairTintPainter.onModelChanged('eyebrow');
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
    if (!cached) {
      console.warn('[HairSystem] No cached eyebrow model to show');
      return;
    }

    const container = new THREE.Group();
    container.name = 'EyebrowContainer';

    const offsetGroup = new THREE.Group();
    offsetGroup.name = 'EyebrowOffset';

    let meshCount = 0;
    cached.traverse(child => {
      if (child.isMesh) {
        const clone = child.clone();
        clone.material = this._eyebrowMat;
        clone.castShadow = true;
        clone.receiveShadow = true;
        offsetGroup.add(clone);
        meshCount++;
      }
    });

    console.log(`[HairSystem] Eyebrow meshes found: ${meshCount}`);

    container.add(offsetGroup);
    this._eyebrowGroup.add(container);
    this._eyebrowContainer = container;
    
    // Clear bbox cache for new model
    this._eyebrowBboxCache = null;

    console.log('[HairSystem] Calling _alignAndAdjustEyebrows...');
    this._alignAndAdjustEyebrows();
    console.log('[HairSystem] Eyebrows displayed successfully');
  }

  _alignAndAdjustEyebrows() {
    if (!this._eyebrowContainer || !this._headGroup) {
      console.warn('[HairSystem] _alignAndAdjustEyebrows early return - container or headGroup missing');
      return;
    }

    const container = this._eyebrowContainer;
    const offsetGroup = container.children[0];
    if (!offsetGroup) {
      console.warn('[HairSystem] _alignAndAdjustEyebrows early return - offsetGroup missing');
      return;
    }
    
    const ep = this.eyebrowParams;

    // Compute bbox only once and cache it
    if (!this._eyebrowBboxCache) {
      console.log('[HairSystem] Computing eyebrow bbox...');
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

      console.log('[HairSystem] Eyebrow bbox - size:', browSize.x, browSize.y, browSize.z);

      if (browSize.x < 0.001) {
        console.warn('[HairSystem] Eyebrow bbox size too small, aborting');
        return;
      }

      this._eyebrowBboxCache = { center: browCenter, size: browSize };
      
      // Center eyebrow model at origin (only needed once)
      offsetGroup.position.set(-browCenter.x, -browCenter.y, -browCenter.z);
      console.log('[HairSystem] Eyebrow bbox cached successfully');
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

    // Apply landmark tracking delta if available (makes eyebrows follow face morphs)
    let landmarkOffsetY = 0;
    let landmarkOffsetZ = 0;
    if (this._browLandmarkDelta && !isNaN(this._browLandmarkDelta.y) && !isNaN(this._browLandmarkDelta.z)) {
      landmarkOffsetY = this._browLandmarkDelta.y;
      landmarkOffsetZ = this._browLandmarkDelta.z;
      console.log('[HairSystem] Eyebrow landmark delta - Y:', landmarkOffsetY, 'Z:', landmarkOffsetZ);
    } else {
      console.log('[HairSystem] Eyebrow landmark tracking not available, using default positioning');
    }

    // Apply scale: X by overall scale, Y by thickness, Z by length
    container.scale.set(
      baseScale * scaleF,
      baseScale * thicknessF,
      baseScale * scaleF * lengthF
    );

    const finalX = this.modelCenter.x + spacingOffset + posOffsetX;
    const finalY = browRegionY + archF + posOffsetY + landmarkOffsetY;
    const finalZ = browRegionZ + posOffsetZ + landmarkOffsetZ;

    container.position.set(finalX, finalY, finalZ);
    
    console.log('[HairSystem] Eyebrow final position - X:', finalX, 'Y:', finalY, 'Z:', finalZ);
    console.log('[HairSystem] Eyebrow scale:', baseScale * scaleF, baseScale * thicknessF, baseScale * scaleF * lengthF);

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
    this._applyBeardTint();
  }

  setBeardTintColor(color) {
    this.beardTintColor = color;
    this._applyBeardTint();
  }

  setBeardTintIntensity(intensity) {
    this.beardTintIntensity = Math.max(0, Math.min(1, intensity));
    this._applyBeardTint();
  }

  _applyBeardTint() {
    const blended = this._blendColors(this.beardColor, this.beardTintColor, this.beardTintIntensity);
    this._beardMat.color.set(blended);
    if (this.hairTintPainter && this.hairTintPainter._hasAnyTintData('beard')) {
      this.hairTintPainter.refreshVertexColors('beard');
    }
  }

  setBeardParam(param, value) {
    this.beardParams[param] = value;
    if (this._beardContainer) this._alignAndAdjustBeard();
  }

  setBeard(style) {
    this.beardStyle = style;
    // Apply model-specific defaults if available
    const config = this.beardModels[style];
    if (config && config.defaults) {
      this.beardParams.scale = config.defaults.scale;
      this.beardParams.posX = config.defaults.posX;
      this.beardParams.posY = config.defaults.posY;
      this.beardParams.posZ = config.defaults.posZ;
      this.beardParams.rotY = config.defaults.rotY;
      this.beardParams.rotZ = config.defaults.rotZ;
    }
    this.generateBeard();
    // Return the applied defaults so UI can update sliders
    return config?.defaults || null;
  }

  generateBeard() {
    if (this.hairTintPainter) this.hairTintPainter.onModelChanged('beard');
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

    // ── Jaw/chin-aware beard synchronization ──
    // Face morph values are 0-100 with 50 as neutral
    const mv = this._faceMorphValues || {};
    const neutral = 50;

    // jawWidth (regions 13,14): scale beard X to match jaw spread
    // morphMap range [0.85, 1.2] → at slider 0: 0.85x, at 50: ~1.025x, at 100: 1.2x
    const jawT = ((mv.jawWidth ?? neutral) - neutral) / 50;        // -1 to 1
    const jawScaleX = 1.0 + jawT * 0.18;  // beard widens/narrows with jaw

    // chinWidth (region 15): further adjust beard X for chin area
    const chinWT = ((mv.chinWidth ?? neutral) - neutral) / 50;
    const chinScaleX = 1.0 + chinWT * 0.12;

    // chinProtrusion (region 15): shift beard forward/back with chin
    const chinPT = ((mv.chinProtrusion ?? neutral) - neutral) / 50;
    const chinZOffset = chinPT * 0.05;

    // chinHeight (region 15): shift beard up/down with chin
    const chinHT = ((mv.chinHeight ?? neutral) - neutral) / 50;
    const chinYOffset = chinHT * 0.05;

    // chinShape (region 15): scale beard Z-depth with chin shape
    const chinST = ((mv.chinShape ?? neutral) - neutral) / 50;
    const chinScaleZ = 1.0 + chinST * 0.10;

    // jawDefinition (jaw_angle landmarks): widens jaw outward and pulls inward
    const jawDT = ((mv.jawDefinition ?? neutral) - neutral) / 50;
    const jawDefScaleX = 1.0 + jawDT * 0.15;
    const jawDefZOffset = jawDT * -0.02;

    // ── Cheek parameters ──
    // cheekFullness: pushes cheeks outward (X) and forward (Z)
    const cheekFT = ((mv.cheekFullness ?? neutral) - neutral) / 50;
    const cheekScaleX = 1.0 + cheekFT * 0.12;
    const cheekZOffset = cheekFT * 0.03;

    // cheekboneProminence: widens cheekbones outward (X) and forward (Z)
    const cheekBT = ((mv.cheekboneProminence ?? neutral) - neutral) / 50;
    const cheekBoneScaleX = 1.0 + cheekBT * 0.10;
    const cheekBoneZOffset = cheekBT * 0.02;

    // cheekHeight: shifts cheek area up/down (Y)
    const cheekHT = ((mv.cheekHeight ?? neutral) - neutral) / 50;
    const cheekYOffset = cheekHT * 0.03;

    // nasolabialDepth: pulls inward around nasolabial folds (Z)
    const nasoT = ((mv.nasolabialDepth ?? neutral) - neutral) / 50;
    const nasoZOffset = nasoT * -0.03;

    // ── Mouth parameters ──
    // mouthWidth: widens mouth area (X)
    const mouthWT = ((mv.mouthWidth ?? neutral) - neutral) / 50;
    const mouthScaleX = 1.0 + mouthWT * 0.10;

    // lipProtrusion: pushes lips forward (Z)
    const lipPT = ((mv.lipProtrusion ?? neutral) - neutral) / 50;
    const lipZOffset = lipPT * 0.04;

    // mouthHeight: shifts mouth area up/down (Y)
    const mouthHT = ((mv.mouthHeight ?? neutral) - neutral) / 50;
    const mouthYOffset = mouthHT * 0.03;

    // ── Lip position tracking (beard gap follows lip placement) ──
    // upperLipThickness: lip moves up (Y) and forward (Z)
    const upperLipT = ((mv.upperLipThickness ?? neutral) - neutral) / 50;
    const upperLipYOffset = upperLipT * 0.025;
    const upperLipZOffset = upperLipT * 0.03;

    // lowerLipThickness: lip moves down (Y) and forward (Z)
    const lowerLipT = ((mv.lowerLipThickness ?? neutral) - neutral) / 50;
    const lowerLipYOffset = lowerLipT * -0.025;
    const lowerLipZOffset = lowerLipT * 0.03;

    // cupidBow: shifts upper lip area up (Y) and slightly forward (Z)
    const cupidT = ((mv.cupidBow ?? neutral) - neutral) / 50;
    const cupidYOffset = cupidT * 0.02;
    const cupidZOffset = cupidT * 0.01;

    // lipCornerAngle: shifts mouth corners up/down (Y)
    const lipCornerT = ((mv.lipCornerAngle ?? neutral) - neutral) / 50;
    const lipCornerYOffset = lipCornerT * 0.02;

    // Combined lip Y/Z offsets — beard gap tracks where lips actually sit
    const lipYShift = upperLipYOffset + lowerLipYOffset + cupidYOffset + lipCornerYOffset;
    const lipZShift = upperLipZOffset + lowerLipZOffset + cupidZOffset;

    // Combined face-morph scale factors
    const faceScaleX = jawScaleX * chinScaleX * jawDefScaleX * cheekScaleX * cheekBoneScaleX * mouthScaleX;
    const faceScaleZ = chinScaleZ;

    container.scale.set(
      baseScale * scaleF * faceScaleX,
      baseScale * scaleF,
      baseScale * scaleF * faceScaleZ
    );

    container.position.set(
      this.modelCenter.x + posOffsetX,
      beardRegionY + posOffsetY + chinYOffset + cheekYOffset + mouthYOffset + lipYShift,
      beardRegionZ + posOffsetZ + chinZOffset + jawDefZOffset + cheekZOffset + cheekBoneZOffset + nasoZOffset + lipZOffset + lipZShift
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

  /**
   * Blend two hex colors by lerping RGB channels.
   * @param {string} baseHex - Base color (#rrggbb)
   * @param {string} tintHex - Tint/overlay color (#rrggbb)
   * @param {number} t - Blend factor (0 = all base, 1 = all tint)
   * @returns {string} Blended hex color
   */
  _blendColors(baseHex, tintHex, t) {
    if (t <= 0) return baseHex;
    if (t >= 1) return tintHex;
    const base = this._hexToRgbObj(baseHex);
    const tint = this._hexToRgbObj(tintHex);
    const r = Math.round(base.r * (1 - t) + tint.r * t);
    const g = Math.round(base.g * (1 - t) + tint.g * t);
    const b = Math.round(base.b * (1 - t) + tint.b * t);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  _hexToRgbObj(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16),
    } : { r: 44, g: 27, b: 14 }; // fallback to dark brown
  }

  _clearGroup(group) {
    while (group.children.length) {
      const c = group.children[0];
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
      group.remove(c);
    }
  }

  clearHair() { this._clearGroup(this.hairGroup); this._hairContainer = null; this._hairBboxCache = null; }

  /**
   * Save current hair position/scale as the new default for this model.
   * Logs the config to console so you can copy it into the code.
   */
  saveHairDefault() {
    const style = this.currentStyle;
    if (!style || style === 'bald') {
      console.log('[HairSystem] No hair style to save defaults for');
      return null;
    }
    const defaults = {
      posx: this.params.posx,
      posy: this.params.posy,
      posz: this.params.posz,
      roty: this.params.roty,
      scale: this.params.scale
    };
    // Update in memory
    if (this.hairModels[style]) {
      this.hairModels[style].defaults = defaults;
    }
    // Log for copying into code
    console.log(`[HairSystem] Default saved for ${style}:`);
    console.log(`      ${style}: { file: '../../assets/models/hair/${style.charAt(0).toUpperCase() + style.slice(1)}.glb', meshName: ${this.hairModels[style]?.meshName ? `'${this.hairModels[style].meshName}'` : 'null'},`);
    console.log(`               defaults: { posx: ${defaults.posx}, posy: ${defaults.posy}, posz: ${defaults.posz}, roty: ${defaults.roty}, scale: ${defaults.scale} } },`);
    return defaults;
  }

  /**
   * Save current beard position/scale as the new default for this model.
   * Logs the config to console so you can copy it into the code.
   */
  saveBeardDefault() {
    const style = this.beardStyle;
    if (!style || style === 'none') {
      console.log('[HairSystem] No beard style to save defaults for');
      return null;
    }
    const defaults = {
      scale: this.beardParams.scale,
      posX: this.beardParams.posX,
      posY: this.beardParams.posY,
      posZ: this.beardParams.posZ,
      rotY: this.beardParams.rotY,
      rotZ: this.beardParams.rotZ
    };
    // Update in memory
    if (this.beardModels[style]) {
      this.beardModels[style].defaults = defaults;
    }
    // Log for copying into code
    console.log(`[HairSystem] Default saved for ${style}:`);
    console.log(`      ${style}: { file: '../../assets/models/facial/${style.charAt(0).toUpperCase() + style.slice(1)}.glb', meshName: null,`);
    console.log(`                defaults: { scale: ${defaults.scale}, posX: ${defaults.posX}, posY: ${defaults.posY}, posZ: ${defaults.posZ}, rotY: ${defaults.rotY}, rotZ: ${defaults.rotZ} } },`);
    return defaults;
  }

  /**
   * Get current defaults for all hair/beard models (for debugging/inspection)
   */
  getAllDefaults() {
    const hairDefaults = {};
    for (const [style, config] of Object.entries(this.hairModels)) {
      if (config.defaults) {
        hairDefaults[style] = config.defaults;
      }
    }
    const beardDefaults = {};
    for (const [style, config] of Object.entries(this.beardModels)) {
      if (config.defaults) {
        beardDefaults[style] = config.defaults;
      }
    }
    console.log('[HairSystem] All Hair Defaults:', hairDefaults);
    console.log('[HairSystem] All Beard Defaults:', beardDefaults);
    return { hair: hairDefaults, beard: beardDefaults };
  }

  getParams() {
    return {
      style: this.currentStyle, color: this.hairColor,
      hairTintColor: this.hairTintColor, hairTintIntensity: this.hairTintIntensity,
      length: this.params.length / 100, density: this.params.density / 100,
      volume: this.params.volume / 100, curl: this.params.curl / 100,
      posX: this.params.posx / 100, posY: this.params.posy / 100,
      posZ: this.params.posz / 100, rotY: this.params.roty / 100,
      hairScale: this.params.scale / 100,
      beard: { style: this.beardStyle, ...this.beardParams, color: this.beardColor,
               tintColor: this.beardTintColor, tintIntensity: this.beardTintIntensity },
      eyebrows: { ...this.eyebrowParams, color: this.eyebrowColor,
                  tintColor: this.eyebrowTintColor, tintIntensity: this.eyebrowTintIntensity },
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

  /**
   * Return the beard's world-space transform so Blender can replicate it.
   */
  getBeardRenderTransform() {
    if (!this._beardContainer || this.beardStyle === 'none') {
      return { matrix: null, params: this.beardParams };
    }

    const c = this._beardContainer;
    const o = c.children[0]; // offsetGroup

    c.updateWorldMatrix(true, false);
    o.updateWorldMatrix(true, false);
    const combinedMatrix = o.matrixWorld;

    return {
      matrix: Array.from(combinedMatrix.elements),
      params: { ...this.beardParams },
      style: this.beardStyle,
      color: this.beardColor,
    };
  }

  /**
   * Return the eyebrow's world-space transform so Blender can replicate it.
   */
  getEyebrowRenderTransform() {
    if (!this._eyebrowContainer) {
      return { matrix: null, params: this.eyebrowParams };
    }

    const c = this._eyebrowContainer;
    const o = c.children[0]; // offsetGroup

    c.updateWorldMatrix(true, false);
    o.updateWorldMatrix(true, false);
    const combinedMatrix = o.matrixWorld;

    return {
      matrix: Array.from(combinedMatrix.elements),
      params: { ...this.eyebrowParams },
      color: this.eyebrowColor,
    };
  }

  loadState(state) {
    if (!state) return;
    if (state.style) this.currentStyle = state.style;
    if (state.color) this.hairColor = state.color;
    if (state.hairTintColor) this.hairTintColor = state.hairTintColor;
    if (state.hairTintIntensity !== undefined) this.hairTintIntensity = state.hairTintIntensity;
    this._applyHairTint();
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
      if (state.beard.color) this.beardColor = state.beard.color;
      if (state.beard.tintColor) this.beardTintColor = state.beard.tintColor;
      if (state.beard.tintIntensity !== undefined) this.beardTintIntensity = state.beard.tintIntensity;
      this._applyBeardTint();
    } else if (state.facialHair) {
      // Legacy support - just ignore old facial hair data
      console.log('Legacy facial hair data ignored - please use beard system');
    }
    
    if (state.eyebrows) {
      const eb = state.eyebrows;
      for (const key of ['thickness', 'arch', 'spacing', 'density', 'posX', 'posY', 'posZ', 'rotation', 'scale', 'straighten', 'tiltX', 'length', 'opacity']) {
        if (eb[key] !== undefined) this.eyebrowParams[key] = eb[key];
      }
      if (eb.color) this.eyebrowColor = eb.color;
      if (eb.tintColor) this.eyebrowTintColor = eb.tintColor;
      if (eb.tintIntensity !== undefined) this.eyebrowTintIntensity = eb.tintIntensity;
      this._applyEyebrowTint();
    }
    this.generate();
    this.generateBeard();
    this.generateEyebrows();
  }
}

window.HairSystem = HairSystem;