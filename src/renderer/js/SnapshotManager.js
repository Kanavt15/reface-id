/**
 * SnapshotManager.js
 * Manages named snapshots of the face state so users can save and restore
 * specific stages of their work. Snapshots persist in localStorage for the
 * current case and include a small thumbnail for visual identification.
 */

class SnapshotManager {
  constructor(caseManager, sceneManager) {
    this.caseManager = caseManager;
    this.sceneManager = sceneManager;
    this.snapshots = [];          // { id, name, timestamp, thumbnail, state }
    this.maxSnapshots = 30;
    this._nextId = 1;
    this._storageKey = 'reface_snapshots';

    // Callbacks for UI updates
    this.onSnapshotsChanged = null;
  }

  /**
   * Capture the current face state as a named snapshot.
   * @param {string} name  User-supplied label (auto-generated if blank)
   * @returns {object}     The newly created snapshot metadata (without heavy state)
   */
  capture(name) {
    const state = JSON.parse(JSON.stringify(this.caseManager.currentCase));
    // Strip undo metadata that shouldn't pollute the snapshot
    delete state._description;

    // Save camera state alongside
    state.cameraState = this.sceneManager.getCameraState();

    // Generate a small thumbnail from the viewport
    let thumbnail = '';
    try {
      thumbnail = this._generateThumbnail();
    } catch (_) { /* viewport may not be ready */ }

    const snapshot = {
      id: this._nextId++,
      name: (name || '').trim() || `Snapshot ${this.snapshots.length + 1}`,
      timestamp: Date.now(),
      thumbnail,
      state,
    };

    this.snapshots.push(snapshot);

    // Enforce limit — remove oldest beyond max
    while (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }

    this._persist();
    this._notify();
    return { id: snapshot.id, name: snapshot.name, timestamp: snapshot.timestamp };
  }

  /**
   * Restore a previously captured snapshot by id.
   * Pushes the current state onto the undo stack first so the user can
   * still undo the restore action.
   * @param {number} id  Snapshot id
   * @returns {object|null}  The restored state, or null if not found
   */
  restore(id) {
    const snapshot = this.snapshots.find(s => s.id === id);
    if (!snapshot) return null;

    // Push current state to undo stack so restore is reversible
    this.caseManager.pushState('Before snapshot restore');

    // Deep-clone so the stored snapshot stays untouched
    const restored = JSON.parse(JSON.stringify(snapshot.state));
    this.caseManager.currentCase = restored;

    return restored;
  }

  /**
   * Update snapshot name.
   */
  rename(id, newName) {
    const snapshot = this.snapshots.find(s => s.id === id);
    if (!snapshot) return false;
    snapshot.name = (newName || '').trim() || snapshot.name;
    this._persist();
    this._notify();
    return true;
  }

  /**
   * Delete a snapshot by id.
   */
  delete(id) {
    const idx = this.snapshots.findIndex(s => s.id === id);
    if (idx === -1) return false;
    this.snapshots.splice(idx, 1);
    this._persist();
    this._notify();
    return true;
  }

  /**
   * Delete all snapshots.
   */
  deleteAll() {
    this.snapshots = [];
    this._persist();
    this._notify();
  }

  /**
   * Get lightweight list (no heavy state blobs) for UI display.
   */
  getList() {
    return this.snapshots.map(s => ({
      id: s.id,
      name: s.name,
      timestamp: s.timestamp,
      thumbnail: s.thumbnail,
      caseNumber: s.state?.caseNumber || '',
      caseName: s.state?.caseName || '',
      investigator: s.state?.investigator || '',
    }));
  }

  // ─── Persistence ───────────────────────────────────────────────────

  _persist() {
    try {
      const caseId = this.caseManager.currentCase.caseId || '_default';
      const key = `${this._storageKey}_${caseId}`;
      const payload = JSON.stringify({
        nextId: this._nextId,
        snapshots: this.snapshots,
      });
      localStorage.setItem(key, payload);
    } catch (e) {
      // localStorage quota exceeded — delete oldest thumbnails to free space
      console.warn('[SnapshotManager] localStorage write failed, trimming thumbnails', e);
      this._trimThumbnails();
      try {
        const caseId = this.caseManager.currentCase.caseId || '_default';
        const key = `${this._storageKey}_${caseId}`;
        localStorage.setItem(key, JSON.stringify({
          nextId: this._nextId,
          snapshots: this.snapshots,
        }));
      } catch (_) {
        console.error('[SnapshotManager] Cannot persist snapshots — storage full');
      }
    }
  }

  /**
   * Load snapshots for the current case from localStorage.
   */
  loadForCurrentCase() {
    try {
      const caseId = this.caseManager.currentCase.caseId || '_default';
      const key = `${this._storageKey}_${caseId}`;
      const raw = localStorage.getItem(key);
      if (raw) {
        const data = JSON.parse(raw);
        this.snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
        this._nextId = typeof data.nextId === 'number' ? data.nextId : 1;
      } else {
        this.snapshots = [];
        this._nextId = 1;
      }
    } catch (e) {
      console.warn('[SnapshotManager] Failed to load snapshots from localStorage', e);
      this.snapshots = [];
      this._nextId = 1;
    }
    this._notify();
  }

  // ─── Thumbnail helpers ─────────────────────────────────────────────

  _generateThumbnail() {
    // Render current frame and downscale to a tiny JPEG for compact storage
    this.sceneManager.renderer.render(this.sceneManager.scene, this.sceneManager.camera);
    const fullCanvas = this.sceneManager.canvas;

    const thumbW = 120;
    const thumbH = 90;
    const offscreen = document.createElement('canvas');
    offscreen.width = thumbW;
    offscreen.height = thumbH;
    const ctx = offscreen.getContext('2d');
    ctx.drawImage(fullCanvas, 0, 0, thumbW, thumbH);
    return offscreen.toDataURL('image/jpeg', 0.6);
  }

  _trimThumbnails() {
    // Remove thumbnails from oldest snapshots to reclaim storage
    const half = Math.ceil(this.snapshots.length / 2);
    for (let i = 0; i < half; i++) {
      this.snapshots[i].thumbnail = '';
    }
  }

  // ─── Notification ──────────────────────────────────────────────────

  _notify() {
    if (typeof this.onSnapshotsChanged === 'function') {
      this.onSnapshotsChanged(this.getList());
    }
  }
}

window.SnapshotManager = SnapshotManager;
