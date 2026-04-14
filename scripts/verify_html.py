import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

with open('src/renderer/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

checks = [
    ('editor-layout.css', 'CSS file linked'),
    ('rf-editor-topbar', 'New top bar'),
    ('rf-topbar-save', 'Save button'),
    ('rf-topbar-status-dot', 'Status dot'),
    ('rf-editor-body', 'Editor body wrapper'),
    ('rf-backend-banner', 'Backend banner'),
    ('rf-sidebar-tabs', 'New sidebar tabs'),
    ('rf-sidebar-tab', 'Sidebar tab buttons'),
    ('panel-tabs', 'Old panel-tabs (kept for JS)'),
    ('rf-panel-pinned-bar', 'Face panel pinned bar'),
    ('rf-viewport-toolbar', 'Viewport floating toolbar'),
    ('rf-vp-front', 'Front view button'),
    ('rf-mode-badge', 'Mode badge'),
    ('rf-viewport-actions', 'Viewport action buttons'),
    ('rf-viewport-info-strip', 'Viewport info strip'),
    ('rf-editor-statusbar', 'New status bar'),
    ('rf-toast-container', 'Toast container'),
    ('rf-ai-examples', 'AI example chips'),
    ('EditorLayout.js', 'EditorLayout script tag'),
    ('id="titlebar"', 'Original titlebar kept'),
    ('id="toolbar"', 'Original toolbar kept'),
    ('id="caseTitle"', 'Original case title kept'),
    ('id="btnClose"', 'Original close button kept'),
    ('id="statusbar"', 'Original status bar kept hidden'),
    ('id="viewport"', 'Original viewport kept'),
    ('id="aiChatMessages"', 'AI chat messages kept'),
    ('id="panel-face"', 'Face panel kept'),
    ('id="app-container"', 'App container kept'),
]

print('HTML Structure Verification:')
ok = 0
fail = 0
for marker, label in checks:
    found = marker in content
    status = 'OK' if found else 'FAIL'
    print(f'  [{status}] {label}')
    if found: ok += 1
    else: fail += 1
print(f'')
print(f'Result: {ok} OK, {fail} FAIL')
print(f'Total file length: {len(content)} chars')
