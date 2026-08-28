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

    // Render mode: 'photoreal' shades against the studio IBL and hides the
    // technical backdrop; 'structure' restores the flat matte shading and the
    // ground/grid, which is far easier to read while sculpting 180 sliders.
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
    /* Exposure dropped from 1.2 when the studio IBL below started contributing
       real energy that had previously been faked with a hot key light, and
       again to 0.92 once the four-light rig went in.
       ACES desaturates as it rolls off, so an over-exposed face does not just
       read as bright — it reads as pale and colourless, which is most of what
       made this head look like a wax model. Holding the forehead and the
       cheekbones below the shoulder of the curve is what lets the melanin and
       haemoglobin variation in the diffuse map survive to the screen at all.
       Down again to 0.84 with the loop key: the face was sitting at a median
       of 151 and a 90th percentile of 172 out of 255, which is most of the way
       up the curve where ACES is flattest, so the new shading gradient would
       have been compressed away as fast as the key created it. */
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

    // ── Image-based lighting ──
    // Everything else in this file is downstream of this: with no
    // scene.environment a PBR material's specular lobe has nothing to reflect
    // and skin renders as flat clay. Built before the lights so the softbox
    // directions and the shadow-casting directions are set up as one thing.
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

    // Post-processing. Created before the first resize so setSize() below can
    // give it real dimensions on the very first frame.
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

  /**
   * The photoreal skin surface constants, in one place.
   *
   * These used to be written out as literals in three separate files —
   * _createSkinMaterial() here, setRenderMode() below, and
   * SkinTextureSystem._applyToMesh(), which runs last on every slider tick and
   * therefore won. They had already drifted apart once (envMapIntensity was
   * 0.9 in two of them and 0.4 in the third, so regenerating the skin textures
   * silently halved the IBL contribution), and clearcoat drifted the same way
   * the moment it was retuned. Anything the three of them share belongs here.
   */
  static get SKIN() {
    return {
      clearcoat: 0.10,
      /* Multiplied by clearcoatRoughnessMap, which SkinTextureSystem binds to
         the skin roughness map — so this is the top of the range, not a flat
         value. A T-zone texel lands near 0.11 (a tight wet highlight) and a dry
         cheek near 0.33 (broad and soft). At the old constant 0.22 every part
         of the face had an identically tight sheen, which is the plastic look. */
      clearcoatRoughness: 0.55,
      /* Eased from 0.9. The studio IBL is four broad softboxes, so it fills
         from every direction at once — exactly what a face needs for its
         specular to look real, and exactly what flattens its diffuse shading
         if it is doing too much of the lighting. This keeps the reflections
         and hands the shading gradients back to the key. */
      envMapIntensity: 0.88,
    };
  }

  /**
   * The one place the skin material is defined.
   *
   * MeshPhysicalMaterial rather than MeshStandardMaterial because skin needs
   * two specular lobes: a broad dermal one (`roughness`) and a tight oily
   * epidermal one on top. `clearcoat` is a cheap stand-in for the second lobe
   * and is most of what separates "skin" from "painted plastic" at a glance.
   *
   * `ior` 1.4 is skin's measured refractive index — the default 1.5 is glass
   * and gives a slightly too-bright grazing edge.
   */
  _createSkinMaterial() {
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xcb9a78,
      roughness: 0.45,
      metalness: 0.0,
      ior: 1.4,
      specularIntensity: 1.0,
      clearcoat: SceneManager.SKIN.clearcoat,
      clearcoatRoughness: SceneManager.SKIN.clearcoatRoughness,
      envMapIntensity: SceneManager.SKIN.envMapIntensity,
      side: THREE.FrontSide,
    });

    // Pre-integrated subsurface scattering, pore detail and cavity occlusion.
    // Degrades to a plain physical material if the injection is unavailable.
    if (window.SkinShader) {
      SkinShader.attach(mat);
      this._skinShaderMaterials = this._skinShaderMaterials || [];
      this._skinShaderMaterials.push(mat);
    }

    this._skinMaterial = mat;
    return mat;
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

        // Seed the cavity attribute for the undeformed mesh; OBJMorpher
        // refreshes it after every morph settles.
        if (window.SkinShader) SkinShader.computeCavity(this.headMesh);

        const box = new THREE.Box3().setFromObject(this.headMesh);
        this.modelCenter = new THREE.Vector3();
        box.getCenter(this.modelCenter);
        this.modelHeight = box.max.y - box.min.y;
        // The shadow frustum is fitted to the subject, so it has to be refitted
        // whenever the subject changes.
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

        const skinMat = this._createSkinMaterial();

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

        // Seed the cavity attribute for the undeformed mesh; OBJMorpher
        // refreshes it after every morph settles.
        if (window.SkinShader) SkinShader.computeCavity(this.headMesh);

        // Compute bounding box in world space to set camera properly
        const box = new THREE.Box3().setFromObject(this.headMesh);
        this.modelCenter = new THREE.Vector3();
        box.getCenter(this.modelCenter);
        this.modelHeight = box.max.y - box.min.y;
        // The shadow frustum is fitted to the subject, so it has to be refitted
        // whenever the subject changes.
        this.updateShadowFrustums();

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
   * Setup studio lighting.
   *
   * LOOP LIGHTING — FORM WITHOUT DRAMA
   * ----------------------------------
   * Two earlier placements, and this is the third. The key began at (2,3,3),
   * 45 degrees off axis and 45 up — Rembrandt. That throws the nose shadow
   * clear across the cheek and hides the nasolabial fold and the cheekbone,
   * which are exactly the features an identification is made on. So it was
   * pulled in to 18 degrees off axis and 27 up, the passport-photo placement.
   *
   * That over-corrected. Measured off a rendered front view, the left and
   * right cheeks came out within 3% of each other — a 1.03:1 ratio across the
   * face, which is not low-contrast lighting, it is no lighting: nothing in
   * the image tells the eye the head is round. Combined with the IBL and the
   * two rims all filling from their own directions, the whole face sat inside
   * an 80-level band with no shadow anywhere in it. A head lit that evenly
   * reads as a drawing of a head, and no amount of skin detail survives it.
   *
   * The key now sits at about 33 degrees off axis and 32 up. That is loop
   * lighting — the standard flattering portrait key, and the one placement
   * that buys real modelling without the Rembrandt cost: the nose shadow
   * stays a short wedge angled down and out, and never reaches the cheek
   * shadow to close the loop. Both sides of the face stay readable, which is
   * the constraint that matters here, but they are no longer the same value.
   */
  setupStudioLighting() {
    this.clearLights();

    // Intensities are roughly halved from the pre-IBL values, and the ambient
    // and hemisphere lights are cut hard. The studio environment now supplies
    // the fill that those were faking, and leaving them at the old levels
    // double-counts it — which washes the face out and flattens exactly the
    // shading gradients the IBL was added to restore.
    /* Up from 0.95 with the dome halved. The old number was set against an
       environment that was doing much of the lighting on its own; against a
       dark studio the key has to actually light the face. Raising it rather
       than lifting exposure or the fill is deliberate — it is the one source
       with a direction, so every unit of it adds modelling instead of
       averaging it away. */
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.25);
    keyLight.position.set(1.95, 2.15, 3.05);
    keyLight.castShadow = true;
    this._configureShadow(keyLight);
    this.scene.add(keyLight);

    /* Fill — opposite side, and low, so it lifts the shadowed cheek and the
       underside of the jaw without adding a second catchlight or a second set
       of shadows. Cool, because a real fill card is bouncing skylight. */
    const fillLight = new THREE.DirectionalLight(0xd6e2f5, 0.20);
    fillLight.position.set(-2.7, 0.65, 2.3);
    this.scene.add(fillLight);

    /* Two kickers rather than one light straight behind. A single rim on the
       axis rims the nose and the ears equally, which reads as a halo; offset
       pairs catch the jawline and the far cheek instead, which is what
       separates a head from its background. */
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.30);
    rimLight.position.set(-1.9, 1.5, -2.4);
    this.scene.add(rimLight);

    const rimLight2 = new THREE.DirectionalLight(0xf6f9ff, 0.16);
    rimLight2.position.set(2.1, 1.2, -2.2);
    this.scene.add(rimLight2);

    const ambientLight = new THREE.AmbientLight(0x404050, 0.12);
    this.scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0x9fb4c2, 0x2b2a2a, 0.10);
    this.scene.add(hemiLight);

    /* Named so setRenderMode() can put the fill back for Structure mode, which
       has no environment to supply it and would otherwise render the head
       under a bare key light with pitch-black shadow sides. */
    this._ambientLight = ambientLight;
    this._hemiLight = hemiLight;
    this.lights = [keyLight, fillLight, rimLight, rimLight2, ambientLight, hemiLight];
    this._applyModeLighting();
    this.updateShadowFrustums();
  }

  /**
   * Shadow settings shared by every shadow-casting light.
   *
   * Two bugs lived here, and between them they produced every grey smudge on
   * the face.
   *
   * 1. THE FRUSTUM WAS TOO SMALL FOR THE SUBJECT. The orthographic shadow
   *    camera was pinned at +/-1.6 x +/-1.8. The head with its neck measures
   *    1.9 x 3.1 x 2.2, and seen from a light 45 degrees up its silhouette is
   *    about 3.8 tall — so the bottom of the neck fell outside. three's shadow
   *    lookup treats anything outside the frustum as fully lit, so the boundary
   *    landed on the neck as a dead-straight diagonal line with shadow on one
   *    side and none on the other. Hardcoded extents cannot be right for a mesh
   *    the morph sliders resize, so updateShadowFrustums() now fits them to the
   *    real bounding sphere and this function only sets what is scale-free.
   *
   * 2. DEPTH BIAS AT GRAZING INCIDENCE. `bias` is in normalised depth, so over
   *    a near 0.5 / far 12 range -0.0005 was pushing the comparison ~5.8mm
   *    through the surface. Where the light rakes along a cheek that offset
   *    converts to a lateral slide of the shadow by bias/tan(angle) — which is
   *    how the nose shadow ended up as a detached oval floating on the cheek.
   *    `normalBias` is the right tool: it offsets along the surface normal in
   *    world units and scales with the angle by construction, so peter-panning
   *    stays bounded. Depth bias drops to a hair above nothing, and the tighter
   *    near/far below buys back the precision that pays for it.
   *
   * `radius` is deliberately absent: it is ignored under PCFSoftShadowMap, so
   * the 3 that used to sit here did nothing at all.
   */
  _configureShadow(light) {
    // 2048 over a frustum fitted to the head is ~0.15mm per texel — finer than
    // the geometry can express. 4096 quadrupled the cost to render the same
    // shadow.
    light.shadow.mapSize.width = 2048;
    light.shadow.mapSize.height = 2048;
    light.shadow.bias = -0.00005;
    light.shadow.normalBias = 0.018;
    this._shadowLights = this._shadowLights || [];
    if (!this._shadowLights.includes(light)) this._shadowLights.push(light);
    this.updateShadowFrustums();
  }

  /**
   * Fit every shadow camera to the subject.
   *
   * Called after the head loads and whenever it is replaced, because the
   * imported meshes differ in scale by more than a factor of two and a frustum
   * fitted to one clips another. Uses the bounding sphere rather than the box
   * so the fit is orientation-independent — the same extents are correct from
   * whatever direction each light happens to sit.
   */
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

      /* A DirectionalLight's shadow camera sits at the light's position and
         looks at its target, so the subject spans `dist +/- extent` along that
         axis. Clamping near/far to that band instead of 0.5..12 concentrates
         the depth buffer on the head, which is what makes the tiny depth bias
         above survivable. */
      const dist = light.position.distanceTo(center);
      cam.near = Math.max(0.05, dist - extent);
      cam.far = dist + extent;
      cam.updateProjectionMatrix();

      // Aim the light at the head. Without this the shadow camera points at
      // the world origin, and the head is not centred there.
      light.target.position.copy(center);
      if (!light.target.parent) this.scene.add(light.target);
      light.target.updateMatrixWorld();
    }
  }

  /**
   * Switch between the photoreal look and the flat technical view.
   *
   * Structure mode is not just "photoreal off" — a matte unlit-ish surface with
   * a ground plane and grid genuinely reads better when you are judging the
   * shape of a jaw against a slider, which is most of what this app is for.
   */
  setRenderMode(mode) {
    this.renderMode = mode === 'structure' ? 'structure' : 'photoreal';
    const photo = this.renderMode === 'photoreal';

    this.scene.environment = photo ? this.environmentSystem.texture : null;
    this.scene.background = photo ? this._photoBackground : this._structureBackground;
    if (this.ground) this.ground.visible = !photo;
    if (this.grid) this.grid.visible = !photo;

    // The head material carries the whole photoreal skin stack; structure mode
    // strips it back to a plain diffuse surface so form reads cleanly.
    if (this.headMesh) {
      this.headMesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mat = child.material;
        if (window.SkinShader) SkinShader.setEnabled(mat, photo);
        mat.envMapIntensity = photo ? SceneManager.SKIN.envMapIntensity : 0.0;
        if (mat.isMeshPhysicalMaterial) {
          mat.clearcoat = photo ? SceneManager.SKIN.clearcoat : 0.0;
          mat.clearcoatRoughness = SceneManager.SKIN.clearcoatRoughness;
        }
        mat.needsUpdate = true;
      });
    }

    this._applyModeLighting();

    if (this.postFX) this.postFX.setEnabled(photo);
    return this.renderMode;
  }

  /**
   * Ambient and hemisphere levels depend on whether the environment is lit.
   *
   * Photoreal keeps them near zero because the studio IBL already supplies
   * that fill, and running both double-counts it — which washes the face out
   * and flattens the very shading gradients the environment was added to
   * restore. Structure has no environment at all, so those two lights are the
   * only fill there is; at the photoreal levels the shadow side of the head
   * goes to near black and the mode becomes useless for judging form.
   */
  _applyModeLighting() {
    const photo = this.renderMode === 'photoreal';
    /* Photoreal values cut again (0.12/0.10). Both of these are perfectly
       directionless — they add the same light to a texel facing the key and a
       texel facing away from it, so every unit of them is subtracted straight
       from the modelling the key is there to create. The IBL already fills the
       shadow side from real directions; these two only need to keep it off the
       floor. Structure mode is unchanged: it has no environment, so they are
       the only fill it has. */
    if (this._ambientLight) this._ambientLight.intensity = photo ? 0.06 : 0.55;
    if (this._hemiLight) this._hemiLight.intensity = photo ? 0.06 : 0.45;
  }

  /** Cycle Photoreal → Structure → Photoreal. Returns the new mode label. */
  toggleRenderMode() {
    const next = this.renderMode === 'photoreal' ? 'structure' : 'photoreal';
    this.setRenderMode(next);
    return next === 'photoreal' ? 'Photoreal' : 'Structure';
  }

  /**
   * Outdoor lighting
   */
  setupOutdoorLighting() {
    this.clearLights();

    const sunLight = new THREE.DirectionalLight(0xfff4e0, 1.5);
    sunLight.position.set(3, 5, 2);
    sunLight.castShadow = true;
    this._configureShadow(sunLight);
    /* Direct sun is a small source, so its shadow should be harder than the
       studio key's. It already is: `shadow.radius` is ignored under
       PCFSoftShadowMap, so the assignment that used to sit here changed
       nothing, and both presets get the same filter width either way. */
    this.scene.add(sunLight);

    const skyLight = new THREE.HemisphereLight(0x87CEEB, 0x362d20, 0.35);
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

  clearLights() {
    if (this.lights) {
      this.lights.forEach((light) => {
        // updateShadowFrustums() parents each shadow light's target to aim it
        // at the head; the target has to leave with the light.
        if (light.target && light.target.parent === this.scene) {
          this.scene.remove(light.target);
        }
        this.scene.remove(light);
      });
    }
    this.lights = [];
    // Only the studio preset defines these; the others must not leave stale
    // references pointing at lights that are no longer in the scene.
    this._ambientLight = null;
    this._hemiLight = null;
    /* Emptied for the same reason. Without this, cycling the lighting preset
       would leave every previous preset's key light in the refit list, and each
       refit would go on re-aiming lights that are no longer in the scene. */
    this._shadowLights = [];
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
   * The ONE place the scene is drawn.
   *
   * Every capture path — the animation loop, screenshots, snapshot thumbnails,
   * the variant picker, and the turntable recorder reading the live canvas —
   * must go through here. Before this existed each of them called
   * `renderer.render()` directly, which was harmless while there was no post
   * stack; with one, a direct call silently produces an ungraded frame that
   * does not match what the operator saw when they pressed the button.
   */
  renderFrame() {
    if (this.postFX && this.postFX.enabled) {
      this.postFX.render(this.scene, this.camera);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Take a screenshot of the viewport
   */
  takeScreenshot() {
    this.renderFrame();
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
    if (this.postFX) this.postFX.setSize(width, height);
  }

  /**
   * Post-processing quality. 'low' bypasses the chain entirely.
   * Returns the tier that is now active.
   */
  setQualityTier(tier) {
    /* The tier governs CPU cost as well as GPU: the procedural skin maps are
       regenerated on the main thread on every slider tick, so their resolution
       belongs to the same control the operator uses to trade quality for
       responsiveness. */
    if (this.skinTextureSystem) {
      this.skinTextureSystem.setResolution(tier === 'high' ? 1024 : 512);
    }
    if (!this.postFX) return 'low';
    const active = this.postFX.setTier(tier);
    // Low disables post, which also hands tone mapping back to the renderer;
    // re-applying the mode keeps everything else consistent with that.
    if (this.renderMode === 'structure') this.postFX.setEnabled(false);
    return active;
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
    if (this.postFX) this.postFX.tick();
    this.renderFrame();
  }
}

window.SceneManager = SceneManager;
