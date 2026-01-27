import React from 'react';
import './RegionSelector.css';

/**
 * Visual face region selector component
 */
function RegionSelector({ selectedRegion, onSelectRegion, onClearSelection }) {
  const regions = [
    { id: 'forehead', name: 'Forehead', x: 50, y: 12 },
    { id: 'leftEye', name: 'Left Eye', x: 30, y: 30 },
    { id: 'rightEye', name: 'Right Eye', x: 70, y: 30 },
    { id: 'nose', name: 'Nose', x: 50, y: 48 },
    { id: 'leftCheek', name: 'Left Cheek', x: 22, y: 50 },
    { id: 'rightCheek', name: 'Right Cheek', x: 78, y: 50 },
    { id: 'mouth', name: 'Mouth', x: 50, y: 70 },
    { id: 'chin', name: 'Chin', x: 50, y: 88 },
    { id: 'leftJaw', name: 'Left Jaw', x: 20, y: 75 },
    { id: 'rightJaw', name: 'Right Jaw', x: 80, y: 75 }
  ];

  return (
    <div className="region-selector">
      <div className="region-face-diagram">
        {/* Face outline SVG */}
        <svg viewBox="0 0 100 100" className="face-outline">
          {/* Face shape */}
          <ellipse cx="50" cy="50" rx="40" ry="48" fill="none" stroke="var(--border-color)" strokeWidth="1.5"/>
          
          {/* Hair line */}
          <path d="M15 35 Q50 5 85 35" fill="none" stroke="var(--border-color)" strokeWidth="1"/>
          
          {/* Eyes */}
          <ellipse cx="35" cy="35" rx="8" ry="4" fill="none" stroke="var(--text-muted)" strokeWidth="0.5"/>
          <ellipse cx="65" cy="35" rx="8" ry="4" fill="none" stroke="var(--text-muted)" strokeWidth="0.5"/>
          
          {/* Nose */}
          <path d="M50 38 L50 55 L45 60 L55 60 L50 55" fill="none" stroke="var(--text-muted)" strokeWidth="0.5"/>
          
          {/* Mouth */}
          <path d="M38 72 Q50 78 62 72" fill="none" stroke="var(--text-muted)" strokeWidth="0.5"/>
          
          {/* Jaw line */}
          <path d="M15 50 Q10 75 50 95 Q90 75 85 50" fill="none" stroke="var(--border-color)" strokeWidth="0.5" strokeDasharray="2"/>
        </svg>
        
        {/* Region hotspots */}
        {regions.map(region => (
          <button
            key={region.id}
            className={`region-hotspot ${selectedRegion === region.id ? 'selected' : ''}`}
            style={{ left: `${region.x}%`, top: `${region.y}%` }}
            onClick={() => onSelectRegion(region.id)}
            title={region.name}
          >
            <span className="hotspot-pulse"></span>
          </button>
        ))}
      </div>
      
      <div className="region-list">
        {regions.map(region => (
          <button
            key={region.id}
            className={`region-button ${selectedRegion === region.id ? 'selected' : ''}`}
            onClick={() => onSelectRegion(region.id)}
          >
            {region.name}
          </button>
        ))}
      </div>
      
      {selectedRegion && (
        <button className="clear-selection-btn" onClick={onClearSelection}>
          Clear Selection
        </button>
      )}
    </div>
  );
}

export default RegionSelector;
