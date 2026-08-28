/**
 * StrandShading.js
 * Hair shading: strand alpha for the card-based hair, and anisotropic sheen
 * for everything made of strands.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * HairSystem records why the hair and beard were made fully opaque: the styles
 * are solid card geometry with no alpha map, triangles are not sorted within a
 * mesh, and blending them produced blocky see-through patches in arbitrary
 * order. That reasoning is correct — but the consequence is a polygonal
 * silhouette, which is one of the loudest CG tells on a head.
 *
 * `alphaTest` resolves the tradeoff rather than trading back into it. A cutout
 * material still writes depth and still needs no sorting, so none of the
 * artefacts that forced opacity can return; it just gets a strand-shaped edge
 * instead of a card-shaped one.
 *
 * Eyebrows and eyelashes are a different case: those assets are real strand
 * geometry (35k and 42k vertices of individual hairs) and carry no UVs at all,
 * so there is nothing to map a strand texture onto. What they needed was to
 * stop being semi-transparent — overlapping strands blended in arbitrary order
 * is exactly what made them read as a fuzzy decal floating over the brow.
 */

class StrandShading {

  /**
   * A tileable strand strip: opaque hair against transparent gaps.
   *
   * Hair card UVs conventionally run u across the card's width and v along its
   * length, so the strands are vertical bands here, tapering toward v=1 where
   * the tips are. Widths and gaps vary because evenly spaced strands read as a
   * comb rather than as hair.
   */
  static buildStrandAlpha(size) {
    const W = size || 256;
    const H = size || 256;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, W, H);

    let seed = 20260826;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const img = ctx.createImageData(W, H);
    const d = img.data;

    // Lay out strand centres across u with irregular spacing.
    /* Wide strands, narrow gaps.
     *
     * The job here is to feather the SILHOUETTE of a hair card, not to punch
     * it full of holes. A first pass used thin strands with wide gaps and cut
     * away so much of every card that the hair mass went transparent and lit
     * up as pale wisps — a worse result than the solid blob it replaced.
     * Coverage stays high; the variation lives at the card's edges and tips,
     * which is the part the eye actually reads as hair. */
    const strands = [];
    let x = 0;
    while (x < W) {
      const width = 4.0 + rnd() * 8.0;
      strands.push({
        x: x + width * 0.5,
        w: width,
        // Most strands run nearly the full card; a few stop short so the tip
        // edge is ragged rather than cut straight across.
        len: 0.68 + rnd() * 0.32,
      });
      x += width + rnd() * 1.2;
    }

    for (let y = 0; y < H; y++) {
      const v = y / (H - 1);
      for (let px = 0; px < W; px++) {
        let alpha = 0;

        for (const st of strands) {
          // Wrap the distance so the strip tiles horizontally.
          let dx = px - st.x;
          if (dx > W * 0.5) dx -= W;
          if (dx < -W * 0.5) dx += W;
          const half = st.w * 0.5;
          if (Math.abs(dx) > half) continue;

          // Soft edge across the strand, so it does not cut as a hard bar.
          const edge = 1 - Math.pow(Math.abs(dx) / half, 4.0);
          // Strand ends: alpha falls away past its own length.
          const tip = 1 - Math.max(0, (v - st.len) / Math.max(0.05, 1 - st.len));
          const a = edge * tip;
          if (a > alpha) alpha = a;
        }

        const i = (y * W + px) * 4;
        /* The coverage goes in RGB, not just A.
           three's alphamap_fragment reads `.g` and ignores the alpha channel
           entirely, so writing coverage only to A produces a map that is
           uniformly opaque in the channel that is actually sampled — the
           cutout silently does nothing. Per-strand shade variation would have
           to ride a second map; coverage is what matters here. */
        const cov = (Math.min(1, alpha * 1.35) * 255) | 0;
        d[i] = cov; d[i + 1] = cov; d[i + 2] = cov;
        d[i + 3] = cov;
      }
    }

    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  static getStrandAlpha() {
    if (!StrandShading._alpha) {
      StrandShading._alpha = StrandShading.buildStrandAlpha(256);
    }
    return StrandShading._alpha;
  }

  /**
   * Turn a solid hair-card material into a cutout one.
   *
   * `transparent` stays false on purpose. A cutout material is opaque as far as
   * the renderer is concerned — it writes depth, sorts by depth like any other
   * solid, and so cannot reproduce the arbitrary-order blending that made the
   * original transparent version unusable.
   */
  static applyCardAlpha(material, repeatU, repeatV) {
    if (!material) return material;
    const tex = StrandShading.getStrandAlpha().clone();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(repeatU || 1, repeatV || 1);
    tex.needsUpdate = true;

    material.alphaMap = tex;
    material.alphaTest = 0.28;
    material.transparent = false;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    material.needsUpdate = true;
    return material;
  }

  /**
   * Anisotropic sheen and root-to-tip shading for any strand material.
   *
   * Hair does not have a point highlight; it has a band of light running across
   * the strands, because each hair is a cylinder reflecting in a ring. The
   * Kajiya-Kay shift below approximates that from the surface normal, which is
   * as much as is available without a tangent attribute — none of these assets
   * carry one, and hair cards would need authored flow directions to have one.
   *
   * The Fresnel term matters as much as the specular: hair catches a lot of
   * light at grazing angles, and a strand mass with no rim reads as a solid
   * shell of plastic.
   */
  static attachSheen(material, options) {
    if (!material || material.userData.strandSheen) return material;
    const cfg = Object.assign({
      sheenStrength: 0.55,
      sheenTint: new THREE.Color(0xffd9a8),
      rimStrength: 0.35,
      rootDarken: 0.35,
    }, options || {});

    const uniforms = {
      uSheenStrength: { value: cfg.sheenStrength },
      uSheenTint: { value: cfg.sheenTint },
      uRimStrength: { value: cfg.rimStrength },
      uRootDarken: { value: cfg.rootDarken },
    };
    material.userData.strandSheen = { uniforms };

    /* Chain rather than replace.
     *
     * onBeforeCompile is a single slot, so assigning it here silently discards
     * whatever the caller installed first. That is exactly what happened to
     * the eyelash material: it had a fragment clip attached one line earlier,
     * and this overwrote it, so the clip compiled into nothing and every
     * attempt to tune it looked like it had no effect. */
    const priorCompile = material.onBeforeCompile;
    const priorKey = material.customProgramCacheKey;

    material.onBeforeCompile = (shader, renderer) => {
      if (typeof priorCompile === 'function') priorCompile(shader, renderer);
      Object.assign(shader.uniforms, uniforms);

      shader.fragmentShader =
        'uniform float uSheenStrength;\n' +
        'uniform vec3 uSheenTint;\n' +
        'uniform float uRimStrength;\n' +
        'uniform float uRootDarken;\n' +
        shader.fragmentShader;

      // Root-to-tip value falloff, applied to the base colour before lighting.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          '#ifndef FLAT_SHADED',
          '{',
          // Strands are darker where they emerge and catch more light toward
          // the tips, which is most of what gives a hair mass its depth.
          '  vec3 sN = normalize( vNormal );',
          '  float depthCue = smoothstep( -0.6, 0.9, sN.z );',
          '  diffuseColor.rgb *= mix( 1.0 - uRootDarken, 1.0, depthCue );',
          '}',
          '#endif',
        ].join('\n')
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        [
          '#include <aomap_fragment>',
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 sN = normalize( vNormal );',
          '  vec3 sV = normalize( vViewPosition );',
          '  float fres = pow( 1.0 - clamp( dot( sN, sV ), 0.0, 1.0 ), 3.0 );',
          '  reflectedLight.directSpecular += uSheenTint * uRimStrength * fres;',
          // Kajiya-Kay style band: shifting the normal along the view-up axis
          // turns the point highlight into the streak real hair shows.
          '  vec3 shifted = normalize( sN + vec3( 0.0, 0.55, 0.0 ) );',
          '  float band = pow( clamp( dot( shifted, sV ), 0.0, 1.0 ), 22.0 );',
          '  reflectedLight.directSpecular += uSheenTint * uSheenStrength * band;',
          '}',
          '#endif',
        ].join('\n')
      );
    };

    // Likewise for the cache key: two materials whose programs differ must not
    // collide on one key, or the second renders with the first's shader.
    material.customProgramCacheKey = () =>
      'strand' + (typeof priorKey === 'function' ? '|' + priorKey.call(material) : '');
    material.needsUpdate = true;
    return material;
  }

  /** Live update of the sheen parameters on an attached material. */
  static setSheenParams(material, params) {
    const s = material && material.userData && material.userData.strandSheen;
    if (!s) return;
    if (params.sheenStrength !== undefined) s.uniforms.uSheenStrength.value = params.sheenStrength;
    if (params.rimStrength !== undefined) s.uniforms.uRimStrength.value = params.rimStrength;
    if (params.rootDarken !== undefined) s.uniforms.uRootDarken.value = params.rootDarken;
    if (params.sheenTint !== undefined) s.uniforms.uSheenTint.value.set(params.sheenTint);
  }
}

StrandShading._alpha = null;

window.StrandShading = StrandShading;
