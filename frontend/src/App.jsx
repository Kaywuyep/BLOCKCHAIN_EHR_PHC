import { useCallback, useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, NavLink, Link, useLocation } from 'react-router-dom';
import './tokens.css';
import './shell.css';
import { PatientApp } from './pages/PatientApp';
import { ClinicianPortal } from './pages/ClinicianPortal';
import { AdminDashboard } from './pages/AdminDashboard';
import { Login } from './pages/Login';
import { Watermark } from './components/Watermark';
import { api } from './api';
import { useLedgerEvents } from './ledgerEvents';
import { SessionContext, allowedTabs, completeOidcRedirect, fetchAuthConfig, fetchSession, logout } from './auth';

const NAV_ITEMS = {
  '/patient': [
    { path: '/patient', label: 'My Health ID', icon: 'fingerprint' },
    { path: '/patient/facilities', label: 'My Hospitals', icon: 'local_hospital' },
    { path: '/patient/records', label: 'My Records', icon: 'description' },
    { path: '/patient/access', label: 'Access Control', icon: 'shield' },
    { path: '/patient/audit', label: 'Audit Trail', icon: 'history' },
  ],
  '/clinician': [
    { path: '/clinician', label: 'Request Access', icon: 'key' },
    { path: '/clinician/emergency', label: 'Emergency Access', icon: 'warning' },
    { path: '/clinician/records', label: 'View Records', icon: 'folder_open' },
  ],
  '/admin': [
    { path: '/admin', label: 'Overview', icon: 'dashboard' },
    { path: '/admin/access-log', label: 'Record Access Log', icon: 'history' },
    { path: '/admin/grants', label: 'Access Grants', icon: 'key' },
    { path: '/admin/clinicians', label: 'Clinicians', icon: 'stethoscope' },
    { path: '/admin/patients', label: 'Patients', icon: 'people' },
    { path: '/admin/hospitals', label: 'Hospitals', icon: 'local_hospital' },
    { path: '/admin/users', label: 'Users', icon: 'people_alt', systemAdminOnly: true },
    { path: '/admin/roster', label: 'Patient Roster', icon: 'people' },
    { path: '/admin/costs', label: 'Cost Model', icon: 'analytics' },
    { path: '/admin/sync', label: 'Sync Status', icon: 'sync' },
    { path: '/admin/breakglass', label: 'Break-Glass Review', icon: 'gavel' },
    { path: '/admin/screen-captures', label: 'Screenshot Attempts', icon: 'screenshot' },
    { path: '/admin/events', label: 'Ledger Events', icon: 'receipt_long' },
  ],
};

const ROLE_HOME = {
  patient: '/patient',
  clinician: '/clinician',
  hospital_admin: '/admin',
  system_admin: '/admin',
};

const SECTION_LABELS = {
  '/patient': 'Patient Portal',
  '/clinician': 'Clinician Portal',
  '/admin': 'Admin Dashboard',
};

function roleLabel(roles) {
  if (!roles || !roles.length) return '';
  const map = { patient: 'Patient', clinician: 'Clinician', hospital_admin: 'Hospital Admin', system_admin: 'System Admin' };
  return roles.map(r => map[r] || r).join(', ');
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [authConfig, setAuthConfig] = useState(null);
  const [session, setSession] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const location = useLocation();

  const refresh = useCallback(async () => {
    setSession(await fetchSession());
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const config = await fetchAuthConfig();
        await completeOidcRedirect(config);
        setAuthConfig(config);
        if (config.mode !== 'off') setSession(await fetchSession());
      } catch (e) {
        setAuthError(e.message);
      }
    })();
    const onUnauthorized = () => setSession(null);
    window.addEventListener('patientchain:unauthorized', onUnauthorized);
    return () => window.removeEventListener('patientchain:unauthorized', onUnauthorized);
  }, []);

  const authOn = authConfig && authConfig.mode !== 'off';
  const tabs = authOn
    ? ['/patient', '/clinician', '/admin'].filter(t => allowedTabs(session).includes(t))
    : ['/patient', '/clinician', '/admin'];

  const sessionValue = useMemo(
    () => ({ session: authOn ? session : null, authMode: authConfig?.mode || 'off', refresh, logout: () => logout(authConfig) }),
    [authOn, session, authConfig, refresh]
  );

  useEffect(() => {
    const check = () => api.health().then(setHealth).catch(() => setHealth(null));
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, []);

  // Pending access requests (patient notification). Loaded once, then
  // refreshed only when the ledger reports a change to this patient's
  // grants (event-driven, Section 3.4.4), not by polling.
  const checkPending = useCallback(() => {
    if (!authOn || !session?.patientDID) return;
    api.getGrantsForPatient(session.patientDID)
      .then(grants => setPendingCount(grants.filter(g => g.status === 'PENDING').length))
      .catch(() => {});
  }, [authOn, session?.patientDID]);
  useEffect(() => { checkPending(); }, [checkPending]);
  useLedgerEvents(checkPending, {
    enabled: Boolean(authOn && session?.patientDID),
    types: ['AccessRequested', 'AccessGranted', 'AccessRevoked', 'BreakGlassAccess'],
  });

  // Determine which section we're in for the sidebar
  const currentSection = tabs.find(t => location.pathname.startsWith(t)) || tabs[0];
  const isSystemAdmin = !authOn || Boolean(session?.superuser || session?.roles?.includes('system_admin'));
  const sidebarItems = (currentSection ? (NAV_ITEMS[currentSection] || []) : []).filter(i => !i.systemAdminOnly || isSystemAdmin);

  // Default home based on role
  const defaultHome = session?.roles?.[0] ? (ROLE_HOME[session.roles[0]] || '/patient') : '/patient';

  // If not authenticated yet
  if (!authConfig && !authError) return null;
  if (authOn && !session) {
    return (
      <>
        {authError && <div className="error-banner" style={{ margin: 16 }}>{authError}</div>}
        <Login authConfig={authConfig} onLoggedIn={refresh} />
      </>
    );
  }

  return (
    <SessionContext.Provider value={sessionValue}>
      <Watermark session={authOn ? session : null} demo={!authOn} />
      <div className="app-layout">
        {/* Sidebar */}
        <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
          <div className="sidebar-brand">
            <Link to="/" className="sidebar-logo-link">
              <img src="/Gradient C Medical App Icon.png" alt="Cevruni" className="sidebar-icon" />
              {sidebarOpen && <span className="sidebar-brand-name">Cevruni</span>}
            </Link>
          </div>

          {/* Section switcher */}
          <div className="sidebar-sections">
            {tabs.map(t => (
              <NavLink
                key={t}
                to={t}
                className={({ isActive }) =>
                  `sidebar-section-btn ${location.pathname.startsWith(t) ? 'active' : ''}`
                }
              >
                <span className="sidebar-section-icon">
                  {t === '/patient' ? '\u{1F464}' : t === '/clinician' ? '\u{1FA7A}' : '\u{1F3E5}'}
                </span>
                {sidebarOpen && <span>{SECTION_LABELS[t]}</span>}
              </NavLink>
            ))}
          </div>

          {/* Section nav items */}
          <nav className="sidebar-nav">
            {sidebarOpen && <span className="sidebar-nav-label">{SECTION_LABELS[currentSection]}</span>}
            {sidebarItems.map(item => {
              const badge = item.path === '/patient/access' && pendingCount > 0 ? pendingCount : 0;
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === currentSection}
                  className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
                >
                  <span className="sidebar-nav-icon">{navIcon(item.icon)}</span>
                  {sidebarOpen && <span>{item.label}</span>}
                  {badge > 0 && <span className="sidebar-badge">{badge}</span>}
                </NavLink>
              );
            })}
          </nav>

          {/* User info at bottom */}
          {authOn && session && (
            <div className="sidebar-user">
              <div className="sidebar-user-avatar">
                {(session.sub || 'U')[0].toUpperCase()}
              </div>
              {sidebarOpen && (
                <div className="sidebar-user-info">
                  <span className="sidebar-user-name">{session.sub}</span>
                  <span className="sidebar-user-role">{roleLabel(session.roles)}</span>
                </div>
              )}
              {sidebarOpen && (
                <button className="sidebar-signout" onClick={sessionValue.logout} title="Sign out">
                  &#x2192;
                </button>
              )}
            </div>
          )}

          <button className="sidebar-toggle" onClick={() => setSidebarOpen(o => !o)} title={sidebarOpen ? 'Collapse' : 'Expand'}>
            {sidebarOpen ? '\u276E' : '\u276F'}
          </button>
        </aside>

        {/* Main area */}
        <div className="app-main">
          <header className="top-bar">
            <div className="top-bar-left">
              <h1 className="top-bar-title">{SECTION_LABELS[currentSection] || 'Cevruni'}</h1>
            </div>
            <div className="top-bar-right">
              {health && (
                <>
                  <span className={`top-status ${health.connectivity === 'online' ? 'online' : 'offline'}`}>
                    <span className="top-status-dot" />
                    {health.connectivity}
                  </span>
                  <span className="top-status">
                    Ledger: <strong>{health.ledgerMode}</strong>
                  </span>
                </>
              )}
              {!health && <span className="top-status offline"><span className="top-status-dot" />backend unreachable</span>}
            </div>
          </header>

          <main className="main-content">
            {authError && <div className="error-banner">{authError}</div>}
            <Routes>
              <Route path="/" element={<Navigate to={authOn ? defaultHome : '/patient'} replace />} />
              {tabs.includes('/patient') && <Route path="/patient/*" element={<PatientApp />} />}
              {tabs.includes('/clinician') && <Route path="/clinician/*" element={<ClinicianPortal />} />}
              {tabs.includes('/admin') && <Route path="/admin/*" element={<AdminDashboard />} />}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </SessionContext.Provider>
  );
}

function navIcon(name) {
  const icons = {
    fingerprint: '\u{1F91A}',
    description: '\u{1F4CB}',
    shield: '\u{1F6E1}',
    history: '\u{1F553}',
    key: '\u{1F511}',
    warning: '\u{26A0}',
    folder_open: '\u{1F4C2}',
    dashboard: '\u{1F4CA}',
    local_hospital: '\u{1F3E5}',
    people: '\u{1F465}',
    analytics: '\u{1F4C8}',
    sync: '\u{1F504}',
    gavel: '\u{2696}',
    receipt_long: '\u{1F4DC}',
    people_alt: '\u{1F9D1}\u{200D}\u{1F4BC}',
    screenshot: '\u{1F4F7}',
    stethoscope: '\u{1FA7A}',
  };
  return icons[name] || '\u{25CF}';
}
