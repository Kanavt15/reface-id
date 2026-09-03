/**
 * PostFX.js
 * A small hand-rolled post-processing chain: bloom, filmic grade, vignette,
 * chromatic aberration, grain.
 *
 * WHY HAND-ROLLED
 * ---------------
 * three's EffectComposer lives in `examples/jsm`, which is ESM. This app loads
 * the UMD global build from a plain <script> under file:// with no bundler, so
 * those modules are not reachable without vendoring and converting several
 * files. The pipeline needed here is two render targets and three shader
 * passes — less code than the conversion would be.
 *
 * WHY IT MATTERS FOR REALISM
 * --------------------------
 * A render is "too clean" in ways people detect without being able to name.
 * Photographs have sensor grain, lens falloff at the corners, a little colour
 * fringing, and highlights that bleed. A perfectly clean frame is read as CG
 * before any conscious analysis of the face happens at all. Grain and vignette
 * in particular are nearly free and do a disproportionate amount of the work.
 *
 * Tone mapping moves here from the renderer, because bloom has to be gathered
 * in linear light — bloom applied after tone mapping blooms the compressed
 * values and looks like a glow filter rather than lens flare.
 */

class PostFX {
  /**
   * Per-tier grade settings — the ONLY place these numbers live.
   *
   * setTier() runs at the end of the constructor and used to assign its own
   * hardcoded literals over params, so the values written in the constructor
   * were dead on arrival and editing the obvious one changed nothing. That is
   * the same trap that hid the duplicated exposure and the duplicated skin
   * constants; the constructor now seeds itself from this table instead.
   */
  static get TIERS() {
    return {
      medium: { bloomStrength: 0.22, grain: 0.022, vignette: 0.30, aberration: 0.0 },
      high:   { bloomStrength: 0.28, grain: 0.027, vignette: 0.36, aberration: 0.0022 },
    };
  }

  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;
    this.tier = 'medium';
    this._time = 0;
    this._disposed = false;

    // Renderer tone mapping is taken over by the composite pass.
    this._savedToneMapping = renderer.toneMapping;
    this._savedExposure = renderer.toneMappingExposure;

    this.params = {
      /* Taken from the renderer, not written here.
         setEnabled() swaps the renderer to NoToneMapping and this pass applies
         the operator instead, so while post is on — which is all of photoreal
         mode — renderer.toneMappingExposure is inert and THIS is the exposure.
         Two independent copies of that number meant changing the obvious one
         in SceneManager did nothing at all to the photoreal image. */
      exposure: renderer.toneMappingExposure,
      bloomStrength: PostFX.TIERS.medium.bloomStrength,
      bloomThreshold: 0.75,
      bloomKnee: 0.35,
      /* Seeded from the tier table; setTier() sets the live values.
         Grain is weighted toward the shadows (see the composite pass), so its
         amplitude is governed by how it looks in the DARKEST part of the
         frame, not the average. It came down from 0.032 because the shadow
         side of a jaw was carrying visibly stippled noise that re-randomised
         every frame. */
      grain: PostFX.TIERS.medium.grain,
      vignette: PostFX.TIERS.medium.vignette,
      aberration: PostFX.TIERS.medium.aberration,
      contrast: 1.06,
      /* 1.0 — no chroma boost.
         This was 1.09. A global saturation lift is a normal look-development
         move, but it lands hardest on whatever is already most saturated, and
         in a head-and-shoulders frame that is always the skin. It was pushing
         rendered skin from the albedo's R/B of 1.69 up towards 1.9, i.e. into
         a deep tan the operator never selected.
         That is a correctness problem before it is an aesthetic one: skin tone
         is part of the description this tool exists to produce, so the pipeline
         must show the tone that was set, not a graded interpretation of it.
         Grade for accuracy here; leave taste to the viewer. */
      saturation: 1.0,
    };

    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = this._createFullscreenTriangle();

    this._buildTargets(1, 1);
    this._buildMaterials();
    this.setTier('medium');
  }

  /**
   * A single oversized triangle rather than a quad: no diagonal seam, one
   * fewer vertex, and no risk of the two triangles being shaded inconsistently
   * along the shared edge.
   */
  _createFullscreenTriangle() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    return new THREE.Mesh(geo, null);
  }

  _buildTargets(width, height) {
    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // Half float so highlights can exceed 1.0 and actually have something
      // for the bloom threshold to find. An 8-bit target clips them away
      // before the bright pass ever runs.
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
    };

    this.sceneRT = new THREE.WebGLRenderTarget(width, height,
      Object.assign({}, opts, { samples: 4 }));

    const bw = Math.max(1, Math.floor(width / 2));
    const bh = Math.max(1, Math.floor(height / 2));
    this.bloomA = new THREE.WebGLRenderTarget(bw, bh,
      Object.assign({}, opts, { depthBuffer: false }));
    this.bloomB = new THREE.WebGLRenderTarget(bw, bh,
      Object.assign({}, opts, { depthBuffer: false }));
  }

  _disposeTargets() {
    if (this.sceneRT) this.sceneRT.dispose();
    if (this.bloomA) this.bloomA.dispose();
    if (this.bloomB) this.bloomB.dispose();
    this.sceneRT = this.bloomA = this.bloomB = null;
  }

  static get VERTEX() {
    return [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = vec4( position.xy, 0.0, 1.0 );',
      '}',
    ].join('\n');
  }

  _buildMaterials() {
    // ── Bright pass ──
    // Soft knee rather than a hard cutoff, so a highlight easing past the
    // threshold ramps into the bloom instead of popping on.
    this._brightMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: this.params.bloomThreshold },
        uKnee: { value: this.params.bloomKnee },
      },
      vertexShader: PostFX.VERTEX,
      fragmentShader: [
        'uniform sampler2D tDiffuse;',
        'uniform float uThreshold;',
        'uniform float uKnee;',
        'varying vec2 vUv;',
        'void main() {',
        '  vec3 c = texture2D( tDiffuse, vUv ).rgb;',
        '  float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );',
        '  float knee = max( uKnee, 1e-4 );',
        '  float soft = clamp( ( lum - uThreshold + knee ) / ( 2.0 * knee ), 0.0, 1.0 );',
        '  soft = soft * soft * ( lum > uThreshold - knee ? 1.0 : 0.0 );',
        '  float contrib = max( soft, step( uThreshold, lum ) );',
        '  gl_FragColor = vec4( c * contrib, 1.0 );',
        '}',
      ].join('\n'),
      depthTest: false,
      depthWrite: false,
    });

    // ── Separable blur ──
    this._blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uTexelSize: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: PostFX.VERTEX,
      fragmentShader: [
        'uniform sampler2D tDiffuse;',
        'uniform vec2 uDirection;',
        'uniform vec2 uTexelSize;',
        'varying vec2 vUv;',
        'void main() {',
        // 9-tap Gaussian collapsed to 5 bilinear fetches.
        '  vec2 off1 = uDirection * uTexelSize * 1.3846153846;',
        '  vec2 off2 = uDirection * uTexelSize * 3.2307692308;',
        '  vec3 c = texture2D( tDiffuse, vUv ).rgb * 0.2270270270;',
        '  c += texture2D( tDiffuse, vUv + off1 ).rgb * 0.3162162162;',
        '  c += texture2D( tDiffuse, vUv - off1 ).rgb * 0.3162162162;',
        '  c += texture2D( tDiffuse, vUv + off2 ).rgb * 0.0702702703;',
        '  c += texture2D( tDiffuse, vUv - off2 ).rgb * 0.0702702703;',
        '  gl_FragColor = vec4( c, 1.0 );',
        '}',
      ].join('\n'),
      depthTest: false,
      depthWrite: false,
    });

    // ── Composite ──
    this._compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: null },
        uBloomStrength: { value: this.params.bloomStrength },
        uExposure: { value: this.params.exposure },
        uGrain: { value: this.params.grain },
        uVignette: { value: this.params.vignette },
        uAberration: { value: this.params.aberration },
        uContrast: { value: this.params.contrast },
        uSaturation: { value: this.params.saturation },
        uTime: { value: 0 },
        // Device pixels per grain cell. See the grain block in the shader.
        uGrainSize: { value: 1.5 * Math.max(1, this.renderer.getPixelRatio() || 1) },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: PostFX.VERTEX,
      fragmentShader: [
        'uniform sampler2D tDiffuse;',
        'uniform sampler2D tBloom;',
        'uniform float uBloomStrength;',
        'uniform float uExposure;',
        'uniform float uGrain;',
        'uniform float uVignette;',
        'uniform float uAberration;',
        'uniform float uContrast;',
        'uniform float uSaturation;',
        'uniform float uTime;',
        'uniform float uGrainSize;',
        'uniform vec2 uResolution;',
        'varying vec2 vUv;',
        '',
        // Narkowicz's ACES fit. Cheap, and close enough to the renderer's
        // ACESFilmicToneMapping that moving the operator here does not shift
        // the look, only the point in the chain where it happens.
        'vec3 acesFilm( vec3 x ) {',
        '  return clamp( ( x * ( 2.51 * x + 0.03 ) ) / ( x * ( 2.43 * x + 0.59 ) + 0.14 ), 0.0, 1.0 );',
        '}',
        'float acesFilm1( float x ) {',
        '  return clamp( ( x * ( 2.51 * x + 0.03 ) ) / ( x * ( 2.43 * x + 0.59 ) + 0.14 ), 0.0, 1.0 );',
        '}',
        '',
        /* Hue-preserving tone mapping.
           Applying ACES per channel does not preserve chromaticity, and on skin
           the error is large and systematic. Measured on this app's own albedo
           (sRGB 203,154,120, R/B = 1.70), per-channel ACES renders it at:

               illumination 0.4  ->  R/B 1.99      (shadow: orange)
               illumination 0.8  ->  R/B 1.59
               illumination 1.7  ->  R/B 1.28      (highlight: pale)

           So one skin tone comes out a different hue depending only on how
           brightly that part of the face happens to be lit, which is why the
           neck read as golden while the forehead read as pale. That is a
           colour-accuracy fault rather than a look: skin tone is part of the
           description this tool produces, and it has to survive the lighting.

           Tone mapping the LUMINANCE and rescaling the channels around it
           holds the hue fixed (measured 1.68-1.73 from shadow to midtone).
           The per-channel curve is blended back in only above the point where
           the image is genuinely blowing out, because there the desaturation
           toward white is real sensor behaviour and not an artefact. */
        'vec3 toneMapHuePreserving( vec3 x ) {',
        '  float l = dot( x, vec3( 0.2126, 0.7152, 0.0722 ) );',
        '  vec3 hueSafe = x * ( acesFilm1( l ) / max( l, 1e-5 ) );',
        '  return clamp( mix( hueSafe, acesFilm( x ), smoothstep( 0.5, 1.2, l ) ), 0.0, 1.0 );',
        '}',
        '',
        'float hash( vec2 p ) {',
        '  return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );',
        '}',
        '',
        'void main() {',
        // Real lenses disperse more toward the edges of the frame, so the
        // offset scales with distance from centre rather than being uniform.
        '  vec2 centered = vUv - 0.5;',
        '  float r2 = dot( centered, centered );',
        '  vec2 caOffset = centered * r2 * uAberration;',
        '  vec3 color;',
        '  color.r = texture2D( tDiffuse, vUv + caOffset ).r;',
        '  color.g = texture2D( tDiffuse, vUv ).g;',
        '  color.b = texture2D( tDiffuse, vUv - caOffset ).b;',
        '',
        '  vec3 bloom = texture2D( tBloom, vUv ).rgb;',
        '  color += bloom * uBloomStrength;',
        '',
        '  color *= uExposure;',
        '  color = toneMapHuePreserving( color );',
        '',
        '  float lum = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );',
        '  color = mix( vec3( lum ), color, uSaturation );',
        '  color = ( color - 0.5 ) * uContrast + 0.5;',
        '',
        '  float vig = 1.0 - uVignette * smoothstep( 0.25, 0.85, length( centered ) * 1.35 );',
        '  color *= vig;',
        '',
        // Grain is strongest in the midtones and shadows, as on real film and
        // on a real sensor: bright areas carry more signal per grain.
        /* Grain is quantised to cells ~1.5 CSS pixels across, not to single
           device pixels.

           Measured on a real frame, the grain was per-device-pixel white
           noise with about half its energy above 70% of Nyquist, fully
           re-randomised every frame. Noise sitting right on the sampling grid
           is the worst place to put it: it has nowhere to alias except into
           the pixel grid itself, it sizzles rather than reading as grain, and
           it is the only thing in the whole frame that changes when the camera
           is completely still (verified: with grain off, two consecutive
           frames are pixel-identical).

           Sizing the cell above one pixel puts the noise below Nyquist, which
           is also the more physical model — film grain is a particle of fixed
           size, not something that gets finer because the panel is denser.
           Scaling by the pixel ratio keeps the apparent size constant across
           displays. */
        '  vec2 grainCell = floor( gl_FragCoord.xy / max( uGrainSize, 1.0 ) );',
        '  float g = hash( grainCell + vec2( uTime * 37.0, uTime * 19.0 ) ) - 0.5;',
        /* The shadow weighting is gentler than it was: 0.35 + 0.65 * w gave
           the darkest pixels almost three times the grain of the brightest.
           Photon noise really is relatively stronger in shadow, so some of
           this is right, but applied here — after tone mapping and the sRGB
           encode — the perceptual effect in the dark end is exaggerated well
           past what a sensor does.
           The visible failure was at SHADING BOUNDARIES. Along a jawline or
           the side of a neck the luminance crosses the smoothstep range over a
           few pixels, so the grain amplitude jumped across that same edge and
           laid a band of strong, fully re-randomised noise along it. Those
           boundaries are diagonal on a three-quarter view, and noise boiling
           along a diagonal edge reads as a diagonal line crawling across the
           face. Flattening the ratio keeps grain in the shadows without
           drawing it along every terminator. */
        '  float grainWeight = 1.0 - smoothstep( 0.15, 1.0, lum );',
        '  color += g * uGrain * ( 0.62 + 0.38 * grainWeight );',
        '',
        '  color = max( color, vec3( 0.0 ) );',
        // Manual sRGB encode: a raw ShaderMaterial does not get three's
        // output colour-space conversion.
        '  vec3 srgb = mix( color * 12.92,',
        '                   1.055 * pow( max( color, vec3( 1e-5 ) ), vec3( 1.0 / 2.4 ) ) - 0.055,',
        '                   step( vec3( 0.0031308 ), color ) );',
        // Ordered dither against banding in the backdrop gradient.
        '  float d = ( hash( gl_FragCoord.xy * 0.7 ) - 0.5 ) / 255.0;',
        '  gl_FragColor = vec4( srgb + d, 1.0 );',
        '}',
      ].join('\n'),
      depthTest: false,
      depthWrite: false,
    });
  }

  /**
   * Quality tiers. Low skips the whole chain — `enabled` false means
   * SceneManager.renderFrame() draws straight to the canvas and no render
   * targets are touched.
   */
  setTier(tier) {
    this.tier = tier;
    const p = this.params;

    if (tier === 'low') {
      this.setEnabled(false);
      return this.tier;
    }

    Object.assign(p, PostFX.TIERS[tier === 'high' ? 'high' : 'medium']);

    const u = this._compositeMat.uniforms;
    u.uBloomStrength.value = p.bloomStrength;
    u.uGrain.value = p.grain;
    u.uVignette.value = p.vignette;
    u.uAberration.value = p.aberration;

    this.setEnabled(true);
    return this.tier;
  }

  setEnabled(on) {
    this.enabled = !!on;
    // The renderer must not tone map into the float target as well; that would
    // apply the curve twice.
    if (this.enabled) {
      this.renderer.toneMapping = THREE.NoToneMapping;
    } else {
      this.renderer.toneMapping = this._savedToneMapping;
      this.renderer.toneMappingExposure = this._savedExposure;
    }
    return this.enabled;
  }

  setSize(width, height) {
    const pr = this.renderer.getPixelRatio();
    /* Refreshed here, not just at construction: dragging the window to a
       monitor with different scaling changes the pixel ratio, and the grain
       should keep the same apparent size rather than growing or shrinking
       with the panel. */
    this._compositeMat.uniforms.uGrainSize.value = 1.5 * Math.max(1, pr);

    const w = Math.max(1, Math.floor(width * pr));
    const h = Math.max(1, Math.floor(height * pr));
    if (this._width === w && this._height === h) return;
    this._width = w;
    this._height = h;

    this._disposeTargets();
    this._buildTargets(w, h);
    this._compositeMat.uniforms.uResolution.value.set(w, h);
  }

  /** Advance the grain animation. Called once per frame by SceneManager. */
  tick() {
    this._time += 1 / 60;
    this._compositeMat.uniforms.uTime.value = this._time;
  }

  _blit(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target || null);
    this.renderer.render(this._quad, this._camera);
  }

  render(scene, camera) {
    if (!this.enabled || this._disposed || !this.sceneRT) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }

    const prevTarget = this.renderer.getRenderTarget();

    // 1. Scene → float target.
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear();
    this.renderer.render(scene, camera);

    // 2. Bright pass → half res.
    this._brightMat.uniforms.tDiffuse.value = this.sceneRT.texture;
    this._blit(this._brightMat, this.bloomA);

    // 3. Separable blur, horizontal then vertical.
    const tx = 1 / this.bloomA.width;
    const ty = 1 / this.bloomA.height;

    this._blurMat.uniforms.tDiffuse.value = this.bloomA.texture;
    this._blurMat.uniforms.uDirection.value.set(1, 0);
    this._blurMat.uniforms.uTexelSize.value.set(tx, ty);
    this._blit(this._blurMat, this.bloomB);

    this._blurMat.uniforms.tDiffuse.value = this.bloomB.texture;
    this._blurMat.uniforms.uDirection.value.set(0, 1);
    this._blit(this._blurMat, this.bloomA);

    // 4. Composite to the canvas.
    this._compositeMat.uniforms.tDiffuse.value = this.sceneRT.texture;
    this._compositeMat.uniforms.tBloom.value = this.bloomA.texture;
    this._blit(this._compositeMat, null);

    this.renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this._disposed = true;
    this._disposeTargets();
    if (this._brightMat) this._brightMat.dispose();
    if (this._blurMat) this._blurMat.dispose();
    if (this._compositeMat) this._compositeMat.dispose();
    if (this._quad) this._quad.geometry.dispose();
    this.renderer.toneMapping = this._savedToneMapping;
    this.renderer.toneMappingExposure = this._savedExposure;
  }
}

window.PostFX = PostFX;
