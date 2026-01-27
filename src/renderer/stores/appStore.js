import { create } from 'zustand';

/**
 * Main application store for global state management
 */
export const useAppStore = create((set, get) => ({
  // Application state
  isLoading: true,
  isInitialized: false,
  error: null,
  
  // Current case/project
  currentCase: null,
  currentMesh: null,
  meshControls: null,  // Export functions from Viewport3D
  
  // View settings
  viewMode: 'shaded', // 'shaded', 'wireframe', 'both'
  showSkullOverlay: false,
  showLandmarks: true,
  symmetryMode: true,
  
  // Active tool
  activeTool: 'select', // 'select', 'move', 'scale', 'sculpt'
  
  // Camera view
  cameraView: 'front', // 'front', 'left', 'right', 'top', 'back'
  
  // Sidebar state
  leftSidebarOpen: true,
  rightSidebarOpen: true,
  
  // Modal state
  activeModal: null,
  modalData: null,
  
  // Notifications
  notifications: [],
  
  // Initialize application
  initializeApp: async () => {
    try {
      // Simulate initialization
      await new Promise(resolve => setTimeout(resolve, 500));
      
      set({
        isLoading: false,
        isInitialized: true
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error.message
      });
    }
  },
  
  // Set current case
  setCurrentCase: (caseData) => {
    set({ currentCase: caseData });
  },
  
  // Set current mesh
  setCurrentMesh: (mesh) => {
    set({ currentMesh: mesh });
  },
  
  // Set mesh controls (export functions from Viewport3D)
  setMeshControls: (controls) => {
    set({ meshControls: controls });
  },
  
  // View settings
  setViewMode: (mode) => {
    set({ viewMode: mode });
  },
  
  setShowSkullOverlay: (show) => {
    set({ showSkullOverlay: show });
  },
  
  setShowLandmarks: (show) => {
    set({ showLandmarks: show });
  },
  
  setSymmetryMode: (enabled) => {
    set({ symmetryMode: enabled });
  },
  
  // Tool selection
  setActiveTool: (tool) => {
    set({ activeTool: tool });
  },
  
  // Camera view
  setCameraView: (view) => {
    set({ cameraView: view });
  },
  
  // Sidebar toggles
  toggleLeftSidebar: () => {
    set(state => ({ leftSidebarOpen: !state.leftSidebarOpen }));
  },
  
  toggleRightSidebar: () => {
    set(state => ({ rightSidebarOpen: !state.rightSidebarOpen }));
  },
  
  // Modal management
  openModal: (modalName, data = null) => {
    set({ activeModal: modalName, modalData: data });
  },
  
  closeModal: () => {
    set({ activeModal: null, modalData: null });
  },
  
  // Notifications
  addNotification: (notification) => {
    const id = Date.now();
    const newNotification = {
      id,
      ...notification,
      timestamp: new Date().toISOString()
    };
    
    set(state => ({
      notifications: [...state.notifications, newNotification]
    }));
    
    // Auto-remove after 5 seconds
    if (!notification.persistent) {
      setTimeout(() => {
        get().removeNotification(id);
      }, 5000);
    }
    
    return id;
  },
  
  removeNotification: (id) => {
    set(state => ({
      notifications: state.notifications.filter(n => n.id !== id)
    }));
  },
  
  clearNotifications: () => {
    set({ notifications: [] });
  }
}));
