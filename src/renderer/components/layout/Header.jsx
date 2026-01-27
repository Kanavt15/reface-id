import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { useMeshStore } from '../../stores/meshStore';
import './Header.css';

/**
 * Application header with navigation and tools
 */
function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { 
    currentCase, 
    toggleLeftSidebar, 
    toggleRightSidebar,
    leftSidebarOpen,
    rightSidebarOpen 
  } = useAppStore();
  const { user, logout } = useAuthStore();
  const { undo, redo, historyIndex, history } = useMeshStore();

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  return (
    <header className="app-header">
      <div className="header-left">
        <div className="app-logo" onClick={() => navigate('/')}>
          <span className="logo-re">RE</span>
          <span className="logo-face">face</span>
        </div>
        
        <nav className="header-nav">
          <button 
            className={`nav-btn ${location.pathname === '/' ? 'active' : ''}`}
            onClick={() => navigate('/')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
              <polyline points="9 22 9 12 15 12 15 22"></polyline>
            </svg>
            Dashboard
          </button>
          
          <button 
            className={`nav-btn ${location.pathname === '/cases' ? 'active' : ''}`}
            onClick={() => navigate('/cases')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            Cases
          </button>
        </nav>
      </div>

      <div className="header-center">
        {currentCase && (
          <div className="current-case-info">
            <span className="case-label">Case:</span>
            <span className="case-id">{currentCase.caseNumber}</span>
            <span className="case-name">{currentCase.name}</span>
          </div>
        )}
      </div>

      <div className="header-right">
        {/* Edit controls */}
        <div className="header-tools">
          <button 
            className="tool-btn tooltip" 
            data-tooltip="Undo (Ctrl+Z)"
            onClick={undo}
            disabled={!canUndo}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 7v6h6"></path>
              <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"></path>
            </svg>
          </button>
          
          <button 
            className="tool-btn tooltip" 
            data-tooltip="Redo (Ctrl+Y)"
            onClick={redo}
            disabled={!canRedo}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 7v6h-6"></path>
              <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"></path>
            </svg>
          </button>
          
          <div className="tool-divider"></div>
          
          <button 
            className={`tool-btn tooltip ${leftSidebarOpen ? 'active' : ''}`}
            data-tooltip="Toggle Left Panel"
            onClick={toggleLeftSidebar}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="9" y1="3" x2="9" y2="21"></line>
            </svg>
          </button>
          
          <button 
            className={`tool-btn tooltip ${rightSidebarOpen ? 'active' : ''}`}
            data-tooltip="Toggle Right Panel"
            onClick={toggleRightSidebar}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="15" y1="3" x2="15" y2="21"></line>
            </svg>
          </button>
        </div>

        {/* User menu */}
        <div className="user-menu">
          <div className="user-info">
            <span className="user-name">{user?.name || 'User'}</span>
            <span className="user-role">{user?.role?.replace('_', ' ') || 'Guest'}</span>
          </div>
          <div className="user-avatar">
            {user?.name?.charAt(0) || 'U'}
          </div>
          <button className="logout-btn" onClick={logout} title="Logout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}

export default Header;
