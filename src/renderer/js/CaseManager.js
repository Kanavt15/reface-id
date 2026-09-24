// Holds the current case and its undo/redo history, and saves, loads, imports and exports cases.

class CaseManager {
  constructor(api) {
    this.api = api;
    this.currentCase = this.newCaseTemplate();
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndoSteps = 50;
    this._pendingSnapshot = null;
  }

  // Makes a new case id straight away, so anything saved before the first backend save is never orphaned.
  static newCaseId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for runtimes without crypto.randomUUID.
    return 'case-' + Date.now().toString(36) + '-' +
           Math.random().toString(36).slice(2, 10);
  }

  // Returns a blank case with every field set to its default.
  newCaseTemplate() {
    return {
      caseId: CaseManager.newCaseId(),
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
        skinTextureParams: { ...SkinTextureSystem.DEFAULT_PARAMS },
        wrinklePaintData: null,
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
        // Placeholder matching FaceMaskSystem's defaults; app.js replaces it with the live state.
        faceMask: {
          enabled: false,
          style: 'mask1',
          maskColor: '#1c1c1e',
          strapColor: '#e6e6e6',
          opacity: 100,
          scale: 100,
          width: 100,
          coverage: 100,
          strapScaleL: 100,
          strapScaleR: 100,
          strapAngleL: 0,
          strapAngleR: 0,
          strapSplayL: 0,
          strapSplayR: 0,
          posX: 0,
          posY: 10,
          posZ: 0,
          rotX: 0,
          rotY: 0,
          rotZ: 0,
        },
        // Placeholder matching EarringSystem's defaults.
        earrings: {
          enabled: false,
          style: 'hoop',
          sideMode: 'both',
          metalColor: '#d4af37',
          polish: 82,
          size: 100,
          posX: 0,
          posY: 0,
          posZ: 0,
          tiltL: 3,
          tiltR: 3,
          splayL: 8,
          splayR: 8,
          dropL: 16,
          dropR: 16,
          spinL: -29,
          spinR: -29,
        },
        // Placeholder matching BandanaSystem's defaults.
        bandana: {
          enabled: false,
          style: 'paisley',
          tint: '#ffffff',
          opacity: 100,
          scale: 105,
          width: 84,
          depth: 74,
          hemFlare: 100,
          posX: 0,
          posY: 0,
          posZ: -38,
          rotX: 0,
          rotY: 0,
          rotZ: 0,
        },
        // Placeholder matching EyebrowPiercingSystem's defaults.
        browPiercing: {
          enabled: false,
          sideMode: 'both',
          metalColor: '#c8cdd2',
          polish: 88,
          size: 100,
          alongBrow: 92,
          posX: 2,
          posY: 35,
          posZ: 0,
          yawL: 27,
          yawR: 27,
          spinL: 110,
          spinR: 110,
        },
      },
      skinMarks: [],
      decals: [],
      cameraState: null,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    };
  }

  // Starts a fresh case.
  newCase() {
    this.currentCase = this.newCaseTemplate();
    this.undoStack = [];
    this.redoStack = [];
    return this.currentCase;
  }

  // Saves the current state for undo; call it before changing the case.
  pushState(description = '') {
    const snapshot = JSON.parse(JSON.stringify(this.currentCase));
    snapshot._description = description;
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.maxUndoSteps) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  // Takes an undo snapshot when a continuous change such as a slider drag begins.
  beginAction(description = '') {
    // Commit any leftover snapshot first so undo can't get stuck.
    if (this._pendingSnapshot) {
      this.endAction();
    }
    this._pendingSnapshot = JSON.parse(JSON.stringify(this.currentCase));
    this._pendingSnapshot._description = description;
  }

  // Commits the snapshot from beginAction() once the drag ends.
  endAction() {
    if (!this._pendingSnapshot) return;
    this.undoStack.push(this._pendingSnapshot);
    if (this.undoStack.length > this.maxUndoSteps) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this._pendingSnapshot = null;
  }

  // Undoes the last change.
  undo() {
    if (this.undoStack.length === 0) return null;
    const snapshot = JSON.parse(JSON.stringify(this.currentCase));
    this.redoStack.push(snapshot);
    this.currentCase = this.undoStack.pop();
    return this.currentCase;
  }

  // Redoes the last undone change.
  redo() {
    if (this.redoStack.length === 0) return null;
    const snapshot = JSON.parse(JSON.stringify(this.currentCase));
    this.undoStack.push(snapshot);
    this.currentCase = this.redoStack.pop();
    return this.currentCase;
  }

  // Updates one case detail field.
  updateCaseInfo(field, value) {
    this.currentCase[field] = value;
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  // Stores the current morph values.
  updateMorphTargets(morphValues) {
    this.currentCase.morphTargets = { ...morphValues };
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  // Stores the current hair settings.
  updateHairParams(hairParams) {
    this.currentCase.hairParams = { ...hairParams };
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  // Stores one appearance setting.
  updateAppearance(key, value) {
    this.currentCase.appearance[key] = value;
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  // Stores the skin marks.
  updateSkinMarks(marksArray) {
    this.currentCase.skinMarks = marksArray ? [...marksArray] : [];
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  // Stores the decals.
  updateDecals(decalsArray) {
    this.currentCase.decals = decalsArray ? [...decalsArray] : [];
    this.currentCase.modifiedAt = new Date().toISOString();
  }

  // Saves the case through the backend.
  async save() {
    this.currentCase.modifiedAt = new Date().toISOString();
    const result = await this.api.saveCase(this.currentCase);
    if (result && result.caseId) {
      this.currentCase.caseId = result.caseId;
    }
    return result;
  }

  // Loads a case file through the backend.
  async load(filePath) {
    const result = await this.api.loadCase(filePath);
    if (result && !result.error) {
      this.currentCase = { ...this.newCaseTemplate(), ...result };
      this.undoStack = [];
      this.redoStack = [];
    }
    return result;
  }

  // Returns the case title for display.
  getTitle() {
    const num = this.currentCase.caseNumber ? `${this.currentCase.caseNumber} — ` : '';
    return `${num}${this.currentCase.caseName || 'Untitled Case'}`;
  }

  // ─── Export / Import ─────────────────────────────────────────────────

  // Downloads the whole current case as a .json file.
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

  // Lets the user pick a .json case file and loads it, keeping the current case in undo history.
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
              // An imported case gets a fresh id right away.
              caseId: CaseManager.newCaseId(),
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
