// Fits a paisley bandana around the lower face, sized from the measured skull, nose and chin so it follows face changes.

// Bandana model path; update this if the file moves.
const BANDANA_MODEL_PATH = '../../assets/accessories/bandana_mask.glb';

class BandanaSystem {
  // Neutral slider values.
  static get BASE_PARAMS() {
    return {
      scale: 100,  // 50..200  — uniform fit
      width: 100,  // 50..150  — X-only, how tightly the loop hugs the skull
      // Depth only pulls the back of the loop and the knot in; the front stays where it is.
      depth: 100,  // 40..150
      // Bends the lower cloth forward off the neck without moving the part over the nose and mouth.
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

    // HeadTracker looks for this.bandanaGroup by name to move it into the tracking pivot.
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
    // Multiplied over the print, so white leaves it unchanged.
    this.tint = '#ffffff';
    this.opacity = 100;

    this.params = BandanaSystem.BASE_PARAMS;

    this.bandanaModels = {
      paisley: {
        file: BANDANA_MODEL_PATH,
        label: 'Paisley',
        // Hand-tuned against the stock head.
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

    // Starting bridge position, used as a fallback if the landmark stops resolving.
    this._initialBridge = null;
    this._initialChin = null;
    this._initialHeadWidth = null;

    // Plain cloth until the model's own textures finish decoding.
    this._mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.tint),
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    this.setStyle(this.currentStyle);

    console.log('[BandanaSystem] Initialized');
  }

  // Returns a style's full default state.
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

  // Connects the bandana to the head mesh and morpher.
  setHeadMesh(headGroup, regionData, morpher) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._morpher = morpher || null;
    this._initialBridge = null;
    this._initialChin = null;
    this._initialHeadWidth = null;
    this._captureBaselines();
  }

  // Records the starting bridge position and face measurements.
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

  // Measures the skull width, the real chin and the nose tip from the mesh, since the landmark table's chin is too high.
  _measureFace(loY, hiY) {
    const group = this._headGroup;
    if (!group) return null;
    let maxAbsX = 0;
    let chinY = Infinity;
    let noseTipZ = -Infinity;
    let noseTipY = 0;
    let seen = 0;
    const v = new THREE.Vector3();

    // How far forward the face reaches at each height, used to keep the cloth off the chin and lips.
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
        // The chin is the lowest point that is still well forward.
        if (v.z > 0.6 && v.y < chinY) chinY = v.y;
        if (v.z > noseTipZ) { noseTipZ = v.z; noseTipY = v.y; }

        // Only the front, near the midline, decides how far forward the cloth sits.
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

  // Number of height bands used for the front-surface profiles.
  static get PROFILE_BANDS() { return 24; }

  // Half-width of the strip down the middle of the face that both profiles are sampled over.
  static get PROFILE_HALF_WIDTH() { return 0.35; }

  // The cloth's share of that strip, as a fraction of model width, so the tested vertices never change with scale.
  static get PROFILE_MODEL_FRACTION() { return 0.21; }

  // Bends the bottom of the cloth forward off the neck, leaving the fitted upper half untouched.
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

  // How far the hem moves forward at full flare, in model units.
  static get HEM_FLARE_RANGE() { return 0.35; }

  // Works out how far forward the cloth must sit so no part of the face pokes through.
  _frontClearance(offsetGroup, headProfile, pLo, pHi, modelHalfWidth, scaleY, scaleZ, centreY, clearance) {
    const BANDS = BandanaSystem.PROFILE_BANDS;
    const headSpan = pHi - pLo;
    if (!(headSpan > 1e-6) || !(scaleY > 1e-9)) return -Infinity;

    // Compare each cloth vertex with the head's height-interpolated profile, so the result changes smoothly with scale.
    const headZAt = (y) => {
      const f = (y - pLo) / headSpan * BANDS - 0.5;   // band centres sit at i+0.5
      const i0 = Math.floor(f);
      if (i0 < 0) return headProfile[0];
      if (i0 + 1 >= BANDS) return headProfile[BANDS - 1];
      const a = headProfile[i0], b = headProfile[i0 + 1];
      if (!isFinite(a) || !isFinite(b)) return NaN;
      return a + (b - a) * (f - i0);
    };

    // Use the untouched mesh so the hem flare can't change the depth fit.
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
        // Test in model space so the set of vertices checked stays fixed as the piece grows.
        if (Math.abs(x) > modelHalfWidth) continue;
        const headZ = headZAt(centreY + y * scaleY);
        if (!isFinite(headZ)) continue;
        const required = headZ + clearance - z * scaleZ;
        if (required > need) need = required;
      }
    });
    return need;
  }

  // Refits the bandana after every face change.
  refreshFromMesh(morphValues) {
    if (morphValues) this._faceMorphValues = morphValues;
    if (this._container && this.enabled) {
      this._alignAndAdjust();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  // Shows or hides the bandana, loading it on first use.
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

  // Switches to another bandana style and applies its tuned defaults.
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

  // Tints the print; white leaves it as designed.
  setTint(hex) {
    this.tint = hex;
    this._mat.color.set(hex);
  }

  // Sets the bandana's opacity.
  setOpacity(value) {
    this.opacity = Math.max(0, Math.min(100, value));
    const o = this.opacity / 100;
    this._mat.opacity = o;
    this._mat.transparent = o < 0.999;
  }

  // Sets one fit value and refits the bandana.
  setParam(param, value) {
    if (this.params[param] === undefined) return;
    this.params[param] = value;
    if (this._container && this.enabled) this._alignAndAdjust();
  }

  // Returns the current bandana settings.
  getParams() {
    return {
      ...this.params,
      enabled: this.enabled,
      style: this.currentStyle,
      tint: this.tint,
      opacity: this.opacity,
    };
  }

  // Texture decoding

  // Pulls the colour, normal and roughness textures out of the GLB, since the shared loader ignores them and the print would be lost.
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
          // glTF UVs start at the top-left, so don't flip the texture.
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
          // The texture carries the colour, so reset the material tint to white.
          this._mat.needsUpdate = true;
        }),
        decode(imageIndexOf(material.normalTexture), false).then(t => {
          if (!t) return;
          this._mat.normalMap = t;
          this._mat.needsUpdate = true;
        }),
        decode(imageIndexOf(pbr.metallicRoughnessTexture), false).then(t => {
          if (!t) return;
          // glTF packs roughness and metalness into one image; three reads each from the right channel.
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

  // Collects each mesh's world transform by walking the glTF node tree.
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

  // Loads the bandana model (or uses the cached one) and fits it to the face.
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

  // Resolves once the bandana model has finished loading.
  whenIdle() {
    return this._loads.whenIdle();
  }

  // Places a cached bandana model in the scene with its own copy of the geometry.
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
      // The hem flare rewrites vertices, so this copy needs its own geometry and an untouched baseline.
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

  // Fits the bandana to the skull, brow, nose and chin, then applies the user's settings.
  _alignAndAdjust() {
    if (!this._container || !this._headGroup) return;

    const container = this._container;
    const offsetGroup = container.children[0];
    if (!offsetGroup) return;

    // Measure the raw model once, with the container reset.
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

    // Chin and nose tip come from the mesh; only the brow line uses a landmark.
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
    // Without a bridge landmark, place the brow line a fifth of the face above the nose tip.
    if (bridgeY === null) bridgeY = noseTipY + (noseTipY - chinY) * 0.20;

    // Width follows the skull so the loop clears it, and height follows brow-to-chin so the point lands where a worn bandana would.
    const WRAP_SLACK = 1.06;
    const userScale = this.params.scale / 100;
    const userWidth = this.params.width / 100;
    const userDepth = this.params.depth / 100;

    const DEG = Math.PI / 180;
    const span = Math.max(0.05, bridgeY - chinY);

    // Morph values fine-tune the fit during fast slider drags.
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

    // Place by the model's top and front edges, since its box centre sits far back because of the knot tails.
    const userPosX = this.params.posX * 0.01;
    const userPosY = this.params.posY * 0.01;
    const userPosZ = this.params.posZ * 0.01;

    const halfHeight = (size.y * scaleY) * 0.5;
    // The container origin is the box centre, so place that so the top edge lands on target.
    const centreY = targetTopY - halfHeight;

    // Push the cloth forward until no part of the face pokes through, then bend the hem.
    this._applyHemFlare(offsetGroup, this._fitCache.min.y, center.y);

    // A small gap to cover contacts that fall between the sampled bands.
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

  // Returns the bandana settings for saving.
  exportState() {
    return {
      ...this.params,
      enabled: this.enabled,
      style: this.currentStyle,
      tint: this.tint,
      opacity: this.opacity,
    };
  }

  // Restores bandana settings from a saved case.
  loadState(state) {
    if (!state) return;
    if (state.style && this.bandanaModels[state.style]) this.currentStyle = state.style;
    if (state.tint) this.setTint(state.tint);
    if (state.opacity !== undefined) this.setOpacity(state.opacity);
    for (const key of Object.keys(this.params)) {
      if (state[key] !== undefined) this.params[key] = state[key];
    }
    // Force a clean rebuild so undo/redo always shows the restored state.
    this._container = null;
    this._fitCache = null;
    this.setEnabled(state.enabled === true);
  }

  // Applies bandana settings suggested by the AI.
  applyFromAI(data) {
    if (!data) return;
    if (data.style && this.bandanaModels[data.style]) this.setStyle(data.style);
    if (data.tint) this.setTint(data.tint);
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

  // Removes the bandana from the scene and frees its textures.
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
