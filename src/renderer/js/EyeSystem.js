// Loads the eye and eyelash models, gives them realistic materials, and keeps them fitted to the eye sockets as the face changes.

class EyeSystem {
  // Limits on how far the eyeball may scale to follow the eye opening.
  static get MIN_FOLLOW_SCALE() { return 0.80; }
  // Largest scale the eyeball may follow the opening to.
  static get MAX_FOLLOW_SCALE() { return 1.30; }

  // Which axis rolls the eye for tilt, with opposite signs per side; flip TILT_SIGN if tilted eyes roll the wrong way.
  static get TILT_AXIS() { return 'y'; }
  // Tilt direction for each eye, since the two are mirrored.
  static get TILT_SIGN() { return { left: 1, right: -1 }; }

  // Set to false to keep the eyeball level whatever the eye tilt.
  static get FOLLOW_TILT() { return true; }

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
      // A warm grey, not white, because a pure white sclera looks like a doll's eye.
      scleraColor: '#cfc6b8',
      irisColor: '#6b5030',
      pupilColor: '#000000',
    };

    // Eye materials; the iris and sclera detail comes from EyeShading, keyed to the eyeball's own gaze axis.

    this._sclera = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(this._eyeMaterials.scleraColor),
      // Matte, because the gloss belongs to the tear film (the cornea shell), not the sclera itself.
      roughness: 0.65,
      metalness: 0.0,
      clearcoat: 0.0,
      envMapIntensity: 0.10,
      side: THREE.FrontSide,
    });
    EyeShading.attachSclera(this._sclera);

    this._iris = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(this._eyeMaterials.irisColor),
      // Matte with no clearcoat, so there's only one catchlight, from the cornea.
      roughness: 0.50,
      metalness: 0.0,
      clearcoat: 0.0,
      // The iris scatters light rather than mirroring it; this only keeps it out of pure black.
      envMapIntensity: 0.45,
      side: THREE.FrontSide,
    });
    EyeShading.attachIris(this._iris);

    this._pupil = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(this._eyeMaterials.pupilColor),
      // The pupil is a hole, so it absorbs everything.
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.0,
      side: THREE.FrontSide,
    });

    // The cornea: an additive shell that adds the catchlight and wet sheen without hiding the iris.
    this._cornea = new THREE.MeshPhysicalMaterial({
      // Metallic on purpose, so the colour sets the reflection strength; a physically correct cornea would be invisible here.
      color: 0x858b92,
      metalness: 1.0,
      roughness: 0.11,
      // Low environment reflection; the catchlight comes from the direct lights instead.
      envMapIntensity: 0.25,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    // Limit the glassy part to the cornea and keep the lid-covered top dry.
    EyeShading.attachCornea(this._cornea);

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

    // Default eye positions, updated once the head has been measured.
    this._leftEyeBasePos = new THREE.Vector3(-0.12, 0.32, 0.58);
    this._rightEyeBasePos = new THREE.Vector3(0.12, 0.32, 0.58);
    this._eyeBaseScale = 1.0;

    // ── Eyelash system ──
    this._eyelashGroup = new THREE.Group();
    this._eyelashGroup.name = 'EyelashSystem';
    this.scene.add(this._eyelashGroup);

    this._leftLashContainer = null;
    this._rightLashContainer = null;
    this._eyelashBboxCache = null;
    this.eyelashesVisible = true;

    this.eyelashParams = {
      scale: 59,
      posX: 51,
      posY: 47,
      posZ: 15,
      rotX: 50,
      rotY: 50,
      rotZ: 50,
      curl: 50,
      thickness: 45,
      length: 32,
      opacity: 100,
    };

    this.eyelashColor = '#241a14';

    // Opaque, dark brown lashes, because blended near-black strands looked like spider legs.
    this._eyelashMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.eyelashColor),
      roughness: 0.45,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthWrite: true,
    });

    if (window.StrandShading) {
      // Every lobe is set explicitly, since the hair defaults would light tiny lashes like a full head of hair.
      StrandShading.attachSheen(this._eyelashMat, {
        sheenStrength: 0.08, trtStrength: 0.07, rimStrength: 0.10,
        rootDarken: 0.22, scatter: 0.16,
      });
    }

    this.eyelashModel = { file: '../../assets/models/facial/eyelashes.glb' };

    console.log('[EyeSystem] Initialized');
  }

  // Eye anatomy

  // Measures one eyeball's gaze axis, iris edge and pupil from its sphere meshes and passes them to the shaders.
  _bindEyeAnatomy(container) {
    // Bind the maps and pigment first, since they don't depend on the geometry.
    EyeShading.setMaps(this._iris);
    EyeShading.setMaps(this._sclera);
    EyeShading.setMelanin(this._iris, this.eyeColor);

    const parts = {};
    container.traverse((c) => {
      if (!c.isMesh) return;
      if (c.material === this._sclera) parts.sclera = c;
      else if (c.material === this._iris) parts.iris = c;
      else if (c.material === this._pupil) parts.pupil = c;
    });
    if (!parts.sclera || !parts.iris) return null;

    const anatomy = EyeShading.measureAnatomy(parts);
    if (!anatomy) {
      console.warn('[EyeSystem] Eye parts are not measurable spheres; shading stays on defaults');
      return null;
    }

    EyeShading.setAnatomy(this._sclera, anatomy, parts.sclera);
    EyeShading.setAnatomy(this._iris, anatomy, parts.iris);
    // The shell hangs off the sclera mesh, so use the sclera's space for directions.
    EyeShading.setAnatomy(this._cornea, anatomy, parts.sclera);

    // Push the pupil sphere back under the iris surface so it reads as a hole, not a bead.
    if (parts.pupil && anatomy.pupilProtrusion > 0) {
      const sink = anatomy.pupilProtrusion + anatomy.irisRadius * 0.03;
      parts.pupil.position.addScaledVector(anatomy.axis, -sink);
      parts.pupil.updateMatrix();
    }

    return anatomy;
  }

  // Builds the tear-film shell for one eye and draws it last, over the iris and pupil.
  _addCorneaShell(container, anatomy) {
    let sclera = null;
    container.traverse((c) => {
      if (c.isMesh && c.material === this._sclera) sclera = c;
    });
    if (!sclera) return null;

    let geo = null;
    let centre = null;
    if (anatomy) {
      const built = EyeShading.buildCorneaGeometry(anatomy, sclera);
      geo = built.geometry;
      centre = built.centre;
    } else {
      // Nothing to measure, so use a plain slightly larger sphere.
      sclera.geometry.computeBoundingSphere();
      const bs = sclera.geometry.boundingSphere;
      if (!bs) return null;
      geo = new THREE.SphereGeometry(bs.radius * EyeShading.SHELL_LIFT, 48, 32);
      centre = bs.center.clone();
    }

    const shell = new THREE.Mesh(geo, this._cornea);
    shell.name = 'CorneaShell';
    // Parent the shell to the sclera so it inherits the eyeball's transform.
    shell.position.copy(centre);
    shell.castShadow = false;
    shell.receiveShadow = false;
    shell.renderOrder = 3;
    sclera.add(shell);
    return shell;
  }

  // ── Head binding ──

  // Connects the eyes to the head mesh and morpher and fits them.
  setHeadMesh(headGroup, regionData, morpher) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._morpher = morpher || null;
    this._initialLandmarkLeft = null;
    this._initialLandmarkRight = null;
    this._initialBaseLeft = null;
    this._initialBaseRight = null;
    this._initialFit = null;
    this._eyeFollow = null;
    this._computeHeadMetrics();
  }

  // Measures one eye opening's centre, size and tilt from the lid landmarks on the morphed mesh, since the centre vertex alone over-travels.
  _measureEyeOpening(side) {
    const m = this._morpher;
    if (!m || typeof m.getCurrentLandmarkPosition !== 'function') return null;

    const p = {};
    for (const key of ['inner', 'outer', 'upper', 'lower']) {
      const v = m.getCurrentLandmarkPosition(`eye_${side}_${key}`);
      if (!v) return null;
      p[key] = new THREE.Vector3(v[0], v[1], v[2]);
    }

    const centre = new THREE.Vector3()
      .add(p.inner).add(p.outer).add(p.upper).add(p.lower)
      .multiplyScalar(0.25);

    return {
      centre,
      span: p.outer.distanceTo(p.inner),
      // Angle of the inner→outer line in the frontal (X/Z) plane.
      tilt: Math.atan2(p.outer.z - p.inner.z, p.outer.x - p.inner.x),
    };
  }

  // Returns how much an opening has grown, within safe limits.
  _followScale(span, initialSpan) {
    if (!(initialSpan > 1e-6)) return 1;
    const ratio = span / initialSpan;
    return Math.max(EyeSystem.MIN_FOLLOW_SCALE,
                    Math.min(EyeSystem.MAX_FOLLOW_SCALE, ratio));
  }

  // Measures the head and works out where each eyeball should sit.
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

    // Follow the eye OPENING, measured from the live mesh — see _measureEyeOpening.
    const fitL = this._measureEyeOpening('left');
    const fitR = this._measureEyeOpening('right');
    if (fitL && fitR) {
      if (!this._initialFit) {
        this._initialFit = { left: fitL, right: fitR };
        this._initialBaseLeft = bbLeft.clone();
        this._initialBaseRight = bbRight.clone();
      }
      const init = this._initialFit;

      this._leftEyeBasePos.copy(this._initialBaseLeft)
        .add(fitL.centre.clone().sub(init.left.centre));
      this._rightEyeBasePos.copy(this._initialBaseRight)
        .add(fitR.centre.clone().sub(init.right.centre));

      // How much each opening has grown and rotated since the neutral face.
      this._eyeFollow = {
        left: {
          scale: this._followScale(fitL.span, init.left.span),
          tilt: fitL.tilt - init.left.tilt,
        },
        right: {
          scale: this._followScale(fitR.span, init.right.span),
          tilt: fitR.tilt - init.right.tilt,
        },
      };

      this.eyeSpacing = Math.abs(this._rightEyeBasePos.x - this._leftEyeBasePos.x);
      return;
    }

    // Older path for meshes without the lid landmarks; follows the centre only.
    if (this._morpher && typeof this._morpher.getCurrentLandmarkPosition === 'function') {
      const leftPos = this._morpher.getCurrentLandmarkPosition('eye_left_center');
      const rightPos = this._morpher.getCurrentLandmarkPosition('eye_right_center');
      if (leftPos && rightPos) {
        const curLeft = new THREE.Vector3(leftPos[0], leftPos[1], leftPos[2]);
        const curRight = new THREE.Vector3(rightPos[0], rightPos[1], rightPos[2]);

        if (!this._initialLandmarkLeft) {
          this._initialLandmarkLeft = curLeft.clone();
          this._initialLandmarkRight = curRight.clone();
          this._initialBaseLeft = bbLeft.clone();
          this._initialBaseRight = bbRight.clone();
        }

        const deltaLeft = curLeft.clone().sub(this._initialLandmarkLeft);
        const deltaRight = curRight.clone().sub(this._initialLandmarkRight);

        this._leftEyeBasePos.copy(this._initialBaseLeft).add(deltaLeft);
        this._rightEyeBasePos.copy(this._initialBaseRight).add(deltaRight);
        this._eyeFollow = null;
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

  // Switches eye style and regenerates the eyes.
  setStyle(style) {
    if (this.eyeModels[style]) {
      this.currentStyle = style;
      this.generateEyes();
    } else {
      console.warn('[EyeSystem] Unknown style:', style);
    }
  }

  // Sets the iris colour from a hex string.
  setEyeColor(hexColor) {
    this.eyeColor = hexColor;
    this._eyeMaterials.irisColor = hexColor;
    this._iris.color.set(hexColor);

    // The colour also sets how much iris structure shows, like real pigment.
    EyeShading.setMelanin(this._iris, hexColor);

    // Ensure already-instantiated meshes update even if they were loaded earlier.
    this._updateRenderedIrisColor();
    console.log('[EyeSystem] Eye color changed to:', hexColor);
  }

  // Updates one eye setting (scale, position, rotation or opacity).
  setParam(param, value) {
    if (this.params[param] === undefined) return;
    this.params[param] = Math.max(0, Math.min(100, value));
    if (this._leftEyeContainer || this._rightEyeContainer) {
      this._applyAdjustments();
    }
  }

  // Returns the eye settings and colour.
  getParams() {
    return {
      ...this.params,
      color: this.eyeColor,
    };
  }

  // Returns the eye and eyelash settings for saving.
  exportState() {
    return {
      style: this.currentStyle,
      color: this.eyeColor,
      params: { ...this.params },
      eyelashes: {
        color: this.eyelashColor,
        visible: this.eyelashesVisible,
        params: { ...this.eyelashParams },
      },
    };
  }

  // Restores eye and eyelash settings from a saved case.
  restoreState(state) {
    if (state.style) this.currentStyle = state.style;
    if (state.color) this.setEyeColor(state.color);
    if (state.params) {
      Object.entries(state.params).forEach(([key, val]) => {
        this.params[key] = val;
      });
    }
    this.generateEyes();
    if (state.eyelashes) {
      if (state.eyelashes.color) this.setEyelashColor(state.eyelashes.color);
      if (state.eyelashes.visible !== undefined) this.setEyelashesVisible(state.eyelashes.visible);
      if (state.eyelashes.params) {
        Object.entries(state.eyelashes.params).forEach(([key, val]) => {
          this.eyelashParams[key] = val;
        });
      }
      this.generateEyelashes();
    }
  }

  // ── Main generation ──

  // Loads the eye models (or builds simple ones as a fallback) and places them.
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

  // Loads one eye model, using the cache when possible.
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

  // Puts both eyes in the scene, scaled from their measured size.
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

    // Measure the eyeball's size without the tear-film shell, so shell tweaks don't resize the eyes.
    const shells = [];
    this._leftEyeContainer.traverse((c) => {
      // Detach the shells, since the bounding box ignores visibility.
      if (c.name === 'CorneaShell') shells.push({ shell: c, parent: c.parent });
    });
    for (const { shell, parent } of shells) parent.remove(shell);
    const leftBox = new THREE.Box3().setFromObject(this._leftEyeContainer);
    for (const { shell, parent } of shells) parent.add(shell);
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

  // Copies the meshes from a loaded eye, assigning materials by name or, failing that, by size.
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

    // Measure before building the shell, since the shell is cut to the measured iris edge.
    const anatomy = this._bindEyeAnatomy(targetContainer);
    this._addCorneaShell(targetContainer, anatomy);
  }

  // Assigns a material from the mesh name and returns which part it matched.
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

  // Builds simple sphere eyes when the eye models can't load.
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

    // The fallback eyes are measured and shelled the same way as the loaded ones.
    for (const container of [this._leftEyeContainer, this._rightEyeContainer]) {
      this._addCorneaShell(container, this._bindEyeAnatomy(container));
    }

    // Add to scene
    this.eyeGroup.add(this._leftEyeContainer);
    this.eyeGroup.add(this._rightEyeContainer);

    // Apply transformations
    this._applyAdjustments();
  }

  // Positions, scales and rotates both eyes from the settings and the measured sockets.
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

    // Follow the opening's size and tilt on top of the sliders so the eyeball stays in its socket.
    const followL = this._eyeFollow ? this._eyeFollow.left : null;
    const scaleL = scale * (followL ? followL.scale : 1);
    if (followL && EyeSystem.FOLLOW_TILT) {
      this._leftEyeContainer.rotation[EyeSystem.TILT_AXIS] +=
        EyeSystem.TILT_SIGN.left * followL.tilt;
    }

    this._leftEyeContainer.scale.set(scaleL, scaleL, scaleL);

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

    const followR = this._eyeFollow ? this._eyeFollow.right : null;
    const scaleR = scale * (followR ? followR.scale : 1);
    if (followR && EyeSystem.FOLLOW_TILT) {
      this._rightEyeContainer.rotation[EyeSystem.TILT_AXIS] +=
        EyeSystem.TILT_SIGN.right * followR.tilt;
    }

    this._rightEyeContainer.scale.set(scaleR, scaleR, scaleR);

    // Set opacity
    const opacity = this.params.opacity / 100;
    this._sclera.opacity = opacity;
    this._iris.opacity = opacity;
    this._pupil.opacity = opacity;
    this._sclera.transparent = opacity < 0.999;
    this._iris.transparent = opacity < 0.999;
    this._pupil.transparent = opacity < 0.999;
    this._updateUnderEyeFrames();
  }

  // Keeps the under-eye skin detail lined up with the rendered eyes.
  _updateUnderEyeFrames() {
    if (!this._headGroup) return;
    const frames = {};
    for (const side of ['left', 'right']) {
      const eye = this[`_${side}EyeContainer`];
      if (!eye) return;
      eye.updateWorldMatrix(true, false);
      let tilt = 0;
      const m = this._morpher;
      const inner = m?.getCurrentLandmarkPosition?.(`eye_${side}_inner`);
      const outer = m?.getCurrentLandmarkPosition?.(`eye_${side}_outer`);
      const restInner = m?._landmarkPositions?.[`eye_${side}_inner`];
      const restOuter = m?._landmarkPositions?.[`eye_${side}_outer`];
      if (inner && outer && restInner && restOuter) {
        // The head geometry is Y-up. Measure frontal tilt in XY, not depth XZ.
        const angle = Math.atan2(outer[1] - inner[1], outer[0] - inner[0]);
        const restAngle = Math.atan2(restOuter[1] - restInner[1], restOuter[0] - restInner[0]);
        tilt = Math.atan2(Math.sin(angle - restAngle), Math.cos(angle - restAngle));
      }
      tilt += (side === 'left' ? 1 : -1) * (this.params.rotZ - 50) / 50 * .3;
      frames[side] = {
        centre: eye.getWorldPosition(new THREE.Vector3()),
        scale: Math.max(.35, Math.min(2, eye.scale.x / (this._eyeBaseScale * 1.27))),
        tilt,
      };
    }
    this._headGroup.traverse(mesh => {
      if (!mesh.isMesh) return;
      mesh.updateWorldMatrix(true, false);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const u = material?.userData?.skinShader?.uniforms;
        if (!u?.uUnderEyeLeft) continue;
        for (const side of ['left', 'right']) {
          const frame = frames[side];
          // World -> this mesh cancels the common head-tracker pivot rotation.
          const centre = mesh.worldToLocal(frame.centre.clone());
          const uniform = side === 'left' ? u.uUnderEyeLeft : u.uUnderEyeRight;
          uniform.value.set(centre.x, centre.y, frame.scale, frame.tilt);
        }
      }
    });
  }

  // Refits the eyes and eyelashes after the face changes.
  refreshFromMesh() {
    this._computeHeadMetrics();
    if (this._leftEyeContainer && this._rightEyeContainer) {
      this._applyAdjustments();
    }
    if (this._leftLashContainer) {
      this._applyEyelashAdjustments();
    }
  }

  // Applies the iris colour to the eye meshes already on screen.
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

  // ── Eyelash system ──

  // Sets the eyelash colour.
  setEyelashColor(hexColor) {
    this.eyelashColor = hexColor;
    this._eyelashMat.color.set(hexColor);
    console.log('[EyeSystem] Eyelash color changed to:', hexColor);
  }

  // Sets one eyelash setting and refits the lashes.
  setEyelashParam(param, value) {
    if (this.eyelashParams[param] === undefined) return;
    this.eyelashParams[param] = Math.max(0, Math.min(100, value));
    if (this._leftLashContainer || this._rightLashContainer) {
      this._applyEyelashAdjustments();
    }
  }

  // Shows or hides the eyelashes.
  setEyelashesVisible(visible) {
    this.eyelashesVisible = visible;
    this._eyelashGroup.visible = visible;
  }

  // Returns the eyelash settings, colour and visibility.
  getEyelashParams() {
    return {
      ...this.eyelashParams,
      color: this.eyelashColor,
      visible: this.eyelashesVisible,
    };
  }

  // Loads the eyelash model (or uses the cached one) and places it.
  generateEyelashes() {
    console.log('[EyeSystem] Generating eyelashes');
    this._clearGroup(this._eyelashGroup);
    this._leftLashContainer = null;
    this._rightLashContainer = null;
    this._eyelashBboxCache = null;

    const config = this.eyelashModel;
    if (!config || !config.file) return;

    if (this._modelCache['eyelashes']) {
      console.log('[EyeSystem] Using cached eyelash model');
      this._showCachedEyelashes();
      return;
    }

    console.log('[EyeSystem] Loading eyelash model from:', config.file);
    const loader = new THREE.GLBLoader();
    loader.load(
      config.file,
      (group) => {
        console.log('[EyeSystem] Eyelash model loaded successfully');
        this._modelCache['eyelashes'] = group;
        this._showCachedEyelashes();
      },
      null,
      (err) => { console.error('[EyeSystem] Failed to load eyelash model:', config.file, err); }
    );
  }

  // Places the cached eyelashes, as one pair or as one lash mirrored for each eye.
  _showCachedEyelashes() {
    this._clearGroup(this._eyelashGroup);
    const cached = this._modelCache['eyelashes'];
    if (!cached) return;

    // The lash model may cover both eyes or just one, so check which.
    const meshes = [];
    cached.traverse(child => { if (child.isMesh) meshes.push(child); });

    if (meshes.length === 0) {
      console.warn('[EyeSystem] Eyelash model has no meshes');
      return;
    }

    // Compute bounding box to determine if the model spans both eyes or just one
    const fullBox = new THREE.Box3().setFromObject(cached);
    const fullCenter = new THREE.Vector3();
    fullBox.getCenter(fullCenter);
    const fullSize = new THREE.Vector3();
    fullBox.getSize(fullSize);

    // Heuristic: if the model's X-extent is more than 60% of head width, treat as full pair
    const isPair = fullSize.x > this.headWidth * 0.3;

    if (isPair) {
      // Full pair: use as-is, positioned relative to the eye midpoint
      this._leftLashContainer = new THREE.Group();
      this._leftLashContainer.name = 'EyelashContainer';

      const offsetGroup = new THREE.Group();
      offsetGroup.name = 'EyelashOffset';

      cached.traverse(child => {
        if (child.isMesh) {
          const clone = child.clone();
          clone.material = this._eyelashMat;
          // Lashes don't cast shadows; they are far thinner than a shadow texel and would only alias.
          clone.castShadow = false;
          clone.receiveShadow = true;
          offsetGroup.add(clone);
        }
      });

      this._leftLashContainer.add(offsetGroup);
      this._eyelashGroup.add(this._leftLashContainer);

      // Use a dummy right container (positioning done via single container)
      this._rightLashContainer = this._leftLashContainer;
    } else {
      // Single eye: clone and mirror for left and right
      this._leftLashContainer = this._createLashContainer(cached, 'LeftEyelash');
      this._rightLashContainer = this._createLashContainer(cached, 'RightEyelash');

      this._eyelashGroup.add(this._leftLashContainer);
      this._eyelashGroup.add(this._rightLashContainer);
    }

    this._eyelashBboxCache = { center: fullCenter, size: fullSize, isPair, min: fullBox.min.clone(), max: fullBox.max.clone() };
    this._eyelashGroup.visible = this.eyelashesVisible;
    this._applyEyelashAdjustments();

    console.log('[EyeSystem] Eyelashes displayed successfully (isPair:', isPair, ')');
    console.log('[EyeSystem] Eyelash bbox:', 'size:', fullSize.x.toFixed(3), fullSize.y.toFixed(3), fullSize.z.toFixed(3),
      'center:', fullCenter.x.toFixed(3), fullCenter.y.toFixed(3), fullCenter.z.toFixed(3),
      'min:', fullBox.min.x.toFixed(3), fullBox.min.y.toFixed(3), fullBox.min.z.toFixed(3),
      'max:', fullBox.max.x.toFixed(3), fullBox.max.y.toFixed(3), fullBox.max.z.toFixed(3));
    console.log('[EyeSystem] Head metrics — width:', this.headWidth.toFixed(3),
      'eyeSpacing:', this.eyeSpacing.toFixed(3),
      'leftEye:', this._leftEyeBasePos.x.toFixed(3), this._leftEyeBasePos.y.toFixed(3), this._leftEyeBasePos.z.toFixed(3),
      'rightEye:', this._rightEyeBasePos.x.toFixed(3), this._rightEyeBasePos.y.toFixed(3), this._rightEyeBasePos.z.toFixed(3));
  }

  // Wraps a copy of the lash model in a container for one eye.
  _createLashContainer(source, name) {
    const container = new THREE.Group();
    container.name = name;

    const offsetGroup = new THREE.Group();
    offsetGroup.name = name + 'Offset';

    source.traverse(child => {
      if (child.isMesh) {
        const clone = child.clone();
        clone.material = this._eyelashMat;
        // Lashes don't cast shadows; they are far thinner than a shadow texel and would only alias.
        clone.castShadow = false;
        clone.receiveShadow = true;
        offsetGroup.add(clone);
      }
    });

    container.add(offsetGroup);
    return container;
  }

  // Positions, scales and tilts the eyelashes from their settings and the eye positions.
  _applyEyelashAdjustments() {
    if (!this._leftLashContainer || !this._eyelashBboxCache) return;

    const ep = this.eyelashParams;
    const cache = this._eyelashBboxCache;

    // Normalize params (-1 to 1 range)
    const posXNorm = (ep.posX - 50) / 50;
    const posYNorm = (ep.posY - 50) / 50;
    const posZNorm = (ep.posZ - 50) / 50;
    const rotXNorm = (ep.rotX - 50) / 50;
    const rotYNorm = (ep.rotY - 50) / 50;
    const rotZNorm = (ep.rotZ - 50) / 50;
    const curlNorm = (ep.curl - 50) / 50;
    const thicknessNorm = (ep.thickness - 50) / 50;

    // Use eye landmark tracking to position eyelashes relative to eyes
    let eyeLandmarkOffsetY = 0;
    let eyeLandmarkOffsetZ = 0;
    if (this._leftEyeBasePos && this._initialBaseLeft) {
      // Calculate Y and Z offset from eye landmark movement
      eyeLandmarkOffsetY = this._leftEyeBasePos.y - this._initialBaseLeft.y;
      eyeLandmarkOffsetZ = this._leftEyeBasePos.z - this._initialBaseLeft.z;
    }

    if (cache.isPair) {
      // Full pair: place it at fixed head coordinates, like the eyebrows.
      const container = this._leftLashContainer;
      const offsetGroup = container.children[0];

      // Center the model at its own origin
      offsetGroup.position.set(-cache.center.x, -cache.center.y, -cache.center.z);

      // The lashes sit a little below and in front of the eyebrows, at the upper lid.
      const lashRegionWidth = 0.90;
      const lashRegionY = 0.34;   // slightly below brow line (at upper eyelid)
      const lashRegionZ = 1.04;   // slightly more forward than brows

      // Base scale: match lash region width (same approach as eyebrows)
      const baseScale = lashRegionWidth / cache.size.x;
      const scaleF = 0.5 + (ep.scale / 100) * 1.0;
      const thicknessF = 1.0 + thicknessNorm * 0.5;
      const lengthF = 0.3 + ((ep.length ?? 50) / 100) * 1.4;  // Z-scale: lash length
      const opacityF = ((ep.opacity ?? 95) / 100);            // Manual opacity

      container.scale.set(
        baseScale * scaleF,
        baseScale * thicknessF,
        baseScale * scaleF * lengthF
      );

      // Position offsets (range ±0.15)
      const posOffsetX = posXNorm * 0.15;
      const posOffsetY = posYNorm * 0.15;
      const posOffsetZ = posZNorm * 0.15;

      container.position.set(
        this.modelCenter.x + posOffsetX,
        lashRegionY + posOffsetY + eyeLandmarkOffsetY,
        lashRegionZ + posOffsetZ + eyeLandmarkOffsetZ
      );

      // Rotations — negative 90° X to curve lashes UPWARD from the eyelid
      const BASE_ROT_X = -Math.PI / 2;
      const rotX = BASE_ROT_X + rotXNorm * 0.5 + curlNorm * 0.3;
      const rotY = rotYNorm * (Math.PI / 3);
      const rotZ = rotZNorm * 0.5;

      container.rotation.set(rotX, rotY, rotZ);

      // Apply opacity
      this._eyelashMat.opacity = opacityF;
      this._eyelashMat.transparent = opacityF < 0.999;
    } else {
      // Single-eye model cloned for each side
      const lashRegionY = 0.34;
      const lashRegionZ = 1.04;
      const halfSpacing = 0.22;

      const baseScale = 0.45 / Math.max(cache.size.x, 0.001);
      const scaleF = 0.5 + (ep.scale / 100) * 1.0;
      const thicknessF = 1.0 + thicknessNorm * 0.5;
      const lengthF = 0.3 + ((ep.length ?? 50) / 100) * 1.4;
      const opacityF = ((ep.opacity ?? 95) / 100);

      const posOffsetX = posXNorm * 0.15;
      const posOffsetY = posYNorm * 0.15;
      const posOffsetZ = posZNorm * 0.15;

      const BASE_ROT_X = -Math.PI / 2;
      const rotX = BASE_ROT_X + rotXNorm * 0.5 + curlNorm * 0.3;
      const rotY = rotYNorm * (Math.PI / 3);
      const rotZ = rotZNorm * 0.5;

      // Left eyelash
      const left = this._leftLashContainer;
      left.children[0].position.set(-cache.center.x, -cache.center.y, -cache.center.z);
      left.scale.set(baseScale * scaleF, baseScale * thicknessF, baseScale * scaleF * lengthF);
      left.position.set(
        this.modelCenter.x - halfSpacing + posOffsetX,
        lashRegionY + posOffsetY + eyeLandmarkOffsetY,
        lashRegionZ + posOffsetZ + eyeLandmarkOffsetZ
      );
      left.rotation.set(rotX, rotY, rotZ);

      // Right eyelash
      const right = this._rightLashContainer;
      right.children[0].position.set(-cache.center.x, -cache.center.y, -cache.center.z);
      right.scale.set(baseScale * scaleF, baseScale * thicknessF, baseScale * scaleF * lengthF);
      right.position.set(
        this.modelCenter.x + halfSpacing + posOffsetX,
        lashRegionY + posOffsetY + eyeLandmarkOffsetY,
        lashRegionZ + posOffsetZ + eyeLandmarkOffsetZ
      );
      right.rotation.set(rotX, -rotY, -rotZ);

      // Apply opacity
      this._eyelashMat.opacity = opacityF;
      this._eyelashMat.transparent = opacityF < 0.999;
    }
  }

  // ── Cleanup ──

  // Clears a group, freeing the cornea shells, which are the only unshared geometry.
  _clearGroup(group) {
    // Free the cornea shells, since everything else shares geometry with the model cache.
    group.traverse((child) => {
      if (child.isMesh && child.name === 'CorneaShell') child.geometry.dispose();
    });
    while (group.children.length > 0) {
      group.remove(group.children[0]);
    }
  }

  // Removes the eyes and eyelashes from the scene.
  dispose() {
    this._clearGroup(this.eyeGroup);
    this.scene.remove(this.eyeGroup);
    this._clearGroup(this._eyelashGroup);
    this.scene.remove(this._eyelashGroup);
  }
}
