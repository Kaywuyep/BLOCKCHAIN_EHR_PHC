import { useCallback, useEffect, useMemo, useState } from 'react';
import { Routes, Route, Navigate, NavLink, Link } from 'react-router-dom';
import './tokens.css';
import './shell.css';
import { Landing } from './pages/Landing';
import { PatientApp } from './pages/PatientApp';
import { ClinicianPortal } from './pages/ClinicianPortal';
import { AdminDashboard } from './pages/AdminDashboard';
import { Login } from './pages/Login';
import { api } from './api';
import { SessionContext, allowedTabs, completeOidcRedirect, fetchAuthConfig, fetchSession, logout } from './auth';

const TABS = [
  { path: '/patient', label: 'Patient App' },
  { path: '/clinician', label: 'Clinician Portal' },
  { path: '/admin', label: 'Admin Dashboard' },
];

export default function App() {
  const [health, setHealth] = useState(null);
  const [authConfig, setAuthConfig] = useState(null);
  const [session, setSession] = useState(null);
  const [authError, setAuthError] = useState(null);

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
  const tabs = authOn ? TABS.filter((t) => allowedTabs(session).includes(t.path)) : TABS;
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

  return (
    <div className="shell">
      <header className="shell-header">
        <Link to="/" className="shell-title">
          <span className="mark" />
          <h1>PatientChain</h1>
          <span className="subtitle">Blockchain-based patient-controlled access &amp; reference system</span>
        </Link>
        <div className="shell-status">
          {health && (
            <>
              <span className="status-pill">
                ledger: <strong className="data">{health.ledgerMode}</strong>
              </span>
              <span className={`status-pill ${health.connectivity === 'online' ? 'online' : 'offline'}`}>
                <span className="dot" />
                {health.connectivity}
              </span>
            </>
          )}
          {!health && <span className="status-pill offline"><span className="dot" />backend unreachable</span>}
          {authOn && session && (
            <span className="status-pill">
              <span className="data">{session.sub}</span> · {session.roles.join(', ')}
              {session.hospitalID ? ` @ ${session.hospitalID}` : ''}
              <button className="link-button" onClick={sessionValue.logout}>
                Sign out
              </button>
            </span>
          )}
        </div>
      </header>

      {authError && <div className="error-banner">{authError}</div>}
      {!authConfig && !authError ? null : authOn && !session ? (
        <main className="main">
          <Login authConfig={authConfig} onLoggedIn={refresh} />
        </main>
      ) : (
      <SessionContext.Provider value={sessionValue}>
      <nav className="tabs">
        {tabs.map((t) => (
          <NavLink key={t.path} to={t.path} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            {t.label}
          </NavLink>
        ))}
      </nav>

      <main className="main">
        <Routes>
          <Route
            path="/"
            element={
              !authOn ? (
                <Landing />
              ) : tabs[0] ? (
                <Navigate to={tabs[0].path} replace />
              ) : (
                <div className="panel">This account has no pages in the web app.</div>
              )
            }
          />
          {tabs.some((t) => t.path === '/patient') && <Route path="/patient" element={<PatientApp />} />}
          {tabs.some((t) => t.path === '/clinician') && <Route path="/clinician" element={<ClinicianPortal />} />}
          {tabs.some((t) => t.path === '/admin') && <Route path="/admin" element={<AdminDashboard />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      </SessionContext.Provider>
      )}
    </div>
  );
}
