// Shows the face as the witness saw it: the light on the subject, the distance, and whether an eye or a CCTV camera did the seeing. Runs as a pass over the finished frame.

class WitnessView {
  // Light on the subject. `lux` is the illuminance on the face, `tint` the cast the light keeps once the eye has adapted to it, and `colour` how much hue survives it (roughly the lamp's colour rendering).
  static get LIGHTING() {
    return {
      daylight:  { label: 'Daylight',      lux: 10000, tint: [1.00, 1.00, 1.00], colour: 1.00 },
      overcast:  { label: 'Overcast',      lux: 1000,  tint: [0.97, 0.99, 1.04], colour: 1.00 },
      indoor:    { label: 'Indoor',        lux: 400,   tint: [0.98, 1.02, 0.97], colour: 0.85 },
      led:       { label: 'LED street',    lux: 15,    tint: [0.94, 1.00, 1.10], colour: 0.70 },
      // High-pressure sodium: the orange street lamp. It renders colour so poorly that most hues collapse into shades of amber.
      sodium:    { label: 'Sodium street', lux: 15,    tint: [1.38, 0.92, 0.40], colour: 0.10 },
      dusk:      { label: 'Dusk',          lux: 3,     tint: [0.86, 0.95, 1.18], colour: 0.60 },
      moonlight: { label: 'Moonlight',     lux: 0.25,  tint: [0.78, 0.92, 1.22], colour: 0.00 },
    };
  }

  // A face is about 14 cm across the cheekbones, roughly three quarters of the head mesh's ear-to-ear width.
  static get FACE_WIDTH_M() { return 0.14; }
  static get FACE_FRACTION() { return 0.75; }

  // The halving chain and the smooth enlargement soften more than an ideal filter would, so the eye's frame keeps 1.5× the Nyquist samples to put the cut-off where the acuity says.
  static get EYE_OVERSAMPLE() { return 1.5; }

  // A 720p camera behind a 90° lens: 1280 pixels over 90 degrees.
  static get CCTV_PX_PER_DEG() { return 1280 / 90; }

  // EN 62676-4 grades a camera by pixels per metre at the subject; identification needs 250.
  static get CCTV_GRADES() {
    return [
      { ppm: 250, label: 'Identification' },
      { ppm: 125, label: 'Recognition' },
      { ppm: 62.5, label: 'Observation' },
      { ppm: 25, label: 'Detection' },
      { ppm: 0, label: 'Monitoring only' },
    ];
  }

  // Below this a CCTV camera switches to its infrared night mode, which sees no colour.
  static get CCTV_IR_LUX() { return 5; }

  // Wagenaar & van der Schrier (1996): identifications made from further than 15 m, or in less than 15 lux, proved unreliable.
  static get RULE_OF_15() { return { distance: 15, lux: 15 }; }

  // Cycles per degree the eye resolves: about 30 in daylight, falling to about 10 by moonlight. A rough fit that keeps the trend right.
  static eyeAcuity(lux) {
    const t = (Math.log10(Math.max(lux, 0.01)) + 0.6) / 2.3;
    return Math.min(30, Math.max(8, 10 + 20 * t));
  }

  // How much colour vision survives, from 1 above about 30 lux to 0 by about 0.5 lux, where rods have taken over from cones.
  static colourVision(lux) {
    const lo = Math.log10(0.5);
    const hi = Math.log10(30);
    const t = (Math.log10(Math.max(lux, 0.01)) - lo) / (hi - lo);
    return Math.min(1, Math.max(0, t));
  }

  // The face's width in degrees of visual angle at a distance in metres.
  static faceAngle(distance) {
    const half = WitnessView.FACE_WIDTH_M / 2 / Math.max(distance, 0.1);
    return 2 * Math.atan(half) * 180 / Math.PI;
  }

  // Works out what the witness could have seen; drives both the render pass and the panel readout.
  static assess(conditions) {
    const light = WitnessView.LIGHTING[conditions.light] || WitnessView.LIGHTING.daylight;
    const distance = conditions.distance;
    const cctv = conditions.sensor === 'cctv';
    const angle = WitnessView.faceAngle(distance);

    // A camera has exactly as many samples as pixels; an eye resolves `cycles` and needs two samples for each.
    const cycles = cctv ? angle * WitnessView.CCTV_PX_PER_DEG / 2 : angle * WitnessView.eyeAcuity(light.lux);
    const samples = cctv ? cycles * 2 : cycles * 2 * WitnessView.EYE_OVERSAMPLE;
    const infrared = cctv && light.lux < WitnessView.CCTV_IR_LUX;
    const colour = infrared ? 0 : light.colour * WitnessView.colourVision(light.lux) * (cctv ? 0.75 : 1);

    // Pixels per metre at the subject: a metre's angular width at this distance times the camera's pixels per degree.
    const metreAngle = 2 * Math.atan(0.5 / Math.max(distance, 0.1)) * 180 / Math.PI;
    const ppm = metreAngle * WitnessView.CCTV_PX_PER_DEG;
    const grade = WitnessView.CCTV_GRADES.find((g) => ppm >= g.ppm);

    const rule = WitnessView.RULE_OF_15;
    return {
      light,
      lux: light.lux,
      angle,
      samples,
      cycles,
      colour,
      infrared,
      ppm,
      grade: grade.label,
      tooFar: distance > rule.distance,
      tooDark: light.lux < rule.lux,
    };
  }

  constructor(sceneManager) {
    this.sceneManager = sceneManager;
    this.renderer = sceneManager.renderer;
    this.active = false;
    this.conditions = { light: 'daylight', distance: 5, sensor: 'eye' };

    this._size = new THREE.Vector2();
    this._src = null;
    this._chain = [];
    this._low = null;
    this._headWidth = null;
    this._measureIn = 0;

    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this._quad = new THREE.Mesh(geo, null);

    this._buildOverlay();
    this._buildMaterials();
  }

  // ─── State ─────────────────────────────────────────────────────────────

  // Updates any of light, distance and sensor; unknown values are ignored.
  setConditions(next) {
    if (!next) return this.conditions;
    const c = this.conditions;
    if (next.light && WitnessView.LIGHTING[next.light]) c.light = next.light;
    if (next.sensor === 'eye' || next.sensor === 'cctv') c.sensor = next.sensor;
    const d = Number(next.distance);
    if (Number.isFinite(d)) c.distance = Math.min(60, Math.max(1, d));
    return c;
  }

  // Returns a copy of the conditions, for the case record.
  getConditions() {
    return { ...this.conditions };
  }

  // Turns the witness view on or off and returns the new state.
  setActive(on) {
    this.active = !!on;
    return this.active;
  }

  // ─── Rendering ─────────────────────────────────────────────────────────

  // Builds the downsample pass and the final pass that applies light, colour and sensor.
  _buildMaterials() {
    // Four bilinear taps at half-texel offsets average a 4×4 block, enough for a clean halving step.
    this._boxMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: PostFX.VERTEX,
      fragmentShader: [
        'uniform sampler2D tDiffuse;',
        'uniform vec2 uTexel;',
        'varying vec2 vUv;',
        'void main() {',
        '  vec3 c = texture2D( tDiffuse, vUv + uTexel * vec2( -0.5, -0.5 ) ).rgb;',
        '  c += texture2D( tDiffuse, vUv + uTexel * vec2(  0.5, -0.5 ) ).rgb;',
        '  c += texture2D( tDiffuse, vUv + uTexel * vec2( -0.5,  0.5 ) ).rgb;',
        '  c += texture2D( tDiffuse, vUv + uTexel * vec2(  0.5,  0.5 ) ).rgb;',
        '  gl_FragColor = vec4( c * 0.25, 1.0 );',
        '}',
      ].join('\n'),
      depthTest: false,
      depthWrite: false,
    });

    this._finalMat = new THREE.ShaderMaterial({
      uniforms: {
        tLow: { value: null },
        uLowSize: { value: new THREE.Vector2(1, 1) },
        uSmooth: { value: 1 },
        uCamera: { value: 0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uColour: { value: 1 },
        uExposure: { value: 1 },
        uBlack: { value: 0 },
        uContrast: { value: 1 },
        uMono: { value: 0 },
        uNoise: { value: 0 },
        uTime: { value: 0 },
        tOverlay: { value: this._overlayTexture },
        uOverlay: { value: 0 },
        uOverlayRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      },
      vertexShader: PostFX.VERTEX,
      fragmentShader: [
        'uniform sampler2D tLow;',
        'uniform vec2 uLowSize;',
        'uniform float uSmooth;',
        'uniform float uCamera;',
        'uniform vec3 uTint;',
        'uniform float uColour;',
        'uniform float uExposure;',
        'uniform float uBlack;',
        'uniform float uContrast;',
        'uniform float uMono;',
        'uniform float uNoise;',
        'uniform float uTime;',
        'uniform sampler2D tOverlay;',
        'uniform float uOverlay;',
        'uniform vec4 uOverlayRect;',
        'varying vec2 vUv;',
        '',
        'float hash( vec2 p ) {',
        '  return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );',
        '}',
        '',
        // Cubic B-spline from four bilinear fetches: a smooth enlargement without the diamond pattern plain bilinear leaves.
        'vec3 sampleSmooth( vec2 uv ) {',
        '  vec2 p = uv * uLowSize - 0.5;',
        '  vec2 f = fract( p );',
        '  p -= f;',
        '  vec2 f2 = f * f;',
        '  vec2 f3 = f2 * f;',
        '  vec2 w0 = ( -f3 + 3.0 * f2 - 3.0 * f + 1.0 ) / 6.0;',
        '  vec2 w1 = ( 3.0 * f3 - 6.0 * f2 + 4.0 ) / 6.0;',
        '  vec2 w2 = ( -3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0 ) / 6.0;',
        '  vec2 w3 = f3 / 6.0;',
        '  vec2 s0 = w0 + w1;',
        '  vec2 s1 = w2 + w3;',
        '  vec2 t0 = ( p - 0.5 + w1 / s0 ) / uLowSize;',
        '  vec2 t1 = ( p + 1.5 + w3 / s1 ) / uLowSize;',
        '  return ( texture2D( tLow, vec2( t0.x, t0.y ) ).rgb * s0.x + texture2D( tLow, vec2( t1.x, t0.y ) ).rgb * s1.x ) * s0.y',
        '       + ( texture2D( tLow, vec2( t0.x, t1.y ) ).rgb * s0.x + texture2D( tLow, vec2( t1.x, t1.y ) ).rgb * s1.x ) * s1.y;',
        '}',
        '',
        'void main() {',
        // A camera frame enlarged shows its pixels; an eye's blur is smooth.
        '  vec2 cell = ( floor( vUv * uLowSize ) + 0.5 ) / uLowSize;',
        '  vec3 c = uSmooth > 0.5 ? sampleSmooth( vUv ) : texture2D( tLow, cell ).rgb;',
        '',
        // The frame arrives sRGB-encoded; light and colour are worked in linear terms.
        '  c = pow( max( c, vec3( 0.0 ) ), vec3( 2.2 ) );',
        '  float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );',
        '  c = mix( vec3( lum ), c, uColour ) * uTint;',
        // Infrared night mode: one channel, with skin reading pale as it does under an IR lamp.
        '  c = mix( c, vec3( pow( lum, 0.85 ) ), uMono );',
        '  c *= uExposure;',
        // Dim light swallows the shadows first.
        '  c = max( c - uBlack, vec3( 0.0 ) ) / ( 1.0 - uBlack );',
        '',
        '  vec3 s = pow( clamp( c, 0.0, 1.0 ), vec3( 1.0 / 2.2 ) );',
        '  s = ( s - 0.5 ) * uContrast + 0.5;',
        // A camera's noise sits on its own pixels; the eye's is fine grain.
        '  vec2 grain = uCamera > 0.5 ? floor( vUv * uLowSize ) : floor( gl_FragCoord.xy / 2.0 );',
        '  s += ( hash( grain + vec2( uTime * 37.0, uTime * 19.0 ) ) - 0.5 ) * uNoise;',
        '',
        '  vec2 ov = ( vUv - uOverlayRect.xy ) / uOverlayRect.zw;',
        '  if ( uOverlay > 0.5 && ov.x >= 0.0 && ov.x <= 1.0 && ov.y >= 0.0 && ov.y <= 1.0 ) {',
        '    vec4 t = texture2D( tOverlay, ov );',
        '    s = mix( s, t.rgb, t.a );',
        '  }',
        '  gl_FragColor = vec4( clamp( s, 0.0, 1.0 ), 1.0 );',
        '}',
      ].join('\n'),
      depthTest: false,
      depthWrite: false,
    });
  }

  // The camera's burned-in caption, drawn into a texture so screenshots and clips carry it too.
  _buildOverlay() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 80;
    this._overlayCanvas = canvas;
    this._overlayTexture = new THREE.CanvasTexture(canvas);
    this._overlayTexture.minFilter = THREE.LinearFilter;
    this._overlayStamp = '';
  }

  // Redraws the caption once a second.
  _updateOverlay() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}  ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    if (stamp === this._overlayStamp) return;
    this._overlayStamp = stamp;

    const ctx = this._overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, 1024, 80);
    ctx.font = '600 46px "Plex Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#f2f0ec';
    ctx.fillText('CAM 01', 16, 40);
    ctx.textAlign = 'right';
    ctx.fillText(stamp, 1008, 40);
    ctx.textAlign = 'left';
    this._overlayTexture.needsUpdate = true;
  }

  // Draws a full-screen pass with the given material into a target.
  _blit(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target || null);
    this.renderer.render(this._quad, this._camera);
  }

  // Makes an 8-bit render target; the frame it holds is already tone mapped.
  _target(w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  // Sizes the full-resolution target to the canvas, rebuilding the halving chain when it changes.
  _ensureSource(w, h) {
    if (this._src && this._src.width === w && this._src.height === h) return;
    if (this._src) this._src.dispose();
    // Depth only matters for the fallback path that renders the scene straight in; PostFX blits a finished frame.
    this._src = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this._chain.forEach((t) => t.dispose());
    this._chain = [];
  }

  // Box-filters one target into another.
  _box(from, to) {
    this._boxMat.uniforms.tDiffuse.value = from.texture;
    this._boxMat.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
    this._blit(this._boxMat, to);
  }

  // Halves the frame until the next halving would undershoot, then makes the last step to the exact size.
  _downsample(lw, lh) {
    let from = this._src;
    let level = 0;
    while (from.width / 2 >= lw && from.height / 2 >= lh) {
      const w = Math.max(1, Math.ceil(from.width / 2));
      const h = Math.max(1, Math.ceil(from.height / 2));
      if (!this._chain[level]) this._chain[level] = this._target(w, h);
      this._box(from, this._chain[level]);
      from = this._chain[level];
      level++;
    }
    if (!this._low || this._low.width !== lw || this._low.height !== lh) {
      if (this._low) this._low.dispose();
      this._low = this._target(lw, lh);
    }
    this._box(from, this._low);
    return this._low;
  }

  // The face's width on screen in device pixels, from the head's measured width and the camera's distance and field of view.
  _facePixels(drawH) {
    if (this._measureIn-- <= 0 || this._headWidth === null) {
      this._headWidth = this._measureHead();
      // Morphs and accessories change the box slowly, so re-measure about twice a second.
      this._measureIn = 30;
    }
    const sm = this.sceneManager;
    const dist = sm.camera.position.distanceTo(sm.controls.target);
    const viewH = 2 * Math.tan(THREE.MathUtils.degToRad(sm.camera.fov) / 2) * dist;
    return this._headWidth * WitnessView.FACE_FRACTION * drawH / Math.max(viewH, 1e-3);
  }

  // Measures the head mesh's ear-to-ear width in world units.
  _measureHead() {
    const head = this.sceneManager.headMesh;
    if (!head) return 1.9;
    const box = new THREE.Box3().setFromObject(head);
    return box.isEmpty() ? 1.9 : box.max.x - box.min.x;
  }

  // Renders the frame as the witness saw it.
  render(scene, camera) {
    const r = this.renderer;
    r.getDrawingBufferSize(this._size);
    const w = this._size.x;
    const h = this._size.y;
    this._ensureSource(w, h);

    const prevTarget = r.getRenderTarget();
    const pfx = this.sceneManager.postFX;
    if (pfx) {
      pfx.render(scene, camera, this._src);
    } else {
      r.setRenderTarget(this._src);
      r.render(scene, camera);
    }

    const a = WitnessView.assess(this.conditions);
    const cctv = this.conditions.sensor === 'cctv';

    // Shrink the frame until the face spans as many samples as the witness could resolve.
    const scale = Math.min(1, a.samples / Math.max(this._facePixels(h), 1));
    let low = this._src;
    if (scale < 0.9) {
      low = this._downsample(Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale)));
    }

    const lux = a.lux;
    const vision = WitnessView.colourVision(lux);
    const u = this._finalMat.uniforms;
    u.tLow.value = low.texture;
    u.uLowSize.value.set(low.width, low.height);
    // At full resolution the texel-centre fetch is an exact copy, so only a reduced frame needs smoothing.
    u.uSmooth.value = cctv || low === this._src ? 0 : 1;
    u.uCamera.value = cctv ? 1 : 0;
    u.uColour.value = a.colour;
    u.uMono.value = a.infrared ? 1 : 0;
    u.uTint.value.fromArray(a.infrared ? [1, 1, 1] : a.light.tint);
    // Perceived brightness follows the log of the light, never dropping to black: the eye and the camera both adapt.
    u.uExposure.value = a.infrared ? 0.95
      : Math.min(1, Math.max(0.3, 0.3 + 0.7 * (Math.log10(lux) + 1) / 3));
    u.uBlack.value = a.infrared ? 0.02 : (1 - vision) * 0.05;
    u.uContrast.value = cctv ? 1.12 : 1.0;
    u.uNoise.value = cctv ? 0.035 + (1 - vision) * 0.05 : (1 - vision) * 0.045;
    u.uTime.value = (performance.now() / 1000) % 1000;

    u.uOverlay.value = cctv ? 1 : 0;
    if (cctv) {
      this._updateOverlay();
      // Across the top like a real camera's caption, just below the viewport badge.
      const rw = 0.3;
      const rh = rw * (80 / 1024) * (w / h);
      u.uOverlayRect.value.set(0.5 - rw / 2, 1 - 0.095 - rh, rw, rh);
    }

    this._blit(this._finalMat, null);
    r.setRenderTarget(prevTarget);
  }

  // ─── Panel ─────────────────────────────────────────────────────────────

  // Wires the Witness conditions panel and the dock button; `ui` is the UIController, for history, slider fills and the case record.
  bindUI(ui) {
    this.ui = ui;
    const viewport = document.getElementById('viewport');
    if (viewport) {
      this._badge = document.createElement('div');
      this._badge.className = 'k-witness-badge';
      this._badge.hidden = true;
      viewport.appendChild(this._badge);
    }

    document.querySelectorAll('#witnessLightGrid [data-witness-light]').forEach((card) => {
      card.addEventListener('click', () => this._change({ light: card.dataset.witnessLight }));
    });
    document.querySelectorAll('#witnessSensorGrid [data-witness-sensor]').forEach((card) => {
      card.addEventListener('click', () => this._change({ sensor: card.dataset.witnessSensor }));
    });

    // Conditions are a viewing aid like the reference overlay, so they stay out of undo; they are kept with the case.
    const slider = document.getElementById('witnessDistanceSlider');
    slider?.addEventListener('input', (e) => this._change({ distance: parseFloat(e.target.value) }));

    document.getElementById('btnWitnessView')?.addEventListener('click', () => this.toggle());
    document.getElementById('btnWitnessDock')?.addEventListener('click', () => this.toggle());

    this.syncUI();
  }

  // Switches the witness view on or off from the panel or the dock.
  toggle() {
    this.setActive(!this.active);
    this.syncUI();
    if (this.ui) {
      this.ui.addHistory(this.active ? `Witness view on: ${this.describe()}` : 'Witness view off');
    }
    return this.active;
  }

  // Applies a change from the panel, records it with the case and refreshes the panel.
  _change(next) {
    this.setConditions(next);
    if (this.ui?.caseManager) this.ui.caseManager.currentCase.witnessConditions = this.getConditions();
    this.syncUI();
  }

  // One line naming the conditions, for the history and the viewport badge.
  describe() {
    const c = this.conditions;
    const light = WitnessView.LIGHTING[c.light].label;
    return `${light}, ${c.distance} m, ${c.sensor === 'cctv' ? 'CCTV camera' : "witness's eyes"}`;
  }

  // Pushes the conditions into the panel, the readout, the badge and both toggles.
  syncUI() {
    const c = this.conditions;
    document.querySelectorAll('#witnessLightGrid [data-witness-light]').forEach((card) => {
      card.classList.toggle('active', card.dataset.witnessLight === c.light);
    });
    document.querySelectorAll('#witnessSensorGrid [data-witness-sensor]').forEach((card) => {
      card.classList.toggle('active', card.dataset.witnessSensor === c.sensor);
    });

    const slider = document.getElementById('witnessDistanceSlider');
    if (slider) {
      slider.value = c.distance;
      const vd = slider.closest('.slider-control')?.querySelector('.slider-value');
      if (vd) vd.textContent = String(c.distance);
      this.ui?.updateSliderFill(slider);
    }

    const btn = document.getElementById('btnWitnessView');
    if (btn) {
      btn.classList.toggle('active', this.active);
      const label = btn.querySelector('span');
      if (label) label.textContent = this.active ? 'Return to studio view' : 'See it as the witness did';
    }
    document.getElementById('btnWitnessDock')?.classList.toggle('active', this.active);

    if (this._badge) {
      this._badge.hidden = !this.active;
      this._badge.textContent = `Witness view · ${this.describe()}`;
    }
    this._renderReadout();
  }

  // Writes the verdict, the rule of 15 for an eye or the EN 62676-4 grade for a camera, then how much detail and colour survive.
  _renderReadout() {
    const el = document.getElementById('witnessReadout');
    if (!el) return;
    const c = this.conditions;
    const a = WitnessView.assess(c);
    const cctv = c.sensor === 'cctv';

    const detail = a.cycles >= 30 ? 'Fine detail resolvable'
      : a.cycles >= 12 ? 'Coarse detail only'
      : 'Very little facial detail';
    const colour = a.colour >= 0.6 ? 'Colour seen reliably'
      : a.colour >= 0.25 ? 'Colour distorted'
      : 'Colour not perceivable';
    const lux = a.lux >= 1 ? Math.round(a.lux).toLocaleString() : a.lux.toFixed(2);

    let ok;
    let verdict;
    if (cctv) {
      // The rule of 15 is about eyewitnesses; a camera is graded by the pixels it puts on the subject.
      ok = a.ppm >= 250;
      verdict = ok ? `${a.grade} grade` : `${a.grade} grade — identification needs 250 px/m`;
    } else {
      ok = !a.tooFar && !a.tooDark;
      const reasons = [];
      if (a.tooFar) reasons.push('further than 15 m');
      if (a.tooDark) reasons.push('darker than 15 lux');
      verdict = ok ? 'Within the rule of 15' : `Outside the rule of 15 — ${reasons.join(' and ')}`;
    }

    el.className = `rf-witness-readout ${ok ? 'is-ok' : 'is-warn'}`;
    el.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'rf-witness-verdict';
    head.textContent = verdict;
    el.appendChild(head);

    const rows = cctv ? [
      ['Light', `${lux} lux`],
      ['On the subject', `${Math.round(a.ppm)} px/m`],
      ['Face spans', `${Math.round(a.samples)} px · ${detail}`],
      ['Colour', a.infrared ? 'Infrared — none' : colour],
    ] : [
      ['Light', `${lux} lux`],
      ['Face spans', `${a.angle.toFixed(2)}°`],
      ['Detail', `~${Math.round(a.cycles)} cycles · ${detail}`],
      ['Colour', colour],
    ];
    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'rf-witness-row';
      const key = document.createElement('span');
      key.textContent = k;
      const val = document.createElement('span');
      val.textContent = v;
      row.append(key, val);
      el.appendChild(row);
    }

    if (a.colour < 0.25) {
      const note = document.createElement('p');
      note.className = 'rf-witness-caution';
      note.textContent = 'Treat any hair, eye or skin colour this witness reported with caution.';
      el.appendChild(note);
    }
  }

  // Frees the GPU resources.
  dispose() {
    if (this._src) this._src.dispose();
    if (this._low) this._low.dispose();
    this._chain.forEach((t) => t.dispose());
    this._boxMat.dispose();
    this._finalMat.dispose();
    this._overlayTexture.dispose();
    this._quad.geometry.dispose();
  }
}

window.WitnessView = WitnessView;
