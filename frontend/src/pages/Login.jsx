import { useState } from 'react';
import { localLogin, startOidcLogin } from '../auth';

const ROLES = [
  { value: 'patient', label: 'Patient' },
  { value: 'clinician', label: 'Clinician' },
  { value: 'hospital_admin', label: 'Hospital admin' },
  { value: 'system_admin', label: 'System admin' },
];

export function Login({ authConfig, onLoggedIn }) {
  const [subject, setSubject] = useState('');
  const [role, setRole] = useState('patient');
  const [hospitalID, setHospitalID] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const staff = role === 'clinician' || role === 'hospital_admin';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await localLogin({ subject: subject.trim(), role, hospitalID: staff ? hospitalID.trim() : undefined });
      await onLoggedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (authConfig.mode === 'oidc') {
    return (
      <div className="panel login-panel">
        <span className="eyebrow">Sign in</span>
        <h2>Sign in with your hospital account</h2>
        <p>PatientChain uses your hospital's identity provider. Your role and hospital come from your account.</p>
        <button className="btn btn-primary" onClick={() => startOidcLogin(authConfig)}>
          Continue to sign in
        </button>
      </div>
    );
  }

  return (
    <form className="panel login-panel" onSubmit={submit}>
      <span className="eyebrow">Development sign-in</span>
      <h2>Sign in</h2>
      <p>
        AUTH_MODE=local: this form issues a development token for any identity, with no password. It is disabled in
        production, where sign-in goes through the hospital's identity provider.
      </p>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label>Role</label>
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>{role === 'clinician' ? 'Provider ID' : 'User ID'}</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} required placeholder="e.g. amina or dr-musa" />
      </div>
      {staff && (
        <div className="field">
          <label>Hospital ID</label>
          <input value={hospitalID} onChange={(e) => setHospitalID(e.target.value)} required />
        </div>
      )}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        Sign in
      </button>
    </form>
  );
}
