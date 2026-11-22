import { useState } from 'react';
import { api } from '../api';
import { RecordSourcesConfig } from './RecordSourcesConfig';

/**
 * SmartClinicConfig — Hospital setup, Connection step, for hospitals running
 * SmartClinic (Primed E-Health), which has its own API instead of FHIR/HL7.
 *
 * 1. Connection: the API address (the "base=" part of the SmartClinic link,
 *    e.g. http://10.0.0.20:8001/v1/) and the API account JUTH created
 *    for Cevruni.
 * 2. Test: sign in, look up one hospital number and one staff ID. Shows what
 *    was read, the field names SmartClinic returned, and a suggested field
 *    mapping to apply with one click.
 * 3. Field mapping (optional): where the hospital number, name, staff ID…
 *    sit in SmartClinic's answers. Blank = detected automatically.
 */

const PATIENT_FIELDS = [
  ['patientId', 'Patient ID in SmartClinic (for record reading)'],
  ['patientHospitalNumber', 'Hospital number'],
  ['patientName', 'Patient name'],
  ['patientDob', 'Date of birth'],
  ['patientList', 'List of patients in the answer'],
];
const STAFF_FIELDS = [
  ['staffId', 'Staff ID (or SmartClinic record ID, _id)'],
  ['staffEmail', 'Email (becomes their sign-in username)'],
  ['staffName', 'Staff name'],
  ['staffRole', 'Role / designation'],
  ['staffDepartment', 'Department'],
  ['staffActive', 'Active / status'],
  ['staffList', 'List of staff in the answer'],
];

/** Pulls base=… out of a pasted SmartClinic link; otherwise returns the text as is. */
function apiUrlFrom(text) {
  const t = String(text || '').trim();
  try {
    const u = new URL(t);
    const base = u.searchParams.get('base');
    if (base) return base;
  } catch {
    // not a URL yet
  }
  return t;
}

export function SmartClinicConfig({ value, onChange, defaults = {}, editingID, hasPassword, recordOptions }) {
  const [sample, setSample] = useState({ hospitalNumber: '', staffID: '' });
  const [result, setResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fm = value.fieldMap || {};
  const setField = (k, v) => onChange({ fieldMap: { ...fm, [k]: v } });

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.adminTestSmartClinic({ ...value, hospitalID: editingID || undefined, ...sample }));
    } catch (e) {
      setResult({ ok: false, steps: [{ step: 'Test', ok: false, detail: e.message }] });
    } finally {
      setTesting(false);
    }
  }

  function applySuggested() {
    const next = { ...fm };
    for (const [k, v] of Object.entries(result.suggested || {})) if (v && !next[k]) next[k] = v;
    onChange({ fieldMap: next });
  }

  const mapRow = ([k, label]) => (
    <div className="field" key={k}>
      <label>{label}</label>
      <input value={fm[k] || ''} placeholder={result?.suggested?.[k] ? `auto: ${result.suggested[k]}` : 'auto'} onChange={(e) => setField(k, e.target.value.trim())} />
    </div>
  );

  return (
    <fieldset className="config-block">
      <legend>SmartClinic (Primed E-Health) API</legend>
      <p className="hint">
        SmartClinic has no FHIR or HL7 interface, so Cevruni signs in to its own API with an account the hospital creates for Cevruni
        (ask for a read-only account: search patients, list staff, read records). It is used to check a patient’s hospital number
        and name when they link this hospital, and to add clinicians by staff ID.
      </p>
      <div className="form-grid">
        <div className="field span-2">
          <label>SmartClinic API address</label>
          <input
            value={value.baseUrl}
            placeholder="http://10.0.0.20:8001/v1/"
            onChange={(e) => onChange({ baseUrl: apiUrlFrom(e.target.value) })}
          />
          <span className="field-help">
            The <code>base=</code> part of the SmartClinic link. You can paste the whole link (e.g.{' '}
            <code>http://…:4500/?base=http://…:8001/v1/&amp;…</code>) and it is picked out.
          </span>
        </div>
        <div className="field">
          <label>Username</label>
          <input value={value.username} autoComplete="off" onChange={(e) => onChange({ username: e.target.value.trim() })} />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            autoComplete="new-password"
            value={value.password}
            placeholder={hasPassword ? 'stored (leave blank to keep)' : ''}
            onChange={(e) => onChange({ password: e.target.value })}
          />
          <span className="field-help">Stored encrypted. Never shown again.</span>
        </div>
      </div>

      <button type="button" className="btn btn-ghost" onClick={() => setShowAdvanced((s) => !s)} style={{ margin: '8px 0' }}>
        {showAdvanced ? 'Hide' : 'Show'} API paths
      </button>
      {showAdvanced && (
        <div className="form-grid">
          {[
            ['loginPath', 'Sign-in path', 'POST, body { data: { username, password } }'],
            ['patientSearchPath', 'Patient search path', '{hospitalNumber} is replaced with the number'],
            ['staffSearchPath', 'Staff list path', '{query} (or {staffID}) is replaced with what the admin types, if used'],
          ].map(([k, label, help]) => (
            <div className="field span-2" key={k}>
              <label>{label}</label>
              <input value={value[k] || ''} placeholder={defaults[k] || ''} onChange={(e) => onChange({ [k]: e.target.value.trim() })} />
              <span className="field-help">{help}. Blank uses the default shown.</span>
            </div>
          ))}
        </div>
      )}

      <div className="test-box">
        <strong>Test the connection</strong>
        <p className="hint">Use a test patient’s hospital number and a staff ID that exist in SmartClinic. Both are optional; sign-in is always tested.</p>
        <div className="form-grid">
          <div className="field">
            <label>Hospital number to look up</label>
            <input value={sample.hospitalNumber} onChange={(e) => setSample({ ...sample, hospitalNumber: e.target.value })} />
          </div>
          <div className="field">
            <label>Staff ID to look up</label>
            <input value={sample.staffID} onChange={(e) => setSample({ ...sample, staffID: e.target.value })} />
          </div>
        </div>
        <button type="button" className="btn" onClick={test} disabled={testing || !value.baseUrl || !value.username || (!value.password && !hasPassword)}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {result && (
          <div className={`test-result ${result.ok ? 'ok' : 'bad'}`}>
            {(result.steps || []).map((s) => (
              <div key={s.step} className="test-step">
                <span>{s.ok ? '✓' : '✗'}</span>
                <strong>{s.step}</strong>
                <span className="test-detail">{s.detail}</span>
              </div>
            ))}
            {result.suggested && Object.values(result.suggested).some(Boolean) && (
              <button type="button" className="btn btn-ghost" onClick={applySuggested}>Use the suggested field mapping</button>
            )}
            {['patient', 'staff'].map((kind) =>
              result.samples?.[kind] ? (
                <details key={kind}>
                  <summary>
                    Fields in SmartClinic’s {kind} answer ({result.samples[kind].count} record{result.samples[kind].count === 1 ? '' : 's'}
                    {result.samples[kind].listPath ? ` under “${result.samples[kind].listPath}”` : ''})
                  </summary>
                  <p className="hint">This is real data from the EMR: don’t screenshot or share it.</p>
                  <pre className="sample-json">{JSON.stringify(result.samples[kind].record || result.samples[kind].raw, null, 2)}</pre>
                </details>
              ) : null
            )}
          </div>
        )}
      </div>


      <RecordSourcesConfig
        value={value.recordSources || []}
        onChange={(list, preset) =>
          onChange({
            recordSources: list,
            ...(preset?.patientIdField && !fm.patientId ? { fieldMap: { ...fm, patientId: preset.patientIdField } } : {}),
          })
        }
        resourceTypes={recordOptions?.resourceTypes}
        presets={Object.fromEntries(Object.entries(recordOptions?.presets || {}).filter(([, p]) => p.system === 'smartclinic'))}
        editingID={editingID}
        fieldMap={fm}
      />

      <details>
        <summary>Field mapping (optional)</summary>
        <p className="hint">
          Where each value sits in SmartClinic’s answers. Leave blank to detect it automatically. Use dots for nested fields
          (<code>dept.name</code>) and <code>+</code> to join fields (<code>firstname + surname</code>).
        </p>
        <div className="form-grid">{PATIENT_FIELDS.map(mapRow)}</div>
        <div className="form-grid">{STAFF_FIELDS.map(mapRow)}</div>
      </details>
    </fieldset>
  );
}
