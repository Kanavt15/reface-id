/**
 * SkinMarkSystem.js
 * Manages placement, selection, movement, and deletion of skin marks
 * (moles, pimples, scars, birthmarks, wounds) on the 3D face mesh.
 *
 * Marks are small Three.js meshes placed on the face surface via raycasting.
 * They track their position using barycentric coordinates within the hit
 * triangle, so they survive face morphing (vertex deformation).
 */

class SkinMarkSystem {
  constructor(sceneManager, objMorpher) {
    this.sceneManager = sceneManager;
    this.scene = sceneManager.scene;
    this.camera = sceneManager.camera;
    this.canvas = sceneManager.canvas;
    this.controls = sceneManager.controls;
    this.morpher = objMorpher;

    // All placed marks
    this.marks = [];
    this.markMeshes = [];

    // Three.js group for all mark meshes - will be attached to head mesh
    this.markGroup = new THREE.Group();
    this.markGroup.name = 'SkinMarks';

    // Attach to head mesh if available, otherwise to scene (will re-attach later)
    this._attachToHeadMesh();

    // Interaction state
    this.enabled = false;
    this.activeMarkType = 'mole';
    this.selectedMarkIndex = -1;
    this.isDragging = false;

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Callbacks
    this.onMarkChanged = null;

    // Bound event handlers
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    // ID counter
    this._nextId = 1;
  }

  /**
   * Attach the mark group to the head mesh so marks move with the model.
   */
  _attachToHeadMesh() {
    const headMesh = this.sceneManager.headMesh;

    // Remove from current parent first
    if (this.markGroup.parent) {
      this.markGroup.parent.remove(this.markGroup);
    }

    if (headMesh) {
      // Attach to head mesh - marks will move with the model
      headMesh.add(this.markGroup);
      this._isAttachedToHead = true;
      console.log('[SkinMarkSystem] markGroup attached to headMesh');
    } else {
      // Fallback: attach to scene (marks won't move with model)
      this.scene.add(this.markGroup);
      this._isAttachedToHead = false;
      console.warn('[SkinMarkSystem] markGroup attached to SCENE (headMesh not available)');
    }
  }

  /**
   * Ensure marks are attached to head mesh (call after model loads).
   */
  ensureAttachedToHead() {
    const headMesh = this.sceneManager.headMesh;
    if (!this._isAttachedToHead && headMesh) {
      console.log('[SkinMarkSystem] Re-attaching to headMesh...');
      this._attachToHeadMesh();
      // Reposition existing marks to local space
      this._convertMarksToLocalSpace();
    } else if (this._isAttachedToHead && headMesh && this.markGroup.parent !== headMesh) {
      // Fix: markGroup says attached but parent is wrong - re-attach
      console.warn('[SkinMarkSystem] Parent mismatch detected, re-attaching...');
      this._attachToHeadMesh();
      this._convertMarksToLocalSpace();
    }
  }

  /**
   * Convert existing marks from world space to local space relative to head mesh.
   */
  _convertMarksToLocalSpace() {
    const headMesh = this.sceneManager.headMesh;
    if (!headMesh) return;

    headMesh.updateWorldMatrix(true, false);
    const invMatrix = new THREE.Matrix4().copy(headMesh.matrixWorld).invert();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(invMatrix);

    for (let i = 0; i < this.marks.length; i++) {
      const markData = this.marks[i];
      const mesh = this.markMeshes[i];

      // Convert position to local space
      const worldPos = new THREE.Vector3().fromArray(markData.position);
      const localPos = worldPos.applyMatrix4(invMatrix);
      markData.position = localPos.toArray();

      // Convert normal to local space
      const worldNormal = new THREE.Vector3().fromArray(markData.normal);
      const localNormal = worldNormal.applyMatrix3(normalMatrix).normalize();
      markData.normal = localNormal.toArray();

      // Re-orient the mesh
      this._orientMark(mesh, markData);
    }
  }

  // ─── Mark Type Definitions ──────────────────────────────────────────────

  static get MARK_TYPES() {
    return {
      mole: {
        label: 'Mole / Beauty Mark',
        icon: 'fa-circle',
        createGeometry: (size) => new THREE.CircleGeometry(size, 16),
        defaultColor: '#3a2010',
        defaultSize: 0.015,
        roughness: 0.7,
        metalness: 0.0,
        raised: false,
      },
      pimple: {
        label: 'Pimple',
        icon: 'fa-dot-circle',
        createGeometry: (size) => new THREE.SphereGeometry(size, 12, 8),
        defaultColor: '#c45555',
        defaultSize: 0.012,
        roughness: 0.5,
        metalness: 0.0,
        raised: true,
      },
      scar: {
        label: 'Scar',
        icon: 'fa-slash',
        createGeometry: (size) => new THREE.PlaneGeometry(size * 3, size * 0.4),
        defaultColor: '#c9a0a0',
        defaultSize: 0.02,
        roughness: 0.8,
        metalness: 0.0,
        raised: false,
      },
      birthmark: {
        label: 'Birthmark',
        icon: 'fa-cloud',
        createGeometry: (size) => {
          const geo = new THREE.CircleGeometry(size, 8);
          const pos = geo.attributes.position;
          for (let i = 1; i < pos.count; i++) {
            const angle = Math.atan2(pos.getY(i), pos.getX(i));
            const noise = 0.7 + 0.3 * Math.sin(angle * 3.7 + 1.3);
            pos.setX(i, pos.getX(i) * noise);
            pos.setY(i, pos.getY(i) * noise);
          }
          pos.needsUpdate = true;
          return geo;
        },
        defaultColor: '#8b5a3a',
        defaultSize: 0.04,
        roughness: 0.65,
        metalness: 0.0,
        raised: false,
      },
      wound: {
        label: 'Wound',
        icon: 'fa-band-aid',
        createGeometry: (size) => new THREE.PlaneGeometry(size * 2, size),
        defaultColor: '#8b2020',
        defaultSize: 0.025,
        roughness: 0.4,
        metalness: 0.05,
        raised: false,
      },
    };
  }

  // ─── Enable / Disable ───────────────────────────────────────────────────

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.canvas.addEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.addEventListener('pointermove', this._onPointerMove, true);
    this.canvas.addEventListener('pointerup', this._onPointerUp, true);
    window.addEventListener('keydown', this._onKeyDown);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.selectedMarkIndex = -1;
    this.isDragging = false;
    this.canvas.removeEventListener('pointerdown', this._onPointerDown, true);
    this.canvas.removeEventListener('pointermove', this._onPointerMove, true);
    this.canvas.removeEventListener('pointerup', this._onPointerUp, true);
    window.removeEventListener('keydown', this._onKeyDown);
    this.controls.enabled = true;
    this._clearSelection();
  }

  toggle() {
    if (this.enabled) this.disable(); else this.enable();
    return this.enabled;
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

  _raycastMarks() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if (this.markGroup.children.length === 0) return null;
    const hits = this.raycaster.intersectObjects(this.markGroup.children, false);
    return hits.length > 0 ? hits[0] : null;
  }

  // ─── Adding Marks ───────────────────────────────────────────────────────

  addMark(intersection) {
    const typeDef = SkinMarkSystem.MARK_TYPES[this.activeMarkType];
    if (!typeDef) return null;

    // Ensure we're attached to head mesh
    this.ensureAttachedToHead();

    // Verify attachment worked
    if (!this._isAttachedToHead) {
      console.error('[SkinMarkSystem] Failed to attach to headMesh - marks may not move correctly');
    }

    const headMesh = this.sceneManager.headMesh;
    const point = intersection.point.clone();
    const normal = intersection.face.normal.clone();

    // Transform normal to world space first
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(intersection.object.matrixWorld);
    normal.applyMatrix3(normalMatrix).normalize();

    // Convert world position and normal to local space (relative to head mesh)
    let localPos = point;
    let localNormal = normal;

    if (headMesh && this._isAttachedToHead) {
      headMesh.updateWorldMatrix(true, false);
      const invMatrix = new THREE.Matrix4().copy(headMesh.matrixWorld).invert();
      localPos = point.clone().applyMatrix4(invMatrix);

      const invNormalMatrix = new THREE.Matrix3().getNormalMatrix(invMatrix);
      localNormal = normal.clone().applyMatrix3(invNormalMatrix).normalize();
    }

    const anchorVertex = this._findNearestVertex(point); // Still uses world space for finding
    const baryCoords = this._computeBarycentricCoords(intersection);

    const markData = {
      id: this._nextId++,
      type: this.activeMarkType,
      position: localPos.toArray(),  // Store in local space
      normal: localNormal.toArray(),  // Store in local space
      size: typeDef.defaultSize,
      color: typeDef.defaultColor,
      rotation: 0,
      anchorVertexIndex: anchorVertex,
      anchorBaryCoords: baryCoords,
    };

    this.marks.push(markData);

    const mesh = this._createMarkMesh(markData);
    this.markMeshes.push(mesh);
    this.markGroup.add(mesh);

    // Debug: log parent chain
    console.log('[SkinMarkSystem] Mark added. Parent chain:',
      'mesh.parent:', mesh.parent?.name,
      '-> markGroup.parent:', this.markGroup.parent?.name,
      '-> attached:', this._isAttachedToHead);

    if (this.onMarkChanged) this.onMarkChanged();
    return markData;
  }

  // ─── Mesh Creation ──────────────────────────────────────────────────────

  _createMarkMesh(markData) {
    const typeDef = SkinMarkSystem.MARK_TYPES[markData.type];
    if (!typeDef) return null;

    const geometry = typeDef.createGeometry(markData.size);

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(markData.color),
      roughness: typeDef.roughness,
      metalness: typeDef.metalness,
      side: THREE.DoubleSide,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.markId = markData.id;
    mesh.renderOrder = 10;

    this._orientMark(mesh, markData);
    return mesh;
  }

  _orientMark(mesh, markData) {
    const pos = new THREE.Vector3().fromArray(markData.position);
    const normal = new THREE.Vector3().fromArray(markData.normal);

    const typeDef = SkinMarkSystem.MARK_TYPES[markData.type];
    const offset = typeDef && typeDef.raised ? markData.size * 0.5 : 0.001;
    mesh.position.copy(pos).addScaledVector(normal, offset);

    // Orient mesh so its local Z axis aligns with surface normal
    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.quaternion.copy(quaternion);

    // Apply user rotation around the normal axis
    if (markData.rotation !== 0) {
      const rotQ = new THREE.Quaternion().setFromAxisAngle(normal, markData.rotation);
      mesh.quaternion.premultiply(rotQ);
    }
  }

  // ─── Selection ──────────────────────────────────────────────────────────

  selectMark(index) {
    this._clearSelection();
    if (index < 0 || index >= this.marks.length) return;
    this.selectedMarkIndex = index;
    const mesh = this.markMeshes[index];
    if (mesh && mesh.material) {
      mesh.material.emissive = new THREE.Color(0x7aa2f7);
      mesh.material.emissiveIntensity = 0.4;
    }
    if (this.onMarkChanged) this.onMarkChanged();
  }

  _clearSelection() {
    if (this.selectedMarkIndex >= 0 && this.selectedMarkIndex < this.markMeshes.length) {
      const mesh = this.markMeshes[this.selectedMarkIndex];
      if (mesh && mesh.material) {
        mesh.material.emissive = new THREE.Color(0x000000);
        mesh.material.emissiveIntensity = 0;
      }
    }
    this.selectedMarkIndex = -1;
  }

  // ─── Update / Delete ────────────────────────────────────────────────────

  updateSelectedMark(property, value) {
    if (this.selectedMarkIndex < 0) return;
    const markData = this.marks[this.selectedMarkIndex];
    const mesh = this.markMeshes[this.selectedMarkIndex];
    if (!markData || !mesh) return;

    switch (property) {
      case 'size':
        markData.size = value;
        const typeDef = SkinMarkSystem.MARK_TYPES[markData.type];
        if (typeDef) {
          mesh.geometry.dispose();
          mesh.geometry = typeDef.createGeometry(value);
        }
        this._orientMark(mesh, markData);
        break;
      case 'color':
        markData.color = value;
        mesh.material.color.set(value);
        break;
      case 'rotation':
        markData.rotation = value;
        this._orientMark(mesh, markData);
        break;
    }

    if (this.onMarkChanged) this.onMarkChanged();
  }

  deleteSelectedMark() {
    if (this.selectedMarkIndex < 0) return;
    const mesh = this.markMeshes[this.selectedMarkIndex];
    this.markGroup.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    this.marks.splice(this.selectedMarkIndex, 1);
    this.markMeshes.splice(this.selectedMarkIndex, 1);
    this.selectedMarkIndex = -1;
    if (this.onMarkChanged) this.onMarkChanged();
  }

  // ─── Pointer Events ─────────────────────────────────────────────────────

  _onPointerDown(event) {
    if (event.button !== 0) return;
    this._getNDC(event);

    // First: check if clicking an existing mark
    const markHit = this._raycastMarks();
    if (markHit) {
      event.preventDefault();
      event.stopPropagation();
      const idx = this.markMeshes.findIndex(m => m === markHit.object);
      if (idx >= 0) {
        this.selectMark(idx);
        this.isDragging = true;
        this.controls.enabled = false;
      }
      return;
    }

    // Second: check if clicking the face to place a new mark
    const faceHit = this._raycastHead();
    if (faceHit) {
      event.preventDefault();
      event.stopPropagation();
      this._clearSelection();
      this.addMark(faceHit);
      this.controls.enabled = false;
    }
  }

  _onPointerMove(event) {
    if (!this.isDragging || this.selectedMarkIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();

    this._getNDC(event);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Raycast against head to find new surface point
    const headMesh = this.sceneManager.headMesh;
    if (!headMesh) return;

    const meshes = [];
    headMesh.traverse(c => { if (c.isMesh) meshes.push(c); });
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return;

    const faceHit = hits[0];
    const markData = this.marks[this.selectedMarkIndex];

    // Get world space position and normal
    const worldPos = faceHit.point.clone();
    const worldNormal = faceHit.face.normal.clone();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(faceHit.object.matrixWorld);
    worldNormal.applyMatrix3(normalMatrix).normalize();

    // Convert to local space if attached to head mesh
    let localPos = worldPos;
    let localNormal = worldNormal;

    if (this._isAttachedToHead) {
      headMesh.updateWorldMatrix(true, false);
      const invMatrix = new THREE.Matrix4().copy(headMesh.matrixWorld).invert();
      localPos = worldPos.clone().applyMatrix4(invMatrix);

      const invNormalMatrix = new THREE.Matrix3().getNormalMatrix(invMatrix);
      localNormal = worldNormal.clone().applyMatrix3(invNormalMatrix).normalize();
    }

    markData.position = localPos.toArray();
    markData.normal = localNormal.toArray();
    markData.anchorVertexIndex = this._findNearestVertex(worldPos);  // Uses world space
    markData.anchorBaryCoords = this._computeBarycentricCoords(faceHit);

    this._orientMark(this.markMeshes[this.selectedMarkIndex], markData);
  }

  _onPointerUp(event) {
    if (event.button !== 0) return;
    if (this.isDragging) {
      event.stopPropagation();
    }
    this.isDragging = false;
    this.controls.enabled = true;
    if (this.onMarkChanged) this.onMarkChanged();
  }

  _onKeyDown(event) {
    if (!this.enabled) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selectedMarkIndex >= 0) {
        event.preventDefault();
        this.deleteSelectedMark();
      }
    }
    if (event.key === 'Escape') {
      this._clearSelection();
      if (this.onMarkChanged) this.onMarkChanged();
    }
  }

  // ─── Vertex / Barycentric Helpers ───────────────────────────────────────

  _findNearestVertex(worldPoint) {
    if (!this.morpher || !this.morpher.meshes) return 0;

    let bestDist = Infinity;
    let bestGlobal = 0;

    for (let m = 0; m < this.morpher.meshes.length; m++) {
      const mesh = this.morpher.meshes[m];
      const posAttr = mesh.geometry.attributes.position;
      const offset = this.morpher.vertexOffsets[m];

      mesh.updateWorldMatrix(true, false);
      const invMatrix = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      const localPoint = worldPoint.clone().applyMatrix4(invMatrix);

      for (let i = 0; i < posAttr.count; i++) {
        const dx = posAttr.getX(i) - localPoint.x;
        const dy = posAttr.getY(i) - localPoint.y;
        const dz = posAttr.getZ(i) - localPoint.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDist) {
          bestDist = d2;
          bestGlobal = offset + i;
        }
      }
    }

    return bestGlobal;
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

  // ─── Morph Tracking ─────────────────────────────────────────────────────

  refreshMarksAfterMorph() {
    if (!this.morpher || !this.morpher.meshes) return;

    // Get inverse matrix for converting world to local (if attached to head)
    const headMesh = this.sceneManager.headMesh;
    let invMatrix = null;
    let invNormalMatrix = null;

    if (headMesh && this._isAttachedToHead) {
      headMesh.updateWorldMatrix(true, false);
      invMatrix = new THREE.Matrix4().copy(headMesh.matrixWorld).invert();
      invNormalMatrix = new THREE.Matrix3().getNormalMatrix(invMatrix);
    }

    for (let i = 0; i < this.marks.length; i++) {
      const markData = this.marks[i];
      const mesh = this.markMeshes[i];
      const bary = markData.anchorBaryCoords;

      if (bary && bary.vertexIndices && this.morpher.meshes[bary.meshIndex]) {
        const srcMesh = this.morpher.meshes[bary.meshIndex];
        const posAttr = srcMesh.geometry.attributes.position;
        const [ia, ib, ic] = bary.vertexIndices;

        // Validate vertex indices
        if (ia >= posAttr.count || ib >= posAttr.count || ic >= posAttr.count) {
          this._refreshMarkFallback(markData, mesh, invMatrix, invNormalMatrix);
          continue;
        }

        srcMesh.updateWorldMatrix(true, false);
        const mat = srcMesh.matrixWorld;

        const vA = new THREE.Vector3(posAttr.getX(ia), posAttr.getY(ia), posAttr.getZ(ia)).applyMatrix4(mat);
        const vB = new THREE.Vector3(posAttr.getX(ib), posAttr.getY(ib), posAttr.getZ(ib)).applyMatrix4(mat);
        const vC = new THREE.Vector3(posAttr.getX(ic), posAttr.getY(ic), posAttr.getZ(ic)).applyMatrix4(mat);

        // Check for degenerate triangle (too small or collinear)
        const edge1 = new THREE.Vector3().subVectors(vB, vA);
        const edge2 = new THREE.Vector3().subVectors(vC, vA);
        const crossVec = new THREE.Vector3().crossVectors(edge1, edge2);
        const triangleArea = crossVec.length() * 0.5;

        if (triangleArea < 0.00001) {
          // Triangle is degenerate, fall back to nearest vertex
          this._refreshMarkFallback(markData, mesh, invMatrix, invNormalMatrix);
          continue;
        }

        // Reconstruct position from barycentric coords (in world space)
        const newWorldPos = new THREE.Vector3()
          .addScaledVector(vA, bary.u)
          .addScaledVector(vB, bary.v)
          .addScaledVector(vC, bary.w);

        // Reconstruct surface normal from triangle (in world space)
        const newWorldNormal = crossVec.normalize();

        // Validate barycentric coordinates sum to ~1 (within tolerance)
        const barySum = bary.u + bary.v + bary.w;
        if (Math.abs(barySum - 1.0) > 0.01) {
          // Barycentric coords are invalid, fall back
          this._refreshMarkFallback(markData, mesh, invMatrix, invNormalMatrix);
          continue;
        }

        // Convert to local space if attached to head mesh
        let localPos = newWorldPos;
        let localNormal = newWorldNormal;

        if (invMatrix) {
          localPos = newWorldPos.clone().applyMatrix4(invMatrix);
          localNormal = newWorldNormal.clone().applyMatrix3(invNormalMatrix).normalize();
        }

        markData.position = localPos.toArray();
        markData.normal = localNormal.toArray();
        this._orientMark(mesh, markData);
      } else {
        // Fallback: nearest vertex
        this._refreshMarkFallback(markData, mesh, invMatrix, invNormalMatrix);
      }
    }
  }

  _refreshMarkFallback(markData, mesh, invMatrix, invNormalMatrix) {
    const worldPos = this._getVertexWorldPosition(markData.anchorVertexIndex);
    if (worldPos) {
      // Try to recalculate normal from mesh
      const normal = this._estimateNormalAtPoint(worldPos);

      // Convert to local space if matrix provided
      let localPos = worldPos;
      let localNormal = normal;

      if (invMatrix) {
        localPos = worldPos.clone().applyMatrix4(invMatrix);
        if (normal && invNormalMatrix) {
          localNormal = normal.clone().applyMatrix3(invNormalMatrix).normalize();
        }
      }

      markData.position = localPos.toArray();
      if (localNormal) {
        markData.normal = localNormal.toArray();
      }
      this._orientMark(mesh, markData);
    }
  }

  _estimateNormalAtPoint(worldPoint) {
    if (!this.morpher || !this.morpher.meshes) return null;

    const raycaster = new THREE.Raycaster();
    raycaster.ray.origin.copy(worldPoint);
    raycaster.ray.direction.normalize();

    for (let m = 0; m < this.morpher.meshes.length; m++) {
      const mesh = this.morpher.meshes[m];
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length > 0) {
        const normal = hits[0].face.normal.clone();
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
        return normal.applyMatrix3(normalMatrix).normalize();
      }
    }
    return null;
  }

  _getVertexWorldPosition(globalIndex) {
    if (!this.morpher || !this.morpher.meshes) return null;

    for (let m = 0; m < this.morpher.meshes.length; m++) {
      const offset = this.morpher.vertexOffsets[m];
      const mesh = this.morpher.meshes[m];
      const posAttr = mesh.geometry.attributes.position;
      if (globalIndex >= offset && globalIndex < offset + posAttr.count) {
        const li = globalIndex - offset;
        const pos = new THREE.Vector3(posAttr.getX(li), posAttr.getY(li), posAttr.getZ(li));
        mesh.updateWorldMatrix(true, false);
        pos.applyMatrix4(mesh.matrixWorld);
        return pos;
      }
    }
    return null;
  }

  // ─── Serialization ──────────────────────────────────────────────────────

  exportState() {
    return this.marks.map(m => ({ ...m }));
  }

  loadState(marksArray) {
    this.clearAll();
    if (!marksArray || !Array.isArray(marksArray)) return;

    // Ensure we're attached to head mesh
    this.ensureAttachedToHead();

    for (const markData of marksArray) {
      if (markData.id >= this._nextId) this._nextId = markData.id + 1;
      const data = { ...markData };
      this.marks.push(data);
      const mesh = this._createMarkMesh(data);
      if (mesh) {
        this.markMeshes.push(mesh);
        this.markGroup.add(mesh);
      }
    }

    if (this.onMarkChanged) this.onMarkChanged();
  }

  clearAll() {
    for (const mesh of this.markMeshes) {
      this.markGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.marks = [];
    this.markMeshes = [];
    this.selectedMarkIndex = -1;
    if (this.onMarkChanged) this.onMarkChanged();
  }

  getMarkCount() {
    return this.marks.length;
  }
}

window.SkinMarkSystem = SkinMarkSystem;
