/**
 * ReFace ID — EditorLayout.js
 * Bridges the new editor layout UI (top bar, sidebar tabs, viewport overlays)
 * to the existing UIController.js, toolbar buttons, and event system.
 *
 * All original IDs remain functional — this module only mirrors/proxies them.
 * Called from app.js after UIController initializes.
 */
;(function EditorLayout() {
  'use strict';

  // ─── Wait for DOM ready ────────────────────────────────────────────────
  function init() {
    bindWindowControls();
    bindTopbarActions();
    bindSidebarTabs();
    bindViewportToolbar();
    bindBackendStatusMirror();
    bindCaseTitleMirror();
    bindEditorBodyWrapper();
    bindViewportActionButtons();
    bindAIExampleChips();

    console.log('[EditorLayout] Initialized');
  }

  // ─── Window Controls (proxy to existing #btnClose, #btnMinimize, etc.) ──
  function bindWindowControls() {
    const map = {
      'rf-tb-close': 'btnClose',
      'rf-tb-min':   'btnMinimize',
      'rf-tb-max':   'btnMaximize',
    };
    Object.entries(map).forEach(([newId, oldId]) => {
      const newBtn = document.getElementById(newId);
      const oldBtn = document.getElementById(oldId);
      if (newBtn && oldBtn) {
        newBtn.addEventListener('click', () => oldBtn.click());
      }
    });
  }

  // ─── Top Bar Action Buttons ────────────────────────────────────────────
  function bindTopbarActions() {
    // Save: proxy #btnSaveCase
    const saveBtn = document.getElementById('rf-topbar-save');
    const oldSaveBtn = document.getElementById('btnSaveCase');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        if (oldSaveBtn) oldSaveBtn.click();
        else showToast('Save Case', 'info');
      });
    }

    // Export: placeholder (or proxy existing export buttons if any)
    const exportBtn = document.getElementById('rf-topbar-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        // Show quick export toast since there's no single existing export btn
        showToast('Use the toolbar for export options.', 'info');
      });
    }

    // Screenshot: proxy #btnScreenshot
    const screenshotBtn = document.getElementById('rf-topbar-screenshot');
    const oldScreenshotBtn = document.getElementById('btnScreenshot');
    if (screenshotBtn && oldScreenshotBtn) {
      screenshotBtn.addEventListener('click', () => oldScreenshotBtn.click());
    }

    // Settings: proxy beard defaults or open a future settings panel
    const settingsBtn = document.getElementById('rf-topbar-settings');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        const beardModal = document.getElementById('beardDefaultsModal');
        if (beardModal) {
          beardModal.style.display = 'flex';
        } else {
          showToast('Settings panel coming soon.', 'info');
        }
      });
    }
  }

  // ─── Sidebar Tabs → proxy old panel-tab clicks ─────────────────────────
  function bindSidebarTabs() {
    const newTabs = document.querySelectorAll('.rf-sidebar-tab');
    if (!newTabs.length) return;

    newTabs.forEach(tab => {
      tab.addEventListener('click', function () {
        // Activate new tab visually
        newTabs.forEach(t => t.classList.remove('active'));
        this.classList.add('active');

        // Find and click corresponding old .panel-tab
        const panelName = this.dataset.rfTab;
        const oldTab = document.querySelector(`.panel-tab[data-panel="${panelName}"]`);
        if (oldTab) {
          oldTab.click();
        }
      });
    });

    // Keep new tabs in sync when old tabs are clicked programmatically (e.g. by AI controller)
    const oldTabs = document.querySelectorAll('.panel-tab');
    oldTabs.forEach(oldTab => {
      oldTab.addEventListener('click', function () {
        const panelName = this.dataset.panel;
        newTabs.forEach(t => t.classList.remove('active'));
        const matchingNew = document.querySelector(`.rf-sidebar-tab[data-rf-tab="${panelName}"]`);
        if (matchingNew) matchingNew.classList.add('active');
      });
    });
  }

  // ─── Viewport Floating Toolbar ─────────────────────────────────────────
  function bindViewportToolbar() {
    // View presets
    const viewMap = {
      'rf-vp-front': 'btnFrontView',
      'rf-vp-side':  'btnSideView',
      'rf-vp-34':    'btn34View',
      'rf-vp-top':   'btnTopView',
    };
    Object.entries(viewMap).forEach(([newId, oldId]) => {
      const newBtn = document.getElementById(newId);
      const oldBtn = document.getElementById(oldId);
      if (newBtn && oldBtn) {
        newBtn.addEventListener('click', () => {
          oldBtn.click();
          // Update active state
          document.querySelectorAll('.rf-vp-btn').forEach(b => b.classList.remove('active'));
          newBtn.classList.add('active');
          // Update view angle mirror
          const viewAngle = document.getElementById('viewAngle');
          const rfInfo = document.getElementById('rf-viewport-info-strip');
          if (viewAngle && rfInfo) {
            rfInfo.querySelector('span span')?.click?.(); // noop — updated by SceneManager
          }
        });
      }
    });

    // Wireframe toggle
    const wireBtn = document.getElementById('rf-vp-wireframe');
    const oldWireBtn = document.getElementById('btnWireframe');
    if (wireBtn && oldWireBtn) {
      wireBtn.addEventListener('click', () => {
        oldWireBtn.click();
        wireBtn.classList.toggle('active');
      });
    }

    // Lighting select → proxy #btnLighting (cycle on each selection)
    const lightSelect = document.getElementById('rf-vp-lighting');
    const oldLightBtn = document.getElementById('btnLighting');
    if (lightSelect && oldLightBtn) {
      lightSelect.addEventListener('change', () => {
        // btnLighting cycles — click it once per value step
        // For simplicity, trigger click on change
        oldLightBtn.click();
      });
    }

    // Mode buttons
    const modeMap = {
      'rf-mode-point':        'btnEditPoints',
      'rf-mode-skin':         'btnSkinMarks',
      'rf-mode-decal':        'btnDecals',
      'rf-mode-head':         'btnHeadTrack',
      'rf-mode-face-capture': 'btnFaceCapture',
    };
    Object.entries(modeMap).forEach(([newId, oldId]) => {
      const newBtn = document.getElementById(newId);
      const oldBtn = document.getElementById(oldId);
      if (newBtn && oldBtn) {
        newBtn.addEventListener('click', () => {
          oldBtn.click();
          // Toggle active state
          const wasActive = newBtn.classList.contains('active');
          document.querySelectorAll('.rf-mode-btn').forEach(b => b.classList.remove('active'));
          if (!wasActive) newBtn.classList.add('active');
          updateModeBadge();
        });
      }
    });
  }

  // ─── Mode Badge ────────────────────────────────────────────────────────
  function updateModeBadge() {
    const badge = document.getElementById('rf-mode-badge');
    if (!badge) return;

    const modeNames = {
      'rf-mode-point':        { label: 'POINT EDIT',    cls: 'rf-mode-point' },
      'rf-mode-skin':         { label: 'SKIN MARKS',    cls: 'rf-mode-skin' },
      'rf-mode-decal':        { label: 'DECAL',         cls: 'rf-mode-decal' },
      'rf-mode-head':         { label: 'TRACKING',      cls: 'rf-mode-head' },
      'rf-mode-face-capture': { label: 'FACE CAPTURE',  cls: 'rf-mode-head' },
    };

    badge.className = 'active'; // reset
    let found = false;
    for (const [id, info] of Object.entries(modeNames)) {
      const btn = document.getElementById(id);
      if (btn && btn.classList.contains('active')) {
        badge.textContent = info.label;
        badge.classList.add(info.cls);
        found = true;
        break;
      }
    }
    if (!found) {
      badge.className = ''; // hide
      badge.textContent = 'VIEW';
    }

    // Also update status bar mode display
    const sbMode = document.getElementById('rf-sb-mode');
    if (sbMode) sbMode.textContent = badge.textContent || 'VIEW';
  }

  // ─── Viewport Action Buttons ───────────────────────────────────────────
  function bindViewportActionButtons() {
    const actionMap = {
      'rf-vp-undo':          'btnUndo',
      'rf-vp-redo':          'btnRedo',
      'rf-vp-screenshot-btn': 'btnScreenshot',
      'rf-vp-reset-all':     'btnResetAll',
      'rf-face-reset-all':   'btnResetAllMorphs',
    };
    Object.entries(actionMap).forEach(([newId, oldId]) => {
      const newBtn = document.getElementById(newId);
      const oldBtn = document.getElementById(oldId);
      if (newBtn && oldBtn) {
        newBtn.addEventListener('click', () => oldBtn.click());
      } else if (newBtn) {
        // If old btn not found just show toast
        newBtn.addEventListener('click', () => showToast(`Action: ${newId}`, 'info'));
      }
    });
  }

  // ─── Backend Status Mirror ─────────────────────────────────────────────
  function bindBackendStatusMirror() {
    // Watch the old backendStatus element for class changes
    // and mirror them to the new top bar status elements
    const oldStatus = document.getElementById('backendStatus');
    const newDot    = document.getElementById('rf-topbar-status-dot');
    const newText   = document.getElementById('rf-topbar-status-text');
    const sbDot     = document.getElementById('rf-sb-dot');
    const sbText    = document.getElementById('rf-sb-backend-text');
    const banner    = document.getElementById('rf-backend-banner');

    if (!oldStatus) return;

    function syncStatus() {
      const isConnected = oldStatus.querySelector('.status-dot.connected') !== null;
      // New top bar dot
      if (newDot) {
        newDot.classList.toggle('connected', isConnected);
      }
      if (newText) {
        newText.textContent = isConnected ? 'Online' : 'Offline';
      }
      // Status bar dot
      if (sbDot) {
        sbDot.classList.toggle('connected', isConnected);
      }
      if (sbText) {
        sbText.textContent = isConnected ? 'Backend: Online' : 'Backend: Offline';
      }
      // Banner visibility
      if (banner) {
        banner.classList.toggle('visible', !isConnected);
      }
    }

    // Observe mutations on the old backendStatus
    const observer = new MutationObserver(syncStatus);
    observer.observe(oldStatus, { attributes: true, subtree: true, attributeFilter: ['class'] });

    // Initial sync
    syncStatus();

    // Also mirror old statusBackend element
    const oldStatusBackend = document.getElementById('statusBackend');
    if (oldStatusBackend) {
      const sbObserver = new MutationObserver(() => {
        // Sync the tiny status dot
        const sbDotOld = oldStatusBackend.querySelector('.status-dot-small');
        if (sbDotOld && sbDot) {
          sbDot.className = sbDotOld.className;
        }
      });
      sbObserver.observe(oldStatusBackend, { subtree: true, childList: true, characterData: true, attributes: true });
    }
  }

  // ─── Case Title Mirror ─────────────────────────────────────────────────
  function bindCaseTitleMirror() {
    const oldCaseTitle = document.getElementById('caseTitle');
    const newCaseDisplay = document.getElementById('rf-topbar-case-display');
    if (!oldCaseTitle || !newCaseDisplay) return;

    function syncTitle() {
      newCaseDisplay.textContent = oldCaseTitle.textContent || 'New Case — Untitled';
    }

    const observer = new MutationObserver(syncTitle);
    observer.observe(oldCaseTitle, { childList: true, characterData: true, subtree: true });
    syncTitle();
  }

  // ─── Editor Body Wrapper: ensure layouting works ───────────────────────
  function bindEditorBodyWrapper() {
    // The rf-editor-body div wraps everything including the app-container.
    // We just need to ensure it's visible and taking full space.
    const editorBody = document.getElementById('rf-editor-body');
    if (editorBody) {
      editorBody.style.flex = '1';
      editorBody.style.display = 'flex';
      editorBody.style.flexDirection = 'column';
      editorBody.style.overflow = 'hidden';
      editorBody.style.position = 'relative';
    }
  }

  // ─── AI Example Chips ─────────────────────────────────────────────────
  function bindAIExampleChips() {
    const chips = document.querySelectorAll('.rf-ai-example-chip');
    chips.forEach(chip => {
      chip.addEventListener('click', function () {
        const prompt = this.dataset.prompt;
        if (!prompt) return;

        // Fill the AI textarea and submit
        const textarea = document.getElementById('aiChatInput');
        const sendBtn  = document.getElementById('aiSendBtn');
        if (textarea && sendBtn) {
          textarea.value = prompt;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          sendBtn.click();
          // Hide the example chips after first use
          const examples = document.getElementById('rf-ai-examples');
          if (examples) examples.style.display = 'none';
          // Switch to AI tab
          const aiTab = document.querySelector('.rf-sidebar-tab[data-rf-tab="ai"]');
          if (aiTab) aiTab.click();
        }
      });
    });
  }

  // ─── Mirror poly count and FPS to new UI elements ─────────────────────
  function mirrorViewportStats() {
    const oldPolyCount = document.getElementById('polyCount');
    const newPolyCount = document.getElementById('rf-poly-count');
    const sbPoly = document.getElementById('rf-sb-poly');

    if (oldPolyCount && (newPolyCount || sbPoly)) {
      const observer = new MutationObserver(() => {
        const text = oldPolyCount.textContent;
        if (newPolyCount) newPolyCount.textContent = text;
        if (sbPoly) sbPoly.textContent = text;
      });
      observer.observe(oldPolyCount, { childList: true, characterData: true, subtree: true });
    }

    // Mirror statusMeshInfo
    const oldMesh = document.getElementById('statusMeshInfo');
    const newMesh = document.getElementById('rf-sb-mesh');
    if (oldMesh && newMesh) {
      const observer2 = new MutationObserver(() => {
        newMesh.textContent = oldMesh.textContent;
      });
      observer2.observe(oldMesh, { childList: true, characterData: true, subtree: true });
    }
  }

  // ─── Toast utility ─────────────────────────────────────────────────────
  function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('rf-toast-container');
    if (!container) return;

    const icons = { info: 'fa-info-circle', success: 'fa-check-circle', error: 'fa-exclamation-circle' };
    const toast = document.createElement('div');
    toast.className = `rf-toast rf-toast-${type}`;
    toast.innerHTML = `<i class="fas ${icons[type] || 'fa-info-circle'}"></i><span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('rf-toast-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Expose globally for use by other modules
  window.rfShowToast = showToast;

  // ─── Boot ───────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOMContentLoaded already fired (Electron common case)
    // Delay slightly to wait for UIController to attach its listeners
    setTimeout(init, 150);
  }

  // Also re-run mirrorViewportStats after a longer delay (SceneManager may populate after model load)
  setTimeout(mirrorViewportStats, 1000);

})();
