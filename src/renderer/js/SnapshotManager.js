/**
 * SnapshotManager.js
 * Named snapshots of the face state, so an operator can save and return to
 * specific stages of a reconstruction.
 *
 * Storage is the backend SQLite database, addressed by the case id. It used
 * to be localStorage under a key rebuilt from the case id on every write,
 * with the only read happening once at boot before any case existed — so
 * every snapshot written after that point was stored correctly and never
 * loaded again. Rows in a table with a foreign key make that class of bug
 * unrepresentable.
 *
 * The backend can be down (the app is built to run without it), so captures
 * are written to a localStorage outbox *before* the network call and replayed
 * on reconnect. Each carries a client uuid that the server treats as an
 * idempotency key, so a replay of a write that already landed resolves to the
 * same row instead of duplicating it.
 */

class SnapshotManager {
  constructor(caseManager, sceneManager, api) {
    this.caseManager = caseManager;
    this.sceneManager = sceneManager;
    this.api = api;

    /* Each entry: { uid, id, name, timestamp, thumbnail, state, pending }
       - uid      client uuid, stable across the sync boundary; the UI keys on it
       - id       server row id, null until synced
       - state    full face state; null for server rows until fetched on demand
       - pending  true while it exists only in the outbox */
    this.snapshots = [];
    this.maxSnapshots = 100;

    this._outboxKey = 'reface_snapshot_outbox';
    this._legacyPrefix = 'reface_snapshots_';
    // Must match db.PENDING_CASE_ID. Snapshots recovered from localStorage
    // park here until a case with a real identity opens and adopts them.
    this._pendingCaseId = '__pending_migration__';
    this._caseId = null;
    this._flushing = false;
    this._loadedCaseId = null;   // which case the in-memory list belongs to
    this._loadedReal = false;    // whether that case had a real identity then

    this.onSnapshotsChanged = null;
    this.onStatus = null;          // (message, kind) for operator-visible notices
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Load the snapshots belonging to the current case.
   * Call this on boot and after any case change — unlike the old version,
   * which only ever ran once at startup.
   */
  /**
   * Reload only if the case this panel is showing is no longer the case the
   * app is on, or if that case has since acquired a real identity.
   *
   * The intake flow does not create a case — it fills the case fields on a
   * template that already exists, so no newCase()/loadCase() hook fires and
   * nothing would otherwise notice that "Untitled Case" has become 2291-B.
   * That matters because recovered snapshots are only adopted by a case with
   * a real identity. Bound to opening the Frames panel, which is the moment
   * the list actually has to be right.
   */
  async refreshIfCaseChanged() {
    const caseId = this._currentCaseId();
    const real = this._isRealCase();
    if (caseId === this._loadedCaseId && real === this._loadedReal) return false;
    await this.loadForCurrentCase();
    return true;
  }

  async loadForCurrentCase() {
    const caseId = this._currentCaseId();
    this._caseId = caseId;
    this._loadedCaseId = caseId;
    this._loadedReal = this._isRealCase();

    this._migrateLegacyLocalStorage();

    // Drain the queue before reading. Migration and any offline captures sit
    // in the outbox, and listing first would show a case that is missing rows
    // this call is about to write.
    await this.flushOutbox();

    // Hand recovered snapshots to this case if it is a real one. The boot
    // template is deliberately skipped: it exists for a few seconds before the
    // operator has filled in anything, and attaching the recovery to it would
    // strand those snapshots in a case no screen ever opens again.
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

    // Anything still queued for this case is shown alongside, flagged, so a
    // capture taken with the backend down is visible rather than apparently lost.
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

  /**
   * Has the operator actually given this case an identity, or is it still the
   * blank template the app boots with?
   */
  _isRealCase() {
    const c = this.caseManager.currentCase;
    return !!(c.caseNumber || '').trim() ||
           ((c.caseName || '').trim() !== '' && c.caseName !== 'Untitled Case');
  }

  // ─── Capture ───────────────────────────────────────────────────────────

  /**
   * Capture the current face state as a named snapshot.
   * Resolves once the snapshot is durable — in the database, or in the outbox
   * if the backend is unreachable.
   */
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

    // Queue first, send second. If the app dies between the two the snapshot
    // is replayed on next boot; the reverse order can lose it outright.
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

  _writeOutbox(items) {
    try {
      localStorage.setItem(this._outboxKey, JSON.stringify(items));
      return true;
    } catch (e) {
      // The outbox is a staging area, not the store, so it only holds
      // unsynced items and normally stays small. If it still overflows, say
      // so loudly rather than dropping a capture silently the way the old
      // thumbnail-trimming path did.
      console.error('[SnapshotManager] outbox write failed — storage full', e);
      this._status('Snapshot could not be queued: local storage is full.', 'error');
      return false;
    }
  }

  _enqueue(payload) {
    const items = this._readOutbox();
    items.push(payload);
    this._writeOutbox(items);
  }

  /**
   * Push every queued capture to the database, oldest first.
   * Stops at the first transport failure so ordering is preserved.
   */
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
            // A rejection is not a transport problem — retrying forever would
            // wedge the queue behind one bad row. Drop it and report.
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

  /**
   * Full state for one snapshot, fetched on demand.
   * The list call omits state so that rendering a case with 100 snapshots
   * does not haul 100 face states across the wire.
   */
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

  /**
   * Restore a snapshot into the current case.
   * The current state goes onto the undo stack first, so a restore is itself
   * reversible.
   */
  async restore(uid) {
    const state = await this.getFullState(uid);
    if (!state) return null;

    this.caseManager.pushState('Before snapshot restore');

    const restored = JSON.parse(JSON.stringify(state));
    // A snapshot is a stage of *this* case, not a different case. Keeping the
    // live case id stops a restore from silently re-filing the case — and its
    // snapshots — under whatever id the state was captured with.
    restored.caseId = this._currentCaseId();
    this.caseManager.currentCase = restored;

    return restored;
  }

  /**
   * Lightweight list for the UI. No state blobs.
   */
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

  async rename(uid, newName) {
    const entry = this.snapshots.find(s => s.uid === uid);
    if (!entry) return false;

    const name = (newName || '').trim();
    if (!name || name === entry.name) return false;

    const previous = entry.name;
    entry.name = name;
    this._notify();

    if (entry.pending) {
      // Still queued — rewrite it in place so the eventual insert carries the
      // new name rather than the one it was captured with.
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

  /**
   * Write one snapshot to a .json file the operator chooses.
   *
   * This used to build a blob URL and click a synthetic <a download>. Electron
   * has a real save dialog over IPC, which gives the operator a path they
   * chose and an error they can see; the anchor route is kept only for
   * running the renderer in a plain browser.
   */
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

  /**
   * Import a snapshot from a .json file. Accepts both the current format and
   * the older shape, which wrapped the same fields without a formatVersion.
   */
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
      // 'cancel' is not fired by every runtime; the focus fallback keeps the
      // promise from hanging forever and leaking the input into the document.
      input.addEventListener('cancel', () => finish(null));
      window.addEventListener('focus', () => setTimeout(() => finish(null), 500),
        { once: true });

      input.click();
    });
  }

  // ─── Migration ─────────────────────────────────────────────────────────

  /**
   * Move snapshots left behind by the localStorage era into the outbox, from
   * which the normal flush files them into the database.
   *
   * Every historical key is swept, including the "_default" bucket that
   * everything actually landed in, because the case id was never assigned.
   * Migrated keys are renamed rather than deleted — if something goes wrong
   * the original payload is still on disk.
   */
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
        // Deterministic uuid from the legacy key and row id: re-running the
        // migration cannot produce a second copy, because the server treats
        // this as the idempotency key.
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

  _currentCaseId() {
    let id = this.caseManager.currentCase.caseId;
    if (!id) {
      // Should not happen now that CaseManager mints one up front, but a case
      // loaded from an old .rfc file can still arrive without one.
      id = CaseManager.newCaseId();
      this.caseManager.currentCase.caseId = id;
    }
    return id;
  }

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

  _toMs(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  _sort() {
    this.snapshots.sort((a, b) => a.timestamp - b.timestamp);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-this.maxSnapshots);
    }
  }

  _uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'snap-' + Date.now().toString(36) + '-' +
           Math.random().toString(36).slice(2, 10);
  }

  /**
   * UTF-8 text to base64, for the save-buffer IPC channel.
   *
   * btoa is latin1-only, so the string has to be encoded to bytes first or a
   * non-ASCII character in a case name corrupts the file. The bytes are then
   * walked in chunks: a snapshot carrying pigment or wrinkle paint data runs
   * to several megabytes, and String.fromCharCode(...bytes) on an array that
   * size overflows the argument limit and throws.
   */
  _toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  _generateThumbnail() {
    this.sceneManager.renderer.render(this.sceneManager.scene, this.sceneManager.camera);
    const fullCanvas = this.sceneManager.canvas;

    // 4:3, matching the aspect the card reserves for it — the old 120x90 was
    // drawn into a 3/4 portrait slot and cropped.
    const thumbW = 160;
    const thumbH = 120;
    const offscreen = document.createElement('canvas');
    offscreen.width = thumbW;
    offscreen.height = thumbH;
    const ctx = offscreen.getContext('2d');
    ctx.drawImage(fullCanvas, 0, 0, thumbW, thumbH);
    return offscreen.toDataURL('image/jpeg', 0.7);
  }

  _status(message, kind = 'info') {
    if (typeof this.onStatus === 'function') this.onStatus(message, kind);
    else console.log(`[SnapshotManager] ${message}`);
  }

  _notify() {
    if (typeof this.onSnapshotsChanged === 'function') {
      this.onSnapshotsChanged(this.getList());
    }
  }
}

window.SnapshotManager = SnapshotManager;
