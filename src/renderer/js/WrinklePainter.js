/** Continuous, tapered skin folds with a trough and soft raised shoulders.
 * Rest-space surface metrics keep brush width consistent across UV islands.
 * A separate 2048 map shares the authored creases' normal/contact shading.
 * Stroke commands preserve undo and case data without huge bitmap snapshots.
 */
class WrinklePainter {
  constructor(sceneManager, skinTextureSystem) {
    this.sceneManager = sceneManager;
    this.camera = sceneManager.camera;
    this.canvas = sceneManager.canvas;
    this.controls = sceneManager.controls;
    this.skinTexture = skinTextureSystem;
    this.enabled = false;
    this.eraseMode = false;
    this.brushSize = 8;
    this.brushStrength = 0.55;
    this.RES = 2048;
    this.texture = null;
    this._foldHeight = null;
    this._commands = [];
    this._undoStack = [];
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();
    this._stroke = null;
    this._frame = null;
    this._previewBounds = null;
    this._pointerId = null;
    this.onChanged = null;
    this.onBeforeStrokeCommit = null;
    this.onSettingsChanged = null;
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onPointerCancel = () => this._finishStroke(false);
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    for (const [event, fn] of this._events()) this.canvas.addEventListener(event, fn, true);
    this.canvas.style.cursor = 'crosshair';
  }

  _events() {
    return [['pointerdown', this._onPointerDown], ['pointermove', this._onPointerMove],
      ['pointerup', this._onPointerUp], ['pointercancel', this._onPointerCancel],
      ['lostpointercapture', this._onPointerCancel]];
  }

  disable() {
    this._finishStroke(true);
    this.enabled = false;
    for (const [event, fn] of this._events()) this.canvas.removeEventListener(event, fn, true);
    this.canvas.style.cursor = '';
  }

  toggle() { if (this.enabled) this.disable(); else this.enable(); return this.enabled; }

  _raycastUV(event) {
    const rect = this.canvas.getBoundingClientRect();
    this._mouse.set((event.clientX - rect.left) / rect.width * 2 - 1,
      1 - (event.clientY - rect.top) / rect.height * 2);
    this._raycaster.setFromCamera(this._mouse, this.camera);
    const meshes = [];
    this.sceneManager.headMesh?.traverse(c => { if (c.isMesh) meshes.push(c); });
    const hit = this._raycaster.intersectObjects(meshes, false)[0];
    if (!hit?.uv || !hit.face) return null;
    const g = hit.object.geometry;
    const rest = g.attributes.aSkinPosition || g.attributes.position;
    const uv = g.attributes.uv;
    const { a, b, c } = hit.face;
    const pa = new THREE.Vector3().fromBufferAttribute(rest, a);
    const ab = new THREE.Vector3().fromBufferAttribute(rest, b).sub(pa);
    const ac = new THREE.Vector3().fromBufferAttribute(rest, c).sub(pa);
    const ub = uv.getX(b) - uv.getX(a), vb = uv.getY(b) - uv.getY(a);
    const uc = uv.getX(c) - uv.getX(a), vc = uv.getY(c) - uv.getY(a);
    const det = ub * vc - uc * vb;
    // A degenerate UV triangle at the head's centre seam is still skin.
    // Skip that sample without breaking the stroke across its neighbours.
    if (Math.abs(det) < 1e-12) return { skip: true };
    const su = ab.clone().multiplyScalar(vc).addScaledVector(ac, -vb).divideScalar(det);
    const sv = ac.clone().multiplyScalar(ub).addScaledVector(ab, -uc).divideScalar(det);
    const position = pa.addScaledVector(su, hit.uv.x - uv.getX(a)).addScaledVector(sv, hit.uv.y - uv.getY(a));
    return { u: hit.uv.x, v: hit.uv.y,
      metric: [su.dot(su), su.dot(sv), sv.dot(sv)], position: position.toArray() };
  }

  _appendHit(hit) {
    if (hit?.skip) return;
    if (!hit) {
      // One exact shared-edge ray can miss both triangles through numerical
      // precision. Bridge that isolated miss; sustained off-face movement
      // still splits the path, as do UV/surface discontinuities below.
      this._misses = (this._misses || 0) + 1;
      if (this._misses > 1 && this._stroke.points.at(-1)) this._stroke.points.push(null);
      return;
    }
    this._misses = 0;
    const p = [hit.u, hit.v, ...hit.metric, ...hit.position];
    const last = this._stroke.points.at(-1);
    if (last) {
      const distance = Math.hypot(p[5] - last[5], p[6] - last[6], p[7] - last[7]);
      if (distance < 0.001) return;
      // Never bridge a UV seam or a jump across the silhouette with a stripe.
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.12 || distance > 0.20) this._stroke.points.push(null);
    }
    this._stroke.points.push(p);
  }

  _handlePointerDown(event) {
    if (!this.enabled || event.button !== 0 || this._stroke) return;
    const hit = this._raycastUV(event);
    if (!hit || hit.skip) return;
    event.preventDefault(); event.stopPropagation();
    this._controlsWereEnabled = this.controls.enabled;
    this.controls.enabled = false;
    this._pointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
    this._stroke = { type: this.eraseMode ? 'erase' : 'fold', size: this.brushSize,
      strength: this.brushStrength, points: [] };
    this._misses = 0;
    this._appendHit(hit);
    this._queuePreview();
  }

  _handlePointerMove(event) {
    if (!this._stroke || event.pointerId !== this._pointerId) return;
    event.preventDefault(); event.stopPropagation();
    this._appendHit(this._raycastUV(event));
    this._queuePreview();
  }

  _handlePointerUp(event) {
    if (!this._stroke || event.pointerId !== this._pointerId) return;
    this._appendHit(this._raycastUV(event));
    this._finishStroke(true);
  }

  _queuePreview() {
    if (this._frame !== null) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      if (this._stroke) this._previewBounds = this._rasterStroke(this._stroke, false);
    });
  }

  _finishStroke(commit) {
    if (!this._stroke) return;
    if (this._frame !== null) cancelAnimationFrame(this._frame);
    this._frame = null;
    const stroke = this._stroke;
    this._stroke = null;
    const pointerId = this._pointerId;
    this._pointerId = null;
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    this.controls.enabled = this._controlsWereEnabled;
    if (commit && (stroke.type === 'erase' || stroke.points.filter(Boolean).length > 1)) {
      this.onBeforeStrokeCommit?.();
      this._pushUndo(); this._commands.push(stroke);
      this._rasterStroke(stroke, true); this.onChanged?.();
    } else if (this._previewBounds) this._encode(this._previewBounds);
    this._previewBounds = null;
  }

  _ensureMap() {
    if (this.texture) return;
    this._foldHeight = new Float32Array(this.RES * this.RES);
    const data = new Uint8Array(this.RES * this.RES * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i + 1] = 128; data[i + 3] = 255;
    }
    this.texture = new THREE.DataTexture(data, this.RES, this.RES);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 8;
    this.texture.needsUpdate = true;
    this._bindTexture();
  }

  _bindTexture() {
    this.sceneManager.headMesh?.traverse(c => {
      if (c.isMesh && window.SkinShader) SkinShader.setWrinkleMap(c.material, this.texture);
    });
  }

  _rasterStroke(stroke, commit, encode = true) {
    const segments = [];
    let length = 0;
    const width = 0.0065 * stroke.size / 8;
    const R = this.RES;
    let x0 = R, y0 = R, x1 = 0, y1 = 0;
    let points = stroke.points;
    const valid = points.filter(Boolean);
    if (stroke.type === 'erase' && valid.length === 1) {
      const b = valid[0].slice(); b[0] += b[0] < .999 ? .000001 : -.000001;
      points = [valid[0], b];
    }
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[i + 1];
      if (!a || !b) continue;
      const du = b[0] - a[0], dv = b[1] - a[1];
      const g00 = (a[2] + b[2]) / 2, g01 = (a[3] + b[3]) / 2, g11 = (a[4] + b[4]) / 2;
      const determinant = g00 * g11 - g01 * g01;
      if (determinant < 1e-8) continue;
      const l2 = du * du * g00 + 2 * du * dv * g01 + dv * dv * g11;
      const len = Math.sqrt(Math.max(0, l2));
      if (len < 1e-7) continue;
      const ru = Math.min(.15, width * 4 * Math.sqrt(g11 / determinant));
      const rv = Math.min(.15, width * 4 * Math.sqrt(g00 / determinant));
      const box = [Math.max(0, Math.floor((Math.min(a[0], b[0]) - ru) * R)),
        Math.max(0, Math.floor((Math.min(a[1], b[1]) - rv) * R)),
        Math.min(R - 1, Math.ceil((Math.max(a[0], b[0]) + ru) * R)),
        Math.min(R - 1, Math.ceil((Math.max(a[1], b[1]) + rv) * R))];
      x0 = Math.min(x0, box[0]); y0 = Math.min(y0, box[1]);
      x1 = Math.max(x1, box[2]); y1 = Math.max(y1, box[3]);
      segments.push({ a, du, dv, g00, g01, g11, l2, len, offset: length, box });
      length += len;
    }
    if (!segments.length) return null;
    this._ensureMap();
    const bounds = [x0, y0, x1, y1], W = x1 - x0 + 1, H = y1 - y0 + 1;
    const nearest = new Float32Array(W * H).fill(Infinity);
    const along = new Float32Array(W * H);
    for (const s of segments) {
      for (let y = s.box[1]; y <= s.box[3]; y++) for (let x = s.box[0]; x <= s.box[2]; x++) {
        const u = (x + .5) / R - s.a[0], v = (y + .5) / R - s.a[1];
        const t = Math.max(0, Math.min(1, (u * (s.g00 * s.du + s.g01 * s.dv) + v * (s.g01 * s.du + s.g11 * s.dv)) / s.l2));
        const dx = u - s.du * t, dy = v - s.dv * t;
        const d2 = Math.max(0, dx * dx * s.g00 + 2 * dx * dy * s.g01 + dy * dy * s.g11);
        const j = (y - y0) * W + x - x0;
        if (d2 < nearest[j]) { nearest[j] = d2; along[j] = s.offset + t * s.len; }
      }
    }
    const patch = new Float32Array(W * H);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const j = (y - y0) * W + x - x0, i = y * R + x;
      let value = this._foldHeight[i];
      if (Number.isFinite(nearest[j])) {
        const w = width * (1 + .07 * Math.sin(along[j] * 31 + .8));
        const trough = Math.exp(-nearest[j] / (2 * w * w));
        if (stroke.type === 'erase') {
          value *= 1 - stroke.strength * Math.exp(-nearest[j] / (8 * w * w));
          if (Math.abs(value) < 0.000002) value = 0;
        } else {
          const taper = Math.pow(Math.max(0, Math.sin(Math.PI * along[j] / length)), .6);
          const shoulder = Math.exp(-nearest[j] / (2 * (w * 2.8) ** 2));
          value += .009 * stroke.strength * taper * (.16 * shoulder - trough);
        }
      }
      patch[j] = Math.max(-.03, Math.min(.01, value));
      if (commit) this._foldHeight[i] = patch[j];
    }
    if (encode) this._encode(bounds, commit ? null : { bounds, width: W, data: patch });
    return bounds;
  }

  _encode(bounds, preview = null) {
    if (!this.texture || !bounds) return;
    const R = this.RES, data = this.texture.image.data;
    const height = (x, y) => {
      x = Math.max(0, Math.min(R - 1, x)); y = Math.max(0, Math.min(R - 1, y));
      if (preview && x >= preview.bounds[0] && x <= preview.bounds[2] && y >= preview.bounds[1] && y <= preview.bounds[3]) {
        return preview.data[(y - preview.bounds[1]) * preview.width + x - preview.bounds[0]];
      }
      return this._foldHeight[y * R + x];
    };
    for (let y = Math.max(0, bounds[1] - 2); y <= Math.min(R - 1, bounds[3] + 2); y++) {
      for (let x = Math.max(0, bounds[0] - 2); x <= Math.min(R - 1, bounds[2] + 2); x++) {
        const i = (y * R + x) * 4;
        const du = -(height(x + 1, y) - height(x - 1, y)) * R / 2;
        const dv = -(height(x, y + 1) - height(x, y - 1)) * R / 2;
        data[i] = Math.max(0, Math.min(255, Math.round(128 + du / 8 * 127)));
        data[i + 1] = Math.max(0, Math.min(255, Math.round(128 + dv / 8 * 127)));
        data[i + 2] = Math.round(Math.max(0, Math.min(1, -height(x, y) / .006)) * 255);
      }
    }
    this.texture.needsUpdate = true;
  }

  // Independent of the macro skin-map resolution and normal-map compositor.
  resize() {}
  getHeightMap() { return null; }
  hasManualWrinkles() { return this._commands.length > 0; }

  _pushUndo() {
    this._undoStack.push(this._commands.slice());
    if (this._undoStack.length > 30) this._undoStack.shift();
  }

  undo() {
    this._finishStroke(false);
    if (!this._undoStack.length) return;
    this._commands = this._undoStack.pop();
    this._rebuild(); this.onChanged?.();
  }

  clearAll() {
    this._finishStroke(false);
    this._pushUndo(); this._commands = [];
    this._rebuild(); this.onChanged?.();
  }

  _rebuild() {
    if (!this.texture && !this._commands.length) return;
    this._ensureMap(); this._foldHeight.fill(0);
    for (const command of this._commands) {
      if (command.type === 'legacy') this._importLegacy(command);
      else this._rasterStroke(command, true, false);
    }
    this._encode([0, 0, this.RES - 1, this.RES - 1]); this._bindTexture();
  }

  _importLegacy(command) {
    const r = command.resolution, R = this.RES;
    const source = new Float32Array(r * r);
    for (const [key, value] of Object.entries(command.data || {})) {
      const i = Number(key);
      if (Number.isInteger(i) && i >= 0 && i < source.length && Number.isFinite(value)) source[i] = value;
    }
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      const sx = x / (R - 1) * (r - 1), sy = y / (R - 1) * (r - 1);
      const ix = Math.floor(sx), iy = Math.floor(sy), tx = sx - ix, ty = sy - iy;
      const x1 = Math.min(r - 1, ix + 1), y1 = Math.min(r - 1, iy + 1);
      const a = source[iy * r + ix] * (1 - tx) + source[iy * r + x1] * tx;
      const b = source[y1 * r + ix] * (1 - tx) + source[y1 * r + x1] * tx;
      this._foldHeight[y * R + x] += ((1 - ty) * a + ty * b) * .02;
    }
  }

  exportState() {
    return { version: 2, resolution: this.RES, brushSize: this.brushSize,
      brushStrength: this.brushStrength, commands: JSON.parse(JSON.stringify(this._commands)) };
  }

  loadState(state) {
    this._finishStroke(false); this._undoStack = [];
    this.eraseMode = false;
    this.brushSize = Math.max(3, Math.min(40, Number(state?.brushSize) || 8));
    this.brushStrength = Math.max(.05, Math.min(1, Number(state?.brushStrength) || .55));
    this._commands = [];
    if (state?.version === 2 && Array.isArray(state.commands)) {
      for (const c of state.commands) {
        if (c.type === 'legacy' && [256, 512, 1024, 2048].includes(c.resolution)) {
          this._commands.push(JSON.parse(JSON.stringify(c)));
        } else if (['fold', 'erase'].includes(c.type) && Array.isArray(c.points)) {
          this._commands.push({ type: c.type, size: Math.max(3, Math.min(40, Number(c.size) || 8)),
            strength: Math.max(.05, Math.min(1, Number(c.strength) || .55)),
            points: c.points.map(p => Array.isArray(p) && p.length === 8 && p.every(Number.isFinite)
              && p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1 ? p.slice() : null) });
        }
      }
    } else if (state?.data && Object.keys(state.data).length) {
      // Older cases omitted resolution. Default to their usual 512 grid;
      // larger indices identify the old High grid. New cases store metadata.
      let max = 0;
      for (const key of Object.keys(state.data)) max = Math.max(max, Number(key) || 0);
      const resolution = [256, 512, 1024, 2048].includes(state.resolution) ? state.resolution
        : max >= 1024 * 1024 ? 2048 : max >= 512 * 512 ? 1024 : 512;
      this._commands.push({ type: 'legacy', resolution, data: { ...state.data } });
    }
    this._rebuild(); this.onSettingsChanged?.();
  }

  dispose() {
    this.disable(); this.texture?.dispose(); this.texture = null;
    this._bindTexture();
    this._foldHeight = null; this._commands = []; this._undoStack = [];
  }
}

window.WrinklePainter = WrinklePainter;
