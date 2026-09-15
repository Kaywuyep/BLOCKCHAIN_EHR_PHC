import { useEffect, useState } from 'react';
import { api } from '../api';
import { LedgerStrip } from '../components/LedgerStrip';

const DEMO_DID = 'did:patientchain:demo-patient-1';

const EMPTY_DEMOGRAPHICS = { name: '', dob: '', sex: '', phone: '', nin: '' };

export function PatientApp() {
  const [patientDID, setPatientDID] = useState(DEMO_DID);
  const [patient, setPatient] = useState(null);
  const [references, setReferences] = useState([]);
  const [grants, setGrants] = useState([]);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const [demographics, setDemographics] = useState(EMPTY_DEMOGRAPHICS);
  const [identityResult, setIdentityResult] = useState(null);

  async function loadAll(did) {
    setError(null);
    try {
      const [p, refs, g, a] = await Promise.all([
        api.getPatient(did).catch(() => null),
        api.getReferences(did).catch(() => []),
        api.getGrantsForPatient(did).catch(() => []),
        api.getAuditTrail(did).catch(() => []),
      ]);
      setPatient(p);
      setReferences(refs);
      setGrants(g);
      setAudit(a);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    loadAll(patientDID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function filledDemographics() {
    return Object.fromEntries(Object.entries(demographics).filter(([, v]) => v && v.trim()));
  }

  async function handleCheckIdentity() {
    setLoading(true);
    setError(null);
    try {
      const filled = filledDemographics();
      if (Object.keys(filled).length === 0) {
        setError('Enter at least a name to run an identity check.');
        return;
      }
      const result = await api.matchPatient(filled);
      setIdentityResult(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function doRegister(extra = {}) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.registerPatient({
        patientDID,
        hospitalID: 'HospitalA-Lagos',
        mrn: 'LAG-00231',
        ...filledDemographics(),
        ...extra,
      });
      setPatient(result.patient);
      setIdentityResult(null);
      await loadAll(patientDID);
    } catch (e) {
      // A 409 from the MPI possible-duplicate check comes back with an
      // `identity` payload (docs/design.md Section 4) -- surface it as a
      // decision point instead of a plain error.
      if (e.message.startsWith('possible duplicate')) {
        try {
          const preview = await api.matchPatient(filledDemographics());
          setIdentityResult(preview);
        } catch {
          setError(e.message);
        }
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister() {
    await doRegister();
  }

  async function handleRegisterAnyway() {
    await doRegister({ force: true });
  }

  async function handleLinkToExisting(candidateDID) {
    setLoading(true);
    setError(null);
    try {
      const result = await api.linkPatient(candidateDID, {
        hospitalID: 'HospitalA-Lagos',
        mrn: 'LAG-00231',
        ...filledDemographics(),
      });
      setPatientDID(candidateDID);
      setPatient(result.patient);
      setIdentityResult(null);
      await loadAll(candidateDID);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleGrant(grantID, minutes) {
    setLoading(true);
    setError(null);
    try {
      await api.grantAccess(grantID, minutes);
      await loadAll(patientDID);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRevoke(grant) {
    setLoading(true);
    setError(null);
    try {
      await api.revokeAccess(grant.grantID, {
        patientDID: grant.patientDID,
        hospitalID: grant.hospitalID,
        actorID: grant.patientDID,
      });
      await loadAll(patientDID);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const grantEntries = grants.map((g) => ({
    id: g.grantID,
    status: g.status,
    title: `${g.providerID} @ ${g.hospitalID}`,
    subtitle:
      g.status === 'ACTIVE'
        ? `Expires ${new Date(g.expiresAt).toLocaleString()}`
        : g.status === 'PENDING'
        ? 'Awaiting your approval'
        : g.status === 'REVOKED'
        ? `Revoked ${new Date(g.revokedAt).toLocaleString()}`
        : 'No longer valid',
    timestamp: g.requestedAt,
  }));

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Patient identity</span>
            <h2>Your PatientChain DID</h2>
          </div>
        </div>
        <div className="field">
          <label>Patient DID</label>
          <input value={patientDID} onChange={(e) => setPatientDID(e.target.value)} />
        </div>

        {!patient && (
          <>
            <p className="hint" style={{ marginTop: 4 }}>
              Master Patient Index (docs/design.md §4): enter your details once so PatientChain can tell whether
              you already have a record at another hospital before minting a new identity.
            </p>
            <div className="grid-2">
              <div className="field">
                <label>Full name</label>
                <input value={demographics.name} onChange={(e) => setDemographics((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="field">
                <label>Date of birth</label>
                <input type="date" value={demographics.dob} onChange={(e) => setDemographics((d) => ({ ...d, dob: e.target.value }))} />
              </div>
              <div className="field">
                <label>Sex</label>
                <select value={demographics.sex} onChange={(e) => setDemographics((d) => ({ ...d, sex: e.target.value }))}>
                  <option value="">—</option>
                  <option value="F">F</option>
                  <option value="M">M</option>
                </select>
              </div>
              <div className="field">
                <label>Phone</label>
                <input value={demographics.phone} onChange={(e) => setDemographics((d) => ({ ...d, phone: e.target.value }))} />
              </div>
              <div className="field">
                <label>NIN (if available)</label>
                <input value={demographics.nin} onChange={(e) => setDemographics((d) => ({ ...d, nin: e.target.value }))} />
              </div>
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn btn-ghost" onClick={() => loadAll(patientDID)}>
            Load
          </button>
          {!patient && (
            <>
              <button className="btn btn-ghost" onClick={handleCheckIdentity} disabled={loading}>
                Check identity (MPI)
              </button>
              <button className="btn btn-primary" onClick={handleRegister} disabled={loading}>
                Register this DID on-chain
              </button>
            </>
          )}
        </div>

        {identityResult && !patient && (
          <div style={{ marginTop: 14, padding: 12, border: '1px solid var(--line)', borderRadius: 8 }}>
            {identityResult.matchType === 'NEW' && (
              <p className="hint">No existing PatientChain record looks like a match — safe to register as new.</p>
            )}
            {identityResult.matchType === 'CONFIDENT_MATCH' && (
              <>
                <p className="hint">
                  This matches an existing PatientChain record ({identityResult.method}, score {identityResult.score}):{' '}
                  <code>{identityResult.patientDID}</code>
                </p>
                <button className="btn btn-primary" onClick={() => handleLinkToExisting(identityResult.patientDID)} disabled={loading}>
                  This is me — use existing identity
                </button>
              </>
            )}
            {identityResult.matchType === 'POSSIBLE_DUPLICATE' && (
              <>
                <p className="hint" style={{ color: 'var(--amber)' }}>
                  Possible duplicate — this looks similar to {identityResult.candidates.length} existing record(s).
                  A registrar should confirm before creating a new identity.
                </p>
                {identityResult.candidates.map((c) => (
                  <div key={c.patientDID} className="data-row">
                    <span className="k">{c.name} (score {c.score})</span>
                    <button className="btn btn-ghost" onClick={() => handleLinkToExisting(c.patientDID)} disabled={loading}>
                      This is me
                    </button>
                  </div>
                ))}
                <button className="btn btn-danger" style={{ marginTop: 8 }} onClick={handleRegisterAnyway} disabled={loading}>
                  None of these are me — register as new
                </button>
              </>
            )}
          </div>
        )}

        {patient && (
          <div style={{ marginTop: 14 }}>
            <div className="data-row">
              <span className="k">Registered</span>
              <span className="v">{new Date(patient.registeredAt).toLocaleString()}</span>
            </div>
            <div className="data-row">
              <span className="k">Public key</span>
              <span className="v">{patient.publicKey}</span>
            </div>
          </div>
        )}
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Section 3.7</span>
              <h2>Record references (on-chain pointers only)</h2>
            </div>
          </div>
          {references.length === 0 && <p className="hint">No record references yet.</p>}
          {references.map((r) => (
            <div className="data-row" key={r.refID}>
              <span className="k">
                {r.recordType} @ {r.hospitalID}
              </span>
              <span className="v">{new Date(r.date).toLocaleDateString()}</span>
            </div>
          ))}
          <p className="hint" style={{ marginTop: 10 }}>
            Only HospitalID, RecordType and Date are ever written here — never clinical content.
          </p>
        </div>

        <div className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Who can see my records</span>
              <h2>Access grants</h2>
            </div>
          </div>
          {grants.length === 0 && <p className="hint">No access requests yet.</p>}
          {grants.map((g) => (
            <div key={g.grantID} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong style={{ fontSize: 13.5 }}>{g.providerID}</strong>
                  {g.grantType === 'BREAK_GLASS' && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--amber)' }}>
                      EMERGENCY ACCESS {g.reviewed ? '(reviewed)' : '(pending review)'}
                    </span>
                  )}
                  <div className="hint">{g.hospitalID} — {g.status} — {g.purpose}</div>
                  {g.scope && g.scope.length > 0 && <div className="hint">Scope: {g.scope.join(', ')}</div>}
                  {g.grantType === 'BREAK_GLASS' && g.justification && (
                    <div className="hint">Justification: {g.justification}</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {g.status === 'PENDING' && (
                    <button className="btn btn-primary" onClick={() => handleGrant(g.grantID, 30)} disabled={loading}>
                      Approve (30 min)
                    </button>
                  )}
                  {g.status === 'ACTIVE' && (
                    <button className="btn btn-danger" onClick={() => handleRevoke(g)} disabled={loading}>
                      Revoke now
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Section 3.5 — immutable, patient-queryable</span>
            <h2>Access grant timeline</h2>
          </div>
        </div>
        <LedgerStrip entries={grantEntries} emptyLabel="No grant activity yet." />
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">AuditLog contract</span>
            <h2>Full audit trail</h2>
          </div>
        </div>
        {audit.length === 0 && <p className="hint">No audit entries yet.</p>}
        {audit.map((a) => (
          <div className="data-row" key={a.entryID}>
            <span className="k">
              {a.eventType} — {a.actorID} {a.queuedOffline ? '(synced from offline queue)' : ''}
            </span>
            <span className="v">{new Date(a.timestamp).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
