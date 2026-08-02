/**
 * TurntableRecorder.js – export a rotating clip of the reconstruction.
 *
 * A still image gives one view of a face. Moving footage gives structure:
 * recognition of an unfamiliar face is measurably better from a rotating view
 * than from a single frame, because the motion reveals depth and profile that
 * a front-on still flattens away. A 3D tool can produce that trivially, which
 * a sketch artist cannot — so it is capability the app already has and was not
 * using.
 *
 * Recorded straight off the WebGL canvas with MediaRecorder, which is built
 * into Chromium. No encoder dependency, nothing to install, works offline.
 *
 * Two consequences of capturing the canvas rather than the window, both
 * wanted: the reference photo overlay is a DOM layer so it never leaks into
 * the clip, and neither does any UI chrome.
 */

class TurntableRecorder {
  static get DEFAULTS() {
    return {
      duration: 6,     // seconds for a full pass
      degrees: 360,    // sweep; 360 loops seamlessly
      fps: 30,
      elevation: 0,    // -30..30 deg, added to the current camera height
    };
  }

  constructor(sceneManager) {
    this.scene = sceneManager;
    this.recording = false;
    this.onProgress = null;   // (fraction 0..1) => void
  }

  /** Chromium always has these, but fail loudly rather than mysteriously. */
  static isSupported() {
    return typeof MediaRecorder !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  _pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  /**
   * Orbit the camera once and record it.
   * Resolves to { blob, mimeType, seconds, fps } — saving is the caller's
   * business.
   */
  async record(options = {}) {
    if (this.recording) throw new Error('Already recording');
    if (!TurntableRecorder.isSupported()) {
      throw new Error('Video capture is not available in this build');
    }

    const opts = { ...TurntableRecorder.DEFAULTS, ...options };
    const canvas = this.scene.canvas || this.scene.renderer.domElement;
    const camera = this.scene.camera;
    const controls = this.scene.controls;

    // Everything that gets put back in the finally block.
    const savedCamera = this.scene.getCameraState ? this.scene.getCameraState() : null;
    const controlsWereEnabled = controls ? controls.enabled : true;

    const mimeType = this._pickMimeType();
    const stream = canvas.captureStream(opts.fps);
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const done = new Promise((resolve, reject) => {
      rec.onstop = () => resolve();
      rec.onerror = (e) => reject(e.error || new Error('Recording failed'));
    });

    this.recording = true;
    // A stray drag mid-take would be baked into the clip.
    if (controls) controls.enabled = false;

    try {
      // Orbit around whatever the camera is currently looking at, keeping its
      // present distance and height, so the clip starts from the view the
      // operator already framed.
      const target = controls ? controls.target.clone() : new THREE.Vector3(0, 0.2, 0);
      const offset = camera.position.clone().sub(target);
      const radius = Math.hypot(offset.x, offset.z);
      const startAngle = Math.atan2(offset.x, offset.z);
      const height = offset.y + (opts.elevation / 30) * radius * 0.35;
      const sweep = opts.degrees * Math.PI / 180;
      const durationMs = Math.max(1, opts.duration) * 1000;

      rec.start();
      const t0 = performance.now();

      await new Promise((resolve) => {
        const step = () => {
          const elapsed = performance.now() - t0;
          const t = Math.min(1, elapsed / durationMs);
          const angle = startAngle + sweep * t;

          camera.position.set(
            target.x + Math.sin(angle) * radius,
            target.y + height,
            target.z + Math.cos(angle) * radius,
          );
          camera.lookAt(target);
          if (this.onProgress) this.onProgress(t);

          if (t >= 1) { resolve(); return; }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });

      // The recorder works off the canvas's own frame callbacks, so give the
      // last drawn frame a moment to reach it before cutting.
      await new Promise(r => setTimeout(r, 120));
      rec.stop();
      await done;

      return {
        blob: new Blob(chunks, { type: mimeType || 'video/webm' }),
        mimeType: mimeType || 'video/webm',
        // Seconds of footage, not the animation tick count. The orbit runs on
        // requestAnimationFrame, which fires far more often than the capture
        // rate, so counting those ticks would report several times the number
        // of frames the clip actually contains.
        seconds: +(opts.duration).toFixed(1),
        fps: opts.fps,
      };
    } finally {
      this.recording = false;
      if (controls) controls.enabled = controlsWereEnabled;
      if (savedCamera && this.scene.loadCameraState) this.scene.loadCameraState(savedCamera);
      for (const track of stream.getTracks()) track.stop();
    }
  }
}

window.TurntableRecorder = TurntableRecorder;
