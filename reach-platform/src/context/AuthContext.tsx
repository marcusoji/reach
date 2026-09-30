import React, { createContext, useContext, useEffect, useState } from 'react';
import { AuthUser, Role, SignupData } from '../types';
import {
  createInstitution, getProfile, getStoredSession, isBackendConfigured, isDemoMode, loginWithBackend,
  logoutBackend, provisionOperator, redeemInvite, signupWithBackend, storeSession,
} from '../lib/reachApi';

export const ROLE_DEFAULT_ROUTES: Record<Role, string> = {
  citizen: '/citizen', 'security-desk': '/security-desk/live-queue', staff: '/staff/live-queue',
  institution: '/institution/overview', operator: '/operator/overview', 'super-admin': '/operator/overview',
};

/** Demo accounts exist only when Supabase is not configured. They are never accepted by the backend. */
export const DEMO_USERS: Record<string, { pass: string; role: Role; name: string; inst: string }> = {
  'desk@greenfield.demo': { pass: 'demo1234', role: 'security-desk', name: 'A. Okonkwo', inst: 'Greenfield Estate' },
  'staff@greenfield.demo': { pass: 'demo1234', role: 'staff', name: 'T. Bello', inst: 'Greenfield Estate' },
  'admin@greenfield.demo': { pass: 'demo1234', role: 'institution', name: 'Estate Admin', inst: 'Greenfield Estate' },
  'ops@reach.demo': { pass: 'demo1234', role: 'operator', name: 'Ops Ada', inst: 'REACH Platform' },
};

export function normalizeRole(roleStr: string): Role {
  if (roleStr === 'desk') return 'security-desk';
  if (roleStr === 'admin') return 'institution';
  if (roleStr === 'resident' || roleStr === 'student' || roleStr === 'citizen') return 'citizen';
  if (['security-desk', 'staff', 'institution', 'operator', 'super-admin'].includes(roleStr)) return roleStr as Role;
  return 'citizen';
}

interface AuthContextType {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, pass: string, requestedRole?: string) => Promise<{ success: boolean; error?: string; user?: AuthUser }>;
  signup: (data: SignupData) => Promise<{ success: boolean; error?: string; user?: AuthUser }>;
  logout: () => void;
  toast: string | null;
  showToast: (msg: string) => void;
  getRoleDashboardPath: (role: Role) => string;
}

const STORAGE_KEY = 'reach_auth_session';
const AuthContext = createContext<AuthContextType | undefined>(undefined);

function saveLocalUser(user: AuthUser | null) {
  try { if (user) localStorage.setItem(STORAGE_KEY, JSON.stringify(user)); else localStorage.removeItem(STORAGE_KEY); } catch { /* unavailable storage */ }
}

function userFromProfile(profile: any, email: string): AuthUser {
  return { id: profile.id, email, name: profile.full_name, role: profile.role as Role, inst: profile.institution_id || undefined };
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(() => {
    if (isBackendConfigured || !isDemoMode) return null;
    try { const saved = localStorage.getItem(STORAGE_KEY); return saved ? JSON.parse(saved) : null; } catch { return null; }
  });
  const [isLoading, setIsLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => setToast(msg);

  useEffect(() => {
    const boot = async () => {
      if (!isBackendConfigured) { setIsLoading(false); return; }
      const session = getStoredSession();
      if (!session?.access_token) { setIsLoading(false); return; }
      try {
        const profile = await getProfile(session.access_token);
        const next = userFromProfile(profile, session.user.email || '');
        setUser(next);
      } catch {
        await logoutBackend(session.access_token);
        setUser(null);
      } finally { setIsLoading(false); }
    };
    void boot();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  const login = async (rawEmail: string, pass: string, requestedRole?: string) => {
    setIsLoading(true);
    const email = rawEmail.trim().toLowerCase();
    try {
      if (isBackendConfigured) {
        // requestedRole is deliberately ignored: role comes from the authenticated profile.
        void requestedRole;
        const session = await loginWithBackend(email, pass);
        const profile = await getProfile(session.access_token);
        const loggedUser = userFromProfile(profile, email);
        setUser(loggedUser); showToast(`Welcome back, ${loggedUser.name}`);
        return { success: true, user: loggedUser };
      }
      if (!isDemoMode) throw new Error('REACH backend is not configured');
      const demo = DEMO_USERS[email];
      if (!demo || demo.pass !== pass) throw new Error('Invalid demo credentials');
      const loggedUser: AuthUser = { email, name: demo.name, role: demo.role, inst: demo.inst };
      setUser(loggedUser); saveLocalUser(loggedUser); showToast(`Welcome back, ${loggedUser.name}`);
      return { success: true, user: loggedUser };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to sign in';
      showToast(message); return { success: false, error: message };
    } finally { setIsLoading(false); }
  };

  const signup = async (data: SignupData) => {
    setIsLoading(true);
    try {
      if (data.pass.length < 8) throw new Error('Password must be at least 8 characters long');
      if (isBackendConfigured) {
        const session = await signupWithBackend({ email: data.email.trim().toLowerCase(), password: data.pass, full_name: data.name.trim() });
        if (!session) return { success: true, error: 'Account created. Check your email, then sign in to finish setup.' };

        if (data.type === 'institution') {
          await createInstitution({ name: data.org.trim() || data.name.trim(), category: data.category, city: data.city });
        } else if (data.type === 'staff') {
          if (!data.invite.trim()) throw new Error('Invite code required');
          await redeemInvite(data.invite.trim());
        } else if (data.type === 'operator') {
          if (!data.key.trim()) throw new Error('Operator provisioning key required');
          await provisionOperator(data.key.trim());
        }

        const profile = await getProfile(session.access_token);
        const loggedUser = userFromProfile(profile, data.email.trim().toLowerCase());
        setUser(loggedUser); showToast('Account setup complete');
        return { success: true, user: loggedUser };
      }

      if (!isDemoMode) throw new Error('REACH backend is not configured');
      if (data.type === 'institution') {
        const u: AuthUser = { email: data.email.trim().toLowerCase(), name: data.name.trim() || 'Institution Admin', role: 'institution', inst: data.org.trim() || 'New Institution' };
        setUser(u); saveLocalUser(u); return { success: true, user: u };
      }
      if (data.type === 'staff') {
        if (!data.invite.trim()) throw new Error('Invite code required');
        const u: AuthUser = { email: data.email.trim().toLowerCase(), name: data.name.trim() || 'New Staff', role: normalizeRole(data.roleMap), inst: 'Demo Institution' };
        setUser(u); saveLocalUser(u); return { success: true, user: u };
      }
      if (!data.key.trim()) throw new Error('Operator access key required');
      const u: AuthUser = { email: data.email.trim().toLowerCase(), name: data.name.trim() || 'Operator', role: 'operator', inst: 'REACH Platform' };
      setUser(u); saveLocalUser(u); return { success: true, user: u };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to create account';
      showToast(message); return { success: false, error: message };
    } finally { setIsLoading(false); }
  };

  const logout = () => {
    if (isBackendConfigured) void logoutBackend();
    setUser(null); saveLocalUser(null); showToast('Logged out');
  };

  return <AuthContext.Provider value={{ user, isAuthenticated: !!user, isLoading, login, signup, logout, toast, showToast, getRoleDashboardPath: (role) => ROLE_DEFAULT_ROUTES[role] || '/citizen' }}>
    {children}
    <div id="toast" className={toast ? 'show' : ''} role="status" aria-live="polite">{toast}</div>
  </AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
