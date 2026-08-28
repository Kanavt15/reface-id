/**
 * SkinTextureSystem.js
 * Procedural skin texture generator with aging effects for Three.js face models.
 *
 * KEY DESIGN: Builds a UV→3D position map by splatting mesh vertices onto the
 * texture grid. This means all facial zone effects (cheeks, forehead, wrinkles)
 * are placed based on ACTUAL 3D anatomy — not assumed UV coordinates.
 *
 * Uses fast interpolated value noise for real-time slider performance.
 * Initialization is deferred so it never blocks the UI thread.
 */

class SkinTextureSystem {
  constructor(sceneManager) {
    this.scene = sceneManager;
    this.meshGroup = null;

    /* Macro map resolution, tied to the quality tier by setResolution().
       512 on Low and Medium, 1024 on High.

       These maps only carry low-frequency content — anatomical colour zones,
       freckles, age spots and wrinkle creases. Pore-scale detail deliberately
       does NOT live here: at any resolution a pore is sub-texel across a whole
       head, so it comes from the tiled detail normal in SkinShader instead,
       which is resolution-independent.

       That is what settles the tradeoff. Measured on this machine, a full
       regenerate costs ~19ms at 512 and ~65ms at 1024, and it runs on every
       slider tick. 1024 sharpens wrinkle creases and nothing else, which is
       not worth tripling the cost of dragging a slider for most work — so it
       is available on High rather than being the default. */
    this.RES = 512;

    // Noise fields keyed by generation parameters. None of them depend on any
    // slider — only on the seed — but they were being regenerated on every
    // single slider move, nine times per pass.
    this._noiseCache = new Map();

    // UV-space bounding boxes for the wrinkle regions, computed once from the
    // position map. See _regionBounds().
    this._regionBoundsCache = null;

    // Per-texel anatomical zone weights. See _buildZoneCache().
    this._zoneCache = null;

    this._diffuseCanvas = null;
    this._normalCanvas = null;
    this._roughnessCanvas = null;
    this._thicknessCanvas = null;
    this.diffuseTexture = null;
    this.normalTexture = null;
    this.roughnessTexture = null;
    this.thicknessTexture = null;

    // UV→3D position map: for each texture pixel, stores the 3D world position
    // This is the key to placing facial zones correctly regardless of UV layout
    this._posMap = null;   // Float32Array(R*R*3) — xyz per pixel
    this._hasPosMap = false;

    // Model bounds for normalizing positions
    this._modelYMin = -1;
    this._modelYMax = 1;
    this._modelCenter = [0, 0, 0];

    this.params = { ...SkinTextureSystem.DEFAULT_PARAMS };
    this._skinColorHex = '#cb9a78';
    this._seed = 42;
    this._initialized = false;

    // Reference to WrinklePainter (set externally)
    this.wrinklePainter = null;

    // Reference to PigmentationPainter (set externally)
    this.pigmentationPainter = null;
  }

  /* Slider defaults. The reset paths in UIController already read this; it
     had never actually been defined, so resetting skin texture wiped params
     down to an empty object instead of restoring them. */
  static get DEFAULT_PARAMS() {
    return {
      age: 20, roughness: 50, freckles: 0,
      poreDetail: 0, wrinkleDepth: 30, skinOiliness: 0, sunDamage: 10,
      /* Depth of the tiled pore normal in SkinShader — the orange-peel
         bumpiness that only resolves when the camera is close. Kept here
         rather than in SkinShader so it saves and restores with the rest of
         the skin state, but it is a plain uniform, so moving it never costs
         a map regenerate. 50 maps to SkinShader's own 0.30 default. */
      microRelief: 50,
      /* Warm capillary bloom over the malar pads. Off by default — at the
         strength the zone tint applies it it reads as applied make-up rather
         than complexion, which is the wrong starting point for a likeness. */
      cheekFlush: false,
    };
  }

  /** Micro-relief slider (0-100) → SkinShader pore normal depth. */
  static microReliefToPoreScale(v) {
    return (Math.max(0, Math.min(100, v)) / 100) * 0.6;
  }

  // ─── PRNG ─────────────────────────────────────────────────────────────────
  _rng() {
    this._seed = (this._seed * 16807) % 2147483647;
    return (this._seed - 1) / 2147483646;
  }
  _resetSeed(s) {
    this._seed = (s || 42) & 0x7fffffff;
    if (this._seed === 0) this._seed = 1;
  }

  // ─── Fast interpolated value noise ────────────────────────────────────────
  _valueNoise(R, gridSize, seed) {
    this._resetSeed(seed);
    const gs = Math.max(2, gridSize);
    const grid = new Float32Array((gs + 1) * (gs + 1));
    for (let i = 0; i < (gs + 1) * (gs + 1); i++) grid[i] = this._rng();
    for (let i = 0; i <= gs; i++) {
      grid[i * (gs + 1) + gs] = grid[i * (gs + 1)];
      grid[gs * (gs + 1) + i] = grid[i];
    }
    const out = new Float32Array(R * R);
    const fade = SkinTextureSystem._fade;
    for (let y = 0; y < R; y++) {
      const gy = (y / R) * gs, iy = Math.floor(gy), fy = fade(gy - iy);
      for (let x = 0; x < R; x++) {
        const gx = (x / R) * gs, ix = Math.floor(gx), fx = fade(gx - ix);
        const s = gs + 1;
        const top = grid[iy * s + ix] + (grid[iy * s + ix + 1] - grid[iy * s + ix]) * fx;
        const bot = grid[(iy+1)*s+ix] + (grid[(iy+1)*s+ix+1] - grid[(iy+1)*s+ix]) * fx;
        out[y * R + x] = top + (bot - top) * fy;
      }
    }
    return out;
  }

  /* Quintic fade curve (6t⁵-15t⁴+10t³). Straight bilinear interpolation is
     only C0 across a cell boundary: the slope jumps there, measured at ~16x
     the interior slope change. That is invisible in a colour map and glaring
     in a normal map, which is built from exactly that slope and then amplifies
     it 5x — it was the grid of diagonal creases over the whole face. The
     quintic is flat in both the first and second derivative at t=0 and t=1,
     so the cells join with no crease at all. */
  static _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

  _fractalNoise(R, seed, octaves, persistence) {
    const result = new Float32Array(R * R);
    let amp = 1, maxAmp = 0, gs = 4;
    for (let o = 0; o < octaves; o++) {
      const layer = this._valueNoise(R, gs, seed + o * 1000);
      for (let i = 0, n = R * R; i < n; i++) result[i] += layer[i] * amp;
      maxAmp += amp; amp *= persistence;
      /* Not gs *= 2. Doubling puts every octave's cell boundaries on the same
         texels, so whatever each layer leaves at its seams stacks coherently
         into one visible grid instead of averaging away. An irrational-ish
         ratio lands them on different texels each octave; rounding keeps gs
         an integer, which the edge wrap above needs. */
      gs = Math.max(gs + 1, Math.round(gs * 2.17));
    }
    const inv = 1 / maxAmp;
    for (let i = 0, n = R * R; i < n; i++) result[i] *= inv;
    return result;
  }

  /**
   * Cached noise. The generators below are pure functions of (R, seed, …), and
   * regenerate() calls nine of them; at 1024 that was ~100M operations per
   * slider tick spent recomputing identical fields. Cached, a regenerate only
   * pays for the per-pixel compositing.
   */
  _cachedFractal(R, seed, octaves, persistence) {
    const key = 'f' + R + '_' + seed + '_' + octaves + '_' + persistence;
    let v = this._noiseCache.get(key);
    if (!v) {
      v = this._fractalNoise(R, seed, octaves, persistence);
      this._noiseCache.set(key, v);
    }
    return v;
  }

  _cachedValue(R, gridSize, seed) {
    const key = 'v' + R + '_' + gridSize + '_' + seed;
    let v = this._noiseCache.get(key);
    if (!v) {
      v = this._valueNoise(R, gridSize, seed);
      this._noiseCache.set(key, v);
    }
    return v;
  }

  _randomNoise(R, seed) {
    this._resetSeed(seed);
    const out = new Float32Array(R * R);
    for (let i = 0, n = R * R; i < n; i++) out[i] = this._rng();
    return out;
  }

  // ─── UV → 3D Position Map ────────────────────────────────────────────────
  // Scatter mesh vertex positions onto the UV texture grid.
  // For each vertex, write its world-space XYZ to the UV pixel it maps to.
  // Then flood-fill gaps so every pixel has a valid 3D position.

  _buildPositionMap() {
    const R = this.RES;
    this._posMap = new Float32Array(R * R * 3);
    const hasData = new Uint8Array(R * R); // 1 = has position data

    let yMin = 1e9, yMax = -1e9;
    let cx = 0, cy = 0, cz = 0, cnt = 0;

    this.meshGroup.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      const pos = child.geometry.attributes.position;
      const uv = child.geometry.attributes.uv;
      if (!pos || !uv) return;

      const N = pos.count;
      for (let i = 0; i < N; i++) {
        const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        const u = uv.getX(i), v = uv.getY(i);

        // UV to pixel
        const tx = Math.floor(u * (R - 1));
        const ty = Math.floor(v * (R - 1));
        if (tx < 0 || tx >= R || ty < 0 || ty >= R) continue;

        const pi = (ty * R + tx) * 3;
        this._posMap[pi] = px;
        this._posMap[pi + 1] = py;
        this._posMap[pi + 2] = pz;
        hasData[ty * R + tx] = 1;

        if (py < yMin) yMin = py;
        if (py > yMax) yMax = py;
        cx += px; cy += py; cz += pz; cnt++;
      }
    });

    if (cnt > 0) {
      this._modelCenter = [cx / cnt, cy / cnt, cz / cnt];
      this._modelYMin = yMin;
      this._modelYMax = yMax;
    }

    /* Flood-fill gaps so every texel has a 3D position to place zones against.
       This was eight full-grid passes of 4-neighbour expansion, which reached
       exactly 8 pixels and no further. At 512 that was enough because 18k
       vertices covered ~7% of the grid; at 1024 they cover under 2% and the
       average gap is wider than 8px, which would have left dead zeros across
       the map and broken every anatomical zone placement downstream.

       A multi-source BFS fills the whole map regardless of resolution, and
       does it in one O(R^2) sweep instead of passes * O(R^2). */
    const queue = new Int32Array(R * R);
    let qHead = 0, qTail = 0;
    for (let i = 0; i < R * R; i++) {
      if (hasData[i]) queue[qTail++] = i;
    }

    while (qHead < qTail) {
      const idx = queue[qHead++];
      const y = (idx / R) | 0;
      const x = idx - y * R;
      const src = idx * 3;

      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || nx >= R || ny < 0 || ny >= R) continue;
        const ni = ny * R + nx;
        if (hasData[ni]) continue;

        const dst = ni * 3;
        this._posMap[dst]     = this._posMap[src];
        this._posMap[dst + 1] = this._posMap[src + 1];
        this._posMap[dst + 2] = this._posMap[src + 2];
        hasData[ni] = 1;
        queue[qTail++] = ni;
      }
    }

    this._hasPosMap = true;
    this._zoneCache = null;
    this._regionBoundsCache = null;
    console.log(`[SkinTexture] Position map built: Y range [${yMin.toFixed(2)}, ${yMax.toFixed(2)}], ${cnt} vertices`);
  }

  // ─── Anatomical zone cache ───────────────────────────────────────────────
  /**
   * Precompute every facial zone weight once per texel.
   *
   * The diffuse and roughness passes each evaluated about a dozen 3D Gaussians
   * per texel — roughly 2.6 million Math.exp calls per regenerate at 512, and
   * four times that at 1024. None of it depends on a single slider: the zones
   * are functions of the position map alone, which only changes when the mesh
   * is rebuilt. Caching them moves that entire cost out of the interactive
   * path, which is what makes a higher macro resolution affordable at all.
   *
   * Stored as Uint8 rather than Float32: these are soft masks multiplying
   * colour deltas of at most ~20/255, so a quantisation step of 1/255 is two
   * orders of magnitude below anything visible, and it keeps the cache at 3MB
   * instead of 12MB per resolution step.
   */
  _buildZoneCache() {
    const R = this.RES;
    const N = R * R;
    const pm = this._posMap;

    const names = ['cheek', 'nose', 'ear', 'underEye', 'forehead', 'temple',
                   'chin', 'beard', 'lip', 'tzone', 'roughCheek', 'roughLip'];
    const z = {};
    for (const n of names) z[n] = new Uint8Array(N);

    if (!this._hasPosMap) {
      this._zoneCache = z;
      return z;
    }

    const q = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0);

    for (let i = 0; i < N; i++) {
      const p3 = i * 3;
      const px = pm[p3], py = pm[p3 + 1], pz = pm[p3 + 2];

      z.cheek[i] = q(Math.max(
        this._gw3d(px, py, pz, -0.40, -0.15, 0.95, 0.20, 0.18, 0.25),
        this._gw3d(px, py, pz, 0.40, -0.15, 0.95, 0.20, 0.18, 0.25)));

      z.nose[i] = q(this._gw3d(px, py, pz, 0, 0.02, 1.30, 0.08, 0.12, 0.15));

      z.ear[i] = q(Math.max(
        this._gw3d(px, py, pz, -0.80, 0.15, -0.05, 0.15, 0.20, 0.20),
        this._gw3d(px, py, pz, 0.80, 0.15, -0.05, 0.15, 0.20, 0.20)));

      z.underEye[i] = q(Math.max(
        this._gw3d(px, py, pz, -0.30, 0.16, 0.98, 0.10, 0.05, 0.15),
        this._gw3d(px, py, pz, 0.30, 0.16, 0.98, 0.10, 0.05, 0.15)));

      z.forehead[i] = q(this._gw3d(px, py, pz, 0, 0.60, 1.07, 0.30, 0.15, 0.25));

      z.temple[i] = q(Math.max(
        this._gw3d(px, py, pz, -0.60, 0.35, 0.70, 0.15, 0.15, 0.20),
        this._gw3d(px, py, pz, 0.60, 0.35, 0.70, 0.15, 0.15, 0.20)));

      z.chin[i] = q(this._gw3d(px, py, pz, 0, -0.60, 1.08, 0.15, 0.12, 0.20));

      z.beard[i] = q(Math.max(
        this._gw3d(px, py, pz, 0, -0.62, 1.02, 0.34, 0.16, 0.34),
        this._gw3d(px, py, pz, 0, -0.22, 1.14, 0.16, 0.05, 0.12)));

      z.lip[i] = q(this._gw3d(px, py, pz, 0, -0.30, 1.12, 0.15, 0.06, 0.12));

      // Roughness pass zones — same regions, different radii.
      z.tzone[i] = q(Math.max(
        this._gw3d(px, py, pz, 0, 0.60, 1.07, 0.25, 0.15, 0.25),
        this._gw3d(px, py, pz, 0, 0.02, 1.30, 0.08, 0.15, 0.15),
        this._gw3d(px, py, pz, 0, -0.60, 1.08, 0.12, 0.10, 0.20)));

      z.roughCheek[i] = q(Math.max(
        this._gw3d(px, py, pz, -0.40, -0.15, 0.95, 0.18, 0.18, 0.25),
        this._gw3d(px, py, pz, 0.40, -0.15, 0.95, 0.18, 0.18, 0.25)));

      z.roughLip[i] = z.lip[i];
    }

    this._zoneCache = z;
    return z;
  }

  /** Zones, built on demand and invalidated whenever the position map is. */
  _zones() {
    if (!this._zoneCache) this._buildZoneCache();
    return this._zoneCache;
  }

  // ─── 3D Gaussian weight for facial regions ────────────────────────────────
  // All coordinates are in model space (Y-up, Z-forward)
  _gw3d(px, py, pz, cx, cy, cz, rx, ry, rz) {
    const dx = (px - cx) / rx, dy = (py - cy) / ry, dz = (pz - cz) / rz;
    return Math.exp(-(dx*dx + dy*dy + dz*dz) * 0.5);
  }

  // ─── Wrinkle regions in 3D model space ────────────────────────────────────
  // These use the actual 3D coordinates from OBJMorpher landmarks
  static get WRINKLE_REGIONS_3D() {
    return {
      forehead:    { dir:'h', x:0, y:0.60, z:1.07, rx:0.35, ry:0.12, rz:0.3, str:1.0, onset:25, n:5 },
      glabella:    { dir:'v', x:0, y:0.38, z:1.08, rx:0.08, ry:0.08, rz:0.2, str:0.8, onset:30, n:3 },
      crowsFeetL:  { dir:'r', x:-0.45, y:0.22, z:0.95, rx:0.12, ry:0.10, rz:0.2, str:0.9, onset:30, n:5 },
      crowsFeetR:  { dir:'r', x:0.45, y:0.22, z:0.95, rx:0.12, ry:0.10, rz:0.2, str:0.9, onset:30, n:5 },
      nasolabialL: { dir:'dl', x:-0.20, y:-0.15, z:1.10, rx:0.10, ry:0.20, rz:0.2, str:1.0, onset:25, n:2 },
      nasolabialR: { dir:'dr', x:0.20, y:-0.15, z:1.10, rx:0.10, ry:0.20, rz:0.2, str:1.0, onset:25, n:2 },
      underEyeL:   { dir:'h', x:-0.30, y:0.16, z:0.98, rx:0.12, ry:0.06, rz:0.2, str:0.6, onset:35, n:3 },
      underEyeR:   { dir:'h', x:0.30, y:0.16, z:0.98, rx:0.12, ry:0.06, rz:0.2, str:0.6, onset:35, n:3 },
      lipLines:    { dir:'v', x:0, y:-0.25, z:1.15, rx:0.15, ry:0.06, rz:0.15, str:0.5, onset:45, n:8 },
      marionette:  { dir:'v', x:0, y:-0.40, z:1.10, rx:0.18, ry:0.10, rz:0.2, str:0.7, onset:50, n:2 },
      neckLines:   { dir:'h', x:0, y:-0.70, z:0.80, rx:0.40, ry:0.08, rz:0.4, str:0.5, onset:40, n:3 },
    };
  }

  // ─── Initialization ───────────────────────────────────────────────────────
  init(meshGroup) {
    this.meshGroup = meshGroup;
    const R = this.RES;

    this._diffuseCanvas = document.createElement('canvas');
    this._diffuseCanvas.width = R; this._diffuseCanvas.height = R;
    this._normalCanvas = document.createElement('canvas');
    this._normalCanvas.width = R; this._normalCanvas.height = R;
    this._roughnessCanvas = document.createElement('canvas');
    this._roughnessCanvas.width = R; this._roughnessCanvas.height = R;
    // Thickness is anatomy, not a slider result, so it is generated once at
    // init and never touched again by regenerate().
    this._thicknessCanvas = document.createElement('canvas');
    this._thicknessCanvas.width = R; this._thicknessCanvas.height = R;

    this.diffuseTexture = new THREE.CanvasTexture(this._diffuseCanvas);
    this.diffuseTexture.colorSpace = THREE.SRGBColorSpace;
    this.diffuseTexture.flipY = false;
    this.normalTexture = new THREE.CanvasTexture(this._normalCanvas);
    this.normalTexture.flipY = false;
    this.roughnessTexture = new THREE.CanvasTexture(this._roughnessCanvas);
    this.roughnessTexture.flipY = false;
    this.thicknessTexture = new THREE.CanvasTexture(this._thicknessCanvas);
    this.thicknessTexture.flipY = false;
    this.thicknessTexture.colorSpace = THREE.NoColorSpace;

    this._ensureUVs();
    this._buildPositionMap();
    this._generateThicknessMap();
    this.thicknessTexture.needsUpdate = true;
    this._initialized = true;

    setTimeout(() => {
      this.regenerate();
      console.log('[SkinTexture] Initial textures generated');
    }, 100);
  }

  _ensureUVs() {
    if (!this.meshGroup) return;
    this.meshGroup.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      if (child.geometry.attributes.uv) return;
      const pos = child.geometry.attributes.position;
      const count = pos.count;
      const uvs = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const len = Math.sqrt(x*x + y*y + z*z) || 1;
        uvs[i*2] = 0.5 + Math.atan2(x, z) / (2 * Math.PI);
        uvs[i*2+1] = Math.acos(Math.max(-1, Math.min(1, y/len))) / Math.PI;
      }
      child.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    });
  }

  /**
   * Change the macro map resolution and rebuild everything derived from it.
   *
   * Every cache below is keyed on or sized by RES, so all of them have to go:
   * the noise fields are per-resolution, the wrinkle bounding boxes are in
   * texel coordinates, and the zone weights and position map are one entry per
   * texel. Missing any one of them reads past the end of a stale array.
   */
  setResolution(res) {
    const r = Math.max(256, Math.min(2048, res | 0));
    if (r === this.RES) return this.RES;
    this.RES = r;

    if (!this._initialized) return this.RES;

    for (const c of [this._diffuseCanvas, this._normalCanvas,
                     this._roughnessCanvas, this._thicknessCanvas]) {
      if (c) { c.width = r; c.height = r; }
    }

    this._noiseCache.clear();
    this._regionBoundsCache = null;
    this._zoneCache = null;

    this._buildPositionMap();
    this._generateThicknessMap();
    this.thicknessTexture.needsUpdate = true;

    // The painters hold their own R-sized buffers keyed to the old resolution.
    if (this.wrinklePainter && typeof this.wrinklePainter.resize === 'function') {
      this.wrinklePainter.resize(r);
    }
    if (this.pigmentationPainter && typeof this.pigmentationPainter.resize === 'function') {
      this.pigmentationPainter.resize(r);
    }

    this.regenerate();
    console.log('[SkinTexture] Resolution set to ' + r);
    return this.RES;
  }

  // ─── Setters ──────────────────────────────────────────────────────────────
  setParam(key, value) {
    if (this.params[key] === undefined) return;
    // Boolean params are toggles; clamping them to 0-100 would coerce them
    // to numbers and break the strict checks in the generators.
    if (typeof this.params[key] === 'boolean') { this.params[key] = !!value; return; }
    this.params[key] = Math.max(0, Math.min(100, value));
    /* Micro relief is a shader uniform, not a texel — it needs no map rebuild,
       so apply it here instead of waiting on the caller's regenerate(). */
    if (key === 'microRelief') this.applyMicroRelief();
  }

  /** Push the current micro relief onto every skin material's pore normal. */
  applyMicroRelief() {
    if (!this.meshGroup || !window.SkinShader) return;
    const poreScale = SkinTextureSystem.microReliefToPoreScale(this.params.microRelief);
    this.meshGroup.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      SkinShader.setParams(child.material, { poreScale });
    });
  }
  setSkinColor(hex) {
    this._skinColorHex = hex;
    if (this._initialized) this.regenerate();
  }
  getParams() { return { ...this.params }; }
  loadState(state) {
    if (!state) return;
    Object.keys(state).forEach(k => { if (this.params[k] !== undefined) this.params[k] = state[k]; });
    if (state.skinColor) this._skinColorHex = state.skinColor;
    this.applyMicroRelief();
    if (this._initialized) this.regenerate();
  }

  // ─── Regenerate ───────────────────────────────────────────────────────────
  regenerate() {
    if (!this._initialized) return;
    const t0 = performance.now();
    this._generateDiffuseMap();
    this._generateNormalMap();
    this._generateRoughnessMap();
    this.diffuseTexture.needsUpdate = true;
    this.normalTexture.needsUpdate = true;
    this.roughnessTexture.needsUpdate = true;
    this._applyToMesh();
    console.log(`[SkinTexture] Regenerated in ${(performance.now() - t0).toFixed(1)}ms`);
  }

  // ─── Diffuse Map (uses 3D position map for zone placement) ────────────────
  _generateDiffuseMap() {
    const R = this.RES;
    const ctx = this._diffuseCanvas.getContext('2d');
    const { age, freckles, sunDamage, poreDetail, cheekFlush } = this.params;
    const baseColor = this._hexToRgb(this._skinColorHex);

    ctx.fillStyle = this._skinColorHex;
    ctx.fillRect(0, 0, R, R);
    const imgData = ctx.getImageData(0, 0, R, R);
    const d = imgData.data;
    const hasPos = this._hasPosMap;

    /* Melanin and haemoglobin, as two independent fields.
       Every existing noise field below drives r, g and b through one fixed
       ratio, so all of the variation sat on a single light/dark axis — the
       skin got brighter and darker but never changed colour, which is most of
       why it reads as painted plastic. The two pigments that actually colour
       skin sit at different depths, are produced by unrelated structures, and
       vary independently: melanin is epidermal and yellow-brown, haemoglobin
       is dermal and red. Uncorrelated seeds are the whole point — it is the
       independence that makes skin look mottled rather than merely noisy. */
    const hemoVar   = this._cachedFractal(R, 910, 3, 0.60);
    const melVar    = this._cachedFractal(R, 920, 4, 0.50);
    const colorVar  = this._cachedFractal(R, 200, 4, 0.55);
    const largeVar  = this._cachedFractal(R, 400, 2, 0.5);
    const poreNoise = this._cachedFractal(R, 100, 5, 0.5);
    const freckleN  = this._cachedFractal(R, 350, 3, 0.45);
    const ageSpotN  = this._cachedValue(R, 12, 450);
    const microVar  = this._cachedFractal(R, 777, 4, 0.6);

    const ageFactor = Math.max(0, (age - 20) / 80);
    const freckleFactor = freckles / 100;
    const sunFactor = sunDamage / 100;

    const Z = this._zones();
    const INV255 = 1 / 255;

    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const idx = (y * R + x) * 4;
        const ni = y * R + x;

        let r = baseColor.r, g = baseColor.g, b = baseColor.b;

        /* ── Natural noise variation ──
           Weights pulled towards neutral (from 1.3/0.9/0.5 and 1.1/0.7/0.4).
           They were steep enough that these fields swung hue as hard as they
           swung brightness, which pinned colour to luminance: measured across
           the map, chroma tracked luminance at r=0.98, so the skin only ever
           got lighter and darker along one warm-cool ramp. Keeping them close
           to neutral leaves them doing what they are for — broad tonal
           variation — and lets the two pigment fields below own the colour,
           which drops the coupling to r=0.69. */
        const cv = (colorVar[ni] - 0.5) * 28;
        r += cv * 1.15; g += cv * 1.0; b += cv * 0.80;
        const lv = (largeVar[ni] - 0.5) * 18;
        r += lv * 1.05; g += lv * 1.0; b += lv * 0.88;
        const mv = (microVar[ni] - 0.5) * 10;
        r += mv; g += mv * 0.5; b -= mv * 0.3;

        // Haemoglobin: perfusion blotches. Red up, green and blue down.
        const hv = (hemoVar[ni] - 0.5) * 2;
        r += hv * 7.0; g -= hv * 3.4; b -= hv * 2.2;

        /* Melanin: darkens and yellows. Scaled by sun damage because that is
           physically what sun exposure does — it drives melanin production,
           and unevenly. */
        const melAmt = ((melVar[ni] - 0.5) * 2) * (5.5 + sunFactor * 5.0);
        r -= melAmt * 0.55; g -= melAmt * 0.75; b -= melAmt * 1.05;

        if (hasPos) {
          /* Zone weights come from the cache rather than a dozen Math.exp
             calls per texel — see _buildZoneCache(). Identical values, none of
             the per-slider cost. */
          /* Cheek flush. Gated rather than always-on: the nose and ear
             redness below is anatomy every face has, but this bloom sits
             where blush goes and reads as make-up, so it is opt-in. */
          if (cheekFlush) {
            const cheekW = Z.cheek[ni] * INV255;
            r += cheekW * 20; g -= cheekW * 3; b -= cheekW * 9;
          }

          const noseW = Z.nose[ni] * INV255;
          r += noseW * 16; g -= noseW * 3; b -= noseW * 5;

          const earW = Z.ear[ni] * INV255;
          r += earW * 14; g -= earW * 2; b -= earW * 5;

          // Under-eye: darker and bluer, deepening with age.
          const dc = (Z.underEye[ni] * INV255) * (12 + ageFactor * 22);
          r -= dc * 0.7; g -= dc * 0.9; b -= dc * 0.1;

          const fhW = Z.forehead[ni] * INV255;
          r += fhW * 7; g += fhW * 3;

          const tmW = Z.temple[ni] * INV255;
          r -= tmW * 9; g -= tmW * 2; b += tmW * 11;

          const chinW = Z.chin[ni] * INV255;
          r += chinW * 5; g -= chinW * 2;

          // Beard shadow across jaw, chin and upper lip.
          const beardW = Z.beard[ni] * INV255;
          r -= beardW * 13; g -= beardW * 11; b -= beardW * 4;

          /* Lips. The old +9/-1/-3 was a blush, not a vermilion — it left the
             mouth the same colour as the chin, so it read as a crease in the
             face rather than as lips, which is one of the strongest mannequin
             cues there is. The vermilion has no stratum corneum over it, so
             the capillary bed shows through directly: it is both redder and
             darker than the skin around it, and the green channel is what
             carries most of that difference. Kept to a muted rose rather than
             a lipstick red — this has to be right for a male subject with no
             lip colour selected, which is the default an operator sees. */
          const lipW = Z.lip[ni] * INV255;
          r += lipW * 14; g -= lipW * 16; b -= lipW * 10;
        }

        // ── Pore texture ──
        const poreVal = poreNoise[ni];
        if (poreVal < 0.4) {
          const pd = (0.4 - poreVal) * 20 * (poreDetail / 100);
          r -= pd; g -= pd * 0.9; b -= pd * 0.7;
        }

        // ── Freckles ──
        if (freckleFactor > 0 || (ageFactor > 0.3 && sunFactor > 0.1)) {
          const fThr = 0.72 - freckleFactor * 0.25 - sunFactor * ageFactor * 0.15;
          if (freckleN[ni] > fThr) {
            const fs = (freckleN[ni] - fThr) / (1 - fThr);
            r -= fs * fs * 40; g -= fs * fs * 30; b -= fs * fs * 12;
          }
        }

        // ── Age spots ──
        if (ageFactor > 0.15) {
          const sThr = 0.68 - ageFactor * 0.22 - sunFactor * 0.12;
          if (ageSpotN[ni] > sThr) {
            const raw = (ageSpotN[ni] - sThr) / (1 - sThr);
            const ss = raw * raw * ageFactor * (0.5 + colorVar[ni] * 0.5);
            r -= ss * 45; g -= ss * 35; b -= ss * 15;
          }
        }

        // ── Aging: desaturation + yellowing ──
        if (ageFactor > 0) {
          const da = ageFactor * 0.2;
          const avg = (r + g + b) / 3;
          r += (avg-r)*da; g += (avg-g)*da; b += (avg-b)*da;
          r += ageFactor * 6; g += ageFactor * 2; b -= ageFactor * 5;
        }

        // ── Manual pigmentation painting (lerp blend) ──
        if (this.pigmentationPainter) {
          const pigMap = this.pigmentationPainter.getPigmentMap();
          const colMap = this.pigmentationPainter.getColorMap();
          if (pigMap) {
            const intensity = pigMap[ni];
            if (intensity > 0.001) {
              const ci3 = ni * 3;
              const pr = colMap[ci3], pg = colMap[ci3+1], pb = colMap[ci3+2];
              r = r * (1 - intensity) + pr * intensity;
              g = g * (1 - intensity) + pg * intensity;
              b = b * (1 - intensity) + pb * intensity;
            }
          }
        }

        d[idx]   = r < 0 ? 0 : r > 255 ? 255 : (r|0);
        d[idx+1] = g < 0 ? 0 : g > 255 ? 255 : (g|0);
        d[idx+2] = b < 0 ? 0 : b > 255 ? 255 : (b|0);
        d[idx+3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // ─── Normal Map (wrinkles use 3D positions) ───────────────────────────────
  _generateNormalMap() {
    const R = this.RES;
    const ctx = this._normalCanvas.getContext('2d');
    const { age, wrinkleDepth, poreDetail } = this.params;
    const imgData = ctx.createImageData(R, R);
    const d = imgData.data;
    const hm = new Float32Array(R * R);
    const pm = this._posMap;
    const hasPos = this._hasPosMap;

    // Pore detail
    const poreN = this._cachedFractal(R, 500, 4, 0.55);
    const poreFine = this._cachedFractal(R, 501, 3, 0.5);
    const poreMicro = this._cachedValue(R, 128, 502);
    const pStr = (poreDetail / 100) * 0.6;
    for (let i = 0, n = R*R; i < n; i++) {
      hm[i] = (poreN[i]-0.5)*pStr + (poreFine[i]-0.5)*pStr*0.4 + (poreMicro[i]-0.5)*pStr*0.15;
    }

    // 3D-position-based wrinkles
    if (hasPos) {
      const ageFactor = Math.max(0, (age - 15) / 85);
      const wStr = (wrinkleDepth / 100) * ageFactor;
      if (wStr > 0.01) {
        const regions = SkinTextureSystem.WRINKLE_REGIONS_3D;
        const bounds = this._regionBounds();
        for (const [name, rgn] of Object.entries(regions)) {
          if (age < rgn.onset) continue;
          const rAge = (age - rgn.onset) / (100 - rgn.onset);
          const lStr = rAge * rgn.str * wStr;
          if (lStr > 0.01) this._drawWrinkles3D(hm, R, pm, rgn, lStr, bounds[name]);
        }
      }
    }

    // Composite manual wrinkle painting on top
    if (this.wrinklePainter) {
      const manualHM = this.wrinklePainter.getHeightMap();
      if (manualHM) {
        for (let i = 0, n = R * R; i < n; i++) {
          hm[i] += manualHM[i];
        }
      }
    }

    // Convert height → normal
    const nStr = 5.0;
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const idx = y * R + x;
        const dxH = (hm[((x+1)%R) + y*R] - hm[((x-1+R)%R) + y*R]) * nStr;
        const dyH = (hm[x + ((y+1)%R)*R] - hm[x + ((y-1+R)%R)*R]) * nStr;
        let nx = -dxH, ny = -dyH, nz = 1.0;
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
        nx /= len; ny /= len; nz /= len;
        const pi = idx * 4;
        d[pi]   = ((nx*0.5+0.5)*255)|0;
        d[pi+1] = ((ny*0.5+0.5)*255)|0;
        d[pi+2] = ((nz*0.5+0.5)*255)|0;
        d[pi+3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  /**
   * UV-space bounding box of each wrinkle region, derived once from the
   * position map.
   *
   * A forehead crease occupies a few percent of the texture, but the drawing
   * loop below used to sweep the entire R*R grid once per wrinkle LINE — with
   * eleven regions of 2-8 lines each that is up to ~40 full-grid sweeps per
   * regenerate, i.e. ~10M iterations at 512 and ~42M at 1024, almost all of it
   * spent on texels that fail the `regionW < 0.02` test immediately.
   *
   * Bounding the sweep makes resolution close to free here, which is what pays
   * for the move to 1024.
   */
  _regionBounds() {
    if (this._regionBoundsCache) return this._regionBoundsCache;

    const R = this.RES;
    const pm = this._posMap;
    const bounds = {};
    const regions = SkinTextureSystem.WRINKLE_REGIONS_3D;

    for (const [name, rgn] of Object.entries(regions)) {
      let minX = R, maxX = -1, minY = R, maxY = -1;

      for (let py = 0; py < R; py++) {
        for (let px = 0; px < R; px++) {
          const pi3 = (py * R + px) * 3;
          const vx = pm[pi3], vy = pm[pi3 + 1], vz = pm[pi3 + 2];
          if (vx === 0 && vy === 0 && vz === 0) continue;

          // Same falloff test the draw loop applies, at its cutoff.
          const dx = (vx - rgn.x) / rgn.rx;
          const dy = (vy - rgn.y) / rgn.ry;
          const dz = (vz - rgn.z) / rgn.rz;
          if (Math.exp(-(dx * dx + dy * dy + dz * dz) * 1.5) < 0.02) continue;

          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }

      // A couple of texels of slack so the Gaussian tail is not clipped.
      bounds[name] = maxX < 0 ? null : {
        minX: Math.max(0, minX - 2), maxX: Math.min(R - 1, maxX + 2),
        minY: Math.max(0, minY - 2), maxY: Math.min(R - 1, maxY + 2),
      };
    }

    this._regionBoundsCache = bounds;
    return bounds;
  }

  /** Draw wrinkle lines using 3D position data for correct placement. */
  _drawWrinkles3D(hm, R, pm, rgn, strength, bounds) {
    const { dir, x: cx, y: cy, z: cz, rx, ry, rz, n: count } = rgn;
    this._resetSeed(Math.floor((cx+5)*1000 + (cy+5)*7777));

    // No texel in this region's footprint — nothing to draw.
    if (!bounds) return;
    const bx0 = bounds.minX, bx1 = bounds.maxX;
    const by0 = bounds.minY, by1 = bounds.maxY;

    for (let li = 0; li < count; li++) {
      const oY = (this._rng() - 0.5) * ry * 1.2;
      const oX = (this._rng() - 0.5) * rx * 1.2;
      const wb = 0.02 + this._rng() * 0.02;

      for (let py = by0; py <= by1; py++) {
        for (let px = bx0; px <= bx1; px++) {
          const pi3 = (py * R + px) * 3;
          const vx = pm[pi3], vy = pm[pi3+1], vz = pm[pi3+2];
          if (vx === 0 && vy === 0 && vz === 0) continue;

          // Distance from region center in 3D
          const dx = (vx - cx) / rx;
          const dy = (vy - cy) / ry;
          const dz = (vz - cz) / rz;
          const regionW = Math.exp(-(dx*dx + dy*dy + dz*dz) * 1.5);
          if (regionW < 0.02) continue;

          let lineVal = 0;

          if (dir === 'h') {
            // Horizontal wrinkle: varies along Y
            const lineY = cy + oY + (li - count/2) * (ry * 2 / count);
            const dist = vy - lineY;
            lineVal = Math.exp(-(dist*dist) / (2*wb*wb));
          } else if (dir === 'v') {
            // Vertical wrinkle: varies along X
            const lineX = cx + oX + (li - count/2) * (rx * 2 / count);
            const dist = vx - lineX;
            lineVal = Math.exp(-(dist*dist) / (2*wb*wb));
          } else if (dir === 'r') {
            // Radial wrinkle (crow's feet)
            const angle = (li / count) * Math.PI * 0.8 - Math.PI * 0.4;
            const ldx = vx - cx, ldy = vy - cy;
            const proj = ldx * Math.cos(angle) + ldy * Math.sin(angle);
            const perp = Math.abs(-ldx * Math.sin(angle) + ldy * Math.cos(angle));
            if (proj > 0) lineVal = Math.exp(-(perp*perp)/(2*wb*wb)) * Math.min(1, proj*8);
          } else if (dir === 'dl' || dir === 'dr') {
            // Diagonal (nasolabial)
            const angle = dir === 'dl' ? -0.7 : 0.7;
            const rotD = (vx - cx) * Math.cos(angle) - (vy - cy) * Math.sin(angle);
            lineVal = Math.exp(-(rotD*rotD) / (2*wb*wb));
          }

          hm[py * R + px] += -lineVal * regionW * strength * 0.6;
        }
      }
    }
  }

  // ─── Roughness Map (3D-position based zones) ─────────────────────────────
  _generateRoughnessMap() {
    const R = this.RES;
    const ctx = this._roughnessCanvas.getContext('2d');
    const baseR = this.params.roughness / 100;
    const oil = this.params.skinOiliness / 100;
    const ageFactor = Math.max(0, (this.params.age - 20) / 80);
    const hasPos = this._hasPosMap;

    const imgData = ctx.createImageData(R, R);
    const dd = imgData.data;
    const rNoise = this._cachedFractal(R, 600, 3, 0.5);
    /* Two more fields, on their own seeds. A single octave set gave the whole
       face one roughness signature, so every part of it caught the light the
       same way. Real skin has patches that are drier or oilier than their
       neighbours for no reason the anatomy zones below know about, and the
       specular breakup that produces is what stops a cheek reading as one
       moulded surface. Deliberately uncorrelated with the colour fields:
       roughness and pigment are not the same thing. */
    const rBlotch = this._cachedFractal(R, 640, 2, 0.65);
    const rFine   = this._cachedFractal(R, 660, 4, 0.45);
    const Z = this._zones();
    const INV255 = 1 / 255;

    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const ni = y * R + x;
        let rough = baseR + (rNoise[ni] - 0.5) * 0.15
                  + (rBlotch[ni] - 0.5) * 0.18
                  + (rFine[ni] - 0.5) * 0.07;

        if (hasPos) {
          /* T-zone oilier (forehead, nose, chin). Oiliness has to work within
             a narrower roughness band now, so it gets more authority over it —
             this is the gradient that makes a forehead read as skin rather
             than as painted plastic. */
          rough -= (Z.tzone[ni] * INV255) * (0.18 + oil * 0.45);

          // Cheeks rougher
          rough += (Z.roughCheek[ni] * INV255) * 0.08;

          /* Lips are wet; they are the glossiest part of a face by a wide
             margin, and reading as matte is instantly wrong. */
          rough -= (Z.roughLip[ni] * INV255) * 0.34;
        }

        rough += ageFactor * 0.12;

        /* Compress into the range skin actually occupies. The slider's 0-100
           mapped straight onto 0-1 roughness, so the default sat near 0.5 and
           aging pushed it past 0.7 — fully matte, no specular lobe at all,
           which is a large part of why the face read as clay. Measured skin
           sits around 0.30 (a shiny nose) to 0.62 (a dry cheek). */
        rough = 0.28 + rough * 0.36;
        rough = rough < 0.18 ? 0.18 : rough > 0.72 ? 0.72 : rough;
        const val = (rough * 255) | 0;
        const idx = ni * 4;
        dd[idx] = val; dd[idx+1] = val; dd[idx+2] = val; dd[idx+3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // ─── Thickness Map (drives subsurface back-scatter) ──────────────────────
  /**
   * How much light can pass all the way through the flesh at each texel.
   *
   * Held up to a lamp, an ear glows orange and the wings of a nose go
   * translucent, because there are only a couple of millimetres of tissue
   * there. A forehead over bone does not. Rendering every part of a face as
   * equally opaque is one of the clearest CG tells there is, and it is exactly
   * what the material did before this map existed.
   *
   * Written by hand from anatomy rather than measured off the mesh: the exact
   * 3D coordinates of the ears, nose and lips are already established in this
   * file for the diffuse zones, and _gw3d() already blends between them.
   */
  _generateThicknessMap() {
    const R = this.RES;
    const ctx = this._thicknessCanvas.getContext('2d');
    const imgData = ctx.createImageData(R, R);
    const d = imgData.data;
    const pm = this._posMap;

    if (!this._hasPosMap) {
      for (let i = 0, n = R * R; i < n; i++) {
        const idx = i * 4;
        d[idx] = d[idx+1] = d[idx+2] = 0; d[idx+3] = 255;
      }
      ctx.putImageData(imgData, 0, 0);
      return;
    }

    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const ni = y * R + x;
        const pi3 = ni * 3;
        const px = pm[pi3], py = pm[pi3+1], pz = pm[pi3+2];

        // Ears — the thinnest part of a head by a wide margin.
        const ear = Math.max(
          this._gw3d(px, py, pz, -0.82, 0.15, -0.05, 0.13, 0.22, 0.18),
          this._gw3d(px, py, pz,  0.82, 0.15, -0.05, 0.13, 0.22, 0.18));

        // Nostril wings and the septum.
        const nose = this._gw3d(px, py, pz, 0, -0.05, 1.32, 0.11, 0.09, 0.10);

        // Lips.
        const lip = this._gw3d(px, py, pz, 0, -0.30, 1.13, 0.17, 0.07, 0.12);

        // Eyelids.
        const lid = Math.max(
          this._gw3d(px, py, pz, -0.30, 0.24, 1.00, 0.11, 0.05, 0.12),
          this._gw3d(px, py, pz,  0.30, 0.24, 1.00, 0.11, 0.05, 0.12));

        // Flesh over the jaw and cheek — some transmission, far less.
        const cheek = Math.max(
          this._gw3d(px, py, pz, -0.44, -0.18, 0.92, 0.18, 0.20, 0.22),
          this._gw3d(px, py, pz,  0.44, -0.18, 0.92, 0.18, 0.20, 0.22));

        let t = Math.max(ear * 1.0, nose * 0.85, lip * 0.75, lid * 0.7, cheek * 0.22);
        t = t < 0 ? 0 : t > 1 ? 1 : t;

        const val = (t * 255) | 0;
        const idx = ni * 4;
        d[idx] = val; d[idx+1] = val; d[idx+2] = val; d[idx+3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  // ─── Apply to mesh ────────────────────────────────────────────────────────
  _applyToMesh() {
    if (!this.meshGroup) return;
    this.meshGroup.traverse((child) => {
      if (!child.isMesh || !child.material) return;
      const mat = child.material;
      mat.map = this.diffuseTexture;
      mat.color.set(0xffffff);
      mat.normalMap = this.normalTexture;

      /* Was 1.5. The macro normal map now carries only the large forms —
         wrinkles and folds — because pore-scale detail moved to the tiled
         detail normal in SkinShader, which is the only place it can actually
         resolve. Overdriving this one on top of that double-counts the
         high frequencies and turns skin crunchy. */
      mat.normalScale = new THREE.Vector2(0.85, 0.85);

      mat.roughnessMap = this.roughnessTexture;
      /* roughness multiplies the map, so it must stay at 1.0 for the map's
         own values (now compressed into skin's real 0.28-0.62 band by
         _generateRoughnessMap) to survive unscaled. */
      mat.roughness = 1.0;
      mat.metalness = 0.0;

      /* Drive the oily epidermal lobe from the same map.
         The clearcoat had no map at all, so the second specular layer was
         perfectly uniform across the whole face — one glossy veneer of
         constant tightness over forehead, cheek and jaw alike. Nothing on a
         real face is uniform like that, and a constant sheen is read as
         moulded plastic no matter how good the diffuse underneath is.
         Reusing the roughness map (clearcoat samples green; the map is grey,
         so the channel does not matter) makes the T-zone carry a tight wet
         highlight while the cheeks stay broad and soft, which is the actual
         difference between the two on skin. */
      mat.clearcoatRoughnessMap = this.roughnessTexture;

      /* Was 0.4, which quietly halved the contribution of the studio IBL —
         the single most important light in the scene — every time the skin
         textures regenerated, overriding what SceneManager had set. Read from
         SceneManager now rather than repeating the number, because this
         assignment runs last on every slider tick and so wins any disagreement:
         a literal here silently overrides the material definition. */
      mat.envMapIntensity = window.SceneManager
        ? SceneManager.SKIN.envMapIntensity : 0.9;

      mat.vertexColors = false;

      if (window.SkinShader) {
        SkinShader.setThicknessMap(mat, this.thicknessTexture);
        SkinShader.setParams(mat, {
          poreScale: SkinTextureSystem.microReliefToPoreScale(this.params.microRelief),
        });
      }

      mat.needsUpdate = true;
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  _hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) }
             : { r: 203, g: 154, b: 120 };
  }

  dispose() {
    if (this.diffuseTexture) this.diffuseTexture.dispose();
    if (this.normalTexture) this.normalTexture.dispose();
    if (this.roughnessTexture) this.roughnessTexture.dispose();
    if (this.thicknessTexture) this.thicknessTexture.dispose();
    if (this.meshGroup) {
      this.meshGroup.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        child.material.map = null;
        child.material.normalMap = null;
        child.material.roughnessMap = null;
        if (window.SkinShader) SkinShader.setThicknessMap(child.material, null);
        child.material.roughness = 0.5;
        child.material.metalness = 0.02;
        child.material.color.set(this._skinColorHex);
        child.material.needsUpdate = true;
      });
    }
    this._initialized = false;
  }
}

window.SkinTextureSystem = SkinTextureSystem;
