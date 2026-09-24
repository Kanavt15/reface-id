// Shader code for the iris, sclera and cornea, anchored to each eyeball's own gaze direction so the detail turns with the head.
class EyeShading {
  // How far the iris shifts under the cornea at an angle, kept below the physical value to avoid a wobble.
  static get PARALLAX() { return 0.115; }

  // The cornea magnifies the iris and pupil slightly.
  static get CORNEA_MAGNIFY() { return 0.93; }

  // How far the corneal bulge sticks out, as a multiple of the eyeball radius.
  static get CORNEA_PROTRUSION() { return 1.105; }

  // Smallest gap between the cornea and the iris dome.
  static get CORNEA_CLEARANCE() { return 0.025; }

  // How far the tear-film shell floats off the eyeball.
  static get SHELL_LIFT() { return 1.006; }

  // Number of rings on the corneal cap.
  static get SHELL_CAP_RINGS() { return 20; }
  // Number of rings on the rest of the shell.
  static get SHELL_BALL_RINGS() { return 26; }
  // Number of segments around the shell.
  static get SHELL_SEGMENTS() { return 72; }

  // Where the shell stops at the back, since that part is inside the head.
  static get SHELL_BACK_POLAR() { return 2.75; }

  // ── Anatomy ──────────────────────────────────────────────────────────────

  // Measures an eyeball's gaze axis, iris edge and pupil from its own sphere meshes, or returns null.
  static measureAnatomy(parts) {
    const S = EyeShading._sphereOf(parts.sclera);
    const I = EyeShading._sphereOf(parts.iris);
    if (!S || !I) return null;

    // The gaze axis runs from the eyeball centre to the iris centre, rather than trusting the model's +Y.
    const axis = I.centre.clone().sub(S.centre);
    const gap = axis.length();
    if (gap < 1e-6 || S.radius < 1e-6 || I.radius < 1e-6) return null;
    axis.divideScalar(gap);

    const limbus = EyeShading._intersectSpheres(S.radius, I.radius, gap);
    if (!limbus) return null;

    const anatomy = {
      axis,
      scleraCentre: S.centre,
      scleraRadius: S.radius,
      irisCentre: I.centre,
      irisRadius: I.radius,
      axisGap: gap,
      // Distance to the iris edge plane and the radius of that circle.
      limbusHeight: limbus.h,
      limbusCircle: limbus.rho,
      // The same circle seen as a polar angle from each sphere's own centre.
      limbusPolarSclera: Math.atan2(limbus.rho, limbus.h),
      limbusPolarIris: Math.atan2(limbus.rho, limbus.h - gap),
      // Fallback pupil size if there is no pupil mesh.
      pupilPolarIris: 0.42 * Math.atan2(limbus.rho, limbus.h - gap),
      pupilProtrusion: 0,
    };

    const P = parts.pupil ? EyeShading._sphereOf(parts.pupil) : null;
    if (P && P.radius > 1e-6) {
      const pupilGap = P.centre.clone().sub(I.centre).length();
      const margin = EyeShading._intersectSpheres(I.radius, P.radius, pupilGap);
      if (margin) {
        anatomy.pupilPolarIris = Math.atan2(margin.rho, margin.h);
        anatomy.pupilCentre = P.centre;
        anatomy.pupilRadius = P.radius;
        // How far the pupil sphere bulges past the iris; EyeSystem sinks it back by this much.
        anatomy.pupilProtrusion = (pupilGap + P.radius) - I.radius;
      }
    }

    anatomy.limbusSin = Math.sin(anatomy.limbusPolarIris);
    anatomy.pupilSin = Math.sin(anatomy.pupilPolarIris);
    return anatomy;
  }

  // Returns a child mesh's bounding sphere in the container's space.
  static _sphereOf(mesh) {
    if (!mesh || !mesh.geometry) return null;
    mesh.geometry.computeBoundingSphere();
    const bs = mesh.geometry.boundingSphere;
    if (!bs || !(bs.radius > 0)) return null;
    mesh.updateMatrix();
    const scale = new THREE.Vector3().setFromMatrixScale(mesh.matrix);
    return {
      centre: bs.center.clone().applyMatrix4(mesh.matrix),
      radius: bs.radius * (scale.x + scale.y + scale.z) / 3,
    };
  }

  // Returns the circle where two spheres meet.
  static _intersectSpheres(ra, rb, d) {
    if (!(d > 1e-6)) return null;
    const h = (d * d + ra * ra - rb * rb) / (2 * d);
    const r2 = ra * ra - h * h;
    if (!(r2 > 1e-9)) return null;
    return { h, rho: Math.sqrt(r2) };
  }

  // Converts a direction into a child mesh's local space.
  static _localDir(mesh, dir) {
    if (!mesh) return dir.clone();
    mesh.updateMatrix();
    const basis = new THREE.Matrix3().setFromMatrix4(mesh.matrix).invert();
    return dir.clone().applyMatrix3(basis).normalize();
  }

  // Converts a point into a child mesh's local space.
  static _localPoint(mesh, point) {
    if (!mesh) return point.clone();
    mesh.updateMatrix();
    return point.clone().applyMatrix4(mesh.matrix.clone().invert());
  }

  // Smoothstep between a and b.
  static _smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
    return t * t * (3 - 2 * t);
  }

  // ── Corneal shell geometry ───────────────────────────────────────────────

  // Builds the tear-film shell: a sphere over the sclera with a smaller corneal bulge at the front.
  static buildCorneaGeometry(anatomy, scleraMesh) {
    const axis = EyeShading._localDir(scleraMesh, anatomy.axis);
    const centre = EyeShading._localPoint(scleraMesh, anatomy.scleraCentre);
    const scale = new THREE.Vector3().setFromMatrixScale(scleraMesh.matrix);
    // Measurements are in container space, so undo the mesh's scale.
    const meshScale = (scale.x + scale.y + scale.z) / 3 || 1;
    const rs = anatomy.scleraRadius / meshScale;
    const rho = anatomy.limbusCircle / meshScale;
    const h = anatomy.limbusHeight / meshScale;
    const irisApex = (anatomy.axisGap + anatomy.irisRadius) / meshScale;

    // The bulge's peak: normal protrusion or just clear of the iris, whichever is further out.
    const apex = Math.max(EyeShading.CORNEA_PROTRUSION * rs,
      irisApex + EyeShading.CORNEA_CLEARANCE * rs);
    // Height of the bulge above the iris edge, which gives the cap's radius.
    const sag = Math.max(apex - h, 1e-4);
    const capRadius = (rho * rho + sag * sag) / (2 * sag);
    const capOffset = apex - capRadius;      // cap centre, along the axis
    const limbusPolar = Math.atan2(rho, h);  // measured from the sclera centre

    // Any frame around the gaze axis works, since the shell has no pattern.
    const T = new THREE.Vector3(1, 0, 0);
    if (Math.abs(axis.dot(T)) > 0.9) T.set(0, 1, 0);
    T.crossVectors(axis, T).normalize();
    const B = new THREE.Vector3().crossVectors(axis, T).normalize();
    const capCentre = axis.clone().multiplyScalar(capOffset);

    // More rings on the small, curved cap and fewer on the rest.
    const polars = [];
    const capRings = EyeShading.SHELL_CAP_RINGS;
    const ballRings = EyeShading.SHELL_BALL_RINGS;
    for (let i = 0; i <= capRings; i++) polars.push(limbusPolar * (i / capRings));
    for (let i = 1; i <= ballRings; i++) {
      polars.push(limbusPolar + (EyeShading.SHELL_BACK_POLAR - limbusPolar) * (i / ballRings));
    }

    const seg = EyeShading.SHELL_SEGMENTS;
    const rings = polars.length;
    const positions = new Float32Array(rings * (seg + 1) * 3);
    const normals = new Float32Array(rings * (seg + 1) * 3);
    const uvs = new Float32Array(rings * (seg + 1) * 2);
    const indices = [];
    const P = new THREE.Vector3();
    const N = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let outerRadius = 0;

    for (let r = 0; r < rings; r++) {
      const polar = polars[r];
      const cp = Math.cos(polar), sp = Math.sin(polar);
      // Distance from the centre to the shell at this angle: the cap inside the iris edge, the eyeball outside it.
      let t = rs;
      if (polar <= limbusPolar) {
        const tca = capOffset * cp;
        const thc2 = capRadius * capRadius - (capOffset * capOffset - tca * tca);
        t = tca + Math.sqrt(Math.max(thc2, 0));
      }
      t *= EyeShading.SHELL_LIFT;
      if (t > outerRadius) outerRadius = t;
      // Blend the normals across a narrow band so the edge stays crisp but smooth.
      const capWeight = 1 - EyeShading._smoothstep(limbusPolar - 0.05, limbusPolar + 0.05, polar);

      for (let s = 0; s <= seg; s++) {
        const phi = (s / seg) * Math.PI * 2;
        dir.copy(axis).multiplyScalar(cp)
          .addScaledVector(T, sp * Math.cos(phi))
          .addScaledVector(B, sp * Math.sin(phi));
        P.copy(dir).multiplyScalar(t);
        N.copy(P).sub(capCentre).normalize().multiplyScalar(capWeight)
          .addScaledVector(dir, 1 - capWeight).normalize();

        const vi = r * (seg + 1) + s;
        positions[vi * 3] = P.x; positions[vi * 3 + 1] = P.y; positions[vi * 3 + 2] = P.z;
        normals[vi * 3] = N.x; normals[vi * 3 + 1] = N.y; normals[vi * 3 + 2] = N.z;
        uvs[vi * 2] = s / seg;
        uvs[vi * 2 + 1] = 1 - r / (rings - 1);
      }
    }

    for (let r = 0; r < rings - 1; r++) {
      for (let s = 0; s < seg; s++) {
        const a = r * (seg + 1) + s;
        const c = (r + 1) * (seg + 1) + s;
        // Skip the zero-area triangle at the very tip.
        if (r > 0) indices.push(a, c, a + 1);
        indices.push(a + 1, c, c + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    // The probe scripts read a radius off the shell, so keep that field.
    geo.parameters = { radius: outerRadius, limbusPolar, capRadius };
    return { geometry: geo, centre, limbusPolar, outerRadius };
  }

  // ── Melanin ──────────────────────────────────────────────────────────────

  // How much pigment the chosen iris colour implies (0-1), so blue irises show more structure than brown ones.
  static melaninFor(color) {
    // Judge the colour in sRGB, since linear values made dark brown look less pigmented than hazel.
    const hsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(color).getHSL(hsl, THREE.SRGBColorSpace);

    // Amber and brown sit near hue 0.08; distance from there means less pigment.
    const AMBER = 0.08, SPAN = 0.20;
    let dist = Math.abs(hsl.h - AMBER);
    if (dist > 0.5) dist = 1 - dist;
    const warmth = Math.max(0, 1 - dist / SPAN) * Math.min(1, hsl.s * 2);

    // Hue says which pigment, lightness says how much.
    return Math.min(1, Math.max(0, warmth * 0.5 + (1 - hsl.l) * 0.5));
  }

  // Shader plumbing

  // Returns the shared set of shader uniforms for an eye material.
  static _uniforms() {
    return {
      uEyeAxis: { value: new THREE.Vector3(0, 1, 0) },
      uLimbusSin: { value: 0.703 },
      uPupilSin: { value: 0.291 },
      uLimbusPolar: { value: 0.344 },
      uParallax: { value: EyeShading.PARALLAX },
      uIrisMelanin: { value: 0.6 },
      uIrisDetail: { value: EyeShading._blank() },
      uIrisNormal: { value: EyeShading._blankNormal() },
      uScleraDetail: { value: EyeShading._blank() },
      uIrisPupilBaked: { value: 0.42 },
      uScleraPolarSpan: { value: 1.65 },
      // Zero until the maps are built, so the eye still renders if they aren't available.
      uTexAmount: { value: 0.0 },
    };
  }

  // A 1x1 mid-grey placeholder texture, so the sampler is always bound.
  static _blank() {
    if (!EyeShading._blankTex) {
      EyeShading._blankTex = new THREE.DataTexture(
        new Uint8Array([128, 128, 128, 255]), 1, 1);
      EyeShading._blankTex.needsUpdate = true;
    }
    return EyeShading._blankTex;
  }

  // A flat placeholder normal map.
  static _blankNormal() {
    if (!EyeShading._blankNrm) {
      EyeShading._blankNrm = new THREE.DataTexture(
        new Uint8Array([128, 128, 255, 255]), 1, 1);
      EyeShading._blankNrm.needsUpdate = true;
    }
    return EyeShading._blankNrm;
  }

  // Binds the baked iris and sclera maps, building them on first use.
  static setMaps(material) {
    const store = material && material.userData && material.userData.eyeShading;
    if (!store || typeof EyeTextures === 'undefined') return false;
    let maps;
    try {
      maps = EyeTextures.maps();
    } catch (err) {
      console.warn('[EyeShading] Eye maps could not be built; shading stays untextured', err);
      return false;
    }
    const u = store.uniforms;
    u.uIrisDetail.value = maps.irisDetail;
    u.uIrisNormal.value = maps.irisNormal;
    u.uScleraDetail.value = maps.scleraDetail;
    u.uIrisPupilBaked.value = EyeTextures.IRIS_PUPIL_FRACTION;
    u.uScleraPolarSpan.value = EyeTextures.SCLERA_POLAR_SPAN;
    u.uTexAmount.value = 1.0;
    return true;
  }

  // Shader helper that builds the eyeball's frame.
  static _helpers() {
    return [
      // The eye frame: the gaze axis turns with the head, and world up keeps the iris upright.
      'void eyeFrame( in vec3 A, out vec3 U, out vec3 R ) {',
      '  vec3 worldUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );',
      '  vec3 u = worldUp - A * dot( worldUp, A );',
      '  float len = length( u );',
      '  if ( len < 1.0e-3 ) { u = cross( A, vec3( 1.0, 0.0, 0.0 ) ); len = length( u ); }',
      '  U = u / max( len, 1.0e-6 );',
      '  R = cross( U, A );',
      '}',
    ].join('\n');
  }

  // Passes the gaze axis to the fragment shader.
  static _vertexPatch(shader) {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [
        '#include <common>',
        'uniform vec3 uEyeAxis;',
        'varying vec3 vEyeAxisView;',
      ].join('\n'))
      .replace('#include <project_vertex>', [
        '#include <project_vertex>',
        'vEyeAxisView = normalize( normalMatrix * uEyeAxis );',
      ].join('\n'));
  }

  // Adds the shared uniform and varying declarations to the fragment shader.
  static _fragmentPars(shader) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', [
      '#include <common>',
      'varying vec3 vEyeAxisView;',
      'uniform float uLimbusSin;',
      'uniform float uPupilSin;',
      'uniform float uLimbusPolar;',
      'uniform float uParallax;',
      'uniform float uIrisMelanin;',
      'uniform sampler2D uIrisDetail;',
      'uniform sampler2D uIrisNormal;',
      'uniform sampler2D uScleraDetail;',
      'uniform float uIrisPupilBaked;',
      'uniform float uScleraPolarSpan;',
      'uniform float uTexAmount;',
      EyeShading._helpers(),
    ].join('\n'));
  }

  // Attaches eye shading to a material once, chaining any existing onBeforeCompile.
  static _attach(material, key, build) {
    if (!material || material.userData.eyeShading) return material;
    const uniforms = EyeShading._uniforms();
    material.userData.eyeShading = { uniforms };
    // Chain onto the existing onBeforeCompile instead of replacing it.
    const prior = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
      if (typeof prior === 'function') prior.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      EyeShading._vertexPatch(shader);
      EyeShading._fragmentPars(shader);
      build(shader);
    };
    material.customProgramCacheKey = () => key;
    material.needsUpdate = true;
    return material;
  }

  // Copies measured anatomy into a material's uniforms.
  static setAnatomy(material, anatomy, mesh) {
    const store = material && material.userData && material.userData.eyeShading;
    if (!store || !anatomy) return;
    const u = store.uniforms;
    u.uEyeAxis.value.copy(EyeShading._localDir(mesh, anatomy.axis));
    u.uLimbusSin.value = anatomy.limbusSin;
    u.uPupilSin.value = anatomy.pupilSin;
    // The sclera and shell measure the iris edge from the eyeball centre; the iris uses its own.
    u.uLimbusPolar.value = anatomy.limbusPolarSclera;
  }

  // Sets the pigment level from the iris colour.
  static setMelanin(material, color) {
    const store = material && material.userData && material.userData.eyeShading;
    if (store) store.uniforms.uIrisMelanin.value = EyeShading.melaninFor(color);
  }

  // ── Iris ─────────────────────────────────────────────────────────────────

  // Shades the iris from the baked maps, plus the pupil, limbal ring and light scattering, keyed to its own sphere rather than the mesh UVs.
  static attachIris(material) {
    return EyeShading._attach(material, 'eye-iris', (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          // Declared outside the block because later shader chunks read these.
          'float eyePupilMask = 0.0;',
          'float eyeIrisStructure = 0.0;',
          'vec2 eyeIrisUV = vec2( 0.5 );',
          'vec3 eyeIrisTangent = vec3( 1.0, 0.0, 0.0 );',
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 A = normalize( vEyeAxisView );',
          '  vec3 U, R;',
          '  eyeFrame( A, U, R );',
          '  vec3 N = normalize( vNormal );',
          '  vec3 V = normalize( vViewPosition );',
          '  float limbusSin = max( uLimbusSin, 1.0e-4 );',
          '  eyeIrisTangent = R;',
          '',
          // Position on the iris disc: 1 at the edge, 0 at the centre.
          '  vec2 disc = vec2( dot( N, R ), dot( N, U ) ) / limbusSin;',
          '  float rGeo = length( disc );',
          '',
          // Corneal refraction: shift and magnify the iris toward the viewer so the eye looks wet from an angle.
          '  vec2 tanV = vec2( dot( V, R ), dot( V, U ) ) / max( dot( V, A ), 0.20 );',
          '  vec2 uv = ( disc - clamp( tanV, vec2( -2.5 ), vec2( 2.5 ) ) * uParallax ) * ' +
          EyeShading.CORNEA_MAGNIFY.toFixed(4) + ';',
          '  float rr = length( uv );',
          '  float ang = atan( uv.y, uv.x );',
          '',
          '  float pupilFrac = clamp( uPupilSin / limbusSin, 0.10, 0.85 );',
          '  float mel = uIrisMelanin;',
          // Pigment hides colour variation but not the crypts and folds, so structure stays partly visible on dark irises.
          '  eyeIrisStructure = mix( 1.0, 0.62, mel ) * uTexAmount;',
          '',
          // Rescale into the baked map, which was drawn at a fixed pupil size.
          '  float rBaked = uIrisPupilBaked',
          '    + ( rr - pupilFrac ) * ( 1.0 - uIrisPupilBaked ) / max( 1.0 - pupilFrac, 0.05 );',
          '  eyeIrisUV = uv * ( rr > 1.0e-3 ? clamp( rBaked / rr, 0.25, 4.0 ) : 1.0 ) * 0.5 + 0.5;',
          '  vec4 det = texture2D( uIrisDetail, eyeIrisUV );',
          // Stored as a change around 1.0, packed into 0-2.
          '  vec3 tint = mix( vec3( 1.0 ), det.rgb * 2.0, eyeIrisStructure );',
          '  float ao = mix( 1.0, det.a, eyeIrisStructure );',
          '',
          '  vec3 c = diffuseColor.rgb;',
          // Across the iris ring: 0 at the pupil edge, 1 at the outer edge.
          '  float t = clamp( ( rr - pupilFrac ) / max( 1.0 - pupilFrac, 0.05 ), 0.0, 1.0 );',
          '',
          // The inner zone is a little darker, with the collarette as the boundary, not a wide fade.
          '  c *= mix( 0.78, 1.16, smoothstep( 0.02, 0.34, t ) );',
          '  c = mix( c, c * vec3( 1.12, 0.86, 0.62 ),',
          '    ( 1.0 - smoothstep( 0.0, 0.30, t ) ) * mix( 0.26, 0.46, mel ) );',
          '',
          // Apply the baked detail and its cavity darkening.
          '  c *= tint;',
          '  c *= mix( 1.0, ao, 0.85 );',
          '',
          // Scallop the pupil edge; whole-number frequencies avoid a seam where the angle wraps.
          '  float crenel = 0.008 * sin( ang * 29.0 + 0.4 ) + 0.006 * sin( ang * 41.0 - 1.9 )',
          '    + 0.005 * sin( ang * 11.0 + 2.2 );',
          '  float pupilR = pupilFrac * ( 1.0 + crenel );',
          '  eyePupilMask = 1.0 - smoothstep( pupilR - 0.014, pupilR + 0.010, rr );',
          // The pupil is near-black but lifts slightly toward the edge, so it looks like a hole, not paint.
          '  vec3 pupil = vec3( 0.0035, 0.0032, 0.0036 ) + vec3( 0.030, 0.017, 0.011 )',
          '    * smoothstep( pupilR * 0.35, pupilR, rr ) * mix( 1.0, 0.45, mel );',
          '  c = mix( c, pupil, eyePupilMask );',
          '',
          // A sharp blue-grey limbal ring on the real iris edge, so it doesn't slide at an angle.
          '  float limbal = smoothstep( 0.90, 1.01, rGeo );',
          '  c *= 1.0 - limbal * 0.66;',
          '  c = mix( c, c * vec3( 0.82, 0.90, 1.06 ), limbal * 0.55 );',
          '',
          '#if NUM_DIR_LIGHTS > 0',
          '  {',
          // Light scatters back out of the iris opposite the catchlight, less so for dark irises.
          '    vec2 lt = vec2( dot( directionalLights[ 0 ].direction, R ),',
          '                    dot( directionalLights[ 0 ].direction, U ) );',
          '    float ll = length( lt );',
          '    if ( ll > 1.0e-4 ) {',
          '      float glow = clamp( dot( normalize( uv + 1.0e-5 ), - lt / ll ), 0.0, 1.0 );',
          '      glow = pow( glow, 1.7 ) * ll * smoothstep( pupilR, 1.0, rr )',
          '        * ( 1.0 - smoothstep( 0.86, 1.0, rGeo ) ) * ( 1.0 - eyePupilMask );',
          '      c += c * glow * mix( 0.85, 0.30, mel );',
          '    }',
          '  }',
          '#endif',
          '',
          '  diffuseColor.rgb = c;',
          '}',
          '#endif',
        ].join('\n'))
        // Relief: turn the baked height map into normals using the eye frame, not the mesh UVs.
        .replace('#include <normal_fragment_maps>', [
          '#include <normal_fragment_maps>',
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 relief = texture2D( uIrisNormal, eyeIrisUV ).xyz * 2.0 - 1.0;',
          // Pigment flattens the relief, and the pupil has none.
          '  relief.xy *= eyeIrisStructure * ( 1.0 - eyePupilMask );',
          '  vec3 T = eyeIrisTangent - normal * dot( eyeIrisTangent, normal );',
          '  float tl = length( T );',
          '  if ( tl > 1.0e-4 ) {',
          '    T /= tl;',
          '    normal = normalize( T * relief.x + cross( normal, T ) * relief.y',
          '      + normal * max( relief.z, 0.15 ) );',
          '  }',
          '}',
          '#endif',
        ].join('\n'))
        // The pupil is a hole, so make it fully rough and free of highlights.
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          'roughnessFactor = mix( roughnessFactor, 1.0, eyePupilMask );',
        ].join('\n'));
    });
  }

  // ── Sclera ───────────────────────────────────────────────────────────────

  // Shades the sclera: socket shadow, blood vessels, a limbal band and a warm cast, keyed to world up and the gaze axis.
  static attachSclera(material) {
    return EyeShading._attach(material, 'eye-sclera', (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 A = normalize( vEyeAxisView );',
          '  vec3 U, R;',
          '  eyeFrame( A, U, R );',
          '  vec3 N = normalize( vNormal );',
          '  vec3 V = normalize( vViewPosition );',
          '  vec3 worldUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );',
          '',
          '  float polar = acos( clamp( dot( N, A ), -1.0, 1.0 ) );',
          '  vec2 pl = vec2( dot( N, R ), dot( N, U ) );',
          '  vec3 c = diffuseColor.rgb;',
          '',
          // The eye sits in a socket, so darken the upper half using world up; lit sclera ends up about 85% as bright as skin.
          '  c *= mix( 0.72, 0.16, smoothstep( -0.45, 0.75, dot( N, worldUp ) ) );',
          '',
          // Darken where the eyeball curves away into the lids.
          '  c *= mix( 1.0, 0.42, smoothstep( 0.34, 0.95, 1.0 - abs( dot( N, V ) ) ) );',
          // Past the visible part the eyeball turns into the socket.
          '  c *= mix( 1.0, 0.30, smoothstep( uLimbusPolar + 0.55, uLimbusPolar + 1.30, polar ) );',
          '',
          // Blood vessels from the baked map, laid out by angle from the front of the eye.
          '  float plLen = length( pl );',
          '  vec2 scleraUV = plLen > 1.0e-4',
          '    ? ( pl / plLen ) * ( polar / max( uScleraPolarSpan, 0.1 ) ) * 0.5 + 0.5',
          '    : vec2( 0.5 );',
          '  vec3 bed = mix( vec3( 1.0 ), texture2D( uScleraDetail, scleraUV ).rgb, uTexAmount );',
          '  float exposed = smoothstep( uLimbusPolar + 0.02, uLimbusPolar + 0.26, polar )',
          '    * ( 1.0 - smoothstep( uLimbusPolar + 0.95, uLimbusPolar + 1.50, polar ) );',
          // More vessels along the opening between the lids, where they can be seen.
          '  float fissure = mix( 0.30, 1.0, 1.0 - smoothstep( 0.18, 0.72, abs( pl.y ) ) );',
          '  c *= mix( vec3( 1.0 ), bed, exposed * 0.95 );',
          '',
          // A faint warm wash under the vessels.
          '  c = mix( c, c * vec3( 1.06, 0.86, 0.80 ), exposed * fissure * 0.45 );',
          '',
          // A warm cast over the whole sclera so it never looks grey or plastic next to the skin.
          '  c *= mix( vec3( 1.0 ), vec3( 1.04, 0.94, 0.86 ),',
          '    smoothstep( uLimbusPolar, uLimbusPolar + 0.60, polar ) );',
          '',
          // The blue-grey band where the sclera thins into the cornea.
          '  c = mix( c, c * vec3( 0.74, 0.80, 0.90 ),',
          '    exp( - pow( ( polar - uLimbusPolar ) * 12.0, 2.0 ) ) * 0.50 );',
          '',
          '  diffuseColor.rgb = c;',
          '}',
          '#endif',
        ].join('\n'));
    });
  }

  // ── Cornea ───────────────────────────────────────────────────────────────

  // Shades the tear film: glassy over the cornea, a thin sheen over the sclera, dry under the lids.
  static attachCornea(material) {
    return EyeShading._attach(material, 'eye-cornea', (shader) => {
      // Use the fragment's position, not its normal, to find where it sits on the ball.
      shader.vertexShader = shader.vertexShader
        .replace('varying vec3 vEyeAxisView;', [
          'varying vec3 vEyeAxisView;',
          'varying vec3 vEyeRadialView;',
        ].join('\n'))
        .replace('vEyeAxisView = normalize( normalMatrix * uEyeAxis );', [
          'vEyeAxisView = normalize( normalMatrix * uEyeAxis );',
          'vEyeRadialView = normalize( normalMatrix * transformed );',
        ].join('\n'));

      shader.fragmentShader = shader.fragmentShader
        .replace('varying vec3 vEyeAxisView;', [
          'varying vec3 vEyeAxisView;',
          'varying vec3 vEyeRadialView;',
        ].join('\n'))
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          'float eyeCorneaCap = 1.0;',
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 A = normalize( vEyeAxisView );',
          '  vec3 D = normalize( vEyeRadialView );',
          '  vec3 N = normalize( vNormal );',
          '  vec3 V = normalize( vViewPosition );',
          '  float polar = acos( clamp( dot( D, A ), -1.0, 1.0 ) );',
          '',
          // The glass ends at the iris edge.
          '  eyeCorneaCap = 1.0 - smoothstep( uLimbusPolar - 0.12, uLimbusPolar + 0.04, polar );',
          // Only the cornea is glass; the sclera gets a faint sheen so it doesn't look like a glass bead.
          '  float wet = mix( 0.07, 1.0, eyeCorneaCap );',
          // A thin bright line where tears pool at the iris edge.
          '  wet += exp( - pow( ( polar - uLimbusPolar ) * 16.0, 2.0 ) ) * 0.12;',
          // Only a light Fresnel boost, or the catchlight disappears.
          '  float fresnel = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 4.0 ) * 0.8;',
          '  wet *= 1.0 + fresnel * mix( 0.15, 1.0, eyeCorneaCap );',
          // The lids cover the top of the eyeball, so nothing there is wet.
          '  wet *= mix( 1.0, 0.35, smoothstep( 0.25, 0.85,',
          '    dot( D, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) ) ) );',
          '',
          '  diffuseColor.rgb *= wet;',
          '}',
          '#endif',
        ].join('\n'))
        // Keep the sclera film nearly as smooth as the cornea and control wetness by strength instead.
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          'roughnessFactor = clamp( roughnessFactor * mix( 1.5, 0.62, eyeCorneaCap ), 0.02, 1.0 );',
        ].join('\n'));
    });
  }
}

window.EyeShading = EyeShading;
