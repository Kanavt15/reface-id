// Fits a small ring through each eyebrow, centred on the brow and angled outward like a real piercing.

// Asset path
const BROW_RING_MODEL_PATH = '../../assets/accessories/eyebrow_ring.glb';

class EyebrowPiercingSystem {
  // Default fit values for the rings.
  static get BASE_PARAMS() {
    return {
      size: 100,      // 40..200 — diameter, relative to the measured brow
      alongBrow: 92,  // 0..100 — 0 = inner end of the brow, 100 = outer end
      posX: 2,        // -100..+100 — outward / inward from the skin
      posY: 35,       // -100..+100 — up / down
      posZ: 0,        // -100..+100 — forward / back
      // Per side but identical by default so the rings match; "left" is the subject's left brow.
      yawL: 27, yawR: 27,       // 0..90 deg — ring plane, 0 = side-on, 90 = flat-on
      spinL: 110, spinR: 110,   // -180..180 deg — rolls the opening around the ring
    };
  }

  constructor(sceneManager) {
    this.sceneManager = sceneManager && sceneManager.scene ? sceneManager : null;
    this.scene = this.sceneManager ? this.sceneManager.scene : sceneManager;

    this.browPiercingGroup = new THREE.Group();
    this.browPiercingGroup.name = 'EyebrowPiercingSystem';
    this.scene.add(this.browPiercingGroup);

    this._headGroup = null;
    this._regionData = null;
    this._morpher = null;
    this._faceMorphValues = null;

    this.enabled = false;
    this.sideMode = 'both';        // 'both' | 'left' | 'right'
    this.metalColor = '#c8cdd2';   // brow jewellery is usually steel, not gold
    this.polish = 88;

    this.params = { ...EyebrowPiercingSystem.BASE_PARAMS };

    this._unitGeometries = null;
    this._hoopCentre = new THREE.Vector3();
    this._loadPromise = null;
    this._loads = new AssetLoadTracker('browPiercing');
    this._loadId = 0;
    this._sides = { left: null, right: null };

    this._initialBrow = { left: null, right: null };
    this._initialBrowSpan = null;

    this._metalMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.metalColor),
      metalness: 1.0,
      roughness: this._polishToRoughness(this.polish),
      envMapIntensity: 1.25,
      side: THREE.FrontSide,
    });
    this._envMap = this._buildEnvMap();
    if (this._envMap) this._metalMat.envMap = this._envMap;

    console.log('[EyebrowPiercingSystem] Initialized');
  }

  // Returns the default piercing settings.
  getDefaults() {
    return {
      enabled: false,
      sideMode: 'both',
      metalColor: '#c8cdd2',
      polish: 88,
      ...EyebrowPiercingSystem.BASE_PARAMS,
    };
  }

  // ── Head binding ────────────────────────────────────────────────────────

  // Connects the piercing to the head mesh and morpher.
  setHeadMesh(headGroup, regionData, morpher) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._morpher = morpher || null;
    this._initialBrow = { left: null, right: null };
    this._initialBrowSpan = null;
    this._sampleBrow();
  }

  // Reads the inner, centre and outer brow points for both sides from the landmarks.
  _sampleBrow() {
    if (!this._morpher || typeof this._morpher.getCurrentLandmarkPosition !== 'function') return null;
    const read = (name) => {
      const p = this._morpher.getCurrentLandmarkPosition(name);
      return p ? new THREE.Vector3(p[0], p[1], p[2]) : null;
    };
    const out = {};
    for (const side of ['left', 'right']) {
      const inner = read(`brow_${side}_inner`);
      const centre = read(`brow_${side}_center`);
      const outer = read(`brow_${side}_outer`);
      if (!centre || !outer) continue;
      out[side] = { inner: inner || centre, centre, outer };
      this._initialBrow[side] = out[side];
    }
    const l = out.left, r = out.right;
    if (l && r) this._initialBrowSpan = Math.abs(r.centre.x - l.centre.x);
    return out;
  }

  // Finds how far forward the skin is near a point on the brow, so the ring sits on the surface.
  _skinFrontAt(x, y, radius) {
    const group = this._headGroup;
    if (!group) return null;
    let maxZ = -Infinity;
    const v = new THREE.Vector3();
    group.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      const pos = o.geometry.attributes.position;
      if (pos.count < 2000) return;   // head only; brows and lashes are separate meshes
      o.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        if (Math.abs(v.x - x) > radius || Math.abs(v.y - y) > radius) continue;
        if (v.z > maxZ) maxZ = v.z;
      }
    });
    return isFinite(maxZ) ? maxZ : null;
  }

  // Refits the rings after a face change.
  refreshFromMesh(morphValues) {
    if (morphValues) this._faceMorphValues = morphValues;
    if (this.enabled && (this._sides.left || this._sides.right)) this._alignAndAdjust();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  // Shows or hides the rings, loading them on first use.
  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.enabled) {
      if (!this._sides.left && !this._sides.right) {
        this.generate();
      } else {
        this.browPiercingGroup.visible = true;
        this._applySideVisibility();
        this._alignAndAdjust();
      }
    } else {
      this.browPiercingGroup.visible = false;
    }
  }

  // Chooses whether to show the left ring, the right ring or both.
  setSideMode(mode) {
    if (!['both', 'left', 'right'].includes(mode)) return;
    this.sideMode = mode;
    this._applySideVisibility();
  }

  // Sets the metal colour.
  setMetalColor(hex) {
    this.metalColor = hex;
    this._metalMat.color.set(hex);
  }

  // Sets how polished the metal looks.
  setPolish(value) {
    this.polish = Math.max(0, Math.min(100, value));
    this._metalMat.roughness = this._polishToRoughness(this.polish);
  }

  // Converts the polish value (0-100) into material roughness.
  _polishToRoughness(polish) {
    return 0.04 + (1 - Math.max(0, Math.min(100, polish)) / 100) * 0.66;
  }

  // Sets one fit value and refits the rings.
  setParam(param, value) {
    if (this.params[param] === undefined) return;
    this.params[param] = value;
    if (this.enabled) this._alignAndAdjust();
  }

  // Returns the current piercing settings.
  getParams() {
    return {
      ...this.params,
      enabled: this.enabled,
      sideMode: this.sideMode,
      metalColor: this.metalColor,
      polish: this.polish,
    };
  }

  // Environment map

  // Builds a small studio reflection map just for this metal, since metal looks black without one.
  _buildEnvMap() {
    const renderer = this.sceneManager && this.sceneManager.renderer;
    if (!renderer || typeof THREE.PMREMGenerator !== 'function') return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      const ramp = ctx.createLinearGradient(0, 0, 0, canvas.height);
      ramp.addColorStop(0.00, '#ffffff');
      ramp.addColorStop(0.42, '#c4ced9');
      ramp.addColorStop(0.52, '#6f757e');
      ramp.addColorStop(1.00, '#202329');
      ctx.fillStyle = ramp;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const [cx, cy, r] of [[64, 34, 44], [186, 46, 30]]) {
        const hl = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
        hl.addColorStop(0.0, 'rgba(255,255,255,1)');
        hl.addColorStop(1.0, 'rgba(255,255,255,0)');
        ctx.fillStyle = hl;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const rt = pmrem.fromEquirectangular(tex);
      pmrem.dispose();
      tex.dispose();
      return rt.texture;
    } catch (e) {
      console.warn('[EyebrowPiercingSystem] Env map build failed:', e);
      return null;
    }
  }

  // Model loading

  // Collects world transforms down the glTF node tree, since this model puts them on parent nodes.
  _readWorldTransforms(buffer) {
    try {
      const dv = new DataView(buffer);
      const jsonLen = dv.getUint32(12, true);
      const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
      const nodes = gltf.nodes || [];
      const meshes = gltf.meshes || [];
      const out = {};
      const localMatrix = (n) => {
        const m = new THREE.Matrix4();
        if (n.matrix) { m.fromArray(n.matrix); return m; }
        const t = n.translation || [0, 0, 0];
        const r = n.rotation || [0, 0, 0, 1];
        const s = n.scale || [1, 1, 1];
        m.compose(new THREE.Vector3(t[0], t[1], t[2]),
                  new THREE.Quaternion(r[0], r[1], r[2], r[3]),
                  new THREE.Vector3(s[0], s[1], s[2]));
        return m;
      };
      const seen = new Set();
      const walk = (idx, parent) => {
        if (seen.has(idx)) return;
        seen.add(idx);
        const n = nodes[idx];
        if (!n) return;
        const world = new THREE.Matrix4().multiplyMatrices(parent, localMatrix(n));
        if (typeof n.mesh === 'number') {
          const name = meshes[n.mesh]?.name;
          if (name && !out[name]) out[name] = world.clone();
        }
        for (const c of n.children || []) walk(c, world);
      };
      const sceneDef = (gltf.scenes || [])[gltf.scene ?? 0];
      const roots = sceneDef?.nodes || nodes.map((_, i) => i);
      for (const r of roots) walk(r, new THREE.Matrix4());
      return out;
    } catch (e) {
      console.warn('[EyebrowPiercingSystem] Could not read node transforms:', e);
      return {};
    }
  }

  // Returns the combined bounding box of several geometries.
  _unionBox(geoms) {
    const box = new THREE.Box3();
    for (const g of geoms) { g.computeBoundingBox(); box.union(g.boundingBox); }
    return box;
  }

  // Turns the ring side-on and centres it on its middle, because a brow ring passes through the skin at its centre.
  _normalise(geoms) {
    if (!geoms.length) return geoms;

    let box = this._unionBox(geoms);
    const size = new THREE.Vector3();
    box.getSize(size);

    // Put the thinnest axis on X so the ring lies in the YZ plane.
    let orient = null;
    if (size.z <= size.x && size.z <= size.y) {
      orient = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    } else if (size.y <= size.x && size.y <= size.z) {
      orient = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    }
    if (orient) for (const g of geoms) g.applyMatrix4(orient);

    box = this._unionBox(geoms);
    box.getSize(size);
    const centre = new THREE.Vector3();
    box.getCenter(centre);
    for (const g of geoms) g.translate(-centre.x, -centre.y, -centre.z);

    const diameter = Math.max(size.y, size.z);
    if (diameter > 1e-6) {
      const s = 1 / diameter;
      const scale = new THREE.Matrix4().makeScale(s, s, s);
      for (const g of geoms) {
        g.applyMatrix4(scale);
        g.computeBoundingBox();
        g.computeBoundingSphere();
      }
    }
    return geoms;
  }

  // Loads the ring model once and caches its geometry.
  _loadModel() {
    if (this._unitGeometries) return Promise.resolve(this._unitGeometries);
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = fetch(BROW_RING_MODEL_PATH)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${BROW_RING_MODEL_PATH}`);
        return r.arrayBuffer();
      })
      .then(buffer => {
        const loader = new THREE.GLBLoader();
        const group = loader.parse(buffer);
        const worldXforms = this._readWorldTransforms(buffer);
        const geoms = [];
        group.traverse(child => {
          if (!child.isMesh || !child.geometry) return;
          const g = child.geometry.clone();
          const m = worldXforms[child.name];
          if (m) g.applyMatrix4(m);
          geoms.push(g);
        });
        if (!geoms.length) throw new Error('GLB contained no meshes');
        this._unitGeometries = this._normalise(geoms);
        return this._unitGeometries;
      })
      .catch(err => {
        console.error('[EyebrowPiercingSystem] Failed to load model:', BROW_RING_MODEL_PATH, err);
        this._loadPromise = null;
        return null;
      });

    return this._loadPromise;
  }

  // ── Generation ──────────────────────────────────────────────────────────

  // Builds a ring for each side of the face.
  generate() {
    this._clearGroup(this.browPiercingGroup);
    this._sides = { left: null, right: null };
    if (!this.enabled) return;

    this._loadId++;
    const thisLoadId = this._loadId;

    this._loads.begin();
    this._loadModel().then(unitGeoms => {
      if (this._loadId !== thisLoadId || !unitGeoms) return;

      for (const side of ['left', 'right']) {
        const container = new THREE.Group();
        container.name = `BrowRing_${side}`;

        // Nested groups so the ring's angle and the opening's position can be set separately.
        const yawGroup = new THREE.Group();
        yawGroup.name = 'BrowRingYaw';
        const spinGroup = new THREE.Group();
        spinGroup.name = 'BrowRingSpin';
        for (const g of unitGeoms) {
          const mesh = new THREE.Mesh(g, this._metalMat);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          spinGroup.add(mesh);
        }
        yawGroup.add(spinGroup);
        container.add(yawGroup);
        container.userData.yaw = yawGroup;
        container.userData.spin = spinGroup;

        this.browPiercingGroup.add(container);
        this._sides[side] = container;
      }

      this.browPiercingGroup.visible = this.enabled;
      this._applySideVisibility();
      this._alignAndAdjust();
    }).finally(() => this._loads.end());
  }

  // Resolves once the ring model has finished loading.
  whenIdle() {
    return this._loads.whenIdle();
  }

  // Shows or hides each side according to the side setting.
  _applySideVisibility() {
    const wantLeft = this.sideMode === 'both' || this.sideMode === 'left';
    const wantRight = this.sideMode === 'both' || this.sideMode === 'right';
    if (this._sides.left) this._sides.left.visible = wantLeft;
    if (this._sides.right) this._sides.right.visible = wantRight;
  }

  // Places each ring on the brow from the landmarks and applies the user's settings.
  _alignAndAdjust() {
    if (!this._sides.left && !this._sides.right) return;

    const live = this._sampleBrow() || {};
    const DEG = Math.PI / 180;

    // Scale from the brow span so the ring keeps its size relative to the face.
    let span = this._initialBrowSpan;
    const bl = live.left || this._initialBrow.left;
    const br = live.right || this._initialBrow.right;
    if (bl && br) span = Math.abs(br.centre.x - bl.centre.x);
    if (!span || span < 0.05) span = 0.60;

    const t = Math.max(0, Math.min(1, this.params.alongBrow / 100));
    // About 0.20 of the brow span gives a ring roughly 1cm across on the stock head.
    const diameter = span * 0.20 * (this.params.size / 100);
    const unit = span;

    for (const side of ['left', 'right']) {
      const container = this._sides[side];
      if (!container) continue;
      const brow = live[side] || this._initialBrow[side];
      if (!brow) continue;

      const isLeft = side === 'left';
      const outward = isLeft ? -1 : 1;
      const suffix = isLeft ? 'L' : 'R';

      // Slide between the inner and outer ends of the brow; brow rings usually sit in the outer third.
      const anchor = new THREE.Vector3().lerpVectors(brow.inner, brow.outer, t);

      // The brow landmarks sit below the rendered eyebrow, so lift the ring onto the brow.
      const BROW_LIFT = 0.10;
      const posY = anchor.y + BROW_LIFT * unit + this.params.posY * 0.0015 * unit;

      // Set the ring partly into the skin, since a piercing passes through it rather than resting on top.
      const skinZ = this._skinFrontAt(anchor.x, posY, diameter * 0.9);
      const baseZ = skinZ !== null ? skinZ : anchor.z;
      const EMBED = 0.405;   // fraction of the ring's diameter sunk behind the skin

      container.position.set(
        anchor.x + outward * this.params.posX * 0.0015 * unit,
        posY,
        baseZ - diameter * EMBED + this.params.posZ * 0.0015 * unit,
      );

      // Yaw angles the ring between side-on (0) and flat-on (90), mirrored for each side.
      const yaw = (this.params['yaw' + suffix] ?? 45) * DEG * outward;
      if (container.userData.yaw) container.userData.yaw.rotation.y = yaw;

      // Spin rolls the opening around the ring; it needs no flip between sides.
      const spin = (this.params['spin' + suffix] ?? 0) * DEG;
      if (container.userData.spin) container.userData.spin.rotation.x = spin;

      container.scale.setScalar(diameter);
    }
  }

  // ── State / persistence ─────────────────────────────────────────────────

  // Returns the piercing settings for saving.
  exportState() {
    return {
      ...this.params,
      enabled: this.enabled,
      sideMode: this.sideMode,
      metalColor: this.metalColor,
      polish: this.polish,
    };
  }

  // Restores piercing settings from a saved case.
  loadState(state) {
    if (!state) return;
    if (state.sideMode && ['both', 'left', 'right'].includes(state.sideMode)) {
      this.sideMode = state.sideMode;
    }
    if (state.metalColor) this.setMetalColor(state.metalColor);
    if (state.polish !== undefined) this.setPolish(state.polish);
    for (const key of Object.keys(this.params)) {
      if (state[key] !== undefined) this.params[key] = state[key];
    }
    this._sides = { left: null, right: null };
    this._clearGroup(this.browPiercingGroup);
    this.setEnabled(state.enabled === true);
  }

  // Applies piercing settings suggested by the AI.
  applyFromAI(data) {
    if (!data) return;
    if (data.sideMode) this.setSideMode(data.sideMode);
    if (data.metalColor) this.setMetalColor(data.metalColor);
    if (data.polish !== undefined) this.setPolish(data.polish);
    this.setEnabled(!!data.enabled);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  // Removes every child from a group.
  _clearGroup(group) {
    while (group.children.length > 0) group.remove(group.children[0]);
  }

  // Removes the rings from the scene and frees their materials.
  dispose() {
    this._clearGroup(this.browPiercingGroup);
    this.scene.remove(this.browPiercingGroup);
    if (this._envMap) this._envMap.dispose();
    this._metalMat.dispose();
  }
}

window.EyebrowPiercingSystem = EyebrowPiercingSystem;
