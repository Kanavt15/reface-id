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
  /** Bounds on how far the eyeball may follow the opening's size. */
  static get MIN_FOLLOW_SCALE() { return 0.80; }
  static get MAX_FOLLOW_SCALE() { return 1.30; }

  /**
   * Which container axis rolls the eye within the frontal plane, and its sign
   * per side — the two containers are mirrored, so the same visual tilt needs
   * opposite signs. Isolated here because it is the one part of following the
   * opening that cannot be derived from the mesh: it depends on how the eye
   * GLB was authored. If tilted eyes ever roll the wrong way, flip TILT_SIGN;
   * if they roll about the wrong axis, change TILT_AXIS to 'z'.
   */
  static get TILT_AXIS() { return 'y'; }
  static get TILT_SIGN() { return { left: 1, right: -1 }; }

  /** Set false to keep the eyeball level regardless of eyeTilt. */
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
      // Not #ffffff. A sclera photographs as a warm grey — leaving it at pure
      // white makes it the brightest thing in the frame, which it never is on
      // a real face, and reads instantly as a doll's eye.
      scleraColor: '#cfc6b8',
      irisColor: '#6b5030',
      pupilColor: '#000000',
    };

    /* Eye materials.
     *
     * A face is read at the eyes before anywhere else, so flat eyes sink an
     * otherwise good head. The three materials here were a plain white sphere,
     * a flat coloured sphere and a black sphere, which is roughly a doll's eye:
     * no wet surface, no limbal ring, no iris structure, no catchlight, and a
     * sclera brighter than anything else on the face.
     *
     * All of the detail added below is derived from the view-space normal
     * rather than from textures, because the eye GLB's UV layout is a Blender
     * UV sphere and a radial iris pattern cannot be mapped onto it sensibly.
     * The normal gives both the radius (how far off-axis a point is) and the
     * angle, which is all an iris pattern needs. */

    this._sclera = new THREE.MeshPhysicalMaterial({
      // Never pure white. A real sclera is a warm off-white and is the single
      // most common giveaway when it is left at #ffffff.
      color: new THREE.Color(this._eyeMaterials.scleraColor),
      roughness: 0.30,
      metalness: 0.0,
      /* The tear film is a separate smooth layer over a rougher surface — but
         at clearcoat 1.0 with a near-mirror roughness it stopped being a film
         and became a chrome ball, reflecting the whole bright upper half of
         the environment. That reflection, not the base colour, was what kept
         the sclera the brightest object in the frame no matter how far the
         diffuse term was pushed down. A tear film is a sheen at a glancing
         angle, not a mirror across the whole eyeball. */
      clearcoat: 0.15,
      clearcoatRoughness: 0.26,
      envMapIntensity: 0.14,
      side: THREE.FrontSide,
    });
    EyeSystem._attachScleraShading(this._sclera);

    this._iris = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(this._eyeMaterials.irisColor),
      roughness: 0.35,
      metalness: 0.0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.1,
      envMapIntensity: 0.8,
      side: THREE.FrontSide,
    });
    EyeSystem._attachIrisShading(this._iris);

    this._pupil = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(this._eyeMaterials.pupilColor),
      // A pupil is a hole. It should absorb essentially everything; the old
      // 0.1 metalness made it pick up a grey sheen and read as a painted dot.
      roughness: 1.0,
      metalness: 0.0,
      envMapIntensity: 0.0,
      side: THREE.FrontSide,
    });

    /* The cornea: a thin shell over the whole eyeball.
     *
     * Black base colour plus additive blending means it contributes nothing
     * but its own reflection — so it adds the specular catchlight and the wet
     * sheen without hiding the iris underneath, and without needing three's
     * transmission pass, which would re-render the scene for two small
     * spheres. The catchlight is what makes an eye look alive; without one the
     * eye reads as glass no matter what else is right. */
    this._cornea = new THREE.MeshPhysicalMaterial({
      /* Metallic, not dielectric, and that is deliberate.
       *
       * A real cornea is a dielectric with an F0 of about 0.025 — it reflects
       * 2.5% of what hits it. It looks bright in a photograph only because the
       * lamp is a thousand times brighter than the face. This environment is a
       * canvas that tops out at 1.0, so a physically correct cornea reflects
       * 0.025 of that and is invisible, which is exactly what the first
       * attempt rendered.
       *
       * metalness 1 makes the reflection take this colour instead, which is
       * the standard way to buy back a highlight the tone range cannot carry.
       * The colour value IS the reflection strength — and it is decoded from
       * sRGB, so a mid-grey here is only ~0.05 linear. That is why the first
       * two passes at this rendered nothing: 0x2b3138 looks like a reasonable
       * dark reflection and is in fact 2% of the light. */
      color: 0xeef3f8,
      metalness: 1.0,
      roughness: 0.11,
      /* Low, and the catchlight comes from the direct lights instead.
       *
       * A mirror reflects the entire environment, and this environment is a
       * broad soft gradient — so at a high intensity the shell was not adding
       * a highlight, it was adding half the sky as a flat additive wash across
       * the whole eyeball. That wash was what kept reading as a bright
       * blue-white sclera through several attempts at darkening the sclera
       * itself, which was never the thing that was bright.
       *
       * The directional lights are point sources: on a surface this smooth
       * they give a small, hard, genuinely bright dot, which is what a
       * catchlight is. This value only carries the faint wet sheen. */
      envMapIntensity: 0.25,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
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
      thickness: 65,
      length: 50,
      opacity: 100,
    };

    this.eyelashColor = '#241a14';

    /* Same reasoning as the eyebrows: eyelashes.glb is 42k vertices of real
       strands with no UVs, and blending them against each other at 0.95 is
       what made them read as hard black spider legs rather than as hair.
       #0a0a0a is also nearly pure black, which no hair is — lashes are dark
       brown and pick up a rim from behind. */
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
      StrandShading.attachSheen(this._eyelashMat, {
        sheenStrength: 0.08, rimStrength: 0.10, rootDarken: 0.22,
      });
    }

    this.eyelashModel = { file: '../../assets/models/facial/eyelashes.glb' };

    console.log('[EyeSystem] Initialized');
  }

  // ── Eye detail shading ───────────────────────────────────────────────────

  /**
   * Give the iris its structure: a limbal ring, radial fibres, a collarette
   * and a darkened rim.
   *
   * Everything is parameterised off the view-space normal instead of UVs. On a
   * sphere, `dot(N, V)` falls from 1 at the point facing the camera to 0 at the
   * silhouette, which is exactly a normalised radius from the iris centre; and
   * `atan(N.y, N.x)` gives the angle around it. A Blender UV sphere's own
   * TEXCOORD_0 could not carry a radial pattern without visible pinching at the
   * pole and a seam down one side.
   */
  static _attachIrisShading(material) {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 N = normalize( vNormal );',
          '  vec3 V = normalize( vViewPosition );',
          // 0 at the iris centre, 1 at its outer edge.
          '  float radius = clamp( 1.0 - abs( dot( N, V ) ), 0.0, 1.0 );',
          '  float r = sqrt( radius );',
          '  float angle = atan( N.y, N.x );',
          '',
          // Radial fibres. Two frequencies so the pattern does not read as a
          // regular starburst; the outer iris is more fibrous than the inner.
          '  float fib = sin( angle * 38.0 ) * 0.5 + 0.5;',
          '  fib = mix( fib, sin( angle * 71.0 + 1.7 ) * 0.5 + 0.5, 0.45 );',
          '  float fibreAmt = smoothstep( 0.18, 0.85, r ) * 0.30;',
          '  diffuseColor.rgb *= 1.0 - fibreAmt * 0.5 + fib * fibreAmt;',
          '',
          // The collarette: the raised ring about a third out from the pupil.
          '  float collar = exp( -pow( ( r - 0.36 ) * 9.0, 2.0 ) );',
          '  diffuseColor.rgb *= 1.0 + collar * 0.22;',
          '',
          // The limbal ring — the dark band where iris meets sclera. A strong
          // real-eye cue, and one people notice missing without knowing why.
          '  float limbal = smoothstep( 0.78, 1.0, r );',
          '  diffuseColor.rgb *= 1.0 - limbal * 0.62;',
          '',
          // Depth: an iris is a cone, darker toward the pupil where the
          // stroma is deepest.
          '  diffuseColor.rgb *= mix( 0.78, 1.35, smoothstep( 0.0, 0.55, r ) );',
          '}',
          '#endif',
        ].join('\n')
      );
    };
    material.customProgramCacheKey = () => 'iris';
    material.needsUpdate = true;
    return material;
  }

  /**
   * Shade the sclera so it stops looking like a ping-pong ball.
   *
   * Two things are happening on a real eye: the upper part sits in the shadow
   * of the brow and lid and is markedly darker than the lower, and the corners
   * carry visible vasculature. A uniformly lit white sphere has neither, and
   * ends up the brightest object on the face — which is never true of a real
   * photograph.
   */
  static _attachScleraShading(material) {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 N = normalize( vNormal );',
          '  vec3 V = normalize( vViewPosition );',
          '  float radius = clamp( 1.0 - abs( dot( N, V ) ), 0.0, 1.0 );',
          '',
          // Lid and brow shadow. N.y > 0 is the upper hemisphere of the
          // eyeball, which is the part the upper lid overhangs.
          // The socket is a cave. An eyeball sits several millimetres inside
          // a bony orbit under a brow, so almost none of the upper hemisphere
          // sees open sky — which is why a sclera photographs around the value
          // of light skin and never as white. Rendering it bright is the
          // single most common reason CG eyes look like marbles.
          '  float lid = smoothstep( -0.45, 0.75, N.y );',
          '  diffuseColor.rgb *= mix( 0.86, 0.18, lid );',
          '',
          // Curving away into the corners of the socket.
          '  diffuseColor.rgb *= mix( 1.0, 0.38, smoothstep( 0.30, 0.95, radius ) );',
          '',
          // Vasculature. Two incommensurate frequencies rather than one
          // product of sines, which laid down regular vertical bands that
          // looked like scratches on the surface.
          // Vasculature, kept to a hint. A sclera is only 24mm across and at
          // portrait distance its vessels are a faint warm cast at the
          // corners, not drawn lines — anything stronger renders as streaks.
          '  float vein = sin( N.x * 31.0 + N.y * 11.0 ) + 0.7 * sin( N.y * 43.0 - N.x * 7.0 ) + 0.5 * sin( N.x * 17.0 + N.y * 29.0 );',
          '  vein = smoothstep( 1.25, 2.10, vein ) * smoothstep( 0.30, 0.80, radius );',
          '  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.0, 0.72, 0.68 ), vein * 0.16 );',
          '',
          // A warm cast toward the inner and outer corners, where the
          // conjunctiva thickens and picks up colour from the lids.
          '  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.03, 0.93, 0.86 ), smoothstep( 0.15, 0.85, radius ) );',
          '}',
          '#endif',
        ].join('\n')
      );
    };
    material.customProgramCacheKey = () => 'sclera';
    material.needsUpdate = true;
    return material;
  }

  /**
   * Build the cornea shell for one eye container.
   *
   * Sized off the sclera's own bounding sphere so it tracks whatever eye model
   * is loaded, and rendered last with depth writing off so it composites over
   * the iris and pupil regardless of draw order.
   */
  _addCorneaShell(container) {
    let sclera = null;
    container.traverse((c) => {
      if (c.isMesh && c.material === this._sclera) sclera = c;
    });
    if (!sclera) return null;

    sclera.geometry.computeBoundingSphere();
    const bs = sclera.geometry.boundingSphere;
    if (!bs) return null;

    const geo = new THREE.SphereGeometry(bs.radius * 1.02, 32, 24);
    const shell = new THREE.Mesh(geo, this._cornea);
    shell.name = 'CorneaShell';
    // Parented to the sclera rather than the container: the eye parts carry
    // their own transforms inside the GLB, and a shell added as a sibling
    // lands in the wrong place and at the wrong size. As a child it inherits
    // the eyeball's full transform for free, and keeps doing so when
    // _applyAdjustments() moves and rescales the eyes.
    shell.position.copy(bs.center);
    shell.castShadow = false;
    shell.receiveShadow = false;
    shell.renderOrder = 3;
    sclera.add(shell);
    return shell;
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
    this._initialFit = null;
    this._eyeFollow = null;
    this._computeHeadMetrics();
  }

  /**
   * Measure one eye's opening on the live, morphed mesh.
   *
   * The eyeball is a separate mesh from the head, so something has to tell it
   * where the socket went. It used to track the eye-CENTRE landmark, and that
   * is the root of the "asleep" look: the morphs displace that centre vertex at
   * full weight, while the ring of lid vertices around it is displaced by a
   * falloff and therefore travels less. Following the centre made the eyeball
   * over-travel — pushed back by eyeDepth it sank behind lids that had barely
   * moved, and the iris disappeared.
   *
   * Measuring the ring instead fixes that at the source, and gives the two
   * things the centre could never express: how big the opening now is, and
   * which way it is tilted.
   *
   * Head space here is X = left/right, Y = depth, Z = up/down — the convention
   * _computeHeadMetrics reads the bounding box in.
   */
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

  /**
   * Growth ratio of an opening, bounded. A landmark that lands on a degenerate
   * or badly-morphed vertex should not be able to inflate the eyeball off the
   * face; past these limits the eyeball is wrong either way, and wrong-and-small
   * is far less alarming than wrong-and-enormous.
   */
  _followScale(span, initialSpan) {
    if (!(initialSpan > 1e-6)) return 1;
    const ratio = span / initialSpan;
    return Math.max(EyeSystem.MIN_FOLLOW_SCALE,
                    Math.min(EyeSystem.MAX_FOLLOW_SCALE, ratio));
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

      // How much the opening has grown and rotated since the neutral face.
      // Derived from the mesh rather than read off the morph sliders, so it
      // stays correct however those morphs are combined or recalibrated.
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

    // Older path: track the centre vertex alone. Kept only for meshes without
    // the four ring landmarks; it cannot see size or tilt.
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
      eyelashes: {
        color: this.eyelashColor,
        visible: this.eyelashesVisible,
        params: { ...this.eyelashParams },
      },
    };
  }

  /**
   * Return the eyes' world-space transforms so Blender can replicate them.
   */
  getEyeRenderTransforms() {
    const result = {
      leftMatrix: null,
      rightMatrix: null,
      params: { ...this.params },
      color: this.eyeColor,
    };

    if (this._leftEyeContainer) {
      this._leftEyeContainer.updateWorldMatrix(true, false);
      result.leftMatrix = Array.from(this._leftEyeContainer.matrixWorld.elements);
    }

    if (this._rightEyeContainer) {
      this._rightEyeContainer.updateWorldMatrix(true, false);
      result.rightMatrix = Array.from(this._rightEyeContainer.matrixWorld.elements);
    }

    return result;
  }

  /**
   * Return the eyelashes' world-space transforms so Blender can replicate them.
   */
  getEyelashRenderTransforms() {
    const result = {
      leftMatrix: null,
      rightMatrix: null,
      params: { ...this.eyelashParams },
      color: this.eyelashColor,
      visible: this.eyelashesVisible,
    };

    if (this._leftLashContainer) {
      this._leftLashContainer.updateWorldMatrix(true, false);
      result.leftMatrix = Array.from(this._leftLashContainer.matrixWorld.elements);
    }

    if (this._rightLashContainer) {
      this._rightLashContainer.updateWorldMatrix(true, false);
      result.rightMatrix = Array.from(this._rightLashContainer.matrixWorld.elements);
    }

    return result;
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

    this._addCorneaShell(targetContainer);
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

    // Follow the opening's size and tilt on top of the manual sliders, so the
    // eyeball stays registered with the socket the morphs actually produced.
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
  }

  refreshFromMesh() {
    this._computeHeadMetrics();
    if (this._leftEyeContainer && this._rightEyeContainer) {
      this._applyAdjustments();
    }
    if (this._leftLashContainer) {
      this._applyEyelashAdjustments();
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

  // ── Eyelash system ──

  setEyelashColor(hexColor) {
    this.eyelashColor = hexColor;
    this._eyelashMat.color.set(hexColor);
    console.log('[EyeSystem] Eyelash color changed to:', hexColor);
  }

  setEyelashParam(param, value) {
    if (this.eyelashParams[param] === undefined) return;
    this.eyelashParams[param] = Math.max(0, Math.min(100, value));
    if (this._leftLashContainer || this._rightLashContainer) {
      this._applyEyelashAdjustments();
    }
  }

  setEyelashesVisible(visible) {
    this.eyelashesVisible = visible;
    this._eyelashGroup.visible = visible;
  }

  getEyelashParams() {
    return {
      ...this.eyelashParams,
      color: this.eyelashColor,
      visible: this.eyelashesVisible,
    };
  }

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

  _showCachedEyelashes() {
    this._clearGroup(this._eyelashGroup);
    const cached = this._modelCache['eyelashes'];
    if (!cached) return;

    // The eyelash GLB may contain a single combined mesh (both eyes) or separate meshes.
    // We'll clone the entire model twice — one for each eye — and mirror the right one.
    // First, check if the model appears to be a single-side (one eye) or full pair.
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
          /* Eyelashes do not cast.
          A lash is about 0.1mm across; the shadow map covers a ~3-unit
          frustum at 4096, so one texel is roughly 0.8mm. Every strand is
          far below a texel, so what lands on the sclera is not a shadow but
          pure aliasing — a scatter of hard blue-grey dashes across the
          white of the eye. Real lash shadows at portrait distance are a
          faint overall darkening, which the socket shading already gives. */
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

  _createLashContainer(source, name) {
    const container = new THREE.Group();
    container.name = name;

    const offsetGroup = new THREE.Group();
    offsetGroup.name = name + 'Offset';

    source.traverse(child => {
      if (child.isMesh) {
        const clone = child.clone();
        clone.material = this._eyelashMat;
        /* Eyelashes do not cast.
        A lash is about 0.1mm across; the shadow map covers a ~3-unit
        frustum at 4096, so one texel is roughly 0.8mm. Every strand is
        far below a texel, so what lands on the sclera is not a shadow but
        pure aliasing — a scatter of hard blue-grey dashes across the
        white of the eye. Real lash shadows at portrait distance are a
        faint overall darkening, which the socket shading already gives. */
        clone.castShadow = false;
        clone.receiveShadow = true;
        offsetGroup.add(clone);
      }
    });

    container.add(offsetGroup);
    return container;
  }

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
      // Full pair model — use the same approach as the eyebrow system:
      // Position using absolute world coordinates, not relative to eye base positions.
      const container = this._leftLashContainer;
      const offsetGroup = container.children[0];

      // Center the model at its own origin
      offsetGroup.position.set(-cache.center.x, -cache.center.y, -cache.center.z);

      // The eyelash region sits at approximately the same location as the eyebrows
      // but slightly lower (at the eyelid line instead of above the eye).
      // Eyebrow reference: browRegionWidth=0.90, browRegionY=0.39, browRegionZ=1.02
      // Eyelashes should be slightly lower in Y and slightly further forward in Z
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

  clearEyelashes() {
    this._clearGroup(this._eyelashGroup);
    this._leftLashContainer = null;
    this._rightLashContainer = null;
    this._eyelashBboxCache = null;
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
    this._clearGroup(this._eyelashGroup);
    this.scene.remove(this._eyelashGroup);
  }
}
