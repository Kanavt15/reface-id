/**
 * AssetLoadTracker.js – "are this system's models actually on the head yet?"
 *
 * Hair, glasses, masks, earrings and bandanas all load their meshes
 * asynchronously and cache them after the first time. That is invisible to a
 * user, who sees the item appear a frame or two later, but not to code that
 * renders immediately after asking for a style: the variant picker captures its
 * six thumbnails in one synchronous pass, so on a cold cache it would photograph
 * a bald head every time.
 *
 * Each system owns one of these and brackets its loads with begin()/end().
 * Anything that needs the model present can await whenIdle().
 */
class AssetLoadTracker {
  constructor(label = 'assets') {
    this.label = label;
    this.pending = 0;
    this._waiters = [];
  }

  /** Call immediately before kicking off an async load. */
  begin() {
    this.pending++;
  }

  /**
   * Call when a load settles — on failure as well as success, or a system that
   * 404s one model would hang every waiter behind it forever.
   */
  end() {
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending > 0) return;
    const waiters = this._waiters;
    this._waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolves once nothing is in flight. Resolves immediately when idle. */
  whenIdle() {
    if (this.pending === 0) return Promise.resolve();
    return new Promise(resolve => this._waiters.push(resolve));
  }

  /**
   * Wait on a mixed bag of systems, skipping any that predate this tracker or
   * are not wired up. Never rejects — a stalled asset should degrade the
   * thumbnail, not break the session.
   */
  static whenAllIdle(systems) {
    const waits = (systems || [])
      .filter(s => s && typeof s.whenIdle === 'function')
      .map(s => s.whenIdle().catch(() => {}));
    return Promise.all(waits);
  }
}

window.AssetLoadTracker = AssetLoadTracker;
