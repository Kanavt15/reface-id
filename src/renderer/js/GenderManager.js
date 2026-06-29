/* ══════════════════════════════════════════════════════════════════════
   GenderManager.js — Male / Female Mode Controller
   ReFace ID

   Manages:
     - The gender toggle UI in the topbar
     - Showing/hiding gender-specific sidebar tabs
     - Switching the active left-panel to the correct gender's version
     - Swapping the 3D head model in SceneManager
     - Persisting the chosen gender in localStorage
   ══════════════════════════════════════════════════════════════════════ */

class GenderManager {
  constructor(sceneManager) {
    this.sceneManager = sceneManager;

    // Always default to 'male' on app launch per user request
    this.currentGender = 'male';
    localStorage.setItem('rf-gender', 'male'); // Reset any stray stored state

    // Tab ↔ panel mapping for female-specific tabs
    // (male tabs use the original panel IDs already in the DOM)
    this.FEMALE_TABS = ['hair-female', 'makeup'];
    this.MALE_ONLY_TABS = ['hair']; // beard section lives inside panel-hair

    this._init();
  }

  /* ─── Initialisation ──────────────────────────────────────────────── */

  _init() {
    this._bindToggleButtons();
    this._bindMakeupControls();
    this._bindFemalePanelControls();
    // Apply the stored/default gender without animating (silent = true)
    this.setGender(this.currentGender, true);
  }

  /* ─── Public API ──────────────────────────────────────────────────── */

  /**
   * Switch to the given gender.
   * @param {'male'|'female'} gender
   * @param {boolean} [silent=false]  If true, skip the toast notification
   */
  setGender(gender, silent = false) {
    if (gender !== 'male' && gender !== 'female') return;

    const prev = this.currentGender;
    this.currentGender = gender;

    // Persist
    localStorage.setItem('rf-gender', gender);

    // Update toggle buttons
    this._updateToggleButtons(gender);

    // Update sidebar tabs visibility
    this._updateSidebarTabs(gender);

    // Swap 3D model if gender actually changed
    if (prev !== gender) {
      this._swapModel(gender);
      // If the currently-active tab belongs to the old gender, switch to face tab
      this._fixActiveTab(gender);
    }

    // Dispatch custom event for other systems to react
    document.dispatchEvent(new CustomEvent('genderchange', {
      detail: { gender, prev },
      bubbles: true,
    }));

    // Toast
    if (!silent && prev !== gender) {
      const label = gender === 'female' ? 'Female' : 'Male';
      this._toast(`Switched to ${label} mode`, 'info');
    }
  }

  toggle() {
    this.setGender(this.currentGender === 'male' ? 'female' : 'male');
  }

  /* ─── UI helpers ──────────────────────────────────────────────────── */

  _updateToggleButtons(gender) {
    const maleBtn   = document.getElementById('rf-gender-male');
    const femaleBtn = document.getElementById('rf-gender-female');
    if (!maleBtn || !femaleBtn) return;

    if (gender === 'male') {
      maleBtn.classList.add('active');
      femaleBtn.classList.remove('active');
    } else {
      femaleBtn.classList.add('active');
      maleBtn.classList.remove('active');
    }
  }

  _updateSidebarTabs(gender) {
    // New rf-sidebar-tabs (visual)
    const rfTabs = document.querySelectorAll('.rf-sidebar-tab[data-gender]');
    rfTabs.forEach(tab => {
      const tabGender = tab.getAttribute('data-gender');
      if (!tabGender) return; // tabs without data-gender are always visible
      tab.style.display = (tabGender === gender) ? '' : 'none';
    });

    // Legacy panel-tabs (hidden but kept for UIController bindings)
    const legacyTabs = document.querySelectorAll('.panel-tab[data-gender]');
    legacyTabs.forEach(tab => {
      const tabGender = tab.getAttribute('data-gender');
      if (!tabGender) return;
      tab.style.display = (tabGender === gender) ? '' : 'none';
    });

    // Show/hide gender-specific panel-content sections
    const allPanels = document.querySelectorAll('.panel-content[data-gender]');
    allPanels.forEach(panel => {
      const panelGender = panel.getAttribute('data-gender');
      if (!panelGender) return;
      panel.style.display = (panelGender === gender) ? '' : 'none';
    });

    // Also control the beard section inside panel-hair
    const beardSection = document.getElementById('rf-beard-section');
    if (beardSection) {
      beardSection.style.display = (gender === 'male') ? '' : 'none';
    }

    // Show/hide male-only control groups within shared panels
    document.querySelectorAll('[data-male-only]').forEach(el => {
      el.style.display = (gender === 'male') ? '' : 'none';
    });
    document.querySelectorAll('[data-female-only]').forEach(el => {
      el.style.display = (gender === 'female') ? '' : 'none';
    });
  }

  _fixActiveTab(gender) {
    // If the currently-active rf-sidebar-tab belongs to the opposite gender, click the face tab
    const activeTab = document.querySelector('.rf-sidebar-tab.active');
    if (!activeTab) return;

    const tabGender = activeTab.getAttribute('data-gender');
    if (tabGender && tabGender !== gender) {
      // Activate the gender-appropriate face tab
      const faceTabId = gender === 'female' ? 'rf-tab-face-female' : 'rf-tab-face-male';
      const faceTab = document.getElementById(faceTabId);
      if (faceTab) {
        faceTab.click();
      } else {
        // Fallback: click the first visible rf-sidebar-tab
        const firstVisible = document.querySelector('.rf-sidebar-tab:not([style*="display: none"])');
        if (firstVisible) firstVisible.click();
      }
    }
  }

  /* ─── Model Switching ─────────────────────────────────────────────── */

  _swapModel(gender) {
    if (!this.sceneManager) return;
    
    // Callback to re-wire systems to the newly loaded head mesh
    const cb = window.wireModelToSystems;

    if (gender === 'female') {
      this.sceneManager.loadFemaleModel(cb);
    } else {
      this.sceneManager.loadMaleModel(cb);
    }
  }

  /* ─── Makeup Controls ─────────────────────────────────────────────── */

  /**
   * Wire up all interactive controls inside #panel-makeup:
   * - Slider value display updates
   * - Finish toggle (Matte/Satin/Gloss/Metallic)
   * - Eyeshadow palette swatch selection
   * - Reset buttons
   */
  _bindMakeupControls() {
    // ── 1. Slider value display for all makeup sliders ──
    document.querySelectorAll('.makeup-slider').forEach(slider => {
      const row = slider.closest('.slider-row');
      const valEl = row ? row.querySelector('.slider-value') : null;
      if (valEl) {
        slider.addEventListener('input', () => {
          valEl.textContent = slider.value;
        });
      }
    });

    // ── 2. Lip finish toggle ──
    const finishBtns = document.querySelectorAll('#lipFinishToggle .rf-finish-btn');
    finishBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        finishBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // ── 3. Eyeshadow palette swatches ──
    const palette = document.getElementById('eyeshadowPalette');
    if (palette) {
      const swatches = palette.querySelectorAll('.makeup-color-swatch');
      swatches.forEach(swatch => {
        swatch.addEventListener('click', () => {
          swatches.forEach(s => s.classList.remove('active'));
          swatch.classList.add('active');
          // Mirror to color picker
          const picker = document.getElementById('eyeshadowColorPicker');
          if (picker) picker.value = swatch.dataset.color;
        });
      });
      // Reverse: color picker to swatch deselect
      const esColorPicker = document.getElementById('eyeshadowColorPicker');
      if (esColorPicker) {
        esColorPicker.addEventListener('input', () => {
          swatches.forEach(s => s.classList.remove('active'));
        });
      }
    }

    // ── 4. Foundation color swatches ──
    this._wireColorPreset('foundationColorPresets', 'foundationColorPicker');

    // ── 5. Blush color swatches ──
    this._wireColorPreset('blushColorPresets', 'blushColorPicker');

    // ── 6. Eyeliner color swatches ──
    this._wireColorPreset('eyelinerColorPresets', 'eyelinerColorPicker');

    // ── 7. Lip color swatches (female) ──
    this._wireColorPreset('lipColorPresetsFemale', 'lipColorPickerFemale');

    // ── 8. Reset All Makeup button ──
    const resetAllBtn = document.getElementById('btnResetAllMakeup');
    if (resetAllBtn) {
      resetAllBtn.addEventListener('click', () => {
        document.querySelectorAll('.makeup-slider').forEach(s => {
          s.value = s.defaultValue;
          s.dispatchEvent(new Event('input'));
        });
        // Reset finish toggle to Matte
        finishBtns.forEach(b => b.classList.remove('active'));
        finishBtns[0]?.classList.add('active');
        this._toast('Makeup reset to defaults', 'info');
      });
    }

    const resetMakeupPinned = document.getElementById('rf-makeup-reset-all');
    if (resetMakeupPinned) {
      resetMakeupPinned.addEventListener('click', () => {
        document.getElementById('btnResetAllMakeup')?.click();
      });
    }

    // ── 9. Reset Foundation ──
    document.getElementById('btnResetFoundation')?.addEventListener('click', () => {
      ['foundationCoverage','contourIntensity','highlightIntensity'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = 0; el.dispatchEvent(new Event('input')); }
      });
    });

    // ── 10. Reset Blush ──
    document.getElementById('btnResetBlush')?.addEventListener('click', () => {
      ['blushIntensity','blushSoftness'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.value = id === 'blushSoftness' ? 70 : 0;
          el.dispatchEvent(new Event('input'));
        }
      });
    });

    // ── 11. Reset Eyeshadow ──
    document.getElementById('btnResetEyeshadow')?.addEventListener('click', () => {
      ['eyeshadowIntensity','eyeshadowGlitter'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = 0; el.dispatchEvent(new Event('input')); }
      });
      const blend = document.getElementById('eyeshadowBlend');
      if (blend) { blend.value = 60; blend.dispatchEvent(new Event('input')); }
    });

    // ── 12. Reset Eyeliner ──
    document.getElementById('btnResetEyeliner')?.addEventListener('click', () => {
      ['eyelinerThickness','eyelinerWing'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value = 0; el.dispatchEvent(new Event('input')); }
      });
    });

    // ── 13. Reset Lip Color (female) ──
    document.getElementById('btnResetLipColorFemale')?.addEventListener('click', () => {
      const lipSlider = document.getElementById('lipColorIntensityFemale');
      if (lipSlider) { lipSlider.value = 0; lipSlider.dispatchEvent(new Event('input')); }
      finishBtns.forEach(b => b.classList.remove('active'));
      finishBtns[0]?.classList.add('active');
    });

    // ── 14. Female Hair Color swatch ──
    this._wireColorPreset('hairColorPresetsFemale', 'hairColorPickerFemale');
    this._wireColorPreset('eyebrowColorPresetsFemale', 'eyebrowColorPickerFemale');
    this._wireColorPreset('eyelashColorPresetsFemale', 'eyelashColorPickerFemale');
    this._wireColorPreset('lipColorPresetsFemale', 'lipColorPickerFemale');
  }

  /**
   * Wire female face panel slider value displays and Reset All button.
   */
  _bindFemalePanelControls() {
    // Female morph sliders value display
    document.querySelectorAll('#panel-face-female .morph-slider').forEach(slider => {
      const row = slider.closest('.slider-row');
      const valEl = row ? row.querySelector('.slider-value') : null;
      if (valEl) {
        slider.addEventListener('input', () => { valEl.textContent = slider.value; });
      }
    });

    // Female hair sliders
    document.querySelectorAll('#panel-hair-female input[type="range"]').forEach(slider => {
      const row = slider.closest('.slider-row');
      const valEl = row ? row.querySelector('.slider-value') : null;
      if (valEl) {
        slider.addEventListener('input', () => { valEl.textContent = slider.value; });
      }
    });

    // Female appearance sliders
    document.querySelectorAll('#panel-appearance-female input[type="range"]').forEach(slider => {
      const row = slider.closest('.slider-row');
      const valEl = row ? row.querySelector('.slider-value') : null;
      if (valEl) {
        slider.addEventListener('input', () => { valEl.textContent = slider.value; });
      }
    });

    // Skin tone grid (female)
    const skinGridFemale = document.getElementById('skinToneGridFemale');
    if (skinGridFemale) {
      skinGridFemale.querySelectorAll('.skin-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
          skinGridFemale.querySelectorAll('.skin-swatch').forEach(s => s.classList.remove('active'));
          swatch.classList.add('active');
          const picker = document.getElementById('skinColorPickerFemale');
          if (picker) picker.value = swatch.dataset.color;
          // Apply to scene if SceneManager available
          if (this.sceneManager && typeof this.sceneManager.setSkinColor === 'function') {
            this.sceneManager.setSkinColor(swatch.dataset.color);
          }
        });
      });
      const skinPickerF = document.getElementById('skinColorPickerFemale');
      if (skinPickerF) {
        skinPickerF.addEventListener('input', () => {
          if (this.sceneManager && typeof this.sceneManager.setSkinColor === 'function') {
            this.sceneManager.setSkinColor(skinPickerF.value);
          }
        });
      }
    }

    // Reset All female morphs
    document.getElementById('btnResetAllMorphsFemale')?.addEventListener('click', () => {
      document.querySelectorAll('#panel-face-female .morph-slider').forEach(slider => {
        slider.value = slider.defaultValue;
        slider.dispatchEvent(new Event('input'));
      });
      this._toast('Female morphs reset to defaults', 'info');
    });

    // Reset All female face pinned bar
    document.getElementById('rf-face-reset-all-female')?.addEventListener('click', () => {
      document.getElementById('btnResetAllMorphsFemale')?.click();
    });

    // Female hair style grid selection highlight
    const hairGridF = document.getElementById('hairStyleGridFemale');
    if (hairGridF) {
      hairGridF.querySelectorAll('.hair-style-card').forEach(card => {
        card.addEventListener('click', () => {
          hairGridF.querySelectorAll('.hair-style-card').forEach(c => c.classList.remove('active'));
          card.classList.add('active');
        });
      });
    }
  }

  /* ─── Utility: wire color preset swatches → color picker ─────────── */

  _wireColorPreset(presetsId, pickerId) {
    const container = document.getElementById(presetsId);
    const picker = document.getElementById(pickerId);
    if (!container) return;

    const swatches = container.querySelectorAll('[data-color]');
    swatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        swatches.forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        if (picker) picker.value = swatch.dataset.color;
      });
    });

    if (picker) {
      picker.addEventListener('input', () => {
        swatches.forEach(s => s.classList.remove('active'));
      });
    }
  }

  /* ─── Button Bindings ─────────────────────────────────────────────── */

  _bindToggleButtons() {
    const maleBtn   = document.getElementById('rf-gender-male');
    const femaleBtn = document.getElementById('rf-gender-female');

    if (maleBtn)   maleBtn.addEventListener('click',   () => this.setGender('male'));
    if (femaleBtn) femaleBtn.addEventListener('click', () => this.setGender('female'));
  }

  /* ─── Toast Helper ────────────────────────────────────────────────── */

  _toast(msg, type = 'info') {
    // Re-use the app's existing toast system if available
    if (typeof window.rfToast === 'function') {
      window.rfToast(msg, type);
      return;
    }
    // Fallback: simple DOM toast
    const container = document.getElementById('rf-toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `rf-toast rf-toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('rf-toast-visible'));
    setTimeout(() => {
      toast.classList.remove('rf-toast-visible');
      setTimeout(() => toast.remove(), 400);
    }, 2500);
  }
}

// Expose globally
window.GenderManager = GenderManager;
