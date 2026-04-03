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

  // Eye system
  const eyeSystem = new EyeSystem(sceneManager.scene);

  // Backend API + Case Manager
  const api = new BackendAPI('http://127.0.0.1:5001');
  const caseManager = new CaseManager(api);

  // Skin Texture System
  const skinTextureSystem = new SkinTextureSystem(sceneManager);

  // Face Point Editor (initialized after model loads)
  let facePointEditor = null;
  let skinMarkSystem = null;
  let decalSystem = null;
  let wrinklePainter = null;
  let lipPainter = null;

  // Use OBJMorpher as the default morpher passed to UI
  // (falls back to FaceMorpher only if OBJ load fails)
  let activeMorpher = objMorpher;

  // UI Controller — will be initialized after we decide the active morpher
  let ui = null;

  // ─── Load Region Data + OBJ concurrently ───────────────────────────────

  const REGION_JSON_PATH = '../../assets/models/base/head_regions.json';
  const MODEL_PATH = '../../assets/models/base/head.glb';

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
    console.log('[App] Region data and model loaded, initializing...');
    if (group) {
      // ── OBJ loaded successfully ──
      console.log('[App] GLB model group loaded successfully');
      let vertexCount = 0;
      group.traverse(c => {
        if (c.isMesh && c.geometry) vertexCount += c.geometry.attributes.position.count;
      });

      // Wire OBJMorpher
      objMorpher.setMeshGroup(group);
      if (regionData) {
        objMorpher.setRegionData(regionData);
        hairSystem.setHeadMesh(group, regionData, objMorpher);
        eyeSystem.setHeadMesh(group, regionData, objMorpher);
      } else {
        // No region data — hair/eye system won't place properly
        console.warn('Region data missing — hair/eye placement disabled');
      }

      activeMorpher = objMorpher;

      document.getElementById('statusMeshInfo').textContent =
        `head.glb — ${vertexCount.toLocaleString()} vertices`;
      document.getElementById('polyCount').textContent =
        `Vertices: ${vertexCount.toLocaleString()}`;
      console.log(`OBJ loaded: ${vertexCount} vertices, region data: ${!!regionData}`);

      // ── Auto-refresh hair and eyes when morphs change (debounced) ──
      let _morphTimer = null;
      objMorpher.onMorphApplied = () => {
        if (_morphTimer) clearTimeout(_morphTimer);
        _morphTimer = setTimeout(() => {
          hairSystem.refreshFromMesh(objMorpher.morphValues);
          eyeSystem.refreshFromMesh();
        }, 120);
      };

      // Generate initial hair (use setStyle to apply calibrated defaults)
      console.log('[App] Generating initial hair...');
      hairSystem.setStyle(hairSystem.currentStyle);
      console.log('[App] Generating eyebrows...');
      hairSystem.generateEyebrows();
      console.log('[App] Generating eyes...');
      eyeSystem.generateEyes();
      console.log('[App] Generating eyelashes...');
      eyeSystem.generateEyelashes();
      console.log('[App] Hair, eyebrows, eyes, and eyelashes generation initiated');
      // Note: Beard starts as 'none' by default

      // ── Initialize Face Point Editor ──
      facePointEditor = new FacePointEditor(sceneManager, objMorpher);

      // ── Initialize Skin Mark System ──
      skinMarkSystem = new SkinMarkSystem(sceneManager, objMorpher);

      // Ensure marks are attached to head mesh (should be loaded by now)
      skinMarkSystem.ensureAttachedToHead();

      // Wire up reference in OBJMorpher for automatic mark refresh
      objMorpher.skinMarkSystem = skinMarkSystem;

      // ── Initialize Decal System ──
      decalSystem = new DecalSystem(sceneManager, objMorpher);
      console.log('[App] Decal System initialized');

      // Refresh editor points, skin marks, and decals when morphs change
      const origOnMorph = objMorpher.onMorphApplied;
      objMorpher.onMorphApplied = () => {
        if (origOnMorph) origOnMorph();
        if (facePointEditor && facePointEditor.enabled) {
          facePointEditor.refreshPoints();
        }
        skinMarkSystem.refreshMarksAfterMorph();
        if (decalSystem) decalSystem.rebuildAll();
      };

      facePointEditor.onPointEdited = (name) => {
        if (ui) {
          ui.addHistory(`Dragged point: ${name}`);
          ui.updatePropertyPanel();
        }
      };

      // ── Initialize Skin Texture System ──
      console.log('[App] Initializing Skin Texture System...');
      skinTextureSystem.init(group);
      sceneManager.skinTextureSystem = skinTextureSystem;
      console.log('[App] Skin Texture System initialized');

      // ── Initialize Wrinkle Painter ──
      wrinklePainter = new WrinklePainter(sceneManager, skinTextureSystem);
      skinTextureSystem.wrinklePainter = wrinklePainter;
      console.log('[App] Wrinkle Painter initialized');

      // ── Initialize Lip Painter ──
      lipPainter = new LipPainter(sceneManager);
      console.log('[App] Lip Painter initialized');

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
    console.log('[App] Creating UIController...');
    ui = new UIController(sceneManager, activeMorpher, hairSystem, api, caseManager);
    ui.facePointEditor = facePointEditor;   // expose for render pipeline
    ui.skinMarkSystem = skinMarkSystem;     // expose for skin marks UI
    ui.decalSystem = decalSystem;           // expose for decal/tattoo UI
    ui.eyeSystem = eyeSystem;               // expose eye system for UI control
    ui.skinTextureSystem = skinTextureSystem; // expose for skin texture UI
    ui.wrinklePainter = wrinklePainter;       // expose for wrinkle painting UI
    ui.lipPainter = lipPainter;               // expose for lip painting UI
    console.log('[App] Initializing UIController...');
    ui.init();
    console.log('[App] UIController initialized successfully');
    ui.updatePropertyPanel();
    ui.addHistory(group ? 'Base face model loaded (OBJ)' : 'Using procedural head');

    // ── Sync initial state to case manager ──
    // Initialize case with default values from all systems
    caseManager.updateMorphTargets(activeMorpher.exportState());
    caseManager.updateHairParams(hairSystem.getParams());
    if (eyeSystem) {
      caseManager.updateAppearance('eyeParams', eyeSystem.getParams());
      caseManager.updateAppearance('eyeColor', eyeSystem.eyeColor);
      caseManager.updateAppearance('eyelashParams', eyeSystem.getEyelashParams());
    }
    console.log('[App] Initial state synced to case manager');

    // ── Initialize Snapshot Manager ──
    console.log('[App] Initializing Snapshot Manager...');
    const snapshotManager = new SnapshotManager(caseManager, sceneManager);
    snapshotManager.loadForCurrentCase();
    ui.snapshotManager = snapshotManager;
    ui.bindSnapshotControls();
    console.log('[App] Snapshot Manager initialized');

    // ── Initialize AI Controller ──
    console.log('[App] Initializing AI Controller...');
    const aiController = new AIController(api, activeMorpher, hairSystem, caseManager, ui);
    aiController.eyes = eyeSystem;  // set eye system reference
    aiController.scene = sceneManager;  // set scene reference for lip color
    aiController.skinMarkSystem = skinMarkSystem;  // set skin mark system reference
    aiController.markPositionMapper = new MarkPositionMapper(activeMorpher);  // set mark position mapper
    aiController.init();
    ui.aiController = aiController;  // expose for quick prompts etc.
    console.log('[App] AI Controller initialized');

    // ── Bind quick prompt buttons ──
    document.querySelectorAll('.ai-quick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const prompt = btn.dataset.prompt;
        const chatInput = document.getElementById('aiChatInput');
        if (chatInput && prompt) {
          chatInput.value = prompt;
          aiController.sendPrompt();
        }
      });
    });

    // ── Bind clear conversation button ──
    document.getElementById('aiClearBtn')?.addEventListener('click', () => {
      aiController.clearConversation();
    });

    // ── Initialize Head Tracker ──
    console.log('[App] Initializing Head Tracker...');
    const headTracker = new HeadTracker(sceneManager, hairSystem, eyeSystem, decalSystem);
    headTracker.init().then(() => {
      console.log('[App] Head Tracker initialized');
    }).catch(err => {
      console.warn('[App] Head Tracker init failed:', err);
    });

    // Bind head tracking toggle button
    const btnHeadTrack = document.getElementById('btnHeadTrack');
    if (btnHeadTrack) {
      btnHeadTrack.addEventListener('click', async () => {
        try {
          const active = await headTracker.toggle();
          btnHeadTrack.classList.toggle('active', active);
          btnHeadTrack.title = active ? 'Stop Head Tracking' : 'Head Tracking';
          const btnRecal = document.getElementById('btnRecalibrateHead');
          if (btnRecal) btnRecal.style.display = active ? '' : 'none';
          if (ui) ui.addHistory(active ? 'Head tracking enabled' : 'Head tracking disabled');
        } catch (err) {
          console.error('[App] Head tracking error:', err);
          if (ui) ui.addHistory('Head tracking failed — check webcam permissions');
        }
      });
    }

    // Bind recalibrate button
    const btnRecalibrate = document.getElementById('btnRecalibrateHead');
    if (btnRecalibrate) {
      btnRecalibrate.addEventListener('click', () => {
        headTracker.recalibrate();
        if (ui) ui.addHistory('Head tracking recalibrated');
      });
    }

    // ── Initialize Face Capture System ──
    const faceCapture = new FaceCaptureSystem(aiController);
    const btnFaceCapture = document.getElementById('btnFaceCapture');
    if (btnFaceCapture) {
      btnFaceCapture.addEventListener('click', () => {
        if (ui) {
          console.log('[App] Resetting all features before face capture...');
          ui.resetAllFeatures();
        }
        // Allow reset to render before starting capture overlay
        requestAnimationFrame(() => {
          faceCapture.start();
          if (ui) ui.addHistory('Multi-angle face capture started');
        });
      });
    }

    // ── Bind Face Point Editor UI controls ──
    _bindPointEditorUI(facePointEditor, ui);
  });

  // ─── Point Editor UI Bindings ──────────────────────────────────────────

  function _bindPointEditorUI(editor, uiCtrl) {
    const btnToolbar = document.getElementById('btnEditPoints');
    const btnToggle = document.getElementById('btnTogglePointEdit');
    const radiusSlider = document.getElementById('pointEditRadius');
    const radiusValue = document.getElementById('pointEditRadiusValue');
    const sizeSlider = document.getElementById('pointEditSize');
    const sizeValue = document.getElementById('pointEditSizeValue');
    const falloffSlider = document.getElementById('pointEditFalloff');
    const falloffValue = document.getElementById('pointEditFalloffValue');
    const btnReset = document.getElementById('btnResetPointEdits');
    const btnUndo = document.getElementById('btnUndoPointEdit');

    function toggleEditor() {
      if (!editor) return;
      // Disable skin marks if active (mutual exclusion)
      if (skinMarkSystem && skinMarkSystem.enabled) {
        skinMarkSystem.disable();
        document.getElementById('btnSkinMarks')?.classList.remove('active');
        const btnSM = document.getElementById('btnToggleSkinMarks');
        if (btnSM) {
          btnSM.classList.remove('active');
          btnSM.innerHTML = '<i class="fas fa-crosshairs"></i> Enable Mark Placement';
        }
      }
      // Disable wrinkle painter if active (mutual exclusion)
      if (wrinklePainter && wrinklePainter.enabled) {
        wrinklePainter.disable();
        document.getElementById('btnWrinklePaint')?.classList.remove('active');
        const btnWP = document.getElementById('btnToggleWrinklePaint');
        if (btnWP) {
          btnWP.classList.remove('active');
          btnWP.innerHTML = '<i class="fas fa-paint-brush"></i> Enable Wrinkle Painting';
        }
      }
      // Disable lip painter if active (mutual exclusion)
      if (lipPainter && lipPainter.enabled) {
        lipPainter.disable();
        document.getElementById('btnLipPaint')?.classList.remove('active');
        const btnLP = document.getElementById('btnToggleLipPaint');
        if (btnLP) {
          btnLP.classList.remove('active');
          btnLP.innerHTML = '<i class="fas fa-pen"></i> Enable Lip Pen';
        }
      }
      // Disable decal system if active (mutual exclusion)
      if (decalSystem && decalSystem.enabled) {
        decalSystem.disable();
        document.getElementById('btnDecals')?.classList.remove('active');
        const btnDC = document.getElementById('btnToggleDecalPlace');
        if (btnDC) {
          btnDC.classList.remove('active');
          btnDC.innerHTML = '<i class="fas fa-crosshairs"></i> Place on Face';
        }
      }
      const active = editor.toggle();
      btnToolbar?.classList.toggle('active', active);
      if (btnToggle) {
        btnToggle.classList.toggle('active', active);
        btnToggle.innerHTML = active
          ? '<i class="fas fa-times"></i> Disable Point Editing'
          : '<i class="fas fa-hand-pointer"></i> Enable Point Editing';
      }
      if (uiCtrl) {
        uiCtrl.addHistory(active ? 'Point editing enabled' : 'Point editing disabled');
      }
    }

    btnToolbar?.addEventListener('click', toggleEditor);
    btnToggle?.addEventListener('click', toggleEditor);

    radiusSlider?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value) / 100;
      if (editor) editor.setInfluenceRadius(v);
      if (radiusValue) radiusValue.textContent = v.toFixed(2);
    });

    sizeSlider?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value) / 1000;
      if (editor) editor.setPointSize(v);
      if (sizeValue) sizeValue.textContent = v.toFixed(3);
    });

    falloffSlider?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value) / 10;
      if (editor) editor.falloffStrength = v;
      if (falloffValue) falloffValue.textContent = v.toFixed(1);
    });

    btnReset?.addEventListener('click', () => {
      if (!editor) return;
      editor.resetAllEdits();
      if (uiCtrl) uiCtrl.addHistory('Reset all manual point edits');
    });

    btnUndo?.addEventListener('click', () => {
      if (!editor) return;
      editor._popUndo();
      if (uiCtrl) uiCtrl.addHistory('Undo manual point edit');
    });
  }

  // ─── Menu Events (from Electron) ───────────────────────────────────────

  if (window.electronAPI) {
    window.electronAPI.onNewCase(() => ui?.newCase());
    window.electronAPI.onOpenCase((path) => ui?.loadCase(path));
    window.electronAPI.onSaveCase(() => document.getElementById('btnSaveCase')?.click());
    window.electronAPI.onExport((format) => ui?.exportModel(format));
    window.electronAPI.onScreenshot(() => ui?.takeScreenshot());
    window.electronAPI.onImportModel((filePath) => ui?.importModelFromPath(filePath));
  }

  console.log('REface ID initialized — loading head.glb + region data...');

})();
