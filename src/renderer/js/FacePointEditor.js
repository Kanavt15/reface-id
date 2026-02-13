/**
 * FacePointEditor.js  (v5 — uses OBJMorpher's own deformation engine)
 *
 * Dragging a landmark deforms the mesh EXACTLY the way the sliders do:
 *   - Gaussian-weighted influence from the landmark + its neighbours
 *   - radius_scale, face_mask, directional weights all from OBJMorpher
 *   - Asymmetric: only the dragged side is affected (unless midline point)
 *
 * The drag delta is decomposed into X/Y/Z components and each is
 * applied through the morpher's weight functions, producing the same
 * natural, face-wide deformation that sliders produce.
 */

class FacePointEditor {
  constructor(sceneManager, objMorpher) {
    this.sceneManager = sceneManager;
    this.scene = sceneManager.scene;
    this.camera = sceneManager.camera;
    this.canvas = sceneManager.canvas;
    this.controls = sceneManager.controls;
    this.morpher = objMorpher;

    this.enabled = false;
    this.pointsVisible = true;
    this.pointSize = 0.018;
    this.influenceRadius = 0.12;     // passed to morpher's _getRegionWeights

    // Groups
    this.pointGroup = new THREE.Group();
    this.pointGroup.name = 'FacePointEditor';
    this.pointGroup.visible = false;
    this.scene.add(this.pointGroup);

    // Point data
    this.controlPoints = [];
    this.selectedPoint = null;
    this.hoveredPoint = null;
    this.isDragging = false;
    this.dragPlane = new THREE.Plane();
    this.dragOffset = new THREE.Vector3();
    this.dragStart = new THREE.Vector3();

    // Drag-session: snapshot of position buffers before drag
    this._dragSnapshot = null;
    // Cached weights for the current drag (computed once at drag start)
    this._dragWeights = null;         // Float64Array — Gaussian weights from morpher
    this._dragDirections = null;      // Float64Array — directional (left/right) values
    this._dragIsAsymmetric = false;   // true if dragged point is NOT on midline
    this._dragSide = 0;              // +1 = right side, -1 = left side, 0 = midline

    // Raycasting
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Points = { threshold: 0.05 };
    this.mouse = new THREE.Vector2();

    // Undo stack
    this.undoStack = [];
    this.maxUndo = 50;

    // Materials
    this.pointMaterial = new THREE.MeshBasicMaterial({
      color: 0x7aa2f7, transparent: true, opacity: 0.85, depthTest: true,
    });
    this.pointHoverMaterial = new THREE.MeshBasicMaterial({
      color: 0x9ece6a, transparent: true, opacity: 1.0, depthTest: true,
    });
    this.pointActiveMaterial = new THREE.MeshBasicMaterial({
      color: 0xf7768e, transparent: true, opacity: 1.0, depthTest: true,
    });

    this.influenceRing = null;
    this.onPointEdited = null;
    this.onSettingsChanged = null;

    // Bind handlers
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ENABLE / DISABLE
  // ═══════════════════════════════════════════════════════════════════════

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this._createControlPoints();
    this.pointGroup.visible = true;
    this.canvas.addEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.addEventListener('pointermove', this._onPointerMove, true);
    this.canvas.addEventListener('pointerup', this._onPointerUp, true);
    window.addEventListener('keydown', this._onKeyDown);
    console.log('FacePointEditor: enabled (v5 — morpher-engine deformation)');
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.pointGroup.visible = false;
    this.selectedPoint = null;
    this.hoveredPoint = null;
    this.isDragging = false;
    this._dragSnapshot = null;
    this._dragWeights = null;
    this._dragDirections = null;

    this.canvas.removeEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.removeEventListener('pointermove', this._onPointerMove, true);
    this.canvas.removeEventListener('pointerup', this._onPointerUp, true);
    window.removeEventListener('keydown', this._onKeyDown);
    this.controls.enabled = true;
    console.log('FacePointEditor: disabled');
  }

  toggle() {
    if (this.enabled) this.disable(); else this.enable();
    return this.enabled;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTROL POINTS
  // ═══════════════════════════════════════════════════════════════════════

  _createControlPoints() {
    while (this.pointGroup.children.length > 0) {
      const c = this.pointGroup.children[0];
      this.pointGroup.remove(c);
      c.geometry.dispose();
      c.material.dispose();
    }
    this.controlPoints = [];

    if (!this.morpher || !this.morpher._landmarkPositions) {
      console.warn('FacePointEditor: no landmarks');
      return;
    }

    const geometry = new THREE.SphereGeometry(this.pointSize, 12, 8);

    for (const [name, pos] of Object.entries(this.morpher._landmarkPositions)) {
      const idx = this.morpher._landmarkIndices[name];
      const currentPos = this._getVertexWorldPosition(idx);

      const mesh = new THREE.Mesh(geometry, this.pointMaterial.clone());
      mesh.position.copy(currentPos);
      mesh.userData = { landmarkName: name, vertexIndex: idx };
      mesh.renderOrder = 999;
      this.pointGroup.add(mesh);

      this.controlPoints.push({
        mesh, name, vertexIndex: idx,
        originalPos: currentPos.clone(),
        currentPos: currentPos.clone(),
      });
    }
    console.log(`FacePointEditor: ${this.controlPoints.length} control points`);
  }

  _getVertexWorldPosition(globalIndex) {
    const pos = new THREE.Vector3();
    for (let m = 0; m < this.morpher.meshes.length; m++) {
      const offset = this.morpher.vertexOffsets[m];
      const mesh = this.morpher.meshes[m];
      const posAttr = mesh.geometry.attributes.position;
      if (globalIndex >= offset && globalIndex < offset + posAttr.count) {
        const li = globalIndex - offset;
        pos.set(posAttr.getX(li), posAttr.getY(li), posAttr.getZ(li));
        mesh.updateWorldMatrix(true, false);
        pos.applyMatrix4(mesh.matrixWorld);
        return pos;
      }
    }
    return pos;
  }

  refreshPoints() {
    for (const cp of this.controlPoints) {
      const worldPos = this._getVertexWorldPosition(cp.vertexIndex);
      cp.mesh.position.copy(worldPos);
      cp.currentPos.copy(worldPos);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  DETERMINE WHICH LANDMARKS TO USE AS WEIGHT SOURCES
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Given a landmark name, return:
   *   landmarks: array of landmark names to pass to _getRegionWeights
   *              (the dragged point + anatomically-related neighbours)
   *   side:      -1 (left), +1 (right), 0 (midline)
   *
   * This mirrors how each slider in applyAllMorphs() groups landmarks.
   */
  _getLandmarkGroupForDrag(name) {
    // Determine side from the landmark's X coordinate
    const pos = this.morpher._landmarkPositions[name];
    const x = pos ? pos[0] : 0;
    const MIDLINE_THRESHOLD = 0.05;
    let side = 0;
    if (x < -MIDLINE_THRESHOLD) side = -1;   // left
    else if (x > MIDLINE_THRESHOLD) side = 1; // right

    // Map each landmark to its anatomical group (same-side only for asymmetry)
    const GROUPS = {
      // Nose (midline, but nostrils/alar have sides)
      nose_tip:        { landmarks: ['nose_tip', 'nose_base'], side: 0 },
      nose_bridge:     { landmarks: ['nose_bridge', 'nose_bridge_top'], side: 0 },
      nose_bridge_top: { landmarks: ['nose_bridge_top', 'nose_bridge'], side: 0 },
      nose_base:       { landmarks: ['nose_base', 'nose_tip'], side: 0 },
      nostril_left:    { landmarks: ['nostril_left', 'alar_left'], side: -1 },
      nostril_right:   { landmarks: ['nostril_right', 'alar_right'], side: 1 },
      alar_left:       { landmarks: ['alar_left', 'nostril_left'], side: -1 },
      alar_right:      { landmarks: ['alar_right', 'nostril_right'], side: 1 },

      // Jaw & Chin
      chin:            { landmarks: ['chin', 'chin_left', 'chin_right'], side: 0 },
      chin_left:       { landmarks: ['chin_left', 'chin', 'jaw_left'], side: -1 },
      chin_right:      { landmarks: ['chin_right', 'chin', 'jaw_right'], side: 1 },
      jaw_left:        { landmarks: ['jaw_left', 'jaw_angle_left', 'chin_left'], side: -1 },
      jaw_right:       { landmarks: ['jaw_right', 'jaw_angle_right', 'chin_right'], side: 1 },
      jaw_angle_left:  { landmarks: ['jaw_angle_left', 'jaw_left'], side: -1 },
      jaw_angle_right: { landmarks: ['jaw_angle_right', 'jaw_right'], side: 1 },

      // Eyes
      eye_left_outer:  { landmarks: ['eye_left_outer', 'eye_left_center', 'eye_left_inner'], side: -1 },
      eye_left_inner:  { landmarks: ['eye_left_inner', 'eye_left_center', 'eye_left_outer'], side: -1 },
      eye_left_center: { landmarks: ['eye_left_center', 'eye_left_inner', 'eye_left_outer', 'eye_left_upper', 'eye_left_lower'], side: -1 },
      eye_left_upper:  { landmarks: ['eye_left_upper', 'eye_left_center'], side: -1 },
      eye_left_lower:  { landmarks: ['eye_left_lower', 'eye_left_center'], side: -1 },
      eye_right_outer: { landmarks: ['eye_right_outer', 'eye_right_center', 'eye_right_inner'], side: 1 },
      eye_right_inner: { landmarks: ['eye_right_inner', 'eye_right_center', 'eye_right_outer'], side: 1 },
      eye_right_center:{ landmarks: ['eye_right_center', 'eye_right_inner', 'eye_right_outer', 'eye_right_upper', 'eye_right_lower'], side: 1 },
      eye_right_upper: { landmarks: ['eye_right_upper', 'eye_right_center'], side: 1 },
      eye_right_lower: { landmarks: ['eye_right_lower', 'eye_right_center'], side: 1 },

      // Brows
      brow_left_inner:  { landmarks: ['brow_left_inner', 'brow_left_center', 'glabella'], side: -1 },
      brow_left_center: { landmarks: ['brow_left_center', 'brow_left_inner', 'brow_left_outer'], side: -1 },
      brow_left_outer:  { landmarks: ['brow_left_outer', 'brow_left_center'], side: -1 },
      brow_right_inner: { landmarks: ['brow_right_inner', 'brow_right_center', 'glabella'], side: 1 },
      brow_right_center:{ landmarks: ['brow_right_center', 'brow_right_inner', 'brow_right_outer'], side: 1 },
      brow_right_outer: { landmarks: ['brow_right_outer', 'brow_right_center'], side: 1 },
      glabella:          { landmarks: ['glabella', 'brow_left_inner', 'brow_right_inner'], side: 0 },

      // Forehead
      forehead_center: { landmarks: ['forehead_center', 'forehead_left', 'forehead_right'], side: 0 },
      forehead_left:   { landmarks: ['forehead_left', 'forehead_center', 'temple_left'], side: -1 },
      forehead_right:  { landmarks: ['forehead_right', 'forehead_center', 'temple_right'], side: 1 },
      hairline_center: { landmarks: ['hairline_center', 'forehead_center'], side: 0 },
      temple_left:     { landmarks: ['temple_left', 'forehead_left'], side: -1 },
      temple_right:    { landmarks: ['temple_right', 'forehead_right'], side: 1 },

      // Cheeks
      cheek_left:       { landmarks: ['cheek_left', 'lower_cheek_left', 'cheekbone_left'], side: -1 },
      cheek_right:      { landmarks: ['cheek_right', 'lower_cheek_right', 'cheekbone_right'], side: 1 },
      cheekbone_left:   { landmarks: ['cheekbone_left', 'cheek_left'], side: -1 },
      cheekbone_right:  { landmarks: ['cheekbone_right', 'cheek_right'], side: 1 },
      lower_cheek_left: { landmarks: ['lower_cheek_left', 'cheek_left'], side: -1 },
      lower_cheek_right:{ landmarks: ['lower_cheek_right', 'cheek_right'], side: 1 },

      // Mouth
      mouth_left:       { landmarks: ['mouth_left', 'upper_lip_left', 'lower_lip_left'], side: -1 },
      mouth_right:      { landmarks: ['mouth_right', 'upper_lip_right', 'lower_lip_right'], side: 1 },
      upper_lip_center: { landmarks: ['upper_lip_center', 'upper_lip_left', 'upper_lip_right', 'philtrum_bottom'], side: 0 },
      upper_lip_left:   { landmarks: ['upper_lip_left', 'upper_lip_center', 'mouth_left'], side: -1 },
      upper_lip_right:  { landmarks: ['upper_lip_right', 'upper_lip_center', 'mouth_right'], side: 1 },
      lower_lip_center: { landmarks: ['lower_lip_center', 'lower_lip_left', 'lower_lip_right'], side: 0 },
      lower_lip_left:   { landmarks: ['lower_lip_left', 'lower_lip_center', 'mouth_left'], side: -1 },
      lower_lip_right:  { landmarks: ['lower_lip_right', 'lower_lip_center', 'mouth_right'], side: 1 },
      cupid_bow_left:   { landmarks: ['cupid_bow_left', 'cupid_bow_right', 'upper_lip_center'], side: -1 },
      cupid_bow_right:  { landmarks: ['cupid_bow_right', 'cupid_bow_left', 'upper_lip_center'], side: 1 },
      philtrum_top:     { landmarks: ['philtrum_top', 'philtrum_bottom'], side: 0 },
      philtrum_bottom:  { landmarks: ['philtrum_bottom', 'philtrum_top', 'upper_lip_center'], side: 0 },

      // Ears
      ear_left_top:     { landmarks: ['ear_left_top', 'ear_left_center'], side: -1 },
      ear_left_center:  { landmarks: ['ear_left_center', 'ear_left_top', 'ear_left_bottom', 'tragus_left'], side: -1 },
      ear_left_bottom:  { landmarks: ['ear_left_bottom', 'ear_left_center'], side: -1 },
      ear_right_top:    { landmarks: ['ear_right_top', 'ear_right_center'], side: 1 },
      ear_right_center: { landmarks: ['ear_right_center', 'ear_right_top', 'ear_right_bottom', 'tragus_right'], side: 1 },
      ear_right_bottom: { landmarks: ['ear_right_bottom', 'ear_right_center'], side: 1 },
      tragus_left:      { landmarks: ['tragus_left', 'ear_left_center'], side: -1 },
      tragus_right:     { landmarks: ['tragus_right', 'ear_right_center'], side: 1 },

      // Skull
      crown:       { landmarks: ['crown', 'hairline_center'], side: 0 },
      occiput:     { landmarks: ['occiput'], side: 0 },
      skull_left:  { landmarks: ['skull_left'], side: -1 },
      skull_right: { landmarks: ['skull_right'], side: 1 },
    };

    const entry = GROUPS[name];
    if (entry) {
      // Filter to only landmarks that exist in the morpher
      const valid = entry.landmarks.filter(n => this.morpher._landmarkPositions[n]);
      return { landmarks: valid.length > 0 ? valid : [name], side: entry.side };
    }

    // Fallback: just the dragged point itself
    return { landmarks: [name], side };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ASYMMETRIC WEIGHT MASK
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create an asymmetry mask that limits deformation to one side.
   * side = -1 (left), +1 (right), 0 (both — midline, no mask)
   *
   * Uses a smooth tanh transition (like OBJMorpher's directional weights)
   * so there's no hard seam at the midline.
   */
  _computeAsymmetryMask(side) {
    const N = this.morpher.totalVertices;
    const mask = new Float64Array(N);
    const verts = this.morpher._allVerts;
    const tw = OBJMorpher.MODEL_CONFIG.transition_width;

    if (side === 0) {
      // Midline point — affect both sides equally
      mask.fill(1.0);
    } else {
      // side = -1 → left (negative X), side = +1 → right (positive X)
      for (let i = 0; i < N; i++) {
        const x = verts[i * 3];
        // Smooth transition: 1 on the target side, 0 on the opposite,
        // smooth blend in the middle
        const s = Math.tanh(x * side / (tw * 2));  // positive when on target side
        mask[i] = Math.max(0, Math.min(1, 0.5 + s * 0.5));
      }
    }

    return mask;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MOUSE INTERACTION
  // ═══════════════════════════════════════════════════════════════════════

  _getNDC(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  _raycastPoints() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    return this.raycaster.intersectObjects(this.pointGroup.children, false)[0] || null;
  }

  // ── Pointer Down ──
  _onPointerDown(event) {
    if (event.button !== 0) return;
    this._getNDC(event);
    const hit = this._raycastPoints();

    if (hit) {
      event.preventDefault();
      event.stopImmediatePropagation();

      this.selectedPoint = this.controlPoints.find(cp => cp.mesh === hit.object);
      if (!this.selectedPoint) return;

      this.isDragging = true;
      this.controls.enabled = false;

      const camDir = new THREE.Vector3();
      this.camera.getWorldDirection(camDir);
      this.dragPlane.setFromNormalAndCoplanarPoint(camDir, this.selectedPoint.mesh.position);

      const intersection = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(this.dragPlane, intersection);
      this.dragOffset.subVectors(this.selectedPoint.mesh.position, intersection);
      this.dragStart.copy(this.selectedPoint.mesh.position);

      // ── Prepare deformation ──
      this._pushUndo();
      this._prepareDrag(this.selectedPoint.name);

      this.selectedPoint.mesh.material.copy(this.pointActiveMaterial);
      this._showInfluenceRing(this.selectedPoint.mesh.position);
    }
  }

  // ── Pointer Move ──
  _onPointerMove(event) {
    this._getNDC(event);

    if (this.isDragging && this.selectedPoint) {
      event.preventDefault();
      event.stopImmediatePropagation();

      const intersection = new THREE.Vector3();
      this.raycaster.setFromCamera(this.mouse, this.camera);

      if (this.raycaster.ray.intersectPlane(this.dragPlane, intersection)) {
        const newPos = intersection.add(this.dragOffset);
        const delta = new THREE.Vector3().subVectors(newPos, this.dragStart);

        // Apply morpher-style deformation
        this._applyDragDelta(delta);

        this.selectedPoint.mesh.position.copy(newPos);
        this.selectedPoint.currentPos.copy(newPos);

        if (this.influenceRing) {
          this.influenceRing.position.copy(newPos);
          this.influenceRing.lookAt(this.camera.position);
        }
      }
    } else {
      const hit = this._raycastPoints();
      const newHovered = hit
        ? this.controlPoints.find(cp => cp.mesh === hit.object)
        : null;

      if (newHovered !== this.hoveredPoint) {
        if (this.hoveredPoint && this.hoveredPoint !== this.selectedPoint)
          this.hoveredPoint.mesh.material.copy(this.pointMaterial);
        if (newHovered && newHovered !== this.selectedPoint)
          newHovered.mesh.material.copy(this.pointHoverMaterial);
        this.hoveredPoint = newHovered;
        this.canvas.style.cursor = newHovered ? 'grab' : '';
      }
    }
  }

  // ── Pointer Up ──
  _onPointerUp(event) {
    if (event.button !== 0) return;
    if (this.isDragging) event.stopImmediatePropagation();

    if (this.isDragging && this.selectedPoint) {
      this.selectedPoint.mesh.material.copy(this.pointMaterial);
      this.morpher._finalizeGeometry();
      this.refreshPoints();
      if (this.onPointEdited) this.onPointEdited(this.selectedPoint.name);
    }

    this.isDragging = false;
    this.selectedPoint = null;
    this._dragSnapshot = null;
    this._dragWeights = null;
    this._dragDirections = null;
    this.controls.enabled = true;
    this.canvas.style.cursor = '';
    this._hideInfluenceRing();
  }

  // ── Keyboard ──
  _onKeyDown(event) {
    if (!this.enabled) return;
    if (event.ctrlKey && event.key === 'z') this._popUndo();
    if (event.key === 'Escape' && this.isDragging) {
      this._popUndo();
      this.isDragging = false;
      this.selectedPoint = null;
      this._dragSnapshot = null;
      this._dragWeights = null;
      this.controls.enabled = true;
      this._hideInfluenceRing();
    }
    if (event.key === '+' || event.key === '=')
      this.setInfluenceRadius(Math.min(0.5, this.influenceRadius + 0.02));
    if (event.key === '-')
      this.setInfluenceRadius(Math.max(0.02, this.influenceRadius - 0.02));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DEFORMATION — USING MORPHER'S OWN WEIGHT SYSTEM
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * At drag-start, compute and cache:
   *   1. A snapshot of all position buffers (for clean restore each frame)
   *   2. Gaussian region weights from morpher._getRegionWeights()
   *   3. Directional weights from morpher._getDirectionalWeights()
   *   4. Asymmetry mask (left-only / right-only / both)
   *
   * These are computed ONCE and reused on every mouse-move.
   */
  _prepareDrag(landmarkName) {
    // 1. Snapshot position buffers
    this._dragSnapshot = [];
    for (let m = 0; m < this.morpher.meshes.length; m++) {
      this._dragSnapshot.push(
        new Float32Array(this.morpher.meshes[m].geometry.attributes.position.array)
      );
    }

    // 2. Get the landmark group + side
    const { landmarks, side } = this._getLandmarkGroupForDrag(landmarkName);
    this._dragSide = side;
    this._dragIsAsymmetric = (side !== 0);

    // 3. Compute morpher-style weights (same as sliders use)
    const radius = this.influenceRadius;
    const { weights, directions } = this.morpher._getDirectionalWeights(landmarks, radius);

    // 4. Apply asymmetry mask
    const asymMask = this._computeAsymmetryMask(side);
    const N = this.morpher.totalVertices;
    for (let i = 0; i < N; i++) {
      weights[i] *= asymMask[i];
    }

    this._dragWeights = weights;
    this._dragDirections = directions;

    const affected = weights.reduce((c, w) => c + (w > 0.001 ? 1 : 0), 0);
    console.log(`FacePointEditor: drag "${landmarkName}" — ${landmarks.length} sources, side=${side}, ${affected} affected verts`);
  }

  /**
   * Apply the drag delta using morpher-style offsets.
   * Called every mouse-move (restores from snapshot first).
   *
   * Decomposition of the world-space delta:
   *   - X component → directional spread (same as noseWidth, jawWidth, etc.)
   *   - Y component → uniform vertical offset (same as browHeight, chinHeight)
   *   - Z component → forward/backward protrusion (same as noseBridgeHeight, chinProtrusion)
   */
  _applyDragDelta(worldDelta) {
    if (!this._dragSnapshot || !this._dragWeights) return;

    const weights = this._dragWeights;
    const directions = this._dragDirections;
    const cfg = OBJMorpher.MODEL_CONFIG;
    const zDir = cfg.z_front_direction;
    const N = this.morpher.totalVertices;

    // Compute per-global-vertex offsets (exactly like applyAllMorphs)
    const offsets = new Float64Array(N * 3);

    // X-axis drag → directional weights (asymmetric spread)
    if (Math.abs(worldDelta.x) > 0.0001) {
      const dx = worldDelta.x;
      for (let i = 0; i < N; i++) {
        if (weights[i] < 0.001) continue;
        // Use directional weight for lateral movement (same as sliders)
        offsets[i * 3] += directions[i] * weights[i] * dx;
      }
    }

    // Y-axis drag → uniform vertical (same as sliders)
    if (Math.abs(worldDelta.y) > 0.0001) {
      const dy = worldDelta.y;
      for (let i = 0; i < N; i++) {
        if (weights[i] < 0.001) continue;
        offsets[i * 3 + 1] += weights[i] * dy;
      }
    }

    // Z-axis drag → forward/backward protrusion (same as sliders)
    if (Math.abs(worldDelta.z) > 0.0001) {
      const dz = worldDelta.z;
      for (let i = 0; i < N; i++) {
        if (weights[i] < 0.001) continue;
        offsets[i * 3 + 2] += weights[i] * dz;
      }
    }

    // Apply: restore from snapshot + add offsets (same pattern as applyAllMorphs)
    for (let m = 0; m < this.morpher.meshes.length; m++) {
      const posAttr = this.morpher.meshes[m].geometry.attributes.position;
      const snap = this._dragSnapshot[m];
      const baseOffset = this.morpher.vertexOffsets[m];

      // Restore from snapshot
      posAttr.array.set(snap);

      // Add offsets
      for (let i = 0; i < posAttr.count; i++) {
        const gi = baseOffset + i;
        if (weights[gi] < 0.001) continue;
        posAttr.array[i * 3]     += offsets[gi * 3];
        posAttr.array[i * 3 + 1] += offsets[gi * 3 + 1];
        posAttr.array[i * 3 + 2] += offsets[gi * 3 + 2];
      }

      posAttr.needsUpdate = true;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INFLUENCE RADIUS / POINT SIZE
  // ═══════════════════════════════════════════════════════════════════════

  setInfluenceRadius(r) {
    this.influenceRadius = r;
    if (this.onSettingsChanged) this.onSettingsChanged();
    if (this.influenceRing) {
      this._hideInfluenceRing();
      if (this.selectedPoint) this._showInfluenceRing(this.selectedPoint.mesh.position);
    }
  }

  setPointSize(size) {
    this.pointSize = size;
    const geo = new THREE.SphereGeometry(size, 12, 8);
    for (const cp of this.controlPoints) {
      cp.mesh.geometry.dispose();
      cp.mesh.geometry = geo;
    }
  }

  _showInfluenceRing(position) {
    this._hideInfluenceRing();
    // Visual ring uses the effective Gaussian radius (after radius_scale)
    const effectiveR = this.influenceRadius * OBJMorpher.MODEL_CONFIG.radius_scale;
    const ringGeo = new THREE.RingGeometry(
      effectiveR - 0.005,
      effectiveR + 0.005, 48
    );
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xf7768e, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthTest: false,
    });
    this.influenceRing = new THREE.Mesh(ringGeo, ringMat);
    this.influenceRing.position.copy(position);
    this.influenceRing.renderOrder = 1000;
    this.influenceRing.lookAt(this.camera.position);
    this.scene.add(this.influenceRing);
  }

  _hideInfluenceRing() {
    if (this.influenceRing) {
      this.scene.remove(this.influenceRing);
      this.influenceRing.geometry.dispose();
      this.influenceRing.material.dispose();
      this.influenceRing = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UNDO
  // ═══════════════════════════════════════════════════════════════════════

  _pushUndo() {
    const snapshot = [];
    for (let m = 0; m < this.morpher.meshes.length; m++) {
      snapshot.push(new Float32Array(this.morpher.meshes[m].geometry.attributes.position.array));
    }
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
  }

  _popUndo() {
    if (this.undoStack.length === 0) return;
    const snapshot = this.undoStack.pop();
    for (let m = 0; m < this.morpher.meshes.length; m++) {
      const posAttr = this.morpher.meshes[m].geometry.attributes.position;
      posAttr.array.set(snapshot[m]);
      posAttr.needsUpdate = true;
      this.morpher.meshes[m].geometry.computeVertexNormals();
      this.morpher.meshes[m].geometry.computeBoundingBox();
      this.morpher.meshes[m].geometry.computeBoundingSphere();
    }
    this.refreshPoints();
    console.log('FacePointEditor: undo applied');
  }

  resetAllEdits() {
    this.undoStack = [];
    this.morpher.applyAllMorphs();
    this.refreshPoints();
    console.log('FacePointEditor: all manual edits reset');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VISIBILITY / CLEANUP
  // ═══════════════════════════════════════════════════════════════════════

  setPointsVisible(visible) {
    this.pointsVisible = visible;
    this.pointGroup.visible = visible && this.enabled;
  }

  dispose() {
    this.disable();
    this.scene.remove(this.pointGroup);
    for (const cp of this.controlPoints) {
      cp.mesh.geometry.dispose();
      cp.mesh.material.dispose();
    }
    this._hideInfluenceRing();
    this.pointMaterial.dispose();
    this.pointHoverMaterial.dispose();
    this.pointActiveMaterial.dispose();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXPORT — OBJ string for Blender render pipeline
  // ═══════════════════════════════════════════════════════════════════════

  exportCurrentMeshAsOBJ() {
    const lines = ['# REface ID — morphed head export'];
    let vertexOffset = 1;

    for (let m = 0; m < this.morpher.meshes.length; m++) {
      const mesh = this.morpher.meshes[m];
      const posAttr = mesh.geometry.attributes.position;
      const normalAttr = mesh.geometry.attributes.normal;
      const indexAttr = mesh.geometry.index;

      mesh.updateWorldMatrix(true, false);
      const mat = mesh.matrixWorld;
      const normalMat = new THREE.Matrix3().getNormalMatrix(mat);

      lines.push(`o mesh_${m}`);

      for (let i = 0; i < posAttr.count; i++) {
        const v = new THREE.Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
        v.applyMatrix4(mat);
        lines.push(`v ${v.x.toFixed(6)} ${v.y.toFixed(6)} ${v.z.toFixed(6)}`);
      }

      if (normalAttr) {
        for (let i = 0; i < normalAttr.count; i++) {
          const n = new THREE.Vector3(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i));
          n.applyMatrix3(normalMat).normalize();
          lines.push(`vn ${n.x.toFixed(6)} ${n.y.toFixed(6)} ${n.z.toFixed(6)}`);
        }
      }

      if (indexAttr) {
        for (let i = 0; i < indexAttr.count; i += 3) {
          const a = indexAttr.getX(i) + vertexOffset;
          const b = indexAttr.getX(i + 1) + vertexOffset;
          const c = indexAttr.getX(i + 2) + vertexOffset;
          lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
        }
      } else {
        for (let i = 0; i < posAttr.count; i += 3) {
          const a = i + vertexOffset;
          lines.push(`f ${a}//${a} ${a + 1}//${a + 1} ${a + 2}//${a + 2}`);
        }
      }

      vertexOffset += posAttr.count;
    }

    return lines.join('\n');
  }
}

window.FacePointEditor = FacePointEditor;
