import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import './Dashboard.css';

/**
 * Dashboard/home page with quick actions and recent cases
 */
function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuthStore();

  const recentCases = [
    {
      id: 'CASE-2024-001',
      name: 'Unknown Male #127',
      status: 'In Progress',
      lastModified: '2024-01-15T10:30:00Z',
      thumbnail: null
    },
    {
      id: 'CASE-2024-002',
      name: 'Cold Case Review #45',
      status: 'Completed',
      lastModified: '2024-01-14T15:45:00Z',
      thumbnail: null
    },
    {
      id: 'CASE-2023-089',
      name: 'Skeletal Remains ID',
      status: 'Under Review',
      lastModified: '2024-01-12T09:00:00Z',
      thumbnail: null
    }
  ];

  const quickStats = [
    { label: 'Active Cases', value: 12, icon: 'folder' },
    { label: 'Completed', value: 47, icon: 'check' },
    { label: 'Pending Review', value: 5, icon: 'clock' },
    { label: 'This Month', value: 8, icon: 'calendar' }
  ];

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <div className="welcome-section">
          <h1>Welcome back, {user?.name?.split(' ')[0] || 'Expert'}</h1>
          <p className="text-muted">Forensic Facial Reconstruction Workspace</p>
        </div>
        
        <button 
          className="btn btn-primary btn-lg new-case-btn"
          onClick={() => navigate('/cases')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          New Case
        </button>
      </div>

      {/* Quick Stats */}
      <div className="stats-grid">
        {quickStats.map((stat, index) => (
          <div key={index} className="stat-card">
            <div className="stat-icon">
              {stat.icon === 'folder' && (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
              )}
              {stat.icon === 'check' && (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                  <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
              )}
              {stat.icon === 'clock' && (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              )}
              {stat.icon === 'calendar' && (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
              )}
            </div>
            <div className="stat-content">
              <span className="stat-value">{stat.value}</span>
              <span className="stat-label">{stat.label}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="quick-actions">
        <h2>Quick Actions</h2>
        <div className="actions-grid">
          <button className="action-card" onClick={() => navigate('/reconstruction/new')}>
            <div className="action-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                <line x1="12" y1="22.08" x2="12" y2="12"></line>
              </svg>
            </div>
            <h3>Start New Reconstruction</h3>
            <p>Create a new facial approximation from forensic data</p>
          </button>
          
          <button className="action-card" onClick={() => navigate('/cases')}>
            <div className="action-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
            </div>
            <h3>Browse Cases</h3>
            <p>View and manage existing case files</p>
          </button>
          
          <button className="action-card">
            <div className="action-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="17 8 12 3 7 8"></polyline>
                <line x1="12" y1="3" x2="12" y2="15"></line>
              </svg>
            </div>
            <h3>Import Data</h3>
            <p>Import skull scans, images, or measurements</p>
          </button>
          
          <button className="action-card">
            <div className="action-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
            </div>
            <h3>Export Renders</h3>
            <p>Generate high-resolution facial renders</p>
          </button>
        </div>
      </div>

      {/* Recent Cases */}
      <div className="recent-cases">
        <div className="section-header">
          <h2>Recent Cases</h2>
          <button className="btn btn-ghost" onClick={() => navigate('/cases')}>
            View All
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
        </div>
        
        <div className="cases-grid">
          {recentCases.map(caseItem => (
            <div 
              key={caseItem.id} 
              className="case-card"
              onClick={() => navigate(`/reconstruction/${caseItem.id}`)}
            >
              <div className="case-thumbnail">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <circle cx="12" cy="8" r="5"></circle>
                  <path d="M20 21a8 8 0 1 0-16 0"></path>
                </svg>
              </div>
              <div className="case-info">
                <span className="case-id">{caseItem.id}</span>
                <h3 className="case-name">{caseItem.name}</h3>
                <div className="case-meta">
                  <span className={`case-status status-${caseItem.status.toLowerCase().replace(' ', '-')}`}>
                    {caseItem.status}
                  </span>
                  <span className="case-date">
                    {new Date(caseItem.lastModified).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
