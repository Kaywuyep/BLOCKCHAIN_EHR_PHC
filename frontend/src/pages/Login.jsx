import { useState } from 'react';
import { localLogin, passwordHint, passwordLogin, signUp, startOidcLogin } from '../auth';

const ROLES = [
  { value: 'patient', label: 'Patient', icon: 'person', desc: 'View and manage your health records' },
  { value: 'clinician', label: 'Clinician', icon: 'stethoscope', desc: 'Access patient records for treatment' },
  { value: 'hospital_admin', label: 'Hospital Admin', icon: 'local_hospital', desc: 'Manage hospital operations' },
  { value: 'system_admin', label: 'System Admin', icon: 'admin_panel_settings', desc: 'Full system administration' },
];

// Demo accounts (see docs/demo-guide.md). AUTH_MODE=local only.
const DEMO_ACCOUNTS = [
  { subject: 'superadmin', role: 'system_admin', label: 'Super Admin', hospitalID: '' },
  { subject: 'admin-langtang', role: 'hospital_admin', label: 'Langtang Hospital Admin', hospitalID: 'general-hospital-langtang' },
  { subject: 'dr-musa', role: 'clinician', label: 'Dr. Musa (Langtang)', hospitalID: 'general-hospital-langtang' },
  { subject: 'dr-bello', role: 'clinician', label: 'Dr. Bello (JUTH)', hospitalID: 'jos-university-teaching-hospital' },
  { subject: 'lab-sani', role: 'clinician', label: 'Sani, Lab Scientist', hospitalID: 'general-hospital-langtang' },
  { subject: 'amina', role: 'patient', label: 'Amina (Patient)', hospitalID: '' },
  { subject: 'ibrahim', role: 'patient', label: 'Ibrahim (Patient)', hospitalID: '' },
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

  async function quickLogin(account) {
    setBusy(true);
    setError(null);
    try {
      await localLogin({
        subject: account.subject,
        role: account.role,
        hospitalID: account.hospitalID || undefined,
      });
      await onLoggedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (authConfig.mode === 'password') return <PasswordLogin onLoggedIn={onLoggedIn} />;

  if (authConfig.mode === 'oidc') {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-brand">
            <img src="/Gradient C Medical App Icon.png" alt="Cevruni" className="login-icon" />
            <img src="/Cevruni Health Logo.png" alt="Cevruni Health" className="login-logo" />
          </div>
          <h2 className="login-heading">Sign in with your hospital account</h2>
          <p className="login-sub">Cevruni uses your hospital's identity provider.</p>
          <button className="login-btn login-btn-primary" onClick={() => startOidcLogin(authConfig)}>
            Continue to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <LoginHero />

      <div className="login-right">
        <div className="login-card">
          <div className="login-brand-sm">
            <img src="/Gradient C Medical App Icon.png" alt="Cevruni" className="login-icon" />
            <span className="login-brand-name">Cevruni</span>
          </div>

          <h2 className="login-heading">
            Welcome back <span className="login-wave" aria-hidden="true">&#x1F44B;</span>
          </h2>
          <p className="login-sub">Sign in to your account to continue</p>

          {error && <div className="login-error">{error}</div>}

          <div className="login-quick">
            <span className="login-quick-label">Quick access</span>
            <div className="login-quick-btns">
              {DEMO_ACCOUNTS.map((a) => (
                <button
                  key={a.subject}
                  className="login-quick-btn"
                  onClick={() => quickLogin(a)}
                  disabled={busy}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          <div className="login-divider">
            <span>or sign in manually</span>
          </div>

          <form className="login-form" onSubmit={submit}>
            <div className="login-field">
              <label>Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="login-field">
              <label>{role === 'clinician' ? 'Provider ID' : 'User ID'}</label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
                placeholder="e.g. amina or dr-musa"
              />
            </div>
            {staff && (
              <div className="login-field">
                <label>Hospital ID</label>
                <input
                  value={hospitalID}
                  onChange={(e) => setHospitalID(e.target.value)}
                  required
                  placeholder="e.g. hospital-a"
                />
              </div>
            )}
            <button className="login-btn login-btn-primary" type="submit" disabled={busy}>
              {busy ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <p className="login-footer">
            Secured by blockchain technology
          </p>
        </div>
      </div>
    </div>
  );
}

const HERO_FEATURES = [
  {
    title: 'Blockchain-secured',
    text: 'Every access is immutably recorded on-chain',
    icon: (
      <>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
  },
  {
    title: 'Multi-hospital',
    text: 'One identity across all your healthcare providers',
    icon: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M12 7v6M9 10h6M10 21v-4h4v4" />
      </>
    ),
  },
  {
    title: 'Patient-controlled',
    text: 'You decide who sees your records and for how long',
    icon: (
      <>
        <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
        <path d="M9 12l2 2 4-4" />
      </>
    ),
  },
];

function LoginHero() {
  return (
    <div className="login-left">
      <div className="login-left-content">
        <div className="login-hero-brand">
          <span className="login-hero-mark">
            <img src="/icon-192.png" alt="" />
          </span>
          <span className="login-hero-name">Cevruni</span>
        </div>
        <p className="login-hero-tagline">Your health. Your records. Your control.</p>
        <ul className="login-hero-features">
          {HERO_FEATURES.map((f) => (
            <li key={f.title} className="login-feature">
              <span className="login-feature-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {f.icon}
                </svg>
              </span>
              <div>
                <strong>{f.title}</strong>
                <p>{f.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * AUTH_MODE=password. Everyone signs in here with a password:
 *   patients    with the email they signed up with;
 *   staff       with the username their admin gave them
 *               (admin@<hospital> or <staff ID>@<hospital>).
 * Only patients create their own account; staff accounts come from the
 * system admin (hospital admins) or the hospital admin (clinicians, from
 * the hospital's EMR).
 */
function PasswordLogin({ onLoggedIn }) {
  const [tab, setTab] = useState('signin');
  const [form, setForm] = useState({ login: '', password: '', fullName: '', email: '', newPassword: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onLoggedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function submitSignIn(e) {
    e.preventDefault();
    run(() => passwordLogin({ login: form.login.trim(), password: form.password }));
  }

  function submitSignUp(e) {
    e.preventDefault();
    if (form.newPassword !== form.confirm) {
      setError('The two passwords do not match');
      return;
    }
    run(() => signUp({ fullName: form.fullName.trim(), email: form.email.trim(), password: form.newPassword }));
  }

  const hint = passwordHint(form.newPassword);

  return (
    <div className="login-page">
      <LoginHero />
      <div className="login-right">
        <div className="login-card">
          <div className="login-brand-sm">
            <img src="/Gradient C Medical App Icon.png" alt="Cevruni" className="login-icon" />
            <span className="login-brand-name">Cevruni</span>
          </div>

          {tab === 'signin' ? (
            <>
              <h2 className="login-heading">
                Welcome back <span className="login-wave" aria-hidden="true">&#x1F44B;</span>
              </h2>
              <p className="login-sub">Sign in to your account to continue</p>
            </>
          ) : (
            <>
              <h2 className="login-heading">Create your account</h2>
              <p className="login-sub">Patients sign up here; staff accounts come from their hospital</p>
            </>
          )}

          <div className="login-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'signin'} className={tab === 'signin' ? 'active' : ''} onClick={() => { setTab('signin'); setError(null); }}>
              Sign in
            </button>
            <button role="tab" aria-selected={tab === 'signup'} className={tab === 'signup' ? 'active' : ''} onClick={() => { setTab('signup'); setError(null); }}>
              Create patient account
            </button>
          </div>

          {error && <div className="login-error" role="alert">{error}</div>}

          {tab === 'signin' ? (
            <form className="login-form" onSubmit={submitSignIn}>
              <div className="login-field">
                <label htmlFor="login">Email or username</label>
                <input id="login" value={form.login} onChange={set('login')} required autoComplete="username" placeholder="you@example.com" />
              </div>
              <div className="login-field">
                <label htmlFor="password">Password</label>
                <input id="password" type="password" value={form.password} onChange={set('password')} required autoComplete="current-password" />
              </div>
              <button className="login-btn login-btn-primary" type="submit" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <p className="login-note">
                Hospital staff: use the username your admin gave you, e.g. <code>admin@your-hospital</code> or <code>staffID@your-hospital</code>.
                Forgot your password? Ask your hospital admin (or the system admin) for a temporary one.
              </p>
            </form>
          ) : (
            <form className="login-form" onSubmit={submitSignUp}>
              <div className="login-field">
                <label htmlFor="fullName">Full name</label>
                <input id="fullName" value={form.fullName} onChange={set('fullName')} required autoComplete="name" placeholder="First name and surname" />
              </div>
              <div className="login-field">
                <label htmlFor="email">Email</label>
                <input id="email" type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
              </div>
              <div className="login-field">
                <label htmlFor="newPassword">Password</label>
                <input id="newPassword" type="password" value={form.newPassword} onChange={set('newPassword')} required autoComplete="new-password" />
                <span className={`login-hint ${hint ? 'warn' : form.newPassword ? 'ok' : ''}`}>
                  {hint || (form.newPassword ? 'Looks good' : 'At least 10 characters, with a letter and a number')}
                </span>
              </div>
              <div className="login-field">
                <label htmlFor="confirm">Confirm password</label>
                <input id="confirm" type="password" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" />
              </div>
              <button className="login-btn login-btn-primary" type="submit" disabled={busy || Boolean(hint)}>
                {busy ? 'Creating your account…' : 'Create account'}
              </button>
              <p className="login-note">
                Your account is recorded on the blockchain. Your name and email stay off it. Next you'll confirm your record at your
                first hospital to get your Health ID.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
