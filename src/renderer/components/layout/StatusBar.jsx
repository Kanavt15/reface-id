import React from 'react';
import { useAppStore } from '../../stores/appStore';
import { useMeshStore } from '../../stores/meshStore';
import './StatusBar.css';

/**
 * Application status bar at the bottom
 */
function StatusBar() {
  const { currentCase, viewMode, activeTool, symmetryMode } = useAppStore();
  const { mesh, selectedVertices, historyIndex, history } = useMeshStore();

  const vertexCount = mesh?.geometry?.attributes?.position?.count || 0;
  const faceCount = mesh?.geometry?.index ? mesh.geometry.index.count / 3 : vertexCount / 3;

  return (
    <footer className="status-bar">
      <div className="status-left">
        <div className="status-item">
          <span className="status-label">Status:</span>
          <span className="status-value status-ready">Ready</span>
        </div>
        
        {currentCase && (
          <div className="status-item">
            <span className="status-label">Case:</span>
            <span className="status-value">{currentCase.caseNumber}</span>
          </div>
        )}
      </div>

      <div className="status-center">
        <div className="status-item">
          <span className="status-label">Vertices:</span>
          <span className="status-value">{vertexCount.toLocaleString()}</span>
        </div>
        
        <div className="status-item">
          <span className="status-label">Faces:</span>
          <span className="status-value">{Math.floor(faceCount).toLocaleString()}</span>
        </div>
        
        {selectedVertices.length > 0 && (
          <div className="status-item">
            <span className="status-label">Selected:</span>
            <span className="status-value status-highlight">{selectedVertices.length}</span>
          </div>
        )}
      </div>

      <div className="status-right">
        <div className="status-item">
          <span className="status-label">Tool:</span>
          <span className="status-value">{activeTool}</span>
        </div>
        
        <div className="status-item">
          <span className="status-label">View:</span>
          <span className="status-value">{viewMode}</span>
        </div>
        
        <div className="status-item">
          <span className={`status-indicator ${symmetryMode ? 'active' : ''}`}>
            SYM
          </span>
        </div>
        
        <div className="status-item">
          <span className="status-label">History:</span>
          <span className="status-value">{historyIndex + 1}/{history.length}</span>
        </div>
      </div>
    </footer>
  );
}

export default StatusBar;
