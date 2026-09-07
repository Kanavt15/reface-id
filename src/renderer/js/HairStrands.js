/** Reconstruct curved fibres from the imported cards, which remain style guides.
 * The small ribbons have their own tangent, diameter, pigment and tapered tips.
 * No rendered polygon spans the width of an original clump.
 */
class HairStrands {
  // Used by both visible and shadow passes so extra density casts matching
  // shadows. Layer zero is the original groom, including its strand IDs.
  static layerVertexGLSL() {
    return `
      attribute float aHairLayer;
      varying float vHairLayer;
      vec3 hairLayerOffset(vec3 tangent, vec3 surfaceNormal, float id, float width) {
        if (aHairLayer < 0.5) return vec3(0.0);
        vec3 across = normalize(cross(tangent, surfaceNormal));
        float lateral = fract(sin(id * 127.1 + aHairLayer * 311.7) * 43758.5453) * 2.0 - 1.0;
        float lift = fract(sin(id * 269.5 + aHairLayer * 183.3) * 43758.5453) * 2.0 - 1.0;
        return (across * lateral + surfaceNormal * lift * 0.65) * width * 7.0 * aHairLayer;
      }
    `;
  }

  static build(geometries, style) {
    const cache = this._cache || (this._cache = new Map());
    const active = this._active || (this._active = {});
    active[style.startsWith('hair') ? 'hair' : 'beard'] = style;
    if (cache.has(style)) {
      const value = cache.get(style); cache.delete(style); cache.set(style, value);
      return value;
    }
    const box = new THREE.Box3();
    for (const g of geometries) { g.computeBoundingBox(); box.union(g.boundingBox); }
    const span = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1e-6);
    const coarse = !style.startsWith('hair');
    let seed = [...style].reduce((s, c) => s * 31 + c.charCodeAt(0), 23) >>> 0;
    const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
    const guides = geometries.map(g => style === 'beard1' ? this._surfaceGuides(g, span, random) : this._guides(g));
    const totalWidth = guides.flat().reduce((sum, c) => sum + c.width, 0);
    const budget = ({ beard1: 14000, beard2: 16000, beard3: 8000, beard4: 5500, beard5: 12000, beard6: 13000, moustache1: 1800 })[style] || 32000;
    const result = geometries.map((g, i) => this._grow(g, guides[i], { span, coarse, random, totalWidth, budget }));
    cache.set(style, result);
    for (const [key, geos] of cache) {
      if (cache.size <= 2) break;
      if (Object.values(active).includes(key)) continue;
      for (const g of geos) g.dispose();
      cache.delete(key);
    }
    return result;
  }

  static _surfaceGuides(g, span, random) {
    const pos = g.attributes.position, norm = g.attributes.normal, index = g.index;
    const guides = [];
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    // Beard 1 includes a continuous foundation, not a hair card. Distribute
    // follicles over its surface rather than wrapping one tuft across it.
    for (let t = 0; t < index.count; t += 3) {
      const ids = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      ids.forEach((id, i) => p[i].fromBufferAttribute(pos, id));
      const area = p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])).length() * 0.5;
      const count = Math.max(0, Math.round(area / (span * span) * 12000 + random() - 0.5));
      for (let n = 0; n < count; n++) {
        const a = Math.sqrt(random()), b = random(), weights = [1 - a, a * (1 - b), a * b];
        const point = new THREE.Vector3(), normal = new THREE.Vector3();
        ids.forEach((id, i) => {
          point.addScaledVector(p[i], weights[i]);
          normal.addScaledVector(new THREE.Vector3().fromBufferAttribute(norm, id), weights[i]);
        });
        normal.normalize();
        const down = new THREE.Vector3(0, -1, 0.12);
        down.addScaledVector(normal, -down.dot(normal)).normalize();
        if (down.lengthSq() < 0.1) down.set(0, -1, 0);
        const across = new THREE.Vector3().crossVectors(down, normal).normalize();
        const length = span * (0.025 + random() * 0.045), phase = random() * Math.PI * 2;
        const source = ids[weights.indexOf(Math.max(...weights))];
        const rows = [];
        for (let k = 0; k <= 6; k++) {
          const v = k / 6;
          const q = point.clone().addScaledVector(down, length * v)
            .addScaledVector(normal, length * 0.22 * v * v)
            .addScaledVector(across, Math.sin(v * 5 + phase) * length * 0.10 * v);
          rows.push({ left: { p: q.clone().addScaledVector(across, -span * 0.0004), source }, right: { p: q.clone().addScaledVector(across, span * 0.0004), source } });
        }
        guides.push({ rows, width: span * 0.0008, single: true });
      }
    }
    return guides;
  }

  static attachShadows(mesh, material) {
    const cache = this._shadows || (this._shadows = new WeakMap());
    if (!cache.has(material)) {
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      const distance = new THREE.MeshDistanceMaterial();
      for (const mat of [depth, distance]) {
        mat.onBeforeCompile = shader => {
          shader.uniforms.uHairDensity = material.userData.strandSheen.uniforms.uHairDensity;
          shader.vertexShader = HairStrands.layerVertexGLSL() + 'attribute vec3 aHairTangent;\nattribute float aHairWidth;\nattribute vec3 aHairFiber;\nvarying vec3 vHairFiber;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += hairLayerOffset(aHairTangent, normal, aHairFiber.z, aHairWidth);\nvHairLayer = aHairLayer;\nvHairFiber = aHairFiber;\nvHairFiber.z = fract(aHairFiber.z + aHairLayer * 0.381966);');
          shader.fragmentShader = 'uniform float uHairDensity;\nvarying float vHairLayer;\nvarying vec3 vHairFiber;\n' + shader.fragmentShader
            .replace('#include <alphamap_fragment>', '')
            .replace('#include <alphatest_fragment>', '#ifdef USE_ALPHATEST\nif (vHairFiber.z < max(0.0, alphaTest - 0.14) * 0.8 || vHairFiber.y < 0.012) discard;\nif (vHairLayer > 0.5 && vHairFiber.z >= uHairDensity - vHairLayer) discard;\n#endif');
        };
        mat.customProgramCacheKey = () => 'hair-fibre-shadow-v4';
      }
      material.addEventListener('dispose', () => { depth.dispose(); distance.dispose(); cache.delete(material); });
      cache.set(material, { depth, distance });
    }
    const { depth, distance } = cache.get(material);
    mesh.customDepthMaterial = depth; mesh.customDistanceMaterial = distance;
  }

  static _guides(g) {
    const pos = g.attributes.position, uv = g.attributes.uv, index = g.index;
    const parent = Int32Array.from({ length: pos.count }, (_, i) => i);
    const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const triangles = [];
    for (let i = 0; i < (index ? index.count : pos.count); i += 3) {
      const t = [0, 1, 2].map(k => index ? index.getX(i + k) : i + k);
      parent[root(t[1])] = parent[root(t[2])] = root(t[0]); triangles.push(t);
    }
    const components = new Map();
    for (const t of triangles) {
      const id = root(t[0]);
      if (!components.has(id)) components.set(id, []);
      components.get(id).push(t);
    }
    const guides = [];
    for (const tris of components.values()) {
      const ids = [...new Set(tris.flat())];
      let minV = Infinity, maxV = -Infinity;
      for (const i of ids) { minV = Math.min(minV, uv.getY(i)); maxV = Math.max(maxV, uv.getY(i)); }
      if (maxV - minV < 1e-6) continue;
      const rows = [];
      // Intersections with iso-v planes recover the actual bends of a card.
      // Sample within the boundary to avoid coincident-edge ambiguities.
      for (let row = 0; row <= 12; row++) {
        const v = minV + (maxV - minV) * (0.0001 + row / 12 * 0.9998);
        const hits = [];
        for (const tri of tris) for (let edge = 0; edge < 3; edge++) {
          const a = tri[edge], b = tri[(edge + 1) % 3];
          const va = uv.getY(a), vb = uv.getY(b);
          if (Math.abs(va - vb) < 1e-8 || v < Math.min(va, vb) || v > Math.max(va, vb)) continue;
          const t = (v - va) / (vb - va);
          const p = new THREE.Vector3().fromBufferAttribute(pos, a).lerp(new THREE.Vector3().fromBufferAttribute(pos, b), t);
          hits.push({ u: uv.getX(a) * (1 - t) + uv.getX(b) * t, p, source: t < 0.5 ? a : b });
        }
        if (hits.length < 2) continue;
        hits.sort((a, b) => a.u - b.u);
        rows.push({ left: hits[0], right: hits[hits.length - 1] });
      }
      if (rows.length < 2) continue;
      const width = rows.reduce((sum, r) => sum + r.left.p.distanceTo(r.right.p), 0) / rows.length;
      guides.push({ rows, width });
    }
    return guides;
  }

  static _grow(source, guides, { span, coarse, random, totalWidth, budget }) {
    const positions = [], normals = [], tangents = [], uvs = [], fibres = [], widths = [], depths = [], indices = [];
    const sourceDepth = source.attributes.aStrandDepth;
    const diameter = span * (coarse ? 0.00085 : 0.00095);
    let strandCount = 0;
    for (const guide of guides) {
      const { rows, width } = guide;
      const count = guide.single ? 1 : Math.max(1, Math.min(640, Math.round(budget * width / Math.max(totalWidth, 1e-8))));
      for (let s = 0; s < count; s++) {
        const u = (s + 0.15 + random() * 0.7) / count;
        const id = random(), phase = random() * Math.PI * 2;
        const flyaway = random() < 0.025;
        const length = 0.65 + random() * 0.35;
        const rootStart = random() * (coarse ? 0.12 : 0.085);
        const thick = diameter * (0.65 + random() * 0.7) * (flyaway ? 0.7 : 1);
        const lift = diameter * (random() - 0.3) * 9 + (flyaway ? span * (0.002 + random() * 0.006) : 0);
        const points = rows.map((row, r) => {
          const v = r / (rows.length - 1);
          const across = new THREE.Vector3().subVectors(row.right.p, row.left.p).normalize();
          const prev = rows[Math.max(0, r - 1)], next = rows[Math.min(rows.length - 1, r + 1)];
          const tangent = next.left.p.clone().lerp(next.right.p, u).sub(prev.left.p.clone().lerp(prev.right.p, u)).normalize();
          const normal = new THREE.Vector3().crossVectors(across, tangent).normalize();
          const p = row.left.p.clone().lerp(row.right.p, u);
          const spread = Math.max(0, width * 0.28 - row.left.p.distanceTo(row.right.p)) * (Math.pow(v, 3) + Math.pow(1 - v, 3));
          p.addScaledVector(across, (u - 0.5) * spread);
          // Small independent departures break the original sheet's plane.
          const wave = Math.sin(v * Math.PI * (coarse ? 3 : 1.5) + phase) * Math.sin(v * Math.PI);
          p.addScaledVector(normal, lift * Math.sin(v * Math.PI));
          p.addScaledVector(across, wave * diameter * (coarse ? 2.5 : 1.5));
          return p;
        });
        // Remove angular changes inherited from the low polygon guides.
        for (let pass = 0; pass < 2; pass++) {
          const smooth = points.map(p => p.clone());
          for (let i = 1; i < points.length - 1; i++) points[i].copy(smooth[i]).multiplyScalar(0.5).addScaledVector(smooth[i - 1], 0.25).addScaledVector(smooth[i + 1], 0.25);
        }
        const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
        const curveLength = points.reduce((sum, p, i) => i ? sum + p.distanceTo(points[i - 1]) : sum, 0);
        const segments = Math.max(5, Math.min(20, Math.ceil(curveLength / span * 48)));
        const start = positions.length / 3;
        const previousAcross = new THREE.Vector3();
        for (let k = 0; k <= segments; k++) {
          const v = k / segments, t = rootStart + v * (length - rootStart);
          const p = curve.getPoint(t), tangent = curve.getTangent(t).normalize();
          const rowIndex = Math.min(rows.length - 1, Math.round(t * (rows.length - 1)));
          const row = rows[rowIndex];
          const across = row.right.p.clone().sub(row.left.p);
          across.addScaledVector(tangent, -across.dot(tangent)).normalize();
          if (across.lengthSq() < 0.1) across.copy(previousAcross);
          previousAcross.copy(across);
          const normal = new THREE.Vector3().crossVectors(across, tangent).normalize();
          const taper = Math.max(0.015, Math.pow(1 - v, 0.35)) * Math.min(1, 0.45 + v * 12);
          const sourceIndex = u < 0.5 ? row.left.source : row.right.source;
          for (const side of [-1, 1]) {
            const q = p.clone().addScaledVector(across, side * thick * taper * 0.5);
            positions.push(q.x, q.y, q.z); normals.push(normal.x, normal.y, normal.z);
            tangents.push(tangent.x, tangent.y, tangent.z);
            // Keep the style's generated pigment atlas; opacity is evaluated
            // for this individual fibre, independently of the old card UVs.
            uvs.push(0.005 + id * 0.99, 0.002 + v * 0.996);
            fibres.push(side, v, id);
            widths.push(thick * taper * 0.5);
            depths.push(sourceDepth ? sourceDepth.getX(sourceIndex) : 0);
          }
          if (k < segments) {
            const a = start + k * 2;
            indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
        strandCount++;
      }
    }
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.instanceCount = 1;
    geometry.setAttribute('aHairLayer', new THREE.InstancedBufferAttribute(new Float32Array([0, 1, 2]), 1));
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('aHairTangent', new THREE.Float32BufferAttribute(tangents, 3));
    geometry.setAttribute('aHairFiber', new THREE.Float32BufferAttribute(fibres, 3));
    geometry.setAttribute('aHairWidth', new THREE.Float32BufferAttribute(widths, 1));
    geometry.setAttribute('aStrandDepth', new THREE.Float32BufferAttribute(depths, 1));
    geometry.setIndex(indices);
    geometry.userData = { ...source.userData, strandGeometryVersion: 3, strandCount, strandSourceVertexCount: source.attributes.position.count };
    // Alignment uses the imported style's bounds, so shorter individual tips
    // cannot shift or enlarge the entire hairstyle when it is regenerated.
    geometry.boundingBox = source.boundingBox.clone();
    geometry.computeBoundingSphere();
    geometry.boundingSphere.radius += span * 0.015;
    return geometry;
  }
}
window.HairStrands = HairStrands;
