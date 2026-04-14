import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HTML_FILE = 'src/renderer/index.html'
with open(HTML_FILE, 'r', encoding='utf-8') as f:
    content = f.read()

# Check state
print('rf-editor-topbar present:', 'rf-editor-topbar' in content)
print('rf-editor-body present:', 'rf-editor-body' in content)

if 'rf-editor-topbar' in content:
    print('Already done, skipping injection.')
else:
    # The file uses \r\n line endings
    # Inject top bar right after the rf-screen-editor opening div
    # Find the exact character position just before the Custom Title Bar comment
    
    # The structure is:
    # <div id="rf-screen-editor" ...>\r\n\r\n  <!-- \u2500\u2500\u2500 Custom Title Bar...
    # We want to inject BEFORE the Custom Title Bar comment
    
    ANCHOR = '  <div id="titlebar">'
    idx = content.find(ANCHOR)
    if idx == -1:
        print('FAIL: Cannot find titlebar anchor')
    else:
        print(f'Titlebar anchor found at {idx}')
        
        INJECTION = '''  <!-- ====== NEW TOP BAR ====== -->
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

'''
        
        content = content[:idx] + INJECTION + content[idx:]
        print('[OK] Top bar injected')

with open(HTML_FILE, 'w', encoding='utf-8') as f:
    f.write(content)

print('Done.')
