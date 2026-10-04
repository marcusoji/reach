import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth, DEMO_USERS } from '../../context/AuthContext';
import { isBackendConfigured, isDemoMode } from '../../lib/reachApi';
import { ReachLogo } from '../../components/common/ReachLogo';
import { Role } from '../../types';
import '../../styles/auth.css';

interface AuthPageProps {
  defaultMode?: 'login' | 'signup';
}

type SignupStep = 'select' | 'institution' | 'staff' | 'operator';

export const AuthPage: React.FC<AuthPageProps> = ({ defaultMode = 'login' }) => {
  const { user, isAuthenticated, login, signup, getRoleDashboardPath, showToast } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated && user) {
      const target = (location.state as any)?.from?.pathname || getRoleDashboardPath(user.role);
      navigate(target, { replace: true });
    }
  }, [isAuthenticated, user, navigate, location.state, getRoleDashboardPath]);

  // Tab & panel state
  const [activeTab, setActiveTab] = useState<'login' | 'signup'>(defaultMode);
  const [signupStep, setSignupStep] = useState<SignupStep>('select');
  const [selectedSignupType, setSelectedSignupType] = useState<'institution' | 'staff' | 'operator'>('institution');

  // Boot animation state (only shown once on first load)
  const [bootGone, setBootGone] = useState<boolean>(() => {
    return sessionStorage.getItem('reach_boot_dismissed') === 'true';
  });

  useEffect(() => {
    if (!bootGone) {
      const timer = setTimeout(() => {
        setBootGone(true);
        sessionStorage.setItem('reach_boot_dismissed', 'true');
      }, 1400);
      return () => clearTimeout(timer);
    }
  }, [bootGone]);

  // Login form inputs
  const [loginEmail, setLoginEmail] = useState<string>(isDemoMode ? 'desk@greenfield.demo' : '');
  const [loginPass, setLoginPass] = useState<string>(isDemoMode ? 'demo1234' : '');
  const [loginRole, setLoginRole] = useState<string>('security-desk');

  // Signup forms inputs

  // Institution
  const [iName, setIName] = useState<string>('');
  const [iEmail, setIEmail] = useState<string>('');
  const [iPass, setIPass] = useState<string>('');
  const [iOrg, setIOrg] = useState<string>('');
  const [iType, setIType] = useState<string>('Estate');
  const [iCity, setICity] = useState<string>('');
  const [iPeople, setIPeople] = useState<string>('640');

  // Staff / Desk
  const [sName, setSName] = useState<string>('');
  const [sEmail, setSEmail] = useState<string>('');
  const [sPass, setSPass] = useState<string>('');
  const [sInvite, setSInvite] = useState<string>('INV-GF-8841');
  const [sRoleMap, setSRoleMap] = useState<'staff' | 'security-desk'>('staff');

  // Operator
  const [oName, setOName] = useState<string>('');
  const [oEmail, setOEmail] = useState<string>('');
  const [oPass, setOPass] = useState<string>('');
  const [oKey, setOKey] = useState<string>('');

  // Quick Demo Chip click handler
  const handleDemoChip = (email: string, role: string) => {
    setLoginEmail(email);
    setLoginPass('demo1234');
    setLoginRole(role);
    setActiveTab('login');
  };

  // Login submit handler
  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await login(loginEmail, loginPass, loginRole);
    if (result.success && result.user) {
      const destination = (location.state as any)?.from?.pathname || getRoleDashboardPath(result.user.role);
      navigate(destination, { replace: true });
    }
  };


  // Institution Signup submit handler
  const handleInstitutionSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await signup({
      type: 'institution',
      name: iName,
      email: iEmail,
      pass: iPass,
      org: iOrg,
      category: iType,
      city: iCity,
      people: parseInt(iPeople, 10) || 640,
    });
    if (result.success && result.user) {
      navigate(getRoleDashboardPath(result.user.role), { replace: true });
    }
  };

  // Staff Signup submit handler
  const handleStaffSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await signup({
      type: 'staff',
      name: sName,
      email: sEmail,
      pass: sPass,
      invite: sInvite,
      roleMap: sRoleMap,
    });
    if (result.success && result.user) {
      navigate(getRoleDashboardPath(result.user.role), { replace: true });
    }
  };

  // Operator Signup submit handler
  const handleOperatorSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await signup({
      type: 'operator',
      name: oName,
      email: oEmail,
      pass: oPass,
      key: oKey,
    });
    if (result.success && result.user) {
      navigate(getRoleDashboardPath(result.user.role), { replace: true });
    }
  };

  return (
    <>
      {/* Animated Robot Boot Screen */}
      <div id="boot" className={bootGone ? 'gone' : ''} aria-hidden={bootGone}>
        <div className="robot-wrap">
          <div className="robot">
            <div className="r-ant" />
            <div className="r-head">
              <div className="r-eye l" />
              <div className="r-eye r" />
            </div>
            <div className="r-body">
              <div className="r-badge">AI</div>
              <div className="r-arm l" />
              <div className="r-arm r" />
              <div className="r-leg l" />
              <div className="r-leg r" />
            </div>
          </div>
        </div>
        <div className="boot-logo" style={{ marginBottom: '10px' }}>
          <ReachLogo size={40} />
        </div>
        <div className="boot-name">REACH</div>
        <div className="boot-sub">Campus &amp; Community Intelligence System</div>
        <div className="boot-bar">
          <i />
        </div>
      </div>

      {/* Main Authentication Card */}
      <div id="auth">
        <div className="auth-shell">
          {/* Brand Left Sidebar (Desktop) */}
          <div className="auth-brand-side">
            <div className="auth-brand-logo-wrap">
              <ReachLogo size={42} />
            </div>
            <div className="auth-brand-name">REACH</div>
            <p className="auth-brand-tag">Resilient Emergency Alert &amp; Community Help</p>
            <ul className="auth-points">
              <li>Institutions subscribe only</li>
              <li>AI assists evidence review and prioritization; humans verify incidents</li>
              <li>Works offline and relays alerts over Bluetooth and Wi-Fi</li>
              <li>One plan · REACH Full</li>
            </ul>
            <div className="auth-brand-foot">Hackathon MVP</div>
          </div>

          {/* Forms Right Column */}
          <div className="auth-forms">
            {/* Mobile Centered Brand Header */}
            <div className="auth-mobile-brand">
              <div className="auth-mobile-logo">
                <ReachLogo size={52} />
              </div>
              <h1 className="auth-mobile-name">REACH</h1>
              <p className="auth-mobile-tag">Resilient Emergency Alert &amp; Community Help</p>
            </div>

            {/* Form Mode Tabs */}
            <div className="auth-tabs" role="tablist">
              <button
                type="button"
                className={`auth-tab ${activeTab === 'login' ? 'on' : ''}`}
                onClick={() => {
                  setActiveTab('login');
                  navigate('/login', { replace: true });
                }}
              >
                Log in
              </button>
              <button
                type="button"
                className={`auth-tab ${activeTab === 'signup' ? 'on' : ''}`}
                onClick={() => {
                  setActiveTab('signup');
                  setSignupStep('select');
                  navigate('/signup', { replace: true });
                }}
              >
                Sign up
              </button>
            </div>

            {/* ==============================================================
                PANEL: LOGIN
                ============================================================== */}
            {activeTab === 'login' && (
              <div className="auth-panel on" id="panel-login">
                <h2 className="auth-h">Welcome back</h2>
                <p className="auth-sub">Sign in to your REACH workspace</p>

                <form onSubmit={handleLoginSubmit} className="auth-panel-form">
                  <div className="auth-form-fields">
                    <div className="field">
                      <label htmlFor="loginEmail">Email</label>
                      <input
                        type="email"
                        id="loginEmail"
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        autoComplete="username"
                        required
                      />
                    </div>

                    <div className="field">
                      <label htmlFor="loginPass">Password</label>
                      <input
                        type="password"
                        id="loginPass"
                        value={loginPass}
                        onChange={(e) => setLoginPass(e.target.value)}
                        autoComplete="current-password"
                        required
                      />
                    </div>

                    {!isBackendConfigured && <div className="field">
                      <label htmlFor="loginRole">Sign in as</label>
                      <select
                        id="loginRole"
                        value={loginRole}
                        onChange={(e) => setLoginRole(e.target.value)}
                      >
                        <option value="security-desk">Security desk</option>
                        <option value="staff">Response staff</option>
                        <option value="institution">Institution admin</option>
                        <option value="operator">SaaS operator</option>
                      </select>
                    </div>}

                    {/* Quick Demo Accounts Helper */}
                    {isDemoMode && !isBackendConfigured && <div className="auth-demo">
                      <strong>Quick demo</strong> — password <code>demo1234</code>
                      <div className="demo-grid">
                        <button
                          type="button"
                          className="demo-chip"
                          onClick={() => handleDemoChip('desk@greenfield.demo', 'security-desk')}
                        >
                          Desk
                        </button>
                        <button
                          type="button"
                          className="demo-chip"
                          onClick={() => handleDemoChip('staff@greenfield.demo', 'staff')}
                        >
                          Staff
                        </button>
                        <button
                          type="button"
                          className="demo-chip"
                          onClick={() => handleDemoChip('admin@greenfield.demo', 'institution')}
                        >
                          Institution
                        </button>
                        <button
                          type="button"
                          className="demo-chip"
                          onClick={() => handleDemoChip('ops@reach.demo', 'operator')}
                        >
                          Operator
                        </button>
                      </div>
                    </div>}
                  </div>

                  {/* Bottom Action Buttons (stretching fully and positioned at bottom on mobile) */}
                  <div className="auth-bottom-actions">
                    <button type="submit" className="btn btn-p btn-b" id="btnLogin">
                      Log in
                    </button>
                    <button
                      type="button"
                      className="btn-auth-secondary"
                      onClick={() => {
                        setActiveTab('signup');
                        setSignupStep('select');
                        navigate('/signup', { replace: true });
                      }}
                    >
                      Don't have an account? Sign up
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* ==============================================================
                PANEL: SIGNUP STEP 1 (Choose Account Type)
                ============================================================== */}
            {activeTab === 'signup' && signupStep === 'select' && (
              <div className="auth-panel on" id="panel-signup">
                <h2 className="auth-h">Create account</h2>
                <p className="auth-sub">Choose how you join REACH</p>

                <div className="auth-panel-form">
                  <div className="auth-form-fields">
                    <div className="signup-types" id="signupType">

                      <button
                        type="button"
                        className={`stype ${selectedSignupType === 'institution' ? 'sel' : ''}`}
                        onClick={() => setSelectedSignupType('institution')}
                      >
                        <strong>Institution Admin</strong>
                        <span>Register estate, school, clinic, or market.</span>
                      </button>

                      <button
                        type="button"
                        className={`stype ${selectedSignupType === 'staff' ? 'sel' : ''}`}
                        onClick={() => setSelectedSignupType('staff')}
                      >
                        <strong>Staff / Desk</strong>
                        <span>Join with an invite code from your admin.</span>
                      </button>

                      <button
                        type="button"
                        className={`stype ${selectedSignupType === 'operator' ? 'sel' : ''}`}
                        onClick={() => setSelectedSignupType('operator')}
                      >
                        <strong>SaaS operator</strong>
                        <span>Platform team. Oversight only.</span>
                      </button>
                    </div>
                  </div>

                  <div className="auth-bottom-actions">
                    <button
                      type="button"
                      className="btn btn-p btn-b"
                      id="btnSignupNext"
                      onClick={() => setSignupStep(selectedSignupType)}
                    >
                      Sign up as {selectedSignupType === 'institution' ? 'Institution Admin' : selectedSignupType === 'staff' ? 'Staff / Desk' : 'SaaS Operator'}
                    </button>
                    <button
                      type="button"
                      className="btn-auth-secondary"
                      onClick={() => {
                        setActiveTab('login');
                        navigate('/login', { replace: true });
                      }}
                    >
                      Already have an account? Log in
                    </button>
                  </div>
                </div>
              </div>
            )}


            {/* ==============================================================
                PANEL: SIGNUP INSTITUTION
                ============================================================== */}
            {activeTab === 'signup' && signupStep === 'institution' && (
              <div className="auth-panel on" id="panel-su-institution">
                <button
                  type="button"
                  className="back-link"
                  onClick={() => setSignupStep('select')}
                >
                  ← Account type
                </button>
                <h2 className="auth-h">Institution sign up</h2>
                <p className="auth-sub">Create your site · subscribe to REACH Full</p>

                <form onSubmit={handleInstitutionSignup} className="auth-panel-form">
                  <div className="auth-form-fields">
                    <div className="field">
                      <label>Admin full name</label>
                      <input
                        type="text"
                        placeholder="Estate Admin"
                        value={iName}
                        onChange={(e) => setIName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Work email</label>
                      <input
                        type="email"
                        placeholder="admin@greenfield.example"
                        value={iEmail}
                        onChange={(e) => setIEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Password</label>
                      <input
                        type="password"
                        placeholder="Min 8 characters"
                        value={iPass}
                        onChange={(e) => setIPass(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Institution name</label>
                      <input
                        type="text"
                        placeholder="Greenfield Estate"
                        value={iOrg}
                        onChange={(e) => setIOrg(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Type</label>
                      <select value={iType} onChange={(e) => setIType(e.target.value)}>
                        <option>Estate</option>
                        <option>School</option>
                        <option>Clinic</option>
                        <option>Market</option>
                        <option>Other</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>City / area</label>
                      <input
                        type="text"
                        placeholder="Lagos"
                        value={iCity}
                        onChange={(e) => setICity(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>Approx. people covered</label>
                      <input
                        type="number"
                        placeholder="640"
                        min="1"
                        value={iPeople}
                        onChange={(e) => setIPeople(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="auth-bottom-actions">
                    <button type="submit" className="btn btn-p btn-b" id="btnSuInstitution">
                      Sign up as Institution
                    </button>
                    <button
                      type="button"
                      className="btn-auth-secondary"
                      onClick={() => {
                        setActiveTab('login');
                        navigate('/login', { replace: true });
                      }}
                    >
                      Already have an account? Log in
                    </button>
                  </div>
                </form>
                <p className="auth-note">
                  Institution billing is managed at the institution level. Individual members never pay for emergency access.
                </p>
              </div>
            )}

            {/* ==============================================================
                PANEL: SIGNUP STAFF / DESK
                ============================================================== */}
            {activeTab === 'signup' && signupStep === 'staff' && (
              <div className="auth-panel on" id="panel-su-staff">
                <button
                  type="button"
                  className="back-link"
                  onClick={() => setSignupStep('select')}
                >
                  ← Account type
                </button>
                <h2 className="auth-h">Staff / Desk sign up</h2>
                <p className="auth-sub">Invite code from your institution admin</p>

                <form onSubmit={handleStaffSignup} className="auth-panel-form">
                  <div className="auth-form-fields">
                    <div className="field">
                      <label>Full name</label>
                      <input
                        type="text"
                        placeholder="T. Bello"
                        value={sName}
                        onChange={(e) => setSName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Email</label>
                      <input
                        type="email"
                        placeholder="staff@greenfield.example"
                        value={sEmail}
                        onChange={(e) => setSEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Password</label>
                      <input
                        type="password"
                        placeholder="Min 8 characters"
                        value={sPass}
                        onChange={(e) => setSPass(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Invite code</label>
                      <input
                        type="text"
                        placeholder="INV-GF-8841"
                        value={sInvite}
                        onChange={(e) => setSInvite(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Role on site</label>
                      <select
                        value={sRoleMap}
                        onChange={(e) => setSRoleMap(e.target.value as 'staff' | 'security-desk')}
                      >
                        <option value="staff">Response staff (field)</option>
                        <option value="security-desk">Security desk</option>
                      </select>
                    </div>
                  </div>

                  <div className="auth-bottom-actions">
                    <button type="submit" className="btn btn-p btn-b" id="btnSuStaff">
                      Sign up with invite
                    </button>
                    <button
                      type="button"
                      className="btn-auth-secondary"
                      onClick={() => {
                        setActiveTab('login');
                        navigate('/login', { replace: true });
                      }}
                    >
                      Already have an account? Log in
                    </button>
                  </div>
                </form>
                <p className="auth-note">
                  Staff and security-desk accounts require a valid, single-use institution invitation code.
                </p>
              </div>
            )}

            {/* ==============================================================
                PANEL: SIGNUP OPERATOR
                ============================================================== */}
            {activeTab === 'signup' && signupStep === 'operator' && (
              <div className="auth-panel on" id="panel-su-operator">
                <button
                  type="button"
                  className="back-link"
                  onClick={() => setSignupStep('select')}
                >
                  ← Account type
                </button>
                <h2 className="auth-h">Operator access</h2>
                <p className="auth-sub">Platform team · oversight only</p>

                <form onSubmit={handleOperatorSignup} className="auth-panel-form">
                  <div className="auth-form-fields">
                    <div className="field">
                      <label>Full name</label>
                      <input
                        type="text"
                        placeholder="Ops Ada"
                        value={oName}
                        onChange={(e) => setOName(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Work email</label>
                      <input
                        type="email"
                        placeholder="ops@reach.demo"
                        value={oEmail}
                        onChange={(e) => setOEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Password</label>
                      <input
                        type="password"
                        placeholder="Min 8 characters"
                        value={oPass}
                        onChange={(e) => setOPass(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label>Operator access key</label>
                      <input
                        type="text"
                        placeholder="Platform-issued key"
                        value={oKey}
                        onChange={(e) => setOKey(e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <div className="auth-bottom-actions">
                    <button type="submit" className="btn btn-p btn-b" id="btnSuOperator">
                      Request operator access
                    </button>
                    <button
                      type="button"
                      className="btn-auth-secondary"
                      onClick={() => {
                        setActiveTab('login');
                        navigate('/login', { replace: true });
                      }}
                    >
                      Already have an account? Log in
                    </button>
                  </div>
                </form>
                <p className="auth-note">
                  Operator access requires a platform-issued provisioning key. Operators do not approve AI emergencies.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
