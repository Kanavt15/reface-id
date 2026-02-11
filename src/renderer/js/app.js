/**
 * app.js
 * Main application entry point.
 * Loads the OBJ model + trimesh region data, then wires OBJMorpher,
 * HairSystem, and UIController together.
 */

(function () {
  'use strict';

  // ─── Initialize Core Systems ───────────────────────────────────────────

  const sceneManager = new SceneManager('viewport-canvas');

  // Procedural fallback (only used if OBJ fails to load)
  const baseFace = new BaseFaceGeometry();
  const proceduralGeometry = baseFace.create();
  const fallbackMorpher = new FaceMorpher(baseFace);

  // OBJ-based morpher (primary)
  const objMorpher = new OBJMorpher();

  // Hair system
  const hairSystem = new HairSystem(sceneManager.scene);

  // Backend API + Case Manager
  const api = new BackendAPI('http://127.0.0.1:5001');
  const caseManager = new CaseManager(api);

  // Use OBJMorpher as the default morpher passed to UI
  // (falls back to FaceMorpher only if OBJ load fails)
  let activeMorpher = objMorpher;

  // UI Controller — will be initialized after we decide the active morpher
  let ui = null;

  // ─── Load Region Data + OBJ concurrently ───────────────────────────────

  const REGION_JSON_PATH = '../../assets/models/head_regions.json';
  const MODEL_PATH = '../../assets/models/head.glb';

  document.getElementById('statusMeshInfo').textContent = 'Loading base face model...';

  // Fetch region data
  const regionPromise = fetch(REGION_JSON_PATH)
    .then(r => { if (!r.ok) throw new Error('Region JSON not found'); return r.json(); })
    .catch(err => { console.warn('Region data unavailable:', err); return null; });

  // Load GLB model (wrap callback in a Promise)
  const objPromise = new Promise((resolve) => {
    sceneManager.loadGLB(MODEL_PATH, (group) => resolve(group));
  });

  // When both are ready, wire everything
  Promise.all([regionPromise, objPromise]).then(([regionData, group]) => {
    if (group) {
      // ── OBJ loaded successfully ──
      let vertexCount = 0;
      group.traverse(c => {
        if (c.isMesh && c.geometry) vertexCount += c.geometry.attributes.position.count;
      });

      // Wire OBJMorpher
      objMorpher.setMeshGroup(group);
      if (regionData) {
        objMorpher.setRegionData(regionData);
        hairSystem.setHeadMesh(group, regionData);
      } else {
        // No region data — hair system won't place hair
        console.warn('Region data missing — hair placement disabled');
      }

      activeMorpher = objMorpher;

      document.getElementById('statusMeshInfo').textContent =
        `head.glb — ${vertexCount.toLocaleString()} vertices`;
      document.getElementById('polyCount').textContent =
        `Vertices: ${vertexCount.toLocaleString()}`;
      console.log(`OBJ loaded: ${vertexCount} vertices, region data: ${!!regionData}`);

      // ── Auto-refresh hair when morphs change (debounced) ──
      let _morphTimer = null;
      objMorpher.onMorphApplied = () => {
        if (_morphTimer) clearTimeout(_morphTimer);
        _morphTimer = setTimeout(() => hairSystem.refreshFromMesh(), 120);
      };

      // Generate initial hair
      hairSystem.generate();
      hairSystem.generateFacialHair();

    } else {
      // ── OBJ failed — use procedural head ──
      console.warn('OBJ load failed, using procedural head');
      sceneManager.createHead(proceduralGeometry);
      activeMorpher = fallbackMorpher;

      document.getElementById('statusMeshInfo').textContent =
        `Procedural head — ${proceduralGeometry.attributes.position.count.toLocaleString()} vertices`;
      document.getElementById('polyCount').textContent =
        `Vertices: ${sceneManager.getVertexCount().toLocaleString()}`;
    }

    // NOW create and init UI with the correct morpher
    ui = new UIController(sceneManager, activeMorpher, hairSystem, api, caseManager);
    ui.init();
    ui.updatePropertyPanel();
    ui.addHistory(group ? 'Base face model loaded (OBJ)' : 'Using procedural head');
  });

  // ─── Menu Events (from Electron) ───────────────────────────────────────

  if (window.electronAPI) {
    window.electronAPI.onNewCase(() => ui?.newCase());
    window.electronAPI.onOpenCase((path) => ui?.loadCase(path));
    window.electronAPI.onSaveCase(() => document.getElementById('btnSaveCase')?.click());
    window.electronAPI.onExport((format) => ui?.exportModel(format));
    window.electronAPI.onScreenshot(() => ui?.takeScreenshot());
  }

  console.log('REface ID initialized — loading head.glb + region data...');

})();
