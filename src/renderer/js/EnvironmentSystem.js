/**
 * EnvironmentSystem.js
 * Builds the image-based lighting environment the whole scene shades against.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until this file, the scene never set `scene.environment` at all — it lit
 * everything with three directional lights and an ambient. A PBR material with
 * no environment has nothing to reflect, so its specular lobe returns almost
 * black and skin collapses to flat matte clay. That single omission was the
 * largest contributor to the head reading as a cartoon rather than a face.
 *
 * The environment is drawn on a canvas rather than loaded from an .hdr so the
 * app stays fully offline and no binary asset joins the repo. It is an
 * equirectangular studio: a sky→horizon→floor ramp with three softboxes burned
 * into it at the SAME directions as the direct lights in SceneManager, so the
 * reflected highlights and the cast shadows agree about where the light is.
 * Mismatched IBL and key lighting looks wrong in a way that is hard to name.
 *
 * EQUIRECTANGULAR LAYOUT (three's `equirectUv`, with CanvasTexture flipY):
 *   u = atan2(dir.z, dir.x) / 2PI + 0.5   →  +Z front = 0.75, +X right = 0.50,
 *                                            -Z back  = 0.25, -X left  = 0.00
 *   v = asin(dir.y) / PI + 0.5            →  canvas row 0 is straight up.
 *
 * `directionToUV()` below is the single place that conversion lives, and the
 * softbox placements are expressed as the light vectors themselves, so the two
 * setups cannot drift apart when someone moves a light.
 *
 * This replaces the near-identical private env builders that EarringSystem and
 * EyebrowPiercingSystem each carried for their metal shading; both now share
 * this one, which also means the jewellery and the skin agree on the lighting.
 */

class EnvironmentSystem {
  /** @param {THREE.WebGLRenderer} renderer needed to PMREM-filter the canvas. */
  constructor(renderer) {
    this.renderer = renderer;
    this.texture = null;      // PMREM-filtered, for scene.environment / envMap
    this._renderTarget = null;
    this._backgroundTexture = null;

    this.WIDTH = 1024;
    this.HEIGHT = 512;

    // Softbox directions mirror SceneManager.setupStudioLighting() exactly.
    // warmth tints toward amber when positive, toward daylight when negative.
    //
    // The radii are large on purpose. These are the shapes that show up in the
    // specular highlight on a forehead or a nose tip, and a small bright source
    // puts a hard white dot there — the single most reliable "this is CG" tell
    // on skin. A metre-wide softbox at portrait distance subtends a broad, soft
    // highlight with a falloff, which is what these radii reproduce.
    this.SOFTBOXES = [
      { dir: [1.95, 2.15, 3.05], radius: 250, intensity: 1.00, warmth: 0.008 }, // key
      { dir: [-2.7, 0.65, 2.3], radius: 300, intensity: 0.44, warmth: -0.10 },  // fill
      { dir: [-1.9, 1.5, -2.4], radius: 165, intensity: 0.34, warmth: 0.02 },   // rim
      { dir: [2.1, 1.2, -2.2], radius: 150, intensity: 0.22, warmth: -0.06 },   // rim 2
    ];
  }

  /**
   * Convert a direction vector to canvas pixel coordinates.
   * Returns {x, y} in pixels, y measured from the top of the canvas.
   */
  directionToUV(x, y, z) {
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const dx = x / len, dy = y / len, dz = z / len;
    const u = Math.atan2(dz, dx) / (Math.PI * 2) + 0.5;
    const v = Math.asin(Math.max(-1, Math.min(1, dy))) / Math.PI + 0.5;
    // v = 1 is straight up; with flipY the canvas top row is v = 1.
    return { x: u * this.WIDTH, y: (1 - v) * this.HEIGHT };
  }

  /**
   * Draw the equirectangular studio onto a 2D canvas.
   */
  _paintEquirect() {
    const W = this.WIDTH, H = this.HEIGHT;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    /* ── Base ramp: overhead sky → horizon grey → floor bounce ──
       The floor is not black: a real studio floor bounces light back up under
       the chin and into the nostrils, and losing that makes a face look like
       it is lit in a void.

       The whole ramp is roughly half its former brightness. It used to open at
       #f2f4f7 — a near-white dome over the entire upper hemisphere, which is
       not a studio, it is an overcast sky inside a white box. Because it
       arrives from every direction at once it lit the key side and the shadow
       side by the same amount, and no key placement can produce modelling
       against that: measured on a front view, the two cheeks came out 1.03:1.

       What a studio actually looks like is a dark room with a few bright
       sources in it. Darkening the ramp and leaving the softboxes alone is the
       version of that this file can express — and it costs nothing in
       realism, because the specular highlight that stops skin reading as clay
       comes from the softboxes, not from the dome behind them. */
    const ramp = ctx.createLinearGradient(0, 0, 0, H);
    ramp.addColorStop(0.00, '#787f88');
    ramp.addColorStop(0.30, '#5e646d');
    ramp.addColorStop(0.48, '#454a52');
    ramp.addColorStop(0.52, '#32353c');
    ramp.addColorStop(0.78, '#212328');
    /* Floor bounce, cooled from #2f2c26. With the dome halved this was the
       warmest thing still reaching the shadow side, and it was pulling the
       unlit cheek towards amber — skin in shadow is lit by the room, which is
       cooler than the key, not warmer. */
    ramp.addColorStop(1.00, '#2b2a2a');
    ctx.fillStyle = ramp;
    ctx.fillRect(0, 0, W, H);

    // ── Softboxes ──
    // Radial falloff rather than a hard rect. PMREM blurs the rough mips
    // anyway, but the sharp mip drives the specular highlight, and a
    // soft-edged source is what gives skin a broad rolling sheen instead of
    // a hard dot.
    for (const box of this.SOFTBOXES) {
      const p = this.directionToUV(box.dir[0], box.dir[1], box.dir[2]);
      const r = box.radius;
      const warm = box.warmth;
      const rr = Math.round(255 * Math.min(1, 1 + warm * 0.5));
      const gg = Math.round(255 * Math.min(1, 1 - Math.abs(warm) * 0.10));
      const bb = Math.round(255 * Math.min(1, 1 - warm * 0.55));

      // Draw across the seam so a softbox near u=0 wraps correctly.
      for (const xOff of [-W, 0, W]) {
        const cx = p.x + xOff;
        if (cx + r < 0 || cx - r > W) continue;

        const g = ctx.createRadialGradient(cx, p.y, 1, cx, p.y, r);
        g.addColorStop(0.00, 'rgba(' + rr + ',' + gg + ',' + bb + ',' + box.intensity + ')');
        g.addColorStop(0.45, 'rgba(' + rr + ',' + gg + ',' + bb + ',' + (box.intensity * 0.35) + ')');
        g.addColorStop(1.00, 'rgba(' + rr + ',' + gg + ',' + bb + ',0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx - r, p.y - r, r * 2, r * 2);
      }
    }

    return canvas;
  }

  /**
   * Build the PMREM environment. Safe to call more than once; the previous
   * render target is released first.
   *
   * Returns the filtered texture, or null if PMREM is unavailable — callers
   * must tolerate null and fall back to direct lighting only.
   */
  build() {
    if (!this.renderer || typeof THREE.PMREMGenerator !== 'function') {
      console.warn('[Environment] No renderer/PMREM — shading will stay flat');
      return null;
    }

    try {
      this.dispose();

      const canvas = this._paintEquirect();
      const tex = new THREE.CanvasTexture(canvas);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;

      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      this._renderTarget = pmrem.fromEquirectangular(tex);
      pmrem.dispose();
      tex.dispose();

      this.texture = this._renderTarget.texture;
      console.log('[Environment] Studio IBL built');
      return this.texture;
    } catch (e) {
      console.warn('[Environment] Build failed:', e);
      this.texture = null;
      return null;
    }
  }

  /**
   * A seamless studio backdrop for the scene background.
   *
   * Deliberately NOT the equirect environment: showing the raw softboxes behind
   * the head looks like a chrome-ball capture. A portrait backdrop is a
   * near-flat sweep, so this is a plain vertical gradient — which is what real
   * seamless paper looks like on camera.
   */
  buildBackground() {
    const W = 32, H = 512;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.00, '#23262b');
    g.addColorStop(0.42, '#2e3238');
    g.addColorStop(0.62, '#24272c');
    g.addColorStop(1.00, '#141619');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    if (this._backgroundTexture) this._backgroundTexture.dispose();
    this._backgroundTexture = tex;
    return tex;
  }

  dispose() {
    if (this._renderTarget) {
      this._renderTarget.dispose();
      this._renderTarget = null;
    }
    this.texture = null;
  }

  disposeAll() {
    this.dispose();
    if (this._backgroundTexture) {
      this._backgroundTexture.dispose();
      this._backgroundTexture = null;
    }
  }
}

window.EnvironmentSystem = EnvironmentSystem;
