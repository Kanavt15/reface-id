const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let pythonProcess;

// Start Python/Blender backend
function startBackend() {
  const backendPath = path.join(__dirname, '..', '..', 'backend', 'server.py');
  pythonProcess = spawn('python', [backendPath], {
    cwd: path.join(__dirname, '..', '..', 'backend')
  });

  pythonProcess.stdout.on('data', (data) => {
    console.log(`[Backend] ${data}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`[Backend Error] ${data}`);
  });

  pythonProcess.on('close', (code) => {
    console.log(`[Backend] Process exited with code ${code}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    title: 'REface ID — 3D Forensic Facial Reconstruction',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    frame: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open DevTools in development
  mainWindow.webContents.openDevTools();

  // Build application menu
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Case',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('menu:new-case')
        },
        {
          label: 'Open Case',
          accelerator: 'CmdOrCtrl+O',
          click: () => handleOpenCase()
        },
        {
          label: 'Save Case',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('menu:save-case')
        },
        { type: 'separator' },
        {
          label: 'Export 3D Model',
          submenu: [
            { label: 'Export as OBJ', click: () => mainWindow.webContents.send('menu:export', 'obj') },
            { label: 'Export as FBX', click: () => mainWindow.webContents.send('menu:export', 'fbx') },
            { label: 'Export as GLB', click: () => mainWindow.webContents.send('menu:export', 'glb') }
          ]
        },
        {
          label: 'Export Screenshot',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow.webContents.send('menu:screenshot')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

async function handleOpenCase() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Case File',
    filters: [{ name: 'REface Case', extensions: ['rfc'] }],
    properties: ['openFile']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('menu:open-case', result.filePaths[0]);
  }
}

// IPC Handlers
ipcMain.handle('dialog:save', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result;
});

ipcMain.handle('file:save-buffer', async (event, filePath, base64Data) => {
  const fs = require('fs');
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filePath, buffer);
});

ipcMain.handle('dialog:open', async (event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, options);
  return result;
});

ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.handle('window:close', () => mainWindow.close());

// App lifecycle
app.whenReady().then(async () => {
  startBackend();
  createWindow();
});

app.on('window-all-closed', () => {
  if (pythonProcess) pythonProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
