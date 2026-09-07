/**
 * EyeShading.js — anatomy-driven iris, sclera and cornea shading.
 *
 * A face is read at the eyes first, so a flat eye sinks an otherwise good
 * head. This module supplies the three things a rendered eye needs and a
 * plain coloured sphere cannot have:
 *
 *  1. Structure. A real iris is not a tinted disc. It has a pupillary zone
 *     and a ciliary zone divided by a ragged collarette, radial trabeculae,
 *     crypts, contraction furrows, a pigment ruff at the pupil margin and a
 *     limbal ring. A sclera is not white: it is a warm grey with episcleral
 *     vessels running along the palpebral fissure and a blue-grey band where
 *     it thins into the cornea.
 *
 *  2. An anchor. Everything is keyed to the eyeball's own gaze axis and to
 *     world up, never to the camera. The shading this replaces parameterised
 *     the iris off dot(N, V), which is a normalised radius only while the eye
 *     faces the lens: as soon as the head turned, the limbal ring, the fibres
 *     and the collarette slid across the eyeball and stayed pointed at the
 *     viewer. On a tool whose whole purpose is turning the head, that is the
 *     defect you notice without being able to name it.
 *
 *  3. A cornea with a shape. A real eyeball is not a sphere — it is a sphere
 *     with a smaller-radius corneal cap grafted onto the front, protruding
 *     about a tenth of the radius past the sclera. That bulge is what makes
 *     the eye read as an eye in profile and three-quarter, and it is where
 *     the catchlight and the wet sheen belong. See buildCorneaGeometry().
 *
 * All of the measurements come from the eye meshes themselves, so this works
 * on the GLB eyes and on the procedural fallback without either being
 * hard-coded here.
 *
 * The division of labour with EyeTextures: this file owns tone and anything
 * that has to react to something measured or chosen — the zone gradient,
 * which depends on melanin; the pupil, which depends on the aperture the
 * anatomy reports; the limbal ring, which has to stay welded to the geometry.
 * EyeTextures owns fine structure, because a fragment shader cannot mipmap
 * its own noise and cannot draw a few hundred individual fibres. Running the
 * same feature in both places compounds it, which is worth remembering: the
 * pupillary-zone gradient was briefly in both, and the two together made a
 * near-black collar around the pupil that no eye has.
 */
class EyeShading {
  /** How far the iris slides under the cornea, per unit tan(view angle).
   *
   * The iris sits behind the cornea and the aqueous humour, so off-axis it is
   * displaced toward the viewer — the strongest single cue that there is a
   * wet lens over it rather than a painted disc. Physically this would be
   * (chamber depth / iris radius / n) ≈ 0.44; the eye asset's iris dome sits
   * almost against its own cornea, so the honest figure slides the pattern
   * further than the geometry can justify and reads as a wobble. */
  static get PARALLAX() { return 0.115; }

  /** Corneal magnification. The cornea is a positive lens, so the iris and
   *  pupil behind it look about 8% larger than they are. */
  static get CORNEA_MAGNIFY() { return 0.93; }

  /** Apex of the corneal cap, as a multiple of the scleral radius. A human
   *  eye measures 1.09; the extra hundredth guarantees the cap clears the
   *  asset's iris dome, which is far steeper than a real iris. */
  static get CORNEA_PROTRUSION() { return 1.105; }

  /** Least gap between corneal cap and iris dome, as a fraction of the
   *  scleral radius, when PROTRUSION alone would not clear it. */
  static get CORNEA_CLEARANCE() { return 0.025; }

  /** How far the tear-film shell floats off the eyeball: enough to avoid
   *  z-fighting with the sclera and iris, small enough not to read as a gap. */
  static get SHELL_LIFT() { return 1.006; }

  /** Shell tessellation. The cap is the part anyone looks at, so it gets more
   *  rings than the far larger scleral remainder. */
  static get SHELL_CAP_RINGS() { return 20; }
  static get SHELL_BALL_RINGS() { return 26; }
  static get SHELL_SEGMENTS() { return 72; }

  /** The back of the ball is inside the head; stop short of the pole rather
   *  than pay for rings nothing can see. */
  static get SHELL_BACK_POLAR() { return 2.75; }

  // ── Anatomy ──────────────────────────────────────────────────────────────

  /**
   * Derive an eyeball's anatomy from its own meshes.
   *
   * The three parts are spheres, so every landmark falls out of sphere
   * intersections: the limbus is the circle where the iris meets the sclera,
   * and the pupil margin is the circle where the pupil meets the iris.
   * Returns container-space positions plus space-independent angles, or null
   * if the meshes are not the spheres this assumes.
   */
  static measureAnatomy(parts) {
    const S = EyeShading._sphereOf(parts.sclera);
    const I = EyeShading._sphereOf(parts.iris);
    if (!S || !I) return null;

    /* The gaze axis is the one direction the meshes agree on: sclera centre
       to iris centre. Deriving it beats assuming the GLB's own +Y, which is
       an authoring accident and would silently point the wrong way the first
       time somebody re-exports the asset from a different scene. */
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
      // Distance along the axis from the sclera centre to the limbus plane,
      // and the radius of the limbus circle itself.
      limbusHeight: limbus.h,
      limbusCircle: limbus.rho,
      // The same circle seen as a polar angle from each sphere's own centre.
      limbusPolarSclera: Math.atan2(limbus.rho, limbus.h),
      limbusPolarIris: Math.atan2(limbus.rho, limbus.h - gap),
      // Stand-in if there is no pupil mesh: a pupil a little under half the
      // iris, which is a normal indoor aperture.
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
        /* How far the pupil sphere pokes past the iris surface. Positive
           means it bulges out of the iris as a black bead instead of reading
           as a hole, which is what the asset does; EyeSystem recesses it by
           this much. */
        anatomy.pupilProtrusion = (pupilGap + P.radius) - I.radius;
      }
    }

    anatomy.limbusSin = Math.sin(anatomy.limbusPolarIris);
    anatomy.pupilSin = Math.sin(anatomy.pupilPolarIris);
    return anatomy;
  }

  /** Bounding sphere of a container child, in the container's space. */
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

  /**
   * Circle where two spheres meet, from both radii and the distance between
   * their centres. `h` runs along the centre-to-centre axis from the first
   * sphere; `rho` is the circle's radius.
   */
  static _intersectSpheres(ra, rb, d) {
    if (!(d > 1e-6)) return null;
    const h = (d * d + ra * ra - rb * rb) / (2 * d);
    const r2 = ra * ra - h * h;
    if (!(r2 > 1e-9)) return null;
    return { h, rho: Math.sqrt(r2) };
  }

  /** A direction expressed in one container child's own local space. */
  static _localDir(mesh, dir) {
    if (!mesh) return dir.clone();
    mesh.updateMatrix();
    const basis = new THREE.Matrix3().setFromMatrix4(mesh.matrix).invert();
    return dir.clone().applyMatrix3(basis).normalize();
  }

  /** A container-space point expressed in one container child's local space. */
  static _localPoint(mesh, point) {
    if (!mesh) return point.clone();
    mesh.updateMatrix();
    return point.clone().applyMatrix4(mesh.matrix.clone().invert());
  }

  static _smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
    return t * t * (3 - 2 * t);
  }

  // ── Corneal shell geometry ───────────────────────────────────────────────

  /**
   * Build the tear-film shell: a sphere over the sclera with a
   * smaller-radius corneal cap grafted on at the limbus.
   *
   * The shell this replaces was a plain sphere at 1.02× the scleral radius,
   * which is the wrong shape twice over. A real eyeball is not spherical —
   * the cornea protrudes about a tenth of the radius past the sclera, and
   * that bump is most of what identifies an eye in three-quarter view. And
   * because the asset's iris dome already reaches 1.08× the scleral radius, a
   * 1.02× sphere passed *underneath* the iris: the shell that exists to carry
   * the catchlight did not cover the one part of the eye anybody looks at.
   *
   * Built in the sclera mesh's own local space, since the shell is parented
   * there and inherits its transform.
   */
  static buildCorneaGeometry(anatomy, scleraMesh) {
    const axis = EyeShading._localDir(scleraMesh, anatomy.axis);
    const centre = EyeShading._localPoint(scleraMesh, anatomy.scleraCentre);
    const scale = new THREE.Vector3().setFromMatrixScale(scleraMesh.matrix);
    // The measurements are in container space; the shell is built in the
    // sclera node's, so undo the node scale they were taken through.
    const meshScale = (scale.x + scale.y + scale.z) / 3 || 1;
    const rs = anatomy.scleraRadius / meshScale;
    const rho = anatomy.limbusCircle / meshScale;
    const h = anatomy.limbusHeight / meshScale;
    const irisApex = (anatomy.axisGap + anatomy.irisRadius) / meshScale;

    // Apex of the cap: the anatomical protrusion, or just clear of the iris
    // dome, whichever reaches further out.
    const apex = Math.max(EyeShading.CORNEA_PROTRUSION * rs,
      irisApex + EyeShading.CORNEA_CLEARANCE * rs);
    // Sagitta above the limbus plane, and hence the cap's radius: the unique
    // sphere through the limbus circle whose pole is the apex.
    const sag = Math.max(apex - h, 1e-4);
    const capRadius = (rho * rho + sag * sag) / (2 * sag);
    const capOffset = apex - capRadius;      // cap centre, along the axis
    const limbusPolar = Math.atan2(rho, h);  // measured from the sclera centre

    // Any frame about the gaze axis will do; the shell carries no pattern
    // that a roll about that axis could disturb.
    const T = new THREE.Vector3(1, 0, 0);
    if (Math.abs(axis.dot(T)) > 0.9) T.set(0, 1, 0);
    T.crossVectors(axis, T).normalize();
    const B = new THREE.Vector3().crossVectors(axis, T).normalize();
    const capCentre = axis.clone().multiplyScalar(capOffset);

    // Rings clustered on the cap, which is small, sharply curved and the only
    // part under scrutiny; the scleral remainder takes the rest.
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
      /* Distance from the sclera centre out to the shell along this
         direction. Inside the limbus that is the far root of the ray against
         the cap sphere; outside it, the scleral sphere. The surface is
         star-shaped about the sclera centre, so one radius per polar angle
         describes it completely. */
      let t = rs;
      if (polar <= limbusPolar) {
        const tca = capOffset * cp;
        const thc2 = capRadius * capRadius - (capOffset * capOffset - tca * tca);
        t = tca + Math.sqrt(Math.max(thc2, 0));
      }
      t *= EyeShading.SHELL_LIFT;
      if (t > outerRadius) outerRadius = t;
      // Normals are radial from whichever sphere the point sits on, blended
      // across a narrow band so the limbal crease stays tight but unfaceted.
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
        // Ring 0 collapses onto the apex, so its inner triangle is
        // degenerate; skip it rather than ship zero-area faces.
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
    /* The diagnostics read geometry.parameters.radius off the shell, which a
       SphereGeometry carries and a hand-built BufferGeometry does not.
       Cheaper to keep the contract than to fork three probe scripts. */
    geo.parameters = { radius: outerRadius, limbusPolar, capRadius };
    return { geometry: geo, centre, limbusPolar, outerRadius };
  }

  // ── Melanin ──────────────────────────────────────────────────────────────

  /**
   * How much anterior pigment the chosen iris colour implies, 0..1.
   *
   * Not decoration. A blue iris has no pigment in front of the stroma, so
   * every fibre, crypt and furrow reads at full contrast and the eye looks
   * structured; a dark brown one buries the same structures under melanin and
   * shows mostly sheen. Driving the structure amount from the colour is what
   * stops the palette producing one texture in five hues, which is the tell
   * that an iris is a decal.
   */
  static melaninFor(color) {
    /* Read the colour back in sRGB, not in the linear working space.
     *
     * Melanin here is a judgement about the colour an operator picked off a
     * swatch, and the linear values are the wrong basis for it: gamma crushes
     * dark colours, so a dark brown's channel spread collapses toward zero
     * and it scored as *less* pigmented than a mid hazel — the exact
     * inversion of the thing being measured. Hue and lightness in sRGB rank
     * the swatches the way an eye does. */
    const hsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(color).getHSL(hsl, THREE.SRGBColorSpace);

    // Amber and brown sit around hue 0.08; how far a colour is from there,
    // the short way round the wheel, is how unpigmented it reads.
    const AMBER = 0.08, SPAN = 0.20;
    let dist = Math.abs(hsl.h - AMBER);
    if (dist > 0.5) dist = 1 - dist;
    const warmth = Math.max(0, 1 - dist / SPAN) * Math.min(1, hsl.s * 2);

    // Both halves matter: hue says which pigment, lightness says how much.
    return Math.min(1, Math.max(0, warmth * 0.5 + (1 - hsl.l) * 0.5));
  }

  // ── Shader plumbing ──────────────────────────────────────────────────────

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
      // Zero until the maps are actually built, so an eye still renders — flat
      // but correct — if the canvas they are painted on is unavailable.
      uTexAmount: { value: 0.0 },
    };
  }

  /** A 1×1 mid-grey stand-in: with uTexAmount at 0 nothing reads it, but the
   *  sampler must still be bound to something. Mid-grey because the detail
   *  map is a modulation scaled by two, so 0.5 means "unchanged". */
  static _blank() {
    if (!EyeShading._blankTex) {
      EyeShading._blankTex = new THREE.DataTexture(
        new Uint8Array([128, 128, 128, 255]), 1, 1);
      EyeShading._blankTex.needsUpdate = true;
    }
    return EyeShading._blankTex;
  }

  /** The same for the normal map, where "unchanged" is +Z. */
  static _blankNormal() {
    if (!EyeShading._blankNrm) {
      EyeShading._blankNrm = new THREE.DataTexture(
        new Uint8Array([128, 128, 255, 255]), 1, 1);
      EyeShading._blankNrm.needsUpdate = true;
    }
    return EyeShading._blankNrm;
  }

  /**
   * Bind the baked iris and sclera maps.
   *
   * Building them is a couple of hundred milliseconds of main-thread canvas
   * work, so it happens here — on the first eye generation — rather than in a
   * constructor, and EyeTextures caches the result for every eye after.
   */
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

  /** The eyeball's own frame. Everything else the shading needs is baked. */
  static _helpers() {
    return [
      /* The eyeball's own frame, in view space.
       *
       * A is the gaze axis carried through from object space, so it turns
       * with the head. The other two axes come from world up, which keeps the
       * palpebral fissure horizontal and the iris upright wherever the camera
       * orbits to. Both halves are needed: an object-space frame alone cannot
       * say which way is up on a sphere the asset authored arbitrarily, and a
       * view-space frame alone slides with the camera. */
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

  /** Carry the gaze axis into view space; every shader below needs it. */
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

  static _attach(material, key, build) {
    if (!material || material.userData.eyeShading) return material;
    const uniforms = EyeShading._uniforms();
    material.userData.eyeShading = { uniforms };
    /* Chain rather than replace: onBeforeCompile is a single slot, and
       assigning it outright silently discards whatever a caller installed
       first. */
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

  /** Push measured anatomy into a material's uniforms. */
  static setAnatomy(material, anatomy, mesh) {
    const store = material && material.userData && material.userData.eyeShading;
    if (!store || !anatomy) return;
    const u = store.uniforms;
    u.uEyeAxis.value.copy(EyeShading._localDir(mesh, anatomy.axis));
    u.uLimbusSin.value = anatomy.limbusSin;
    u.uPupilSin.value = anatomy.pupilSin;
    /* The sclera and the shell measure the limbus from the eyeball's centre;
       the iris measures the same circle from its own centre and reads
       uLimbusSin for it instead. */
    u.uLimbusPolar.value = anatomy.limbusPolarSclera;
  }

  static setMelanin(material, color) {
    const store = material && material.userData && material.userData.eyeShading;
    if (store) store.uniforms.uIrisMelanin.value = EyeShading.melaninFor(color);
  }

  // ── Iris ─────────────────────────────────────────────────────────────────

  /**
   * The iris: two zones, a ragged collarette between them, radial trabeculae,
   * crypts, contraction furrows, a pigment ruff at the pupil margin, a limbal
   * ring, and the pupil itself.
   *
   * The iris mesh is a sphere about its own centre, so its normal *is* the
   * direction from that centre: the polar angle off the gaze axis is a
   * normalised radius and the azimuth is the angle around it. That is the
   * whole coordinate system, and unlike the mesh's own UVs — a Blender UV
   * sphere, pinched at a pole that does not sit where the pupil does — it
   * carries a radial pattern without a seam.
   */
  static attachIris(material) {
    return EyeShading._attach(material, 'eye-iris', (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <color_fragment>', [
          '#include <color_fragment>',
          // Held outside the block: <roughnessmap_fragment> and
          // <normal_fragment_maps> both run later and both read these.
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
          // Position on the iris disc: 1.0 at the limbus, 0 at the axis.
          '  vec2 disc = vec2( dot( N, R ), dot( N, U ) ) / limbusSin;',
          '  float rGeo = length( disc );',
          '',
          /* Corneal refraction. Everything inside the limbus is seen through
             the cornea and the aqueous humour, so it is displaced toward the
             viewer by roughly depth * tan(angle) and magnified by the same
             lens. This is what makes an eye read as wet from off-axis; a
             pattern painted flat on the surface tracks the geometry exactly
             and looks like a printed contact lens. */
          '  vec2 tanV = vec2( dot( V, R ), dot( V, U ) ) / max( dot( V, A ), 0.20 );',
          '  vec2 uv = ( disc - clamp( tanV, vec2( -2.5 ), vec2( 2.5 ) ) * uParallax ) * ' +
          EyeShading.CORNEA_MAGNIFY.toFixed(4) + ';',
          '  float rr = length( uv );',
          '  float ang = atan( uv.y, uv.x );',
          '',
          '  float pupilFrac = clamp( uPupilSin / limbusSin, 0.10, 0.85 );',
          '  float mel = uIrisMelanin;',
          // Pigment hides structure. Blue irides show all of the stroma; dark
          // brown ones show a fraction of it.
          '  eyeIrisStructure = mix( 1.0, 0.42, mel ) * uTexAmount;',
          '',
          /* Into the baked map.
           *
           * The maps are drawn at one nominal pupil size and the real one is
           * measured per eyeball, so the annulus between pupil and limbus is
           * rescaled on the way in. That keeps the collarette, the crypts and
           * the ruff sitting where they belong on the GLB eyes and on the
           * procedural fallback, whose pupils differ by about a tenth.
           *
           * The scale runs away as rr approaches zero, which is why it is
           * clamped — but that only happens deep inside the pupil, under
           * paint that is about to be made black. */
          '  float rBaked = uIrisPupilBaked',
          '    + ( rr - pupilFrac ) * ( 1.0 - uIrisPupilBaked ) / max( 1.0 - pupilFrac, 0.05 );',
          '  eyeIrisUV = uv * ( rr > 1.0e-3 ? clamp( rBaked / rr, 0.25, 4.0 ) : 1.0 ) * 0.5 + 0.5;',
          '  vec4 det = texture2D( uIrisDetail, eyeIrisUV );',
          // Stored as a modulation about 1.0, packed into the range 0..2.
          '  vec3 tint = mix( vec3( 1.0 ), det.rgb * 2.0, eyeIrisStructure );',
          '  float ao = mix( 1.0, det.a, eyeIrisStructure );',
          '',
          '  vec3 c = diffuseColor.rgb;',
          // Across the annulus: 0 at the pupil margin, 1 at the limbus.
          '  float t = clamp( ( rr - pupilFrac ) / max( 1.0 - pupilFrac, 0.05 ), 0.0, 1.0 );',
          '',
          /* The stroma is a cone, thickest at the collarette and thinning to
             the pupil, so the pupillary zone reads darker and browner. The
             two zones wanting visibly different values is most of what makes
             an iris look like tissue rather than a tinted disc, so this is
             the one gradient worth running hard. */
          '  c *= mix( 0.62, 1.26, smoothstep( 0.0, 0.55, t ) );',
          '  c = mix( c, c * vec3( 1.14, 0.84, 0.58 ),',
          '    ( 1.0 - smoothstep( 0.0, 0.42, t ) ) * mix( 0.35, 0.62, mel ) );',
          '',
          // Trabeculae, crypts, collarette, furrows, ruff and pigment, all
          // out of the baked map; and the light their own pits keep out,
          // which is what makes the relief read as depth rather than paint.
          '  c *= tint;',
          '  c *= mix( 1.0, ao, 0.85 );',
          '',
          /* The pupil margin is scalloped by the sphincter, never cut round.
             Integer frequencies only: the angle wraps at +/- pi, and a
             non-integer multiple of it leaves a visible step there. */
          '  float crenel = 0.008 * sin( ang * 29.0 + 0.4 ) + 0.006 * sin( ang * 41.0 - 1.9 )',
          '    + 0.005 * sin( ang * 11.0 + 2.2 );',
          '  float pupilR = pupilFrac * ( 1.0 + crenel );',
          '  eyePupilMask = 1.0 - smoothstep( pupilR - 0.018, pupilR + 0.014, rr );',
          '  c = mix( c, vec3( 0.004, 0.004, 0.005 ), eyePupilMask );',
          '',
          /* The limbal ring, keyed to the true geometry rather than to the
             refracted pattern, so it stays welded to the edge of the iris
             instead of sliding off it at a glancing angle. A strong real-eye
             cue, and one people notice missing without knowing why. */
          '  c *= 1.0 - smoothstep( 0.86, 1.0, rGeo ) * 0.62;',
          '',
          '#if NUM_DIR_LIGHTS > 0',
          '  {',
          /* Light that crosses the anterior chamber lands on the far side of
             the iris and scatters back out through the stroma. On a real eye
             this glow sits opposite the catchlight and is the reason a lit
             iris is never flat. It fades as melanin rises, because pigment
             absorbs what the stroma would otherwise scatter. */
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
        /* Relief.
         *
         * Trabeculae stand proud of the stroma, crypts are pits and the
         * collarette is a ridge. Without this the map is a photograph of an
         * iris painted onto a smooth dome, and the moment the key light moves
         * it reads as exactly that.
         *
         * The map's u and v run along the disc's own axes, so its tangent
         * frame is the eye frame projected onto the surface. No generated
         * tangents and no UV derivatives are needed, which is just as well:
         * the disc coordinates are not the mesh's UVs, so three's own tangent
         * frame would be derived from the wrong parameterisation entirely. */
        .replace('#include <normal_fragment_maps>', [
          '#include <normal_fragment_maps>',
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 relief = texture2D( uIrisNormal, eyeIrisUV ).xyz * 2.0 - 1.0;',
          // Pigment flattens the relief along with the pattern, and a hole
          // has no surface to catch light on at all.
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
        // A pupil is a hole. Nothing about it is glossy, and leaving the
        // iris's own roughness there put a second highlight inside the one
        // part of the eye that must stay black.
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          'roughnessFactor = mix( roughnessFactor, 1.0, eyePupilMask );',
        ].join('\n'));
    });
  }

  // ── Sclera ───────────────────────────────────────────────────────────────

  /**
   * The sclera: socket occlusion, episcleral vessels, the limbal band and a
   * warm conjunctival cast at the corners.
   *
   * The brightness terms deliberately keep the values they were tuned to —
   * an eyeball sits millimetres inside a bony orbit under a brow, so most of
   * its upper hemisphere never sees open sky, and a sclera photographs around
   * the value of light skin rather than as white. What changes is the anchor:
   * the shading is keyed to world up and to the gaze axis instead of to the
   * camera, so it no longer swims when the head turns.
   */
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
          /* The socket is a cave. Almost none of the upper hemisphere sees
             open sky, which is why rendering a sclera bright is the single
             most common reason CG eyes look like marbles. Measured against
             world up rather than view-space Y, so a camera that rises above
             the head no longer rotates the brow shadow with it.
             *
             * The lit figure comes off a measurement, not taste: at 0.86 the
             * rendered sclera sat within a couple of per cent of the lit
             * cheek, and in a portrait a sclera reads around 85% of the skin
             * beside it. */
          '  c *= mix( 0.72, 0.16, smoothstep( -0.45, 0.75, dot( N, worldUp ) ) );',
          '',
          // Curving away from the viewer, into the lid margins.
          '  c *= mix( 1.0, 0.42, smoothstep( 0.34, 0.95, 1.0 - abs( dot( N, V ) ) ) );',
          // Past the exposed fissure the ball turns into the orbit and
          // nothing reaches it at all.
          '  c *= mix( 1.0, 0.30, smoothstep( uLimbusPolar + 0.55, uLimbusPolar + 1.30, polar ) );',
          '',
          /* Episcleral vessels, out of the baked map.
           *
           * They emerge from both canthi, run along the fissure and thin out
           * before the limbus, which stays comparatively clear on a healthy
           * eye. All of that is grown as branching, tapering paths in
           * EyeTextures rather than thresholded out of noise here — noise can
           * make a line but it cannot make a line that starts somewhere,
           * splits, and gets narrower than its parent, and that is the whole
           * difference between a vessel and a scratch.
           *
           * Mapped azimuthally: distance from the centre of the map is the
           * polar angle from the corneal pole. The projection's only
           * singularity is at that pole, which sits under the cornea and is
           * never seen. */
          '  float plLen = length( pl );',
          '  vec2 scleraUV = plLen > 1.0e-4',
          '    ? ( pl / plLen ) * ( polar / max( uScleraPolarSpan, 0.1 ) ) * 0.5 + 0.5',
          '    : vec2( 0.5 );',
          '  vec3 bed = mix( vec3( 1.0 ), texture2D( uScleraDetail, scleraUV ).rgb, uTexAmount );',
          '  float exposed = smoothstep( uLimbusPolar + 0.02, uLimbusPolar + 0.26, polar )',
          '    * ( 1.0 - smoothstep( uLimbusPolar + 0.95, uLimbusPolar + 1.50, polar ) );',
          // Denser along the fissure: the sclera above and below it is under
          // a lid, and vessels drawn there are vessels nobody can see.
          '  float fissure = mix( 0.30, 1.0, 1.0 - smoothstep( 0.18, 0.72, abs( pl.y ) ) );',
          '  c *= mix( vec3( 1.0 ), bed, exposed * 0.8 );',
          '',
          // Under the discrete vessels, the diffuse wash of the bed they sit
          // in: a millimetre of collagen over choroid is never neutral.
          '  c = mix( c, c * vec3( 1.06, 0.86, 0.80 ), exposed * fissure * 0.45 );',
          '',
          /* And a warm cast over the whole exposed ball, vessels or no.
           *
           * This is the term that decides whether the eye reads as an eye or
           * as a grey bead. Measured against the face beside it, the sclera
           * was coming out almost neutral — red over blue of 1.15 against
           * skin's 1.6 — and a neutral patch that size next to skin reads as
           * plastic however well its brightness is matched. Conjunctiva is
           * vascular tissue lying over white sclera and it is never grey. */
          '  c *= mix( vec3( 1.0 ), vec3( 1.04, 0.94, 0.86 ),',
          '    smoothstep( uLimbusPolar, uLimbusPolar + 0.60, polar ) );',
          '',
          // The sclera thins where it meets the cornea and the dark uvea
          // shows through it as the blue-grey limbal band.
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

  /**
   * The tear film. The shell is additive and metallic, so its colour *is* its
   * reflection strength and modulating diffuseColor here scales the
   * catchlight directly.
   *
   * What this adds over a uniform shell: the glassy part is the corneal cap
   * alone, the tear meniscus pools in the limbal groove and catches a bright
   * line there, and the lid-covered top of the ball is not wet at all.
   * Previously the whole sphere reflected equally, which laid half the sky
   * across the eyeball as a flat wash — and that wash, not the sclera's own
   * colour, was what kept reading as a bright white eyeball.
   */
  static attachCornea(material) {
    return EyeShading._attach(material, 'eye-cornea', (shader) => {
      /* Where on the ball a fragment sits has to come from its position, not
         from its normal.
         *
         * On the scleral part the two agree — the normal is radial from the
         * eyeball centre. On the corneal cap they do not, and badly: the cap
         * is a much tighter sphere, so at the limbus its normal is 52° off
         * the axis where the geometry is only 20° off. Reading the angle off
         * the normal put the limbal meniscus a third of the way into the
         * cornea and shrank the glassy zone to the middle of the pupil.
         *
         * The shell's geometry is built about the origin and the mesh is
         * translated to the eyeball centre, so its object-space position is
         * exactly the radial direction that is wanted. */
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
          // Glass ends at the limbus, not somewhere past it.
          '  eyeCorneaCap = 1.0 - smoothstep( uLimbusPolar - 0.12, uLimbusPolar + 0.04, polar );',
          /* Only the cornea is glass. Over the sclera the film is a thin wet
             sheen, and letting it reflect at anything close to corneal
             strength put a clipped near-white smear beside the iris measuring
             1.8× the lit cheek next to it. One mirror that size is all it
             takes to turn an eye back into a glass bead — and a bead is
             exactly what it read as, through a matte sclera and through the
             environment being switched off, until the shell was suppressed
             and it vanished. */
          '  float wet = mix( 0.07, 1.0, eyeCorneaCap );',
          // The tear meniscus pools in the groove at the limbus: a fine
          // bright line, not a halo.
          '  wet += exp( - pow( ( polar - uLimbusPolar ) * 16.0, 2.0 ) ) * 0.12;',
          /* A nudge of Fresnel, not a curve. A real cornea reflects 2.5%
             head-on and only a little more at a glancing angle; a full
             Schlick term here dims the catchlight to nothing, which is the
             one thing this shell exists to carry. Weighted onto the cap,
             since grazing incidence on the scleral part is half of what made
             the smear. */
          '  float fresnel = pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 4.0 ) * 0.8;',
          '  wet *= 1.0 + fresnel * mix( 0.15, 1.0, eyeCorneaCap );',
          // The lids and brow cover the top of the ball; nothing there is
          // wet. Keyed to where the fragment sits, not to which way it faces.
          '  wet *= mix( 1.0, 0.35, smoothstep( 0.25, 0.85,',
          '    dot( D, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) ) ) );',
          '',
          '  diffuseColor.rgb *= wet;',
          '}',
          '#endif',
        ].join('\n'))
        /* The cap is glass; the film over the sclera is thinner, and a shade
           less even. Only a shade, though: roughening the scleral film is
           what turned the fill light's reflection there from a small glint
           into the broad smear, because a mid-roughness lobe on a bright
           metallic shell keeps the peak and spreads the area. Strength, not
           roughness, is the right knob for "less wet". */
        .replace('#include <roughnessmap_fragment>', [
          '#include <roughnessmap_fragment>',
          'roughnessFactor = clamp( roughnessFactor * mix( 1.5, 0.62, eyeCorneaCap ), 0.02, 1.0 );',
        ].join('\n'));
    });
  }
}

window.EyeShading = EyeShading;
