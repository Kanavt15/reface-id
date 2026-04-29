/**
 * GlassesSystem.js – GLB-based glasses/spectacles for forensic facial reconstruction.
 *
 * Loads a glasses GLB model and aligns it to the nose bridge / temples.
 * Mirrors the patterns used by EyeSystem.js and HairSystem.js so it follows
 * head tracking automatically (HeadTracker reparents glassesGroup into the
 * pivot group).
 *
 * Note (export): The glasses GLB is a separate scene object from the head
 * mesh. Screenshots capture it automatically because it lives in the same
 * Three.js scene. For future Blender export support, the glasses container
 * matrix can be merged with the head mesh — see getRenderTransform().
 */

// ── Asset path constants ────────────────────────────────────────────────────
// Update these paths if the GLB files are moved.
const GLASSES_MODEL_PATH_DEFAULT = '../../assets/Glasses/Glasses_01.obj';
const GLASSES_MODEL_PATH_STYLE2  = '../../assets/Glasses/glasses.obj';
const GLASSES_MODEL_PATH_STYLE3  = '../../assets/Glasses/Glasses_03.obj';
const GLASSES_MODEL_PATH_STYLE4  = '../../assets/Glasses/Glasses_04.obj';

class GlassesSystem {
  constructor(scene) {
    this.scene = scene;

    // Scene group — HeadTracker.js looks for this.glassesGroup by name to
    // reparent into the head-tracking pivot, matching HairSystem/EyeSystem.
    this.glassesGroup = new THREE.Group();
    this.glassesGroup.name = 'GlassesSystem';
    this.scene.add(this.glassesGroup);

    // Head references (set by setHeadMesh)
    this._headGroup = null;
    this._regionData = null;
    this._morpher = null;
    this._faceMorphValues = null;

    // State
    this.enabled = false;
    this.currentStyle = 'glasses1';
    this.frameColor = '#1a1a1a';
    this.lensColor = '#88ccff';
    this.lensOpacity = 20;        // 0..100 — 0 = clear, 100 = fully tinted

    // User fine-tune sliders
    this.params = {
      scale: 100,    // 50..200  — uniform fit
      lensScale: 100, // 50..150  — scales lens meshes only (around their own center)
      armSplay: 0,   // -45..+45 deg — yaws each temple arm outward around its hinge
      armLength: 100, // 50..200 — scales each arm along its back axis from the hinge
      posX: 0,       // -100..+100 — horizontal shift (left/right)
      posY: 0,       // -100..+100 — vertical placement on bridge (up/down)
      posZ: 0,       // -100..+100 — depth from face surface (forward/back)
      rotX: 0,       // -180..180 deg — pitch (nose-up / nose-down)
      rotY: 0,       // -180..180 deg — yaw (turn left/right)
      rotZ: 0,       // -180..180 deg — roll (tilt / crooked look)
    };

    // Populated during _showCached so _alignAndAdjust can independently scale
    // lens meshes around their own bbox centers.
    this._lensMeshes = [];

    // Left/right temple arm meshes, each pivoted at its hinge so a rotation
    // around `upAxis` ('y' or 'z') yaws the arm outward. `backAxis` is the
    // axis the arm extends along; `backDir` is its sign.
    this._armMeshes = { left: null, right: null, backAxis: 'z', upAxis: 'y', backDir: 1 };

    // Style configs. `loader` defaults to 'glb'; 'obj' uses THREE.OBJLoader and
    // applies a -90° X rotation to convert Blender Z-up exports to Three.js Y-up
    // (matches SceneManager.loadOBJ's convention for the head model).
    this.glassesModels = {
      glasses1: {
        file: GLASSES_MODEL_PATH_DEFAULT, loader: 'obj', meshName: null,
        defaults: {
          scale: 103, lensScale: 100, armSplay: 12, armLength: 119,
          posX: 0, posY: 1, posZ: -83,
          rotX: 89, rotY: 0, rotZ: 0,
          lensOpacity: 71,
        },
      },
      glasses2: {
        file: GLASSES_MODEL_PATH_STYLE2, loader: 'obj', meshName: null,
        // Hand-tuned for the OBJ aviator: it loads in raw model space (huge
        // and rotated) so we apply a known-good starting pose. User can still
        // tweak any slider afterwards.
        defaults: {
          scale: 103, lensScale: 100, armSplay: 11, armLength: 131,
          posX: 0, posY: 7, posZ: -71,
          rotX: 100, rotY: 0, rotZ: 0,
          lensOpacity: 71,
          lensColor: '#000000',
        },
      },
      glasses3: {
        file: GLASSES_MODEL_PATH_STYLE3, loader: 'obj', meshName: null,
        defaults: {
          scale: 117, lensScale: 100, armSplay: 7, armLength: 111,
          posX: 0, posY: -2, posZ: -83,
          rotX: 87, rotY: 0, rotZ: 0,
          lensOpacity: 7,
          lensColor: '#ffffff',
        },
      },
      glasses4: {
        file: GLASSES_MODEL_PATH_STYLE4, loader: 'obj', meshName: null,
        defaults: {
          scale: 92, lensScale: 100, armSplay: 13, armLength: 132,
          posX: 0, posY: -2, posZ: -83,
          rotX: 87, rotY: 0, rotZ: 0,
          lensOpacity: 7,
          lensColor: '#ffffff',
        },
      },
    };

    // Caches
    this._modelCache = {};   // styleName -> THREE.Group
    this._loadId = 0;

    // Current scene container
    this._container = null;
    this._bboxCache = null;

    // Baseline landmark positions captured on first refresh — used for
    // delta-based morph tracking (matches EyeSystem approach).
    this._initialBridgePos = null;
    this._initialTempleLeft = null;
    this._initialTempleRight = null;
    this._initialTempleSpan = null;

    // Materials
    this._frameMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.frameColor),
      roughness: 0.35,
      metalness: 0.55,
      side: THREE.DoubleSide,
    });
    this._lensMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(this.lensColor),
      roughness: 0.05,
      metalness: 0.0,
      transparent: true,
      opacity: this.lensOpacity / 100,
      side: THREE.DoubleSide,
    });

    console.log('[GlassesSystem] Initialized');
  }

  // ── Head binding ────────────────────────────────────────────────────────

  setHeadMesh(headGroup, regionData, morpher) {
    this._headGroup = headGroup;
    this._regionData = regionData;
    this._morpher = morpher || null;
    this._initialBridgePos = null;
    this._initialTempleLeft = null;
    this._initialTempleRight = null;
    this._initialTempleSpan = null;
    this._captureBaselines();
  }

  _captureBaselines() {
    if (!this._morpher || typeof this._morpher.getCurrentLandmarkPosition !== 'function') return;
    const bridge = this._morpher.getCurrentLandmarkPosition('nose_bridge_top');
    const templeL = this._morpher.getCurrentLandmarkPosition('temple_left');
    const templeR = this._morpher.getCurrentLandmarkPosition('temple_right');
    if (bridge) this._initialBridgePos = new THREE.Vector3(bridge[0], bridge[1], bridge[2]);
    if (templeL) this._initialTempleLeft = new THREE.Vector3(templeL[0], templeL[1], templeL[2]);
    if (templeR) this._initialTempleRight = new THREE.Vector3(templeR[0], templeR[1], templeR[2]);
    if (this._initialTempleLeft && this._initialTempleRight) {
      this._initialTempleSpan = Math.abs(this._initialTempleRight.x - this._initialTempleLeft.x);
    }
  }

  /**
   * Called by app.js on every morph update so glasses track facial changes.
   */
  refreshFromMesh(morphValues) {
    if (morphValues) this._faceMorphValues = morphValues;
    if (this._container && this.enabled) {
      this._alignAndAdjust();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.enabled) {
      if (!this._container) {
        this.generate();
      } else {
        this.glassesGroup.visible = true;
        this._alignAndAdjust();
      }
    } else {
      this.glassesGroup.visible = false;
    }
  }

  setStyle(style) {
    const config = this.glassesModels[style];
    if (!config) {
      console.warn('[GlassesSystem] Unknown style:', style);
      return;
    }
    this.currentStyle = style;

    // Apply per-style defaults (only fields that are explicitly set on the
    // config). Falls through silently when defaults is null/undefined.
    const d = config.defaults;
    if (d) {
      for (const key of Object.keys(this.params)) {
        if (d[key] !== undefined) this.params[key] = d[key];
      }
      if (d.lensOpacity !== undefined) this.setLensOpacity(d.lensOpacity);
      if (d.frameColor) this.setFrameColor(d.frameColor);
      if (d.lensColor)  this.setLensColor(d.lensColor);
    }

    if (this.enabled) {
      this.generate();
    }
  }

  setFrameColor(hex) {
    this.frameColor = hex;
    this._frameMat.color.set(hex);
  }

  setLensColor(hex) {
    this.lensColor = hex;
    this._lensMat.color.set(hex);
  }

  setLensOpacity(value) {
    this.lensOpacity = Math.max(0, Math.min(100, value));
    const o = this.lensOpacity / 100;
    this._lensMat.opacity = o;
    this._lensMat.transparent = o < 0.999;
  }

  setParam(param, value) {
    if (this.params[param] === undefined) return;
    this.params[param] = value;
    if (this._container && this.enabled) this._alignAndAdjust();
  }

  getParams() {
    return {
      ...this.params,
      enabled: this.enabled,
      style: this.currentStyle,
      frameColor: this.frameColor,
      lensColor: this.lensColor,
      lensOpacity: this.lensOpacity,
    };
  }

  // ── Generation ──────────────────────────────────────────────────────────

  generate() {
    this._clearGroup(this.glassesGroup);
    this._container = null;
    this._bboxCache = null;

    if (!this.enabled) return;

    const config = this.glassesModels[this.currentStyle];
    if (!config || !config.file) return;

    this._loadId++;
    const thisLoadId = this._loadId;

    if (this._modelCache[this.currentStyle]) {
      if (this._loadId !== thisLoadId) return;
      this._showCached(this.currentStyle);
      return;
    }

    if ((config.loader || 'glb') === 'obj') {
      this._loadOBJ(config, thisLoadId);
      return;
    }

    // We fetch the raw GLB ourselves so we can read node transforms from the
    // glTF JSON. The shared GLBLoader emits a flat list of meshes and ignores
    // node TRS — fine for the hair/beard/eyebrow GLBs (their configs are
    // tuned around that), but the glasses model wraps each mesh in a node
    // with scale=0.01 and translate y=-1.418. Without baking those, the
    // geometry sits ~12 world-units above the head at 100x size and never
    // appears on screen.
    fetch(config.file)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${config.file}`);
        return r.arrayBuffer();
      })
      .then(buffer => {
        if (this._loadId !== thisLoadId) return;
        const loader = new THREE.GLBLoader();
        const group = loader.parse(buffer);
        const nodeXforms = this._readNodeTransforms(buffer);

        // Bake node transforms onto each mesh's geometry, and skip placeholder
        // meshes (e.g. the bare "Cube" at the origin in Glasses_1.glb).
        const baked = new THREE.Group();
        baked.name = group.name;
        group.traverse(child => {
          if (!child.isMesh) return;
          if (this._isPlaceholderMesh(child.name)) return;
          if (config.meshName && child.name !== config.meshName) return;
          const xform = nodeXforms[child.name];
          if (xform) child.geometry.applyMatrix4(xform);
          baked.add(child.clone());
        });

        this._modelCache[this.currentStyle] = baked;
        this._showCached(this.currentStyle);
      })
      .catch(err => {
        console.error('[GlassesSystem] Failed to load model:', config.file, err);
      });
  }

  _loadOBJ(config, thisLoadId) {
    const loader = new THREE.OBJLoader();
    loader.load(
      config.file,
      (group) => {
        if (this._loadId !== thisLoadId) return;

        // Blender's OBJ exporter writes Z-up; Three.js scene is Y-up. Bake a
        // -90° X rotation onto each mesh's geometry so downstream bbox/scale
        // logic in _alignAndAdjust sees correctly oriented coordinates.
        const axisFix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

        const baked = new THREE.Group();
        baked.name = group.name || 'GlassesOBJ';
        group.traverse(child => {
          if (!child.isMesh) return;
          if (this._isPlaceholderMesh(child.name)) return;
          if (config.meshName && child.name !== config.meshName) return;
          child.geometry.applyMatrix4(axisFix);
          baked.add(child.clone());
        });

        this._modelCache[this.currentStyle] = baked;
        this._showCached(this.currentStyle);
      },
      null,
      (err) => { console.error('[GlassesSystem] Failed to load OBJ:', config.file, err); }
    );
  }

  _isPlaceholderMesh(name) {
    if (!name) return false;
    const lower = name.toLowerCase();
    return lower === 'cube' || lower === 'sphere' || lower === 'plane';
  }

  _readNodeTransforms(buffer) {
    try {
      const dv = new DataView(buffer);
      const jsonLen = dv.getUint32(12, true);
      const jsonBytes = new Uint8Array(buffer, 20, jsonLen);
      const gltf = JSON.parse(new TextDecoder().decode(jsonBytes));
      const out = {};
      const meshes = gltf.meshes || [];
      const nodes = gltf.nodes || [];
      for (const n of nodes) {
        if (typeof n.mesh !== 'number') continue;
        const meshName = meshes[n.mesh]?.name;
        if (!meshName) continue;
        const m = new THREE.Matrix4();
        if (n.matrix) {
          m.fromArray(n.matrix);
        } else {
          const t = n.translation || [0, 0, 0];
          const r = n.rotation || [0, 0, 0, 1];
          const s = n.scale || [1, 1, 1];
          m.compose(
            new THREE.Vector3(t[0], t[1], t[2]),
            new THREE.Quaternion(r[0], r[1], r[2], r[3]),
            new THREE.Vector3(s[0], s[1], s[2]),
          );
        }
        out[meshName] = m;
      }
      return out;
    } catch (e) {
      console.warn('[GlassesSystem] Could not read node transforms:', e);
      return {};
    }
  }

  _showCached(style) {
    this._clearGroup(this.glassesGroup);
    this._lensMeshes = [];
    this._armMeshes = { left: null, right: null, backAxis: 'z', upAxis: 'y', backDir: 1 };
    const cached = this._modelCache[style];
    if (!cached) return;

    const container = new THREE.Group();
    container.name = 'GlassesContainer';
    const offsetGroup = new THREE.Group();
    offsetGroup.name = 'GlassesOffset';

    // Two passes: collect lens vs frame meshes first so we know the lens
    // bounding box (used to decide where the arms start when splitting a
    // bundled frame mesh like the OBJ's "the_rest").
    const lensSrc = [];
    const frameSrc = [];
    cached.traverse(child => {
      if (!child.isMesh) return;
      (this._isLensMesh(child) ? lensSrc : frameSrc).push(child);
    });

    const lensBBox = new THREE.Box3();
    for (const src of lensSrc) {
      const halves = this._splitLensHalves(src);
      for (const half of halves) {
        half.material = this._lensMat;
        half.castShadow = true;
        half.receiveShadow = true;
        this._lensMeshes.push(half);
        offsetGroup.add(half);
        // Expand lensBBox in offsetGroup-local space (mesh.position + geometry bbox).
        const gb = half.geometry.boundingBox || half.geometry.computeBoundingBox() || half.geometry.boundingBox;
        if (gb) {
          lensBBox.expandByPoint(new THREE.Vector3(gb.min.x + half.position.x, gb.min.y + half.position.y, gb.min.z + half.position.z));
          lensBBox.expandByPoint(new THREE.Vector3(gb.max.x + half.position.x, gb.max.y + half.position.y, gb.max.z + half.position.z));
        }
      }
    }

    // When no lens meshes exist by name, build a synthetic lensBBox from the
    // "flat" frame pieces — those whose largest off-X extent is under 45 % of
    // their X width. Arm pieces extend much farther in Y or Z and are excluded,
    // so the result approximates the front lens region. This gives
    // _splitFrameAndArms enough context to locate the arm territory.
    if (lensBBox.isEmpty() && frameSrc.length > 0) {
      for (const src of frameSrc) {
        src.geometry.computeBoundingBox();
        const bb = src.geometry.boundingBox;
        const xE = bb.max.x - bb.min.x;
        const yE = bb.max.y - bb.min.y;
        const zE = bb.max.z - bb.min.z;
        if (xE > 0 && Math.max(yE, zE) < xE * 0.45) {
          lensBBox.union(bb);
        }
      }
    }

    // "Largest wins": a small spurious arm split-off should not overwrite the
    // real arm. Track vertex count and keep whichever arm piece is largest.
    const armVertCount = { left: 0, right: 0 };
    const setArm = (side, piece) => {
      const vCount = piece.geometry.attributes.position?.count ?? 0;
      if (vCount > armVertCount[side]) {
        armVertCount[side] = vCount;
        this._armMeshes[side] = piece;
        if (piece.userData.backDir  !== undefined) this._armMeshes.backDir  = piece.userData.backDir;
        if (piece.userData.backAxis !== undefined) this._armMeshes.backAxis = piece.userData.backAxis;
        if (piece.userData.upAxis   !== undefined) this._armMeshes.upAxis   = piece.userData.upAxis;
      }
    };

    for (const src of frameSrc) {
      const pieces = this._splitFrameAndArms(src, lensBBox);
      for (const piece of pieces) {
        piece.material = this._frameMat;
        piece.castShadow = true;
        piece.receiveShadow = true;
        if (piece.userData.armSide === 'left')  setArm('left',  piece);
        if (piece.userData.armSide === 'right') setArm('right', piece);
        offsetGroup.add(piece);
      }
    }

    container.add(offsetGroup);
    this.glassesGroup.add(container);
    this._container = container;
    this.glassesGroup.visible = this.enabled;

    this._alignAndAdjust();
  }

  /**
   * Split a lens mesh into per-eye halves so each lens can be scaled around
   * its own bbox center. Returns an array of THREE.Mesh, each with geometry
   * recentered at origin and `mesh.position` set to the original center.
   *
   * If the mesh's geometry doesn't straddle x=0 (i.e. it's already a single
   * lens), returns a single recentered mesh.
   */
  _splitLensHalves(srcMesh) {
    const srcGeom = srcMesh.geometry;
    const posAttr = srcGeom.getAttribute('position');
    const normAttr = srcGeom.getAttribute('normal');
    const uvAttr = srcGeom.getAttribute('uv');
    if (!posAttr) return [srcMesh.clone()];

    const indexAttr = srcGeom.index;
    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;

    const leftTris  = []; // arrays of vertex indices into the source
    const rightTris = [];

    const getPos = (i, out) => {
      out[0] = posAttr.getX(i);
      out[1] = posAttr.getY(i);
      out[2] = posAttr.getZ(i);
    };
    const tri = [0, 0, 0];
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];

    for (let t = 0; t < triCount; t++) {
      if (indexAttr) {
        tri[0] = indexAttr.getX(t * 3);
        tri[1] = indexAttr.getX(t * 3 + 1);
        tri[2] = indexAttr.getX(t * 3 + 2);
      } else {
        tri[0] = t * 3; tri[1] = t * 3 + 1; tri[2] = t * 3 + 2;
      }
      getPos(tri[0], a); getPos(tri[1], b); getPos(tri[2], c);
      const cx = (a[0] + b[0] + c[0]) / 3;
      (cx < 0 ? leftTris : rightTris).push(tri[0], tri[1], tri[2]);
    }

    // No meaningful split — fall back to a single recentered mesh.
    if (leftTris.length === 0 || rightTris.length === 0) {
      const cloned = srcMesh.clone();
      cloned.geometry = srcGeom.clone();
      this._recenterGeometry(cloned);
      return [cloned];
    }

    const buildHalf = (triIndices, name) => {
      const vCount = triIndices.length;
      const pos = new Float32Array(vCount * 3);
      const nrm = normAttr ? new Float32Array(vCount * 3) : null;
      const uv  = uvAttr   ? new Float32Array(vCount * 2) : null;

      for (let i = 0; i < vCount; i++) {
        const si = triIndices[i];
        pos[i * 3]     = posAttr.getX(si);
        pos[i * 3 + 1] = posAttr.getY(si);
        pos[i * 3 + 2] = posAttr.getZ(si);
        if (nrm) {
          nrm[i * 3]     = normAttr.getX(si);
          nrm[i * 3 + 1] = normAttr.getY(si);
          nrm[i * 3 + 2] = normAttr.getZ(si);
        }
        if (uv) {
          uv[i * 2]     = uvAttr.getX(si);
          uv[i * 2 + 1] = uvAttr.getY(si);
        }
      }

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (nrm) g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      else g.computeVertexNormals();
      if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

      const m = new THREE.Mesh(g, srcMesh.material);
      m.name = (srcMesh.name || 'lenses') + '_' + name;
      this._recenterGeometry(m);
      return m;
    };

    return [buildHalf(leftTris, 'left'), buildHalf(rightTris, 'right')];
  }

  /**
   * Split a frame "rest" mesh into front + left arm + right arm pieces.
   * Triangles whose centroid extends past the lens depth on the back side AND
   * lie clearly to the left/right of the bridge become arm meshes, recentered
   * on their hinge point so `mesh.rotation.y` yaws each arm outward around
   * the hinge. Triangles inside the lens-depth range stay as the front frame.
   *
   * If the source mesh doesn't extend meaningfully past the lens depth (e.g.
   * it's a pure rim with no temples) the whole thing is returned as a single
   * front-frame mesh.
   */
  _splitFrameAndArms(srcMesh, lensBBox) {
    const srcGeom = srcMesh.geometry;
    const posAttr = srcGeom.getAttribute('position');
    const normAttr = srcGeom.getAttribute('normal');
    const uvAttr = srcGeom.getAttribute('uv');
    if (!posAttr) {
      const cloned = srcMesh.clone();
      cloned.geometry = srcGeom.clone();
      return [cloned];
    }

    srcGeom.computeBoundingBox();
    const fbb = srcGeom.boundingBox;

    // When no lens bbox is available (no named lens meshes in the model), try
    // to detect a pre-separated arm by shape: it should be mostly on one side
    // of X (off-center) and elongated along Y or Z relative to its X width.
    if (lensBBox.isEmpty()) {
      const cenX  = (fbb.min.x + fbb.max.x) * 0.5;
      const xExt  = fbb.max.x - fbb.min.x;
      const yExt  = fbb.max.y - fbb.min.y;
      const zExt  = fbb.max.z - fbb.min.z;
      const maxYZ = Math.max(yExt, zExt);
      if (Math.abs(cenX) > xExt * 0.55 && maxYZ > xExt * 1.5) {
        const backAxis = yExt >= zExt ? 'y' : 'z';
        const upAxis   = backAxis === 'y' ? 'z' : 'y';
        const backMin  = backAxis === 'y' ? fbb.min.y : fbb.min.z;
        const backMax  = backAxis === 'y' ? fbb.max.y : fbb.max.z;
        const backCen  = (backMin + backMax) * 0.5;
        const backDir  = backCen >= 0 ? 1 : -1;

        const cloned = srcMesh.clone();
        cloned.geometry = srcGeom.clone();
        const hingeX = cenX;
        const hingeY = backAxis === 'y'
          ? (backDir > 0 ? fbb.min.y : fbb.max.y)
          : (fbb.min.y + fbb.max.y) * 0.5;
        const hingeZ = backAxis === 'z'
          ? (backDir > 0 ? fbb.min.z : fbb.max.z)
          : (fbb.min.z + fbb.max.z) * 0.5;
        cloned.geometry.translate(-hingeX, -hingeY, -hingeZ);
        cloned.position.set(hingeX, hingeY, hingeZ);
        cloned.userData.armSide  = cenX < 0 ? 'left' : 'right';
        cloned.userData.backAxis = backAxis;
        cloned.userData.upAxis   = upAxis;
        cloned.userData.backDir  = backDir;
        return [cloned];
      }
      // Can't detect — return as plain frame piece
      const fallback = srcMesh.clone();
      fallback.geometry = srcGeom.clone();
      return [fallback];
    }

    // Glasses are symmetric on X (left-right). The temple arms extend along
    // either Y or Z depending on how the model was authored — pick whichever
    // axis the frame overshoots the lens bbox by the most.
    const candidates = [
      { axis: 'y', pos: fbb.max.y - lensBBox.max.y, neg: lensBBox.min.y - fbb.min.y, range: lensBBox.max.y - lensBBox.min.y },
      { axis: 'z', pos: fbb.max.z - lensBBox.max.z, neg: lensBBox.min.z - fbb.min.z, range: lensBBox.max.z - lensBBox.min.z },
    ];
    let best = null;
    for (const c of candidates) {
      const overshoot = Math.max(c.pos, c.neg);
      if (!best || overshoot > best.overshoot) {
        best = { axis: c.axis, overshoot, dir: c.pos >= c.neg ? 1 : -1, range: c.range };
      }
    }
    const pad = Math.max((best.range || 0) * 0.25, 0.005);

    // Name-based override: if the mesh is explicitly labelled as an arm/temple,
    // trust it unconditionally and skip the overshoot threshold guard.
    const armNameRe = /\b(arm|arms|temple|temples|earpiece|ear[_\s]?piece)\b/i;
    const isArmByName = armNameRe.test(srcMesh.name || '');

    if (!isArmByName && best.overshoot < pad * 1.2) {
      const cloned = srcMesh.clone();
      cloned.geometry = srcGeom.clone();
      return [cloned];
    }

    // For name-hinted arms with no real overshoot, derive the back axis from
    // the mesh's own longest Y/Z extent. backDir is determined by comparing the
    // arm centroid to the lens bbox centroid: if the arm sits below the lens on
    // that axis, the arms extend in the negative direction.
    let backAxisResolved = best.axis;
    let backDirResolved  = best.dir;
    if (isArmByName && best.overshoot < pad * 1.2) {
      const yE = fbb.max.y - fbb.min.y;
      const zE = fbb.max.z - fbb.min.z;
      backAxisResolved = yE >= zE ? 'y' : 'z';
      const armCen  = backAxisResolved === 'y'
        ? (fbb.min.y + fbb.max.y) * 0.5
        : (fbb.min.z + fbb.max.z) * 0.5;
      const lensCen = backAxisResolved === 'y'
        ? (lensBBox.min.y + lensBBox.max.y) * 0.5
        : (lensBBox.min.z + lensBBox.max.z) * 0.5;
      backDirResolved = armCen >= lensCen ? 1 : -1;
    }

    const backAxis = backAxisResolved;     // 'y' or 'z'
    const upAxis   = backAxis === 'y' ? 'z' : 'y';
    const backDir  = backDirResolved;      // ±1
    const lensBackMax = backAxis === 'y' ? lensBBox.max.y : lensBBox.max.z;
    const lensBackMin = backAxis === 'y' ? lensBBox.min.y : lensBBox.min.z;
    const armThreshold = backDir > 0 ? lensBackMax + pad : lensBackMin - pad;

    const indexAttr = srcGeom.index;
    const triCount = indexAttr ? indexAttr.count / 3 : posAttr.count / 3;

    const frontTris = [];
    const leftTris  = [];
    const rightTris = [];
    const tri = [0, 0, 0];

    const getBack = backAxis === 'y'
      ? ((i) => posAttr.getY(i))
      : ((i) => posAttr.getZ(i));
    const isPastThreshold = (b) => (backDir > 0 ? b > armThreshold : b < armThreshold);

    for (let t = 0; t < triCount; t++) {
      if (indexAttr) {
        tri[0] = indexAttr.getX(t * 3);
        tri[1] = indexAttr.getX(t * 3 + 1);
        tri[2] = indexAttr.getX(t * 3 + 2);
      } else {
        tri[0] = t * 3; tri[1] = t * 3 + 1; tri[2] = t * 3 + 2;
      }
      const cenX = (posAttr.getX(tri[0]) + posAttr.getX(tri[1]) + posAttr.getX(tri[2])) / 3;
      const cenB = (getBack(tri[0]) + getBack(tri[1]) + getBack(tri[2])) / 3;

      if (isPastThreshold(cenB)) {
        (cenX < 0 ? leftTris : rightTris).push(tri[0], tri[1], tri[2]);
      } else {
        frontTris.push(tri[0], tri[1], tri[2]);
      }
    }

    const buildPiece = (triIndices, name, options = {}) => {
      const vCount = triIndices.length;
      if (vCount === 0) return null;
      const pos = new Float32Array(vCount * 3);
      const nrm = normAttr ? new Float32Array(vCount * 3) : null;
      const uv  = uvAttr   ? new Float32Array(vCount * 2) : null;

      for (let i = 0; i < vCount; i++) {
        const si = triIndices[i];
        pos[i * 3]     = posAttr.getX(si);
        pos[i * 3 + 1] = posAttr.getY(si);
        pos[i * 3 + 2] = posAttr.getZ(si);
        if (nrm) {
          nrm[i * 3]     = normAttr.getX(si);
          nrm[i * 3 + 1] = normAttr.getY(si);
          nrm[i * 3 + 2] = normAttr.getZ(si);
        }
        if (uv) {
          uv[i * 2]     = uvAttr.getX(si);
          uv[i * 2 + 1] = uvAttr.getY(si);
        }
      }

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (nrm) g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      else g.computeVertexNormals();
      if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

      const m = new THREE.Mesh(g, srcMesh.material);
      m.name = (srcMesh.name || 'frame') + '_' + name;

      if (options.armSide) {
        // Pivot at the hinge: front-most along the back axis (toward the lens),
        // centered on the up axis and on the side axis. After translating the
        // geometry by -hinge and offsetting mesh.position by +hinge, a
        // rotation around the up axis yaws the arm around its hinge.
        g.computeBoundingBox();
        const bb = g.boundingBox;
        const hingeX = (bb.min.x + bb.max.x) * 0.5;
        const hingeY = backAxis === 'y'
          ? (backDir > 0 ? bb.min.y : bb.max.y)
          : (bb.min.y + bb.max.y) * 0.5;
        const hingeZ = backAxis === 'z'
          ? (backDir > 0 ? bb.min.z : bb.max.z)
          : (bb.min.z + bb.max.z) * 0.5;
        g.translate(-hingeX, -hingeY, -hingeZ);
        m.position.set(hingeX, hingeY, hingeZ);
        m.userData.armSide = options.armSide;
        m.userData.backDir = backDir;
        m.userData.backAxis = backAxis;
        m.userData.upAxis = upAxis;
      }

      return m;
    };

    const out = [];
    const front = buildPiece(frontTris, 'front');
    if (front) out.push(front);
    const leftArm = buildPiece(leftTris, 'arm_left', { armSide: 'left' });
    if (leftArm) out.push(leftArm);
    const rightArm = buildPiece(rightTris, 'arm_right', { armSide: 'right' });
    if (rightArm) out.push(rightArm);

    if (out.length === 0 || (!leftArm && !rightArm)) {
      const cloned = srcMesh.clone();
      cloned.geometry = srcGeom.clone();
      return [cloned];
    }

    return out;
  }

  /**
   * Translate a mesh's geometry so its bbox center sits at the local origin,
   * then offset mesh.position by that center. After this, mesh.scale grows or
   * shrinks the geometry around its own center rather than the model origin.
   */
  _recenterGeometry(mesh) {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const cx = (bb.min.x + bb.max.x) * 0.5;
    const cy = (bb.min.y + bb.max.y) * 0.5;
    const cz = (bb.min.z + bb.max.z) * 0.5;
    mesh.geometry.translate(-cx, -cy, -cz);
    mesh.position.set(cx, cy, cz);
  }

  _isLensMesh(mesh) {
    // Match only when a discrete token is clearly a lens word.
    // 'glasses1 frame' must NOT match; 'glasses1 lens', 'lens1', 'lenses' must match.
    // Token regex: 'lens' with optional trailing digits, or exactly 'glass'/'glasses'.
    const lensToken = /^(lens\d*|lenses?|glass(es)?)$/;
    // Structural words that override a bare 'glass/glasses' token — e.g.
    // "Large_Framed_Glasses__Arms_1_0001" must not be classified as a lens
    // just because it contains the word "glasses".
    const nonLensToken = /^(frame|frames|arm|arms|temple|temples|earpiece|bridge|rim|rims|hinge)$/;
    const nameTokens = (mesh.name || '').toLowerCase().split(/[\s_.]+/);
    if (nameTokens.some(t => nonLensToken.test(t))) return false;
    if (nameTokens.some(t => lensToken.test(t))) return true;
    const matName = (mesh.material?.name || '').toLowerCase();
    if (matName.includes('lens') || matName.includes('glass')) return true;
    if (mesh.material?.transparent && (mesh.material.opacity ?? 1) < 1) return true;
    return false;
  }

  _alignAndAdjust() {
    if (!this._container || !this._headGroup) return;

    const container = this._container;
    const offsetGroup = container.children[0];
    if (!offsetGroup) return;

    // Compute and cache the model's bbox in its own local space
    if (!this._bboxCache) {
      container.scale.set(1, 1, 1);
      container.position.set(0, 0, 0);
      container.rotation.set(0, 0, 0);
      offsetGroup.position.set(0, 0, 0);

      const box = new THREE.Box3().setFromObject(container);
      const center = new THREE.Vector3();
      const size = new THREE.Vector3();
      box.getCenter(center);
      box.getSize(size);

      if (size.x < 0.0001) return;

      this._bboxCache = { center, size };
      offsetGroup.position.set(-center.x, -center.y, -center.z);
    }

    const size = this._bboxCache.size;

    // ── Live landmark sample (current post-morph positions) ──
    let bridge = this._initialBridgePos ? this._initialBridgePos.clone() : null;
    let templeL = this._initialTempleLeft ? this._initialTempleLeft.clone() : null;
    let templeR = this._initialTempleRight ? this._initialTempleRight.clone() : null;

    if (this._morpher && typeof this._morpher.getCurrentLandmarkPosition === 'function') {
      const b = this._morpher.getCurrentLandmarkPosition('nose_bridge_top');
      const tl = this._morpher.getCurrentLandmarkPosition('temple_left');
      const tr = this._morpher.getCurrentLandmarkPosition('temple_right');
      if (b) bridge = new THREE.Vector3(b[0], b[1], b[2]);
      if (tl) templeL = new THREE.Vector3(tl[0], tl[1], tl[2]);
      if (tr) templeR = new THREE.Vector3(tr[0], tr[1], tr[2]);

      // Lazy capture if baselines weren't ready when setHeadMesh ran
      if (!this._initialBridgePos && bridge) this._initialBridgePos = bridge.clone();
      if (!this._initialTempleLeft && templeL) this._initialTempleLeft = templeL.clone();
      if (!this._initialTempleRight && templeR) this._initialTempleRight = templeR.clone();
      if (this._initialTempleSpan === null && this._initialTempleLeft && this._initialTempleRight) {
        this._initialTempleSpan = Math.abs(this._initialTempleRight.x - this._initialTempleLeft.x);
      }
    }

    // Sensible fallbacks if landmark detection failed entirely
    if (!bridge) bridge = new THREE.Vector3(0, 0.30, 1.14);
    if (!templeL) templeL = new THREE.Vector3(-0.60, 0.35, 0.70);
    if (!templeR) templeR = new THREE.Vector3(0.60, 0.35, 0.70);

    // Base scale: match current temple span so frame fits the face width
    const templeSpan = Math.max(0.0001, Math.abs(templeR.x - templeL.x));
    const baseScale = templeSpan / Math.max(size.x, 0.0001);

    // ── Morph-driven offsets (delta from baseline landmarks) ──
    // Use post-morph landmark deltas for X/Y/Z drift (same approach as EyeSystem).
    let morphDeltaY = 0;
    let morphDeltaZ = 0;
    if (this._initialBridgePos) {
      morphDeltaY = bridge.y - this._initialBridgePos.y;
      morphDeltaZ = bridge.z - this._initialBridgePos.z;
    }

    // Morph-value driven scale adjustments (refine fit beyond raw landmark drift)
    const mv = this._faceMorphValues || (this._morpher ? this._morpher.morphValues : null) || {};
    const neutral = 50;
    const t = (key) => ((mv[key] ?? neutral) - neutral) / 50; // -1..+1

    const faceWT  = t('faceWidth');
    const headWT  = t('headWidth');
    const noseBWT = t('noseBridgeWidth');
    const eyeSpT  = t('eyeSpacing');
    const noseLT  = t('noseLength');
    const noseBHT = t('noseBridgeHeight');

    // X scale: face/head width + nose bridge width all push frame wider/narrower
    const widthScale = 1.0 + faceWT * 0.10 + headWT * 0.08 + noseBWT * 0.05 + eyeSpT * 0.06;

    // Y/Z fine offsets — landmark delta already captures most movement, these
    // sharpen the response so glasses don't lag noticeably during fast slider drags.
    const morphYOffset = noseLT * -0.02 + noseBHT * 0.015;
    const morphZOffset = noseBHT * 0.015;

    // ── User slider offsets ──
    const userScale = this.params.scale / 100;          // 0.5..2.0
    const userPosX  = this.params.posX * 0.01;           // ±0.10 world-units
    const userPosY  = this.params.posY * 0.01;           // ±0.10 world-units
    const userPosZ  = this.params.posZ * 0.01;           // ±0.10 world-units
    const DEG = Math.PI / 180;
    const userRotX  = this.params.rotX * DEG;
    const userRotY  = this.params.rotY * DEG;
    const userRotZ  = this.params.rotZ * DEG;

    // Forward offset so glasses sit just in front of the bridge surface.
    // Half the (scaled) model depth plus a small clearance avoids face clipping.
    const sizeZ = size.z;
    const forwardOffset = sizeZ * baseScale * 0.5 + 0.012;

    container.scale.set(
      baseScale * widthScale * userScale,
      baseScale * userScale,
      baseScale * userScale
    );
    container.position.set(
      bridge.x + userPosX,
      bridge.y + morphYOffset + userPosY,
      bridge.z + forwardOffset + morphZOffset + userPosZ
    );
    container.rotation.set(userRotX, userRotY, userRotZ);

    // Per-lens local scale (grows/shrinks around the lens bbox center thanks
    // to the geometry-translate done in _showCached).
    const lensScale = (this.params.lensScale ?? 100) / 100;
    for (const m of this._lensMeshes) m.scale.setScalar(lensScale);

    // Temple arm splay: yaw each arm around the up axis at its hinge, with a
    // sign chosen so positive `armSplay` always pushes the tips outward
    // regardless of which axis the arms extend along or its sign.
    const splayRad = ((this.params.armSplay ?? 0) * Math.PI) / 180;
    const armLen   = (this.params.armLength ?? 100) / 100;
    const backDir  = this._armMeshes.backDir  || 1;
    const upAxis   = this._armMeshes.upAxis   || 'y';
    const backAxis = this._armMeshes.backAxis || 'z';
    const applyArm = (m, sign) => {
      m.rotation.set(0, 0, 0);
      m.rotation[upAxis] = sign * splayRad * backDir;
      m.scale.set(1, 1, 1);
      m.scale[backAxis] = armLen;
    };
    if (this._armMeshes.left)  applyArm(this._armMeshes.left,  +1);
    if (this._armMeshes.right) applyArm(this._armMeshes.right, -1);
  }

  // ── State / persistence ─────────────────────────────────────────────────

  exportState() {
    return {
      enabled: this.enabled,
      style: this.currentStyle,
      frameColor: this.frameColor,
      lensColor: this.lensColor,
      lensOpacity: this.lensOpacity,
      scale: this.params.scale,
      lensScale: this.params.lensScale,
      armSplay: this.params.armSplay,
      armLength: this.params.armLength,
      posX: this.params.posX,
      posY: this.params.posY,
      posZ: this.params.posZ,
      rotX: this.params.rotX,
      rotY: this.params.rotY,
      rotZ: this.params.rotZ,
    };
  }

  loadState(state) {
    if (!state) return;
    if (state.style && this.glassesModels[state.style]) this.currentStyle = state.style;
    if (state.frameColor) this.setFrameColor(state.frameColor);
    if (state.lensColor) this.setLensColor(state.lensColor);
    if (state.lensOpacity !== undefined) this.setLensOpacity(state.lensOpacity);
    if (state.scale !== undefined) this.params.scale = state.scale;
    if (state.lensScale !== undefined) this.params.lensScale = state.lensScale;
    if (state.armSplay !== undefined) this.params.armSplay = state.armSplay;
    if (state.armLength !== undefined) this.params.armLength = state.armLength;
    if (state.posX !== undefined) this.params.posX = state.posX;
    if (state.posY !== undefined) this.params.posY = state.posY;
    if (state.posZ !== undefined) this.params.posZ = state.posZ;
    if (state.rotX !== undefined) this.params.rotX = state.rotX;
    if (state.rotY !== undefined) this.params.rotY = state.rotY;
    if (state.rotZ !== undefined) this.params.rotZ = state.rotZ;
    // Backward-compat: older saves stored a single Z-axis tilt as `rotation`.
    if (state.rotation !== undefined && state.rotZ === undefined) {
      this.params.rotZ = state.rotation;
    }
    // Force a clean rebuild so style/param changes from undo/redo are always
    // reflected — setEnabled skips generate() when a container already exists.
    this._container = null;
    this._bboxCache = null;
    this.setEnabled(state.enabled === true);
  }

  /**
   * Apply AI-generated glasses block. Schema:
   *   { enabled, frameColor, lensColor, lensOpacity }
   */
  applyFromAI(data) {
    if (!data) return;
    if (data.frameColor) this.setFrameColor(data.frameColor);
    if (data.lensColor) this.setLensColor(data.lensColor);
    if (data.lensOpacity !== undefined) this.setLensOpacity(data.lensOpacity);
    this.setEnabled(!!data.enabled);
  }

  /**
   * World-space transform of the glasses container. Useful for future
   * Blender export pipelines that want to merge glasses into the head mesh.
   */
  getRenderTransform() {
    if (!this._container || !this.enabled) {
      return { matrix: null, params: { ...this.params }, enabled: this.enabled };
    }
    const c = this._container;
    const o = c.children[0];
    c.updateWorldMatrix(true, false);
    o?.updateWorldMatrix(true, false);
    return {
      matrix: Array.from((o ? o.matrixWorld : c.matrixWorld).elements),
      params: { ...this.params },
      enabled: this.enabled,
      style: this.currentStyle,
      frameColor: this.frameColor,
      lensColor: this.lensColor,
      lensOpacity: this.lensOpacity,
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  _clearGroup(group) {
    while (group.children.length > 0) {
      group.remove(group.children[0]);
    }
  }

  dispose() {
    this._clearGroup(this.glassesGroup);
    this.scene.remove(this.glassesGroup);
  }
}

window.GlassesSystem = GlassesSystem;
