/**
 * EarringSystem.js – GLB-based ear jewellery with per-side placement.
 *
 * Anchors to the live post-morph earlobe landmarks (ear_left_bottom /
 * ear_right_bottom) so the jewellery follows earSize, earHeight, earProtrusion
 * and earlobeSize instead of sitting at a fixed offset. Mirrors GlassesSystem
 * and FaceMaskSystem — HeadTracker reparents earringGroup into the pivot group,
 * so head tracking works without extra wiring.
 *
 * Sides are independent: 'both', 'left' or 'right'. A single piercing is common
 * enough in real subjects that one-sided wear is a first-class option, not an
 * afterthought.
 *
 * Model-space notes for assets/accessories/nose_ring_ear_ring.glb:
 *   - The file carries exactly one mesh, "Nose Ring.001_Metal_0" (a plain hoop).
 *     Both ears reuse that geometry; there is no separate left/right mesh.
 *   - Every transform lives on ANCESTOR nodes (Sketchfab_model → .fbx →
 *     RootNode → Nose Ring.001), and the mesh-bearing node has no matrix of its
 *     own. GlassesSystem._readNodeTransforms only reads a mesh node's own
 *     matrix, so it returns nothing here — hence _readWorldTransforms below,
 *     which accumulates down the hierarchy.
 *   - The hoop is authored thin in Z. An earring needs it thin in X (hoop plane
 *     parallel to the head's sagittal plane), so _normalise rotates it.
 *
 * Realism: the geometry is re-origined at the TOP of the hoop, which is the
 * point that passes through the lobe. Positioning that origin at the piercing
 * point makes the hoop hang below the lobe the way real jewellery does, rather
 * than floating centred on the landmark. A small bead is drawn at the entry
 * point so the piercing reads as a piercing.
 */

// ── Asset path constants ────────────────────────────────────────────────────
// Update this path if the GLB is moved.
const EARRING_MODEL_PATH = '../../assets/accessories/nose_ring_ear_ring.glb';

class EarringSystem {
  /**
   * Neutral slider values, before any per-style tuning is layered on top.
   * Every key here is a valid `setParam` target.
   */
  static get BASE_PARAMS() {
    return {
      size: 100,   // 40..200 — overall scale, relative to the measured ear
      posX: 0,     // -100..+100 — outward (away from the head) / inward
      posY: 0,     // -100..+100 — raises / lowers the piercing point
      posZ: 0,     // -100..+100 — forward / back along the lobe
      // Per-side tuning. Ears are rarely symmetric once morphs are applied, and
      // a single-side piercing usually wants its own placement. "left" is the
      // subject's left, i.e. the -X ear, matching the ear_left_* / jaw_angle_left
      // convention in OBJMorpher.LANDMARKS.
      tiltL: 0,    // -45..+45 deg — swings the hoop fore/aft in the ear plane
      tiltR: 0,
      splayL: 0,   // -45..+45 deg — flares the hoop away from the neck
      splayR: 0,
      dropL: 0,    // -50..+50 — extra hang below the lobe
      dropR: 0,
      // Rolls the hoop around its own centre without moving it. 0 leaves the
      // model's opening where _alignGapToTop put it, i.e. straight at the lobe.
      spinL: 0,    // -180..+180 deg
      spinR: 0,
    };
  }

  constructor(sceneManager) {
    // Accepts a SceneManager (needs .renderer for the metal environment map)
    // but tolerates a bare scene, matching the looser constructors elsewhere.
    this.sceneManager = sceneManager && sceneManager.scene ? sceneManager : null;
    this.scene = this.sceneManager ? this.sceneManager.scene : sceneManager;

    // Scene group — HeadTracker.js looks for this.earringGroup by name to
    // reparent into the head-tracking pivot, matching GlassesSystem.
    this.earringGroup = new THREE.Group();
    this.earringGroup.name = 'EarringSystem';
    this.scene.add(this.earringGroup);

    // Head references (set by setHeadMesh)
    this._headGroup = null;
    this._regionData = null;
    this._morpher = null;
    this._faceMorphValues = null;

    // State
    this.enabled = false;
    this.currentStyle = 'hoop';
    this.sideMode = 'both';        // 'both' | 'left' | 'right'
    this.metalColor = '#d4af37';   // default: yellow gold
    this.polish = 82;              // 0..100 — maps inversely to roughness

    this.params = EarringSystem.BASE_PARAMS;

    // Style configs. `defaults` are applied by setStyle().
    //
    // `place` is the piercing point relative to the measured lobe anchor, in
    // units of ear height: `out` is away from the skull, `lift` upward, `fwd`
    // toward the face. These exist because _computeEarAnchors returns the
    // outermost point of the lower ear, which is the helix rim rather than the
    // lobe itself — it lands a touch high, noticeably far back, and outboard of
    // where a ring actually passes through. Hand-tuned against the stock head;
    // `place` keeps that correction out of the user's sliders so those stay
    // centred on 0 and can trim in both directions.
    this.earringModels = {
      hoop: {
        label: 'Hoop',
        usesModel: true,
        // Hoop diameter as a fraction of the measured ear height. The stock
        // head measures ~0.49 units ear-to-lobe against a ~1.9 unit head
        // width, so one unit is roughly 8cm; 0.42 puts a ~1.7cm hoop on the
        // lobe, which reads as everyday jewellery rather than a statement piece.
        sizeRatio: 0.4234,
        place: { out: -0.17, lift: 0.032, fwd: 0.188 },
        // spin is negative because the slider's sign is now absolute rather
        // than per-side: the tuned left ear ran at -29 once its old outward
        // flip was applied, and the right must match it exactly.
        defaults: {
          size: 100, posX: 0, posY: 0, posZ: 0,
          tiltL: 3, tiltR: 3, splayL: 8, splayR: 8,
          dropL: 16, dropR: 16, spinL: -29, spinR: -29,
        },
      },
      stud: {
        label: 'Stud',
        usesModel: false,
        // A stud is a bead sitting on the lobe, so it is scaled off the same
        // ear measurement but far smaller — about a 5mm ball. It rests on the
        // surface rather than passing through, so it keeps more of the
        // anchor's outward reach than the ring styles do.
        sizeRatio: 0.10,
        place: { out: -0.04, lift: 0.032, fwd: 0.188 },
        defaults: {
          size: 100, posX: 0, posY: 0, posZ: 0,
          tiltL: 0, tiltR: 0, splayL: 0, splayR: 0,
          dropL: 0, dropR: 0, spinL: 0, spinR: 0,
        },
      },
      drop: {
        label: 'Drop',
        usesModel: true,
        // Hangs a smaller hoop below a short bar. The ratio covers the whole
        // assembly (bar + hoop = 1.0 in unit space), so a ~2.5cm total drop.
        // Its bar passes through the lobe just as the hoop does, so it shares
        // the ring placement.
        sizeRatio: 0.46,
        place: { out: -0.17, lift: 0.032, fwd: 0.188 },
        defaults: {
          size: 100, posX: 0, posY: 0, posZ: 0,
          tiltL: 3, tiltR: 3, splayL: 8, splayR: 8,
          dropL: 0, dropR: 0, spinL: -29, spinR: -29,
        },
      },
    };

    // Caches
    this._unitGeometries = null;   // baked, normalised hoop geometry (unit diameter)
    this._hoopCentreY = -0.5;      // ring centre in unit space, set by _normalise
    this._loadPromise = null;
    this._loadId = 0;
    this._loads = new AssetLoadTracker('earrings');

    // Per-side scene containers
    this._sides = { left: null, right: null };

    // Baseline landmark positions captured on first refresh — used so the fit
    // degrades gracefully if a landmark stops resolving mid-session.
    this._initialLobeL = null;
    this._initialLobeR = null;
    this._initialEarHeight = null;

    // ── Metal material ──
    // metalness 1.0 with no image-based lighting renders almost black, and this
    // scene never sets scene.environment (SceneManager only adds directional,
    // ambient and hemisphere lights). A small PMREM-filtered gradient gives the
    // metal something to reflect. It is attached to this material only, so the
    // skin/hair/glasses/mask look is untouched.
    this._metalMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.metalColor),
      metalness: 1.0,
      roughness: this._polishToRoughness(this.polish),
      envMapIntensity: 1.25,
      side: THREE.FrontSide,
    });
    this._envMap = this._buildEnvMap();
    if (this._envMap) this._metalMat.envMap = this._envMap;

    this.setStyle(this.currentStyle);

    console.log('[EarringSystem] Initialized');
  }

  /**
   * Full default state for a style, ready to hand to loadState(). Reset paths
   * use this so "reset" restores the tuned per-style fit rather than a flat
   * neutral pose that no style actually wants.
   */
  getStyleDefaults(style) {
    const name = this.earringModels[style] ? style : 'hoop';
    const d = this.earringModels[name].defaults || {};
    return {
      enabled: false,
      style: name,
      sideMode: 'both',
      metalColor: '#d4af37',
      polish: 82,
      ...EarringSystem.BASE_PARAMS,
      ...d,
    };
  }

  // ── Head binding ────────────────────────────────────────────────────────

  setHeadMesh(headGroup, regionData, morpher) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._morpher = morpher || null;
    this._initialLobeL = null;
    this._initialLobeR = null;
    this._initialEarHeight = null;
    this._captureBaselines();
  }

  _captureBaselines() {
    const a = this._computeEarAnchors();
    if (!a) return;
    this._initialLobeL = a.left.clone();
    this._initialLobeR = a.right.clone();
    this._initialEarHeight = a.earHeight;
  }

  // ── Ear localisation ────────────────────────────────────────────────────

  /**
   * World-space vertices of the head mesh, post-morph.
   *
   * OBJMorpher rewrites the position attribute in place, so reading it here
   * always reflects the current face. Accessory meshes are skipped by vertex
   * count — the head is an order of magnitude denser than anything else in
   * the group.
   */
  _sampleHeadPoints() {
    const group = this._headGroup;
    if (!group) return null;
    const chunks = [];
    let total = 0;
    const v = new THREE.Vector3();
    group.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      const pos = o.geometry.attributes.position;
      if (pos.count < 2000) return;
      o.updateWorldMatrix(true, false);
      const arr = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
      }
      chunks.push(arr);
      total += pos.count;
    });
    if (!total) return null;
    if (chunks.length === 1) return chunks[0];
    const out = new Float32Array(total * 3);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  /**
   * Find each earlobe from the mesh itself rather than from
   * OBJMorpher.LANDMARKS.
   *
   * The landmark table is a hand-written approximation and its ear entries do
   * not match head.glb: `ear_left_bottom` resolves roughly 0.12 above, 0.13
   * behind and 0.05 inboard of the actual lobe, which buries a hoop inside the
   * skull. Measuring instead keeps the jewellery on the surface and makes it
   * follow earSize / earProtrusion / earlobeSize for free.
   *
   * Method: bin the head by height and record how far each slice reaches
   * sideways. The ear is the lateral bulge, so outwardness peaks inside it and
   * falls away below; the lobe is where the profile has dropped to 90% of that
   * peak. Averaging the outermost vertices around that height gives a point on
   * the outer lobe surface — where a piercing actually sits.
   */
  _computeEarAnchors() {
    const pts = this._sampleHeadPoints();
    if (!pts) return null;
    const n = pts.length / 3;
    if (n < 500) return null;

    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const y = pts[i * 3 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const span = maxY - minY;
    if (!(span > 1e-6)) return null;

    const BINS = 96;
    const binOf = (y) => Math.min(BINS - 1, Math.max(0, Math.floor((y - minY) / span * BINS)));

    const result = {};
    let earHeight = 0;

    for (const side of ['left', 'right']) {
      const sign = side === 'left' ? -1 : 1;   // subject's left ear is at -X

      // Per-slice maximum outward reach.
      const ext = new Float32Array(BINS).fill(-Infinity);
      for (let i = 0; i < n; i++) {
        const outward = pts[i * 3] * sign;
        if (outward <= 0) continue;
        const b = binOf(pts[i * 3 + 1]);
        if (outward > ext[b]) ext[b] = outward;
      }

      // Peak = widest point of the ear. Restrict to the upper 60% of the head
      // so a broad jaw or shoulder cannot win.
      const lo = binOf(minY + span * 0.40);
      let peakBin = -1, peak = -Infinity;
      for (let b = lo; b < BINS; b++) {
        if (ext[b] > peak) { peak = ext[b]; peakBin = b; }
      }
      if (peakBin < 0 || !isFinite(peak)) return null;

      // Walk down from the peak to where the ear stops protruding.
      const CUT = peak * 0.90;
      let lobeBin = peakBin;
      for (let b = peakBin; b >= 0; b--) {
        if (!isFinite(ext[b]) || ext[b] < CUT) break;
        lobeBin = b;
      }
      // And up, to size the ear.
      let topBin = peakBin;
      for (let b = peakBin; b < BINS; b++) {
        if (!isFinite(ext[b]) || ext[b] < CUT) break;
        topBin = b;
      }
      earHeight = Math.max(earHeight, (topBin - lobeBin + 1) / BINS * span);

      // Average the outermost vertices in a window around the lobe height.
      const bandLo = minY + (lobeBin - 2) / BINS * span;
      const bandHi = minY + (lobeBin + 3) / BINS * span;
      let bandPeak = -Infinity;
      for (let i = 0; i < n; i++) {
        const y = pts[i * 3 + 1];
        if (y < bandLo || y > bandHi) continue;
        const outward = pts[i * 3] * sign;
        if (outward > bandPeak) bandPeak = outward;
      }
      if (!isFinite(bandPeak)) return null;

      const keep = bandPeak * 0.94;
      let sx = 0, sy = 0, sz = 0, count = 0;
      for (let i = 0; i < n; i++) {
        const y = pts[i * 3 + 1];
        if (y < bandLo || y > bandHi) continue;
        const outward = pts[i * 3] * sign;
        if (outward < keep) continue;
        sx += pts[i * 3]; sy += y; sz += pts[i * 3 + 2];
        count++;
      }
      if (!count) return null;
      result[side] = new THREE.Vector3(sx / count, sy / count, sz / count);
    }

    if (!result.left || !result.right || !(earHeight > 1e-4)) return null;
    result.earHeight = earHeight;
    return result;
  }

  /**
   * Called by app.js on every morph update so the jewellery tracks ear changes.
   */
  refreshFromMesh(morphValues) {
    if (morphValues) this._faceMorphValues = morphValues;
    if (this.enabled && (this._sides.left || this._sides.right)) {
      this._alignAndAdjust();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.enabled) {
      if (!this._sides.left && !this._sides.right) {
        this.generate();
      } else {
        this.earringGroup.visible = true;
        this._applySideVisibility();
        this._alignAndAdjust();
      }
    } else {
      this.earringGroup.visible = false;
    }
  }

  setStyle(style) {
    if (style === 'none') {
      this.setEnabled(false);
      return;
    }
    const config = this.earringModels[style];
    if (!config) {
      console.warn('[EarringSystem] Unknown style:', style);
      return;
    }
    this.currentStyle = style;

    const d = config.defaults;
    if (d) {
      for (const key of Object.keys(this.params)) {
        if (d[key] !== undefined) this.params[key] = d[key];
      }
    }

    if (this.enabled) this.generate();
  }

  /** 'both' | 'left' | 'right' — which ears carry jewellery. */
  setSideMode(mode) {
    if (!['both', 'left', 'right'].includes(mode)) {
      console.warn('[EarringSystem] Unknown side mode:', mode);
      return;
    }
    this.sideMode = mode;
    this._applySideVisibility();
  }

  setMetalColor(hex) {
    this.metalColor = hex;
    this._metalMat.color.set(hex);
  }

  /** 0 = brushed/matte, 100 = mirror finish. */
  setPolish(value) {
    this.polish = Math.max(0, Math.min(100, value));
    this._metalMat.roughness = this._polishToRoughness(this.polish);
  }

  _polishToRoughness(polish) {
    // Keep a floor of 0.04: a perfectly smooth metal with only a tiny env map
    // collapses to a hard mirror and loses its silhouette.
    return 0.04 + (1 - Math.max(0, Math.min(100, polish)) / 100) * 0.66;
  }

  setParam(param, value) {
    if (this.params[param] === undefined) return;
    this.params[param] = value;
    if (this.enabled) this._alignAndAdjust();
  }

  getParams() {
    return {
      ...this.params,
      enabled: this.enabled,
      style: this.currentStyle,
      sideMode: this.sideMode,
      metalColor: this.metalColor,
      polish: this.polish,
    };
  }

  /** True when the active style is driven by the GLB rather than procedural. */
  usesModel() {
    return !!this.earringModels[this.currentStyle]?.usesModel;
  }

  // ── Environment map (metal reflections) ─────────────────────────────────

  /**
   * Build a small PMREM-filtered studio gradient. Drawn on a canvas rather than
   * loaded from disk so the app stays offline-only and no asset is added.
   * Returns null if no renderer is reachable — the material then falls back to
   * direct lighting only, which is dull but not broken.
   */
  _buildEnvMap() {
    const renderer = this.sceneManager && this.sceneManager.renderer;
    if (!renderer || typeof THREE.PMREMGenerator !== 'function') {
      console.warn('[EarringSystem] No renderer/PMREM — metal will look flat');
      return null;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');

      // Vertical sky → horizon → floor ramp, equirectangular.
      const ramp = ctx.createLinearGradient(0, 0, 0, canvas.height);
      ramp.addColorStop(0.00, '#ffffff');
      ramp.addColorStop(0.42, '#c4ced9');
      ramp.addColorStop(0.52, '#6f757e');
      ramp.addColorStop(1.00, '#202329');
      ctx.fillStyle = ramp;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Two soft highlights so the hoop catches moving streaks as it rotates,
      // which is most of what sells a curved metal surface.
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
      console.warn('[EarringSystem] Env map build failed:', e);
      return null;
    }
  }

  // ── GLB loading ─────────────────────────────────────────────────────────

  /**
   * Accumulate each mesh's full world matrix by walking the glTF node tree.
   *
   * GLBLoader emits a flat mesh list and drops node TRS entirely, and
   * GlassesSystem's flat reader only recovers a transform when it sits on the
   * mesh's own node. This asset puts a -90 deg X rotation, a 0.01 scale and a
   * 0.63 scale on three separate ancestors, so both of those paths lose it.
   */
  _readWorldTransforms(buffer) {
    try {
      const dv = new DataView(buffer);
      const jsonLen = dv.getUint32(12, true);
      const jsonBytes = new Uint8Array(buffer, 20, jsonLen);
      const gltf = JSON.parse(new TextDecoder().decode(jsonBytes));
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
        if (seen.has(idx)) return;   // guard against a malformed cyclic graph
        seen.add(idx);
        const n = nodes[idx];
        if (!n) return;
        const world = new THREE.Matrix4().multiplyMatrices(parentMatrix, localMatrix(n));
        if (typeof n.mesh === 'number') {
          const meshName = meshes[n.mesh]?.name;
          // GLBLoader names every primitive of a mesh after the mesh itself, so
          // one entry per mesh name is the right granularity here.
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
      console.warn('[EarringSystem] Could not read node transforms:', e);
      return {};
    }
  }

  /** Union bounding box across a list of BufferGeometry. */
  _unionBox(geoms) {
    const box = new THREE.Box3();
    for (const g of geoms) {
      g.computeBoundingBox();
      box.union(g.boundingBox);
    }
    return box;
  }

  /**
   * Roll the hoop about its own axis so its opening faces the lobe.
   *
   * The supplied model is a split ring: a 40-degree gap sits directly opposite
   * the closed arc. Left alone the closed side lands against the ear and the
   * opening dangles in mid-air, which is backwards — on a real hoop the gap is
   * the closure, and it sits at the piercing with the ear inside it.
   *
   * Vertices are binned by angle around the hoop centre in the YZ plane; the
   * longest empty run is the opening. Returns the ring radius, or null when
   * the model is a closed ring and there is nothing to align.
   */
  _alignGapToTop(geoms, centreY, centreZ) {
    const BINS = 72;                        // 5 degrees per bin
    const hits = new Uint16Array(BINS);
    let radius = 0;

    for (const g of geoms) {
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const dy = pos.getY(i) - centreY;
        const dz = pos.getZ(i) - centreZ;
        const r = Math.hypot(dy, dz);
        if (r > radius) radius = r;
      }
    }
    if (!(radius > 1e-6)) return null;

    for (const g of geoms) {
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const dy = pos.getY(i) - centreY;
        const dz = pos.getZ(i) - centreZ;
        const r = Math.hypot(dy, dz);
        if (r < radius * 0.5) continue;     // ignore the tube's inner wall
        let a = Math.atan2(dz, dy) * 180 / Math.PI;   // 0 deg = +Y
        if (a < 0) a += 360;
        hits[Math.floor(a / 5) % BINS]++;
      }
    }

    // Longest wrap-around run of empty bins.
    let bestLen = 0, bestStart = -1;
    for (let s = 0; s < BINS; s++) {
      if (hits[s]) continue;
      let l = 0;
      while (l < BINS && !hits[(s + l) % BINS]) l++;
      if (l > bestLen) { bestLen = l; bestStart = s; }
    }
    // A couple of stray empty bins is just sampling noise, not an opening.
    if (bestLen < 3) return { radius, rotated: false };

    const gapMid = ((bestStart + bestLen / 2) * 5) % 360;
    const theta = -gapMid * Math.PI / 180;   // bring the gap round to +Y

    const toCentre = new THREE.Matrix4().makeTranslation(0, -centreY, -centreZ);
    const rot = new THREE.Matrix4().makeRotationX(theta);
    const back = new THREE.Matrix4().makeTranslation(0, centreY, centreZ);
    const m = back.multiply(rot).multiply(toCentre);
    for (const g of geoms) g.applyMatrix4(m);

    return { radius, rotated: true };
  }

  /**
   * Bake world transforms, re-orient the hoop into the sagittal plane, roll its
   * opening up to the lobe, move the origin to the piercing point and normalise
   * to unit diameter. After this the per-side container only has to set
   * position, rotation and a single scale equal to the desired diameter, and
   * the hoop centre always sits at local (0, _hoopCentreY, 0).
   */
  _normalise(geoms) {
    if (!geoms.length) return geoms;

    // ── Orient: bring the thinnest axis onto X so the hoop plane is YZ ──
    let box = this._unionBox(geoms);
    const size = new THREE.Vector3();
    box.getSize(size);

    let orient = null;
    if (size.z <= size.x && size.z <= size.y) {
      orient = new THREE.Matrix4().makeRotationY(Math.PI / 2);   // Z → X
    } else if (size.y <= size.x && size.y <= size.z) {
      orient = new THREE.Matrix4().makeRotationZ(Math.PI / 2);   // Y → X
    }
    if (orient) for (const g of geoms) g.applyMatrix4(orient);

    // ── Roll the opening up so the ear sits inside it ──
    box = this._unionBox(geoms);
    const centre = new THREE.Vector3();
    box.getCenter(centre);
    const gap = this._alignGapToTop(geoms, centre.y, centre.z);

    // ── Re-origin at the piercing point ──
    // With an opening aligned upward that point is the ring's notional top
    // (centre + radius), which lands in the middle of the gap. Falling back to
    // the bbox top would sit the origin on the rim instead, below the opening.
    box = this._unionBox(geoms);
    box.getSize(size);
    box.getCenter(centre);
    const top = (gap && gap.rotated) ? centre.y + gap.radius : box.max.y;
    for (const g of geoms) g.translate(-centre.x, -top, -centre.z);

    // ── Normalise to unit diameter ──
    const diameter = (gap && gap.rotated) ? gap.radius * 2 : Math.max(size.y, size.z);
    if (diameter > 1e-6) {
      const s = 1 / diameter;
      const scale = new THREE.Matrix4().makeScale(s, s, s);
      for (const g of geoms) {
        g.applyMatrix4(scale);
        g.computeBoundingBox();
        g.computeBoundingSphere();
      }
      // Origin is the ring top and radius is half the diameter, so in unit
      // space the centre is exactly half a diameter below the origin.
      this._hoopCentreY = (gap && gap.rotated) ? -0.5 : (centre.y - top) / diameter;
    }
    return geoms;
  }

  /** Fetch + parse the GLB once; resolves to normalised unit geometry. */
  _loadModel() {
    if (this._unitGeometries) return Promise.resolve(this._unitGeometries);
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = fetch(EARRING_MODEL_PATH)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${EARRING_MODEL_PATH}`);
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
        console.error('[EarringSystem] Failed to load model:', EARRING_MODEL_PATH, err);
        this._loadPromise = null;
        return null;
      });

    return this._loadPromise;
  }

  // ── Piece construction ──────────────────────────────────────────────────

  _meshFromGeometry(geometry) {
    const mesh = new THREE.Mesh(geometry, this._metalMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * The bead that sits at the entry point. Without it a hoop simply intersects
   * the lobe and reads as clipping rather than as a piercing.
   */
  _makePiercingBead(radius) {
    const bead = this._meshFromGeometry(new THREE.SphereGeometry(radius, 16, 12));
    bead.name = 'EarringBead';
    return bead;
  }

  /**
   * A thin cylinder. `axis` 'x' gives the post that passes through the lobe
   * front-to-back; 'y' gives the vertical bar a drop earring hangs from.
   * CylinderGeometry is Y-aligned as built, so only the X case rotates.
   */
  _makeBar(radius, length, axis) {
    const geo = new THREE.CylinderGeometry(radius, radius, length, 12);
    if (axis === 'x') geo.rotateZ(Math.PI / 2);
    const bar = this._meshFromGeometry(geo);
    bar.name = axis === 'x' ? 'EarringPost' : 'EarringDropBar';
    return bar;
  }

  /**
   * A hoop wrapped so it can be rolled about its own centre.
   *
   * The piece origin is the piercing point on the ring's rim, so rotating the
   * meshes directly would swing the whole hoop away from the ear instead of
   * turning it in place. Nesting them under a group parked at the ring centre
   * makes rotation.x a true spin.
   */
  _makeHoop(unitGeoms) {
    const outer = new THREE.Group();
    outer.name = 'EarringHoop';
    const spinner = new THREE.Group();
    spinner.name = 'EarringHoopSpin';
    spinner.position.set(0, this._hoopCentreY, 0);
    const inner = new THREE.Group();
    inner.position.set(0, -this._hoopCentreY, 0);
    for (const g of unitGeoms) inner.add(this._meshFromGeometry(g));
    spinner.add(inner);
    outer.add(spinner);
    outer.userData.spinner = spinner;
    return outer;
  }

  /**
   * Build one side's jewellery in unit space: the piercing point is the origin
   * and the piece hangs down -Y with an overall extent of about 1 unit.
   * `piece.userData.spinners` lists the groups the spin slider drives.
   */
  _buildPiece(unitGeoms) {
    const piece = new THREE.Group();
    piece.name = 'EarringPiece';
    piece.userData.spinners = [];

    if (this.currentStyle === 'stud') {
      // A stud is the bead itself plus a token post so a side view still shows
      // something passing through the lobe.
      const bead = this._makePiercingBead(0.5);
      bead.position.set(0, -0.35, 0);
      piece.add(bead);
      piece.add(this._makeBar(0.12, 1.1, 'x'));
      return piece;
    }

    if (!unitGeoms || !unitGeoms.length) return piece;

    if (this.currentStyle === 'drop') {
      // Short bar, then a smaller hoop hanging off its lower end.
      const BAR_LEN = 0.34;
      const bar = this._makeBar(0.035, BAR_LEN, 'y');
      bar.position.set(0, -BAR_LEN / 2, 0);
      piece.add(bar);

      const hoop = this._makeHoop(unitGeoms);
      hoop.scale.setScalar(0.66);
      hoop.position.set(0, -BAR_LEN, 0);
      piece.add(hoop);
      piece.userData.spinners.push(hoop.userData.spinner);

      // The bar, not the ring, meets the lobe here, so it still needs a bead.
      piece.add(this._makePiercingBead(0.045));
      return piece;
    }

    // Default: plain hoop, opening at the lobe so the ear sits inside it.
    // No extra bead — the model carries its own ball terminals, and after the
    // gap alignment those are exactly what flank the piercing.
    const hoop = this._makeHoop(unitGeoms);
    piece.add(hoop);
    piece.userData.spinners.push(hoop.userData.spinner);
    return piece;
  }

  // ── Generation ──────────────────────────────────────────────────────────

  generate() {
    this._clearGroup(this.earringGroup);
    this._sides = { left: null, right: null };

    if (!this.enabled) return;

    this._loadId++;
    const thisLoadId = this._loadId;

    const needsModel = this.usesModel();
    const ready = needsModel ? this._loadModel() : Promise.resolve(null);

    this._loads.begin();
    ready.then(unitGeoms => {
      if (this._loadId !== thisLoadId) return;
      if (needsModel && !unitGeoms) return;   // load failed, already logged

      for (const side of ['left', 'right']) {
        const container = new THREE.Group();
        container.name = `Earring_${side}`;
        container.add(this._buildPiece(unitGeoms));
        this.earringGroup.add(container);
        this._sides[side] = container;
      }

      this.earringGroup.visible = this.enabled;
      this._applySideVisibility();
      this._alignAndAdjust();
    }).finally(() => this._loads.end());
  }

  /** Resolves once no earring model is mid-load. See AssetLoadTracker. */
  whenIdle() {
    return this._loads.whenIdle();
  }

  _applySideVisibility() {
    const wantLeft = this.sideMode === 'both' || this.sideMode === 'left';
    const wantRight = this.sideMode === 'both' || this.sideMode === 'right';
    if (this._sides.left) this._sides.left.visible = wantLeft;
    if (this._sides.right) this._sides.right.visible = wantRight;
  }

  _alignAndAdjust() {
    if (!this._sides.left && !this._sides.right) return;

    // ── Live measurement of the current post-morph ears ──
    const measured = this._computeEarAnchors();
    let lobeL = measured ? measured.left : (this._initialLobeL ? this._initialLobeL.clone() : null);
    let lobeR = measured ? measured.right : (this._initialLobeR ? this._initialLobeR.clone() : null);
    let earHeight = measured ? measured.earHeight : this._initialEarHeight;

    if (measured) {
      this._initialLobeL = measured.left.clone();
      this._initialLobeR = measured.right.clone();
      this._initialEarHeight = measured.earHeight;
    }

    // Last-resort fallbacks, measured off the stock head.glb.
    if (!lobeL) lobeL = new THREE.Vector3(-0.82, -0.12, 0.05);
    if (!lobeR) lobeR = new THREE.Vector3(0.82, -0.12, 0.05);
    if (!earHeight || earHeight < 0.02) earHeight = 0.65;

    const config = this.earringModels[this.currentStyle] || this.earringModels.hoop;
    const diameter = earHeight * (config.sizeRatio || 0.42) * (this.params.size / 100);

    const DEG = Math.PI / 180;
    // Slider offsets are scaled by ear height so they stay proportional when
    // earSize is morphed, instead of drifting off a large ear. At ±100 a
    // slider moves the piece by ±0.2 of an ear height, which is plenty of
    // trim without letting it fly off the head.
    const unit = earHeight;
    const userPosX = this.params.posX * 0.002 * unit;
    const userPosY = this.params.posY * 0.002 * unit;
    const userPosZ = this.params.posZ * 0.002 * unit;

    for (const side of ['left', 'right']) {
      const container = this._sides[side];
      if (!container) continue;

      const isLeft = side === 'left';
      const lobe = isLeft ? lobeL : lobeR;
      const outward = isLeft ? -1 : 1;   // subject's left ear is at -X
      const suffix = isLeft ? 'L' : 'R';

      const place = config.place || { out: 0, lift: 0, fwd: 0 };
      const drop = (this.params['drop' + suffix] ?? 0) * 0.002 * unit;

      container.position.set(
        lobe.x + outward * (place.out * unit + userPosX),
        lobe.y + place.lift * unit + userPosY - drop,
        lobe.z + place.fwd * unit + userPosZ,
      );

      // Tilt swings the hang fore/aft within the ear plane (about X).
      // Splay flares the piece away from the neck; rotation about Z sends a
      // point at -Y toward +X, so the left ear needs the opposite sign for both
      // sides to swing outward together.
      const tilt = (this.params['tilt' + suffix] ?? 0) * DEG;
      const splay = (this.params['splay' + suffix] ?? 0) * DEG;
      container.rotation.set(tilt, 0, outward * splay);

      container.scale.setScalar(diameter);

      // Spin rolls the ring about its own centre, so the opening can be aimed
      // anywhere without the hoop leaving the lobe.
      //
      // No per-side sign flip, unlike splay. Reflecting the head through the
      // sagittal plane maps (x,y,z) to (-x,y,z), which leaves a rotation about
      // X untouched — so a mirror-symmetric pair carries the *same* spin angle.
      // Negating it here made the right ear a rotational mirror of the left,
      // which only looked right when viewed from behind the head. Tilt is also
      // a rotation about X and is left unflipped for the same reason.
      const spin = (this.params['spin' + suffix] ?? 0) * DEG;
      const piece = container.children[0];
      for (const s of (piece && piece.userData.spinners) || []) {
        s.rotation.x = spin;
      }
    }
  }

  // ── State / persistence ─────────────────────────────────────────────────

  exportState() {
    // Spread params so new sliders persist without touching this method.
    return {
      ...this.params,
      enabled: this.enabled,
      style: this.currentStyle,
      sideMode: this.sideMode,
      metalColor: this.metalColor,
      polish: this.polish,
    };
  }

  loadState(state) {
    if (!state) return;
    if (state.style && this.earringModels[state.style]) this.currentStyle = state.style;
    if (state.sideMode && ['both', 'left', 'right'].includes(state.sideMode)) {
      this.sideMode = state.sideMode;
    }
    if (state.metalColor) this.setMetalColor(state.metalColor);
    if (state.polish !== undefined) this.setPolish(state.polish);
    for (const key of Object.keys(this.params)) {
      if (state[key] !== undefined) this.params[key] = state[key];
    }
    // Force a clean rebuild so style/param changes from undo/redo are always
    // reflected — setEnabled skips generate() when containers already exist.
    this._sides = { left: null, right: null };
    this._clearGroup(this.earringGroup);
    this.setEnabled(state.enabled === true);
  }

  /**
   * Apply AI-generated earring block. Schema:
   *   { enabled, style, sideMode, metalColor, polish }
   */
  applyFromAI(data) {
    if (!data) return;
    if (data.style && this.earringModels[data.style]) this.setStyle(data.style);
    if (data.sideMode) this.setSideMode(data.sideMode);
    if (data.metalColor) this.setMetalColor(data.metalColor);
    if (data.polish !== undefined) this.setPolish(data.polish);
    this.setEnabled(!!data.enabled);
  }

  /**
   * World-space transforms of each visible side. Useful for future Blender
   * export pipelines that want to merge the jewellery into the head mesh.
   */
  getRenderTransform() {
    const out = {
      matrices: {},
      params: { ...this.params },
      enabled: this.enabled,
      style: this.currentStyle,
      sideMode: this.sideMode,
      metalColor: this.metalColor,
      polish: this.polish,
    };
    if (!this.enabled) return out;
    for (const side of ['left', 'right']) {
      const c = this._sides[side];
      if (!c || !c.visible) continue;
      c.updateWorldMatrix(true, false);
      out.matrices[side] = Array.from(c.matrixWorld.elements);
    }
    return out;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  _clearGroup(group) {
    while (group.children.length > 0) {
      group.remove(group.children[0]);
    }
  }

  dispose() {
    this._clearGroup(this.earringGroup);
    this.scene.remove(this.earringGroup);
    if (this._envMap) this._envMap.dispose();
    this._metalMat.dispose();
  }
}

window.EarringSystem = EarringSystem;
