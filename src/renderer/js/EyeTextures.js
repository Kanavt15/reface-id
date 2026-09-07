/**
 * EyeTextures.js — baked iris and sclera maps for the eye shading.
 *
 * EyeShading draws the eye's large structures from analytic terms in the
 * fragment shader. Three things it cannot do from there, and this file exists
 * for all three:
 *
 *  1. Mipmaps. Procedural noise evaluated per fragment has no filtered
 *     pyramid, so hundreds of iris fibres alias into a shimmering moiré the
 *     moment the eye is smaller than the macro framing — which is every frame
 *     the operator actually works in. A baked map is filtered by the hardware
 *     and resolves to a smooth average instead.
 *
 *  2. Irregularity. A real iris is not a noise field; it is a few hundred
 *     individual trabeculae, each with its own length, width and start
 *     radius, plus a dozen crypts with ragged outlines. Drawing them as
 *     objects gives detail that no amount of octave-stacking imitates, and
 *     the same goes for the sclera's vessels, which branch and taper and are
 *     laid down here as grown paths rather than as thresholded noise.
 *
 *  3. Relief. Trabeculae stand proud, crypts are pits and the collarette is a
 *     ridge. Without a normal map the iris is a picture of an iris painted on
 *     a smooth dome, and it reads as one the moment the light moves.
 *
 * Everything is mapped into a disc rather than onto the mesh's own UVs. The
 * eye GLB is a Blender UV sphere whose pole does not sit where the pupil
 * does, so its TEXCOORD_0 cannot carry a radial pattern without a seam and a
 * pinch. The disc has neither: EyeShading already computes a position on the
 * iris plane, and sampling at `disc * 0.5 + 0.5` is continuous everywhere the
 * eye is visible, which is also what keeps the hardware's derivatives — and
 * therefore the mip selection — well behaved.
 */
class EyeTextures {
  /** Iris map resolution. The iris carries hundreds of trabeculae inside a
   *  12mm disc, and it is the only map where the finest detail is the point. */
  static get SIZE() { return 1024; }

  /** Sclera map resolution.
   *
   * Half the iris, and a quarter of the cost. Its content is soft branching
   * lines and a mottle, none of it near the resolution limit, and the two
   * maps together were an 800ms freeze on the main thread when the eyes are
   * first generated. Most of that was a million-pixel mottle pass over a map
   * that is mostly empty. */
  static get SCLERA_SIZE() { return 512; }

  /** Pupil radius the iris map is drawn at, as a fraction of the limbus.
   *
   * The real fraction is measured per eyeball and differs between the GLB
   * asset and the procedural fallback, so the shader rescales the annulus on
   * sampling. Baking at a mid value keeps that rescale small either way. */
  static get IRIS_PUPIL_FRACTION() { return 0.42; }

  /** Polar angle from the corneal pole that the sclera map's edge stands for.
   *  Past this the eyeball has turned into the orbit and is not visible. */
  static get SCLERA_POLAR_SPAN() { return 1.65; }

  /** How steeply the baked height field tilts the normal. */
  static get IRIS_RELIEF() { return 4.0; }

  // ── Public ───────────────────────────────────────────────────────────────

  /**
   * The three maps, built once and shared by both eyes.
   *
   * Built on demand rather than in EyeSystem's constructor: this is a couple
   * of hundred milliseconds of main-thread work, and it should land when the
   * eyes are first generated rather than while the editor is still mounting.
   */
  static maps() {
    if (!EyeTextures._maps) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      EyeTextures._maps = {
        ...EyeTextures._buildIris(),
        scleraDetail: EyeTextures._buildSclera(),
      };
      const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      console.log('[EyeTextures] Built iris and sclera maps in', ms.toFixed(0) + 'ms');
    }
    return EyeTextures._maps;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Deterministic generator: the same eye every session, and every run of
   *  the render checks comparable with the last. */
  static _rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  static _hash2(ix, iy, seed) {
    let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) >>> 0;
    h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  static _noise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = EyeTextures._hash2(ix, iy, seed);
    const b = EyeTextures._hash2(ix + 1, iy, seed);
    const c = EyeTextures._hash2(ix, iy + 1, seed);
    const d = EyeTextures._hash2(ix + 1, iy + 1, seed);
    return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
  }

  static _fbm(x, y, seed, octaves) {
    let v = 0, amp = 0.5, f = 1;
    for (let i = 0; i < octaves; i++) {
      v += amp * EyeTextures._noise(x * f, y * f, seed + i * 37);
      f *= 2.03; amp *= 0.5;
    }
    return v;
  }

  static _smooth(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
    return t * t * (3 - 2 * t);
  }

  /** Wrap an angle difference into [-pi, pi]. */
  static _wrap(d) {
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  static _upload(data, name, size) {
    const N = size || EyeTextures.SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = N; canvas.height = N;
    canvas.getContext('2d').putImageData(new ImageData(data, N, N), 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.name = name;
    // The shader computes its own disc coordinates, so the canvas rows map
    // straight to v and must not be flipped.
    tex.flipY = false;
    // Modulation and normal data, not colour: no sRGB decode on the way in.
    tex.colorSpace = THREE.NoColorSpace;
    // Never tile. The disc mapping runs off the edge of the square outside
    // the limbus, and a repeat there wraps the far side of the iris into it.
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    return tex;
  }

  // ── Iris ─────────────────────────────────────────────────────────────────

  /**
   * Trabeculae, laid out as individual fibres rather than as a noise field.
   *
   * Each slot around the circle holds one fibre with its own angular offset,
   * width, span and brightness, and a slight drift so it is not a perfect
   * radius. A pixel only ever consults the three slots nearest its own angle,
   * which keeps this O(1) per pixel while still letting neighbouring fibres
   * overlap the way real ones do.
   */
  static _fibreBank(count, seed, cfg) {
    const rnd = EyeTextures._rng(seed);
    const step = Math.PI * 2 / count;
    const bank = {
      count, step,
      offset: new Float32Array(count),
      width: new Float32Array(count),
      inner: new Float32Array(count),
      outer: new Float32Array(count),
      amp: new Float32Array(count),
      drift: new Float32Array(count),
      wave: new Float32Array(count),
      phase: new Float32Array(count),
    };
    for (let i = 0; i < count; i++) {
      bank.offset[i] = (i + 0.5 + (rnd() - 0.5) * cfg.jitter) * step;
      bank.width[i] = step * (cfg.width + rnd() * cfg.widthVary);
      bank.inner[i] = cfg.inner + rnd() * cfg.innerVary;
      bank.outer[i] = cfg.outer - rnd() * cfg.outerVary;
      bank.amp[i] = cfg.amp * (0.45 + rnd() * 0.55);
      bank.drift[i] = (rnd() - 0.5) * cfg.drift;
      bank.wave[i] = cfg.wave * (0.5 + rnd());
      bank.phase[i] = rnd() * Math.PI * 2;
    }
    return bank;
  }

  static _fibreAt(bank, theta, t) {
    // Three nearest slots: a fibre that has drifted can reach past its own.
    let sum = 0;
    const base = Math.floor(theta / bank.step);
    for (let k = -1; k <= 1; k++) {
      let i = (base + k) % bank.count;
      if (i < 0) i += bank.count;
      const span = EyeTextures._smooth(bank.inner[i], bank.inner[i] + 0.10, t)
        * (1 - EyeTextures._smooth(bank.outer[i] - 0.16, bank.outer[i], t));
      if (span <= 0) continue;
      const centre = bank.offset[i] + bank.drift[i] * t;
      const d = EyeTextures._wrap(theta - centre) / bank.width[i];
      const d2 = d * d;
      if (d2 > 1) continue;
      /* Bipolar cross-section, and that is the point of it.
       *
       * A purely additive profile makes every fibre a bright spoke on a flat
       * ground, which is what the first bake looked like: a starburst. Real
       * trabeculae are ridges with grooves between them, so the profile has
       * to go negative before it dies — positive in the core, negative in a
       * ring around it, zero at the boundary so neighbouring fibres meet
       * without a seam. */
      /* Beading along the fibre's length.
       *
       * Without it every fibre is a smooth ray running the width of the
       * annulus, and a few hundred smooth rays is a sunburst, not a stroma.
       * Real trabeculae thicken and thin and break along their run, and one
       * modulation per fibre is what turns the bake from a diagram into
       * tissue. */
      const bead = 0.5 + 0.5 * Math.sin(t * bank.wave[i] + bank.phase[i]);
      sum += bank.amp[i] * (1 - d2) * (1 - 3.0 * d2) * span * (0.35 + 0.65 * bead);
    }
    return sum;
  }

  static _buildIris() {
    const N = EyeTextures.SIZE;
    const PUPIL = EyeTextures.IRIS_PUPIL_FRACTION;
    const rnd = EyeTextures._rng(90210);

    /* Coarse trabeculae carry the read at portrait distance; the fine layer
       only shows under the macro framing, which is why it is half the height
       and twice the count. Both spans are wide open: fibres that all run the
       full width of the annulus draw a starburst, and a real iris is a mat of
       fibres of every length, most of them stopping well short of the pupil. */
    /* Three scales, and the coarsest one is the reason this works at all.
     *
     * An iris fills about 150 pixels in the framing the operator works in, so
     * a bank of 380 fibres is a fibre per pixel and the mip chain averages a
     * symmetric ridge-and-groove profile to exactly nothing — the first bake
     * at that density rendered as a smooth brown dome. Trabeculae come in
     * bundles on a real iris, and it is the bundles that survive minification
     * and carry the radial read at portrait distance; the finer banks are
     * there for the macro framing and are expected to average out before it. */
    const bundles = EyeTextures._fibreBank(70, 5171, {
      jitter: 0.85, width: 0.38, widthVary: 0.26,
      inner: -0.10, innerVary: 0.55, outer: 1.06, outerVary: 0.40,
      amp: 0.70, drift: 0.10, wave: 4,
    });
    const coarse = EyeTextures._fibreBank(200, 7717, {
      jitter: 0.75, width: 0.32, widthVary: 0.22,
      inner: -0.06, innerVary: 0.72, outer: 1.04, outerVary: 0.50,
      amp: 0.55, drift: 0.12, wave: 7,
    });
    const fine = EyeTextures._fibreBank(520, 3391, {
      jitter: 0.9, width: 0.28, widthVary: 0.20,
      inner: 0.02, innerVary: 0.85, outer: 1.04, outerVary: 0.55,
      amp: 0.30, drift: 0.18, wave: 13,
    });

    // Crypts of Fuchs: lacunae in the stroma, clustered on the collarette and
    // stretched along the fibres.
    /* Spread across the annulus, not piled inside the collarette.
     *
     * Confined to the pupillary zone they stopped reading as individual
     * lacunae: fifteen of them at random angles in a narrow band overlapped
     * into one continuous dark collar around the pupil, which no eye has. */
    const CRYPTS = 13;
    const crypts = [];
    for (let i = 0; i < CRYPTS; i++) {
      crypts.push({
        theta: rnd() * Math.PI * 2,
        t: 0.05 + rnd() * 0.70,
        halfAngle: 0.05 + rnd() * 0.11,
        halfT: 0.05 + rnd() * 0.13,
        depth: 0.45 + rnd() * 0.55,
        ragged: 2 + Math.floor(rnd() * 3),
        phase: rnd() * Math.PI * 2,
      });
    }

    // Contraction furrows: concentric folds in the ciliary zone, broken into
    // arcs rather than closed rings.
    const FURROWS = 5;
    const furrows = [];
    for (let i = 0; i < FURROWS; i++) {
      furrows.push({
        t: 0.52 + i * 0.10 + (rnd() - 0.5) * 0.05,
        halfT: 0.018 + rnd() * 0.016,
        depth: 0.35 + rnd() * 0.4,
        wobble: 0.02 + rnd() * 0.03,
        phase: rnd() * Math.PI * 2,
        freq: 3 + Math.floor(rnd() * 5),
      });
    }

    // Ragged rings and sector variation, as sums of sines. Periodic by
    // construction, so they close on themselves with no seam at the wrap.
    const ring = (n, scale, from) => {
      const h = [];
      for (let i = 0; i < n; i++) {
        h.push({ f: from + i * 2 + Math.floor(rnd() * 3), a: scale / (i + 1), p: rnd() * Math.PI * 2 });
      }
      return h;
    };
    const collarWave = ring(4, 0.030, 3);
    // Real irides are not rotationally uniform: they have wedges of heavier
    // and lighter pigment, and without them a bake this regular reads as a
    // machined part.
    const sectorWave = ring(3, 0.11, 2);

    /* Anything that depends only on the angle is tabulated.
     *
     * The furrow break-up in particular was an fbm call inside a loop over
     * five furrows, evaluated per pixel — forty hash lookups a pixel for a
     * value that is the same for all five and constant down every radius. */
    const TAB = 4096;
    const collarTab = new Float32Array(TAB);
    const breakTab = new Float32Array(TAB);
    const sectorTab = new Float32Array(TAB);
    for (let i = 0; i < TAB; i++) {
      const a = i / TAB * Math.PI * 2;
      let cr = 0.30;
      for (const w of collarWave) cr += Math.sin(a * w.f + w.p) * w.a;
      collarTab[i] = cr;
      let sc = 0;
      for (const w of sectorWave) sc += Math.sin(a * w.f + w.p) * w.a;
      sectorTab[i] = sc;
      breakTab[i] = EyeTextures._smooth(0.30, 0.70, EyeTextures._fbm(
        Math.cos(a) * 3.5 + 11, Math.sin(a) * 3.5 + 11, 611, 2));
    }
    const TAB_SCALE = TAB / (Math.PI * 2);

    const detail = new Uint8ClampedArray(N * N * 4);
    const height = new Float32Array(N * N);

    for (let y = 0; y < N; y++) {
      const dy = (y + 0.5) / N * 2 - 1;
      for (let x = 0; x < N; x++) {
        const dx = (x + 0.5) / N * 2 - 1;
        const r = Math.sqrt(dx * dx + dy * dy);
        const i = y * N + x;
        if (r > 1.06) {
          detail[i * 4] = detail[i * 4 + 1] = detail[i * 4 + 2] = 128;
          detail[i * 4 + 3] = 255;
          continue;
        }
        const theta = Math.atan2(dy, dx) + Math.PI;   // 0 .. 2pi
        // Normalised across the annulus: 0 at the pupil margin, 1 at limbus.
        const t = (r - PUPIL) / (1 - PUPIL);
        let tab = (theta * TAB_SCALE) | 0;
        if (tab >= TAB) tab = TAB - 1;

        let h = 0;
        let tint = 1.0;
        let warm = 0;      // >0 pushes amber, <0 pushes cool
        let ao = 1.0;

        if (t > -0.20) {
          const tc = t > 0 ? t : 0;
          const cr = collarTab[tab];

          // ── trabeculae ──
          const fib = EyeTextures._fibreAt(bundles, theta, tc)
            + EyeTextures._fibreAt(coarse, theta, tc)
            + EyeTextures._fibreAt(fine, theta, tc);
          // Muted inside the collarette, where the stroma is covered by the
          // pupillary ruff's pigment rather than open fibre.
          const fibZone = (0.75 + 0.25 * EyeTextures._smooth(cr - 0.14, cr + 0.26, tc))
            * (1 + sectorTab[tab] * 2.2);
          h += fib * fibZone * 0.9;
          /* Measured, not chosen by eye.
           *
           * At 0.19 the fibre field varied by ten per cent along an arc
           * through the ciliary zone, the shader's melanin factor took that
           * to six, and seven-to-one minification took what was left below
           * anything a viewer registers — the iris rendered as a smooth brown
           * dome with crypts on it. */
          tint += fib * fibZone * 0.26;

          // ── collarette ──
          // A ridge, with the shadow a ridge casts on its pupil side.
          const dcr = tc - cr;
          const ridge = Math.exp(-dcr * dcr * 121);
          h += ridge * 0.55;
          tint += ridge * 0.19;
          const inner = Math.exp(-Math.pow(dcr + 0.055, 2) * 260);
          tint -= inner * 0.09;
          ao -= inner * 0.16;
          /* No pupillary-zone darkening here.
           *
           * The shader already runs that gradient, and it has to: how much
           * darker the pupillary zone goes depends on melanin, which is a
           * property of the colour the operator picked and not of a map baked
           * once. Doing it in both places compounded them into a near-black
           * collar with a hard outer edge. This map carries structure; the
           * shader carries tone. */

          // ── crypts ──
          for (let c = 0; c < CRYPTS; c++) {
            const cy = crypts[c];
            const dt = tc - cy.t;
            if (dt > cy.halfT * 1.6 || dt < -cy.halfT * 1.6) continue;
            const da = EyeTextures._wrap(theta - cy.theta);
            if (da > cy.halfAngle * 1.6 || da < -cy.halfAngle * 1.6) continue;
            // Ragged outline: the boundary radius wobbles with the angle
            // around the crypt, so it is a lacuna and not an ellipse.
            const wob = 1 + 0.16 * Math.sin(Math.atan2(dt, da) * cy.ragged + cy.phase);
            const qa = da / (cy.halfAngle * wob), qt = dt / (cy.halfT * wob);
            const q = Math.sqrt(qa * qa + qt * qt);
            if (q < 1.4) {
              const m = 1 - EyeTextures._smooth(0.55, 1.15, q);
              h -= m * cy.depth * 1.15;
              tint -= m * cy.depth * 0.30;
              ao -= m * cy.depth * 0.42;
              warm -= m * cy.depth * 0.20;
            }
          }

          // ── contraction furrows ──
          const broken = breakTab[tab];
          if (broken > 0) {
            for (let f = 0; f < FURROWS; f++) {
              const fr = furrows[f];
              const centre = fr.t + Math.sin(theta * fr.freq + fr.phase) * fr.wobble;
              const dd = (tc - centre) / fr.halfT;
              if (dd > 3 || dd < -3) continue;
              const m = Math.exp(-dd * dd) * broken;
              h -= m * fr.depth * 0.5;
              tint -= m * fr.depth * 0.10;
              ao -= m * fr.depth * 0.18;
            }
          }

          // ── pupillary ruff ──
          // The fringe of posterior pigment epithelium wrapping the margin,
          // scalloped by the sphincter beneath it. Fine: at the amplitude
          // this started at, the scalloping was as wide as the fringe and the
          // whole thing bloomed into a flower.
          /* Three frequencies, none a multiple of another. Two regular
             sines beat into a repeating scallop, and a pupil edge with a
             period reads as a cog wheel — which is exactly what two of them
             here plus two more in the shader produced. */
          const crenel = 0.007 * Math.sin(theta * 23 + 1.1)
            + 0.005 * Math.sin(theta * 37 - 0.4)
            + 0.004 * Math.sin(theta * 13 + 2.7);
          const ruff = 1 - EyeTextures._smooth(0.008 + crenel, 0.048 + crenel, tc);
          tint -= ruff * 0.46;
          warm += ruff * 0.30;
          h += ruff * 0.30;
          ao -= ruff * 0.25;

          // ── pigment ──
          // Irregular patches that ignore the fibre direction, plus the fine
          // grain of the stroma itself, plus the sector variation.
          const blotch = EyeTextures._fbm(dx * 3.2 + 5, dy * 3.2 + 5, 4001, 3) - 0.47;
          tint += blotch * 0.34 + sectorTab[tab] * 0.55;
          warm += blotch * 0.55 + sectorTab[tab] * 0.9;
          const grain = EyeTextures._fbm(dx * 46 + 2, dy * 46 + 2, 8123, 2) - 0.47;
          tint += grain * 0.10;
          h += grain * 0.18;
        }

        // Fade everything out past the limbus so the square's corners cannot
        // bleed pattern into the sclera through the bilinear filter.
        const edge = 1 - EyeTextures._smooth(0.97, 1.03, r);
        tint = 1 + (tint - 1) * edge;
        warm *= edge;
        ao = 1 - (1 - ao) * edge;
        height[i] = h * edge;

        // Warmth is a hue shift about the tint, so the base colour the
        // operator picked still decides what colour the iris is.
        const rr = tint * (1 + warm * 0.22);
        const gg = tint * (1 + warm * 0.02);
        const bb = tint * (1 - warm * 0.26);
        detail[i * 4] = Math.round(Math.min(2, Math.max(0, rr)) * 127.5);
        detail[i * 4 + 1] = Math.round(Math.min(2, Math.max(0, gg)) * 127.5);
        detail[i * 4 + 2] = Math.round(Math.min(2, Math.max(0, bb)) * 127.5);
        detail[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, ao)) * 255);
      }
    }

    // Normals from the height field. Central differences rather than a full
    // Sobel: the field is already smooth, and a wider kernel only softens the
    // fibres that are the point of having it.
    const normal = new Uint8ClampedArray(N * N * 4);
    const K = EyeTextures.IRIS_RELIEF * N / 1024;
    for (let y = 0; y < N; y++) {
      const yp = y > 0 ? y - 1 : y, yn = y < N - 1 ? y + 1 : y;
      for (let x = 0; x < N; x++) {
        const xp = x > 0 ? x - 1 : x, xn = x < N - 1 ? x + 1 : x;
        const gx = (height[y * N + xn] - height[y * N + xp]) * K;
        const gy = (height[yn * N + x] - height[yp * N + x]) * K;
        const len = Math.sqrt(gx * gx + gy * gy + 1);
        const i = (y * N + x) * 4;
        normal[i] = Math.round((-gx / len * 0.5 + 0.5) * 255);
        normal[i + 1] = Math.round((-gy / len * 0.5 + 0.5) * 255);
        normal[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
        normal[i + 3] = 255;
      }
    }

    return {
      irisDetail: EyeTextures._upload(detail, 'iris-detail'),
      irisNormal: EyeTextures._upload(normal, 'iris-normal'),
    };
  }

  // ── Sclera ───────────────────────────────────────────────────────────────

  /**
   * Episcleral vessels, grown as branching paths.
   *
   * Thresholded noise cannot produce a vessel: a vessel starts somewhere,
   * runs somewhere, tapers, and splits into children that are narrower than
   * their parent. Growing them with a canvas stroke gets all of that plus
   * free antialiasing, and multiply blending makes crossings darken the way
   * overlapping vessels do.
   *
   * Laid out azimuthally: the distance from the centre of the map is the
   * polar angle from the corneal pole, scaled by SCLERA_POLAR_SPAN. That
   * projection has its only singularity at the pole, which sits under the
   * cornea and is never seen.
   */
  static _buildSclera() {
    const N = EyeTextures.SCLERA_SIZE;
    const rnd = EyeTextures._rng(551987);
    const canvas = document.createElement('canvas');
    canvas.width = N; canvas.height = N;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, N, N);
    g.globalCompositeOperation = 'multiply';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    const C = N / 2;
    // Where the limbus falls in this projection, for the perilimbal zone that
    // stays comparatively clear on a healthy eye.
    const limbus = 0.344 / EyeTextures.SCLERA_POLAR_SPAN;

    const grow = (x, y, dir, width, alpha, depth) => {
      const pts = [[x, y]];
      // Many short steps with a gentle turn rate. The first pass took long
      // steps and swung hard at each one, which drew a net of straight lines
      // rather than vessels.
      const steps = 8 + Math.floor(rnd() * 9);
      let px = x, py = y, d = dir;
      for (let i = 0; i < steps; i++) {
        /* Wander, but be pulled back toward the limbus at every step.
         *
         * A free random walk gives vessels that set off from the canthus and
         * then cross each other at every angle, which reads as a scratched
         * surface rather than as conjunctiva. Real episcleral vessels
         * radiate: they meander, but they are all going the same way. The
         * bias is what turns a tangle into a bed. */
        const inward = Math.atan2(C - py, C - px);
        d += EyeTextures._wrap(inward - d) * 0.20 + (rnd() - 0.5) * 0.55;
        const len = N * (0.006 + rnd() * 0.011);
        px += Math.cos(d) * len;
        py += Math.sin(d) * len;
        const rad = Math.hypot(px - C, py - C) / C;
        // Stop at the limbus and at the far edge of what the map covers.
        if (rad < limbus * 1.12 || rad > 0.99) break;
        pts.push([px, py]);
      }
      if (pts.length < 2) return;
      // Taper: each segment a little narrower than the last.
      for (let i = 1; i < pts.length; i++) {
        const w = width * (1 - 0.55 * (i / pts.length));
        g.beginPath();
        g.moveTo(pts[i - 1][0], pts[i - 1][1]);
        g.lineTo(pts[i][0], pts[i][1]);
        g.lineWidth = Math.max(0.6, w);
        g.strokeStyle = 'rgba(214, 92, 84, ' + alpha.toFixed(3) + ')';
        g.stroke();
      }
      if (depth >= 3) return;
      const kids = depth === 0 ? 2 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 2);
      for (let k = 0; k < kids; k++) {
        const at = 1 + Math.floor(rnd() * (pts.length - 1));
        const [bx, by] = pts[Math.min(at, pts.length - 1)];
        grow(bx, by, Math.atan2(by - C, bx - C) + Math.PI + (rnd() - 0.5) * 1.5,
          width * (0.52 + rnd() * 0.22), alpha * 0.85, depth + 1);
      }
    };

    /* Trunks enter from the periphery and run toward the limbus. Their start
       angles cluster on the horizontal meridian because that is where the
       palpebral fissure exposes sclera — the vessels over the top and bottom
       of the ball are under the lids and would never be seen anyway. */
    const TRUNKS = 28;
    for (let i = 0; i < TRUNKS; i++) {
      // Two lobes, at the medial and lateral canthus.
      const lobe = rnd() < 0.5 ? 0 : Math.PI;
      const a = lobe + (rnd() - 0.5) * 1.1;
      const rad = 0.72 + rnd() * 0.26;
      grow(C + Math.cos(a) * rad * C, C + Math.sin(a) * rad * C,
        Math.atan2(-Math.sin(a), -Math.cos(a)) + (rnd() - 0.5) * 0.6,
        N * (0.0022 + rnd() * 0.0026), 0.34 + rnd() * 0.20, 0);
    }

    // A second, finer bed drawn softer: the deep vessels a millimetre of
    // collagen sits over, which read as a wash rather than as lines.
    g.filter = 'blur(' + (N / 340).toFixed(1) + 'px)';
    for (let i = 0; i < 20; i++) {
      const lobe = rnd() < 0.5 ? 0 : Math.PI;
      const a = lobe + (rnd() - 0.5) * 1.7;
      const rad = 0.62 + rnd() * 0.34;
      grow(C + Math.cos(a) * rad * C, C + Math.sin(a) * rad * C,
        Math.atan2(-Math.sin(a), -Math.cos(a)) + (rnd() - 0.5) * 0.9,
        N * (0.0040 + rnd() * 0.0045), 0.13 + rnd() * 0.09, 1);
    }
    g.filter = 'none';

    // Mottle, and the fade that keeps the map's corners from bleeding.
    const img = g.getImageData(0, 0, N, N);
    const d = img.data;
    for (let y = 0; y < N; y++) {
      const dy = (y + 0.5) / N * 2 - 1;
      for (let x = 0; x < N; x++) {
        const dx = (x + 0.5) / N * 2 - 1;
        const i = (y * N + x) * 4;
        const rad = Math.sqrt(dx * dx + dy * dy);
        const fade = 1 - EyeTextures._smooth(0.94, 1.0, rad);
        // Two scales of mottle: the sclera is fibrous tissue, not a flat
        // field, and at portrait distance this is most of what says so.
        const mot = 0.950 + EyeTextures._fbm(dx * 7 + 3, dy * 7 + 3, 2222, 3) * 0.075
          + EyeTextures._fbm(dx * 29 + 8, dy * 29 + 8, 9091, 2) * 0.050;
        for (let c = 0; c < 3; c++) {
          const v = 1 + (d[i + c] / 255 - 1) * fade;
          d[i + c] = Math.round(Math.min(1, Math.max(0, v * mot)) * 255);
        }
        d[i + 3] = 255;
      }
    }
    return EyeTextures._upload(d, 'sclera-detail', N);
  }
}

window.EyeTextures = EyeTextures;
