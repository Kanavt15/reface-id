// The dialog that asks for an AI provider key, and the check every AI feature goes through before calling the backend.

class ApiKeyGate {
  constructor(api) {
    this.api = api;
    this.providers = null;      // last /api/ai/providers payload, null until fetched
    this.onChange = [];         // called with the fresh provider map after any change

    this.modal = null;
    this._resolve = null;       // settles the promise handed to the current caller
    this._provider = null;      // provider whose tab is showing
    this._wanted = null;        // provider the caller was blocked on
    this._busy = false;
  }

  // Finds the dialog elements and wires up its buttons.
  init() {
    this.modal = document.getElementById('aiKeyModal');
    this.titleEl = document.getElementById('aiKeyTitle');
    this.noteEl = document.getElementById('aiKeyNote');
    this.inputEl = document.getElementById('aiKeyInput');
    this.revealEl = document.getElementById('aiKeyReveal');
    this.statusEl = document.getElementById('aiKeyStatus');
    this.tabsEl = document.getElementById('aiKeyProviders');
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

    // The key is hidden by default because someone may be watching; the operator can choose to reveal it.
    this.revealEl?.addEventListener('change', () => {
      if (this.inputEl) this.inputEl.type = this.revealEl.checked ? 'text' : 'password';
    });

    // Open the provider's page in the browser so the reconstruction stays on screen.
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

  // Re-reads which providers have a key; returns null if the backend is offline.
  async refresh() {
    try {
      const res = await fetch(`${this.api.baseUrl}/api/ai/providers`);
      const data = await res.json();
      this.providers = data.providers || null;
      this.defaultProvider = data.default || 'anthropic';
      this._announce();
      return this.providers;
    } catch (err) {
      // The backend is still starting, so leave this empty and ask again next time.
      this.providers = null;
      return null;
    }
  }

  // Returns what the backend knows about one provider.
  info(provider) {
    return this.providers?.[provider] || null;
  }

  // Tells whether a provider has a working key.
  isReady(provider) {
    return this.info(provider)?.available === true;
  }

  // Registers a listener for key changes, used to relabel the model picker.
  subscribe(fn) {
    if (typeof fn === 'function') this.onChange.push(fn);
  }

  // Tells every listener that the keys changed.
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

  // Makes sure a provider has a key before an AI call; resolves false if the operator closes the dialog.
  async ensure(provider, note) {
    if (this.providers === null) await this.refresh();
    if (this.isReady(provider)) return true;
    // Still null: the backend is unreachable, so a key cannot be saved either.
    if (this.providers === null) return false;
    return this.open(provider, { note });
  }

  // Reopens the dialog when the backend says the key is missing or used up, and tells the caller whether to retry.
  async handleResponse(data, fallbackProvider) {
    if (!data || !data.needsKey) return false;
    await this.refresh();
    return this.open(data.provider || fallbackProvider, { error: data.error });
  }

  // ─── Dialog ────────────────────────────────────────────────────────────

  // Opens the key dialog for a provider and resolves true once any key has been saved.
  open(provider, { note, error } = {}) {
    if (!this.modal) return Promise.resolve(false);

    // If the dialog is already open for this provider, share the same answer instead of opening it twice.
    if (this._isOpen() && this._wanted === provider) return this._pending;
    if (this._isOpen()) this._close(false);

    this._wanted = provider;
    this._note = note;
    this._showProvider(provider, error);

    this.modal.classList.add('open');
    setTimeout(() => this.inputEl?.focus(), 0);

    this._pending = new Promise((resolve) => { this._resolve = resolve; });
    return this._pending;
  }

  // Points every field in the dialog at one provider.
  _showProvider(provider, error) {
    this._provider = provider;
    const info = this.info(provider) || {};
    const label = info.label || provider;

    if (this.titleEl) this.titleEl.textContent = `${label} API key`;
    if (this.noteEl) {
      this.noteEl.textContent = this._note || (info.available
        ? `Replace or remove the ${label} key. Keys are stored on this machine only.`
        : `Paste a ${label} key below, or pick a different provider. Keys are stored on this machine only, and you are asked once.`);
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

    this._renderTabs();
    this._paintSaved(info);
    this._setStatus(error || '', error ? 'error' : '');
    this._setBusy(false);
  }

  // Draws one tab per provider the backend knows about, highlighting the ones that already have a key.
  _renderTabs() {
    if (!this.tabsEl) return;
    this.tabsEl.innerHTML = '';

    for (const [provider, info] of Object.entries(this.providers || {})) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'ai-key-tab';
      tab.dataset.provider = provider;
      if (provider === this._provider) tab.classList.add('is-active');
      if (info.available) tab.classList.add('has-key');
      tab.title = info.available
        ? `${info.label} key set${info.source === 'env' ? ` (${info.envVar})` : ''}`
        : `No ${info.label} key yet`;

      const dot = document.createElement('span');
      dot.className = 'ai-key-dot';
      tab.append(dot, document.createTextNode(info.label || provider));

      tab.addEventListener('click', () => {
        if (this._busy || provider === this._provider) return;
        this._note = null;   // the reason the dialog opened belongs to its own tab
        this._showProvider(provider);
        this.inputEl?.focus();
      });

      this.tabsEl.appendChild(tab);
    }
  }

  // Shows where the saved key came from and whether it can be removed.
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

  // Tells whether the dialog is open.
  _isOpen() {
    return !!this.modal?.classList.contains('open');
  }

  // Shows a status message under the key field.
  _setStatus(text, kind) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text || '';
    this.statusEl.className = `ai-key-status${kind ? ' is-' + kind : ''}`;
  }

  // Disables the buttons while a request is running.
  _setBusy(busy) {
    this._busy = busy;
    if (this.saveBtn) {
      this.saveBtn.disabled = busy;
      this.saveBtn.textContent = busy ? 'Checking…' : 'Save key';
    }
    if (this.removeBtn) this.removeBtn.disabled = busy;
    if (this.inputEl) this.inputEl.disabled = busy;
  }

  // Checks the key with the provider through the backend and saves it.
  async _save() {
    if (this._busy) return;
    const key = this.inputEl?.value?.trim();
    if (!key) {
      this._setStatus('Enter a key.', 'error');
      this.inputEl?.focus();
      return;
    }

    this._setBusy(true);
    // The backend checks the key with the provider first, so a typo isn't saved silently.
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

  // Removes the saved key for the current provider.
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
      this._renderTabs();
      this._paintSaved(this.info(this._provider) || {});
      this._setStatus('Key removed.', '');
    } catch (err) {
      this._setStatus(`Could not remove the key: ${err.message}`, 'error');
    }

    this._setBusy(false);
  }

  // Closes the dialog and tells the waiting caller whether a key was saved.
  _close(saved) {
    this.modal?.classList.remove('open');
    this._note = null;
    if (this.inputEl) this.inputEl.value = '';
    const resolve = this._resolve;
    this._resolve = null;
    this._pending = null;
    if (resolve) resolve(!!saved);
  }
}

window.ApiKeyGate = ApiKeyGate;
