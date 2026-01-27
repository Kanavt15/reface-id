const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Use ANGLE for better GPU compatibility on Windows
app.commandLine.appendSwitch('use-angle', 'gl');
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow;
let splashWindow;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

/**
 * Create the splash screen window
 */
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 500,
    height: 350,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  splashWindow.loadFile(path.join(__dirname, '../renderer/splash.html'));
}

/**
 * Create the main application window
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    show: false,
    icon: path.join(__dirname, '../../public/icons/icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
      webSecurity: true
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a2e',
      symbolColor: '#ffffff',
      height: 40
    }
  });

  // Create application menu
  const menuTemplate = createMenuTemplate();
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  // Load the app - always load from built files
  mainWindow.loadFile(path.join(__dirname, '../../public/index.html'));
  
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.once('ready-to-show', () => {
    if (splashWindow) {
      splashWindow.destroy();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Create application menu template
 */
function createMenuTemplate() {
  return [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Case',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('menu-new-case')
        },
        {
          label: 'Open Case',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send('menu-open-case')
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('menu-save')
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow.webContents.send('menu-save-as')
        },
        { type: 'separator' },
        {
          label: 'Import Skull Scan',
          click: () => handleImportFile('skull')
        },
        {
          label: 'Import Reference Image',
          click: () => handleImportFile('image')
        },
        {
          label: 'Import 3D Mesh',
          click: () => handleImportFile('mesh')
        },
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            {
              label: 'Export as GLTF',
              click: () => mainWindow.webContents.send('menu-export', 'gltf')
            },
            {
              label: 'Export as GLB',
              click: () => mainWindow.webContents.send('menu-export', 'glb')
            },
            {
              label: 'Export as OBJ',
              click: () => mainWindow.webContents.send('menu-export', 'obj')
            },
            { type: 'separator' },
            {
              label: 'Export High-Res Render',
              click: () => mainWindow.webContents.send('menu-export-render')
            },
            {
              label: 'Export Comparison View',
              click: () => mainWindow.webContents.send('menu-export-comparison')
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: 'Alt+F4',
          click: () => app.quit()
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => mainWindow.webContents.send('menu-undo')
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Y',
          click: () => mainWindow.webContents.send('menu-redo')
        },
        { type: 'separator' },
        {
          label: 'Reset to Initial',
          click: () => mainWindow.webContents.send('menu-reset')
        },
        {
          label: 'Clear All Modifications',
          click: () => mainWindow.webContents.send('menu-clear-modifications')
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Shaded View',
          accelerator: 'F1',
          click: () => mainWindow.webContents.send('menu-view-mode', 'shaded')
        },
        {
          label: 'Wireframe View',
          accelerator: 'F2',
          click: () => mainWindow.webContents.send('menu-view-mode', 'wireframe')
        },
        {
          label: 'Shaded + Wireframe',
          accelerator: 'F3',
          click: () => mainWindow.webContents.send('menu-view-mode', 'both')
        },
        { type: 'separator' },
        {
          label: 'Show Skull Overlay',
          type: 'checkbox',
          checked: false,
          click: (menuItem) => mainWindow.webContents.send('menu-skull-overlay', menuItem.checked)
        },
        {
          label: 'Show Landmarks',
          type: 'checkbox',
          checked: true,
          click: (menuItem) => mainWindow.webContents.send('menu-landmarks', menuItem.checked)
        },
        { type: 'separator' },
        {
          label: 'Front View',
          accelerator: 'Numpad1',
          click: () => mainWindow.webContents.send('menu-camera-view', 'front')
        },
        {
          label: 'Side View (Left)',
          accelerator: 'Numpad3',
          click: () => mainWindow.webContents.send('menu-camera-view', 'left')
        },
        {
          label: 'Side View (Right)',
          accelerator: 'Numpad9',
          click: () => mainWindow.webContents.send('menu-camera-view', 'right')
        },
        {
          label: 'Top View',
          accelerator: 'Numpad7',
          click: () => mainWindow.webContents.send('menu-camera-view', 'top')
        },
        { type: 'separator' },
        {
          label: 'Toggle Fullscreen',
          accelerator: 'F11',
          click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen())
        }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Select Tool',
          accelerator: 'S',
          click: () => mainWindow.webContents.send('menu-tool', 'select')
        },
        {
          label: 'Move Tool',
          accelerator: 'G',
          click: () => mainWindow.webContents.send('menu-tool', 'move')
        },
        {
          label: 'Scale Tool',
          accelerator: 'R',
          click: () => mainWindow.webContents.send('menu-tool', 'scale')
        },
        {
          label: 'Sculpt Tool',
          accelerator: 'B',
          click: () => mainWindow.webContents.send('menu-tool', 'sculpt')
        },
        { type: 'separator' },
        {
          label: 'Symmetry Mode',
          type: 'checkbox',
          checked: true,
          click: (menuItem) => mainWindow.webContents.send('menu-symmetry', menuItem.checked)
        }
      ]
    },
    {
      label: 'Case',
      submenu: [
        {
          label: 'Case Details',
          click: () => mainWindow.webContents.send('menu-case-details')
        },
        {
          label: 'Version History',
          click: () => mainWindow.webContents.send('menu-version-history')
        },
        {
          label: 'Audit Log',
          click: () => mainWindow.webContents.send('menu-audit-log')
        },
        { type: 'separator' },
        {
          label: 'Generate Report',
          click: () => mainWindow.webContents.send('menu-generate-report')
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'User Guide',
          click: () => mainWindow.webContents.send('menu-help')
        },
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => mainWindow.webContents.send('menu-shortcuts')
        },
        { type: 'separator' },
        {
          label: 'About REface',
          click: () => showAboutDialog()
        }
      ]
    }
  ];
}

/**
 * Handle file import dialogs
 */
async function handleImportFile(type) {
  const filters = {
    skull: [
      { name: '3D Scans', extensions: ['stl', 'obj', 'ply', 'glb', 'gltf'] }
    ],
    image: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tiff'] }
    ],
    mesh: [
      { name: '3D Models', extensions: ['glb', 'gltf', 'obj', 'fbx'] }
    ]
  };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Import ${type.charAt(0).toUpperCase() + type.slice(1)}`,
    filters: filters[type],
    properties: ['openFile']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('file-imported', {
      type,
      filePath: result.filePaths[0]
    });
  }
}

/**
 * Show about dialog
 */
function showAboutDialog() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About REface',
    message: 'REface Forensic Reconstruction',
    detail: `Version 1.0.0\n\nForensic Facial Approximation Tool\n\n⚠️ DISCLAIMER: This software produces forensic facial approximations for investigative purposes only. Results are not suitable for identification verification.\n\n© 2024 Forensic Tech Solutions`
  });
}

// IPC Handlers
ipcMain.handle('dialog:openFile', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

ipcMain.handle('dialog:saveFile', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

ipcMain.handle('fs:readFile', async (event, filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    return { success: true, data: data.toString('base64') };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('fs:writeFile', async (event, filePath, data) => {
  try {
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(filePath, buffer);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('app:getPath', (event, name) => {
  return app.getPath(name);
});

// App lifecycle
app.whenReady().then(() => {
  createSplashWindow();
  
  // Simulate loading time for splash screen
  setTimeout(() => {
    createMainWindow();
  }, 2000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
});
