import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { api } from '../api';
import { LedgerStrip } from '../components/LedgerStrip';

export function AdminDashboard() {
  const [cost, setCost] = useState(null);
  const [batchSize, setBatchSize] = useState(10);
  const [events, setEvents] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [queue, setQueue] = useState([]);
  const [pendingReviews, setPendingReviews] = useState([]);
  const [reviewNotes, setReviewNotes] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    try {
      const [c, e, s, q, pr] = await Promise.all([
        api.getCostSummary({ b: batchSize }),
        api.getRecentEvents(),
        api.getSyncStatus(),
        api.getSyncQueue(),
        api.getPendingBreakGlass(),
      ]);
      setCost(c);
      setEvents(e);
      setSyncStatus(s);
      setQueue(q);
      setPendingReviews(pr);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleReview(grantID) {
    setLoading(true);
    try {
      await api.reviewBreakGlass(grantID, {
        reviewerID: 'hospital-admin',
        notes: reviewNotes[grantID] || 'Reviewed via Admin Dashboard',
      });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchSize]);

  async function toggleConnectivity() {
    setLoading(true);
    try {
      await api.setConnectivity(!syncStatus?.connected);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const ledgerEntries = events.map((e) => ({
    id: `${e.type}-${e.timestamp}`,
    status: e.type.replace(/([a-z])([A-Z])/g, '$1 $2'),
    title: describeEvent(e),
    timestamp: e.timestamp,
  }));

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Section 3.5.2</span>
            <h2>Transaction-optimisation cost model</h2>
          </div>
        </div>

        {cost && (
          <>
            <div className="stat-row" style={{ marginBottom: 18 }}>
              <div className="stat">
                <div className="num">{cost.counters.reference}</div>
                <div className="label">References (λr events)</div>
              </div>
              <div className="stat">
                <div className="num">{cost.counters.grant}</div>
                <div className="label">Grant events (λg)</div>
              </div>
              <div className="stat">
                <div className="num">{cost.counters.audit}</div>
                <div className="label">Audit writes (λa)</div>
              </div>
              <div className="stat">
                <div className="num" style={{ color: cost.counters.breakglass > 0 ? 'var(--amber)' : undefined }}>
                  {cost.counters.breakglass ?? 0}
                </div>
                <div className="label">Break-glass events (§35.1)</div>
              </div>
              <div className="stat">
                <div className="num">{cost.actionCostAtCurrentBatch}</div>
                <div className="label">Caction(b) at b={batchSize} (ms)</div>
              </div>
              <div className="stat">
                <div className="num">{cost.ledgerGrowth.reductionFactor ?? '—'}×</div>
                <div className="label">Ledger-growth reduction vs. full-record-on-chain</div>
              </div>
            </div>

            <div className="field" style={{ maxWidth: 280, marginBottom: 8 }}>
              <label>Batch size b (Fabric orderer MaxMessageCount)</label>
              <input
                type="range"
                min={1}
                max={50}
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
              />
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
                  <ReferenceLine
                    y={cost.params.Ce + cost.params.Cv}
                    stroke="var(--sage)"
                    strokeDasharray="4 2"
                    label={{ value: 'Ce + Cv asymptote', fontSize: 10, fill: 'var(--sage)', position: 'insideTopRight' }}
                  />
                  <Line type="monotone" dataKey="cost" stroke="var(--verdigris)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="hint">
              Caction(b) = Ce + Cv + Co/b — strictly decreasing in b, asymptoting at Ce + Cv. Diminishing returns
              past a moderate batch size, exactly as Section 3.5.2 predicts; the amber line marks the current b.
            </p>
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Section 3.6 / Figure 5</span>
            <h2>Offline-first synchronisation</h2>
          </div>
          <button className="btn btn-primary" onClick={toggleConnectivity} disabled={loading}>
            {syncStatus?.connected ? 'Simulate hospital going offline' : 'Restore connectivity (reconcile queue)'}
          </button>
        </div>
        <div className="stat-row">
          <div className="stat">
            <div className="num" style={{ color: syncStatus?.connected ? 'var(--sage)' : 'var(--amber)' }}>
              {syncStatus?.connected ? 'Online' : 'Offline'}
            </div>
            <div className="label">Fabric peer connectivity</div>
          </div>
          <div className="stat">
            <div className="num">{syncStatus?.queuedCount ?? 0}</div>
            <div className="label">Actions queued locally</div>
          </div>
          <div className="stat">
            <div className="num">{(syncStatus?.retryIntervalMs ?? 30000) / 1000}s</div>
            <div className="label">Retry interval (i)</div>
          </div>
        </div>
        {queue.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {queue.slice(0, 6).map((item) => (
              <div className="data-row" key={item.id}>
                <span className="k">{item.action_type} — {item.status}</span>
                <span className="v">{new Date(item.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Section 35.1</span>
            <h2>Break-glass access — review queue</h2>
          </div>
        </div>
        {pendingReviews.length === 0 && <p className="hint">No emergency accesses awaiting review.</p>}
        {pendingReviews.map((g) => (
          <div key={g.grantID} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
            <div className="data-row">
              <span className="k">{g.providerID} @ {g.hospitalID} → {g.patientDID}</span>
              <span className="v">{new Date(g.grantedAt).toLocaleString()}</span>
            </div>
            <p className="hint">Justification: {g.justification}</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                style={{ flex: 1 }}
                placeholder="Review notes"
                value={reviewNotes[g.grantID] || ''}
                onChange={(e) => setReviewNotes((n) => ({ ...n, [g.grantID]: e.target.value }))}
              />
              <button className="btn btn-primary" onClick={() => handleReview(g.grantID)} disabled={loading}>
                Mark reviewed
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Live ledger feed</span>
            <h2>Recent chaincode events</h2>
          </div>
        </div>
        <LedgerStrip entries={ledgerEntries} emptyLabel="No ledger activity yet — try the Patient or Clinician tabs." />
      </div>
    </div>
  );
}

function describeEvent(e) {
  switch (e.type) {
    case 'PatientRegistered':
      return `Patient ${e.payload.patientDID} registered`;
    case 'RecordReferenceRegistered':
      return `Reference registered at ${e.payload.hospitalID} (${e.payload.recordType})`;
    case 'AccessRequested':
      return `${e.payload.providerID} requested access to ${e.payload.patientDID}`;
    case 'AccessGranted':
      return `Access granted to ${e.payload.providerID} until ${new Date(e.payload.expiresAt).toLocaleTimeString()}`;
    case 'AccessRevoked':
      return `Access revoked from ${e.payload.providerID}`;
    case 'AuditEntryWritten':
      return `${e.payload.eventType} logged for ${e.payload.patientDID}`;
    case 'BreakGlassAccess':
      return `EMERGENCY: ${e.payload.providerID} broke glass on ${e.payload.patientDID} at ${e.payload.hospitalID}`;
    case 'BreakGlassReviewed':
      return `Break-glass grant for ${e.payload.patientDID} reviewed by ${e.payload.reviewedBy}`;
    default:
      return e.type;
  }
}
