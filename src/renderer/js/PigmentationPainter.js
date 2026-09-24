// Lets the user paint dark spots and other pigmentation onto the skin texture.

class PigmentationPainter {
  constructor(sceneManager, skinTextureSystem) {
    this.sceneManager = sceneManager;
    this.scene = sceneManager.scene;
    this.camera = sceneManager.camera;
    this.canvas = sceneManager.canvas;
    this.controls = sceneManager.controls;
    this.skinTexture = skinTextureSystem;

    this.enabled = false;
    this.eraseMode = false;

    // Brush parameters
    this.brushSize = 12;        // radius in UV-space pixels (on 512 texture)
    this.brushStrength = 0.15;  // 0–1 per stamp
    this.brushColor = '#6B3A2A'; // default dark brown

    // Pigmentation maps (same res as SkinTextureSystem)
    this.RES = skinTextureSystem.RES; // 512
    this._pigmentMap = new Float32Array(this.RES * this.RES);  // intensity 0–1
    this._colorMap = new Uint8Array(this.RES * this.RES * 3);  // RGB per pixel

    // Initialize color map to default brown
    const defaultRgb = this._hexToRgb(this.brushColor);
    for (let i = 0, n = this.RES * this.RES; i < n; i++) {
      this._colorMap[i * 3]     = defaultRgb.r;
      this._colorMap[i * 3 + 1] = defaultRgb.g;
      this._colorMap[i * 3 + 2] = defaultRgb.b;
    }

    // Undo stack (stores { pigment, color } snapshot pairs, max 30)
    this._undoStack = [];
    this._maxUndo = 30;

    // Raycaster
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // Painting state
    this._isPainting = false;
    this._lastUV = null;

    // Bound handlers
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);

    // Callback when pigmentation changes (for case manager persistence)
    this.onChanged = null;
  }

  // ─── Enable / Disable ──────────────────────────────────────────────────

  // Starts listening for paint strokes on the canvas.
  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.canvas.addEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.addEventListener('pointermove', this._onPointerMove, true);
    this.canvas.addEventListener('pointerup', this._onPointerUp, true);
    this.canvas.style.cursor = 'crosshair';
  }

  // Stops listening for paint strokes.
  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this._isPainting = false;
    this._lastUV = null;
    this.canvas.removeEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.removeEventListener('pointermove', this._onPointerMove, true);
    this.canvas.removeEventListener('pointerup', this._onPointerUp, true);
    this.canvas.style.cursor = '';
    this.controls.enabled = true;
  }

  // Turns the pigment brush on or off.
  toggle() {
    if (this.enabled) { this.disable(); } else { this.enable(); }
    return this.enabled;
  }

  // ─── Raycasting ────────────────────────────────────────────────────────

  // Converts the mouse position to normalised screen coordinates.
  _getNDC(event) {
    const rect = this.canvas.getBoundingClientRect();
    this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  // Casts a ray from the mouse and returns the skin texture position it hits.
  _raycastUV(event) {
    this._getNDC(event);
    this._raycaster.setFromCamera(this._mouse, this.camera);

    const headMesh = this.sceneManager.headMesh;
    if (!headMesh) return null;

    const meshes = [];
    headMesh.traverse(c => { if (c.isMesh) meshes.push(c); });

    const hits = this._raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    const hit = hits[0];
    const uv = hit.uv;
    if (!uv) return null;

    return { u: uv.x, v: uv.y };
  }

  // ─── Pointer Events ────────────────────────────────────────────────────

  // Starts a stroke where the user pressed on the face.
  _handlePointerDown(event) {
    if (event.button !== 0) return;

    const uv = this._raycastUV(event);
    if (!uv) return;

    this.controls.enabled = false;
    event.preventDefault();
    event.stopPropagation();

    this._pushUndo();

    this._isPainting = true;
    this._lastUV = uv;
    this._stampBrush(uv.u, uv.v);
    this._applyToTexture();
  }

  // Paints along the stroke as the mouse moves.
  _handlePointerMove(event) {
    if (!this._isPainting) return;
    event.preventDefault();
    event.stopPropagation();

    const uv = this._raycastUV(event);
    if (!uv) return;

    if (this._lastUV) {
      const du = uv.u - this._lastUV.u;
      const dv = uv.v - this._lastUV.v;
      const dist = Math.sqrt(du * du + dv * dv) * this.RES;
      const steps = Math.max(1, Math.ceil(dist / (this.brushSize * 0.3)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const su = this._lastUV.u + du * t;
        const sv = this._lastUV.v + dv * t;
        this._stampBrush(su, sv);
      }
    } else {
      this._stampBrush(uv.u, uv.v);
    }

    this._lastUV = uv;
    this._applyToTexture();
  }

  // Ends the stroke and refreshes the skin.
  _handlePointerUp(event) {
    if (!this._isPainting) return;
    this._isPainting = false;
    this._lastUV = null;
    this.controls.enabled = true;

    this._applyToTexture();
    if (this.onChanged) this.onChanged();
  }

  // ─── Brush Stamping ────────────────────────────────────────────────────

  // Paints one soft round dab of pigment into the maps.
  _stampBrush(u, v) {
    const R = this.RES;
    const cx = Math.round(u * (R - 1));
    const cy = Math.round(v * (R - 1));
    const r = this.brushSize;
    const str = this.brushStrength;
    const erase = this.eraseMode;
    const color = this._hexToRgb(this.brushColor);

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r) continue;

        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= R || py < 0 || py >= R) continue;

        const falloff = 1.0 - (dist / r);
        const weight = falloff * falloff * str;
        const idx = py * R + px;

        if (erase) {
          this._pigmentMap[idx] *= (1.0 - weight);
        } else {
          const oldInt = this._pigmentMap[idx];
          const newInt = Math.min(1.0, oldInt + weight);
          this._pigmentMap[idx] = newInt;

          // Blend per-pixel color toward current brush color
          if (newInt > 0) {
            const t = (newInt > 0.001) ? weight / newInt : 1.0;
            const ci = idx * 3;
            this._colorMap[ci]     = Math.round(this._colorMap[ci]     * (1 - t) + color.r * t);
            this._colorMap[ci + 1] = Math.round(this._colorMap[ci + 1] * (1 - t) + color.g * t);
            this._colorMap[ci + 2] = Math.round(this._colorMap[ci + 2] * (1 - t) + color.b * t);
          }
        }
      }
    }
  }

  // ─── Apply to Texture ──────────────────────────────────────────────────

  // Rebuilds the skin texture so the new pigment shows.
  _applyToTexture() {
    if (this.skinTexture && this.skinTexture._initialized) {
      this.skinTexture.regenerate();
    }
  }

  // Resizes the pigment maps to a new texture resolution, keeping what was painted.
  resize(res) {
    const r = res | 0;
    if (!r || r === this.RES || !this._pigmentMap) return;

    const oldR = this.RES;
    const oldPig = this._pigmentMap;
    const oldCol = this._colorMap;
    const pig = new Float32Array(r * r);
    const col = new Uint8Array(r * r * 3);

    for (let y = 0; y < r; y++) {
      const sy = Math.min(oldR - 1, (y * oldR / r) | 0);
      for (let x = 0; x < r; x++) {
        const sx = Math.min(oldR - 1, (x * oldR / r) | 0);
        const si = sy * oldR + sx;
        const di = y * r + x;
        pig[di] = oldPig[si];
        col[di * 3]     = oldCol[si * 3];
        col[di * 3 + 1] = oldCol[si * 3 + 1];
        col[di * 3 + 2] = oldCol[si * 3 + 2];
      }
    }

    this.RES = r;
    this._pigmentMap = pig;
    this._colorMap = col;
    this._undoStack = [];
    if (this._paintCanvas) {
      this._paintCanvas.width = r;
      this._paintCanvas.height = r;
    }
  }

  // Returns the pigment strength map.
  getPigmentMap() {
    return this._pigmentMap;
  }

  // Returns the pigment colour map.
  getColorMap() {
    return this._colorMap;
  }

  // ─── Undo ──────────────────────────────────────────────────────────────

  // Saves a copy of the maps so the next change can be undone.
  _pushUndo() {
    if (this._undoStack.length >= this._maxUndo) {
      this._undoStack.shift();
    }
    this._undoStack.push({
      pigment: new Float32Array(this._pigmentMap),
      color: new Uint8Array(this._colorMap),
    });
  }

  // Undoes the last change.
  undo() {
    if (this._undoStack.length === 0) return;
    const snapshot = this._undoStack.pop();
    this._pigmentMap = snapshot.pigment;
    this._colorMap = snapshot.color;
    this._applyToTexture();
    if (this.onChanged) this.onChanged();
  }

  // ─── Clear ─────────────────────────────────────────────────────────────

  // Removes all painted pigment.
  clearAll() {
    this._pushUndo();
    this._pigmentMap.fill(0);
    // Reset color map to default brown
    const defaultRgb = this._hexToRgb('#6B3A2A');
    for (let i = 0, n = this.RES * this.RES; i < n; i++) {
      this._colorMap[i * 3]     = defaultRgb.r;
      this._colorMap[i * 3 + 1] = defaultRgb.g;
      this._colorMap[i * 3 + 2] = defaultRgb.b;
    }
    this._applyToTexture();
    if (this.onChanged) this.onChanged();
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  // Returns the painted pixels in a compact form for saving.
  exportState() {
    const sparse = {};
    for (let i = 0, n = this._pigmentMap.length; i < n; i++) {
      if (this._pigmentMap[i] > 0.001) {
        const ci = i * 3;
        sparse[i] = {
          a: Math.round(this._pigmentMap[i] * 10000) / 10000,
          r: this._colorMap[ci],
          g: this._colorMap[ci + 1],
          b: this._colorMap[ci + 2],
        };
      }
    }
    return {
      brushSize: this.brushSize,
      brushStrength: this.brushStrength,
      brushColor: this.brushColor,
      data: sparse,
    };
  }

  // Restores painted pigment from a saved case.
  loadState(state) {
    if (!state) return;
    if (state.brushSize !== undefined) this.brushSize = state.brushSize;
    if (state.brushStrength !== undefined) this.brushStrength = state.brushStrength;
    if (state.brushColor !== undefined) this.brushColor = state.brushColor;
    if (state.data) {
      this._pigmentMap.fill(0);
      const defaultRgb = this._hexToRgb('#6B3A2A');
      for (let i = 0, n = this.RES * this.RES; i < n; i++) {
        this._colorMap[i * 3]     = defaultRgb.r;
        this._colorMap[i * 3 + 1] = defaultRgb.g;
        this._colorMap[i * 3 + 2] = defaultRgb.b;
      }
      for (const [idx, val] of Object.entries(state.data)) {
        const i = parseInt(idx);
        this._pigmentMap[i] = val.a;
        const ci = i * 3;
        this._colorMap[ci]     = val.r;
        this._colorMap[ci + 1] = val.g;
        this._colorMap[ci + 2] = val.b;
      }
      this._applyToTexture();
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  // Converts a hex colour to RGB.
  _hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16),
    } : { r: 107, g: 58, b: 42 }; // fallback to default brown
  }

  // ─── Dispose ───────────────────────────────────────────────────────────

  // Turns the brush off and frees its maps.
  dispose() {
    this.disable();
    this._pigmentMap = null;
    this._colorMap = null;
    this._undoStack = [];
  }
}

window.PigmentationPainter = PigmentationPainter;
