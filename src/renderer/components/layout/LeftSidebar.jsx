import React, { useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useMeshStore } from '../../stores/meshStore';
import ParameterSlider from '../ui/ParameterSlider';
import RegionSelector from '../ui/RegionSelector';
import './LeftSidebar.css';

/**
 * Left sidebar with facial parameter controls
 */
function LeftSidebar() {
  const { activeTool, setActiveTool, symmetryMode, setSymmetryMode } = useAppStore();
  const { parameters, updateParameter, selectedRegion, selectRegion, clearSelection, reset, undo, redo, historyIndex, history } = useMeshStore();
  
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;
  
  const [expandedSections, setExpandedSections] = useState({
    tools: true,
    jaw: true,
    nose: true,
    cheeks: false,
    forehead: false,
    eyes: false,
    mouth: false,
    overall: false,
    age: false,
    hair: true
  });

  const toggleSection = (section) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const tools = [
    { id: 'select', name: 'Select', shortcut: 'S', icon: 'M3 3h18v18H3z' },
    { id: 'move', name: 'Move', shortcut: 'G', icon: 'M5 9l4-4 4 4M9 5v14M15 19l4-4-4-4M19 15H9' },
    { id: 'scale', name: 'Scale', shortcut: 'R', icon: 'M21 21l-6-6m6 6v-4.8m0 4.8h-4.8M3 16.2V21m0 0h4.8M3 21l6-6M21 7.8V3m0 0h-4.8M21 3l-6 6M3 7.8V3m0 0h4.8M3 3l6 6' },
    { id: 'sculpt', name: 'Sculpt', shortcut: 'B', icon: 'M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.586 7.586' }
  ];

  return (
    <div className="left-sidebar">
      {/* Tools Section */}
      <div className="sidebar-section">
        <div 
          className="sidebar-section-header"
          onClick={() => toggleSection('tools')}
        >
          <span className="sidebar-section-title">Tools</span>
          <svg 
            className={`sidebar-section-toggle ${expandedSections.tools ? 'expanded' : ''}`}
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        
        {expandedSections.tools && (
          <div className="sidebar-section-content expanded">
            <div className="tools-grid">
              {tools.map(tool => (
                <button
                  key={tool.id}
                  className={`tool-button ${activeTool === tool.id ? 'active' : ''}`}
                  onClick={() => setActiveTool(tool.id)}
                  title={`${tool.name} (${tool.shortcut})`}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d={tool.icon}></path>
                  </svg>
                  <span>{tool.name}</span>
                </button>
              ))}
            </div>
            
            <div className="symmetry-toggle">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={symmetryMode}
                  onChange={(e) => setSymmetryMode(e.target.checked)}
                />
                <span className="toggle-slider"></span>
                <span className="toggle-text">Symmetry Mode</span>
              </label>
            </div>
            
            <div className="action-buttons">
              <button 
                className="action-btn" 
                onClick={undo} 
                disabled={!canUndo}
                title="Undo (Ctrl+Z)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 7v6h6"></path>
                  <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>
                </svg>
                Undo
              </button>
              <button 
                className="action-btn" 
                onClick={redo} 
                disabled={!canRedo}
                title="Redo (Ctrl+Y)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 7v6h-6"></path>
                  <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"></path>
                </svg>
                Redo
              </button>
              <button 
                className="action-btn reset-btn" 
                onClick={reset}
                title="Reset to default (R)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2.5 2v6h6M21.5 22v-6h-6"/>
                  <path d="M22 11.5A10 10 0 0 0 3.2 7.2M2 12.5a10 10 0 0 0 18.8 4.2"/>
                </svg>
                Reset
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Region Selection */}
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">Facial Regions</span>
        </div>
        <div className="sidebar-section-content expanded">
          <RegionSelector 
            selectedRegion={selectedRegion}
            onSelectRegion={selectRegion}
            onClearSelection={clearSelection}
          />
        </div>
      </div>

      {/* Jaw Parameters */}
      <div className="sidebar-section">
        <div 
          className="sidebar-section-header"
          onClick={() => toggleSection('jaw')}
        >
          <span className="sidebar-section-title">Jaw & Chin</span>
          <svg 
            className={`sidebar-section-toggle ${expandedSections.jaw ? 'expanded' : ''}`}
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        
        {expandedSections.jaw && (
          <div className="sidebar-section-content expanded">
            <ParameterSlider
              label="Jaw Width"
              value={parameters.jawWidth}
              onChange={(v) => updateParameter('jawWidth', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Jaw Angle"
              value={parameters.jawAngle}
              onChange={(v) => updateParameter('jawAngle', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Jaw Length"
              value={parameters.jawLength}
              onChange={(v) => updateParameter('jawLength', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Chin Projection"
              value={parameters.chinProjection}
              onChange={(v) => updateParameter('chinProjection', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Chin Width"
              value={parameters.chinWidth}
              onChange={(v) => updateParameter('chinWidth', v)}
              min={-100}
              max={100}
            />
          </div>
        )}
      </div>

      {/* Nose Parameters */}
      <div className="sidebar-section">
        <div 
          className="sidebar-section-header"
          onClick={() => toggleSection('nose')}
        >
          <span className="sidebar-section-title">Nose</span>
          <svg 
            className={`sidebar-section-toggle ${expandedSections.nose ? 'expanded' : ''}`}
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        
        {expandedSections.nose && (
          <div className="sidebar-section-content expanded">
            <ParameterSlider
              label="Nose Length"
              value={parameters.noseLength}
              onChange={(v) => updateParameter('noseLength', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Nose Width"
              value={parameters.noseWidth}
              onChange={(v) => updateParameter('noseWidth', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Nose Projection"
              value={parameters.noseProjection}
              onChange={(v) => updateParameter('noseProjection', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Bridge Height"
              value={parameters.noseBridge}
              onChange={(v) => updateParameter('noseBridge', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Nostril Width"
              value={parameters.nostrilWidth}
              onChange={(v) => updateParameter('nostrilWidth', v)}
              min={-100}
              max={100}
            />
          </div>
        )}
      </div>

      {/* Cheeks Parameters */}
      <div className="sidebar-section">
        <div 
          className="sidebar-section-header"
          onClick={() => toggleSection('cheeks')}
        >
          <span className="sidebar-section-title">Cheekbones</span>
          <svg 
            className={`sidebar-section-toggle ${expandedSections.cheeks ? 'expanded' : ''}`}
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        
        {expandedSections.cheeks && (
          <div className="sidebar-section-content expanded">
            <ParameterSlider
              label="Cheekbone Height"
              value={parameters.cheekboneHeight}
              onChange={(v) => updateParameter('cheekboneHeight', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Cheekbone Prominence"
              value={parameters.cheekboneProminence}
              onChange={(v) => updateParameter('cheekboneProminence', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Cheek Fullness"
              value={parameters.cheekFullness}
              onChange={(v) => updateParameter('cheekFullness', v)}
              min={-100}
              max={100}
            />
          </div>
        )}
      </div>

      {/* Overall Face Parameters */}
      <div className="sidebar-section">
        <div 
          className="sidebar-section-header"
          onClick={() => toggleSection('overall')}
        >
          <span className="sidebar-section-title">Overall Face</span>
          <svg 
            className={`sidebar-section-toggle ${expandedSections.overall ? 'expanded' : ''}`}
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        
        {expandedSections.overall && (
          <div className="sidebar-section-content expanded">
            <ParameterSlider
              label="Face Width"
              value={parameters.faceWidth}
              onChange={(v) => updateParameter('faceWidth', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Face Length"
              value={parameters.faceLength}
              onChange={(v) => updateParameter('faceLength', v)}
              min={-100}
              max={100}
            />
            <ParameterSlider
              label="Facial Symmetry"
              value={parameters.facialSymmetry}
              onChange={(v) => updateParameter('facialSymmetry', v)}
              min={50}
              max={100}
              suffix="%"
            />
          </div>
        )}
      </div>

      {/* Age Parameters */}
      <div className="sidebar-section">
        <div 
          className="sidebar-section-header"
          onClick={() => toggleSection('age')}
        >
          <span className="sidebar-section-title">Age Effects</span>
          <svg 
            className={`sidebar-section-toggle ${expandedSections.age ? 'expanded' : ''}`}
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        
        {expandedSections.age && (
          <div className="sidebar-section-content expanded">
            <ParameterSlider
              label="Age Deformation"
              value={parameters.ageDeformation}
              onChange={(v) => updateParameter('ageDeformation', v)}
              min={0}
              max={100}
            />
            <ParameterSlider
              label="Skin Sagging"
              value={parameters.skinSagging}
              onChange={(v) => updateParameter('skinSagging', v)}
              min={0}
              max={100}
            />
            <ParameterSlider
              label="Wrinkle Depth"
              value={parameters.wrinkleDepth}
              onChange={(v) => updateParameter('wrinkleDepth', v)}
              min={0}
              max={100}
            />
          </div>
        )}
      </div>

      {/* Hair Parameters */}
      <div className="sidebar-section">
        <div 
          className="sidebar-section-header"
          onClick={() => toggleSection('hair')}
        >
          <span className="sidebar-section-title">Hair</span>
          <svg 
            className={`sidebar-section-toggle ${expandedSections.hair ? 'expanded' : ''}`}
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        
        {expandedSections.hair && (
          <div className="sidebar-section-content expanded">
            <div className="hair-type-selector">
              <label className="parameter-label">Hair Type</label>
              <select 
                className="hair-type-dropdown"
                value={parameters.hairType}
                onChange={(e) => updateParameter('hairType', parseInt(e.target.value))}
              >
                <option value={0}>None / Bald</option>
                <option value={1}>Short</option>
                <option value={2}>Medium</option>
                <option value={3}>Long</option>
                <option value={4}>Receding</option>
                <option value={5}>Crew Cut</option>
              </select>
            </div>
            {parameters.hairType > 0 && parameters.hairType !== 4 && (
              <>
                <ParameterSlider
                  label="Hair Volume"
                  value={parameters.hairVolume}
                  onChange={(v) => updateParameter('hairVolume', v)}
                  min={0}
                  max={100}
                />
                <ParameterSlider
                  label="Hair Length"
                  value={parameters.hairLength}
                  onChange={(v) => updateParameter('hairLength', v)}
                  min={0}
                  max={100}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default LeftSidebar;
