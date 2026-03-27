/**
 * FaceCaptureSystem.js
 * Guided multi-angle face capture using MediaPipe Face Mesh.
 * Automatically detects face orientation (front, left profile, right profile)
 * and walks the user through capturing all 3 views. The captured images are
 * then sent to the AI backend for agentic face reconstruction.
 */

class FaceCaptureSystem {
  constructor(aiController) {
    this.ai = aiController;
    this.stream = null;
    this.faceMesh = null;
    this.videoEl = null;
    this.canvasEl = null;
    this.canvasCtx = null;
    this.running = false;

    // Capture steps — order the user goes through
    this.steps = [
      { id: 'front',  label: 'Front Face',        instruction: 'Look straight at the camera',       yawRange: [-0.25, 0.25] },
      { id: 'left',   label: 'Left Side',          instruction: 'Turn your head to show your LEFT side',  yawRange: [-Infinity, -0.45] },
      { id: 'right',  label: 'Right Side',         instruction: 'Turn your head to show your RIGHT side', yawRange: [0.45, Infinity] },
    ];

    this.currentStep = 0;
    this.captures = [];        // { id, dataUrl }
    this.holdFrames = 0;       // consecutive frames in correct orientation
    this.HOLD_REQUIRED = 18;   // ~0.6 s at 30 fps

    // DOM
    this.overlay = null;
  }

  // ── Public API ─────────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;
    this.currentStep = 0;
    this.captures = [];
    this.holdFrames = 0;

    this._buildOverlay();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });

      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();

      // Reuse FaceMesh from CDN (already loaded for HeadTracker)
      this.faceMesh = new FaceMesh({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });
      this.faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      this.faceMesh.onResults((r) => this._onResults(r));

      this._updateUI();
      this._detectLoop();
    } catch (err) {
      console.error('[FaceCapture] Camera error:', err);
      this.cancel();
    }
  }

  cancel() {
    this._cleanup();
  }

  // ── Detection loop ─────────────────────────────────────────

  _detectLoop() {
    if (!this.running) return;
    if (this.videoEl.readyState >= 2) {
      this.faceMesh.send({ image: this.videoEl }).then(() => {
        if (this.running) requestAnimationFrame(() => this._detectLoop());
      });
    } else {
      requestAnimationFrame(() => this._detectLoop());
    }
  }

  _onResults(results) {
    if (!this.running) return;

    // Draw mirrored camera feed
    const w = this.canvasEl.width;
    const h = this.canvasEl.height;
    this.canvasCtx.save();
    this.canvasCtx.clearRect(0, 0, w, h);
    this.canvasCtx.translate(w, 0);
    this.canvasCtx.scale(-1, 1);
    if (this.videoEl.readyState >= 2) {
      this.canvasCtx.drawImage(this.videoEl, 0, 0, w, h);
    }
    this.canvasCtx.restore();

    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      this._setStatus('No face detected — make sure your face is visible', false);
      this.holdFrames = 0;
      this._updateProgress(0);
      return;
    }

    const landmarks = results.multiFaceLandmarks[0];
    const yaw = this._estimateYaw(landmarks);
    const step = this.steps[this.currentStep];
    const inRange = yaw >= step.yawRange[0] && yaw <= step.yawRange[1];

    // Draw face landmark dots overlay
    this._drawLandmarks(landmarks, inRange);

    if (inRange) {
      this.holdFrames++;
      const pct = Math.min(100, (this.holdFrames / this.HOLD_REQUIRED) * 100);
      this._updateProgress(pct);
      this._setStatus(`Hold steady... ${Math.round(pct)}%`, true);

      if (this.holdFrames >= this.HOLD_REQUIRED) {
        this._captureFrame(step);
      }
    } else {
      this.holdFrames = 0;
      this._updateProgress(0);
      this._setStatus(step.instruction, false);
    }
  }

  // ── Yaw estimation (reuses HeadTracker approach) ───────────

  _estimateYaw(landmarks) {
    const noseTip   = landmarks[1];
    const leftEdge  = landmarks[234];
    const rightEdge = landmarks[454];

    const faceWidth = rightEdge.x - leftEdge.x;
    if (faceWidth < 0.01) return 0;
    const noseCenterOffset = noseTip.x - (leftEdge.x + faceWidth / 2);
    return (noseCenterOffset / (faceWidth / 2)) * (Math.PI / 3);
  }

  // ── Capture a frame ────────────────────────────────────────

  _captureFrame(step) {
    // Flash effect
    this._flash();

    // Capture from the unmirrored video element
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.videoEl.videoWidth;
    tempCanvas.height = this.videoEl.videoHeight;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(this.videoEl, 0, 0);
    const dataUrl = tempCanvas.toDataURL('image/png');

    this.captures.push({ id: step.id, dataUrl });

    // Update thumbnails
    this._renderThumbnail(this.currentStep, dataUrl);

    this.currentStep++;
    this.holdFrames = 0;

    if (this.currentStep >= this.steps.length) {
      // All captured — send to AI
      this._allCaptured();
    } else {
      this._updateUI();
    }
  }

  // ── Send to AI ─────────────────────────────────────────────

  _allCaptured() {
    this._setStatus('All angles captured! Sending to AI...', true);
    this._updateProgress(100);

    // Short delay so user sees the success state
    setTimeout(() => {
      this._sendToAI();
      this._cleanup();
    }, 800);
  }

  _sendToAI() {
    if (!this.ai) return;

    // Build reference images array matching AIController format
    const refImages = this.captures.map(cap => ({
      name: `face-${cap.id}.png`,
      mimeType: 'image/png',
      dataUrl: cap.dataUrl,
    }));

    // Inject into AIController reference images
    this.ai.referenceImages = refImages;

    // Set the prompt and trigger send
    const prompt = 'I have captured three angles of a face (front, left side, right side). ' +
      'Analyze all three reference images carefully and reconstruct this face as accurately as possible. ' +
      'Pay close attention to facial proportions, bone structure, nose shape, eye spacing, ' +
      'jaw line, cheekbones, and all distinguishing features visible from each angle. ' +
      'Also determine hair style/color, skin tone, approximate age, and sex from the images.';

    if (this.ai.chatInput) {
      this.ai.chatInput.value = prompt;
    }
    this.ai.sendPrompt();
  }

  // ── Overlay UI ─────────────────────────────────────────────

  _buildOverlay() {
    if (this.overlay) this.overlay.remove();

    this.overlay = document.createElement('div');
    this.overlay.id = 'face-capture-overlay';
    this.overlay.innerHTML = `
      <div class="fc-modal">
        <div class="fc-header">
          <div class="fc-title">
            <i class="fas fa-user-circle"></i>
            <span>Multi-Angle Face Capture</span>
          </div>
          <button class="fc-close-btn" title="Cancel"><i class="fas fa-times"></i></button>
        </div>

        <div class="fc-body">
          <div class="fc-step-indicators">
            <div class="fc-step-dot active" data-step="0">
              <i class="fas fa-portrait"></i>
              <span>Front</span>
            </div>
            <div class="fc-step-line"></div>
            <div class="fc-step-dot" data-step="1">
              <i class="fas fa-arrow-left"></i>
              <span>Left</span>
            </div>
            <div class="fc-step-line"></div>
            <div class="fc-step-dot" data-step="2">
              <i class="fas fa-arrow-right"></i>
              <span>Right</span>
            </div>
          </div>

          <div class="fc-camera-area">
            <video class="fc-video" autoplay playsinline></video>
            <canvas class="fc-canvas"></canvas>
            <div class="fc-guide-ring"></div>
            <div class="fc-progress-ring">
              <svg viewBox="0 0 120 120">
                <circle class="fc-progress-bg" cx="60" cy="60" r="56"/>
                <circle class="fc-progress-fill" cx="60" cy="60" r="56"/>
              </svg>
            </div>
          </div>

          <div class="fc-status">
            <span class="fc-status-text">Initializing camera...</span>
          </div>

          <div class="fc-thumbnails">
            <div class="fc-thumb" data-step="0"><i class="fas fa-portrait"></i></div>
            <div class="fc-thumb" data-step="1"><i class="fas fa-arrow-left"></i></div>
            <div class="fc-thumb" data-step="2"><i class="fas fa-arrow-right"></i></div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);

    // References
    this.videoEl = this.overlay.querySelector('.fc-video');
    this.canvasEl = this.overlay.querySelector('.fc-canvas');
    this.canvasEl.width = 640;
    this.canvasEl.height = 480;
    this.canvasCtx = this.canvasEl.getContext('2d');

    // Bind close
    this.overlay.querySelector('.fc-close-btn').addEventListener('click', () => this.cancel());

    // Click outside modal closes
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.cancel();
    });
  }

  _updateUI() {
    if (!this.overlay) return;

    const step = this.steps[this.currentStep];
    this._setStatus(step.instruction, false);
    this._updateProgress(0);

    // Update step indicators
    this.overlay.querySelectorAll('.fc-step-dot').forEach((dot, i) => {
      dot.classList.toggle('active', i === this.currentStep);
      dot.classList.toggle('completed', i < this.currentStep);
    });

    // Update step lines
    this.overlay.querySelectorAll('.fc-step-line').forEach((line, i) => {
      line.classList.toggle('completed', i < this.currentStep);
    });
  }

  _setStatus(text, success) {
    const el = this.overlay?.querySelector('.fc-status-text');
    if (el) {
      el.textContent = text;
      el.classList.toggle('fc-success', success);
    }
  }

  _updateProgress(pct) {
    const circle = this.overlay?.querySelector('.fc-progress-fill');
    if (!circle) return;
    const circumference = 2 * Math.PI * 56;
    const offset = circumference - (pct / 100) * circumference;
    circle.style.strokeDasharray = `${circumference}`;
    circle.style.strokeDashoffset = `${offset}`;

    const ring = this.overlay?.querySelector('.fc-guide-ring');
    if (ring) {
      ring.classList.toggle('fc-filling', pct > 0 && pct < 100);
      ring.classList.toggle('fc-complete', pct >= 100);
    }
  }

  _renderThumbnail(stepIndex, dataUrl) {
    const thumb = this.overlay?.querySelector(`.fc-thumb[data-step="${stepIndex}"]`);
    if (!thumb) return;
    thumb.innerHTML = '';
    thumb.classList.add('captured');
    const img = document.createElement('img');
    img.src = dataUrl;
    thumb.appendChild(img);
  }

  _flash() {
    const flash = document.createElement('div');
    flash.className = 'fc-flash';
    this.overlay?.querySelector('.fc-camera-area')?.appendChild(flash);
    setTimeout(() => flash.remove(), 350);
  }

  _drawLandmarks(landmarks, inRange) {
    const w = this.canvasEl.width;
    const h = this.canvasEl.height;
    const color = inRange ? '#00ff88' : '#ff6b6b';

    // Draw key landmarks as small dots
    const keyPoints = [1, 33, 263, 61, 291, 10, 152, 234, 454, 133, 362];
    this.canvasCtx.fillStyle = color;
    for (const idx of keyPoints) {
      const lm = landmarks[idx];
      // Mirror X for display
      const x = w - lm.x * w;
      const y = lm.y * h;
      this.canvasCtx.beginPath();
      this.canvasCtx.arc(x, y, 3, 0, Math.PI * 2);
      this.canvasCtx.fill();
    }
  }

  // ── Cleanup ────────────────────────────────────────────────

  _cleanup() {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    this.faceMesh = null;
    this.videoEl = null;
    this.canvasEl = null;
    this.canvasCtx = null;
  }
}

window.FaceCaptureSystem = FaceCaptureSystem;
