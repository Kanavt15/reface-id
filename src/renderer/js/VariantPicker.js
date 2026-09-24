// Builds a face by recognition: shows the witness six candidate faces, then narrows around the one they pick, using only one AI call per session.

class VariantPicker {
  // How far candidates spread in the first round after a pick, in slider units.
  static get START_AMPLITUDE() { return 14; }

  // Each round narrows by this factor.
  static get AMPLITUDE_DECAY() { return 0.62; }

  // Below this the candidates look the same, so stop offering new rounds.
  static get MIN_AMPLITUDE() { return 2.5; }

  // Number of candidates shown per round.
  static get COUNT() { return 6; }

  // Thumbnail width; portrait because heads are taller than wide.
  static get THUMB_W() { return 260; }
  // Thumbnail height.
  static get THUMB_H() { return 320; }

  // Extra space around the head so it fills about four fifths of the thumbnail.
  static get FRAME_MARGIN() { return 1.12; }

  // Share of the head's depth added to the camera distance.
  static get DEPTH_CLEARANCE() { return 0.15; }

  // How far above the crown the frame may stretch for hair.
  static get MAX_HAIR_HEADROOM() { return 0.22; }

  // How far each setting may move from neutral, so every candidate stays a believable real person.
  static get PARAM_BANDS() {
    return {
      // Eye openness moves the eyelids themselves, so it stays fixed.
      eyeOpenness: [50, 50],
      // The other eye settings are allowed a modest range, since the eyeball now follows the socket.
      eyeSize: [38, 62],
      eyeDepth: [40, 60],
      eyeTilt: [42, 58],
      eyeHeight: [40, 60],
      eyeSpacing: [38, 62],
      // The brow ridge gets a tight range so it never hangs over the eyes.
      browHeight: [45, 55],
      browProminence: [42, 58],
      noseWidth: [38, 62],
      noseBridgeWidth: [38, 62],
      noseTipWidth: [38, 62],
      nostrilFlare: [38, 62],
    };
  }

  // Range for any setting not listed above; past this, features start to look melted.
  static get DEFAULT_BAND() { return [30, 70]; }

  // Settings that change together on a real face, and which way each one moves.
  static get FEATURE_GROUPS() {
    return {
      // Overall breadth of the skull and everything carried on it.
      width: {
        faceWidth: 1, headWidth: 1, jawWidth: 1, foreheadWidth: 1,
        templeWidth: 1, cheekboneProminence: 1, chinWidth: 1,
        faceTaper: -1, faceLength: -0.5,
      },
      // Overall length, from crown to chin.
      length: {
        faceLength: 1, headLength: 1, foreheadHeight: 1,
        noseLength: 1, chinHeight: 1, cheekHeight: 0.5,
      },
      // How much flesh sits over the bone.
      fullness: {
        cheekFullness: 1, nasolabialDepth: 1, foreheadBulge: 1,
        jawDefinition: -1, cheekboneProminence: -0.5,
      },
      // The brow-and-eye shelf.
      browSet: {
        browHeight: 1, browProminence: 1, browThickness: 1,
        browArch: 0.5, eyeDepth: -0.5,
      },
      // The nose as one object.
      nose: {
        noseWidth: 1, noseBridgeWidth: 1, noseTipWidth: 1, nostrilFlare: 1,
        noseBridgeHeight: 0.5, noseTipHeight: 0.5,
      },
      // The mouth as one object.
      mouth: {
        mouthWidth: 1, upperLipThickness: 1, lowerLipThickness: 1,
        lipProtrusion: 0.5, mouthHeight: 0.5, cupidBow: 0.5,
      },
      // Ears, which vary together and independently of the face.
      ears: { earSize: 1, earHeight: 1, earlobeSize: 1, earProtrusion: 0.5 },
    };
  }

  // How much of each candidate's change comes from the shared group pull rather than random noise.
  static get GROUP_COHERENCE() { return 0.7; }

  // Scene groups holding things worn on the head, used for framing.
  static get WORN_GROUPS() {
    return new Set([
      'HairSystem', 'BeardSystem', 'EyebrowSystem',
      'GlassesSystem', 'FaceMaskSystem', 'EarringSystem',
      'BandanaSystem', 'EyebrowPiercingSystem',
    ]);
  }

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
    this.shared = null;        // non-morph face data applied across the whole set

    this.onUpdate = null;      // () => void, fired when the set changes
    // Provider and model for the AI call, set from the assist panel.
    this.provider = null;
    this.model = null;

    // Applies the shared hair, colouring and accessories to the live face; supplied by UIController.
    this.applyShared = null;
    // Restores the full face state when the session is cancelled.
    this.onRestore = null;
    // Systems whose models must be loaded before thumbnails are taken.
    this.assetSystems = [];

    console.log('[VariantPicker] Initialized');
  }

  // Tells whether another, narrower round is still useful.
  get canNarrow() {
    return this.amplitude * VariantPicker.AMPLITUDE_DECAY >= VariantPicker.MIN_AMPLITUDE;
  }

  // ── Session ─────────────────────────────────────────────────────────────

  // Starts a session with one AI call for the opening set.
  async start(description, referenceImages = []) {
    this.description = (description || '').trim();
    this.referenceImages = referenceImages || [];
    this.rejected = [];
    this.round = 0;
    this.amplitude = VariantPicker.START_AMPLITUDE;
    this.selectedIndex = -1;
    this.baseMorphs = { ...this.morpher.morphValues };
    this.shared = null;
    this.active = true;

    return this._requestAiSet();
  }

  // The witness rejected the whole set, so ask the AI for a genuinely different one.
  async rejectAll() {
    for (const v of this.variants) this.rejected.push(v.morphTargets);
    // Cap what gets sent back; the model only needs the gist of what failed.
    if (this.rejected.length > 18) this.rejected = this.rejected.slice(-18);
    this.round = 0;
    this.amplitude = VariantPicker.START_AMPLITUDE;
    this.selectedIndex = -1;
    return this._requestAiSet();
  }

  // Asks the AI for a set of candidates, applies the shared look, then renders the thumbnails.
  async _requestAiSet() {
    const res = await this.api.generateVariants({
      prompt: this.description,
      count: VariantPicker.COUNT,
      avoid: this.rejected,
      referenceImages: this.referenceImages,
      // Use the provider chosen in the assist panel, not the backend's default.
      provider: this.provider,
      model: this.model,
    });
    if (res?.error) {
      // Pass needsKey on so the caller can show the key dialog and try again.
      const err = new Error(res.error);
      err.needsKey = !!res.needsKey;
      err.provider = res.provider;
      throw err;
    }
    if (!Array.isArray(res?.variants) || !res.variants.length) {
      throw new Error('No candidates were returned');
    }

    this.variants = res.variants.map(v => ({
      label: v.label || 'Variant',
      morphTargets: this._completeMorphs(v.morphTargets),
      thumb: null,
    }));

    // Apply the shared look before the thumbnails, since hair and colouring matter as much as bone structure.
    if (res.shared && typeof this.applyShared === 'function') {
      this.shared = res.shared;
      this.applyShared(res.shared);
      // Wait for hair and accessories to finish loading, or the thumbnails show a bald head.
      await (window.AssetLoadTracker?.whenAllIdle(this.assetSystems) ?? Promise.resolve());
    }

    this._renderThumbnails();
    if (this.onUpdate) this.onUpdate();
    return this.variants;
  }

  // The witness picked one; builds the next, narrower set locally and returns false once it has converged.
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

    // Keep the chosen face as the first slot so the witness never loses their best match.
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

  // Applies a candidate to the live face and ends the session.
  apply(index) {
    const chosen = this.variants[index];
    if (!chosen) return null;
    this._setMorphs(chosen.morphTargets, true);
    this.active = false;
    return chosen;
  }

  // Cancels the session and puts the face back as it was.
  cancel() {
    if (this.shared && typeof this.onRestore === 'function') {
      // The session changed hair and colouring too, so use the full restore.
      this.onRestore();
    } else if (this.baseMorphs) {
      this._setMorphs(this.baseMorphs, true);
    }
    this.active = false;
    this.variants = [];
    this.shared = null;
    this.selectedIndex = -1;
  }

  // Fills in any settings the AI left out with neutral values, so candidates don't inherit each other's features.
  _completeMorphs(partial) {
    const src = partial || {};
    const out = {};
    const params = this.morpher.params || Object.keys(src);
    for (const key of params) {
      const v = src[key];
      // An omitted parameter means neutral, which every band contains.
      out[key] = typeof v === 'number' ? this._plausible(key, v) : 50;
    }
    return out;
  }

  // Rounds a value and keeps it inside its believable range.
  _plausible(key, value) {
    const [lo, hi] = VariantPicker.PARAM_BANDS[key] || VariantPicker.DEFAULT_BAND;
    return Math.max(lo, Math.min(hi, Math.round(value)));
  }

  // Jitter

  // Makes a variation of a face by moving related features together, plus a little noise, so it still looks like a real person.
  _jitter(base, amplitude) {
    const bell = () => (Math.random() + Math.random()) - 1;

    // One pull per feature group, shared by everything in it.
    const groupPull = {};
    for (const name of Object.keys(VariantPicker.FEATURE_GROUPS)) {
      groupPull[name] = bell() * amplitude;
    }
    const groupOf = VariantPicker._groupIndex();

    const out = {};
    const params = this.morpher.params || Object.keys(base);
    const [dLo, dHi] = VariantPicker.DEFAULT_BAND;

    for (const key of params) {
      const [lo, hi] = VariantPicker.PARAM_BANDS[key] || VariantPicker.DEFAULT_BAND;
      if (lo === hi) { out[key] = lo; continue; }
      const start = base[key] !== undefined ? base[key] : (this.morpher.morphValues[key] ?? 50);

      // Scale the change by how much room the setting has, so tight ranges aren't pinned at their limits.
      const room = (hi - lo) / (dHi - dLo);

      // A setting can belong to several groups, so average its pulls.
      const memberships = groupOf[key];
      let shared = 0;
      // Settings in no group get the full amount, or they would never vary.
      let soloWeight = 1;
      if (memberships && memberships.length) {
        for (const m of memberships) shared += groupPull[m.group] * m.sign;
        shared = (shared / memberships.length) * VariantPicker.GROUP_COHERENCE;
        soloWeight = 1 - VariantPicker.GROUP_COHERENCE;
      }
      const solo = bell() * amplitude * soloWeight;

      out[key] = this._plausible(key, start + (shared + solo) * room);
    }
    return out;
  }

  // Builds a lookup from each setting to the groups it belongs to.
  static _groupIndex() {
    if (!VariantPicker.__groupIndex) {
      const index = {};
      for (const [group, members] of Object.entries(VariantPicker.FEATURE_GROUPS)) {
        for (const [key, sign] of Object.entries(members)) {
          (index[key] || (index[key] = [])).push({ group, sign });
        }
      }
      VariantPicker.__groupIndex = index;
    }
    return VariantPicker.__groupIndex;
  }

  // Thumbnails

  // Renders each candidate to a small image in one synchronous pass on the real head.
  _renderThumbnails() {
    if (!this.scene?.renderer || !this.morpher) return;

    const saved = { ...this.morpher.morphValues };
    const view = this._beginCapture();

    try {
      for (const v of this.variants) {
        this._setMorphs(v.morphTargets, true);
        // Refit hair, eyes and accessories right away, since the normal refit is debounced.
        this._refitWorn();
        this._frameHead();
        v.thumb = this._captureThumb();
      }
    } finally {
      this._setMorphs(saved, true);
      this._refitWorn();
      this._endCapture(view);
    }
  }

  // Refits everything worn on the head to the current face immediately.
  _refitWorn() {
    if (typeof this.scene?.refitWornSystems === 'function') {
      this.scene.refitWornSystems();
    }
  }

  // Temporarily resizes the renderer to the thumbnail's shape so faces aren't cropped, and returns what to restore.
  _beginCapture() {
    const s = this.scene;
    const r = s.renderer;
    const surface = r.domElement || s.canvas;
    if (!surface) return null;   // nothing to resize; capture at whatever it is
    const prev = {
      width: surface.width,
      height: surface.height,
      pixelRatio: r.getPixelRatio ? r.getPixelRatio() : 1,
      aspect: s.camera?.aspect,
      position: s.camera?.position?.clone?.() ?? null,
      target: s.controls?.target?.clone?.() ?? null,
    };

    // Hide the floor and grid, which look like a grey slab in a portrait.
    prev.hidden = [];
    for (const obj of [s.ground, s.grid]) {
      if (obj && obj.visible) { prev.hidden.push(obj); obj.visible = false; }
    }

    // Cap the pixel ratio at 2; small thumbnails don't need more.
    if (r.setPixelRatio) r.setPixelRatio(Math.min(prev.pixelRatio || 1, 2));
    r.setSize(VariantPicker.THUMB_W, VariantPicker.THUMB_H, false);
    if (s.camera) {
      s.camera.aspect = VariantPicker.THUMB_W / VariantPicker.THUMB_H;
      s.camera.updateProjectionMatrix();
    }
    return prev;
  }

  // Puts back the renderer size, camera and hidden objects after capture.
  _endCapture(prev) {
    const s = this.scene;
    const r = s.renderer;
    if (!prev) return;
    for (const obj of prev.hidden || []) obj.visible = true;
    if (r.setPixelRatio) r.setPixelRatio(prev.pixelRatio);
    // domElement dimensions are in device pixels; setSize wants CSS pixels.
    const ratio = prev.pixelRatio || 1;
    r.setSize(prev.width / ratio, prev.height / ratio, false);
    if (s.camera) {
      if (prev.aspect) s.camera.aspect = prev.aspect;
      s.camera.updateProjectionMatrix();
      if (prev.position) s.camera.position.copy(prev.position);
    }
    if (s.controls) {
      if (prev.target) s.controls.target.copy(prev.target);
      s.controls.update();
    }
  }

  // Points the camera at the front of the head, fitted to this candidate's size.
  _frameHead() {
    const s = this.scene;
    if (!s?.camera || !s?.controls) return;

    const box = this._headBounds();
    if (!box || box.isEmpty()) {
      // Nothing to measure, so just face the head straight on.
      const cY = s.modelCenter?.y ?? 0;
      s.camera.position.set(0, cY, 4.5);
      s.controls.target.set(0, cY, 0);
      s.controls.update();
      return;
    }

    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const fov = (s.camera.fov || 50) * Math.PI / 180;
    const aspect = s.camera.aspect || 1;
    const fitHeight = (size.y / 2) / Math.tan(fov / 2);
    const fitWidth = (size.x / 2) / (Math.tan(fov / 2) * aspect);
    // Add back only part of the head's depth, since the nose is the only thing that far forward.
    const dist = Math.max(fitHeight, fitWidth) * VariantPicker.FRAME_MARGIN
               + size.z * VariantPicker.DEPTH_CLEARANCE;

    // Straight on, level with the middle of the head.
    s.camera.position.set(center.x, center.y, center.z + dist);
    s.controls.target.copy(center);
    s.controls.update();
  }

  // Returns the bounds to frame: the head mesh plus a limited amount of room for hair.
  _headBounds() {
    const s = this.scene;
    if (typeof THREE === 'undefined' || !s?.scene || !s.headMesh) return null;

    const head = new THREE.Box3().setFromObject(s.headMesh);
    if (head.isEmpty()) return null;

    const headHeight = head.max.y - head.min.y;
    let top = head.max.y;
    for (const child of s.scene.children || []) {
      if (!VariantPicker.WORN_GROUPS.has(child.name)) continue;
      const b = new THREE.Box3().setFromObject(child);
      if (!b.isEmpty()) top = Math.max(top, b.max.y);
    }

    const box = new THREE.Box3();
    box.copy(head);
    box.max.y = Math.min(top, head.max.y + headHeight * VariantPicker.MAX_HAIR_HEADROOM);
    return box;
  }

  // Captures the current render as a thumbnail image.
  _captureThumb() {
    const W = VariantPicker.THUMB_W, H = VariantPicker.THUMB_H;
    this.scene.renderFrame();
    const src = this.scene.canvas || this.scene.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    // The render already has the thumbnail's shape, so this is a straight downscale.
    c.getContext('2d').drawImage(src, 0, 0, W, H);
    return c.toDataURL('image/png');
  }

  // Writes morph values into the morpher and rebuilds the face.
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

  // Returns the picker's current state for the UI.
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
