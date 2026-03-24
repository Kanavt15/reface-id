/**
 * WrinklePainter.js
 * Manual wrinkle drawing tool — paint wrinkles directly onto the 3D face
 * by clicking and dragging. Strokes are recorded in UV space on a height map
 * canvas that gets composited into SkinTextureSystem's normal map.
 *
 * Uses raycasting to find the face surface point under the cursor, then
 * converts the hit to UV coordinates and stamps a brush footprint.
 */

class WrinklePainter {
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
    this.brushSize = 15;      // radius in UV-space pixels (on 512 texture)
    this.brushStrength = 0.4;  // 0–1

    // Height map canvas for manual wrinkles (same res as SkinTextureSystem)
    this.RES = skinTextureSystem.RES; // 512
    this._paintCanvas = document.createElement('canvas');
    this._paintCanvas.width = this.RES;
    this._paintCanvas.height = this.RES;
    // Float height map: negative = indent (wrinkle), 0 = neutral
    this._heightMap = new Float32Array(this.RES * this.RES);

    // Undo stack (stores full height map snapshots, max 30)
    this._undoStack = [];
    this._maxUndo = 30;

    // Raycaster
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // Painting state
    this._isPainting = false;
    this._lastUV = null; // for interpolating between pointer events

    // Bound handlers
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);

    // Callback when wrinkles change (for case manager persistence)
    this.onChanged = null;
  }

  // ─── Enable / Disable ──────────────────────────────────────────────────

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.canvas.addEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.addEventListener('pointermove', this._onPointerMove, true);
    this.canvas.addEventListener('pointerup', this._onPointerUp, true);
    this.canvas.style.cursor = 'crosshair';
  }

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

  toggle() {
    if (this.enabled) { this.disable(); } else { this.enable(); }
    return this.enabled;
  }

  // ─── Raycasting ────────────────────────────────────────────────────────

  _getNDC(event) {
    const rect = this.canvas.getBoundingClientRect();
    this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * Raycast the face mesh and return the UV coordinates of the hit point.
   * Returns { u, v } in [0,1] range, or null if no hit.
   */
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

  _handlePointerDown(event) {
    if (event.button !== 0) return; // left click only

    const uv = this._raycastUV(event);
    if (!uv) return;

    // Disable orbit controls while painting
    this.controls.enabled = false;
    event.preventDefault();
    event.stopPropagation();

    // Save undo snapshot before starting a new stroke
    this._pushUndo();

    this._isPainting = true;
    this._lastUV = uv;
    this._stampBrush(uv.u, uv.v);
    this._applyToTexture();
  }

  _handlePointerMove(event) {
    if (!this._isPainting) return;
    event.preventDefault();
    event.stopPropagation();

    const uv = this._raycastUV(event);
    if (!uv) return;

    // Interpolate between last UV and current UV for smooth strokes
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

  _handlePointerUp(event) {
    if (!this._isPainting) return;
    this._isPainting = false;
    this._lastUV = null;
    this.controls.enabled = true;

    // Final update
    this._applyToTexture();
    if (this.onChanged) this.onChanged();
  }

  // ─── Brush Stamping ────────────────────────────────────────────────────

  /**
   * Stamp the brush at UV coordinates (u, v) in [0,1] range.
   * Modifies the internal height map.
   */
  _stampBrush(u, v) {
    const R = this.RES;
    const cx = Math.round(u * (R - 1));
    const cy = Math.round(v * (R - 1));
    const r = this.brushSize;
    const str = this.brushStrength;
    const erase = this.eraseMode;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r) continue;

        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= R || py < 0 || py >= R) continue;

        // Smooth falloff (Gaussian-ish)
        const falloff = 1.0 - (dist / r);
        const weight = falloff * falloff * str;

        const idx = py * R + px;
        if (erase) {
          // Move toward 0 (neutral)
          this._heightMap[idx] *= (1.0 - weight);
        } else {
          // Indent (negative = wrinkle groove)
          this._heightMap[idx] -= weight * 0.15;
          // Clamp to reasonable range
          if (this._heightMap[idx] < -1.0) this._heightMap[idx] = -1.0;
        }
      }
    }
  }

  // ─── Apply to Texture ──────────────────────────────────────────────────

  /**
   * Triggers SkinTextureSystem to regenerate the normal map,
   * which will now include our manual wrinkle height data.
   */
  _applyToTexture() {
    if (this.skinTexture && this.skinTexture._initialized) {
      this.skinTexture.regenerate();
    }
  }

  /**
   * Returns the manual wrinkle height map for compositing.
   * Called by SkinTextureSystem._generateNormalMap().
   */
  getHeightMap() {
    return this._heightMap;
  }

  /**
   * Check if there are any manual wrinkles painted.
   */
  hasManualWrinkles() {
    for (let i = 0, n = this._heightMap.length; i < n; i++) {
      if (this._heightMap[i] !== 0) return true;
    }
    return false;
  }

  // ─── Undo ──────────────────────────────────────────────────────────────

  _pushUndo() {
    if (this._undoStack.length >= this._maxUndo) {
      this._undoStack.shift();
    }
    this._undoStack.push(new Float32Array(this._heightMap));
  }

  undo() {
    if (this._undoStack.length === 0) return;
    this._heightMap = this._undoStack.pop();
    this._applyToTexture();
    if (this.onChanged) this.onChanged();
  }

  // ─── Clear ─────────────────────────────────────────────────────────────

  clearAll() {
    this._pushUndo();
    this._heightMap.fill(0);
    this._applyToTexture();
    if (this.onChanged) this.onChanged();
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  exportState() {
    // Compress: only store non-zero entries as {index: value} pairs
    const sparse = {};
    for (let i = 0, n = this._heightMap.length; i < n; i++) {
      if (this._heightMap[i] !== 0) {
        sparse[i] = Math.round(this._heightMap[i] * 10000) / 10000;
      }
    }
    return {
      brushSize: this.brushSize,
      brushStrength: this.brushStrength,
      data: sparse,
    };
  }

  loadState(state) {
    if (!state) return;
    if (state.brushSize !== undefined) this.brushSize = state.brushSize;
    if (state.brushStrength !== undefined) this.brushStrength = state.brushStrength;
    if (state.data) {
      this._heightMap.fill(0);
      for (const [idx, val] of Object.entries(state.data)) {
        this._heightMap[parseInt(idx)] = val;
      }
      this._applyToTexture();
    }
  }

  // ─── Dispose ───────────────────────────────────────────────────────────

  dispose() {
    this.disable();
    this._heightMap = null;
    this._undoStack = [];
  }
}

window.WrinklePainter = WrinklePainter;
