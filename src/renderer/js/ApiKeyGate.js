/**
 * ApiKeyGate.js
 * The dialog that asks for an AI provider key, and the gate every AI feature
 * passes through before it calls the backend.
 *
 * Keys used to live in a .env file read once at backend startup. An installed
 * build ships no such file and gives the operator no way to write one, so the
 * AI features were dead in every compiled copy of the app and could only be
 * revived by editing .env and building again. Now the key is asked for at the
 * moment it is first needed, verified, and stored by the backend in the user
 * data directory — entered once per machine, never at build time.
 *
 * Two entry points, and AI code should use one of them rather than reading
 * provider state itself:
 *
 *   ensure(provider)        before a call — puts the dialog up when there is
 *                           no key, resolves true once there is one.
 *   handleResponse(data)    after a call — reopens the dialog when the backend
 *                           answers `needsKey` (a revoked or exhausted key),
 *                           resolving true when the caller should retry.
 */

class ApiKeyGate {
  constructor(api) {
    this.api = api;
    this.providers = null;      // last /api/ai/providers payload, null until fetched
    this.onChange = [];         // called with the fresh provider map after any change

    this.modal = null;
    this._resolve = null;       // settles the promise handed to the current caller
    this._provider = null;      // provider the open dialog is asking about
    this._busy = false;
  }

  init() {
    this.modal = document.getElementById('aiKeyModal');
    this.titleEl = document.getElementById('aiKeyTitle');
    this.noteEl = document.getElementById('aiKeyNote');
    this.inputEl = document.getElementById('aiKeyInput');
    this.revealEl = document.getElementById('aiKeyReveal');
    this.statusEl = document.getElementById('aiKeyStatus');
    this.linkEl = document.getElementById('aiKeyConsoleLink');
    this.savedEl = document.getElementById('aiKeySaved');
    this.saveBtn = document.getElementById('aiKeySaveBtn');
    this.removeBtn = document.getElementById('aiKeyRemoveBtn');
    this.cancelBtn = document.getElementById('aiKeyCancelBtn');
    this.closeBtn = document.getElementById('aiKeyCloseBtn');

    this.saveBtn?.addEventListener('click', () => this._save());
    this.removeBtn?.addEventListener('click', () => this._remove());
    this.cancelBtn?.addEventListener('click', () => this._close(false));
    this.closeBtn?.addEventListener('click', () => this._close(false));

    this.inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._save();
      }
    });

    // The key is masked by default because these dialogs get filled in with
    // someone watching; revealing it is the operator's choice, per opening.
    this.revealEl?.addEventListener('change', () => {
      if (this.inputEl) this.inputEl.type = this.revealEl.checked ? 'text' : 'password';
    });

    // Opening the provider's console in the default browser rather than in
    // this window: the reconstruction on screen stays where it was.
    this.linkEl?.addEventListener('click', () => {
      const url = this.linkEl.dataset.url;
      if (url) window.electronAPI?.openExternal?.(url);
    });

    this.modal?.addEventListener('mousedown', (e) => {
      if (e.target === this.modal) this._close(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._isOpen()) this._close(false);
    });

    this.refresh();
  }

  // ─── Provider state ────────────────────────────────────────────────────

  /** Re-read which providers hold a key. Returns the map, or null if offline. */
  async refresh() {
    try {
      const res = await fetch(`${this.api.baseUrl}/api/ai/providers`);
      const data = await res.json();
      this.providers = data.providers || null;
      this.defaultProvider = data.default || 'anthropic';
      this._announce();
      return this.providers;
    } catch (err) {
      // Backend still starting. Left null so the next ensure() asks again
      // rather than caching "no key" for the rest of the session.
      this.providers = null;
      return null;
    }
  }

  info(provider) {
    return this.providers?.[provider] || null;
  }

  isReady(provider) {
    return this.info(provider)?.available === true;
  }

  /** Register a listener for key changes — used to relabel the model picker. */
  subscribe(fn) {
    if (typeof fn === 'function') this.onChange.push(fn);
  }

  _announce() {
    for (const fn of this.onChange) {
      try {
        fn(this.providers);
      } catch (err) {
        console.error('[ApiKeyGate] listener failed:', err);
      }
    }
  }

  // ─── Gates ─────────────────────────────────────────────────────────────

  /**
   * Make sure `provider` has a key before an AI call is made.
   * Resolves true when there is one, false when the operator dismissed the
   * dialog — in which case the caller should abandon the request quietly.
   */
  async ensure(provider, note) {
    if (this.providers === null) await this.refresh();
    if (this.isReady(provider)) return true;
    // Still null: the backend is unreachable, so a key cannot be saved either.
    if (this.providers === null) return false;
    return this.open(provider, { note });
  }

  /**
   * Inspect a backend reply. When it came back `needsKey` — a key that was
   * revoked, rotated or ran out of credit — reopen the dialog and resolve true
   * if the caller should now retry the same request.
   */
  async handleResponse(data, fallbackProvider) {
    if (!data || !data.needsKey) return false;
    await this.refresh();
    return this.open(data.provider || fallbackProvider, { error: data.error });
  }

  // ─── Dialog ────────────────────────────────────────────────────────────

  /**
   * Open the dialog for a provider. `note` explains why it appeared, `error`
   * carries a backend rejection to show in red. Resolves true once a key has
   * been saved, false if the dialog was dismissed.
   */
  open(provider, { note, error } = {}) {
    if (!this.modal) return Promise.resolve(false);

    // A second feature asking while the dialog is up joins the same answer
    // rather than stacking another copy of it.
    if (this._isOpen() && this._provider === provider) {
      return this._pending;
    }
    if (this._isOpen()) this._close(false);

    this._provider = provider;
    const info = this.info(provider) || {};
    const label = info.label || provider;

    if (this.titleEl) this.titleEl.textContent = `${label} API key`;
    if (this.noteEl) {
      this.noteEl.textContent = note || (info.available
        ? `Replace the ${label} key this app uses. It is stored on this machine only.`
        : `The AI features need a ${label} API key. It is stored on this machine only, and you will not be asked again.`);
    }
    if (this.linkEl && info.console) {
      this.linkEl.textContent = info.console;
      this.linkEl.dataset.url = info.console;
      this.linkEl.parentElement?.classList.remove('rf-hidden');
    } else if (this.linkEl) {
      this.linkEl.parentElement?.classList.add('rf-hidden');
    }
    if (this.inputEl) {
      this.inputEl.value = '';
      this.inputEl.type = 'password';
      this.inputEl.placeholder = info.placeholder || 'Paste the key';
    }
    if (this.revealEl) this.revealEl.checked = false;

    this._paintSaved(info);
    this._setStatus(error || '', error ? 'error' : '');
    this._setBusy(false);

    this.modal.classList.add('open');
    setTimeout(() => this.inputEl?.focus(), 0);

    this._pending = new Promise((resolve) => { this._resolve = resolve; });
    return this._pending;
  }

  _paintSaved(info) {
    if (!this.savedEl) return;
    if (info.available) {
      const from = info.source === 'env'
        ? `from ${info.envVar} in the environment`
        : 'saved on this machine';
      this.savedEl.textContent = `Current key ${info.hint || ''} — ${from}.`;
      this.savedEl.classList.remove('rf-hidden');
    } else {
      this.savedEl.textContent = '';
      this.savedEl.classList.add('rf-hidden');
    }
    // An environment key is not ours to delete — it lives in .env, not the store.
    if (this.removeBtn) {
      this.removeBtn.classList.toggle('rf-hidden', info.source !== 'saved');
    }
  }

  _isOpen() {
    return !!this.modal?.classList.contains('open');
  }

  _setStatus(text, kind) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text || '';
    this.statusEl.className = `ai-key-status${kind ? ' is-' + kind : ''}`;
  }

  _setBusy(busy) {
    this._busy = busy;
    if (this.saveBtn) {
      this.saveBtn.disabled = busy;
      this.saveBtn.textContent = busy ? 'Checking…' : 'Save key';
    }
    if (this.removeBtn) this.removeBtn.disabled = busy;
    if (this.inputEl) this.inputEl.disabled = busy;
  }

  async _save() {
    if (this._busy) return;
    const key = this.inputEl?.value?.trim();
    if (!key) {
      this._setStatus('Enter a key.', 'error');
      this.inputEl?.focus();
      return;
    }

    this._setBusy(true);
    // The backend verifies the key against the provider before storing it, so
    // this waits on a round trip rather than accepting a typo silently.
    this._setStatus('Verifying the key with the provider…', '');

    let data;
    try {
      const res = await fetch(`${this.api.baseUrl}/api/ai/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: this._provider, apiKey: key }),
      });
      data = await res.json();
    } catch (err) {
      this._setBusy(false);
      this._setStatus(`Could not reach the backend: ${err.message}`, 'error');
      return;
    }

    this._setBusy(false);

    if (!data || data.error) {
      this._setStatus(data?.error || 'The key could not be saved.', 'error');
      this.inputEl?.select();
      return;
    }

    this.providers = data.providers || this.providers;
    this._announce();
    if (this.inputEl) this.inputEl.value = '';
    this._close(true);
  }

  async _remove() {
    if (this._busy) return;
    this._setBusy(true);
    this._setStatus('Removing…', '');

    try {
      const res = await fetch(`${this.api.baseUrl}/api/ai/keys`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: this._provider }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      this.providers = data.providers || this.providers;
      this._announce();
      this._paintSaved(this.info(this._provider) || {});
      this._setStatus('Key removed.', '');
    } catch (err) {
      this._setStatus(`Could not remove the key: ${err.message}`, 'error');
    }

    this._setBusy(false);
  }

  _close(saved) {
    this.modal?.classList.remove('open');
    if (this.inputEl) this.inputEl.value = '';
    const resolve = this._resolve;
    this._resolve = null;
    this._pending = null;
    if (resolve) resolve(!!saved);
  }
}

window.ApiKeyGate = ApiKeyGate;
