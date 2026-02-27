/**
 * AIController.js
 * Handles AI-powered face generation — sends prompts to backend,
 * applies returned parameters to morpher/hair/appearance, and syncs sliders.
 */

class AIController {
  constructor(backendAPI, morpher, hairSystem, caseManager, uiController) {
    this.api = backendAPI;
    this.morpher = morpher;
    this.hair = hairSystem;
    this.caseManager = caseManager;
    this.ui = uiController;

    // Conversation history for refinement
    this.conversationHistory = [];
    this.isProcessing = false;

    // Chat DOM references (set after DOM init)
    this.chatMessages = null;
    this.chatInput = null;
    this.sendBtn = null;
    this.micBtn = null;
    this.undoAiBtn = null;

    // Voice recognition
    this._recognition = null;
    this._isListening = false;
  }

  /**
   * Initialize DOM bindings for the AI chat panel.
   */
  init() {
    this.chatMessages = document.getElementById('aiChatMessages');
    this.chatInput = document.getElementById('aiChatInput');
    this.sendBtn = document.getElementById('aiSendBtn');
    this.micBtn = document.getElementById('aiMicBtn');
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

    if (this.undoAiBtn) {
      this.undoAiBtn.addEventListener('click', () => this.undoLastAiChange());
    }

    // Initialize voice recognition
    this._initVoiceRecognition();

    // Add welcome message
    this._addMessage('assistant', 'Describe a face and I\'ll build it. You can refine by saying things like "make the nose wider" or "cheeks should be fuller".');
  }

  /**
   * Send the current prompt to the AI backend.
   */
  async sendPrompt() {
    const text = this.chatInput?.value?.trim();
    if (!text || this.isProcessing) return;

    // Show user message
    this._addMessage('user', text);
    this.chatInput.value = '';

    // Set loading state
    this.isProcessing = true;
    this._setLoading(true);

    // Build current state snapshot for refinement context
    const currentState = this._getCurrentState();

    try {
      const response = await fetch(`${this.api.baseUrl}/api/ai/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: text,
          currentState: currentState,
          history: this.conversationHistory,
        }),
      });

      const data = await response.json();

      if (data.error) {
        this._addMessage('assistant', `Error: ${data.error}`);
        return;
      }

      if (data.success && data.params) {
        // Save undo state before applying AI changes
        this.caseManager.pushState('AI face generation');

        // Apply the parameters
        const changes = this._applyParams(data.params);

        // Update conversation history for refinement
        this.conversationHistory.push(
          { role: 'user', content: text },
          { role: 'assistant', content: data.aiResponse }
        );

        // Keep history reasonable (last 10 turns)
        if (this.conversationHistory.length > 20) {
          this.conversationHistory = this.conversationHistory.slice(-20);
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
          this.ui.addHistory('AI: ' + text.substring(0, 40) + (text.length > 40 ? '...' : ''));
        }
      }
    } catch (err) {
      this._addMessage('assistant', `Connection error: ${err.message}. Is the backend running?`);
    } finally {
      this.isProcessing = false;
      this._setLoading(false);
    }
  }

  /**
   * Apply AI-returned parameters to the face.
   * Returns an object summarizing what changed.
   */
  _applyParams(params) {
    const changes = { morphs: 0, hair: false, eyebrows: false, beard: false, appearance: false };

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

    // Sync all sliders to new values
    this._syncSliders();

    return changes;
  }

  /**
   * Apply skin color to the 3D model material and UI.
   */
  _applySkinColor(hex) {
    this.caseManager.updateAppearance('skinColor', hex);
    // Update the material on the head mesh
    if (this.morpher.meshGroup) {
      this.morpher.meshGroup.traverse(child => {
        if (child.isMesh && child.material) {
          child.material.color.set(hex);
        }
      });
    }
    // Update skin tone UI
    const picker = document.getElementById('skinColorPicker');
    if (picker) picker.value = hex;
    const swatches = document.querySelectorAll('#skinToneGrid .skin-swatch');
    swatches.forEach(s => s.classList.toggle('active', s.dataset.color === hex));
  }

  /**
   * Apply eye color to the 3D model material and UI.
   */
  _applyEyeColor(hex) {
    this.caseManager.updateAppearance('eyeColor', hex);
    const swatches = document.querySelectorAll('#eyeColorPresets .color-swatch');
    swatches.forEach(s => s.classList.toggle('active', s.dataset.color === hex));
  }

  /**
   * Sync all morph sliders, hair sliders, etc. to current values.
   */
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

  /**
   * Get current face state for sending to AI as context.
   */
  _getCurrentState() {
    return {
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
  }

  /**
   * Summarize what the AI changed for the chat.
   */
  _summarizeChanges(changes) {
    const parts = [];
    if (changes.morphs > 0) parts.push(`${changes.morphs} facial features`);
    if (changes.hair) parts.push('hair');
    if (changes.eyebrows) parts.push('eyebrows');
    if (changes.beard) parts.push('beard');
    if (changes.appearance) parts.push('appearance');

    if (parts.length === 0) return 'No changes were needed.';
    return `Updated ${parts.join(', ')}. You can refine further or adjust individual sliders manually.`;
  }

  /**
   * Undo the last AI-applied change.
   */
  undoLastAiChange() {
    if (this.ui) {
      // Trigger the existing undo system
      document.getElementById('btnUndo')?.click();
    }
  }

  /**
   * Clear conversation history and start fresh.
   */
  clearConversation() {
    this.conversationHistory = [];
    if (this.chatMessages) {
      this.chatMessages.innerHTML = '';
    }
    this._addMessage('assistant', 'Conversation cleared. Describe a new face to get started.');
  }

  // ─── Chat UI Helpers ──────────────────────────────────────────────────────

  _addMessage(role, content) {
    if (!this.chatMessages) return;
    const msg = document.createElement('div');
    msg.className = `ai-chat-msg ai-chat-${role}`;
    msg.textContent = content;
    this.chatMessages.appendChild(msg);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

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

  // ─── Voice Recording (Web Audio → Backend Transcription) ─────────────────

  _initVoiceRecognition() {
    // Using Web Audio recording + backend speech-to-text (works in Electron)
    this._mediaRecorder = null;
    this._audioChunks = [];
    this._audioStream = null;
  }

  async toggleVoice() {
    if (this._isListening) {
      // Stop recording
      this._stopRecording();
    } else {
      // Start recording
      await this._startRecording();
    }
  }

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

  async _processRecording() {
    if (this._audioChunks.length === 0) {
      this._resetInputPlaceholder();
      return;
    }

    try {
      const webmBlob = new Blob(this._audioChunks, { type: 'audio/webm' });

      // Send audio to backend for transcription (backend handles format conversion)
      const formData = new FormData();
      formData.append('audio', webmBlob, 'recording.webm');

      const response = await fetch(`${this.api.baseUrl}/api/speech/transcribe`, {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();

      if (data.success && data.text) {
        // Show transcribed text in the input — user can review/edit before sending
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

  _resetInputPlaceholder() {
    if (this.chatInput) {
      this.chatInput.placeholder = 'Describe a face or give instructions...';
    }
  }

}

window.AIController = AIController;
