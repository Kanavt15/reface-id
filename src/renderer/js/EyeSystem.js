/**
 * EyeSystem.js – Realistic 3D eye system for forensic facial reconstruction
 *
 * Features:
 * - Loads left and right eye GLB models
 * - Applies eye color (iris/sclera)
 * - Adjusts eye positioning and size based on morphs
 * - Supports multiple eye styles
 * - Auto-refreshes when head morphs change
 */

class EyeSystem {
  constructor(scene) {
    this.scene = scene;

    // Eye groups
    this.eyeGroup = new THREE.Group();
    this.eyeGroup.name = 'EyeSystem';
    this.scene.add(this.eyeGroup);

    // Head references
    this._headGroup = null;
    this._regionData = null;

    // State
    this.currentStyle = 'realistic'; // realistic, cartoon, anime, etc.
    this.eyeColor = '#634e34'; // Brown by default
    this.params = {
      scale: 50,
      spacing: 50,
      posX: 50,
      posY: 50,
      posZ: 50,
      rotX: 50,
      rotY: 50,
      rotZ: 50,
      opacity: 100,
    };

    // Head metrics
    this.modelCenter = new THREE.Vector3();
    this.modelHeight = 2.0;
    this.modelDepth = 1.5;
    this.headWidth = 1.9;
    this.headTop = 1.4;
    this.headFront = 1.0;
    this.eyeSpacing = 0.6;

    // GLB model cache
    this._modelCache = {};
    this._loadId = 0;

    // Current eye containers
    this._leftEyeContainer = null;
    this._rightEyeContainer = null;

    // Eye materials
    this._eyeMaterials = {
      scleraColor: '#ffffff',
      irisColor: '#634e34',
      pupilColor: '#000000',
    };

    // Eye material instances
    this._sclera = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this._eyeMaterials.scleraColor),
      roughness: 0.4,
      metalness: 0.05,
      side: THREE.FrontSide,
    });

    this._iris = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this._eyeMaterials.irisColor),
      roughness: 0.6,
      metalness: 0.0,
      side: THREE.FrontSide,
    });

    this._pupil = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this._eyeMaterials.pupilColor),
      roughness: 0.9,
      metalness: 0.1,
      side: THREE.FrontSide,
    });

    // Eye model configurations (reference to GLB files when available)
    this.eyeModels = {
      realistic: {
        leftFile: '../../assets/models/facial/EyeLeft.glb',
        rightFile: '../../assets/models/facial/EyeRight.glb',
      },
      cartoon: {
        leftFile: '../../assets/models/facial/EyeCartoonLeft.glb',
        rightFile: '../../assets/models/facial/EyeCartoonRight.glb',
      },
    };

    // Default position and scale calibration (updated after head metrics are known)
    this._leftEyeBasePos = new THREE.Vector3(-0.12, 0.32, 0.58);
    this._rightEyeBasePos = new THREE.Vector3(0.12, 0.32, 0.58);
    this._eyeBaseScale = 1.0;

    console.log('[EyeSystem] Initialized');
  }

  // ── Head binding ──

  setHeadMesh(headGroup, regionData, morpher) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._morpher = morpher || null;
    this._initialLandmarkLeft = null;
    this._initialLandmarkRight = null;
    this._initialBaseLeft = null;
    this._initialBaseRight = null;
    this._computeHeadMetrics();
  }

  _computeHeadMetrics() {
    if (!this._headGroup) return;
    const box = new THREE.Box3().setFromObject(this._headGroup);
    box.getCenter(this.modelCenter);
    this.modelHeight = box.max.z - box.min.z;
    this.modelDepth = box.max.y - box.min.y;
    this.headWidth = box.max.x - box.min.x;
    this.headTop = box.max.z;
    this.headFront = box.max.y;

    // Compute base position from bounding box (calibrated position)
    const eyeOffsetX = this.headWidth * 0.16;
    const eyeY = this.headFront - this.modelDepth * 0.12;
    const eyeZ = box.min.z + this.modelHeight * 0.57;

    const bbLeft = new THREE.Vector3(this.modelCenter.x - eyeOffsetX, eyeY, eyeZ);
    const bbRight = new THREE.Vector3(this.modelCenter.x + eyeOffsetX, eyeY, eyeZ);

    // Track landmark movement delta so eyes follow face morphs
    if (this._morpher && typeof this._morpher.getCurrentLandmarkPosition === 'function') {
      const leftPos = this._morpher.getCurrentLandmarkPosition('eye_left_center');
      const rightPos = this._morpher.getCurrentLandmarkPosition('eye_right_center');
      if (leftPos && rightPos) {
        const curLeft = new THREE.Vector3(leftPos[0], leftPos[1], leftPos[2]);
        const curRight = new THREE.Vector3(rightPos[0], rightPos[1], rightPos[2]);

        // Store initial positions on first call
        if (!this._initialLandmarkLeft) {
          this._initialLandmarkLeft = curLeft.clone();
          this._initialLandmarkRight = curRight.clone();
          this._initialBaseLeft = bbLeft.clone();
          this._initialBaseRight = bbRight.clone();
        }

        // Apply delta from initial landmark to current landmark
        const deltaLeft = curLeft.clone().sub(this._initialLandmarkLeft);
        const deltaRight = curRight.clone().sub(this._initialLandmarkRight);

        this._leftEyeBasePos.copy(this._initialBaseLeft).add(deltaLeft);
        this._rightEyeBasePos.copy(this._initialBaseRight).add(deltaRight);
        this.eyeSpacing = Math.abs(this._rightEyeBasePos.x - this._leftEyeBasePos.x);
        return;
      }
    }

    // Fallback: use bounding box positions directly
    this._leftEyeBasePos.copy(bbLeft);
    this._rightEyeBasePos.copy(bbRight);
    this.eyeSpacing = eyeOffsetX * 2;
  }

  // ── Public API ──

  setStyle(style) {
    if (this.eyeModels[style]) {
      this.currentStyle = style;
      this.generateEyes();
    } else {
      console.warn('[EyeSystem] Unknown style:', style);
    }
  }

  /**
   * Set eye color (iris color)
   * Accepts hex color string: #634e34 (brown), #2e536f (blue), #3d671d (green), etc.
   */
  setEyeColor(hexColor) {
    this.eyeColor = hexColor;
    this._eyeMaterials.irisColor = hexColor;
    this._iris.color.set(hexColor);

    // Ensure already-instantiated meshes update even if they were loaded earlier.
    this._updateRenderedIrisColor();
    console.log('[EyeSystem] Eye color changed to:', hexColor);
  }

  /**
   * Update eye parameter (scale, position, rotation, opacity)
   */
  setParam(param, value) {
    if (this.params[param] === undefined) return;
    this.params[param] = Math.max(0, Math.min(100, value));
    if (this._leftEyeContainer || this._rightEyeContainer) {
      this._applyAdjustments();
    }
  }

  getColor() {
    return this.eyeColor;
  }

  getParams() {
    return {
      ...this.params,
      color: this.eyeColor,
    };
  }

  exportState() {
    return {
      style: this.currentStyle,
      color: this.eyeColor,
      params: { ...this.params },
    };
  }

  restoreState(state) {
    if (state.style) this.currentStyle = state.style;
    if (state.color) this.setEyeColor(state.color);
    if (state.params) {
      Object.entries(state.params).forEach(([key, val]) => {
        this.params[key] = val;
      });
    }
    this.generateEyes();
  }

  // ── Main generation ──

  generateEyes() {
    console.log('[EyeSystem] Generating eyes with style:', this.currentStyle);
    this._computeHeadMetrics();
    this._clearGroup(this.eyeGroup);
    this._leftEyeContainer = null;
    this._rightEyeContainer = null;

    const config = this.eyeModels[this.currentStyle];
    if (!config) {
      console.warn('[EyeSystem] No configuration for style:', this.currentStyle);
      this._createProceduralEyes(); // Fallback to procedural
      return;
    }

    this._loadId++;
    const thisLoadId = this._loadId;

    // Load both left and right eyes
    Promise.all([
      this._loadEyeModel(config.leftFile, 'left', thisLoadId),
      this._loadEyeModel(config.rightFile, 'right', thisLoadId),
    ]).then(([leftGroup, rightGroup]) => {
      if (this._loadId !== thisLoadId) return; // Outdated request

      if (leftGroup && rightGroup) {
        this._displayEyes(leftGroup, rightGroup);
      } else {
        console.warn('[EyeSystem] Failed to load one or both eye models, using procedural fallback');
        this._createProceduralEyes();
      }
    });
  }

  _loadEyeModel(filePath, side, loadId) {
    return new Promise((resolve) => {
      // Check cache first
      const cacheKey = `${this.currentStyle}_${side}`;
      if (this._modelCache[cacheKey]) {
        console.log('[EyeSystem] Using cached eye model:', cacheKey);
        resolve(this._modelCache[cacheKey]);
        return;
      }

      const loader = new THREE.GLBLoader();
      loader.load(
        filePath,
        (group) => {
          if (this._loadId !== loadId) return;

          let meshCount = 0;
          group.traverse((child) => {
            if (child.isMesh) meshCount += 1;
          });
          if (meshCount === 0) {
            console.warn('[EyeSystem] Eye model has no meshes, using fallback:', filePath);
            resolve(null);
            return;
          }

          console.log('[EyeSystem] Eye model loaded:', filePath);
          this._modelCache[cacheKey] = group;
          resolve(group);
        },
        null,
        (err) => {
          console.warn('[EyeSystem] Failed to load eye model:', filePath, err);
          resolve(null);
        }
      );
    });
  }

  _displayEyes(leftGroup, rightGroup) {
    this._clearGroup(this.eyeGroup);

    // Create containers for left and right eyes
    this._leftEyeContainer = new THREE.Group();
    this._leftEyeContainer.name = 'LeftEyeContainer';

    this._rightEyeContainer = new THREE.Group();
    this._rightEyeContainer.name = 'RightEyeContainer';

    // Collect meshes and apply materials
    this._collectAndAssignMaterials(leftGroup, this._leftEyeContainer);
    this._collectAndAssignMaterials(rightGroup, this._rightEyeContainer);

    if (this._leftEyeContainer.children.length === 0 || this._rightEyeContainer.children.length === 0) {
      console.warn('[EyeSystem] GLB loaded but eye meshes are missing, using procedural fallback');
      this._clearGroup(this.eyeGroup);
      this._leftEyeContainer = null;
      this._rightEyeContainer = null;
      this._createProceduralEyes();
      return;
    }

    // Derive base scale from loaded mesh size so imported eyes are not oversized.
    const leftBox = new THREE.Box3().setFromObject(this._leftEyeContainer);
    const leftSize = new THREE.Vector3();
    leftBox.getSize(leftSize);
    const modelDiameter = Math.max(leftSize.x, leftSize.y, leftSize.z);
    const targetDiameter = this.headWidth * 0.11;
    if (modelDiameter > 0.0001) {
      this._eyeBaseScale = targetDiameter / modelDiameter;
    }

    // Add to scene
    this.eyeGroup.add(this._leftEyeContainer);
    this.eyeGroup.add(this._rightEyeContainer);

    // Apply transformations
    this._applyAdjustments();

    console.log('[EyeSystem] Eyes displayed successfully');
  }

  /**
   * Collect meshes from a loaded GLB group, clone them, and assign materials.
   * First tries name-based matching. If no mesh matched "iris" by name,
   * falls back to a size-based heuristic: largest=sclera, smallest=pupil, middle=iris.
   */
  _collectAndAssignMaterials(sourceGroup, targetContainer) {
    const clones = [];
    sourceGroup.traverse((child) => {
      if (child.isMesh) {
        const clone = child.clone();
        clone.castShadow = true;
        clone.receiveShadow = true;
        clones.push(clone);
      }
    });

    // Try name-based assignment first
    let irisFoundByName = false;
    for (const clone of clones) {
      const matched = this._applyEyeMaterials(clone);
      if (matched === 'iris') irisFoundByName = true;
    }

    // If no mesh was recognized as iris by name, use size-based heuristic
    if (!irisFoundByName && clones.length >= 2) {
      console.log('[EyeSystem] No iris detected by name, using size-based assignment');
      // Compute bounding sphere radius for each mesh
      const meshSizes = clones.map((mesh) => {
        mesh.geometry.computeBoundingSphere();
        const radius = mesh.geometry.boundingSphere ? mesh.geometry.boundingSphere.radius : 0;
        return { mesh, radius };
      });
      // Sort by radius descending (largest first)
      meshSizes.sort((a, b) => b.radius - a.radius);

      for (let i = 0; i < meshSizes.length; i++) {
        const { mesh, radius } = meshSizes[i];
        if (i === 0) {
          // Largest = sclera (white)
          mesh.material = this._sclera;
          console.log(`[EyeSystem] Size-assigned SCLERA: ${mesh.name} (radius: ${radius.toFixed(4)})`);
        } else if (i === meshSizes.length - 1) {
          // Smallest = pupil (black)
          mesh.material = this._pupil;
          console.log(`[EyeSystem] Size-assigned PUPIL: ${mesh.name} (radius: ${radius.toFixed(4)})`);
        } else {
          // Middle = iris (colored)
          mesh.material = this._iris;
          console.log(`[EyeSystem] Size-assigned IRIS: ${mesh.name} (radius: ${radius.toFixed(4)})`);
        }
      }
    }

    // Add all clones to target container
    for (const clone of clones) {
      targetContainer.add(clone);
    }
  }

  /**
   * Apply correct materials based on mesh names.
   * Returns which part was matched: 'pupil', 'iris', 'sclera', or 'unknown'.
   */
  _applyEyeMaterials(mesh) {
    const name = mesh.name.toLowerCase();
    console.log('[EyeSystem] Checking mesh name:', mesh.name);

    if (name.includes('pupil') || name.includes('pupilla')) {
      mesh.material = this._pupil;
      console.log('[EyeSystem] Name-assigned PUPIL:', mesh.name);
      return 'pupil';
    } else if (name.includes('iris') || name.includes('iride')) {
      mesh.material = this._iris;
      console.log('[EyeSystem] Name-assigned IRIS:', mesh.name);
      return 'iris';
    } else if (name.includes('sclera') || name.includes('white') || name.includes('eyeball')) {
      mesh.material = this._sclera;
      console.log('[EyeSystem] Name-assigned SCLERA:', mesh.name);
      return 'sclera';
    } else if (name.includes('cornea') || name.includes('lens') || name.includes('highlight') || name.includes('reflect')) {
      mesh.material = this._sclera;
      return 'sclera';
    } else {
      // Temporarily assign sclera; size-based fallback may override this
      mesh.material = this._sclera;
      console.log('[EyeSystem] Unrecognized mesh name:', mesh.name);
      return 'unknown';
    }
  }

  /**
   * Create procedural eyes as fallback
   * Generates simple geometric eyes when GLB models are unavailable
   */
  _createProceduralEyes() {
    console.log('[EyeSystem] Creating procedural eyes');

    // Keep procedural fallback conservative so eyes do not appear oversized.
    const eyeballGeo = new THREE.SphereGeometry(0.06, 28, 28);
    const pupilGeo = new THREE.SphereGeometry(0.016, 16, 16);
    const irisGeo = new THREE.SphereGeometry(0.028, 20, 20);

    // Procedural mesh already uses near-correct world size.
    this._eyeBaseScale = 1.0;

    // LEFT EYE
    this._leftEyeContainer = new THREE.Group();
    this._leftEyeContainer.name = 'LeftEyeContainer';

    const leftEyeball = new THREE.Mesh(eyeballGeo, this._sclera);
    const leftIris = new THREE.Mesh(irisGeo, this._iris);
    const leftPupil = new THREE.Mesh(pupilGeo, this._pupil);

    leftIris.position.y = 0.045;
    leftPupil.position.y = 0.055;

    leftEyeball.castShadow = true;
    leftEyeball.receiveShadow = true;
    leftIris.castShadow = true;
    leftPupil.castShadow = true;

    this._leftEyeContainer.add(leftEyeball);
    this._leftEyeContainer.add(leftIris);
    this._leftEyeContainer.add(leftPupil);

    // RIGHT EYE
    this._rightEyeContainer = new THREE.Group();
    this._rightEyeContainer.name = 'RightEyeContainer';

    const rightEyeball = new THREE.Mesh(eyeballGeo, this._sclera);
    const rightIris = new THREE.Mesh(irisGeo, this._iris);
    const rightPupil = new THREE.Mesh(pupilGeo, this._pupil);

    rightIris.position.y = 0.045;
    rightPupil.position.y = 0.055;

    rightEyeball.castShadow = true;
    rightEyeball.receiveShadow = true;
    rightIris.castShadow = true;
    rightPupil.castShadow = true;

    this._rightEyeContainer.add(rightEyeball);
    this._rightEyeContainer.add(rightIris);
    this._rightEyeContainer.add(rightPupil);

    // Add to scene
    this.eyeGroup.add(this._leftEyeContainer);
    this.eyeGroup.add(this._rightEyeContainer);

    // Apply transformations
    this._applyAdjustments();
  }

  /**
   * Position and adjust eyes based on params
   */
  _applyAdjustments() {
    if (!this._leftEyeContainer || !this._rightEyeContainer) return;

    // Normalize params (0-100 scale)
    const scaleNorm = (this.params.scale - 50) / 50; // -1 to 1
    const spacingNorm = (this.params.spacing - 50) / 50;
    const posXNorm = (this.params.posX - 50) / 50;
    const posYNorm = (this.params.posY - 50) / 50;
    const posZNorm = (this.params.posZ - 50) / 50;
    const rotXNorm = (this.params.rotX - 50) / 50;
    const rotYNorm = (this.params.rotY - 50) / 50;
    const rotZNorm = (this.params.rotZ - 50) / 50;
    const scale = this._eyeBaseScale * 1.27 * (1 + scaleNorm * 0.5); // baked scale from calibration (77), ±50% fine-tune

    // Baked-in offsets from calibration
    const BASE_SPACING = 0.015;  // from spacing=45
    const BASE_OFFSET_Y = -0.672; // from depth=46
    const BASE_OFFSET_Z = 0.51;   // from height=40
    const BASE_ROT_X = 0.06;
    const BASE_ROT_Y = 1.5;
    const BASE_ROT_Z = 1.5;

    // LEFT EYE
    this._leftEyeContainer.position.copy(this._leftEyeBasePos);
    this._leftEyeContainer.position.x += BASE_SPACING;
    this._leftEyeContainer.position.x -= spacingNorm * 0.15;
    this._leftEyeContainer.position.x += posXNorm * 0.15;
    this._leftEyeContainer.position.y += BASE_OFFSET_Y + posYNorm * 0.15;
    this._leftEyeContainer.position.z += BASE_OFFSET_Z + posZNorm * 0.15;

    this._leftEyeContainer.rotation.x = BASE_ROT_X + rotXNorm * 0.3;
    this._leftEyeContainer.rotation.y = BASE_ROT_Y + rotYNorm * 0.3;
    this._leftEyeContainer.rotation.z = BASE_ROT_Z + rotZNorm * 0.3;

    this._leftEyeContainer.scale.set(scale, scale, scale);

    // RIGHT EYE
    this._rightEyeContainer.position.copy(this._rightEyeBasePos);
    this._rightEyeContainer.position.x -= BASE_SPACING;
    this._rightEyeContainer.position.x += spacingNorm * 0.15;
    this._rightEyeContainer.position.x += posXNorm * 0.15;
    this._rightEyeContainer.position.y += BASE_OFFSET_Y + posYNorm * 0.15;
    this._rightEyeContainer.position.z += BASE_OFFSET_Z + posZNorm * 0.15;

    this._rightEyeContainer.rotation.x = BASE_ROT_X + rotXNorm * 0.3;
    this._rightEyeContainer.rotation.y = -BASE_ROT_Y - rotYNorm * 0.3;
    this._rightEyeContainer.rotation.z = -BASE_ROT_Z - rotZNorm * 0.3;

    this._rightEyeContainer.scale.set(scale, scale, scale);

    // Set opacity
    const opacity = this.params.opacity / 100;
    this._sclera.opacity = opacity;
    this._iris.opacity = opacity;
    this._pupil.opacity = opacity;
    this._sclera.transparent = opacity < 0.999;
    this._iris.transparent = opacity < 0.999;
    this._pupil.transparent = opacity < 0.999;
  }

  refreshFromMesh() {
    this._computeHeadMetrics();
    if (this._leftEyeContainer && this._rightEyeContainer) {
      this._applyAdjustments();
    }
  }

  _updateRenderedIrisColor() {
    const applyColor = (container) => {
      if (!container) return;
      container.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        // Only update meshes that use the iris material
        if (child.material === this._iris) {
          child.material.color.set(this.eyeColor);
        }
      });
    };
    applyColor(this._leftEyeContainer);
    applyColor(this._rightEyeContainer);
  }

  // ── Cleanup ──

  _clearGroup(group) {
    while (group.children.length > 0) {
      group.remove(group.children[0]);
    }
  }

  dispose() {
    this._clearGroup(this.eyeGroup);
    this.scene.remove(this.eyeGroup);
  }
}
