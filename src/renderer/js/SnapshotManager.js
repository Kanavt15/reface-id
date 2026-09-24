// Saves named snapshots of the face for each case in the backend database, queuing them locally while the backend is offline.

class SnapshotManager {
  constructor(caseManager, sceneManager, api) {
    this.caseManager = caseManager;
    this.sceneManager = sceneManager;
    this.api = api;

    // Each entry holds uid (stable client id), id (server row id), name, timestamp, thumbnail, state (loaded on demand) and pending (still queued).
    this.snapshots = [];
    this.maxSnapshots = 100;

    this._outboxKey = 'reface_snapshot_outbox';
    this._legacyPrefix = 'reface_snapshots_';
    // Must match db.PENDING_CASE_ID; recovered old snapshots wait here until a real case adopts them.
    this._pendingCaseId = '__pending_migration__';
    this._caseId = null;
    this._flushing = false;
    this._loadedCaseId = null;   // which case the in-memory list belongs to
    this._loadedReal = false;    // whether that case had a real identity then

    this.onSnapshotsChanged = null;
    this.onStatus = null;          // (message, kind) for operator-visible notices
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  // Reloads only if the app has moved to another case, or the current case has just been given a real identity.
  async refreshIfCaseChanged() {
    const caseId = this._currentCaseId();
    const real = this._isRealCase();
    if (caseId === this._loadedCaseId && real === this._loadedReal) return false;
    await this.loadForCurrentCase();
    return true;
  }

  // Loads the current case's snapshots, sending queued ones first and adopting any recovered ones.
  async loadForCurrentCase() {
    const caseId = this._currentCaseId();
    this._caseId = caseId;
    this._loadedCaseId = caseId;
    this._loadedReal = this._isRealCase();

    this._migrateLegacyLocalStorage();

    // Send the queue first so the list includes everything that is about to be written.
    await this.flushOutbox();

    // Only a real case adopts recovered snapshots, never the blank template the app boots with.
    let adopted = 0;
    if (this._isRealCase()) {
      try {
        adopted = await this.api.adoptPendingSnapshots(caseId, this._caseMeta());
      } catch (err) {
        if (!err.offline) console.warn('[SnapshotManager] adopt failed', err);
      }
    }

    let fromServer = [];
    let offline = false;
    try {
      fromServer = await this.api.listSnapshots(caseId);
    } catch (err) {
      offline = !!err.offline;
      if (!offline) console.warn('[SnapshotManager] list failed', err);
    }

    this.snapshots = fromServer.map(r => this._fromServer(r));

    // Also show captures still queued for this case, marked as pending.
    for (const item of this._readOutbox()) {
      if (item.caseId !== caseId) continue;
      if (this.snapshots.some(s => s.uid === item.clientUuid)) continue;
      this.snapshots.push({
        uid: item.clientUuid,
        id: null,
        name: item.name,
        timestamp: item.timestamp,
        thumbnail: item.thumbnail,
        state: item.state,
        pending: true,
      });
    }

    this._sort();
    this._notify();

    if (adopted) {
      this._status(`${adopted} snapshot(s) recovered from before the database ` +
                   `were added to this case.`, 'ok');
    }

    return this.snapshots.length;
  }

  // Tells whether the operator has given this case an identity yet.
  _isRealCase() {
    const c = this.caseManager.currentCase;
    return !!(c.caseNumber || '').trim() ||
           ((c.caseName || '').trim() !== '' && c.caseName !== 'Untitled Case');
  }

  // ─── Capture ───────────────────────────────────────────────────────────

  // Saves the current face as a named snapshot, in the database or in the offline queue.
  async capture(name) {
    const caseId = this._currentCaseId();
    const state = JSON.parse(JSON.stringify(this.caseManager.currentCase));
    delete state._description;          // undo bookkeeping, not part of the state

    try {
      state.cameraState = this.sceneManager.getCameraState();
    } catch (_) { /* camera not ready */ }

    let thumbnail = '';
    try {
      thumbnail = this._generateThumbnail();
    } catch (_) { /* viewport may not be ready */ }

    const entry = {
      uid: this._uuid(),
      id: null,
      name: (name || '').trim() || `Snapshot ${this.snapshots.length + 1}`,
      timestamp: Date.now(),
      thumbnail,
      state,
      pending: true,
    };

    // Queue first, send second, so a crash in between can't lose the snapshot.
    this._enqueue({
      clientUuid: entry.uid,
      caseId,
      name: entry.name,
      timestamp: entry.timestamp,
      thumbnail: entry.thumbnail,
      state: entry.state,
      caseMeta: this._caseMeta(),
    });

    this.snapshots.push(entry);
    this._sort();
    this._notify();

    await this.flushOutbox();
    return { uid: entry.uid, id: entry.id, name: entry.name, timestamp: entry.timestamp };
  }

  // ─── Outbox ────────────────────────────────────────────────────────────

  // Reads the offline queue from local storage.
  _readOutbox() {
    try {
      const raw = localStorage.getItem(this._outboxKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('[SnapshotManager] outbox unreadable, starting empty', e);
      return [];
    }
  }

  // Writes the offline queue to local storage, reporting loudly if storage is full.
  _writeOutbox(items) {
    try {
      localStorage.setItem(this._outboxKey, JSON.stringify(items));
      return true;
    } catch (e) {
      // If the queue can't be written, say so instead of silently dropping the capture.
      console.error('[SnapshotManager] outbox write failed — storage full', e);
      this._status('Snapshot could not be queued: local storage is full.', 'error');
      return false;
    }
  }

  // Adds a capture to the offline queue.
  _enqueue(payload) {
    const items = this._readOutbox();
    items.push(payload);
    this._writeOutbox(items);
  }

  // Sends every queued capture to the database, oldest first, stopping at the first network failure.
  async flushOutbox() {
    if (this._flushing) return;
    this._flushing = true;

    try {
      let items = this._readOutbox();
      if (!items.length) return;

      const remaining = [];
      let offline = false;

      for (const item of items) {
        if (offline) { remaining.push(item); continue; }

        try {
          const row = await this.api.createSnapshot({
            caseId: item.caseId,
            clientUuid: item.clientUuid,
            name: item.name,
            state: item.state,
            thumbnail: item.thumbnail,
            caseMeta: item.caseMeta,
          });

          const local = this.snapshots.find(s => s.uid === item.clientUuid);
          if (local) {
            local.id = row.id;
            local.pending = false;
            local.timestamp = this._toMs(row.timestamp) || local.timestamp;
          }
        } catch (err) {
          if (err.offline) {
            offline = true;
            remaining.push(item);
          } else {
            // A rejected snapshot would block the queue forever, so drop it and report it.
            console.error('[SnapshotManager] snapshot rejected, dropping', item.name, err);
            this._status(`Snapshot "${item.name}" could not be saved: ${err.message}`, 'error');
            const local = this.snapshots.findIndex(s => s.uid === item.clientUuid);
            if (local !== -1) this.snapshots.splice(local, 1);
          }
        }
      }

      this._writeOutbox(remaining);
      if (remaining.length) {
        this._status(`${remaining.length} snapshot(s) queued — backend offline.`, 'warn');
      }
      this._notify();
    } finally {
      this._flushing = false;
    }
  }

  // ─── Read ──────────────────────────────────────────────────────────────

  // Fetches one snapshot's full state; the list leaves it out to stay light.
  async getFullState(uid) {
    const entry = this.snapshots.find(s => s.uid === uid);
    if (!entry) return null;
    if (entry.state) return entry.state;

    try {
      const row = await this.api.getSnapshot(entry.id);
      entry.state = row.state;
      return entry.state;
    } catch (err) {
      console.error('[SnapshotManager] could not fetch snapshot state', err);
      this._status('Could not read that snapshot from the database.', 'error');
      return null;
    }
  }

  // Restores a snapshot into the current case, putting the current state on the undo stack first.
  async restore(uid) {
    const state = await this.getFullState(uid);
    if (!state) return null;

    this.caseManager.pushState('Before snapshot restore');

    const restored = JSON.parse(JSON.stringify(state));
    // Keep the live case id so restoring never moves the case under another id.
    restored.caseId = this._currentCaseId();
    this.caseManager.currentCase = restored;

    return restored;
  }

  // Returns a light list of snapshots for the UI, without the full states.
  getList() {
    return this.snapshots.map(s => ({
      uid: s.uid,
      id: s.id,
      name: s.name,
      timestamp: s.timestamp,
      thumbnail: s.thumbnail,
      pending: !!s.pending,
      caseNumber: s.state?.caseNumber || this.caseManager.currentCase.caseNumber || '',
      caseName: s.state?.caseName || '',
      investigator: s.state?.investigator || this.caseManager.currentCase.investigator || '',
    }));
  }

  // ─── Mutate ────────────────────────────────────────────────────────────

  // Renames a snapshot, rolling back if the database refuses.
  async rename(uid, newName) {
    const entry = this.snapshots.find(s => s.uid === uid);
    if (!entry) return false;

    const name = (newName || '').trim();
    if (!name || name === entry.name) return false;

    const previous = entry.name;
    entry.name = name;
    this._notify();

    if (entry.pending) {
      // Still queued, so rename it in the queue too.
      const items = this._readOutbox();
      const queued = items.find(i => i.clientUuid === uid);
      if (queued) { queued.name = name; this._writeOutbox(items); }
      return true;
    }

    try {
      await this.api.renameSnapshot(entry.id, name);
      return true;
    } catch (err) {
      entry.name = previous;            // the database is the truth; roll back
      this._notify();
      this._status(`Rename failed: ${err.message}`, 'error');
      return false;
    }
  }

  // Deletes a snapshot from the database or the queue.
  async delete(uid) {
    const idx = this.snapshots.findIndex(s => s.uid === uid);
    if (idx === -1) return false;
    const entry = this.snapshots[idx];

    if (entry.pending) {
      this._writeOutbox(this._readOutbox().filter(i => i.clientUuid !== uid));
      this.snapshots.splice(idx, 1);
      this._notify();
      return true;
    }

    try {
      await this.api.deleteSnapshot(entry.id);
      this.snapshots.splice(idx, 1);
      this._notify();
      return true;
    } catch (err) {
      this._status(`Delete failed: ${err.message}`, 'error');
      return false;
    }
  }

  // Deletes every snapshot for the current case.
  async deleteAll() {
    const caseId = this._currentCaseId();
    try {
      await this.api.clearSnapshots(caseId);
    } catch (err) {
      this._status(`Clear failed: ${err.message}`, 'error');
      return false;
    }
    this._writeOutbox(this._readOutbox().filter(i => i.caseId !== caseId));
    this.snapshots = [];
    this._notify();
    return true;
  }

  // ─── Export / Import ───────────────────────────────────────────────────

  // Saves one snapshot to a .json file through the Electron save dialog, with a browser download as fallback.
  async exportToFile(uid) {
    const entry = this.snapshots.find(s => s.uid === uid);
    if (!entry) return false;

    const state = await this.getFullState(uid);
    if (!state) return false;

    const payload = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      name: entry.name,
      timestamp: entry.timestamp,
      thumbnail: entry.thumbnail,
      state,
    };
    const json = JSON.stringify(payload, null, 2);
    const safeName = entry.name.replace(/[^a-zA-Z0-9_\- ]/g, '_').trim() || 'snapshot';
    const filename = `snapshot_${safeName}.json`;

    if (window.electronAPI?.saveDialog && window.electronAPI?.saveFile) {
      try {
        const result = await window.electronAPI.saveDialog({
          title: 'Export Snapshot',
          defaultPath: filename,
          filters: [
            { name: 'Snapshot JSON', extensions: ['json'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });
        if (result.canceled || !result.filePath) return false;

        await window.electronAPI.saveFile(result.filePath, this._toBase64(json));

        this._status(`Snapshot exported to ${result.filePath}`, 'ok');
        return true;
      } catch (err) {
        console.error('[SnapshotManager] export failed', err);
        this._status(`Export failed: ${err.message}`, 'error');
        return false;
      }
    }

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }

  // Imports a snapshot from a .json file, accepting both the current and the older format.
  async importFromFile() {
    const file = await this._pickFile();
    if (!file) return null;

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      this._status('Could not parse that file — it is not valid JSON.', 'error');
      return null;
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.state) {
      this._status('Invalid snapshot file — no state data in it.', 'error');
      return null;
    }

    const caseId = this._currentCaseId();
    const entry = {
      uid: this._uuid(),
      id: null,
      name: (parsed.name || 'Imported snapshot').toString().slice(0, 60),
      timestamp: this._toMs(parsed.timestamp) || Date.now(),
      thumbnail: parsed.thumbnail || '',
      state: parsed.state,
      pending: true,
    };

    this._enqueue({
      clientUuid: entry.uid,
      caseId,
      name: entry.name,
      timestamp: entry.timestamp,
      thumbnail: entry.thumbnail,
      state: entry.state,
      caseMeta: this._caseMeta(),
    });

    this.snapshots.push(entry);
    this._sort();
    this._notify();
    await this.flushOutbox();

    return { uid: entry.uid, name: entry.name, timestamp: entry.timestamp };
  }

  // Opens a file picker and resolves with the chosen file, or null if cancelled.
  _pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      document.body.appendChild(input);

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        input.remove();
        resolve(value);
      };

      input.addEventListener('change', () => finish(input.files[0] || null));
      // Not every runtime fires 'cancel', so a focus fallback stops the promise hanging.
      input.addEventListener('cancel', () => finish(null));
      window.addEventListener('focus', () => setTimeout(() => finish(null), 500),
        { once: true });

      input.click();
    });
  }

  // ─── Migration ─────────────────────────────────────────────────────────

  // Moves snapshots from the old localStorage storage into the queue, renaming the old keys instead of deleting them.
  _migrateLegacyLocalStorage() {
    let keys;
    try {
      keys = Object.keys(localStorage).filter(
        k => k.startsWith(this._legacyPrefix) && !k.includes('_migrated_'));
    } catch (_) {
      return;
    }
    if (!keys.length) return;

    const meta = this._caseMeta();
    const queued = this._readOutbox();
    let moved = 0;

    for (const key of keys) {
      let data;
      try {
        data = JSON.parse(localStorage.getItem(key));
      } catch (_) {
        continue;
      }
      const list = Array.isArray(data?.snapshots) ? data.snapshots : [];

      for (const old of list) {
        if (!old || !old.state) continue;
        // A fixed id per old snapshot means running the migration twice can't create a duplicate.
        const uid = `legacy-${key}-${old.id}`;
        if (queued.some(i => i.clientUuid === uid)) continue;

        queued.push({
          clientUuid: uid,
          // Parked, not assigned — see _pendingCaseId.
          caseId: this._pendingCaseId,
          name: old.name || 'Recovered snapshot',
          timestamp: this._toMs(old.timestamp) || Date.now(),
          thumbnail: old.thumbnail || '',
          state: old.state,
          caseMeta: meta,
        });
        moved++;
      }

      try {
        localStorage.setItem(key.replace(this._legacyPrefix,
          `${this._legacyPrefix}migrated_`), localStorage.getItem(key));
        localStorage.removeItem(key);
      } catch (_) { /* keep the original if the rename cannot be written */ }
    }

    if (moved) {
      this._writeOutbox(queued);
      console.log(`[SnapshotManager] migrated ${moved} legacy snapshot(s) to the database`);
      this._status(`Recovered ${moved} snapshot(s) from local storage.`, 'ok');
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  // Returns the current case id, creating one if an old case file has none.
  _currentCaseId() {
    let id = this.caseManager.currentCase.caseId;
    if (!id) {
      // Older .rfc files can arrive without an id.
      id = CaseManager.newCaseId();
      this.caseManager.currentCase.caseId = id;
    }
    return id;
  }

  // Returns the case number and name sent along with snapshots.
  _caseMeta() {
    const c = this.caseManager.currentCase;
    return {
      caseNumber: c.caseNumber || '',
      caseName: c.caseName || '',
      investigator: c.investigator || '',
      description: c.description || '',
      notes: c.notes || '',
    };
  }

  // Converts a database row into a snapshot entry.
  _fromServer(row) {
    return {
      uid: row.clientUuid || `server-${row.id}`,
      id: row.id,
      name: row.name,
      timestamp: this._toMs(row.timestamp),
      thumbnail: row.thumbnail || '',
      state: null,               // fetched on demand
      pending: false,
    };
  }

  // Converts a date string or number to milliseconds.
  _toMs(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  // Sorts snapshots by time and drops the oldest past the limit.
  _sort() {
    this.snapshots.sort((a, b) => a.timestamp - b.timestamp);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-this.maxSnapshots);
    }
  }

  // Makes a unique id for a new snapshot.
  _uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'snap-' + Date.now().toString(36) + '-' +
           Math.random().toString(36).slice(2, 10);
  }

  // Encodes UTF-8 text as base64 in chunks, so non-English names and large snapshots both work.
  _toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // Renders the current view into a small 4:3 thumbnail.
  _generateThumbnail() {
    this.sceneManager.renderFrame();
    const fullCanvas = this.sceneManager.canvas;

    // 4:3 to match the space the snapshot card leaves for it.
    const thumbW = 160;
    const thumbH = 120;
    const offscreen = document.createElement('canvas');
    offscreen.width = thumbW;
    offscreen.height = thumbH;
    const ctx = offscreen.getContext('2d');
    ctx.drawImage(fullCanvas, 0, 0, thumbW, thumbH);
    return offscreen.toDataURL('image/jpeg', 0.7);
  }

  // Shows a status message to the operator, or logs it.
  _status(message, kind = 'info') {
    if (typeof this.onStatus === 'function') this.onStatus(message, kind);
    else console.log(`[SnapshotManager] ${message}`);
  }

  // Tells the UI that the snapshot list changed.
  _notify() {
    if (typeof this.onSnapshotsChanged === 'function') {
      this.onSnapshotsChanged(this.getList());
    }
  }
}

window.SnapshotManager = SnapshotManager;
