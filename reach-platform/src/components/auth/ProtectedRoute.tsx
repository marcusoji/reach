import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Role } from '../../types';

interface ProtectedRouteProps {
  allowedRoles?: Role[];
  children?: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ allowedRoles, children }) => {
  const { user, isAuthenticated, getRoleDashboardPath } = useAuth();
  const location = useLocation();

  if (!isAuthenticated || !user) {
    // Redirect unauthenticated user to /login, remembering the attempted location
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Check role restrictions if allowedRoles are defined
  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
    // Role mismatch: redirect user to their own role's authorized dashboard
    const userHomePath = getRoleDashboardPath(user.role);
    return <Navigate to={userHomePath} replace />;
  }

  return children ? <>{children}</> : <Outlet />;
};
