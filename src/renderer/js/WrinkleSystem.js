/**
 * WrinkleSystem.js
 * Manages wrinkle, stretch mark, and scar drawing on the 3D face mesh.
 *
 * Wrinkles are stored as polylines (arrays of surface points) and rendered
 * using normal maps and optional geometry displacement. They track position
 * using barycentric coordinates to survive face morphing.
 */

class WrinkleSystem {
  constructor(sceneManager, objMorpher, textureGenerator) {
    this.sceneManager = sceneManager;
    this.scene = sceneManager.scene;
    this.camera = sceneManager.camera;
    this.canvas = sceneManager.canvas;
    this.controls = sceneManager.controls;
    this.morpher = objMorpher;
    this.textureGenerator = textureGenerator;

    // All placed wrinkles
    this.wrinkles = [];

    // Drawing state
    this.enabled = false;
    this.currentType = 'fine';  // 'fine', 'deep', 'stretch', 'scar'
    this.currentWidth = 0.005;
    this.currentDepth = 0.8;
    this.useGeometryDisplacement = false;

    // Active drawing line
    this.isDrawing = false;
    this.currentLine = null;  // Array of points being drawn
    this.lastScreenPos = null;  // For sampling rate control

    // Preview line (visual feedback while drawing)
    this.previewLine = null;

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Callbacks
    this.onWrinkleChanged = null;

    // Bound event handlers
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    // ID counter
    this._nextId = 1;

    // Min screen distance for sampling points (pixels)
    this.minSampleDistance = 10;
  }

  // ─── Wrinkle Type Definitions ───────────────────────────────────────────

  static get WRINKLE_TYPES() {
    return {
      fine: {
        label: 'Fine Lines',
        defaultWidth: 0.002,
        defaultDepth: 0.5,
        defaultColor: '#8b7355',  // Slightly darker than skin
        textureWidthPx: 3,  // Texture gradient width in pixels
      },
      deep: {
        label: 'Deep Wrinkles',
        defaultWidth: 0.006,
        defaultDepth: 0.9,
        defaultColor: '#6b5845',  // Darker
        textureWidthPx: 12,
      },
      stretch: {
        label: 'Stretch Marks',
        defaultWidth: 0.004,
        defaultDepth: 0.6,
        defaultColor: '#d4a5a5',  // Pinkish/lighter
        textureWidthPx: 6,
      },
      scar: {
        label: 'Scars',
        defaultWidth: 0.003,
        defaultDepth: 0.7,
        defaultColor: '#c9a0a0',  // Pinkish
        textureWidthPx: 5,
      },
    };
  }

  // ─── Enable/Disable ─────────────────────────────────────────────────────

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.canvas.addEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.addEventListener('pointermove', this._onPointerMove, true);
    this.canvas.addEventListener('pointerup', this._onPointerUp, true);
    window.addEventListener('keydown', this._onKeyDown);
    this.controls.enabled = false;  // Disable orbit during drawing
    console.log('[WrinkleSystem] Enabled');
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.isDrawing = false;
    this.currentLine = null;
    this._clearPreviewLine();
    this.canvas.removeEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.removeEventListener('pointermove', this._onPointerMove, true);
    this.canvas.removeEventListener('pointerup', this._onPointerUp, true);
    window.removeEventListener('keydown', this._onKeyDown);
    this.controls.enabled = true;
    console.log('[WrinkleSystem] Disabled');
  }

  toggle() {
    if (this.enabled) this.disable(); else this.enable();
    return this.enabled;
  }

  // ─── Settings ───────────────────────────────────────────────────────────

  setType(type) {
    if (!WrinkleSystem.WRINKLE_TYPES[type]) {
      console.error(`[WrinkleSystem] Invalid type: ${type}`);
      return;
    }
    this.currentType = type;
    const typeDef = WrinkleSystem.WRINKLE_TYPES[type];
    this.currentWidth = typeDef.defaultWidth;
    this.currentDepth = typeDef.defaultDepth;
    console.log(`[WrinkleSystem] Type set to: ${type}`);
  }

  setWidth(width) {
    this.currentWidth = Math.max(0.001, Math.min(0.02, width));
  }

  setDepth(depth) {
    this.currentDepth = Math.max(0, Math.min(1, depth));
  }

  setGeometryDisplacement(enabled) {
    this.useGeometryDisplacement = enabled;
    console.log(`[WrinkleSystem] Geometry displacement: ${enabled}`);
  }

  // ─── Raycasting ─────────────────────────────────────────────────────────

  _getNDC(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  _raycastHead() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const headMesh = this.sceneManager.headMesh;
    if (!headMesh) return null;

    const meshes = [];
    headMesh.traverse(c => { if (c.isMesh) meshes.push(c); });

    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.length > 0 ? hits[0] : null;
  }

  // ─── Drawing Interaction ────────────────────────────────────────────────

  _onPointerDown(event) {
    if (!this.enabled) return;

    this._getNDC(event);
    const intersection = this._raycastHead();

    if (intersection) {
      event.preventDefault();
      event.stopImmediatePropagation();

      // Start drawing new line
      this.isDrawing = true;
      this.currentLine = [];
      this.lastScreenPos = { x: event.clientX, y: event.clientY };

      // Add first point
      this._addPointToCurrentLine(intersection);

      // Create preview line
      this._createPreviewLine();
    }
  }

  _onPointerMove(event) {
    if (!this.enabled || !this.isDrawing || !this.currentLine) return;

    this._getNDC(event);
    const intersection = this._raycastHead();

    if (intersection) {
      event.preventDefault();
      event.stopImmediatePropagation();

      // Check if moved enough screen distance to sample a new point
      const screenDist = Math.hypot(
        event.clientX - this.lastScreenPos.x,
        event.clientY - this.lastScreenPos.y
      );

      if (screenDist >= this.minSampleDistance) {
        this._addPointToCurrentLine(intersection);
        this.lastScreenPos = { x: event.clientX, y: event.clientY };
        this._updatePreviewLine();
      }
    }
  }

  _onPointerUp(event) {
    if (!this.enabled || !this.isDrawing || !this.currentLine) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    this.controls.enabled = false;  // Keep disabled for next draw

    // Finalize the line if it has enough points
    if (this.currentLine.length >= 2) {
      this._finalizeWrinkle();
    } else {
      console.warn('[WrinkleSystem] Line too short, discarding');
    }

    // Reset drawing state
    this.isDrawing = false;
    this.currentLine = null;
    this.lastScreenPos = null;
    this._clearPreviewLine();
  }

  _onKeyDown(event) {
    if (!this.enabled) return;

    // ESC to cancel drawing
    if (event.key === 'Escape') {
      if (this.isDrawing) {
        this.isDrawing = false;
        this.currentLine = null;
        this._clearPreviewLine();
      }
    }
  }

  // ─── Point Sampling ─────────────────────────────────────────────────────

  _addPointToCurrentLine(intersection) {
    const headMesh = this.sceneManager.headMesh;
    const point = intersection.point.clone();
    const normal = intersection.face.normal.clone();

    // Transform normal to world space
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(intersection.object.matrixWorld);
    normal.applyMatrix3(normalMatrix).normalize();

    // Convert to local space (relative to head mesh)
    let localPos = point;
    let localNormal = normal;

    if (headMesh) {
      headMesh.updateWorldMatrix(true, false);
      const invMatrix = new THREE.Matrix4().copy(headMesh.matrixWorld).invert();
      localPos = point.clone().applyMatrix4(invMatrix);

      const invNormalMatrix = new THREE.Matrix3().getNormalMatrix(invMatrix);
      localNormal = normal.clone().applyMatrix3(invNormalMatrix).normalize();
    }

    // Get UV coordinate (if available)
    let uv = [0.5, 0.5];
    if (intersection.uv) {
      uv = [intersection.uv.x, intersection.uv.y];
    } else {
      // Fallback: generate UV from position
      uv = this._generateUVFromPosition(localPos);
    }

    // Compute barycentric coordinates for morph tracking
    const baryCoords = this._computeBarycentricCoords(intersection);

    const pointData = {
      position: localPos.toArray(),
      normal: localNormal.toArray(),
      uv: uv,
      anchorBaryCoords: baryCoords,
    };

    this.currentLine.push(pointData);
  }

  _generateUVFromPosition(localPos) {
    // Simple planar projection
    const u = (localPos.x + 1.0) * 0.5;
    const v = (localPos.y + 1.5) * 0.5;
    return [Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v))];
  }

  _computeBarycentricCoords(intersection) {
    if (!intersection.face || intersection.faceIndex === undefined) return null;

    const mesh = intersection.object;
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;
    const idx = geo.index;
    const fi = intersection.faceIndex;

    let a, b, c;
    if (idx) {
      a = idx.getX(fi * 3);
      b = idx.getX(fi * 3 + 1);
      c = idx.getX(fi * 3 + 2);
    } else {
      a = fi * 3;
      b = fi * 3 + 1;
      c = fi * 3 + 2;
    }

    mesh.updateWorldMatrix(true, false);
    const mat = mesh.matrixWorld;

    const vA = new THREE.Vector3(posAttr.getX(a), posAttr.getY(a), posAttr.getZ(a)).applyMatrix4(mat);
    const vB = new THREE.Vector3(posAttr.getX(b), posAttr.getY(b), posAttr.getZ(b)).applyMatrix4(mat);
    const vC = new THREE.Vector3(posAttr.getX(c), posAttr.getY(c), posAttr.getZ(c)).applyMatrix4(mat);

    const bary = new THREE.Vector3();
    new THREE.Triangle(vA, vB, vC).getBarycoord(intersection.point, bary);

    // Find which morpher mesh this is
    let meshIndex = 0;
    if (this.morpher && this.morpher.meshes) {
      for (let m = 0; m < this.morpher.meshes.length; m++) {
        if (this.morpher.meshes[m] === mesh) { meshIndex = m; break; }
      }
    }

    return {
      meshIndex: meshIndex,
      faceIndex: fi,
      vertexIndices: [a, b, c],
      u: bary.x,
      v: bary.y,
      w: bary.z,
    };
  }

  // ─── Line Processing ────────────────────────────────────────────────────

  _finalizeWrinkle() {
    if (!this.currentLine || this.currentLine.length < 2) return;

    console.log(`[WrinkleSystem] Finalizing wrinkle with ${this.currentLine.length} points`);

    // Smooth and resample the line
    const processedPoints = this._smoothAndResample(this.currentLine);

    // Create wrinkle object
    const typeDef = WrinkleSystem.WRINKLE_TYPES[this.currentType];
    const wrinkle = {
      id: this._nextId++,
      type: this.currentType,
      points: processedPoints,
      width: this.currentWidth,
      depth: this.currentDepth,
      color: typeDef.defaultColor,
      useGeometryDisplacement: this.useGeometryDisplacement,
    };

    this.wrinkles.push(wrinkle);

    // Update textures
    this._updateTextures();

    // Always apply geometry displacement for 3D effect
    this._applyAllGeometryDisplacements();

    // Notify
    if (this.onWrinkleChanged) this.onWrinkleChanged();

    console.log('[WrinkleSystem] Wrinkle added:', wrinkle.id);
  }

  _smoothAndResample(points) {
    if (points.length < 3) return points;

    // Simple smoothing: average adjacent points
    const smoothed = [points[0]];  // Keep first point

    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const next = points[i + 1];

      const avgPos = [
        (prev.position[0] + curr.position[0] + next.position[0]) / 3,
        (prev.position[1] + curr.position[1] + next.position[1]) / 3,
        (prev.position[2] + curr.position[2] + next.position[2]) / 3,
      ];

      const avgNormal = [
        (prev.normal[0] + curr.normal[0] + next.normal[0]) / 3,
        (prev.normal[1] + curr.normal[1] + next.normal[1]) / 3,
        (prev.normal[2] + curr.normal[2] + next.normal[2]) / 3,
      ];

      // Normalize the normal
      const len = Math.sqrt(avgNormal[0] ** 2 + avgNormal[1] ** 2 + avgNormal[2] ** 2);
      if (len > 0) {
        avgNormal[0] /= len;
        avgNormal[1] /= len;
        avgNormal[2] /= len;
      }

      smoothed.push({
        position: avgPos,
        normal: avgNormal,
        uv: curr.uv,
        anchorBaryCoords: curr.anchorBaryCoords,
      });
    }

    smoothed.push(points[points.length - 1]);  // Keep last point

    // TODO: Implement uniform resampling if needed
    return smoothed;
  }

  // ─── Preview Line ───────────────────────────────────────────────────────

  _createPreviewLine() {
    this._clearPreviewLine();

    if (!this.currentLine || this.currentLine.length < 2) return;

    const geometry = new THREE.BufferGeometry();
    const material = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });

    this.previewLine = new THREE.Line(geometry, material);
    this.scene.add(this.previewLine);
    this._updatePreviewLine();
  }

  _updatePreviewLine() {
    if (!this.previewLine || !this.currentLine) return;

    const headMesh = this.sceneManager.headMesh;
    const positions = [];

    for (const point of this.currentLine) {
      let worldPos = new THREE.Vector3().fromArray(point.position);

      // Convert from local to world space
      if (headMesh) {
        headMesh.updateWorldMatrix(true, false);
        worldPos.applyMatrix4(headMesh.matrixWorld);
      }

      positions.push(worldPos.x, worldPos.y, worldPos.z);
    }

    this.previewLine.geometry.setAttribute('position',
      new THREE.Float32BufferAttribute(positions, 3));
    this.previewLine.geometry.computeBoundingSphere();
  }

  _clearPreviewLine() {
    if (this.previewLine) {
      this.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      this.previewLine.material.dispose();
      this.previewLine = null;
    }
  }

  // ─── Texture Updates ────────────────────────────────────────────────────

  _updateTextures() {
    if (!this.textureGenerator) {
      console.warn('[WrinkleSystem] No texture generator available');
      return;
    }

    const { normalTexture, displacementTexture } = this.textureGenerator.generateWrinkleTextures(this.wrinkles);

    // Update material
    this.sceneManager.updateWrinkleTextures(normalTexture, displacementTexture);
  }

  // ─── Geometry Displacement ──────────────────────────────────────────────

  /**
   * Apply geometry displacement to create actual 3D wrinkle depth.
   * Creates a valley in the center with slight ridges on the sides.
   */
  _applyAllGeometryDisplacements() {
    const headMesh = this.sceneManager.headMesh;
    if (!headMesh || this.wrinkles.length === 0) return;

    console.log('[WrinkleSystem] Applying geometry displacements for all wrinkles');

    // Store original positions if not already stored
    headMesh.traverse(mesh => {
      if (!mesh.isMesh) return;
      const posAttr = mesh.geometry.attributes.position;

      // Store original positions on first use
      if (!mesh.geometry.userData.originalPositions) {
        mesh.geometry.userData.originalPositions = posAttr.array.slice();
      }

      // Reset to original positions before applying new displacements
      const original = mesh.geometry.userData.originalPositions;
      for (let i = 0; i < posAttr.count * 3; i++) {
        posAttr.array[i] = original[i];
      }
    });

    // Apply displacements for each wrinkle
    headMesh.traverse(mesh => {
      if (!mesh.isMesh) return;

      const posAttr = mesh.geometry.attributes.position;
      const normalAttr = mesh.geometry.attributes.normal;

      for (let i = 0; i < posAttr.count; i++) {
        const vertPos = new THREE.Vector3(
          posAttr.getX(i),
          posAttr.getY(i),
          posAttr.getZ(i)
        );

        // Get vertex normal
        let vertNormal = new THREE.Vector3(0, 0, 1);
        if (normalAttr) {
          vertNormal.set(
            normalAttr.getX(i),
            normalAttr.getY(i),
            normalAttr.getZ(i)
          ).normalize();
        }

        let totalDisplacement = new THREE.Vector3(0, 0, 0);

        // Calculate displacement from all wrinkles
        for (const wrinkle of this.wrinkles) {
          const displacement = this._calculateWrinkleDisplacement(vertPos, vertNormal, wrinkle);
          totalDisplacement.add(displacement);
        }

        // Apply total displacement
        posAttr.setXYZ(
          i,
          vertPos.x + totalDisplacement.x,
          vertPos.y + totalDisplacement.y,
          vertPos.z + totalDisplacement.z
        );
      }

      // Mark geometry as needing update
      posAttr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    });

    console.log('[WrinkleSystem] Geometry displacements applied');
  }

  /**
   * Calculate displacement for a single vertex from a single wrinkle.
   * Creates a valley (inward) at center with slight ridges on edges.
   */
  _calculateWrinkleDisplacement(vertPos, vertNormal, wrinkle) {
    const displacement = new THREE.Vector3(0, 0, 0);

    // Find distance to wrinkle line
    const dist = this._distanceToPolyline(vertPos, wrinkle.points);

    // Influence radius based on wrinkle width
    const influenceRadius = wrinkle.width * 5;  // Wider influence area

    if (dist > influenceRadius) {
      return displacement;  // Too far, no effect
    }

    // Get wrinkle type settings
    const typeDef = WrinkleSystem.WRINKLE_TYPES[wrinkle.type] || WrinkleSystem.WRINKLE_TYPES['fine'];

    // Depth multipliers based on type (increased for more visible effect)
    const depthMultipliers = {
      fine: 0.006,      // Fine lines - visible but subtle
      deep: 0.015,      // Pronounced deep wrinkles
      stretch: 0.008,   // Medium stretch marks
      scar: 0.012,      // Moderately deep scars
    };

    const baseDepth = depthMultipliers[wrinkle.type] || 0.008;
    const maxDepth = baseDepth * wrinkle.depth;

    // Normalized distance (0 at center, 1 at edge of influence)
    const normalizedDist = dist / influenceRadius;

    // Create wrinkle profile: valley in center with ridges on sides
    // Using a modified profile for realistic wrinkle appearance
    const valleyWidth = 0.35;  // Center valley takes 35% of total width
    const ridgeWidth = 0.35;   // Ridge zone 35-70%

    let profile;
    if (normalizedDist < valleyWidth) {
      // Center valley - push inward (negative)
      const t = normalizedDist / valleyWidth;
      profile = -Math.cos(t * Math.PI * 0.5);  // Smooth valley bottom
    } else if (normalizedDist < valleyWidth + ridgeWidth) {
      // Ridge zone - slight outward push (positive) for raised edges
      const t = (normalizedDist - valleyWidth) / ridgeWidth;
      profile = 0.35 * Math.sin(t * Math.PI);  // Raised ridge effect
    } else {
      // Fade out zone - smooth transition to flat
      const t = (normalizedDist - valleyWidth - ridgeWidth) / (1 - valleyWidth - ridgeWidth);
      profile = 0.35 * (1 - t) * Math.sin(Math.PI * 0.5);  // Fade to zero
    }

    // Apply displacement along vertex normal
    const displaceAmount = profile * maxDepth;
    displacement.copy(vertNormal).multiplyScalar(displaceAmount);

    return displacement;
  }

  _applyGeometryDisplacement(wrinkle) {
    // Just apply all displacements - simpler to recalculate everything
    this._applyAllGeometryDisplacements();
  }

  /**
   * Clear all geometry displacements and restore original mesh
   */
  _clearGeometryDisplacements() {
    const headMesh = this.sceneManager.headMesh;
    if (!headMesh) return;

    headMesh.traverse(mesh => {
      if (!mesh.isMesh) return;
      const posAttr = mesh.geometry.attributes.position;
      const original = mesh.geometry.userData.originalPositions;

      if (original) {
        for (let i = 0; i < posAttr.count * 3; i++) {
          posAttr.array[i] = original[i];
        }
        posAttr.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
      }
    });
  }

  _distanceToPolyline(point, wrinklePoints) {
    let minDist = Infinity;

    for (let i = 0; i < wrinklePoints.length - 1; i++) {
      const p1 = new THREE.Vector3().fromArray(wrinklePoints[i].position);
      const p2 = new THREE.Vector3().fromArray(wrinklePoints[i + 1].position);

      const dist = this._distanceToSegment(point, p1, p2);
      minDist = Math.min(minDist, dist);
    }

    return minDist;
  }

  _distanceToSegment(point, segStart, segEnd) {
    const segment = new THREE.Vector3().subVectors(segEnd, segStart);
    const toPoint = new THREE.Vector3().subVectors(point, segStart);

    const segmentLengthSq = segment.lengthSq();
    if (segmentLengthSq === 0) {
      return point.distanceTo(segStart);
    }

    const t = Math.max(0, Math.min(1, toPoint.dot(segment) / segmentLengthSq));
    const projection = new THREE.Vector3().copy(segStart).addScaledVector(segment, t);

    return point.distanceTo(projection);
  }

  _interpolateNormalAtPoint(point, wrinklePoints) {
    // Find closest point on polyline and return its normal
    let minDist = Infinity;
    let closestPointIndex = 0;

    for (let i = 0; i < wrinklePoints.length; i++) {
      const p = new THREE.Vector3().fromArray(wrinklePoints[i].position);
      const dist = point.distanceTo(p);
      if (dist < minDist) {
        minDist = dist;
        closestPointIndex = i;
      }
    }

    return new THREE.Vector3().fromArray(wrinklePoints[closestPointIndex].normal);
  }

  // ─── Morphing Persistence ───────────────────────────────────────────────

  refreshWrinklesAfterMorph() {
    if (!this.morpher || !this.morpher.meshes) return;
    if (this.wrinkles.length === 0) return;

    console.log('[WrinkleSystem] Refreshing wrinkles after morph');

    const headMesh = this.sceneManager.headMesh;
    let invMatrix = null;
    let invNormalMatrix = null;

    if (headMesh) {
      headMesh.updateWorldMatrix(true, false);
      invMatrix = new THREE.Matrix4().copy(headMesh.matrixWorld).invert();
      invNormalMatrix = new THREE.Matrix3().getNormalMatrix(invMatrix);
    }

    // Clear stored original positions so displacements use the new morphed state
    headMesh.traverse(mesh => {
      if (mesh.isMesh && mesh.geometry.userData.originalPositions) {
        delete mesh.geometry.userData.originalPositions;
      }
    });

    for (const wrinkle of this.wrinkles) {
      for (const point of wrinkle.points) {
        const bary = point.anchorBaryCoords;
        if (!bary) continue;

        // Reconstruct position from barycentric coords
        const result = this._reconstructPositionFromBary(bary, invMatrix, invNormalMatrix);
        if (result) {
          point.position = result.position.toArray();
          point.normal = result.normal.toArray();
        }
      }
    }

    // Regenerate textures
    this._updateTextures();

    // Apply geometry displacement for 3D effect
    this._applyAllGeometryDisplacements();
  }

  _reconstructPositionFromBary(bary, invMatrix, invNormalMatrix) {
    if (!bary || !this.morpher.meshes[bary.meshIndex]) return null;

    const srcMesh = this.morpher.meshes[bary.meshIndex];
    const posAttr = srcMesh.geometry.attributes.position;
    const [ia, ib, ic] = bary.vertexIndices;

    // Validate indices
    if (ia >= posAttr.count || ib >= posAttr.count || ic >= posAttr.count) {
      return null;
    }

    srcMesh.updateWorldMatrix(true, false);
    const mat = srcMesh.matrixWorld;

    const vA = new THREE.Vector3(posAttr.getX(ia), posAttr.getY(ia), posAttr.getZ(ia)).applyMatrix4(mat);
    const vB = new THREE.Vector3(posAttr.getX(ib), posAttr.getY(ib), posAttr.getZ(ib)).applyMatrix4(mat);
    const vC = new THREE.Vector3(posAttr.getX(ic), posAttr.getY(ic), posAttr.getZ(ic)).applyMatrix4(mat);

    // Check for degenerate triangle
    const edge1 = new THREE.Vector3().subVectors(vB, vA);
    const edge2 = new THREE.Vector3().subVectors(vC, vA);
    const crossVec = new THREE.Vector3().crossVectors(edge1, edge2);
    const triangleArea = crossVec.length() * 0.5;

    if (triangleArea < 0.00001) {
      return null;  // Degenerate triangle
    }

    // Reconstruct position
    const newWorldPos = new THREE.Vector3()
      .addScaledVector(vA, bary.u)
      .addScaledVector(vB, bary.v)
      .addScaledVector(vC, bary.w);

    // Reconstruct normal
    const newWorldNormal = crossVec.normalize();

    // Convert to local space
    let localPos = newWorldPos;
    let localNormal = newWorldNormal;

    if (invMatrix) {
      localPos = newWorldPos.clone().applyMatrix4(invMatrix);
      localNormal = newWorldNormal.clone().applyMatrix3(invNormalMatrix).normalize();
    }

    return { position: localPos, normal: localNormal };
  }

  // ─── Preset Patterns ────────────────────────────────────────────────────

  applyPreset(presetName) {
    console.log(`[WrinkleSystem] Applying preset: ${presetName}`);

    const pattern = this._getPresetPattern(presetName);
    if (!pattern) {
      console.error(`[WrinkleSystem] Unknown preset: ${presetName}`);
      return;
    }

    // Add each line in the pattern
    for (const lineTemplate of pattern) {
      const wrinkle = this._createWrinkleFromTemplate(lineTemplate);
      this.wrinkles.push(wrinkle);
    }

    this._updateTextures();
    if (this.onWrinkleChanged) this.onWrinkleChanged();
  }

  _getPresetPattern(name) {
    // TODO: Implement preset patterns using facial landmarks
    // For now, return null (to be implemented)
    console.warn('[WrinkleSystem] Preset patterns not yet implemented');
    return null;
  }

  _createWrinkleFromTemplate(template) {
    // TODO: Create wrinkle from template coordinates
    return null;
  }

  // ─── Management ─────────────────────────────────────────────────────────

  clearAll() {
    this.wrinkles = [];
    this._updateTextures();
    this._clearGeometryDisplacements();
    if (this.onWrinkleChanged) this.onWrinkleChanged();
    console.log('[WrinkleSystem] All wrinkles cleared');
  }

  // ─── Serialization ──────────────────────────────────────────────────────

  exportState() {
    return this.wrinkles.map(w => ({
      id: w.id,
      type: w.type,
      points: w.points,
      width: w.width,
      depth: w.depth,
      color: w.color,
      useGeometryDisplacement: w.useGeometryDisplacement,
    }));
  }

  loadState(wrinkleArray) {
    if (!wrinkleArray || !Array.isArray(wrinkleArray)) {
      this.wrinkles = [];
    } else {
      this.wrinkles = wrinkleArray.map(w => ({ ...w }));
    }

    this._updateTextures();

    // Always apply geometry displacement for 3D effect
    if (this.wrinkles.length > 0) {
      this._applyAllGeometryDisplacements();
    } else {
      this._clearGeometryDisplacements();
    }

    if (this.onWrinkleChanged) this.onWrinkleChanged();
    console.log(`[WrinkleSystem] Loaded ${this.wrinkles.length} wrinkles`);
  }
}

// Export to global scope
window.WrinkleSystem = WrinkleSystem;
