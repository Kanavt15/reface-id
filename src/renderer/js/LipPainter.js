/**
 * LipPainter.js
 * Manual lip color painting tool — draw lip color onto the 3D face by
 * clicking and dragging with a pen, or remove color with an eraser.
 *
 * Works by raycasting to find the vertex closest to the cursor, then
 * modifying that vertex's lip weight in SceneManager._lipWeights.
 * After each stroke, calls SceneManager._updateVertexColors() to refresh.
 */

class LipPainter {
  constructor(sceneManager) {
    this.sceneManager = sceneManager;
    this.scene = sceneManager.scene;
    this.camera = sceneManager.camera;
    this.canvas = sceneManager.canvas;
    this.controls = sceneManager.controls;

    this.enabled = false;
    this.eraseMode = false;

    // Brush parameters
    this.brushRadius = 0.04;     // world-space radius around hit point
    this.brushStrength = 0.35;   // 0–1 per stroke stamp

    // Raycaster
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    // Painting state
    this._isPainting = false;
    this._lastHit = null;

    // Undo stack (stores sparse weight deltas, max 30)
    this._undoStack = [];
    this._maxUndo = 30;
    this._currentStrokeDeltas = null; // tracks deltas for current stroke

    // Bound handlers
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);

    // Callback when lip paint changes (for case manager persistence)
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
    this._lastHit = null;
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
   * Raycast the face mesh and return the hit info (world point + mesh).
   */
  _raycastHit(event) {
    this._getNDC(event);
    this._raycaster.setFromCamera(this._mouse, this.camera);

    const headMesh = this.sceneManager.headMesh;
    if (!headMesh) return null;

    const meshes = [];
    headMesh.traverse(c => { if (c.isMesh) meshes.push(c); });

    const hits = this._raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    const hit = hits[0];
    return {
      point: hit.point.clone(),
      mesh: hit.object,
      faceIndex: hit.faceIndex,
    };
  }

  // ─── Pointer Events ────────────────────────────────────────────────────

  _handlePointerDown(event) {
    if (event.button !== 0) return;

    const hit = this._raycastHit(event);
    if (!hit) return;

    // Ensure lip weights exist (auto-apply a default color if none set)
    this._ensureLipWeights();

    // Disable orbit controls while painting
    this.controls.enabled = false;
    event.preventDefault();
    event.stopPropagation();

    // Start tracking deltas for undo
    this._currentStrokeDeltas = [];

    this._isPainting = true;
    this._lastHit = hit.point;
    this._paintAtPoint(hit.point, hit.mesh);
  }

  _handlePointerMove(event) {
    if (!this._isPainting) return;
    event.preventDefault();
    event.stopPropagation();

    const hit = this._raycastHit(event);
    if (!hit) return;

    // Interpolate between last hit and current for smooth strokes
    if (this._lastHit) {
      const dx = hit.point.x - this._lastHit.x;
      const dy = hit.point.y - this._lastHit.y;
      const dz = hit.point.z - this._lastHit.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const stepSize = this.brushRadius * 0.3;
      const steps = Math.max(1, Math.ceil(dist / stepSize));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const p = new THREE.Vector3(
          this._lastHit.x + dx * t,
          this._lastHit.y + dy * t,
          this._lastHit.z + dz * t
        );
        this._paintAtPoint(p, hit.mesh);
      }
    } else {
      this._paintAtPoint(hit.point, hit.mesh);
    }

    this._lastHit = hit.point;
  }

  _handlePointerUp(event) {
    if (!this._isPainting) return;
    this._isPainting = false;
    this._lastHit = null;
    this.controls.enabled = true;

    // Save stroke to undo stack
    if (this._currentStrokeDeltas && this._currentStrokeDeltas.length > 0) {
      if (this._undoStack.length >= this._maxUndo) {
        this._undoStack.shift();
      }
      this._undoStack.push(this._currentStrokeDeltas);
    }
    this._currentStrokeDeltas = null;

    if (this.onChanged) this.onChanged();
  }

  // ─── Painting Logic ────────────────────────────────────────────────────

  /**
   * Ensure lip weights are computed in SceneManager.
   * If no lip color is set, we still need weights for manual painting.
   */
  _ensureLipWeights() {
    const sm = this.sceneManager;
    if (!sm._lipWeights) {
      sm._computeLipWeights();
      if (sm._lipPaintOverrides) {
        sm._applyPaintOverrides();
      }
    }
    // Initialize the overrides map if needed
    if (!sm._lipPaintOverrides) {
      sm._lipPaintOverrides = new Map();
    }
  }

  /**
   * Paint (or erase) lip color at a world-space point.
   * Modifies vertex lip weights directly.
   */
  _paintAtPoint(worldPoint, targetMesh) {
    const sm = this.sceneManager;
    if (!sm._lipWeights) return;

    const r = this.brushRadius;
    const r2 = r * r;
    const strength = this.brushStrength;
    const erase = this.eraseMode;

    for (const entry of sm._lipWeights) {
      const mesh = entry.mesh;
      const weights = entry.weights;
      const pos = mesh.geometry.attributes.position;
      const N = pos.count;

      // Convert world point to mesh local space
      const localPoint = worldPoint.clone();
      mesh.worldToLocal(localPoint);

      // Initialize overrides array for this mesh if needed
      if (!sm._lipPaintOverrides.has(mesh)) {
        sm._lipPaintOverrides.set(mesh, new Float32Array(N));
      }
      const overrides = sm._lipPaintOverrides.get(mesh);

      for (let i = 0; i < N; i++) {
        const dx = pos.getX(i) - localPoint.x;
        const dy = pos.getY(i) - localPoint.y;
        const dz = pos.getZ(i) - localPoint.z;
        const d2 = dx * dx + dy * dy + dz * dz;

        if (d2 > r2) continue;

        // Smooth falloff
        const dist = Math.sqrt(d2);
        const falloff = 1.0 - (dist / r);
        const amount = falloff * falloff * strength;

        const oldWeight = weights[i];

        if (erase) {
          weights[i] = Math.max(0, weights[i] - amount);
          overrides[i] -= (oldWeight - weights[i]);
        } else {
          weights[i] = Math.min(1, weights[i] + amount);
          overrides[i] += (weights[i] - oldWeight);
        }

        // Track for undo
        if (this._currentStrokeDeltas) {
          this._currentStrokeDeltas.push({
            entryIdx: sm._lipWeights.indexOf(entry),
            vertIdx: i,
            delta: weights[i] - oldWeight,
          });
        }
      }
    }

    // If no lip color set yet, apply a default so the user sees feedback
    if (!sm._lipColor) {
      sm._lipColor = '#c44569'; // default rose
      const picker = document.getElementById('lipColorPicker');
      if (picker) picker.value = '#c44569';
    }

    sm._updateVertexColors();
  }

  // ─── Undo ──────────────────────────────────────────────────────────────

  undo() {
    if (this._undoStack.length === 0) return;
    const deltas = this._undoStack.pop();
    const sm = this.sceneManager;
    if (!sm._lipWeights) return;

    // Reverse all deltas from this stroke
    for (const d of deltas) {
      const entry = sm._lipWeights[d.entryIdx];
      if (!entry) continue;
      entry.weights[d.vertIdx] = Math.max(0, Math.min(1, entry.weights[d.vertIdx] - d.delta));

      // Also update overrides
      if (sm._lipPaintOverrides) {
        const overrides = sm._lipPaintOverrides.get(entry.mesh);
        if (overrides) {
          overrides[d.vertIdx] -= d.delta;
        }
      }
    }

    sm._updateVertexColors();
    if (this.onChanged) this.onChanged();
  }

  // ─── Clear ─────────────────────────────────────────────────────────────

  clearAll() {
    const sm = this.sceneManager;
    sm._lipPaintOverrides = null;
    sm._lipWeights = null; // force recompute from clean landmarks
    this._undoStack = [];

    if (sm._lipColor) {
      sm._computeLipWeights();
      sm._updateVertexColors();
    }

    if (this.onChanged) this.onChanged();
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  exportState() {
    const sm = this.sceneManager;
    if (!sm._lipPaintOverrides) return null;

    const data = [];
    for (const entry of (sm._lipWeights || [])) {
      const overrides = sm._lipPaintOverrides.get(entry.mesh);
      if (!overrides) { data.push(null); continue; }

      const sparse = {};
      for (let i = 0; i < overrides.length; i++) {
        if (overrides[i] !== 0) {
          sparse[i] = Math.round(overrides[i] * 10000) / 10000;
        }
      }
      data.push(Object.keys(sparse).length > 0 ? sparse : null);
    }

    return {
      brushRadius: this.brushRadius,
      brushStrength: this.brushStrength,
      data,
    };
  }

  loadState(state) {
    if (!state) return;
    const sm = this.sceneManager;

    if (state.brushRadius !== undefined) this.brushRadius = state.brushRadius;
    if (state.brushStrength !== undefined) this.brushStrength = state.brushStrength;

    if (state.data && sm._lipWeights) {
      sm._lipPaintOverrides = new Map();
      for (let idx = 0; idx < state.data.length; idx++) {
        const sparse = state.data[idx];
        if (!sparse || !sm._lipWeights[idx]) continue;

        const entry = sm._lipWeights[idx];
        const overrides = new Float32Array(entry.weights.length);
        for (const [vertIdx, val] of Object.entries(sparse)) {
          const i = parseInt(vertIdx);
          overrides[i] = val;
          entry.weights[i] = Math.max(0, Math.min(1, entry.weights[i] + val));
        }
        sm._lipPaintOverrides.set(entry.mesh, overrides);
      }
      sm._updateVertexColors();
    }
  }

  // ─── Dispose ───────────────────────────────────────────────────────────

  dispose() {
    this.disable();
    this._undoStack = [];
    this._currentStrokeDeltas = null;
  }
}

window.LipPainter = LipPainter;
