// Small hand-written post-processing chain (bloom, tone mapping, vignette, grain), since three's EffectComposer needs ES modules.

class PostFX {
  // Settings for each quality tier; this is the only place these numbers live.
  static get TIERS() {
    return {
      // Keep pores and feature edges free of animated grain and colour fringing.
      medium: { bloomStrength: 0.0, grain: 0.0, vignette: 0.06, aberration: 0.0 },
      high:   { bloomStrength: 0.0, grain: 0.0, vignette: 0.06, aberration: 0.0 },
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
      // Exposure is read from the renderer, because this pass does the tone mapping while it is on.
      exposure: renderer.toneMappingExposure,
      bloomStrength: PostFX.TIERS.medium.bloomStrength,
      bloomThreshold: 0.75,
      bloomKnee: 0.35,
      // Seeded from the tier table; grain is kept low so shadows don't look speckled.
      grain: PostFX.TIERS.medium.grain,
      vignette: PostFX.TIERS.medium.vignette,
      aberration: PostFX.TIERS.medium.aberration,
      contrast: 1.0,
      // No saturation boost, so the skin tone shown is exactly the one the operator chose.
      saturation: 1.0,
    };

    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = this._createFullscreenTriangle();

    this._buildTargets(1, 1);
    this._buildMaterials();
    this.setTier('medium');
  }

  // Builds one oversized triangle that covers the screen, which avoids a seam down the middle.
  _createFullscreenTriangle() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    return new THREE.Mesh(geo, null);
  }

  // Creates the render targets for the scene and the bloom passes.
  _buildTargets(width, height) {
    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // Half-float so highlights can go above 1.0 for the bloom to find.
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
    };

    // 2x multisampling on high-DPI screens to save bandwidth, 4x otherwise; hair strands need some to stay smooth.
    const samples = this.renderer.getPixelRatio() > 1.25 ? 2 : 4;

    this.sceneRT = new THREE.WebGLRenderTarget(width, height,
      Object.assign({}, opts, { samples }));

    const bw = Math.max(1, Math.floor(width / 2));
    const bh = Math.max(1, Math.floor(height / 2));
    this.bloomA = new THREE.WebGLRenderTarget(bw, bh,
      Object.assign({}, opts, { depthBuffer: false }));
    this.bloomB = new THREE.WebGLRenderTarget(bw, bh,
      Object.assign({}, opts, { depthBuffer: false }));
  }

  // Frees the render targets.
  _disposeTargets() {
    if (this.sceneRT) this.sceneRT.dispose();
    if (this.bloomA) this.bloomA.dispose();
    if (this.bloomB) this.bloomB.dispose();
    this.sceneRT = this.bloomA = this.bloomB = null;
  }

  // Vertex shader shared by every pass.
  static get VERTEX() {
    return [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = vec4( position.xy, 0.0, 1.0 );',
      '}',
    ].join('\n');
  }

  // Builds the bright-pass, blur and final composite shaders.
  _buildMaterials() {
    // Bright pass with a soft knee so highlights fade into the bloom instead of popping on.
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
        // ACES tone curve, close to the renderer's own so moving it here doesn't change the look.
        'vec3 acesFilm( vec3 x ) {',
        '  return clamp( ( x * ( 2.51 * x + 0.03 ) ) / ( x * ( 2.43 * x + 0.59 ) + 0.14 ), 0.0, 1.0 );',
        '}',
        'float acesFilm1( float x ) {',
        '  return clamp( ( x * ( 2.51 * x + 0.03 ) ) / ( x * ( 2.43 * x + 0.59 ) + 0.14 ), 0.0, 1.0 );',
        '}',
        '',
        // Tone map brightness only, so skin keeps the same hue whether it is in shadow or light.
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
        // Colour fringing grows toward the edges, like a real lens.
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
        // Grain is strongest in shadows and midtones, like real film.
        // Grain cells are about 1.5 pixels wide, so it looks like film grain instead of flickering pixel noise.
        '  vec2 grainCell = floor( gl_FragCoord.xy / max( uGrainSize, 1.0 ) );',
        '  float g = hash( grainCell + vec2( uTime * 37.0, uTime * 19.0 ) ) - 0.5;',
        // Gentle shadow weighting so grain doesn't crawl along shading edges such as the jawline.
        '  float grainWeight = 1.0 - smoothstep( 0.15, 1.0, lum );',
        '  color += g * uGrain * ( 0.62 + 0.38 * grainWeight );',
        '',
        '  color = max( color, vec3( 0.0 ) );',
        // Encode to sRGB by hand, since a raw ShaderMaterial skips three's conversion.
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

  // Sets the quality tier; Low turns the whole chain off.
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

  // Turns the effects on or off, moving tone mapping between the renderer and this pass.
  setEnabled(on) {
    this.enabled = !!on;
    // Don't let the renderer tone map as well, or the curve is applied twice.
    if (this.enabled) {
      this.renderer.toneMapping = THREE.NoToneMapping;
    } else {
      this.renderer.toneMapping = this._savedToneMapping;
      this.renderer.toneMappingExposure = this._savedExposure;
    }
    return this.enabled;
  }

  // Resizes the render targets to match the canvas.
  setSize(width, height) {
    const pr = this.renderer.getPixelRatio();
    // Update grain size here too, since moving to another monitor can change the pixel ratio.
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

  // Moves the grain animation on by one frame.
  tick() {
    this._time += 1 / 60;
    this._compositeMat.uniforms.uTime.value = this._time;
  }

  // Draws a full-screen pass with the given material into a target.
  _blit(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target || null);
    this.renderer.render(this._quad, this._camera);
  }

  // Renders the scene through the effects chain, or straight to the screen when it is off.
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

  // Frees every GPU resource the chain uses.
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
