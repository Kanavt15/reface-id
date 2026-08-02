/**
 * ReferenceOverlay.js – pin a reference photo over the viewport for comparison.
 *
 * Reference images already reach the AI as vision input (AIController), but the
 * investigator never got to see the photo and the reconstruction together. This
 * puts the photo on top of the render so the two can be aligned and judged
 * directly, which is how facial comparison actually gets done.
 *
 * Deliberately a DOM layer rather than a textured plane in the scene:
 *   - It must never take a pointer event. The layer is `pointer-events: none`
 *     at all times, so orbiting, point-edit, mark placement and every other
 *     viewport interaction keep working with the photo visible. Alignment is
 *     driven by sliders instead of dragging, which also avoids fighting
 *     OrbitControls for the mouse.
 *   - It sits at z-index 2 — above the canvas and the vignette, below the
 *     floating toolbar (50), the action buttons and the stats strip — so it
 *     covers the render and nothing else.
 *   - Screenshots come from the WebGL canvas, so the overlay never leaks into a
 *     saved image. That is the right behaviour: the photo is a working aid, not
 *     part of the reconstruction.
 */

class ReferenceOverlay {
  static get BASE_PARAMS() {
    return {
      opacity: 50,   // 0..100 — 50 shows model and photo together by default
      scale: 100,    // 25..300
      posX: 0,       // -100..100, percent of viewport width
      posY: 0,       // -100..100, percent of viewport height
      rotate: 0,     // -180..180 deg
      wipe: 50,      // 0..100 — divider position, only used in wipe mode
    };
  }

  constructor(viewportEl) {
    this.viewport = viewportEl || document.getElementById('viewport');

    this.enabled = false;
    this.mode = 'blend';        // 'blend' | 'wipe'
    this.flipped = false;
    this.imageName = null;
    this.hasImage = false;
    this.params = { ...ReferenceOverlay.BASE_PARAMS };

    this._buildLayer();

    console.log('[ReferenceOverlay] Initialized');
  }

  _buildLayer() {
    if (!this.viewport) {
      console.warn('[ReferenceOverlay] No #viewport element — overlay disabled');
      return;
    }

    const layer = document.createElement('div');
    layer.id = 'rf-ref-layer';
    layer.setAttribute('aria-hidden', 'true');

    const img = document.createElement('img');
    img.id = 'rf-ref-image';
    img.alt = '';
    layer.appendChild(img);

    const divider = document.createElement('div');
    divider.id = 'rf-ref-divider';
    layer.appendChild(divider);

    // Insert directly after the canvas so it layers above the render but
    // before every floating control in the markup.
    this.viewport.appendChild(layer);

    this.layer = layer;
    this.img = img;
    this.divider = divider;
    this._apply();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Load a photo from a data URL. Resets alignment so a new photo starts clean. */
  setImage(dataUrl, name) {
    if (!this.img || !dataUrl) return;
    this.img.src = dataUrl;
    this.imageName = name || 'reference';
    this.hasImage = true;
    this.params = { ...ReferenceOverlay.BASE_PARAMS };
    this.flipped = false;
    this.enabled = true;
    this._apply();
  }

  clear() {
    if (!this.img) return;
    this.img.removeAttribute('src');
    this.imageName = null;
    this.hasImage = false;
    this.enabled = false;
    this._apply();
  }

  setEnabled(on) {
    this.enabled = !!on && this.hasImage;
    this._apply();
  }

  /** Show/hide without losing the loaded photo — the toolbar toggle. */
  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  setMode(mode) {
    this.mode = mode === 'wipe' ? 'wipe' : 'blend';
    this._apply();
  }

  setFlipped(on) {
    this.flipped = !!on;
    this._apply();
  }

  setParam(key, value) {
    if (this.params[key] === undefined) return;
    this.params[key] = value;
    this._apply();
  }

  /** Drop alignment back to a centred, unrotated fit. */
  resetTransform() {
    const base = ReferenceOverlay.BASE_PARAMS;
    this.params.scale = base.scale;
    this.params.posX = base.posX;
    this.params.posY = base.posY;
    this.params.rotate = base.rotate;
    this.flipped = false;
    this._apply();
  }

  getState() {
    return {
      ...this.params,
      enabled: this.enabled,
      mode: this.mode,
      flipped: this.flipped,
      hasImage: this.hasImage,
      imageName: this.imageName,
    };
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  _apply() {
    if (!this.layer) return;
    const p = this.params;
    const visible = this.enabled && this.hasImage;

    this.layer.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    this.layer.style.opacity = String(Math.max(0, Math.min(100, p.opacity)) / 100);

    // Wipe reveals the photo from the left edge to the divider, so the model
    // shows through on the right. Blend just shows the whole photo.
    if (this.mode === 'wipe') {
      const w = Math.max(0, Math.min(100, p.wipe));
      this.layer.style.clipPath = `inset(0 ${100 - w}% 0 0)`;
      this.divider.style.display = 'block';
      this.divider.style.left = `${w}%`;
    } else {
      this.layer.style.clipPath = 'none';
      this.divider.style.display = 'none';
    }

    // Offsets are a percentage of the viewport so alignment survives a resize.
    this.img.style.transform =
      `translate(-50%, -50%) ` +
      `translate(${p.posX}%, ${p.posY}%) ` +
      `rotate(${p.rotate}deg) ` +
      `scale(${(p.scale / 100) * (this.flipped ? -1 : 1)}, ${p.scale / 100})`;
  }

  // ── State / persistence ─────────────────────────────────────────────────

  /**
   * Alignment only — the photo itself is not persisted.
   *
   * A reference still can be several megabytes, and a .rfc is a JSON case file
   * that gets copied around; embedding base64 image data would bloat every
   * save. The photo is reloaded per session.
   */
  exportState() {
    return { ...this.params, mode: this.mode, flipped: this.flipped };
  }

  loadState(state) {
    if (!state) return;
    for (const key of Object.keys(this.params)) {
      if (state[key] !== undefined) this.params[key] = state[key];
    }
    if (state.mode) this.mode = state.mode === 'wipe' ? 'wipe' : 'blend';
    if (state.flipped !== undefined) this.flipped = !!state.flipped;
    this._apply();
  }

  dispose() {
    if (this.layer && this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this.layer = null;
    this.img = null;
  }
}

window.ReferenceOverlay = ReferenceOverlay;
