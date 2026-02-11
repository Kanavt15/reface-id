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
   * Generic POST request
   */
  async _post(endpoint, data) {
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      return await response.json();
    } catch (err) {
      console.error(`API Error [${endpoint}]:`, err);
      return { error: err.message };
    }
  }
}

window.BackendAPI = BackendAPI;
