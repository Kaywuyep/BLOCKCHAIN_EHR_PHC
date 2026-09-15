import { useEffect, useState } from 'react';
import './tokens.css';
import './shell.css';
import { PatientApp } from './pages/PatientApp';
import { ClinicianPortal } from './pages/ClinicianPortal';
import { AdminDashboard } from './pages/AdminDashboard';
import { api } from './api';

const TABS = [
  { id: 'patient', label: 'Patient App', component: PatientApp },
  { id: 'clinician', label: 'Clinician Portal', component: ClinicianPortal },
  { id: 'admin', label: 'Admin Dashboard', component: AdminDashboard },
];

export default function App() {
  const [active, setActive] = useState('patient');
  const [health, setHealth] = useState(null);

  useEffect(() => {
    const check = () => api.health().then(setHealth).catch(() => setHealth(null));
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, []);

  const ActiveComponent = TABS.find((t) => t.id === active)?.component ?? PatientApp;

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-title">
          <span className="mark" />
          <h1>PatientChain</h1>
          <span className="subtitle">Blockchain-based patient-controlled access &amp; reference system</span>
        </div>
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
          <button
            key={t.id}
            className={`tab ${active === t.id ? 'active' : ''}`}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="main">
        <ActiveComponent />
      </main>
    </div>
  );
}
