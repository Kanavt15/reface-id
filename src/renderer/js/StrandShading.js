/**
 * StrandShading.js
 * Hair shading: the strand maps that give a hair card its silhouette and its
 * internal variation, and the scattering model that lights it.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * HairSystem records why the hair and beard were made fully opaque: the styles
 * are solid card geometry with no alpha map, triangles are not sorted within a
 * mesh, and blending them produced blocky see-through patches in arbitrary
 * order. That reasoning is correct — but the consequence is a polygonal
 * silhouette, which is one of the loudest CG tells on a head.
 *
 * `alphaTest` resolves the tradeoff rather than trading back into it. A cutout
 * material still writes depth and still needs no sorting, so none of the
 * artefacts that forced opacity can return; it just gets a strand-shaped edge
 * instead of a card-shaped one.
 *
 * WHAT THE CUTOUT ALONE DID NOT FIX
 * ---------------------------------
 * A cutout gives the mass a hair-shaped outline and stops there. Everything
 * inside the outline was still a flat card taking a single Lambert value, so
 * the hair photographed as hard black and khaki slabs with a step between
 * neighbouring cards and no gradient across any one of them. Three separate
 * things were missing, and the silhouette work could not supply any of them:
 *
 *   - Variation WITHIN a card. Real hair is thousands of strands at slightly
 *     different tones, darker at the root and lighter at the tip. One flat
 *     albedo across a card cannot read as that no matter how it is lit.
 *   - A strand-shaped normal. A card is geometrically flat, so its highlight
 *     is a flat wash. Each strand is a cylinder, and it is the cylinders that
 *     break light into the fine streaks the eye reads as hair.
 *   - A hair response to light. Hair is not a rough dielectric surface. It has
 *     no point highlight; it has bands, it scatters forward through the mass,
 *     and its second reflection comes back carrying the hair's own colour.
 *     Lambert-plus-GGX cannot produce any of that.
 *
 * So the maps below are generated as a matched set from ONE strand layout —
 * coverage, tone and normal in register, because a tip that tapers in the
 * cutout has to be the same tip that lightens in the tone and rounds off in
 * the normal — and `attachSheen` replaces the standard direct-lighting term
 * with a hair one rather than adding a highlight on top of it.
 *
 * Eyebrows and eyelashes are a different case: those assets are real strand
 * geometry (35k and 42k vertices of individual hairs) and carry no UVs at all,
 * so there is nothing to map a strand texture onto. What they needed was to
 * stop being semi-transparent — overlapping strands blended in arbitrary order
 * is exactly what made them read as a fuzzy decal floating over the brow. They
 * take the same lighting model, minus the parts that need a UV; see the
 * fallback in `attachSheen`.
 */

class StrandShading {

  /** Encoding headroom for the tone channel: strands may run 27% over mid. */
  static get TONE_SCALE() { return 200; }

  /**
   * One irregular run of strand centres across u, shared by every map.
   *
   * The maps have to agree strand for strand. Generating them from separate
   * random walks would put a tone boundary in the middle of a coverage strand
   * and a normal ridge in the gap between two others, and the result reads as
   * three unrelated noises rather than as one set of hairs.
   *
   * Hair card UVs conventionally run u across the card's width and v along its
   * length, so strands are vertical bands here, tapering toward v=1 where the
   * tips are. Widths and gaps vary because evenly spaced strands read as a
   * comb rather than as hair.
   */
  static _buildLayout(width) {
    let seed = 20260826;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    /* Wide strands, narrow gaps.
     *
     * The job here is to feather the SILHOUETTE of a hair card, not to punch
     * it full of holes. A first pass used thin strands with wide gaps and cut
     * away so much of every card that the hair mass went transparent and lit
     * up as pale wisps — a worse result than the solid blob it replaced.
     * Coverage stays high; the variation lives at the card's edges and tips,
     * which is the part the eye actually reads as hair. */
    const strands = [];
    let x = 0;
    while (x < width) {
      const w = 3.0 + rnd() * 7.0;
      strands.push({
        x: x + w * 0.5,
        w: w,
        // Most strands run nearly the full card; a few stop short so the tip
        // edge is ragged rather than cut straight across.
        len: 0.66 + rnd() * 0.34,
        /* Per-strand tone. Real hair reads as a mass precisely because its
           strands do not share a value — a few catch the light, most sit mid,
           some are nearly black. The spread is deliberately wide; at a narrow
           one the card goes straight back to looking painted. */
        tone: 0.55 + rnd() * 0.62,
        // Free per-strand random, carried through so the lighting can shift
        // and glint each strand differently. See shiftR and glint.
        id: rnd(),
        // A slow lengthwise waver, so strands are not perfectly parallel bars.
        wave: (rnd() - 0.5) * 2.2,
        phase: rnd() * 6.283,
      });
      x += w + rnd() * 1.1;
    }
    return strands;
  }

  /**
   * Coverage, tone and strand id — three channels of one texture.
   *
   * They ride together rather than in separate maps because three samples
   * `alphaMap.g` for the cutout and ignores the rest, which leaves exactly the
   * two channels this needs free, and because a second texture sampled at the
   * same UV would only be a slower way of guaranteeing the register that one
   * texture gives for nothing.
   *
   *   r — per-strand tone: how light this particular strand is
   *   g — coverage; this is the channel three's alphamap_fragment reads
   *   b — a per-strand random constant, for specular shift and glint
   *
   * All three vary across u and are constant along v, because a hair card's
   * strands run along v. Nothing here ramps root to tip; see the note at the
   * assignment for why that cannot live in a texture on an atlased asset.
   *
   * Alpha is held at 255 on purpose. A 2D canvas stores its pixels
   * premultiplied, so any channel written under a low alpha comes back
   * quantised toward zero — the tone and id channels would be destroyed in the
   * gaps between strands and, worse, at the tapering tips where they matter
   * most. Nothing reads this texture's alpha channel, so keeping it opaque
   * costs nothing and keeps the other three intact.
   */
  static buildStrandMap(size) {
    const W = size || 512;
    const H = size || 512;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const strands = StrandShading._buildLayout(W);
    const img = ctx.createImageData(W, H);
    const d = img.data;
    let toneSum = 0, toneKept = 0;

    for (let y = 0; y < H; y++) {
      const v = y / (H - 1);
      for (let px = 0; px < W; px++) {
        let cov = 0, tone = 0.85, id = 0.5;

        for (const st of strands) {
          // Wrap the distance so the strip tiles horizontally.
          const cx = st.x + Math.sin(v * 3.1 + st.phase) * st.wave;
          let dx = px - cx;
          if (dx > W * 0.5) dx -= W;
          if (dx < -W * 0.5) dx += W;
          const half = st.w * 0.5;
          if (Math.abs(dx) > half) continue;

          // Soft edge across the strand, so it does not cut as a hard bar.
          const edge = 1 - Math.pow(Math.abs(dx) / half, 3.0);
          // Strand ends: coverage falls away past its own length.
          const tip = 1 - Math.max(0, (v - st.len) / Math.max(0.05, 1 - st.len));
          const a = edge * tip;
          if (a > cov) {
            cov = a;
            /* Strand to strand only — deliberately nothing along v.
             *
             * A root-to-tip ramp belongs here in principle, and it was here,
             * and it had to come out. These assets are atlased: one card owns
             * v 0..0.333 and its neighbour owns 0.667..1.0, so a ramp in
             * texture space is not a ramp along a strand — it is a constant
             * offset per card, and the hair photographed with the cards
             * outlined in it as visible rectangles. The atlas defeats the
             * shader and the texture equally; there is no v anywhere that
             * means "distance along this strand".
             *
             * What the ramp was really standing in for is that hair is dark
             * inside the mass and light on the outside, and that IS available
             * — from the geometry, not from any UV. See computeStrandDepth. */
            tone = st.tone;
            id = st.id;
          }
        }

        const i = (y * W + px) * 4;
        d[i]     = Math.min(255, (tone * StrandShading.TONE_SCALE) | 0);
        d[i + 1] = (Math.min(1, cov * 1.35) * 255) | 0;
        d[i + 2] = (id * 255) | 0;
        d[i + 3] = 255;

        // Mean over the pixels that survive the cutout — the ones in the gaps
        // are never shaded, so averaging them in would bias the figure dark.
        if (cov > 0.25) { toneSum += tone; toneKept++; }
      }
    }

    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    /* Measured, not assumed.
     *
     * The shader divides the sampled tone by this to get a multiplier that
     * averages 1.0, so per-strand variation lightens and darkens around the
     * albedo the user picked instead of quietly shifting it. Writing the
     * figure down as a literal would be a landmine: it depends on the tone
     * spread and the root-to-tip ramp above, so any retune of those would
     * silently start darkening or blowing out every head of hair in the app. */
    tex.userData.toneMean = (toneKept ? toneSum / toneKept : 1) *
      (StrandShading.TONE_SCALE / 255);
    return tex;
  }

  /**
   * A tangent-space normal that bows across every strand.
   *
   * This is the map that stops a card from lighting as a card. Each strand is
   * a cylinder, so its normal sweeps from one side to the other across the
   * strand's width; laid side by side, that is what splits a single broad
   * highlight into the fine parallel streaks hair actually shows. Built from
   * the same layout as the coverage above, so every ridge sits on a strand and
   * every crease lands in a gap.
   */
  static buildStrandNormal(size) {
    const W = size || 512;
    const H = size || 512;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const strands = StrandShading._buildLayout(W);
    const img = ctx.createImageData(W, H);
    const d = img.data;

    for (let y = 0; y < H; y++) {
      const v = y / (H - 1);
      for (let px = 0; px < W; px++) {
        let nx = 0, ny = 0, best = -1;

        for (const st of strands) {
          const cx = st.x + Math.sin(v * 3.1 + st.phase) * st.wave;
          let dx = px - cx;
          if (dx > W * 0.5) dx -= W;
          if (dx < -W * 0.5) dx += W;
          const half = st.w * 0.5;
          if (Math.abs(dx) > half) continue;

          const t = dx / half;           // -1 at one edge, +1 at the other
          const w = 1 - Math.abs(t);     // nearest strand wins the pixel
          if (w <= best) continue;
          best = w;
          // Cylinder cross-section, flattened: a full hemisphere of normal
          // over a few pixels aliases into a hard rim, so the sweep is capped.
          nx = Math.sin(t * 1.15);
          // The lengthwise waver tilts the strand slightly off vertical.
          ny = Math.sin(v * 3.1 + st.phase) * st.wave * 0.035;
        }

        const nz = Math.sqrt(Math.max(0.04, 1 - nx * nx - ny * ny));
        const i = (y * W + px) * 4;
        d[i]     = ((nx * 0.5 + 0.5) * 255) | 0;
        d[i + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
        d[i + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
        d[i + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Tile periods of the strand map across a mesh's bounding diagonal.
   *
   * Measured off Hair 3, which is the style the shading was tuned on: its kept
   * mesh has a diagonal of 44.8 model units and 0.0608 UV units per model
   * unit, so the `repeat: 3` that looked right there works out to 3 x 44.8 x
   * 0.0608. Every other style is scaled to hit the same figure, which is the
   * only way one shared material can give fourteen differently-unwrapped
   * assets the same physical strand width. See normalizeStrandUv.
   */
  static get TARGET_TILES() { return 8.2; }

  /** UV area per unit of surface area — how densely a mesh is unwrapped. */
  static _uvDensity(geometry) {
    const uvAttr = geometry.attributes.uv;
    const pos = geometry.attributes.position;
    if (!uvAttr || !pos) return 0;
    const uv = uvAttr.array, p = pos.array, idx = geometry.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    let uvArea = 0, modelArea = 0;
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx.getX(t * 3) : t * 3;
      const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      modelArea += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
      uvArea += 0.5 * Math.abs(
        (uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) -
        (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1]));
    }
    return modelArea > 1e-12 ? Math.sqrt(uvArea / modelArea) : 0;
  }

  /**
   * Give a mesh usable strand UVs when the asset shipped without any.
   *
   * Hair7.glb and Hair14.glb carry a TEXCOORD_0 whose every vertex is the same
   * point, (0, 1). That is not a poor unwrap, it is no unwrap: the whole mesh
   * samples a single texel of the strand map, and the texel at (0, 1) happens
   * to be a gap between two strands, so the cutout discarded every triangle
   * and both styles rendered as a bald head with a few shards floating round
   * it. Nothing in the shading model can recover from that — there is no
   * direction to run strands along and no coverage to vary.
   *
   * The substitute is polar about the centre of the hair mass: u is the
   * azimuth, and v is the angle down from straight up — 0 at the crown, 1 at
   * whatever hangs lowest. Since the strand map runs its strands along v, that
   * makes them flow radially outward from the crown and then down the sides,
   * which is how hair grows out of a whorl and how it then falls.
   *
   * A cylinder was the obvious first choice — u around, v by height — and it
   * is wrong in exactly one place, which happens to be the place you look at.
   * Height barely changes across the top of a skull, so over the crown the
   * strand direction goes undefined and the map smears into vertical bars: the
   * head renders as though behind a picket fence. Taking v as the polar angle
   * instead is what makes it vary fastest precisely where height varies least.
   *
   * Two artefacts remain, both narrow. Triangles crossing the +/-pi azimuth
   * seam get a u jump of about 1, so a compressed strip of texture and an
   * unreliable tangent; and u still collapses at the pole itself, thinning the
   * strands over a small patch at the very top. Both are local, where the
   * cylinder's failure was not. A seamless parameterisation needs connectivity
   * analysis this does not justify for two assets out of fourteen.
   */
  static ensureStrandUv(geometries) {
    const geos = (Array.isArray(geometries) ? geometries : [geometries]).filter(Boolean);
    if (!geos.length) return;

    const box = new THREE.Box3();
    for (const g of geos) {
      g.computeBoundingBox();
      box.union(g.boundingBox);
    }
    const cx = (box.min.x + box.max.x) * 0.5;
    const cy = (box.min.y + box.max.y) * 0.5;
    const cz = (box.min.z + box.max.z) * 0.5;

    for (const g of geos) {
      // A real unwrap has area; a collapsed one has none. This is the same
      // test either way, so a mesh with no attribute at all also lands here.
      if (StrandShading._uvDensity(g) > 1e-9) continue;

      const p = g.attributes.position.array;
      const n = g.attributes.position.count;
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const x = p[i * 3] - cx, y = p[i * 3 + 1] - cy, z = p[i * 3 + 2] - cz;
        const r = Math.max(1e-9, Math.hypot(x, y, z));
        uv[i * 2] = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
        // 0 straight up at the crown, 1 straight down — so v increases the way
        // hair grows, and the map's tip taper lands at the hanging ends.
        uv[i * 2 + 1] = Math.acos(Math.max(-1, Math.min(1, y / r))) / Math.PI;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.userData.strandUvSynthesized = true;
    }
  }

  /**
   * Scale each mesh's u so every style gets the same physical strand width.
   *
   * The strand map tiles across u, and how many times it tiles over a given
   * piece of hair depends entirely on how the artist unwrapped it. Measured
   * across the fourteen styles that ratio spans more than a factor of four —
   * Hair 3 and Hair 4 are modelled at roughly quadruple the unit scale of the
   * rest — so the single `repeat` value tuned on Hair 3 would have left most
   * of the others with strands three to five times too wide, reading as
   * painted bands rather than hair.
   *
   * It goes into the geometry rather than the material because there is only
   * one hair material and fourteen styles share it; a texture transform is
   * per-material and cannot express a per-mesh correction. These assets carry
   * no textures of their own — every hair GLB in the set has zero images — so
   * the UV channel is free to rewrite for our own use.
   *
   * Only u is touched. v runs along the strand, where the map is nearly
   * constant apart from the taper at the tip; rescaling it would repeat that
   * taper down the length of every card as periodic banding.
   */
  static normalizeStrandUv(geometries) {
    const geos = (Array.isArray(geometries) ? geometries : [geometries])
      .filter(g => g && g.attributes.uv && !g.userData.strandUvNormalized);
    if (!geos.length) return;

    const box = new THREE.Box3();
    for (const g of geos) {
      g.computeBoundingBox();
      box.union(g.boundingBox);
    }
    const diag = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y,
                            box.max.z - box.min.z);
    if (!(diag > 1e-9)) return;

    for (const g of geos) {
      const density = StrandShading._uvDensity(g);
      if (!(density > 1e-9)) continue;
      // Clamped only as a guard against a degenerate mesh driving the scale to
      // an absurd value — the measured styles all land between about 3 and 14.
      const scale = Math.max(0.5, Math.min(24,
        StrandShading.TARGET_TILES / (diag * density)));
      const uv = g.attributes.uv.array;
      for (let i = 0; i < uv.length; i += 2) uv[i] *= scale;
      g.attributes.uv.needsUpdate = true;
      g.userData.strandUvNormalized = true;
      g.userData.strandUvScale = scale;
    }
  }

  /**
   * Everything a hair style's geometry needs before it can be shaded, in the
   * one order that works: synthesise UVs where there are none, then scale
   * them (which has to measure the UVs that now exist), then measure the mass.
   */
  static prepareStrandGeometry(geometries) {
    StrandShading.ensureStrandUv(geometries);
    StrandShading.normalizeStrandUv(geometries);
    StrandShading.computeStrandDepth(geometries);
  }

  /**
   * How deep inside the hair mass each vertex sits, as a 0..1 vertex attribute.
   *
   * This is the cue the texture could not carry. A head of hair is nearly
   * black a centimetre in and catches all its light on the outer shell, and
   * without that the mass reads as a single sheet of strands with no volume
   * behind it — which is what the flat cards were already failing at.
   *
   * Measured as the local density of hair SURFACE, not of vertices. Vertex
   * count is a bad proxy for card geometry: one big card spanning half the
   * fringe may carry four vertices while a tight curl carries two hundred, so
   * a vertex-density field would read the fringe as empty air. Triangle area
   * binned into a coarse grid measures how much hair is actually present in a
   * region, which is the thing that occludes.
   *
   * The attribute is named so that a MISSING one means "not occluded": WebGL
   * feeds absent attributes as zero, and zero has to be the harmless value.
   * The eyebrow and beard materials run the same shader without ever calling
   * this, and if the polarity were the other way round they would silently
   * render black.
   *
   * Takes every geometry of a style at once, and has to. A style is three or
   * four meshes that interleave in space — a cap under a fringe under a fall
   * — and a mesh measuring only its own triangles would report the fringe as
   * hanging in clear air while the cap it is lying against reports the same.
   * One grid over all of them is what makes the field describe the hair
   * rather than the mesh split.
   */
  static computeStrandDepth(geometries) {
    const geos = (Array.isArray(geometries) ? geometries : [geometries])
      .filter(g => g && g.attributes.position && !g.attributes.aStrandDepth);
    if (!geos.length) return;

    const box = new THREE.Box3();
    for (const g of geos) {
      g.computeBoundingBox();
      box.union(g.boundingBox);
    }
    const sx = Math.max(1e-4, box.max.x - box.min.x);
    const sy = Math.max(1e-4, box.max.y - box.min.y);
    const sz = Math.max(1e-4, box.max.z - box.min.z);

    /* Coarse on purpose. The field wants to describe the mass, not the cards
       inside it; at a fine resolution every voxel holds one card and the
       result is card-shaped again, which is the artefact this replaces. */
    const RES = 14;
    const cell = Math.max(sx, sy, sz) / RES;
    const nx = Math.max(1, Math.ceil(sx / cell));
    const ny = Math.max(1, Math.ceil(sy / cell));
    const nz = Math.max(1, Math.ceil(sz / cell));
    const grid = new Float32Array(nx * ny * nz);

    const cellOf = (x, y, z) => {
      const ix = Math.min(nx - 1, Math.max(0, ((x - box.min.x) / cell) | 0));
      const iy = Math.min(ny - 1, Math.max(0, ((y - box.min.y) / cell) | 0));
      const iz = Math.min(nz - 1, Math.max(0, ((z - box.min.z) / cell) | 0));
      return (iz * ny + iy) * nx + ix;
    };

    // Bin each triangle's area at its centroid, across every mesh at once.
    for (const g of geos) {
      const p = g.attributes.position.array;
      const idx = g.index;
      const triCount = idx ? idx.count / 3 : g.attributes.position.count / 3;
      for (let t = 0; t < triCount; t++) {
        const a = (idx ? idx.getX(t * 3) : t * 3) * 3;
        const b = (idx ? idx.getX(t * 3 + 1) : t * 3 + 1) * 3;
        const c = (idx ? idx.getX(t * 3 + 2) : t * 3 + 2) * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const cxn = uy * vz - uz * vy;
        const cyn = uz * vx - ux * vz;
        const czn = ux * vy - uy * vx;
        const area = 0.5 * Math.sqrt(cxn * cxn + cyn * cyn + czn * czn);
        grid[cellOf((p[a] + p[b] + p[c]) / 3,
                    (p[a + 1] + p[b + 1] + p[c + 1]) / 3,
                    (p[a + 2] + p[b + 2] + p[c + 2]) / 3)] += area;
      }
    }

    /* Normalise against a high percentile rather than the maximum. One dense
       voxel — a knot at the crown, a fold where cards stack — would otherwise
       set the scale for the whole head and flatten everything else to zero. */
    const occupied = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] > 0) occupied.push(grid[i]);
    if (!occupied.length) return;
    occupied.sort((p, q) => p - q);
    const ref = occupied[Math.min(occupied.length - 1, Math.floor(occupied.length * 0.85))] || 1;

    // 3x3x3 average, so the field varies smoothly instead of stepping at the
    // voxel boundaries and putting a grid back into the shading.
    for (const g of geos) {
      const p = g.attributes.position.array;
      const n = g.attributes.position.count;
      const depth = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const ix = Math.min(nx - 1, Math.max(0, ((p[i * 3] - box.min.x) / cell) | 0));
        const iy = Math.min(ny - 1, Math.max(0, ((p[i * 3 + 1] - box.min.y) / cell) | 0));
        const iz = Math.min(nz - 1, Math.max(0, ((p[i * 3 + 2] - box.min.z) / cell) | 0));
        let sum = 0, cnt = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const jz = iz + dz; if (jz < 0 || jz >= nz) continue;
          for (let dy = -1; dy <= 1; dy++) {
            const jy = iy + dy; if (jy < 0 || jy >= ny) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const jx = ix + dx; if (jx < 0 || jx >= nx) continue;
              sum += grid[(jz * ny + jy) * nx + jx];
              cnt++;
            }
          }
        }
        // Neighbourhoods clipped by the bounding box average over fewer cells;
        // dividing by the count keeps the edge of the box from reading as air.
        depth[i] = Math.min(1, (sum / Math.max(1, cnt)) / ref);
      }
      g.setAttribute('aStrandDepth', new THREE.BufferAttribute(depth, 1));
    }
  }

  static getStrandMap() {
    if (!StrandShading._map) StrandShading._map = StrandShading.buildStrandMap(512);
    return StrandShading._map;
  }

  static getStrandNormal() {
    if (!StrandShading._normal) StrandShading._normal = StrandShading.buildStrandNormal(512);
    return StrandShading._normal;
  }

  /**
   * Turn a solid hair-card material into a cutout one, and give it the strand
   * normal that goes with the cutout.
   *
   * `transparent` stays false on purpose. A cutout material is opaque as far as
   * the renderer is concerned — it writes depth, sorts by depth like any other
   * solid, and so cannot reproduce the arbitrary-order blending that made the
   * original transparent version unusable.
   *
   * `alphaToCoverage` is what takes the jaggedness off that cutout. It resolves
   * the strand edge through the MSAA samples the scene is already rendering
   * with (PostFX's scene target is 4x, and the default framebuffer is
   * antialiased for the passes that bypass it), so the edge softens without
   * anything entering the alpha pass and without any sorting. Where there is
   * no MSAA it degenerates silently to the hard cutout, which is where this
   * started — so it can only help.
   *
   * The repeat arguments stay at 1 for the hair. Strand density is a per-style
   * quantity and this is a per-material setting, so it cannot live here; the
   * scale is baked into each geometry's u instead. See normalizeStrandUv.
   */
  static applyCardAlpha(material, repeatU, repeatV) {
    if (!material) return material;
    const ru = repeatU || 1, rv = repeatV || 1;

    const tex = StrandShading.getStrandMap().clone();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(ru, rv);
    tex.needsUpdate = true;

    const nrm = StrandShading.getStrandNormal().clone();
    nrm.wrapS = THREE.RepeatWrapping;
    nrm.wrapT = THREE.ClampToEdgeWrapping;
    nrm.repeat.set(ru, rv);
    nrm.needsUpdate = true;

    material.alphaMap = tex;
    material.normalMap = nrm;
    /* Strong enough to break the card into strands, well short of the value
       that turns the highlight into noise: the map already sweeps a full 1.15
       radians across a strand a few pixels wide, so it does not need help. */
    material.normalScale = new THREE.Vector2(0.55, 0.55);
    material.alphaTest = 0.32;
    material.alphaToCoverage = true;
    material.transparent = false;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    material.needsUpdate = true;
    return material;
  }

  /**
   * Replace the surface's direct-lighting term with a hair one.
   *
   * Hair is not a rough dielectric, and shading it as one is what made the
   * mass read as painted slabs. Three things it does that a standard material
   * cannot:
   *
   *   - It has no point highlight. Each strand is a cylinder, so it reflects
   *     in a ring, and a head of them reflects in a BAND running across the
   *     strands. Where that band sits depends on the strand direction, not on
   *     the surface normal, which is why this needs a tangent.
   *   - Light goes THROUGH it. A strand mass lit from behind glows; the
   *     terminator is soft and the far side never reaches black. A Lambert
   *     term gives a hard terminator and a black back, which is most of why
   *     the baseline had a step between neighbouring cards.
   *   - It reflects twice, and the second one is coloured. Light that enters a
   *     strand, bounces inside and comes back out has been filtered by the
   *     hair's own pigment. That is the broad warm band sitting below the
   *     white one, and it is the single most recognisable thing about how hair
   *     looks. Marschner calls these two R and TRT; the shifted lobes below
   *     are the cheap version of them.
   *
   * THE TANGENT
   * -----------
   * None of these assets carry a tangent attribute, and hair cards would need
   * authored flow directions to have one. But they do carry UVs, and the card
   * convention puts v along the strand — so the direction in which v increases
   * across the surface IS the strand direction, and that is recoverable per
   * pixel from screen-space derivatives without any new attribute. A card's UV
   * scale drops out under normalisation, so the tiling repeat does not disturb
   * it.
   *
   * Where there is no UV at all — the eyebrow and eyelash strand meshes — the
   * derivative is meaningless and the code falls back to shifting the normal
   * along view-up, which is the approximation this file used everywhere before
   * the tangent was available. It is wrong, but it is wrong in a way that
   * still reads as a band, and those assets are 3mm of hair viewed head-on.
   */
  static attachSheen(material, options) {
    if (!material || material.userData.strandSheen) return material;
    const cfg = Object.assign({
      /* R: the tight near-white band off the cuticle. Takes the light's colour
       * with only a slight warm bias — it has not been inside the hair.
       *
       * The strength looks tiny next to the TRT below, and it has to be. This
       * is the one term that is WHITE on top of an albedo as dark as hair, so
       * it sets the hue of anything it touches: at 0.30 it buried a dark brown
       * head under what photographed as steel wool, and the band is broad —
       * every H perpendicular to the strand is in it, which is a great circle,
       * not a spot. Read the two numbers together: the white lobe is a glint
       * on top, the coloured one carries the light. */
      sheenStrength: 0.085,
      sheenTint: new THREE.Color(0xfff2e2),
      sheenExponent: 150.0,
      sheenShift: -0.10,
      // TRT: the broad band that HAS been inside, so it is tinted by the hair
      // and lands further down the strand. Wider, softer, and it glints. Safe
      // to run hot precisely because it is multiplied by the hair's own colour.
      trtStrength: 0.13,
      trtExponent: 38.0,
      trtShift: 0.22,
      /* How far the transmission tint is pulled toward the light's own
         colour. At 0 it is the hair's hue at full saturation, which on a dark
         brown is a copper that reads as gold streaks; near 1 it is a plain
         warm sheen that only hints at the hair's colour. See trtTint. */
      trtDesat: 0.78,
      // Also white, also unconditional, and it is added once rather than per
      // light — so it needs to stay near the floor for the same reason as R.
      rimStrength: 0.06,
      rootDarken: 0.35,
      // Forward scattering through the mass: how far past the terminator the
      // light carries. 0 is Lambert.
      scatter: 0.5,
      toneStrength: 1.0,
    }, options || {});

    const uniforms = {
      uSheenStrength: { value: cfg.sheenStrength },
      uSheenTint: { value: cfg.sheenTint },
      uSheenExp: { value: cfg.sheenExponent },
      uSheenShift: { value: cfg.sheenShift },
      uTrtStrength: { value: cfg.trtStrength },
      uTrtExp: { value: cfg.trtExponent },
      uTrtShift: { value: cfg.trtShift },
      uTrtDesat: { value: cfg.trtDesat },
      uRimStrength: { value: cfg.rimStrength },
      uRootDarken: { value: cfg.rootDarken },
      uScatter: { value: cfg.scatter },
      uToneStrength: { value: cfg.toneStrength },
      // Filled in at compile time from the map itself; see below.
      uToneMean: { value: 1.0 },
    };
    material.userData.strandSheen = { uniforms };

    /* Chain rather than replace.
     *
     * onBeforeCompile is a single slot, so assigning it here silently discards
     * whatever the caller installed first. That is exactly what happened to
     * the eyelash material: it had a fragment clip attached one line earlier,
     * and this overwrote it, so the clip compiled into nothing and every
     * attempt to tune it looked like it had no effect. */
    const priorCompile = material.onBeforeCompile;
    const priorKey = material.customProgramCacheKey;

    material.onBeforeCompile = (shader, renderer) => {
      if (typeof priorCompile === 'function') priorCompile(shader, renderer);

      /* Carry the mass-depth attribute through to the fragment stage.
         Declared unconditionally: a geometry without it feeds zero, which
         this defines as "not occluded", so the materials that never run
         computeStrandDepth are unaffected. */
      shader.vertexShader =
        'attribute float aStrandDepth;\n' +
        'varying float vStrandDepth;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          'vStrandDepth = aStrandDepth;\n#include <begin_vertex>'
        );

      /* Read the map here rather than in the constructor: attachSheen and
         applyCardAlpha are two independent calls in either order, and only by
         compile time is the material guaranteed to have both. */
      const mean = material.alphaMap && material.alphaMap.userData.toneMean;
      uniforms.uToneMean.value = mean || 1.0;
      Object.assign(shader.uniforms, uniforms);

      /* Globals, not varyings or function arguments.
       *
       * The strand frame is needed inside RE_Direct, which three calls from
       * its own light loop with a fixed signature there is no way to add to.
       * A file-scope variable written in main() before that loop runs is the
       * only channel into it. */
      shader.fragmentShader =
        'uniform float uSheenStrength;\n' +
        'uniform vec3 uSheenTint;\n' +
        'uniform float uSheenExp;\n' +
        'uniform float uSheenShift;\n' +
        'uniform float uTrtStrength;\n' +
        'uniform float uTrtExp;\n' +
        'uniform float uTrtShift;\n' +
        'uniform float uTrtDesat;\n' +
        'uniform float uRimStrength;\n' +
        'uniform float uRootDarken;\n' +
        'uniform float uScatter;\n' +
        'uniform float uToneStrength;\n' +
        'uniform float uToneMean;\n' +
        'varying float vStrandDepth;\n' +
        'vec3 gStrandT = vec3( 0.0, 1.0, 0.0 );\n' +
        'float gStrandId = 0.5;\n' +
        'float gStrandOpen = 1.0;\n' +
        shader.fragmentShader;

      /* Per-strand tone, applied to the base colour before lighting.
         After <color_fragment> so it multiplies whatever the vertex-colour
         tint painter has already put there rather than replacing it. */
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          /* Mass occlusion, before anything else touches the albedo.
             Held clear of zero: hair deep in the mass is very dark but it is
             never a hole, and letting it reach black punches one through the
             silhouette wherever the field peaks. */
          '{',
          '  gStrandOpen = mix( 1.0, 1.0 - uRootDarken, clamp( vStrandDepth, 0.0, 1.0 ) );',
          '  diffuseColor.rgb *= gStrandOpen;',
          '}',
          '#ifdef USE_ALPHAMAP',
          '{',
          '  vec3 packed = texture2D( alphaMap, vAlphaMapUv ).rgb;',
          '  gStrandId = packed.b;',
          // r carries the strand's own tone with the root-to-tip ramp already
          // folded in. Dividing by the map's measured mean holds the overall
          // level where the user's colour put it and leaves uToneStrength as
          // a pure variation control rather than a hidden exposure.
          '  float tone = mix( 1.0, packed.r / uToneMean, uToneStrength );',
          '  diffuseColor.rgb *= tone;',
          '}',
          '#else',
          '#ifndef FLAT_SHADED',
          '{',
          /* No UV, so no baked ramp: fall back to the view-space cue this file
             used before the maps existed. It is a poor stand-in for
             root-to-tip — it swims as the camera orbits — but on 3mm of
             eyebrow seen head-on that never shows. */
          '  vec3 sN = normalize( vNormal );',
          '  float depthCue = smoothstep( -0.6, 0.9, sN.z );',
          '  diffuseColor.rgb *= mix( 1.0 - uRootDarken, 1.0, depthCue );',
          '}',
          '#endif',
          '#endif',
        ].join('\n')
      );

      /* The hair lighting model, swapped in for the standard one.
         Injected after lights_physical_pars_fragment because that is where
         PhysicalMaterial and RE_Direct_Physical are declared — and the #undef
         has to come after three's own #define, not before it. */
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_pars_fragment>',
        [
          '#include <lights_physical_pars_fragment>',
          '',
          // Kajiya-Kay: the highlight is strongest where the half vector is
          // perpendicular to the strand, so it is the sine of the angle
          // between them, not the cosine — a band across the strands rather
          // than a point on the surface.
          'float rfStrandBand( vec3 T, vec3 N, vec3 H, float shift, float expo ) {',
          '  vec3 Ts = normalize( T + shift * N );',
          '  float dotTH = dot( Ts, H );',
          '  float sinTH = sqrt( max( 1e-4, 1.0 - dotTH * dotTH ) );',
          '  return pow( sinTH, expo );',
          '}',
          '',
          'void RE_Direct_Strand( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {',
          '  vec3 N = geometryNormal;',
          '  vec3 V = geometryViewDir;',
          '  vec3 L = directLight.direction;',
          '  vec3 H = normalize( L + V );',
          '  float ndl = dot( N, L );',
          '',
          // Wrapped diffuse. Light entering a hair mass scatters forward
          // through several strands before it leaves, so the terminator is
          // soft and the shadow side keeps a fraction of the light. The
          // denominator is the usual energy correction, so widening the wrap
          // spreads the light rather than adding more of it.
          '  float wrapped = clamp( ( ndl + uScatter ) / ( ( 1.0 + uScatter ) * ( 1.0 + uScatter ) ), 0.0, 1.0 );',
          '  reflectedLight.directDiffuse += directLight.color * wrapped * BRDF_Lambert( material.diffuseColor );',
          '',
          /* Both bands are scaled by the same wrapped term as the diffuse.
             A specular that is not tied to whether the light actually reaches
             the strand is what turned the first pass into steel wool: with a
             constant floor under it, every card kept a white band whichever
             way it faced, including the ones the key light never reached, and
             a broad Kajiya-Kay lobe put that band nearly everywhere. Sharing
             the diffuse's visibility keeps the highlight on the lit side and
             still lets it carry a little past the terminator, which is the
             one thing hair genuinely does. */
          // Scaled by the same occlusion as the albedo: a strand buried in the
          // mass does not catch a highlight either, and leaving the bands out
          // of it puts a full-strength glint on hair that should be in the
          // dark, which reads as the whole mass being made of surface.
          '  float vis = wrapped * gStrandOpen;',
          '',
          /* R — off the cuticle, the light's own colour, shifted toward the
           * root.
           *
           * The jitter is wide, and that is the whole reason the band works
           * on cards. A card is flat, so its strand direction barely changes
           * across it, so an unjittered lobe evaluates to almost the same
           * number over the entire quad and the hair renders as slabs with a
           * hard step at every card boundary. Scattering the shift per strand
           * puts neighbouring strands at different points on the same band,
           * which is what a card cannot do with geometry and real hair gets
           * for free from having actual separate strands. */
          '  float shiftR = uSheenShift + ( gStrandId - 0.5 ) * 0.38;',
          '  float bandR = rfStrandBand( gStrandT, N, H, shiftR, uSheenExp );',
          '  reflectedLight.directSpecular += directLight.color * uSheenTint * ( uSheenStrength * bandR * vis );',
          '',
          // TRT — through the strand and back out, so it carries the hair's
          // pigment, sits lower down the strand, and glints on the ones that
          // happen to face right.
          '  float shiftT = uTrtShift + ( gStrandId - 0.5 ) * 0.50;',
          '  float bandT = rfStrandBand( gStrandT, N, H, shiftT, uTrtExp );',
          /* A narrow spread, because this multiplies a lobe that is already
             scattered per strand by the shift above. Stacking a 2.6x glint
             range on top of that made every lit strand either full copper or
             nothing, and a head of those reads as rust stripes rather than as
             hair catching light. */
          '  float glint = 0.72 + 0.56 * gStrandId;',
          /* Tinted by the hair's HUE, at full value — not by its albedo.
           *
           * Multiplying by diffuseColor is the obvious move and it is wrong:
           * dark brown sits around 0.02 in linear, so the band came out at
           * two per cent of the light and the lobe may as well not have been
           * there. This is transmitted light, not reflected — the pigment
           * filters its colour, it does not attenuate it to the albedo. So
           * take the albedo's hue and normalise the value back to 1, which
           * for a dark brown gives the strong copper that dark hair actually
           * flares in a key light. */
          '  vec3 alb = material.diffuseColor;',
          '  float peak = max( alb.r, max( alb.g, alb.b ) );',
          /* Pulled back toward the light's own colour, and a long way back.
           *
           * A fully saturated hue is what ONE pass through a pigment gives.
           * Light crossing a real strand mass takes many paths of different
           * lengths and the average is nowhere near as saturated as the
           * deepest of them — so the physical argument for normalising the
           * albedo's hue to full value is also the argument for not stopping
           * there. Near the saturated end a dark brown flares copper and the
           * crown reads as gold streaks painted on, which is worse than the
           * flat slabs this replaced. uTrtDesat is the control; it wants to
           * sit high. */
          '  vec3 trtTint = mix( alb / max( peak, 1e-4 ), vec3( 1.0 ), uTrtDesat );',
          '  reflectedLight.directSpecular += directLight.color * trtTint * ( uTrtStrength * bandT * glint * vis );',
          '}',
          '',
          '#undef RE_Direct',
          '#define RE_Direct RE_Direct_Strand',
        ].join('\n')
      );

      /* Build the strand frame just before the light loop consumes it — after
         normal_fragment_maps, so the normal already carries the strand normal
         map, and after lights_physical_fragment, so nothing later overwrites
         it. */
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        [
          '#ifdef USE_ALPHAMAP',
          '{',
          /* dP/dv from screen-space derivatives.
             P varies with (u,v), so dP/dx = dP/du * du/dx + dP/dv * dv/dx and
             likewise for y; solving that 2x2 for dP/dv gives the direction
             along which v increases on the surface, which for a hair card is
             the strand. vViewPosition is the negated view position, and the
             sign cancels under normalisation. */
          '  vec3 dPdx = dFdx( - vViewPosition );',
          '  vec3 dPdy = dFdy( - vViewPosition );',
          '  vec2 dUx = dFdx( vAlphaMapUv );',
          '  vec2 dUy = dFdy( vAlphaMapUv );',
          '  float det = dUx.x * dUy.y - dUy.x * dUx.y;',
          '  vec3 tv = dPdy * dUx.x - dPdx * dUy.x;',
          // Degenerate UVs (a collapsed shell, a seam pixel) make det tiny and
          // tv garbage; keep the default up-axis frame rather than a random
          // one that would flicker per pixel.
          '  if ( abs( det ) > 1e-9 && dot( tv, tv ) > 1e-12 ) {',
          '    gStrandT = normalize( tv / det );',
          '  }',
          '}',
          '#else',
          // No UV: shift the normal toward view-up and use that as a stand-in
          // strand direction. See the class comment.
          '  gStrandT = normalize( normal + vec3( 0.0, 0.55, 0.0 ) );',
          '#endif',
          '#include <lights_fragment_begin>',
        ].join('\n')
      );

      /* Fresnel rim, kept separate from the two bands.
         It is not a strand effect — it is the mass catching light at grazing
         angles, and without it a head of hair reads as a solid shell. It goes
         in after the light loop so it is not scaled by any one light. */
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        [
          '#include <aomap_fragment>',
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 sV = normalize( vViewPosition );',
          '  float fres = pow( 1.0 - clamp( dot( normal, sV ), 0.0, 1.0 ), 3.0 );',
          '  reflectedLight.directSpecular += uSheenTint * uRimStrength * fres;',
          '}',
          '#endif',
        ].join('\n')
      );
    };

    // Likewise for the cache key: two materials whose programs differ must not
    // collide on one key, or the second renders with the first's shader.
    material.customProgramCacheKey = () =>
      'strand' + (typeof priorKey === 'function' ? '|' + priorKey.call(material) : '');
    material.needsUpdate = true;
    return material;
  }

  /** Live update of the sheen parameters on an attached material. */
  static setSheenParams(material, params) {
    const s = material && material.userData && material.userData.strandSheen;
    if (!s) return;
    const named = {
      sheenStrength: 'uSheenStrength', sheenExponent: 'uSheenExp', sheenShift: 'uSheenShift',
      trtStrength: 'uTrtStrength', trtExponent: 'uTrtExp', trtShift: 'uTrtShift',
      trtDesat: 'uTrtDesat',
      rimStrength: 'uRimStrength', rootDarken: 'uRootDarken',
      scatter: 'uScatter', toneStrength: 'uToneStrength',
    };
    for (const key in named) {
      if (params[key] !== undefined) s.uniforms[named[key]].value = params[key];
    }
    if (params.sheenTint !== undefined) s.uniforms.uSheenTint.value.set(params.sheenTint);
  }
}

StrandShading._map = null;
StrandShading._normal = null;

window.StrandShading = StrandShading;
