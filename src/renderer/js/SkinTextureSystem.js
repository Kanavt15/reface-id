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
    this.RES = 512;

    this._diffuseCanvas = null;
    this._normalCanvas = null;
    this._roughnessCanvas = null;
    this.diffuseTexture = null;
    this.normalTexture = null;
    this.roughnessTexture = null;

    // UV→3D position map: for each texture pixel, stores the 3D world position
    // This is the key to placing facial zones correctly regardless of UV layout
    this._posMap = null;   // Float32Array(R*R*3) — xyz per pixel
    this._hasPosMap = false;

    // Model bounds for normalizing positions
    this._modelYMin = -1;
    this._modelYMax = 1;
    this._modelCenter = [0, 0, 0];

    this.params = {
      age: 20, roughness: 50, freckles: 0,
      poreDetail: 60, wrinkleDepth: 30, skinOiliness: 40, sunDamage: 10,
    };
    this._skinColorHex = '#d4a574';
    this._seed = 42;
    this._initialized = false;

    // Reference to WrinklePainter (set externally)
    this.wrinklePainter = null;
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
    for (let y = 0; y < R; y++) {
      const gy = (y / R) * gs, iy = Math.floor(gy), fy = gy - iy;
      for (let x = 0; x < R; x++) {
        const gx = (x / R) * gs, ix = Math.floor(gx), fx = gx - ix;
        const s = gs + 1;
        const top = grid[iy * s + ix] + (grid[iy * s + ix + 1] - grid[iy * s + ix]) * fx;
        const bot = grid[(iy+1)*s+ix] + (grid[(iy+1)*s+ix+1] - grid[(iy+1)*s+ix]) * fx;
        out[y * R + x] = top + (bot - top) * fy;
      }
    }
    return out;
  }

  _fractalNoise(R, seed, octaves, persistence) {
    const result = new Float32Array(R * R);
    let amp = 1, maxAmp = 0, gs = 4;
    for (let o = 0; o < octaves; o++) {
      const layer = this._valueNoise(R, gs, seed + o * 1000);
      for (let i = 0, n = R * R; i < n; i++) result[i] += layer[i] * amp;
      maxAmp += amp; amp *= persistence; gs *= 2;
    }
    const inv = 1 / maxAmp;
    for (let i = 0, n = R * R; i < n; i++) result[i] *= inv;
    return result;
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

    // Flood-fill gaps: for pixels without data, copy from nearest filled neighbor
    // Do a few passes of nearest-neighbor expansion
    for (let pass = 0; pass < 8; pass++) {
      let filled = 0;
      for (let y = 0; y < R; y++) {
        for (let x = 0; x < R; x++) {
          if (hasData[y * R + x]) continue;
          // Check 4 neighbors
          for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= R || ny < 0 || ny >= R) continue;
            if (!hasData[ny * R + nx]) continue;
            const src = (ny * R + nx) * 3;
            const dst = (y * R + x) * 3;
            this._posMap[dst] = this._posMap[src];
            this._posMap[dst+1] = this._posMap[src+1];
            this._posMap[dst+2] = this._posMap[src+2];
            hasData[y * R + x] = 1;
            filled++;
            break;
          }
        }
      }
      if (filled === 0) break;
    }

    this._hasPosMap = true;
    console.log(`[SkinTexture] Position map built: Y range [${yMin.toFixed(2)}, ${yMax.toFixed(2)}], ${cnt} vertices`);
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

  // ─── Setters ──────────────────────────────────────────────────────────────
  setParam(key, value) {
    if (this.params[key] !== undefined) this.params[key] = Math.max(0, Math.min(100, value));
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
    const { age, freckles, sunDamage, poreDetail } = this.params;
    const baseColor = this._hexToRgb(this._skinColorHex);

    ctx.fillStyle = this._skinColorHex;
    ctx.fillRect(0, 0, R, R);
    const imgData = ctx.getImageData(0, 0, R, R);
    const d = imgData.data;
    const pm = this._posMap;
    const hasPos = this._hasPosMap;

    const colorVar  = this._fractalNoise(R, 200, 4, 0.55);
    const largeVar  = this._fractalNoise(R, 400, 2, 0.5);
    const poreNoise = this._fractalNoise(R, 100, 5, 0.5);
    const freckleN  = this._fractalNoise(R, 350, 3, 0.45);
    const ageSpotN  = this._valueNoise(R, 12, 450);
    const microVar  = this._fractalNoise(R, 777, 4, 0.6);

    const ageFactor = Math.max(0, (age - 20) / 80);
    const freckleFactor = freckles / 100;
    const sunFactor = sunDamage / 100;

    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const idx = (y * R + x) * 4;
        const ni = y * R + x;
        const pi3 = ni * 3;

        // Get 3D position for this pixel (from position map)
        const px = hasPos ? pm[pi3] : 0;
        const py = hasPos ? pm[pi3+1] : 0;
        const pz = hasPos ? pm[pi3+2] : 0;

        let r = baseColor.r, g = baseColor.g, b = baseColor.b;

        // ── Natural noise variation ──
        const cv = (colorVar[ni] - 0.5) * 28;
        r += cv * 1.3; g += cv * 0.9; b += cv * 0.5;
        const lv = (largeVar[ni] - 0.5) * 18;
        r += lv * 1.1; g += lv * 0.7; b += lv * 0.4;
        const mv = (microVar[ni] - 0.5) * 10;
        r += mv; g += mv * 0.5; b -= mv * 0.3;

        if (hasPos) {
          // ── Subsurface scattering zones (3D position-based) ──
          // Cheeks: rosy warmth (x=±0.40, y=-0.15, z=0.95)
          const cheekW = Math.max(
            this._gw3d(px, py, pz, -0.40, -0.15, 0.95, 0.20, 0.18, 0.25),
            this._gw3d(px, py, pz,  0.40, -0.15, 0.95, 0.20, 0.18, 0.25));
          r += cheekW * 25; g -= cheekW * 4; b -= cheekW * 10;

          // Nose: redder (0, 0.02, 1.30)
          const noseW = this._gw3d(px, py, pz, 0, 0.02, 1.30, 0.08, 0.12, 0.15);
          r += noseW * 18; g -= noseW * 3; b -= noseW * 4;

          // Ears: redder (x=±0.80, y=0.15, z=-0.05)
          const earW = Math.max(
            this._gw3d(px, py, pz, -0.80, 0.15, -0.05, 0.15, 0.20, 0.20),
            this._gw3d(px, py, pz,  0.80, 0.15, -0.05, 0.15, 0.20, 0.20));
          r += earW * 15; b -= earW * 5;

          // Under-eye: darker/bluer
          const ueW = Math.max(
            this._gw3d(px, py, pz, -0.30, 0.16, 0.98, 0.10, 0.05, 0.15),
            this._gw3d(px, py, pz,  0.30, 0.16, 0.98, 0.10, 0.05, 0.15));
          const dc = ueW * (12 + ageFactor * 22);
          r -= dc * 0.7; g -= dc * 0.9; b -= dc * 0.1;

          // Forehead: warmer
          const fhW = this._gw3d(px, py, pz, 0, 0.60, 1.07, 0.30, 0.15, 0.25);
          r += fhW * 7; g += fhW * 3;

          // Temples: cooler
          const tmW = Math.max(
            this._gw3d(px, py, pz, -0.60, 0.35, 0.70, 0.15, 0.15, 0.20),
            this._gw3d(px, py, pz,  0.60, 0.35, 0.70, 0.15, 0.15, 0.20));
          r -= tmW * 6; b += tmW * 7;

          // Chin: slightly different
          const chinW = this._gw3d(px, py, pz, 0, -0.60, 1.08, 0.15, 0.12, 0.20);
          r += chinW * 5; g -= chinW * 2;

          // Lip area: pinker/redder
          const lipW = this._gw3d(px, py, pz, 0, -0.30, 1.12, 0.15, 0.06, 0.12);
          r += lipW * 14; g -= lipW * 2; b -= lipW * 5;
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
    const poreN = this._fractalNoise(R, 500, 4, 0.55);
    const poreFine = this._fractalNoise(R, 501, 3, 0.5);
    const poreMicro = this._valueNoise(R, 128, 502);
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
        for (const [, rgn] of Object.entries(regions)) {
          if (age < rgn.onset) continue;
          const rAge = (age - rgn.onset) / (100 - rgn.onset);
          const lStr = rAge * rgn.str * wStr;
          if (lStr > 0.01) this._drawWrinkles3D(hm, R, pm, rgn, lStr);
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

  /** Draw wrinkle lines using 3D position data for correct placement. */
  _drawWrinkles3D(hm, R, pm, rgn, strength) {
    const { dir, x: cx, y: cy, z: cz, rx, ry, rz, n: count } = rgn;
    this._resetSeed(Math.floor((cx+5)*1000 + (cy+5)*7777));

    for (let li = 0; li < count; li++) {
      const oY = (this._rng() - 0.5) * ry * 1.2;
      const oX = (this._rng() - 0.5) * rx * 1.2;
      const wb = 0.02 + this._rng() * 0.02;

      for (let py = 0; py < R; py++) {
        for (let px = 0; px < R; px++) {
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
    const pm = this._posMap;
    const hasPos = this._hasPosMap;

    const imgData = ctx.createImageData(R, R);
    const dd = imgData.data;
    const rNoise = this._fractalNoise(R, 600, 3, 0.5);

    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const ni = y * R + x;
        let rough = baseR + (rNoise[ni] - 0.5) * 0.15;

        if (hasPos) {
          const pi3 = ni * 3;
          const px = pm[pi3], py2 = pm[pi3+1], pz = pm[pi3+2];

          // T-zone oilier (forehead, nose, chin)
          const tz = Math.max(
            this._gw3d(px, py2, pz, 0, 0.60, 1.07, 0.25, 0.15, 0.25),
            this._gw3d(px, py2, pz, 0, 0.02, 1.30, 0.08, 0.15, 0.15),
            this._gw3d(px, py2, pz, 0, -0.60, 1.08, 0.12, 0.10, 0.20));
          rough -= tz * oil * 0.25;

          // Cheeks rougher
          const ck = Math.max(
            this._gw3d(px, py2, pz, -0.40, -0.15, 0.95, 0.18, 0.18, 0.25),
            this._gw3d(px, py2, pz,  0.40, -0.15, 0.95, 0.18, 0.18, 0.25));
          rough += ck * 0.08;

          // Lips smoother
          const lip = this._gw3d(px, py2, pz, 0, -0.30, 1.12, 0.15, 0.06, 0.12);
          rough -= lip * 0.15;
        }

        rough += ageFactor * 0.12;
        rough = rough < 0.1 ? 0.1 : rough > 1.0 ? 1.0 : rough;
        const val = (rough * 255) | 0;
        const idx = ni * 4;
        dd[idx] = val; dd[idx+1] = val; dd[idx+2] = val; dd[idx+3] = 255;
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
      mat.normalScale = new THREE.Vector2(1.5, 1.5);
      mat.roughnessMap = this.roughnessTexture;
      mat.roughness = 1.0;
      mat.metalness = 0.02;
      mat.envMapIntensity = 0.4;
      mat.vertexColors = false;
      mat.needsUpdate = true;
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  _hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) }
             : { r: 212, g: 165, b: 116 };
  }

  dispose() {
    if (this.diffuseTexture) this.diffuseTexture.dispose();
    if (this.normalTexture) this.normalTexture.dispose();
    if (this.roughnessTexture) this.roughnessTexture.dispose();
    if (this.meshGroup) {
      this.meshGroup.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        child.material.map = null;
        child.material.normalMap = null;
        child.material.roughnessMap = null;
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
