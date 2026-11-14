import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../auth';
import './admin.css';
import { LedgerStrip } from '../components/LedgerStrip';
import { useLedgerEvents } from '../ledgerEvents';
import { ensureKeyPair, keysSupported, newGrantID, publicKeyOnDevice, signGrant, signRevoke } from '../patientKeys';

// A P-256 SPKI public key in base64 always starts with this prefix.
const SPKI_P256 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE';
import { useScreenCaptureSubject } from '../components/screenCaptureAudit';

export function PatientApp() {
  const { session, refresh } = useSession();
  const [patientDID, setPatientDID] = useState(session?.patientDID || '');
  // Key pairs are stored per account on this device.
  const account = session?.sub || 'demo-patient';
  const [keyOnDevice, setKeyOnDevice] = useState(null);
  // First-hospital confirmation before the Health ID is created (FR1).
  const [firstHospitalID, setFirstHospitalID] = useState('');
  const [firstNumber, setFirstNumber] = useState('');
  const [firstDob, setFirstDob] = useState('');
  const [firstMatch, setFirstMatch] = useState(null);
  useScreenCaptureSubject(patientDID);
  const [patient, setPatient] = useState(null);
  const [references, setReferences] = useState([]);
  const [grants, setGrants] = useState([]);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Hospital search & linking
  const [hospitalSearch, setHospitalSearch] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedHospital, setSelectedHospital] = useState(null);
  const [facilityNumber, setFacilityNumber] = useState('');
  const [facilityDob, setFacilityDob] = useState('');
  const [facilityMatch, setFacilityMatch] = useState(null);
  const [facilityError, setFacilityError] = useState(null);
  const [linkedFacilities, setLinkedFacilities] = useState([]);

  // All hospitals directory (for name lookups)
  const [allHospitals, setAllHospitals] = useState([]);
  // Cross-hospital approval: which hospitals to share per grant
  const [shareSelections, setShareSelections] = useState({}); // grantID -> Set of hospitalIDs
  const [shareViewer, setShareViewer] = useState('');
  const [shareSource, setShareSource] = useState('');
  const [shareDays, setShareDays] = useState(7);
  const [emergencyInfo, setEmergencyInfo] = useState({});

  useEffect(() => {
    api.searchHospitals('').then(setAllHospitals).catch(() => {});
  }, []);

  function hospitalName(hospitalID) {
    const h = allHospitals.find(x => x.hospitalID === hospitalID);
    return h ? h.name : hospitalID;
  }

  async function loadAll(did) {
    setError(null);
    try {
      const [p, refs, g, a, links] = await Promise.all([
        api.getPatient(did).catch(() => null),
        api.getReferences(did).catch(() => []),
        api.getGrantsForPatient(did).catch(() => []),
        api.getAuditTrail(did).catch(() => []),
        api.getMyFacilities(did).catch(() => []),
      ]);
      setPatient(p);
      setReferences(refs);
      setGrants(g);
      setAudit(a);
      setLinkedFacilities(links);
      if (p) setKeyOnDevice((await publicKeyOnDevice(account)) === p.publicKey);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    if (patientDID) loadAll(patientDID);
  }, []);

  // Event-driven: refresh when the ledger reports a change for this patient.
  useLedgerEvents(() => patientDID && loadAll(patientDID), { enabled: Boolean(patientDID) });

  // Patients registered with a key must sign; older keyless records cannot.
  const mustSign = Boolean(patient && typeof patient.publicKey === 'string' && patient.publicKey.startsWith(SPKI_P256));
  const sigFor = (fn) => (mustSign ? fn() : Promise.resolve(undefined));

  async function handleFirstLookup() {
    setLoading(true);
    setError(null);
    setFirstMatch(null);
    try {
      setFirstMatch(await api.registerLookup({ hospitalID: firstHospitalID, hospitalNumber: firstNumber.trim(), dateOfBirth: firstDob }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister() {
    setLoading(true);
    setError(null);
    try {
      // The key pair is created on this device; only the public key leaves it.
      const publicKey = keysSupported() ? await ensureKeyPair(account) : undefined;
      const result = await api.registerPatient({
        publicKey,
        ...(session ? { firstFacility: { hospitalID: firstHospitalID, hospitalNumber: firstNumber.trim() } } : {}),
      });
      setPatientDID(result.patient.patientDID);
      setPatient(result.patient);
      if (session) await refresh();
      await loadAll(result.patient.patientDID);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Hospital search
  async function handleHospitalSearch(query) {
    setHospitalSearch(query);
    if (query.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    try {
      const results = await api.searchHospitals(query.trim());
      const linkedIDs = new Set(linkedFacilities.map(f => f.hospitalID));
      setSearchResults(results.filter(h => !linkedIDs.has(h.hospitalID)));
    } catch {
      setSearchResults([]);
    }
  }

  function handleSelectHospital(hospital) {
    setSelectedHospital(hospital);
    setFacilityNumber('');
    setFacilityDob('');
    setFacilityMatch(null);
    setFacilityError(null);
    setHospitalSearch('');
    setSearchResults([]);
  }

  async function handleLinkHospital() {
    if (!selectedHospital || !facilityNumber || !facilityDob) return;
    setLoading(true);
    setFacilityError(null);
    try {
      const result = await api.linkFacility(patientDID, {
        hospitalID: selectedHospital.hospitalID,
        hospitalNumber: facilityNumber.trim(),
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

  async function handleConfirmLink() {
    setLoading(true);
    setFacilityError(null);
    try {
      const result = await api.confirmLink(patientDID, {
        hospitalID: selectedHospital.hospitalID,
        hospitalNumber: facilityNumber.trim(),
      });
      setLinkedFacilities(prev => [
        ...prev.filter(f => f.hospitalID !== result.hospitalID),
        { ...result, name: selectedHospital.name, location: selectedHospital.location },
      ]);
      setSelectedHospital(null);
      setFacilityNumber('');
      setFacilityDob('');
      setFacilityMatch(null);
    } catch (e) {
      setFacilityError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleCancelLink() {
    setSelectedHospital(null);
    setFacilityNumber('');
    setFacilityDob('');
    setFacilityMatch(null);
    setFacilityError(null);
  }

  function handleUnlink(hospitalID) {
    setLinkedFacilities(prev => prev.filter(f => f.hospitalID !== hospitalID));
  }

  // Access grant helpers
  async function handleGrant(grantID, minutes) {
    setLoading(true);
    setError(null);
    try {
      const signature = await sigFor(() => signGrant(account, grantID, minutes));
      await api.grantAccess(grantID, minutes, signature);
      await loadAll(patientDID);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleShareHospital(grantID, hospitalID) {
    setShareSelections(prev => {
      const current = new Set(prev[grantID] || []);
      if (current.has(hospitalID)) current.delete(hospitalID);
      else current.add(hospitalID);
      return { ...prev, [grantID]: current };
    });
  }

  async function handleApproveCrossHospital(grantID, durationMinutes) {
    const selected = shareSelections[grantID];
    if (!selected || selected.size === 0) {
      setError('Select at least one hospital to share records from');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Each grant is signed by the patient; the original request and every
      // cross-hospital grant are approved together in one ledger transaction.
      const targets = [...selected];
      const crossGrants = await Promise.all(
        targets.map(async (hospitalID) => {
          const id = newGrantID();
          return { hospitalID, grantID: id, signature: await sigFor(() => signGrant(account, id, durationMinutes)) };
        })
      );
      await api.approveCrossHospital(grantID, {
        targetHospitalIDs: targets,
        durationMinutes,
        signature: await sigFor(() => signGrant(account, grantID, durationMinutes)),
        crossGrants,
      });
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
        signature: await sigFor(() => signRevoke(account, grant.grantID)),
      });
      await loadAll(patientDID);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Standing share: clinicians at one of my hospitals may see my records from another.
  async function handleShare() {
    setLoading(true);
    setError(null);
    try {
      const id = newGrantID();
      const minutes = shareDays * 1440;
      await api.patientGrantHospital({
        hospitalID: shareSource,
        viewerHospitalID: shareViewer,
        durationMinutes: minutes,
        grantID: id,
        signature: await sigFor(() => signGrant(account, id, minutes)),
      });
      setShareViewer('');
      setShareSource('');
      await loadAll(patientDID);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Approve every pending request at once: one signed batch, one ledger
  // transaction (Section 3.4.4).
  async function handleApproveAll(minutes) {
    setLoading(true);
    setError(null);
    try {
      const items = await Promise.all(
        grants.filter((g) => g.status === 'PENDING').map(async (g) => ({
          grantID: g.grantID,
          durationMinutes: minutes,
          signature: await sigFor(() => signGrant(account, g.grantID, minutes)),
        }))
      );
      await api.batchGrant(items);
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
    title: `${g.providerID} @ ${hospitalName(g.hospitalID)}`,
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

  const pendingGrants = grants.filter(g => g.status === 'PENDING');
  const activeGrants = grants.filter(g => g.status === 'ACTIVE');
  const revokedGrants = grants.filter(g => g.status === 'REVOKED' || g.status === 'EXPIRED');
  const emergencyGrants = grants.filter((g) => g.grantType === 'BREAK_GLASS');

  // Who asked for each emergency access (off-chain, shown to the patient).
  useEffect(() => {
    for (const g of emergencyGrants) {
      if (emergencyInfo[g.grantID]) continue;
      api.getEmergencyDetails(g.grantID).then((d) => setEmergencyInfo((x) => ({ ...x, [g.grantID]: d }))).catch(() => {});
    }
  }, [grants]);

  return (
    <Routes>
      {/* ── My Health ID ─────────────────────────────────────── */}
      <Route index element={
        <div>
          {error && <div className="error-banner">{error}</div>}

          <div className="dash-welcome">
            <h2>Welcome{session?.sub ? `, ${session.sub}` : ''}</h2>
            <p>Manage your health identity, link hospitals, and control who accesses your records.</p>
          </div>

          <div className="dash-grid">
            <div className="dash-card">
              <div className="dash-card-icon blue">{'\u{1F91A}'}</div>
              <h3>Your Health ID</h3>
              {patient ? (
                <>
                  <p className="stat-value" style={{ fontSize: 13, wordBreak: 'break-all' }}>{patientDID}</p>
                  <p>Registered {new Date(patient.registeredAt).toLocaleDateString()}</p>
                </>
              ) : (
                <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>Not yet registered</p>
              )}
            </div>
            <div className="dash-card">
              <div className="dash-card-icon purple">{'\u{1F3E5}'}</div>
              <h3>My Hospitals</h3>
              <p className="stat-value">{linkedFacilities.length}</p>
              <p>Hospitals in your network</p>
            </div>
            <div className="dash-card">
              <div className="dash-card-icon green">{'\u{1F6E1}'}</div>
              <h3>Active Grants</h3>
              <p className="stat-value">{activeGrants.length}</p>
              <p>Hospitals/clinicians with access</p>
            </div>
            <div className="dash-card">
              <div className="dash-card-icon amber">{'\u{23F3}'}</div>
              <h3>Pending Requests</h3>
              <p className="stat-value">{pendingGrants.length}</p>
              <p>Awaiting your approval</p>
            </div>
          </div>

          {!patient ? (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <span className="eyebrow">Get started</span>
                  <h2>Create your Cevruni Health ID</h2>
                </div>
              </div>
              {error && <div className="error-banner">{error}</div>}
              <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginBottom: 16, lineHeight: 1.6 }}>
                Your Health ID is a unique, portable identity that works across all hospitals.
                First, confirm your record at the hospital where you registered first, using the hospital number on
                your card and your date of birth. A private signing key is then created on this device: you use it to
                approve or revoke access, and it never leaves the device.
              </p>
              {session && (
                <>
                  <div className="form-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                    <div className="field">
                      <label>First hospital</label>
                      <select value={firstHospitalID} onChange={(e) => { setFirstHospitalID(e.target.value); setFirstMatch(null); }}>
                        <option value="">Select…</option>
                        {allHospitals.map((h) => <option key={h.hospitalID} value={h.hospitalID}>{h.name}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label>Hospital number</label>
                      <input value={firstNumber} onChange={(e) => { setFirstNumber(e.target.value); setFirstMatch(null); }} placeholder="on your hospital card" />
                    </div>
                    <div className="field">
                      <label>Date of birth</label>
                      <input type="date" value={firstDob} onChange={(e) => { setFirstDob(e.target.value); setFirstMatch(null); }} />
                    </div>
                  </div>
                  {!firstMatch && (
                    <button className="btn btn-primary" onClick={handleFirstLookup} disabled={loading || !firstHospitalID || !firstNumber || !firstDob}>
                      {loading ? 'Checking…' : 'Find my record'}
                    </button>
                  )}
                </>
              )}
              {(!session || firstMatch) && (
                <div style={{ marginTop: 12 }}>
                  {firstMatch && (
                    <p style={{ fontSize: 15, marginBottom: 12 }}>
                      Is this you: <strong>{firstMatch.name}</strong>?
                    </p>
                  )}
                  <button className="btn btn-primary" onClick={handleRegister} disabled={loading} style={{ fontSize: 15, padding: '12px 28px' }}>
                    {loading ? 'Creating...' : firstMatch ? 'Yes, create my Health ID' : 'Create My Health ID'}
                  </button>
                  {firstMatch && <button className="btn btn-ghost" style={{ marginLeft: 8 }} onClick={() => setFirstMatch(null)}>No, that’s not me</button>}
                </div>
              )}
            </div>
          ) : (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <span className="eyebrow">Your identity</span>
                  <h2>Cevruni Health ID</h2>
                </div>
              </div>
              <div className="data-row"><span className="k">Health ID (DID)</span><span className="v" style={{ fontSize: 12, wordBreak: 'break-all' }}>{patientDID}</span></div>
              <div className="data-row"><span className="k">Registered</span><span className="v">{new Date(patient.registeredAt).toLocaleString()}</span></div>
              <div className="data-row"><span className="k">Public key</span><span className="v" style={{ fontSize: 12, wordBreak: 'break-all' }}>{patient.publicKey}</span></div>
              <div className="data-row">
                <span className="k">Signing key</span>
                <span className="v">
                  {!mustSign ? 'not set up (older Health ID)' : keyOnDevice ? 'on this device ✓' : 'not on this device: use the device where you created your Health ID'}
                </span>
              </div>
            </div>
          )}
        </div>
      } />

      {/* ── My Hospitals ─────────────────────────────────────── */}
      <Route path="facilities" element={
        <div>
          {error && <div className="error-banner">{error}</div>}

          <div className="dash-welcome">
            <h2>My Hospitals</h2>
            <p>Add the hospitals where you have records to your network. Your data stays at each hospital — only a secure link is created.</p>
          </div>

          {!patient ? (
            <div className="panel">
              <div className="panel-head"><div><span className="eyebrow">Setup required</span><h2>Register first</h2></div></div>
              <p className="hint">You need a Cevruni Health ID before you can add hospitals. Go to <strong>My Health ID</strong> in the sidebar to register.</p>
            </div>
          ) : (
            <>
              {/* My Network */}
              <div className="panel">
                <div className="panel-head"><div><span className="eyebrow">Your network</span><h2>My Hospital Network ({linkedFacilities.length})</h2></div></div>
                {linkedFacilities.length === 0 ? (
                  <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
                    No hospitals added yet. Search for a hospital below to add it to your network.
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {linkedFacilities.map((f) => (
                      <div key={f.hospitalID} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: 'var(--parchment)', borderRadius: 'var(--radius)', border: '1px solid var(--line)' }}>
                        <div style={{ width: 44, height: 44, borderRadius: 10, background: 'rgba(37,99,235,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>{'\u{1F3E5}'}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{f.name || hospitalName(f.hospitalID)}</div>
                          {f.location && <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{f.location}</div>}
                          <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Hospital No: <strong>{f.hospitalNumber}</strong></div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--sage)', background: 'var(--sage-bg)', padding: '4px 10px', borderRadius: 20 }}>Linked</span>
                          <button
                            className="btn btn-ghost"
                            style={{ fontSize: 12, padding: '4px 12px', color: 'var(--rust)' }}
                            onClick={() => handleUnlink(f.hospitalID)}
                          >
                            Unlink
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Search & add */}
              {!selectedHospital ? (
                <div className="panel">
                  <div className="panel-head"><div><span className="eyebrow">Add to network</span><h2>Find a Hospital</h2></div></div>
                  <div className="field">
                    <label>Search by hospital name</label>
                    <input
                      value={hospitalSearch}
                      onChange={(e) => handleHospitalSearch(e.target.value)}
                      placeholder="e.g. Langtang General Hospital, JUTH, Wase..."
                      style={{ fontSize: 15, padding: '12px 14px' }}
                    />
                  </div>
                  {searchResults.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                      {searchResults.map(h => (
                        <div key={h.hospitalID} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: 'white', borderRadius: 'var(--radius)', border: '1px solid var(--line)', cursor: 'pointer', transition: 'all 0.15s ease' }}
                          onClick={() => handleSelectHospital(h)}
                          onMouseOver={e => { e.currentTarget.style.borderColor = 'var(--brand-blue)'; e.currentTarget.style.background = 'rgba(37,99,235,0.03)'; }}
                          onMouseOut={e => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.background = 'white'; }}
                        >
                          <div style={{ width: 44, height: 44, borderRadius: 10, background: 'rgba(37,99,235,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0 }}>{'\u{1F3E5}'}</div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 600, fontSize: 14 }}>{h.name}</div>
                            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{h.location} — {h.type}</div>
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--brand-blue)' }}>Add to network &#x2192;</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {hospitalSearch.trim().length >= 2 && searchResults.length === 0 && (
                    <p className="hint" style={{ marginTop: 10 }}>No hospitals found matching "{hospitalSearch}".</p>
                  )}
                </div>
              ) : (
                <div className="panel">
                  <div className="panel-head">
                    <div><span className="eyebrow">Adding to network</span><h2>{selectedHospital.name}</h2></div>
                    <button className="btn btn-ghost" onClick={handleCancelLink}>Cancel</button>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 4 }}>{selectedHospital.location} — {selectedHospital.type}</p>
                  {facilityError && <div className="error-banner" style={{ marginTop: 12 }}>{facilityError}</div>}
                  {!facilityMatch ? (
                    <>
                      <p style={{ fontSize: 14, color: 'var(--ink-soft)', margin: '16px 0', lineHeight: 1.6 }}>
                        Enter your hospital number — this is the ID number <strong>{selectedHospital.name}</strong> gave you. We'll verify it to securely link your records.
                      </p>
                      <div className="grid-2">
                        <div className="field">
                          <label>Your hospital number</label>
                          <input value={facilityNumber} onChange={(e) => setFacilityNumber(e.target.value)} placeholder="e.g. 536728" style={{ fontSize: 15, padding: '12px 14px' }} />
                        </div>
                        <div className="field">
                          <label>Date of birth (for verification)</label>
                          <input type="date" value={facilityDob} onChange={(e) => setFacilityDob(e.target.value)} style={{ fontSize: 15, padding: '12px 14px' }} />
                        </div>
                      </div>
                      <button className="btn btn-primary" onClick={handleLinkHospital} disabled={loading || !facilityNumber.trim() || !facilityDob} style={{ marginTop: 4, fontSize: 14, padding: '11px 24px' }}>
                        {loading ? 'Verifying...' : 'Verify & Add to Network'}
                      </button>
                    </>
                  ) : (
                    <div style={{ marginTop: 16, padding: 20, background: 'var(--sage-bg)', borderRadius: 'var(--radius-lg)', border: '1px solid rgba(16,185,129,0.2)' }}>
                      <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>Record found!</p>
                      <p style={{ fontSize: 16, fontWeight: 700, margin: '8px 0' }}>{facilityMatch.name}</p>
                      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 16 }}>Is this you? Confirming will add <strong>{selectedHospital.name}</strong> to your network.</p>
                      <div style={{ display: 'flex', gap: 10 }}>
                        <button className="btn btn-primary" onClick={handleConfirmLink} disabled={loading} style={{ fontSize: 14, padding: '11px 24px' }}>{loading ? 'Linking...' : 'Yes, add to my network'}</button>
                        <button className="btn btn-ghost" onClick={handleCancelLink} disabled={loading}>Not me — cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      } />

      {/* ── My Records ───────────────────────────────────────── */}
      <Route path="records" element={
        <div>
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">On-chain pointers only</span><h2>Record References</h2></div></div>
            {references.length === 0 && <p className="hint">No record references yet. Records appear here once a hospital registers them.</p>}
            {references.map((r) => (
              <div className="data-row" key={r.refID}>
                <span className="k">{r.recordType} @ {hospitalName(r.hospitalID)}</span>
                <span className="v">{new Date(r.date).toLocaleDateString()}</span>
              </div>
            ))}
            <p className="hint" style={{ marginTop: 10 }}>Only HospitalID, RecordType and Date are written here — never clinical content.</p>
          </div>
        </div>
      } />

      {/* ── Access Control ───────────────────────────────────── */}
      <Route path="access" element={
        <div>
          <div className="dash-welcome">
            <h2>Access Control</h2>
            <p>Decide which clinicians may see your records from your other hospitals. Your records never leave the hospital that holds them; a clinician only views them, for as long as you allow.</p>
          </div>
          {error && <div className="error-banner">{error}</div>}

          {/* Emergency accesses: an account to the patient (GAID 2025 Art. 24(4)) */}
          {emergencyGrants.length > 0 && (
            <div className="panel pa-emergency">
              <div className="panel-head"><div><span className="eyebrow">Emergency access to your records</span><h2>Opened without your approval</h2></div></div>
              <p className="hint">In an emergency, when you could not consent, a clinician may open your essential records (allergies, medications, diagnoses, encounters, lab results) from another hospital in your network for a limited time. Every case is logged and reviewed by the hospitals.</p>
              {emergencyGrants.map((g) => {
                const d = emergencyInfo[g.grantID];
                return (
                  <div key={g.grantID} className="pa-em-row">
                    <div className="pa-em-icon">{'\u{1F6A8}'}</div>
                    <div style={{ flex: 1 }}>
                      <div><strong>{g.providerID}</strong> at <strong>{g.viewedFromName}</strong> opened your records from <strong>{g.recordsAtName}</strong></div>
                      <div className="hint">{new Date(g.grantedAt).toLocaleString()} · {g.status === 'ACTIVE' ? `active until ${new Date(g.expiresAt).toLocaleString()}` : 'ended'}{g.reviewed ? ' · reviewed by the hospital' : ' · awaiting hospital review'}</div>
                      <div className="hint">Reason: {g.justification}</div>
                      {d?.representative && <div className="hint">Asked for by your {d.representative.relationship || 'representative'} {d.representative.name}{d.representative.phone ? ` (${d.representative.phone})` : ''}</div>}
                      {(g.extensions || []).map((x, i) => <div key={i} className="hint">Extended +{x.minutes} min: {x.reason}</div>)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Requests awaiting approval */}
          <div className="panel" style={pendingGrants.length ? { borderLeft: '4px solid var(--amber)' } : undefined}>
            <div className="panel-head">
              <div><span className="eyebrow">Awaiting your decision</span><h2>Requests ({pendingGrants.length})</h2></div>
              {pendingGrants.length > 1 && (
                <button className="btn btn-primary" onClick={() => handleApproveAll(1440)} disabled={loading} title="All approvals are signed and sent as one ledger transaction">
                  Approve all for 24 h
                </button>
              )}
            </div>
            {pendingGrants.length === 0 && <p className="hint">No requests right now. You will be notified here as soon as a clinician asks.</p>}
            {pendingGrants.map((g) => (
              <div key={g.grantID} className="pa-req">
                <div className="pa-req-icon">{'\u{1F514}'}</div>
                <div style={{ flex: 1 }}>
                  <div className="pa-req-title"><strong>{g.providerID}</strong>{g.providerRole ? ` (${g.providerRole})` : ''} at <strong>{g.viewedFromName}</strong> asks to see your records from <strong>{g.recordsAtName}</strong></div>
                  <div className="hint">Purpose: {g.purpose} · Record types: {g.scope && g.scope.length ? g.scope.join(', ') : 'all'} · asked {new Date(g.requestedAt).toLocaleString()}</div>
                </div>
                <div className="pa-req-actions">
                  <button className="btn btn-primary" onClick={() => handleGrant(g.grantID, 1440)} disabled={loading}>Approve 24 h</button>
                  <button className="btn btn-ghost" onClick={() => handleGrant(g.grantID, 60)} disabled={loading}>1 h</button>
                  <button className="btn btn-danger" onClick={() => handleRevoke(g)} disabled={loading}>Decline</button>
                </div>
              </div>
            ))}
          </div>

          {/* Standing share between two of the patient's hospitals */}
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">Share ahead of time</span><h2>Let a hospital see records from another</h2></div></div>
            {linkedFacilities.length < 2 ? (
              <p className="hint">Add at least two hospitals under <strong>My Hospitals</strong> to share between them.</p>
            ) : (
              <div className="pa-share">
                <div className="field">
                  <label>Clinicians at</label>
                  <select value={shareViewer} onChange={(e) => setShareViewer(e.target.value)}>
                    <option value="">Select…</option>
                    {linkedFacilities.map((f) => <option key={f.hospitalID} value={f.hospitalID}>{hospitalName(f.hospitalID)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>may see my records from</label>
                  <select value={shareSource} onChange={(e) => setShareSource(e.target.value)}>
                    <option value="">Select…</option>
                    {linkedFacilities.filter((f) => f.hospitalID !== shareViewer).map((f) => <option key={f.hospitalID} value={f.hospitalID}>{hospitalName(f.hospitalID)}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>for</label>
                  <select value={shareDays} onChange={(e) => setShareDays(Number(e.target.value))}>
                    <option value={1}>1 day</option>
                    <option value={7}>1 week</option>
                    <option value={30}>30 days</option>
                  </select>
                </div>
                <button className="btn btn-primary" disabled={loading || !shareViewer || !shareSource || shareViewer === shareSource} onClick={handleShare}>Share</button>
              </div>
            )}
          </div>

          {/* Active grants */}
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">Currently allowed</span><h2>Who can see what ({activeGrants.filter((g) => g.grantType !== 'BREAK_GLASS').length})</h2></div></div>
            {activeGrants.filter((g) => g.grantType !== 'BREAK_GLASS').length === 0 && <p className="hint">Nobody has access to your records at another hospital.</p>}
            {activeGrants.filter((g) => g.grantType !== 'BREAK_GLASS').map((g) => (
              <div key={g.grantID} className="pa-active">
                <div style={{ flex: 1 }}>
                  <strong>{g.providerID.startsWith('hospital-staff@') ? `All clinicians at ${g.viewedFromName}` : `${g.providerID} at ${g.viewedFromName}`}</strong>
                  <span className="hint"> can see your <strong>{g.recordsAtName}</strong> records</span>
                  <div className="hint">
                    {g.scope && g.scope.length ? g.scope.join(', ') : 'all record types'} · {g.purpose} · until {new Date(g.expiresAt).toLocaleString()}
                    {g.patientSigned && ' · signed by you ✓'}
                  </div>
                </div>
                <button className="btn btn-danger" onClick={() => handleRevoke(g)} disabled={loading}>Revoke</button>
              </div>
            ))}
          </div>

          {revokedGrants.length > 0 && (
            <div className="panel">
              <div className="panel-head"><div><span className="eyebrow">History</span><h2>Past grants</h2></div></div>
              {revokedGrants.map((g) => (
                <div className="data-row" key={g.grantID}>
                  <span className="k">{g.providerID} ({g.viewedFromName}) — {g.recordsAtName} records — {g.purpose}</span>
                  <span className="v" style={{ color: 'var(--rust)' }}>{g.status === 'REVOKED' && !g.grantedAt ? 'DECLINED' : g.status}</span>
                </div>
              ))}
            </div>
          )}

          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">Immutable timeline</span><h2>Grant Activity</h2></div></div>
            <LedgerStrip entries={grantEntries} emptyLabel="No grant activity yet." />
          </div>
        </div>
      } />

      {/* ── Audit Trail ──────────────────────────────────────── */}
      <Route path="audit" element={
        <div>
          <div className="panel">
            <div className="panel-head"><div><span className="eyebrow">Blockchain audit log</span><h2>Full Audit Trail</h2></div></div>
            {audit.length === 0 && <p className="hint">No audit entries yet. All access events are recorded immutably on-chain.</p>}
            {audit.map((a) => (
              <div className="data-row" key={a.entryID}>
                <span className="k">{a.eventType} — {a.actorID} {a.queuedOffline ? '(synced from offline)' : ''}</span>
                <span className="v">{new Date(a.timestamp).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      } />
    </Routes>
  );
}
