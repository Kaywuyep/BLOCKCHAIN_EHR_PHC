import { useState } from 'react';
import { changePassword, passwordHint } from '../auth';

/**
 * Change password (AUTH_MODE=password). `forced` is the screen shown after
 * signing in with a temporary password: nothing else works until it is
 * changed. Otherwise it is a dialog opened from the sidebar.
 */
export function ChangePassword({ forced = false, session, onDone, onCancel, onSignOut }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const hint = passwordHint(form.next);

  async function submit(e) {
    e.preventDefault();
    if (form.next !== form.confirm) {
      setError('The two new passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword({ currentPassword: form.current, newPassword: form.next });
      setDone(true);
      await onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const card = (
    <div className="login-card">
      <h2 className="login-heading">{forced ? 'Choose your own password' : 'Change password'}</h2>
      <p className="login-sub">
        {forced
          ? `You signed in as ${session?.login || session?.sub} with a temporary password. Choose a new one to continue.`
          : 'Enter your current password, then the new one.'}
      </p>
      {error && <div className="login-error" role="alert">{error}</div>}
      {done && !forced && <div className="login-hint ok">Password changed.</div>}
      <form className="login-form" onSubmit={submit}>
        <div className="login-field">
          <label htmlFor="cp-current">{forced ? 'Temporary password' : 'Current password'}</label>
          <input id="cp-current" type="password" value={form.current} onChange={set('current')} required autoComplete="current-password" />
        </div>
        <div className="login-field">
          <label htmlFor="cp-next">New password</label>
          <input id="cp-next" type="password" value={form.next} onChange={set('next')} required autoComplete="new-password" />
          <span className={`login-hint ${hint ? 'warn' : form.next ? 'ok' : ''}`}>
            {hint || (form.next ? 'Looks good' : 'At least 10 characters, with a letter and a number; not your name or username')}
          </span>
        </div>
        <div className="login-field">
          <label htmlFor="cp-confirm">Confirm new password</label>
          <input id="cp-confirm" type="password" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" />
        </div>
        <button className="login-btn login-btn-primary" type="submit" disabled={busy || Boolean(hint)}>
          {busy ? 'Saving…' : 'Save new password'}
        </button>
        {forced ? (
          <button type="button" className="login-btn login-btn-secondary" onClick={onSignOut}>Sign out</button>
        ) : (
          <button type="button" className="login-btn login-btn-secondary" onClick={onCancel}>Close</button>
        )}
      </form>
    </div>
  );

  if (forced) {
    return (
      <div className="login-page">
        <div className="login-right" style={{ maxWidth: '100%' }}>{card}</div>
      </div>
    );
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Change password" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal-panel">{card}</div>
    </div>
  );
}
