const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script for secure IPC communication
 * Exposes limited API to renderer process
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
  saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, data) => ipcRenderer.invoke('fs:writeFile', filePath, data),
  
  // App paths
  getPath: (name) => ipcRenderer.invoke('app:getPath', name),
  
  // Menu events
  onMenuNewCase: (callback) => ipcRenderer.on('menu-new-case', callback),
  onMenuOpenCase: (callback) => ipcRenderer.on('menu-open-case', callback),
  onMenuSave: (callback) => ipcRenderer.on('menu-save', callback),
  onMenuSaveAs: (callback) => ipcRenderer.on('menu-save-as', callback),
  onMenuExport: (callback) => ipcRenderer.on('menu-export', (event, format) => callback(format)),
  onMenuExportRender: (callback) => ipcRenderer.on('menu-export-render', callback),
  onMenuExportComparison: (callback) => ipcRenderer.on('menu-export-comparison', callback),
  
  // Edit events
  onMenuUndo: (callback) => ipcRenderer.on('menu-undo', callback),
  onMenuRedo: (callback) => ipcRenderer.on('menu-redo', callback),
  onMenuReset: (callback) => ipcRenderer.on('menu-reset', callback),
  onMenuClearModifications: (callback) => ipcRenderer.on('menu-clear-modifications', callback),
  
  // View events
  onMenuViewMode: (callback) => ipcRenderer.on('menu-view-mode', (event, mode) => callback(mode)),
  onMenuSkullOverlay: (callback) => ipcRenderer.on('menu-skull-overlay', (event, show) => callback(show)),
  onMenuLandmarks: (callback) => ipcRenderer.on('menu-landmarks', (event, show) => callback(show)),
  onMenuCameraView: (callback) => ipcRenderer.on('menu-camera-view', (event, view) => callback(view)),
  
  // Tool events
  onMenuTool: (callback) => ipcRenderer.on('menu-tool', (event, tool) => callback(tool)),
  onMenuSymmetry: (callback) => ipcRenderer.on('menu-symmetry', (event, enabled) => callback(enabled)),
  
  // Case events
  onMenuCaseDetails: (callback) => ipcRenderer.on('menu-case-details', callback),
  onMenuVersionHistory: (callback) => ipcRenderer.on('menu-version-history', callback),
  onMenuAuditLog: (callback) => ipcRenderer.on('menu-audit-log', callback),
  onMenuGenerateReport: (callback) => ipcRenderer.on('menu-generate-report', callback),
  
  // File import events
  onFileImported: (callback) => ipcRenderer.on('file-imported', (event, data) => callback(data)),
  
  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
