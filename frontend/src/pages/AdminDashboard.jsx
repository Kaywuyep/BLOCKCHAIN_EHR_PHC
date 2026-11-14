import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useSession } from '../auth';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { api } from '../api';
import { useLedgerEvents } from '../ledgerEvents';
import './admin.css';
import { HospitalSetup } from './HospitalSetup';
import { UserDirectory } from './UserDirectory';
import { HospitalScope, HospitalOverview, AccessLog, HospitalGrants, Clinicians, HospitalPatients } from './HospitalAdminView';
import { LedgerStrip } from '../components/LedgerStrip';

const EMPTY_ROSTER_FORM = { hospitalNumber: '', name: '', dob: '' };

export function AdminDashboard() {
  const [cost, setCost] = useState(null);
  const [batchSize, setBatchSize] = useState(10);
  const [events, setEvents] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [hospitalStatuses, setHospitalStatuses] = useState([]);
  const [queue, setQueue] = useState([]);
  const [pendingReviews, setPendingReviews] = useState([]);
  const [screenCaptures, setScreenCaptures] = useState([]);
  const [reviewNotes, setReviewNotes] = useState({});
  const { session, authMode } = useSession();
  const isSystemAdmin = authMode === 'off' || Boolean(session?.superuser || session?.roles?.includes('system_admin'));
  const [reviewerID, setReviewerID] = useState(session?.sub || '');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const [rosterHospitalID, setRosterHospitalID] = useState(session?.hospitalID || '');
  const [roster, setRoster] = useState([]);
  const [rosterForm, setRosterForm] = useState(EMPTY_ROSTER_FORM);
  const [rosterError, setRosterError] = useState(null);

  async function refresh() {
    try {
      const [c, e, s, q, pr, hs, sc] = await Promise.all([
        api.getCostSummary({ b: batchSize }),
        api.getRecentEvents(),
        api.getSyncStatus(),
        api.getSyncQueue(),
        api.getPendingBreakGlass(),
        api.getHospitalStatuses(),
        api.getScreenCaptures().catch(() => []),
      ]);
      setCost(c); setEvents(e); setSyncStatus(s); setQueue(q); setPendingReviews(pr); setHospitalStatuses(hs); setScreenCaptures(sc);
      setError(null);
    } catch (e) { setError(e.message); }
  }

  async function handleReview(grantID) {
    setLoading(true);
    try {
      await api.reviewBreakGlass(grantID, { reviewerID: reviewerID || 'unspecified-reviewer', notes: reviewNotes[grantID] || 'Reviewed via Admin Dashboard' });
      await refresh();
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  // Ledger-driven figures refresh when the ledger reports an event
  // (Section 3.4.4); a slow timer only covers non-ledger status (HL7
  // listeners, the offline queue).
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [batchSize]);
  useLedgerEvents(() => refresh());

  async function loadRoster(hospitalID) {
    if (!hospitalID) return;
    setRosterError(null);
    try { setRoster(await api.getLocalPatientRecords(hospitalID)); } catch (e) { setRosterError(e.message); }
  }

  async function handleAddRosterRecord() {
    setLoading(true); setRosterError(null);
    try {
      await api.addLocalPatientRecord(rosterHospitalID, rosterForm);
      setRosterForm(EMPTY_ROSTER_FORM);
      await loadRoster(rosterHospitalID);
    } catch (e) { setRosterError(e.message); } finally { setLoading(false); }
  }

  async function toggleConnectivity() {
    setLoading(true);
    try { await api.setConnectivity(!syncStatus?.connected); await refresh(); } catch (e) { setError(e.message); } finally { setLoading(false); }
  }

  const ledgerEntries = events.map((e) => ({
    id: `${e.type}-${e.timestamp}`,
    status: e.type.replace(/([a-z])([A-Z])/g, '$1 $2'),
    title: describeEvent(e),
    timestamp: e.timestamp,
  }));

  return (
    <Routes>
      <Route path="access-log" element={<HospitalScope><AccessLog /></HospitalScope>} />
      <Route path="grants" element={<HospitalScope><HospitalGrants /></HospitalScope>} />
      <Route path="clinicians" element={<HospitalScope><Clinicians /></HospitalScope>} />
      <Route path="patients" element={<HospitalScope><HospitalPatients /></HospitalScope>} />

      <Route index element={!isSystemAdmin ? <HospitalScope><HospitalOverview /></HospitalScope> : (
        <div>
          {error && <div className="error-banner">{error}</div>}

          <div className="dash-welcome">
            <h2>Admin Dashboard</h2>
            <p>Monitor system health, manage hospitals, review emergency access, and track blockchain operations.</p>
          </div>

          <div className="dash-grid">
            <div className="dash-card">
              <div className="dash-card-icon blue">{'\u{1F3E5}'}</div>
              <h3>Hospitals</h3>
              <p className="stat-value">{hospitalStatuses.length}</p>
              <p>Connected hospitals</p>
            </div>
            <div className="dash-card">
              <div className="dash-card-icon green">{'\u{1F504}'}</div>
              <h3>Connectivity</h3>
              <p className="stat-value" style={{ color: syncStatus?.connected ? 'var(--sage)' : 'var(--amber)' }}>{syncStatus?.connected ? 'Online' : 'Offline'}</p>
              <p>Fabric peer status</p>
            </div>
            <div className="dash-card">
              <div className="dash-card-icon amber">{'\u{26A0}'}</div>
              <h3>Pending Reviews</h3>
              <p className="stat-value">{pendingReviews.length}</p>
              <p>Break-glass accesses to review</p>
            </div>
            {cost && (
              <div className="dash-card">
                <div className="dash-card-icon purple">{'\u{1F4CA}'}</div>
                <h3>Transactions</h3>
                <p className="stat-value">{cost.counters.reference + cost.counters.grant + cost.counters.audit}</p>
                <p>Total on-chain events</p>
              </div>
            )}
          </div>
        </div>
      )} />

      <Route path="users" element={isSystemAdmin ? <UserDirectory /> : <div className="error-banner">Only system admins can manage users.</div>} />

      <Route path="hospitals" element={isSystemAdmin ? <HospitalSetup /> : (
        <div>
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">HL7 / MLLP integration</span><h2>Connected Hospitals</h2></div></div>
            <p className="hint">Hospital connection status and message counts. MLLP does not keep a permanent connection open.</p>
            {hospitalStatuses.length === 0 && <p className="hint">No hospitals are configured for ingestion.</p>}
            {hospitalStatuses.map((hospital) => (
              <div className="data-row" key={hospital.hospitalID}>
                <div>
                  <div className="k">{hospital.hospitalID}</div>
                  <div className="hint">{hospital.mode === 'hl7' ? `MLLP port ${hospital.mllpPort}` : hospital.mode} · {hospital.messagesReceived} messages · Last: {hospital.lastMessageAt ? new Date(hospital.lastMessageAt).toLocaleString() : 'None'}</div>
                </div>
                <div className="v" style={{ color: hospital.status === 'listening' ? 'var(--sage)' : 'var(--amber)' }}>
                  {hospital.status === 'listening' ? 'Listening' : hospital.status}
                  {hospital.messagesAccepted > 0 && ` · ${hospital.messagesAccepted} accepted`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )} />

      <Route path="roster" element={
        <div>
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">Off-chain, never on-chain</span><h2>Hospital Patient Roster</h2></div></div>
            <p className="hint">The demographic records a hospital's EMR holds. Add entries here to make hospital numbers linkable by patients.</p>
            {rosterError && <p className="hint" style={{ color: 'var(--rust)' }}>{rosterError}</p>}
            <div className="grid-2">
              <div className="field"><label>Hospital ID</label><input value={rosterHospitalID} onChange={(e) => setRosterHospitalID(e.target.value)} placeholder="e.g. hospital-a" /></div>
              <div className="field"><label>Hospital number</label><input value={rosterForm.hospitalNumber} onChange={(e) => setRosterForm((f) => ({ ...f, hospitalNumber: e.target.value }))} /></div>
              <div className="field"><label>Full name</label><input value={rosterForm.name} onChange={(e) => setRosterForm((f) => ({ ...f, name: e.target.value }))} /></div>
              <div className="field"><label>Date of birth</label><input type="date" value={rosterForm.dob} onChange={(e) => setRosterForm((f) => ({ ...f, dob: e.target.value }))} /></div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={handleAddRosterRecord} disabled={loading || !rosterHospitalID || !rosterForm.hospitalNumber || !rosterForm.name || !rosterForm.dob}>Add record</button>
              <button className="btn btn-ghost" onClick={() => loadRoster(rosterHospitalID)} disabled={!rosterHospitalID}>View roster</button>
            </div>
            {roster.length === 0 && <p className="hint" style={{ marginTop: 14 }}>{rosterHospitalID ? `No local records at ${rosterHospitalID} yet.` : 'Enter a hospital ID above.'}</p>}
            {roster.length > 0 && (
              <div style={{ marginTop: 14 }}>
                {roster.map((r) => <div className="data-row" key={r.hospitalNumber}><span className="k">{r.name} — {r.hospitalNumber}</span><span className="v">DOB {r.dob}</span></div>)}
              </div>
            )}
          </div>
        </div>
      } />

      <Route path="costs" element={
        <div>
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">Transaction optimisation</span><h2>Cost Model</h2></div></div>
            {cost && (
              <>
                <div className="stat-row" style={{ marginBottom: 18 }}>
                  <div className="stat"><div className="num">{cost.counters.reference}</div><div className="label">References</div></div>
                  <div className="stat"><div className="num">{cost.counters.grant}</div><div className="label">Grants</div></div>
                  <div className="stat"><div className="num">{cost.counters.audit}</div><div className="label">Audit writes</div></div>
                  <div className="stat"><div className="num" style={{ color: cost.counters.breakglass > 0 ? 'var(--amber)' : undefined }}>{cost.counters.breakglass ?? 0}</div><div className="label">Break-glass</div></div>
                  <div className="stat"><div className="num">{cost.actionCostAtCurrentBatch}</div><div className="label">Caction(b={batchSize}) ms</div></div>
                  <div className="stat"><div className="num">{cost.ledgerGrowth.reductionFactor ?? '—'}x</div><div className="label">Growth reduction</div></div>
                </div>
                <div className="field" style={{ maxWidth: 280, marginBottom: 8 }}>
                  <label>Batch size (b)</label>
                  <input type="range" min={1} max={50} value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} />
                  <span className="hint">Current: b = {batchSize}</span>
                </div>
                <div style={{ height: 260, marginTop: 10 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={cost.actionCostCurve} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
                      <XAxis dataKey="b" tick={{ fontSize: 11 }} label={{ value: 'Batch size b', position: 'insideBottom', offset: -3, fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} label={{ value: 'Caction(b), ms', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                      <Tooltip formatter={(v) => `${v} ms`} labelFormatter={(l) => `b = ${l}`} />
                      <ReferenceLine x={batchSize} stroke="var(--amber)" strokeDasharray="4 2" />
                      <ReferenceLine y={cost.params.Ce + cost.params.Cv} stroke="var(--sage)" strokeDasharray="4 2" label={{ value: 'Ce + Cv', fontSize: 10, fill: 'var(--sage)', position: 'insideTopRight' }} />
                      <Line type="monotone" dataKey="cost" stroke="var(--brand-blue)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </div>
        </div>
      } />

      <Route path="sync" element={
        <div>
          <div className="panel">
            <div className="panel-head">
              <div><span className="eyebrow">Offline-first sync</span><h2>Synchronisation Status</h2></div>
              <button className="btn btn-primary" onClick={toggleConnectivity} disabled={loading}>
                {syncStatus?.connected ? 'Simulate offline' : 'Restore connectivity'}
              </button>
            </div>
            <div className="stat-row">
              <div className="stat"><div className="num" style={{ color: syncStatus?.connected ? 'var(--sage)' : 'var(--amber)' }}>{syncStatus?.connected ? 'Online' : 'Offline'}</div><div className="label">Connectivity</div></div>
              <div className="stat"><div className="num">{syncStatus?.queuedCount ?? 0}</div><div className="label">Queued</div></div>
              <div className="stat"><div className="num">{(syncStatus?.retryIntervalMs ?? 30000) / 1000}s</div><div className="label">Retry interval</div></div>
            </div>
            {queue.length > 0 && (
              <div style={{ marginTop: 14 }}>
                {queue.slice(0, 6).map((item) => (
                  <div className="data-row" key={item.id}><span className="k">{item.action_type} — {item.status}</span><span className="v">{new Date(item.created_at).toLocaleTimeString()}</span></div>
                ))}
              </div>
            )}
          </div>
        </div>
      } />

      <Route path="breakglass" element={
        <div>
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">Mandatory review</span><h2>Break-Glass Access Review</h2></div></div>
            <div className="field" style={{ maxWidth: 280 }}>
              <label>Reviewing as</label>
              <input value={reviewerID} onChange={(e) => setReviewerID(e.target.value)} readOnly={Boolean(session)} />
            </div>
            {pendingReviews.length === 0 && <p className="hint">No emergency accesses awaiting review.</p>}
            {pendingReviews.map((g) => (
              <div key={g.grantID} className="bg-review">
                <div className="bg-review-head">
                  <span className={`pill ${g.direction === 'our-records' ? 'pill-bad' : 'pill-info'}`}>
                    {g.direction === 'our-records' ? 'Our records opened by another hospital' : g.direction === 'our-clinician' ? 'Our clinician opened another hospital’s records' : 'Emergency access'}
                  </span>
                  <span className="hint">{new Date(g.grantedAt).toLocaleString()} · {g.status === 'ACTIVE' ? `active until ${new Date(g.expiresAt).toLocaleTimeString()}` : g.status.toLowerCase()}</span>
                </div>
                <div className="bg-review-body">
                  <div><span className="k">Clinician</span> {g.providerID} ({g.viewedFromName})</div>
                  <div><span className="k">Records at</span> {g.recordsAtName}</div>
                  <div><span className="k">Patient</span> <span className="mono">{g.patientDID}</span></div>
                  <div><span className="k">Reason</span> {g.justification}</div>
                  {g.representative && (
                    <div>
                      <span className="k">Requested by</span> {g.representative.relationship || 'Representative'} {g.representative.name}
                      {g.representative.phone ? ` · ${g.representative.phone}` : ''}
                      {g.representative.verified ? <span className="pill pill-ok" style={{ marginLeft: 6 }}>matches ledger hash</span> : <span className="pill pill-bad" style={{ marginLeft: 6 }}>hash mismatch</span>}
                    </div>
                  )}
                  {(g.extensions || []).map((x, i) => (
                    <div key={i}><span className="k">Extended</span> +{x.minutes} min at {new Date(x.at).toLocaleTimeString()}: {x.reason}</div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input style={{ flex: 1 }} placeholder="Review notes" value={reviewNotes[g.grantID] || ''} onChange={(e) => setReviewNotes((n) => ({ ...n, [g.grantID]: e.target.value }))} />
                  <button className="btn btn-primary" onClick={() => handleReview(g.grantID)} disabled={loading}>Mark reviewed</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      } />

      <Route path="screen-captures" element={
        <div>
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">Recorded on the ledger audit trail</span><h2>Screenshot Attempts</h2></div></div>
            <p className="hint">
              Confirmed: the screenshot key reached the app. Suspected: the screenshot shortcut was pressed but the operating system took the final key.
              Screenshots taken from a menu, screen recorders and phone cameras cannot be detected.
            </p>
            {screenCaptures.length === 0 && <p className="hint">No screenshot attempts recorded.</p>}
            {screenCaptures.map((a) => (
              <div key={a.id} className="data-row">
                <span className="k">
                  {a.actorID}{a.role ? ` (${a.role})` : ''}{a.hospitalID ? ` @ ${a.hospitalID}` : ''} · {CAPTURE_METHOD_LABELS[a.method] || a.method} · {a.confidence}
                  {a.patientDID ? ` · viewing ${a.patientDID}` : ''}{a.page ? ` · ${a.page}` : ''}
                  {!a.ledgerEntryID && ' · ledger write failed'}
                </span>
                <span className="v">{new Date(a.occurredAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      } />

      <Route path="events" element={
        <div>
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">Live feed</span><h2>Recent Ledger Events</h2></div></div>
            <LedgerStrip entries={ledgerEntries} emptyLabel="No ledger activity yet." />
          </div>
        </div>
      } />
    </Routes>
  );
}

const CAPTURE_METHOD_LABELS = {
  'print-screen': 'PrintScreen key',
  'mac-shortcut': 'macOS screenshot shortcut',
  'windows-snip': 'Windows Snipping Tool shortcut',
  print: 'Print / Save as PDF',
};

function describeEvent(e) {
  switch (e.type) {
    case 'PatientRegistered': return `Patient ${e.payload.patientDID} registered`;
    case 'RecordReferenceRegistered': return `Reference at ${e.payload.hospitalID} (${e.payload.recordType})`;
    case 'AccessRequested': return `${e.payload.providerID} requested access to ${e.payload.patientDID}`;
    case 'AccessGranted': return `Access granted to ${e.payload.providerID}`;
    case 'AccessRevoked': return `Access revoked from ${e.payload.providerID}`;
    case 'AuditEntryWritten': return `${e.payload.eventType} logged for ${e.payload.patientDID}`;
    case 'BreakGlassAccess': return `EMERGENCY: ${e.payload.providerID} @ ${e.payload.hospitalID}`;
    case 'BreakGlassReviewed': return `Break-glass reviewed by ${e.payload.reviewedBy}`;
    default: return e.type;
  }
}
