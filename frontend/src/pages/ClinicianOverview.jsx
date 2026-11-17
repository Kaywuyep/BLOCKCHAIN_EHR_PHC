import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../auth';
import { useLedgerEvents } from '../ledgerEvents';
import './admin.css';
import './viewRecords.css';

/**
 * ClinicianOverview — the clinician's home page.
 *
 *   - who they are here (name, role, department, hospital, status);
 *   - headline numbers: records they can open now, requests waiting for
 *     patients, emergency accesses open, access ending soon;
 *   - "Ready to open" and "Waiting for the patient" lists;
 *   - their own recent activity, read from the ledger audit trail.
 *
 * Everything comes from the ledger (grants and audit entries naming this
 * clinician) and refreshes when the ledger reports a change.
 */

const ENDING_SOON_MS = 15 * 60 * 1000;

const ACTIVITY_LABEL = {
  RECORD_ACCESSED: 'Opened records',
  BREAK_GLASS_ACCESS: 'Emergency access opened',
  BREAK_GLASS_EXTENDED: 'Emergency access extended',
  BREAK_GLASS_REVIEWED: 'Emergency access reviewed',
  EMERGENCY_CODE_USED: 'Used a patient’s emergency code',
  SCREEN_CAPTURE_ATTEMPT: 'Screenshot attempt recorded',
};

function isLive(g) {
  return g.status === 'ACTIVE' && (!g.expiresAt || new Date(g.expiresAt) > new Date());
}

function minutesLeft(expiresAt) {
  const ms = new Date(expiresAt) - Date.now();
  if (ms <= 0) return 'ended';
  const h = Math.floor(ms / 3600000);
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${h} h ${Math.round((ms % 3600000) / 60000)} min left`;
  return `${Math.max(1, Math.round(ms / 60000))} min left`;
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - new Date(ts)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function Stat({ value, label, tone, to }) {
  return (
    <Link to={to} className="stat-link">
      <div className={`dash-card ${tone ? `tone-${tone}` : ''}`}>
        <p className="stat-value">{value ?? '—'}</p>
        <p>{label}</p>
      </div>
    </Link>
  );
}

export function ClinicianOverview({ profile, hospitalName }) {
  const { session } = useSession();
  const [grants, setGrants] = useState(null);
  const [activity, setActivity] = useState(null);
  const [error, setError] = useState(null);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const [g, a] = await Promise.all([api.getMyProviderGrants(), api.getMyActivity()]);
      setGrants(g);
      setActivity(a);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useLedgerEvents(() => load());
  // Keep "min left" current.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const s = useMemo(() => {
    const list = grants || [];
    const live = list.filter(isLive).sort((a, b) => new Date(a.expiresAt || 0) - new Date(b.expiresAt || 0));
    const pending = list.filter((g) => g.status === 'PENDING').sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
    const weekAgo = Date.now() - 7 * 86400000;
    const acts = activity || [];
    return {
      live,
      pending,
      emergency: live.filter((g) => g.grantType === 'BREAK_GLASS'),
      endingSoon: live.filter((g) => g.expiresAt && new Date(g.expiresAt) - Date.now() < ENDING_SOON_MS),
      opened7: acts.filter((e) => e.eventType === 'RECORD_ACCESSED' && new Date(e.timestamp) >= weekAgo).length,
      patients7: new Set(acts.filter((e) => ['RECORD_ACCESSED', 'BREAK_GLASS_ACCESS'].includes(e.eventType) && new Date(e.timestamp) >= weekAgo).map((e) => e.patientDID)).size,
      unreviewed: list.filter((g) => g.grantType === 'BREAK_GLASS' && !g.reviewed).length,
    };
  }, [grants, activity]);

  // Patient names come from the grants (the hospitals' own rosters).
  const nameByDid = useMemo(() => {
    const m = new Map();
    for (const g of grants || []) if (g.patientName) m.set(g.patientDID, g.patientName);
    return m;
  }, [grants]);

  const displayName = profile?.name || session?.displayName || session?.providerID || 'Clinician';
  const notActive = profile && profile.status && profile.status !== 'ACTIVE';

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      <div className="dash-welcome">
        <h2>{greeting()}, {displayName}</h2>
        <p>
          {[profile?.role, profile?.department, hospitalName].filter(Boolean).join(' · ') || hospitalName}
          {' — '}records from other hospitals that patients have shared with you, and your own access history.
        </p>
      </div>

      {notActive && (
        <div className="error-banner">
          Your hospital’s staff register shows you as {String(profile.status).toLowerCase()}. You can’t open records until your hospital admin changes this.
        </div>
      )}

      <div className="dash-grid">
        <Stat value={grants ? s.live.length : null} label="Patients’ records you can open now" to="/clinician/records" />
        <Stat value={grants ? s.pending.length : null} label="Requests waiting for the patient" to="/clinician/records" tone={s.pending.length ? 'info' : ''} />
        <Stat value={grants ? s.emergency.length : null} label="Emergency accesses open now" to="/clinician/records" tone={s.emergency.length ? 'warn' : ''} />
        <Stat value={grants ? s.endingSoon.length : null} label="Access ending within 15 minutes" to="/clinician/records" tone={s.endingSoon.length ? 'warn' : ''} />
        <Stat value={activity ? s.opened7 : null} label={`Times you opened records, last 7 days (${s.patients7} patient${s.patients7 === 1 ? '' : 's'})`} to="/clinician/records" />
        <Stat value={grants ? s.unreviewed : null} label="Your emergency accesses awaiting admin review" to="/clinician/records" />
      </div>

      <div className="quick-actions">
        <Link className="btn btn-primary" to="/clinician/request">Request a patient’s records</Link>
        <Link className="btn" to="/clinician/records">View records</Link>
        <Link className="btn btn-danger" to="/clinician/emergency">Emergency access</Link>
      </div>

      <div className="overview-columns">
        <div className="panel">
          <div className="panel-head">
            <div><span className="eyebrow">Patients have said yes</span><h2>Ready to open</h2></div>
            <Link className="btn btn-ghost" to="/clinician/records">View all</Link>
          </div>
          {grants && !s.live.length && <p className="hint">Nothing open right now. When a patient approves a request, it appears here.</p>}
          {s.live.slice(0, 6).map((g) => (
            <Link key={g.grantID} to="/clinician/records" className="overview-row">
              <div>
                <div className="cell-title">
                  {g.patientName || 'Patient'}
                  {g.grantType === 'BREAK_GLASS' && <span className="pill pill-bad" style={{ marginLeft: 8 }}>Emergency</span>}
                </div>
                <div className="cell-sub">records at {g.recordsAtName || g.hospitalID}</div>
              </div>
              <span className={`cell-sub nowrap ${g.expiresAt && new Date(g.expiresAt) - Date.now() < ENDING_SOON_MS ? 'warn' : ''}`}>
                {g.expiresAt ? minutesLeft(g.expiresAt) : 'open'}
              </span>
            </Link>
          ))}
        </div>

        <div className="panel">
          <div className="panel-head">
            <div><span className="eyebrow">Sent, not yet approved</span><h2>Waiting for the patient</h2></div>
          </div>
          {grants && !s.pending.length && <p className="hint">No requests waiting.</p>}
          {s.pending.slice(0, 6).map((g) => (
            <div key={g.grantID} className="overview-row">
              <div>
                <div className="cell-title">{g.patientName || 'Patient'}</div>
                <div className="cell-sub">records at {g.recordsAtName || g.hospitalID}</div>
              </div>
              <span className="cell-sub nowrap">asked {ago(g.requestedAt)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div><span className="eyebrow">From the ledger audit trail</span><h2>Your recent activity</h2></div>
        </div>
        <p className="hint">Every time you open a record or use emergency access it is written to the blockchain. Patients and your hospital admin see the same entries.</p>
        {activity && !activity.length && <p className="hint">No activity yet.</p>}
        {activity && activity.length > 0 && (
          <div className="table-wrap">
            <table className="admin-table">
              <thead><tr><th>When</th><th>What</th><th>Patient</th></tr></thead>
              <tbody>
                {activity.slice(0, 10).map((e) => (
                  <tr key={e.entryID}>
                    <td className="cell-sub nowrap" title={new Date(e.timestamp).toLocaleString()}>{ago(e.timestamp)}</td>
                    <td>
                      {ACTIVITY_LABEL[e.eventType] || e.eventType}
                      {e.eventType.startsWith('BREAK_GLASS') && <span className="pill pill-bad" style={{ marginLeft: 8 }}>Emergency</span>}
                    </td>
                    <td>{nameByDid.get(e.patientDID) || <span className="cell-sub">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
