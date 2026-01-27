import React, { useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Viewport3D from '../viewport/Viewport3D';
import { useAppStore } from '../../stores/appStore';
import { useMeshStore } from '../../stores/meshStore';
import './ReconstructionView.css';

/**
 * Main reconstruction workspace with 3D viewport
 */
function ReconstructionView() {
  const { caseId } = useParams();
  const viewportRef = useRef(null);
  const [meshControls, setMeshControls] = useState(null);
  
  const { currentCase, setCurrentCase, setMeshControls: setGlobalMeshControls } = useAppStore();
  const { parameters } = useMeshStore();

  // Set current case on mount
  React.useEffect(() => {
    if (caseId && caseId !== 'new') {
      // Load case data from backend
      setCurrentCase({
        id: caseId,
        caseNumber: caseId,
        name: 'Reconstruction Case',
        createdAt: new Date().toISOString()
      });
    } else {
      setCurrentCase({
        id: 'new',
        caseNumber: 'NEW-CASE',
        name: 'New Reconstruction',
        createdAt: new Date().toISOString()
      });
    }
  }, [caseId, setCurrentCase]);

  const handleMeshLoaded = useCallback((controls) => {
    setMeshControls(controls);
    setGlobalMeshControls(controls);  // Store in global state for RightSidebar access
  }, [setGlobalMeshControls]);

  const handleImportMesh = () => {
    // Create file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.glb,.gltf,.obj';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file && meshControls?.loadMeshFile) {
        meshControls.loadMeshFile(file);
      }
    };
    input.click();
  };

  const handleExportGLB = () => {
    if (meshControls?.exportMesh) {
      meshControls.exportMesh('glb');
    }
  };

  const handleExportGLTF = () => {
    if (meshControls?.exportMesh) {
      meshControls.exportMesh('gltf');
    }
  };

  const handleScreenshot = () => {
    if (meshControls?.captureScreenshot) {
      meshControls.captureScreenshot();
    }
  };

  return (
    <div className="reconstruction-view">
      <div className="reconstruction-toolbar">
        <div className="toolbar-group">
          <button className="toolbar-btn" onClick={handleImportMesh}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="17 8 12 3 7 8"></polyline>
              <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
            Import Mesh
          </button>
          
          <div className="toolbar-divider"></div>
          
          <button className="toolbar-btn" onClick={handleExportGLB}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Export GLB
          </button>
          
          <button className="toolbar-btn" onClick={handleExportGLTF}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Export GLTF
          </button>
          
          <div className="toolbar-divider"></div>
          
          <button className="toolbar-btn" onClick={handleScreenshot}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <circle cx="8.5" cy="8.5" r="1.5"></circle>
              <polyline points="21 15 16 10 5 21"></polyline>
            </svg>
            Screenshot
          </button>
        </div>
        
        <div className="toolbar-info">
          <span className="case-indicator">
            Case: <strong>{currentCase?.caseNumber || 'N/A'}</strong>
          </span>
        </div>
      </div>
      
      <div className="reconstruction-content">
        <Viewport3D ref={viewportRef} onMeshLoaded={handleMeshLoaded} />
      </div>
    </div>
  );
}

export default ReconstructionView;
