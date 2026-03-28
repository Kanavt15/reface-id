/**
 * DecalSystem.js
 * Manages placement, selection, transformation, and deletion of image decals
 * (tattoos, birthmarks, skin graphics) on the 3D face mesh using DecalGeometry.
 *
 * Decals conform to face curvature via THREE.DecalGeometry projection.
 * They survive morphing by storing placement params and rebuilding geometry.
 */

class DecalSystem {
  constructor(sceneManager, objMorpher) {
    this.sceneManager = sceneManager;
    this.scene = sceneManager.scene;
    this.camera = sceneManager.camera;
    this.canvas = sceneManager.canvas;
    this.controls = sceneManager.controls;
    this.morpher = objMorpher;

    // All placed decals — data records
    this.decals = [];
    // Corresponding THREE.Mesh objects
    this.decalMeshes = [];

    // Scene group for all decal meshes
    this.decalGroup = new THREE.Group();
    this.decalGroup.name = 'Decals';
    this.scene.add(this.decalGroup);

    // Uploaded texture registry: { id, name, texture, thumbnail (dataURL) }
    this.textures = [];
    this._nextTextureId = 1;

    // Active texture ID selected for placement
    this.activeTextureId = null;

    // Interaction state
    this.enabled = false;        // placement mode active
    this.selectedDecalIndex = -1;

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Callbacks
    this.onDecalChanged = null;
    this.onDecalPlaced = null;

    // Bound event handlers
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    // ID counter for decals
    this._nextId = 1;

    // Limits
    this.MAX_DECALS = 10;
    this.MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
  }

  // ─── Enable / Disable (placement mode) ─────────────────────────────────

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.canvas.addEventListener('pointerdown', this._onPointerDown, true);
    window.addEventListener('keydown', this._onKeyDown);
    this.canvas.style.cursor = 'crosshair';
    console.log('[DecalSystem] Placement mode enabled');
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this._clearSelection();
    this.canvas.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('keydown', this._onKeyDown);
    this.canvas.style.cursor = '';
    this.controls.enabled = true;
    console.log('[DecalSystem] Placement mode disabled');
  }

  toggle() {
    if (this.enabled) this.disable(); else this.enable();
    return this.enabled;
  }

  // ─── Texture Upload ────────────────────────────────────────────────────

  /**
   * Upload an image file and register it as a decal texture.
   * @param {File} file - PNG/JPEG/WEBP file
   * @returns {Promise<Object>} texture registry entry { id, name, texture, thumbnail }
   */
  async uploadTexture(file) {
    if (!file) return null;

    // Validate type
    const validTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      console.error('[DecalSystem] Invalid file type:', file.type);
      return null;
    }

    // Validate size
    if (file.size > this.MAX_FILE_SIZE) {
      console.error('[DecalSystem] File too large:', (file.size / 1024 / 1024).toFixed(1), 'MB');
      return null;
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataURL = e.target.result;

        // Create texture from data URL
        const img = new Image();
        img.onload = () => {
          const texture = new THREE.Texture(img);
          texture.needsUpdate = true;
          texture.colorSpace = THREE.SRGBColorSpace;

          // Generate thumbnail (64x64)
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.width = 64;
          thumbCanvas.height = 64;
          const ctx = thumbCanvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 64, 64);
          const thumbnail = thumbCanvas.toDataURL('image/png');

          const entry = {
            id: this._nextTextureId++,
            name: file.name,
            texture: texture,
            thumbnail: thumbnail,
            dataURL: dataURL,
          };

          this.textures.push(entry);
          this.activeTextureId = entry.id;

          console.log(`[DecalSystem] Texture uploaded: ${file.name} (${img.width}x${img.height})`);
          resolve(entry);
        };
        img.src = dataURL;
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * Get a texture entry by ID.
   */
  getTexture(textureId) {
    return this.textures.find(t => t.id === textureId) || null;
  }

  // ─── Raycasting ────────────────────────────────────────────────────────

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

  _raycastDecals() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if (this.decalGroup.children.length === 0) return null;
    const hits = this.raycaster.intersectObjects(this.decalGroup.children, false);
    return hits.length > 0 ? hits[0] : null;
  }

  // ─── Decal Placement ──────────────────────────────────────────────────

  /**
   * Get the face width from bounding box for sizing reference.
   */
  _getFaceWidth() {
    const headMesh = this.sceneManager.headMesh;
    if (!headMesh) return 1.0;
    const box = new THREE.Box3().setFromObject(headMesh);
    return box.max.x - box.min.x;
  }

  /**
   * Compute orientation Euler from surface normal + camera up.
   */
  _computeOrientation(normal, point) {
    // Build a rotation matrix that aligns -Z with the surface normal
    // and keeps Y roughly aligned with camera up
    const lookTarget = point.clone().add(normal);
    const m = new THREE.Matrix4();
    m.lookAt(point, lookTarget, this.camera.up);

    const euler = new THREE.Euler();
    euler.setFromRotationMatrix(m);
    return euler;
  }

  /**
   * Place a decal at the raycast intersection point.
   */
  placeDecal(intersection, options = {}) {
    if (this.decals.length >= this.MAX_DECALS) {
      console.warn('[DecalSystem] Max decals reached:', this.MAX_DECALS);
      return null;
    }

    const texEntry = this.getTexture(this.activeTextureId);
    if (!texEntry) {
      console.warn('[DecalSystem] No active texture selected');
      return null;
    }

    const point = intersection.point.clone();
    const faceNormal = intersection.face.normal.clone();

    // Transform normal to world space
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(intersection.object.matrixWorld);
    faceNormal.applyMatrix3(normalMatrix).normalize();

    const faceWidth = this._getFaceWidth();
    const defaultSize = faceWidth * 0.15; // 15% of face width default
    const depth = faceWidth * 0.15;       // projection depth

    const orientation = this._computeOrientation(faceNormal, point);

    const decalData = {
      id: this._nextId++,
      textureId: texEntry.id,
      position: point.toArray(),
      normal: faceNormal.toArray(),
      orientation: [orientation.x, orientation.y, orientation.z],
      size: [
        options.width || defaultSize,
        options.height || defaultSize,
        depth,
      ],
      rotation: options.rotation || 0,
      opacity: options.opacity !== undefined ? options.opacity : 100,
      scale: options.scale || 1.0,
    };

    this.decals.push(decalData);

    const mesh = this._createDecalMesh(decalData);
    if (mesh) {
      this.decalMeshes.push(mesh);
      this.decalGroup.add(mesh);
    } else {
      // If mesh creation fails, remove decal data
      this.decals.pop();
      return null;
    }

    console.log(`[DecalSystem] Decal placed: id=${decalData.id}, texture=${texEntry.name}`);

    if (this.onDecalPlaced) this.onDecalPlaced(decalData);
    if (this.onDecalChanged) this.onDecalChanged();

    return decalData;
  }

  // ─── Mesh Creation ─────────────────────────────────────────────────────

  /**
   * Build a DecalGeometry mesh from decal data.
   */
  _createDecalMesh(decalData) {
    const headMesh = this.sceneManager.headMesh;
    if (!headMesh) return null;

    const texEntry = this.getTexture(decalData.textureId);
    if (!texEntry) return null;

    // Find the actual renderable mesh (group → child)
    let targetMesh = null;
    if (headMesh.isMesh && headMesh.geometry) {
      targetMesh = headMesh;
    } else {
      headMesh.traverse(c => {
        if (c.isMesh && c.geometry && !targetMesh) targetMesh = c;
      });
    }
    if (!targetMesh) return null;

    const position = new THREE.Vector3().fromArray(decalData.position);
    const size = new THREE.Vector3().fromArray(decalData.size);

    // Apply uniform scale
    size.x *= decalData.scale;
    size.y *= decalData.scale;

    // Build orientation Euler, then apply user rotation around the normal
    const orientation = new THREE.Euler(
      decalData.orientation[0],
      decalData.orientation[1],
      decalData.orientation[2]
    );

    // Apply user rotation (around the Z-axis of the decal's local frame = normal)
    if (decalData.rotation !== 0) {
      const rotRad = (decalData.rotation * Math.PI) / 180;
      orientation.z += rotRad;
    }

    let geometry;
    try {
      geometry = new THREE.DecalGeometry(targetMesh, position, orientation, size);
    } catch (err) {
      console.error('[DecalSystem] DecalGeometry creation failed:', err);
      return null;
    }

    // Check if geometry has any vertices
    if (!geometry.attributes.position || geometry.attributes.position.count === 0) {
      console.warn('[DecalSystem] DecalGeometry produced empty geometry — decal may be outside mesh');
      geometry.dispose();
      return null;
    }

    const material = new THREE.MeshStandardMaterial({
      map: texEntry.texture,
      transparent: true,
      opacity: decalData.opacity / 100,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      blending: THREE.NormalBlending,
      side: THREE.FrontSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.decalId = decalData.id;
    mesh.renderOrder = 5;

    return mesh;
  }

  // ─── Selection ─────────────────────────────────────────────────────────

  selectDecal(index) {
    this._clearSelection();
    if (index < 0 || index >= this.decals.length) return;
    this.selectedDecalIndex = index;
    const mesh = this.decalMeshes[index];
    if (mesh && mesh.material) {
      mesh.material.emissive = new THREE.Color(0x7aa2f7);
      mesh.material.emissiveIntensity = 0.3;
    }
    if (this.onDecalChanged) this.onDecalChanged();
  }

  _clearSelection() {
    if (this.selectedDecalIndex >= 0 && this.selectedDecalIndex < this.decalMeshes.length) {
      const mesh = this.decalMeshes[this.selectedDecalIndex];
      if (mesh && mesh.material) {
        mesh.material.emissive = new THREE.Color(0x000000);
        mesh.material.emissiveIntensity = 0;
        mesh.material.needsUpdate = true;
      }
    }
    this.selectedDecalIndex = -1;
  }

  // ─── Transform Controls ────────────────────────────────────────────────

  updateSelectedDecal(property, value) {
    if (this.selectedDecalIndex < 0) return;
    const decalData = this.decals[this.selectedDecalIndex];
    if (!decalData) return;

    switch (property) {
      case 'scale':
        decalData.scale = value;
        this._rebuildDecal(this.selectedDecalIndex);
        break;
      case 'rotation':
        decalData.rotation = value;
        this._rebuildDecal(this.selectedDecalIndex);
        break;
      case 'opacity':
        decalData.opacity = value;
        const mesh = this.decalMeshes[this.selectedDecalIndex];
        if (mesh && mesh.material) {
          mesh.material.opacity = value / 100;
        }
        break;
    }

    if (this.onDecalChanged) this.onDecalChanged();
  }

  /**
   * Reposition the selected decal to a new raycast intersection.
   */
  repositionSelected(intersection) {
    if (this.selectedDecalIndex < 0) return;
    const decalData = this.decals[this.selectedDecalIndex];
    if (!decalData) return;

    const point = intersection.point.clone();
    const faceNormal = intersection.face.normal.clone();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(intersection.object.matrixWorld);
    faceNormal.applyMatrix3(normalMatrix).normalize();

    const orientation = this._computeOrientation(faceNormal, point);

    decalData.position = point.toArray();
    decalData.normal = faceNormal.toArray();
    decalData.orientation = [orientation.x, orientation.y, orientation.z];

    // Recalculate depth based on face width
    const faceWidth = this._getFaceWidth();
    decalData.size[2] = faceWidth * 0.15;

    this._rebuildDecal(this.selectedDecalIndex);
    if (this.onDecalChanged) this.onDecalChanged();
  }

  // ─── Rebuild Single Decal ──────────────────────────────────────────────

  _rebuildDecal(index) {
    if (index < 0 || index >= this.decals.length) return;

    const oldMesh = this.decalMeshes[index];
    if (oldMesh) {
      this.decalGroup.remove(oldMesh);
      oldMesh.geometry.dispose();
      oldMesh.material.dispose();
    }

    const newMesh = this._createDecalMesh(this.decals[index]);
    if (newMesh) {
      this.decalMeshes[index] = newMesh;
      this.decalGroup.add(newMesh);

      // Re-apply selection highlight if selected
      if (index === this.selectedDecalIndex) {
        newMesh.material.emissive = new THREE.Color(0x7aa2f7);
        newMesh.material.emissiveIntensity = 0.3;
      }
    }
  }

  // ─── Rebuild All (after morph) ─────────────────────────────────────────

  rebuildAll() {
    for (let i = 0; i < this.decals.length; i++) {
      this._rebuildDecal(i);
    }
    console.log(`[DecalSystem] Rebuilt ${this.decals.length} decal(s) after morph`);
  }

  // ─── Delete ────────────────────────────────────────────────────────────

  deleteSelectedDecal() {
    const idx = this.selectedDecalIndex;
    if (idx < 0 || idx >= this.decals.length) return;

    // Clear selection
    this.selectedDecalIndex = -1;

    const mesh = this.decalMeshes[idx];
    if (mesh) {
      this.decalGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }

    this.decals.splice(idx, 1);
    this.decalMeshes.splice(idx, 1);

    console.log('[DecalSystem] Deleted decal at index', idx);
    if (this.onDecalChanged) this.onDecalChanged();
  }

  clearAll() {
    this._clearSelection();
    for (const mesh of this.decalMeshes) {
      this.decalGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.decals = [];
    this.decalMeshes = [];
    if (this.onDecalChanged) this.onDecalChanged();
  }

  // ─── Pointer Events ────────────────────────────────────────────────────

  _onPointerDown(event) {
    if (event.button !== 0) return;
    this._getNDC(event);

    // Check if clicking an existing decal
    const decalHit = this._raycastDecals();
    if (decalHit) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const idx = this.decalMeshes.findIndex(m => m === decalHit.object);
      if (idx >= 0) {
        if (idx === this.selectedDecalIndex) {
          // Deselect
          this._clearSelection();
        } else {
          this.selectDecal(idx);
        }
      }
      this.controls.enabled = false;
      setTimeout(() => { this.controls.enabled = true; }, 100);
      return;
    }

    // Clicking the face with a selected decal → reposition it
    if (this.selectedDecalIndex >= 0) {
      const faceHit = this._raycastHead();
      if (faceHit) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.repositionSelected(faceHit);
        this.controls.enabled = false;
        setTimeout(() => { this.controls.enabled = true; }, 100);
        return;
      }
    }

    // Clicking the face with nothing selected → place new decal
    if (this.activeTextureId) {
      const faceHit = this._raycastHead();
      if (faceHit) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.placeDecal(faceHit);
        this.controls.enabled = false;
        setTimeout(() => { this.controls.enabled = true; }, 100);
      }
    }
  }

  _onKeyDown(event) {
    if (!this.enabled) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selectedDecalIndex >= 0) {
        event.preventDefault();
        this.deleteSelectedDecal();
      }
    }
    if (event.key === 'Escape') {
      this._clearSelection();
      if (this.onDecalChanged) this.onDecalChanged();
    }
  }

  // ─── Serialization ─────────────────────────────────────────────────────

  exportState() {
    return this.decals.map(d => {
      const texEntry = this.getTexture(d.textureId);
      return {
        id: d.id,
        textureDataURL: texEntry ? texEntry.dataURL : null,
        textureName: texEntry ? texEntry.name : 'unknown',
        position: [...d.position],
        normal: [...d.normal],
        orientation: [...d.orientation],
        size: [...d.size],
        rotation: d.rotation,
        opacity: d.opacity,
        scale: d.scale,
      };
    });
  }

  loadState(decalsArray) {
    this.clearAll();
    if (!decalsArray || !Array.isArray(decalsArray)) return;

    // Reconstruct textures and decals
    const promises = decalsArray.map(entry => {
      return new Promise((resolve) => {
        if (!entry.textureDataURL) { resolve(null); return; }

        const img = new Image();
        img.onload = () => {
          const texture = new THREE.Texture(img);
          texture.needsUpdate = true;
          texture.colorSpace = THREE.SRGBColorSpace;

          // Generate thumbnail
          const thumbCanvas = document.createElement('canvas');
          thumbCanvas.width = 64;
          thumbCanvas.height = 64;
          const ctx = thumbCanvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 64, 64);
          const thumbnail = thumbCanvas.toDataURL('image/png');

          // Check if this texture dataURL is already registered
          let texEntry = this.textures.find(t => t.dataURL === entry.textureDataURL);
          if (!texEntry) {
            texEntry = {
              id: this._nextTextureId++,
              name: entry.textureName || 'Loaded',
              texture: texture,
              thumbnail: thumbnail,
              dataURL: entry.textureDataURL,
            };
            this.textures.push(texEntry);
          }

          // Restore decal data
          const decalData = {
            id: entry.id || this._nextId++,
            textureId: texEntry.id,
            position: entry.position,
            normal: entry.normal,
            orientation: entry.orientation,
            size: entry.size,
            rotation: entry.rotation || 0,
            opacity: entry.opacity !== undefined ? entry.opacity : 100,
            scale: entry.scale || 1.0,
          };

          if (decalData.id >= this._nextId) this._nextId = decalData.id + 1;

          this.decals.push(decalData);
          const mesh = this._createDecalMesh(decalData);
          if (mesh) {
            this.decalMeshes.push(mesh);
            this.decalGroup.add(mesh);
          }

          resolve(decalData);
        };
        img.onerror = () => resolve(null);
        img.src = entry.textureDataURL;
      });
    });

    Promise.all(promises).then(() => {
      console.log(`[DecalSystem] Loaded ${this.decals.length} decal(s) from state`);
      if (this.onDecalChanged) this.onDecalChanged();
    });
  }

  getDecalCount() {
    return this.decals.length;
  }

  /**
   * Serialize all decals for undo/redo snapshots.
   * Alias for exportState().
   */
  serialize() {
    return this.exportState();
  }

  /**
   * Deserialize decals from an undo/redo snapshot.
   * Fully rebuilds textures, geometry, meshes, and fires onDecalChanged
   * so the UI gallery refreshes.
   */
  deserialize(data) {
    this.loadState(data);
  }
}

window.DecalSystem = DecalSystem;
