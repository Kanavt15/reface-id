// Skin shading on top of three's physical material: pore and fold detail, subsurface scattering, thin-skin glow and crease shadows.

class SkinShader {

  // ── Diffusion profile ────────────────────────────────────────────────────
  // Six-Gaussian skin scattering profile (d'Eon & Luebke); red spreads much further than blue, which is what makes skin look like flesh.
  static get PROFILE() {
    return [
      [0.0064, 0.233, 0.455, 0.649],
      [0.0484, 0.100, 0.336, 0.344],
      [0.1870, 0.118, 0.198, 0.000],
      [0.5670, 0.113, 0.007, 0.007],
      [1.9900, 0.358, 0.004, 0.000],
      [7.4100, 0.078, 0.000, 0.000],
    ];
  }

  // Adds up the profile's Gaussians at a surface distance r (mm).
  static _profileAt(r) {
    let cr = 0, cg = 0, cb = 0;
    const rr = r * r;
    for (const [v, wr, wg, wb] of SkinShader.PROFILE) {
      const g = Math.exp(-rr / (2 * v)) / (2 * Math.PI * v);
      cr += g * wr;
      cg += g * wg;
      cb += g * wb;
    }
    return [cr, cg, cb];
  }

  // Builds the scattering lookup texture: light angle across, surface curvature down, averaged around a ring of nearby points.
  static buildSSSLUT(size) {
    const N = size || 128;
    const canvas = document.createElement('canvas');
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(N, N);
    const d = img.data;

    const STEP = 0.03;

    for (let y = 0; y < N; y++) {
      // Row 0 is the flattest surface, so guard the divide.
      const curvature = Math.max((y + 0.5) / N, 1e-3);
      const radius = 1.0 / curvature; // mm

      for (let x = 0; x < N; x++) {
        const cosTheta = ((x + 0.5) / N) * 2 - 1;
        const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));

        let lr = 0, lg = 0, lb = 0;
        let wr = 0, wg = 0, wb = 0;

        for (let a = -Math.PI / 2; a <= Math.PI / 2; a += STEP) {
          // Lambert term at a point rotated `a` around the ring...
          const diffuse = Math.max(0, Math.cos(theta + a));
          // ...and the chord distance the light travelled to reach it.
          const dist = Math.abs(2.0 * radius * Math.sin(a * 0.5));
          const [pr, pg, pb] = SkinShader._profileAt(dist);
          lr += diffuse * pr; lg += diffuse * pg; lb += diffuse * pb;
          wr += pr; wg += pg; wb += pb;
        }

        const i = (y * N + x) * 4;
        d[i]     = Math.round(255 * Math.min(1, wr > 0 ? lr / wr : 0));
        d[i + 1] = Math.round(255 * Math.min(1, wg > 0 ? lg / wg : 0));
        d[i + 2] = Math.round(255 * Math.min(1, wb > 0 ? lb / wb : 0));
        d[i + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    // Lookup data, not colour — must not be sRGB-decoded.
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  // Returns the shared scattering lookup texture.
  static getSSSLUT() {
    if (!SkinShader._lut) {
      const t0 = performance.now();
      SkinShader._lut = SkinShader.buildSSSLUT(128);
      console.log('[SkinShader] SSS LUT baked in ' + (performance.now() - t0).toFixed(1) + 'ms');
    }
    return SkinShader._lut;
  }

  // ── Tile-building primitives ─────────────────────────────────────────────

  // Hashes a cell index so pores don't line up in rows and the tile still wraps exactly.
  static _hash2(ix, iy, salt) {
    let h = Math.imul(ix + 374761393, 2246822519)
          ^ Math.imul(iy + 668265263, 3266489917)
          ^ Math.imul(salt + 1, 374761393);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // Quintic fade curve used by the noise.
  static _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

  // Tileable value noise with integer wrapping so the edges meet.
  static _tileNoise(R, grid, salt) {
    const out = new Float32Array(R * R);
    const fade = SkinShader._fade;
    const hash2 = SkinShader._hash2;
    const lattice = new Float32Array(grid * grid);
    for (let j = 0; j < grid; j++)
      for (let i = 0; i < grid; i++) lattice[j * grid + i] = hash2(i, j, salt);
    for (let y = 0; y < R; y++) {
      const gy = (y / R) * grid, iy = Math.floor(gy), fy = fade(gy - iy);
      const j0 = iy % grid, j1 = (iy + 1) % grid;
      for (let x = 0; x < R; x++) {
        const gx = (x / R) * grid, ix = Math.floor(gx), fx = fade(gx - ix);
        const i0 = ix % grid, i1 = (ix + 1) % grid;
        const top = lattice[j0 * grid + i0] + (lattice[j0 * grid + i1] - lattice[j0 * grid + i0]) * fx;
        const bot = lattice[j1 * grid + i0] + (lattice[j1 * grid + i1] - lattice[j1 * grid + i0]) * fx;
        out[y * R + x] = top + (bot - top) * fy;
      }
    }
    return out;
  }

  // Wrapped 3x3 box blur, done in place.
  static _blur3(src, R) {
    const out = new Float32Array(R * R);
    for (let y = 0; y < R; y++) {
      const ym = ((y - 1 + R) % R) * R, y0 = y * R, yp = ((y + 1) % R) * R;
      for (let x = 0; x < R; x++) {
        const xm = (x - 1 + R) % R, xp = (x + 1) % R;
        out[y0 + x] = (src[ym + xm] + src[ym + x] + src[ym + xp]
                     + src[y0 + xm] + src[y0 + x] + src[y0 + xp]
                     + src[yp + xm] + src[yp + x] + src[yp + xp]) / 9;
      }
    }
    return out;
  }

  // Turns a wrapped height map into normal XY values.
  static _heightToNormal(h, R, strength) {
    const nx = new Float32Array(R * R);
    const ny = new Float32Array(R * R);
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const l = h[y * R + ((x - 1 + R) % R)];
        const r = h[y * R + ((x + 1) % R)];
        const u = h[((y - 1 + R) % R) * R + x];
        const dn = h[((y + 1) % R) * R + x];
        let vx = (l - r) * strength, vy = (u - dn) * strength;
        const inv = 1 / Math.sqrt(vx * vx + vy * vy + 1);
        nx[y * R + x] = vx * inv;
        ny[y * R + x] = vy * inv;
      }
    }
    return { nx, ny };
  }

  // ── Detail tiles ─────────────────────────────────────────────────────────
  // Builds two seamless detail tiles: pores (with a rank so density can vary by region), a crossing line network, an oriented ridge and pigment speckle.
  static buildDetailTiles(size) {
    const R = size || 512;
    const N = R * R;
    const hash2 = SkinShader._hash2;
    const noise = (grid, salt) => SkinShader._tileNoise(R, grid, salt);
    const TAU = Math.PI * 2;

    // Pores: about 0.25mm apart, like cheek skin.
    const CELLS = 56;
    const cellSize = R / CELLS;
    const pJx = new Float32Array(CELLS * CELLS);
    const pJy = new Float32Array(CELLS * CELLS);
    const pRad = new Float32Array(CELLS * CELLS);
    const pDepth = new Float32Array(CELLS * CELLS);
    const pRank = new Float32Array(CELLS * CELLS);
    // Cluster the pores so some patches have more than others.
    const clusterN = noise(7, 9);
    for (let cy = 0; cy < CELLS; cy++) {
      for (let cx = 0; cx < CELLS; cx++) {
        const i = cy * CELLS + cx;
        pJx[i] = 0.15 + hash2(cx, cy, 1) * 0.7;
        pJy[i] = 0.15 + hash2(cx, cy, 2) * 0.7;
        // One size value sets both width and depth, since wide pores are also deep.
        // Skewed small: most pores are tiny, a few are the visible ones.
        const sz = Math.pow(hash2(cx, cy, 4), 1.6);
        pRad[i] = 0.16 + sz * 0.30;
        pDepth[i] = 0.35 + sz * 0.65 + hash2(cx, cy, 5) * 0.2;
        const cl = clusterN[Math.floor((cy + 0.5) * cellSize) * R + Math.floor((cx + 0.5) * cellSize)];
        pRank[i] = Math.min(1, Math.max(0, hash2(cx, cy, 3) * 0.75 + (1 - cl) * 0.35));
      }
    }

    const poreH = new Float32Array(N);
    const pitMask = new Float32Array(N);
    const rankMap = new Float32Array(N);
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
        let best = 1e9, bestDepth = 1, bestRank = 1;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const gx = ((cx + ox) % CELLS + CELLS) % CELLS;
            const gy = ((cy + oy) % CELLS + CELLS) % CELLS;
            const pi = gy * CELLS + gx;
            const px = (cx + ox + pJx[pi]) * cellSize;
            const py = (cy + oy + pJy[pi]) * cellSize;
            const dx = x - px, dy = y - py;
            const dist = Math.sqrt(dx * dx + dy * dy) / (cellSize * pRad[pi]);
            if (dist < best) { best = dist; bestDepth = pDepth[pi]; bestRank = pRank[pi]; }
          }
        }
        // A rounded pit: flat outside radius 1, smoothly cupped inside.
        const h = best > 1 ? 1 : best;
        const cup = 1 - h * h;
        const pit = cup * cup * bestDepth;
        poreH[y * R + x] = -pit;
        pitMask[y * R + x] = pit;
        rankMap[y * R + x] = bestRank;
      }
    }
    // A soft orange-peel undulation plus fine grain between the pores.
    {
      const und1 = noise(9, 71), und2 = noise(19, 72);
      for (let i = 0; i < N; i++) {
        const y = (i / R) | 0, x = i - y * R;
        poreH[i] += (und1[i] - 0.5) * 0.30 + (und2[i] - 0.5) * 0.16 + (hash2(x, y, 77) - 0.5) * 0.08;
      }
    }
    const poreHb = SkinShader._blur3(poreH, R);
    const poreN = SkinShader._heightToNormal(poreHb, R, 3.4 * (R / 512));

    // Primary lines: whole-number wave vectors keep each family tileable.
    const families = [
      { kx: 29, ky: 20, depth: 1.00, salt: 21 },
      { kx: 29, ky: -20, depth: 0.95, salt: 22 },
      { kx: 66, ky: 46, depth: 0.40, salt: 23 },
      { kx: 66, ky: -46, depth: 0.38, salt: 24 },
    ];
    const lineH = new Float32Array(N);
    for (const f of families) {
      // Bend and break the lines with noise so they form an irregular mesh that stops and restarts.
      const phase = noise(7, f.salt);
      const kink = noise(23, f.salt + 20);
      const amp = noise(13, f.salt + 40);
      const width = noise(9, f.salt + 80);
      for (let y = 0; y < R; y++) {
        const v = y / R;
        for (let x = 0; x < R; x++) {
          const u = x / R, i = y * R + x;
          const t = TAU * (f.kx * u + f.ky * v) + (phase[i] - 0.5) * 5.0 + (kink[i] - 0.5) * 2.6;
          const s = Math.abs(Math.sin(t));
          const p = 2.5 + width[i] * 4.0;
          const groove = Math.pow(1 - s, p);
          const gate = Math.max(0, amp[i] * 1.7 - 0.35);
          lineH[i] -= groove * f.depth * gate;
        }
      }
    }
    const lineN = SkinShader._heightToNormal(lineH, R, 5.0 * (R / 512));

    // Oriented ridge: broader furrows the shader turns to match each region's line direction.
    const ridgeSlope = new Float32Array(N);
    {
      const wob = noise(5, 31), amp = noise(4, 32), wid = noise(6, 33);
      const rh = new Float32Array(N);
      for (let y = 0; y < R; y++) {
        const v = y / R;
        for (let x = 0; x < R; x++) {
          const i = y * R + x;
          const t = TAU * (8 * v + (wob[i] - 0.5) * 0.45);
          const s = Math.abs(Math.sin(t));
          rh[i] = -Math.pow(1 - s, 1.6 + wid[i] * 2.0) * (0.35 + amp[i] * 0.8);
        }
      }
      const str = 5.0 * (R / 512);
      for (let y = 0; y < R; y++) {
        for (let x = 0; x < R; x++) {
          const u = rh[((y - 1 + R) % R) * R + x], dn = rh[((y + 1) % R) * R + x];
          const sl = (u - dn) * str;
          ridgeSlope[y * R + x] = sl < -1 ? -1 : sl > 1 ? 1 : sl;
        }
      }
    }

    // Pigment speckle: small sharp spots of melanin.
    const speck = new Float32Array(N);
    {
      const s1 = noise(96, 51), s2 = noise(200, 52), gate = noise(11, 53);
      for (let i = 0; i < N; i++) {
        let v = (s1[i] - 0.5) * 2;
        v = Math.sign(v) * Math.pow(Math.abs(v), 0.6);
        speck[i] = v * (0.55 + gate[i] * 0.6) * 0.8 + (s2[i] - 0.5) * 0.5;
      }
    }

    // Pack as raw bytes, since a canvas would premultiply the alpha data.
    const q = (v) => { const t = ((v * 0.5 + 0.5) * 255) | 0; return t < 0 ? 0 : t > 255 ? 255 : t; };
    const q01 = (v) => { const t = (v * 255) | 0; return t < 0 ? 0 : t > 255 ? 255 : t; };

    const da = new Uint8Array(N * 4), db = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      da[o] = q(poreN.nx[i]); da[o + 1] = q(poreN.ny[i]);
      da[o + 2] = q01(pitMask[i]); da[o + 3] = q01(rankMap[i]);
      db[o] = q(lineN.nx[i]); db[o + 1] = q(lineN.ny[i]);
      db[o + 2] = q(ridgeSlope[i]); db[o + 3] = q(speck[i]);
    }
    return { a: da, b: db, size: R };
  }

  // Wraps pixel data in a repeating, non-colour texture.
  static _tileTexture(data, R) {
    const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }

  // Wrapped separable box blur, used once when importing the detail image.
  static _blurField(src, R, radius) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    const width = radius * 2 + 1;
    for (let y = 0; y < R; y++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += src[y * R + (k + R) % R];
      for (let x = 0; x < R; x++) {
        tmp[y * R + x] = sum / width;
        sum += src[y * R + (x + radius + 1) % R] - src[y * R + (x - radius + R) % R];
      }
    }
    for (let x = 0; x < R; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[((k + R) % R) * R + x];
      for (let y = 0; y < R; y++) {
        out[y * R + x] = sum / width;
        sum += tmp[((y + radius + 1) % R) * R + x] - tmp[((y - radius + R) % R) * R + x];
      }
    }
    return out;
  }

  // Imports the generated skin image as detail tiles, removing its own colour and crossfading edges so it tiles.
  static buildImageDetailTiles(source, R = 1024) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = R;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, R, R);
    const pixels = ctx.getImageData(0, 0, R, R).data;
    const raw = new Float32Array(R * R), field = new Float32Array(R * R);
    const complexion = new Float32Array(R * R * 3);
    const mean = [0, 0, 0];
    for (let i = 0; i < raw.length; i++) {
      const o = i * 4;
      raw[i] = (pixels[o] * 0.2126 + pixels[o + 1] * 0.7152 + pixels[o + 2] * 0.0722) / 255;
      for (let c = 0; c < 3; c++) mean[c] += pixels[o + c] / (255 * raw.length);
    }
    const edgeWeight = (x) => {
      const t = Math.min(1, Math.min(x, R - x) / (R * 0.12));
      return t * t * (3 - 2 * t);
    };
    for (let y = 0; y < R; y++) {
      const wy = edgeWeight(y), sy = (y + R / 2) % R;
      for (let x = 0; x < R; x++) {
        const wx = edgeWeight(x), sx = (x + R / 2) % R;
        const a = raw[y * R + x] * wx + raw[y * R + sx] * (1 - wx);
        const b = raw[sy * R + x] * wx + raw[sy * R + sx] * (1 - wx);
        field[y * R + x] = a * wy + b * (1 - wy);
        for (let c = 0; c < 3; c++) {
          const top = pixels[(y * R + x) * 4 + c] * wx + pixels[(y * R + sx) * 4 + c] * (1 - wx);
          const bottom = pixels[(sy * R + x) * 4 + c] * wx + pixels[(sy * R + sx) * 4 + c] * (1 - wx);
          complexion[(y * R + x) * 3 + c] = (top * wy + bottom * (1 - wy)) / 255;
        }
      }
    }
    const local = SkinShader._blurField(field, R, 12);
    // Keep the millimetre-scale variation too, which still shows at portrait size.
    const broad = SkinShader._blurField(field, R, Math.max(1, Math.round(R / 24)));
    const height = new Float32Array(R * R);
    for (let i = 0; i < height.length; i++) {
      height[i] = Math.max(-0.3, Math.min(0.3, (field[i] - local[i]) * 3.0));
    }
    const smooth = SkinShader._blur3(height, R);
    const pore = SkinShader._heightToNormal(smooth, R, 5.5 * R / 1024);
    const a = new Uint8Array(R * R * 4), b = new Uint8Array(a.length);
    const q = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    for (let i = 0; i < height.length; i++) {
      const o = i * 4;
      a[o] = q(pore.nx[i] * 0.5 + 0.5);
      a[o + 1] = q(pore.ny[i] * 0.5 + 0.5);
      a[o + 2] = q(Math.max(0, -height[i]) * 2.5);
      a[o + 3] = q(0.5 + Math.max(-0.9, Math.min(0.9, (local[i] - broad[i]) * 18.0)) * 0.5);
      for (let c = 0; c < 3; c++) {
        const relative = (complexion[i * 3 + c] - mean[c]) / Math.max(mean[c], 0.01);
        b[o + c] = q(0.5 + relative * 1.5);
      }
      b[o + 3] = q(0.5 + height[i] * 1.8);
    }
    return { a, b, size: R };
  }

  // Returns the detail tiles, starting with the procedural set and swapping in the image ones once they load.
  static getDetailTiles() {
    if (!SkinShader._tiles) {
      const c = SkinShader.buildDetailTiles(512);
      SkinShader._tiles = {
        a: SkinShader._tileTexture(c.a, 512), b: SkinShader._tileTexture(c.b, 512),
        res: 512, mm: 16, imageDetail: 0, source: 'procedural-fallback',
      };
      SkinShader._detailReady = new Promise((resolve) => {
        const source = new Image();
        source.onload = () => {
          const upgrade = () => {
            try {
              const hi = SkinShader.buildImageDetailTiles(source);
              const old = SkinShader._tiles;
              SkinShader._tiles = {
                a: SkinShader._tileTexture(hi.a, hi.size), b: SkinShader._tileTexture(hi.b, hi.size),
                res: hi.size, mm: 48, imageDetail: 1, source: 'generated-cheek-v2',
              };
              for (const u of SkinShader._tileUsers) {
                u.uDetailA.value = SkinShader._tiles.a;
                u.uDetailB.value = SkinShader._tiles.b;
                u.uDetailMM.value = SkinShader._tiles.mm;
                u.uImageDetail.value = 1;
              }
              old.a.dispose(); old.b.dispose();
              console.log('[SkinShader] Original cheek detail ready: ' + hi.size + 'px');
              resolve(true);
            } catch (error) {
              console.warn('[SkinShader] Detail import failed; using procedural fallback.', error);
              resolve(false);
            }
          };
          if (typeof requestIdleCallback === 'function') requestIdleCallback(upgrade, { timeout: 1500 });
          else setTimeout(upgrade, 0);
        };
        source.onerror = () => {
          console.warn('[SkinShader] Detail asset unavailable; using procedural fallback.');
          resolve(false);
        };
        source.src = new URL('../../assets/textures/skin/cheek-skin-v2.png', document.baseURI).href;
      });
    }
    return SkinShader._tiles;
  }

  // Under-eye fold atlas in eye-local space (X toward the temple, Y up), which works even without the skin images.
  static getUnderEyeMap() {
    if (SkinShader._underEyeMap) return SkinShader._underEyeMap;
    const W = 1024, H = 512, x0 = -.20, y0 = -.18, sx = .52, sy = .26;
    const dx = sx / (W - 1), dy = sy / (H - 1);
    const height = new Float32Array(W * H);
    const stroke = (points, width, depth) => {
      const margin = width * 5;
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
      const left = Math.max(0, Math.floor((Math.min(...xs) - margin - x0) / dx));
      const right = Math.min(W - 1, Math.ceil((Math.max(...xs) + margin - x0) / dx));
      const bottom = Math.max(0, Math.floor((Math.min(...ys) - margin - y0) / dy));
      const top = Math.min(H - 1, Math.ceil((Math.max(...ys) + margin - y0) / dy));
      for (let y = bottom; y <= top; y++) for (let x = left; x <= right; x++) {
        const px = x0 + x * dx, py = y0 + y * dy;
        let nearest = Infinity, along = 0;
        for (let j = 0; j < points.length - 1; j++) {
          const a = points[j], b = points[j + 1], vx = b[0] - a[0], vy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy)));
          const distance = (px - a[0] - t * vx) ** 2 + (py - a[1] - t * vy) ** 2;
          if (distance < nearest) { nearest = distance; along = (j + t) / (points.length - 1); }
        }
        const taper = Math.max(0, Math.sin(Math.PI * along)) ** .6;
        const trough = Math.exp(-nearest / (2 * width * width));
        const shoulder = Math.exp(-nearest / (2 * (width * 2.8) ** 2));
        height[y * W + x] += depth * taper * (.16 * shoulder - trough);
      }
    };
    for (let i = 0; i < 4; i++) {
      const points = Array.from({length: 28}, (_, j) => {
        const t = j / 27 * 2 - 1;
        return [t * (.135 + i * .013), -.060 - i * .02184
          + (.0273 + i * .00312) * t * t + .0022 * Math.sin(t * 13 + i * 2)];
      });
      // The nearest two creases were too faint, so they are deeper now.
      stroke(points, i < 2 ? .0024 : .0029, i < 2 ? .0021 : .0017);
    }
    for (let i = 0; i < 5; i++) {
      const points = Array.from({length: 25}, (_, j) => {
        const t = j / 24;
        return [.135 + t * (.13 + .022 * (i % 2)),
          .0102 + .78 * (t * (.077 - i * .036) - t * t * .022 + .002 * Math.sin(t * 14 + i))];
      });
      stroke(points, .0024 + i * .00016, .0018);
    }
    const data = new Uint8Array(W * H * 4);
    const encode = v => Math.round(128 + Math.max(-1, Math.min(1, v)) * 127);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      data[o] = encode((height[y * W + Math.max(0, x - 1)] - height[y * W + Math.min(W - 1, x + 1)]) / (2 * dx));
      data[o + 1] = encode((height[Math.max(0, y - 1) * W + x] - height[Math.min(H - 1, y + 1) * W + x]) / (2 * dy));
      data[o + 2] = Math.round(Math.max(0, Math.min(1, -height[i] / .006)) * 255);
      data[o + 3] = 255;
    }
    const texture = new THREE.DataTexture(data, W, H);
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    SkinShader._underEyeMap = texture;
    return texture;
  }

  // Returns the anatomy maps authored in Blender, shared by all skin materials.
  static getAnatomyMaps() {
    if (SkinShader._anatomyMaps) return SkinShader._anatomyMaps;
    const neutral = new THREE.DataTexture(new Uint8Array([128, 128, 0, 0]), 1, 1);
    neutral.needsUpdate = true;
    SkinShader._anatomyMaps = { fine: neutral, age: neutral, ready: 0 };
    const load = name => new Promise(resolve => {
      new THREE.TextureLoader().load(
        new URL('../../assets/textures/skin/' + name, document.baseURI).href,
        texture => {
          texture.colorSpace = THREE.NoColorSpace;
          texture.anisotropy = 8;
          resolve(texture);
        }, undefined, () => resolve(null));
    });
    SkinShader._anatomyReady = Promise.all([
      load('anatomy-fine-v1.png'), load('anatomy-age-v1.png'),
    ]).then(([fine, age]) => {
      if (!fine || !age) {
        fine?.dispose(); age?.dispose();
        return false;
      }
      SkinShader._anatomyMaps = { fine, age, ready: 1 };
      for (const u of SkinShader._tileUsers) {
        u.uAnatomyFine.value = fine;
        u.uAnatomyAge.value = age;
        u.uAnatomyReady.value = 1;
      }
      neutral.dispose();
      return true;
    });
    return SkinShader._anatomyMaps;
  }

  // Returns the fine skin fold tile, used alongside the pore tile.
  static getMicrofoldTile() {
    if (SkinShader._microfoldTile) return SkinShader._microfoldTile;
    const neutral = SkinShader._tileTexture(new Uint8Array([128, 128, 0, 255]), 1);
    SkinShader._microfoldTile = { texture: neutral, ready: 0 };
    SkinShader._microfoldReady = new Promise(resolve => {
      const source = new Image();
      source.onload = () => {
        try {
          const data = SkinShader.buildImageDetailTiles(source);
          const texture = SkinShader._tileTexture(data.a, data.size);
          SkinShader._microfoldTile = { texture, ready: 1 };
          for (const u of SkinShader._tileUsers) {
            u.uMicrofoldMap.value = texture;
            u.uMicrofoldReady.value = 1;
          }
          neutral.dispose();
          resolve(true);
        } catch (_) { resolve(false); }
      };
      source.onerror = () => resolve(false);
      source.src = new URL('../../assets/textures/skin/microfold-skin-v1.png', document.baseURI).href;
    });
    return SkinShader._microfoldTile;
  }

  // Removes the broad lighting from the generated face colour image so it can be re-lit.
  static buildFaceColourMap(source, R = 1024) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = R;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, R, R);
    const pixels = ctx.getImageData(0, 0, R, R).data;
    const linear = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      linear[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    const luminance = new Float32Array(R * R);
    const mean = [0, 0, 0];
    let count = 0;
    for (let i = 0; i < luminance.length; i++) {
      const o = i * 4;
      const rgb = [linear[pixels[o]], linear[pixels[o + 1]], linear[pixels[o + 2]]];
      luminance[i] = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      const x = (i % R) / R, y = Math.floor(i / R) / R;
      if (x > 0.32 && x < 0.68 && y > 0.15 && y < 0.80 && luminance[i] > 0.08) {
        for (let c = 0; c < 3; c++) mean[c] += rgb[c] / luminance[i];
        count++;
      }
    }
    for (let c = 0; c < 3; c++) mean[c] /= Math.max(1, count);
    const broad = SkinShader._blurField(luminance, R, Math.round(R / 28));
    const data = new Uint8Array(R * R * 4);
    const encode = v => Math.round(Math.max(0, Math.min(1, v * 0.5 + 0.5)) * 255);
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      const i = y * R + x, src = i * 4;
      // Flip rows to the usual bottom-up UV order.
      const dst = ((R - 1 - y) * R + x) * 4;
      const detail = Math.max(-0.35, Math.min(0.35, luminance[i] / Math.max(0.02, broad[i]) - 1));
      for (let c = 0; c < 3; c++) {
        const chroma = linear[pixels[src + c]] / Math.max(0.02, luminance[i]);
        const variation = (chroma / Math.max(0.01, mean[c]) - 1) * 0.9 + detail * 0.75;
        data[dst + c] = encode(Math.max(-0.4, Math.min(0.4, variation)));
      }
      data[dst + 3] = encode(detail);
    }
    const texture = SkinShader._tileTexture(data, R);
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  // Returns the face colour map, a neutral placeholder until the image loads.
  static getFaceColourMap() {
    if (SkinShader._faceColourMap) return SkinShader._faceColourMap;
    const neutral = SkinShader._tileTexture(new Uint8Array([128, 128, 128, 128]), 1);
    SkinShader._faceColourMap = { texture: neutral, ready: 0 };
    SkinShader._faceColourReady = new Promise(resolve => {
      const source = new Image();
      source.onload = () => {
        try {
          const texture = SkinShader.buildFaceColourMap(source);
          SkinShader._faceColourMap = { texture, ready: 1 };
          for (const u of SkinShader._tileUsers) {
            u.uFaceColourMap.value = texture;
            u.uFaceColourReady.value = 1;
          }
          neutral.dispose();
          resolve(true);
        } catch (_) { resolve(false); }
      };
      source.onerror = () => resolve(false);
      source.src = new URL('../../assets/textures/skin/face-colour-v1.png', document.baseURI).href;
    });
    return SkinShader._faceColourMap;
  }

  // ── Cavity occlusion ─────────────────────────────────────────────────────
  // Stores how concave the mesh is at each vertex, so creases like nostrils and eye corners get less ambient light; recomputed after morphs.
  static computeCavity(target) {
    const meshes = [];
    if (!target) return;
    if (Array.isArray(target)) {
      for (const m of target) if (m && m.isMesh) meshes.push(m);
    } else if (target.isMesh) {
      meshes.push(target);
    } else if (target.traverse) {
      target.traverse((c) => { if (c.isMesh) meshes.push(c); });
    }

    for (const mesh of meshes) {
      const geo = mesh.geometry;
      if (!geo || !geo.attributes.position) continue;

      const pos = geo.attributes.position;
      // Keep the rest-pose positions so pores move with the face.
      if (!geo.attributes.aSkinPosition || geo.attributes.aSkinPosition.count !== pos.count) {
        geo.setAttribute('aSkinPosition', pos.clone());
      }
      const nrm = geo.attributes.normal;
      if (!nrm) continue;
      const N = pos.count;

      // The mesh topology never changes, so build the neighbour list once.
      let adj = geo.userData._cavityAdjacency;
      if (!adj || adj.count !== N) {
        adj = SkinShader._buildAdjacency(geo, N);
        if (!adj) continue;
        geo.userData._cavityAdjacency = adj;
      }

      const { offsets, neighbours } = adj;
      const raw = new Float32Array(N);
      const px = pos.array, nx = nrm.array;

      for (let i = 0; i < N; i++) {
        const start = offsets[i], end = offsets[i + 1];
        const degree = end - start;
        if (degree === 0) continue;

        const vx = px[i * 3], vy = px[i * 3 + 1], vz = px[i * 3 + 2];
        const nvx = nx[i * 3], nvy = nx[i * 3 + 1], nvz = nx[i * 3 + 2];

        let sum = 0;
        for (let k = start; k < end; k++) {
          const j = neighbours[k];
          let dx = px[j * 3] - vx;
          let dy = px[j * 3 + 1] - vy;
          let dz = px[j * 3 + 2] - vz;
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (len < 1e-8) continue;
          sum += (dx * nvx + dy * nvy + dz * nvz) / len;
        }
        raw[i] = sum / degree;
      }

      // Smooth three times so the triangulation doesn't show as blotches while real creases survive.
      let src = raw;
      let dst = new Float32Array(N);
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < N; i++) {
          const start = offsets[i], end = offsets[i + 1];
          let sum = src[i], count = 1;
          for (let k = start; k < end; k++) { sum += src[neighbours[k]]; count++; }
          dst[i] = sum / count;
        }
        const swap = src; src = dst; dst = swap;
      }
      const smoothed = src;

      // Only concave areas are darkened, scaled into 0-1.
      let attr = geo.attributes.aCavity;
      if (!attr || attr.count !== N) {
        attr = new THREE.BufferAttribute(new Float32Array(N), 1);
        geo.setAttribute('aCavity', attr);
      }
      const out = attr.array;
      for (let i = 0; i < N; i++) {
        const c = smoothed[i] * 5.0;
        out[i] = c < 0 ? 0 : c > 1 ? 1 : c;
      }
      attr.needsUpdate = true;
    }
  }

  // Builds a compact neighbour list for every vertex from the index buffer.
  static _buildAdjacency(geo, N) {
    const index = geo.index;
    if (!index) return null;
    const idx = index.array;
    const triCount = idx.length / 3;

    // First pass counts neighbours; shared edges count twice, which is harmless.
    const degree = new Uint32Array(N);
    for (let t = 0; t < triCount; t++) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      degree[a] += 2; degree[b] += 2; degree[c] += 2;
    }

    const offsets = new Uint32Array(N + 1);
    for (let i = 0; i < N; i++) offsets[i + 1] = offsets[i] + degree[i];

    const neighbours = new Uint32Array(offsets[N]);
    const cursor = offsets.slice(0, N);
    for (let t = 0; t < triCount; t++) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      neighbours[cursor[a]++] = b; neighbours[cursor[a]++] = c;
      neighbours[cursor[b]++] = a; neighbours[cursor[b]++] = c;
      neighbours[cursor[c]++] = a; neighbours[cursor[c]++] = b;
    }

    return { offsets, neighbours, count: N };
  }

  // Recomputes cavity after a morph, once per burst of slider changes.
  static scheduleCavity(target) {
    if (SkinShader._cavityTimer) clearTimeout(SkinShader._cavityTimer);
    SkinShader._cavityTimer = setTimeout(() => {
      SkinShader._cavityTimer = null;
      SkinShader.computeCavity(target);
    }, 120);
  }

  // Attachment

  // Default skin shading settings.
  static get DEFAULTS() {
    return {
      sssStrength: 0.7,
      // Model units are about 100mm, and the lookup uses curvature per mm.
      curvatureScale: 0.01,
      // A small floor so broad areas still scatter a little and don't look like plastic.
      curvatureBias: 0.03,
      // Depth of the pore relief. Driven by the Micro Relief slider.
      poreScale: 0.30,
      // Line depth for the procedural fallback; the image supplies its own relief.
      lineScale: 0.18,
      // Albedo modulation from speckle and pore pits, as a fraction.
      albedoDetail: 0.50,
      // Broader complexion detail remains readable at full-face framing.
      complexionDetail: 0.10,
      wrinkleStrength: 1.0,
      underEyeStrength: 0.0,
      fineCreaseStrength: 1.0,
      faceColourStrength: 0.65,
      // Roughness modulation from pits and ridges.
      roughDetail: 0.10,
      // How far the oil layer follows the perturbed normal (0 = stock three).
      clearcoatFollow: 0.65,
      cavityStrength: 0.55,
      translucency: 0.5,
    };
  }

  // Installs the skin shading on a MeshPhysicalMaterial; calling it twice does nothing.
  static attach(material, options) {
    if (!material || material.userData.skinShader) return material;

    const cfg = Object.assign({}, SkinShader.DEFAULTS, options || {});
    const tiles = SkinShader.getDetailTiles();
    const anatomy = SkinShader.getAnatomyMaps();
    const microfold = SkinShader.getMicrofoldTile();
    const faceColour = SkinShader.getFaceColourMap();

    const uniforms = {
      uSSSLut: { value: SkinShader.getSSSLUT() },
      uDetailA: { value: tiles.a },
      uDetailB: { value: tiles.b },
      uDetailMM: { value: tiles.mm },
      uImageDetail: { value: tiles.imageDetail },
      uAnatomyFine: { value: anatomy.fine },
      uAnatomyAge: { value: anatomy.age },
      uAnatomyReady: { value: anatomy.ready },
      uWrinkleStrength: { value: cfg.wrinkleStrength },
      uUnderEyeStrength: { value: cfg.underEyeStrength },
      uUnderEyeMap: { value: SkinShader.getUnderEyeMap() },
      // Neutral eye positions and sizes; EyeSystem updates these as the eyes move.
      uUnderEyeLeft: { value: new THREE.Vector4(-.29111776, .33871184, 1, 0) },
      uUnderEyeRight: { value: new THREE.Vector4(.29111776, .33871184, 1, 0) },
      uPaintedWrinkles: { value: SkinShader.getEmptyWrinkleMap() },
      uFineCreaseStrength: { value: cfg.fineCreaseStrength },
      uMicrofoldMap: { value: microfold.texture },
      uMicrofoldReady: { value: microfold.ready },
      uFaceColourMap: { value: faceColour.texture },
      uFaceColourReady: { value: faceColour.ready },
      uFaceColourStrength: { value: cfg.faceColourStrength },
      uThicknessMap: { value: null },
      uSSSStrength: { value: cfg.sssStrength },
      uCurvatureScale: { value: cfg.curvatureScale },
      uCurvatureBias: { value: cfg.curvatureBias },
      uPoreScale: { value: cfg.poreScale },
      uLineScale: { value: cfg.lineScale },
      uAlbedoDetail: { value: cfg.albedoDetail },
      uComplexionDetail: { value: cfg.complexionDetail },
      uRoughDetail: { value: cfg.roughDetail },
      uClearcoatFollow: { value: cfg.clearcoatFollow },
      uCavityStrength: { value: cfg.cavityStrength },
      uTranslucency: { value: cfg.translucency },
      uSkinEnabled: { value: 1.0 },
    };

    material.userData.skinShader = { uniforms, hasThickness: false };
    SkinShader._tileUsers.add(uniforms);
    material.addEventListener('dispose', () => SkinShader._tileUsers.delete(uniforms));

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      // Keep a handle so live parameter changes reach the compiled program.
      material.userData.skinShader.shader = shader;

      const hasThickness = !!uniforms.uThicknessMap.value;
      const defines = hasThickness ? '#define USE_SKIN_THICKNESS\n' : '';

      // Pass our own UVs, since three's only exist when a normal map is bound.
      shader.vertexShader =
        'varying vec2 vSkinUv;\n' +
        'attribute float aCavity;\n' +
        'attribute vec3 aSkinPosition;\n' +
        'varying vec3 vSkinPosition;\n' +
        'varying vec3 vSkinCurrentPosition;\n' +
        'varying float vCavity;\n' +
        shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\tvSkinUv = uv;\n\tvCavity = aCavity;\n\tvSkinPosition = aSkinPosition;'
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        'vSkinCurrentPosition = transformed;\n#include <project_vertex>'
      );

      // ── Fragment prelude ──
      shader.fragmentShader =
        defines +
        'uniform sampler2D uSSSLut;\n' +
        'uniform sampler2D uDetailA;\n' +
        'uniform sampler2D uDetailB;\n' +
        'uniform float uDetailMM;\n' +
        'uniform float uImageDetail;\n' +
        'uniform sampler2D uAnatomyFine;\n' +
        'uniform sampler2D uAnatomyAge;\n' +
        'uniform float uAnatomyReady;\n' +
        'uniform float uWrinkleStrength;\n' +
        'uniform float uUnderEyeStrength;\n' +
        'uniform sampler2D uUnderEyeMap;\n' +
        'uniform vec4 uUnderEyeLeft;\n' +
        'uniform vec4 uUnderEyeRight;\n' +
        'uniform sampler2D uPaintedWrinkles;\n' +
        'uniform float uFineCreaseStrength;\n' +
        'uniform sampler2D uMicrofoldMap;\n' +
        'uniform float uMicrofoldReady;\n' +
        'uniform sampler2D uFaceColourMap;\n' +
        'uniform float uFaceColourReady;\n' +
        'uniform float uFaceColourStrength;\n' +
        'varying vec3 vSkinPosition;\n' +
        'varying vec3 vSkinCurrentPosition;\n' +
        '#ifdef USE_SKIN_THICKNESS\nuniform sampler2D uThicknessMap;\n#endif\n' +
        'uniform float uSSSStrength;\n' +
        'uniform float uCurvatureScale;\n' +
        'uniform float uCurvatureBias;\n' +
        'uniform float uPoreScale;\n' +
        'uniform float uLineScale;\n' +
        'uniform float uAlbedoDetail;\n' +
        'uniform float uComplexionDetail;\n' +
        'uniform float uRoughDetail;\n' +
        'uniform float uClearcoatFollow;\n' +
        'uniform float uCavityStrength;\n' +
        'uniform float uTranslucency;\n' +
        'uniform float uSkinEnabled;\n' +
        'varying vec2 vSkinUv;\n' +
        'varying float vCavity;\n' +
        'float skinCurvature = 0.0;\n' +
        'float skinThickness = 0.0;\n' +
        'vec3 skinDetailGradient = vec3( 0.0 );\n' +
        'vec3 skinAnatomyGradient = vec3( 0.0 );\n' +
        'vec3 skinEyeGradient = vec3( 0.0 );\n' +
        'float skinPhotoHeight = 0.0;\n' +
        'vec2 skinPaintGradient = vec2( 0.0 );\n' +
        'float skinCcRough = 0.0;\n' +
        'float skinRoughTexel = 1.0;\n' +
        'vec3 skinMacroNormal = vec3( 0.0, 0.0, 1.0 );\n' +
        shader.fragmentShader;

      // Sample detail by three projections in rest space: fixed physical scale and no UV seams.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        {
          float density = 0.55;
          float lineGain = 0.5;
          #ifdef USE_ROUGHNESSMAP
            density = texelRoughness.r;
            lineGain = texelRoughness.b;
            skinRoughTexel = texelRoughness.g;
          #endif
          #ifdef USE_SKIN_THICKNESS
            skinThickness = texture2D( uThicknessMap, vSkinUv ).r;
          #endif
          vec3 restDx = dFdx( vSkinPosition );
          vec3 restDy = dFdy( vSkinPosition );
          vec3 restN = cross( restDx, restDy );
          restN /= max( length( restN ), 1e-8 );
          vec3 w = pow( abs( restN ), vec3( 4.0 ) );
          w /= max( w.x + w.y + w.z, 1e-6 );
          vec3 p = vSkinPosition * ( 100.0 / uDetailMM );
          vec4 ax = texture2D( uDetailA, p.yz + vec2( 0.17, 0.41 ) );
          vec4 ay = texture2D( uDetailA, p.xz + vec2( 0.53, 0.09 ) );
          vec4 az = texture2D( uDetailA, p.xy );
          vec4 bx = texture2D( uDetailB, p.yz + vec2( 0.17, 0.41 ) );
          vec4 by = texture2D( uDetailB, p.xz + vec2( 0.53, 0.09 ) );
          vec4 bz = texture2D( uDetailB, p.xy );
          float poreGain = clamp( density * 1.45, 0.0, 1.0 );
          lineGain *= 1.0 - uImageDetail;
          vec2 nx = ( ax.xy * 2.0 - 1.0 ) * poreGain * uPoreScale
                  + ( bx.xy * 2.0 - 1.0 ) * lineGain * uLineScale;
          vec2 ny = ( ay.xy * 2.0 - 1.0 ) * poreGain * uPoreScale
                  + ( by.xy * 2.0 - 1.0 ) * lineGain * uLineScale;
          vec2 nz = ( az.xy * 2.0 - 1.0 ) * poreGain * uPoreScale
                  + ( bz.xy * 2.0 - 1.0 ) * lineGain * uLineScale;
          skinDetailGradient = vec3( 0.0, nx.x, nx.y ) * w.x
                             + vec3( ny.x, 0.0, ny.y ) * w.y
                             + vec3( nz.x, nz.y, 0.0 ) * w.z;
          // Fade by pixel footprint, so zoom, quality and screen DPI agree.
          float footprint = max( length( dFdx( p ) ), length( dFdy( p ) ) );
          float resolved = 1.0 - smoothstep( 0.008, 0.055, footprint );
          skinDetailGradient *= resolved;
          vec2 foldX = texture2D( uMicrofoldMap, p.yz + vec2( 0.17, 0.41 ) ).xy * 2.0 - 1.0;
          vec2 foldY = texture2D( uMicrofoldMap, p.xz + vec2( 0.53, 0.09 ) ).xy * 2.0 - 1.0;
          vec2 foldZ = texture2D( uMicrofoldMap, p.xy ).xy * 2.0 - 1.0;
          vec3 foreheadP = ( vSkinPosition - vec3( 0.0, 0.68, 1.03 ) ) / vec3( 0.52, 0.32, 0.42 );
          vec3 eyeP = ( vec3( abs( vSkinPosition.x ), vSkinPosition.yz ) - vec3( 0.34, 0.18, 0.99 ) ) / vec3( 0.21, 0.10, 0.22 );
          float foldRegion = max( exp( -dot( foreheadP, foreheadP ) ), exp( -dot( eyeP, eyeP ) ) );
          float foldStrength = mix( 0.10, 0.32, foldRegion ) * poreGain * uPoreScale * uMicrofoldReady * resolved;
          skinDetailGradient += ( vec3( 0.0, foldX.x, foldX.y ) * w.x
            + vec3( foldY.x, 0.0, foldY.y ) * w.y + vec3( foldZ, 0.0 ) * w.z ) * foldStrength;
          float pit = ( ax.z * w.x + ay.z * w.y + az.z * w.z ) * poreGain;
          float pigment = ( bx.w * w.x + by.w * w.y + bz.w * w.z ) * 2.0 - 1.0;
          vec3 variation = pigment * vec3( 0.55, 0.46, 0.36 ) - pit * 0.24;
          vec3 complexion = ( bx.rgb * w.x + by.rgb * w.y + bz.rgb * w.z ) * 2.0 - 1.0;
          variation = mix( variation, complexion - pit * 0.12, uImageDetail );
          float meso = ( ax.w * w.x + ay.w * w.y + az.w * w.z ) * 2.0 - 1.0;
          // The extra band is source colour variation, not relief: the face
          // retains its smooth silhouette and soft highlights at every zoom.
          vec3 portraitVariation = meso * vec3( 0.85, 1.0, 1.12 ) * uComplexionDetail
            * mix( 0.35, 1.0, poreGain ) * uImageDetail;
          diffuseColor.rgb *= 1.0 + ( variation * uAlbedoDetail + portraitVariation ) * uSkinEnabled;
          float rd = pit * 0.45 - pigment * 0.12;
          roughnessFactor = clamp( roughnessFactor + ( rd * uRoughDetail
            + ( 1.0 - resolved ) * uPoreScale * 0.045 ) * uSkinEnabled, 0.0, 1.0 );
          skinCcRough = rd * uRoughDetail;
          vec2 anatomyUv = ( vSkinPosition.xy - vec2( -1.05, -1.80 ) ) / vec2( 2.10, 3.25 );
          vec4 fineCrease = texture2D( uAnatomyFine, anatomyUv );
          float anatomyMask = smoothstep( 0.10, 0.60, vSkinPosition.z ) * uAnatomyReady;
          float eyeRegion = smoothstep( 0.10, 0.16, abs( vSkinPosition.x ) )
            * ( 1.0 - smoothstep( 0.48, 0.54, abs( vSkinPosition.x ) ) )
            * smoothstep( 0.015, 0.065, vSkinPosition.y )
            * ( 1.0 - smoothstep( 0.20, 0.245, vSkinPosition.y ) );
          float lipRegion = 1.0 - smoothstep( -0.12, -0.06, vSkinPosition.y );
          float fineStrength = lipRegion * uFineCreaseStrength;
          // Lips remain attached in rest space. Eye folds follow their own live
          // frames, independently of hand-drawn wrinkles and skin pore detail.
          vec2 creaseGradient = ( fineCrease.xy - vec2( 128.0 / 255.0 ) ) * 2.0 * fineStrength;
          skinAnatomyGradient = vec3( creaseGradient, 0.0 ) * anatomyMask;
          float creaseDepth = fineCrease.z * fineStrength;
          // A restrained contact term keeps fine folds readable under diffuse fill.
          diffuseColor.rgb *= 1.0 - clamp( creaseDepth * 0.32, 0.0, 0.22 ) * anatomyMask * uSkinEnabled;
          float eyeSide = vSkinCurrentPosition.x < ( uUnderEyeLeft.x + uUnderEyeRight.x ) * 0.5 ? -1.0 : 1.0;
          vec4 eyeFrame = eyeSide < 0.0 ? uUnderEyeLeft : uUnderEyeRight;
          float eyeCos = cos( eyeFrame.w ), eyeSin = sin( eyeFrame.w );
          vec2 eyeAxisX = vec2( eyeCos, eyeSin ) * eyeSide / eyeFrame.z;
          vec2 eyeAxisY = vec2( -eyeSin, eyeCos ) / eyeFrame.z;
          vec2 eyeDelta = vSkinCurrentPosition.xy - eyeFrame.xy;
          vec2 eyeLocal = vec2( dot( eyeDelta, eyeAxisX ), dot( eyeDelta, eyeAxisY ) );
          vec2 eyeUv = ( eyeLocal - vec2( -0.20, -0.18 ) ) / vec2( 0.52, 0.26 );
          float liveEyeRegion = smoothstep( 0.0, 0.06, eyeUv.x ) * ( 1.0 - smoothstep( 0.94, 1.0, eyeUv.x ) )
            * smoothstep( 0.0, 0.06, eyeUv.y ) * ( 1.0 - smoothstep( 0.94, 1.0, eyeUv.y ) );
          float eyeStrength = liveEyeRegion * smoothstep( 0.10, 0.60, vSkinPosition.z ) * uUnderEyeStrength;
          vec3 eyeFold = texture2D( uUnderEyeMap, eyeUv ).rgb;
          vec2 eyeGradient = ( eyeFold.rg * 255.0 - 128.0 ) / 127.0;
          skinEyeGradient = vec3( eyeAxisX * eyeGradient.x + eyeAxisY * eyeGradient.y, 0.0 ) * eyeStrength;
          diffuseColor.rgb *= 1.0 - clamp( eyeFold.b * 0.38 * eyeStrength, 0.0, 0.22 ) * uSkinEnabled;
          vec3 painted = texture2D( uPaintedWrinkles, vSkinUv ).rgb;
          skinPaintGradient = ( painted.rg * 255.0 - 128.0 ) / 127.0 * 8.0 * uWrinkleStrength;
          diffuseColor.rgb *= 1.0 - clamp( painted.b * uWrinkleStrength * 0.32, 0.0, 0.22 ) * uSkinEnabled;
          // Projection from the fixed authoring camera, evaluated in rest space.
          // This remains attached when the live camera moves or the head morphs.
          vec2 faceUv = 0.5 + ( vSkinPosition.xy - vec2( 0.0, 0.124098 ) )
            * 1.585797 / max( 0.1, 4.5 - vSkinPosition.z );
          vec4 faceColour = texture2D( uFaceColourMap, faceUv );
          float faceMask = smoothstep( 0.20, 0.80, restN.z ) * smoothstep( 0.45, 0.80, vSkinPosition.z );
          // Exclude baked forehead/eye lines from the source colour image.
          float noBakedFolds = 1.0 - max( max( eyeRegion, liveEyeRegion ), smoothstep( 0.28, 0.42, vSkinPosition.y ) );
          float faceAmount = faceMask * uFaceColourReady * uFaceColourStrength * noBakedFolds;
          diffuseColor.rgb *= 1.0 + ( faceColour.rgb * 2.0 - 1.0 ) * faceAmount * uSkinEnabled;
          skinPhotoHeight = ( faceColour.a * 2.0 - 1.0 ) * faceAmount * 0.0008;
        }`
      );

      // Move the rest-space detail onto the current surface, following morphs without a tangent map.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        skinMacroNormal = normal;
        {
          vec3 dp1 = dFdx( -vViewPosition );
          vec3 dp2 = dFdy( -vViewPosition );
          vec3 r1 = cross( dp2, normal );
          vec3 r2 = cross( normal, dp1 );
          float determinant = dot( dp1, r1 );
          float invDet = sign( determinant ) / max( abs( determinant ), 1e-10 );
          float ah1 = dot( skinAnatomyGradient, dFdx( vSkinPosition ) ) + dot( skinPaintGradient, dFdx( vSkinUv ) );
          float ah2 = dot( skinAnatomyGradient, dFdy( vSkinPosition ) ) + dot( skinPaintGradient, dFdy( vSkinUv ) );
          ah1 += dot( skinEyeGradient, dFdx( vSkinCurrentPosition ) );
          ah2 += dot( skinEyeGradient, dFdy( vSkinCurrentPosition ) );
          vec3 anatomyOffset = ( r1 * ah1 + r2 * ah2 ) * invDet;
          // Millimetre-scale folds shape diffuse light; only pore relief is softened by SSS.
          skinMacroNormal = normalize( normal + anatomyOffset * uSkinEnabled );
          float dh1 = dot( skinDetailGradient, dFdx( vSkinPosition ) ) - dFdx( skinPhotoHeight );
          float dh2 = dot( skinDetailGradient, dFdy( vSkinPosition ) ) - dFdy( skinPhotoHeight );
          normal = normalize( normal + ( anatomyOffset + ( r1 * dh1 + r2 * dh2 ) * invDet ) * uSkinEnabled );
        }`
      );

      // Make the clearcoat follow the detailed normal so skin oil sits in the pores and furrows.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clearcoat_normal_fragment_begin>',
        [
          '#include <clearcoat_normal_fragment_begin>',
          '#ifdef USE_CLEARCOAT',
          '  clearcoatNormal = normalize( mix( nonPerturbedNormal, normal, uClearcoatFollow * uSkinEnabled ) );',
          '#endif',
        ].join('\n')
      );

      // Work out curvature once from the smooth geometric normal, not the detailed one.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        [
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 gn = normalize( vNormal );',
          '  float dN = length( fwidth( gn ) );',
          '  float dP = max( length( fwidth( vViewPosition ) ), 1e-5 );',
          '  skinCurvature = clamp( ( dN / dP ) * uCurvatureScale + uCurvatureBias, 0.0, 1.0 );',
          '}',
          '#endif',
          '#include <lights_fragment_begin>',
        ].join('\n')
      );

      // Per-texel clearcoat roughness, reusing the roughness value already read.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_fragment>',
        [
          '#include <lights_physical_fragment>',
          '#ifdef USE_CLEARCOAT',
          '  material.clearcoatRoughness = clamp( clearcoatRoughness * mix( 0.70, 1.0, skinRoughTexel ) + geometryRoughness + skinCcRough * uSkinEnabled, 0.35, 1.0 );',
          // Keep oil mostly on the T-zone by following the roughness map.
          '  material.clearcoat *= mix( 1.0, mix( 0.25, 1.0, ( 1.0 - smoothstep( 0.32, 0.60, skinRoughTexel ) ) ), uSkinEnabled );',
          '#endif',
          '#ifdef USE_SHEEN',
          '  material.sheenColor *= uSkinEnabled;',
          '#endif',
        ].join('\n')
      );

      // Replace the direct diffuse term with the scattering lookup.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_pars_fragment>',
        [
          '#include <lights_physical_pars_fragment>',
          '',
          'void RE_Direct_Skin( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {',
          '',
          '  float dotNL = dot( geometryNormal, directLight.direction );',
          '  vec3 irradiance = saturate( dotNL ) * directLight.color;',
          '',
          '  #ifdef USE_CLEARCOAT',
          '    float dotNLcc = saturate( dot( geometryClearcoatNormal, directLight.direction ) );',
          '    vec3 ccIrradiance = dotNLcc * directLight.color;',
          '    clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );',
          '  #endif',
          '',
          '  #ifdef USE_SHEEN',
          '    sheenSpecularDirect += irradiance * BRDF_Sheen( directLight.direction, geometryViewDir, geometryNormal, material.sheenColor, material.sheenRoughness );',
          '  #endif',
          '',
          // Specular stays as it is; only diffuse light goes through the skin.
          '  reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );',
          '',
          // Soften the normal fed to scattering, since light entering a furrow leaves from the ridge next to it.
          '  vec3 sssN = normalize( mix( skinMacroNormal, geometryNormal, 0.4 ) );',
          '  float dotNLs = dot( sssN, directLight.direction );',
          '  vec3 sssIrradiance = texture2D( uSSSLut, vec2( dotNLs * 0.5 + 0.5, skinCurvature ) ).rgb * directLight.color;',
          '  vec3 diffuseIrradiance = mix( irradiance, sssIrradiance, uSSSStrength * uSkinEnabled );',
          '  reflectedLight.directDiffuse += diffuseIrradiance * BRDF_Lambert( material.diffuseColor );',
          '',
          '  #ifdef USE_SKIN_THICKNESS',
          // Red glow through thin parts such as ears and nostrils when lit from behind.
          '    vec3 backDir = normalize( directLight.direction + geometryNormal * 0.4 );',
          '    float back = pow( saturate( dot( geometryViewDir, -backDir ) ), 3.0 );',
          '    reflectedLight.directDiffuse += back * skinThickness * uTranslucency * uSkinEnabled * directLight.color * material.diffuseColor * vec3( 1.0, 0.38, 0.26 );',
          '  #endif',
          '}',
          '',
          '#undef RE_Direct',
          '#define RE_Direct RE_Direct_Skin',
        ].join('\n')
      );

      // Darken ambient light in creases so features don't look stuck on.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        [
          '#include <aomap_fragment>',
          'float skinCav = 1.0 - clamp( vCavity, 0.0, 1.0 ) * uCavityStrength * uSkinEnabled;',
          'reflectedLight.indirectDiffuse *= skinCav;',
          'reflectedLight.indirectSpecular *= skinCav;',
          // Direct light is darkened less, since it can reach partway into a crease.
          'reflectedLight.directDiffuse *= mix( 1.0, skinCav, 0.45 );',
          'reflectedLight.directSpecular *= mix( 1.0, skinCav, 0.45 );',
        ].join('\n')
      );
    };

    // Give materials with and without the thickness map separate shader cache keys.
    material.customProgramCacheKey = () =>
      'skin7-eye-local-folds' + (material.userData.skinShader.uniforms.uThicknessMap.value ? '-thick' : '');

    material.needsUpdate = true;
    return material;
  }

  // Turns the skin effects on or off without recompiling.
  static setEnabled(material, on) {
    const s = material && material.userData && material.userData.skinShader;
    if (!s) return;
    s.uniforms.uSkinEnabled.value = on ? 1.0 : 0.0;
  }

  // Updates tuning values on a live material.
  static setParams(material, params) {
    const s = material && material.userData && material.userData.skinShader;
    if (!s) return;
    const map = {
      sssStrength: 'uSSSStrength',
      curvatureScale: 'uCurvatureScale',
      curvatureBias: 'uCurvatureBias',
      poreScale: 'uPoreScale',
      lineScale: 'uLineScale',
      albedoDetail: 'uAlbedoDetail',
      complexionDetail: 'uComplexionDetail',
      wrinkleStrength: 'uWrinkleStrength',
      underEyeStrength: 'uUnderEyeStrength',
      fineCreaseStrength: 'uFineCreaseStrength',
      faceColourStrength: 'uFaceColourStrength',
      roughDetail: 'uRoughDetail',
      clearcoatFollow: 'uClearcoatFollow',
      cavityStrength: 'uCavityStrength',
      translucency: 'uTranslucency',
    };
    for (const key of Object.keys(params || {})) {
      const uname = map[key];
      if (uname && s.uniforms[uname]) s.uniforms[uname].value = params[key];
    }
  }

  // Binds a thickness map; this recompiles once because the back-glow code is switched by a define.
  static setThicknessMap(material, texture) {
    const s = material && material.userData && material.userData.skinShader;
    if (!s) return;
    const had = !!s.uniforms.uThicknessMap.value;
    s.uniforms.uThicknessMap.value = texture || null;
    if (had !== !!texture) material.needsUpdate = true;
  }

  // Returns a flat placeholder wrinkle map.
  static getEmptyWrinkleMap() {
    if (!SkinShader._emptyWrinkleMap) {
      SkinShader._emptyWrinkleMap = new THREE.DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1);
      SkinShader._emptyWrinkleMap.needsUpdate = true;
    }
    return SkinShader._emptyWrinkleMap;
  }

  // Sets the painted wrinkle map on a material, or the flat placeholder.
  static setWrinkleMap(material, texture) {
    const s = material?.userData?.skinShader;
    if (s) s.uniforms.uPaintedWrinkles.value = texture || SkinShader.getEmptyWrinkleMap();
  }
}

SkinShader._lut = null;
SkinShader._tiles = null;
SkinShader._tileUsers = new Set();
SkinShader._detailReady = null;
SkinShader._anatomyMaps = null;
SkinShader._anatomyReady = null;
SkinShader._microfoldTile = null;
SkinShader._microfoldReady = null;
SkinShader._faceColourMap = null;
SkinShader._faceColourReady = null;
SkinShader._cavityTimer = null;

window.SkinShader = SkinShader;
