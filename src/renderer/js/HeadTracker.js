/**
 * HeadTracker.js
 * Uses the webcam + MediaPipe Face Mesh to detect head pose (yaw/pitch)
 * and rotates the 3D model accordingly in the Three.js viewport.
 *
 * Requires MediaPipe Face Mesh CDN scripts loaded before this file.
 */

class HeadTracker {
  constructor(sceneManager, hairSystem, eyeSystem) {
    this.sceneManager = sceneManager;
    this.hairSystem = hairSystem;
    this.eyeSystem = eyeSystem;
    this.enabled = false;
    this.videoElement = null;
    this.canvasElement = null;
    this.canvasCtx = null;
    this.faceMesh = null;
    this.camera = null; // MediaPipe camera helper
    this.stream = null;

    // Pivot group that parents all face objects during tracking
    this.pivotGroup = null;
    this.reparentedObjects = [];

    // Smoothing & mapping
    this.smoothYaw = 0;
    this.smoothPitch = 0;
    this.smoothingFactor = 0.15; // Lower = smoother, higher = more responsive
    this.sensitivity = 1.5;      // Multiplier for head rotation mapping
    this.maxAngle = Math.PI / 4; // 45 degrees max rotation

    // Base rotation (saved when tracking starts so we rotate relative to it)
    this.baseYaw = 0;
    this.basePitch = 0;
    this.calibrated = false;
    this.calibrationFrames = 0;
    this.calibrationSumYaw = 0;
    this.calibrationSumPitch = 0;
    this.CALIBRATION_COUNT = 10;

    // Preview element
    this.previewContainer = null;
  }

  /**
   * Initialize the video element and MediaPipe Face Mesh
   */
  async init() {
    // Create hidden video element for webcam feed
    this.videoElement = document.createElement('video');
    this.videoElement.setAttribute('playsinline', '');
    this.videoElement.style.display = 'none';
    document.body.appendChild(this.videoElement);

    // Create small preview canvas (shown in corner when tracking)
    this._createPreview();

    // Initialize MediaPipe Face Mesh
    this.faceMesh = new FaceMesh({
      locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
      }
    });

    this.faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    this.faceMesh.onResults((results) => this._onResults(results));

    console.log('[HeadTracker] Initialized');
  }

  /**
   * Create the small webcam preview overlay
   */
  _createPreview() {
    this.previewContainer = document.createElement('div');
    this.previewContainer.id = 'head-tracker-preview';
    this.previewContainer.style.cssText = `
      position: fixed;
      bottom: 16px;
      right: 16px;
      width: 160px;
      height: 120px;
      border-radius: 8px;
      overflow: hidden;
      border: 2px solid #00d4ff;
      box-shadow: 0 4px 16px rgba(0, 212, 255, 0.3);
      z-index: 1000;
      display: none;
      background: #000;
    `;

    this.canvasElement = document.createElement('canvas');
    this.canvasElement.width = 160;
    this.canvasElement.height = 120;
    this.canvasElement.style.cssText = 'width: 100%; height: 100%; transform: scaleX(-1);';
    this.canvasCtx = this.canvasElement.getContext('2d');

    // Status indicator
    const statusDot = document.createElement('div');
    statusDot.style.cssText = `
      position: absolute;
      top: 6px;
      left: 6px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #00ff88;
      box-shadow: 0 0 6px #00ff88;
    `;

    const label = document.createElement('div');
    label.textContent = 'Head Tracking';
    label.style.cssText = `
      position: absolute;
      top: 4px;
      left: 20px;
      font-size: 9px;
      color: #00d4ff;
      font-family: 'JetBrains Mono', monospace;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    `;

    this.previewContainer.appendChild(this.canvasElement);
    this.previewContainer.appendChild(statusDot);
    this.previewContainer.appendChild(label);
    document.body.appendChild(this.previewContainer);
  }

  /**
   * Start head tracking — requests webcam and begins detection loop
   */
  async start() {
    if (this.enabled) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, facingMode: 'user' }
      });

      this.videoElement.srcObject = this.stream;
      await this.videoElement.play();

      // Create pivot group and reparent all face objects into it
      this._setupPivotGroup();

      // Reset calibration
      this.calibrated = false;
      this.calibrationFrames = 0;
      this.calibrationSumYaw = 0;
      this.calibrationSumPitch = 0;
      this.smoothYaw = 0;
      this.smoothPitch = 0;

      this.enabled = true;
      this.previewContainer.style.display = 'block';

      // Disable orbit controls so they don't conflict
      this.sceneManager.controls.enabled = false;

      // Start detection loop
      this._detectLoop();

      console.log('[HeadTracker] Started');
    } catch (err) {
      console.error('[HeadTracker] Failed to access webcam:', err);
      throw err;
    }
  }

  /**
   * Create a pivot group and reparent head, hair, eyes, eyebrows, beard into it.
   * This way rotating the pivot rotates everything together.
   */
  _setupPivotGroup() {
    const scene = this.sceneManager.scene;

    this.pivotGroup = new THREE.Group();
    this.pivotGroup.name = 'HeadTrackingPivot';
    scene.add(this.pivotGroup);

    // Collect all face-related objects to reparent
    this.reparentedObjects = [];

    const headMesh = this.sceneManager.headMesh;
    if (headMesh) {
      this.reparentedObjects.push(headMesh);
    }

    if (this.hairSystem) {
      if (this.hairSystem.hairGroup) this.reparentedObjects.push(this.hairSystem.hairGroup);
      if (this.hairSystem._eyebrowGroup) this.reparentedObjects.push(this.hairSystem._eyebrowGroup);
      if (this.hairSystem._beardGroup) this.reparentedObjects.push(this.hairSystem._beardGroup);
    }

    if (this.eyeSystem) {
      if (this.eyeSystem.eyeGroup) this.reparentedObjects.push(this.eyeSystem.eyeGroup);
      if (this.eyeSystem._eyelashGroup) this.reparentedObjects.push(this.eyeSystem._eyelashGroup);
    }

    // Move all objects into the pivot group (preserves their world position)
    for (const obj of this.reparentedObjects) {
      this.pivotGroup.attach(obj);
    }

    console.log(`[HeadTracker] Pivot group created with ${this.reparentedObjects.length} objects`);
  }

  /**
   * Tear down pivot group, reparent objects back to the scene
   */
  _teardownPivotGroup() {
    if (!this.pivotGroup) return;

    const scene = this.sceneManager.scene;

    // Reset pivot rotation before reparenting back
    this.pivotGroup.rotation.set(0, 0, 0);
    this.pivotGroup.updateMatrixWorld(true);

    // Move all objects back to the scene
    for (const obj of this.reparentedObjects) {
      scene.attach(obj);
    }

    scene.remove(this.pivotGroup);
    this.pivotGroup = null;
    this.reparentedObjects = [];

    console.log('[HeadTracker] Pivot group removed');
  }

  /**
   * Stop head tracking, release webcam, restore model rotation
   */
  stop() {
    if (!this.enabled) return;

    this.enabled = false;
    this.previewContainer.style.display = 'none';

    // Stop webcam stream
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    this.videoElement.srcObject = null;

    // Tear down pivot group — reparents objects back to scene with rotation reset
    this._teardownPivotGroup();

    // Re-enable orbit controls
    this.sceneManager.controls.enabled = true;

    console.log('[HeadTracker] Stopped');
  }

  /**
   * Toggle tracking on/off
   */
  async toggle() {
    if (this.enabled) {
      this.stop();
      return false;
    } else {
      await this.start();
      return true;
    }
  }

  /**
   * Continuous detection loop using requestAnimationFrame
   */
  _detectLoop() {
    if (!this.enabled) return;

    if (this.videoElement.readyState >= 2) {
      this.faceMesh.send({ image: this.videoElement }).then(() => {
        if (this.enabled) {
          requestAnimationFrame(() => this._detectLoop());
        }
      });
    } else {
      requestAnimationFrame(() => this._detectLoop());
    }
  }

  /**
   * Process MediaPipe Face Mesh results
   */
  _onResults(results) {
    // Draw preview
    this.canvasCtx.save();
    this.canvasCtx.clearRect(0, 0, 160, 120);

    if (this.videoElement.readyState >= 2) {
      this.canvasCtx.drawImage(this.videoElement, 0, 0, 160, 120);
    }

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
      const landmarks = results.multiFaceLandmarks[0];

      // Estimate head pose from key landmarks
      const pose = this._estimatePose(landmarks);

      // Calibration: average the first N frames as the "neutral" pose
      if (!this.calibrated) {
        this.calibrationSumYaw += pose.yaw;
        this.calibrationSumPitch += pose.pitch;
        this.calibrationFrames++;

        if (this.calibrationFrames >= this.CALIBRATION_COUNT) {
          this.baseYaw = this.calibrationSumYaw / this.CALIBRATION_COUNT;
          this.basePitch = this.calibrationSumPitch / this.CALIBRATION_COUNT;
          this.calibrated = true;
          console.log(`[HeadTracker] Calibrated: baseYaw=${this.baseYaw.toFixed(3)}, basePitch=${this.basePitch.toFixed(3)}`);
        }

        this.canvasCtx.restore();
        return;
      }

      // Relative yaw/pitch from calibrated neutral
      const relYaw = pose.yaw - this.baseYaw;
      const relPitch = pose.pitch - this.basePitch;

      // Smooth with exponential moving average
      this.smoothYaw += (relYaw - this.smoothYaw) * this.smoothingFactor;
      this.smoothPitch += (relPitch - this.smoothPitch) * this.smoothingFactor;

      // Clamp
      const clampedYaw = Math.max(-this.maxAngle, Math.min(this.maxAngle, this.smoothYaw * this.sensitivity));
      const clampedPitch = Math.max(-this.maxAngle, Math.min(this.maxAngle, this.smoothPitch * this.sensitivity));

      // Apply to head mesh rotation
      this._applyRotation(clampedYaw, clampedPitch);

      // Draw crosshair indicator on preview
      const cx = 80 + (clampedYaw / this.maxAngle) * 40;
      const cy = 60 + (clampedPitch / this.maxAngle) * 30;
      this.canvasCtx.beginPath();
      this.canvasCtx.arc(cx, cy, 4, 0, 2 * Math.PI);
      this.canvasCtx.fillStyle = '#00ff88';
      this.canvasCtx.fill();
    }

    this.canvasCtx.restore();
  }

  /**
   * Estimate head yaw and pitch from face landmarks.
   * Uses nose tip, left/right face edges, and forehead/chin for pitch.
   */
  _estimatePose(landmarks) {
    // Key landmark indices (MediaPipe Face Mesh 468 landmarks):
    // 1   = nose tip
    // 33  = left eye inner corner
    // 263 = right eye inner corner
    // 10  = forehead top center
    // 152 = chin bottom
    // 234 = left face edge (cheek)
    // 454 = right face edge (cheek)

    const noseTip = landmarks[1];
    const leftEdge = landmarks[234];
    const rightEdge = landmarks[454];
    const forehead = landmarks[10];
    const chin = landmarks[152];

    // Yaw: horizontal position of nose relative to face edges
    // If nose is closer to left edge -> head turned right (from user's POV)
    const faceWidth = rightEdge.x - leftEdge.x;
    const noseCenterOffset = noseTip.x - (leftEdge.x + faceWidth / 2);
    // Normalize to roughly -1..1 range, then convert to radians
    const yaw = (noseCenterOffset / (faceWidth / 2)) * (Math.PI / 3);

    // Pitch: vertical position of nose relative to forehead-chin line
    const faceHeight = chin.y - forehead.y;
    const noseCenterY = noseTip.y - (forehead.y + faceHeight / 2);
    const pitch = (noseCenterY / (faceHeight / 2) - 0.3) * (Math.PI / 4);

    return { yaw, pitch };
  }

  /**
   * Apply computed rotation to the pivot group (rotates head + hair + eyes + all)
   */
  _applyRotation(yaw, pitch) {
    if (!this.pivotGroup) return;

    // Yaw = Y-axis rotation (left/right)
    // Pitch = X-axis rotation (up/down)
    this.pivotGroup.rotation.y = yaw;
    this.pivotGroup.rotation.x = -pitch;
  }

  /**
   * Recalibrate the neutral head position
   */
  recalibrate() {
    this.calibrated = false;
    this.calibrationFrames = 0;
    this.calibrationSumYaw = 0;
    this.calibrationSumPitch = 0;
    this.smoothYaw = 0;
    this.smoothPitch = 0;
    console.log('[HeadTracker] Recalibrating...');
  }

  /**
   * Clean up resources
   */
  dispose() {
    this.stop();
    if (this.videoElement && this.videoElement.parentNode) {
      this.videoElement.parentNode.removeChild(this.videoElement);
    }
    if (this.previewContainer && this.previewContainer.parentNode) {
      this.previewContainer.parentNode.removeChild(this.previewContainer);
    }
  }
}

window.HeadTracker = HeadTracker;
