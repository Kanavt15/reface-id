/**
 * SceneManager.js
 * Manages the Three.js scene, camera, lighting, and rendering.
 * Handles the 3D viewport, view presets, materials, and screenshot capture.
 *
 * Coordinate system: Three.js standard (Y-up, Z-toward-camera, X-right).
 * Blender OBJ models are rotated -90° on X to convert from Z-up → Y-up.
 */

class SceneManager {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.scene = new THREE.Scene();
    this.headMesh = null;
    this.wireframeMode = false;
    this.lightingMode = 0; // 0 = studio, 1 = outdoor, 2 = dramatic

    // Model bounding info (set after loading)
    this.modelCenter = new THREE.Vector3(0, 0.18, 0);
    this.modelHeight = 2.2;

    // Lip color state
    this._skinColor = '#d4a574';
    this._lipColor = null;
    this._lipWeights = null; // cached per-vertex lip weights
    this._lipPaintOverrides = null; // Map<mesh, Float32Array> manual paint deltas

    // Skin texture system reference (set externally)
    this.skinTextureSystem = null;

    this.init();
  }

  init() {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true, // For screenshots
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Camera — Y-up, looking at model center, front = +Z direction
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.camera.position.set(0, 0.2, 4.5);
    this.camera.lookAt(0, 0.2, 0);

    // Controls
    this.controls = new THREE.OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.8;
    this.controls.panSpeed = 0.5;
    this.controls.zoomSpeed = 1.0;
    this.controls.target.set(0, 0.2, 0);
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 15;

    // Background
    this.scene.background = new THREE.Color(0x1a1a24);

    // Ground plane (Y-up convention: plane lies in XZ, positioned below model)
    const groundGeo = new THREE.PlaneGeometry(10, 10);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x15151f,
      roughness: 0.9,
      metalness: 0.1,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.0;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Grid helper
    const grid = new THREE.GridHelper(6, 30, 0x2a2a3a, 0x1f1f2f);
    grid.position.y = -0.99;
    this.scene.add(grid);
    this.grid = grid;

    // Lighting
    this.setupStudioLighting();

    // Handle resize
    this.resize();
    window.addEventListener('resize', () => this.resize());

    // Start render loop
    this.animate();
  }

  /**
   * Load a GLB model. Already in Y-up — no rotation needed.
   */
  loadGLB(url, onLoaded) {
    const loader = new THREE.GLBLoader();
    loader.load(
      url,
      (group) => {
        if (this.headMesh) this.scene.remove(this.headMesh);

        // GLB is already Y-up, no rotation needed
        const skinMat = new THREE.MeshStandardMaterial({
          color: 0xd4a574,
          roughness: 0.50,
          metalness: 0.02,
          side: THREE.FrontSide,
        });

        group.traverse((child) => {
          if (child.isMesh) {
            child.material = skinMat;
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        this.headMesh = group;
        this.headMesh.name = 'HeadMesh';
        this.scene.add(this.headMesh);

        const box = new THREE.Box3().setFromObject(this.headMesh);
        this.modelCenter = new THREE.Vector3();
        box.getCenter(this.modelCenter);
        this.modelHeight = box.max.y - box.min.y;

        const cY = this.modelCenter.y;
        this.controls.target.set(0, cY, 0);
        this.camera.position.set(0, cY, 4.5);
        this.controls.update();

        console.log(`GLB loaded: ${url}`);
        console.log(`  Center: (${this.modelCenter.x.toFixed(3)}, ${this.modelCenter.y.toFixed(3)}, ${this.modelCenter.z.toFixed(3)})`);
        console.log(`  Height: ${this.modelHeight.toFixed(3)}`);

        if (onLoaded) onLoaded(group);
      },
      null,
      (error) => {
        console.error('Failed to load GLB:', error);
        if (onLoaded) onLoaded(null);
      }
    );
  }

  /**
   * Load an OBJ model from a file path.
   * Applies -90° X rotation to convert from Blender Z-up to Three.js Y-up.
   */
  loadOBJ(url, onLoaded) {
    const loader = new THREE.OBJLoader();
    loader.load(
      url,
      (group) => {
        // Remove old head
        if (this.headMesh) {
          this.scene.remove(this.headMesh);
        }

        // ── Convert Blender Z-up → Three.js Y-up ──
        group.rotation.x = -Math.PI / 2;
        group.updateMatrixWorld(true);

        // Apply default skin material with SSS-like properties
        const skinMat = new THREE.MeshStandardMaterial({
          color: 0xd4a574,
          roughness: 0.50,
          metalness: 0.02,
          side: THREE.FrontSide,
        });

        group.traverse((child) => {
          if (child.isMesh) {
            child.material = skinMat;
            child.castShadow = true;
            child.receiveShadow = true;

            // Ensure geometry normals are correct after rotation
            if (child.geometry) {
              child.geometry.computeVertexNormals();
            }
          }
        });

        this.headMesh = group;
        this.headMesh.name = 'HeadMesh';
        this.scene.add(this.headMesh);

        // Compute bounding box in world space to set camera properly
        const box = new THREE.Box3().setFromObject(this.headMesh);
        this.modelCenter = new THREE.Vector3();
        box.getCenter(this.modelCenter);
        this.modelHeight = box.max.y - box.min.y;

        // Reposition camera for loaded model
        const cY = this.modelCenter.y;
        this.controls.target.set(0, cY, 0);
        this.camera.position.set(0, cY, 4.5);
        this.controls.update();

        console.log(`OBJ loaded: ${url}`);
        console.log(`  Model center: (${this.modelCenter.x.toFixed(3)}, ${this.modelCenter.y.toFixed(3)}, ${this.modelCenter.z.toFixed(3)})`);
        console.log(`  Model height: ${this.modelHeight.toFixed(3)}`);
        console.log(`  Bounds: min(${box.min.x.toFixed(2)}, ${box.min.y.toFixed(2)}, ${box.min.z.toFixed(2)}) max(${box.max.x.toFixed(2)}, ${box.max.y.toFixed(2)}, ${box.max.z.toFixed(2)})`);

        if (onLoaded) onLoaded(group);
      },
      (progress) => {
        if (progress.total > 0) {
          console.log(`Loading OBJ: ${(progress.loaded / progress.total * 100).toFixed(0)}%`);
        }
      },
      (error) => {
        console.error('Failed to load OBJ:', error);
        if (onLoaded) onLoaded(null);
      }
    );
  }

  /**
   * Add an imported 3D model to the scene as a reference overlay.
   * Parses GLB/OBJ from an ArrayBuffer and adds it alongside the head mesh.
   */
  addImportedModel(arrayBuffer, fileName) {
    const ext = fileName.split('.').pop().toLowerCase();

    // Track imported models for removal
    if (!this.importedModels) this.importedModels = [];

    const onParsed = (group) => {
      if (!group) {
        console.error('[Import] Failed to parse model:', fileName);
        return null;
      }

      // Apply a neutral material so it's distinguishable from the head
      const importMat = new THREE.MeshStandardMaterial({
        color: 0xaabbcc,
        roughness: 0.5,
        metalness: 0.1,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      });

      group.traverse((child) => {
        if (child.isMesh) {
          child.material = importMat;
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      // Scale and position the imported model to match the head
      const importBox = new THREE.Box3().setFromObject(group);
      const importSize = new THREE.Vector3();
      importBox.getSize(importSize);
      const importHeight = importSize.y;

      if (this.headMesh && importHeight > 0) {
        const headBox = new THREE.Box3().setFromObject(this.headMesh);
        const headSize = new THREE.Vector3();
        headBox.getSize(headSize);
        const scale = headSize.y / importHeight;
        group.scale.setScalar(scale);

        // Re-compute box after scaling
        const scaledBox = new THREE.Box3().setFromObject(group);
        const scaledCenter = new THREE.Vector3();
        scaledBox.getCenter(scaledCenter);

        // Align centers
        const headCenter = new THREE.Vector3();
        headBox.getCenter(headCenter);
        group.position.add(headCenter.sub(scaledCenter));
      }

      group.name = 'ImportedModel_' + fileName;
      this.scene.add(group);
      this.importedModels.push(group);

      let vertexCount = 0;
      group.traverse(c => {
        if (c.isMesh && c.geometry) vertexCount += c.geometry.attributes.position.count;
      });

      console.log(`[Import] Model added: ${fileName} (${vertexCount} vertices)`);
      return { group, vertexCount };
    };

    if (ext === 'glb' || ext === 'gltf') {
      const loader = new THREE.GLBLoader();
      const group = loader.parse(arrayBuffer);
      return onParsed(group);
    } else if (ext === 'obj') {
      const decoder = new TextDecoder();
      const text = decoder.decode(arrayBuffer);
      const loader = new THREE.OBJLoader();
      const group = loader.parse(text);
      if (group) group.rotation.x = -Math.PI / 2;
      return onParsed(group);
    } else {
      console.error('[Import] Unsupported format:', ext);
      return null;
    }
  }

  /**
   * Remove an imported model from the scene by index or all.
   */
  removeImportedModel(index) {
    if (!this.importedModels) return;
    if (index === undefined) {
      // Remove all
      this.importedModels.forEach(m => this.scene.remove(m));
      this.importedModels = [];
    } else if (this.importedModels[index]) {
      this.scene.remove(this.importedModels[index]);
      this.importedModels.splice(index, 1);
    }
  }

  /**
   * Create the base head mesh from geometry (procedural fallback)
   */
  createHead(geometry, material) {
    if (this.headMesh) {
      this.scene.remove(this.headMesh);
    }

    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: 0xd4a574,
        roughness: 0.55,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
    }

    this.headMesh = new THREE.Mesh(geometry, material);
    this.headMesh.castShadow = true;
    this.headMesh.receiveShadow = true;
    this.headMesh.name = 'HeadMesh';
    this.scene.add(this.headMesh);

    return this.headMesh;
  }

  /**
   * Update skin color on all head meshes
   */
  setSkinColor(color) {
    this._skinColor = color;
    if (!this.headMesh) return;

    // If skin texture system is active, regenerate with new color
    if (this.skinTextureSystem && this.skinTextureSystem._initialized) {
      this.skinTextureSystem.setSkinColor(color);
      // Lip color is handled via vertex colors on top of texture
      if (this._lipColor) {
        this._updateVertexColors();
      }
      return;
    }

    if (this._lipColor) {
      this._updateVertexColors();
    } else {
      this.headMesh.traverse((child) => {
        if (child.isMesh && child.material) {
          child.material.color.set(color);
        }
      });
    }
  }

  /**
   * Set lip color. Pass null to remove lip color.
   */
  setLipColor(color) {
    this._lipColor = color;
    if (!this.headMesh) return;

    if (color) {
      if (!this._lipWeights) {
        this._computeLipWeights();
        // Apply any manual paint overrides
        if (this._lipPaintOverrides) {
          this._applyPaintOverrides();
        }
      }
      this._updateVertexColors();
    } else {
      // Disable vertex colors
      this.headMesh.traverse((child) => {
        if (child.isMesh && child.material) {
          child.material.vertexColors = false;
          // If skin texture is active, let texture handle color
          if (this.skinTextureSystem && this.skinTextureSystem._initialized) {
            child.material.color.set(0xffffff);
          } else {
            child.material.color.set(this._skinColor);
          }
          child.material.needsUpdate = true;
        }
      });
    }
  }

  /**
   * Compute Gaussian weights for lip vertices based on lip landmarks.
   * Uses anisotropic distance (Y penalized 3x) so color stays tight
   * vertically while covering the full horizontal lip width.
   */
  _computeLipWeights() {
    // Dense lip landmarks — upper lip outer edge, inner edge, lower lip, and fill
    const lipLandmarks = [
      // ── Upper lip outer edge (top boundary — Cupid's bow shape) ──
      [-0.19, -0.29, 1.10],   // mouth_left corner
      [-0.16, -0.27, 1.12],
      [-0.13, -0.26, 1.13],
      [-0.10, -0.255, 1.135],
      [-0.07, -0.25, 1.14],
      [-0.04, -0.245, 1.145],
      [-0.02, -0.25, 1.15],   // Cupid's bow left dip
      [ 0.00, -0.255, 1.15],  // upper lip center
      [ 0.02, -0.25, 1.15],   // Cupid's bow right dip
      [ 0.04, -0.245, 1.145],
      [ 0.07, -0.25, 1.14],
      [ 0.10, -0.255, 1.135],
      [ 0.13, -0.26, 1.13],
      [ 0.16, -0.27, 1.12],
      [ 0.19, -0.29, 1.10],   // mouth_right corner

      // ── Upper lip body (between outer edge and mouth opening) ──
      [-0.15, -0.285, 1.12],
      [-0.10, -0.275, 1.135],
      [-0.05, -0.27, 1.145],
      [ 0.00, -0.275, 1.15],
      [ 0.05, -0.27, 1.145],
      [ 0.10, -0.275, 1.135],
      [ 0.15, -0.285, 1.12],

      // ── Mouth seam line (where lips meet) ──
      [-0.17, -0.30, 1.11],
      [-0.13, -0.295, 1.13],
      [-0.09, -0.29, 1.14],
      [-0.05, -0.29, 1.145],
      [ 0.00, -0.29, 1.15],
      [ 0.05, -0.29, 1.145],
      [ 0.09, -0.29, 1.14],
      [ 0.13, -0.295, 1.13],
      [ 0.17, -0.30, 1.11],

      // ── Lower lip body (between mouth opening and bottom edge) ──
      [-0.15, -0.315, 1.115],
      [-0.11, -0.325, 1.125],
      [-0.07, -0.33, 1.13],
      [-0.03, -0.335, 1.135],
      [ 0.00, -0.335, 1.135],
      [ 0.03, -0.335, 1.135],
      [ 0.07, -0.33, 1.13],
      [ 0.11, -0.325, 1.125],
      [ 0.15, -0.315, 1.115],

      // ── Lower lip outer edge (bottom boundary) ──
      [-0.17, -0.31, 1.11],
      [-0.14, -0.33, 1.115],
      [-0.10, -0.345, 1.12],
      [-0.06, -0.355, 1.125],
      [-0.03, -0.36, 1.13],
      [ 0.00, -0.36, 1.13],   // lower lip center bottom
      [ 0.03, -0.36, 1.13],
      [ 0.06, -0.355, 1.125],
      [ 0.10, -0.345, 1.12],
      [ 0.14, -0.33, 1.115],
      [ 0.17, -0.31, 1.11],

      // ── Extra lower lip fill (denser coverage for fuller lower lip) ──
      [-0.08, -0.34, 1.125],
      [-0.04, -0.35, 1.13],
      [ 0.00, -0.35, 1.13],
      [ 0.04, -0.35, 1.13],
      [ 0.08, -0.34, 1.125],
    ];

    const radius = 0.07;
    const twoR2 = 2 * radius * radius;
    // Anisotropic scale: penalize Y distance 4x to prevent vertical bleed
    const yScale = 4.0;

    const allWeights = [];

    this.headMesh.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      const pos = child.geometry.attributes.position;
      const N = pos.count;
      const weights = new Float32Array(N);

      for (const lp of lipLandmarks) {
        for (let i = 0; i < N; i++) {
          const dx = pos.getX(i) - lp[0];
          const dy = (pos.getY(i) - lp[1]) * yScale;
          const dz = pos.getZ(i) - lp[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          const w = Math.exp(-d2 / twoR2);
          if (w > weights[i]) weights[i] = w;
        }
      }

      // Threshold and smoothstep for clean lip edges
      for (let i = 0; i < N; i++) {
        let w = weights[i];
        if (w < 0.18) {
          weights[i] = 0;
        } else {
          // Remap 0.18..0.75 → 0..1, then smoothstep
          w = Math.max(0, Math.min(1, (w - 0.18) / 0.57));
          weights[i] = w * w * (3 - 2 * w);
        }
      }

      allWeights.push({ mesh: child, weights });
    });

    this._lipWeights = allWeights;
  }

  /**
   * Apply vertex colors blending skin color and lip color based on lip weights.
   */
  _updateVertexColors() {
    if (!this._lipWeights || !this._lipColor) return;

    // When skin textures are active, use white as base so texture shows through
    const hasTexture = this.skinTextureSystem && this.skinTextureSystem._initialized;
    const skinC = hasTexture ? new THREE.Color(1, 1, 1) : new THREE.Color(this._skinColor);
    const lipC = new THREE.Color(this._lipColor);

    for (const { mesh, weights } of this._lipWeights) {
      const geo = mesh.geometry;
      const N = geo.attributes.position.count;

      // Create or get color attribute
      let colorAttr = geo.attributes.color;
      if (!colorAttr || colorAttr.count !== N) {
        colorAttr = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
        geo.setAttribute('color', colorAttr);
      }

      const arr = colorAttr.array;
      for (let i = 0; i < N; i++) {
        const w = weights[i];
        arr[i * 3]     = skinC.r + (lipC.r - skinC.r) * w;
        arr[i * 3 + 1] = skinC.g + (lipC.g - skinC.g) * w;
        arr[i * 3 + 2] = skinC.b + (lipC.b - skinC.b) * w;
      }
      colorAttr.needsUpdate = true;

      // Enable vertex colors on material
      mesh.material.vertexColors = true;
      mesh.material.color.set(0xffffff);
      mesh.material.needsUpdate = true;
    }
  }

  /**
   * Apply manual paint overrides to computed lip weights.
   * Called by LipPainter after each stroke.
   */
  _applyPaintOverrides() {
    if (!this._lipWeights || !this._lipPaintOverrides) return;
    for (const entry of this._lipWeights) {
      const overrides = this._lipPaintOverrides.get(entry.mesh);
      if (!overrides) continue;
      for (let i = 0; i < entry.weights.length; i++) {
        if (overrides[i] !== undefined) {
          entry.weights[i] = Math.max(0, Math.min(1, entry.weights[i] + overrides[i]));
        }
      }
    }
  }

  /**
   * Invalidate cached lip weights so they recompute on next setLipColor.
   */
  invalidateLipWeights() {
    this._lipWeights = null;
  }

  /**
   * Setup studio lighting (3-point)
   */
  setupStudioLighting() {
    this.clearLights();

    // Key light — upper right front
    const keyLight = new THREE.DirectionalLight(0xffeedd, 1.8);
    keyLight.position.set(2, 3, 3);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 15;
    this.scene.add(keyLight);

    // Fill light — left side
    const fillLight = new THREE.DirectionalLight(0xccddff, 0.6);
    fillLight.position.set(-2, 2, 2);
    this.scene.add(fillLight);

    // Rim light — behind
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
    rimLight.position.set(0, 1, -3);
    this.scene.add(rimLight);

    // Ambient
    const ambientLight = new THREE.AmbientLight(0x404050, 0.4);
    this.scene.add(ambientLight);

    // Hemisphere light for natural fill
    const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0x362d20, 0.3);
    this.scene.add(hemiLight);

    this.lights = [keyLight, fillLight, rimLight, ambientLight, hemiLight];
  }

  /**
   * Outdoor lighting
   */
  setupOutdoorLighting() {
    this.clearLights();

    const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sunLight.position.set(3, 5, 2);
    sunLight.castShadow = true;
    this.scene.add(sunLight);

    const skyLight = new THREE.HemisphereLight(0x87CEEB, 0x362d20, 0.8);
    this.scene.add(skyLight);

    const bounceLight = new THREE.DirectionalLight(0x8899aa, 0.3);
    bounceLight.position.set(-1, 0, 1);
    this.scene.add(bounceLight);

    this.lights = [sunLight, skyLight, bounceLight];
  }

  /**
   * Dramatic lighting
   */
  setupDramaticLighting() {
    this.clearLights();

    const spotLight = new THREE.SpotLight(0xff8844, 3, 10, Math.PI / 6, 0.3);
    spotLight.position.set(2, 3, 1);
    spotLight.castShadow = true;
    this.scene.add(spotLight);

    const accent = new THREE.PointLight(0x4488ff, 1.5, 5);
    accent.position.set(-2, 1, -1);
    this.scene.add(accent);

    const ambient = new THREE.AmbientLight(0x0a0a14, 0.2);
    this.scene.add(ambient);

    this.lights = [spotLight, accent, ambient];
  }

  clearLights() {
    if (this.lights) {
      this.lights.forEach(light => this.scene.remove(light));
    }
    this.lights = [];
  }

  /**
   * Cycle through lighting modes
   */
  cycleLighting() {
    this.lightingMode = (this.lightingMode + 1) % 3;
    switch (this.lightingMode) {
      case 0: this.setupStudioLighting(); return 'Studio';
      case 1: this.setupOutdoorLighting(); return 'Outdoor';
      case 2: this.setupDramaticLighting(); return 'Dramatic';
    }
  }

  /**
   * Toggle wireframe mode (supports groups from OBJ)
   */
  toggleWireframe() {
    this.wireframeMode = !this.wireframeMode;
    if (this.headMesh) {
      this.headMesh.traverse((child) => {
        if (child.isMesh && child.material) {
          child.material.wireframe = this.wireframeMode;
        }
      });
    }
    return this.wireframeMode;
  }

  /**
   * Camera view presets (Y-up coordinate system)
   * Front = +Z looking toward origin, right = +X, up = +Y
   */
  setView(view) {
    const cY = this.modelCenter.y;
    const target = new THREE.Vector3(0, cY, 0);
    let pos;

    switch (view) {
      case 'front':
        pos = new THREE.Vector3(0, cY, 4.5);
        break;
      case 'side':
        pos = new THREE.Vector3(4.5, cY, 0);
        break;
      case '34':
        pos = new THREE.Vector3(3.2, cY + 0.3, 3.2);
        break;
      case 'top':
        pos = new THREE.Vector3(0, 5, 0.01);
        break;
      case 'back':
        pos = new THREE.Vector3(0, cY, -4.5);
        break;
    }

    // Smooth animation
    this.animateCamera(pos, target);
    return view;
  }

  /**
   * Animate camera to target position
   */
  animateCamera(targetPos, targetLookAt) {
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    let t = 0;

    const animate = () => {
      t += 0.04;
      if (t > 1) t = 1;

      const eased = 1 - Math.pow(1 - t, 3); // Ease out cubic

      this.camera.position.lerpVectors(startPos, targetPos, eased);
      this.controls.target.lerpVectors(startTarget, targetLookAt, eased);
      this.controls.update();

      if (t < 1) {
        requestAnimationFrame(animate);
      }
    };

    animate();
  }

  /**
   * Take a screenshot of the viewport
   */
  takeScreenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  /**
   * Get vertex count
   */
  getVertexCount() {
    let count = 0;
    this.scene.traverse((child) => {
      if (child.geometry) {
        count += child.geometry.attributes.position.count;
      }
    });
    return count;
  }

  /**
   * Resize handler
   */
  resize() {
    const viewport = document.getElementById('viewport');
    if (!viewport) return;

    const width = viewport.clientWidth;
    const height = viewport.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  /**
   * Get camera state for saving
   */
  getCameraState() {
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
    };
  }

  /**
   * Restore camera state
   */
  loadCameraState(state) {
    if (!state) return;
    if (state.position) this.camera.position.fromArray(state.position);
    if (state.target) this.controls.target.fromArray(state.target);
    this.controls.update();
  }

  /**
   * Animation loop
   */
  animate() {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

window.SceneManager = SceneManager;
