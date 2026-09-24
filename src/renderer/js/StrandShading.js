// Builds matching textures and hair-specific lighting for each hair and beard style.
class StrandShading {
  // Random seed, waviness and taper for each style's fibre texture.
  static get PROFILES() {
    return {
      hair1: { seed: 1103, wave: 1.4, taper: 0.76 },
      hair2: { seed: 2207, wave: 3.2, taper: 0.66 },
      hair3: { seed: 3301, wave: 0.8, taper: 0.85 },
      hair4: { seed: 4409, wave: 1.8, taper: 0.79 },
      hair5: { seed: 5501, wave: 2.8, taper: 0.71 },
      hair6: { seed: 6607, wave: 2.1, taper: 0.77 },
      hair7: { seed: 7703, wave: 1.2, taper: 0.82 },
      hair8: { seed: 8803, wave: 0.7, taper: 0.88 },
      hair9: { seed: 9901, wave: 1.1, taper: 0.86 },
      hair10: { seed: 10103, wave: 1.6, taper: 0.81 },
      hair11: { seed: 11113, wave: 2.5, taper: 0.72 },
      hair12: { seed: 12101, wave: 3.5, taper: 0.64 },
      hair13: { seed: 13103, wave: 2.4, taper: 0.75 },
      hair14: { seed: 14107, wave: 1.5, taper: 0.80 },
      beard1: { seed: 15101, wave: 3.2, taper: 0.76, coarse: true },
      beard2: { seed: 16103, wave: 4.2, taper: 0.65, coarse: true },
      beard3: { seed: 17107, wave: 3.6, taper: 0.69, coarse: true },
      beard4: { seed: 18119, wave: 3.9, taper: 0.64, coarse: true },
      beard5: { seed: 19121, wave: 4.0, taper: 0.70, coarse: true },
      beard6: { seed: 20107, wave: 4.4, taper: 0.62, coarse: true },
      moustache1: { seed: 21101, wave: 2.4, taper: 0.79, coarse: true },
    };
  }

  // Builds a style's fibre texture atlas with four card widths.
  static buildStyleTextures(style) {
    const cfg = StrandShading.PROFILES[style] || StrandShading.PROFILES.hair1;
    const W = 1024, H = 1024, tile = W / 4;
    let seed = cfg.seed;
    const rnd = () => { seed = seed * 16807 % 2147483647; return (seed - 1) / 2147483646; };
    const packed = new Uint8ClampedArray(W * H * 4);
    const normals = new Uint8ClampedArray(W * H * 4);
    const coverage = new Float32Array(W * H);
    for (let i = 0; i < packed.length; i += 4) {
      packed[i] = 180; packed[i + 2] = 128; packed[i + 3] = 255;
      normals[i] = normals[i + 1] = 128; normals[i + 2] = normals[i + 3] = 255;
    }
    for (let col = 0; col < 4; col++) {
      const count = 8 * (2 ** col);
      const spacing = (tile - 18) / count;
      const strands = Array.from({ length: count }, (_, i) => ({
        x: 9 + (i + 0.22 + rnd() * 0.56) * spacing,
        width: spacing * (0.62 + rnd() * 0.48),
        length: cfg.taper + rnd() * (0.985 - cfg.taper),
        tone: 0.70 + rnd() * 0.43,
        id: rnd(), phase: rnd() * Math.PI * 2,
        wave: cfg.wave * (0.35 + rnd() * 0.65) * Math.max(1,spacing*0.12),
      }));
      for (let y = 0; y < H; y++) {
        // DataTexture-style orientation, also used for the exported PNGs.
        const v = y / (H - 1);
        for (const st of strands) {
          if (v >= st.length) continue;
          const tip = Math.min(1, (st.length - v) / 0.18);
          const root = Math.min(1, v / (cfg.coarse ? 0.10 : 0.05));
          const half = Math.max(0.1, st.width * 0.5 * Math.sqrt(tip));
          // Endpoints stay within the card, with a few independent flyaways.
          const bend = Math.sin(v * 8 + st.phase) - Math.sin(st.phase);
          const cx = st.x + bend * st.wave * Math.sin(v * Math.PI);
          const lo = Math.max(2, Math.floor(cx - half - 1));
          const hi = Math.min(tile - 3, Math.ceil(cx + half + 1));
          for (let x = lo; x <= hi; x++) {
            const dx = (x - cx) / half;
            const cov = Math.min(1, Math.max(0, half + 0.5 - Math.abs(x - cx))) * Math.min(1, root * 1.5) * Math.min(1, tip * 3);
            const pixel = y * W + col * tile + x;
            if (cov <= coverage[pixel]) continue;
            coverage[pixel] = cov;
            const i = pixel * 4;
            // Warmth is supplied by the user's colour, not baked highlights.
            packed[i] = Math.min(255, Math.round(200 * st.tone * (0.82 + 0.18 * v)));
            packed[i + 1] = Math.round(cov * 255);
            packed[i + 2] = Math.round(st.id * 255);
            const nx = Math.max(-0.8, Math.min(0.8, dx * 0.65));
            const ny = Math.cos(v * 8 + st.phase) * st.wave * 0.014;
            normals[i] = Math.round((nx * 0.5 + 0.5) * 255);
            normals[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            normals[i + 2] = Math.round((Math.sqrt(Math.max(0.1, 1 - nx * nx - ny * ny)) * 0.5 + 0.5) * 255);
          }
        }
      }
    }
    const texture = (data, suffix) => {
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      canvas.getContext('2d').putImageData(new ImageData(data, W, H), 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.name = style + '-' + suffix + '-v2';
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 8;
      return tex;
    };
    let toneSum = 0, kept = 0;
    for (let i = 0; i < packed.length; i += 4) {
      if (packed[i + 1] > 80) { toneSum += packed[i] / 255; kept++; }
    }
    const map = texture(packed, 'strands');
    map.userData.toneMean = toneSum / Math.max(1, kept);
    map.userData.style = style;
    return { map, normal: texture(normals, 'normal'), profile: cfg };
  }

  // Returns a style's textures from the cache, building and loading them if needed.
  static getStyleTextures(style) {
    const cache = StrandShading._styles || (StrandShading._styles = new Map());
    if (cache.has(style)) {
      const value = cache.get(style);
      cache.delete(style); cache.set(style, value);
      return value;
    }
    const value = StrandShading.buildStyleTextures(style);
    value.source = 'procedural-fallback';
    // Load the authored fibre atlas; the generated set above covers first display and offline use.
    value.ready = new Promise(resolve => {
      new THREE.ImageLoader().load('../../assets/textures/hair/' + style + '-fibres-v2.png', image => {
        if (value.disposed) { resolve(); return; }
        StrandShading.readFibreAtlas(value, image);
        value.source = 'generated-fibres-v2';
        resolve();
      }, undefined, () => resolve());
    });
    cache.set(style, value);
    // Keep at most four styles cached to limit GPU memory.
    if (cache.size > 4) {
      const candidates = [...cache.keys()];
      const oldest = candidates.find(key => !StrandShading._activeStyles?.has(key));
      if (oldest) {
        const old = cache.get(oldest);
        old.disposed = true;
        old.map.dispose(); old.normal.dispose(); cache.delete(oldest);
      }
    }
    return value;
  }

  // Builds the matching colour, roughness and normal channels from the authored fibre image.
  static readFibreAtlas(textures, image) {
    const W = 1024, H = 1024;
    const layout = textures.map.image.getContext('2d').getImageData(0,0,W,H).data;
    const layoutNormal = textures.normal.image.getContext('2d').getImageData(0,0,W,H).data;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, W, H);
    const source = ctx.getImageData(0,0,W,H).data;
    const fitted = document.createElement('canvas'); fitted.width = W; fitted.height = H;
    const fit = fitted.getContext('2d');
    // Fit the fibre count to each card width, or short cards blur into a see-through patch.
    for (let col=0;col<4;col++) {
      const counts = [];
      for (const y of [180,320,460]) {
        let peaks = 0;
        for (let x=col*256+4;x<(col+1)*256-4;x++) {
          const i=(y*W+x)*4, h=source[i];
          if (h>45 && h>source[i-4]+5 && h>=source[i+4]) peaks++;
        }
        counts.push(peaks);
      }
      counts.sort((a,b)=>a-b);
      const fraction = Math.min(1,(8*(2**col))/Math.max(8,counts[1]));
      const crop = 256*fraction;
      fit.drawImage(canvas,col*256+(256-crop)*0.5,0,crop,H,col*256,0,256,H);
    }
    const pixels = fit.getImageData(0,0,W,H).data;
    const heights = new Float32Array(W*H);
    for (let i=0;i<heights.length;i++) heights[i] = pixels[i*4]/255;
    const packed = ctx.createImageData(W,H), normal = ctx.createImageData(W,H);
    let mean = 0, count = 0;
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
      const p = y*W+x, i = p*4, h = heights[p];
      // Keep solid, continuous fibres; the image only adds detail and colour variation within them.
      const tone = (layout[i]/200) * (0.78 + Math.sqrt(h)*0.44);
      const cov = (layout[i+1]/255) * (0.86 + Math.min(1,h*2)*0.14);
      packed.data[i] = Math.min(255,Math.round(tone*200));
      packed.data[i+1] = Math.round(cov*255);
      packed.data[i+2] = layout[i+2];
      packed.data[i+3] = 255;
      const dx = heights[y*W+Math.max(0,x-1)] - heights[y*W+Math.min(W-1,x+1)];
      const dy = heights[Math.max(0,y-1)*W+x] - heights[Math.min(H-1,y+1)*W+x];
      const nx = dx*1.4, ny = dy*0.5, invLength = 1/Math.sqrt(nx*nx+ny*ny+1);
      normal.data[i] = Math.round(layoutNormal[i]*0.8 + (nx*invLength*0.5+0.5)*255*0.2);
      normal.data[i+1] = Math.round(layoutNormal[i+1]*0.8 + (ny*invLength*0.5+0.5)*255*0.2);
      normal.data[i+2] = Math.round(layoutNormal[i+2]*0.8 + (invLength*0.5+0.5)*255*0.2);
      normal.data[i+3] = 255;
      if (cov > 0.30) { mean += packed.data[i]/255; count++; }
    }
    textures.map.image.getContext('2d').putImageData(packed,0,0);
    textures.normal.image.getContext('2d').putImageData(normal,0,0);
    textures.map.userData.toneMean = mean/Math.max(1,count);
    textures.map.needsUpdate = textures.normal.needsUpdate = true;
  }

  // Unwraps each hair card on its own so its texture runs along the strands, keeping vertex order for painting.
  static prepareStrandGeometry(geometries, style = 'hair1') {
    const geos = (Array.isArray(geometries) ? geometries : [geometries]).filter(Boolean);
    const box = new THREE.Box3();
    for (const g of geos) { g.computeBoundingBox(); box.union(g.boundingBox); }
    const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-6);
    for (const g of geos) {
      if (g.userData.strandCardVersion === 2) continue;
      const pos = g.attributes.position, oldUV = g.attributes.uv;
      const parent = Int32Array.from({ length: pos.count }, (_, i) => i);
      const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      const idx = g.index;
      for (let t = 0; t < (idx ? idx.count : pos.count); t += 3) {
        const a = root(idx ? idx.getX(t) : t);
        parent[root(idx ? idx.getX(t + 1) : t + 1)] = a;
        parent[root(idx ? idx.getX(t + 2) : t + 2)] = a;
      }
      const cards = new Map();
      for (let i = 0; i < pos.count; i++) {
        const key = root(i);
        if (!cards.has(key)) cards.set(key, []);
        cards.get(key).push(i);
      }
      const uv = new Float32Array(pos.count * 2);
      let synthesized = 0;
      for (const verts of cards.values()) {
        const centre = new THREE.Vector3();
        const p = new THREE.Vector3();
        for (const i of verts) centre.add(p.fromBufferAttribute(pos, i));
        centre.divideScalar(verts.length);
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        if (oldUV) for (const i of verts) {
          minU = Math.min(minU, oldUV.getX(i)); maxU = Math.max(maxU, oldUV.getX(i));
          minV = Math.min(minV, oldUV.getY(i)); maxV = Math.max(maxV, oldUV.getY(i));
        }
        const valid = oldUV && maxU - minU > 1e-6 && maxV - minV > 1e-6;
        const coords = [];
        if (valid) {
          for (const i of verts) coords.push([(oldUV.getX(i) - minU) / (maxU - minU), (oldUV.getY(i) - minV) / (maxV - minV)]);
        } else {
          synthesized++;
          // Principal direction of this card, not a projection of the head.
          const covariance = new THREE.Matrix3().set(0,0,0,0,0,0,0,0,0);
          const e = covariance.elements;
          for (const i of verts) {
            p.fromBufferAttribute(pos, i).sub(centre);
            const a = p.toArray();
            for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) e[c * 3 + r] += a[r] * a[c];
          }
          const axis = new THREE.Vector3(e[0] >= e[4] && e[0] >= e[8] ? 1 : 0, e[4] > e[0] && e[4] >= e[8] ? 1 : 0, e[8] > e[0] && e[8] > e[4] ? 1 : 0);
          for (let k = 0; k < 12; k++) axis.applyMatrix3(covariance).normalize();
          const normal = new THREE.Vector3();
          if (g.attributes.normal) for (const i of verts) normal.add(p.fromBufferAttribute(g.attributes.normal, i));
          normal.normalize();
          const cross = new THREE.Vector3().crossVectors(axis, normal).normalize();
          if (cross.lengthSq() < 0.1) cross.crossVectors(axis, Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0)).normalize();
          minU = minV = Infinity; maxU = maxV = -Infinity;
          for (const i of verts) {
            p.fromBufferAttribute(pos, i).sub(centre);
            const u = p.dot(cross), v = p.dot(axis);
            coords.push([u,v]);
            minU = Math.min(minU,u); maxU = Math.max(maxU,u); minV = Math.min(minV,v); maxV = Math.max(maxV,v);
          }
          for (const c of coords) { c[0] = (c[0] - minU) / Math.max(1e-8,maxU-minU); c[1] = (c[1] - minV) / Math.max(1e-8,maxV-minV); }
        }
        const extent = dimension => {
          const a = new THREE.Vector3(), b = new THREE.Vector3(); let na = 0, nb = 0;
          coords.forEach((c,j) => {
            if (c[dimension] < 0.12) { a.add(p.fromBufferAttribute(pos,verts[j])); na++; }
            if (c[dimension] > 0.88) { b.add(p.fromBufferAttribute(pos,verts[j])); nb++; }
          });
          a.divideScalar(Math.max(1,na)); b.divideScalar(Math.max(1,nb));
          return { a,b,length: a.distanceTo(b) };
        };
        let across = extent(0), along = extent(1);
        if (across.length > along.length * 1.35) {
          for (const c of coords) [c[0],c[1]] = [c[1],c[0]];
          [across,along] = [along,across];
        }
        // Roots generally sit nearer the centre of the mass than free tips.
        const massCentre = box.getCenter(new THREE.Vector3());
        const reverse = along.a.distanceToSquared(massCentre) > along.b.distanceToSquared(massCentre);
        const fibres = across.length / span * (style.startsWith('hair') ? 1000 : 500);
        const col = Math.max(0,Math.min(3,Math.round(Math.log2(Math.max(8,fibres)/8))));
        coords.forEach((c,j) => {
          const i = verts[j];
          uv[i*2] = (col + 0.005 + c[0]*0.99)/4;
          uv[i*2+1] = 0.002 + (reverse ? 1-c[1] : c[1])*0.996;
        });
      }
      g.setAttribute('uv',new THREE.BufferAttribute(uv,2));
      // Imported tangents would refer to the previous UVs.
      g.deleteAttribute('tangent');
      g.userData.strandCardVersion = 2;
      g.userData.strandCards = cards.size;
      g.userData.strandUvSynthesized = synthesized > 0;
    }
    StrandShading.computeStrandDepth(geos);
  }

  // Stores how deep inside the hair mass each vertex sits (0-1), so inner hair is darker, measured across all meshes of a style.
  static computeStrandDepth(geometries) {
    const geos = (Array.isArray(geometries) ? geometries : [geometries])
      .filter(g => g && g.attributes.position && !g.attributes.aStrandDepth);
    if (!geos.length) return;

    const box = new THREE.Box3();
    for (const g of geos) {
      g.computeBoundingBox();
      box.union(g.boundingBox);
    }
    const sx = Math.max(1e-4, box.max.x - box.min.x);
    const sy = Math.max(1e-4, box.max.y - box.min.y);
    const sz = Math.max(1e-4, box.max.z - box.min.z);

    // Coarse on purpose, so it describes the hair mass rather than the individual cards.
    const RES = 14;
    const cell = Math.max(sx, sy, sz) / RES;
    const nx = Math.max(1, Math.ceil(sx / cell));
    const ny = Math.max(1, Math.ceil(sy / cell));
    const nz = Math.max(1, Math.ceil(sz / cell));
    const grid = new Float32Array(nx * ny * nz);

    const cellOf = (x, y, z) => {
      const ix = Math.min(nx - 1, Math.max(0, ((x - box.min.x) / cell) | 0));
      const iy = Math.min(ny - 1, Math.max(0, ((y - box.min.y) / cell) | 0));
      const iz = Math.min(nz - 1, Math.max(0, ((z - box.min.z) / cell) | 0));
      return (iz * ny + iy) * nx + ix;
    };

    // Bin each triangle's area at its centroid, across every mesh at once.
    for (const g of geos) {
      const p = g.attributes.position.array;
      const idx = g.index;
      const triCount = idx ? idx.count / 3 : g.attributes.position.count / 3;
      for (let t = 0; t < triCount; t++) {
        const a = (idx ? idx.getX(t * 3) : t * 3) * 3;
        const b = (idx ? idx.getX(t * 3 + 1) : t * 3 + 1) * 3;
        const c = (idx ? idx.getX(t * 3 + 2) : t * 3 + 2) * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const cxn = uy * vz - uz * vy;
        const cyn = uz * vx - ux * vz;
        const czn = ux * vy - uy * vx;
        const area = 0.5 * Math.sqrt(cxn * cxn + cyn * cyn + czn * czn);
        grid[cellOf((p[a] + p[b] + p[c]) / 3,
                    (p[a + 1] + p[b + 1] + p[c + 1]) / 3,
                    (p[a + 2] + p[b + 2] + p[c + 2]) / 3)] += area;
      }
    }

    // Normalise against a high percentile so one dense spot doesn't flatten the rest.
    const occupied = [];
    for (let i = 0; i < grid.length; i++) if (grid[i] > 0) occupied.push(grid[i]);
    if (!occupied.length) return;
    occupied.sort((p, q) => p - q);
    const ref = occupied[Math.min(occupied.length - 1, Math.floor(occupied.length * 0.85))] || 1;

    // Average neighbouring cells so the shading has no visible grid.
    for (const g of geos) {
      const p = g.attributes.position.array;
      const n = g.attributes.position.count;
      const depth = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const ix = Math.min(nx - 1, Math.max(0, ((p[i * 3] - box.min.x) / cell) | 0));
        const iy = Math.min(ny - 1, Math.max(0, ((p[i * 3 + 1] - box.min.y) / cell) | 0));
        const iz = Math.min(nz - 1, Math.max(0, ((p[i * 3 + 2] - box.min.z) / cell) | 0));
        let sum = 0, cnt = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const jz = iz + dz; if (jz < 0 || jz >= nz) continue;
          for (let dy = -1; dy <= 1; dy++) {
            const jy = iy + dy; if (jy < 0 || jy >= ny) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const jx = ix + dx; if (jx < 0 || jx >= nx) continue;
              sum += grid[(jz * ny + jy) * nx + jx];
              cnt++;
            }
          }
        }
        // Divide by the count so the edges of the box don't read as empty.
        depth[i] = Math.min(1, (sum / Math.max(1, cnt)) / ref);
      }
      g.setAttribute('aStrandDepth', new THREE.BufferAttribute(depth, 1));
    }
  }

  // Applies a style's textures to a material.
  static applyStyle(material, style) {
    const active = StrandShading._activeStyles || (StrandShading._activeStyles = new Set());
    if (material.userData.strandStyle) active.delete(material.userData.strandStyle);
    active.add(style);
    const textures = StrandShading.getStyleTextures(style);
    material.alphaMap = textures.map;
    material.normalMap = textures.normal;
    material.normalScale.set(0.38, 0.38);
    material.alphaTest = 0.30;
    material.alphaToCoverage = true;
    material.transparent = false;
    material.opacity = 1;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    if (window.HairStrands) material.defines = { ...material.defines, HAIR_FIBRES: 1 };
    material.userData.strandStyle = style;
    const uniforms = material.userData.strandSheen?.uniforms;
    if (uniforms) uniforms.uToneMean.value = textures.map.userData.toneMean;
    material.userData.strandTexturesReady = textures.ready.then(() => {
      if (material.alphaMap === textures.map && uniforms) uniforms.uToneMean.value = textures.map.userData.toneMean;
    });
    material.needsUpdate = true;
    return material;
  }

  // Swaps in a hair lighting model: a white band off the surface, a coloured band through the strand, and soft light through the mass.
  static attachSheen(material, options) {
    if (!material || material.userData.strandSheen) return material;
    const cfg = Object.assign({
      // R: the thin white highlight band; kept weak because white on dark hair quickly looks like steel wool.
      sheenStrength: 0.085,
      sheenTint: new THREE.Color(0xfff2e2),
      sheenExponent: 150.0,
      sheenShift: -0.10,
      // TRT: the broad coloured band from light passing through the strand, tinted by the hair colour.
      trtStrength: 0.13,
      trtExponent: 38.0,
      trtShift: 0.22,
      // How far the coloured band is pulled toward the light's colour, so dark hair doesn't flare copper.
      trtDesat: 0.78,
      // Rim light, kept low because it is white and added once.
      rimStrength: 0.06,
      rootDarken: 0.35,
      // How far light carries past the shadow line through the hair (0 = none).
      scatter: 0.5,
      toneStrength: 1.0,
    }, options || {});

    const uniforms = {
      uSheenStrength: { value: cfg.sheenStrength },
      uSheenTint: { value: cfg.sheenTint },
      uSheenExp: { value: cfg.sheenExponent },
      uSheenShift: { value: cfg.sheenShift },
      uTrtStrength: { value: cfg.trtStrength },
      uTrtExp: { value: cfg.trtExponent },
      uTrtShift: { value: cfg.trtShift },
      uTrtDesat: { value: cfg.trtDesat },
      uRimStrength: { value: cfg.rimStrength },
      uRootDarken: { value: cfg.rootDarken },
      uScatter: { value: cfg.scatter },
      uToneStrength: { value: cfg.toneStrength },
      // Filled in at compile time from the map itself; see below.
      uToneMean: { value: 1.0 },
      uHairViewport: { value: new THREE.Vector2(800, 900) },
      uHairDensity: { value: 1.0 },
    };
    material.userData.strandSheen = { uniforms };
    const priorRender = material.onBeforeRender;
    material.onBeforeRender = function(renderer, ...args) {
      if (typeof priorRender === 'function') priorRender.call(this, renderer, ...args);
      renderer.getDrawingBufferSize(uniforms.uHairViewport.value);
    };

    // Chain onto any existing onBeforeCompile instead of replacing it.
    const priorCompile = material.onBeforeCompile;
    const priorKey = material.customProgramCacheKey;

    material.onBeforeCompile = (shader, renderer) => {
      if (typeof priorCompile === 'function') priorCompile(shader, renderer);

      // Pass the depth attribute to the fragment shader; missing means "not occluded".
      shader.vertexShader =
        (window.HairStrands ? '#ifdef HAIR_FIBRES\n' + HairStrands.layerVertexGLSL() + '\n#endif\n' : '') +
        '#ifdef HAIR_FIBRES\nattribute vec3 aHairTangent;\nattribute vec3 aHairFiber;\nattribute float aHairWidth;\nuniform vec2 uHairViewport;\nvarying vec3 vHairTangent;\nvarying vec3 vHairFiber;\n#endif\n' +
        'attribute float aStrandDepth;\n' +
        'varying float vStrandDepth;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          'vStrandDepth = aStrandDepth;\n#include <begin_vertex>\n#ifdef HAIR_FIBRES\nvHairTangent = normalize(mat3(modelViewMatrix) * aHairTangent);\nvHairFiber = aHairFiber;\nvHairFiber.z = fract(aHairFiber.z + aHairLayer * 0.381966);\nvHairLayer = aHairLayer;\ntransformed += hairLayerOffset(aHairTangent, normal, aHairFiber.z, aHairWidth);\n#endif'
        );
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', [
        '#ifdef HAIR_FIBRES',
        'vec3 hairAcross = normalize(cross(aHairTangent, objectNormal));',
        'vec3 hairCentre = transformed - hairAcross * aHairWidth * aHairFiber.x;',
        'vec4 mvPosition = modelViewMatrix * vec4(hairCentre, 1.0);',
        'vec2 screenAcross = vec2(vHairTangent.y, -vHairTangent.x);',
        'screenAcross /= max(length(screenAcross), 0.0001);',
        'float actualWidth = length(mat3(modelViewMatrix) * hairAcross) * aHairWidth;',
        'float endTaper = sqrt(min(1.0, (1.0 - aHairFiber.y) * 10.0)) * sqrt(min(1.0, aHairFiber.y * 28.0));',
        'float pixelWidth = 0.72 * max(0.01, -mvPosition.z) / (projectionMatrix[1][1] * uHairViewport.y) * endTaper;',
        'mvPosition.xy += screenAcross * max(actualWidth, pixelWidth) * aHairFiber.x;',
        'gl_Position = projectionMatrix * mvPosition;',
        '#else',
        '#include <project_vertex>',
        '#endif',
      ].join('\n'));

      // Read the map's average tone at compile time, when both texture and alpha are set.
      const mean = material.alphaMap && material.alphaMap.userData.toneMean;
      uniforms.uToneMean.value = mean || 1.0;
      Object.assign(shader.uniforms, uniforms);

      // Shared variables, because three's light function has a fixed signature.
      shader.fragmentShader =
        '#ifdef HAIR_FIBRES\nuniform float uHairDensity;\nvarying float vHairLayer;\nvarying vec3 vHairTangent;\nvarying vec3 vHairFiber;\n#endif\n' +
        'uniform float uSheenStrength;\n' +
        'uniform vec3 uSheenTint;\n' +
        'uniform float uSheenExp;\n' +
        'uniform float uSheenShift;\n' +
        'uniform float uTrtStrength;\n' +
        'uniform float uTrtExp;\n' +
        'uniform float uTrtShift;\n' +
        'uniform float uTrtDesat;\n' +
        'uniform float uRimStrength;\n' +
        'uniform float uRootDarken;\n' +
        'uniform float uScatter;\n' +
        'uniform float uToneStrength;\n' +
        'uniform float uToneMean;\n' +
        'varying float vStrandDepth;\n' +
        'vec3 gStrandT = vec3( 0.0, 1.0, 0.0 );\n' +
        'float gStrandId = 0.5;\n' +
        'float gStrandOpen = 1.0;\n' +
        shader.fragmentShader;

      // Apply per-strand tone after the vertex colour so painted tint is kept.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          // Darken hair deep in the mass, but never to full black.
          '{',
          '  gStrandOpen = mix( 1.0, 1.0 - uRootDarken, clamp( vStrandDepth, 0.0, 1.0 ) );',
          '  diffuseColor.rgb *= gStrandOpen;',
          '}',
          '#ifdef USE_ALPHAMAP',
          '{',
          '  vec3 packed = texture2D( alphaMap, vAlphaMapUv ).rgb;',
          '  gStrandId = packed.b;',
          // Divide by the map's average so the user's colour sets the overall level.
          '  float tone = mix( 1.0, packed.r / uToneMean, uToneStrength );',
          '#ifndef HAIR_FIBRES',
          '  diffuseColor.rgb *= tone;',
          '#endif',
          '#ifdef HAIR_FIBRES',
          '  diffuseColor.rgb *= 0.86 + 0.28 * packed.r;',
          '  gStrandId = vHairFiber.z;',
          '  diffuseColor.rgb *= (0.78 + 0.44 * gStrandId) * mix(0.72, 1.0, smoothstep(0.0, 0.35, vHairFiber.y));',
          '#endif',
          '}',
          '#else',
          '#ifndef FLAT_SHADED',
          '{',
          // No UV, so fall back to a simple view-based cue; fine for small eyebrows.
          '  vec3 sN = normalize( vNormal );',
          '  float depthCue = smoothstep( -0.6, 0.9, sN.z );',
          '  diffuseColor.rgb *= mix( 1.0 - uRootDarken, 1.0, depthCue );',
          '}',
          '#endif',
          '#endif',
        ].join('\n')
      );

      // Hair lighting replaces the standard one, inserted where three declares it.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_pars_fragment>',
        [
          '#include <lights_physical_pars_fragment>',
          '',
          // Kajiya-Kay: the highlight is a band across the strands, strongest where the half vector is perpendicular to them.
          'float rfStrandBand( vec3 T, vec3 N, vec3 H, float shift, float expo ) {',
          '  vec3 Ts = normalize( T + shift * N );',
          '  float dotTH = dot( Ts, H );',
          '  float sinTH = sqrt( max( 1e-4, 1.0 - dotTH * dotTH ) );',
          '  return pow( sinTH, expo );',
          '}',
          '',
          'void RE_Direct_Strand( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {',
          '  vec3 N = geometryNormal;',
          '  vec3 V = geometryViewDir;',
          '  vec3 L = directLight.direction;',
          '  vec3 H = normalize( L + V );',
          '  float ndl = dot( N, L );',
          '',
          // Wrapped diffuse: light scatters through the hair, so the shadow edge is soft.
          '  float wrapped = clamp( ( ndl + uScatter ) / ( ( 1.0 + uScatter ) * ( 1.0 + uScatter ) ), 0.0, 1.0 );',
          '#ifdef USE_ALPHAMAP',
          // A fibre is a cylinder, so its diffuse follows its axis instead of the flat card.
          '  float tl = dot(gStrandT, L);',
          '  float cylinder = sqrt(max(0.0, 1.0 - tl * tl)) * 0.40;',
          '  wrapped = mix(wrapped, cylinder, 0.55);',
          '#ifdef HAIR_FIBRES',
          '  wrapped = cylinder;',
          '#endif',
          '#endif',
          '  reflectedLight.directDiffuse += directLight.color * wrapped * BRDF_Lambert( material.diffuseColor );',
          '',
          // Scale both bands by the light visibility and the mass occlusion, so highlights stay on lit, outer hair.
          '  float vis = wrapped * gStrandOpen;',
          '',
          // R band, shifted per strand so flat cards don't show a hard step between them.
          '  float shiftR = uSheenShift + ( gStrandId - 0.5 ) * 0.38;',
          '  float bandR = rfStrandBand( gStrandT, N, H, shiftR, uSheenExp );',
          '  reflectedLight.directSpecular += directLight.color * uSheenTint * ( uSheenStrength * bandR * vis );',
          '',
          // TRT band: carries the hair colour and sits lower down the strand.
          '  float shiftT = uTrtShift + ( gStrandId - 0.5 ) * 0.50;',
          '  float bandT = rfStrandBand( gStrandT, N, H, shiftT, uTrtExp );',
          // A narrow glint range, since the band is already varied per strand.
          '  float glint = 0.72 + 0.56 * gStrandId;',
          // Tint by the hair's hue at full brightness, since transmitted light is filtered, not darkened.
          '  vec3 alb = material.diffuseColor;',
          '  float peak = max( alb.r, max( alb.g, alb.b ) );',
          // Pull the tint back toward the light's colour, as light through many strands is much less saturated.
          '  vec3 trtTint = mix( alb / max( peak, 1e-4 ), vec3( 1.0 ), uTrtDesat );',
          '  reflectedLight.directSpecular += directLight.color * trtTint * ( uTrtStrength * bandT * glint * vis );',
          '}',
          '',
          '#undef RE_Direct',
          '#define RE_Direct RE_Direct_Strand',
        ].join('\n')
      );

      // Build the strand direction just before the light loop, after the normal map is applied.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n#ifdef USE_ALPHAMAP\n' +
        'roughnessFactor = clamp(roughnessFactor + (gStrandId - 0.5) * 0.16, 0.32, 0.72);\n#endif'
      );

      // Turn the thin edge into MSAA coverage so tapered fibres keep a soft outline.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphamap_fragment>',
        '#ifdef HAIR_FIBRES\n' +
        'diffuseColor.a *= smoothstep(0.0, 0.025, vHairFiber.y);\n' +
        '#else\n#include <alphamap_fragment>\n#endif'
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        '#ifdef HAIR_FIBRES\n' +
        'vec3 fibreT = normalize(vHairTangent);\n' +
        'vec3 fibreV = normalize(vViewPosition);\n' +
        'normal = normalize(fibreV - fibreT * dot(fibreT, fibreV));\n' +
        '#else\n#include <normal_fragment_maps>\n#endif'
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphatest_fragment>',
        '#ifdef HAIR_FIBRES\n' +
        'if (vHairFiber.z < max(0.0, alphaTest - 0.14) * 0.8) discard;\n' +
        'if (vHairLayer > 0.5 && vHairFiber.z >= uHairDensity - vHairLayer) discard;\n' +
        '#elif defined(USE_ALPHATEST)\n' +
        'float strandAA = max(fwidth(diffuseColor.a), 0.025);\n' +
        'diffuseColor.a = smoothstep(alphaTest - strandAA, alphaTest + strandAA, diffuseColor.a);\n' +
        'if (diffuseColor.a <= 0.001) discard;\n#endif'
      );

      // Keep the fibre coverage, which three's opaque output would reset to 1.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        'float strandCoverage = diffuseColor.a;\n#include <opaque_fragment>\n' +
        '#ifdef USE_ALPHAMAP\ngl_FragColor.a = strandCoverage;\n#endif'
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        [
          '#ifdef USE_ALPHAMAP',
          '{',
          // Strand direction from screen-space derivatives: the way v increases across the card.
          '  vec3 dPdx = dFdx( - vViewPosition );',
          '  vec3 dPdy = dFdy( - vViewPosition );',
          '  vec2 dUx = dFdx( vAlphaMapUv );',
          '  vec2 dUy = dFdy( vAlphaMapUv );',
          '  float det = dUx.x * dUy.y - dUy.x * dUx.y;',
          '  vec3 tv = dPdy * dUx.x - dPdx * dUy.x;',
          // Bad UVs give a garbage direction, so keep the default instead of flickering.
          '  if ( abs( det ) > 1e-9 && dot( tv, tv ) > 1e-12 ) {',
          '    gStrandT = normalize( tv / det );',
          '  }',
          '}',
          '#else',
          // No UV: use the normal nudged toward view-up as a stand-in direction.
          '  gStrandT = normalize( normal + vec3( 0.0, 0.55, 0.0 ) );',
          '#endif',
          '#ifdef HAIR_FIBRES',
          '  gStrandT = normalize(vHairTangent);',
          '#endif',
          '#include <lights_fragment_begin>',
        ].join('\n')
      );

      // Fresnel rim so the hair mass catches light at grazing angles, added after the light loop.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        [
          '#include <aomap_fragment>',
          '#ifdef USE_ALPHAMAP',
          // Keep ambient fill but reduce the plastic-looking reflection.
          'reflectedLight.indirectSpecular *= 0.45;',
          '#endif',
          '#ifndef FLAT_SHADED',
          '{',
          '  vec3 sV = normalize( vViewPosition );',
          '  float fres = pow( 1.0 - clamp( dot( normal, sV ), 0.0, 1.0 ), 3.0 );',
          '  reflectedLight.directSpecular += uSheenTint * uRimStrength * fres;',
          '}',
          '#endif',
        ].join('\n')
      );
    };

    // Give each variant its own cache key so they don't share a compiled shader.
    material.customProgramCacheKey = () =>
      'strand-v4' + (typeof priorKey === 'function' ? '|' + priorKey.call(material) : '');
    material.needsUpdate = true;
    return material;
  }
}

window.StrandShading = StrandShading;
