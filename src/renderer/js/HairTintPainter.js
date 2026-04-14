/**
 * HairTintPainter.js
 * Brush-based manual tint painting on hair, beard, and eyebrow 3D meshes.
 * Uses vertex colors to apply per-vertex tint overlays on top of the base color.
 * Similar to PigmentationPainter but operates on 3D mesh vertices
 * instead of 2D UV texture pixels.
 *
 * Usage:
 *   1. Select a target (hair / beard / eyebrow)
 *   2. Pick a tint color and adjust brush size/strength
 *   3. Click & drag on the model to paint tint
 *   4. Use eraser mode to remove tint from specific areas
 */

class HairTintPainter {
  constructor(sceneManager, hairSystem) {
    this.sceneManager = sceneManager;
    this.scene = sceneManager.scene;
    this.camera = sceneManager.camera;
    this.canvas = sceneManager.canvas;
    this.controls = sceneManager.controls;
    this.hairSystem = hairSystem;

    this.enabled = false;
    this.eraseMode = false;
    this.target = 'hair'; // 'hair', 'beard', 'eyebrow'

    // Brush parameters
    this.brushRadius = 0.08;   // world-space units
    this.brushStrength = 0.25; // per stamp
    this.brushColor = '#8b2500'; // default tint color (auburn)

    // Per-mesh tint data: Map<meshUUID, { intensities: Float32Array, colors: Uint8Array, vertexCount: int }>
    this._tintData = new Map();

    // Track which materials have been switched to vertex-color mode
    this._vertexColorMaterials = new Set();

    // Raycaster
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // Painting state
    this._isPainting = false;

    // Undo stack (stores snapshots, max 20)
    this._undoStack = [];
    this._maxUndo = 20;

    // Bound handlers
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp   = this._handlePointerUp.bind(this);

    // Callback when tint data changes
    this.onChanged = null;
  }

  // ─── Enable / Disable ──────────────────────────────────────────────────

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.canvas.addEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.addEventListener('pointermove', this._onPointerMove, true);
    this.canvas.addEventListener('pointerup',   this._onPointerUp, true);
    this.canvas.style.cursor = 'crosshair';
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this._isPainting = false;
    this.canvas.removeEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.removeEventListener('pointermove', this._onPointerMove, true);
    this.canvas.removeEventListener('pointerup',   this._onPointerUp, true);
    this.canvas.style.cursor = '';
    this.controls.enabled = true;
  }

  toggle() {
    if (this.enabled) { this.disable(); } else { this.enable(); }
    return this.enabled;
  }

  setTarget(target) {
    this.target = target;
  }

  // ─── Target Meshes ─────────────────────────────────────────────────────

  _getTargetGroup() {
    switch (this.target) {
      case 'hair':    return this.hairSystem.hairGroup;
      case 'beard':   return this.hairSystem._beardGroup;
      case 'eyebrow': return this.hairSystem._eyebrowGroup;
      default: return null;
    }
  }

  _getTargetMeshes() {
    const group = this._getTargetGroup();
    if (!group) return [];
    const meshes = [];
    group.traverse(c => { if (c.isMesh) meshes.push(c); });
    return meshes;
  }

  _getTargetMaterial() {
    switch (this.target) {
      case 'hair':    return this.hairSystem._hairMat;
      case 'beard':   return this.hairSystem._beardMat;
      case 'eyebrow': return this.hairSystem._eyebrowMat;
      default: return null;
    }
  }

  _getEffectiveBaseColor() {
    const hs = this.hairSystem;
    switch (this.target) {
      case 'hair':
        return hs._blendColors(hs.hairColor, hs.hairTintColor, hs.hairTintIntensity);
      case 'beard':
        return hs._blendColors(hs.beardColor, hs.beardTintColor, hs.beardTintIntensity);
      case 'eyebrow':
        return hs._blendColors(hs.eyebrowColor, hs.eyebrowTintColor, hs.eyebrowTintIntensity);
      default:
        return '#2c1b0e';
    }
  }

  // ─── Raycasting ────────────────────────────────────────────────────────

  _getNDC(event) {
    const rect = this.canvas.getBoundingClientRect();
    this._mouse.x =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
    this._mouse.y = -((event.clientY - rect.top)  / rect.height) * 2 + 1;
  }

  _raycastTarget(event) {
    this._getNDC(event);
    this._raycaster.setFromCamera(this._mouse, this.camera);

    const meshes = this._getTargetMeshes();
    if (meshes.length === 0) return null;

    const hits = this._raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    return { point: hits[0].point.clone(), mesh: hits[0].object };
  }

  // ─── Pointer Events ────────────────────────────────────────────────────

  _handlePointerDown(event) {
    if (event.button !== 0) return;

    const hit = this._raycastTarget(event);
    if (!hit) return;

    this.controls.enabled = false;
    event.preventDefault();
    event.stopPropagation();

    this._pushUndo();
    this._isPainting = true;
    this._stampBrush(hit.point);
  }

  _handlePointerMove(event) {
    if (!this._isPainting) return;
    event.preventDefault();
    event.stopPropagation();

    const hit = this._raycastTarget(event);
    if (!hit) return;

    this._stampBrush(hit.point);
  }

  _handlePointerUp(event) {
    if (!this._isPainting) return;
    this._isPainting = false;
    this.controls.enabled = true;
    if (this.onChanged) this.onChanged();
  }

  // ─── Vertex Color Setup ────────────────────────────────────────────────

  _ensureTintData(mesh) {
    if (this._tintData.has(mesh.uuid)) return;

    // Clone geometry so we don't modify the cached model data
    if (!mesh._geometryClonedForTint) {
      mesh.geometry = mesh.geometry.clone();
      mesh._geometryClonedForTint = true;
    }

    const count = mesh.geometry.attributes.position.count;
    const intensities = new Float32Array(count);
    const colors = new Uint8Array(count * 3);

    // Init tint colors to current brush color
    const rgb = this._hexToRgb(this.brushColor);
    for (let i = 0; i < count; i++) {
      colors[i * 3]     = rgb.r;
      colors[i * 3 + 1] = rgb.g;
      colors[i * 3 + 2] = rgb.b;
    }

    this._tintData.set(mesh.uuid, { intensities, colors, vertexCount: count });
  }

  _enableVertexColorsOnMaterial(mat) {
    if (mat._hairTintPainterActive) return;

    // Store original color for restoration
    mat._originalColor = mat.color.clone();
    mat.vertexColors = true;
    mat.color.set(0xffffff); // White — vertex colors now drive appearance
    mat.needsUpdate = true;
    mat._hairTintPainterActive = true;
    this._vertexColorMaterials.add(mat);
  }

  /**
   * Initialize vertex colors for ALL meshes in the current target group.
   * This is called once when painting begins on a target for the first time.
   */
  _initAllVertexColors() {
    const meshes = this._getTargetMeshes();
    const mat = this._getTargetMaterial();
    if (!mat) return;

    const baseHex = this._getEffectiveBaseColor();
    const base = this._hexToRgb(baseHex);

    for (const mesh of meshes) {
      // Clone geometry if needed
      if (!mesh._geometryClonedForTint) {
        mesh.geometry = mesh.geometry.clone();
        mesh._geometryClonedForTint = true;
      }

      const geo = mesh.geometry;
      const count = geo.attributes.position.count;

      // Create vertex color attribute
      let colorAttr = geo.attributes.color;
      if (!colorAttr || colorAttr.count !== count) {
        const arr = new Float32Array(count * 3);
        colorAttr = new THREE.Float32BufferAttribute(arr, 3);
        geo.setAttribute('color', colorAttr);
      }

      // Set vertex colors: tinted where data exists, base otherwise
      const data = this._tintData.get(mesh.uuid);
      for (let i = 0; i < count; i++) {
        if (data && data.intensities[i] > 0.001) {
          const t = data.intensities[i];
          const ci = i * 3;
          const tr = data.colors[ci]     / 255;
          const tg = data.colors[ci + 1] / 255;
          const tb = data.colors[ci + 2] / 255;
          colorAttr.setXYZ(i,
            (base.r / 255) * (1 - t) + tr * t,
            (base.g / 255) * (1 - t) + tg * t,
            (base.b / 255) * (1 - t) + tb * t
          );
        } else {
          colorAttr.setXYZ(i, base.r / 255, base.g / 255, base.b / 255);
        }
      }
      colorAttr.needsUpdate = true;
    }

    this._enableVertexColorsOnMaterial(mat);
  }

  // ─── Brush Stamping ────────────────────────────────────────────────────

  _stampBrush(worldPoint) {
    const meshes = this._getTargetMeshes();
    const r      = this.brushRadius;
    const str    = this.brushStrength;
    const erase  = this.eraseMode;
    const rgb    = this._hexToRgb(this.brushColor);
    const baseHex = this._getEffectiveBaseColor();
    const base   = this._hexToRgb(baseHex);

    // Ensure vertex colors are active for all meshes in the group
    const mat = this._getTargetMaterial();
    if (mat && !mat._hairTintPainterActive) {
      this._initAllVertexColors();
    }

    for (const mesh of meshes) {
      this._ensureTintData(mesh);
      const data = this._tintData.get(mesh.uuid);
      const geo  = mesh.geometry;
      const posAttr   = geo.attributes.position;
      const colorAttr = geo.attributes.color;
      const count     = posAttr.count;

      // Transform world point to mesh local space
      mesh.updateWorldMatrix(true, false);
      const invMatrix = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      const localPoint = worldPoint.clone().applyMatrix4(invMatrix);

      // Compute local-space brush radius (scale-aware)
      const worldScale = mesh.getWorldScale(new THREE.Vector3());
      const avgScale   = (worldScale.x + worldScale.y + worldScale.z) / 3;
      const localRadius = r / Math.max(avgScale, 0.001);

      let changed = false;
      for (let i = 0; i < count; i++) {
        const vx = posAttr.getX(i);
        const vy = posAttr.getY(i);
        const vz = posAttr.getZ(i);

        const dx = vx - localPoint.x;
        const dy = vy - localPoint.y;
        const dz = vz - localPoint.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist > localRadius) continue;

        const falloff = 1.0 - (dist / localRadius);
        const weight  = falloff * falloff * str;

        if (erase) {
          data.intensities[i] *= (1.0 - weight);
        } else {
          const oldInt = data.intensities[i];
          const newInt = Math.min(1.0, oldInt + weight);
          data.intensities[i] = newInt;

          // Blend per-vertex tint color toward brush color
          if (newInt > 0) {
            const t  = (newInt > 0.001) ? weight / newInt : 1.0;
            const ci = i * 3;
            data.colors[ci]     = Math.round(data.colors[ci]     * (1 - t) + rgb.r * t);
            data.colors[ci + 1] = Math.round(data.colors[ci + 1] * (1 - t) + rgb.g * t);
            data.colors[ci + 2] = Math.round(data.colors[ci + 2] * (1 - t) + rgb.b * t);
          }
        }

        // Update the vertex color immediately
        const tInt = data.intensities[i];
        const ci   = i * 3;
        if (tInt > 0.001) {
          const tr = data.colors[ci]     / 255;
          const tg = data.colors[ci + 1] / 255;
          const tb = data.colors[ci + 2] / 255;
          colorAttr.setXYZ(i,
            (base.r / 255) * (1 - tInt) + tr * tInt,
            (base.g / 255) * (1 - tInt) + tg * tInt,
            (base.b / 255) * (1 - tInt) + tb * tInt
          );
        } else {
          colorAttr.setXYZ(i, base.r / 255, base.g / 255, base.b / 255);
        }

        changed = true;
      }

      if (changed && colorAttr) {
        colorAttr.needsUpdate = true;
      }
    }
  }

  // ─── Refresh vertex colors (called when base color changes) ────────────

  /**
   * Refresh vertex colors for a specific target (or all).
   * Call this when base color, global tint, or style changes.
   */
  refreshVertexColors(target) {
    if (target) {
      const saved = this.target;
      this.target = target;
      this._refreshCurrentTargetColors();
      this.target = saved;
    } else {
      this._refreshCurrentTargetColors();
    }
  }

  refreshAllVertexColors() {
    for (const t of ['hair', 'beard', 'eyebrow']) {
      if (this._hasAnyTintData(t)) {
        this.refreshVertexColors(t);
      }
    }
  }

  _hasAnyTintData(target) {
    const saved = this.target;
    this.target = target;
    const meshes = this._getTargetMeshes();
    this.target = saved;
    for (const mesh of meshes) {
      if (this._tintData.has(mesh.uuid)) return true;
    }
    return false;
  }

  _refreshCurrentTargetColors() {
    const meshes = this._getTargetMeshes();
    const baseHex = this._getEffectiveBaseColor();
    const base = this._hexToRgb(baseHex);

    for (const mesh of meshes) {
      const data = this._tintData.get(mesh.uuid);
      const colorAttr = mesh.geometry?.attributes?.color;
      if (!colorAttr) continue;

      const count = colorAttr.count;
      for (let i = 0; i < count; i++) {
        if (data && data.intensities[i] > 0.001) {
          const t  = data.intensities[i];
          const ci = i * 3;
          const tr = data.colors[ci]     / 255;
          const tg = data.colors[ci + 1] / 255;
          const tb = data.colors[ci + 2] / 255;
          colorAttr.setXYZ(i,
            (base.r / 255) * (1 - t) + tr * t,
            (base.g / 255) * (1 - t) + tg * t,
            (base.b / 255) * (1 - t) + tb * t
          );
        } else {
          colorAttr.setXYZ(i, base.r / 255, base.g / 255, base.b / 255);
        }
      }
      colorAttr.needsUpdate = true;
    }
  }

  // ─── Model change handler ──────────────────────────────────────────────

  /**
   * Call when a model is regenerated (style change). Cleans up stale tint data
   * and restores the material to non-vertex-color mode.
   */
  onModelChanged(target) {
    const mat = (() => {
      switch (target) {
        case 'hair':    return this.hairSystem._hairMat;
        case 'beard':   return this.hairSystem._beardMat;
        case 'eyebrow': return this.hairSystem._eyebrowMat;
        default: return null;
      }
    })();

    // Remove stale tint data entries (old mesh UUIDs)
    const saved = this.target;
    this.target = target;
    const currentUuids = new Set(this._getTargetMeshes().map(m => m.uuid));
    this.target = saved;

    for (const uuid of [...this._tintData.keys()]) {
      if (!currentUuids.has(uuid)) {
        this._tintData.delete(uuid);
      }
    }

    // Reset material from vertex-color mode if it was active
    if (mat && mat._hairTintPainterActive) {
      if (mat._originalColor) {
        mat.color.copy(mat._originalColor);
        delete mat._originalColor;
      }
      mat.vertexColors = false;
      mat.needsUpdate = true;
      delete mat._hairTintPainterActive;
      this._vertexColorMaterials.delete(mat);
    }
  }

  // ─── Undo ──────────────────────────────────────────────────────────────

  _pushUndo() {
    if (this._undoStack.length >= this._maxUndo) this._undoStack.shift();

    // Snapshot all tint data
    const snapshot = new Map();
    for (const [uuid, data] of this._tintData) {
      snapshot.set(uuid, {
        intensities: new Float32Array(data.intensities),
        colors:      new Uint8Array(data.colors),
        vertexCount: data.vertexCount,
      });
    }
    this._undoStack.push({ target: this.target, data: snapshot });
  }

  undo() {
    if (this._undoStack.length === 0) return;
    const snapshot = this._undoStack.pop();

    // Restore tint data from snapshot
    for (const [uuid, data] of snapshot.data) {
      if (this._tintData.has(uuid)) {
        const current = this._tintData.get(uuid);
        current.intensities.set(data.intensities);
        current.colors.set(data.colors);
      }
    }

    // Refresh vertex colors for the snapshot's target
    const saved = this.target;
    this.target = snapshot.target;
    this._refreshCurrentTargetColors();
    this.target = saved;

    if (this.onChanged) this.onChanged();
  }

  // ─── Clear ─────────────────────────────────────────────────────────────

  clearAll() {
    this._pushUndo();
    this._tintData.clear();

    // Reset all vertex-color materials back to normal
    for (const mat of this._vertexColorMaterials) {
      if (mat._originalColor) {
        mat.color.copy(mat._originalColor);
        delete mat._originalColor;
      }
      mat.vertexColors = false;
      mat.needsUpdate = true;
      delete mat._hairTintPainterActive;
    }
    this._vertexColorMaterials.clear();

    // Remove vertex color attributes from meshes
    for (const t of ['hair', 'beard', 'eyebrow']) {
      const saved = this.target;
      this.target = t;
      for (const mesh of this._getTargetMeshes()) {
        if (mesh.geometry.attributes.color) {
          mesh.geometry.deleteAttribute('color');
        }
      }
      this.target = saved;
    }

    if (this.onChanged) this.onChanged();
  }

  clearTarget(target) {
    this._pushUndo();

    const saved = this.target;
    this.target = target || this.target;
    const meshes = this._getTargetMeshes();
    const mat = this._getTargetMaterial();

    for (const mesh of meshes) {
      this._tintData.delete(mesh.uuid);
      if (mesh.geometry.attributes.color) {
        mesh.geometry.deleteAttribute('color');
      }
    }

    if (mat && mat._hairTintPainterActive) {
      if (mat._originalColor) {
        mat.color.copy(mat._originalColor);
        delete mat._originalColor;
      }
      mat.vertexColors = false;
      mat.needsUpdate = true;
      delete mat._hairTintPainterActive;
      this._vertexColorMaterials.delete(mat);
    }

    this.target = saved;
    if (this.onChanged) this.onChanged();
  }

  hasTintData() {
    for (const [, data] of this._tintData) {
      for (let i = 0; i < data.intensities.length; i++) {
        if (data.intensities[i] > 0.001) return true;
      }
    }
    return false;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  _hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16),
    } : { r: 139, g: 37, b: 0 }; // fallback to auburn
  }

  // ─── Dispose ───────────────────────────────────────────────────────────

  dispose() {
    this.disable();
    this._tintData.clear();
    this._undoStack = [];
    this._vertexColorMaterials.clear();
  }
}

window.HairTintPainter = HairTintPainter;
