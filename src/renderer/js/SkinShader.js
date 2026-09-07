/**
 * Skin shading for Three.js r160 MeshPhysicalMaterial.
 *
 * Original generated cheek detail is imported once into two linear data tiles:
 * A = normal XY, pore depression, spare; B = relative RGB complexion, pigment.
 * A deterministic procedural tile remains available while loading or on failure.
 * Rest-position triplanar sampling keeps detail continuous across UV seams and
 * attached during morphs, without the derivative distortion of UV * density(UV).
 * Macro anatomy, ageing, painted marks and skin tone remain in SkinTextureSystem.
 * The generated image is synthetic surface detail, not a measured identity map.
 *
 * Scattering LUT, thin-region transmission and cavity shading extend the stock
 * physical shader, preserving Three's lighting, shadow and environment paths.
 */

class SkinShader {

  // ── Diffusion profile ────────────────────────────────────────────────────
  /**
   * Six-Gaussian sum fit to measured Caucasian skin (d'Eon & Luebke, GPU Gems 3
   * ch. 14). Each entry is [variance in mm^2, rWeight, gWeight, bWeight].
   *
   * The channel spread is the whole point: red's widest lobe has ~50x the
   * variance of blue's, so red bleeds far past the terminator while blue stops
   * dead at it. That difference is what the eye reads as "flesh".
   */
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

  /** Sum of the profile's Gaussians at surface distance `r` (mm). */
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

  /**
   * Build the pre-integrated scattering lookup.
   *
   *   x axis → N·L remapped from [-1,1] to [0,1]
   *   y axis → surface curvature; y=1 is a 1mm radius (a nostril edge),
   *            y=0.05 is 20mm (a cheek). Flatter surfaces scatter less
   *            because the light arriving at neighbouring points is more
   *            similar, which the integral below captures for free.
   *
   * For each cell, walk a ring of surface positions around the shading point,
   * weight each by how far the light had to travel through skin to get there,
   * and average. That is the whole technique.
   */
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

  /** Cached LUT, shared by every skin material. */
  static getSSSLUT() {
    if (!SkinShader._lut) {
      const t0 = performance.now();
      SkinShader._lut = SkinShader.buildSSSLUT(128);
      console.log('[SkinShader] SSS LUT baked in ' + (performance.now() - t0).toFixed(1) + 'ms');
    }
    return SkinShader._lut;
  }

  // ── Tile-building primitives ─────────────────────────────────────────────

  /**
   * Deterministic per-cell hash rather than a running generator.
   * Consecutive draws of a Lehmer LCG fall on a coarse lattice, and any pores
   * jittered by them inherit that lattice and line up in rows. A hash of the
   * cell index has no sequence to correlate along, and being a pure function of
   * (x, y) it keeps the tile wrap exact.
   */
  static _hash2(ix, iy, salt) {
    let h = Math.imul(ix + 374761393, 2246822519)
          ^ Math.imul(iy + 668265263, 3266489917)
          ^ Math.imul(salt + 1, 374761393);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  static _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

  /**
   * Tileable value noise: `grid` cells across the tile, lattice values from the
   * hash, quintic fade, integer wrap so the tile edges meet exactly.
   */
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

  /** Wrapped 3x3 box blur, in place via a scratch buffer. */
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

  /** Wrapped height → tangent-space normal xy, unit-normalised, as [-1,1]. */
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
  /**
   * Two seamlessly tileable RGBA detail maps, each covering 16mm of skin.
   *
   *   Tile A:  xy = pore normal      z = pore pit mask     w = rank of nearest pore
   *   Tile B:  xy = line-net normal  z = oriented ridge slope (along tile v)
   *                                   w = pigment speckle (0.5 = none)
   *
   * Pores are cellular, not fractal — skin is a packed field of small pits —
   * so they come from a jittered Worley field with per-pore radius and depth.
   * Every pore also carries a RANK (a per-pore hash) in .w; the shader shows a
   * pore only when its rank is below the region's density. That is what lets
   * the nose carry dense pores and the eyelid almost none from ONE tile,
   * rather than fading every pore evenly, which just reads as blur.
   *
   * The primary line network is the part no earlier version had. Skin is not a
   * bumpy surface with holes in it; it is a surface scored by fine furrows at
   * roughly ±35° that cross into a diamond mesh, with a finer secondary set
   * between. Each family is a wave with an INTEGER wave-vector, so it is
   * periodic on the tile by construction, then phase-wobbled and amplitude-
   * modulated by tileable noise so no two furrows are alike.
   *
   * The oriented ridge is a single family of broader furrows along the tile's
   * u axis. The shader rotates it per fragment to the region's line direction.
   */
  static buildDetailTiles(size) {
    const R = size || 512;
    const N = R * R;
    const hash2 = SkinShader._hash2;
    const noise = (grid, salt) => SkinShader._tileNoise(R, grid, salt);
    const TAU = Math.PI * 2;

    // ── Pores ──
    // 64 cells per 16mm tile → 0.25mm spacing, the follicular density of a
    // cheek. Radius 0.35-0.7 of a cell → 0.09-0.17mm.
    const CELLS = 56;
    const cellSize = R / CELLS;
    const pJx = new Float32Array(CELLS * CELLS);
    const pJy = new Float32Array(CELLS * CELLS);
    const pRad = new Float32Array(CELLS * CELLS);
    const pDepth = new Float32Array(CELLS * CELLS);
    const pRank = new Float32Array(CELLS * CELLS);
    // Clustered density: pores are not a uniform lattice. A wrapped noise at
    // a fairly high frequency biases the rank so patches of skin are pore-rich
    // and other patches bare, without the pattern itself repeating visibly.
    const clusterN = noise(7, 9);
    for (let cy = 0; cy < CELLS; cy++) {
      for (let cx = 0; cx < CELLS; cx++) {
        const i = cy * CELLS + cx;
        pJx[i] = 0.15 + hash2(cx, cy, 1) * 0.7;
        pJy[i] = 0.15 + hash2(cx, cy, 2) * 0.7;
        /* One size variable drives both width and depth: on skin a wide
           follicular opening is a deep one. Drawn independently they combine
           into narrow-but-deep pits, which render as hard black specks. */
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
    // Between the pores the skin is not flat: a soft, broad undulation (the
    // orange-peel relief at 1-2mm) plus fine grain, blurred so it is texture
    // rather than pixel noise.
    {
      const und1 = noise(9, 71), und2 = noise(19, 72);
      for (let i = 0; i < N; i++) {
        const y = (i / R) | 0, x = i - y * R;
        poreH[i] += (und1[i] - 0.5) * 0.30 + (und2[i] - 0.5) * 0.16 + (hash2(x, y, 77) - 0.5) * 0.08;
      }
    }
    const poreHb = SkinShader._blur3(poreH, R);
    const poreN = SkinShader._heightToNormal(poreHb, R, 3.4 * (R / 512));

    // ── Primary line network ──
    // Wave-vectors are integers (cycles per tile) so each family tiles.
    // (29, 20) is 35.2 cycles at 34.6° → 0.45mm furrow spacing.
    const families = [
      { kx: 29, ky: 20, depth: 1.00, salt: 21 },
      { kx: 29, ky: -20, depth: 0.95, salt: 22 },
      { kx: 66, ky: 46, depth: 0.40, salt: 23 },
      { kx: 66, ky: -46, depth: 0.38, salt: 24 },
    ];
    const lineH = new Float32Array(N);
    for (const f of families) {
      /* Two phase fields: a coarse one that bends whole furrows and a fine
         one, at roughly the furrow spacing, that kinks them — so the network
         is a mesh of irregular polygons, not ruled hatching. The amplitude
         gate is thresholded so runs of each furrow vanish entirely, which is
         what real primary lines do: they stop and restart. */
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

    // ── Oriented ridge, along u ──
    // 8 cycles per tile → 2mm furrows: forehead lines, lip lines, crow's
    // feet, once the shader rotates them into the region's direction.
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

    // ── Pigment speckle ──
    // Melanin is produced in clusters a fraction of a millimetre across. A
    // sharpened high-frequency noise, so it is spots rather than a haze.
    const speck = new Float32Array(N);
    {
      const s1 = noise(96, 51), s2 = noise(200, 52), gate = noise(11, 53);
      for (let i = 0; i < N; i++) {
        let v = (s1[i] - 0.5) * 2;
        v = Math.sign(v) * Math.pow(Math.abs(v), 0.6);
        speck[i] = v * (0.55 + gate[i] * 0.6) * 0.8 + (s2[i] - 0.5) * 0.5;
      }
    }

    // ── Pack ──
    // Raw RGBA bytes, not a canvas: canvas 2D premultiplies by alpha on
    // putImageData, and both tiles carry data in alpha (pore rank, speckle).
    // A rank of 0.05 would have crushed that texel's normal to 12 levels.
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

  /** Wrapped separable box filter; runs once when importing the detail asset. */
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

  /** Import synthetic surface contrast, without baking its beige tone onto a face.
   * Height inferred from contrast is an artistic approximation, not scan depth.
   * Half-tile crossfades make the field periodic even if the image edges differ.
   */
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
    // Keep the source's millimetre-scale variation as well as individual pores.
    // This band survives portrait-size mip levels without enlarging the pores.
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

  /** Original anatomy fields authored in Blender; shared across skin materials. */
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

  /** Fine skin folds complement the follicular pore tile at a lower strength. */
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

  /** Remove broad illumination from the generated face before re-lighting it. */
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
      // DataTexture rows are explicitly inverted to conventional bottom-up UVs.
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
  /**
   * Write a per-vertex `aCavity` attribute measuring how concave the surface
   * is at each vertex.
   *
   * Ambient light physically cannot reach the inside of a nostril, the inner
   * corner of an eye socket, the fold behind an ear or the crease under a jaw.
   * With no occlusion term every one of those sits at the same brightness as
   * the cheek beside it, and features end up looking appliquéd onto the face
   * rather than part of it.
   *
   * Measured as the mean of dot(normalize(neighbour - vertex), normal) over the
   * one-ring. Convex points have neighbours falling away below the tangent
   * plane (negative mean, no occlusion); concave points have neighbours rising
   * above it (positive mean, occluded).
   *
   * A vertex attribute rather than a baked texture, for two reasons: it needs
   * no second UV channel, and it can be recomputed after a morph in a few
   * milliseconds, which a bake cannot. OBJMorpher deforms this mesh constantly,
   * so anything baked would be stale the moment a slider moved.
   */
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
      // Keep the undeformed surface coordinates: pores move with the face.
      if (!geo.attributes.aSkinPosition || geo.attributes.aSkinPosition.count !== pos.count) {
        geo.setAttribute('aSkinPosition', pos.clone());
      }
      const nrm = geo.attributes.normal;
      if (!nrm) continue;
      const N = pos.count;

      // Topology never changes under morphing, so the adjacency is built once
      // and cached on the geometry. Rebuilding it per morph would dominate.
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

      /* Smoothing. One pass was not enough.
         The raw one-ring measure is dominated by how evenly the mesh happens
         to be triangulated: on the 18k-vertex head this app ships, an isolated
         vertex whose neighbours sit slightly high reads as concave even in the
         middle of a convex surface. A single averaging pass leaves plenty of
         that through, and multiplying what survives by 7 turned it into
         visible per-vertex blotching across the nose and forehead — patches
         that follow the triangulation, which is exactly what makes a render
         look faceted and low-poly regardless of the actual polygon count.
         Three passes push the residue below the threshold where the eye picks
         out the mesh, while genuine features — nostril, eye corner, the fold
         behind an ear — span many vertices and survive all three intact. */
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

      // Only concavity occludes; convex vertices get zero. The scale maps the
      // typical concavity range of a head mesh onto a usable 0-1.
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

  /** Compressed-sparse-row one-ring adjacency from the index buffer. */
  static _buildAdjacency(geo, N) {
    const index = geo.index;
    if (!index) return null;
    const idx = index.array;
    const triCount = idx.length / 3;

    // Pass 1: degree count (with duplicates; shared edges appear twice, which
    // simply weights those neighbours slightly higher — harmless here).
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

  /**
   * Recompute cavity after a morph, coalescing the burst of calls a slider
   * drag produces into one pass on the trailing edge.
   */
  static scheduleCavity(target) {
    if (SkinShader._cavityTimer) clearTimeout(SkinShader._cavityTimer);
    SkinShader._cavityTimer = setTimeout(() => {
      SkinShader._cavityTimer = null;
      SkinShader.computeCavity(target);
    }, 120);
  }

  // ── Attachment ───────────────────────────────────────────────────────────

  static get DEFAULTS() {
    return {
      sssStrength: 0.7,
      // Model units are ~100mm per unit (a 2.2-unit head is ~220mm), and the
      // LUT's y axis is curvature in mm^-1, hence the 0.01 conversion.
      curvatureScale: 0.01,
      // A floor so broad areas still get some wrap. Physically a flat plane
      // scatters nothing visible, but a face has subsurface structure the
      // curvature estimate cannot see, and zero wrap there reads as plastic.
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

  /**
   * Install the skin shading onto a MeshPhysicalMaterial.
   * Idempotent — calling twice on the same material is a no-op.
   */
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

      // ── Vertex ──
      // Own UV varying rather than three's vNormalMapUv: that one only exists
      // when a normalMap is bound, and the procedural maps arrive a frame or
      // two after the first paint.
      shader.vertexShader =
        'varying vec2 vSkinUv;\n' +
        'attribute float aCavity;\n' +
        'attribute vec3 aSkinPosition;\n' +
        'varying vec3 vSkinPosition;\n' +
        'varying float vCavity;\n' +
        shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\tvSkinUv = uv;\n\tvCavity = aCavity;\n\tvSkinPosition = aSkinPosition;'
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
        'uniform sampler2D uPaintedWrinkles;\n' +
        'uniform float uFineCreaseStrength;\n' +
        'uniform sampler2D uMicrofoldMap;\n' +
        'uniform float uMicrofoldReady;\n' +
        'uniform sampler2D uFaceColourMap;\n' +
        'uniform float uFaceColourReady;\n' +
        'uniform float uFaceColourStrength;\n' +
        'varying vec3 vSkinPosition;\n' +
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
        'float skinPhotoHeight = 0.0;\n' +
        'vec2 skinPaintGradient = vec2( 0.0 );\n' +
        'float skinCcRough = 0.0;\n' +
        'float skinRoughTexel = 1.0;\n' +
        'vec3 skinMacroNormal = vec3( 0.0, 0.0, 1.0 );\n' +
        shader.fragmentShader;

      // Three projections in rest space: a fixed physical scale, no UV seams.
      // The pore samples are shared across colour, roughness and surface relief;
      // regional anatomy, microfold and facial colour layers add separate detail.
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
          vec4 ageCrease = texture2D( uAnatomyAge, anatomyUv );
          float anatomyMask = smoothstep( 0.10, 0.60, vSkinPosition.z ) * uAnatomyReady;
          float eyeRegion = smoothstep( 0.10, 0.16, abs( vSkinPosition.x ) )
            * ( 1.0 - smoothstep( 0.48, 0.54, abs( vSkinPosition.x ) ) )
            * smoothstep( 0.015, 0.065, vSkinPosition.y )
            * ( 1.0 - smoothstep( 0.20, 0.245, vSkinPosition.y ) );
          float lipRegion = 1.0 - smoothstep( -0.12, -0.06, vSkinPosition.y );
          float fineStrength = lipRegion * uFineCreaseStrength + eyeRegion * uUnderEyeStrength;
          float ageStrength = eyeRegion * uUnderEyeStrength;
          // Forehead and other age folds are drawn by the operator. Only the
          // separately enabled under-eye preset samples the old anatomy field.
          vec2 creaseGradient = ( fineCrease.xy - vec2( 128.0 / 255.0 ) ) * 2.0 * fineStrength
            + ( ageCrease.xy - vec2( 128.0 / 255.0 ) ) * 2.0 * ageStrength;
          skinAnatomyGradient = vec3( creaseGradient, 0.0 ) * anatomyMask;
          float creaseDepth = fineCrease.z * fineStrength + ageCrease.z * ageStrength;
          // A restrained contact term keeps fine folds readable under diffuse fill.
          diffuseColor.rgb *= 1.0 - clamp( creaseDepth * 0.32, 0.0, 0.22 ) * anatomyMask * uSkinEnabled;
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
          float noBakedFolds = 1.0 - max( eyeRegion, smoothstep( 0.28, 0.42, vSkinPosition.y ) );
          float faceAmount = faceMask * uFaceColourReady * uFaceColourStrength * noBakedFolds;
          diffuseColor.rgb *= 1.0 + ( faceColour.rgb * 2.0 - 1.0 ) * faceAmount * uSkinEnabled;
          skinPhotoHeight = ( faceColour.a * 2.0 - 1.0 ) * faceAmount * 0.0008;
        }`
      );

      // Transform the rest-space surface gradient into the current surface.
      // This follows morphs, mesh rotation and mirrored UVs without a tangent map.
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
          vec3 anatomyOffset = ( r1 * ah1 + r2 * ah2 ) * invDet;
          // Millimetre-scale folds shape diffuse light; only pore relief is softened by SSS.
          skinMacroNormal = normalize( normal + anatomyOffset * uSkinEnabled );
          float dh1 = dot( skinDetailGradient, dFdx( vSkinPosition ) ) - dFdx( skinPhotoHeight );
          float dh2 = dot( skinDetailGradient, dFdy( vSkinPosition ) ) - dFdy( skinPhotoHeight );
          normal = normalize( normal + ( anatomyOffset + ( r1 * dh1 + r2 * dh2 ) * invDet ) * uSkinEnabled );
        }`
      );

      // ── Clearcoat follows the surface ──
      // three evaluates the clearcoat lobe on the unperturbed normal, so the
      // oil sheen ignored every wrinkle and pore and slid over the face as one
      // continuous highlight. Skin oil sits IN the furrows and ON the pores;
      // the lobe has to see them.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clearcoat_normal_fragment_begin>',
        [
          '#include <clearcoat_normal_fragment_begin>',
          '#ifdef USE_CLEARCOAT',
          '  clearcoatNormal = normalize( mix( nonPerturbedNormal, normal, uClearcoatFollow * uSkinEnabled ) );',
          '#endif',
        ].join('\n')
      );

      // ── Curvature, evaluated once before the light loop ──
      // Derived from the interpolated geometric normal, NOT the shaded normal:
      // feeding pore detail into the curvature estimate would make every pore
      // scatter like a nose tip.
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

      // ── Per-texel clearcoat roughness and mode-gated sheen ──
      // The clearcoat roughness map used to be the roughness map bound a
      // second time; the same value is already in scope, so it is applied
      // here with the micro-detail on top, and one texture unit is freed.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_fragment>',
        [
          '#include <lights_physical_fragment>',
          '#ifdef USE_CLEARCOAT',
          '  material.clearcoatRoughness = clamp( clearcoatRoughness * mix( 0.70, 1.0, skinRoughTexel ) + geometryRoughness + skinCcRough * uSkinEnabled, 0.35, 1.0 );',
          // The oil film is a T-zone thing. A uniform clearcoat over cheek,
          // jaw and forehead alike was the single loudest plastic cue left;
          // here it follows the roughness map, so the dry cheek has a quarter
          // of the nose's oil.
          '  material.clearcoat *= mix( 1.0, mix( 0.25, 1.0, ( 1.0 - smoothstep( 0.32, 0.60, skinRoughTexel ) ) ), uSkinEnabled );',
          '#endif',
          '#ifdef USE_SHEEN',
          '  material.sheenColor *= uSkinEnabled;',
          '#endif',
        ].join('\n')
      );

      // ── Take over the direct diffuse term ──
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
          // Specular is untouched: the oily surface layer reflects, it does not
          // scatter. Only the diffuse lobe goes through the skin.
          '  reflectedLight.directSpecular += irradiance * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );',
          '',
          // Scattering blurs the micro-relief: light entering a furrow leaves
          // from the ridge beside it. The LUT is fed a normal part-way back to
          // the macro surface, or every furrow shades as a hard Lambert edge.
          '  vec3 sssN = normalize( mix( skinMacroNormal, geometryNormal, 0.4 ) );',
          '  float dotNLs = dot( sssN, directLight.direction );',
          '  vec3 sssIrradiance = texture2D( uSSSLut, vec2( dotNLs * 0.5 + 0.5, skinCurvature ) ).rgb * directLight.color;',
          '  vec3 diffuseIrradiance = mix( irradiance, sssIrradiance, uSSSStrength * uSkinEnabled );',
          '  reflectedLight.directDiffuse += diffuseIrradiance * BRDF_Lambert( material.diffuseColor );',
          '',
          '  #ifdef USE_SKIN_THICKNESS',
          // Light entering the far side of a thin part and leaving toward the
          // eye. Tinted hard toward red because that is the only wavelength
          // that survives the trip through several millimetres of tissue.
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

      // ── Cavity occlusion ──
      // Ambient light cannot reach the inside of a nostril or the corner of an
      // eye socket. Without this every feature looks appliquéd onto the face.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        [
          '#include <aomap_fragment>',
          'float skinCav = 1.0 - clamp( vCavity, 0.0, 1.0 ) * uCavityStrength * uSkinEnabled;',
          'reflectedLight.indirectDiffuse *= skinCav;',
          'reflectedLight.indirectSpecular *= skinCav;',
          // Direct light is occluded less than ambient — it arrives from one
          // direction and can still reach partway into a crease.
          'reflectedLight.directDiffuse *= mix( 1.0, skinCav, 0.45 );',
          'reflectedLight.directSpecular *= mix( 1.0, skinCav, 0.45 );',
        ].join('\n')
      );
    };

    // Materials with and without the thickness map compile to different
    // programs; without this they would share one and the second would render
    // with the first's shader.
    material.customProgramCacheKey = () =>
      'skin6-painted-folds' + (material.userData.skinShader.uniforms.uThicknessMap.value ? '-thick' : '');

    material.needsUpdate = true;
    return material;
  }

  /** Toggle the skin stack without a recompile (Photoreal ↔ Structure). */
  static setEnabled(material, on) {
    const s = material && material.userData && material.userData.skinShader;
    if (!s) return;
    s.uniforms.uSkinEnabled.value = on ? 1.0 : 0.0;
  }

  /** Update one or more tuning parameters on a live material. */
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

  /**
   * Bind a thickness/control map. Triggers one recompile, because the
   * back-scatter branch is a #define — it is a per-pixel texture fetch that
   * should not run at all when there is no map to fetch from.
   */
  static setThicknessMap(material, texture) {
    const s = material && material.userData && material.userData.skinShader;
    if (!s) return;
    const had = !!s.uniforms.uThicknessMap.value;
    s.uniforms.uThicknessMap.value = texture || null;
    if (had !== !!texture) material.needsUpdate = true;
  }

  static getEmptyWrinkleMap() {
    if (!SkinShader._emptyWrinkleMap) {
      SkinShader._emptyWrinkleMap = new THREE.DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1);
      SkinShader._emptyWrinkleMap.needsUpdate = true;
    }
    return SkinShader._emptyWrinkleMap;
  }

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
