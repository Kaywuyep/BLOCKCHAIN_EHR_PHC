import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../auth';
import { useLedgerEvents } from '../ledgerEvents';
import { TemporaryPassword } from '../components/TemporaryPassword';
import { clinicianName } from '../people';
import './admin.css';

/**
 * HospitalAdminView — what a hospital's administration sees about its own
 * hospital (Chapter 3: NFR9, Table 3.7 §29, Section 3.4.7):
 *
 *   Overview      headline numbers and what needs attention
 *   Record Access every record access at this hospital: which clinician,
 *                 which patient, when, under which grant (immutable audit trail)
 *   Access Grants every grant covering this hospital's records: scope,
 *                 purpose, role, status, patient-signed or not
 *   Clinicians    registered clinicians, their access activity; register,
 *                 change role or suspend
 *   Patients      patients who have linked their Health ID to this hospital
 *
 * A hospital admin only ever sees their own hospital. A system admin picks
 * a hospital at the top. Everything refreshes when the ledger reports an
 * event (no polling).
 */

const HospitalContext = createContext({ hospitalID: '', setHospitalID: () => {}, hospitals: [] });

const EVENT_LABELS = {
  RECORD_ACCESSED: 'Record accessed',
  BREAK_GLASS_ACCESS: 'Emergency (break-glass) access',
  BREAK_GLASS_REVIEWED: 'Break-glass reviewed',
  GRANT_ISSUED: 'Access granted by patient',
  GRANT_REVOKED: 'Access revoked by patient',
  PATIENT_GRANTED_HOSPITAL: 'Patient granted hospital access',
  CROSS_HOSPITAL_GRANT: 'Patient shared records across hospitals',
  SCREEN_CAPTURE_ATTEMPT: 'Screenshot attempt',
  BREAK_GLASS_EXTENDED: 'Emergency access extended',
  EMERGENCY_CODE_USED: 'Emergency code used',
  EMERGENCY_CODE_REPLACED: 'Emergency code replaced',
  ACCOUNT_CREATED: 'Account created',
  HOSPITAL_REGISTERED: 'Hospital registered',
  CLINICIAN_STATUS_CHANGED: 'Clinician status changed',
};

const CLINICAL_ROLES = ['Physician', 'Consultant', 'Nurse', 'Laboratory Scientist', 'Pharmacist', 'Radiographer', 'Medical Records Officer'];

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}


function useHospitalData(path, params = {}) {
  const { hospitalID } = useContext(HospitalContext);
  const { session } = useSession();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const key = JSON.stringify(params);
  const load = useCallback(async () => {
    if (!hospitalID) return;
    try {
      setData(await api.hospitalAdmin(path, hospitalID, JSON.parse(key)));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [path, hospitalID, key]);
  useEffect(() => {
    load();
  }, [load, session?.sub]);
  useLedgerEvents(() => load(), { enabled: Boolean(hospitalID) });
  return { data, error, reload: load };
}

/** Wraps the hospital pages: fixes the hospital for a hospital admin, offers a picker to a system admin. */
export function HospitalScope({ children }) {
  const { session, authMode } = useSession();
  const isSystemAdmin = authMode === 'off' || Boolean(session?.superuser || session?.roles?.includes('system_admin'));
  const [hospitals, setHospitals] = useState([]);
  const [picked, setPicked] = useState(() => {
    try {
      return localStorage.getItem('cevruni.adminHospital') || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    api.searchHospitals('').then(setHospitals).catch(() => {});
  }, []);
  const hospitalID = isSystemAdmin ? picked || hospitals[0]?.hospitalID || '' : session?.hospitalID || '';
  const setHospitalID = (id) => {
    setPicked(id);
    try {
      localStorage.setItem('cevruni.adminHospital', id);
    } catch {
      // storage unavailable
    }
  };
  const name = hospitals.find((h) => h.hospitalID === hospitalID)?.name || hospitalID;
  const value = useMemo(() => ({ hospitalID, setHospitalID, hospitals, name }), [hospitalID, hospitals, name]);

  return (
    <HospitalContext.Provider value={value}>
      {isSystemAdmin && (
        <div className="hospital-picker">
          <span>Viewing hospital</span>
          <select value={hospitalID} onChange={(e) => setHospitalID(e.target.value)}>
            {hospitals.map((h) => <option key={h.hospitalID} value={h.hospitalID}>{h.name}</option>)}
          </select>
        </div>
      )}
      {hospitalID ? children : <div className="error-banner">Your account is not linked to a hospital.</div>}
    </HospitalContext.Provider>
  );
}

function Stat({ value, label, tone, to }) {
  const body = (
    <div className={`dash-card ${tone ? `tone-${tone}` : ''}`}>
      <p className="stat-value">{value ?? '—'}</p>
      <p>{label}</p>
    </div>
  );
  return to ? <Link to={to} className="stat-link">{body}</Link> : body;
}

export function HospitalOverview() {
  const { name } = useContext(HospitalContext);
  const { data: o, error } = useHospitalData('overview');
  const { data: recent } = useHospitalData('access-log', { limit: 8 });
  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div className="dash-welcome">
        <h2>{name}</h2>
        <p>Records moving between this hospital and others through Cevruni: who opened your patients’ records here, what your clinicians opened elsewhere, and what needs your review.</p>
      </div>
      {o && (
        <div className="dash-grid">
          <Stat value={o.ourRecordsOpenedLast7Days} label="Our records opened by other hospitals (7 days)" to="/admin/access-log" />
          <Stat value={o.ourCliniciansOpenedLast7Days} label="Records our clinicians opened elsewhere (7 days)" to="/admin/access-log" />
          <Stat value={o.emergencyActiveNow} label="Emergency accesses active now" tone={o.emergencyActiveNow ? 'warn' : ''} to="/admin/grants" />
          <Stat value={o.breakGlassAwaitingReview} label="Break-glass awaiting review" tone={o.breakGlassAwaitingReview ? 'warn' : ''} to="/admin/breakglass" />
          <Stat value={o.grants.active} label={`Active grants (${o.grants.pending} pending)`} to="/admin/grants" />
          <Stat value={o.clinicians} label={`Active clinicians${o.cliniciansSuspended ? ` (${o.cliniciansSuspended} suspended)` : ''}`} to="/admin/clinicians" />
          <Stat value={o.linkedPatients} label={`Patients linked (roster: ${o.rosterSize})`} to="/admin/patients" />
          <Stat value={o.screenshotAttemptsLast7Days} label="Screenshot attempts, last 7 days" tone={o.screenshotAttemptsLast7Days ? 'warn' : ''} to="/admin/screen-captures" />
        </div>
      )}
      <div className="panel">
        <div className="panel-head">
          <div><span className="eyebrow">From the ledger audit trail</span><h2>Latest record accesses</h2></div>
          <Link className="btn btn-ghost" to="/admin/access-log">View all</Link>
        </div>
        <AccessTable entries={recent || []} compact />
      </div>
    </div>
  );
}

function AccessTable({ entries, compact = false }) {
  if (!entries.length) return <p className="hint">No record accesses yet.</p>;
  return (
    <div className="table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Clinician</th>
            <th>Patient</th>
            <th>Records at</th>
            <th>Event</th>
            {!compact && <th>Details</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.entryID} className={e.breakGlass ? 'row-warn' : ''}>
              <td className="nowrap">{fmt(e.timestamp)}{e.queuedOffline && <div className="cell-sub">synced from offline</div>}</td>
              <td>
                <div className="cell-title">{e.actor.name || (e.actor.kind === 'patient' ? 'Patient' : 'Staff member')}</div>
                <div className="cell-sub">
                  {e.actor.role ? `${e.actor.role}${e.actor.department ? ` · ${e.actor.department}` : ''}` : e.actor.kind === 'patient' ? 'patient' : ''}
                  {e.actor.ours === false && e.actor.hospitalName ? ` · ${e.actor.hospitalName}` : ''}
                </div>
              </td>
              <td>
                <div className="cell-title">{e.patient.name || 'Not linked here'}</div>
                {e.patient.hospitalNumber && <div className="cell-sub">No. {e.patient.hospitalNumber}</div>}
              </td>
              <td>
                {e.recordsAt?.name || e.hospitalID}
                <div className="cell-sub">{e.direction === 'our-records' ? 'our records' : 'our clinician'}</div>
              </td>
              <td>
                {e.breakGlass ? <span className="pill pill-bad">{EVENT_LABELS[e.eventType] || 'Emergency'}</span> : <span className="pill pill-info">{EVENT_LABELS[e.eventType] || e.eventType}</span>}
              </td>
              {!compact && <td className="cell-sub">{e.detail}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AccessLog() {
  const [params] = useSearchParams();
  const [type, setType] = useState('access');
  const [providerID, setProviderID] = useState(params.get('providerID') || '');
  const [q, setQ] = useState('');
  const { data, error } = useHospitalData('access-log', { type, providerID, limit: 1000 });
  const { data: clinicians } = useHospitalData('clinicians');
  const shown = (data || []).filter((e) => {
    if (!q) return true;
    const n = q.toLowerCase();
    return [e.patient.name, e.patient.hospitalNumber, e.patientDID, e.actor.name, e.actor.id, e.detail].some((v) => v && String(v).toLowerCase().includes(n));
  });

  function exportCsv() {
    const rows = [['time', 'event', 'clinician_id', 'clinician_name', 'role', 'patient_name', 'hospital_number', 'patient_did', 'detail']];
    for (const e of shown) rows.push([e.timestamp, e.eventType, e.actor.id, e.actor.name || '', e.actor.role || '', e.patient.name || '', e.patient.hospitalNumber || '', e.patientDID, e.detail || '']);
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `access-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="panel">
      {error && <div className="error-banner">{error}</div>}
      <div className="panel-head">
        <div><span className="eyebrow">Immutable ledger audit trail</span><h2>Record Access Log</h2></div>
        <button className="btn btn-ghost" onClick={exportCsv} disabled={!shown.length}>Export CSV</button>
      </div>
      <p className="hint">Every time a clinician opened a patient’s records at this hospital, and every emergency override. Entries cannot be edited or deleted.</p>
      <div className="filter-bar">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="access">Record accesses</option>
          <option value="BREAK_GLASS_ACCESS">Emergency (break-glass) only</option>
          <option value="all">All audit events</option>
        </select>
        <select value={providerID} onChange={(e) => setProviderID(e.target.value)}>
          <option value="">All clinicians</option>
          {(clinicians || []).map((c) => <option key={c.providerID} value={c.providerID}>{c.name}</option>)}
        </select>
        <input className="search" placeholder="Search patient, hospital number, clinician…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <AccessTable entries={shown} />
    </div>
  );
}

export function HospitalGrants() {
  const [status, setStatus] = useState('');
  const { data, error } = useHospitalData('grants', { status });
  const counts = useMemo(() => {
    const c = {};
    for (const g of data || []) c[g.status] = (c[g.status] || 0) + 1;
    return c;
  }, [data]);
  return (
    <div className="panel">
      {error && <div className="error-banner">{error}</div>}
      <div className="panel-head"><div><span className="eyebrow">On-chain, issued by patients</span><h2>Access Grants</h2></div></div>
      <p className="hint">Grants covering this hospital’s records: who may see them, which record types, for what purpose and until when.</p>
      <div className="filter-bar">
        <div className="role-tabs">
          {['', 'ACTIVE', 'PENDING', 'REVOKED', 'EXPIRED'].map((s) => (
            <button key={s || 'all'} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
              {s ? s[0] + s.slice(1).toLowerCase() : 'All'} {s && <span className="count">{counts[s] || 0}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Clinician</th>
              <th>Patient</th>
              <th>Records at → viewed from</th>
              <th>Covers</th>
              <th>Status</th>
              <th>Dates</th>
            </tr>
          </thead>
          <tbody>
            {(data || []).map((g) => (
              <tr key={g.grantID}>
                <td>
                  <div className="cell-title">{g.provider.name || clinicianName(g)}</div>
                  <div className="cell-sub">{g.providerRole || g.provider.role || ''}</div>
                </td>
                <td>
                  <div className="cell-title">{g.patient.name || 'Not linked here'}</div>
                  {g.patient.hospitalNumber && <div className="cell-sub">No. {g.patient.hospitalNumber}</div>}
                </td>
                <td>
                  <div>{g.recordsAt?.name} → {g.viewedFrom?.name || '—'}</div>
                  <div className="cell-sub">{g.direction === 'our-records' ? 'our records shared out' : 'our clinician viewing elsewhere'}</div>
                </td>
                <td>
                  <div>{g.scope && g.scope.length ? g.scope.join(', ') : 'All record types'}</div>
                  <div className="cell-sub">Purpose: {g.purpose}{g.justification ? ` · “${g.justification}”` : ''}</div>
                </td>
                <td>
                  <span className={`pill ${g.status === 'ACTIVE' ? 'pill-ok' : g.status === 'PENDING' ? 'pill-info' : 'pill-muted'}`}>{g.status}</span>
                  {g.grantType === 'BREAK_GLASS' && <span className="pill pill-bad">Emergency{g.reviewed ? ' · reviewed' : ''}</span>}
                  {g.patientSigned && <span className="pill pill-ok" title="Approval signed with the patient's own key and verified on-chain">Patient-signed</span>}
                </td>
                <td className="cell-sub nowrap">
                  Requested {fmt(g.requestedAt)}
                  {g.grantedAt && <div>Granted {fmt(g.grantedAt)}</div>}
                  {g.expiresAt && <div>Expires {fmt(g.expiresAt)}</div>}
                  {g.revokedAt && <div>Revoked {fmt(g.revokedAt)}</div>}
                </td>
              </tr>
            ))}
            {data && !data.length && <tr><td colSpan={6} className="hint">No grants.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const STATUS_LABEL = { ACTIVE: 'active', SUSPENDED: 'suspended', INACTIVE: 'inactive in EMR' };

/**
 * Adds a clinician from the hospital's EMR (password accounts): search by
 * staff ID or name → pick the person → check what the EMR says → add, which
 * creates their login and shows a temporary password once.
 */
function AddFromEmr({ hospitalID, onAdded, onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [total, setTotal] = useState(0);
  const [found, setFound] = useState(null);
  const [added, setAdded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Full details (role, department, status) of the person picked.
  // The email or name helps the EMR find the person picked in one search.
  const hintFor = (r) => r.email || r.name || undefined;
  const pick = (r) => run(async () => setFound({ ...(await api.hospitalAdminEmrLookup(hospitalID, r.staffID, hintFor(r))), hint: hintFor(r) }));

  const search = (e) => {
    e.preventDefault();
    setFound(null);
    setResults(null);
    run(async () => {
      const answer = await api.hospitalAdminEmrSearch(hospitalID, query.trim());
      const list = answer.results || [];
      setResults(list);
      setTotal(answer.total || list.length);
      const usable = list.filter((r) => r.usable && !r.alreadyRegistered);
      if (list.length === 1 && usable.length === 1) {
        setFound({ ...(await api.hospitalAdminEmrLookup(hospitalID, usable[0].staffID, hintFor(usable[0]))), hint: hintFor(usable[0]) });
      }
    });
  };
  const add = () =>
    run(async () => {
      setAdded(await api.hospitalAdminAddFromEmr(hospitalID, found.staffID, found.hint || found.email || undefined));
      await onAdded();
    });
  const reset = () => { setAdded(null); setFound(null); setResults(null); setQuery(''); };

  return (
    <div className="config-block">
      {error && <div className="error-banner">{error}</div>}
      {added ? (
        <>
          <p><strong>{added.provider.name}</strong> is added ({added.provider.role}, {added.provider.department}). Give them these sign-in details:</p>
          <TemporaryPassword account={added.account} who="The clinician" />
          <div className="wizard-foot">
            <span className="spacer" />
            <button className="btn btn-primary" onClick={reset}>Add another</button>
            <button className="btn btn-ghost" onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          <form className="form-grid three" onSubmit={search}>
            <div className="field span-2">
              <label htmlFor="emr-search">Name, email or staff ID</label>
              <input
                id="emr-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. Ngozi Eze, doctor.test@hospital.example or JUTH/00421"
                autoFocus
              />
            </div>
            <div className="field" style={{ alignSelf: 'end' }}>
              <button className="btn" type="submit" disabled={busy || query.trim().length < 2}>{busy && !results ? 'Searching…' : 'Search EMR'}</button>
            </div>
          </form>

          {results && !found && (
            results.length ? (
              <div className="table-wrap" style={{ marginTop: 12 }}>
                {total > results.length && (
                  <p className="hint">Showing {results.length} of {total.toLocaleString()} matches. Type more of the name, or their email, to narrow it down.</p>
                )}
                <table className="admin-table">
                  <thead><tr><th>Name</th><th>Email / staff ID</th><th>Role</th><th>Status in EMR</th><th /></tr></thead>
                  <tbody>
                    {results.map((r, i) => (
                      <tr key={r.staffID || `row-${i}`} className={!r.active ? 'row-muted' : ''}>
                        <td><div className="cell-title">{r.name || '—'}</div><div className="cell-sub">{r.department || ''}</div></td>
                        <td className="nowrap">{r.email || r.staffID || <span className="cell-sub">no ID</span>}</td>
                        <td>{r.role || <span className="cell-sub">—</span>}</td>
                        <td>{r.active ? 'Active' : 'Not active'}</td>
                        <td className="cell-actions">
                          {r.alreadyRegistered ? (
                            <span className="cell-sub">already added</span>
                          ) : !r.usable ? (
                            <span className="cell-sub">{r.staffID ? 'ID not usable' : 'no staff ID in EMR'}</span>
                          ) : (
                            <button className="btn btn-ghost" disabled={busy} onClick={() => pick(r)}>Select</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="hint" style={{ marginTop: 12 }}>No one in the EMR matches “{query}”. Check the spelling, or try their email.</p>
            )
          )}

          {found && (
            <div className="review" style={{ marginTop: 12 }}>
              <div className="data-row"><span className="k">Name</span><span className="v">{found.name || '—'}</span></div>
              {found.email && <div className="data-row"><span className="k">Email (their sign-in username)</span><span className="v">{found.email}</span></div>}
              {!found.email && <div className="data-row"><span className="k">Staff ID</span><span className="v">{found.staffID}</span></div>}
              <div className="data-row"><span className="k">Role</span><span className="v">{found.role || 'not given (Physician)'}</span></div>
              <div className="data-row"><span className="k">Department</span><span className="v">{found.department || 'not given (General)'}</span></div>
              <div className="data-row"><span className="k">Status in EMR</span><span className="v">{found.active ? 'Active' : 'Not active'}</span></div>
              {found.alreadyRegistered && <div className="inline-warn">Already on your clinicians list. Use Re-sync on their row instead.</div>}
              {!found.active && <div className="inline-warn">The EMR shows this person as not active, so they can’t be added.</div>}
              {results && results.length > 1 && <button className="btn btn-ghost" onClick={() => setFound(null)}>← Back to the list</button>}
            </div>
          )}

          <div className="wizard-foot">
            <span className="hint">Name, role, department and status come from your EMR and can’t be changed here. Re-sync to pick up EMR changes.</span>
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !found || !found.active || found.alreadyRegistered} onClick={add}>
              {busy && found ? 'Adding…' : 'Add and create login'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Clinicians() {
  const { data, error, reload } = useHospitalData('clinicians');
  const { data: overview } = useHospitalData('overview');
  const { hospitalID } = useContext(HospitalContext);
  const { authMode } = useSession();
  const passwordAccounts = authMode === 'password';
  const emr = Boolean(passwordAccounts && overview?.emrConnected);
  const [form, setForm] = useState(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [rowNotice, setRowNotice] = useState(null);

  async function save(values) {
    setSaving(true);
    setFormError(null);
    try {
      const result = await api.hospitalAdminRegisterClinician({ ...values, hospitalID });
      setForm(null);
      if (result.account) setRowNotice({ text: `${result.provider.name} is added. Give them these sign-in details:`, account: result.account });
      await reload();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function rowAction(c, kind) {
    setRowNotice(null);
    try {
      if (kind === 'resync') {
        const r = await api.hospitalAdminResyncClinician(hospitalID, c.providerID);
        setRowNotice({ text: r.inEmr ? `${r.provider.name}: updated from the EMR (${STATUS_LABEL[r.provider.status] || r.provider.status}).` : `${c.name} is no longer in the EMR, so they are now inactive here.` });
      } else if (kind === 'reset') {
        if (!window.confirm(`Give ${c.name} a new temporary password? Their current password stops working.`)) return;
        const account = await api.hospitalAdminResetClinicianPassword(hospitalID, c.providerID);
        setRowNotice({ text: `New temporary password for ${c.name}:`, account });
      }
      await reload();
    } catch (e) {
      setRowNotice({ text: e.message, error: true });
    }
  }

  const emptyManual = { providerID: '', name: '', role: 'Physician', department: '', status: 'ACTIVE', isNew: true };

  return (
    <div className="panel">
      {error && <div className="error-banner">{error}</div>}
      <div className="panel-head">
        <div><span className="eyebrow">Hospital staff register</span><h2>Clinicians</h2></div>
        {emr ? (
          <button className="btn btn-primary" onClick={() => { setAdding(true); setForm(null); }}>+ Add from EMR</button>
        ) : (
          <button className="btn btn-primary" onClick={() => { setForm(emptyManual); setAdding(false); }}>+ Register clinician</button>
        )}
      </div>
      <p className="hint">
        {emr
          ? 'Clinicians come from your EMR (search by name, email or staff ID), and the EMR stays in charge: their name, role, department and active status are copied from it. Their email in the EMR becomes their sign-in username. Re-sync after a change in the EMR; someone the EMR marks inactive or removes can no longer sign in. '
          : 'Only clinicians registered and active here can use a patient’s grant at this hospital. '}
        A grant is tied to the clinician’s role: a role change stops their existing grants working until the patient grants again.
      </p>
      {passwordAccounts && !emr && overview && (
        <div className="inline-warn">This hospital has no FHIR connection to its EMR, so clinicians are typed in by hand. Ask the system admin to connect the EMR.</div>
      )}
      {rowNotice && (
        <div className={rowNotice.error ? 'error-banner' : 'notice-banner'}>
          {rowNotice.text}
          {rowNotice.account && <TemporaryPassword account={rowNotice.account} who="The clinician" />}
        </div>
      )}
      {adding && <AddFromEmr hospitalID={hospitalID} onAdded={reload} onClose={() => setAdding(false)} />}
      {form && (
        <div className="config-block">
          {formError && <div className="error-banner">{formError}</div>}
          {form.source === 'emr' && <p className="hint">This clinician comes from the EMR: only a local suspension can be set here.</p>}
          <div className="form-grid three">
            <div className="field">
              <label>{passwordAccounts ? 'Staff ID' : 'Clinician ID'}</label>
              <input value={form.providerID} disabled={!form.isNew} onChange={(e) => setForm({ ...form, providerID: e.target.value.trim() })} placeholder={passwordAccounts ? 'their staff ID' : 'their sign-in name'} />
            </div>
            <div className="field">
              <label>Full name</label>
              <input value={form.name} disabled={form.source === 'emr'} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <label>Role</label>
              <select value={form.role} disabled={form.source === 'emr'} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {[...new Set([...CLINICAL_ROLES, form.role])].map((r) => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Department</label>
              <input value={form.department} disabled={form.source === 'emr'} onChange={(e) => setForm({ ...form, department: e.target.value })} />
            </div>
            <div className="field">
              <label>Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="ACTIVE" disabled={form.source === 'emr' && form.status === 'INACTIVE'}>Active</option>
                <option value="SUSPENDED">Suspended</option>
                {form.status === 'INACTIVE' && <option value="INACTIVE">Inactive (EMR)</option>}
              </select>
            </div>
          </div>
          <div className="wizard-foot">
            {form.isNew && passwordAccounts && <span className="hint">Saving creates their login and shows a temporary password once.</span>}
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={saving || !form.providerID} onClick={() => save(form)}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Clinician</th>
              <th>Role</th>
              <th>Record accesses</th>
              <th>Patients</th>
              <th>Break-glass</th>
              <th>Last access</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data || []).map((c) => (
              <tr key={c.providerID} className={c.status !== 'ACTIVE' ? 'row-muted' : ''}>
                <td>
                  <div className="cell-title">{c.name}</div>
                  <div className="cell-sub">
                    {c.login || c.providerID}
                    {c.status !== 'ACTIVE' && ` · ${STATUS_LABEL[c.status] || c.status}`}
                    {c.source === 'emr' && ' · from EMR'}
                  </div>
                </td>
                <td>{c.role}<div className="cell-sub">{c.department}</div></td>
                <td>{c.recordAccesses}<div className="cell-sub">{c.activeGrants} active grant{c.activeGrants === 1 ? '' : 's'}</div></td>
                <td>{c.patientsAccessed}</td>
                <td>{c.breakGlassUses ? <span className="pill pill-bad">{c.breakGlassUses}</span> : 0}</td>
                <td className="cell-sub nowrap">{fmt(c.lastAccessAt)}</td>
                <td className="cell-actions">
                  <Link className="btn btn-ghost" to={`/admin/access-log?providerID=${encodeURIComponent(c.providerID)}`}>Activity</Link>
                  {emr && c.source === 'emr' && <button className="btn btn-ghost" onClick={() => rowAction(c, 'resync')}>Re-sync</button>}
                  {passwordAccounts && c.login && <button className="btn btn-ghost" onClick={() => rowAction(c, 'reset')}>Reset password</button>}
                  <button className="btn btn-ghost" onClick={() => { setForm({ ...c, isNew: false }); setAdding(false); }}>Edit</button>
                </td>
              </tr>
            ))}
            {data && !data.length && <tr><td colSpan={7} className="hint">No clinicians registered yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function HospitalPatients() {
  const { data, error } = useHospitalData('patients');
  const [q, setQ] = useState('');
  const shown = (data || []).filter((p) => !q || [p.name, p.hospitalNumber, p.patientDID].some((v) => v && v.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="panel">
      {error && <div className="error-banner">{error}</div>}
      <div className="panel-head"><div><span className="eyebrow">Linked Health IDs</span><h2>Patients</h2></div></div>
      <p className="hint">Patients who have linked their Cevruni Health ID to their record at this hospital. Names come from this hospital’s own roster.</p>
      <div className="filter-bar">
        <input className="search" placeholder="Search name, hospital number, Health ID…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Hospital number</th>
              <th>Linked</th>
              <th>Active grants</th>
              <th>Record accesses</th>
              <th>Last accessed</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.patientDID}>
                <td>
                  <div className="cell-title">{p.name || '—'}</div>
                </td>
                <td className="mono">{p.hospitalNumber}</td>
                <td className="cell-sub nowrap">{fmt(p.linkedAt)}</td>
                <td>{p.activeGrants}</td>
                <td>{p.recordAccesses}</td>
                <td className="cell-sub nowrap">{fmt(p.lastAccessAt)}</td>
              </tr>
            ))}
            {data && !shown.length && <tr><td colSpan={6} className="hint">No linked patients.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
