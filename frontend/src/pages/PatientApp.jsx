import { useEffect, useState } from 'react';
import { api } from '../api';
import { LedgerStrip } from '../components/LedgerStrip';

export function PatientApp() {
  const [patientDID, setPatientDID] = useState('');
  const [patient, setPatient] = useState(null);
  const [references, setReferences] = useState([]);
  const [grants, setGrants] = useState([]);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const [homeHospitalID, setHomeHospitalID] = useState('');
  const [homeHospitalNumber, setHomeHospitalNumber] = useState('');

  const [facilityHospitalID, setFacilityHospitalID] = useState('');
  const [facilityNumber, setFacilityNumber] = useState('');
  const [facilityDob, setFacilityDob] = useState('');
  const [facilityMatch, setFacilityMatch] = useState(null);
  const [facilityError, setFacilityError] = useState(null);
  const [linkedFacilities, setLinkedFacilities] = useState([]);

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
    if (patientDID) loadAll(patientDID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRegister() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.registerPatient({
        patientDID,
        hospitalID: homeHospitalID || undefined,
        mrn: homeHospitalNumber || undefined,
      });
      // When patientDID was left blank, the server mints one and returns
      // it -- sync it back so the DID field and the reload below reflect
      // it, instead of re-querying with the empty string that started this.
      setPatientDID(result.patient.patientDID);
      setPatient(result.patient);
      await loadAll(result.patient.patientDID);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Step 1 of the patient-asserted facility-linkage flow: look the
  // hospital number + DOB up against that hospital's own records. A match
  // returns just a name to confirm -- nothing is linked yet.
  async function handleLookupFacility() {
    setLoading(true);
    setFacilityError(null);
    try {
      const result = await api.linkFacility(patientDID, {
        hospitalID: facilityHospitalID,
        hospitalNumber: facilityNumber,
        dateOfBirth: facilityDob,
      });
      setFacilityMatch(result);
    } catch (e) {
      setFacilityError(e.message);
      setFacilityMatch(null);
    } finally {
      setLoading(false);
    }
  }

  // Step 2: only reachable after the patient has seen the matched name
  // and said "yes, this is me".
  async function handleConfirmFacilityLink() {
    setLoading(true);
    setFacilityError(null);
    try {
      const result = await api.confirmLink(patientDID, {
        hospitalID: facilityHospitalID,
        hospitalNumber: facilityNumber,
      });
      setLinkedFacilities((prev) => [...prev.filter((f) => f.hospitalID !== result.hospitalID), result]);
      setFacilityMatch(null);
      setFacilityNumber('');
      setFacilityDob('');
    } catch (e) {
      setFacilityError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleRejectFacilityMatch() {
    setFacilityMatch(null);
    setFacilityNumber('');
    setFacilityDob('');
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
          <input
            value={patientDID}
            onChange={(e) => setPatientDID(e.target.value)}
            placeholder="did:patientchain:... (leave blank to mint a new one)"
          />
        </div>

        {!patient && (
          <div className="grid-2">
            <div className="field">
              <label>Home hospital ID (optional)</label>
              <input
                value={homeHospitalID}
                onChange={(e) => setHomeHospitalID(e.target.value)}
                placeholder="leave blank to register a DID with no hospital yet"
              />
            </div>
            <div className="field">
              <label>Hospital number (optional — leave blank to have one assigned)</label>
              <input
                value={homeHospitalNumber}
                onChange={(e) => setHomeHospitalNumber(e.target.value)}
                disabled={!homeHospitalID}
              />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn btn-ghost" onClick={() => loadAll(patientDID)}>
            Load
          </button>
          {!patient && (
            <button className="btn btn-primary" onClick={handleRegister} disabled={loading}>
              Register this DID on-chain
            </button>
          )}
        </div>

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

      {patient && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Off-chain, patient-asserted, never on-chain</span>
              <h2>Link a facility</h2>
            </div>
          </div>
          <p className="hint">
            Already have a record at another hospital? Enter your hospital number and date of birth there and
            we'll check it against that hospital's own records.
          </p>

          {facilityError && (
            <p className="hint" style={{ color: 'var(--rust)' }}>
              {facilityError}
            </p>
          )}

          {!facilityMatch && (
            <>
              <div className="grid-2">
                <div className="field">
                  <label>Hospital ID</label>
                  <input
                    value={facilityHospitalID}
                    onChange={(e) => setFacilityHospitalID(e.target.value)}
                    placeholder="the hospital's ID, as its admin dashboard shows it"
                  />
                </div>
                <div className="field">
                  <label>Hospital number</label>
                  <input value={facilityNumber} onChange={(e) => setFacilityNumber(e.target.value)} />
                </div>
                <div className="field">
                  <label>Date of birth</label>
                  <input type="date" value={facilityDob} onChange={(e) => setFacilityDob(e.target.value)} />
                </div>
              </div>
              <button
                className="btn btn-primary"
                style={{ marginTop: 8 }}
                onClick={handleLookupFacility}
                disabled={loading || !facilityHospitalID || !facilityNumber || !facilityDob}
              >
                Look up
              </button>
            </>
          )}

          {facilityMatch && (
            <div style={{ marginTop: 14, padding: 12, border: '1px solid var(--line)', borderRadius: 8 }}>
              <p className="hint">We found a matching record at {facilityHospitalID}:</p>
              <p style={{ fontWeight: 600, fontSize: 16 }}>{facilityMatch.name}</p>
              <p className="hint">Is this you?</p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-primary" onClick={handleConfirmFacilityLink} disabled={loading}>
                  Yes
                </button>
                <button className="btn btn-ghost" onClick={handleRejectFacilityMatch} disabled={loading}>
                  No
                </button>
              </div>
            </div>
          )}

          {linkedFacilities.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {linkedFacilities.map((f) => (
                <div className="data-row" key={f.hospitalID}>
                  <span className="k">{f.hospitalID}</span>
                  <span className="v">linked ({f.hospitalNumber})</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
