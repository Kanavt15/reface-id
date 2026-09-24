// Loads a face mask model and fits it to the lower face from the live landmarks, with adjustable ear loops.

// Mask model paths; update these if the files move.
const FACEMASK_MODEL_PATH_STYLE1 = '../../assets/models/face_mask/Mask1.obj';
const FACEMASK_MODEL_PATH_STYLE2 = '../../assets/models/face_mask/Mask2.obj';

class FaceMaskSystem {
  // Neutral slider values before any per-style tuning.
  static get BASE_PARAMS() {
    return {
      scale: 100,    // 50..200  — uniform fit
      width: 100,    // 50..150  — X-only widening (cheek wrap)
      coverage: 100, // 50..150  — how far up the nose the top edge reaches
      posX: 0,       // -100..+100 — horizontal shift
      posY: 0,       // -100..+100 — vertical placement
      posZ: 0,       // -100..+100 — depth from face surface
      rotX: 0,       // -180..180 deg — pitch
      rotY: 0,       // -180..180 deg — yaw
      rotZ: 0,       // -180..180 deg — roll
      // Ear loops are tuned per side because the cords aren't perfect mirrors; "left" means the subject's left.
      strapScaleL: 100, // 50..200 — left ear-loop length
      strapScaleR: 100, // 50..200 — right ear-loop length
      strapAngleL: 0,   // -60..+60 deg — swings the left loop's free end up/down
      strapAngleR: 0,   // -60..+60 deg — same for the right loop
      strapSplayL: 0,   // -45..+45 deg — swings the left loop outward/inward
      strapSplayR: 0,   // -45..+45 deg — same for the right loop
    };
  }

  constructor(scene) {
    this.scene = scene;

    // HeadTracker looks for this.maskGroup by name to move it into the tracking pivot.
    this.maskGroup = new THREE.Group();
    this.maskGroup.name = 'FaceMaskSystem';
    this.scene.add(this.maskGroup);

    // Head references (set by setHeadMesh)
    this._headGroup = null;
    this._regionData = null;
    this._morpher = null;
    this._faceMorphValues = null;

    // State
    this.enabled = false;
    this.currentStyle = 'mask1';
    this.maskColor = '#1c1c1e';
    this.strapColor = '#e6e6e6';
    this.opacity = 100;      // 0..100 — 100 = fully opaque

    // Seeded from the active style's defaults at the end of the constructor.
    this.params = FaceMaskSystem.BASE_PARAMS;

    // Body meshes drive the fit bbox; strap meshes only ride along.
    this._bodyMeshes = [];
    this._strapMeshes = [];

    // Style configs. `defaults` are applied by setStyle().
    this.maskModels = {
      mask1: {
        file: FACEMASK_MODEL_PATH_STYLE1,
        label: 'Cloth Mask',
        // This model's top edge dips at the middle, so lift it to cover the nose.
        defaults: {
          scale: 100, width: 100, coverage: 100,
          posX: 0, posY: 10, posZ: 0,
          rotX: 0, rotY: 0, rotZ: 0,
          strapScaleL: 100, strapScaleR: 100,
          strapAngleL: 0, strapAngleR: 0,
          strapSplayL: 0, strapSplayR: 0,
          maskColor: '#1c1c1e',
          opacity: 100,
        },
      },
      mask2: {
        file: FACEMASK_MODEL_PATH_STYLE2,
        label: 'Medical Mask',
        // Hand-tuned; the two ear loops need slightly different lengths to reach the ears.
        defaults: {
          scale: 127, width: 98, coverage: 87,
          posX: -2, posY: 2, posZ: 3,
          rotX: -7, rotY: 0, rotZ: 0,
          strapScaleL: 135, strapScaleR: 133,
          strapAngleL: 0, strapAngleR: 0,
          strapSplayL: -3, strapSplayR: 0,
          maskColor: '#7fb5d4',
          strapColor: '#e6e6e6',
          opacity: 100,
        },
      },
    };

    // Caches
    this._modelCache = {};   // styleName -> THREE.Group
    this._loadId = 0;
    this._loads = new AssetLoadTracker('faceMask');

    // Current scene container
    this._container = null;
    this._fitCache = null;

    // Starting landmark positions, used as a fallback if a landmark stops resolving.
    this._initialNoseBridge = null;
    this._initialChin = null;
    this._initialJawSpan = null;

    // Materials
    this._maskMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.maskColor),
      roughness: 0.88,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    this._strapMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.strapColor),
      roughness: 0.75,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    // Apply the starting style's defaults now so the first "show mask" already uses the tuned fit.
    this.setStyle(this.currentStyle);

    console.log('[FaceMaskSystem] Initialized');
  }

  // Returns a style's full default state, so reset restores the tuned fit.
  getStyleDefaults(style) {
    const name = this.maskModels[style] ? style : 'mask1';
    const d = this.maskModels[name].defaults || {};
    return {
      enabled: false,
      style: name,
      maskColor: '#1c1c1e',
      strapColor: '#e6e6e6',
      opacity: 100,
      ...FaceMaskSystem.BASE_PARAMS,
      ...d,
    };
  }

  // ── Head binding ────────────────────────────────────────────────────────

  // Connects the mask to the head mesh and morpher.
  setHeadMesh(headGroup, regionData, morpher) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._morpher = morpher || null;
    this._initialNoseBridge = null;
    this._initialChin = null;
    this._initialJawSpan = null;
    this._captureBaselines();
  }

  // Records the starting positions of the landmarks the fit uses.
  _captureBaselines() {
    if (!this._morpher || typeof this._morpher.getCurrentLandmarkPosition !== 'function') return;
    const bridge = this._morpher.getCurrentLandmarkPosition('nose_bridge');
    const chin = this._morpher.getCurrentLandmarkPosition('chin');
    const jawL = this._morpher.getCurrentLandmarkPosition('jaw_angle_left');
    const jawR = this._morpher.getCurrentLandmarkPosition('jaw_angle_right');
    if (bridge) this._initialNoseBridge = new THREE.Vector3(bridge[0], bridge[1], bridge[2]);
    if (chin) this._initialChin = new THREE.Vector3(chin[0], chin[1], chin[2]);
    if (jawL && jawR) this._initialJawSpan = Math.abs(jawR[0] - jawL[0]);
  }

  // Refits the mask after every face change.
  refreshFromMesh(morphValues) {
    if (morphValues) this._faceMorphValues = morphValues;
    if (this._container && this.enabled) {
      this._alignAndAdjust();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  // Shows or hides the mask, loading it on first use.
  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.enabled) {
      if (!this._container) {
        this.generate();
      } else {
        this.maskGroup.visible = true;
        this._alignAndAdjust();
      }
    } else {
      this.maskGroup.visible = false;
    }
  }

  // Switches to another mask style and applies its tuned defaults.
  setStyle(style) {
    const config = this.maskModels[style];
    if (!config) {
      console.warn('[FaceMaskSystem] Unknown style:', style);
      return;
    }
    this.currentStyle = style;

    const d = config.defaults;
    if (d) {
      for (const key of Object.keys(this.params)) {
        if (d[key] !== undefined) this.params[key] = d[key];
      }
      if (d.maskColor) this.setMaskColor(d.maskColor);
      if (d.strapColor) this.setStrapColor(d.strapColor);
      if (d.opacity !== undefined) this.setOpacity(d.opacity);
    }

    if (this.enabled) {
      this.generate();
    }
  }

  // Sets the mask colour.
  setMaskColor(hex) {
    this.maskColor = hex;
    this._maskMat.color.set(hex);
  }

  // Sets the ear-loop colour.
  setStrapColor(hex) {
    this.strapColor = hex;
    this._strapMat.color.set(hex);
  }

  // Sets the mask's opacity.
  setOpacity(value) {
    this.opacity = Math.max(0, Math.min(100, value));
    const o = this.opacity / 100;
    for (const mat of [this._maskMat, this._strapMat]) {
      mat.opacity = o;
      mat.transparent = o < 0.999;
    }
  }

  // Sets one fit value and refits the mask.
  setParam(param, value) {
    if (this.params[param] === undefined) return;
    this.params[param] = value;
    if (this._container && this.enabled) this._alignAndAdjust();
  }

  // Returns the current mask settings.
  getParams() {
    return {
      ...this.params,
      enabled: this.enabled,
      style: this.currentStyle,
      maskColor: this.maskColor,
      strapColor: this.strapColor,
      opacity: this.opacity,
    };
  }

  // ── Generation ──────────────────────────────────────────────────────────

  // Loads the mask model (or uses the cached one) and fits it to the face.
  generate() {
    this._clearGroup(this.maskGroup);
    this._container = null;
    this._fitCache = null;

    if (!this.enabled) return;

    const config = this.maskModels[this.currentStyle];
    if (!config || !config.file) return;

    this._loadId++;
    const thisLoadId = this._loadId;

    if (this._modelCache[this.currentStyle]) {
      this._showCached(this.currentStyle);
      return;
    }

    const loader = new THREE.OBJLoader();
    this._loads.begin();
    loader.load(
      config.file,
      (group) => {
        if (this._loadId !== thisLoadId) { this._loads.end(); return; }

        // No axis fix: these OBJs are already Y-up with +Z forward.
        const baked = new THREE.Group();
        baked.name = group.name || 'FaceMaskOBJ';
        group.traverse(child => {
          if (!child.isMesh) return;
          baked.add(child.clone());
        });

        this._modelCache[this.currentStyle] = baked;
        this._showCached(this.currentStyle);
        this._loads.end();
      },
      null,
      (err) => {
        console.error('[FaceMaskSystem] Failed to load OBJ:', config.file, err);
        this._loads.end();
      }
    );
  }

  // Resolves once no mask model is still loading.
  whenIdle() {
    return this._loads.whenIdle();
  }

  // Tells whether a mesh is one of the ear loops, from the name Blender exported.
  _isStrapMesh(mesh) {
    return /cord|strap|loop|band|elastic|tie|string/i.test(mesh.name || '');
  }

  // Moves a strap's pivot to where it joins the mask, so its length and angle swing it toward the ear.
  _pivotStrapAtAttachment(mesh, bodyCentreX) {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const px = (bb.min.x + bb.max.x) * 0.5;
    const py = (bb.min.y + bb.max.y) * 0.5;
    const pz = bb.max.z;
    mesh.geometry.translate(-px, -py, -pz);
    mesh.position.set(px, py, pz);
    mesh.userData.strapSide = px < bodyCentreX ? 'left' : 'right';
  }

  // Places a cached mask model in the scene, separating the body from the ear loops.
  _showCached(style) {
    this._clearGroup(this.maskGroup);
    this._bodyMeshes = [];
    this._strapMeshes = [];
    const cached = this._modelCache[style];
    if (!cached) return;

    const container = new THREE.Group();
    container.name = 'FaceMaskContainer';
    const offsetGroup = new THREE.Group();
    offsetGroup.name = 'FaceMaskOffset';

    cached.traverse(child => {
      if (!child.isMesh) return;
      const mesh = child.clone();
      mesh.geometry = child.geometry.clone();
      const isStrap = this._isStrapMesh(child);
      mesh.material = isStrap ? this._strapMat : this._maskMat;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      (isStrap ? this._strapMeshes : this._bodyMeshes).push(mesh);
      offsetGroup.add(mesh);
    });

    // A model with only straps counts them all as body so the fit box is never empty.
    if (this._bodyMeshes.length === 0 && this._strapMeshes.length > 0) {
      this._bodyMeshes = this._strapMeshes.slice();
      this._strapMeshes = [];
    } else {
      // Pivot each strap where it meets the mask body, once every mesh has been sorted.
      const bodyBox = new THREE.Box3();
      for (const m of this._bodyMeshes) {
        m.geometry.computeBoundingBox();
        bodyBox.union(m.geometry.boundingBox);
      }
      const bodyCentreX = bodyBox.isEmpty() ? 0 : (bodyBox.min.x + bodyBox.max.x) * 0.5;
      for (const m of this._strapMeshes) this._pivotStrapAtAttachment(m, bodyCentreX);
    }

    container.add(offsetGroup);
    this.maskGroup.add(container);
    this._container = container;
    this._fitCache = null;
    this.maskGroup.visible = this.enabled;

    this._alignAndAdjust();
  }

  // Fits the mask to the nose bridge, chin and jaw, then applies the user's offsets.
  _alignAndAdjust() {
    if (!this._container || !this._headGroup) return;

    const container = this._container;
    const offsetGroup = container.children[0];
    if (!offsetGroup) return;

    // Measure the fit box from the mask body only; the straps would throw it off.
    if (!this._fitCache) {
      container.scale.set(1, 1, 1);
      container.position.set(0, 0, 0);
      container.rotation.set(0, 0, 0);
      offsetGroup.position.set(0, 0, 0);

      const box = new THREE.Box3();
      for (const m of this._bodyMeshes) {
        m.geometry.computeBoundingBox();
        box.union(m.geometry.boundingBox);
      }
      if (box.isEmpty()) return;

      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);
      if (size.x < 0.0001 || size.y < 0.0001) return;

      this._fitCache = { center, size };
      offsetGroup.position.set(-center.x, -center.y, -center.z);
    }

    const size = this._fitCache.size;

    // ── Live landmark sample (current post-morph positions) ──
    let bridge = this._initialNoseBridge ? this._initialNoseBridge.clone() : null;
    let chin = this._initialChin ? this._initialChin.clone() : null;
    let jawSpan = this._initialJawSpan;
    let noseTipZ = null;

    if (this._morpher && typeof this._morpher.getCurrentLandmarkPosition === 'function') {
      const b = this._morpher.getCurrentLandmarkPosition('nose_bridge');
      const c = this._morpher.getCurrentLandmarkPosition('chin');
      const jl = this._morpher.getCurrentLandmarkPosition('jaw_angle_left');
      const jr = this._morpher.getCurrentLandmarkPosition('jaw_angle_right');
      const nt = this._morpher.getCurrentLandmarkPosition('nose_tip');
      if (b) bridge = new THREE.Vector3(b[0], b[1], b[2]);
      if (c) chin = new THREE.Vector3(c[0], c[1], c[2]);
      if (jl && jr) jawSpan = Math.abs(jr[0] - jl[0]);
      if (nt) noseTipZ = nt[2];

      // Lazy capture if baselines weren't ready when setHeadMesh ran
      if (!this._initialNoseBridge && bridge) this._initialNoseBridge = bridge.clone();
      if (!this._initialChin && chin) this._initialChin = chin.clone();
      if (this._initialJawSpan === null && jawSpan) this._initialJawSpan = jawSpan;
    }

    // Fallbacks matching OBJMorpher.LANDMARKS if detection failed entirely
    if (!bridge) bridge = new THREE.Vector3(0, 0.20, 1.19);
    if (!chin) chin = new THREE.Vector3(0, -0.60, 1.08);
    if (!jawSpan) jawSpan = 1.20;
    if (noseTipZ === null) noseTipZ = 1.30;

    // Top edge sits on the nose bridge and the bottom wraps just under the chin.
    const coverage = (this.params.coverage ?? 100) / 100;
    const CHIN_WRAP = 0.10;
    const coverTop = chin.y + (bridge.y - chin.y) * coverage;
    const coverBottom = chin.y - CHIN_WRAP;
    const targetHeight = Math.max(0.05, coverTop - coverBottom);

    const baseScale = targetHeight / size.y;

    // ── Horizontal fit: match the jaw-angle span so the mask wraps the cheeks ──
    const JAW_WRAP = 1.02;
    const fittedWidth = size.x * baseScale;
    const widthFit = fittedWidth > 0.0001
      ? Math.max(0.6, Math.min(1.6, (jawSpan * JAW_WRAP) / fittedWidth))
      : 1;

    // Morph values fine-tune the fit so it keeps up during fast slider drags.
    const mv = this._faceMorphValues || (this._morpher ? this._morpher.morphValues : null) || {};
    const neutral = 50;
    const t = (key) => ((mv[key] ?? neutral) - neutral) / 50; // -1..+1
    const morphWidth = 1.0 + t('faceWidth') * 0.06 + t('jawWidth') * 0.05;
    const morphZOffset = t('lipProtrusion') * 0.012 + t('chinProtrusion') * 0.010;

    // ── User slider offsets ──
    const userScale = this.params.scale / 100;         // 0.5..2.0
    const userWidth = this.params.width / 100;         // 0.5..1.5
    const userPosX  = this.params.posX * 0.01;          // ±0.10 world-units
    const userPosY  = this.params.posY * 0.01;
    const userPosZ  = this.params.posZ * 0.01;
    const DEG = Math.PI / 180;

    const scaleY = baseScale * userScale;
    const scaleZ = baseScale * userScale;
    const scaleX = baseScale * widthFit * morphWidth * userWidth * userScale;

    container.scale.set(scaleX, scaleY, scaleZ);

    // Centre the mask on the covered span so its top edge lands on the nose bridge.
    const centreY = (coverTop + coverBottom) * 0.5;

    // Depth: push the mask so its front-most point clears the nose tip.
    const FACE_CLEARANCE = 0.02;
    const halfDepth = size.z * scaleZ * 0.5;
    const centreZ = noseTipZ + FACE_CLEARANCE - halfDepth;

    container.position.set(
      userPosX,
      centreY + userPosY,
      centreZ + morphZOffset + userPosZ
    );
    container.rotation.set(
      this.params.rotX * DEG,
      this.params.rotY * DEG,
      this.params.rotZ * DEG
    );

    // Ear loops scale along -Z and rotate at their pivot; the right loop uses opposite signs so both swing the same way.
    for (const m of this._strapMeshes) {
      const isLeft = m.userData.strapSide === 'left';
      const suffix = isLeft ? 'L' : 'R';
      const splaySign = isLeft ? 1 : -1;
      const angle = (this.params['strapAngle' + suffix] ?? 0) * DEG;
      const splay = (this.params['strapSplay' + suffix] ?? 0) * DEG;
      m.rotation.set(angle, splaySign * splay, 0);
      m.scale.set(1, 1, (this.params['strapScale' + suffix] ?? 100) / 100);
    }
  }

  // ── State / persistence ─────────────────────────────────────────────────

  // Returns the mask settings for saving.
  exportState() {
    // Spread params so new sliders persist without touching this method.
    return {
      ...this.params,
      enabled: this.enabled,
      style: this.currentStyle,
      maskColor: this.maskColor,
      strapColor: this.strapColor,
      opacity: this.opacity,
    };
  }

  // Restores mask settings from a saved case.
  loadState(state) {
    if (!state) return;
    if (state.style && this.maskModels[state.style]) this.currentStyle = state.style;
    if (state.maskColor) this.setMaskColor(state.maskColor);
    if (state.strapColor) this.setStrapColor(state.strapColor);
    if (state.opacity !== undefined) this.setOpacity(state.opacity);
    for (const key of Object.keys(this.params)) {
      if (state[key] !== undefined) this.params[key] = state[key];
    }
    // Older saves had one strap value for both loops, so copy it to both sides.
    for (const base of ['strapScale', 'strapAngle', 'strapSplay']) {
      if (state[base] === undefined) continue;
      if (state[base + 'L'] === undefined) this.params[base + 'L'] = state[base];
      if (state[base + 'R'] === undefined) this.params[base + 'R'] = state[base];
    }
    // Force a clean rebuild so undo/redo always shows the restored state.
    this._container = null;
    this._fitCache = null;
    this.setEnabled(state.enabled === true);
  }

  // Applies mask settings suggested by the AI.
  applyFromAI(data) {
    if (!data) return;
    if (data.style && this.maskModels[data.style]) this.setStyle(data.style);
    if (data.maskColor) this.setMaskColor(data.maskColor);
    if (data.strapColor) this.setStrapColor(data.strapColor);
    if (data.opacity !== undefined) this.setOpacity(data.opacity);
    this.setEnabled(!!data.enabled);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  // Removes every child from a group.
  _clearGroup(group) {
    while (group.children.length > 0) {
      group.remove(group.children[0]);
    }
  }

  // Removes the mask from the scene.
  dispose() {
    this._clearGroup(this.maskGroup);
    this.scene.remove(this.maskGroup);
  }
}

window.FaceMaskSystem = FaceMaskSystem;
