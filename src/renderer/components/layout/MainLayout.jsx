import React from 'react';
import Header from './Header';
import LeftSidebar from './LeftSidebar';
import RightSidebar from './RightSidebar';
import StatusBar from './StatusBar';
import NotificationContainer from '../ui/NotificationContainer';
import DisclaimerBanner from '../ui/DisclaimerBanner';
import { useAppStore } from '../../stores/appStore';
import './MainLayout.css';

/**
 * Main application layout with header, sidebars, and content area
 */
function MainLayout({ children }) {
  const { leftSidebarOpen, rightSidebarOpen } = useAppStore();

  return (
    <div className="main-layout">
      <Header />
      <DisclaimerBanner />
      
      <div className="layout-body">
        {leftSidebarOpen && (
          <aside className="sidebar sidebar-left">
            <LeftSidebar />
          </aside>
        )}
        
        <main className="main-content">
          {children}
        </main>
        
        {rightSidebarOpen && (
          <aside className="sidebar sidebar-right">
            <RightSidebar />
          </aside>
        )}
      </div>
      
      <StatusBar />
      <NotificationContainer />
    </div>
  );
}

export default MainLayout;
