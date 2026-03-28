/**
 * DecalGeometry.js
 * Adapted from three/examples/jsm/geometries/DecalGeometry.js (r160)
 * Converted to global THREE namespace for non-module usage.
 *
 * Projects a flat texture onto an arbitrary mesh surface, conforming
 * to the curvature. Used for tattoos, birthmarks, and skin decals.
 */

(function () {
  'use strict';

  const _plane = new THREE.Vector3();

  class DecalVertex {
    constructor(position, normal) {
      this.position = position;
      this.normal = normal;
    }
    clone() {
      return new DecalVertex(this.position.clone(), this.normal.clone());
    }
  }

  class DecalGeometry extends THREE.BufferGeometry {
    constructor(mesh, position, orientation, size) {
      super();

      // buffers
      const vertices = [];
      const normals = [];
      const uvs = [];

      // helpers
      const projectorMatrix = new THREE.Matrix4();
      const projectorMatrixInverse = new THREE.Matrix4();

      const decalNormal = new THREE.Vector3();
      const decalPosition = new THREE.Vector3();
      const decalSize = new THREE.Vector3();

      decalPosition.copy(position);
      decalSize.copy(size);

      // build the basis from the orientation (Euler)
      projectorMatrix.makeRotationFromEuler(orientation);
      projectorMatrix.setPosition(position);

      projectorMatrixInverse.copy(projectorMatrix).invert();

      // generate geometry
      generate();

      // functions

      function generate() {
        let meshGeometry;

        const isMesh = mesh.isMesh;

        if (isMesh) {
          mesh.updateMatrixWorld(true);

          // Use the mesh geometry or the first child mesh geometry
          if (mesh.geometry) {
            meshGeometry = mesh.geometry;
            pushDecalGeometry(mesh, meshGeometry);
          } else {
            mesh.traverse((child) => {
              if (child.isMesh && child.geometry) {
                pushDecalGeometry(child, child.geometry);
              }
            });
          }
        } else {
          // It's a group — traverse children
          mesh.traverse((child) => {
            if (child.isMesh && child.geometry) {
              pushDecalGeometry(child, child.geometry);
            }
          });
        }

        setAttributes();
      }

      function pushDecalGeometry(targetMesh, geometry) {
        let decalVertices = [];

        const positionAttribute = geometry.attributes.position;
        const normalAttribute = geometry.attributes.normal;

        // if the mesh is indexed, convert faces
        if (geometry.index !== null) {
          const index = geometry.index;

          for (let i = 0; i < index.count; i += 3) {
            const a = index.getX(i);
            const b = index.getX(i + 1);
            const c = index.getX(i + 2);

            decalVertices = clipFace(
              pushVertex(decalVertices, positionAttribute, normalAttribute, a, targetMesh),
              targetMesh
            );
            decalVertices = clipFace(
              pushVertex(decalVertices, positionAttribute, normalAttribute, b, targetMesh),
              targetMesh
            );
            decalVertices = clipFace(
              pushVertex(decalVertices, positionAttribute, normalAttribute, c, targetMesh),
              targetMesh
            );
          }
        } else {
          for (let i = 0; i < positionAttribute.count; i += 3) {
            decalVertices = clipFace(
              pushVertex(decalVertices, positionAttribute, normalAttribute, i, targetMesh),
              targetMesh
            );
            decalVertices = clipFace(
              pushVertex(decalVertices, positionAttribute, normalAttribute, i + 1, targetMesh),
              targetMesh
            );
            decalVertices = clipFace(
              pushVertex(decalVertices, positionAttribute, normalAttribute, i + 2, targetMesh),
              targetMesh
            );
          }
        }
      }

      function pushVertex(decalVertices, positionAttribute, normalAttribute, index, targetMesh) {
        const vertex = new DecalVertex(
          new THREE.Vector3().fromBufferAttribute(positionAttribute, index).applyMatrix4(targetMesh.matrixWorld),
          new THREE.Vector3().fromBufferAttribute(normalAttribute, index)
        );

        // transform the normal to world space
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(targetMesh.matrixWorld);
        vertex.normal.applyMatrix3(normalMatrix);
        vertex.normal.normalize();

        decalVertices.push(vertex);

        return decalVertices;
      }

      function clipFace(inVertices, targetMesh) {
        if (inVertices.length < 3) return inVertices;

        // Only process complete triangles
        const triStart = inVertices.length - 3;
        let triangle = [
          inVertices[triStart],
          inVertices[triStart + 1],
          inVertices[triStart + 2],
        ];

        // Remove the last 3 vertices (we'll add back the clipped version)
        inVertices.length = triStart;

        // Clip against all 6 planes of the projector
        triangle = clipTriangle(triangle, new THREE.Vector3(1, 0, 0));
        triangle = clipTriangle(triangle, new THREE.Vector3(-1, 0, 0));
        triangle = clipTriangle(triangle, new THREE.Vector3(0, 1, 0));
        triangle = clipTriangle(triangle, new THREE.Vector3(0, -1, 0));
        triangle = clipTriangle(triangle, new THREE.Vector3(0, 0, 1));
        triangle = clipTriangle(triangle, new THREE.Vector3(0, 0, -1));

        // Triangulate the result
        for (let i = 1; i < triangle.length - 1; i++) {
          const v0 = triangle[0];
          const v1 = triangle[i];
          const v2 = triangle[i + 1];

          vertices.push(v0.position.x, v0.position.y, v0.position.z);
          vertices.push(v1.position.x, v1.position.y, v1.position.z);
          vertices.push(v2.position.x, v2.position.y, v2.position.z);

          normals.push(v0.normal.x, v0.normal.y, v0.normal.z);
          normals.push(v1.normal.x, v1.normal.y, v1.normal.z);
          normals.push(v2.normal.x, v2.normal.y, v2.normal.z);

          // Generate UVs from projector space
          const uv0 = getUV(v0);
          const uv1 = getUV(v1);
          const uv2 = getUV(v2);

          uvs.push(uv0.x, uv0.y);
          uvs.push(uv1.x, uv1.y);
          uvs.push(uv2.x, uv2.y);
        }

        return inVertices;
      }

      function clipTriangle(triangle, plane) {
        if (triangle.length === 0) return triangle;

        const s = 0.5 * Math.abs(decalSize.dot(plane));
        const result = [];

        // Classify all vertices
        for (let i = 0; i < triangle.length; i++) {
          const v0 = triangle[i];
          const v1 = triangle[(i + 1) % triangle.length];

          const p0 = v0.position.clone().applyMatrix4(projectorMatrixInverse);
          const p1 = v1.position.clone().applyMatrix4(projectorMatrixInverse);

          const d0 = p0.dot(plane) - s;
          const d1 = p1.dot(plane) - s;

          const inside0 = d0 <= 0;
          const inside1 = d1 <= 0;

          if (inside0) result.push(v0);

          if (inside0 !== inside1) {
            // Edge crosses the plane — compute intersection
            const t = d0 / (d0 - d1);
            const intersection = new DecalVertex(
              new THREE.Vector3().lerpVectors(v0.position, v1.position, t),
              new THREE.Vector3().lerpVectors(v0.normal, v1.normal, t).normalize()
            );
            result.push(intersection);
          }
        }

        return result;
      }

      function getUV(vertex) {
        const p = vertex.position.clone().applyMatrix4(projectorMatrixInverse);

        return new THREE.Vector2(
          0.5 + (p.x / decalSize.x),
          0.5 + (p.y / decalSize.y)
        );
      }

      function setAttributes() {
        const geo = DecalGeometry.prototype; // unused, we set on `this`
        // Actually set on the instance — use the outer scope reference
      }

      // Set buffer attributes
      this.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      this.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      this.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    }
  }

  // Expose on THREE global
  THREE.DecalGeometry = DecalGeometry;

})();
