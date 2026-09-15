import { useState } from 'react';
import { api } from '../api';

// FHIR resource types offered as granular scope checkboxes (docs/design.md
// Section 8). Psychiatric records default OFF, mirroring the design's
// own worked example of a doctor who should not automatically see them.
const SCOPE_OPTIONS = [
  { key: 'Observation', label: 'Laboratory', defaultChecked: true },
  { key: 'MedicationRequest', label: 'Medications', defaultChecked: true },
  { key: 'Encounter', label: 'Encounters', defaultChecked: false },
  { key: 'Condition', label: 'Psychiatric records', defaultChecked: false },
];

const PURPOSE_OPTIONS = ['Treatment', 'Referral', 'Second Opinion'];

export function ClinicianPortal() {
  const [patientDID, setPatientDID] = useState('did:patientchain:demo-patient-1');
  const [providerID, setProviderID] = useState('dr-adeyemi');
  const [hospitalID, setHospitalID] = useState('HospitalA-Lagos');
  const [purpose, setPurpose] = useState('Treatment');
  const [scope, setScope] = useState(
    Object.fromEntries(SCOPE_OPTIONS.map((o) => [o.key, o.defaultChecked]))
  );
  const [grant, setGrant] = useState(null);
  const [resolution, setResolution] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [queuedNotice, setQueuedNotice] = useState(null);

  const [justification, setJustification] = useState('');
  const [breakGlassNotice, setBreakGlassNotice] = useState(null);

  const selectedScope = SCOPE_OPTIONS.filter((o) => scope[o.key]).map((o) => o.key);

  async function handleRequest() {
    setLoading(true);
    setError(null);
    setQueuedNotice(null);
    setResolution(null);
    setBreakGlassNotice(null);
    try {
      const result = await api.requestAccess({ patientDID, providerID, hospitalID, scope: selectedScope, purpose });
      if (result.queued) {
        setQueuedNotice(
          `Network unreachable — request queued locally (id ${result.queueItem.id.slice(0, 8)}). It will submit automatically once connectivity returns.`
        );
        setGrant(null);
      } else {
        setGrant(result);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckStatus() {
    if (!grant) return;
    setLoading(true);
    setError(null);
    try {
      const updated = await api.checkAccess(grant.grantID);
      setGrant(updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleResolve() {
    if (!grant) return;
    setLoading(true);
    setError(null);
    setResolution(null);
    try {
      const result = await api.resolveRecord(grant.grantID, hospitalID, {
        purpose: grant.purpose,
        resourceTypes: grant.scope && grant.scope.length ? grant.scope.join(',') : undefined,
      });
      setResolution(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleBreakGlass() {
    setLoading(true);
    setError(null);
    setQueuedNotice(null);
    setResolution(null);
    setBreakGlassNotice(null);
    try {
      const result = await api.requestBreakGlass({ patientDID, providerID, hospitalID, justification });
      setGrant(result);
      setBreakGlassNotice(
        'This is an EMERGENCY OVERRIDE, not a patient-approved grant. It is logged as BREAK_GLASS_ACCESS, visible to the patient, and requires mandatory post-hoc review by the hospital.'
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}

      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Figure 3, steps 3–4</span>
            <h2>Request access to a patient's records</h2>
          </div>
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Patient DID</label>
            <input value={patientDID} onChange={(e) => setPatientDID(e.target.value)} />
          </div>
          <div className="field">
            <label>Your provider ID</label>
            <input value={providerID} onChange={(e) => setProviderID(e.target.value)} />
          </div>
          <div className="field">
            <label>Hospital</label>
            <select value={hospitalID} onChange={(e) => setHospitalID(e.target.value)}>
              <option value="HospitalA-Lagos">HospitalA-Lagos</option>
              <option value="HospitalB-Ibadan">HospitalB-Ibadan</option>
            </select>
          </div>
          <div className="field">
            <label>Purpose of use</label>
            <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {PURPOSE_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="field" style={{ marginTop: 4 }}>
          <label>Requested scope (FHIR resource types — Section 8)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 4 }}>
            {SCOPE_OPTIONS.map((o) => (
              <label key={o.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={!!scope[o.key]}
                  onChange={(e) => setScope((s) => ({ ...s, [o.key]: e.target.checked }))}
                />
                {o.label}
              </label>
            ))}
          </div>
        </div>

        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={handleRequest} disabled={loading}>
          Request access
        </button>
        {queuedNotice && <p className="hint" style={{ marginTop: 10 }}>{queuedNotice}</p>}
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">Section 35.1</span>
            <h2>Emergency (break-glass) access</h2>
          </div>
        </div>
        <p className="hint">
          Use only when the patient cannot grant access and immediate access is clinically necessary. Every
          break-glass access is active immediately, logged distinctly as <code>BREAK_GLASS_ACCESS</code>, and must
          be reviewed after the fact by the hospital (see Admin Dashboard).
        </p>
        <div className="field">
          <label>Justification (required)</label>
          <textarea
            rows={2}
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            placeholder="e.g. Unconscious patient in ER, unknown allergy history"
          />
        </div>
        <button
          className="btn btn-danger"
          onClick={handleBreakGlass}
          disabled={loading || !justification.trim()}
        >
          Request emergency access now
        </button>
        {breakGlassNotice && <p className="hint" style={{ marginTop: 10, color: 'var(--amber)' }}>{breakGlassNotice}</p>}
      </div>

      {grant && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">On-chain grant state</span>
              <h2>Grant {grant.grantID.slice(0, 8)}</h2>
            </div>
            <button className="btn btn-ghost" onClick={handleCheckStatus} disabled={loading}>
              Re-check status
            </button>
          </div>
          {grant.grantType === 'BREAK_GLASS' && (
            <div className="data-row">
              <span className="k">Type</span>
              <span className="v" style={{ color: 'var(--amber)' }}>
                BREAK_GLASS {grant.reviewed ? '(reviewed)' : '(review pending)'}
              </span>
            </div>
          )}
          <div className="data-row">
            <span className="k">Status</span>
            <span className="v">{grant.status}</span>
          </div>
          <div className="data-row">
            <span className="k">Purpose</span>
            <span className="v">{grant.purpose}</span>
          </div>
          {grant.scope && grant.scope.length > 0 && (
            <div className="data-row">
              <span className="k">Scope</span>
              <span className="v">{grant.scope.join(', ')}</span>
            </div>
          )}
          <div className="data-row">
            <span className="k">Requested</span>
            <span className="v">{new Date(grant.requestedAt).toLocaleString()}</span>
          </div>
          {grant.expiresAt && (
            <div className="data-row">
              <span className="k">Expires</span>
              <span className="v">{new Date(grant.expiresAt).toLocaleString()}</span>
            </div>
          )}
          {grant.status === 'PENDING' && (
            <p className="hint" style={{ marginTop: 10 }}>
              Switch to the Patient App tab (same demo patient) to approve or revoke this request.
            </p>
          )}

          {grant.status === 'ACTIVE' && (
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={handleResolve} disabled={loading}>
              Pull record via FHIR Adapter
            </button>
          )}
        </div>
      )}

      {resolution && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Figure 4 — record resolution</span>
              <h2>Resolved FHIR bundles from {hospitalID}</h2>
            </div>
          </div>
          <p className="hint">{resolution.resolution.note}</p>
          {resolution.bundles.length === 0 && <p className="hint">No records found at this hospital for this patient.</p>}
          {resolution.bundles.map((bundle) => (
            <div className="record-bundle" key={bundle.id}>
              <span className="rtype">{bundle.entry[0].resource.resourceType}</span>
              <div style={{ marginTop: 6, fontSize: 13 }}>
                {bundle.entry[0].resource.reasonCode?.[0]?.text ||
                  bundle.entry[0].resource.code?.text ||
                  'Clinical entry'}
                {bundle.entry[0].resource.valueString ? ` — ${bundle.entry[0].resource.valueString}` : ''}
              </div>
              <div className="hint" style={{ marginTop: 4 }}>{new Date(bundle.timestamp).toLocaleString()}</div>
            </div>
          ))}
          <p className="hint" style={{ marginTop: 10 }}>
            This bundle came directly from the hospital's own database — it was never written to the blockchain.
          </p>
        </div>
      )}
    </div>
  );
}
