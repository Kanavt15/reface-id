// Combines composites built with different witnesses into one face. Each witness's errors are their own, so averaging cancels much of them; Bruce et al. (2002) found combined composites were rated better likenesses than the individual ones.

class WitnessFusion {
  constructor(ui) {
    this.ui = ui;
    this.selecting = false;
    // A Set keeps the order snapshots were picked in; the first one picked is the base.
    this.selected = new Set();
    this.busy = false;
  }

  // ─── Combining ─────────────────────────────────────────────────────────

  // The mean of the finite numbers in a list, or undefined if there are none.
  static mean(values) {
    const nums = values.map(Number).filter(Number.isFinite);
    if (!nums.length) return undefined;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }

  // The most common value; a tie goes to whichever came first.
  static majority(values) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    let best = values[0];
    for (const v of values) if (counts.get(v) > counts.get(best)) best = v;
    return best;
  }

  // Averages hex colours in linear light, which is how paint or light would mix them; non-colours are skipped.
  static mixColours(hexes) {
    const valid = hexes.filter((h) => typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h));
    if (!valid.length) return undefined;
    const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
    const sum = [0, 0, 0];
    for (const h of valid) {
      for (let i = 0; i < 3; i++) sum[i] += toLin(parseInt(h.slice(1 + i * 2, 3 + i * 2), 16));
    }
    return '#' + sum.map((s) => {
      const v = Math.round(Math.min(1, Math.max(0, toSrgb(s / valid.length))) * 255);
      return v.toString(16).padStart(2, '0');
    }).join('');
  }

  // Averages every numeric field the objects share; anything else is taken from the first.
  static meanObject(objects) {
    const out = JSON.parse(JSON.stringify(objects[0]));
    for (const key of Object.keys(out)) {
      if (typeof out[key] !== 'number') continue;
      const m = WitnessFusion.mean(objects.map((o) => o[key]));
      if (m !== undefined) out[key] = Number.isInteger(out[key]) ? Math.round(m) : m;
    }
    return out;
  }

  // Builds one face state from several. Shape and colouring are averaged; hairstyle, beard, age and sex go to the majority; marks and worn items come from the first state.
  static fuse(states) {
    const base = JSON.parse(JSON.stringify(states[0]));

    // Face shape: the mean of every morph; a value one composite never set counts as the neutral 50.
    const keys = new Set(states.flatMap((s) => Object.keys(s.morphTargets || {})));
    base.morphTargets = {};
    for (const key of keys) {
      base.morphTargets[key] = Math.round(WitnessFusion.mean(
        states.map((s) => (Number.isFinite(Number(s.morphTargets?.[key])) ? s.morphTargets[key] : 50))));
    }

    // Hair: each style is fitted to the head on its own, so the majority style keeps its own fit and only its cut is averaged.
    const hairs = states.map((s) => s.hairParams || {});
    if (hairs.some((h) => h.style)) {
      const style = WitnessFusion.majority(hairs.map((h) => h.style).filter(Boolean));
      const same = hairs.filter((h) => h.style === style);
      const hair = JSON.parse(JSON.stringify(same[0]));
      for (const key of ['length', 'density', 'volume', 'curl']) {
        const m = WitnessFusion.mean(same.map((h) => h[key]));
        if (m !== undefined) hair[key] = m;
      }
      hair.color = WitnessFusion.mixColours(hairs.map((h) => h.color)) || hair.color;

      const beards = hairs.map((h) => h.beard).filter(Boolean);
      if (beards.length) {
        const beardStyle = WitnessFusion.majority(beards.map((b) => b.style || 'none'));
        const sameBeard = beards.filter((b) => (b.style || 'none') === beardStyle);
        hair.beard = JSON.parse(JSON.stringify(sameBeard[0]));
        hair.beard.color = WitnessFusion.mixColours(sameBeard.map((b) => b.color)) || hair.beard.color;
      }

      const brows = hairs.map((h) => h.eyebrows).filter(Boolean);
      if (brows.length) {
        hair.eyebrows = WitnessFusion.meanObject(brows);
        hair.eyebrows.color = WitnessFusion.mixColours(brows.map((b) => b.color)) || hair.eyebrows.color;
      }
      base.hairParams = hair;
    }

    // Colouring and the settings behind it.
    const looks = states.map((s) => s.appearance || {});
    const look = base.appearance || {};
    look.skinColor = WitnessFusion.mixColours(looks.map((a) => a.skinColor)) || look.skinColor;
    look.eyeColor = WitnessFusion.mixColours(looks.map((a) => a.eyeColor)) || look.eyeColor;
    // Lip colour only survives if most witnesses noticed one.
    const lips = looks.map((a) => a.lipColor).filter(Boolean);
    look.lipColor = lips.length * 2 > looks.length ? WitnessFusion.mixColours(lips) : null;
    for (const key of ['eyeParams', 'skinTextureParams']) {
      const objs = looks.map((a) => a[key]).filter((o) => o && typeof o === 'object');
      if (objs.length) look[key] = WitnessFusion.meanObject(objs);
    }
    for (const key of ['ageRange', 'sex']) {
      const values = looks.map((a) => a[key]).filter(Boolean);
      if (values.length) look[key] = WitnessFusion.majority(values);
    }
    base.appearance = look;

    return base;
  }

  // ─── Panel ─────────────────────────────────────────────────────────────

  // Wires the Combine button and the selection bar, and takes over clicks on the snapshot list while picking.
  bind() {
    const list = document.getElementById('snapshotList');
    if (!list) return;

    // Capture phase, so picking a card never also restores, renames or deletes it.
    const intercept = (e) => {
      if (!this.selecting) return;
      const card = e.target.closest('.snapshot-card');
      if (!card) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.type !== 'click') return;
      const uid = card.dataset.snapshotUid;
      if (this.selected.has(uid)) this.selected.delete(uid);
      else this.selected.add(uid);
      this.decorate();
    };
    list.addEventListener('click', intercept, true);
    list.addEventListener('dblclick', intercept, true);

    document.getElementById('btnFuseMode')?.addEventListener('click', () => this.setSelecting(!this.selecting));
    document.getElementById('btnFuseCancel')?.addEventListener('click', () => this.setSelecting(false));
    document.getElementById('btnFuseApply')?.addEventListener('click', () => this.combine());
    this.decorate();
  }

  // Enters or leaves picking mode.
  setSelecting(on) {
    this.selecting = !!on;
    this.selected.clear();
    this.decorate();
  }

  // Marks picked cards with their order and updates the bar; called again whenever the list is redrawn.
  decorate() {
    const list = document.getElementById('snapshotList');
    if (!list) return;
    const cards = [...list.querySelectorAll('.snapshot-card')];

    // Forget picks whose snapshot has since been deleted.
    const present = new Set(cards.map((c) => c.dataset.snapshotUid));
    for (const uid of [...this.selected]) if (!present.has(uid)) this.selected.delete(uid);

    const order = [...this.selected];
    list.classList.toggle('fuse-mode', this.selecting);
    for (const card of cards) {
      const index = order.indexOf(card.dataset.snapshotUid);
      card.classList.toggle('fuse-selected', index >= 0);
      if (index >= 0) card.dataset.fuseOrder = String(index + 1);
      else delete card.dataset.fuseOrder;
    }

    const bar = document.getElementById('snapshotFuseBar');
    if (bar) bar.style.display = this.selecting ? '' : 'none';
    const count = document.getElementById('snapshotFuseCount');
    if (count) {
      count.textContent = order.length < 2
        ? `Pick ${2 - order.length} more`
        : `${order.length} composites`;
    }
    const apply = document.getElementById('btnFuseApply');
    if (apply) apply.disabled = order.length < 2 || this.busy;
    // Combining needs at least two composites; while picking, the bar's own buttons take over.
    const mode = document.getElementById('btnFuseMode');
    if (mode) mode.style.display = cards.length >= 2 && !this.selecting ? '' : 'none';
  }

  // Combines the picked snapshots, applies the result as one undo step and saves it as a new snapshot.
  async combine() {
    const ui = this.ui;
    const sm = ui.snapshotManager;
    const uids = [...this.selected];
    if (uids.length < 2 || this.busy || !sm) return;
    this.busy = true;
    this.decorate();

    try {
      const list = sm.getList();
      const names = uids.map((uid) => list.find((s) => s.uid === uid)?.name || 'Snapshot');
      const states = await Promise.all(uids.map((uid) => sm.getFullState(uid)));
      if (states.some((s) => !s)) {
        ui.addHistory('Could not read one of the picked snapshots');
        return;
      }

      const fused = WitnessFusion.fuse(states);
      // The combined face belongs to this case, whichever case the sources were captured under.
      const live = ui.caseManager.currentCase;
      for (const key of ['caseId', 'caseNumber', 'caseName', 'investigator', 'description', 'notes']) {
        fused[key] = live[key];
      }
      fused.fusion = {
        sources: names,
        combinedAt: new Date().toISOString(),
        method: 'Mean face shape and colouring; majority hairstyle, beard, age and sex; marks and worn items from the first',
      };

      ui.caseManager.pushState('Before combining witnesses');
      ui.caseManager.currentCase = fused;
      ui.restoreState(fused);
      this.setSelecting(false);
      ui.addHistory(`Combined ${names.length} composites: ${names.join(', ')}`);

      // Give the morph worker and the worn items a moment, so the new snapshot's thumbnail shows the combined face.
      await new Promise((resolve) => setTimeout(resolve, 900));
      ui.updateCaseFromUI();
      const joined = `Combined: ${names.join(' + ')}`;
      await sm.capture(joined.length <= 60 ? joined : `Combined: ${names.length} witnesses`);
    } catch (err) {
      console.error('[WitnessFusion] combine failed', err);
      ui.addHistory('Combining composites failed');
    } finally {
      this.busy = false;
      this.decorate();
    }
  }
}

window.WitnessFusion = WitnessFusion;
