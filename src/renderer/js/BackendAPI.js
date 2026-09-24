// Talks to the local Python backend over HTTP.

class BackendAPI {
  constructor(baseUrl = 'http://127.0.0.1:5001') {
    this.baseUrl = baseUrl;
    this.isConnected = false;
    this.blenderAvailable = false;
    this.onStatusChange = null;
  }

  // Pings the backend and updates the connection status.
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

  // Checks the backend straight away and then every few seconds.
  startHealthCheck(interval = 5000) {
    this.checkHealth();
    this.healthInterval = setInterval(() => this.checkHealth(), interval);
  }

  // Asks the backend to export the model in the given format.
  async exportModel(format, caseData) {
    return this._post('/api/export', { format, caseData });
  }

  // Asks the AI for several different candidate faces, skipping ones the witness already rejected.
  async generateVariants({ prompt, count = 6, avoid = [], referenceImages = [], provider, model }) {
    return this._post('/api/ai/variants', { prompt, count, avoid, referenceImages, provider, model });
  }

  // Saves the case through the backend.
  async saveCase(caseData) {
    return this._post('/api/case/save', caseData);
  }

  // Loads a saved case through the backend.
  async loadCase(path) {
    return this._post('/api/case/load', { path });
  }

  // Snapshot calls throw on failure so SnapshotManager can tell "backend offline" apart from "request rejected".

  // Lists the snapshots saved for a case.
  async listSnapshots(caseId) {
    const res = await this._request(
      `/api/snapshots?caseId=${encodeURIComponent(caseId)}`);
    return res.snapshots || [];
  }

  // Fetches one snapshot by its id.
  async getSnapshot(id) {
    const res = await this._request(`/api/snapshots/${id}`);
    return res.snapshot;
  }

  // Saves a new snapshot.
  async createSnapshot(payload) {
    const res = await this._request('/api/snapshots', {
      method: 'POST', body: payload });
    return res.snapshot;
  }

  // Renames a snapshot.
  async renameSnapshot(id, name) {
    const res = await this._request(`/api/snapshots/${id}`, {
      method: 'PATCH', body: { name } });
    return res.snapshot;
  }

  // Deletes a snapshot.
  async deleteSnapshot(id) {
    await this._request(`/api/snapshots/${id}`, { method: 'DELETE' });
    return true;
  }

  // Moves snapshots saved before the database existed onto this case.
  async adoptPendingSnapshots(caseId, caseMeta) {
    const res = await this._request('/api/snapshots/adopt', {
      method: 'POST', body: { caseId, caseMeta } });
    return res.adopted || 0;
  }

  // Removes every snapshot for a case.
  async clearSnapshots(caseId) {
    const res = await this._request('/api/snapshots/clear', {
      method: 'POST', body: { caseId } });
    return res.cleared || 0;
  }

  // Sends a request and throws on failure, marking the error as offline when the server can't be reached.
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

  // Sends a POST request and returns the JSON, or an error object instead of throwing.
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
