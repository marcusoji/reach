import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppLayout } from './layouts/AppLayout';
import { ProtectedRoute } from './components/auth/ProtectedRoute';

// Authentication Pages
import { AuthPage } from './pages/auth/AuthPage';

// Security Desk Pages
import { LiveQueuePage } from './pages/security-desk/LiveQueuePage';
import { ResponseDeskPage } from './pages/security-desk/ResponseDeskPage';
import { TeamOnDutyPage } from './pages/security-desk/TeamOnDutyPage';
import { DeskSettingsPage } from './pages/security-desk/DeskSettingsPage';

// Staff Pages
import { StaffTasksPage } from './pages/staff/StaffTasksPage';

// Institution Pages
import { OverviewPage as InstitutionOverviewPage } from './pages/institution/OverviewPage';
import { BillingPlanPage } from './pages/institution/BillingPlanPage';
import { SiteIncidentsPage } from './pages/institution/SiteIncidentsPage';
import { SecurityRosterPage } from './pages/institution/SecurityRosterPage';
import { NotificationsPage } from './pages/institution/NotificationsPage';

// Operator Pages
import { OperatorOverviewPage } from './pages/operator/OperatorOverviewPage';
import { InstitutionsPage } from './pages/operator/InstitutionsPage';
import { AllIncidentsPage } from './pages/operator/AllIncidentsPage';
import { AiPerformancePage } from './pages/operator/AiPerformancePage';
import { RelayHealthPage } from './pages/operator/RelayHealthPage';
import { SystemHealthPage } from './pages/operator/SystemHealthPage';
import { AuditLogPage } from './pages/operator/AuditLogPage';
import { CitizenPortalPage } from './pages/citizen/CitizenPortalPage';

/**
 * RootRedirect redirects authenticated users to their specific role dashboard,
 * or unauthenticated users to /login.
 */
const RootRedirect: React.FC = () => {
  const { user, isAuthenticated, getRoleDashboardPath } = useAuth();
  if (!isAuthenticated || !user) {
    return <Navigate to="/login" replace />;
  }
  return <Navigate to={getRoleDashboardPath(user.role)} replace />;
};

export default function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <BrowserRouter>
          <Routes>
            {/* Public Authentication Routes */}
            <Route path="/login" element={<AuthPage defaultMode="login" />} />
            <Route path="/signup" element={<AuthPage defaultMode="signup" />} />

            {/* Root Route: Role-based redirect or login */}
            <Route path="/" element={<RootRedirect />} />

            {/* Protected Application Portals */}
            <Route element={<ProtectedRoute />}>
              <Route element={<AppLayout />}>
                {/* Security Desk Section */}
                <Route path="citizen" element={<ProtectedRoute allowedRoles={['citizen']}><CitizenPortalPage /></ProtectedRoute>} />
                <Route path="security-desk" element={<ProtectedRoute allowedRoles={['security-desk']} />}>
                  <Route index element={<Navigate to="live-queue" replace />} />
                  <Route path="live-queue" element={<LiveQueuePage />} />
                  <Route path="response-desk" element={<ResponseDeskPage />} />
                  <Route path="team-on-duty" element={<TeamOnDutyPage />} />
                  <Route path="desk-settings" element={<DeskSettingsPage />} />
                </Route>
                <Route
                  path="desk/dashboard"
                  element={
                    <ProtectedRoute allowedRoles={['security-desk']}>
                      <Navigate to="/security-desk/live-queue" replace />
                    </ProtectedRoute>
                  }
                />

                {/* Staff Section */}
                <Route path="staff" element={<ProtectedRoute allowedRoles={['staff']} />}>
                  <Route index element={<Navigate to="live-queue" replace />} />
                  <Route path="live-queue" element={<StaffTasksPage />} />
                </Route>

                {/* Institution Section */}
                <Route path="institution" element={<ProtectedRoute allowedRoles={['institution']} />}>
                  <Route index element={<Navigate to="overview" replace />} />
                  <Route path="overview" element={<InstitutionOverviewPage />} />
                  <Route path="billing-and-plan" element={<BillingPlanPage />} />
                  <Route path="site-incidents" element={<SiteIncidentsPage />} />
                  <Route path="security-roster" element={<SecurityRosterPage />} />
                  <Route path="from-reach" element={<NotificationsPage />} />
                </Route>
                <Route
                  path="admin/dashboard"
                  element={
                    <ProtectedRoute allowedRoles={['institution']}>
                      <Navigate to="/institution/overview" replace />
                    </ProtectedRoute>
                  }
                />

                {/* Operator Section */}
                <Route path="operator" element={<ProtectedRoute allowedRoles={['operator','super-admin']} />}>
                  <Route index element={<Navigate to="overview" replace />} />
                  <Route path="overview" element={<OperatorOverviewPage />} />
                  <Route path="institution" element={<InstitutionsPage />} />
                  <Route path="all-incidents" element={<AllIncidentsPage />} />
                  <Route path="ai-performance" element={<AiPerformancePage />} />
                  <Route path="relay-health" element={<RelayHealthPage />} />
                  <Route path="system-health" element={<SystemHealthPage />} />
                  <Route path="audit-log" element={<AuditLogPage />} />
                </Route>
              </Route>
            </Route>

            {/* Fallback Catch-all: Route via RootRedirect */}
            <Route path="*" element={<RootRedirect />} />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </AuthProvider>
  );
}
