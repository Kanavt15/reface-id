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
          // Wrinkle texture maps (initially null, set by WrinkleSystem)
          normalMap: null,
          normalScale: new THREE.Vector2(1.0, 1.0),
          displacementMap: null,
          displacementScale: 0.01,
        });

        group.traverse((child) => {
          if (child.isMesh) {
            // Ensure UV coordinates exist
            if (child.geometry) {
              this._ensureUVCoordinates(child.geometry);
            }
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
          // Wrinkle texture maps (initially null, set by WrinkleSystem)
          normalMap: null,
          normalScale: new THREE.Vector2(1.0, 1.0),
          displacementMap: null,
          displacementScale: 0.01,
        });

        group.traverse((child) => {
          if (child.isMesh) {
            child.material = skinMat;
            child.castShadow = true;
            child.receiveShadow = true;

            // Ensure geometry normals are correct after rotation
            if (child.geometry) {
              child.geometry.computeVertexNormals();
              // Ensure UV coordinates exist
              this._ensureUVCoordinates(child.geometry);
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
    if (!this.headMesh) return;
    this.headMesh.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material.color.set(color);
      }
    });
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
   * Ensure geometry has UV coordinates (generate if missing)
   */
  _ensureUVCoordinates(geometry) {
    if (geometry.attributes.uv) {
      console.log('[SceneManager] UV coordinates already exist');
      return;  // Already has UVs
    }

    console.log('[SceneManager] Generating UV coordinates via planar projection');

    const positions = geometry.attributes.position;
    const uvArray = new Float32Array(positions.count * 2);

    // Generate planar projection UVs (works well for front-facing faces)
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);

      // Map X and Y to [0, 1] range
      uvArray[i * 2] = (x + 1.0) * 0.5;      // U from X
      uvArray[i * 2 + 1] = (y + 1.5) * 0.5;  // V from Y
    }

    geometry.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
    console.log('[SceneManager] UV coordinates generated');
  }

  /**
   * Update wrinkle textures on the head mesh material
   */
  updateWrinkleTextures(normalTexture, displacementTexture) {
    if (!this.headMesh) {
      console.warn('[SceneManager] Cannot update wrinkle textures: no head mesh');
      return;
    }

    let updated = false;

    this.headMesh.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material.normalMap = normalTexture;
        child.material.displacementMap = displacementTexture;
        child.material.needsUpdate = true;
        updated = true;
      }
    });

    if (updated) {
      console.log('[SceneManager] Wrinkle textures updated');
    } else {
      console.warn('[SceneManager] No meshes found to update');
    }
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
