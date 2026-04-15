import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HTML_FILE = 'src/renderer/index.html'
with open(HTML_FILE, 'r', encoding='utf-8') as f:
    content = f.read()

LF = '\r\n'
steps_ok = 0
steps_fail = 0

def replace_once(content, old, new, label):
    global steps_ok, steps_fail
    if old in content:
        content = content.replace(old, new, 1)
        print(f'  [OK] {label}')
        steps_ok += 1
    else:
        print(f'  [FAIL] {label} - pattern not found')
        steps_fail += 1
    return content

# ═══════════════════════════════════════════════════════
# STEP 1: Inject new top bar BEFORE #titlebar
# ═══════════════════════════════════════════════════════
OLD1 = '<!-- Screen 4: Main Editor (all existing app HTML below) -->\r\n    <div id="rf-screen-editor" class="rf-screen rf-screen-hidden">\r\n\r\n  <!-- \u2500\u2500\u2500 Custom Title Bar'

NEW1 = '''<!-- Screen 4: Main Editor (all existing app HTML below) -->
    <div id="rf-screen-editor" class="rf-screen rf-screen-hidden">

  <!-- ══ NEW EDITOR TOP BAR ══ -->
  <div id="rf-editor-topbar">
    <div class="rf-topbar-left">
      <div class="rf-topbar-logo">
        <i class="fas fa-gem rf-topbar-logo-icon"></i>
        <span><span class="rf-topbar-logo-re">Re</span>Face</span>
        <span class="rf-topbar-logo-badge">PRO</span>
      </div>
    </div>
    <div class="rf-topbar-sep"></div>
    <div class="rf-topbar-center">
      <span class="rf-topbar-case-title" id="rf-topbar-case-display">New Case &#8212; Untitled</span>
    </div>
    <div class="rf-topbar-right">
      <button class="rf-topbar-btn rf-topbar-btn-gold" id="rf-topbar-save" title="Save Case (Ctrl+S)">
        <i class="fas fa-save"></i> Save
      </button>
      <button class="rf-topbar-btn" id="rf-topbar-export" title="Export GLB / FBX">
        <i class="fas fa-file-export"></i> Export
      </button>
      <div class="rf-topbar-sep"></div>
      <button class="rf-topbar-icon-btn" id="rf-topbar-screenshot" title="Take Screenshot">
        <i class="fas fa-camera"></i>
      </button>
      <button class="rf-topbar-icon-btn" id="rf-topbar-settings" title="Settings">
        <i class="fas fa-sliders-h"></i>
      </button>
      <div class="rf-topbar-sep"></div>
      <div class="rf-topbar-status" id="rf-topbar-backend-status">
        <span class="rf-topbar-status-dot" id="rf-topbar-status-dot"></span>
        <span id="rf-topbar-status-text">Connecting&#8230;</span>
      </div>
      <div class="rf-topbar-sep"></div>
      <div class="rf-topbar-wctrl">
        <button class="rf-wc-btn rf-wc-close" id="rf-tb-close" title="Close"><i class="fas fa-times rf-wc-icon"></i></button>
        <button class="rf-wc-btn rf-wc-min"   id="rf-tb-min"   title="Minimize"><i class="fas fa-minus rf-wc-icon"></i></button>
        <button class="rf-wc-btn rf-wc-max"   id="rf-tb-max"   title="Maximize"><i class="far fa-square rf-wc-icon"></i></button>
      </div>
    </div>
  </div><!-- /rf-editor-topbar -->

  <!-- ══ EDITOR BODY WRAP START ══ -->
  <div id="rf-editor-body">

  <!-- Backend Offline Banner -->
  <div id="rf-backend-banner">
    <i class="fas fa-exclamation-triangle"></i>
    Backend offline &#8212; AI features unavailable. Start the Flask server to reconnect.
  </div>

  <!-- \u2500\u2500\u2500 Custom Title Bar'''

content = replace_once(content, OLD1, NEW1, 'Top bar + editor body wrap injected')

# ═══════════════════════════════════════════════════════
# STEP 2: Replace old panel-tabs with new rf-sidebar-tabs
# ═══════════════════════════════════════════════════════
OLD2 = '''    <div id="left-panel" class="panel">
      <div class="panel-tabs">
        <button class="panel-tab active" data-panel="face">
          <i class="fas fa-head-side"></i> Face
        </button>
        <button class="panel-tab" data-panel="hair">
          <i class="fas fa-cut"></i> Hair
        </button>
        <button class="panel-tab" data-panel="appearance">
          <i class="fas fa-palette"></i> Look
        </button>
        <button class="panel-tab" data-panel="ai">
          <i class="fas fa-robot"></i> AI
        </button>
        <button class="panel-tab" data-panel="snapshots">
          <i class="fas fa-camera-retro"></i> Snaps
        </button>
        <button class="panel-tab" data-panel="case">
          <i class="fas fa-folder-open"></i> Case
        </button>
      </div>'''

NEW2 = '''    <div id="left-panel" class="panel">
      <!-- NEW: rf-sidebar-tabs (proxies old panel-tabs for JS via EditorLayout.js) -->
      <div class="rf-sidebar-tabs" id="rf-sidebar-tabs">
        <button class="rf-sidebar-tab active" data-rf-tab="face" title="Face Morphs"><i class="fas fa-head-side"></i><span>Face</span></button>
        <button class="rf-sidebar-tab" data-rf-tab="hair" title="Hair &amp; Beard"><i class="fas fa-cut"></i><span>Hair</span></button>
        <button class="rf-sidebar-tab" data-rf-tab="appearance" title="Eyes &amp; Skin"><i class="fas fa-palette"></i><span>Look</span></button>
        <button class="rf-sidebar-tab" data-rf-tab="ai" title="AI Chat"><i class="fas fa-robot"></i><span>AI</span></button>
        <button class="rf-sidebar-tab" data-rf-tab="snapshots" title="Snapshots"><i class="fas fa-camera-retro"></i><span>Snaps</span></button>
        <button class="rf-sidebar-tab" data-rf-tab="case" title="Case Info"><i class="fas fa-folder-open"></i><span>Case</span></button>
      </div>
      <!-- OLD panel-tabs: hidden but kept for UIController.js querySelector bindings -->
      <div class="panel-tabs" style="display:none !important; visibility:hidden !important; pointer-events:none !important;">
        <button class="panel-tab active" data-panel="face">
          <i class="fas fa-head-side"></i> Face
        </button>
        <button class="panel-tab" data-panel="hair">
          <i class="fas fa-cut"></i> Hair
        </button>
        <button class="panel-tab" data-panel="appearance">
          <i class="fas fa-palette"></i> Look
        </button>
        <button class="panel-tab" data-panel="ai">
          <i class="fas fa-robot"></i> AI
        </button>
        <button class="panel-tab" data-panel="snapshots">
          <i class="fas fa-camera-retro"></i> Snaps
        </button>
        <button class="panel-tab" data-panel="case">
          <i class="fas fa-folder-open"></i> Case
        </button>
      </div>'''

content = replace_once(content, OLD2, NEW2, 'Sidebar tabs injected, old panel-tabs hidden')

# ═══════════════════════════════════════════════════════
# STEP 3: Add pinned Reset All bar to face panel
# ═══════════════════════════════════════════════════════
OLD3 = '''      <!-- Face Morphing Panel -->
      <div class="panel-content active" id="panel-face">
        <div class="panel-scroll">'''

NEW3 = '''      <!-- Face Morphing Panel -->
      <div class="panel-content active" id="panel-face">
        <!-- Pinned Reset All bar -->
        <div class="rf-panel-pinned-bar">
          <span class="rf-pinned-title">Face Morphs</span>
          <button class="rf-panel-reset-all" id="rf-face-reset-all" title="Reset all face morphs to neutral">
            <i class="fas fa-undo"></i> Reset All
          </button>
        </div>
        <div class="panel-scroll">'''

content = replace_once(content, OLD3, NEW3, 'Face panel pinned bar added')

# ═══════════════════════════════════════════════════════
# STEP 4: Inject viewport overlays inside #viewport
# ═══════════════════════════════════════════════════════
OLD4 = '''    <!-- 3D Viewport -->
    <div id="viewport">
      <canvas id="viewport-canvas"></canvas>
      
      <!-- Viewport overlays -->
      <div class="viewport-info" id="viewportInfo">
        <span id="viewAngle">Front</span>
        <span id="polyCount">Vertices: 0</span>
      </div>
      
      <div class="viewport-axes" id="viewportAxes">
        <div class="axis-label axis-x">X</div>
        <div class="axis-label axis-y">Y</div>
        <div class="axis-label axis-z">Z</div>
      </div>

      <!-- Loading overlay -->
      <div class="loading-overlay" id="loadingOverlay" style="display: none;">
        <div class="loading-spinner"></div>
        <p class="loading-text" id="loadingText">Processing...</p>
      </div>
    </div>'''

NEW4 = '''    <!-- 3D Viewport -->
    <div id="viewport">
      <canvas id="viewport-canvas"></canvas>

      <!-- Subtle edge vignette -->
      <div class="rf-viewport-vignette" aria-hidden="true"></div>

      <!-- Floating toolbar (top center) -->
      <div id="rf-viewport-toolbar">
        <!-- View presets -->
        <button class="rf-vp-btn active" id="rf-vp-front" title="Front View (1)"><i class="fas fa-portrait"></i> Front</button>
        <button class="rf-vp-btn" id="rf-vp-side" title="Side View (3)"><i class="fas fa-user"></i> Side</button>
        <button class="rf-vp-btn" id="rf-vp-34" title="3/4 View (5)"><i class="fas fa-street-view"></i> 3/4</button>
        <button class="rf-vp-btn" id="rf-vp-top" title="Top View (7)"><i class="fas fa-arrow-down"></i> Top</button>
        <div class="rf-vp-sep"></div>
        <!-- Lighting -->
        <select class="rf-vp-select" id="rf-vp-lighting" title="Cycle Lighting">
          <option value="0">Studio</option>
          <option value="1">Warm</option>
          <option value="2">Cool</option>
          <option value="3">Dramatic</option>
        </select>
        <div class="rf-vp-sep"></div>
        <!-- Wireframe -->
        <button class="rf-vp-toggle" id="rf-vp-wireframe" title="Toggle Wireframe"><i class="fas fa-border-all"></i> Wire</button>
        <div class="rf-vp-sep"></div>
        <!-- Mode buttons -->
        <button class="rf-mode-btn" id="rf-mode-point" title="Point Edit Mode"><i class="fas fa-hand-pointer"></i> Point Edit</button>
        <button class="rf-mode-btn" id="rf-mode-skin" title="Skin Mark Mode"><i class="fas fa-circle"></i> Marks</button>
        <button class="rf-mode-btn" id="rf-mode-decal" title="Decal Mode"><i class="fas fa-stamp"></i> Decal</button>
        <button class="rf-mode-btn" id="rf-mode-head" title="Head Tracking Toggle"><i class="fas fa-video"></i> Track</button>
      </div>

      <!-- Mode indicator badge (top right) -->
      <div id="rf-mode-badge">VIEW</div>

      <!-- Bottom-right action buttons -->
      <div id="rf-viewport-actions">
        <div class="rf-vp-action-row">
          <button class="rf-vp-action-btn" id="rf-vp-undo" title="Undo (Ctrl+Z)"><i class="fas fa-undo"></i> Undo</button>
          <button class="rf-vp-action-btn" id="rf-vp-redo" title="Redo (Ctrl+Y)"><i class="fas fa-redo"></i> Redo</button>
          <button class="rf-vp-action-btn rf-vp-screenshot" id="rf-vp-screenshot-btn" title="Take Screenshot"><i class="fas fa-camera"></i> Screenshot</button>
          <button class="rf-vp-action-btn" id="rf-vp-reset-all" title="Reset All Features"><i class="fas fa-eraser"></i> Reset All</button>
        </div>
      </div>

      <!-- Bottom-left stats strip -->
      <div id="rf-viewport-info-strip">
        <span><i class="fas fa-th"></i> <span id="rf-poly-count">Poly: 0</span></span>
        <span><i class="fas fa-dot-circle"></i> <span id="rf-vert-count">Vert: 0</span></span>
        <span><i class="fas fa-tachometer-alt"></i> <span id="rf-fps-count">FPS: --</span></span>
      </div>

      <!-- Legacy viewport overlays (hidden but IDs preserved for JS) -->
      <div class="viewport-info" id="viewportInfo" style="display:none !important;">
        <span id="viewAngle">Front</span>
        <span id="polyCount">Vertices: 0</span>
      </div>
      
      <div class="viewport-axes" id="viewportAxes">
        <div class="axis-label axis-x">X</div>
        <div class="axis-label axis-y">Y</div>
        <div class="axis-label axis-z">Z</div>
      </div>

      <!-- Loading overlay -->
      <div class="loading-overlay" id="loadingOverlay" style="display: none;">
        <div class="loading-spinner"></div>
        <p class="loading-text" id="loadingText">Processing...</p>
      </div>
    </div>'''

content = replace_once(content, OLD4, NEW4, 'Viewport overlays injected')

# ═══════════════════════════════════════════════════════
# STEP 5: Replace old statusbar + close rf-editor-body
# ═══════════════════════════════════════════════════════
OLD5 = '''  <!-- Status Bar -->
  <div id="statusbar">
    <div class="status-left">
      <span class="status-item">
        <i class="fas fa-cube"></i>
        <span id="statusMeshInfo">Ready</span>
      </span>
    </div>
    <div class="status-right">
      <span class="status-item" id="statusBackend">
        <span class="status-dot-small"></span> Backend: Connecting...
      </span>
      <span class="status-item" id="statusBlender">
        <i class="fas fa-blender"></i> Blender: Checking...
      </span>
      <span class="status-item">
        <i class="fas fa-database"></i> REface ID v1.0
      </span>
    </div>
  </div>

    </div><!-- /rf-screen-editor -->'''

NEW5 = '''  <!-- Legacy status bar: hidden, IDs kept for JS -->
  <div id="statusbar" style="display:none !important; visibility:hidden !important;">
    <div class="status-left">
      <span class="status-item">
        <i class="fas fa-cube"></i>
        <span id="statusMeshInfo">Ready</span>
      </span>
    </div>
    <div class="status-right">
      <span class="status-item" id="statusBackend">
        <span class="status-dot-small"></span> Backend: Connecting...
      </span>
      <span class="status-item" id="statusBlender">
        <i class="fas fa-blender"></i> Blender: Checking...
      </span>
      <span class="status-item">
        <i class="fas fa-database"></i> REface ID v1.0
      </span>
    </div>
  </div>

  </div><!-- /rf-editor-body -->

  <!-- New bottom status bar -->
  <div id="rf-editor-statusbar">
    <div class="rf-statusbar-left">
      <span class="rf-statusbar-item">
        <i class="fas fa-cube"></i>
        <span class="rf-statusbar-val" id="rf-sb-mesh">Ready</span>
      </span>
    </div>
    <div class="rf-statusbar-center">
      <span class="rf-statusbar-item">
        <i class="fas fa-th"></i>
        <span class="rf-statusbar-val" id="rf-sb-poly">Poly: 0</span>
      </span>
      <span class="rf-statusbar-item">
        <i class="fas fa-crosshairs"></i>
        <span class="rf-statusbar-mode" id="rf-sb-mode">VIEW</span>
      </span>
      <span class="rf-statusbar-item">
        <i class="fas fa-tachometer-alt"></i>
        <span class="rf-statusbar-val" id="rf-sb-fps">FPS: --</span>
      </span>
    </div>
    <div class="rf-statusbar-right">
      <span class="rf-statusbar-item" id="rf-sb-backend">
        <span class="status-dot-small" id="rf-sb-dot"></span>
        <span id="rf-sb-backend-text">Backend: Offline</span>
      </span>
      <span class="rf-statusbar-item">
        <i class="fas fa-database"></i>
        <span>REface ID v1.0</span>
      </span>
    </div>
  </div>

  <!-- Toast notification container -->
  <div id="rf-toast-container"></div>

    </div><!-- /rf-screen-editor -->'''

content = replace_once(content, OLD5, NEW5, 'New status bar + rf-editor-body closed')

# ═══════════════════════════════════════════════════════
# STEP 6: Add AI example prompts inside aiChatMessages
# ═══════════════════════════════════════════════════════
OLD6 = '''            <div class="ai-chat-messages" id="aiChatMessages">
              <!-- Messages will be added dynamically -->
            </div>'''

NEW6 = '''            <div class="ai-chat-messages" id="aiChatMessages">
              <!-- Messages will be added dynamically -->
              <!-- Example prompts shown when chat is empty — hidden by AIController on first message -->
              <div class="rf-ai-examples" id="rf-ai-examples">
                <div class="rf-ai-examples-label">Try these examples</div>
                <button class="rf-ai-example-chip" data-prompt="Middle aged man, wide jaw, strong cheekbones, short dark hair, medium skin tone">
                  <i class="fas fa-user"></i> Middle aged man, wide jaw, short dark hair
                </button>
                <button class="rf-ai-example-chip" data-prompt="Young woman, oval face, high cheekbones, large almond eyes, light skin">
                  <i class="fas fa-user"></i> Young woman, oval face, high cheekbones
                </button>
                <button class="rf-ai-example-chip" data-prompt="Add crow's feet wrinkles and a small scar on the left cheek">
                  <i class="fas fa-pen"></i> Add crow's feet and a scar on left cheek
                </button>
                <button class="rf-ai-example-chip" data-prompt="Wider nose bridge, thinner lips, and closer set eyes">
                  <i class="fas fa-sliders-h"></i> Wider nose, thinner lips, closer eyes
                </button>
              </div>
            </div>'''

content = replace_once(content, OLD6, NEW6, 'AI example prompts added')

# ═══════════════════════════════════════════════════════
# Write result
# ═══════════════════════════════════════════════════════
with open(HTML_FILE, 'w', encoding='utf-8') as f:
    f.write(content)

print(f'\nResult: {steps_ok} steps OK, {steps_fail} steps FAILED')
if steps_fail == 0:
    print('All steps complete. Editor HTML restructured successfully.')
