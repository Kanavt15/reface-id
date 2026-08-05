/**
 * BandanaSystem.js – GLB-based paisley bandana worn over the lower face.
 *
 * Fits the wrap to the live post-morph head: width comes from the measured
 * skull, the top edge rides the nose bridge and the front clears the nose tip,
 * so the bandana tracks faceWidth / jawWidth / noseSize instead of sitting at a
 * fixed offset. Mirrors GlassesSystem and FaceMaskSystem — HeadTracker
 * reparents bandanaGroup into the pivot group, so head tracking needs no extra
 * wiring.
 *
 * Model-space notes for assets/accessories/bandana_mask.glb:
 *   - One mesh, 360 verts, and 3MB of embedded textures. Almost all of the
 *     look lives in those textures, so unlike the mask OBJs this cannot be
 *     rendered as a flat colour. GLBLoader drops materials and never touches
 *     the image bufferViews, so _loadEmbeddedTextures decodes them here.
 *   - Already Y-up with +Z forward, matching the scene: its two ancestor
 *     rotations (-90 then +90 about X) cancel to identity. No axis fix.
 *   - The geometry is a closed loop that encircles the head, with the folded
 *     triangle hanging at the front and two knot tails trailing at the back.
 *     That is why it is not a FaceMaskSystem style: that system fits a flat
 *     panel from its bounding box, and 2.0 of this model's 2.0-deep box is
 *     back tails, which would throw its depth placement badly off.
 */

// ── Asset path constants ────────────────────────────────────────────────────
// Update this path if the GLB is moved.
const BANDANA_MODEL_PATH = '../../assets/accessories/bandana_mask.glb';

class BandanaSystem {
  /**
   * Neutral slider values. Every key here is a valid `setParam` target.
   */
  static get BASE_PARAMS() {
    return {
      scale: 100,  // 50..200  — uniform fit
      width: 100,  // 50..150  — X-only, how tightly the loop hugs the skull
      // Z-only. The front face stays put when this changes: the depth solve
      // pins the cloth to the same clearance over the binding contact point
      // regardless of scaleZ, so this pulls the back of the loop and the knot
      // in toward the skull without disturbing the view from the front.
      depth: 100,  // 40..150
      // Bends the lower cloth forward, off the neck, tapering to nothing at
      // mid-height so the part already fitted over the nose and mouth does not
      // move. A transform cannot do this — it would carry the whole piece.
      hemFlare: 0, // -30..100
      posX: 0,     // -100..+100 — horizontal shift
      posY: 0,     // -100..+100 — vertical placement
      posZ: 0,     // -100..+100 — depth from the face
      rotX: 0,     // -180..180 deg — pitch
      rotY: 0,     // -180..180 deg — yaw
      rotZ: 0,     // -180..180 deg — roll
    };
  }

  constructor(scene) {
    this.scene = scene;

    // Scene group — HeadTracker.js looks for this.bandanaGroup by name to
    // reparent into the head-tracking pivot, matching GlassesSystem.
    this.bandanaGroup = new THREE.Group();
    this.bandanaGroup.name = 'BandanaSystem';
    this.scene.add(this.bandanaGroup);

    // Head references (set by setHeadMesh)
    this._headGroup = null;
    this._regionData = null;
    this._morpher = null;
    this._faceMorphValues = null;

    // State
    this.enabled = false;
    this.currentStyle = 'paisley';
    // Multiplied over the base colour texture, so white leaves the artwork
    // untouched and anything else dyes the cloth.
    this.tint = '#ffffff';
    this.opacity = 100;

    this.params = BandanaSystem.BASE_PARAMS;

    this.bandanaModels = {
      paisley: {
        file: BANDANA_MODEL_PATH,
        label: 'Paisley',
        // Hand-tuned against the stock head, same role as FaceMaskSystem's
        // per-style defaults.
        defaults: {
          scale: 105, width: 84, depth: 74, hemFlare: 100,
          posX: 0, posY: 0, posZ: -38,
          rotX: 0, rotY: 0, rotZ: 0,
          tint: '#ffffff',
          opacity: 100,
        },
      },
    };

    // Caches
    this._modelCache = {};   // styleName -> THREE.Group
    this._loadId = 0;
    this._loads = new AssetLoadTracker('bandana');

    this._container = null;
    this._fitCache = null;

    // Baselines captured on first refresh so the fit degrades gracefully if a
    // landmark stops resolving mid-session.
    this._initialBridge = null;
    this._initialChin = null;
    this._initialHeadWidth = null;

    // Material. The map is attached once the GLB's textures decode; until then
    // it renders as plain cloth rather than failing.
    this._mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.tint),
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    this.setStyle(this.currentStyle);

    console.log('[BandanaSystem] Initialized');
  }

  /**
   * Full default state for a style, ready to hand to loadState().
   */
  getStyleDefaults(style) {
    const name = this.bandanaModels[style] ? style : 'paisley';
    const d = this.bandanaModels[name].defaults || {};
    return {
      enabled: false,
      style: name,
      tint: '#ffffff',
      opacity: 100,
      ...BandanaSystem.BASE_PARAMS,
      ...d,
    };
  }

  // ── Head binding ────────────────────────────────────────────────────────

  setHeadMesh(headGroup, regionData, morpher) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._morpher = morpher || null;
    this._initialBridge = null;
    this._initialChin = null;
    this._initialHeadWidth = null;
    this._captureBaselines();
  }

  _captureBaselines() {
    if (!this._morpher || typeof this._morpher.getCurrentLandmarkPosition !== 'function') return;
    const b = this._morpher.getCurrentLandmarkPosition('nose_bridge');
    if (b) this._initialBridge = new THREE.Vector3(b[0], b[1], b[2]);
    const m = this._measureFace();
    if (m) {
      this._initialChin = m.chinY;
      this._initialHeadWidth = m.width;
    }
  }

  /**
   * Measure the head directly: skull width, the true chin, and the nose tip.
   *
   * Two reasons this does not just read OBJMorpher.LANDMARKS. The `chin` entry
   * resolves to y = -0.606 on head.glb while the mesh's actual chin is at
   * -0.859 — a quarter of a unit high, which ends the drape above the mouth
   * and leaves the jaw bare. And the bandana encircles the whole head, so the
   * jaw-angle span FaceMaskSystem uses to size a flat panel is too narrow: the
   * loop has to clear the cheekbones and the back of the skull.
   *
   * `loY`/`hiY` bound the band the width is taken from; the chin and nose tip
   * are always measured over the whole head.
   */
  _measureFace(loY, hiY) {
    const group = this._headGroup;
    if (!group) return null;
    let maxAbsX = 0;
    let chinY = Infinity;
    let noseTipZ = -Infinity;
    let noseTipY = 0;
    let seen = 0;
    const v = new THREE.Vector3();

    // Front-surface profile: how far forward the face reaches at each height.
    // Used to push the cloth clear of the chin and lips — see _frontClearance.
    const BANDS = BandanaSystem.PROFILE_BANDS;
    const pLo = loY !== undefined ? loY : -1.2;
    const pHi = hiY !== undefined ? hiY : 0.6;
    const profile = new Float32Array(BANDS).fill(-Infinity);
    const pSpan = pHi - pLo;

    group.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      const pos = o.geometry.attributes.position;
      if (pos.count < 2000) return;   // skip accessory meshes; the head is far denser
      o.updateWorldMatrix(true, false);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        seen++;
        if (loY === undefined || (v.y >= loY && v.y <= hiY)) {
          const ax = Math.abs(v.x);
          if (ax > maxAbsX) maxAbsX = ax;
        }
        // Chin: the lowest point that is still well forward, so the neck and
        // the back of the head cannot win.
        if (v.z > 0.6 && v.y < chinY) chinY = v.y;
        if (v.z > noseTipZ) { noseTipZ = v.z; noseTipY = v.y; }

        // Only the front half matters, and only near the midline: the cloth
        // spans across the face, so a cheekbone out at the side should not
        // decide how far forward it sits.
        if (v.z > 0 && Math.abs(v.x) < BandanaSystem.PROFILE_HALF_WIDTH && pSpan > 1e-6) {
          const b = Math.floor((v.y - pLo) / pSpan * BANDS);
          if (b >= 0 && b < BANDS && v.z > profile[b]) profile[b] = v.z;
        }
      }
    });

    if (!seen) return null;
    return {
      width: maxAbsX > 1e-4 ? maxAbsX * 2 : null,
      chinY: isFinite(chinY) ? chinY : null,
      noseTipZ: isFinite(noseTipZ) ? noseTipZ : null,
      noseTipY: isFinite(noseTipZ) ? noseTipY : null,
      profile, profileLo: pLo, profileHi: pHi,
    };
  }

  /** Number of height bands used for both front-surface profiles. */
  static get PROFILE_BANDS() { return 24; }

  /**
   * Half-width of the midline strip both front profiles are sampled over.
   *
   * Both sides must use the same strip in world units. Sampling the cloth
   * wider than the face pulls its profile down — out at the cheeks the wrap
   * has already curved backwards — which reads as a collision and pushes the
   * whole bandana forward off the face.
   */
  static get PROFILE_HALF_WIDTH() { return 0.35; }

  /**
   * The cloth's half of that strip, as a fraction of model width.
   *
   * Expressed in model space rather than world so the set of vertices tested
   * never changes with scale. 0.21 of this model's width lands on roughly the
   * same real-world strip as PROFILE_HALF_WIDTH at the tuned fit.
   */
  static get PROFILE_MODEL_FRACTION() { return 0.21; }

  /**
   * Bend the bottom of the cloth forward, off the neck.
   *
   * The model's triangle hangs almost straight down, so once the wrap is
   * fitted the point buries itself in the throat. Rotating or shifting the
   * whole piece would drag the nose and mouth coverage with it, so this shears
   * the geometry instead: every vertex below the halfway line moves forward in
   * proportion to how far down it is, which leaves the fitted upper half
   * untouched and lets the hem stand off like real cloth.
   *
   * Runs on each fit, which is free here — the mesh is 360 vertices.
   *
   * Normals are corrected analytically rather than recomputed. The shear
   * z' = z + k(p - y) has a constant Jacobian in the affected region, so the
   * inverse transpose is just n_y += k * n_z. That keeps the authored smooth
   * normals intact instead of replacing them with averaged face normals.
   */
  _applyHemFlare(offsetGroup, minY, pivotY) {
    const amount = (this.params.hemFlare || 0) / 100 * BandanaSystem.HEM_FLARE_RANGE;
    const drop = pivotY - minY;
    if (!(drop > 1e-6)) return;
    const k = amount / drop;

    offsetGroup.traverse(m => {
      if (!m.isMesh || !m.userData.basePos) return;
      const pos = m.geometry.attributes.position;
      const base = m.userData.basePos;
      const nrm = m.geometry.attributes.normal;
      const baseN = m.userData.baseNrm;

      for (let i = 0; i < pos.count; i++) {
        const y = base[i * 3 + 1];
        const t = y >= pivotY ? 0 : Math.min(1, (pivotY - y) / drop);
        pos.array[i * 3] = base[i * 3];
        pos.array[i * 3 + 1] = y;
        pos.array[i * 3 + 2] = base[i * 3 + 2] + amount * t;

        if (nrm && baseN) {
          if (t > 0 && t < 1) {
            const nx = baseN[i * 3], ny = baseN[i * 3 + 1] + k * baseN[i * 3 + 2], nz = baseN[i * 3 + 2];
            const len = Math.hypot(nx, ny, nz) || 1;
            nrm.array[i * 3] = nx / len;
            nrm.array[i * 3 + 1] = ny / len;
            nrm.array[i * 3 + 2] = nz / len;
          } else {
            nrm.array[i * 3] = baseN[i * 3];
            nrm.array[i * 3 + 1] = baseN[i * 3 + 1];
            nrm.array[i * 3 + 2] = baseN[i * 3 + 2];
          }
        }
      }
      pos.needsUpdate = true;
      if (nrm && baseN) nrm.needsUpdate = true;
    });
  }

  /** Model-space Z the hem moves at hemFlare = 100. */
  static get HEM_FLARE_RANGE() { return 0.35; }

  /**
   * How far forward the cloth has to sit to stay off the face.
   *
   * Aligning the model's foremost point to the nose tip is not enough: the
   * model's surface falls away going down faster than this head's does, so the
   * lips and chin punch straight through and the render shows bare skin in an
   * arch over the mouth. Comparing the two front profiles band by band and
   * taking the worst case pushes the cloth just clear everywhere, and keeps
   * doing so when a morph changes the jaw.
   *
   * Returns the container Z that satisfies every band.
   */
  _frontClearance(offsetGroup, headProfile, pLo, pHi, modelHalfWidth, scaleY, scaleZ, centreY, clearance) {
    const BANDS = BandanaSystem.PROFILE_BANDS;
    const headSpan = pHi - pLo;
    if (!(headSpan > 1e-6) || !(scaleY > 1e-9)) return -Infinity;

    // Build the cloth's profile in the head's own world bands, so the two are
    // directly comparable. Cheap: this mesh is a few hundred vertices, and it
    // has to happen here rather than in the fit cache because the midline
    // strip is only meaningful once the scale is known.
    // Read the head's profile at any height, interpolating between band
    // centres.
    //
    // Binning the *cloth* into these same bands is what made scale jitter the
    // depth: as scaleY changes, vertices migrate across band boundaries, the
    // winning band flips, and the solved Z lurches by over 0.1 for a one-unit
    // scale step — non-monotonically, so it looked random. Testing each vertex
    // against an interpolated head height instead keeps the constraint set
    // fixed and every term continuous, so the result moves smoothly.
    const headZAt = (y) => {
      const f = (y - pLo) / headSpan * BANDS - 0.5;   // band centres sit at i+0.5
      const i0 = Math.floor(f);
      if (i0 < 0) return headProfile[0];
      if (i0 + 1 >= BANDS) return headProfile[BANDS - 1];
      const a = headProfile[i0], b = headProfile[i0 + 1];
      if (!isFinite(a) || !isFinite(b)) return NaN;
      return a + (b - a) * (f - i0);
    };

    // Sampled from the pristine baseline, not the live attribute, so the hem
    // flare cannot feed back into the depth solve. Otherwise flaring the hem
    // would relieve whichever point was binding and let the whole bandana
    // slide back toward the face — moving the nose and mouth fit the flare is
    // supposed to leave alone.
    let need = -Infinity;
    offsetGroup.traverse(m => {
      if (!m.isMesh) return;
      const pos = m.geometry.attributes.position;
      const base = m.userData.basePos;
      for (let i = 0; i < pos.count; i++) {
        const x = base ? base[i * 3] : pos.getX(i);
        const y = base ? base[i * 3 + 1] : pos.getY(i);
        const z = base ? base[i * 3 + 2] : pos.getZ(i);
        if (z <= 0) continue;
        // Model-space, deliberately: testing the scaled X would let vertices
        // drift out of the strip as the piece grows, dropping whichever one
        // was binding and lurching the depth. A fixed set keeps it continuous.
        if (Math.abs(x) > modelHalfWidth) continue;
        const headZ = headZAt(centreY + y * scaleY);
        if (!isFinite(headZ)) continue;
        const required = headZ + clearance - z * scaleZ;
        if (required > need) need = required;
      }
    });
    return need;
  }

  /**
   * Called by app.js on every morph update so the wrap tracks facial changes.
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
        this.bandanaGroup.visible = true;
        this._alignAndAdjust();
      }
    } else {
      this.bandanaGroup.visible = false;
    }
  }

  setStyle(style) {
    const config = this.bandanaModels[style];
    if (!config) {
      console.warn('[BandanaSystem] Unknown style:', style);
      return;
    }
    this.currentStyle = style;

    const d = config.defaults;
    if (d) {
      for (const key of Object.keys(this.params)) {
        if (d[key] !== undefined) this.params[key] = d[key];
      }
      if (d.tint) this.setTint(d.tint);
      if (d.opacity !== undefined) this.setOpacity(d.opacity);
    }

    if (this.enabled) this.generate();
  }

  /** Multiplied over the base colour texture; white leaves the print as authored. */
  setTint(hex) {
    this.tint = hex;
    this._mat.color.set(hex);
  }

  setOpacity(value) {
    this.opacity = Math.max(0, Math.min(100, value));
    const o = this.opacity / 100;
    this._mat.opacity = o;
    this._mat.transparent = o < 0.999;
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
      tint: this.tint,
      opacity: this.opacity,
    };
  }

  // ── Texture decoding ────────────────────────────────────────────────────

  /**
   * Pull the base colour, normal and metallic-roughness maps out of the GLB.
   *
   * GLBLoader hands back geometry only: it ignores glTF materials and never
   * looks at the image bufferViews. This asset is 360 vertices and 3MB of
   * texture, so without this the bandana renders as a blank sheet and loses
   * the entire paisley print.
   *
   * Applied asynchronously — the mesh shows in plain cloth for the frame or
   * two the decode takes, rather than blocking the fit.
   */
  _loadEmbeddedTextures(buffer) {
    try {
      const dv = new DataView(buffer);
      const jsonLen = dv.getUint32(12, true);
      const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
      const binStart = 20 + jsonLen + 8;   // JSON chunk, then the BIN chunk header

      const material = (gltf.materials || [])[0];
      if (!material) return;
      const pbr = material.pbrMetallicRoughness || {};

      const imageIndexOf = (texRef) => {
        if (!texRef || texRef.index === undefined) return -1;
        const tex = (gltf.textures || [])[texRef.index];
        return tex && tex.source !== undefined ? tex.source : -1;
      };

      const decode = (imgIdx, srgb) => {
        if (imgIdx < 0) return Promise.resolve(null);
        const img = (gltf.images || [])[imgIdx];
        if (!img || img.bufferView === undefined) return Promise.resolve(null);
        const bv = gltf.bufferViews[img.bufferView];
        const start = binStart + (bv.byteOffset || 0);
        const blob = new Blob([new Uint8Array(buffer, start, bv.byteLength)],
                              { type: img.mimeType || 'image/png' });
        return createImageBitmap(blob).then(bitmap => {
          const t = new THREE.Texture(bitmap);
          // glTF UVs put the origin at the top-left, the opposite of three's
          // default, so the flip has to be off or the print lands upside down.
          t.flipY = false;
          t.wrapS = THREE.RepeatWrapping;
          t.wrapT = THREE.RepeatWrapping;
          if (srgb) t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          t.needsUpdate = true;
          return t;
        });
      };

      const jobs = [
        decode(imageIndexOf(pbr.baseColorTexture), true).then(t => {
          if (!t) return;
          this._mat.map = t;
          // The texture carries the colour, so the material tint must start
          // neutral or it would double-darken the print.
          this._mat.needsUpdate = true;
        }),
        decode(imageIndexOf(material.normalTexture), false).then(t => {
          if (!t) return;
          this._mat.normalMap = t;
          this._mat.needsUpdate = true;
        }),
        decode(imageIndexOf(pbr.metallicRoughnessTexture), false).then(t => {
          if (!t) return;
          // glTF packs roughness in G and metalness in B of one image; three
          // reads the right channel from each slot when both point at it.
          this._mat.roughnessMap = t;
          this._mat.metalnessMap = t;
          this._mat.roughness = 1.0;
          this._mat.metalness = 1.0;
          this._mat.needsUpdate = true;
        }),
      ];

      Promise.all(jobs).catch(e => console.warn('[BandanaSystem] Texture decode failed:', e));
    } catch (e) {
      console.warn('[BandanaSystem] Could not read embedded textures:', e);
    }
  }

  /**
   * Accumulate each mesh's world matrix down the glTF node tree.
   *
   * This asset's transforms live on ancestors, not on the mesh node, so a flat
   * reader would miss them. They happen to cancel to identity here, but the
   * walk keeps that a measured fact rather than an assumption.
   */
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
        if (n.matrix) {
          m.fromArray(n.matrix);
        } else {
          const t = n.translation || [0, 0, 0];
          const r = n.rotation || [0, 0, 0, 1];
          const s = n.scale || [1, 1, 1];
          m.compose(
            new THREE.Vector3(t[0], t[1], t[2]),
            new THREE.Quaternion(r[0], r[1], r[2], r[3]),
            new THREE.Vector3(s[0], s[1], s[2]),
          );
        }
        return m;
      };

      const seen = new Set();
      const walk = (idx, parentMatrix) => {
        if (seen.has(idx)) return;
        seen.add(idx);
        const n = nodes[idx];
        if (!n) return;
        const world = new THREE.Matrix4().multiplyMatrices(parentMatrix, localMatrix(n));
        if (typeof n.mesh === 'number') {
          const meshName = meshes[n.mesh]?.name;
          if (meshName && !out[meshName]) out[meshName] = world.clone();
        }
        for (const child of n.children || []) walk(child, world);
      };

      const sceneDef = (gltf.scenes || [])[gltf.scene ?? 0];
      const roots = sceneDef?.nodes || nodes.map((_, i) => i);
      const identity = new THREE.Matrix4();
      for (const r of roots) walk(r, identity);
      return out;
    } catch (e) {
      console.warn('[BandanaSystem] Could not read node transforms:', e);
      return {};
    }
  }

  // ── Generation ──────────────────────────────────────────────────────────

  generate() {
    this._clearGroup(this.bandanaGroup);
    this._container = null;
    this._fitCache = null;

    if (!this.enabled) return;

    const config = this.bandanaModels[this.currentStyle];
    if (!config || !config.file) return;

    this._loadId++;
    const thisLoadId = this._loadId;

    if (this._modelCache[this.currentStyle]) {
      this._showCached(this.currentStyle);
      return;
    }

    this._loads.begin();
    fetch(config.file)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${config.file}`);
        return r.arrayBuffer();
      })
      .then(buffer => {
        if (this._loadId !== thisLoadId) return;

        const loader = new THREE.GLBLoader();
        const group = loader.parse(buffer);
        const worldXforms = this._readWorldTransforms(buffer);

        // No axis fix: this GLB is already Y-up with +Z forward.
        const baked = new THREE.Group();
        baked.name = 'BandanaGLB';
        group.traverse(child => {
          if (!child.isMesh) return;
          const mesh = child.clone();
          mesh.geometry = child.geometry.clone();
          const m = worldXforms[child.name];
          if (m) mesh.geometry.applyMatrix4(m);
          baked.add(mesh);
        });

        this._loadEmbeddedTextures(buffer);

        this._modelCache[this.currentStyle] = baked;
        this._showCached(this.currentStyle);
      })
      .catch(err => {
        console.error('[BandanaSystem] Failed to load model:', config.file, err);
      })
      .finally(() => this._loads.end());
  }

  /** Resolves once no bandana model is mid-load. See AssetLoadTracker. */
  whenIdle() {
    return this._loads.whenIdle();
  }

  _showCached(style) {
    this._clearGroup(this.bandanaGroup);
    const cached = this._modelCache[style];
    if (!cached) return;

    const container = new THREE.Group();
    container.name = 'BandanaContainer';
    const offsetGroup = new THREE.Group();
    offsetGroup.name = 'BandanaOffset';

    cached.traverse(child => {
      if (!child.isMesh) return;
      const mesh = child.clone();
      // The hem flare rewrites vertices, so this instance needs its own copy
      // and a pristine baseline to re-derive from each time the slider moves.
      mesh.geometry = child.geometry.clone();
      const pos = mesh.geometry.attributes.position;
      const nrm = mesh.geometry.attributes.normal;
      mesh.userData.basePos = new Float32Array(pos.array);
      if (nrm) mesh.userData.baseNrm = new Float32Array(nrm.array);
      mesh.material = this._mat;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      offsetGroup.add(mesh);
    });

    container.add(offsetGroup);
    this.bandanaGroup.add(container);
    this._container = container;
    this._fitCache = null;
    this.bandanaGroup.visible = this.enabled;

    this._alignAndAdjust();
  }

  _alignAndAdjust() {
    if (!this._container || !this._headGroup) return;

    const container = this._container;
    const offsetGroup = container.children[0];
    if (!offsetGroup) return;

    // Measure the raw model once, with the container reset so the numbers are
    // model-space rather than whatever the last fit left behind.
    if (!this._fitCache) {
      container.scale.set(1, 1, 1);
      container.position.set(0, 0, 0);
      container.rotation.set(0, 0, 0);
      offsetGroup.position.set(0, 0, 0);

      const box = new THREE.Box3();
      offsetGroup.traverse(m => {
        if (!m.isMesh) return;
        m.geometry.computeBoundingBox();
        box.union(m.geometry.boundingBox);
      });
      if (box.isEmpty()) return;

      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);
      if (size.x < 0.0001 || size.y < 0.0001) return;

      this._fitCache = { center, size, max: box.max.clone(), min: box.min.clone() };
      offsetGroup.position.set(-center.x, -center.y, -center.z);
    }

    const { size, center, max } = this._fitCache;

    // ── Live measurement of the current post-morph head ──
    // The chin and nose tip come off the mesh; only the brow line still uses a
    // landmark, because `nose_bridge` does land where it should and there is no
    // clean geometric extremum for it.
    let bridgeY = this._initialBridge ? this._initialBridge.y : null;
    if (this._morpher && typeof this._morpher.getCurrentLandmarkPosition === 'function') {
      const b = this._morpher.getCurrentLandmarkPosition('nose_bridge');
      if (b) {
        bridgeY = b[1];
        if (!this._initialBridge) this._initialBridge = new THREE.Vector3(b[0], b[1], b[2]);
      }
    }

    const measured = this._measureFace(
      this._initialChin !== null ? this._initialChin : -0.9,
      bridgeY !== null ? bridgeY : 0.2,
    );

    let chinY = measured && measured.chinY !== null ? measured.chinY : this._initialChin;
    let noseTipZ = measured && measured.noseTipZ !== null ? measured.noseTipZ : null;
    let noseTipY = measured && measured.noseTipY !== null ? measured.noseTipY : null;
    let headWidth = (measured && measured.width) || this._initialHeadWidth;

    if (chinY !== null && chinY !== undefined) this._initialChin = chinY;
    if (headWidth) this._initialHeadWidth = headWidth;

    // Fallbacks measured off the stock head.glb.
    if (chinY === null || chinY === undefined) chinY = -0.86;
    if (noseTipZ === null) noseTipZ = 1.30;
    if (noseTipY === null) noseTipY = 0.02;
    if (!headWidth) headWidth = 1.77;
    // Without a bridge landmark, put the brow line a fifth of the face above
    // the nose tip, which is roughly where it sits on the stock head.
    if (bridgeY === null) bridgeY = noseTipY + (noseTipY - chinY) * 0.20;

    // ── Scale ──
    // Width and height are fitted independently, as FaceMaskSystem does.
    //
    // The model's own proportions do not match this head: fitted uniformly to
    // the skull it wraps correctly but its triangle hangs to the base of the
    // neck, and fitted uniformly to the face it stops at the chin but bites
    // into the cheeks. Horizontal follows the skull so the loop clears it, and
    // vertical follows the brow-to-chin span so the point lands where a worn
    // bandana would.
    const WRAP_SLACK = 1.06;
    const userScale = this.params.scale / 100;
    const userWidth = this.params.width / 100;
    const userDepth = this.params.depth / 100;

    const DEG = Math.PI / 180;
    const span = Math.max(0.05, bridgeY - chinY);

    // Morph-driven refinement — measured deltas cover most of it, these sharpen
    // the response during fast slider drags.
    const mv = this._faceMorphValues || (this._morpher ? this._morpher.morphValues : null) || {};
    const neutral = 50;
    const t = (key) => ((mv[key] ?? neutral) - neutral) / 50;   // -1..+1
    const morphWidth = 1.0 + t('faceWidth') * 0.06 + t('jawWidth') * 0.04;

    // Top edge sits on the nose bridge, bottom edge tucks under the chin.
    const BROW_LIFT = 0.0;
    const CHIN_WRAP = 0.10;
    const targetTopY = bridgeY + span * BROW_LIFT;
    const targetBottomY = chinY - span * CHIN_WRAP;
    const targetHeight = Math.max(0.05, targetTopY - targetBottomY);

    const wrap = (headWidth * WRAP_SLACK) / size.x;
    const scaleY = (targetHeight / size.y) * userScale;
    const scaleZ = wrap * userScale * userDepth;
    const scaleX = wrap * userScale * userWidth * morphWidth;

    container.scale.set(scaleX, scaleY, scaleZ);

    // ── Placement ──
    // Anchor by the model's own edges rather than its bbox centre: the centre
    // sits far back because the box includes the knot tails, so aligning the
    // top edge to the brow and the front edge to the nose is what actually
    // lands the cloth on the face.
    const userPosX = this.params.posX * 0.01;
    const userPosY = this.params.posY * 0.01;
    const userPosZ = this.params.posZ * 0.01;

    const halfHeight = (size.y * scaleY) * 0.5;
    // offsetGroup already recentred the geometry, so the container origin is
    // the bbox centre; place that so the top edge lands on target.
    const centreY = targetTopY - halfHeight;

    // Depth: far enough forward that no part of the face pokes through.
    // The nose-tip alignment is the floor; the profile sweep usually asks for
    // more, because the chin and lips sit proud of where this model's surface
    // would otherwise fall.
    // Purely additive: the fit cache measures the pristine mesh and the depth
    // solve samples the pristine baseline, so flaring the hem never rescales
    // or repositions the piece — only the lower cloth moves.
    // Vertices stay in raw model space — the recentring lives on
    // offsetGroup.position — so the bounds passed here are model-space too.
    this._applyHemFlare(offsetGroup, this._fitCache.min.y, center.y);

    // 0.075 rather than a hair's breadth: the profiles are sampled into 24
    // bands, so the true worst contact usually falls between two band centres
    // and the sweep under-reads it by ~0.04. Calibrated so the measured
    // closest approach lands a little clear of the skin rather than on it.
    const FACE_CLEARANCE = 0.075;
    const frontFromCentre = (max.z - center.z) * scaleZ;
    let centreZ = noseTipZ + FACE_CLEARANCE - frontFromCentre;

    if (measured && measured.profile) {
      const swept = this._frontClearance(
        offsetGroup, measured.profile, measured.profileLo, measured.profileHi,
        size.x * BandanaSystem.PROFILE_MODEL_FRACTION,
        scaleY, scaleZ, centreY, FACE_CLEARANCE,
      );
      if (isFinite(swept) && swept > centreZ) centreZ = swept;
    }

    container.position.set(
      userPosX,
      centreY + userPosY,
      centreZ + userPosZ,
    );
    container.rotation.set(
      this.params.rotX * DEG,
      this.params.rotY * DEG,
      this.params.rotZ * DEG,
    );
  }

  // ── State / persistence ─────────────────────────────────────────────────

  exportState() {
    return {
      ...this.params,
      enabled: this.enabled,
      style: this.currentStyle,
      tint: this.tint,
      opacity: this.opacity,
    };
  }

  loadState(state) {
    if (!state) return;
    if (state.style && this.bandanaModels[state.style]) this.currentStyle = state.style;
    if (state.tint) this.setTint(state.tint);
    if (state.opacity !== undefined) this.setOpacity(state.opacity);
    for (const key of Object.keys(this.params)) {
      if (state[key] !== undefined) this.params[key] = state[key];
    }
    // Force a clean rebuild so style/param changes from undo/redo are always
    // reflected — setEnabled skips generate() when a container already exists.
    this._container = null;
    this._fitCache = null;
    this.setEnabled(state.enabled === true);
  }

  /**
   * Apply AI-generated bandana block. Schema:
   *   { enabled, style, tint, opacity }
   */
  applyFromAI(data) {
    if (!data) return;
    if (data.style && this.bandanaModels[data.style]) this.setStyle(data.style);
    if (data.tint) this.setTint(data.tint);
    if (data.opacity !== undefined) this.setOpacity(data.opacity);
    this.setEnabled(!!data.enabled);
  }

  /**
   * World-space transform of the container, for future Blender export
   * pipelines that want to merge the bandana into the head mesh.
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
      tint: this.tint,
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
    this._clearGroup(this.bandanaGroup);
    this.scene.remove(this.bandanaGroup);
    for (const k of ['map', 'normalMap', 'roughnessMap']) {
      if (this._mat[k]) this._mat[k].dispose();
    }
    this._mat.dispose();
  }
}

window.BandanaSystem = BandanaSystem;
