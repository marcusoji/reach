import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { MobileHeader } from './MobileHeader';

export const AppLayout: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="app-shell">
      {/* Mobile Top Header */}
      <MobileHeader onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />

      {/* Role Navigation Sidebar */}
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Main Content Area */}
      <main className="app-main">
        <div className="app-main__container">
          {/* Child Page Route Content */}
          <Outlet />
        </div>
      </main>
    </div>
  );
};
