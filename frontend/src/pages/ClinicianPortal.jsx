import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useSession } from '../auth';
import { api } from '../api';
import { useLedgerEvents } from '../ledgerEvents';
import './viewRecords.css';
import { useScreenCaptureSubject } from '../components/screenCaptureAudit';

// Record-type categories a clinician can ask for (Table 3.6). The grant
// stores the FHIR resource types; the gateway returns nothing else.
const SCOPE_OPTIONS = [
  { key: 'lab', label: 'Laboratory & diagnostics', types: ['Observation', 'DiagnosticReport'], defaultChecked: true },
  { key: 'meds', label: 'Medications', types: ['MedicationRequest'], defaultChecked: true },
  { key: 'enc', label: 'Encounters', types: ['Encounter'], defaultChecked: false },
  { key: 'dx', label: 'Diagnoses (incl. psychiatric)', types: ['Condition'], defaultChecked: false },
  { key: 'docs', label: 'Clinical documents', types: ['DocumentReference'], defaultChecked: false },
];
const ADMIN_TYPES = new Set(['Patient', 'Practitioner', 'Organization']);

/** Flattens resolved bundles into the clinical resources to display. */
function clinicalEntries(bundles) {
  return bundles.flatMap((bundle) =>
    (bundle.entry || [])
      .map((e) => e.resource)
      .filter((r) => r && !ADMIN_TYPES.has(r.resourceType))
      .map((r) => ({ bundle, r, key: `${bundle.id}-${r.id || r.resourceType}` }))
  );
}

function entryTitle(r) {
  if (r.resourceType === 'AllergyIntolerance') return `Allergy: ${r.code?.text || 'unspecified'}`;
  return r.reasonCode?.[0]?.text || r.code?.text || r.medicationCodeableConcept?.text || r.description || r.type?.text || 'Clinical entry';
}

const PURPOSE_OPTIONS = ['Treatment', 'Referral', 'Second Opinion'];

export function ClinicianPortal() {
  const { session } = useSession();
  const providerID = session?.providerID || '';
  const hospitalID = session?.hospitalID || '';
  const [profile, setProfile] = useState(null);
  const [hospitals, setHospitals] = useState([]);

  useEffect(() => {
    if (providerID && hospitalID) api.getMyProviderProfile().then(setProfile).catch(() => {});
    api.searchHospitals('').then(setHospitals).catch(() => {});
  }, [providerID, hospitalID]);

  const nameOf = (id) => hospitals.find((h) => h.hospitalID === id)?.name || id;
  const hospitalName = nameOf(hospitalID);

  return (
    <Routes>
      <Route index element={<RequestRecords hospitalID={hospitalID} hospitalName={hospitalName} providerID={providerID} profile={profile} nameOf={nameOf} />} />
      <Route path="emergency" element={<EmergencyAccess hospitalID={hospitalID} hospitalName={hospitalName} hospitals={hospitals} nameOf={nameOf} />} />
      <Route path="records" element={<MyGrants hospitalName={hospitalName} />} />
    </Routes>
  );
}

/**
 * Request Access: find the patient by YOUR hospital's number (they must
 * have linked your hospital), see which other hospitals are in their
 * network, and ask the patient for records from one or more of them.
 * Your own hospital's records are in your own EMR, not here.
 */
function RequestRecords({ hospitalID, hospitalName, providerID, profile, nameOf }) {
  const [number, setNumber] = useState('');
  const [patient, setPatient] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState(new Set());
  const [purpose, setPurpose] = useState('Treatment');
  const [scope, setScope] = useState(Object.fromEntries(SCOPE_OPTIONS.map((o) => [o.key, o.defaultChecked])));
  const [sent, setSent] = useState([]);
  const [myGrants, setMyGrants] = useState([]);
  useScreenCaptureSubject(patient?.patientDID);

  const loadMine = () => api.getMyProviderGrants().then(setMyGrants).catch(() => {});
  useEffect(() => { loadMine(); }, []);
  useLedgerEvents(() => loadMine());

  async function lookup(e) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setPatient(null);
    setSent([]);
    try {
      const p = await api.lookupPatientByHospitalNumber(hospitalID, number.trim());
      setPatient(p);
      setTargets(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    setBusy(true);
    setError(null);
    const types = SCOPE_OPTIONS.filter((o) => scope[o.key]).flatMap((o) => o.types);
    const results = [];
    for (const target of targets) {
      try {
        const g = await api.requestAccess({ patientDID: patient.patientDID, providerID, hospitalID: target, scope: types, purpose });
        results.push({ hospitalID: target, ok: true, queued: g.queued });
      } catch (err) {
        results.push({ hospitalID: target, ok: false, error: err.message });
      }
    }
    setSent(results);
    setTargets(new Set());
    setBusy(false);
    loadMine();
  }

  const forPatient = patient ? myGrants.filter((g) => g.patientDID === patient.patientDID) : [];
  const toggle = (id) => setTargets((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div>
      <div className="dash-welcome">
        <h2>Request records from other hospitals</h2>
        <p>
          {profile?.name || providerID} · {profile?.role || 'Clinician'} · {hospitalName}. Your own hospital’s records are in your hospital’s EMR.
          Use Cevruni to see what a patient’s <strong>other</strong> hospitals hold, with the patient’s permission. Records stay at those hospitals.
        </p>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="panel-head"><div><span className="eyebrow">Step 1</span><h2>Find the patient</h2></div></div>
        <form className="cl-search" onSubmit={lookup}>
          <div className="field" style={{ flex: 1, margin: 0 }}>
            <label>Patient’s hospital number at {hospitalName}</label>
            <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. 536728" />
          </div>
          <button className="btn btn-primary" disabled={busy || !number.trim()}>{busy && !patient ? 'Searching…' : 'Find patient'}</button>
        </form>
        <p className="hint">Only patients who have linked {hospitalName} to their Cevruni Health ID can be found.</p>
      </div>

      {patient && (
        <div className="panel">
          <div className="panel-head">
            <div><span className="eyebrow">Step 2</span><h2>{patient.name || 'Patient'} <span className="hint">· No. {patient.hospitalNumber}</span></h2></div>
            <button className="btn btn-ghost" onClick={() => { setPatient(null); setNumber(''); }}>New search</button>
          </div>
          {patient.network.length === 0 ? (
            <div className="cl-note">
              This patient has no other hospitals in their Cevruni network, so there is nothing to request. All their records with you are in your EMR.
            </div>
          ) : (
            <>
              <label className="section-label">Request records from</label>
              <div className="cl-hospitals">
                {patient.network.map((n) => {
                  const existing = forPatient.find((g) => g.hospitalID === n.hospitalID && (g.status === 'ACTIVE' || g.status === 'PENDING'));
                  return (
                    <label key={n.hospitalID} className={`cl-hospital ${targets.has(n.hospitalID) ? 'on' : ''} ${existing ? 'has' : ''}`}>
                      <input type="checkbox" disabled={Boolean(existing)} checked={targets.has(n.hospitalID)} onChange={() => toggle(n.hospitalID)} />
                      <span className="cl-hospital-name">{'\u{1F3E5}'} {nameOf(n.hospitalID)}</span>
                      {existing && <span className={`cl-tag ${existing.status.toLowerCase()}`}>{existing.status === 'ACTIVE' ? 'Access granted' : 'Request pending'}</span>}
                    </label>
                  );
                })}
              </div>
              <div className="form-grid" style={{ marginTop: 14 }}>
                <div className="field">
                  <label>Purpose</label>
                  <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                    {PURPOSE_OPTIONS.map((p) => <option key={p}>{p}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Record types</label>
                  <div className="cl-types">
                    {SCOPE_OPTIONS.map((o) => (
                      <label key={o.key}><input type="checkbox" checked={!!scope[o.key]} onChange={(e) => setScope((x) => ({ ...x, [o.key]: e.target.checked }))} /> {o.label}</label>
                    ))}
                  </div>
                </div>
              </div>
              <button className="btn btn-primary" onClick={send} disabled={busy || targets.size === 0 || !SCOPE_OPTIONS.some((o) => scope[o.key])}>
                {busy ? 'Sending…' : `Send request to patient (${targets.size} hospital${targets.size === 1 ? '' : 's'})`}
              </button>
              {sent.length > 0 && (
                <div className="cl-sent">
                  {sent.map((r) => (
                    <div key={r.hospitalID} className={r.ok ? 'ok' : 'bad'}>
                      {r.ok ? (r.queued ? '⏳ Queued (offline): ' : '✓ Request sent: ') : '✕ '}{nameOf(r.hospitalID)}{r.error ? ` — ${r.error}` : ''}
                    </div>
                  ))}
                  <p className="hint">The patient is notified now. Once they approve, open the records under <strong>View Records</strong>.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const EMPTY_REP = { name: '', relationship: '', phone: '' };

/**
 * Emergency (break-glass) access to another hospital's records, when the
 * patient cannot consent. Uses the patient's number AT that hospital (e.g.
 * from family). One hour, emergency record types only, extendable with a
 * reason up to 24 hours; seen by both hospitals' admins and the patient.
 */
function EmergencyAccess({ hospitalID, hospitalName, hospitals, nameOf }) {
  const [target, setTarget] = useState('');
  const [number, setNumber] = useState('');
  const [justification, setJustification] = useState('');
  const [rep, setRep] = useState(EMPTY_REP);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const others = hospitals.filter((h) => h.hospitalID !== hospitalID);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const representative = rep.name || rep.relationship || rep.phone ? rep : undefined;
      setResult(await api.requestBreakGlass({ hospitalID: target, hospitalNumber: number.trim(), justification: justification.trim(), representative }));
      setNumber('');
      setJustification('');
      setRep(EMPTY_REP);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="dash-welcome emergency">
        <h2>Emergency access</h2>
        <p>
          For a patient who cannot consent, when their history at another hospital is needed now. You will see their
          allergies, medications, diagnoses, encounters and lab results from that hospital for <strong>1 hour</strong>
          (extendable with a reason, up to 24 hours). Both hospitals’ administrators and the patient will see this access and its reason.
        </p>
      </div>

      {result && (
        <div className="panel cl-bg-result">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Emergency access open</span>
              <h2>{result.patientName || 'Patient'} <span className="hint">· {nameOf(result.hospitalID)} No. {result.hospitalNumber}</span></h2>
            </div>
          </div>
          <p>Check this is the right patient. Access ends at <strong>{new Date(result.expiresAt).toLocaleTimeString()}</strong>. Open the records under <strong>View Records</strong>, where you can also extend access with a reason.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <a className="btn btn-primary" href="/clinician/records">Open emergency records</a>
            <button className="btn btn-ghost" onClick={() => setResult(null)}>New emergency access</button>
          </div>
        </div>
      )}

      {!result && (
        <form className="panel" onSubmit={submit}>
          {error && <div className="error-banner">{error}</div>}
          <div className="form-grid">
            <div className="field">
              <label>Hospital holding the records</label>
              <select value={target} onChange={(e) => setTarget(e.target.value)} required>
                <option value="">Select hospital…</option>
                {others.map((h) => <option key={h.hospitalID} value={h.hospitalID}>{h.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Patient’s hospital number there</label>
              <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="e.g. from the family or the patient’s card" required />
            </div>
            <div className="field span-2">
              <label>Why is this needed now?</label>
              <textarea rows={3} value={justification} onChange={(e) => setJustification(e.target.value)} required
                placeholder="e.g. Brought in unresponsive; need allergies and current medication before treatment" />
            </div>
          </div>
          <fieldset className="config-block">
            <legend>Who asked? <span className="optional">optional</span></legend>
            <p className="hint" style={{ marginTop: 0 }}>The family member or representative who gave the number (National Health Act 2014 s.26(2)(d)). Stored encrypted, off the blockchain.</p>
            <div className="form-grid three">
              <div className="field"><label>Name</label><input value={rep.name} onChange={(e) => setRep({ ...rep, name: e.target.value })} /></div>
              <div className="field"><label>Relationship</label><input value={rep.relationship} onChange={(e) => setRep({ ...rep, relationship: e.target.value })} placeholder="e.g. Husband" /></div>
              <div className="field"><label>Phone</label><input value={rep.phone} onChange={(e) => setRep({ ...rep, phone: e.target.value })} placeholder="+234…" /></div>
            </div>
          </fieldset>
          <p className="hint">Works only if the patient has added both {hospitalName} and that hospital to their Cevruni network. If not, treat with the information available; your duty to treat is unchanged.</p>
          <button className="btn btn-danger-solid" disabled={busy || !target || !number.trim() || !justification.trim()}>
            {busy ? 'Opening…' : 'Open emergency access'}
          </button>
        </form>
      )}
    </div>
  );
}

const STATUS_ORDER = { ACTIVE: 0, PENDING: 1, EXPIRED: 2, REVOKED: 3 };

// How each FHIR type is shown in the record viewer.
const TYPE_META = {
  AllergyIntolerance: { label: 'Allergies', icon: '\u{26A0}' },
  Encounter: { label: 'Encounters', icon: '\u{1F3E5}' },
  Observation: { label: 'Lab & observations', icon: '\u{1F9EA}' },
  DiagnosticReport: { label: 'Diagnostic reports', icon: '\u{1FA7B}' },
  Condition: { label: 'Diagnoses', icon: '\u{1F4CB}' },
  MedicationRequest: { label: 'Medications', icon: '\u{1F48A}' },
  DocumentReference: { label: 'Documents', icon: '\u{1F4C4}' },
};

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function recordDate(r, bundle) {
  return r.effectiveDateTime || r.authoredOn || r.period?.start || r.date || r.recordedDate || bundle.timestamp;
}

function timeLeft(expiresAt) {
  const ms = new Date(expiresAt) - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600000);
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${h} h left`;
  return `${Math.max(1, Math.round(ms / 60000))} min left`;
}

/**
 * View Records: every grant naming this clinician, at every hospital,
 * straight from the ledger. Open a grant to see its records, close it to
 * hide them. Each open is a fresh on-chain check (two-layer revocation)
 * and is written to the patient's audit trail. Updates live when a patient
 * approves or revokes.
 */
function MyGrants({ hospitalName }) {
  const [grants, setGrants] = useState(null);
  const [error, setError] = useState(null);
  const [results, setResults] = useState({}); // grantID -> resolution | { error }
  const [openID, setOpenID] = useState(null);
  const [busy, setBusy] = useState(null);
  const [filter, setFilter] = useState('current'); // current | all
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState({}); // grantID -> resourceType | ''
  const [hospitals, setHospitals] = useState([]);
  const [extendFor, setExtendFor] = useState(null); // grantID
  const [extendReason, setExtendReason] = useState('');
  const [extendMinutes, setExtendMinutes] = useState(60);
  const [extendError, setExtendError] = useState(null);
  const [details, setDetails] = useState({}); // grantID -> emergency details

  async function extend(g) {
    setExtendError(null);
    try {
      await api.extendBreakGlass(g.grantID, { reason: extendReason.trim(), minutes: extendMinutes });
      setExtendFor(null);
      setExtendReason('');
      await load();
      api.getEmergencyDetails(g.grantID).then((d) => setDetails((x) => ({ ...x, [g.grantID]: d }))).catch(() => {});
    } catch (e) {
      setExtendError(e.message);
    }
  }

  async function load() {
    try {
      setGrants(await api.getMyProviderGrants());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
    api.searchHospitals('').then(setHospitals).catch(() => {});
  }, []);
  useLedgerEvents((evt) => {
    load();
    // A revoked or expired grant closes immediately.
    if (evt.payload?.grantID && evt.type === 'AccessRevoked' && evt.payload.grantID === openID) {
      setOpenID(null);
      setResults((r) => ({ ...r, [evt.payload.grantID]: undefined }));
    }
  });

  const nameOf = (id) => hospitals.find((h) => h.hospitalID === id)?.name || id;

  async function fetchRecords(g) {
    setBusy(g.grantID);
    try {
      const res = await api.resolveRecord(g.grantID, g.hospitalID, {
        purpose: g.purpose,
        resourceTypes: g.scope?.length ? g.scope.join(',') : undefined,
      });
      setResults((o) => ({ ...o, [g.grantID]: res }));
    } catch (e) {
      setResults((o) => ({ ...o, [g.grantID]: { error: e.message } }));
    } finally {
      setBusy(null);
    }
  }

  function toggle(g) {
    if (openID === g.grantID) {
      setOpenID(null);
      return;
    }
    setOpenID(g.grantID);
    fetchRecords(g); // always re-checked on the ledger when opened
    if (g.grantType === 'BREAK_GLASS' && !details[g.grantID]) {
      api.getEmergencyDetails(g.grantID).then((d) => setDetails((x) => ({ ...x, [g.grantID]: d }))).catch(() => {});
    }
  }

  const sorted = (grants || [])
    .slice()
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || new Date(b.requestedAt) - new Date(a.requestedAt));
  const shown = sorted
    .filter((g) => filter === 'all' || g.status === 'ACTIVE' || g.status === 'PENDING')
    .filter((g) => !q || [g.patientName, g.hospitalNumber, nameOf(g.hospitalID)].some((v) => v && v.toLowerCase().includes(q.toLowerCase())));
  const counts = { active: sorted.filter((g) => g.status === 'ACTIVE').length, pending: sorted.filter((g) => g.status === 'PENDING').length };

  return (
    <div className="vr">
      <div className="dash-welcome">
        <h2>View Records</h2>
        <p>Records held at patients’ other hospitals that you may view from {hospitalName}: approved by the patient, shared with your hospital, or opened in an emergency. They stay at those hospitals; opening them re-checks your access on the blockchain and is logged for the patient and both hospitals.</p>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="vr-toolbar">
        <div className="vr-tabs">
          <button className={filter === 'current' ? 'active' : ''} onClick={() => setFilter('current')}>
            Current <span>{counts.active + counts.pending}</span>
          </button>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            All <span>{sorted.length}</span>
          </button>
        </div>
        <input className="vr-search" placeholder="Search patient, hospital number or hospital…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {grants === null && <p className="hint">Loading your grants…</p>}
      {grants && shown.length === 0 && (
        <div className="vr-empty">
          <div className="vr-empty-icon">{'\u{1F4C2}'}</div>
          <strong>No {filter === 'current' ? 'current ' : ''}grants</strong>
          <p>Find a patient under <strong>Request Access</strong> and send a request. It appears here once the patient responds.</p>
        </div>
      )}

      <div className="vr-list">
        {shown.map((g) => {
          const isOpen = openID === g.grantID;
          const res = results[g.grantID];
          const entries = res && !res.error ? clinicalEntries(res.bundles) : [];
          const types = [...new Set(entries.map((e) => e.r.resourceType))];
          const tf = typeFilter[g.grantID] || '';
          const visible = tf ? entries.filter((e) => e.r.resourceType === tf) : entries;
          visible.sort((a, b) => new Date(recordDate(b.r, b.bundle)) - new Date(recordDate(a.r, a.bundle)));
          const canOpen = g.status === 'ACTIVE';
          return (
            <div key={g.grantID} className={`vr-card ${isOpen ? 'open' : ''} status-${g.status.toLowerCase()}`}>
              <div className="vr-card-head" onClick={() => canOpen && toggle(g)} role={canOpen ? 'button' : undefined}>
                <div className={`vr-avatar ${g.grantType === 'BREAK_GLASS' ? 'emergency' : ''}`}>{initials(g.patientName)}</div>
                <div className="vr-main">
                  <div className="vr-name">
                    {g.patientName || 'Patient'}
                    {g.localNumber && <span className="vr-mrn">your No. {g.localNumber}</span>}
                    {g.grantType === 'BREAK_GLASS' && <span className="vr-chip emergency">Emergency access</span>}
                  </div>
                  <div className="vr-meta">
                    <span className="vr-hosp">{'\u{1F3E5}'} Records at {nameOf(g.hospitalID)}{g.hospitalNumber ? ` (No. ${g.hospitalNumber})` : ''}</span>
                    {g.sharedWithHospital && <span>shared with all clinicians at your hospital</span>}
                    <span>{g.purpose}</span>
                    {g.providerRole && <span>as {g.providerRole}</span>}
                  </div>
                  <div className="vr-scope">
                    {(g.scope?.length ? g.scope : ['All record types']).map((t) => (
                      <span key={t} className="vr-chip">{TYPE_META[t]?.label || t}</span>
                    ))}
                  </div>
                </div>
                <div className="vr-side">
                  <span className={`vr-status ${g.status.toLowerCase()}`}>{g.status}</span>
                  <span className="vr-when">
                    {g.status === 'ACTIVE' && timeLeft(g.expiresAt)}
                    {g.status === 'PENDING' && 'Awaiting patient'}
                    {g.status === 'REVOKED' && 'Revoked by patient'}
                    {g.status === 'EXPIRED' && 'Expired'}
                  </span>
                  {canOpen && (
                    <button
                      className={`btn ${isOpen ? 'btn-ghost' : 'btn-primary'} vr-toggle`}
                      onClick={(e) => { e.stopPropagation(); toggle(g); }}
                      disabled={busy === g.grantID}
                      aria-expanded={isOpen}
                    >
                      {busy === g.grantID ? 'Checking…' : isOpen ? 'Close' : 'Open records'}
                      <span className="vr-caret">{isOpen ? '▴' : '▾'}</span>
                    </button>
                  )}
                </div>
              </div>

              {isOpen && (
                <div className="vr-body">
                  {busy === g.grantID && !res && <p className="hint">Checking your access on the blockchain…</p>}
                  {res && res.error && <div className="error-banner">{res.error}</div>}
                  {g.grantType === 'BREAK_GLASS' && (
                    <div className="vr-emergency">
                      <div>
                        <strong>Emergency access</strong> · ends {new Date(g.expiresAt).toLocaleString()}
                        {g.extensions?.length ? ` · extended ${g.extensions.length}×` : ''}
                        <div className="hint">Reason: {g.justification}</div>
                        {details[g.grantID]?.representative && (
                          <div className="hint">
                            Requested by {details[g.grantID].representative.relationship || 'representative'} {details[g.grantID].representative.name}
                            {details[g.grantID].representative.phone ? ` · ${details[g.grantID].representative.phone}` : ''}
                          </div>
                        )}
                        {(g.extensions || []).map((x, i) => (
                          <div key={i} className="hint">Extended {new Date(x.at).toLocaleTimeString()} (+{x.minutes} min): {x.reason}</div>
                        ))}
                      </div>
                      {extendFor === g.grantID ? (
                        <div className="vr-extend">
                          <input value={extendReason} onChange={(e) => setExtendReason(e.target.value)} placeholder="Why is more time needed?" />
                          <select value={extendMinutes} onChange={(e) => setExtendMinutes(Number(e.target.value))}>
                            <option value={30}>+30 min</option>
                            <option value={60}>+1 hour</option>
                          </select>
                          <button className="btn btn-primary" disabled={!extendReason.trim()} onClick={() => extend(g)}>Extend</button>
                          <button className="btn btn-ghost" onClick={() => { setExtendFor(null); setExtendError(null); }}>Cancel</button>
                          {extendError && <div className="error-banner" style={{ width: '100%' }}>{extendError}</div>}
                        </div>
                      ) : (
                        <button className="btn btn-ghost" onClick={() => { setExtendFor(g.grantID); setExtendReason(''); }}>Extend access…</button>
                      )}
                    </div>
                  )}
                  {res && !res.error && (
                    <>
                      <div className="vr-body-bar">
                        <div className="vr-filters">
                          <button className={!tf ? 'active' : ''} onClick={() => setTypeFilter((f) => ({ ...f, [g.grantID]: '' }))}>
                            All <span>{entries.length}</span>
                          </button>
                          {types.map((t) => (
                            <button key={t} className={tf === t ? 'active' : ''} onClick={() => setTypeFilter((f) => ({ ...f, [g.grantID]: t }))}>
                              {TYPE_META[t]?.icon} {TYPE_META[t]?.label || t} <span>{entries.filter((e) => e.r.resourceType === t).length}</span>
                            </button>
                          ))}
                        </div>
                        <div className="vr-actions">
                          <button className="btn btn-ghost" onClick={() => fetchRecords(g)} disabled={busy === g.grantID}>Refresh</button>
                          <button className="btn btn-ghost" onClick={() => setOpenID(null)}>Close</button>
                        </div>
                      </div>
                      <div className="vr-notes">
                        {res.liveSource && (res.liveSource.ok
                          ? <span className="vr-note live">{'⚡'} Fetched live from {nameOf(g.hospitalID)}’s FHIR server</span>
                          : <span className="vr-note warn">Live FHIR fetch failed: {res.liveSource.error}</span>)}
                        {res.withheld > 0 && <span className="vr-note">{'\u{1F512}'} {res.withheld} record{res.withheld === 1 ? '' : 's'} outside this grant’s record types withheld</span>}
                        <span className="vr-note">{'✓'} Access verified on the blockchain and logged</span>
                      </div>
                      {visible.length === 0 && <p className="hint">No records of the granted types at this hospital.</p>}
                      <div className="vr-records">
                        {visible.map(({ bundle, r, key }) => {
                          const date = recordDate(r, bundle);
                          const who = r.participant?.[0]?.individual?.display || r.requester?.display || r.performer?.[0]?.display || r.serviceProvider?.display;
                          return (
                            <div key={key} className={`vr-record type-${r.resourceType}`}>
                              <div className="vr-record-icon">{TYPE_META[r.resourceType]?.icon || '\u{1F4C4}'}</div>
                              <div className="vr-record-main">
                                <div className="vr-record-top">
                                  <span className="vr-record-title">{entryTitle(r)}</span>
                                  <span className="vr-record-date">{date ? new Date(date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</span>
                                </div>
                                <div className="vr-record-type">{TYPE_META[r.resourceType]?.label || r.resourceType}{r.status ? ` · ${r.status}` : ''}</div>
                                {r.valueString && <div className="vr-value">{r.valueString}</div>}
                                {r.conclusion && <div className="vr-text">{r.conclusion}</div>}
                                {r.dosageInstruction?.[0]?.text && <div className="vr-text">Dosage: {r.dosageInstruction[0].text}</div>}
                                {r.reaction?.[0] && <div className="vr-text vr-allergy">Reaction: {r.reaction[0].manifestation?.map((m) => m.text).join(', ')}{r.reaction[0].severity ? ` (${r.reaction[0].severity})` : ''}</div>}
                                {r.content?.[0]?.attachment?.data && r.content[0].attachment.contentType === 'text/plain' && (
                                  <div className="vr-text vr-doc">{decodeText(r.content[0].attachment.data)}</div>
                                )}
                                {who && <div className="vr-who">{who}</div>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function decodeText(b64) {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}
