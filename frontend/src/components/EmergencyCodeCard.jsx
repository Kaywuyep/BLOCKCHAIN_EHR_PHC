import { useEffect, useState } from 'react';
import { api } from '../api';
import './emergencyCode.css';

/**
 * EmergencyCodeCard — the patient's 7-character emergency code, on the
 * Health ID page. Family can give it to a clinician in an emergency when
 * nobody knows a hospital number; the clinician then sees the hospitals in
 * the patient's network and can open break-glass at one of them. Every use
 * shows here and on the audit trail. Replacing the code stops the old one.
 */
export function EmergencyCodeCard({ patientDID }) {
  const [code, setCode] = useState(null);
  const [shown, setShown] = useState(false);
  const [uses, setUses] = useState([]);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      setCode(await api.getEmergencyCode(patientDID));
      const trail = await api.getAuditTrail(patientDID).catch(() => []);
      setUses(trail.filter((e) => e.eventType === 'EMERGENCY_CODE_USED' || e.eventType === 'EMERGENCY_CODE_REPLACED').reverse().slice(0, 5));
      setError(null);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { if (patientDID) load(); }, [patientDID]);

  async function replace() {
    setConfirm(false);
    try {
      setCode(await api.regenerateEmergencyCode(patientDID));
      setShown(true);
      await load();
    } catch (e) { setError(e.message); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(code.code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }

  // Prints only this card (see emergencyCode.css); the screen shield lets
  // this one print through because it is the patient's own code.
  function printCard() {
    const done = () => document.body.classList.remove('ec-printing');
    document.body.classList.add('ec-printing');
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    setTimeout(done, 1000);
  }

  return (
    <div className="panel ec-card">
      <div className="panel-head">
        <div><span className="eyebrow">For emergencies</span><h2>Your emergency code</h2></div>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        If you are ever brought to a hospital unable to speak and nobody knows your hospital number, a family member can give
        this code to the doctor. It shows the doctor which hospitals hold your records so they can open your emergency
        information for one hour. Every use appears below and in your Audit Trail. Keep it with your next of kin, on your phone or printed in your wallet.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {code && (
        <div className="ec-print">
          <div className="ec-code-row">
            <span className={`ec-code ${shown ? '' : 'hidden'}`} data-allow-copy aria-label={shown ? `Emergency code ${code.code.split('').join(' ')}` : 'Emergency code hidden'}>
              {shown ? code.code : '•••••••'}
            </span>
            <button className="btn btn-ghost" onClick={() => setShown((v) => !v)}>{shown ? 'Hide' : 'Show'}</button>
            {shown && <button className="btn btn-ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>}
            {shown && <button className="btn btn-ghost" onClick={printCard}>Print card</button>}
          </div>
          <div className="hint">Created {new Date(code.createdAt).toLocaleDateString('en-NG')}</div>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        {confirm ? (
          <span className="inline-warn" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            The old code will stop working at once.
            <button className="btn btn-danger-solid" onClick={replace}>Replace code</button>
            <button className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
          </span>
        ) : (
          <button className="btn btn-ghost" onClick={() => setConfirm(true)}>Replace code (if someone you don’t trust has it)</button>
        )}
      </div>
      {uses.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 16 }}>Recent uses</div>
          <ul className="ec-uses">
            {uses.map((u) => (
              <li key={u.entryID || u.timestamp}>{new Date(u.timestamp).toLocaleString('en-NG')} · {u.detail}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
