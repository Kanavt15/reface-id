/**
 * OBJLoader for Three.js
 * Simplified OBJ loader for loading base face models.
 * Bundled for offline Electron use.
 */

THREE.OBJLoader = function (manager) {
  this.manager = manager !== undefined ? manager : THREE.DefaultLoadingManager;
  this.materials = null;
};

THREE.OBJLoader.prototype = {
  constructor: THREE.OBJLoader,

  load: function (url, onLoad, onProgress, onError) {
    const scope = this;
    const loader = new THREE.FileLoader(this.manager);
    loader.setPath(this.path);
    loader.setRequestHeader(this.requestHeader);
    loader.setWithCredentials(this.withCredentials);
    loader.load(url, function (text) {
      try {
        onLoad(scope.parse(text));
      } catch (e) {
        if (onError) {
          onError(e);
        } else {
          console.error(e);
        }
      }
    }, onProgress, onError);
  },

  setPath: function (value) {
    this.path = value;
    return this;
  },

  setRequestHeader: function (value) {
    this.requestHeader = value;
    return this;
  },

  setWithCredentials: function (value) {
    this.withCredentials = value;
    return this;
  },

  parse: function (text) {
    const lines = text.split('\n');
    const vertices = [];
    const normals = [];
    const uvs = [];

    // Each object/group declared via `o <name>` or `g <name>` becomes its own
    // segment with its own face buffer. Files that don't declare any object
    // get a single anonymous segment, preserving prior single-mesh behavior
    // for callers like SceneManager.loadOBJ that load a single-object head.
    const segments = [];
    let current = { name: '', faceVertices: [], faceNormals: [], faceUVs: [] };
    segments.push(current);

    const startSegment = (name) => {
      // If the existing segment has no faces yet, just rename it — avoids
      // emitting an empty mesh when `o`/`g` appears before any face data.
      if (current.faceVertices.length === 0) {
        current.name = name;
      } else {
        current = { name, faceVertices: [], faceNormals: [], faceUVs: [] };
        segments.push(current);
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0 || line.charAt(0) === '#') continue;

      const parts = line.split(/\s+/);
      const keyword = parts[0];

      if (keyword === 'v') {
        vertices.push(
          parseFloat(parts[1]),
          parseFloat(parts[2]),
          parseFloat(parts[3])
        );
      } else if (keyword === 'vn') {
        normals.push(
          parseFloat(parts[1]),
          parseFloat(parts[2]),
          parseFloat(parts[3])
        );
      } else if (keyword === 'vt') {
        uvs.push(
          parseFloat(parts[1]),
          parseFloat(parts[2])
        );
      } else if (keyword === 'o' || keyword === 'g') {
        startSegment(parts.slice(1).join(' ') || '');
      } else if (keyword === 'f') {
        const faceVerts = [];
        const faceNorms = [];
        const faceTexs = [];

        for (let j = 1; j < parts.length; j++) {
          const indices = parts[j].split('/');
          faceVerts.push(parseInt(indices[0]) - 1);
          if (indices[1]) faceTexs.push(parseInt(indices[1]) - 1);
          if (indices[2]) faceNorms.push(parseInt(indices[2]) - 1);
        }

        // Triangulate (fan triangulation for n-gons)
        for (let j = 1; j < faceVerts.length - 1; j++) {
          current.faceVertices.push(faceVerts[0], faceVerts[j], faceVerts[j + 1]);
          if (faceNorms.length > 0) {
            current.faceNormals.push(faceNorms[0], faceNorms[j], faceNorms[j + 1]);
          }
          if (faceTexs.length > 0) {
            current.faceUVs.push(faceTexs[0], faceTexs[j], faceTexs[j + 1]);
          }
        }
      }
    }

    const group = new THREE.Group();

    for (const seg of segments) {
      if (seg.faceVertices.length === 0) continue;

      const geometry = new THREE.BufferGeometry();
      const posArray = new Float32Array(seg.faceVertices.length * 3);
      const hasNormals = normals.length > 0 && seg.faceNormals.length > 0;
      const hasUVs = uvs.length > 0 && seg.faceUVs.length > 0;
      const normArray = hasNormals ? new Float32Array(seg.faceVertices.length * 3) : null;
      const uvArray = hasUVs ? new Float32Array(seg.faceVertices.length * 2) : null;

      for (let i = 0; i < seg.faceVertices.length; i++) {
        const vi = seg.faceVertices[i];
        posArray[i * 3]     = vertices[vi * 3];
        posArray[i * 3 + 1] = vertices[vi * 3 + 1];
        posArray[i * 3 + 2] = vertices[vi * 3 + 2];

        if (normArray && seg.faceNormals[i] !== undefined) {
          const ni = seg.faceNormals[i];
          normArray[i * 3]     = normals[ni * 3];
          normArray[i * 3 + 1] = normals[ni * 3 + 1];
          normArray[i * 3 + 2] = normals[ni * 3 + 2];
        }

        if (uvArray && seg.faceUVs[i] !== undefined) {
          const ti = seg.faceUVs[i];
          uvArray[i * 2]     = uvs[ti * 2];
          uvArray[i * 2 + 1] = uvs[ti * 2 + 1];
        }
      }

      geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
      if (normArray) {
        geometry.setAttribute('normal', new THREE.BufferAttribute(normArray, 3));
      } else {
        geometry.computeVertexNormals();
      }
      if (uvArray) {
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
      }

      const material = new THREE.MeshStandardMaterial({
        color: 0xd4a574,
        roughness: 0.5,
        metalness: 0.05,
      });

      const mesh = new THREE.Mesh(geometry, material);
      if (seg.name) mesh.name = seg.name;
      group.add(mesh);
    }

    // Edge case: malformed file with no faces at all — return an empty group
    // rather than a mesh with zero-length attributes. Callers already handle
    // empty groups gracefully.
    return group;
  }
};
