/**
 * UIController.js
 * Connects all UI elements to the 3D scene, morpher, hair system, and backend.
 * Handles all DOM interactions, panel switching, slider updates, etc.
 */

class UIController {
  constructor(sceneManager, faceMorpher, hairSystem, backendAPI, caseManager) {
    this.scene = sceneManager;
    this.morpher = faceMorpher;
    this.hair = hairSystem;
    this.api = backendAPI;
    this.caseManager = caseManager;
    this.skinMarkSystem = null;
    this.historyLog = [];
  }

  init() {
    this.bindTitleBar();
    this.bindToolbar();
    this.bindPanelTabs();
    this.bindMorphSliders();
    this.bindHairControls();
    this.bindAppearanceControls();
    this.bindSkinMarkControls();
    this.bindCaseControls();
    this.bindGroupCollapse();
    this.bindKeyboardShortcuts();
    this.bindBackendStatus();

    // Initial state
    this.updatePropertyPanel();
    this.addHistory('Session started');
  }

  // ─── Title Bar ───────────────────────────────────────────────────────────

  bindTitleBar() {
    document.getElementById('btnMinimize')?.addEventListener('click', () => {
      window.electronAPI?.minimize();
    });
    document.getElementById('btnMaximize')?.addEventListener('click', () => {
      window.electronAPI?.maximize();
    });
    document.getElementById('btnClose')?.addEventListener('click', () => {
      window.electronAPI?.close();
    });
  }

  // ─── Toolbar ─────────────────────────────────────────────────────────────

  bindToolbar() {
    // View presets
    document.getElementById('btnFrontView')?.addEventListener('click', () => {
      this.scene.setView('front');
      this.updateViewAngle('Front');
    });
    document.getElementById('btnSideView')?.addEventListener('click', () => {
      this.scene.setView('side');
      this.updateViewAngle('Side');
    });
    document.getElementById('btn34View')?.addEventListener('click', () => {
      this.scene.setView('34');
      this.updateViewAngle('3/4');
    });
    document.getElementById('btnTopView')?.addEventListener('click', () => {
      this.scene.setView('top');
      this.updateViewAngle('Top');
    });

    // Wireframe toggle
    document.getElementById('btnWireframe')?.addEventListener('click', (e) => {
      const active = this.scene.toggleWireframe();
      e.currentTarget.classList.toggle('active', active);
      this.addHistory(`Wireframe ${active ? 'ON' : 'OFF'}`);
    });

    // Lighting cycle
    document.getElementById('btnLighting')?.addEventListener('click', () => {
      const mode = this.scene.cycleLighting();
      this.addHistory(`Lighting: ${mode}`);
    });

    // Screenshot
    document.getElementById('btnScreenshot')?.addEventListener('click', () => {
      this.takeScreenshot();
    });

    // Export button
    document.getElementById('btnExport')?.addEventListener('click', () => {
      this.showExportDialog();
    });

    // Undo/Redo
    document.getElementById('btnUndo')?.addEventListener('click', () => this.undo());
    document.getElementById('btnRedo')?.addEventListener('click', () => this.redo());
  }

  // ─── Panel Tabs ──────────────────────────────────────────────────────────

  bindPanelTabs() {
    document.querySelectorAll('.panel-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        // Deactivate all tabs and panels
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));

        // Activate selected
        e.currentTarget.classList.add('active');
        const panelId = 'panel-' + e.currentTarget.dataset.panel;
        document.getElementById(panelId)?.classList.add('active');
      });
    });
  }

  // ─── Morph Sliders ───────────────────────────────────────────────────────

  bindMorphSliders() {
    document.querySelectorAll('.morph-slider').forEach(slider => {
      const control = slider.closest('.slider-control');
      const param = control?.dataset.param;
      const valueDisplay = control?.querySelector('.slider-value');

      slider.addEventListener('mousedown', () => {
        this.caseManager.beginAction(`Modified ${param}`);
      });

      slider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        if (valueDisplay) valueDisplay.textContent = value;

        if (param) {
          this.morpher.setMorphValue(param, value);
          this.caseManager.updateMorphTargets(this.morpher.exportState());
          this.updatePropertyPanel();
        }
      });

      slider.addEventListener('mouseup', () => {
        this.caseManager.endAction();
        this.addHistory(`Changed ${this.formatParamName(param)}`);
      });
    });

    // Reset all morphs
    document.getElementById('btnResetAllMorphs')?.addEventListener('click', () => {
      this.caseManager.pushState('Reset all morphs');
      this.morpher.resetAll();
      this.caseManager.updateMorphTargets(this.morpher.exportState());
      // Reset all slider UI
      document.querySelectorAll('.morph-slider').forEach(slider => {
        slider.value = 50;
        const valueDisplay = slider.closest('.slider-control')?.querySelector('.slider-value');
        if (valueDisplay) valueDisplay.textContent = '50';
      });
      this.addHistory('Reset all facial features');
      this.updatePropertyPanel();
    });

    // Reset group buttons
    document.querySelectorAll('.btn-reset-group').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const group = btn.dataset.group;
        this.caseManager.pushState(`Reset ${group}`);
        this.morpher.resetGroup(group);
        this.caseManager.updateMorphTargets(this.morpher.exportState());

        // Reset sliders in this group
        const groupBody = btn.closest('.control-group')?.querySelector('.control-group-body');
        if (groupBody) {
          groupBody.querySelectorAll('.morph-slider').forEach(slider => {
            slider.value = 50;
            const valueDisplay = slider.closest('.slider-control')?.querySelector('.slider-value');
            if (valueDisplay) valueDisplay.textContent = '50';
          });
        }

        this.addHistory(`Reset ${group} features`);
        this.updatePropertyPanel();
      });
    });
  }

  // ─── Hair Controls ───────────────────────────────────────────────────────

  bindHairControls() {
    // Hair style cards
    document.querySelectorAll('.hair-style-card').forEach(card => {
      card.addEventListener('click', (e) => {
        this.caseManager.pushState(`Hair style: ${card.dataset.style}`);
        document.querySelectorAll('.hair-style-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');

        const style = card.dataset.style;
        this.hair.setStyle(style);
        this.caseManager.updateHairParams(this.hair.getParams());
        this.addHistory(`Hair style: ${this.formatStyleName(style)}`);
        this.updatePropertyPanel();
      });
    });

    // Hair property sliders
    document.querySelectorAll('.hair-slider').forEach(slider => {
      const control = slider.closest('.slider-control');
      const param = control?.dataset.param;
      const valueDisplay = control?.querySelector('.slider-value');

      slider.addEventListener('mousedown', () => {
        this.caseManager.beginAction(`Modified hair ${param}`);
      });

      slider.addEventListener('input', (e) => {
        const value = parseInt(e.target.value);
        if (valueDisplay) valueDisplay.textContent = value;

        if (param) {
          if (param.startsWith('hair')) {
            const key = param.replace('hair', '').toLowerCase();
            this.hair.setParam(key, value);
          }
        }
      });

      slider.addEventListener('mouseup', () => {
        this.caseManager.updateHairParams(this.hair.getParams());
        this.caseManager.endAction();
      });
    });

    // Reset hair position button
    document.getElementById('btnResetHairPosition')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.caseManager.pushState('Reset hair position');
      ['posx', 'posy', 'posz', 'roty', 'scale'].forEach(key => {
        this.hair.setParam(key, 50);
      });
      const posGroup = e.currentTarget.closest('.control-group')?.querySelector('.control-group-body');
      if (posGroup) {
        posGroup.querySelectorAll('.hair-slider').forEach(slider => {
          slider.value = 50;
          const vd = slider.closest('.slider-control')?.querySelector('.slider-value');
          if (vd) vd.textContent = '50';
        });
      }
      this.caseManager.updateHairParams(this.hair.getParams());
      this.addHistory('Reset hair position');
    });

    // Hair color presets
    document.querySelectorAll('#hairColorPresets .color-swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        this.caseManager.pushState('Changed hair color');
        document.querySelectorAll('#hairColorPresets .color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');

        const color = swatch.dataset.color;
        this.hair.setColor(color);
        document.getElementById('hairColorPicker').value = color;
        this.caseManager.updateHairParams(this.hair.getParams());
        this.addHistory('Changed hair color');
      });
    });

    // Hair color picker
    {
      let _hairColorCapturing = false;
      const hairColorPicker = document.getElementById('hairColorPicker');
      hairColorPicker?.addEventListener('input', (e) => {
        if (!_hairColorCapturing) {
          this.caseManager.beginAction('Changed hair color');
          _hairColorCapturing = true;
        }
        this.hair.setColor(e.target.value);
        document.querySelectorAll('#hairColorPresets .color-swatch').forEach(s => s.classList.remove('active'));
      });
      hairColorPicker?.addEventListener('change', () => {
        this.caseManager.updateHairParams(this.hair.getParams());
        this.caseManager.endAction();
        _hairColorCapturing = false;
        this.addHistory('Changed hair color');
      });
    }

    // Facial hair
    document.getElementById('facialHairStyle')?.addEventListener('change', (e) => {
      this.caseManager.pushState(`Facial hair: ${e.target.value}`);
      this.hair.setFacialHair(e.target.value);
      this.caseManager.updateHairParams(this.hair.getParams());
      this.addHistory(`Facial hair: ${e.target.value}`);
    });

    // ── Render with Blender (disabled — re-enable when hair transform pipeline is fixed) ──
    // To re-enable: uncomment the block below and unhide #renderSection in index.html
    /*
    document.getElementById('btnRenderBlender')?.addEventListener('click', async () => {
      this.showLoading('Preparing morphed mesh for render...');

      // ── Upload current morphed mesh to backend so Blender uses it ──
      try {
        if (this.facePointEditor) {
          const objData = this.facePointEditor.exportCurrentMeshAsOBJ();
          if (objData) {
            const uploadResult = await this.api.uploadMorphedMesh(objData);
            if (uploadResult?.error) {
              console.warn('Mesh upload failed, Blender will use base model:', uploadResult.error);
            } else {
              console.log('Morphed mesh uploaded for render');
            }
          }
        }
      } catch (err) {
        console.warn('Mesh export/upload error, Blender will use base model:', err);
      }

      this.showLoading('Rendering with Blender (this may take a minute)...');

      // Gather render settings from UI
      const engine = document.getElementById('renderEngine')?.value || 'EEVEE';
      const quality = document.getElementById('renderQuality')?.value || 'medium';

      // Gather scene data to send to Blender
      const hairParams = this.hair.getParams();
      const skinColor = document.getElementById('skinColorPicker')?.value || '#d4a574';
      const hairColor = document.getElementById('hairColorPicker')?.value || '#2c1b0e';

      // Get the precise hair transform from the frontend scene
      const hairTransform = this.hair.getRenderTransform();
      console.log('Hair transform for render:', JSON.stringify(hairTransform));

      const result = await this.api.renderScene({
        hairStyle: hairParams.style || 'hair1',
        hairColor: hairColor,
        skinColor: skinColor,
        engine: engine,
        quality: quality,
        hairTransform: hairTransform,
      });

      this.hideLoading();

      if (result?.error) {
        this.addHistory('Blender render failed: ' + result.error);
        alert('Render failed: ' + result.error);
      } else if (result?.render_url) {
        // Open rendered image in a new window or download it
        const renderUrl = `http://127.0.0.1:5001${result.render_url}`;
        const win = window.open(renderUrl, '_blank', 'width=1280,height=720');
        if (!win) {
          // Fallback: download
          const link = document.createElement('a');
          link.href = renderUrl;
          link.download = result.filename || 'render.png';
          link.click();
        }
        this.addHistory('Blender render complete');
      } else {
        this.addHistory('Blender render returned no image');
      }
    });
    */
  }

  // ─── Appearance Controls ─────────────────────────────────────────────────

  bindAppearanceControls() {
    // Skin tone swatches
    document.querySelectorAll('#skinToneGrid .skin-swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        this.caseManager.pushState('Changed skin tone');
        document.querySelectorAll('#skinToneGrid .skin-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');

        const color = swatch.dataset.color;
        this.scene.setSkinColor(color);
        document.getElementById('skinColorPicker').value = color;
        this.caseManager.updateAppearance('skinColor', color);
        this.addHistory('Changed skin tone');
        this.updatePropertyPanel();
      });
    });

    // Skin color picker
    {
      let _skinColorCapturing = false;
      const skinColorPicker = document.getElementById('skinColorPicker');
      skinColorPicker?.addEventListener('input', (e) => {
        if (!_skinColorCapturing) {
          this.caseManager.beginAction('Changed skin color');
          _skinColorCapturing = true;
        }
        this.scene.setSkinColor(e.target.value);
        document.querySelectorAll('#skinToneGrid .skin-swatch').forEach(s => s.classList.remove('active'));
        this.caseManager.updateAppearance('skinColor', e.target.value);
      });
      skinColorPicker?.addEventListener('change', () => {
        this.caseManager.endAction();
        _skinColorCapturing = false;
        this.addHistory('Changed skin color');
        this.updatePropertyPanel();
      });
    }

    // Eye color
    document.querySelectorAll('#eyeColorPresets .color-swatch').forEach(swatch => {
      swatch.addEventListener('click', () => {
        this.caseManager.pushState('Changed eye color');
        document.querySelectorAll('#eyeColorPresets .color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');

        this.caseManager.updateAppearance('eyeColor', swatch.dataset.color);
        this.addHistory('Changed eye color');
        this.updatePropertyPanel();
      });
    });

    // Demographics
    document.getElementById('ageRange')?.addEventListener('change', (e) => {
      this.caseManager.updateAppearance('ageRange', e.target.value);
    });
    document.getElementById('sexSelect')?.addEventListener('change', (e) => {
      this.caseManager.updateAppearance('sex', e.target.value);
    });
  }

  // ─── Skin Mark Controls ──────────────────────────────────────────────────

  bindSkinMarkControls() {
    const skinMarks = this.skinMarkSystem;
    if (!skinMarks) return;

    const btnToggle = document.getElementById('btnToggleSkinMarks');
    const btnToolbar = document.getElementById('btnSkinMarks');

    const toggleSkinMarks = () => {
      // Disable point editor if active (mutual exclusion)
      if (this.facePointEditor && this.facePointEditor.enabled) {
        this.facePointEditor.disable();
        document.getElementById('btnEditPoints')?.classList.remove('active');
        const btnPE = document.getElementById('btnTogglePointEdit');
        if (btnPE) {
          btnPE.classList.remove('active');
          btnPE.innerHTML = '<i class="fas fa-hand-pointer"></i> Enable Point Editing';
        }
      }

      const active = skinMarks.toggle();
      btnToggle?.classList.toggle('active', active);
      btnToolbar?.classList.toggle('active', active);
      if (btnToggle) {
        btnToggle.innerHTML = active
          ? '<i class="fas fa-times"></i> Disable Mark Placement'
          : '<i class="fas fa-crosshairs"></i> Enable Mark Placement';
      }
      this.addHistory(active ? 'Skin mark placement enabled' : 'Skin mark placement disabled');
    };

    btnToggle?.addEventListener('click', toggleSkinMarks);
    btnToolbar?.addEventListener('click', toggleSkinMarks);

    // Mark type selector
    document.getElementById('skinMarkType')?.addEventListener('change', (e) => {
      skinMarks.activeMarkType = e.target.value;
      const typeDef = SkinMarkSystem.MARK_TYPES[e.target.value];
      if (typeDef) {
        document.getElementById('skinMarkColor').value = typeDef.defaultColor;
      }
    });

    // Size slider
    document.getElementById('skinMarkSize')?.addEventListener('mousedown', () => {
      this.caseManager.beginAction('Modified skin mark size');
    });
    document.getElementById('skinMarkSize')?.addEventListener('input', (e) => {
      const sizeNorm = parseInt(e.target.value) / 100;
      const actualSize = 0.005 + sizeNorm * 0.095;
      skinMarks.updateSelectedMark('size', actualSize);
      document.getElementById('skinMarkSizeValue').textContent = actualSize.toFixed(3);
    });
    document.getElementById('skinMarkSize')?.addEventListener('mouseup', () => {
      this.caseManager.endAction();
    });

    // Rotation slider
    document.getElementById('skinMarkRotation')?.addEventListener('mousedown', () => {
      this.caseManager.beginAction('Modified skin mark rotation');
    });
    document.getElementById('skinMarkRotation')?.addEventListener('input', (e) => {
      const degrees = parseInt(e.target.value);
      const radians = (degrees * Math.PI) / 180;
      skinMarks.updateSelectedMark('rotation', radians);
      document.getElementById('skinMarkRotationValue').textContent = degrees + '\u00B0';
    });
    document.getElementById('skinMarkRotation')?.addEventListener('mouseup', () => {
      this.caseManager.endAction();
    });

    // Color picker
    {
      let _markColorCapturing = false;
      const markColorPicker = document.getElementById('skinMarkColor');
      markColorPicker?.addEventListener('input', (e) => {
        if (!_markColorCapturing) {
          this.caseManager.beginAction('Modified skin mark color');
          _markColorCapturing = true;
        }
        skinMarks.updateSelectedMark('color', e.target.value);
      });
      markColorPicker?.addEventListener('change', () => {
        this.caseManager.endAction();
        _markColorCapturing = false;
      });
    }

    // Delete button
    document.getElementById('btnDeleteMark')?.addEventListener('click', () => {
      this.caseManager.pushState('Deleted skin mark');
      skinMarks.deleteSelectedMark();
      this.addHistory('Deleted skin mark');
    });

    // Clear all marks
    document.getElementById('btnClearAllMarks')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.caseManager.pushState('Cleared all skin marks');
      skinMarks.clearAll();
      this.addHistory('Cleared all skin marks');
    });

    // Callback: update UI when marks change
    skinMarks.onMarkChanged = () => {
      const count = skinMarks.getMarkCount();
      const countEl = document.getElementById('skinMarkCount');
      if (countEl) countEl.textContent = count;
      const propEl = document.getElementById('currentSkinMarkCount');
      if (propEl) propEl.textContent = count;

      // Show/hide selected-mark properties
      const propsPanel = document.getElementById('skinMarkProperties');
      if (propsPanel) {
        propsPanel.style.display = skinMarks.selectedMarkIndex >= 0 ? 'block' : 'none';
      }

      // Update property controls to reflect selected mark
      if (skinMarks.selectedMarkIndex >= 0) {
        const mark = skinMarks.marks[skinMarks.selectedMarkIndex];
        const sizeSlider = document.getElementById('skinMarkSize');
        const sizeValue = document.getElementById('skinMarkSizeValue');
        const rotSlider = document.getElementById('skinMarkRotation');
        const rotValue = document.getElementById('skinMarkRotationValue');
        const colorPicker = document.getElementById('skinMarkColor');

        if (sizeSlider) sizeSlider.value = Math.round(((mark.size - 0.005) / 0.095) * 100);
        if (sizeValue) sizeValue.textContent = mark.size.toFixed(3);
        if (rotSlider) rotSlider.value = Math.round((mark.rotation * 180) / Math.PI);
        if (rotValue) rotValue.textContent = Math.round((mark.rotation * 180) / Math.PI) + '\u00B0';
        if (colorPicker) colorPicker.value = mark.color;
      }

      this.caseManager.updateSkinMarks(skinMarks.exportState());
      this.updatePropertyPanel();
    };
  }

  // ─── Case Controls ───────────────────────────────────────────────────────

  bindCaseControls() {
    // Save
    document.getElementById('btnSaveCase')?.addEventListener('click', async () => {
      this.updateCaseFromUI();
      const result = await this.caseManager.save();
      if (result?.success) {
        this.addHistory('Case saved');
        this.updateCaseTitle();
      } else {
        this.addHistory('Save failed: ' + (result?.error || 'Unknown error'));
      }
    });

    // Load
    document.getElementById('btnLoadCase')?.addEventListener('click', async () => {
      if (window.electronAPI) {
        const result = await window.electronAPI.openDialog({
          title: 'Open Case File',
          filters: [{ name: 'REface Case', extensions: ['rfc'] }],
          properties: ['openFile'],
        });
        if (!result.canceled && result.filePaths?.length > 0) {
          await this.loadCase(result.filePaths[0]);
        }
      }
    });

    // New case
    document.getElementById('btnNewCase')?.addEventListener('click', () => {
      this.newCase();
    });

    // Export buttons
    ['OBJ', 'FBX', 'GLB'].forEach(format => {
      document.getElementById(`btnExport${format}`)?.addEventListener('click', () => {
        this.exportModel(format.toLowerCase());
      });
    });

    // Screenshot
    document.getElementById('btnExportPNG')?.addEventListener('click', () => {
      this.takeScreenshot();
    });

    // Case info fields — auto-update
    ['caseNumber', 'caseName', 'investigator'].forEach(field => {
      document.getElementById(field)?.addEventListener('input', (e) => {
        this.caseManager.updateCaseInfo(field, e.target.value);
        if (field === 'caseName' || field === 'caseNumber') {
          this.updateCaseTitle();
        }
      });
    });
    document.getElementById('caseDescription')?.addEventListener('input', (e) => {
      this.caseManager.updateCaseInfo('description', e.target.value);
    });
    document.getElementById('caseNotes')?.addEventListener('input', (e) => {
      this.caseManager.updateCaseInfo('notes', e.target.value);
    });
  }

  // ─── Group Collapse ──────────────────────────────────────────────────────

  bindGroupCollapse() {
    document.querySelectorAll('.control-group-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.btn-reset-group')) return; // Don't toggle when clicking reset

        const body = header.nextElementSibling;
        if (body) {
          body.classList.toggle('collapsed');
          header.classList.toggle('collapsed');
        }
      });
    });
  }

  // ─── Keyboard Shortcuts ──────────────────────────────────────────────────

  bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case 'z':
            e.preventDefault();
            this.undo();
            break;
          case 'y':
            e.preventDefault();
            this.redo();
            break;
          case 's':
            e.preventDefault();
            document.getElementById('btnSaveCase')?.click();
            break;
        }
      }

      // Number keys for views
      if (e.key === '1') this.scene.setView('front');
      if (e.key === '3') this.scene.setView('side');
      if (e.key === '7') this.scene.setView('top');
      if (e.key === '5') this.scene.setView('34');
    });
  }

  // ─── Backend Status ──────────────────────────────────────────────────────

  bindBackendStatus() {
    this.api.onStatusChange = (connected, data) => {
      const statusDot = document.querySelector('#backendStatus .status-dot');
      const statusText = document.querySelector('#backendStatus .status-text');
      const statusBar = document.getElementById('statusBackend');
      const blenderStatus = document.getElementById('statusBlender');

      if (connected) {
        statusDot?.classList.add('connected');
        if (statusText) statusText.textContent = 'Connected';
        if (statusBar) statusBar.innerHTML = '<span class="status-dot-small connected"></span> Backend: Connected';

        if (data?.blender_available) {
          if (blenderStatus) blenderStatus.innerHTML = '<i class="fas fa-blender"></i> Blender: Ready';
          blenderStatus?.classList.add('ready');
        } else {
          if (blenderStatus) blenderStatus.innerHTML = '<i class="fas fa-blender"></i> Blender: Not Found';
        }
      } else {
        statusDot?.classList.remove('connected');
        if (statusText) statusText.textContent = 'Offline';
        if (statusBar) statusBar.innerHTML = '<span class="status-dot-small"></span> Backend: Offline';
        if (blenderStatus) blenderStatus.innerHTML = '<i class="fas fa-blender"></i> Blender: N/A';
      }
    };

    this.api.startHealthCheck(5000);
  }

  // ─── Helper Methods ──────────────────────────────────────────────────────

  updateCaseFromUI() {
    this.caseManager.updateCaseInfo('caseNumber', document.getElementById('caseNumber')?.value || '');
    this.caseManager.updateCaseInfo('caseName', document.getElementById('caseName')?.value || 'Untitled');
    this.caseManager.updateCaseInfo('investigator', document.getElementById('investigator')?.value || '');
    this.caseManager.updateCaseInfo('description', document.getElementById('caseDescription')?.value || '');
    this.caseManager.updateCaseInfo('notes', document.getElementById('caseNotes')?.value || '');
    this.caseManager.updateMorphTargets(this.morpher.exportState());
    this.caseManager.updateHairParams(this.hair.getParams());
    if (this.skinMarkSystem) {
      this.caseManager.updateSkinMarks(this.skinMarkSystem.exportState());
    }
    this.caseManager.currentCase.cameraState = this.scene.getCameraState();
  }

  updateCaseTitle() {
    const titleEl = document.getElementById('caseTitle');
    if (titleEl) titleEl.textContent = this.caseManager.getTitle();
  }

  updateViewAngle(name) {
    const el = document.getElementById('viewAngle');
    if (el) el.textContent = name;
  }

  updatePropertyPanel() {
    const modCount = document.getElementById('modifiedCount');
    if (modCount) modCount.textContent = this.morpher.getModifiedCount();

    const hairStyleEl = document.getElementById('currentHairStyle');
    if (hairStyleEl) hairStyleEl.textContent = this.formatStyleName(this.hair.currentStyle);

    const skinToneEl = document.getElementById('currentSkinTone');
    const skinColor = this.caseManager.currentCase.appearance.skinColor;
    if (skinToneEl) {
      skinToneEl.innerHTML = `<span class="mini-swatch" style="background: ${skinColor};"></span>`;
    }

    const eyeColorEl = document.getElementById('currentEyeColor');
    const eyeColor = this.caseManager.currentCase.appearance.eyeColor;
    if (eyeColorEl) {
      eyeColorEl.innerHTML = `<span class="mini-swatch" style="background: ${eyeColor};"></span>`;
    }

    const markCountEl = document.getElementById('currentSkinMarkCount');
    if (markCountEl && this.skinMarkSystem) {
      markCountEl.textContent = this.skinMarkSystem.getMarkCount();
    }

    // Vertex count
    const polyEl = document.getElementById('polyCount');
    if (polyEl) polyEl.textContent = `Vertices: ${this.scene.getVertexCount().toLocaleString()}`;
  }

  addHistory(message) {
    this.historyLog.unshift(message);
    if (this.historyLog.length > 30) this.historyLog.pop();

    const historyList = document.getElementById('historyList');
    if (historyList) {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.textContent = message;
      historyList.prepend(item);

      // Limit displayed items
      while (historyList.children.length > 20) {
        historyList.removeChild(historyList.lastChild);
      }
    }
  }

  showLoading(text = 'Processing...') {
    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    if (overlay) overlay.style.display = 'flex';
    if (loadingText) loadingText.textContent = text;
  }

  hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  async takeScreenshot() {
    const dataUrl = this.scene.takeScreenshot();
    if (window.electronAPI) {
      const result = await window.electronAPI.saveDialog({
        title: 'Save Screenshot',
        defaultPath: `reface_screenshot_${Date.now()}.png`,
        filters: [{ name: 'PNG Image', extensions: ['png'] }],
      });
      if (!result.canceled && result.filePath) {
        const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
        await window.electronAPI.saveFile(result.filePath, base64Data);
        this.addHistory('Screenshot saved');
      }
    } else {
      // Browser fallback — download
      const link = document.createElement('a');
      link.download = `reface_screenshot_${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
      this.addHistory('Screenshot downloaded');
    }
  }

  async exportModel(format) {
    this.updateCaseFromUI();
    this.showLoading(`Exporting as ${format.toUpperCase()}...`);

    const result = await this.api.exportModel(format, this.caseManager.getExportData());
    this.hideLoading();

    if (result?.error) {
      this.addHistory(`Export failed: ${result.error}`);
    } else {
      this.addHistory(`Exported as ${format.toUpperCase()}`);
    }
  }

  async showExportDialog() {
    // Switch to case panel and scroll to export
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-panel="case"]')?.classList.add('active');
    document.getElementById('panel-case')?.classList.add('active');
  }

  newCase() {
    this.caseManager.newCase();
    this.morpher.resetAll();
    this.hair.setStyle('hair1');
    this.hair.setColor('#2c1b0e');
    this.scene.setSkinColor('#d4a574');
    if (this.skinMarkSystem) this.skinMarkSystem.clearAll();

    // Reset UI
    document.querySelectorAll('.morph-slider').forEach(s => {
      s.value = 50;
      const v = s.closest('.slider-control')?.querySelector('.slider-value');
      if (v) v.textContent = '50';
    });
    document.getElementById('caseNumber').value = '';
    document.getElementById('caseName').value = '';
    document.getElementById('investigator').value = '';
    document.getElementById('caseDescription').value = '';
    document.getElementById('caseNotes').value = '';

    this.updateCaseTitle();
    this.updatePropertyPanel();
    this.addHistory('New case created');
  }

  async loadCase(filePath) {
    this.showLoading('Loading case...');
    const data = await this.caseManager.load(filePath);
    this.hideLoading();

    if (data && !data.error) {
      // Restore morph values
      if (data.morphTargets) {
        this.morpher.loadState(data.morphTargets);
      }
      // Restore hair
      if (data.hairParams) {
        this.hair.loadState(data.hairParams);
      }
      // Restore appearance
      if (data.appearance?.skinColor) {
        this.scene.setSkinColor(data.appearance.skinColor);
      }
      // Restore skin marks
      if (data.skinMarks && this.skinMarkSystem) {
        this.skinMarkSystem.loadState(data.skinMarks);
      }
      // Restore camera
      if (data.cameraState) {
        this.scene.loadCameraState(data.cameraState);
      }
      // Update UI fields
      document.getElementById('caseNumber').value = data.caseNumber || '';
      document.getElementById('caseName').value = data.caseName || '';
      document.getElementById('investigator').value = data.investigator || '';
      document.getElementById('caseDescription').value = data.description || '';
      document.getElementById('caseNotes').value = data.notes || '';

      this.updateCaseTitle();
      this.updatePropertyPanel();
      this.addHistory(`Loaded case: ${data.caseName || 'Untitled'}`);
    } else {
      this.addHistory('Failed to load case');
    }
  }

  undo() {
    const state = this.caseManager.undo();
    if (state) {
      this.restoreState(state);
      this.addHistory('Undo');
    }
  }

  redo() {
    const state = this.caseManager.redo();
    if (state) {
      this.restoreState(state);
      this.addHistory('Redo');
    }
  }

  restoreState(state) {
    // Restore morph targets + slider UI
    if (state.morphTargets) {
      Object.entries(state.morphTargets).forEach(([param, value]) => {
        this.morpher.morphValues[param] = value;
        const slider = document.querySelector(`[data-param="${param}"] .morph-slider`);
        if (slider) {
          slider.value = value;
          const v = slider.closest('.slider-control')?.querySelector('.slider-value');
          if (v) v.textContent = value;
        }
      });
      this.morpher.applyAllMorphs();
    }

    // Restore hair params
    if (state.hairParams) {
      this.hair.loadState(state.hairParams);
      // Update hair slider UI
      document.querySelectorAll('.hair-slider').forEach(slider => {
        const control = slider.closest('.slider-control');
        const param = control?.dataset.param;
        if (param && param.startsWith('hair')) {
          const key = param.replace('hair', '').toLowerCase();
          const val = state.hairParams[key];
          if (val !== undefined) {
            slider.value = val;
            const vd = control?.querySelector('.slider-value');
            if (vd) vd.textContent = val;
          }
        }
      });
      // Update active hair style card
      if (state.hairParams.style) {
        document.querySelectorAll('.hair-style-card').forEach(c => {
          c.classList.toggle('active', c.dataset.style === state.hairParams.style);
        });
      }
      // Update hair color picker
      if (state.hairParams.color) {
        const picker = document.getElementById('hairColorPicker');
        if (picker) picker.value = state.hairParams.color;
        document.querySelectorAll('#hairColorPresets .color-swatch').forEach(s => {
          s.classList.toggle('active', s.dataset.color === state.hairParams.color);
        });
      }
      // Update facial hair dropdown
      if (state.hairParams.facialHair !== undefined) {
        const sel = document.getElementById('facialHairStyle');
        if (sel) sel.value = state.hairParams.facialHair;
      }
    }

    // Restore appearance (skin color, eye color)
    if (state.appearance) {
      if (state.appearance.skinColor) {
        this.scene.setSkinColor(state.appearance.skinColor);
        const skinPicker = document.getElementById('skinColorPicker');
        if (skinPicker) skinPicker.value = state.appearance.skinColor;
        document.querySelectorAll('#skinToneGrid .skin-swatch').forEach(s => {
          s.classList.toggle('active', s.dataset.color === state.appearance.skinColor);
        });
      }
      if (state.appearance.eyeColor) {
        document.querySelectorAll('#eyeColorPresets .color-swatch').forEach(s => {
          s.classList.toggle('active', s.dataset.color === state.appearance.eyeColor);
        });
      }
      if (state.appearance.ageRange) {
        const ageEl = document.getElementById('ageRange');
        if (ageEl) ageEl.value = state.appearance.ageRange;
      }
      if (state.appearance.sex) {
        const sexEl = document.getElementById('sexSelect');
        if (sexEl) sexEl.value = state.appearance.sex;
      }
    }

    // Restore skin marks
    if (state.skinMarks && this.skinMarkSystem) {
      this.skinMarkSystem.loadState(state.skinMarks);
    }

    this.updatePropertyPanel();
  }

  formatParamName(param) {
    return param.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
  }

  formatStyleName(style) {
    return style.replace(/_/g, ' ').replace(/^./, s => s.toUpperCase());
  }
}

window.UIController = UIController;
