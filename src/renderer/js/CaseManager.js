/**
 * CaseManager.js
 * Handles forensic case data — save, load, new case, and state management.
 */

class CaseManager {
  constructor(api) {
    this.api = api;
    this.currentCase = this.newCaseTemplate();
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndoSteps = 50;
    this._pendingSnapshot = null;
  }

  newCaseTemplate() {
    return {
      caseId: null,
      caseNumber: '',
      caseName: 'Untitled Case',
      investigator: '',
      description: '',
      notes: '',
      morphTargets: {},
      hairParams: {},
      appearance: {
        skinColor: '#d4a574',
        lipColor: null,
        eyeColor: '#634e34',
        eyeParams: {
          scale: 50,
          spacing: 50,
          posX: 50,
          posY: 50,
          posZ: 50,
          rotX: 50,
          rotY: 50,
          rotZ: 50,
          opacity: 100,
        },
        skinTextureParams: {
          age: 20,
          wrinkleDepth: 0,
          roughness: 30,
          poreDetail: 0,
          freckles: 0,
          skinOiliness: 0,
          sunDamage: 0,
        },
        ageRange: '25-35',
        sex: 'male',
        pigmentPaintData: null,
        glasses: {
          enabled: false,
          style: 'glasses1',
          frameColor: '#1a1a1a',
          lensColor: '#88ccff',
          lensOpacity: 20,
          scale: 100,
          posY: 0,
          posZ: 0,
          rotation: 0,
        },
      },
      skinMarks: [],
      decals: [],
      cameraState: null,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Start a new case
   */
  newCase() {
    this.currentCase = this.newCaseTemplate();
    this.undoStack = [];
    this.redoStack = [];
    return this.currentCase;
  }

  /**
   * Save current case state to undo stack.
   * IMPORTANT: Call this BEFORE modifying currentCase so the snapshot
   * captures the state the user can revert to.
   */
  pushState(description = '') {
    const snapshot = JSON.parse(JSON.stringify(this.currentCase));
    snapshot._description = description;
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxUndoSteps) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /**
   * Capture current state BEFORE a continuous change begins (e.g. slider drag).
   * Call this on mousedown / first input, then call endAction() when done.
   */
  beginAction(description = '') {
    // If there's already a pending snapshot that wasn't committed, commit it first
    // This prevents the undo system from getting stuck
    if (this._pendingSnapshot) {
      this.endAction();
    }
    this._pendingSnapshot = JSON.parse(JSON.stringify(this.currentCase));
    this._pendingSnapshot._description = description;
  }

  /**
   * Commit the before-snapshot captured by beginAction() to the undo stack.
   * Call this on mouseup / change event when the continuous operation ends.
   */
  endAction() {
    if (!this._pendingSnapshot) return;
    this.undoStack.push(this._pendingSnapshot);
    if (this.undoStack.length > this.maxUndoSteps) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this._pendingSnapshot = null;
  }

  /**
   * Cancel any pending action without committing it.
   * Use this when an action is abandoned (e.g., escape key pressed).
   */
  cancelAction() {
    this._pendingSnapshot = null;
  }

  /**
   * Undo last change
   */
  undo() {
    if (this.undoStack.length === 0) return null;
    const snapshot = JSON.parse(JSON.stringify(this.currentCase));
    this.redoStack.push(snapshot);
    this.currentCase = this.undoStack.pop();
    return this.currentCase;
  }

  /**
   * Redo last undo
   */
  redo() {
    if (this.redoStack.length === 0) return null;
    const snapshot = JSON.parse(JSON.stringify(this.currentCase));
    this.undoStack.push(snapshot);
    this.currentCase = this.redoStack.pop();
    return this.currentCase;
  }

  /**
   * Update case data
   */
  updateCaseInfo(field, value) {
    this.currentCase[field] = value;
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  /**
   * Update morph targets
   */
  updateMorphTargets(morphValues) {
    this.currentCase.morphTargets = { ...morphValues };
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  /**
   * Update hair params
   */
  updateHairParams(hairParams) {
    this.currentCase.hairParams = { ...hairParams };
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  /**
   * Update appearance
   */
  updateAppearance(key, value) {
    this.currentCase.appearance[key] = value;
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  /**
   * Update skin marks data
   */
  updateSkinMarks(marksArray) {
    this.currentCase.skinMarks = marksArray ? [...marksArray] : [];
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  /**
   * Update decals data
   */
  updateDecals(decalsArray) {
    this.currentCase.decals = decalsArray ? [...decalsArray] : [];
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  /**
   * Save case to backend
   */
  async save() {
    this.currentCase.modifiedAt = new Date().toISOString();
    const result = await this.api.saveCase(this.currentCase);
    if (result && result.caseId) {
      this.currentCase.caseId = result.caseId;
    }
    return result;
  }

  /**
   * Load case from file
   */
  async load(filePath) {
    const result = await this.api.loadCase(filePath);
    if (result && !result.error) {
      this.currentCase = { ...this.newCaseTemplate(), ...result };
      this.undoStack = [];
      this.redoStack = [];
    }
    return result;
  }

  /**
   * Get complete case data for export
   */
  getExportData() {
    return {
      ...this.currentCase,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Get case title for display
   */
  getTitle() {
    const num = this.currentCase.caseNumber ? `${this.currentCase.caseNumber} — ` : '';
    return `${num}${this.currentCase.caseName || 'Untitled Case'}`;
  }

  // ─── Export / Import ─────────────────────────────────────────────────

  /**
   * Export the complete current case to a downloadable .json file.
   * Includes all case details: metadata, morphTargets, hairParams, appearance,
   * skinMarks, decals, and camera state.
   */
  exportToFile() {
    const exportData = {
      ...this.currentCase,
      exportedAt: new Date().toISOString(),
      version: '1.0',
    };

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    // Create safe filename from case number and name
    const caseNum = this.currentCase.caseNumber || 'case';
    const caseName = this.currentCase.caseName || 'untitled';
    const safeName = `${caseNum}_${caseName}`.replace(/[^a-zA-Z0-9_\- ]/g, '_');
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    return true;
  }

  /**
   * Import a case from a .json file selected by the user.
   * Opens a file picker, parses the JSON, and loads the complete case.
   * Saves current case to undo stack before loading.
   * @returns {Promise<object|null>}  The imported case data, or null on failure
   */
  importFromFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.style.display = 'none';
      document.body.appendChild(input);

      input.addEventListener('change', () => {
        const file = input.files[0];
        document.body.removeChild(input);
        if (!file) { resolve(null); return; }

        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(reader.result);
            if (!parsed || typeof parsed !== 'object') {
              alert('Invalid case file — invalid JSON format.');
              resolve(null);
              return;
            }

            // Validate essential case structure
            if (!parsed.caseName && !parsed.caseNumber && !parsed.morphTargets) {
              alert('Invalid case file — missing required case data.');
              resolve(null);
              return;
            }

            // Save current state to undo before loading
            this.pushState('Before case import');

            // Merge imported data with template to ensure all fields exist
            const template = this.newCaseTemplate();
            this.currentCase = {
              ...template,
              ...parsed,
              caseId: null, // Generate new ID on next save
              createdAt: parsed.createdAt || new Date().toISOString(),
              modifiedAt: new Date().toISOString(),
            };

            // Clear redo stack since we've made a new change
            this.redoStack = [];

            const displayName = this.currentCase.caseName || this.currentCase.caseNumber || 'Imported Case';
            alert(`Case imported successfully: ${displayName}`);
            resolve(this.currentCase);
          } catch (e) {
            alert('Failed to parse case file. Ensure it is valid JSON.');
            console.error('[CaseManager] Import parse error', e);
            resolve(null);
          }
        };
        reader.onerror = () => {
          alert('Failed to read file.');
          resolve(null);
        };
        reader.readAsText(file);
      });

      // Handle cancel (no file selected)
      input.addEventListener('cancel', () => {
        document.body.removeChild(input);
        resolve(null);
      });

      input.click();
    });
  }
}

window.CaseManager = CaseManager;
