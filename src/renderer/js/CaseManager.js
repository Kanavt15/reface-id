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
        eyeColor: '#634e34',
        ageRange: '25-35',
        sex: 'male',
      },
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
   * Save current case state to undo stack
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
}

window.CaseManager = CaseManager;
