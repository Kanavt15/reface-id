import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

with open('src/renderer/index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Find rf-viewport-toolbar
idx = content.find('rf-viewport-toolbar')
print('rf-viewport-toolbar at:', idx)
if idx >= 0:
    print('Context:', repr(content[idx-10:idx+500]))

# Also find rf-vp-front
idx2 = content.find('rf-vp-front')
print('rf-vp-front at:', idx2)

# Find btnFaceCapture in viewport toolbar
idx3 = content.find('rf-mode-head')
print('rf-mode-head at:', idx3)
if idx3 >= 0:
    print('Context:', repr(content[idx3-5:idx3+150]))
