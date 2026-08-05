/**
 * FaceMaskSystem.js – OBJ-based face coverings (cloth / medical mask).
 *
 * Loads a mask OBJ and fits it to the lower face using live post-morph
 * landmarks: nose_bridge (top edge), chin (bottom edge), jaw angles (width)
 * and nose_tip (forward clearance). Mirrors GlassesSystem so head tracking
 * works automatically — HeadTracker reparents maskGroup into the pivot group.
 *
 * Model space note: both mask OBJs export Y-up with +Z facing forward, which
 * already matches the Three.js scene and head.glb. Unlike GlassesSystem no
 * axis-fix rotation is baked onto the geometry.
 *
 * Strap meshes (Mask2's ear cords) are kept out of the fit bounding box so the
 * mask body drives scale and placement, then ride along with the body.
 */

// ── Asset path constants ────────────────────────────────────────────────────
// Update these paths if the OBJ files are moved.
const FACEMASK_MODEL_PATH_STYLE1 = '../../assets/models/face_mask/Mask1.obj';
const FACEMASK_MODEL_PATH_STYLE2 = '../../assets/models/face_mask/Mask2.obj';

class FaceMaskSystem {
  /**
   * Neutral slider values, before any per-style tuning is layered on top.
   * Every key here is a valid `setParam` target.
   */
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
      // Ear loops are tuned per side — the cords are not perfect mirrors in
      // the source assets, and a morphed face pushes them further apart.
      // "left" is the subject's left, i.e. the -X cheek, matching the
      // eye_left / jaw_angle_left convention in OBJMorpher.LANDMARKS.
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

    // Scene group — HeadTracker.js looks for this.maskGroup by name to
    // reparent into the head-tracking pivot, matching GlassesSystem.
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

    // User fine-tune sliders — seeded from the active style's defaults at the
    // end of this constructor.
    this.params = FaceMaskSystem.BASE_PARAMS;

    // Body meshes drive the fit bbox; strap meshes only ride along.
    this._bodyMeshes = [];
    this._strapMeshes = [];

    // Style configs. `defaults` are applied by setStyle().
    this.maskModels = {
      mask1: {
        file: FACEMASK_MODEL_PATH_STYLE1,
        label: 'Cloth Mask',
        // posY lift: this model's top edge dips hard at the midline (its bbox
        // top comes from the flared cheek corners), so a neutral fit leaves the
        // nose uncovered. +10 puts the nose-bridge edge back over the nose.
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
        // Hand-tuned against the neutral head. The landmark fit gets the mask
        // close, but this model's cords are not perfect mirrors of each other
        // in the source asset, so the two ear loops need slightly different
        // lengths to both land on the ear.
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

    // Baseline landmark positions captured on first refresh — used so the fit
    // degrades gracefully if a landmark stops resolving mid-session.
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

    // Seed params/colours from the starting style's defaults. Without this the
    // tuned values only land once a style card is clicked, so simply ticking
    // "Show face mask" would render an untuned fit. Safe to call here: the
    // materials exist and setStyle only reaches generate() when enabled.
    this.setStyle(this.currentStyle);

    console.log('[FaceMaskSystem] Initialized');
  }

  /**
   * Full default state for a style, ready to hand to loadState(). Reset paths
   * use this so "reset" restores the tuned per-style fit rather than a flat
   * neutral pose that no style actually wants.
   */
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

  setHeadMesh(headGroup, regionData, morpher) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._morpher = morpher || null;
    this._initialNoseBridge = null;
    this._initialChin = null;
    this._initialJawSpan = null;
    this._captureBaselines();
  }

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

  /**
   * Called by app.js on every morph update so the mask tracks facial changes.
   */
  refreshFromMesh(morphValues) {
    if (morphValues) this._faceMorphValues = morphValues;
    if (this._container && this.enabled) {
      this._alignAndAdjust();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

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

  setMaskColor(hex) {
    this.maskColor = hex;
    this._maskMat.color.set(hex);
  }

  setStrapColor(hex) {
    this.strapColor = hex;
    this._strapMat.color.set(hex);
  }

  setOpacity(value) {
    this.opacity = Math.max(0, Math.min(100, value));
    const o = this.opacity / 100;
    for (const mat of [this._maskMat, this._strapMat]) {
      mat.opacity = o;
      mat.transparent = o < 0.999;
    }
  }

  setParam(param, value) {
    if (this.params[param] === undefined) return;
    this.params[param] = value;
    if (this._container && this.enabled) this._alignAndAdjust();
  }

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

  /** True when the current style actually has ear-loop geometry. */
  hasStraps() {
    return this._strapMeshes.length > 0;
  }

  // ── Generation ──────────────────────────────────────────────────────────

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

  /** Resolves once no mask model is mid-load. See AssetLoadTracker. */
  whenIdle() {
    return this._loads.whenIdle();
  }

  /**
   * Blender exports each sub-object as `o <name>`, which OBJLoader turns into
   * a mesh name. Mask2's ear cords come through as "...:cord..." / "...:cord1..."
   */
  _isStrapMesh(mesh) {
    return /cord|strap|loop|band|elastic|tie|string/i.test(mesh.name || '');
  }

  /**
   * Translate a strap's geometry so its attachment end sits at the local
   * origin, then offset mesh.position by that point. After this, mesh.scale.z
   * lengthens the loop backwards from the mask body and mesh.rotation swings
   * it around the attachment instead of around the model origin.
   *
   * `bodyCentreX` decides which cheek the strap belongs to — the raw model X
   * is not centred on the mask, so its sign alone would misclassify both.
   */
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

    // Degenerate model with only straps — treat everything as body so the fit
    // bbox is never empty, and leave the geometry alone. Pivoting would shift
    // it out from under the fit bbox, which reads geometry bounds directly.
    if (this._bodyMeshes.length === 0 && this._strapMeshes.length > 0) {
      this._bodyMeshes = this._strapMeshes.slice();
      this._strapMeshes = [];
    } else {
      // Second pass: pivot each strap at the point where it meets the mask
      // body (its front-most +Z end) so length and angle changes swing it
      // toward the ear instead of dragging it away from the model origin.
      // Needs the body centre, so it can only run once every mesh is
      // classified.
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

  _alignAndAdjust() {
    if (!this._container || !this._headGroup) return;

    const container = this._container;
    const offsetGroup = container.children[0];
    if (!offsetGroup) return;

    // Fit bbox is measured from the mask body only (straps would inflate both
    // the depth and the width and throw the whole placement off).
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

    // ── Vertical span the mask must cover ──
    // Top edge rides the nose bridge, bottom edge wraps just under the chin.
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

    // Morph-value driven refinement — landmark deltas cover most of it, these
    // sharpen the response during fast slider drags.
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

    // Vertical: centre of the covered span (the recentred bbox puts the body
    // centre at the container origin, so this lands the top edge on the bridge).
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

    // Ear loops run backwards along -Z from their attachment pivot, so scale.z
    // lengthens them and a rotation at the pivot re-aims the free end.
    //
    // Positive strapAngle lifts that end (rotation about X sends a point at
    // -Z to +Y). Positive strapSplay pushes it away from the face; rotation
    // about Y sends -Z toward -X, so the right-hand strap needs the opposite
    // sign for both loops to swing outward together.
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

  loadState(state) {
    if (!state) return;
    if (state.style && this.maskModels[state.style]) this.currentStyle = state.style;
    if (state.maskColor) this.setMaskColor(state.maskColor);
    if (state.strapColor) this.setStrapColor(state.strapColor);
    if (state.opacity !== undefined) this.setOpacity(state.opacity);
    for (const key of Object.keys(this.params)) {
      if (state[key] !== undefined) this.params[key] = state[key];
    }
    // Backward-compat: strap controls used to be a single value shared by both
    // ear loops. Fan an older save's value out to both sides.
    for (const base of ['strapScale', 'strapAngle', 'strapSplay']) {
      if (state[base] === undefined) continue;
      if (state[base + 'L'] === undefined) this.params[base + 'L'] = state[base];
      if (state[base + 'R'] === undefined) this.params[base + 'R'] = state[base];
    }
    // Force a clean rebuild so style/param changes from undo/redo are always
    // reflected — setEnabled skips generate() when a container already exists.
    this._container = null;
    this._fitCache = null;
    this.setEnabled(state.enabled === true);
  }

  /**
   * Apply AI-generated face mask block. Schema:
   *   { enabled, style, maskColor, strapColor, opacity }
   */
  applyFromAI(data) {
    if (!data) return;
    if (data.style && this.maskModels[data.style]) this.setStyle(data.style);
    if (data.maskColor) this.setMaskColor(data.maskColor);
    if (data.strapColor) this.setStrapColor(data.strapColor);
    if (data.opacity !== undefined) this.setOpacity(data.opacity);
    this.setEnabled(!!data.enabled);
  }

  /**
   * World-space transform of the mask container. Useful for future Blender
   * export pipelines that want to merge the mask into the head mesh.
   */
  getRenderTransform() {
    if (!this._container || !this.enabled) {
      return { matrix: null, params: { ...this.params }, enabled: this.enabled };
    }
    const c = this._container;
    const o = c.children[0];
    c.updateWorldMatrix(true, false);
    o?.updateWorldMatrix(true, false);
    return {
      matrix: Array.from((o ? o.matrixWorld : c.matrixWorld).elements),
      params: { ...this.params },
      enabled: this.enabled,
      style: this.currentStyle,
      maskColor: this.maskColor,
      strapColor: this.strapColor,
      opacity: this.opacity,
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  _clearGroup(group) {
    while (group.children.length > 0) {
      group.remove(group.children[0]);
    }
  }

  dispose() {
    this._clearGroup(this.maskGroup);
    this.scene.remove(this.maskGroup);
  }
}

window.FaceMaskSystem = FaceMaskSystem;
