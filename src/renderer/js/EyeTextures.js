// Paints the iris and sclera detail textures (colour, relief, vessels) once on canvases, mapped onto a disc so they have no seam.
class EyeTextures {
  // Iris map size; the iris needs the finest detail.
  static get SIZE() { return 1024; }

  // Sclera map size, half the iris, since its content is soft and this keeps the first bake fast.
  static get SCLERA_SIZE() { return 512; }

  // Pupil size the iris map is drawn at, as a share of the iris; the shader rescales it per eye.
  static get IRIS_PUPIL_FRACTION() { return 0.42; }

  // How far from the front of the eye the sclera map reaches before the eyeball turns out of sight.
  static get SCLERA_POLAR_SPAN() { return 1.65; }

  // How strongly the baked relief tilts the normals; kept low so strands don't look like wire.
  static get IRIS_RELIEF() { return 2.1; }

  // ── Public ───────────────────────────────────────────────────────────────

  // Builds the three maps once, on first use, and shares them between both eyes.
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

  // Seeded random generator, so the eye looks the same every session.
  static _rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // Hashes two integer coordinates and a seed into a number between 0 and 1.
  static _hash2(ix, iy, seed) {
    let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) >>> 0;
    h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // Smooth value noise at a point.
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

  // Layered noise (several octaves added together).
  static _fbm(x, y, seed, octaves) {
    let v = 0, amp = 0.5, f = 1;
    for (let i = 0; i < octaves; i++) {
      v += amp * EyeTextures._noise(x * f, y * f, seed + i * 37);
      f *= 2.03; amp *= 0.5;
    }
    return v;
  }

  // Smoothstep between a and b.
  static _smooth(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
    return t * t * (3 - 2 * t);
  }

  // Wraps an angle difference into [-pi, pi].
  static _wrap(d) {
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Turns pixel data into a clamped, non-colour texture.
  static _upload(data, name, size) {
    const N = size || EyeTextures.SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = N; canvas.height = N;
    canvas.getContext('2d').putImageData(new ImageData(data, N, N), 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.name = name;
    // The shader computes its own disc coordinates, so don't flip the rows.
    tex.flipY = false;
    // Modulation and normal data, not colour: no sRGB decode on the way in.
    tex.colorSpace = THREE.NoColorSpace;
    // Never tile, or the far side of the iris wraps into view.
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    return tex;
  }

  // ── Iris ─────────────────────────────────────────────────────────────────

  // Creates a filled 2D canvas context; willReadFrequently is left off because it made the bake far slower.
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

  // Blurs a canvas in place through a scratch canvas.
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

  // Paints the iris as anatomy with strokes (sectors, bundles, strands, crypts, furrows, collarette, ruff) into tone, relief and cavity maps.
  static _buildIris() {
    const N = EyeTextures.SIZE;
    const C = N / 2;
    const PUPIL = EyeTextures.IRIS_PUPIL_FRACTION;
    const rnd = EyeTextures._rng(90210);

    const tone = EyeTextures._ctx(N, '#808080');
    const relief = EyeTextures._ctx(N, '#808080');
    const cavity = EyeTextures._ctx(N, '#ffffff');

    // Annulus coordinates: t is 0 at the pupil edge and 1 at the outer edge of the iris.
    const at = (theta, t) => {
      const r = (PUPIL + t * (1 - PUPIL)) * C;
      return [C + Math.cos(theta) * r, C + Math.sin(theta) * r];
    };
    // One unit of t in pixels, so widths scale with the map.
    const TPX = (1 - PUPIL) * C;

    // Walks a path through the iris and paints every map from the same walk, tapering width and opacity at both ends.
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

    // A closed wobbly curve, used for the collarette, furrows and ruff.
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

    // Ink colours; warm means more red than blue, so every iris colour keeps its own hue.
    const RIDGE = '255,250,238';   // stroma catching light: warm, near white
    const GROOVE = '52,40,28';     // the shadow between two bundles
    const PIT = '62,44,30';        // a crypt: an opening, not a stain
    const RUFF = '30,16,8';        // posterior pigment, the warmest dark here

    // Where the collarette runs at each angle, as a seamless sum of sine waves.
    const cH = [];
    for (let i = 0; i < 5; i++) {
      cH.push({ f: 2 + i + Math.floor(rnd() * 3), a: 0.045 / (i * 0.7 + 1), p: rnd() * 6.283 });
    }
    const collar = (th) => {
      let r = 0.32;
      for (const h of cH) r += Math.sin(th * h.f + h.p) * h.a;
      return r;
    };

    // Sector wedges: broad lighter and darker areas, the detail that still shows at normal viewing distance.
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

    // Trabecular bundles, most stopping short of either edge so it doesn't look like a starburst.
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

    // Strands: each ridge sits in its own darker groove so they read as a mat of fibres.
    for (let i = 0; i < 720; i++) {
      // Evenly spaced angles, since random ones clump.
      const theta = (i + rnd()) / 720 * Math.PI * 2;
      const t0 = -0.04 + rnd() * 0.58;
      const t1 = Math.min(1.05, t0 + 0.26 + rnd() * 0.62);
      const bow = (rnd() - 0.5) * 0.16;
      const phase = rnd() * 6.283;
      const w = 0.007 + rnd() * 0.012;
      // Same path for groove and ridge so they stay together.
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

    // Crypts: dark, ragged, stretched openings, mostly along the collarette, with a lit rim for depth.
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

    // Stretched about three to one along the fibres so they read as openings, not spots.
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

    // Fine stroma: short thin strands that keep the surface from looking smooth up close.
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

    // Contraction furrows: broken arcs in the outer iris, each a dark crease with a lit edge.
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

    // Collarette: the wavy ridge a third of the way out, drawn as broken arcs of uneven strength.
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

    // Pupillary ruff: a thin, nearly black scalloped fringe just outside the pupil edge.
    const ruffR = (th) => 0.046
      + 0.0055 * Math.sin(th * 23 + 1.1)
      + 0.0036 * Math.sin(th * 37 - 0.4)
      + 0.0028 * Math.sin(th * 13 + 2.7);
    ring(ruffR, 0, 6.2832, 0.036, 320, [
      [tone, RUFF, 0.46, 1],
      [relief, '255,255,255', 0.12, 1],
      [cavity, '0,0,0', 0.26, 1],
    ]);
    // Fill inside the pupil dark all the way to the ruff, or a pale halo shows.
    tone.beginPath();
    tone.arc(C, C, (PUPIL + 0.042 * (1 - PUPIL)) * C, 0, 6.2832);
    tone.fillStyle = 'rgba(' + RUFF + ',0.62)';
    tone.fill();

    // Soften the relief slightly before turning it into normals, or they sparkle.
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

        // Add fine grain and irregular pigment patches that strokes can't draw.
        const grain = EyeTextures._fbm(dx * 52 + 2, dy * 52 + 2, 8123, 2) - 0.47;
        const blotch = EyeTextures._fbm(dx * 3.4 + 5, dy * 3.4 + 5, 4001, 3) - 0.47;
        // Fade to neutral past the iris edge so nothing bleeds into the sclera.
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

    // Normals from the height field using central differences.
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

  // Paints the sclera: a warm mottled base with branching blood vessels, sparse and uneven like a healthy eye.
  static _buildSclera() {
    const N = EyeTextures.SCLERA_SIZE;
    const rnd = EyeTextures._rng(551987);
    const canvas = document.createElement('canvas');
    canvas.width = N; canvas.height = N;
    const g = canvas.getContext('2d');
    // Not pure white; the sclera looks warm in photos.
    g.fillStyle = '#fffcf6';
    g.fillRect(0, 0, N, N);
    g.lineCap = 'round';
    g.lineJoin = 'round';

    const C = N / 2;
    // Where the limbus falls in this projection.
    const limbus = 0.344 / EyeTextures.SCLERA_POLAR_SPAN;
    // Leave a clear ring around the iris where vessels stop.
    const clear = limbus * 1.34;

    // A warm cast that deepens toward the edges, painted under the vessels.
    const wash = g.createRadialGradient(C, C, C * clear, C, C, C);
    wash.addColorStop(0, 'rgba(255,252,246,0)');
    wash.addColorStop(0.55, 'rgba(246,231,206,0.30)');
    wash.addColorStop(1, 'rgba(232,208,172,0.62)');
    g.fillStyle = wash;
    g.fillRect(0, 0, N, N);

    g.globalCompositeOperation = 'multiply';

    const grow = (x, y, dir, width, alpha, depth) => {
      const pts = [[x, y]];
      // Many short steps with gentle turns so the paths look like vessels, not a net of lines.
      const steps = 9 + Math.floor(rnd() * 10);
      let px = x, py = y, d = dir;
      for (let i = 0; i < steps; i++) {
        // Wander, but keep pulling toward the iris so the vessels radiate rather than tangle.
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

    // Vessels start at the corners of the eye and are spread evenly so they don't clump.
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

    // A second soft layer of deep vessels, which carries the redness at portrait distance.
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
        // Two scales of mottle, since the sclera is fibrous, not flat.
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
