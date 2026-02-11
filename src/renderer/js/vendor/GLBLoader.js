/**
 * GLBLoader.js
 * Minimal GLB (Binary glTF 2.0) loader for Three.js.
 * Handles a single mesh with POSITION, NORMAL, TEXCOORD_0 attributes.
 * Designed for the REface ID forensic reconstruction app.
 */

THREE.GLBLoader = function (manager) {
  this.manager = manager || THREE.DefaultLoadingManager;
};

THREE.GLBLoader.prototype = {
  constructor: THREE.GLBLoader,

  load: function (url, onLoad, onProgress, onError) {
    const scope = this;
    const loader = new THREE.FileLoader(this.manager);
    loader.setResponseType('arraybuffer');
    loader.load(url, function (data) {
      try {
        const result = scope.parse(data);
        if (onLoad) onLoad(result);
      } catch (e) {
        if (onError) onError(e);
        else console.error('GLBLoader:', e);
      }
    }, onProgress, onError);
  },

  parse: function (buffer) {
    const dataView = new DataView(buffer);
    let offset = 0;

    // ── Header ──
    const magic = dataView.getUint32(offset, true); offset += 4;
    if (magic !== 0x46546C67) throw new Error('Not a valid GLB file');
    const version = dataView.getUint32(offset, true); offset += 4;
    const totalLength = dataView.getUint32(offset, true); offset += 4;

    // ── Chunk 0: JSON ──
    const jsonChunkLen = dataView.getUint32(offset, true); offset += 4;
    const jsonChunkType = dataView.getUint32(offset, true); offset += 4;
    const jsonBytes = new Uint8Array(buffer, offset, jsonChunkLen);
    const jsonStr = new TextDecoder().decode(jsonBytes);
    const gltf = JSON.parse(jsonStr);
    offset += jsonChunkLen;

    // ── Chunk 1: Binary ──
    let binData = null;
    if (offset < totalLength) {
      const binChunkLen = dataView.getUint32(offset, true); offset += 4;
      const binChunkType = dataView.getUint32(offset, true); offset += 4;
      binData = buffer.slice(offset, offset + binChunkLen);
    }
    if (!binData) throw new Error('GLB has no binary chunk');

    const accessors = gltf.accessors || [];
    const bufferViews = gltf.bufferViews || [];

    // Helper: read accessor data
    function getAccessorData(accIdx) {
      const acc = accessors[accIdx];
      const bv = bufferViews[acc.bufferView];
      const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const count = acc.count;

      // Component sizes
      const compSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
      const compBytes = compSize[acc.componentType];

      // Element sizes
      const elemCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
      const elems = elemCount[acc.type];

      const stride = bv.byteStride || (compBytes * elems);
      const isInterleaved = bv.byteStride && bv.byteStride !== compBytes * elems;

      if (!isInterleaved) {
        // Tightly packed
        if (acc.componentType === 5126) {
          return new Float32Array(binData, byteOffset, count * elems);
        } else if (acc.componentType === 5123) {
          return new Uint16Array(binData, byteOffset, count * elems);
        } else if (acc.componentType === 5125) {
          return new Uint32Array(binData, byteOffset, count * elems);
        }
      }

      // Interleaved fallback
      const result = acc.componentType === 5126
        ? new Float32Array(count * elems)
        : new Uint32Array(count * elems);
      const srcView = new DataView(binData);
      for (let i = 0; i < count; i++) {
        const base = byteOffset + i * stride;
        for (let j = 0; j < elems; j++) {
          if (acc.componentType === 5126) {
            result[i * elems + j] = srcView.getFloat32(base + j * 4, true);
          } else if (acc.componentType === 5123) {
            result[i * elems + j] = srcView.getUint16(base + j * 2, true);
          } else if (acc.componentType === 5125) {
            result[i * elems + j] = srcView.getUint32(base + j * 4, true);
          }
        }
      }
      return result;
    }

    // ── Build meshes ──
    const group = new THREE.Group();
    group.name = 'GLBModel';

    const meshes = gltf.meshes || [];
    for (let mi = 0; mi < meshes.length; mi++) {
      const meshDef = meshes[mi];
      const primitives = meshDef.primitives || [];

      for (let pi = 0; pi < primitives.length; pi++) {
        const prim = primitives[pi];
        const geometry = new THREE.BufferGeometry();

        // Position
        if (prim.attributes.POSITION !== undefined) {
          const posData = getAccessorData(prim.attributes.POSITION);
          geometry.setAttribute('position', new THREE.BufferAttribute(posData, 3));
        }

        // Normal
        if (prim.attributes.NORMAL !== undefined) {
          const normData = getAccessorData(prim.attributes.NORMAL);
          geometry.setAttribute('normal', new THREE.BufferAttribute(normData, 3));
        }

        // UV
        if (prim.attributes.TEXCOORD_0 !== undefined) {
          const uvData = getAccessorData(prim.attributes.TEXCOORD_0);
          geometry.setAttribute('uv', new THREE.BufferAttribute(uvData, 2));
        }

        // Indices
        if (prim.indices !== undefined) {
          const idxData = getAccessorData(prim.indices);
          geometry.setIndex(new THREE.BufferAttribute(idxData, 1));
        }

        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        if (!prim.attributes.NORMAL) geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
          color: 0xd4a574,
          roughness: 0.65,
          metalness: 0.05,
          side: THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = meshDef.name || ('mesh_' + mi + '_' + pi);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }

    return group;
  },
};
