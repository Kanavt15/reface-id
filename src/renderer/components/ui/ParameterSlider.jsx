import React from 'react';
import './ParameterSlider.css';

/**
 * Parameter slider component for facial modifications
 */
function ParameterSlider({ 
  label, 
  value, 
  onChange, 
  min = -100, 
  max = 100, 
  step = 1,
  suffix = '',
  showReset = true 
}) {
  const handleChange = (e) => {
    onChange(parseFloat(e.target.value));
  };

  const handleReset = () => {
    onChange(0);
  };

  const handleInputChange = (e) => {
    const newValue = parseFloat(e.target.value);
    if (!isNaN(newValue) && newValue >= min && newValue <= max) {
      onChange(newValue);
    }
  };

  // Calculate percentage for visual indicator
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className="parameter-slider">
      <div className="slider-header">
        <label className="slider-label">{label}</label>
        <div className="slider-value-container">
          <input
            type="number"
            className="slider-value-input"
            value={value}
            onChange={handleInputChange}
            min={min}
            max={max}
            step={step}
          />
          {suffix && <span className="slider-suffix">{suffix}</span>}
          {showReset && value !== 0 && (
            <button 
              className="slider-reset" 
              onClick={handleReset}
              title="Reset to 0"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                <path d="M3 3v5h5"></path>
              </svg>
            </button>
          )}
        </div>
      </div>
      
      <div className="slider-track-container">
        <input
          type="range"
          className="slider-input"
          value={value}
          onChange={handleChange}
          min={min}
          max={max}
          step={step}
        />
        <div 
          className="slider-fill"
          style={{ 
            width: `${percentage}%`,
            left: min < 0 ? '50%' : '0',
            transform: min < 0 ? `translateX(-${100 - percentage}%)` : 'none'
          }}
        ></div>
        {min < 0 && <div className="slider-center-mark"></div>}
      </div>
      
      <div className="slider-range">
        <span>{min}{suffix}</span>
        <span>{max}{suffix}</span>
      </div>
    </div>
  );
}

export default ParameterSlider;
