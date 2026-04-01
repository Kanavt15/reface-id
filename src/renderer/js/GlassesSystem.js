/**
 * GlassesSystem.js
 * Handles loading, positioning, and customization of 3D glasses models
 */

const THREE = window.THREE || require('three');

class GlassesSystem {
  constructor(sceneManager, objMorpher) {
    this.sceneManager = sceneManager;
    this.morpher = objMorpher;

    // Main container for all glasses
    this.glassesGroup = new THREE.Group();
    this.glassesGroup.name = 'GlassesGroup';
    this.sceneManager.scene.add(this.glassesGroup);

    // Model cache
    this._modelCache = {};
    this._loadId = 0;

    // Bounding box cache (to prevent glitching)
    this._bboxCache = null;

    // Current state
    this.currentGlasses = null;
    this._glassesContainer = null;
    this._glassesOffset = null;

    // Available glasses models (removed glasses3)
    this.availableGlasses = [
      { id: 'glasses1', name: 'Glasses 1', file: '../../assets/Glasses/glasses 1.glb' },
      { id: 'glasses2', name: 'Glasses 2', file: '../../assets/Glasses/glasses 2.glb' },
      { id: 'glasses4', name: 'Glasses 4', file: '../../assets/Glasses/Glasses 4.glb' },
      { id: 'glasses5', name: 'Glasses', file: '../../assets/Glasses/glasses.glb' }
    ];

    // Per-model orientation corrections (in degrees)
    // These are applied to fix known orientation issues with specific models
    // Values extracted from user's manual adjustments
    this.modelOrientationFixes = {
      'glasses1': { x: 0, y: 0, z: 0, posX: 0, posY: 45, posZ: 34, scale: 0.99, rotX: 87, rotY: 0, rotZ: 0 },
      'glasses2': { x: 0, y: 0, z: 0, posX: 11, posY: -86, posZ: 100, scale: 0.29, rotX: 0, rotY: 3, rotZ: 92 },
      'glasses4': { x: 0, y: 0, z: 0, posX: 29, posY: -9, posZ: -7, scale: 0.38, rotX: 5, rotY: 4, rotZ: -98 },
      'glasses5': { x: 0, y: 0, z: 0, posX: 0, posY: 0, posZ: -43, scale: 1.0, rotX: 87, rotY: 0, rotZ: 0 }
    };

    // User adjustments
    this.scale = 1.0;
    this.positionX = 0;
    this.positionY = 0;
    this.positionZ = 0;
    this.rotationX = 0;  // Pitch (tilt forward/backward)
    this.rotationY = 0;  // Yaw (turn left/right)
    this.rotationZ = 0;  // Roll (tilt sideways)

    // Cached head metrics
    this._headMetrics = null;
  }

  /**
   * Get list of available glasses
   */
  getAvailableGlasses() {
    return this.availableGlasses;
  }

  /**
   * Compute head metrics (cached)
   */
  _computeHeadMetrics() {
    const headMesh = this.sceneManager.headMesh;
    if (!headMesh) return null;

    const box = new THREE.Box3().setFromObject(headMesh);
    const center = new THREE.Vector3();
    box.getCenter(center);

    this._headMetrics = {
      center: center,
      width: box.max.x - box.min.x,
      height: box.max.y - box.min.y,
      depth: box.max.z - box.min.z,
      top: box.max.y,
      front: box.max.z
    };

    return this._headMetrics;
  }

  /**
   * Load and apply a glasses model
   */
  loadGlasses(glassesId) {
    const config = this.availableGlasses.find(g => g.id === glassesId);
    if (!config) {
      console.warn('Glasses not found:', glassesId);
      return;
    }

    this.currentGlasses = glassesId;
    this._bboxCache = null; // Clear bbox cache for new model

    // Get saved defaults for this model if available
    const savedDefaults = this.modelOrientationFixes[glassesId];
    
    // Reset user adjustments to model-specific defaults or zeros
    this.scale = savedDefaults?.scale || 1.0;
    this.positionX = savedDefaults?.posX || 0;
    this.positionY = savedDefaults?.posY || 0;
    this.positionZ = savedDefaults?.posZ || 0;
    this.rotationX = savedDefaults?.rotX || 0;
    this.rotationY = savedDefaults?.rotY || 0;
    this.rotationZ = savedDefaults?.rotZ || 0;

    const thisLoadId = ++this._loadId;

    // Check cache first
    if (this._modelCache[glassesId]) {
      this._showCachedModel(glassesId);
      return;
    }

    // Load GLB
    const loader = new THREE.GLBLoader();
    loader.load(
      config.file,
      (group) => {
        // Prevent stale loads
        if (this._loadId !== thisLoadId) return;

        this._modelCache[glassesId] = group;
        this._showCachedModel(glassesId);
      },
      null,
      (err) => {
        console.error('Failed to load glasses:', err);
      }
    );
  }

  /**
   * Display cached glasses model
   */
  _showCachedModel(glassesId) {
    console.log('[GlassesSystem] Showing cached model:', glassesId);

    // Clear existing
    if (this._glassesContainer) {
      this.glassesGroup.remove(this._glassesContainer);
      this._glassesContainer = null;
      this._glassesOffset = null;
    }

    const cached = this._modelCache[glassesId];
    if (!cached) {
      console.warn('[GlassesSystem] Cached model not found:', glassesId);
      return;
    }

    // Create container and offset groups
    const container = new THREE.Group();
    container.name = 'GlassesContainer';

    const offsetGroup = new THREE.Group();
    offsetGroup.name = 'GlassesOffset';

    // Clone meshes and fix their materials
    let meshCount = 0;
    cached.traverse((child) => {
      if (child.isMesh) {
        const clone = child.clone();

        // Clone and fix the material, passing mesh name for better detection
        if (child.material) {
          if (Array.isArray(child.material)) {
            clone.material = child.material.map(m => this._fixGlassesMaterial(m.clone(), child.name));
          } else {
            clone.material = this._fixGlassesMaterial(child.material.clone(), child.name);
          }
        }

        clone.castShadow = true;
        clone.receiveShadow = true;
        offsetGroup.add(clone);
        meshCount++;
      }
    });

    console.log(`[GlassesSystem] Cloned ${meshCount} meshes for ${glassesId}`);

    container.add(offsetGroup);
    this.glassesGroup.add(container);

    this._glassesContainer = container;
    this._glassesOffset = offsetGroup;
    this._bboxCache = null; // Reset bbox cache for new model

    this._alignAndAdjust();
  }

  /**
   * Fix glasses material to look like regular reading/eyeglasses
   * Makes lenses very clear/transparent and frames look like metal or plastic
   */
  _fixGlassesMaterial(material, meshName = '') {
    if (!material) return material;

    const nameLower = (material.name || '').toLowerCase();
    const meshNameLower = (meshName || '').toLowerCase();
    
    // More aggressive lens detection - check material name, mesh name, and properties
    const isLikelyLens = material.transparent || 
                         (material.opacity && material.opacity < 1) ||
                         nameLower.includes('lens') ||
                         nameLower.includes('glass') ||
                         meshNameLower.includes('lens') ||
                         meshNameLower.includes('glass');

    // Also check if it's a dark/tinted material that might be sunglasses lens
    const isDarkTint = material.color && 
                       (material.color.r < 0.3 && material.color.g < 0.3 && material.color.b < 0.35);

    if (isLikelyLens || isDarkTint) {
      // Make lenses look like clear reading glasses - almost invisible
      material.color = new THREE.Color(0xffffff);  // Pure white/clear
      material.transparent = true;
      material.opacity = 0.08;  // Nearly invisible - regular glasses
      material.metalness = 0.0;
      material.roughness = 0.0;  // Perfectly smooth glass
      material.side = THREE.DoubleSide;
      material.depthWrite = false;  // Prevent z-fighting
      if (material.envMapIntensity !== undefined) {
        material.envMapIntensity = 0.3;  // Subtle reflections like real glass
      }
      console.log(`[GlassesSystem] Fixed lens material: ${material.name || 'unnamed'}`);
    } else {
      // Make frames look like nice metal or plastic eyeglass frames
      if (material.color) {
        const r = material.color.r;
        const g = material.color.g;
        const b = material.color.b;
        
        // If color is brownish/tan, change to elegant frame colors
        const isBrownish = (r > 0.3 && r < 0.8) && (g > 0.2 && g < 0.6) && (b > 0.1 && b < 0.5);
        const isTan = Math.abs(r - g) < 0.2 && Math.abs(g - b) < 0.2 && r > 0.3;
        
        if (isBrownish || isTan) {
          // Nice silver/gunmetal color for elegant frames
          material.color = new THREE.Color(0x505560);  // Gunmetal gray
          material.metalness = 0.7;  // Metallic frames
          material.roughness = 0.3;  // Some polish
          console.log(`[GlassesSystem] Fixed frame material: ${material.name || 'unnamed'}`);
        }
      }
    }

    material.needsUpdate = true;
    return material;
  }

  /**
   * Align glasses to face and apply user adjustments
   */
  _alignAndAdjust() {
    if (!this._glassesContainer || !this._glassesOffset) return;

    // Get head metrics
    const headMetrics = this._computeHeadMetrics();
    if (!headMetrics) {
      console.warn('[GlassesSystem] Cannot align - no head metrics');
      return;
    }

    // Compute and cache glasses bounding box (only once per model)
    if (!this._bboxCache) {
      console.log('[GlassesSystem] Computing bbox and orientation...');

      // Reset transforms for accurate bbox computation
      this._glassesContainer.scale.set(1, 1, 1);
      this._glassesContainer.position.set(0, 0, 0);
      this._glassesContainer.rotation.set(0, 0, 0);
      this._glassesOffset.position.set(0, 0, 0);
      this._glassesOffset.rotation.set(0, 0, 0);

      const glassesBox = new THREE.Box3().setFromObject(this._glassesOffset);
      const glassesCenter = new THREE.Vector3();
      glassesBox.getCenter(glassesCenter);
      const glassesSize = new THREE.Vector3();
      glassesBox.getSize(glassesSize);

      console.log('[GlassesSystem] Original bbox size:', glassesSize);

      // Check if model has valid size
      if (glassesSize.x < 0.001 && glassesSize.y < 0.001 && glassesSize.z < 0.001) {
        console.warn('[GlassesSystem] Glasses model has no valid size');
        return;
      }

      this._bboxCache = {
        center: glassesCenter.clone(),
        size: glassesSize.clone()
      };

      // Center glasses at origin (only needed once per model)
      this._glassesOffset.position.set(
        -glassesCenter.x,
        -glassesCenter.y,
        -glassesCenter.z
      );

      // Apply per-model orientation fixes if defined
      const orientationFix = this.modelOrientationFixes[this.currentGlasses];
      if (orientationFix) {
        console.log('[GlassesSystem] Applying model-specific orientation fix for:', this.currentGlasses, orientationFix);
        
        // Apply the rotation fix
        this._glassesOffset.rotation.set(
          (orientationFix.x * Math.PI) / 180,
          (orientationFix.y * Math.PI) / 180,
          (orientationFix.z * Math.PI) / 180
        );
        
        // Recalculate bounding box after rotation to get correct dimensions for scaling
        this._glassesOffset.updateMatrixWorld(true);
        const rotatedBox = new THREE.Box3().setFromObject(this._glassesOffset);
        const rotatedSize = new THREE.Vector3();
        rotatedBox.getSize(rotatedSize);
        this._bboxCache.size = rotatedSize;
        
        console.log('[GlassesSystem] Size after orientation fix:', rotatedSize);
      } else {
        // Fallback: Use automatic orientation detection for unknown models
        // Detect and correct common orientation issues
        let needsYRotation = false;
        let needsXRotation = false;
        let needsZRotation = false;
        
        // Case 1: Model is wider in Z than X by significant margin - rotated 90° on Y
        if (glassesSize.z > glassesSize.x * 1.3) {
          needsYRotation = true;
        }
        
        // Case 2: Model is taller in Z than both X and Y - likely facing wrong direction
        if (glassesSize.z > glassesSize.y * 2 && glassesSize.z > glassesSize.x * 1.3) {
          needsYRotation = true;
        }
        
        // Case 3: Model is taller than wide (Y > X significantly) and depth is reasonable
        if (glassesSize.y > glassesSize.x * 1.5 && glassesSize.z < glassesSize.y) {
          needsZRotation = true;
        }
        
        // Case 4: If model is very tall in X compared to Y, it might be rotated on X axis
        if (glassesSize.x > glassesSize.y * 2.5 && glassesSize.y < glassesSize.z * 0.5) {
          needsXRotation = true;
        }
        
        // Apply corrections
        if (needsYRotation) {
          console.log('[GlassesSystem] Applying Y-axis rotation correction (90°)');
          this._glassesOffset.rotation.y = Math.PI / 2;
          const temp = this._bboxCache.size.x;
          this._bboxCache.size.x = this._bboxCache.size.z;
          this._bboxCache.size.z = temp;
        }
        
        if (needsXRotation) {
          console.log('[GlassesSystem] Applying X-axis rotation correction (-90°)');
          this._glassesOffset.rotation.x = -Math.PI / 2;
          const temp = this._bboxCache.size.y;
          this._bboxCache.size.y = this._bboxCache.size.z;
          this._bboxCache.size.z = temp;
        }
        
        if (needsZRotation) {
          console.log('[GlassesSystem] Applying Z-axis rotation correction (90°)');
          this._glassesOffset.rotation.z = Math.PI / 2;
          const temp = this._bboxCache.size.x;
          this._bboxCache.size.x = this._bboxCache.size.y;
          this._bboxCache.size.y = temp;
        }
      }

      console.log('[GlassesSystem] Final bbox size after orientation:', this._bboxCache.size);
    }

    const glassesSize = this._bboxCache.size;

    // Auto-scale based on head width (glasses should be about 85% of head width)
    const autoScale = (headMetrics.width / glassesSize.x) * 0.85;

    // Apply user scale adjustment
    const finalScale = autoScale * this.scale;
    this._glassesContainer.scale.set(finalScale, finalScale, finalScale);

    // Position glasses on face
    // Y: Position at eye level (about 15% above center)
    const baseY = headMetrics.center.y + headMetrics.height * 0.12;
    // Z: Position in front of face
    const baseZ = headMetrics.front * 0.42;

    // Apply user position adjustments (scaled by head dimensions)
    const adjustX = (this.positionX / 100) * headMetrics.width * 0.5;
    const adjustY = (this.positionY / 100) * headMetrics.height * 0.5;
    const adjustZ = (this.positionZ / 100) * headMetrics.depth * 0.5;

    this._glassesContainer.position.set(
      headMetrics.center.x + adjustX,
      baseY + adjustY,
      baseZ + adjustZ
    );

    // Apply user rotation (all three axes)
    // X-axis: pitch (tilt forward/backward)
    // Y-axis: yaw (turn left/right)  
    // Z-axis: roll (tilt sideways)
    this._glassesContainer.rotation.set(
      (this.rotationX * Math.PI) / 180,
      (this.rotationY * Math.PI) / 180,
      (this.rotationZ * Math.PI) / 180
    );

    console.log('[GlassesSystem] Positioned glasses at:', this._glassesContainer.position);
  }

  /**
   * Remove current glasses
   */
  removeGlasses() {
    if (this._glassesContainer) {
      this.glassesGroup.remove(this._glassesContainer);
      this._glassesContainer = null;
      this._glassesOffset = null;
    }
    this._bboxCache = null;
    this.currentGlasses = null;

    // Reset adjustments
    this.scale = 1.0;
    this.positionX = 0;
    this.positionY = 0;
    this.positionZ = 0;
    this.rotationX = 0;
    this.rotationY = 0;
    this.rotationZ = 0;
  }

  /**
   * Set scale (0.5 - 1.5)
   */
  setScale(value) {
    this.scale = value;
    this._applyTransforms();
  }

  /**
   * Set position X (-50 to 50)
   */
  setPositionX(value) {
    this.positionX = value;
    this._applyTransforms();
  }

  /**
   * Set position Y (-50 to 50)
   */
  setPositionY(value) {
    this.positionY = value;
    this._applyTransforms();
  }

  /**
   * Set position Z (-50 to 50)
   */
  setPositionZ(value) {
    this.positionZ = value;
    this._applyTransforms();
  }

  /**
   * Set rotation (-45 to 45 degrees) - backward compatibility
   */
  setRotation(value) {
    this.rotationZ = value;
    this._applyTransforms();
  }

  /**
   * Set X-axis rotation (pitch: tilt forward/backward, -90 to 90 degrees)
   */
  setRotationX(value) {
    this.rotationX = value;
    this._applyTransforms();
  }

  /**
   * Set Y-axis rotation (yaw: turn left/right, -180 to 180 degrees)
   */
  setRotationY(value) {
    this.rotationY = value;
    this._applyTransforms();
  }

  /**
   * Set Z-axis rotation (roll: tilt sideways, -45 to 45 degrees)
   */
  setRotationZ(value) {
    this.rotationZ = value;
    this._applyTransforms();
  }

  /**
   * Apply transforms without recalculating bbox
   */
  _applyTransforms() {
    if (!this._glassesContainer || !this._bboxCache) return;

    const headMetrics = this._headMetrics || this._computeHeadMetrics();
    if (!headMetrics) return;

    const glassesSize = this._bboxCache.size;

    // Auto-scale based on head width
    const autoScale = (headMetrics.width / glassesSize.x) * 0.85;
    const finalScale = autoScale * this.scale;
    this._glassesContainer.scale.set(finalScale, finalScale, finalScale);

    // Position glasses
    const baseY = headMetrics.center.y + headMetrics.height * 0.12;
    const baseZ = headMetrics.front * 0.42;

    const adjustX = (this.positionX / 100) * headMetrics.width * 0.5;
    const adjustY = (this.positionY / 100) * headMetrics.height * 0.5;
    const adjustZ = (this.positionZ / 100) * headMetrics.depth * 0.5;

    this._glassesContainer.position.set(
      headMetrics.center.x + adjustX,
      baseY + adjustY,
      baseZ + adjustZ
    );

    // Apply rotation (all three axes)
    this._glassesContainer.rotation.set(
      (this.rotationX * Math.PI) / 180,
      (this.rotationY * Math.PI) / 180,
      (this.rotationZ * Math.PI) / 180
    );
  }

  /**
   * Recalculate alignment after morph changes
   */
  onMorphUpdate() {
    if (this.currentGlasses) {
      // Clear head metrics cache so they get recomputed
      this._headMetrics = null;
      this._applyTransforms();
    }
  }

  /**
   * Export state for saving
   */
  exportState() {
    return {
      currentGlasses: this.currentGlasses,
      scale: this.scale,
      positionX: this.positionX,
      positionY: this.positionY,
      positionZ: this.positionZ,
      rotationX: this.rotationX,
      rotationY: this.rotationY,
      rotationZ: this.rotationZ,
      // Backward compatibility
      rotation: this.rotationZ
    };
  }

  /**
   * Import state for loading
   */
  importState(state) {
    if (!state) return;

    this.scale = state.scale || 1.0;
    this.positionX = state.positionX || 0;
    this.positionY = state.positionY || 0;
    this.positionZ = state.positionZ || 0;
    this.rotationX = state.rotationX || 0;
    this.rotationY = state.rotationY || 0;
    // Support both new rotationZ and legacy rotation property
    this.rotationZ = state.rotationZ !== undefined ? state.rotationZ : (state.rotation || 0);

    if (state.currentGlasses) {
      this.loadGlasses(state.currentGlasses);
    } else {
      this.removeGlasses();
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this._glassesContainer) {
      this.glassesGroup.remove(this._glassesContainer);
    }
    this.sceneManager.scene.remove(this.glassesGroup);

    // Clear cache
    for (const key in this._modelCache) {
      const model = this._modelCache[key];
      model.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
    }
    this._modelCache = {};
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GlassesSystem;
}
