// Tracks whether a system's models are still loading, so other code can wait until they are really on the head.
class AssetLoadTracker {
  constructor(label = 'assets') {
    this.label = label;
    this.pending = 0;
    this._waiters = [];
  }

  // Call right before starting an async load.
  begin() {
    this.pending++;
  }

  // Call when a load finishes, including on failure, or anything waiting would hang forever.
  end() {
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending > 0) return;
    const waiters = this._waiters;
    this._waiters = [];
    for (const resolve of waiters) resolve();
  }

  // Resolves once nothing is loading.
  whenIdle() {
    if (this.pending === 0) return Promise.resolve();
    return new Promise(resolve => this._waiters.push(resolve));
  }

  // Waits for several systems to finish loading and never rejects, so one stuck asset can't break the session.
  static whenAllIdle(systems) {
    const waits = (systems || [])
      .filter(s => s && typeof s.whenIdle === 'function')
      .map(s => s.whenIdle().catch(() => {}));
    return Promise.all(waits);
  }
}

window.AssetLoadTracker = AssetLoadTracker;
