/* ══════════════════════════════════════════════════════════════════════
   ScreenRouter.js — Application Screen Transition Manager
   ReFace ID UI Redesign — Phase 2

   Manages transitions between:
     'hero'          → Full-screen landing page
     'case-setup'    → Case metadata form
     'input-method'  → Reconstruction method selection
     'editor'        → Main 3D editor (existing app)

   Designed to be non-destructive: the editor screen is always
   initialized in the DOM. Showing/hiding just controls visibility.
   ══════════════════════════════════════════════════════════════════════ */

class ScreenRouter {
  constructor() {
    this.screens = {
      'hero':         document.getElementById('rf-screen-hero'),
      'case-setup':   document.getElementById('rf-screen-case-setup'),
      'input-method': document.getElementById('rf-screen-input-method'),
      'editor':       document.getElementById('rf-screen-editor'),
    };

    // Data passed between screens (case form values, selected methods, etc.)
    this.caseData = {
      caseNumber:  '',
      caseName:    '',
      investigator: '',
      description: '',
      notes:       '',
    };
    this.selectedMethods = new Set();

    // Which screen is currently visible
    this.current = 'hero';

    // Transition duration — must match --rf-dur-screen in CSS (400ms)
    this.TRANSITION_MS = 400;
    this._transitioning = false;
  }

  /* ─── Public API ──────────────────────────────────────────────────── */

  /**
   * Navigate to a named screen with optional data payload.
   * @param {string} screenName  One of: 'hero', 'case-setup', 'input-method', 'editor'
   * @param {object} [data]      Optional data to merge into this.caseData
   */
  navigateTo(screenName, data = {}) {
    if (this._transitioning) return;
    if (screenName === this.current) return;
    if (!this.screens[screenName]) {
      console.warn(`[ScreenRouter] Unknown screen: "${screenName}"`);
      return;
    }

    // Merge any passed data
    if (data && typeof data === 'object') {
      Object.assign(this.caseData, data);
    }

    this._transitioning = true;

    const outEl = this.screens[this.current];
    const inEl  = this.screens[screenName];
    const prev  = this.current;

    // Fade out current
    this._fadeOut(outEl, () => {
      this.current = screenName;

      // Run any on-enter hooks
      this._onEnter(screenName, prev);

      // Fade in new screen
      this._fadeIn(inEl);

      setTimeout(() => {
        this._transitioning = false;
      }, this.TRANSITION_MS);
    });
  }

  /**
   * Show the hero screen (entry point of the app).
   * Called once on startup when hero is ready.
   */
  showHero() {
    if (this.current === 'hero') return;
    const editorEl = this.screens['editor'];
    const heroEl   = this.screens['hero'];

    // Instantly hide editor, show hero (no animation on initial load)
    editorEl.classList.remove('rf-screen-active');
    editorEl.classList.add('rf-screen-hidden');

    heroEl.classList.remove('rf-screen-hidden');
    heroEl.classList.add('rf-screen-active');

    this.current = 'hero';
  }

  /* ─── Private Transition Helpers ─────────────────────────────────── */

  _fadeOut(el, done) {
    el.classList.add('rf-screen-exit');
    el.classList.remove('rf-screen-active');

    setTimeout(() => {
      el.classList.remove('rf-screen-exit');
      el.classList.add('rf-screen-hidden');
      done();
    }, this.TRANSITION_MS);
  }

  _fadeIn(el) {
    el.classList.remove('rf-screen-hidden');
    el.classList.add('rf-screen-enter');

    // Next frame: mark active (triggers opacity transition)
    requestAnimationFrame(() => {
      el.classList.add('rf-screen-active');
      setTimeout(() => {
        el.classList.remove('rf-screen-enter');
      }, this.TRANSITION_MS);
    });
  }

  /* ─── Screen Enter Hooks ──────────────────────────────────────────── */

  _onEnter(screenName, _fromScreen) {
    switch (screenName) {
      case 'editor':
        this._onEnterEditor(_fromScreen);
        break;
      case 'hero':
        // nothing yet — hero animates via CSS
        break;
      case 'case-setup':
        // nothing yet — form animates via CSS
        break;
      case 'input-method':
        // nothing yet — cards animate via CSS
        break;
    }
  }

  /**
   * Called when transitioning INTO the editor screen.
   * Populates the Case Panel fields with data from the setup form,
   * then dispatches method-specific actions (open AI, start capture, etc.)
   */
  _onEnterEditor(_fromScreen) {
    // Populate Case Panel fields from gathered caseData
    const fieldMap = {
      'caseNumber':   this.caseData.caseNumber,
      'caseName':     this.caseData.caseName,
      'investigator': this.caseData.investigator,
      'caseDescription': this.caseData.description,
      'caseNotes':    this.caseData.notes,
    };

    Object.entries(fieldMap).forEach(([id, value]) => {
      if (!value) return;
      const el = document.getElementById(id);
      if (el) {
        el.value = value;
        // Dispatch change event so CaseManager picks it up
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    // Update the title bar case title if caseName was provided
    const caseTitle = document.getElementById('caseTitle');
    if (caseTitle && this.caseData.caseName) {
      const num = this.caseData.caseNumber ? `${this.caseData.caseNumber} — ` : '';
      caseTitle.textContent = `${num}${this.caseData.caseName}`;
    }

    // After a short delay (let editor finish rendering), dispatch method actions
    if (this.selectedMethods.size > 0) {
      setTimeout(() => this._dispatchMethodActions(), 300);
    }
  }

  /**
   * Trigger UI actions based on which input methods the user selected.
   */
  _dispatchMethodActions() {
    // Always open the relevant panel first based on priority
    if (this.selectedMethods.has('text-description') ||
        this.selectedMethods.has('upload-photos')) {
      // Open AI panel
      const aiTab = document.querySelector('.panel-tab[data-panel="ai"]');
      if (aiTab) aiTab.click();

      // Focus the AI chat input for text-description
      if (this.selectedMethods.has('text-description')) {
        setTimeout(() => {
          const aiInput = document.getElementById('aiChatInput');
          if (aiInput) aiInput.focus();
        }, 100);
      }

      // Trigger upload for upload-photos
      if (this.selectedMethods.has('upload-photos')) {
        setTimeout(() => {
          const uploadBtn = document.getElementById('aiMenuUploadBtn');
          if (uploadBtn) uploadBtn.click();
        }, 150);
      }

    } else if (this.selectedMethods.has('live-capture')) {
      // Trigger face capture modal
      const captureBtn = document.getElementById('btnFaceCapture');
      if (captureBtn) captureBtn.click();

    } else if (this.selectedMethods.has('manual-editor')) {
      // Open Face panel
      const faceTab = document.querySelector('.panel-tab[data-panel="face"]');
      if (faceTab) faceTab.click();
    }
  }

  /* ─── Form Data Collectors ────────────────────────────────────────── */

  /**
   * Read case setup form values into this.caseData.
   * Called before navigating away from the case-setup screen.
   */
  collectCaseSetupData() {
    this.caseData.caseNumber  = this._val('rf-form-case-number');
    this.caseData.caseName    = this._val('rf-form-case-name');
    this.caseData.investigator= this._val('rf-form-investigator');
    this.caseData.description = this._val('rf-form-description');
    this.caseData.notes       = this._val('rf-form-notes');
  }

  /**
   * Read selected method cards into this.selectedMethods.
   */
  collectSelectedMethods() {
    this.selectedMethods.clear();
    document.querySelectorAll('.rf-method-card.rf-method-selected').forEach(card => {
      const method = card.getAttribute('data-method');
      if (method) this.selectedMethods.add(method);
    });
  }

  /* ─── Utility ─────────────────────────────────────────────────────── */

  _val(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  /* ─── Button Bindings ─────────────────────────────────────────────── */

  /**
   * Wire up all navigation buttons.
   * Called from app.js after DOM is ready.
   */
  bindNavigation() {
    // Hero screen
    this._on('rf-hero-new-case', 'click', () => {
      this.navigateTo('case-setup');
    });

    this._on('rf-hero-load-case', 'click', () => {
      // Navigate to editor first, then trigger load dialog
      this.navigateTo('editor');
      setTimeout(() => {
        const loadBtn = document.getElementById('btnLoadCase');
        if (loadBtn) loadBtn.click();
      }, this.TRANSITION_MS + 100);
    });

    // "Open Editor" button — go straight to editor
    this._on('rf-hero-open-editor', 'click', () => {
      this.navigateTo('editor');
    });

    // Hero window controls — proxy to existing titlebar buttons
    this._on('rf-wc-close', 'click', () => {
      document.getElementById('btnClose')?.click();
    });
    this._on('rf-wc-min', 'click', () => {
      document.getElementById('btnMinimize')?.click();
    });
    this._on('rf-wc-max', 'click', () => {
      document.getElementById('btnMaximize')?.click();
    });

    // Case Setup screen
    this._on('rf-case-setup-back', 'click', () => {
      this.navigateTo('hero');
    });

    this._on('rf-case-setup-continue', 'click', () => {
      if (!this._validateCaseSetup()) return;
      this.collectCaseSetupData();
      this.navigateTo('input-method');
    });

    // Input Method screen
    this._on('rf-input-method-back', 'click', () => {
      this.navigateTo('case-setup');
    });

    this._on('rf-input-method-begin', 'click', () => {
      this.collectSelectedMethods();
      this.navigateTo('editor');
    });

    this._on('rf-input-method-skip', 'click', () => {
      this.selectedMethods.clear();
      this.navigateTo('editor');
    });

    // Method row toggling (event delegation — works for both cards and rows)
    const methodGrid = document.getElementById('rf-method-grid');
    if (methodGrid) {
      methodGrid.addEventListener('click', (e) => {
        const row = e.target.closest('[data-method]');
        if (!row) return;
        row.classList.toggle('rf-method-selected');
        this._updateBeginButton();
      });
    }

    // Case Setup — live validation to enable Continue button
    ['rf-form-case-number', 'rf-form-case-name'].forEach(id => {
      this._onInput(id, () => this._updateContinueButton());
    });
  }

  /* ─── Validation ──────────────────────────────────────────────────── */

  _validateCaseSetup() {
    let valid = true;

    const required = [
      { id: 'rf-form-case-number', errorId: 'rf-error-case-number' },
      { id: 'rf-form-case-name',   errorId: 'rf-error-case-name' },
    ];

    required.forEach(({ id, errorId }) => {
      const input = document.getElementById(id);
      const error = document.getElementById(errorId);
      if (!input) return;

      if (!input.value.trim()) {
        input.classList.add('rf-error');
        if (error) error.classList.add('rf-visible');
        valid = false;
      } else {
        input.classList.remove('rf-error');
        if (error) error.classList.remove('rf-visible');
      }
    });

    return valid;
  }

  _updateContinueButton() {
    const btn = document.getElementById('rf-case-setup-continue');
    if (!btn) return;
    const num  = this._val('rf-form-case-number');
    const name = this._val('rf-form-case-name');
    if (num && name) {
      btn.disabled = false;
      btn.classList.remove('rf-cta-disabled');
    } else {
      btn.disabled = true;
      btn.classList.add('rf-cta-disabled');
    }
  }

  _updateBeginButton() {
    const btn = document.getElementById('rf-input-method-begin');
    if (!btn) return;
    const anySelected = document.querySelector('[data-method].rf-method-selected');
    if (anySelected) {
      btn.disabled = false;
      btn.classList.remove('rf-cta-disabled');
    } else {
      btn.disabled = true;
      btn.classList.add('rf-cta-disabled');
    }
  }

  /* ─── Event Helper ────────────────────────────────────────────────── */

  _on(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  }

  _onInput(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', handler);
  }
}

// Expose globally so app.js and other modules can use it
window.ScreenRouter = ScreenRouter;
