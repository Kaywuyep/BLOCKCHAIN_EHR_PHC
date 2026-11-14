import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import './admin.css';

/**
 * HospitalSetup — System Admin: onboard and manage hospitals.
 *
 * A four-step wizard: Details → Connection (FHIR / HL7 ADT / both / manual)
 * → Hospital admin → Review. Each connection type has a built-in test
 * (FHIR: capability statement + OAuth2 token; HL7: dry-run an ADT message
 * against the field mapping) so the admin knows it works before saving.
 */

const INTEGRATION_CHOICES = [
  {
    key: 'hl7',
    title: 'HL7 v2 ADT feed',
    body: 'The hospital’s interface engine (Mirth, Rhapsody, etc.) sends admit / update / discharge messages to us. Most common for hospital information systems.',
  },
  {
    key: 'fhir',
    title: 'FHIR R4 API',
    body: 'The hospital’s EMR exposes a FHIR REST API (OpenMRS, HAPI FHIR, Epic, Cerner…). We fetch records when a patient grants access.',
  },
  {
    key: 'both',
    title: 'Both',
    body: 'ADT feed keeps the patient roster current; FHIR API supplies clinical records on request.',
  },
  {
    key: 'rest',
    title: 'Custom REST push',
    body: 'Neither FHIR nor HL7: the vendor, or a small export job at the hospital, sends records to Cevruni’s REST endpoint as FHIR R4 JSON.',
  },
  {
    key: 'manual',
    title: 'No integration yet',
    body: 'Staff maintain the patient roster by hand in Patient Roster. You can switch to HL7 or FHIR later.',
  },
];

const FIELD_LABELS = {
  hospitalNumber: 'Hospital number (MRN)',
  familyName: 'Family name',
  givenName: 'Given name',
  dob: 'Date of birth',
  sex: 'Sex',
  patientClass: 'Patient class',
  attendingId: 'Attending doctor ID',
  admitDateTime: 'Admit date/time',
  dischargeDateTime: 'Discharge date/time',
};

const INTEGRATION_LABEL = { hl7: 'HL7 ADT', fhir: 'FHIR API', both: 'HL7 ADT + FHIR', rest: 'Custom REST', manual: 'Manual roster' };

function emptyForm(options) {
  return {
    name: '',
    hospitalID: '',
    location: '',
    type: options?.hospitalTypes?.[0] || '',
    integration: 'hl7',
    fhir: {
      baseUrl: '',
      authType: 'client-secret',
      tokenUrl: '',
      clientId: '',
      clientSecret: '',
      mrnIdentifierSystem: '',
      scope: options?.defaultFhirScope || '',
      clientCertPath: '',
      clientKeyPath: '',
      caPath: '',
    },
    hl7: {
      mllpEnabled: true,
      mllpPort: options?.nextMllpPort || 5001,
      httpEnabled: true,
      hl7Version: '2.5',
      allowedIps: '',
      bindAddress: '',
      fieldMap: {},
    },
    adminUser: { subject: '', displayName: '' },
  };
}

function fromHospital(h, options) {
  const base = emptyForm(options);
  return {
    ...base,
    name: h.name,
    hospitalID: h.hospitalID,
    location: h.location,
    type: h.type,
    integration: h.integration,
    fhir: h.fhir ? { ...base.fhir, ...h.fhir, clientSecret: '' } : base.fhir,
    hl7: h.hl7
      ? { ...base.hl7, ...h.hl7, mllpPort: h.hl7.mllpPort || base.hl7.mllpPort, allowedIps: (h.hl7.allowedIps || []).join(', ') }
      : base.hl7,
  };
}

function toPayload(form, { editing }) {
  const usesFhir = form.integration === 'fhir' || form.integration === 'both';
  const usesHl7 = form.integration === 'hl7' || form.integration === 'both';
  const payload = {
    name: form.name.trim(),
    location: form.location.trim(),
    type: form.type,
    integration: form.integration,
    fhir: usesFhir ? form.fhir : null,
    hl7: usesHl7
      ? { ...form.hl7, mllpPort: Number(form.hl7.mllpPort), allowedIps: form.hl7.allowedIps.split(/[\s,]+/).filter(Boolean) }
      : null,
  };
  if (!editing) {
    payload.hospitalID = form.hospitalID.trim() || undefined;
    if (form.adminUser.subject.trim()) payload.adminUser = form.adminUser;
  }
  return payload;
}

function slugify(name) {
  return name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function StatusPill({ hospital }) {
  if (hospital.status !== 'active') return <span className="pill pill-muted">Inactive</span>;
  const rt = hospital.runtime?.status;
  if (rt === 'listening') return <span className="pill pill-ok">Listening</span>;
  if (rt === 'receiving') return <span className="pill pill-ok">Receiving</span>;
  if (rt === 'error') return <span className="pill pill-bad">Error</span>;
  return <span className="pill pill-info">Active</span>;
}

function TestResult({ result }) {
  if (!result) return null;
  if (result.error) return <div className="test-result bad">{result.error}</div>;
  return (
    <div className={`test-result ${result.ok ? 'ok' : 'bad'}`}>
      {(result.steps || []).map((s) => (
        <div key={s.step} className="test-step">
          <span>{s.ok ? '✓' : '✕'}</span>
          <strong>{s.step}</strong>
          <span className="test-detail">{s.detail}</span>
        </div>
      ))}
    </div>
  );
}

export function HospitalSetup() {
  const [options, setOptions] = useState(null);
  const [hospitals, setHospitals] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [mode, setMode] = useState('list'); // list | create | edit
  const [editingID, setEditingID] = useState(null);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(emptyForm(null));
  const [idTouched, setIdTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fhirTest, setFhirTest] = useState(null);
  const [hl7Sample, setHl7Sample] = useState('');
  const [hl7Test, setHl7Test] = useState(null);
  const [testing, setTesting] = useState(false);
  const [showMapping, setShowMapping] = useState(false);

  async function load() {
    try {
      const [o, h] = await Promise.all([api.adminHospitalOptions(), api.adminListHospitals()]);
      setOptions(o);
      setHospitals(h);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(() => api.adminListHospitals().then(setHospitals).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, []);

  const editing = mode === 'edit';
  const usesFhir = form.integration === 'fhir' || form.integration === 'both';
  const usesHl7 = form.integration === 'hl7' || form.integration === 'both';
  const steps = editing ? ['Details', 'Connection', 'Review'] : ['Details', 'Connection', 'Hospital admin', 'Review'];
  const reviewStep = steps.length - 1;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setFhir = (patch) => {
    setFhirTest(null);
    setForm((f) => ({ ...f, fhir: { ...f.fhir, ...patch } }));
  };
  const setHl7 = (patch) => setForm((f) => ({ ...f, hl7: { ...f.hl7, ...patch } }));

  function startCreate() {
    setForm(emptyForm(options));
    setIdTouched(false);
    setStep(0);
    setFhirTest(null);
    setHl7Test(null);
    setHl7Sample(options?.sampleAdtMessage || '');
    setEditingID(null);
    setMode('create');
    setNotice(null);
    setError(null);
  }

  function startEdit(h) {
    setForm(fromHospital(h, options));
    setIdTouched(true);
    setStep(0);
    setFhirTest(null);
    setHl7Test(null);
    setHl7Sample(options?.sampleAdtMessage || '');
    setEditingID(h.hospitalID);
    setMode('edit');
    setNotice(null);
    setError(null);
  }

  // Simple per-step checks so mistakes show before the server is asked.
  const stepProblem = useMemo(() => {
    if (step === 0) {
      if (form.name.trim().length < 3) return 'Enter the hospital name.';
      if (!editing && form.hospitalID && !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(form.hospitalID)) {
        return 'Hospital ID: lower-case letters, digits and hyphens only.';
      }
    }
    if (step === 1) {
      if (usesFhir) {
        if (!/^https?:\/\//.test(form.fhir.baseUrl)) return 'Enter the FHIR base URL (starts with https://).';
        if (form.fhir.authType !== 'none' && (!form.fhir.tokenUrl || !form.fhir.clientId)) return 'Enter the token URL and client ID.';
        if (form.fhir.authType === 'client-secret' && !form.fhir.clientSecret && !(editing && form.fhir.hasClientSecret)) {
          return 'Enter the client secret.';
        }
        if (!form.fhir.mrnIdentifierSystem) return 'Enter the MRN identifier system.';
      }
      if (usesHl7) {
        if (!form.hl7.mllpEnabled && !form.hl7.httpEnabled) return 'Turn on at least one way to receive HL7 messages.';
        if (form.hl7.mllpEnabled && !(Number(form.hl7.mllpPort) >= 1024 && Number(form.hl7.mllpPort) <= 65535)) {
          return 'MLLP port must be between 1024 and 65535.';
        }
      }
    }
    return null;
  }, [step, form, editing, usesFhir, usesHl7]);

  async function testFhir() {
    setTesting(true);
    try {
      setFhirTest(await api.adminTestFhir({ ...form.fhir, hospitalID: editingID || undefined }));
    } catch (e) {
      setFhirTest({ error: e.message });
    } finally {
      setTesting(false);
    }
  }

  async function testHl7() {
    setTesting(true);
    try {
      setHl7Test(await api.adminTestHl7({ message: hl7Sample, fieldMap: form.hl7.fieldMap }));
    } catch (e) {
      setHl7Test({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = toPayload(form, { editing });
      const saved = editing ? await api.adminUpdateHospital(editingID, payload) : await api.adminCreateHospital(payload);
      let msg = editing ? `${saved.name} updated.` : `${saved.name} is set up.`;
      if (saved.adminUser) msg += ` Hospital admin “${saved.adminUser.subject}” can now sign in.`;
      if (saved.adminUserError) msg += ` The admin account was not created: ${saved.adminUserError}`;
      setNotice({ text: msg, hospital: saved });
      setMode('list');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(h) {
    try {
      await api.adminSetHospitalStatus(h.hospitalID, h.status === 'active' ? 'inactive' : 'active');
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  // ── List ──────────────────────────────────────────────────────────────
  if (mode === 'list') {
    return (
      <div>
        {error && <div className="error-banner">{error}</div>}
        {notice && (
          <div className="notice-banner">
            {notice.text}
            {notice.hospital && <ConnectionInstructions hospital={notice.hospital} options={options} />}
          </div>
        )}
        <div className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">System admin</span>
              <h2>Hospitals</h2>
            </div>
            <button className="btn btn-primary" onClick={startCreate} disabled={!options}>+ Add hospital</button>
          </div>
          <p className="hint">
            Every hospital connected to Cevruni. Patients see active hospitals in “My Hospitals”; clinicians and admins are
            tied to one hospital. Changes take effect immediately, with no restart.
          </p>
          <div className="table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Hospital</th>
                  <th>Connection</th>
                  <th>Status</th>
                  <th>Messages</th>
                  <th>Staff</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {hospitals.map((h) => (
                  <tr key={h.hospitalID} className={h.status !== 'active' ? 'row-muted' : ''}>
                    <td>
                      <div className="cell-title">{h.name}</div>
                      <div className="cell-sub">{h.hospitalID}{h.location ? ` · ${h.location}` : ''}</div>
                    </td>
                    <td>
                      <div>{INTEGRATION_LABEL[h.integration]}</div>
                      <div className="cell-sub">
                        {h.hl7?.mllpEnabled && `MLLP :${h.hl7.mllpPort}`}
                        {h.hl7?.mllpEnabled && h.hl7?.httpEnabled && ' · '}
                        {h.hl7?.httpEnabled && 'HTTP'}
                        {h.fhir && `${h.hl7 ? ' · ' : ''}${new URL(h.fhir.baseUrl).host}`}
                      </div>
                    </td>
                    <td>
                      <StatusPill hospital={h} />
                      {h.runtime?.error && h.status === 'active' && <div className="cell-sub">{h.runtime.error}</div>}
                    </td>
                    <td>
                      {h.runtime && (h.integration === 'hl7' || h.integration === 'both') ? (
                        <>
                          <div>{h.runtime.messagesAccepted} accepted</div>
                          <div className="cell-sub">
                            {h.runtime.messagesRejected} rejected
                            {h.runtime.lastMessageAt && ` · last ${new Date(h.runtime.lastMessageAt).toLocaleString()}`}
                          </div>
                        </>
                      ) : (
                        <span className="cell-sub">—</span>
                      )}
                    </td>
                    <td>
                      {h.staffCount}
                      {h.adminCount === 0 && <div className="cell-sub warn">no hospital admin</div>}
                    </td>
                    <td className="cell-actions">
                      <button className="btn btn-ghost" onClick={() => startEdit(h)}>Edit</button>
                      <button className={`btn ${h.status === 'active' ? 'btn-danger' : 'btn-ghost'}`} onClick={() => toggleStatus(h)}>
                        {h.status === 'active' ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
                {hospitals.length === 0 && (
                  <tr><td colSpan={6} className="hint">No hospitals yet. Click “Add hospital” to connect the first one.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // ── Wizard ────────────────────────────────────────────────────────────
  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">{editing ? `Editing ${editingID}` : 'New hospital'}</span>
            <h2>{editing ? form.name : 'Add a hospital'}</h2>
          </div>
          <button className="btn btn-ghost" onClick={() => setMode('list')}>Cancel</button>
        </div>

        <ol className="wizard-steps">
          {steps.map((label, i) => (
            <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''}>
              <button type="button" onClick={() => i < step && setStep(i)} disabled={i > step}>
                <span className="wizard-num">{i < step ? '✓' : i + 1}</span>
                {label}
              </button>
            </li>
          ))}
        </ol>

        {/* Step 1: details */}
        {step === 0 && (
          <div className="wizard-body">
            <div className="form-grid">
              <div className="field span-2">
                <label>Hospital name</label>
                <input
                  autoFocus
                  value={form.name}
                  placeholder="e.g. General Hospital Pankshin"
                  onChange={(e) => set({ name: e.target.value, ...(idTouched || editing ? {} : { hospitalID: slugify(e.target.value) }) })}
                />
              </div>
              <div className="field">
                <label>Hospital ID</label>
                <input
                  value={form.hospitalID}
                  disabled={editing}
                  onChange={(e) => { setIdTouched(true); set({ hospitalID: e.target.value.toLowerCase() }); }}
                />
                <span className="field-help">
                  {editing ? 'Cannot be changed: patient links and the audit trail use it.' : 'Filled in from the name. Used in URLs and HL7 routing; it cannot be changed later.'}
                </span>
              </div>
              <div className="field">
                <label>Type</label>
                <select value={form.type} onChange={(e) => set({ type: e.target.value })}>
                  {(options?.hospitalTypes || []).map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div className="field span-2">
                <label>Location</label>
                <input value={form.location} placeholder="Town, State" onChange={(e) => set({ location: e.target.value })} />
              </div>
            </div>
          </div>
        )}

        {/* Step 2: connection */}
        {step === 1 && (
          <div className="wizard-body">
            <label className="section-label">How do this hospital’s records reach Cevruni?</label>
            <div className="choice-grid">
              {INTEGRATION_CHOICES.map((c) => (
                <button
                  type="button"
                  key={c.key}
                  className={`choice-card ${form.integration === c.key ? 'selected' : ''}`}
                  onClick={() => set({ integration: c.key })}
                >
                  <strong>{c.title}</strong>
                  <span>{c.body}</span>
                </button>
              ))}
            </div>

            {usesHl7 && (
              <fieldset className="config-block">
                <legend>HL7 v2 ADT feed</legend>
                <div className="form-grid">
                  <label className="toggle span-2">
                    <input type="checkbox" checked={form.hl7.mllpEnabled} onChange={(e) => setHl7({ mllpEnabled: e.target.checked })} />
                    <span>
                      <strong>MLLP (TCP)</strong>: the standard way interface engines send HL7. We listen on a port for this hospital.
                    </span>
                  </label>
                  {form.hl7.mllpEnabled && (
                    <>
                      <div className="field">
                        <label>MLLP port</label>
                        <input type="number" min="1024" max="65535" value={form.hl7.mllpPort} onChange={(e) => setHl7({ mllpPort: e.target.value })} />
                        <span className="field-help">Suggested: next free port. Must be open in the firewall for the hospital’s engine.</span>
                      </div>
                      <div className="field">
                        <label>HL7 version</label>
                        <select value={form.hl7.hl7Version} onChange={(e) => setHl7({ hl7Version: e.target.value })}>
                          {(options?.hl7Versions || []).map((v) => <option key={v}>{v}</option>)}
                        </select>
                      </div>
                      <div className="field">
                        <label>Allowed sender IPs <span className="optional">optional</span></label>
                        <input value={form.hl7.allowedIps} placeholder="10.20.0.15, 10.20.0.16" onChange={(e) => setHl7({ allowedIps: e.target.value })} />
                        <span className="field-help">Connections from any other address are dropped. Recommended in production.</span>
                      </div>
                      <div className="field">
                        <label>Bind address <span className="optional">optional</span></label>
                        <input value={form.hl7.bindAddress} placeholder="all interfaces" onChange={(e) => setHl7({ bindAddress: e.target.value })} />
                        <span className="field-help">Listen only on this interface, e.g. the VPN address.</span>
                      </div>
                      {options && !options.mllpEnabledOnServer && (
                        <div className="inline-warn span-2">
                          MLLP listeners are off on this server (HL7_MLLP_ENABLED is not true). The settings are saved and the
                          listener starts once it is turned on. HTTP delivery works now.
                        </div>
                      )}
                    </>
                  )}
                  <label className="toggle span-2">
                    <input type="checkbox" checked={form.hl7.httpEnabled} onChange={(e) => setHl7({ httpEnabled: e.target.checked })} />
                    <span>
                      <strong>HTTPS POST</strong>: for engines that send over HTTP instead, to{' '}
                      <code>/api/hl7/adt/{form.hospitalID || 'hospital-id'}</code>
                    </span>
                  </label>
                </div>

                <button type="button" className="link-btn" onClick={() => setShowMapping((s) => !s)}>
                  {showMapping ? '▾' : '▸'} Field mapping and test message
                </button>
                {showMapping && (
                  <div className="mapping">
                    <p className="hint">
                      Leave blank to use the HL7 standard positions. Only change a field if this hospital’s feed puts it somewhere else
                      (e.g. MRN in PID-2 instead of PID-3). Paste a real (de-identified) message from their engine and click Test.
                    </p>
                    <div className="form-grid three">
                      {Object.entries(FIELD_LABELS).map(([key, label]) => (
                        <div className="field" key={key}>
                          <label>{label}</label>
                          <input
                            value={form.hl7.fieldMap[key] || ''}
                            placeholder={options?.defaultFieldMap?.[key]}
                            onChange={(e) => { setHl7Test(null); setHl7({ fieldMap: { ...form.hl7.fieldMap, [key]: e.target.value.toUpperCase() } }); }}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="field">
                      <label>Sample ADT message</label>
                      <textarea rows={6} className="mono" value={hl7Sample} onChange={(e) => { setHl7Test(null); setHl7Sample(e.target.value); }} />
                    </div>
                    <button type="button" className="btn btn-ghost" onClick={testHl7} disabled={testing || !hl7Sample.trim()}>
                      {testing ? 'Testing…' : 'Test message'}
                    </button>
                    {hl7Test && (
                      hl7Test.ok ? (
                        <div className="test-result ok">
                          <div className="test-step"><span>✓</span><strong>Message read successfully</strong></div>
                          {[
                            ['Message', hl7Test.extracted.messageType],
                            ['Hospital number', hl7Test.extracted.hospitalNumber],
                            ['Patient', hl7Test.extracted.patientName],
                            ['Date of birth', hl7Test.extracted.dateOfBirth],
                            ['Sex', hl7Test.extracted.sex],
                            ['Encounter', hl7Test.extracted.encounter && [hl7Test.extracted.encounter.class, hl7Test.extracted.encounter.status, hl7Test.extracted.encounter.location].filter(Boolean).join(' · ')],
                            ['Attending', hl7Test.extracted.encounter?.attending],
                          ].filter(([, v]) => v).map(([k, v]) => (
                            <div className="test-step" key={k}><span /><strong>{k}</strong><span className="test-detail">{v}</span></div>
                          ))}
                          {hl7Test.warnings?.map((w) => <div className="test-step" key={w}><span>!</span><span className="test-detail">{w}</span></div>)}
                        </div>
                      ) : (
                        <div className="test-result bad">{hl7Test.error}</div>
                      )
                    )}
                  </div>
                )}
              </fieldset>
            )}

            {usesFhir && (
              <fieldset className="config-block">
                <legend>FHIR R4 API</legend>
                <p className="hint">Get these from the hospital’s EMR / integration team after registering Cevruni as a backend (system) client.</p>
                <div className="form-grid">
                  <div className="field span-2">
                    <label>FHIR base URL</label>
                    <input value={form.fhir.baseUrl} placeholder="https://emr.hospital.ng/fhir/R4" onChange={(e) => setFhir({ baseUrl: e.target.value.trim() })} />
                  </div>
                  <div className="field">
                    <label>Sign-in method</label>
                    <select value={form.fhir.authType} onChange={(e) => setFhir({ authType: e.target.value })}>
                      <option value="client-secret">OAuth2 client secret</option>
                      <option value="private-key-jwt">SMART backend services (private key JWT)</option>
                      <option value="none">None (test servers only)</option>
                    </select>
                  </div>
                  {form.fhir.authType !== 'none' && (
                    <>
                      <div className="field">
                        <label>Token URL</label>
                        <input value={form.fhir.tokenUrl} placeholder="https://emr.hospital.ng/oauth2/token" onChange={(e) => setFhir({ tokenUrl: e.target.value.trim() })} />
                      </div>
                      <div className="field">
                        <label>Client ID</label>
                        <input value={form.fhir.clientId} onChange={(e) => setFhir({ clientId: e.target.value.trim() })} />
                      </div>
                    </>
                  )}
                  {form.fhir.authType === 'client-secret' && (
                    <div className="field">
                      <label>Client secret</label>
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={form.fhir.clientSecret}
                        placeholder={editing && form.fhir.hasClientSecret ? 'stored (leave blank to keep)' : ''}
                        onChange={(e) => setFhir({ clientSecret: e.target.value })}
                      />
                      <span className="field-help">Stored encrypted. Never shown again.</span>
                    </div>
                  )}
                  <div className="field span-2">
                    <label>MRN identifier system</label>
                    <input value={form.fhir.mrnIdentifierSystem} placeholder="https://emr.hospital.ng/identifiers/mrn" onChange={(e) => setFhir({ mrnIdentifierSystem: e.target.value.trim() })} />
                    <span className="field-help">The <code>Patient.identifier.system</code> this hospital uses for its hospital number. Ask for a sample Patient resource.</span>
                  </div>
                  <div className="field">
                    <label>Client certificate <span className="optional">mutual TLS</span></label>
                    <input value={form.fhir.clientCertPath || ''} placeholder="/etc/cevruni/hospital-x/client.crt" onChange={(e) => setFhir({ clientCertPath: e.target.value.trim() })} />
                    <span className="field-help">Path on the Cevruni server. Use when the hospital requires a client certificate.</span>
                  </div>
                  <div className="field">
                    <label>Client key <span className="optional">mutual TLS</span></label>
                    <input value={form.fhir.clientKeyPath || ''} placeholder="/etc/cevruni/hospital-x/client.key" onChange={(e) => setFhir({ clientKeyPath: e.target.value.trim() })} />
                  </div>
                  <div className="field span-2">
                    <label>Hospital CA certificate <span className="optional">optional</span></label>
                    <input value={form.fhir.caPath || ''} placeholder="only if the hospital uses a private certificate authority" onChange={(e) => setFhir({ caPath: e.target.value.trim() })} />
                    <span className="field-help">Connections use TLS 1.3. Cevruni only fetches the record types a patient’s grant allows.</span>
                  </div>
                  <div className="field span-2">
                    <label>Scopes</label>
                    <input value={form.fhir.scope} onChange={(e) => setFhir({ scope: e.target.value })} />
                  </div>
                </div>
                <button type="button" className="btn btn-ghost" onClick={testFhir} disabled={testing || !form.fhir.baseUrl}>
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
                <TestResult result={fhirTest} />
              </fieldset>
            )}

            {form.integration === 'rest' && (
              <div className="config-block">
                <p className="hint" style={{ marginTop: 0 }}>
                  The hospital (or its vendor) sends records with <code>POST /api/ingest/{form.hospitalID || 'hospital-id'}</code>, signed in with an
                  account that has the <strong>HL7 Interface</strong> role for this hospital (add it under Users). Body:
                </p>
                <pre className="code-sample">{`{
  "hospitalNumber": "536728",
  "patient": { "name": "Amina Yusuf", "dob": "1995-03-15" },
  "resources": [
    { "resourceType": "Observation", "status": "final",
      "code": { "text": "Full Blood Count" }, "valueString": "Hb 11.2 g/dL" }
  ]
}`}</pre>
                <p className="hint">A FHIR R4 Bundle is also accepted. Each resource is checked against FHIR R4 before it is stored; invalid ones are rejected with the reason.</p>
              </div>
            )}

            {form.integration === 'manual' && (
              <p className="hint">
                Nothing to configure. After saving, add patients in <strong>Patient Roster</strong> so they can link this hospital.
              </p>
            )}
          </div>
        )}

        {/* Step 3: first hospital admin (create only) */}
        {!editing && step === 2 && (
          <div className="wizard-body">
            <p className="hint">
              Create the hospital’s first admin. They review break-glass access, manage the roster and register clinicians for this
              hospital. You can skip this and add one later under <strong>Users</strong>.
            </p>
            <div className="form-grid">
              <div className="field">
                <label>Admin user ID</label>
                <input
                  value={form.adminUser.subject}
                  placeholder={`admin-${form.hospitalID.split('-').slice(-1)[0] || 'hospital'}`}
                  onChange={(e) => set({ adminUser: { ...form.adminUser, subject: e.target.value.trim() } })}
                />
                <span className="field-help">Must match their sign-in name at the identity provider.</span>
              </div>
              <div className="field">
                <label>Full name <span className="optional">optional</span></label>
                <input value={form.adminUser.displayName} onChange={(e) => set({ adminUser: { ...form.adminUser, displayName: e.target.value } })} />
              </div>
            </div>
          </div>
        )}

        {/* Review */}
        {step === reviewStep && (
          <div className="wizard-body">
            <div className="review">
              <div className="data-row"><span className="k">Name</span><span className="v">{form.name}</span></div>
              <div className="data-row"><span className="k">Hospital ID</span><span className="v">{form.hospitalID || slugify(form.name)}</span></div>
              <div className="data-row"><span className="k">Type · Location</span><span className="v">{form.type}{form.location ? ` · ${form.location}` : ''}</span></div>
              <div className="data-row"><span className="k">Connection</span><span className="v">{INTEGRATION_LABEL[form.integration]}</span></div>
              {usesHl7 && (
                <div className="data-row">
                  <span className="k">HL7</span>
                  <span className="v">
                    {[form.hl7.mllpEnabled && `MLLP port ${form.hl7.mllpPort} (v${form.hl7.hl7Version})`, form.hl7.httpEnabled && 'HTTPS POST'].filter(Boolean).join(' + ')}
                    {Object.values(form.hl7.fieldMap).some(Boolean) && ' · custom field mapping'}
                  </span>
                </div>
              )}
              {usesFhir && (
                <div className="data-row">
                  <span className="k">FHIR</span>
                  <span className="v">{form.fhir.baseUrl}{fhirTest ? (fhirTest.ok ? ' · tested ✓' : ' · test failed') : ' · not tested'}</span>
                </div>
              )}
              {!editing && (
                <div className="data-row">
                  <span className="k">Hospital admin</span>
                  <span className="v">{form.adminUser.subject || 'none (add later)'}</span>
                </div>
              )}
            </div>
            {usesFhir && fhirTest && !fhirTest.ok && (
              <div className="inline-warn">The FHIR test did not pass. You can still save and fix it later.</div>
            )}
          </div>
        )}

        <div className="wizard-foot">
          {stepProblem && <span className="hint warn">{stepProblem}</span>}
          <span className="spacer" />
          {step > 0 && <button className="btn btn-ghost" onClick={() => setStep(step - 1)}>Back</button>}
          {step < reviewStep && (
            <button className="btn btn-primary" disabled={Boolean(stepProblem)} onClick={() => setStep(step + 1)}>Continue</button>
          )}
          {step === reviewStep && (
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create hospital'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** What to send the hospital's IT team after setup. */
function ConnectionInstructions({ hospital }) {
  const host = window.location.hostname;
  const lines = [];
  if (hospital.hl7?.mllpEnabled) lines.push(`HL7 v${hospital.hl7.hl7Version} over MLLP: ${host}:${hospital.hl7.mllpPort}`);
  if (hospital.hl7?.httpEnabled) {
    lines.push(`HL7 over HTTPS: POST ${window.location.origin}/api/hl7/adt/${hospital.hospitalID} (Content-Type: text/plain, bearer token with role hl7_interface)`);
  }
  if (hospital.integration === 'rest') {
    lines.push(`Custom REST: POST ${window.location.origin}/api/ingest/${hospital.hospitalID} (JSON: hospitalNumber, patient, resources[] as FHIR R4; bearer token with role hl7_interface)`);
  }
  if (hospital.fhir) lines.push(`FHIR: Cevruni will call ${hospital.fhir.baseUrl} as client “${hospital.fhir.clientId || '—'}”`);
  if (!lines.length) return null;
  return (
    <div className="instructions">
      <strong>Send to the hospital’s integration team:</strong>
      <pre>{lines.join('\n')}</pre>
    </div>
  );
}
