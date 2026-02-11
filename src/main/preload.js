const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  // Dialogs
  saveDialog: (options) => ipcRenderer.invoke('dialog:save', options),
  openDialog: (options) => ipcRenderer.invoke('dialog:open', options),

  // Menu events
  onNewCase: (callback) => ipcRenderer.on('menu:new-case', callback),
  onOpenCase: (callback) => ipcRenderer.on('menu:open-case', (_, path) => callback(path)),
  onSaveCase: (callback) => ipcRenderer.on('menu:save-case', callback),
  onExport: (callback) => ipcRenderer.on('menu:export', (_, format) => callback(format)),
  onScreenshot: (callback) => ipcRenderer.on('menu:screenshot', callback),
});
