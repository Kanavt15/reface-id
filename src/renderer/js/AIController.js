// Runs the AI assistant: sends descriptions and photos to the backend and applies the returned face to the model and sliders.

class AIController {
  constructor(backendAPI, morpher, hairSystem, caseManager, uiController) {
    this.api = backendAPI;
    this.morpher = morpher;
    this.hair = hairSystem;
    this.eyes = null;
    this.caseManager = caseManager;
    this.ui = uiController;
    this.skinMarkSystem = null;
    this.markPositionMapper = null;
    this.keys = null;  // ApiKeyGate, set from app.js; it owns the provider keys.

    // Conversation history for refinement
    this.conversationHistory = [];
    this.isProcessing = false;

    // Chat DOM references (set after DOM init)
    this.chatMessages = null;
    this.chatInput = null;
    this.sendBtn = null;
    this.micBtn = null;
    this.actionBtn = null;
    this.actionMenu = null;
    this.menuUploadBtn = null;
    this.menuCameraBtn = null;
    this.imageInput = null;
    this.referenceInfo = null;
    this.undoAiBtn = null;

    this.referenceImages = [];

    // Camera capture
    this.cameraModal = null;
    this.cameraVideo = null;
    this.cameraCanvas = null;
    this.cameraCaptureBtn = null;
    this.cameraCloseBtn = null;
    this._cameraStream = null;

    // Voice recognition
    this._recognition = null;
    this._isListening = false;

    // Provider selection
    this.providerSelect = null;
    this.availableProviders = [];

    // Mark handling options
    this.generateFacialMarks = false;
    this.markHandlingMode = 'preserve';  // 'preserve', 'replace', or 'merge'
  }

  // Wires up the AI chat panel's buttons, inputs and camera.
  init() {
    this.chatMessages = document.getElementById('aiChatMessages');
    this.chatInput = document.getElementById('aiChatInput');
    this.sendBtn = document.getElementById('aiSendBtn');
    this.micBtn = document.getElementById('aiMicBtn');
    this.actionBtn = document.getElementById('aiActionBtn');
    this.actionMenu = document.getElementById('aiActionMenu');
    this.menuUploadBtn = document.getElementById('aiMenuUploadBtn');
    this.menuCameraBtn = document.getElementById('aiMenuCameraBtn');
    this.imageInput = document.getElementById('aiImageInput');
    this.referenceInfo = document.getElementById('aiReferenceInfo');
    this.undoAiBtn = document.getElementById('aiUndoBtn');

    if (this.sendBtn) {
      this.sendBtn.addEventListener('click', () => this.sendPrompt());
    }

    if (this.chatInput) {
      this.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendPrompt();
        }
      });
    }

    if (this.micBtn) {
      this.micBtn.addEventListener('click', () => this.toggleVoice());
    }

    if (this.actionBtn && this.actionMenu) {
      this.actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.actionMenu.classList.toggle('visible');
        this.actionBtn.classList.toggle('active');
      });

      // Close menu when clicking outside
      document.addEventListener('click', (e) => {
        if (!this.actionBtn.contains(e.target) && !this.actionMenu.contains(e.target)) {
          this.actionMenu.classList.remove('visible');
          this.actionBtn.classList.remove('active');
        }
      });
    }

    if (this.menuUploadBtn && this.imageInput) {
      this.menuUploadBtn.addEventListener('click', () => {
        this.actionMenu.classList.remove('visible');
        this.actionBtn.classList.remove('active');
        this.imageInput.click();
      });
      this.imageInput.addEventListener('change', (e) => this._onReferenceImageSelected(e));
    }

    if (this.menuCameraBtn) {
      this.menuCameraBtn.addEventListener('click', () => {
        this.actionMenu.classList.remove('visible');
        this.actionBtn.classList.remove('active');
        this._openCamera();
      });
    }

    // Camera capture
    this.cameraModal = document.getElementById('aiCameraModal');
    this.cameraVideo = document.getElementById('aiCameraVideo');
    this.cameraCanvas = document.getElementById('aiCameraCanvas');
    this.cameraCaptureBtn = document.getElementById('aiCameraCaptureBtn');
    this.cameraCloseBtn = document.getElementById('aiCameraCloseBtn');
    if (this.cameraCaptureBtn) {
      this.cameraCaptureBtn.addEventListener('click', () => this._capturePhoto());
    }
    if (this.cameraCloseBtn) {
      this.cameraCloseBtn.addEventListener('click', () => this._closeCamera());
    }

    if (this.undoAiBtn) {
      this.undoAiBtn.addEventListener('click', () => this.undoLastAiChange());
    }

    // Clear conversation button
    const clearBtn = document.getElementById('aiClearBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearConversation());
    }

    // Provider selector
    this.providerSelect = document.getElementById('aiProviderSelect');

    // Changing model can change provider, so refresh the "(no key)" labels.
    if (this.providerSelect) {
      this.providerSelect.addEventListener('change', () => this._paintProviders());
    }

    // Lets the operator open the key dialog on purpose, to replace or remove a key.
    const keyBtn = document.getElementById('aiKeyBtn');
    if (keyBtn) {
      keyBtn.addEventListener('click', () => this.keys?.open(this._selectedProvider()));
    }

    // Mark generation and handling controls
    const generateMarksCheckbox = document.getElementById('aiGenerateMarksCheckbox');
    if (generateMarksCheckbox) {
      generateMarksCheckbox.addEventListener('change', (e) => {
        this.generateFacialMarks = e.target.checked;
      });
    }

    const markModeRadios = document.querySelectorAll('input[name="aiMarkMode"]');
    markModeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.markHandlingMode = e.target.value;
      });
    });

    // Initialize voice recognition
    this._initVoiceRecognition();

    // Detect which AI providers are available
    this._detectProviders();

    // Add welcome message
    this._addMessage('assistant', 'Describe a face and I\'ll build it. You can refine by saying things like "make the nose wider" or "cheeks should be fuller".');
  }

  // Sends the current prompt to the AI and applies the result.
  async sendPrompt() {
    const text = this.chatInput?.value?.trim();
    if ((!text && this.referenceImages.length === 0) || this.isProcessing) return;

    let [provider, model] = (this.providerSelect?.value || 'anthropic:claude-opus-5').split(':');

    // Ask for a key only when it is needed, and before echoing the prompt so a dismissed dialog keeps the text.
    if (this.keys && !(await this.keys.ensure(provider))) {
      this._addMessage('assistant', 'No API key entered, so nothing was sent.');
      return;
    }

    // The key saved may be for a different provider; the picker has already moved to it, so follow it.
    [provider, model] = (this.providerSelect?.value || `${provider}:${model}`).split(':');

    // Show user message
    const hasImages = this.referenceImages.length > 0;
    const imageSummary = hasImages
      ? this.referenceImages.map(img => img.name).join(', ')
      : '';
    const userMessage = hasImages
      ? `${text || 'Use these images as reference.'}\n[${this.referenceImages.length} reference image${this.referenceImages.length > 1 ? 's' : ''} attached: ${imageSummary}]`
      : text;
    this._addMessage('user', userMessage);
    this.chatInput.value = '';

    // Set loading state
    this.isProcessing = true;
    this._setLoading(true);

    // Build current state snapshot for refinement context
    const currentState = this._getCurrentState();

    try {
      const send = () => fetch(`${this.api.baseUrl}/api/ai/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          currentState: currentState,
          history: this.conversationHistory,
          referenceImages: this.referenceImages,
          generateFacialMarks: this.generateFacialMarks,
          markHandlingMode: this.markHandlingMode,
          provider: provider,
          model: model,
        }),
      });

      let data = await (await send()).json();

      // If the key was revoked or ran out, ask for a new one and resend the same request.
      if (data.needsKey && this.keys && await this.keys.handleResponse(data, provider)) {
        data = await (await send()).json();
      }

      if (data.error) {
        this._addMessage('assistant', `Error: ${data.error}`);
        return;
      }

      if (data.success && data.params) {
        // Save undo state before applying AI changes
        this.caseManager.pushState('AI face generation');

        // Apply the parameters
        const changes = this._applyParams(data.params);

        // Keep the history as text only, dropping images to save tokens.
        this.conversationHistory.push(
          { role: 'user', content: userMessage },
          { role: 'assistant', content: data.aiResponse }
        );

        // Keep history to last 3 turns (6 messages) to control API costs
        if (this.conversationHistory.length > 6) {
          this.conversationHistory = this.conversationHistory.slice(-6);
        }

        // Show success message with summary
        const summary = this._summarizeChanges(changes);
        this._addMessage('assistant', summary);

        // Sync UI sliders
        if (this.ui) {
          this.ui.updatePropertyPanel();
        }

        // Log in history
        if (this.ui) {
          const historyLabel = text || (hasImages ? `[${this.referenceImages.length} image reference${this.referenceImages.length > 1 ? 's' : ''}]` : 'AI request');
          this.ui.addHistory('AI: ' + historyLabel.substring(0, 40) + (historyLabel.length > 40 ? '...' : ''));
        }

        // Reference images are used once, then cleared for the next turn.
        this._clearReferenceImages();
      }
    } catch (err) {
      this._addMessage('assistant', `Connection error: ${err.message}. Is the backend running?`);
    } finally {
      this.isProcessing = false;
      this._setLoading(false);
    }
  }

  // Applies the AI's parameters to the face and returns a summary of what changed.
  _applyParams(params) {
    const changes = {
      morphs: 0, hair: false, eyebrows: false, beard: false,
      appearance: false, marks: false,
      glasses: false, faceMask: false, earrings: false, bandana: false,
      browPiercing: false,
    };

    // Apply morph targets (set values directly, then apply once for performance)
    if (params.morphTargets) {
      for (const [param, value] of Object.entries(params.morphTargets)) {
        if (this.morpher.morphValues.hasOwnProperty(param)) {
          const clamped = Math.max(0, Math.min(100, Math.round(value)));
          this.morpher.morphValues[param] = clamped;
          changes.morphs++;
        }
      }
      this.morpher.applyAllMorphs();
      this.caseManager.updateMorphTargets(this.morpher.morphValues);
    }

    // Apply hair
    if (params.hair) {
      if (params.hair.style && this.hair.hairModels[params.hair.style]) {
        this.hair.setStyle(params.hair.style);
        changes.hair = true;
      }
      if (params.hair.color) {
        this.hair.setColor(params.hair.color);
        changes.hair = true;
      }
      const hairParamMap = {
        length: 'length', density: 'density', volume: 'volume', curl: 'curl'
      };
      for (const [key, paramName] of Object.entries(hairParamMap)) {
        if (params.hair[key] !== undefined) {
          this.hair.setParam(paramName, Math.max(0, Math.min(100, Math.round(params.hair[key]))));
          changes.hair = true;
        }
      }
      this.caseManager.updateHairParams(this.hair.getParams());
    }

    // Apply eyebrows
    if (params.eyebrows) {
      const ebMap = { thickness: 'thickness', arch: 'arch', spacing: 'spacing', density: 'density' };
      for (const [key, paramName] of Object.entries(ebMap)) {
        if (params.eyebrows[key] !== undefined) {
          this.hair.setEyebrowParam(paramName, Math.max(0, Math.min(100, Math.round(params.eyebrows[key]))));
          changes.eyebrows = true;
        }
      }
      if (params.eyebrows.color) {
        this.hair.setEyebrowColor(params.eyebrows.color);
        changes.eyebrows = true;
      }
      this.caseManager.updateHairParams(this.hair.getParams());
    }

    // Apply beard
    if (params.beard) {
      if (params.beard.style !== undefined) {
        this.hair.setBeard(params.beard.style);
        changes.beard = true;
      }
      if (params.beard.color) {
        this.hair.setBeardColor(params.beard.color);
        changes.beard = true;
      }
      this.caseManager.updateHairParams(this.hair.getParams());
    }

    // Apply appearance
    if (params.appearance) {
      if (params.appearance.skinColor) {
        this._applySkinColor(params.appearance.skinColor);
        changes.appearance = true;
      }
      if (params.appearance.lipColor) {
        this._applyLipColor(params.appearance.lipColor);
        changes.appearance = true;
      }
      if (params.appearance.eyeColor) {
        this._applyEyeColor(params.appearance.eyeColor);
        changes.appearance = true;
      }
      if (params.appearance.ageRange) {
        this.caseManager.updateAppearance('ageRange', params.appearance.ageRange);
        const ageSelect = document.getElementById('ageRange');
        if (ageSelect) ageSelect.value = params.appearance.ageRange;
        changes.appearance = true;
      }
      if (params.appearance.sex) {
        this.caseManager.updateAppearance('sex', params.appearance.sex);
        const sexSelect = document.getElementById('sexSelect');
        if (sexSelect) sexSelect.value = params.appearance.sex;
        changes.appearance = true;
      }
    }

    // Apply facial marks if provided
    if (params.facialMarks && this.skinMarkSystem && this.markPositionMapper) {
      // Only report marks as changed if they really were; 'preserve' can drop them.
      changes.marks = this._applyFacialMarks(params.facialMarks);
    }

    // Each accessory system checks its own data, so this only routes it, saves it and refreshes the panel.
    const accessories = [
      ['glasses',  this.glasses,  'glasses',  '_syncGlassesUI'],
      ['faceMask', this.faceMask, 'faceMask', '_syncFaceMaskUI'],
      ['earrings', this.earrings, 'earrings', '_syncEarringUI'],
      ['bandana',  this.bandana,  'bandana',  '_syncBandanaUI'],
      ['browPiercing', this.browPiercing, 'browPiercing', '_syncBrowRingUI'],
    ];
    for (const [key, system, caseKey, syncFn] of accessories) {
      if (!params[key] || !system) continue;
      system.applyFromAI(params[key]);
      this.caseManager.updateAppearance(caseKey, system.exportState());
      if (this.ui && typeof this.ui[syncFn] === 'function') {
        this.ui[syncFn](system.exportState());
      }
      changes[key] = true;
    }

    // A bandana and a face mask can't be worn together, so keep only one.
    if (this.bandana?.enabled && this.faceMask?.enabled) {
      this.faceMask.setEnabled(false);
      this.caseManager.updateAppearance('faceMask', this.faceMask.exportState());
      if (this.ui && typeof this.ui._syncFaceMaskUI === 'function') {
        this.ui._syncFaceMaskUI(this.faceMask.exportState());
      }
      changes.faceMask = true;
    }

    // Sync all sliders to new values
    this._syncSliders();

    return changes;
  }

  // Places the AI's facial marks on the face.
  _applyFacialMarks(aiMarks) {
    if (!Array.isArray(aiMarks) || aiMarks.length === 0) return false;

    const existingCount = typeof this.skinMarkSystem.getMarkCount === 'function'
      ? this.skinMarkSystem.getMarkCount()
      : 0;

    // The mark mode decides what happens to marks the operator already placed.
    if (this.markHandlingMode === 'replace') {
      // AI wins: wipe the existing set first.
      this.skinMarkSystem.clearAll();
    } else if (this.markHandlingMode === 'preserve' && existingCount > 0) {
      // Operator's marks win, but only when there are some; on a fresh face the AI's marks are added.
      console.log(`[AIController] Preserving ${existingCount} existing mark(s); dropped ${aiMarks.length} from the AI`);
      return false;
    }
    // 'merge' falls through: existing marks stay and the AI's are added on top.

    for (const markData of aiMarks) {
      try {
        // Map region + offset to 3D world position
        const mapped = this.markPositionMapper.mapMarkPosition(
          markData.region,
          markData.side || 'center',
          markData.offset_x || 0,
          markData.offset_y || 0,
          markData.size || 0.02
        );

        if (mapped) {
          // Create mark intersection object for SkinMarkSystem
          const intersection = {
            point: new THREE.Vector3().fromArray(mapped.position),
            face: { normal: new THREE.Vector3().fromArray(mapped.normal) },
            object: this.morpher.meshes[0],  // Use first mesh as fallback
            faceIndex: 0,
          };

          // Temporarily change mark type and add
          const originalType = this.skinMarkSystem.activeMarkType;
          this.skinMarkSystem.activeMarkType = markData.type || 'birthmark';

          const newMark = this.skinMarkSystem.addMark(intersection);

          if (newMark && markData.size) {
            newMark.size = markData.size;
            this.skinMarkSystem.updateSelectedMark('size', markData.size);
          }

          this.skinMarkSystem.activeMarkType = originalType;
        }
      } catch (err) {
        console.warn('Failed to apply mark:', markData, err);
      }
    }

    // Save marks to case manager
    this.caseManager.updateSkinMarks(this.skinMarkSystem.exportState());
    return true;
  }

  // Applies a skin colour to the model and the colour picker.
  _applySkinColor(hex) {
    this.caseManager.updateAppearance('skinColor', hex);
    // Use SceneManager.setSkinColor so the colour, texture and material stay in sync.
    if (this.scene) {
      this.scene.setSkinColor(hex);
    }
    // Update skin tone UI
    const picker = document.getElementById('skinColorPicker');
    if (picker) picker.value = hex;
    const swatches = document.querySelectorAll('#skinToneGrid .skin-swatch');
    swatches.forEach(s => s.classList.toggle('active', s.dataset.color === hex));
  }

  // Applies a lip colour to the model and the colour picker.
  _applyLipColor(hex) {
    this.caseManager.updateAppearance('lipColor', hex);
    if (this.scene) {
      this.scene.setLipColor(hex);
    }
    const picker = document.getElementById('lipColorPicker');
    if (picker) picker.value = hex;
    const swatches = document.querySelectorAll('#lipColorPresets .color-swatch');
    swatches.forEach(s => s.classList.toggle('active', s.dataset.color === hex));
  }

  // Applies an eye colour to the model and the colour picker.
  _applyEyeColor(hex) {
    if (this.eyes) {
      this.eyes.setEyeColor(hex);
    }
    this.caseManager.updateAppearance('eyeColor', hex);
    const swatches = document.querySelectorAll('#eyeColorPresets .color-swatch');
    swatches.forEach(s => s.classList.toggle('active', s.dataset.color === hex));
  }

  // Moves every slider and picker to match the current values.
  _syncSliders() {
    // Morph sliders
    document.querySelectorAll('.slider-control[data-param]').forEach(ctrl => {
      const param = ctrl.dataset.param;
      const slider = ctrl.querySelector('.morph-slider');
      const valueSpan = ctrl.querySelector('.slider-value');
      if (slider && this.morpher.morphValues[param] !== undefined) {
        slider.value = this.morpher.morphValues[param];
        if (valueSpan) valueSpan.textContent = this.morpher.morphValues[param];
      }
    });

    // Hair sliders
    const hairSliderMap = {
      hairLength: 'length', hairDensity: 'density', hairVolume: 'volume', hairCurl: 'curl',
      hairPosX: 'posx', hairPosY: 'posy', hairPosZ: 'posz', hairRotY: 'roty', hairScale: 'scale',
    };
    for (const [dataParam, hairKey] of Object.entries(hairSliderMap)) {
      const ctrl = document.querySelector(`.slider-control[data-param="${dataParam}"]`);
      if (ctrl && this.hair.params[hairKey] !== undefined) {
        const slider = ctrl.querySelector('.hair-slider');
        const valueSpan = ctrl.querySelector('.slider-value');
        if (slider) slider.value = this.hair.params[hairKey];
        if (valueSpan) valueSpan.textContent = this.hair.params[hairKey];
      }
    }

    // Hair style card
    document.querySelectorAll('.hair-style-card').forEach(card => {
      card.classList.toggle('active', card.dataset.style === this.hair.currentStyle);
    });

    // Hair color picker
    const hairColorPicker = document.getElementById('hairColorPicker');
    if (hairColorPicker) hairColorPicker.value = this.hair.hairColor;
  }

  // Collects the current face state to send to the AI as context.
  _getCurrentState() {
    const state = {
      morphTargets: { ...this.morpher.morphValues },
      hair: {
        style: this.hair.currentStyle,
        color: this.hair.hairColor,
        length: this.hair.params.length,
        density: this.hair.params.density,
        volume: this.hair.params.volume,
        curl: this.hair.params.curl,
      },
      eyebrows: {
        thickness: this.hair.eyebrowParams.thickness,
        arch: this.hair.eyebrowParams.arch,
        spacing: this.hair.eyebrowParams.spacing,
        density: this.hair.eyebrowParams.density,
        color: this.hair.eyebrowColor,
      },
      beard: {
        style: this.hair.beardStyle,
        color: this.hair.beardColor,
      },
      appearance: { ...this.caseManager.currentCase.appearance },
    };

    // Include accessories so the AI can make relative changes like "make the glasses darker".
    if (this.glasses) state.glasses = this.glasses.exportState();
    if (this.faceMask) state.faceMask = this.faceMask.exportState();
    if (this.earrings) state.earrings = this.earrings.exportState();
    if (this.bandana) state.bandana = this.bandana.exportState();

    // Include skin marks if available
    if (this.skinMarkSystem) {
      const marks = this.skinMarkSystem.exportState();
      if (marks && marks.length > 0) {
        state.skinMarks = marks;
      }
    }

    return state;
  }

  // Builds a short chat summary of what the AI changed.
  _summarizeChanges(changes) {
    const parts = [];
    if (changes.morphs > 0) parts.push(`${changes.morphs} facial features`);
    if (changes.hair) parts.push('hair');
    if (changes.eyebrows) parts.push('eyebrows');
    if (changes.beard) parts.push('beard');
    if (changes.appearance) parts.push('appearance');
    if (changes.marks) parts.push('marks/scars');
    if (changes.glasses) parts.push('glasses');
    if (changes.faceMask) parts.push('face mask');
    if (changes.earrings) parts.push('earrings');
    if (changes.bandana) parts.push('bandana');
    if (changes.browPiercing) parts.push('eyebrow piercing');

    if (parts.length === 0) return 'No changes were needed.';
    return `Updated ${parts.join(', ')}. You can refine further or adjust individual sliders manually.`;
  }

  // Undoes the last AI change using the normal undo.
  undoLastAiChange() {
    if (this.ui) {
      // Trigger the existing undo system
      document.getElementById('btnUndo')?.click();
    }
  }

  // Clears the conversation and starts fresh.
  clearConversation() {
    this.conversationHistory = [];
    this._clearReferenceImages();
    if (this.chatMessages) {
      this.chatMessages.innerHTML = '';
    }
    this._addMessage('assistant', 'Conversation cleared. Describe a new face to get started.');
  }

  // ─── Chat UI Helpers ──────────────────────────────────────────────────────

  // Adds a message to the chat.
  _addMessage(role, content) {
    if (!this.chatMessages) return;
    const msg = document.createElement('div');
    msg.className = `ai-chat-msg ai-chat-${role}`;
    msg.textContent = content;
    this.chatMessages.appendChild(msg);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  // Shows or hides the "thinking" state on the send button and in the chat.
  _setLoading(loading) {
    if (this.sendBtn) {
      this.sendBtn.disabled = loading;
      this.sendBtn.innerHTML = loading
        ? '<i class="fas fa-spinner fa-spin"></i>'
        : '<i class="fas fa-paper-plane"></i>';
    }
    if (this.chatInput) {
      this.chatInput.disabled = loading;
    }
    if (this.actionBtn) {
      this.actionBtn.disabled = loading;
    }
    if (loading) {
      this._addMessage('assistant', 'Thinking...');
    } else {
      // Remove the "Thinking..." message
      const msgs = this.chatMessages?.querySelectorAll('.ai-chat-assistant');
      if (msgs && msgs.length > 0) {
        const last = msgs[msgs.length - 1];
        if (last.textContent === 'Thinking...') {
          last.remove();
        }
      }
    }
  }

  // Provider detection

  // Returns the provider part of the model picker's value, such as 'anthropic'.
  _selectedProvider() {
    return (this.providerSelect?.value || 'anthropic:claude-opus-5').split(':')[0];
  }

  // Marks providers without a key as "(no key)"; they stay selectable so choosing one prompts for its key.
  _paintProviders() {
    const providers = this.keys?.providers;
    if (!providers || !this.providerSelect) return;

    Array.from(this.providerSelect.options).forEach(opt => {
      // Keep the original label so "(no key)" isn't added twice.
      if (!opt.dataset.label) opt.dataset.label = opt.textContent;
      const info = providers[opt.value.split(':')[0]];
      opt.textContent = info && !info.available
        ? `${opt.dataset.label} (no key)`
        : opt.dataset.label;
    });

    // If only another provider has a key, switch the picker to it.
    if (!providers[this._selectedProvider()]?.available) {
      const ready = Array.from(this.providerSelect.options)
        .find(opt => providers[opt.value.split(':')[0]]?.available);
      if (ready) this.providerSelect.value = ready.value;
    }
  }

  // Labels the providers now and whenever the keys change.
  _detectProviders() {
    if (!this.keys) return;
    this._paintProviders();
    this.keys.subscribe(() => this._paintProviders());
  }

  // Voice input (recorded here, transcribed by the backend)

  // Sets up voice recording state.
  _initVoiceRecognition() {
    this._mediaRecorder = null;
    this._audioChunks = [];
    this._audioStream = null;
  }

  // Starts or stops voice recording.
  async toggleVoice() {
    if (this._isListening) {
      this._stopRecording();
    } else {
      await this._startRecording();
    }
  }

  // Starts recording from the microphone.
  async _startRecording() {
    try {
      this._audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._audioChunks = [];
      this._mediaRecorder = new MediaRecorder(this._audioStream, { mimeType: 'audio/webm' });

      this._mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this._audioChunks.push(e.data);
      };

      this._mediaRecorder.onstop = () => this._processRecording();

      this._mediaRecorder.start();
      this._isListening = true;

      if (this.micBtn) {
        this.micBtn.classList.add('ai-mic-active');
        this.micBtn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
      }
      if (this.chatInput) {
        this.chatInput.value = '';
        this.chatInput.placeholder = 'Recording... click mic to stop';
      }
    } catch (err) {
      console.error('[AIController] Mic access error:', err);
      this._addMessage('assistant', 'Microphone access denied. Please allow microphone access and try again.');
    }
  }

  // Stops recording and releases the microphone.
  _stopRecording() {
    if (this._mediaRecorder && this._mediaRecorder.state === 'recording') {
      this._mediaRecorder.stop();
    }
    if (this._audioStream) {
      this._audioStream.getTracks().forEach(t => t.stop());
      this._audioStream = null;
    }
    this._isListening = false;
    if (this.micBtn) {
      this.micBtn.classList.remove('ai-mic-active');
      this.micBtn.innerHTML = '<i class="fas fa-microphone"></i>';
    }
    if (this.chatInput) {
      this.chatInput.placeholder = 'Transcribing...';
    }
  }

  // Sends the recording to the backend for transcription and puts the text in the input box.
  async _processRecording() {
    if (this._audioChunks.length === 0) {
      this._resetInputPlaceholder();
      return;
    }

    try {
      const webmBlob = new Blob(this._audioChunks, { type: 'audio/webm' });

      // Send the audio to the backend, which handles format conversion.
      const formData = new FormData();
      formData.append('audio', webmBlob, 'recording.webm');

      const response = await fetch(`${this.api.baseUrl}/api/speech/transcribe`, {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();

      if (data.success && data.text) {
        // Put the text in the input so the user can check it before sending.
        if (this.chatInput) {
          this.chatInput.value = data.text;
          this.chatInput.placeholder = 'Review and press Enter to send, or edit first';
          this.chatInput.focus();
        }
      } else {
        this._resetInputPlaceholder();
        this._addMessage('assistant', `Voice error: ${data.error || 'Could not transcribe audio'}`);
      }
    } catch (err) {
      console.warn('[AIController] Recording processing error:', err);
      this._resetInputPlaceholder();
      this._addMessage('assistant', `Transcription failed: ${err.message}`);
    }
  }

  // Restores the chat input's placeholder text.
  _resetInputPlaceholder() {
    if (this.chatInput) {
      this.chatInput.placeholder = 'Describe a face or give instructions...';
    }
  }

  // Adds the chosen photos as reference images, up to the limit.
  async _onReferenceImageSelected(event) {
    const files = Array.from(event.target?.files || []);
    if (!files.length) return;

    const maxImages = 10;
    const remainingSlots = maxImages - this.referenceImages.length;
    if (remainingSlots <= 0) {
      this._addMessage('assistant', `You can attach up to ${maxImages} reference images per prompt.`);
      this.imageInput.value = '';
      return;
    }

    if (files.length > remainingSlots) {
      this._addMessage('assistant', `Only ${remainingSlots} more image${remainingSlots > 1 ? 's are' : ' is'} allowed for this prompt.`);
    }

    const maxBytes = 5 * 1024 * 1024;
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp'];
    const filesToLoad = files.slice(0, remainingSlots).filter((file) => {
      if (file.size > maxBytes) {
        this._addMessage('assistant', `${file.name}: image is too large. Use under 5MB.`);
        return false;
      }
      if (!allowedTypes.includes(file.type)) {
        this._addMessage('assistant', `${file.name}: unsupported format. Use PNG, JPEG, or WEBP.`);
        return false;
      }
      return true;
    });

    if (filesToLoad.length === 0) {
      this.imageInput.value = '';
      return;
    }

    try {
      const loaded = await Promise.all(filesToLoad.map(file => this._readReferenceImage(file)));
      this.referenceImages.push(...loaded);
      this._renderReferenceImages();
    } catch (err) {
      this._addMessage('assistant', `Could not read selected images: ${err.message}`);
    } finally {
      // Reset so picking the same file again still triggers a change.
      this.imageInput.value = '';
    }
  }

  // Reads an image file as a data URL.
  _readReferenceImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          name: file.name,
          mimeType: file.type,
          dataUrl: reader.result,
        });
      };
      reader.onerror = () => reject(new Error(`failed to read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  // Shows the reference image thumbnails with remove buttons.
  _renderReferenceImages() {
    if (!this.referenceInfo) return;
    if (this.referenceImages.length === 0) {
      this.referenceInfo.style.display = 'none';
      this.referenceInfo.innerHTML = '';
      this.attachBtn?.classList.remove('active');
      return;
    }

    this.referenceInfo.style.display = '';
    this.referenceInfo.innerHTML = '';
    this.referenceImages.forEach((img, index) => {
      const chip = document.createElement('div');
      chip.className = 'ai-reference-chip';

      const icon = document.createElement('i');
      icon.className = 'fas fa-image';
      chip.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'ai-reference-name';
      name.title = img.name;
      name.textContent = img.name;
      chip.appendChild(name);

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'ai-reference-clear';
      clearBtn.title = 'Remove image';
      clearBtn.innerHTML = '<i class="fas fa-times"></i>';
      clearBtn.addEventListener('click', () => this._removeReferenceImage(index));
      chip.appendChild(clearBtn);

      this.referenceInfo.appendChild(chip);
    });

    this.attachBtn?.classList.add('active');
  }

  // Removes one reference image.
  _removeReferenceImage(index) {
    if (index < 0 || index >= this.referenceImages.length) return;
    this.referenceImages.splice(index, 1);
    this._renderReferenceImages();
  }

  // Removes every reference image.
  _clearReferenceImages() {
    this.referenceImages = [];
    if (this.imageInput) this.imageInput.value = '';
    this._renderReferenceImages();
  }

  // ── Camera Capture ──────────────────────────────────────────

  // Opens the webcam to take a reference photo.
  async _openCamera() {
    if (!this.cameraModal || !this.cameraVideo) return;

    const maxImages = 10;
    if (this.referenceImages.length >= maxImages) {
      this._addMessage('assistant', `You can attach up to ${maxImages} reference images per prompt.`);
      return;
    }

    try {
      this._cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      this.cameraVideo.srcObject = this._cameraStream;
      this.cameraModal.style.display = '';
    } catch (err) {
      this._addMessage('assistant', `Could not access camera: ${err.message}`);
    }
  }

  // Takes a photo from the webcam and adds it as a reference image.
  _capturePhoto() {
    if (!this.cameraVideo || !this.cameraCanvas) return;

    const video = this.cameraVideo;
    const canvas = this.cameraCanvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/png');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    this.referenceImages.push({
      name: `camera-${timestamp}.png`,
      mimeType: 'image/png',
      dataUrl,
    });

    this._renderReferenceImages();
    this._closeCamera();
    this._addMessage('assistant', 'Photo captured and attached as a reference image.');
  }

  // Closes the webcam dialog and stops the camera.
  _closeCamera() {
    if (this._cameraStream) {
      this._cameraStream.getTracks().forEach(track => track.stop());
      this._cameraStream = null;
    }
    if (this.cameraVideo) {
      this.cameraVideo.srcObject = null;
    }
    if (this.cameraModal) {
      this.cameraModal.style.display = 'none';
    }
  }

}

window.AIController = AIController;
