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
        eyeColor: '#634e34',
        ageRange: '25-35',
        sex: 'male',
      },
      skinMarks: [],
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
    if (this._pendingSnapshot) return; // already capturing
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
