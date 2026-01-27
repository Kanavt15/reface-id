import React, { useEffect } from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import MainLayout from './components/layout/MainLayout';
import Dashboard from './components/pages/Dashboard';
import CaseView from './components/pages/CaseView';
import ReconstructionView from './components/pages/ReconstructionView';
import CaseList from './components/pages/CaseList';
import Settings from './components/pages/Settings';
import Login from './components/pages/Login';
import { useAppStore } from './stores/appStore';
import { useAuthStore } from './stores/authStore';
import { useMeshStore } from './stores/meshStore';
import './styles/global.css';

function App() {
  const { initializeApp, isLoading, setActiveTool } = useAppStore();
  const { isAuthenticated, checkAuth } = useAuthStore();
  const { undo, redo, reset } = useMeshStore();

  useEffect(() => {
    initializeApp();
    checkAuth();
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // Ctrl/Cmd + Z = Undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      // Ctrl/Cmd + Y or Ctrl/Cmd + Shift + Z = Redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      // R = Reset
      if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
        reset();
      }
      // Tool shortcuts
      if (e.key === 's' && !e.ctrlKey && !e.metaKey) {
        setActiveTool('select');
      }
      if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
        setActiveTool('move');
      }
      if (e.key === 'b' && !e.ctrlKey && !e.metaKey) {
        setActiveTool('sculpt');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, reset, setActiveTool]);

  if (isLoading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner"></div>
        <p>Loading REface...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  return (
    <Router>
      <MainLayout>
        <Routes>
          <Route path="/" element={<ReconstructionView />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/cases" element={<CaseList />} />
          <Route path="/case/:caseId" element={<CaseView />} />
          <Route path="/reconstruction" element={<ReconstructionView />} />
          <Route path="/reconstruction/:caseId" element={<ReconstructionView />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </MainLayout>
    </Router>
  );
}

export default App;
