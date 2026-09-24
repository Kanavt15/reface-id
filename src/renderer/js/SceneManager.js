// Owns the Three.js scene: renderer, camera, lights, the head mesh and its skin material, view presets and screenshots (Y is up).

class SceneManager {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.scene = new THREE.Scene();
    this.headMesh = null;
    this.wireframeMode = false;
    this.lightingMode = 0; // 0 = studio, 1 = outdoor, 2 = dramatic

    // Photoreal uses the studio lighting; Structure shows flat shading with a floor and grid, easier for sculpting.
    this.renderMode = 'photoreal';
    this.environmentSystem = null;
    this._skinMaterial = null;

    // Model bounding info (set after loading)
    this.modelCenter = new THREE.Vector3(0, 0.18, 0);
    this.modelHeight = 2.2;

    // Lip color state
    this._skinColor = '#cb9a78';
    this._lipColor = null;
    this._lipWeights = null; // cached per-vertex lip weights
    this._lipPaintOverrides = null; // Map<mesh, Float32Array> manual paint deltas

    // Skin texture system reference (set externally)
    this.skinTextureSystem = null;

    // Quality tier, which sets the post effects, skin map size and pixel ratio cap.
    this.qualityTier = 'medium';

    // Countdown to the next shadow map rebuild; see _refreshShadows().
    this._shadowFrame = 0;

    this.init();
  }

  // Creates the renderer, camera, controls, lighting and post effects, then starts the render loop.
  init() {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true, // For screenshots
    });
    this.renderer.setPixelRatio(this._targetPixelRatio());
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;

    // Don't redraw the shadow map every frame, since the hair alone is about 950k triangles; _refreshShadows() handles it.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Preserve complexion variation in highlights; PostFX shares this exposure.
    this.renderer.toneMappingExposure = 0.88;
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

    // Image-based lighting, built before the lights so the softboxes and shadows line up; without it skin looks like clay.
    this.environmentSystem = new EnvironmentSystem(this.renderer);
    this.environmentSystem.build();
    this.scene.environment = this.environmentSystem.texture;

    // Background
    this._structureBackground = new THREE.Color(0x1a1a24);
    this._photoBackground = this.environmentSystem.buildBackground();
    this.scene.background = this._photoBackground;

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
    this.ground = ground;

    // Grid helper
    const grid = new THREE.GridHelper(6, 30, 0x2a2a3a, 0x1f1f2f);
    grid.position.y = -0.99;
    this.scene.add(grid);
    this.grid = grid;

    // Lighting
    this.setupStudioLighting();

    // Post effects, created before the first resize so they get real dimensions straight away.
    if (window.PostFX) {
      this.postFX = new PostFX(this.renderer);
      this.postFX.setTier('medium');
    }

    // Applies the ground/grid/background visibility for the starting mode.
    this.setRenderMode(this.renderMode);

    // Handle resize
    this.resize();
    window.addEventListener('resize', () => this.resize());

    // Start render loop
    this.animate();
  }

  // Frames between automatic shadow refreshes, a safety net so a missed invalidateShadows() only lags briefly.
  static get SHADOW_REFRESH_FRAMES() {
    return 6;
  }

  // Forces the shadow map to rebuild on the next frame.
  invalidateShadows() {
    this._shadowFrame = 0;
    if (this.renderer) this.renderer.shadowMap.needsUpdate = true;
  }

  // Rebuilds the shadow map when asked or every few frames.
  _refreshShadows() {
    if (!this.renderer.shadowMap.enabled) return;
    if (this._shadowFrame-- <= 0) {
      this.renderer.shadowMap.needsUpdate = true;
      this._shadowFrame = SceneManager.SHADOW_REFRESH_FRAMES;
    }
  }

  // Highest pixel ratio per quality tier, so high-DPI screens keep a steady frame rate.
  static get PIXEL_RATIO_CAP() {
    return { low: 1.0, medium: 1.25, high: 2.0 };
  }

  // Returns the pixel ratio to render at, within the tier's cap.
  _targetPixelRatio() {
    const cap = SceneManager.PIXEL_RATIO_CAP[this.qualityTier] ?? 1.5;
    return Math.min(window.devicePixelRatio || 1, cap);
  }

  // The photoreal skin surface values, kept in one place so they can't drift apart.
  static get SKIN() {
    return {
      roughness: 0.62,
      specularIntensity: 0.55,
      // Restrained oil and fuzz layers over the broad skin reflection.
      clearcoat: 0.025,
      clearcoatRoughness: 0.85,
      envMapIntensity: 0.60,
      sheen: 0.06,
      sheenRoughness: 0.90,
      sheenColor: 0xffeee0,
    };
  }

  // Applies the shared skin surface values for the current mode.
  static applySkinSurface(material, photoreal) {
    const skin = SceneManager.SKIN;
    material.envMapIntensity = photoreal ? skin.envMapIntensity : 0;
    if (!material.isMeshPhysicalMaterial) return;
    material.specularIntensity = photoreal ? skin.specularIntensity : 0.25;
    material.clearcoat = photoreal ? skin.clearcoat : 0;
    material.clearcoatRoughness = skin.clearcoatRoughness;
    material.sheen = photoreal ? skin.sheen : 0;
    material.sheenRoughness = skin.sheenRoughness;
    material.sheenColor.set(skin.sheenColor);
  }

  // Creates the skin material: two reflection layers (clearcoat for oil) and skin's refractive index of 1.4.
  _createSkinMaterial() {
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xcb9a78,
      roughness: SceneManager.SKIN.roughness,
      metalness: 0.0,
      ior: 1.4,
      specularIntensity: SceneManager.SKIN.specularIntensity,
      clearcoat: SceneManager.SKIN.clearcoat,
      clearcoatRoughness: SceneManager.SKIN.clearcoatRoughness,
      envMapIntensity: SceneManager.SKIN.envMapIntensity,
      sheen: SceneManager.SKIN.sheen,
      sheenRoughness: SceneManager.SKIN.sheenRoughness,
      sheenColor: new THREE.Color(SceneManager.SKIN.sheenColor),
      side: THREE.FrontSide,
    });

    // Add scattering, pore detail and crease shading, or fall back to a plain material.
    if (window.SkinShader) {
      SkinShader.attach(mat);
      this._skinShaderMaterials = this._skinShaderMaterials || [];
      this._skinShaderMaterials.push(mat);
    }

    this._skinMaterial = mat;
    return mat;
  }

  // Loads a GLB head model, which is already Y-up.
  loadGLB(url, onLoaded) {
    const loader = new THREE.GLBLoader();
    loader.load(
      url,
      (group) => {
        if (this.headMesh) this.scene.remove(this.headMesh);

        // GLB is already Y-up, no rotation needed
        const skinMat = this._createSkinMaterial();

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

        // Compute crease shading for the starting shape; OBJMorpher refreshes it after morphs.
        if (window.SkinShader) SkinShader.computeCavity(this.headMesh);

        const box = new THREE.Box3().setFromObject(this.headMesh);
        this.modelCenter = new THREE.Vector3();
        box.getCenter(this.modelCenter);
        this.modelHeight = box.max.y - box.min.y;
        // Refit the shadows to the new head.
        this.updateShadowFrustums();

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

  // Adds an imported 3D model next to the head as a reference.
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

  // Removes one imported model by index, or all of them.
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

  // Creates the fallback head mesh from procedural geometry.
  createHead(geometry, material) {
    if (this.headMesh) {
      this.scene.remove(this.headMesh);
    }

    if (!material) {
      material = this._createSkinMaterial();
      material.side = THREE.DoubleSide;
    }

    this.headMesh = new THREE.Mesh(geometry, material);
    this.headMesh.castShadow = true;
    this.headMesh.receiveShadow = true;
    this.headMesh.name = 'HeadMesh';
    this.scene.add(this.headMesh);

    return this.headMesh;
  }

  // Sets the skin colour on the head.
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

  // Sets the lip colour, or removes it when given null.
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

  // Works out how strongly each vertex belongs to the lips, keeping the colour tight vertically.
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

  // Blends skin and lip colour into the vertex colours using the lip weights.
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

  // Applies the lip painter's manual changes to the lip weights.
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

  // Sets up neutral portrait lighting with a gentle key-to-fill difference.
  setupStudioLighting() {
    this.clearLights();

    // A moderate key shapes the face without overpowering the skin detail.
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.10);
    keyLight.position.set(1.95, 2.15, 3.05);
    keyLight.castShadow = true;
    this._configureShadow(keyLight, true);
    this.scene.add(keyLight);

    // A neutral fill keeps the shadowed cheek readable without a second shadow.
    const fillLight = new THREE.DirectionalLight(0xf4f5f7, 0.70);
    fillLight.position.set(-2.7, 0.65, 2.3);
    this.scene.add(fillLight);

    // Two offset rim lights catch the jaw and far cheek instead of haloing the nose and ears.
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.08);
    rimLight.position.set(-1.9, 1.5, -2.4);
    this.scene.add(rimLight);

    const rimLight2 = new THREE.DirectionalLight(0xf6f9ff, 0.04);
    rimLight2.position.set(2.1, 1.2, -2.2);
    this.scene.add(rimLight2);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.18);
    this.scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xf0f2f5, 0x77736d, 0.14);
    this.scene.add(hemiLight);

    // Keep a handle so Structure mode can raise the fill, since it has no environment light.
    this._ambientLight = ambientLight;
    this._hemiLight = hemiLight;
    this.lights = [keyLight, fillLight, rimLight, rimLight2, ambientLight, hemiLight];
    this._applyModeLighting();
    this.updateShadowFrustums();
  }

  // Fits a light's shadow to the head; the studio key uses a soft, wide filter.
  _configureShadow(light, soft = false) {
    // A smaller map with a wide filter gives the studio shadow a smooth falloff.
    light.shadow.mapSize.width = soft ? 1024 : 2048;
    light.shadow.mapSize.height = soft ? 1024 : 2048;
    light.shadow.radius = soft ? 48 : 2;
    light.shadow.blurSamples = soft ? 24 : 8;
    light.shadow.bias = -0.00005;
    light.shadow.normalBias = 0.018;
    this._shadowLights = this._shadowLights || [];
    if (!this._shadowLights.includes(light)) this._shadowLights.push(light);
    this.updateShadowFrustums();
  }

  // Fits every shadow camera to the head's bounding sphere, whichever way the lights point.
  updateShadowFrustums() {
    if (!this._shadowLights || !this._shadowLights.length) return;

    let center = this.modelCenter ? this.modelCenter.clone() : new THREE.Vector3();
    let radius = 2.2;

    if (this.headMesh) {
      const box = new THREE.Box3().setFromObject(this.headMesh);
      if (!box.isEmpty()) {
        box.getCenter(center);
        // Half the diagonal: the smallest sphere at `center` containing the box.
        radius = box.getSize(new THREE.Vector3()).length() * 0.5;
      }
    }

    // Headroom for hair, and for a morph that grows the head between fits.
    const extent = radius * 1.25;

    for (const light of this._shadowLights) {
      const cam = light.shadow.camera;
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;

      // Clamp near and far to the head's depth so the shadow depth precision goes where it matters.
      const dist = light.position.distanceTo(center);
      cam.near = Math.max(0.05, dist - extent);
      cam.far = dist + extent;
      cam.updateProjectionMatrix();

      // Aim the light at the head, not the world origin.
      light.target.position.copy(center);
      if (!light.target.parent) this.scene.add(light.target);
      light.target.updateMatrixWorld();
    }
  }

  // Switches between the photoreal look and the flat Structure view used for judging shape.
  setRenderMode(mode) {
    this.renderMode = mode === 'structure' ? 'structure' : 'photoreal';
    const photo = this.renderMode === 'photoreal';

    this.scene.environment = photo ? this.environmentSystem.texture : null;
    this.scene.background = photo ? this._photoBackground : this._structureBackground;
    if (this.ground) this.ground.visible = !photo;
    if (this.grid) this.grid.visible = !photo;

    // Structure mode strips the skin back to a plain surface so the shape reads clearly.
    if (this.headMesh) {
      this.headMesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mat = child.material;
        if (window.SkinShader) SkinShader.setEnabled(mat, photo);
        SceneManager.applySkinSurface(mat, photo);
        mat.needsUpdate = true;
      });
    }

    this._applyModeLighting();

    if (this.postFX) this.postFX.setEnabled(photo);
    return this.renderMode;
  }

  // Adjusts the ambient fill for the current mode.
  _applyModeLighting() {
    const photo = this.renderMode === 'photoreal';
    // Use restrained neutral bounce in Photoreal and stronger fill in Structure.
    if (this._ambientLight) this._ambientLight.intensity = photo ? 0.18 : 0.55;
    if (this._hemiLight) this._hemiLight.intensity = photo ? 0.14 : 0.45;
  }

  // Toggles between Photoreal and Structure and returns the new mode's label.
  toggleRenderMode() {
    const next = this.renderMode === 'photoreal' ? 'structure' : 'photoreal';
    this.setRenderMode(next);
    return next === 'photoreal' ? 'Photoreal' : 'Structure';
  }

  // Sets up outdoor lighting.
  setupOutdoorLighting() {
    this.clearLights();

    const sunLight = new THREE.DirectionalLight(0xfff4e0, 1.5);
    sunLight.position.set(3, 5, 2);
    sunLight.castShadow = true;
    this._configureShadow(sunLight);
    // The outdoor preset uses a narrow shadow filter for direct sunlight.
    this.scene.add(sunLight);

    const skyLight = new THREE.HemisphereLight(0x87CEEB, 0x362d20, 0.35);
    this.scene.add(skyLight);

    const bounceLight = new THREE.DirectionalLight(0x8899aa, 0.3);
    bounceLight.position.set(-1, 0, 1);
    this.scene.add(bounceLight);

    this.lights = [sunLight, skyLight, bounceLight];
  }

  // Sets up dramatic lighting.
  setupDramaticLighting() {
    this.clearLights();

    const spotLight = new THREE.SpotLight(0xff8844, 3, 10, Math.PI / 6, 0.3);
    spotLight.position.set(2, 3, 1);
    spotLight.castShadow = true;
    spotLight.shadow.mapSize.width = 2048;
    spotLight.shadow.mapSize.height = 2048;
    spotLight.shadow.radius = 4;
    spotLight.shadow.bias = -0.0005;
    spotLight.shadow.normalBias = 0.02;
    this.scene.add(spotLight);

    const accent = new THREE.PointLight(0x4488ff, 1.5, 5);
    accent.position.set(-2, 1, -1);
    this.scene.add(accent);

    const ambient = new THREE.AmbientLight(0x0a0a14, 0.2);
    this.scene.add(ambient);

    this.lights = [spotLight, accent, ambient];
  }

  // Removes every light, along with the shadow targets and references tied to them.
  clearLights() {
    if (this.lights) {
      this.lights.forEach((light) => {
        // Remove each light's target too, since it was added to the scene for aiming.
        if (light.target && light.target.parent === this.scene) {
          this.scene.remove(light.target);
        }
        this.scene.remove(light);
      });
    }
    this.lights = [];
    // Only the studio preset sets these, so clear them.
    this._ambientLight = null;
    this._hemiLight = null;
    // Empty the shadow list so old lights aren't re-aimed.
    this._shadowLights = [];
  }

  // Cycles to the next lighting preset.
  cycleLighting() {
    this.lightingMode = (this.lightingMode + 1) % 3;
    // Moving the lights changes every shadow, so rebuild now.
    this.invalidateShadows();
    switch (this.lightingMode) {
      case 0: this.setupStudioLighting(); return 'Studio';
      case 1: this.setupOutdoorLighting(); return 'Outdoor';
      case 2: this.setupDramaticLighting(); return 'Dramatic';
    }
  }

  // Turns wireframe view on or off.
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

  // Moves the camera to a preset view (front is +Z, right is +X, up is +Y).
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

  // Smoothly animates the camera to a new position and target.
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

  // Draws the scene; every screenshot and capture goes through here so it matches the screen.
  renderFrame() {
    if (this.postFX && this.postFX.enabled) {
      this.postFX.render(this.scene, this.camera);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  // Captures the viewport as an image.
  takeScreenshot() {
    this.renderFrame();
    return this.canvas.toDataURL('image/png');
  }

  // Returns the head's vertex count.
  getVertexCount() {
    let count = 0;
    this.scene.traverse((child) => {
      if (child.geometry) {
        count += child.geometry.attributes.position.count;
      }
    });
    return count;
  }

  // Resizes the renderer and camera to fit the viewport.
  resize() {
    const viewport = document.getElementById('viewport');
    if (!viewport) return;

    const width = viewport.clientWidth;
    const height = viewport.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    if (this.postFX) this.postFX.setSize(width, height);
  }

  // Sets the quality tier ('low' turns off post effects) and returns the active tier.
  setQualityTier(tier) {
    // The tier also sets the skin map resolution, since those are rebuilt on every slider move.
    this.qualityTier = tier;
    if (this.skinTextureSystem) {
      this.skinTextureSystem.setResolution(tier === 'high' ? 1024 : 512);
    }

    // Rebuild the renderer and post targets for the new pixel ratio.
    const pr = this._targetPixelRatio();
    if (this.renderer.getPixelRatio() !== pr) {
      this.renderer.setPixelRatio(pr);
      this.resize();
    }

    if (!this.postFX) return 'low';
    const active = this.postFX.setTier(tier);
    // Low turns post off, which hands tone mapping back to the renderer.
    if (this.renderMode === 'structure') this.postFX.setEnabled(false);
    return active;
  }

  // Returns the camera position and target for saving.
  getCameraState() {
    return {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
    };
  }

  // Restores a saved camera position and target.
  loadCameraState(state) {
    if (!state) return;
    if (state.position) this.camera.position.fromArray(state.position);
    if (state.target) this.controls.target.fromArray(state.target);
    this.controls.update();
  }

  // Render loop: updates the controls, shadows and grain, then draws a frame.
  animate() {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    if (this.postFX) this.postFX.tick();
    this._refreshShadows();
    this.renderFrame();
  }
}

window.SceneManager = SceneManager;
