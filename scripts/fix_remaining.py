import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HTML_FILE = 'src/renderer/index.html'
with open(HTML_FILE, 'r', encoding='utf-8') as f:
    content = f.read()

# We need to add btnFaceCapture proxy right after the Track button, before closing </div>
OLD = ' id="rf-mode-head" title="Head Tracking Toggle"><i class="fas fa-video"></i> Track</button>\n      </div>\n\n      <!-- Mode indicator badge (top right) -->'

NEW = ' id="rf-mode-head" title="Head Tracking Toggle"><i class="fas fa-video"></i> Track</button>\n        <div class="rf-vp-sep"></div>\n        <button class="rf-mode-btn" id="rf-mode-face-capture" title="Multi-Angle Face Capture (front, left, right for AI reconstruction)"><i class="fas fa-id-badge"></i> Face Capture</button>\n      </div>\n\n      <!-- Mode indicator badge (top right) -->'

if OLD in content:
    content = content.replace(OLD, NEW, 1)
    print('[OK] Face Capture button added to viewport toolbar')
else:
    print('[FAIL] Could not find insertion point')
    # Debug: show what's around rf-mode-head
    idx = content.find('rf-mode-head')
    print('Context:', repr(content[idx-5:idx+200]))

with open(HTML_FILE, 'w', encoding='utf-8') as f:
    f.write(content)

print('Done.')
