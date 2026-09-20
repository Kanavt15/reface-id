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

  /** How steeply the baked height field tilts the normal.
   *
   * Halved when the bake moved from analytic profiles to strokes. A cosine
   * ridge evaluated per pixel has a gentle gradient by construction; a
   * stroked one has an antialiased edge two pixels wide, and differentiating
   * that at the old figure turned every strand into a chrome wire and the
   * whole iris into tree bark. */
  static get IRIS_RELIEF() { return 2.1; }

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

  /** A 2D context at the map's own size, flood-filled and set up for strokes.
   *
   * Deliberately without willReadFrequently. These canvases are read exactly
   * once, at the end, and the hint pins the context to Chromium's software
   * rasteriser — which for the tens of thousands of strokes the iris is drawn
   * from was the difference between a 700ms bake and an eight-second freeze
   * on the main thread. One readback off the GPU is far cheaper than
   * rasterising the whole map on the CPU to avoid it. */
  static _ctx(N, fill) {
    const canvas = document.createElement('canvas');
    canvas.width = N; canvas.height = N;
    const g = canvas.getContext('2d');
    g.fillStyle = fill;
    g.fillRect(0, 0, N, N);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    return g;
  }

  /** Blur one context in place, through a scratch canvas. Canvas2D has no
   *  in-place filter, and drawing a canvas onto itself under a filter reads
   *  and writes the same backing store. */
  static _blur(g, px) {
    const N = g.canvas.width;
    const tmp = document.createElement('canvas');
    tmp.width = N; tmp.height = N;
    const t = tmp.getContext('2d');
    t.filter = 'blur(' + px.toFixed(2) + 'px)';
    t.drawImage(g.canvas, 0, 0);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'copy';
    g.filter = 'none';
    g.drawImage(tmp, 0, 0);
    g.restore();
  }

  /**
   * The iris, drawn as anatomy rather than evaluated as a field.
   *
   * The version this replaces sampled a bank of analytic fibre profiles per
   * pixel. Every fibre in it therefore had to be a smooth function of angle
   * and radius, which meant a smooth cosine ridge running the width of the
   * annulus — and a few hundred of those, however jittered, is a starburst.
   * That is what it rendered as: a brown disc with a sunburst on it and a
   * dozen dark smudges.
   *
   * Strokes are a better instrument for the same job. A stroke can start
   * anywhere, stop short, fork, curve, cross its neighbours and taper at both
   * ends, none of which a per-pixel profile can do, and the raster comes back
   * antialiased for free. It is also an order of magnitude cheaper: a
   * thousand paths against a million pixels times thirty profile
   * evaluations.
   *
   * Three inks are painted from the same walks so they cannot drift out of
   * register with each other:
   *
   *   tone   — the colour modulation, mid grey meaning "leave the operator's
   *            iris colour alone". Painted in colour, not in grey, so a
   *            strand can be warmer than the stroma around it and a crypt can
   *            be browner than either.
   *   relief — the height field the normal map is differentiated from.
   *   cavity — how much light a pit keeps out.
   */
  static _buildIris() {
    const N = EyeTextures.SIZE;
    const C = N / 2;
    const PUPIL = EyeTextures.IRIS_PUPIL_FRACTION;
    const rnd = EyeTextures._rng(90210);

    const tone = EyeTextures._ctx(N, '#808080');
    const relief = EyeTextures._ctx(N, '#808080');
    const cavity = EyeTextures._ctx(N, '#ffffff');

    /* Annulus coordinates. `t` is 0 at the pupil margin and 1 at the limbus,
       which is the coordinate every measurement of an iris is quoted in, and
       the one the shader rescales into when the eyeball's real pupil differs
       from the fraction this is baked at. */
    const at = (theta, t) => {
      const r = (PUPIL + t * (1 - PUPIL)) * C;
      return [C + Math.cos(theta) * r, C + Math.sin(theta) * r];
    };
    // One unit of t in pixels, so widths can be quoted in annulus fractions
    // and stay proportionate at any map resolution.
    const TPX = (1 - PUPIL) * C;

    /**
     * Walk a path through the annulus, painting every ink from the one walk.
     *
     * `path` returns [theta, t] for a parameter running 0..1; `inks` are
     * [context, 'r,g,b', alpha, widthScale] rows. Taper is applied to width
     * and alpha together — a stroke that ends at full width and full opacity
     * reads as a drawn line, which is the tell that separates a diagram of an
     * iris from an iris.
     */
    const paint = (path, width, steps, inks) => {
      let px = 0, py = 0;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const [theta, t] = path(f);
        const [x, y] = at(theta, t);
        if (i > 0) {
          const taper = Math.sqrt(Math.sin(Math.PI * f));
          for (let k = 0; k < inks.length; k++) {
            const ink = inks[k];
            const g = ink[0];
            g.beginPath();
            g.moveTo(px, py);
            g.lineTo(x, y);
            g.lineWidth = Math.max(0.6, width * TPX * ink[3] * (0.30 + 0.70 * taper));
            g.strokeStyle = 'rgba(' + ink[1] + ',' + (ink[2] * taper).toFixed(3) + ')';
            g.stroke();
          }
        }
        px = x; py = y;
      }
    };

    /** A closed wobbling curve — the collarette, the furrows and the ruff are
     *  all one of these. `radius(theta)` gives t. */
    const ring = (radius, from, to, width, steps, inks) => {
      let px = 0, py = 0;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const theta = from + (to - from) * f;
        const [x, y] = at(theta, radius(theta));
        if (i > 0) {
          const taper = Math.sqrt(Math.sin(Math.PI * f));
          for (let k = 0; k < inks.length; k++) {
            const ink = inks[k];
            const g = ink[0];
            g.beginPath();
            g.moveTo(px, py);
            g.lineTo(x, y);
            g.lineWidth = Math.max(0.6, width * TPX * ink[3] * (0.35 + 0.65 * taper));
            g.strokeStyle = 'rgba(' + ink[1] + ',' + (ink[2] * taper).toFixed(3) + ')';
            g.stroke();
          }
        }
        px = x; py = y;
      }
    };

    /* Ink colours. The tone map multiplies the operator's iris colour, so a
       warm ink is one whose red exceeds its blue rather than one that is
       brown in absolute terms — a literally brown ink would drag every iris
       in the palette toward brown, which is the decal tell this whole file
       exists to avoid. */
    const RIDGE = '255,250,238';   // stroma catching light: warm, near white
    const GROOVE = '52,40,28';     // the shadow between two bundles
    const PIT = '62,44,30';        // a crypt: an opening, not a stain
    const RUFF = '30,16,8';        // posterior pigment, the warmest dark here

    /* Where the collarette runs, as a function of angle. Declared up here
       because three layers need to know: the crypts open along it, the
       bundles change character across it, and it is drawn itself further
       down. A sum of harmonics rather than noise, so it closes on itself with
       no seam at the wrap. */
    const cH = [];
    for (let i = 0; i < 5; i++) {
      cH.push({ f: 2 + i + Math.floor(rnd() * 3), a: 0.045 / (i * 0.7 + 1), p: rnd() * 6.283 });
    }
    const collar = (th) => {
      let r = 0.32;
      for (const h of cH) r += Math.sin(th * h.f + h.p) * h.a;
      return r;
    };

    /* ── Sector wedges ──────────────────────────────────────────────────
     *
     * The most important layer at the distance the eye is actually seen at.
     * An iris fills about 150 pixels in portrait framing, by which point every
     * individual strand below has averaged into the mip chain and vanished —
     * a symmetric ridge and groove average to exactly nothing, which is why
     * the previous bake minified to a smooth dome. Real irides have sectors
     * of heavier and lighter pigment several millimetres across, and those
     * are what survives minification and reads as an iris from across a room.
     *
     * Drawn very blurred, so nothing but the low frequency gets through. */
    tone.save();
    tone.filter = 'blur(' + (N * 0.040).toFixed(1) + 'px)';
    const WEDGES = 16;
    for (let i = 0; i < WEDGES; i++) {
      const a0 = (i + rnd() * 0.6) / WEDGES * Math.PI * 2;
      const a1 = a0 + (0.45 + rnd() * 1.15) / WEDGES * Math.PI * 2;
      const lift = rnd() - 0.42;
      tone.beginPath();
      tone.moveTo(C, C);
      tone.arc(C, C, C * 1.05, a0, a1);
      tone.closePath();
      tone.fillStyle = lift > 0
        ? 'rgba(255,246,226,' + (lift * 0.62).toFixed(3) + ')'
        : 'rgba(46,34,24,' + (-lift * 0.54).toFixed(3) + ')';
      tone.fill();
    }
    tone.restore();

    /* ── Trabecular bundles ─────────────────────────────────────────────
     *
     * Between the wedges and the individual strands: a hundred-odd bundles a
     * few tenths of a millimetre across, most of them stopping well short of
     * both ends of the annulus. Their lengths are what stop the layer reading
     * as a sunburst — on a real iris hardly any fibre runs the full width,
     * and a bank where most of them do is a starburst however finely it is
     * jittered. */
    for (let i = 0; i < 130; i++) {
      const theta = (i + rnd()) / 130 * Math.PI * 2;
      const t0 = -0.08 + rnd() * 0.34;
      const t1 = Math.min(1.04, t0 + 0.45 + rnd() * 0.60);
      const bow = (rnd() - 0.5) * 0.16;
      const light = rnd() < 0.52;
      const a = 0.040 + rnd() * 0.065;
      paint((f) => [theta + bow * f * f, t0 + (t1 - t0) * f],
        0.020 + rnd() * 0.032, 10, [
          [tone, light ? RIDGE : GROOVE, a, 1],
          [relief, light ? '255,255,255' : '0,0,0', a * 0.85, 1],
        ]);
    }

    /* ── Strands ────────────────────────────────────────────────────────
     *
     * A ridge with its own groove around it: the groove is stroked first at
     * twice the width, then the ridge over the top of it, so every strand
     * sits in a shadow of its own and neighbouring strands meet without a
     * seam. That pairing is what makes the layer read as a mat of fibres
     * rather than as scratches on a disc. */
    for (let i = 0; i < 720; i++) {
      // Stratified rather than scattered. Uniform random angles clump, and a
      // clump of strands with a bare patch beside it reads as damage.
      const theta = (i + rnd()) / 720 * Math.PI * 2;
      const t0 = -0.04 + rnd() * 0.58;
      const t1 = Math.min(1.05, t0 + 0.26 + rnd() * 0.62);
      const bow = (rnd() - 0.5) * 0.16;
      const phase = rnd() * 6.283;
      const w = 0.007 + rnd() * 0.012;
      // The same wander for both passes, or the ridge walks out of its groove.
      const path = (f) => [
        theta + bow * f * f + Math.sin(f * 3.4 + phase) * 0.014,
        t0 + (t1 - t0) * f,
      ];
      paint(path, w * 2.4, 10, [
        [tone, GROOVE, 0.062, 1],
        [relief, '0,0,0', 0.10, 1],
      ]);
      paint(path, w, 10, [
        [tone, RIDGE, 0.10 + rnd() * 0.07, 1],
        [relief, '255,255,255', 0.17, 1],
      ]);
    }

    /* ── Crypts of Fuchs ────────────────────────────────────────────────
     *
     * Openings through the stroma to the pigment layer behind it, so they are
     * dark, sharply outlined and radially elongated — the previous bake drew
     * them as soft round blobs, which read as dirt on a lens rather than as
     * holes in tissue. Most of them open along the collarette, which is where
     * the stroma is thinnest; a few sit further out.
     *
     * Drawn as a ragged polygon rather than an ellipse, with a lit lip on the
     * near rim: the edge of a hole catches light, and that lip is most of
     * what makes it read as depth.
     *
     * Drawn here, between the strands and the fine stroma, rather than last.
     * Painted over a finished iris they read as spots of dirt on a lens — a
     * dark shape with no fibre crossing it belongs to a different picture
     * than the one under it. Half the fine layer runs over them instead, and
     * the shape stops being a stain and starts being a hole with stroma
     * hanging into it. */
    const crypt = (theta, t, halfA, halfT, depth) => {
      const M = 15;
      const pts = [];
      for (let i = 0; i < M; i++) {
        const a = (i / M) * Math.PI * 2;
        const wob = 0.55 + 0.45 * rnd();
        pts.push(at(theta + Math.cos(a) * halfA * wob, t + Math.sin(a) * halfT * wob));
      }
      for (const [g, fill, alpha] of [
        [tone, PIT, depth * 0.46], [relief, '0,0,0', depth * 0.55],
        [cavity, '0,0,0', depth * 0.40],
      ]) {
        g.save();
        g.filter = 'blur(' + (N * 0.0012).toFixed(2) + 'px)';
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < M; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
        g.fillStyle = 'rgba(' + fill + ',' + alpha.toFixed(3) + ')';
        g.fill();
        g.restore();
      }
      // The lit rim, on the side away from the pupil.
      relief.save();
      relief.filter = 'blur(' + (N * 0.0016).toFixed(2) + 'px)';
      relief.beginPath();
      const lip = Math.round(M * 0.72);
      relief.moveTo(pts[Math.round(M * 0.14)][0], pts[Math.round(M * 0.14)][1]);
      for (let i = Math.round(M * 0.14); i <= lip; i++) relief.lineTo(pts[i % M][0], pts[i % M][1]);
      relief.lineWidth = Math.max(1, N * 0.0030);
      relief.strokeStyle = 'rgba(255,255,255,' + (depth * 0.26).toFixed(3) + ')';
      relief.stroke();
      relief.restore();
    };

    /* Elongated along the fibres, roughly three to one. A crypt that is as
       wide as it is long is a spot; the radial stretch is what makes it read
       as an opening between two bundles, which is what it is. */
    for (let i = 0; i < 12; i++) {
      const theta = (i + rnd() * 0.8) / 12 * Math.PI * 2;
      // Straddling the collarette, where the stroma is thinnest.
      crypt(theta, collar(theta) + 0.02 + rnd() * 0.14,
        0.018 + rnd() * 0.026, 0.055 + rnd() * 0.095, 0.45 + rnd() * 0.40);
    }
    for (let i = 0; i < 9; i++) {
      const theta = rnd() * Math.PI * 2;
      crypt(theta, 0.54 + rnd() * 0.36,
        0.011 + rnd() * 0.020, 0.035 + rnd() * 0.070, 0.20 + rnd() * 0.24);
    }

    /* ── Fine stroma ────────────────────────────────────────────────────
     *
     * Short, thin and half of them dark: the layer that only shows under the
     * macro framing, and the one that keeps the surface from going smooth
     * between the strands above. */
    for (let i = 0; i < 1400; i++) {
      const theta = (i + rnd()) / 1400 * Math.PI * 2;
      const t0 = 0.0 + rnd() * 0.84;
      const t1 = Math.min(1.05, t0 + 0.10 + rnd() * 0.32);
      const light = rnd() < 0.5;
      const bow = (rnd() - 0.5) * 0.12;
      paint((f) => [theta + bow * f, t0 + (t1 - t0) * f],
        0.003 + rnd() * 0.006, 4, [
          [tone, light ? RIDGE : GROOVE, 0.070 + rnd() * 0.065, 1],
          [relief, light ? '255,255,255' : '0,0,0', 0.10, 1],
        ]);
    }

    /* ── Contraction furrows ────────────────────────────────────────────
     *
     * Concentric folds in the outer ciliary zone, where the iris crumples as
     * the pupil dilates. Broken into arcs, never closed rings: a complete
     * circle at this radius reads as a machined groove. Each is a dark crease
     * with a lit lip on its outer side, which is what a fold is. */
    for (let i = 0; i < 5; i++) {
      const base = 0.54 + i * 0.095 + (rnd() - 0.5) * 0.05;
      const wob = 0.014 + rnd() * 0.018;
      const freq = 3 + Math.floor(rnd() * 4);
      const phase = rnd() * 6.283;
      const radius = (th) => base + Math.sin(th * freq + phase) * wob;
      let a = rnd() * 6.283;
      while (a < 6.283 + rnd()) {
        const span = 0.5 + rnd() * 1.5;
        ring(radius, a, a + span, 0.016, Math.ceil(span * 16), [
          [tone, GROOVE, 0.055 + rnd() * 0.04, 1],
          [relief, '0,0,0', 0.10, 1],
          [cavity, '0,0,0', 0.10, 1],
        ]);
        ring((th) => radius(th) + 0.016, a + 0.1, a + span - 0.1,
          0.008, Math.ceil(span * 16), [
            [tone, RIDGE, 0.05, 1],
            [relief, '255,255,255', 0.08, 1],
          ]);
        a += span + 0.25 + rnd() * 0.9;
      }
    }

    /* ── Collarette ─────────────────────────────────────────────────────
     *
     * The ridge dividing the pupillary zone from the ciliary one, and the
     * single most recognisable thing on an iris: a wandering, distinctly
     * scalloped line about a third of the way out, with the crypts opening
     * along its outer edge. It runs as a lit ridge with its shadow on the
     * pupil side. */
    /* Broken into arcs of uneven strength, never stroked as one closed
       curve. A continuous ring at a constant width and a constant alpha is a
       gasket, and that is exactly what the first pass at this rendered as —
       a hard wire circle sitting on the iris like the rim of a contact lens.
       On a real iris the collarette fades out over some sectors entirely and
       stands up sharply in others, and the crypts open along the strong
       stretches. */
    let ca = rnd() * 6.283;
    while (ca < 6.283) {
      const span = 0.35 + rnd() * 1.25;
      const gain = 0.35 + rnd() * 0.65;
      const steps = Math.ceil(span * 26);
      ring((th) => collar(th) - 0.026, ca, ca + span, 0.026, steps, [
        [tone, GROOVE, 0.085 * gain, 1],
        [relief, '0,0,0', 0.13 * gain, 1],
        [cavity, '0,0,0', 0.11 * gain, 1],
      ]);
      ring(collar, ca + 0.05, ca + span - 0.05, 0.018, steps, [
        [tone, RIDGE, 0.105 * gain, 1],
        [relief, '255,255,255', 0.20 * gain, 1],
      ]);
      ca += span + 0.08 + rnd() * 0.55;
    }

    /* ── Pupillary ruff ─────────────────────────────────────────────────
     *
     * The fringe of posterior pigment epithelium that wraps around the margin
     * from behind, scalloped by the sphincter under it. Thin — about half a
     * millimetre on a 12mm iris — and nearly black, and the darkest thing on
     * the iris by a wide margin.
     *
     * Drawn clear of the margin, not on it. The shader paints the pupil as a
     * disc whose edge lands a little outside the measured margin, so a ruff
     * baked at the margin itself is entirely underneath it and the pupil
     * renders as a hole cut in coloured paper — which is what it looked like.
     * Standing it off by a few hundredths puts the whole fringe outside the
     * black, where the thing it exists to do, softening the transition from
     * stroma to aperture, can actually happen.
     *
     * Three frequencies, none a multiple of another. Two regular sines beat
     * into a repeating scallop, and a pupil edge with a period reads as a cog
     * wheel. */
    const ruffR = (th) => 0.046
      + 0.0055 * Math.sin(th * 23 + 1.1)
      + 0.0036 * Math.sin(th * 37 - 0.4)
      + 0.0028 * Math.sin(th * 13 + 2.7);
    ring(ruffR, 0, 6.2832, 0.036, 320, [
      [tone, RUFF, 0.46, 1],
      [relief, '255,255,255', 0.12, 1],
      [cavity, '0,0,0', 0.26, 1],
    ]);
    /* Everything inside the margin is behind the pupil and never sampled, but
       the bilinear filter reaches across the edge, so it has to be dark too —
       and it has to reach the ruff. Filled to the pupil radius alone it left
       a ring of untouched mid-grey between the two, which rendered as a pale
       halo around the pupil. */
    tone.beginPath();
    tone.arc(C, C, (PUPIL + 0.042 * (1 - PUPIL)) * C, 0, 6.2832);
    tone.fillStyle = 'rgba(' + RUFF + ',0.62)';
    tone.fill();

    /* Soften the relief before differentiating it. Canvas strokes have hard
       antialiased edges, and a central difference across one of them is a
       spike — the normal map came out reading as glitter rather than as
       fibre. Half a pixel is enough to make the gradient continuous without
       costing the strands their definition. */
    EyeTextures._blur(relief, N * 0.0007);
    EyeTextures._blur(cavity, N * 0.0025);

    const toneData = tone.getImageData(0, 0, N, N).data;
    const reliefData = relief.getImageData(0, 0, N, N).data;
    const cavityData = cavity.getImageData(0, 0, N, N).data;

    const detail = new Uint8ClampedArray(N * N * 4);
    const height = new Float32Array(N * N);

    for (let y = 0; y < N; y++) {
      const dy = (y + 0.5) / N * 2 - 1;
      for (let x = 0; x < N; x++) {
        const dx = (x + 0.5) / N * 2 - 1;
        const i = y * N + x;
        const o = i * 4;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > 1.06) {
          detail[o] = detail[o + 1] = detail[o + 2] = 128;
          detail[o + 3] = 255;
          continue;
        }

        /* Two things the strokes cannot reach, both left analytic.
         *
         * The grain is finer than a path can be stroked at this resolution
         * and is what stops the stroma reading as flat between the strands;
         * the blotch is an irregular pigment patch that ignores the fibre
         * direction entirely, weighted per channel so it shifts hue as well
         * as value — a patch that only changes brightness reads as a stain. */
        const grain = EyeTextures._fbm(dx * 52 + 2, dy * 52 + 2, 8123, 2) - 0.47;
        const blotch = EyeTextures._fbm(dx * 3.4 + 5, dy * 3.4 + 5, 4001, 3) - 0.47;
        // Fade to neutral past the limbus so the square's corners cannot
        // bleed pattern into the sclera through the bilinear filter.
        const edge = 1 - EyeTextures._smooth(0.97, 1.03, r);
        const hue = [0.26, 0.12, -0.02];

        for (let c = 0; c < 3; c++) {
          let v = toneData[o + c] / 127.5;
          v *= 1 + grain * 0.055 + blotch * hue[c];
          detail[o + c] = Math.round(Math.min(2, Math.max(0, 1 + (v - 1) * edge)) * 127.5);
        }
        detail[o + 3] = Math.round((1 - (1 - cavityData[o] / 255) * edge) * 255);
        height[i] = ((reliefData[o] / 255 - 0.5) * 2 + grain * 0.14) * edge;
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
   * The conjunctival bed: episcleral vessels, grown as branching paths, over
   * a warm mottled ground.
   *
   * Thresholded noise cannot produce a vessel: a vessel starts somewhere,
   * runs somewhere, tapers, and splits into children narrower than their
   * parent. Growing them with a canvas stroke gets all of that plus free
   * antialiasing, and multiply blending makes crossings darken the way
   * overlapping vessels do.
   *
   * What changed from the first pass at this: density. Twenty-eight trunks
   * branching three deep filled both canthi edge to edge, and a bed with no
   * white left in it does not read as vessels — it reads as a graze. On a
   * healthy eye the sclera between two vessels is the largest thing in the
   * picture, the vessels are widely spaced and unequal, and there is a clear
   * zone a millimetre wide inside the limbus. So: a third as many trunks,
   * spaced rather than scattered, each one thicker and darker so it survives
   * the shader's exposure terms, and the two canthi given different
   * densities because the nasal side of a real eye is the redder one.
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
    // Not white. Sclera is collagen with a fat pad behind it and it
    // photographs warm; starting the bed at pure white is the same mistake as
    // starting the sclera material there.
    g.fillStyle = '#fffcf6';
    g.fillRect(0, 0, N, N);
    g.lineCap = 'round';
    g.lineJoin = 'round';

    const C = N / 2;
    // Where the limbus falls in this projection.
    const limbus = 0.344 / EyeTextures.SCLERA_POLAR_SPAN;
    /* The perilimbal clear zone. Vessels approach the cornea and stop about a
       millimetre short of it, and that ring of clean sclera around the iris is
       a strong cue — running them right up to the limbus is what makes a CG
       eye look irritated. */
    const clear = limbus * 1.34;

    /* The orbital ground: a broad warm cast that deepens toward the far
       periphery, where the sclera thins over the muscle insertions and the
       orbital fat behind them. Painted before the vessels so they sit in it. */
    const wash = g.createRadialGradient(C, C, C * clear, C, C, C);
    wash.addColorStop(0, 'rgba(255,252,246,0)');
    wash.addColorStop(0.55, 'rgba(246,231,206,0.30)');
    wash.addColorStop(1, 'rgba(232,208,172,0.62)');
    g.fillStyle = wash;
    g.fillRect(0, 0, N, N);

    g.globalCompositeOperation = 'multiply';

    const grow = (x, y, dir, width, alpha, depth) => {
      const pts = [[x, y]];
      // Many short steps with a gentle turn rate. The first pass took long
      // steps and swung hard at each one, which drew a net of straight lines
      // rather than vessels.
      const steps = 9 + Math.floor(rnd() * 10);
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
        d += EyeTextures._wrap(inward - d) * 0.20 + (rnd() - 0.5) * 0.48;
        const len = N * (0.007 + rnd() * 0.013);
        px += Math.cos(d) * len;
        py += Math.sin(d) * len;
        const rad = Math.hypot(px - C, py - C) / C;
        // Stop at the clear zone and at the far edge of what the map covers.
        if (rad < clear || rad > 0.99) break;
        pts.push([px, py]);
      }
      if (pts.length < 2) return;
      // Taper: each segment a little narrower than the last.
      for (let i = 1; i < pts.length; i++) {
        const w = width * (1 - 0.5 * (i / pts.length));
        g.beginPath();
        g.moveTo(pts[i - 1][0], pts[i - 1][1]);
        g.lineTo(pts[i][0], pts[i][1]);
        g.lineWidth = Math.max(0.7, w);
        g.strokeStyle = 'rgba(196, 74, 66, ' + alpha.toFixed(3) + ')';
        g.stroke();
      }
      if (depth >= 2) return;
      const kids = depth === 0 ? 1 + Math.floor(rnd() * 2) : 1;
      for (let k = 0; k < kids; k++) {
        const at = 1 + Math.floor(rnd() * (pts.length - 1));
        const [bx, by] = pts[Math.min(at, pts.length - 1)];
        grow(bx, by, Math.atan2(by - C, bx - C) + Math.PI + (rnd() - 0.5) * 1.3,
          width * (0.50 + rnd() * 0.20), alpha * 0.82, depth + 1);
      }
    };

    /* Trunks enter from the periphery and run toward the limbus. Their start
       angles cluster on the horizontal meridian because that is where the
       palpebral fissure exposes sclera — the vessels over the top and bottom
       of the ball are under the lids and would never be seen anyway.
       Distributed across each lobe rather than sampled at random within it:
       a random scatter clumps, and a clump of vessels is a haemorrhage. */
    const lobes = [
      { centre: 0, spread: 0.95, count: 8 },        // temporal
      { centre: Math.PI, spread: 1.05, count: 11 }, // nasal, the redder side
    ];
    for (const lobe of lobes) {
      for (let i = 0; i < lobe.count; i++) {
        const a = lobe.centre + ((i + 0.5) / lobe.count - 0.5) * 2 * lobe.spread
          + (rnd() - 0.5) * (lobe.spread / lobe.count);
        const rad = 0.74 + rnd() * 0.24;
        grow(C + Math.cos(a) * rad * C, C + Math.sin(a) * rad * C,
          Math.atan2(-Math.sin(a), -Math.cos(a)) + (rnd() - 0.5) * 0.5,
          N * (0.0030 + rnd() * 0.0040), 0.42 + rnd() * 0.24, 0);
      }
    }

    // A second, finer bed drawn soft and wide: the deep vessels a millimetre
    // of collagen sits over, which read as a diffuse flush rather than as
    // lines. This is what carries the redness at portrait distance, where the
    // discrete vessels above are a pixel wide and have averaged away.
    g.filter = 'blur(' + (N / 90).toFixed(1) + 'px)';
    for (let i = 0; i < 10; i++) {
      const lobe = i < 4 ? 0 : Math.PI;
      const a = lobe + (rnd() - 0.5) * 1.6;
      const rad = 0.60 + rnd() * 0.34;
      grow(C + Math.cos(a) * rad * C, C + Math.sin(a) * rad * C,
        Math.atan2(-Math.sin(a), -Math.cos(a)) + (rnd() - 0.5) * 0.8,
        N * (0.010 + rnd() * 0.012), 0.16 + rnd() * 0.10, 1);
    }
    g.filter = 'none';
    g.globalCompositeOperation = 'source-over';

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
