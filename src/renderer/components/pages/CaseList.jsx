import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './CaseList.css';

/**
 * Case list/management page
 */
function CaseList() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy] = useState('date');

  // Mock case data
  const cases = [
    {
      id: 'CASE-2024-001',
      name: 'Unknown Male #127',
      description: 'Skeletal remains found near highway',
      status: 'in-progress',
      createdAt: '2024-01-15T10:30:00Z',
      modifiedAt: '2024-01-20T14:45:00Z',
      assignedTo: 'Dr. Sarah Johnson',
      priority: 'high'
    },
    {
      id: 'CASE-2024-002',
      name: 'Cold Case Review #45',
      description: 'Re-evaluation of 1998 case with new techniques',
      status: 'completed',
      createdAt: '2024-01-10T08:00:00Z',
      modifiedAt: '2024-01-14T15:45:00Z',
      assignedTo: 'Dr. Michael Chen',
      priority: 'medium'
    },
    {
      id: 'CASE-2024-003',
      name: 'Skeletal Remains ID',
      description: 'Partial cranium reconstruction',
      status: 'pending-review',
      createdAt: '2024-01-08T12:00:00Z',
      modifiedAt: '2024-01-12T09:00:00Z',
      assignedTo: 'Dr. Sarah Johnson',
      priority: 'high'
    },
    {
      id: 'CASE-2023-089',
      name: 'Historical Figure Study',
      description: 'Academic reconstruction from archival data',
      status: 'completed',
      createdAt: '2023-12-01T09:00:00Z',
      modifiedAt: '2023-12-20T16:30:00Z',
      assignedTo: 'Dr. Emily Roberts',
      priority: 'low'
    }
  ];

  const filteredCases = cases
    .filter(c => 
      (statusFilter === 'all' || c.status === statusFilter) &&
      (c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
       c.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
       c.description.toLowerCase().includes(searchQuery.toLowerCase()))
    )
    .sort((a, b) => {
      if (sortBy === 'date') {
        return new Date(b.modifiedAt) - new Date(a.modifiedAt);
      } else if (sortBy === 'name') {
        return a.name.localeCompare(b.name);
      } else if (sortBy === 'priority') {
        const priority = { high: 3, medium: 2, low: 1 };
        return priority[b.priority] - priority[a.priority];
      }
      return 0;
    });

  const handleNewCase = () => {
    navigate('/reconstruction/new');
  };

  const handleOpenCase = (caseId) => {
    navigate(`/reconstruction/${caseId}`);
  };

  return (
    <div className="case-list-page">
      <div className="case-list-header">
        <div className="header-title">
          <h1>Case Management</h1>
          <p className="text-muted">Manage forensic reconstruction cases</p>
        </div>
        
        <button className="btn btn-primary" onClick={handleNewCase}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          New Case
        </button>
      </div>

      <div className="case-filters">
        <div className="search-box">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            placeholder="Search cases..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input"
          />
        </div>

        <div className="filter-group">
          <label>Status:</label>
          <select 
            value={statusFilter} 
            onChange={(e) => setStatusFilter(e.target.value)}
            className="input"
          >
            <option value="all">All Status</option>
            <option value="in-progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="pending-review">Pending Review</option>
          </select>
        </div>

        <div className="filter-group">
          <label>Sort by:</label>
          <select 
            value={sortBy} 
            onChange={(e) => setSortBy(e.target.value)}
            className="input"
          >
            <option value="date">Last Modified</option>
            <option value="name">Name</option>
            <option value="priority">Priority</option>
          </select>
        </div>
      </div>

      <div className="case-table-container">
        <table className="case-table">
          <thead>
            <tr>
              <th>Case ID</th>
              <th>Name</th>
              <th>Description</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Assigned To</th>
              <th>Modified</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredCases.map(caseItem => (
              <tr key={caseItem.id} onClick={() => handleOpenCase(caseItem.id)}>
                <td className="case-id-cell">
                  <span className="case-id">{caseItem.id}</span>
                </td>
                <td className="case-name-cell">
                  <strong>{caseItem.name}</strong>
                </td>
                <td className="case-desc-cell">
                  <span className="truncate">{caseItem.description}</span>
                </td>
                <td>
                  <span className={`badge badge-${caseItem.status}`}>
                    {caseItem.status.replace('-', ' ')}
                  </span>
                </td>
                <td>
                  <span className={`priority priority-${caseItem.priority}`}>
                    {caseItem.priority}
                  </span>
                </td>
                <td className="text-muted">{caseItem.assignedTo}</td>
                <td className="text-muted">
                  {new Date(caseItem.modifiedAt).toLocaleDateString()}
                </td>
                <td>
                  <div className="action-buttons">
                    <button 
                      className="btn btn-icon btn-ghost"
                      onClick={(e) => { e.stopPropagation(); handleOpenCase(caseItem.id); }}
                      title="Open"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                        <polyline points="15 3 21 3 21 9"></polyline>
                        <line x1="10" y1="14" x2="21" y2="3"></line>
                      </svg>
                    </button>
                    <button 
                      className="btn btn-icon btn-ghost"
                      onClick={(e) => e.stopPropagation()}
                      title="More options"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="1"></circle>
                        <circle cx="12" cy="5" r="1"></circle>
                        <circle cx="12" cy="19" r="1"></circle>
                      </svg>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filteredCases.length === 0 && (
        <div className="no-results">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <p>No cases found matching your criteria</p>
        </div>
      )}
    </div>
  );
}

export default CaseList;
