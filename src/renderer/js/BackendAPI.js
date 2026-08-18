/**
 * BackendAPI.js
 * Handles communication with the Python/Blender backend server.
 */

class BackendAPI {
  constructor(baseUrl = 'http://127.0.0.1:5001') {
    this.baseUrl = baseUrl;
    this.isConnected = false;
    this.blenderAvailable = false;
    this.onStatusChange = null;
  }

  /**
   * Check backend health
   */
  async checkHealth() {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      const data = await response.json();
      this.isConnected = true;
      this.blenderAvailable = data.blender_available;
      if (this.onStatusChange) this.onStatusChange(true, data);
      return data;
    } catch (err) {
      this.isConnected = false;
      this.blenderAvailable = false;
      if (this.onStatusChange) this.onStatusChange(false, null);
      return null;
    }
  }

  /**
   * Start periodic health checks
   */
  startHealthCheck(interval = 5000) {
    this.checkHealth();
    this.healthInterval = setInterval(() => this.checkHealth(), interval);
  }

  /**
   * Stop health checks
   */
  stopHealthCheck() {
    if (this.healthInterval) clearInterval(this.healthInterval);
  }

  /**
   * Apply morph targets via Blender
   */
  async applyMorphs(morphTargets) {
    return this._post('/api/morph', { morphTargets });
  }

  /**
   * Generate hair via Blender
   */
  async generateHair(hairParams) {
    return this._post('/api/hair/generate', { hairParams });
  }

  /**
   * Export model
   */
  async exportModel(format, caseData) {
    return this._post('/api/export', { format, caseData });
  }

  /**
   * Generate several distinct candidate faces in one call, for the variant
   * picker. `avoid` carries morphTarget sets the witness already rejected so
   * the next set does not repeat them.
   */
  async generateVariants({ prompt, count = 6, avoid = [], referenceImages = [], provider, model }) {
    return this._post('/api/ai/variants', { prompt, count, avoid, referenceImages, provider, model });
  }

  /**
   * Save case
   */
  async saveCase(caseData) {
    return this._post('/api/case/save', caseData);
  }

  /**
   * Load case
   */
  async loadCase(path) {
    return this._post('/api/case/load', { path });
  }

  /**
   * List every case held in the database.
   */
  async listCases() {
    return this._post('/api/case/list', {});
  }

  // ─── Snapshots ──────────────────────────────────────────────────────────
  //
  // These deliberately throw instead of resolving to { error } like _post
  // does. SnapshotManager has to tell "the backend is down, queue this
  // locally" apart from "the backend rejected this", and a resolved value
  // cannot express the difference without every caller re-checking a field.

  async listSnapshots(caseId) {
    const res = await this._request(
      `/api/snapshots?caseId=${encodeURIComponent(caseId)}`);
    return res.snapshots || [];
  }

  async getSnapshot(id) {
    const res = await this._request(`/api/snapshots/${id}`);
    return res.snapshot;
  }

  async createSnapshot(payload) {
    const res = await this._request('/api/snapshots', {
      method: 'POST', body: payload });
    return res.snapshot;
  }

  async renameSnapshot(id, name) {
    const res = await this._request(`/api/snapshots/${id}`, {
      method: 'PATCH', body: { name } });
    return res.snapshot;
  }

  async deleteSnapshot(id) {
    await this._request(`/api/snapshots/${id}`, { method: 'DELETE' });
    return true;
  }

  async adoptPendingSnapshots(caseId, caseMeta) {
    const res = await this._request('/api/snapshots/adopt', {
      method: 'POST', body: { caseId, caseMeta } });
    return res.adopted || 0;
  }

  async clearSnapshots(caseId) {
    const res = await this._request('/api/snapshots/clear', {
      method: 'POST', body: { caseId } });
    return res.cleared || 0;
  }

  async dbStats() {
    return this._request('/api/db/stats');
  }

  /**
   * Request that rejects on transport failure or a non-2xx reply, so callers
   * can branch on it. Errors carry `.offline` when the request never reached
   * the server, which is the case the snapshot outbox exists for.
   */
  async _request(endpoint, { method = 'GET', body = null, timeout = 15000 } = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const e = new Error(`Backend unreachable: ${err.message}`);
      e.offline = true;
      throw e;
    }

    let result = {};
    try {
      result = await response.json();
    } catch (_) { /* empty or non-JSON body */ }

    if (!response.ok || result.error) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    return result;
  }

  /**
   * Set Blender path
   */
  async setBlenderPath(path) {
    return this._post('/api/blender/config', { path });
  }

  /**
   * Render scene with Blender
   */
  async renderScene(params) {
    return this._post('/api/render', params);
  }

  /**
   * Upload morphed mesh OBJ data so Blender render uses it
   */
  async uploadMorphedMesh(objData) {
    return this._post('/api/render/upload-mesh', { objData });
  }

  /**
   * AI face generation
   */
  async aiGenerateFace(prompt, currentState, history) {
    return this._post('/api/ai/generate', { prompt, currentState, history });
  }

  /**
   * Generic POST request
   */
  async _post(endpoint, data) {
    try {
      console.log(`[API] POST ${endpoint}`, data);
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await response.json();
      console.log(`[API] Response ${endpoint}:`, result);
      return result;
    } catch (err) {
      console.error(`[API] Error [${endpoint}]:`, err);
      return { error: err.message };
    }
  }
}

window.BackendAPI = BackendAPI;
