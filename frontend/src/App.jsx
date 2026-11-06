import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, NavLink, Link } from 'react-router-dom';
import './tokens.css';
import './shell.css';
import { Landing } from './pages/Landing';
import { PatientApp } from './pages/PatientApp';
import { ClinicianPortal } from './pages/ClinicianPortal';
import { AdminDashboard } from './pages/AdminDashboard';
import { api } from './api';

const TABS = [
  { path: '/patient', label: 'Patient App' },
  { path: '/clinician', label: 'Clinician Portal' },
  { path: '/admin', label: 'Admin Dashboard' },
];

export default function App() {
  const [health, setHealth] = useState(null);

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
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <NavLink key={t.path} to={t.path} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            {t.label}
          </NavLink>
        ))}
      </nav>

      <main className="main">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/patient" element={<PatientApp />} />
          <Route path="/clinician" element={<ClinicianPortal />} />
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
