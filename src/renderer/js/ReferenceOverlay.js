// Shows a reference photo over the 3D view so the reconstruction can be compared with it directly.

class ReferenceOverlay {
  // Default alignment settings for the photo.
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

  // Creates the photo layer inside the viewport; it ignores the mouse so the 3D view keeps working.
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

    // Add it right after the canvas so it sits above the render but below the floating controls.
    this.viewport.appendChild(layer);

    this.layer = layer;
    this.img = img;
    this.divider = divider;
    this._apply();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  // Loads a photo from a data URL and resets its alignment.
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

  // Removes the photo and hides the overlay.
  clear() {
    if (!this.img) return;
    this.img.removeAttribute('src');
    this.imageName = null;
    this.hasImage = false;
    this.enabled = false;
    this._apply();
  }

  // Shows or hides the overlay, but only if a photo is loaded.
  setEnabled(on) {
    this.enabled = !!on && this.hasImage;
    this._apply();
  }

  // Shows or hides the overlay without dropping the loaded photo.
  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  // Switches between blend and wipe modes.
  setMode(mode) {
    this.mode = mode === 'wipe' ? 'wipe' : 'blend';
    this._apply();
  }

  // Mirrors the photo left to right.
  setFlipped(on) {
    this.flipped = !!on;
    this._apply();
  }

  // Sets one alignment value, such as opacity or scale.
  setParam(key, value) {
    if (this.params[key] === undefined) return;
    this.params[key] = value;
    this._apply();
  }

  // Puts the photo back to a centred, unrotated fit.
  resetTransform() {
    const base = ReferenceOverlay.BASE_PARAMS;
    this.params.scale = base.scale;
    this.params.posX = base.posX;
    this.params.posY = base.posY;
    this.params.rotate = base.rotate;
    this.flipped = false;
    this._apply();
  }

  // Returns the overlay's current settings.
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

  // Applies the current settings to the photo layer.
  _apply() {
    if (!this.layer) return;
    const p = this.params;
    const visible = this.enabled && this.hasImage;

    this.layer.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    this.layer.style.opacity = String(Math.max(0, Math.min(100, p.opacity)) / 100);

    // Wipe shows the photo left of the divider and the model on the right; blend shows the whole photo.
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

  // Saves the alignment only; the photo itself isn't stored because it would bloat the case file.
  exportState() {
    return { ...this.params, mode: this.mode, flipped: this.flipped };
  }

  // Restores saved alignment settings.
  loadState(state) {
    if (!state) return;
    for (const key of Object.keys(this.params)) {
      if (state[key] !== undefined) this.params[key] = state[key];
    }
    if (state.mode) this.mode = state.mode === 'wipe' ? 'wipe' : 'blend';
    if (state.flipped !== undefined) this.flipped = !!state.flipped;
    this._apply();
  }

  // Removes the overlay from the page.
  dispose() {
    if (this.layer && this.layer.parentNode) this.layer.parentNode.removeChild(this.layer);
    this.layer = null;
    this.img = null;
  }
}

window.ReferenceOverlay = ReferenceOverlay;
