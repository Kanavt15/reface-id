/**
 * VariantPicker.js – recognition-driven face building.
 *
 * Asking a witness "how wide was his nose, 1 to 10?" fights how face memory
 * works: people recall features poorly but recognise faces well. This shows a
 * set of candidates and asks which is closest, then generates a new set around
 * that choice, narrowing each round until it converges. It is the same idea as
 * the evolutionary composite systems used in police work.
 *
 * Cost shape matters here and drove the design:
 *   - Opening a session is ONE call that returns every candidate at once.
 *     Asked one at a time the model converges on the same reading of the
 *     description; seeing them together is what makes it differentiate.
 *   - Every round after a pick is generated locally by jittering the chosen
 *     face — zero calls, instant.
 *   - Only "none of these" spends another call, and it sends the rejected sets
 *     back so the replacements are actually different.
 *
 * A normal session is therefore one call regardless of how long the witness
 * iterates.
 */

class VariantPicker {
  /** Jitter width for the first round after a pick, in morph units (0-100). */
  static get START_AMPLITUDE() { return 14; }

  /** Each round narrows by this factor — wide exploration, then refinement. */
  static get AMPLITUDE_DECAY() { return 0.62; }

  /** Below this the candidates stop being tellable apart, so stop offering more. */
  static get MIN_AMPLITUDE() { return 2.5; }

  static get COUNT() { return 6; }

  constructor(sceneManager, morpher, api) {
    this.scene = sceneManager;
    this.morpher = morpher;
    this.api = api;

    this.active = false;
    this.description = '';
    this.referenceImages = [];

    this.variants = [];        // [{ label, morphTargets, thumb }]
    this.round = 0;            // 0 = the AI set, 1+ = jittered rounds
    this.amplitude = VariantPicker.START_AMPLITUDE;
    this.rejected = [];        // morphTarget sets the witness has turned down
    this.selectedIndex = -1;
    this.baseMorphs = null;    // face state to restore if the session is cancelled

    this.onUpdate = null;      // () => void, fired when the set changes

    console.log('[VariantPicker] Initialized');
  }

  get canNarrow() {
    return this.amplitude * VariantPicker.AMPLITUDE_DECAY >= VariantPicker.MIN_AMPLITUDE;
  }

  // ── Session ─────────────────────────────────────────────────────────────

  /**
   * Open a session: one API call for the opening set.
   * `referenceImages` is passed straight through to the vision model.
   */
  async start(description, referenceImages = []) {
    this.description = (description || '').trim();
    this.referenceImages = referenceImages || [];
    this.rejected = [];
    this.round = 0;
    this.amplitude = VariantPicker.START_AMPLITUDE;
    this.selectedIndex = -1;
    this.baseMorphs = { ...this.morpher.morphValues };
    this.active = true;

    return this._requestAiSet();
  }

  /** Witness rejected the whole set — spend one call on a genuinely new one. */
  async rejectAll() {
    for (const v of this.variants) this.rejected.push(v.morphTargets);
    // Cap what gets sent back; the model only needs the gist of what failed.
    if (this.rejected.length > 18) this.rejected = this.rejected.slice(-18);
    this.round = 0;
    this.amplitude = VariantPicker.START_AMPLITUDE;
    this.selectedIndex = -1;
    return this._requestAiSet();
  }

  async _requestAiSet() {
    const res = await this.api.generateVariants({
      prompt: this.description,
      count: VariantPicker.COUNT,
      avoid: this.rejected,
      referenceImages: this.referenceImages,
    });
    if (res?.error) throw new Error(res.error);
    if (!Array.isArray(res?.variants) || !res.variants.length) {
      throw new Error('No candidates were returned');
    }

    this.variants = res.variants.map(v => ({
      label: v.label || 'Variant',
      morphTargets: v.morphTargets || {},
      thumb: null,
    }));
    this._renderThumbnails();
    if (this.onUpdate) this.onUpdate();
    return this.variants;
  }

  /**
   * Witness picked one. Everything from here is local — no API call.
   * Returns false once the set has narrowed as far as it usefully can.
   */
  pick(index) {
    const chosen = this.variants[index];
    if (!chosen) return false;

    this.selectedIndex = index;
    const base = chosen.morphTargets;

    if (!this.canNarrow) {
      // Converged — apply the choice and let the manual editor take over.
      this.apply(index);
      return false;
    }

    this.amplitude *= VariantPicker.AMPLITUDE_DECAY;
    this.round++;

    // Carry the chosen face forward unchanged as the first slot, so the
    // witness can never lose the best face they have found so far by picking
    // it and getting only mutations back.
    const next = [{ label: 'Your pick', morphTargets: { ...base }, thumb: null }];
    for (let i = 1; i < VariantPicker.COUNT; i++) {
      next.push({
        label: `Variation ${i}`,
        morphTargets: this._jitter(base, this.amplitude),
        thumb: null,
      });
    }
    this.variants = next;
    this.selectedIndex = -1;
    this._renderThumbnails();
    if (this.onUpdate) this.onUpdate();
    return true;
  }

  /** Commit a candidate to the live face and end the session. */
  apply(index) {
    const chosen = this.variants[index];
    if (!chosen) return null;
    this._setMorphs(chosen.morphTargets, true);
    this.active = false;
    return chosen;
  }

  /** Abandon the session and put the face back the way it was. */
  cancel() {
    if (this.baseMorphs) this._setMorphs(this.baseMorphs, true);
    this.active = false;
    this.variants = [];
    this.selectedIndex = -1;
  }

  // ── Jitter ──────────────────────────────────────────────────────────────

  /**
   * Perturb every morph by up to ±amplitude.
   *
   * Two uniform samples averaged gives a rough bell shape, so most candidates
   * sit near the chosen face and a few reach further out. That reads better
   * than flat noise, where every candidate feels equally wrong.
   */
  _jitter(base, amplitude) {
    const out = {};
    const params = this.morpher.params || Object.keys(base);
    for (const key of params) {
      const start = base[key] !== undefined ? base[key] : (this.morpher.morphValues[key] ?? 50);
      const noise = ((Math.random() + Math.random()) - 1) * amplitude;
      out[key] = Math.max(0, Math.min(100, Math.round(start + noise)));
    }
    return out;
  }

  // ── Thumbnails ──────────────────────────────────────────────────────────

  /**
   * Render each candidate to a small image by applying it to the real head and
   * capturing the canvas.
   *
   * Synchronous on purpose. applyAllMorphs writes geometry directly and
   * takeScreenshot forces its own render, so the whole set can be captured in
   * one pass with nothing on screen in between. onMorphApplied is detached for
   * the duration — otherwise every candidate would drag the hair, skin marks
   * and accessory systems through a full refit, six times over, for images a
   * couple of hundred pixels wide.
   */
  _renderThumbnails() {
    if (!this.scene?.renderer || !this.morpher) return;

    const saved = { ...this.morpher.morphValues };
    const savedHook = this.morpher.onMorphApplied;
    this.morpher.onMorphApplied = null;

    try {
      for (const v of this.variants) {
        this._setMorphs(v.morphTargets, false);
        v.thumb = this._captureThumb();
      }
    } finally {
      this._setMorphs(saved, false);
      this.morpher.onMorphApplied = savedHook;
      // One refresh at the end so the accessory systems re-fit to the face the
      // viewport is actually left showing.
      if (typeof savedHook === 'function') savedHook();
    }
  }

  _captureThumb() {
    const W = 260, H = 320;
    this.scene.renderer.render(this.scene.scene, this.scene.camera);
    const src = this.scene.canvas || this.scene.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    // Cover-fit the viewport into the thumbnail so faces stay centred and
    // uncropped regardless of the window's aspect ratio.
    const sw = src.width, sh = src.height;
    const scale = Math.max(W / sw, H / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return c.toDataURL('image/png');
  }

  _setMorphs(values, notify) {
    for (const [k, v] of Object.entries(values)) {
      if (this.morpher.morphValues[k] !== undefined) {
        this.morpher.morphValues[k] = Math.max(0, Math.min(100, Math.round(v)));
      }
    }
    const hook = this.morpher.onMorphApplied;
    if (!notify) this.morpher.onMorphApplied = null;
    this.morpher.applyAllMorphs();
    if (!notify) this.morpher.onMorphApplied = hook;
  }

  getState() {
    return {
      active: this.active,
      round: this.round,
      amplitude: +this.amplitude.toFixed(2),
      canNarrow: this.canNarrow,
      count: this.variants.length,
      rejectedCount: this.rejected.length,
      variants: this.variants.map(v => ({ label: v.label, thumb: v.thumb })),
    };
  }
}

window.VariantPicker = VariantPicker;
