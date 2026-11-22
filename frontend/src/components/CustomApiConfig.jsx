import { useState } from 'react';
import { api } from '../api';
import { RecordSourcesConfig } from './RecordSourcesConfig';

/**
 * CustomApiConfig — Hospital setup, Connection step, "Custom API" hospitals
 * (integration "rest") whose own custom-built system has a REST API that
 * Cevruni can sign in to.
 *
 * Every part is set here because each custom system differs: the API
 * address, the sign-in path and JSON body, where the token comes back and
 * how it is sent, the patient and staff search paths, and (optionally) the
 * field mapping. "Test connection" signs in and tries one lookup of each,
 * shows the fields the API returned and suggests a mapping.
 *
 * All blank = this hospital only sends records to Cevruni (push ingest).
 */

const PATIENT_FIELDS = [
  ['patientId', 'Patient ID in the hospital system (for record reading)'],
  ['patientHospitalNumber', 'Hospital number'],
  ['patientName', 'Patient name'],
  ['patientDob', 'Date of birth'],
  ['patientList', 'List of patients in the answer'],
];
const STAFF_FIELDS = [
  ['staffId', 'Staff ID (or the system’s record ID, e.g. _id)'],
  ['staffEmail', 'Email (becomes their sign-in username)'],
  ['staffName', 'Staff name'],
  ['staffRole', 'Role / designation'],
  ['staffDepartment', 'Department'],
  ['staffActive', 'Active / status'],
  ['staffList', 'List of staff in the answer'],
];
const TOKEN_IN_LABEL = {
  bearer: 'Authorization: Bearer <token> header',
  header: 'A header of its own (name below)',
  query: 'In the address, ?name=<token>',
};

export function CustomApiConfig({ value, onChange, defaults = {}, tokenInOptions = ['bearer', 'header', 'query'], editingID, hasPassword, recordOptions }) {
  const [sample, setSample] = useState({ hospitalNumber: '', staffID: '' });
  const [result, setResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [enabled, setEnabled] = useState(Boolean(value.baseUrl));
  const fm = value.fieldMap || {};
  const setField = (k, v) => onChange({ fieldMap: { ...fm, [k]: v } });
  const tokenIn = value.tokenIn || defaults.tokenIn || 'bearer';

  function toggle(on) {
    setEnabled(on);
    if (!on) onChange({ baseUrl: '', username: '', password: '' });
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.adminTestCustomApi({ ...value, hospitalID: editingID || undefined, ...sample }));
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

  const input = (k, label, { placeholder, help, span = true, type } = {}) => (
    <div className={`field${span ? ' span-2' : ''}`} key={k}>
      <label>{label}</label>
      <input
        type={type}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        value={value[k] || ''}
        placeholder={placeholder ?? defaults[k] ?? ''}
        onChange={(e) => onChange({ [k]: type === 'password' ? e.target.value : e.target.value.trim() })}
      />
      {help && <span className="field-help">{help}</span>}
    </div>
  );

  const mapRow = ([k, label]) => (
    <div className="field" key={k}>
      <label>{label}</label>
      <input value={fm[k] || ''} placeholder={result?.suggested?.[k] ? `auto: ${result.suggested[k]}` : 'auto'} onChange={(e) => setField(k, e.target.value.trim())} />
    </div>
  );

  return (
    <fieldset className="config-block">
      <legend>Read from the hospital’s API</legend>
      <label className="toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
        Cevruni signs in to the hospital’s own API to check patients’ hospital numbers and add clinicians
      </label>
      {!enabled && <p className="hint">Off: the hospital only sends records to Cevruni (below).</p>}

      {enabled && (
        <>
          <p className="hint">
            Ask the hospital for a read-only API account (search patients, list staff). Cevruni uses it when a patient links this
            hospital and when the hospital admin adds clinicians from the EMR.
          </p>

          <div className="form-grid">
            {input('baseUrl', 'API address', {
              placeholder: 'http://192.168.88.15/api/',
              help: 'The address every path below is added to. Usually ends in /api/.',
            })}
            {input('username', 'Username', { span: false })}
            {input('password', 'Password', {
              span: false,
              type: 'password',
              placeholder: hasPassword ? 'stored (leave blank to keep)' : '',
              help: 'Stored encrypted. Never shown again.',
            })}
          </div>

          <h4 className="config-sub">Sign-in</h4>
          <div className="form-grid">
            {input('loginPath', 'Sign-in path', { help: 'Sent as POST. Blank uses the default shown.' })}
            <div className="field span-2">
              <label>Sign-in body (JSON)</label>
              <textarea
                rows={2}
                spellCheck={false}
                value={value.loginBody || ''}
                placeholder={defaults.loginBody || ''}
                onChange={(e) => onChange({ loginBody: e.target.value })}
              />
              <span className="field-help">
                <code>{'{username}'}</code> and <code>{'{password}'}</code> are filled in. Some systems use other names, e.g.{' '}
                <code>{'{"email":"{username}","password":"{password}"}'}</code>.
              </span>
            </div>
            {input('tokenPath', 'Token in the answer', {
              placeholder: 'auto',
              help: 'Where the sign-in answer holds the token, e.g. token, data.token, or data. Blank = detected.',
            })}
            <div className="field">
              <label>Send the token as</label>
              <select value={tokenIn} onChange={(e) => onChange({ tokenIn: e.target.value })}>
                {tokenInOptions.map((o) => (
                  <option key={o} value={o}>{TOKEN_IN_LABEL[o] || o}</option>
                ))}
              </select>
            </div>
            {tokenIn !== 'bearer' &&
              input('tokenName', tokenIn === 'header' ? 'Header name' : 'Parameter name', {
                span: false,
                placeholder: tokenIn === 'header' ? 'x-access-token' : 'token',
              })}
          </div>

          <h4 className="config-sub">Lookups</h4>
          <div className="form-grid">
            {input('patientSearchPath', 'Patient search path', {
              placeholder: 'patients/get?search={hospitalNumber}&currentPage=1&pageLimit=50',
              help: '{hospitalNumber} is replaced with the number the patient typed. Used to confirm their hospital number and name.',
            })}
            {input('staffLookupPath', 'Staff lookup path (names in records)', {
              placeholder: 'staffs/{id}',
              help: 'One staff member by their number. Records then show names (e.g. the requester) instead of staff numbers.',
            })}
            {input('staffSearchPath', 'Staff search path', {
              placeholder: 'staffs/get?search={query}&currentPage=1&pageLimit=50',
              help: '{query} is replaced with the name, email or staff ID the hospital admin types in “Add from EMR”.',
            })}
          </div>

          <div className="test-box">
            <strong>Test the connection</strong>
            <p className="hint">Use a test patient’s hospital number and a staff name or ID that exist in the hospital’s system. Both are optional; sign-in is always tested.</p>
            <div className="form-grid">
              <div className="field">
                <label>Hospital number to look up</label>
                <input value={sample.hospitalNumber} onChange={(e) => setSample({ ...sample, hospitalNumber: e.target.value })} />
              </div>
              <div className="field">
                <label>Staff name or ID to search</label>
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
                        Fields in the {kind} answer ({result.samples[kind].count} record{result.samples[kind].count === 1 ? '' : 's'}
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
                ...(preset?.staffLookupPath ? { staffLookupPath: preset.staffLookupPath } : {}),
              })
            }
            resourceTypes={recordOptions?.resourceTypes}
            presets={Object.fromEntries(Object.entries(recordOptions?.presets || {}).filter(([, p]) => p.system !== 'smartclinic'))}
            editingID={editingID}
            fieldMap={fm}
          />

          <details>
            <summary>Field mapping (optional)</summary>
            <p className="hint">
              Where each value sits in the API’s answers. Leave blank to detect it automatically. Use dots for nested fields
              (<code>dept.name</code>) and <code>+</code> to join fields (<code>firstname + surname</code>).
            </p>
            <div className="form-grid">{PATIENT_FIELDS.map(mapRow)}</div>
            <div className="form-grid">{STAFF_FIELDS.map(mapRow)}</div>
          </details>
        </>
      )}
    </fieldset>
  );
}
