// Paints a soft studio lighting environment on a canvas so skin and metal get realistic reflections.

class EnvironmentSystem {
  // The renderer is needed to filter the environment map.
  constructor(renderer) {
    this.renderer = renderer;
    this.texture = null;      // PMREM-filtered, for scene.environment / envMap
    this._renderTarget = null;
    this._backgroundTexture = null;

    this.WIDTH = 1024;
    this.HEIGHT = 512;

    // Softboxes match SceneManager's lights and are large on purpose, so skin highlights stay soft instead of a hard white dot.
    this.SOFTBOXES = [
      { dir: [1.95, 2.15, 3.05], radius: 320, intensity: 0.55, warmth: 0.0 },   // key
      { dir: [-2.7, 0.65, 2.3], radius: 360, intensity: 0.28, warmth: -0.015 }, // fill
      { dir: [-1.9, 1.5, -2.4], radius: 180, intensity: 0.10, warmth: 0.0 },   // rim
      { dir: [2.1, 1.2, -2.2], radius: 180, intensity: 0.07, warmth: 0.0 },    // rim 2
    ];
  }

  // Converts a direction to pixel coordinates on the environment canvas.
  directionToUV(x, y, z) {
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const dx = x / len, dy = y / len, dz = z / len;
    const u = Math.atan2(dz, dx) / (Math.PI * 2) + 0.5;
    const v = Math.asin(Math.max(-1, Math.min(1, dy))) / Math.PI + 0.5;
    // v = 1 is straight up; with flipY the canvas top row is v = 1.
    return { x: u * this.WIDTH, y: (1 - v) * this.HEIGHT };
  }

  // Draws the studio environment onto a 2D canvas.
  _paintEquirect() {
    const W = this.WIDTH, H = this.HEIGHT;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // Dim studio ramp from ceiling to floor; keeping it dark lets the key light shape the face instead of lighting both cheeks equally.
    const ramp = ctx.createLinearGradient(0, 0, 0, H);
    ramp.addColorStop(0.00, '#787f88');
    ramp.addColorStop(0.30, '#5e646d');
    ramp.addColorStop(0.48, '#454a52');
    ramp.addColorStop(0.52, '#32353c');
    ramp.addColorStop(0.78, '#212328');
    // Slightly cool floor bounce, because skin in shadow is lit by the room, not by warm light.
    ramp.addColorStop(1.00, '#2b2a2a');
    ctx.fillStyle = ramp;
    ctx.fillRect(0, 0, W, H);

    // Soft round softboxes give skin a broad sheen instead of a hard dot.
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

  // Builds the filtered lighting environment, or returns null if that isn't supported.
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

  // Builds a plain gradient backdrop, like the seamless paper used in portrait studios.
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

  // Frees the GPU resources.
  dispose() {
    if (this._renderTarget) {
      this._renderTarget.dispose();
      this._renderTarget = null;
    }
    this.texture = null;
  }
}

window.EnvironmentSystem = EnvironmentSystem;
