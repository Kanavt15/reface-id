/**
 * VariantPicker.js – recognition-driven face building.
 *
 * Asking a witness "how wide was his nose, 1 to 10?" fights how face memory
 * works: people recall features poorly but recognise faces well. This shows a
 * set of candidates and asks which is closest, then generates a new set around
 * that choice, narrowing each round until it converges. It is the same idea as
 * the evolutionary composite systems used in police work.
 *
 * A candidate is a whole face, not just a skull: the opening call also returns
 * one `shared` block of hair, colouring, beard and worn items, built to the
 * same standard as the single-face AI builder and applied across the whole set.
 * Candidates are readings of one person, so that part is identical between them
 * either way — sending it once costs nothing and is what makes a candidate
 * resemble the person at all, since a witness judges colouring and hair long
 * before bone structure.
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

  /** Thumbnail size. Portrait, because heads are taller than they are wide. */
  static get THUMB_W() { return 260; }
  static get THUMB_H() { return 320; }

  /**
   * Breathing room around the head, as a multiple of the exact fitting
   * distance. Tuned with DEPTH_CLEARANCE to leave the head filling roughly
   * four fifths of the frame: enough air that nothing touches an edge, little
   * enough that the face is the picture rather than a stamp in the middle of
   * one.
   */
  static get FRAME_MARGIN() { return 1.12; }

  /** Fraction of head depth added to the camera distance. See _frameHead. */
  static get DEPTH_CLEARANCE() { return 0.15; }

  /**
   * How far above the crown the frame will stretch for hair, as a fraction of
   * head height. Enough for a tall style; not enough for a bad bounding box to
   * strand the face at the bottom of the picture.
   */
  static get MAX_HAIR_HEADROOM() { return 0.22; }

  /**
   * How far each parameter may stray from neutral.
   *
   * The default band exists because a witness is matching a memory of a real
   * person: a candidate only earns its slot if it could walk past you in the
   * street, and the ends of these sliders are caricature. A caricature matches
   * nobody, so it wastes one of six chances at recognition.
   *
   * The narrower bands are where two separate meshes have to agree with each
   * other, rather than one piece of geometry deforming on its own:
   *
   *  - eyeOpenness moves the eyelids directly, so below 50 the eyes simply
   *    close. No amount of tracking helps a shut eye, so it stays pinned.
   *  - the other eye parameters move the socket, and the eyeball is a separate
   *    mesh that follows it (EyeSystem._measureEyeOpening). It follows a
   *    moderate change convincingly and a large one less so, hence a band
   *    rather than free rein.
   *  - the brow ridge sits directly over the eye opening; pushed down or
   *    forward it overhangs and shadows the iris.
   *  - the nose widths mirror the high-sensitivity warning in the backend
   *    prompt: a small change there swings the whole face.
   */
  static get PARAM_BANDS() {
    return {
      // eyeOpenness still moves the lids themselves — shut eyes are shut eyes,
      // however well the eyeball tracks them — so it stays pinned.
      eyeOpenness: [50, 50],
      // The rest are open again now that EyeSystem measures the eye opening
      // rather than its centre vertex, so the eyeball follows the socket's
      // position, size and tilt. Kept modest rather than wide: this is still
      // two meshes agreeing with each other, not one piece of geometry.
      eyeSize: [38, 62],
      eyeDepth: [40, 60],
      eyeTilt: [42, 58],
      eyeHeight: [40, 60],
      eyeSpacing: [38, 62],
      // The brow ridge sits directly over the eye opening. Pushed down or
      // forward it overhangs the eye, shadowing the iris into the same "asleep"
      // look the eye morphs cause — so it gets a tight band too, and browHeight
      // (which moves the ridge vertically, straight onto the lid) the tightest.
      browHeight: [45, 55],
      browProminence: [42, 58],
      noseWidth: [38, 62],
      noseBridgeWidth: [38, 62],
      noseTipWidth: [38, 62],
      nostrilFlare: [38, 62],
    };
  }

  /**
   * Band for anything not named above.
   *
   * Kept well inside the slider's nominal range. These morphs displace vertices
   * along a falloff from a landmark, and past a moderate push the surface stops
   * reading as bone and starts reading as melted — smoothed-over brows, a
   * swollen jaw. That is the difference between a set that looks like six
   * people and one that looks broken.
   */
  static get DEFAULT_BAND() { return [30, 70]; }

  /**
   * Parameters that move together on a real face, and the direction each takes.
   *
   * A skull is not fifty independent measurements. Widen it and the jaw and
   * cheekbones widen with it; lengthen the face and the nose and chin follow.
   * Each group draws one shared pull per candidate so those relationships
   * survive, which is what keeps a jittered face looking like a person rather
   * than a mesh with the sliders shaken.
   *
   * A sign of -1 means the parameter moves the opposite way to the group: a
   * face that grows longer grows relatively narrower, and a face that tapers
   * hard to the chin reads as narrower at the jaw.
   */
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

  /**
   * Share of a candidate's variation that comes from its group pull rather than
   * per-parameter noise. All group and the six faces differ only in a handful
   * of directions; all noise and the relationships break. This leans towards
   * coherence, because an incoherent face is not merely a worse match — it is
   * unrecognisable, and costs the witness one of six chances.
   */
  static get GROUP_COHERENCE() { return 0.7; }

  /** Top-level scene groups holding things worn on the head, for framing. */
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
    // (shared) => void — applies hair/colouring/accessories to the live face.
    // Injected rather than built in: the picker holds only the morpher and the
    // renderer, and the builder's apply path already handles every block.
    this.applyShared = null;
    // () => void — full-state restore for cancel(). Needed once a session
    // touches more than morphs, which baseMorphs alone cannot put back.
    this.onRestore = null;
    // Systems whose meshes must be on the head before thumbnails are captured.
    // Injected alongside applyShared; anything without whenIdle() is ignored.
    this.assetSystems = [];

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
    this.shared = null;
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
      morphTargets: this._completeMorphs(v.morphTargets),
      thumb: null,
    }));

    // Before the thumbnails, not after — the candidates are judged on those
    // images, and a face wearing the wrong skin tone and hair reads as wrong no
    // matter how good its structure is. Applied once for the whole set, since
    // every candidate is the same person.
    if (res.shared && typeof this.applyShared === 'function') {
      this.shared = res.shared;
      this.applyShared(res.shared);
      // Hair and the worn items load their meshes asynchronously and only cache
      // them afterwards, so on a cold cache they are not on the head yet — and
      // the capture below is one synchronous pass. Without this wait every
      // thumbnail in the opening set photographs a bald, bare head.
      await (window.AssetLoadTracker?.whenAllIdle(this.assetSystems) ?? Promise.resolve());
    }

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
    if (this.shared && typeof this.onRestore === 'function') {
      // The session changed hair and colouring too, so rewinding the morphs
      // would leave the AI's version of everything else on the face. Hand back
      // to the full restore instead.
      this.onRestore();
    } else if (this.baseMorphs) {
      this._setMorphs(this.baseMorphs, true);
    }
    this.active = false;
    this.variants = [];
    this.shared = null;
    this.selectedIndex = -1;
  }

  /**
   * Expand a candidate's morphs into a complete set.
   *
   * The model is told to omit anything that should sit at the neutral 50, but
   * _setMorphs only writes the keys it is given — so an omitted parameter would
   * silently keep the previous candidate's value, and the six faces would
   * accumulate each other's features instead of being independent readings.
   */
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

  /**
   * Round a value and hold it inside the believable range for its parameter.
   *
   * The prompt asks for this too, but a prompt is a request and this is a
   * guarantee — and it covers the jittered rounds, which no prompt reaches.
   */
  _plausible(key, value) {
    const [lo, hi] = VariantPicker.PARAM_BANDS[key] || VariantPicker.DEFAULT_BAND;
    return Math.max(lo, Math.min(hi, Math.round(value)));
  }

  // ── Jitter ──────────────────────────────────────────────────────────────

  /**
   * Build a variation of `base` by moving groups of related features together.
   *
   * Faces do not vary one slider at a time. A broad skull comes with a broad
   * jaw and wide cheekbones; a long face carries a longer nose and chin. So
   * each candidate first draws one shared pull per FEATURE_GROUPS entry, which
   * every parameter in that group follows, and only then a smaller amount of
   * per-parameter noise for detail.
   *
   * Jittering all fifty parameters independently — which is what this used to
   * do — breaks every one of those relationships at once. The result is a face
   * whose parts contradict each other: it stops looking like a person and
   * starts looking like a mesh with the sliders shaken, and it gets worse every
   * round because the errors accumulate around the previous pick.
   *
   * Two uniform samples averaged gives a rough bell shape, so most candidates
   * sit near the chosen face and a few reach further out. That reads better
   * than flat noise, where every candidate feels equally wrong.
   */
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

      // Scale the kick by the room this parameter has. Jittering a tightly
      // banded parameter at full amplitude would just pile candidates against
      // its limits, turning variation into a row of identical clamps.
      const room = (hi - lo) / (dHi - dLo);

      // A parameter can belong to more than one group — a cheekbone is part of
      // how wide the skull is AND how much flesh sits on it — so take every
      // membership and average them, keeping the pull comparable to a
      // single-group parameter's.
      const memberships = groupOf[key];
      let shared = 0;
      // Only split the amplitude when there is actually a group to share with.
      // A parameter that belongs to no group — eye spacing, philtrum width —
      // has nothing to correlate against, so giving it the leftover 30% would
      // quietly freeze it and every candidate's eyes would look the same.
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

  /**
   * key -> [{ group, sign }, ...], built once from FEATURE_GROUPS.
   * A list, not a single entry: several parameters sit in more than one group.
   */
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

  // ── Thumbnails ──────────────────────────────────────────────────────────

  /**
   * Render each candidate to a small image by applying it to the real head and
   * capturing the canvas.
   *
   * Synchronous on purpose: applyAllMorphs writes geometry directly and the
   * render below is forced, so the whole set is captured in one pass with
   * nothing on screen in between. Because it never yields, the scene's own
   * animation loop cannot interleave and see the borrowed camera or viewport.
   */
  _renderThumbnails() {
    if (!this.scene?.renderer || !this.morpher) return;

    const saved = { ...this.morpher.morphValues };
    const view = this._beginCapture();

    try {
      for (const v of this.variants) {
        this._setMorphs(v.morphTargets, true);
        // Re-fit synchronously rather than trusting onMorphApplied, which is
        // debounced: in a burst like this each candidate cancels the previous
        // candidate's pending re-fit, so every thumbnail would be captured with
        // the hair, brows, beard and eyes still fitted to the face before the
        // session — floating hair, a detached moustache, eyes in the wrong
        // sockets. Frame only after, so the bounds see the re-fitted hair.
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

  /**
   * Re-fit hair, brows, beard, eyes and accessories to the current skull, now,
   * bypassing the debounce on the interactive path.
   */
  _refitWorn() {
    if (typeof this.scene?.refitWornSystems === 'function') {
      this.scene.refitWornSystems();
    }
  }

  /**
   * Borrow the viewport for portrait capture, returning what to hand back.
   *
   * The renderer is resized to the thumbnail's own aspect ratio. Rendering at
   * the window's wide aspect and cropping to portrait afterwards throws away
   * more than half the width, which zooms every face in past the hairline and
   * chin — a head shot cropped to a nose.
   */
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

    // The studio floor and grid are orientation aids for someone turning a head
    // in the viewport. In a portrait they are a grey slab across the jaw, and
    // they are the first thing that makes a set of six look like a screenshot
    // of a tool rather than a set of faces.
    prev.hidden = [];
    for (const obj of [s.ground, s.grid]) {
      if (obj && obj.visible) { prev.hidden.push(obj); obj.visible = false; }
    }

    // Cap the ratio: past 2x this is spending fill rate on detail no 260px
    // thumbnail can show.
    if (r.setPixelRatio) r.setPixelRatio(Math.min(prev.pixelRatio || 1, 2));
    r.setSize(VariantPicker.THUMB_W, VariantPicker.THUMB_H, false);
    if (s.camera) {
      s.camera.aspect = VariantPicker.THUMB_W / VariantPicker.THUMB_H;
      s.camera.updateProjectionMatrix();
    }
    return prev;
  }

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

  /**
   * Frame the camera on the head from the front, fitted to its live bounds.
   *
   * Measured per candidate rather than set to one fixed distance: the whole
   * point of the set is that these skulls differ in width and length, and a
   * distance that frames a narrow face crops a broad one. Hair is included in
   * the bounds so a tall style is not cut off at the crown.
   */
  _frameHead() {
    const s = this.scene;
    if (!s?.camera || !s?.controls) return;

    const box = this._headBounds();
    if (!box || box.isEmpty()) {
      // Nothing measurable to fit — still face the head straight on, using the
      // scene's own front framing. Getting the angle right matters more than
      // getting the distance perfect.
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
    // Only a fraction of the depth is added back. Backing off by the full half
    // depth would guarantee nothing clips even if the widest part of the head
    // sat right at the front — but on a head it does not: the front-most point
    // is the nose, dead centre, while the ears, crown and chin that define the
    // silhouette sit at mid depth. Paying the full clearance for that just
    // pushes the face away and leaves the frame half empty.
    const dist = Math.max(fitHeight, fitWidth) * VariantPicker.FRAME_MARGIN
               + size.z * VariantPicker.DEPTH_CLEARANCE;

    // Straight on, level with the middle of the head.
    s.camera.position.set(center.x, center.y, center.z + dist);
    s.controls.target.copy(center);
    s.controls.update();
  }

  /**
   * Bounds to frame on: the head itself, plus headroom for hair.
   *
   * Anchored on the head mesh rather than the union of every worn group. A
   * group's box is only as tight as its meshes — a hair model with stray
   * geometry, or a container sitting away from the head, inflates the union and
   * pushes the face down the frame, which is what leaves a band of empty space
   * above the crown and drops the chin off the bottom edge. Worn items are read
   * as a hint for the top of frame only, capped to a believable amount of hair,
   * and never allowed to move the chin, the sides, or the depth.
   */
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

  _captureThumb() {
    const W = VariantPicker.THUMB_W, H = VariantPicker.THUMB_H;
    this.scene.renderFrame();
    const src = this.scene.canvas || this.scene.renderer.domElement;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    // The viewport was rendered at this exact aspect ratio, so this is a
    // straight downscale — nothing is cropped off the edges.
    c.getContext('2d').drawImage(src, 0, 0, W, H);
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
