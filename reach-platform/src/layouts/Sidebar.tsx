import React from 'react';
import { NavLink, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ReachLogo } from '../components/common/ReachLogo';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

interface NavItem {
  label: string;
  path: string;
  badge?: string | number;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose }) => {
  const { user, logout } = useAuth();
  const location = useLocation();
  const pathname = location.pathname;

  // Determine current active role navigation
  const getNavItems = (): { title: string; items: NavItem[] } => {
    if (pathname.startsWith('/staff')) {
      return {
        title: 'Response Staff',
        items: [{ label: 'Live Queue', path: '/staff/live-queue' }],
      };
    }
    if (pathname.startsWith('/institution') || pathname.startsWith('/admin')) {
      return {
        title: 'Institution',
        items: [
          { label: 'Overview', path: '/institution/overview' },
          { label: 'Billing and Plan', path: '/institution/billing-and-plan' },
          { label: 'Site Incidents', path: '/institution/site-incidents' },
          { label: 'Security Roster', path: '/institution/security-roster' },
          { label: 'From REACH', path: '/institution/from-reach' },
        ],
      };
    }
    if (pathname.startsWith('/operator')) {
      return {
        title: 'SaaS Operator',
        items: [
          { label: 'Overview', path: '/operator/overview' },
          { label: 'Institution', path: '/operator/institution' },
          { label: 'All Incidents', path: '/operator/all-incidents' },
          { label: 'Ai Performance', path: '/operator/ai-performance' },
          { label: 'Relay Health', path: '/operator/relay-health' },
          { label: 'System Health', path: '/operator/system-health' },
          { label: 'Audit Log', path: '/operator/audit-log' },
        ],
      };
    }
    // Default: Security Desk
    return {
      title: 'Security Desk',
      items: [
        { label: 'Live Queue', path: '/security-desk/live-queue' },
        { label: 'Response Desk', path: '/security-desk/response-desk' },
        { label: 'Team On Duty', path: '/security-desk/team-on-duty' },
        { label: 'Desk Settings', path: '/security-desk/desk-settings' },
      ],
    };
  };

  const currentNav = getNavItems();

  return (
    <>
      {isOpen && (
        <div
          className="mobile-drawer-overlay"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside className={`app-sidebar ${isOpen ? 'app-sidebar--open' : ''}`}>
        <div className="app-sidebar__content">
          <Link to="/" className="app-sidebar__logo" onClick={onClose}>
            <ReachLogo size={28} />
            <span>REACH</span>
          </Link>

          <nav className="app-sidebar__nav" aria-label="Role Navigation">
            <span className="app-sidebar__nav-title">{currentNav.title}</span>
            <ul className="app-sidebar__nav-list">
              {currentNav.items.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    className={({ isActive }) =>
                      `app-sidebar__nav-link ${
                        isActive ? 'app-sidebar__nav-link--active' : ''
                      }`
                    }
                    onClick={onClose}
                  >
                    <span>{item.label}</span>
                    {item.badge !== undefined && (
                      <span className="app-sidebar__badge">{item.badge}</span>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          {user && (
            <div style={{ marginTop: 'auto', paddingTop: '1.25rem', borderTop: '1px solid var(--reach-border-subtle)' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--reach-text-primary)' }}>
                {user.name}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--reach-text-muted)', textTransform: 'capitalize', marginBottom: '0.75rem' }}>
                {user.role.replace('-', ' ')}
              </div>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  logout();
                }}
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: 'var(--reach-brand)',
                  backgroundColor: 'var(--reach-brand-light)',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  cursor: 'pointer',
                  width: '100%',
                  textAlign: 'center',
                }}
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
};

