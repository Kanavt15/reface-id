/**
 * SkinTextureSystem.js
 * Procedural skin texture generator with aging effects for Three.js face models.
 *
 * KEY DESIGN: Rasterizes UV triangles into a continuous 3D position map, with
 * padded island borders. Facial zone effects (cheeks, forehead, wrinkles)
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

       These maps carry anatomical colour zones, freckles, age spots and
       painted wrinkles. Pore-scale detail deliberately
       does NOT live here: at any resolution a pore is sub-texel across a whole
       head, so it comes from the tiled detail normal in SkinShader instead,
       which is resolution-independent.

       High increases the macro-map resolution at extra regeneration cost.
       The authored anatomy fields are shared 2048px maps at every tier. */
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

    this.diffuseTexture = null;
    this.normalTexture = null;
    this.roughnessTexture = null;
    this.thicknessTexture = null;

    // UV→3D position map: for each texture pixel, stores the 3D world position
    // This is the key to placing facial zones correctly regardless of UV layout
    this._posMap = null;   // Float32Array(R*R*3) — xyz per pixel
    this._hasPosMap = false;

    /* Per-texel UV stretch and tangent frame, built alongside the position
       map from the index buffer. See _buildPositionMap(). */
    this._uvDensity = null;   // Float32Array(R*R): log2(local mm-per-UV / mean), encoded 0..1
    this._tanMap = null;      // Float32Array(R*R*6): object-space T (+u) and B (+v)
    this._mmPerUV = 450;      // millimetres of skin per UV unit, whole-mesh mean
    this._thicknessData = null;

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
      age: 30, roughness: 50, freckles: 0,
      poreDetail: 0, wrinkleDepth: 100, skinOiliness: 0, sunDamage: 10,
      underEyeEnabled: false, underEyeIntensity: 50,
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

  /** A field derived from the noise fields by a pure per-texel function. */
  _cachedDerived(name, R, build) {
    const key = 'd' + R + '_' + name;
    let v = this._noiseCache.get(key);
    if (!v) { v = build(); this._noiseCache.set(key, v); }
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
  // Seed vertices, interpolate triangle interiors, then pad UV-island borders.
  // Positions stay in the same local frame as the authored anatomy zones.

  _buildPositionMap() {
    const R = this.RES;
    this._posMap = new Float32Array(R * R * 3);
    const hasData = new Uint8Array(R * R); // 1 = has position data

    let yMin = 1e9, yMax = -1e9;
    let cx = 0, cy = 0, cz = 0, cnt = 0;

    /* UV stretch and tangent frame, per vertex, from the index buffer.

       The detail tiles in SkinShader repeat a fixed number of times per UV
       unit. Where the unwrap squeezes a lot of surface into little UV — the
       nose on the shipped head — each tile then covers several times more
       skin, and pores came out several times larger there than on the cheek.
       That was the polygonal blotching on the nose tip. sqrt(area3D/areaUV)
       per triangle is exactly the correction factor; the shader multiplies the
       tile repeat by it.

       The tangent frame (dP/du, dP/dv) is what turns "horizontal on the
       forehead" into a direction on the tile: the oriented-ridge field is
       rotated into it by _generateThicknessMap(). Both are derived from the
       triangles rather than from finite differences of the flood-filled
       position map, which is constant inside every filled patch. */
    const densRaw = new Float32Array(R * R);
    const tanRaw = new Float32Array(R * R * 6);
    let sumA3D = 0, sumAUV = 0;

    this.meshGroup.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      const pos = child.geometry.attributes.position;
      const uv = child.geometry.attributes.uv;
      if (!pos || !uv) return;

      const N = pos.count;
      const vRatio = new Float32Array(N);
      const vW = new Float32Array(N);
      const vT = new Float32Array(N * 3);
      const vB = new Float32Array(N * 3);
      const index = child.geometry.index;
      if (index) {
        const idx = index.array;
        for (let t = 0; t < idx.length; t += 3) {
          const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
          const e1x = pos.getX(i1) - pos.getX(i0), e1y = pos.getY(i1) - pos.getY(i0), e1z = pos.getZ(i1) - pos.getZ(i0);
          const e2x = pos.getX(i2) - pos.getX(i0), e2y = pos.getY(i2) - pos.getY(i0), e2z = pos.getZ(i2) - pos.getZ(i0);
          const du1 = uv.getX(i1) - uv.getX(i0), dv1 = uv.getY(i1) - uv.getY(i0);
          const du2 = uv.getX(i2) - uv.getX(i0), dv2 = uv.getY(i2) - uv.getY(i0);
          const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
          const a3d = Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5;
          const det = du1 * dv2 - du2 * dv1;
          const auv = Math.abs(det) * 0.5;
          if (a3d < 1e-12 || auv < 1e-12) continue;
          sumA3D += a3d; sumAUV += auv;
          const ratio = Math.sqrt(a3d / auv);
          const inv = 1 / det;
          let tx = (e1x * dv2 - e2x * dv1) * inv, ty = (e1y * dv2 - e2y * dv1) * inv, tz = (e1z * dv2 - e2z * dv1) * inv;
          let bx = (e2x * du1 - e1x * du2) * inv, by = (e2y * du1 - e1y * du2) * inv, bz = (e2z * du1 - e1z * du2) * inv;
          const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1, bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
          tx /= tl; ty /= tl; tz /= tl; bx /= bl; by /= bl; bz /= bl;
          for (const vi of [i0, i1, i2]) {
            vRatio[vi] += ratio * a3d; vW[vi] += a3d;
            vT[vi * 3] += tx * a3d; vT[vi * 3 + 1] += ty * a3d; vT[vi * 3 + 2] += tz * a3d;
            vB[vi * 3] += bx * a3d; vB[vi * 3 + 1] += by * a3d; vB[vi * 3 + 2] += bz * a3d;
          }
        }
      }

      for (let i = 0; i < N; i++) {
        const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        const u = uv.getX(i), v = uv.getY(i);

        // UV to pixel
        const tx = Math.floor(u * (R - 1));
        const ty = Math.floor(v * (R - 1));
        if (tx < 0 || tx >= R || ty < 0 || ty >= R) continue;

        const ti = ty * R + tx;
        const pi = ti * 3;
        this._posMap[pi] = px;
        this._posMap[pi + 1] = py;
        this._posMap[pi + 2] = pz;
        hasData[ti] = 1;

        if (vW[i] > 0) {
          densRaw[ti] = vRatio[i] / vW[i];
          const t6 = ti * 6;
          tanRaw[t6] = vT[i * 3]; tanRaw[t6 + 1] = vT[i * 3 + 1]; tanRaw[t6 + 2] = vT[i * 3 + 2];
          tanRaw[t6 + 3] = vB[i * 3]; tanRaw[t6 + 4] = vB[i * 3 + 1]; tanRaw[t6 + 5] = vB[i * 3 + 2];
        }

        if (py < yMin) yMin = py;
        if (py > yMax) yMax = py;
        cx += px; cy += py; cz += pz; cnt++;
      }

      // Interpolate inside UV triangles. Vertex splats alone leave nearest-
      // vertex patches across the face, which show through as polygonal tints
      // and specular zones. The flood fill below is now only island padding.
      const indices = index ? index.array : null;
      const count = indices ? indices.length : N;
      const invR = 1 / (R - 1);
      for (let t = 0; t + 2 < count; t += 3) {
        const a = indices ? indices[t] : t;
        const b = indices ? indices[t + 1] : t + 1;
        const c = indices ? indices[t + 2] : t + 2;
        const ax = uv.getX(a), ay = uv.getY(a);
        const bx = uv.getX(b), by = uv.getY(b);
        const cxUV = uv.getX(c), cyUV = uv.getY(c);
        const det = (by - cyUV) * (ax - cxUV) + (cxUV - bx) * (ay - cyUV);
        if (Math.abs(det) < 1e-12) continue;
        const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cxUV) * (R - 1)));
        const x1 = Math.min(R - 1, Math.floor(Math.max(ax, bx, cxUV) * (R - 1)));
        const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cyUV) * (R - 1)));
        const y1 = Math.min(R - 1, Math.floor(Math.max(ay, by, cyUV) * (R - 1)));
        const wa = vW[a] || 1, wb = vW[b] || 1, wc = vW[c] || 1;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const u = x * invR, v = y * invR;
            const w0 = ((by - cyUV) * (u - cxUV) + (cxUV - bx) * (v - cyUV)) / det;
            const w1 = ((cyUV - ay) * (u - cxUV) + (ax - cxUV) * (v - cyUV)) / det;
            const w2 = 1 - w0 - w1;
            if (Math.min(w0, w1, w2) < -1e-6) continue;
            const i = y * R + x, p = i * 3, ti = i * 6;
            this._posMap[p] = pos.getX(a) * w0 + pos.getX(b) * w1 + pos.getX(c) * w2;
            this._posMap[p + 1] = pos.getY(a) * w0 + pos.getY(b) * w1 + pos.getY(c) * w2;
            this._posMap[p + 2] = pos.getZ(a) * w0 + pos.getZ(b) * w1 + pos.getZ(c) * w2;
            densRaw[i] = vRatio[a] / wa * w0 + vRatio[b] / wb * w1 + vRatio[c] / wc * w2;
            for (let k = 0; k < 3; k++) {
              tanRaw[ti + k] = vT[a * 3 + k] / wa * w0 + vT[b * 3 + k] / wb * w1 + vT[c * 3 + k] / wc * w2;
              tanRaw[ti + k + 3] = vB[a * 3 + k] / wa * w0 + vB[b * 3 + k] / wb * w1 + vB[c * 3 + k] / wc * w2;
            }
            hasData[i] = 1;
          }
        }
      }
    });

    const meanRatio = sumAUV > 0 ? Math.sqrt(sumA3D / sumAUV) : 4.5;
    // Model units are ~100mm per unit (a 2.2-unit head is ~220mm).
    this._mmPerUV = meanRatio * 100;

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
        densRaw[ni] = densRaw[idx];
        const s6 = idx * 6, d6 = ni * 6;
        for (let k = 0; k < 6; k++) tanRaw[d6 + k] = tanRaw[s6 + k];
        hasData[ni] = 1;
        queue[qTail++] = ni;
      }
    }

    /* Density: log ratio to the mean, 5x5 box-blurred so the per-vertex
       steps left by the flood fill do not become visible tile-scale jumps,
       then clamped to ±1.5 octaves and encoded 0..1 with 0.5 at the mean. */
    const logD = new Float32Array(R * R);
    for (let i = 0; i < R * R; i++) {
      const r = densRaw[i] > 0 ? densRaw[i] : meanRatio;
      logD[i] = Math.log2(r / meanRatio);
    }
    const tmp = new Float32Array(R * R);
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        let s = 0;
        for (let k = -2; k <= 2; k++) s += logD[y * R + Math.min(R - 1, Math.max(0, x + k))];
        tmp[y * R + x] = s / 5;
      }
    }
    this._uvDensity = new Float32Array(R * R);
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        let s = 0;
        for (let k = -2; k <= 2; k++) s += tmp[Math.min(R - 1, Math.max(0, y + k)) * R + x];
        const v = Math.max(-1.5, Math.min(1.5, s / 5));
        this._uvDensity[y * R + x] = v / 3 + 0.5;
      }
    }
    this._tanMap = tanRaw;

    this._hasPosMap = true;
    this._zoneCache = null;
    this._regionBoundsCache = null;
    console.log(`[SkinTexture] Position map built: Y range [${yMin.toFixed(2)}, ${yMax.toFixed(2)}], ${cnt} vertices, ${this._mmPerUV.toFixed(0)}mm per UV unit`);
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
    this.diffuseTexture = new THREE.CanvasTexture(this._diffuseCanvas);
    this.diffuseTexture.colorSpace = THREE.SRGBColorSpace;
    this.diffuseTexture.flipY = false;
    this.normalTexture = new THREE.CanvasTexture(this._normalCanvas);
    this.normalTexture.flipY = false;
    this.roughnessTexture = new THREE.CanvasTexture(this._roughnessCanvas);
    this.roughnessTexture.flipY = false;

    this._ensureUVs();
    this._buildPositionMap();
    // Thickness and the surface-control channels are anatomy, not a slider
    // result, so they are generated once here and never touched by regenerate().
    this._buildThicknessTexture();
    this._initialized = true;

    setTimeout(() => {
      this.regenerate();
      console.log('[SkinTexture] Initial textures generated');
    }, 100);
    if (window.SkinShader && SkinShader._anatomyReady) {
      SkinShader._anatomyReady.then(ready => {
        if (ready && this._initialized) this.regenerate();
      });
    }
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

    for (const c of [this._diffuseCanvas, this._normalCanvas, this._roughnessCanvas]) {
      if (c) { c.width = r; c.height = r; }
    }

    this._noiseCache.clear();
    this._regionBoundsCache = null;
    this._zoneCache = null;

    this._buildPositionMap();
    this._buildThicknessTexture();

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
    if (typeof this.params[key] === 'boolean') {
      this.params[key] = !!value;
      if (key === 'underEyeEnabled') this.applyWrinkleControls();
      return;
    }
    this.params[key] = Math.max(0, Math.min(100, value));
    /* Micro relief is a shader uniform, not a texel — it needs no map rebuild,
       so apply it here instead of waiting on the caller's regenerate(). */
    if (key === 'microRelief') this.applyMicroRelief();
    if (key === 'wrinkleDepth' || key === 'underEyeIntensity') this.applyWrinkleControls();
  }

  applyWrinkleControls() {
    this.meshGroup?.traverse(child => {
      if (child.isMesh && window.SkinShader) SkinShader.setParams(child.material, {
        wrinkleStrength: this.params.wrinkleDepth / 100,
        underEyeStrength: this.params.underEyeEnabled ? this.params.underEyeIntensity / 100 : 0,
      });
    });
    // Both manual and eye-local folds have independent shader maps, including
    // when the external skin images are unavailable. No CPU map rebuild here.
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
    this.params = { ...SkinTextureSystem.DEFAULT_PARAMS };
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
    const { age, freckles, sunDamage, cheekFlush } = this.params;
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
    const freckleN  = this._cachedFractal(R, 350, 3, 0.45);
    const ageSpotN  = this._cachedValue(R, 12, 450);
    const microVar  = this._cachedFractal(R, 777, 4, 0.6);
    /* Two fields the old map lacked entirely, and whose absence is most of
       why it read as an airbrush: melanin SPECKLE — pigment is made in
       clusters a fraction of a millimetre across, so real skin colour is
       grainy at every scale, not a smooth gradient — and a capillary field,
       the fine red network that shows through on the nose wings and cheeks
       and thickens with sun damage and age. Both are cached: only the
       compositing runs per slider tick. */
    const speckle   = this._cachedDerived('speckleSharp', R, () => {
      const f = this._cachedFractal(R, 930, 7, 0.55), o = new Float32Array(R * R);
      for (let i = 0; i < R * R; i++) { const v = (f[i] - 0.5) * 2; o[i] = Math.sign(v) * Math.pow(Math.abs(v), 0.7); }
      return o;
    });
    const capillary = this._cachedDerived('capillary', R, () => {
      const f = this._cachedFractal(R, 950, 5, 0.5), o = new Float32Array(R * R);
      for (let i = 0; i < R * R; i++) { const c = 1 - Math.abs(f[i] * 2 - 1); const c3 = c * c * c; o[i] = c3 * c3; }
      return o;
    });

    const ageFactor = Math.max(0, (age - 20) / 80);
    const freckleFactor = freckles / 100;
    const sunFactor = sunDamage / 100;

    /* Pigment offsets scale with the base tone. The same +7 of red is a
       whisper on pale skin and a shout on dark skin, and worse, additive
       offsets on a dark base pull it toward grey. Scaling by luminance keeps
       the RATIO of variation constant across the eight swatches, so a dark
       complexion stays saturated in its shadows instead of going muddy. */
    const baseL = (0.299 * baseColor.r + 0.587 * baseColor.g + 0.114 * baseColor.b) / 255;
    const tone = 0.30 + 0.70 * Math.min(1.3, baseL / 0.62);

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
        const cv = (colorVar[ni] - 0.5) * 36 * tone;
        r += cv * 1.15; g += cv * 1.0; b += cv * 0.80;
        const lv = (largeVar[ni] - 0.5) * 18 * tone;
        r += lv * 1.05; g += lv * 1.0; b += lv * 0.88;
        const mv = (microVar[ni] - 0.5) * 10 * tone;
        r += mv; g += mv * 0.5; b -= mv * 0.3;

        // Haemoglobin: perfusion blotches. Red up, green and blue down.
        const hv = (hemoVar[ni] - 0.5) * 2 * tone;
        r += hv * 16.0; g -= hv * 8.0; b -= hv * 5.0;

        /* Melanin: darkens and yellows. Scaled by sun damage because that is
           physically what sun exposure does — it drives melanin production,
           and unevenly. */
        const melAmt = ((melVar[ni] - 0.5) * 2) * (6.0 + sunFactor * 5.0) * tone;
        r -= melAmt * 0.55; g -= melAmt * 0.75; b -= melAmt * 1.05;

        // Melanin speckle: sharpened so it is grain, not haze.
        const sp = speckle[ni] * 20 * tone * (1 + sunFactor * 0.6);
        r -= sp * 0.9; g -= sp * 1.0; b -= sp * 1.15;

        // Capillaries: ridged noise, thin bright lines, red.
        const cap = capillary[ni];

        if (hasPos) {
          const capW = (Z.nose[ni] * INV255) * 0.9 + (Z.cheek[ni] * INV255) * 0.45;
          const capAmt = cap * capW * (0.5 + sunFactor * 0.8 + ageFactor * 0.6) * 26 * tone;
          r += capAmt; g -= capAmt * 0.55; b -= capAmt * 0.45;

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
          r += lipW * 26 * tone; g -= lipW * 30 * tone; b -= lipW * 16 * tone;
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

    /* No pore-scale content here any more. At ~1mm per texel a "pore" layer
       in this map was just bumpiness at the wrong scale, and it fought the
       properly sized detail tiles in SkinShader. This map carries only the
       large forms: a soft skin undulation, the wrinkle creases, and whatever
       the operator paints. */
    const undul = this._cachedFractal(R, 500, 3, 0.5);
    const uStr = 0.02 + (poreDetail / 100) * 0.03;
    for (let i = 0, n = R*R; i < n; i++) {
      hm[i] = (undul[i] - 0.5) * uStr;
    }

    // Under-eye folds are eye-local shader detail, also in the missing-image
    // fallback. Baking them here would leave stationary folds on the cheeks.

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
    const dNoise  = this._cachedFractal(R, 680, 3, 0.55);
    const Z = this._zones();
    const INV255 = 1 / 255;

    /* Pore density and line gain ride in the R and B channels of this map
       (three reads roughness from G). They are the per-region controls for
       the detail tiles in SkinShader: the tile carries every pore with a
       rank, and a pore is drawn only where its rank is under the density
       here — so the nose is densely pored and an eyelid nearly bare from the
       same tile, without fading the pores into blur. */
    const poreF = this.params.poreDetail / 100;
    const densGain = 0.70 + 0.30 * poreF;
    const lineBase = 0.38 + ageFactor * 0.30 + poreF * 0.15;

    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const ni = y * R + x;
        let rough = baseR + (rNoise[ni] - 0.5) * 0.15
                  + (rBlotch[ni] - 0.5) * 0.22
                  + (rFine[ni] - 0.5) * 0.09;

        // Base pore density: mid-face default, then anatomy.
        let dens = 0.55 + (dNoise[ni] - 0.5) * 0.30;
        let lineG = lineBase;

        if (hasPos) {
          /* T-zone oilier (forehead, nose, chin). Oiliness has to work within
             a narrower roughness band now, so it gets more authority over it —
             this is the gradient that makes a forehead read as skin rather
             than as painted plastic. */
          const tz = Z.tzone[ni] * INV255;
          rough -= tz * (0.18 + oil * 0.45);

          // Cheeks rougher
          const ck = Z.roughCheek[ni] * INV255;
          rough += ck * 0.08;

          /* Lips are wet; they are the glossiest part of a face by a wide
             margin, and reading as matte is instantly wrong. */
          const lp = Z.roughLip[ni] * INV255;
          rough -= lp * 0.34;

          // Pores: dense on the nose and T-zone, medium on the cheeks,
          // almost none on the lips, eyelids and ears.
          const nose = Z.nose[ni] * INV255;
          const ue = Z.underEye[ni] * INV255;
          const ear = Z.ear[ni] * INV255;
          const fh = Z.forehead[ni] * INV255;
          dens += nose * 0.55 + tz * 0.30 + ck * 0.12 + fh * 0.10;
          dens *= (1 - lp * 0.95) * (1 - ue * 0.85) * (1 - ear * 0.8);

          // Lines: the vermilion is heavily furrowed; forehead and eye corners
          // gain with age; the nose has few.
          lineG += lp * 0.45 + fh * 0.15 * ageFactor + ue * 0.2 * ageFactor - nose * 0.2;
        }

        rough += ageFactor * 0.12;

        // Keep a soft surface highlight at the default setting while retaining
        // the difference between an oily nose, dry cheeks and the vermilion.
        rough = 0.48 + rough * 0.26;
        rough = rough < 0.42 ? 0.42 : rough > 0.86 ? 0.86 : rough;

        dens *= densGain;
        dens = dens < 0 ? 0 : dens > 1 ? 1 : dens;
        lineG = lineG < 0 ? 0 : lineG > 1 ? 1 : lineG;

        const idx = ni * 4;
        dd[idx]   = (dens * 255) | 0;
        dd[idx+1] = (rough * 255) | 0;
        dd[idx+2] = (lineG * 255) | 0;
        dd[idx+3] = 255;
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
  /**
   * (Re)create the thickness/control DataTexture at the current resolution.
   *
   * A DataTexture rather than a CanvasTexture because two of its channels are
   * a direction vector and one is a UV-stretch factor: canvas 2D premultiplies
   * RGB by alpha on putImageData, and un-premultiplying on upload would have
   * quantised the thickness wherever the direction vector's alpha was low.
   * DataTextures cannot be resized, so a resolution change makes a new one;
   * _applyToMesh rebinds it on the next regenerate.
   */
  _buildThicknessTexture() {
    const R = this.RES;
    if (this.thicknessTexture) this.thicknessTexture.dispose();
    this._thicknessData = new Uint8Array(R * R * 4);
    this._generateThicknessMap();
    const tex = new THREE.DataTexture(this._thicknessData, R, R, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.thicknessTexture = tex;
    this._tanMap = null; // only needed while the direction field is written
  }

  /**
   * Channel layout: R = thickness, G = UV density (log2 over mean, 0.5 = mean),
   * B/A = line direction as a doubled angle (cos 2θ, sin 2θ) scaled by weight,
   * encoded 0..1.
   *
   * The direction is doubled so that a furrow running "left" and one running
   * "right" are the same vector — a line has no sign — and so that bilinear
   * filtering between two regions with different directions shrinks the
   * vector toward zero (isotropic) instead of swinging through a wrong
   * direction. The weight lives in the length for the same reason.
   */
  _generateThicknessMap() {
    const R = this.RES;
    const d = this._thicknessData;
    const pm = this._posMap;

    if (!this._hasPosMap) {
      for (let i = 0, n = R * R; i < n; i++) {
        const idx = i * 4;
        d[idx] = 0; d[idx+1] = 128; d[idx+2] = 128; d[idx+3] = 128;
      }
      return;
    }

    const Z = this._zones();
    const tan = this._tanMap;
    const dens = this._uvDensity;
    const INV255 = 1 / 255;

    // Direction field entries: [weight, dirX, dirY, dirZ] in object space, or
    // a function of position for the radial (crow's feet) case.
    const H = [1, 0, 0], V = [0, 1, 0];
    const nasL = [-0.45, -1, 0], nasR = [0.45, -1, 0];

    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const ni = y * R + x;
        const pi3 = ni * 3;
        const px = pm[pi3], py = pm[pi3+1], pz = pm[pi3+2];

        // ── Line direction ──
        const t6 = ni * 6;
        const Tx = tan[t6], Ty = tan[t6+1], Tz = tan[t6+2];
        const Bx = tan[t6+3], By = tan[t6+4], Bz = tan[t6+5];
        let vx = 0, vy = 0;
        const add = (w, dx, dy, dz) => {
          if (w < 0.01) return;
          const tu = dx * Tx + dy * Ty + dz * Tz;
          const tv = dx * Bx + dy * By + dz * Bz;
          const th = Math.atan2(tv, tu);
          vx += w * Math.cos(2 * th);
          vy += w * Math.sin(2 * th);
        };
        add((Z.forehead[ni] * INV255) * 0.60, H[0], H[1], H[2]);
        add((Z.underEye[ni] * INV255) * 0.45, H[0], H[1], H[2]);
        add((Z.lip[ni] * INV255) * 1.0, V[0], V[1], V[2]);
        add(this._gw3d(px, py, pz, 0, 0.38, 1.08, 0.09, 0.11, 0.2) * 0.6, V[0], V[1], V[2]);
        add(this._gw3d(px, py, pz, 0, -0.70, 0.80, 0.42, 0.14, 0.4) * 0.5, H[0], H[1], H[2]);
        add(this._gw3d(px, py, pz, -0.20, -0.15, 1.10, 0.10, 0.20, 0.2) * 0.5, nasL[0], nasL[1], nasL[2]);
        add(this._gw3d(px, py, pz, 0.20, -0.15, 1.10, 0.10, 0.20, 0.2) * 0.5, nasR[0], nasR[1], nasR[2]);
        // Crow's feet radiate from the outer eye corner.
        for (const sx of [-1, 1]) {
          const w = this._gw3d(px, py, pz, sx * 0.46, 0.22, 0.95, 0.14, 0.13, 0.2) * 0.7;
          if (w > 0.01) {
            const rx = px - sx * 0.36, ry = py - 0.20;
            const rl = Math.sqrt(rx * rx + ry * ry) || 1;
            add(w, rx / rl, ry / rl, 0);
          }
        }
        const vl = Math.sqrt(vx * vx + vy * vy);
        if (vl > 1) { vx /= vl; vy /= vl; }

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

        const idx = ni * 4;
        d[idx]   = (t * 255) | 0;
        d[idx+1] = (dens[ni] * 255) | 0;
        d[idx+2] = ((vx * 0.5 + 0.5) * 255) | 0;
        d[idx+3] = ((vy * 0.5 + 0.5) * 255) | 0;
      }
    }
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
      // Preserve the per-pixel roughness values without another multiplier.
      mat.roughness = 1.0;
      mat.metalness = 0.0;

      /* The oily epidermal lobe is varied per texel by SkinShader, which
         reads the roughness texel already in scope and adds the pore/furrow
         micro-roughness on top — so no clearcoatRoughnessMap is bound here.
         Binding it a second time cost a texture unit for a value the shader
         already had. */
      mat.clearcoatRoughnessMap = null;

      // Regeneration must retain the active render mode and shared surface settings.
      const photoreal = this.scene.renderMode !== 'structure';
      if (window.SceneManager) SceneManager.applySkinSurface(mat, photoreal);
      else mat.envMapIntensity = photoreal ? 0.6 : 0;

      mat.vertexColors = false;

      if (window.SkinShader) {
        SkinShader.setEnabled(mat, photoreal);
        SkinShader.setThicknessMap(mat, this.thicknessTexture);
        SkinShader.setParams(mat, {
          poreScale: SkinTextureSystem.microReliefToPoreScale(this.params.microRelief),
          wrinkleStrength: this.params.wrinkleDepth / 100,
          underEyeStrength: this.params.underEyeEnabled ? this.params.underEyeIntensity / 100 : 0,
        });
        if (this.wrinklePainter) SkinShader.setWrinkleMap(mat, this.wrinklePainter.texture);
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
