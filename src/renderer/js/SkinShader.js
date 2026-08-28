/**
 * SkinShader.js
 * Turns a MeshPhysicalMaterial into a skin material.
 *
 * WHY
 * ---
 * A standard PBR material models an opaque dielectric. Skin is not opaque: light
 * enters the epidermis, bounces around in the dermis, and leaves somewhere else.
 * Red light travels furthest, which is why a real face glows warm where the
 * light grazes it and why ear rims go orange against a lamp. None of that is
 * expressible with `roughness` and `metalness`, and its absence is precisely the
 * "waxy plastic mannequin" look this file exists to remove.
 *
 * WHAT IT ADDS
 * ------------
 *  1. Pre-integrated subsurface scattering (Penner & Borshukov 2011). The
 *     expensive part — convolving the diffuse falloff with a skin diffusion
 *     profile — is precomputed once into a 2D lookup indexed by (N·L, surface
 *     curvature). At runtime the direct diffuse term becomes one texture fetch.
 *  2. Back-scatter through thin parts (ears, nose wings, lips), driven by a
 *     thickness map.
 *  3. A tiled pore/microdetail normal. The macro texture is ~1mm per texel on a
 *     whole head, so pores physically cannot resolve there; they have to come
 *     from a high-frequency map tiled many times over the UVs.
 *  4. Cavity occlusion from a per-vertex attribute, darkening creases.
 *
 * HOW IT ATTACHES
 * ---------------
 * Via `onBeforeCompile`, not a custom ShaderMaterial, so three's shadow, IBL,
 * decal, vertex-colour and fog paths keep working untouched. The injection
 * points were read off three r160's chunks directly — `RE_Direct` is a #define
 * alias, so redefining it after `lights_physical_pars_fragment` is enough to
 * take over the diffuse term while leaving specular, clearcoat and sheen alone.
 *
 * Everything is gated on a `uSkinEnabled` uniform rather than a #define so the
 * Photoreal/Structure toggle costs no shader recompile.
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

  // ── Pore / microdetail normal ────────────────────────────────────────────
  /**
   * A seamlessly tileable pore normal map.
   *
   * Pores are cellular, not fractal — skin is a packed field of small pits, so
   * the height field is built from distance-to-nearest-feature-point (Worley)
   * rather than value noise. Fine fractal noise is layered under it for the
   * microtexture between pores.
   *
   * Tileability comes from wrapping the feature-point lookup at the grid edges,
   * which matters because this gets repeated ~14x across the face.
   */
  static buildPoreNormal(size) {
    const R = size || 512;
    const canvas = document.createElement('canvas');
    canvas.width = R;
    canvas.height = R;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(R, R);
    const d = img.data;

    /* Deterministic per-cell hash rather than a running generator.
       Each feature point's jitter used to be two consecutive draws of a Lehmer
       LCG, which is the textbook case where consecutive tuples fall on a
       coarse lattice — the pores inherited that lattice and lined up in rows.
       A hash of the cell index has no sequence to correlate along, and being a
       pure function of (x, y) it keeps the wrap below exact. */
    const hash2 = (ix, iy, salt) => {
      let h = Math.imul(ix + 374761393, 2246822519)
            ^ Math.imul(iy + 668265263, 3266489917)
            ^ Math.imul(salt + 1, 374761393);
      h = Math.imul(h ^ (h >>> 15), 2246822519);
      h = Math.imul(h ^ (h >>> 13), 3266489917);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };

    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

    /* Pore density in patches. One pore per cell forever is the single most
       artificial thing about a Worley pore map — real pores cluster, and leave
       stretches of bare skin between the clusters. This is a wrapped value
       noise at DGRID cycles per tile that gates whether a cell gets a pore at
       all. Kept at a fairly high frequency on purpose: the tile repeats 32x
       across a face, so a low-frequency field here would repeat 32 times and
       read as a pattern of its own. */
    const DGRID = 7;
    const dGrid = new Float32Array(DGRID * DGRID);
    for (let i = 0; i < DGRID * DGRID; i++) {
      dGrid[i] = hash2(i % DGRID, (i / DGRID) | 0, 9);
    }
    const density = (u, v) => {
      const gx = u * DGRID, gy = v * DGRID;
      const ix = Math.floor(gx), iy = Math.floor(gy);
      const fx = fade(gx - ix), fy = fade(gy - iy);
      const i0 = ix % DGRID, i1 = (ix + 1) % DGRID;
      const j0 = iy % DGRID, j1 = (iy + 1) % DGRID;
      const top = dGrid[j0 * DGRID + i0] + (dGrid[j0 * DGRID + i1] - dGrid[j0 * DGRID + i0]) * fx;
      const bot = dGrid[j1 * DGRID + i0] + (dGrid[j1 * DGRID + i1] - dGrid[j1 * DGRID + i0]) * fx;
      return top + (bot - top) * fy;
    };

    /* Per-pore attributes, all keyed on the wrapped cell index so the tile
       stays seamless. CELLS is unchanged: it sets the physical pore spacing,
       which was already tuned against poreRepeat, and the irregularity below
       comes from varying the pores rather than from moving them. */
    const CELLS = 48;
    const cellSize = R / CELLS;
    const pJx = new Float32Array(CELLS * CELLS);
    const pJy = new Float32Array(CELLS * CELLS);
    const pRad = new Float32Array(CELLS * CELLS);
    const pDepth = new Float32Array(CELLS * CELLS);
    const pOn = new Uint8Array(CELLS * CELLS);

    for (let cy = 0; cy < CELLS; cy++) {
      for (let cx = 0; cx < CELLS; cx++) {
        const i = cy * CELLS + cx;
        pJx[i] = hash2(cx, cy, 1);
        pJy[i] = hash2(cx, cy, 2);
        /* One size variable drives both width and depth, because on skin they
           go together — a wide follicular opening is a deep one. Drawn
           independently they combine into narrow-but-deep pits, which render
           as hard black specks rather than pores. A smaller independent term
           keeps the relationship from being exactly linear.

           Radius, 0.55x to 1.45x, divides the distance falloff, so a wide pore
           claims more of the surrounding area as well as being wide — a
           multiplicatively weighted Worley. Uniform-radius pits were the other
           half of why the old map read as a machined pattern. Depth averages
           1.0 so the overall relief matches what poreScale was tuned against;
           only its spread is new. */
        const sz = hash2(cx, cy, 4);
        pRad[i] = 0.55 + sz * 0.90;
        pDepth[i] = 0.55 + sz * 0.55 + hash2(cx, cy, 5) * 0.35;
        const d = density((cx + 0.5) / CELLS, (cy + 0.5) / CELLS);
        pOn[i] = hash2(cx, cy, 3) < (0.30 + d * 0.62) ? 1 : 0;
      }
    }

    const height = new Float32Array(R * R);

    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const cx = Math.floor(x / cellSize);
        const cy = Math.floor(y / cellSize);

        let best = 1e9, bestDepth = 1;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            // Wrap so the pattern tiles with no seam.
            const gx = ((cx + ox) % CELLS + CELLS) % CELLS;
            const gy = ((cy + oy) % CELLS + CELLS) % CELLS;
            const pi = gy * CELLS + gx;
            if (!pOn[pi]) continue;

            const px = (cx + ox + pJx[pi]) * cellSize;
            const py = (cy + oy + pJy[pi]) * cellSize;
            const dx = x - px, dy = y - py;
            const dist = Math.sqrt(dx * dx + dy * dy) / (cellSize * pRad[pi]);
            if (dist < best) { best = dist; bestDepth = pDepth[pi]; }
          }
        }

        /* Normalised distance to the nearest pore centre → a shallow pit.
           0.65 is the flat skin level; a pore cuts down from it by its own
           depth, so cells with no pore and cells far from one both sit flat. */
        const h = best > 1 ? 1 : best;
        height[y * R + x] = 0.65 * (1 - bestDepth * (1 - h * h));
      }
    }

    /* Fine grain between the pores. Hashed per texel rather than drawn in
       scanline order from a running generator, for the same reason as the
       jitter above. */
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        height[y * R + x] += (hash2(x, y, 77) - 0.5) * 0.12;
      }
    }

    // Blur the grain slightly so it becomes texture rather than pixel noise.
    const blurred = new Float32Array(R * R);
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        let sum = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const nx = (x + ox + R) % R;
            const ny = (y + oy + R) % R;
            sum += height[ny * R + nx];
          }
        }
        blurred[y * R + x] = sum / 9;
      }
    }

    // ── Height → normal ──
    const STRENGTH = 2.4;
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const l = blurred[y * R + ((x - 1 + R) % R)];
        const r = blurred[y * R + ((x + 1) % R)];
        const u = blurred[((y - 1 + R) % R) * R + x];
        const dn = blurred[((y + 1) % R) * R + x];

        let nx = (l - r) * STRENGTH;
        let ny = (u - dn) * STRENGTH;
        let nz = 1.0;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= inv; ny *= inv; nz *= inv;

        const i = (y * R + x) * 4;
        d[i]     = ((nx * 0.5 + 0.5) * 255) | 0;
        d[i + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
        d[i + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
        d[i + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /** Cached pore map, shared by every skin material. */
  static getPoreNormal() {
    if (!SkinShader._pore) {
      const t0 = performance.now();
      SkinShader._pore = SkinShader.buildPoreNormal(512);
      console.log('[SkinShader] Pore map built in ' + (performance.now() - t0).toFixed(1) + 'ms');
    }
    return SkinShader._pore;
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
      // typical concavity range of a head mesh onto a usable 0-1. Lower than
      // the previous 7.0 because smoothing no longer leaves spikes that needed
      // clamping away, so the gain can serve the real features instead.
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
      // A pore is ~0.3mm. At 14 tiles the cells landed nearer 2mm, which reads
      // as orange peel or stucco rather than skin — visible texture at the
      // wrong scale is worse than none.
      poreRepeat: 32.0,
      poreScale: 0.30,
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

    const uniforms = {
      uSSSLut: { value: SkinShader.getSSSLUT() },
      uPoreMap: { value: SkinShader.getPoreNormal() },
      uThicknessMap: { value: null },
      uSSSStrength: { value: cfg.sssStrength },
      uCurvatureScale: { value: cfg.curvatureScale },
      uCurvatureBias: { value: cfg.curvatureBias },
      uPoreRepeat: { value: cfg.poreRepeat },
      uPoreScale: { value: cfg.poreScale },
      uCavityStrength: { value: cfg.cavityStrength },
      uTranslucency: { value: cfg.translucency },
      uSkinEnabled: { value: 1.0 },
    };

    material.userData.skinShader = { uniforms, hasThickness: false };

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
        'varying float vCavity;\n' +
        shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\tvSkinUv = uv;\n\tvCavity = aCavity;'
      );

      // ── Fragment prelude ──
      shader.fragmentShader =
        defines +
        'uniform sampler2D uSSSLut;\n' +
        'uniform sampler2D uPoreMap;\n' +
        '#ifdef USE_SKIN_THICKNESS\nuniform sampler2D uThicknessMap;\n#endif\n' +
        'uniform float uSSSStrength;\n' +
        'uniform float uCurvatureScale;\n' +
        'uniform float uCurvatureBias;\n' +
        'uniform float uPoreRepeat;\n' +
        'uniform float uPoreScale;\n' +
        'uniform float uCavityStrength;\n' +
        'uniform float uTranslucency;\n' +
        'uniform float uSkinEnabled;\n' +
        'varying vec2 vSkinUv;\n' +
        'varying float vCavity;\n' +
        'float skinCurvature = 0.0;\n' +
        'float skinThickness = 0.0;\n' +
        shader.fragmentShader;

      // ── Pore detail normal ──
      // The tangent frame is derived here from screen-space derivatives rather
      // than reusing three's `tbn`, which is only declared when a normal map is
      // bound. Mikkelsen's construction; also automatically correct after a
      // morph, since nothing is baked.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        [
          '#include <normal_fragment_maps>',
          '{',
          '  vec3 sp = - vViewPosition;',
          '  vec3 dp1 = dFdx( sp );',
          '  vec3 dp2 = dFdy( sp );',
          '  vec2 duv1 = dFdx( vSkinUv );',
          '  vec2 duv2 = dFdy( vSkinUv );',
          '  vec3 dp2perp = cross( dp2, normal );',
          '  vec3 dp1perp = cross( normal, dp1 );',
          '  vec3 skinT = dp2perp * duv1.x + dp1perp * duv2.x;',
          '  vec3 skinB = dp2perp * duv1.y + dp1perp * duv2.y;',
          '  float invmax = inversesqrt( max( dot( skinT, skinT ), dot( skinB, skinB ) ) );',
          // Pores are sub-millimetre. Held at full strength when the camera is
          // close, faded out as it pulls back, or they alias into crawling
          // noise that looks worse than no detail at all.
          '  float poreFade = 1.0 - smoothstep( 3.5, 10.0, length( vViewPosition ) );',
          '  vec3 dN = texture2D( uPoreMap, vSkinUv * uPoreRepeat ).xyz * 2.0 - 1.0;',
          '  float poreAmt = uPoreScale * poreFade * uSkinEnabled;',
          '  normal = normalize( normal + ( skinT * dN.x + skinB * dN.y ) * invmax * poreAmt );',
          '}',
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
          '#ifdef USE_SKIN_THICKNESS',
          'skinThickness = texture2D( uThicknessMap, vSkinUv ).r;',
          '#endif',
          '#include <lights_fragment_begin>',
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
          '  vec3 sssIrradiance = texture2D( uSSSLut, vec2( dotNL * 0.5 + 0.5, skinCurvature ) ).rgb * directLight.color;',
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
      'skin' + (material.userData.skinShader.uniforms.uThicknessMap.value ? '-thick' : '');

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
      poreRepeat: 'uPoreRepeat',
      poreScale: 'uPoreScale',
      cavityStrength: 'uCavityStrength',
      translucency: 'uTranslucency',
    };
    for (const key of Object.keys(params || {})) {
      const uname = map[key];
      if (uname && s.uniforms[uname]) s.uniforms[uname].value = params[key];
    }
  }

  /**
   * Bind a thickness map. Triggers one recompile, because the back-scatter
   * branch is a #define — it is a per-pixel texture fetch that should not run
   * at all when there is no map to fetch from.
   */
  static setThicknessMap(material, texture) {
    const s = material && material.userData && material.userData.skinShader;
    if (!s) return;
    const had = !!s.uniforms.uThicknessMap.value;
    s.uniforms.uThicknessMap.value = texture || null;
    if (had !== !!texture) material.needsUpdate = true;
  }
}

SkinShader._lut = null;
SkinShader._pore = null;
SkinShader._cavityTimer = null;

window.SkinShader = SkinShader;
