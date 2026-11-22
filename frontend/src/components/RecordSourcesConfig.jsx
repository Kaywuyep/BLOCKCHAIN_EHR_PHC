import { useState } from 'react';
import { api } from '../api';

/**
 * RecordSourcesConfig — "Record reading" in the hospital setup wizard, for
 * hospitals whose own API Cevruni reads (custom API, SmartClinic).
 *
 * Each record source says what kind of record it is, where to read it for
 * one patient, and which field holds the patient ID (records belonging to
 * anyone else are always dropped). Records are read live when a clinician
 * with access opens them; Cevruni stores nothing.
 */

const TYPE_LABEL = {
  Encounter: 'Visits / encounters',
  Observation: 'Lab tests & observations',
  DiagnosticReport: 'Radiology & reports',
  Condition: 'Diagnoses',
  MedicationRequest: 'Medications',
  AllergyIntolerance: 'Allergies',
  DocumentReference: 'Notes & documents',
};

const EMPTY = { label: '', resourceType: 'Observation', path: '', listPath: '', patientField: 'patient_id', idField: '', titleField: '', dateField: '', detailField: '', statusField: '', whoField: '' };

export function RecordSourcesConfig({ value = [], onChange, resourceTypes = Object.keys(TYPE_LABEL), presets = {}, editingID, fieldMap = {} }) {
  const [hospitalNumber, setHospitalNumber] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const [webAppUrl, setWebAppUrl] = useState('');
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState(null);
  const sources = value || [];
  const set = (i, patch) => onChange(sources.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const remove = (i) => onChange(sources.filter((_, j) => j !== i));

  function usePreset(key) {
    if (sources.length && !window.confirm('Replace the record sources below with this layout?')) return;
    onChange(presets[key].sources.map((s) => ({ ...EMPTY, ...s })), presets[key]);
  }

  async function findAutomatically() {
    setFinding(true);
    setFound(null);
    try {
      const out = await api.adminDiscoverRecords({ hospitalID: editingID, hospitalNumber, webAppUrl: webAppUrl.trim() || undefined });
      setFound(out);
      if (out.sources?.length) onChange(out.sources.map((x) => ({ ...EMPTY, ...x })), { patientIdField: out.patientIdField, staffLookupPath: out.staffLookupPath });
    } catch (e) {
      setFound({ ok: false, steps: [{ step: 'Find records', ok: false, detail: e.message }] });
    } finally {
      setFinding(false);
    }
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.adminTestRecords({ hospitalID: editingID, hospitalNumber, recordSources: sources, fieldMap }));
    } catch (e) {
      setResult({ ok: false, steps: [{ step: 'Test', ok: false, detail: e.message }] });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="record-sources">
      <h4 className="config-sub">Record reading</h4>
      <p className="hint">
        When a doctor with the patient’s permission opens their records, Cevruni reads them from this hospital’s system at that
        moment and shows them. <strong>Nothing is copied or kept in Cevruni</strong>: the records stay in the hospital’s database.
        The Cevruni server must be on the hospital’s network.
      </p>

      <div className="test-box">
        <strong>Find records automatically</strong>
        {!editingID ? (
          <p className="hint">Save the hospital first (with its API address and account), then come back here.</p>
        ) : (
          <>
            <p className="hint">
              Type a <strong>test patient’s</strong> hospital number. Cevruni looks through the hospital’s system for that patient’s
              visits, lab tests, medications, radiology, diagnoses and notes, and fills in the record sources below. It only reads;
              nothing is stored. What it finds is <strong>saved straight away</strong>: doctors with the patient’s permission can then see
              these records.
            </p>
            <div className="form-grid">
              <div className="field">
                <label>Test patient’s hospital number</label>
                <input value={hospitalNumber} onChange={(e) => setHospitalNumber(e.target.value)} />
              </div>
              <div className="field">
                <label>Hospital web app address (optional)</label>
                <input value={webAppUrl} placeholder="same computer as the API, e.g. http://192.168.88.15/" onChange={(e) => setWebAppUrl(e.target.value)} />
              </div>
            </div>
            <button type="button" className="btn btn-primary" onClick={findAutomatically} disabled={finding || !hospitalNumber.trim()}>
              {finding ? 'Looking… (up to a few minutes)' : 'Find and switch on record reading'}
            </button>
          </>
        )}
        {found && (
          <div className={`test-result ${found.ok ? 'ok' : 'bad'}`}>
            {(found.steps || []).map((st, k) => (
              <div key={k} className="test-step">
                <span>{st.ok ? '✓' : '✗'}</span>
                <strong>{st.step}</strong>
                <span className="test-detail">{st.detail}</span>
              </div>
            ))}
            {found.saved && (
              <p className="hint ok-text">
                <strong>Saved.</strong> Record reading is on for this hospital: {found.sources.map((x) => x.label).join(', ')}.
                Doctors with the patient’s permission will see these records when they open them.
              </p>
            )}
            {!found.sources?.length && <p className="hint">Nothing was found. Check the hospital number, or set the record sources by hand.</p>}
          </div>
        )}
      </div>

      {Object.keys(presets).length > 0 && (
        <div className="preset-row">
          {Object.entries(presets).map(([key, p]) => (
            <button key={key} type="button" className="btn btn-ghost" onClick={() => usePreset(key)}>
              Use the {p.label} layout
            </button>
          ))}
        </div>
      )}

      {sources.length === 0 && <p className="hint">No record sources yet: doctors will see no records from this hospital.</p>}

      {sources.map((s, i) => (
        <details key={i} className="record-source" open={!s.path}>
          <summary>
            <strong>{s.label || `Record source ${i + 1}`}</strong> <span className="hint">· {TYPE_LABEL[s.resourceType] || s.resourceType}</span>
          </summary>
          <div className="form-grid">
            <div className="field">
              <label>Name</label>
              <input value={s.label} placeholder="e.g. Lab tests" onChange={(e) => set(i, { label: e.target.value })} />
            </div>
            <div className="field">
              <label>Kind of record</label>
              <select value={s.resourceType} onChange={(e) => set(i, { resourceType: e.target.value })}>
                {resourceTypes.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] || t}</option>)}
              </select>
            </div>
            <div className="field span-2">
              <label>Address (path)</label>
              <input value={s.path} placeholder="e.g. visits/prescriptions/{visitId}" onChange={(e) => set(i, { path: e.target.value.trim() })} />
              <span className="field-help">
                Use <code>{'{patientId}'}</code>, <code>{'{hospitalNumber}'}</code>, or <code>{'{visitId}'}</code> (read once for each visit from the Visits source).
              </span>
            </div>
            <div className="field">
              <label>Field holding the patient ID</label>
              <input value={s.patientField} placeholder="patient_id" onChange={(e) => set(i, { patientField: e.target.value.trim() })} />
              <span className="field-help">Required. Records whose patient ID doesn’t match are never shown.</span>
            </div>
            <div className="field">
              <label>List in the answer</label>
              <input value={s.listPath} placeholder="auto (e.g. data.tests)" onChange={(e) => set(i, { listPath: e.target.value.trim() })} />
            </div>
          </div>
          <details>
            <summary>What to show (optional)</summary>
            <p className="hint">
              Blank = guessed. A field (<code>drug.name</code>), fields joined with <code>+</code>, or a sentence with fields in braces
              (<code>{'{frequency} for {duration} {duration_unit}'}</code>).
            </p>
            <div className="form-grid">
              {[
                ['titleField', 'Title'],
                ['dateField', 'Date'],
                ['detailField', 'Details'],
                ['statusField', 'Status'],
                ['whoField', 'Doctor / staff'],
                ['idField', 'Record ID (default id)'],
                ['resultPath', 'Full result address (optional)'],
                ['resultMatch', 'Match result to record (e.g. request=_id)'],
                ['excludeFields', 'Leave out these fields (comma-separated)'],
              ].map(([k, label]) => (
                <div className="field" key={k}>
                  <label>{label}</label>
                  <input value={s[k] || ''} placeholder="auto" onChange={(e) => set(i, { [k]: e.target.value })} />
                </div>
              ))}
            </div>
          </details>
          <button type="button" className="btn btn-ghost" onClick={() => remove(i)}>Remove this source</button>
        </details>
      ))}

      <button type="button" className="btn btn-ghost" onClick={() => onChange([...sources, { ...EMPTY }])} style={{ marginTop: 8 }}>
        + Add a record source
      </button>

      <div className="test-box">
        <strong>Test record reading</strong>
        {!editingID ? (
          <p className="hint">Save the hospital first, then come back here to test reading a patient’s records.</p>
        ) : (
          <>
            <p className="hint">
              Reads the records of the test patient above ({hospitalNumber.trim() || 'enter a hospital number above'}) with the sources
              listed. Nothing is stored.
            </p>
            <button type="button" className="btn" onClick={test} disabled={testing || !hospitalNumber.trim() || !sources.length}>
              {testing ? 'Reading…' : 'Test record reading'}
            </button>
          </>
        )}
        {result && (
          <div className={`test-result ${result.ok ? 'ok' : 'bad'}`}>
            {(result.steps || []).map((st, k) => (
              <div key={k} className="test-step">
                <span>{st.ok ? '✓' : '✗'}</span>
                <strong>{st.step}</strong>
                <span className="test-detail">{st.detail}</span>
              </div>
            ))}
            {result.preview && Object.keys(result.preview).length > 0 && (
              <details>
                <summary>How the first records will look to doctors</summary>
                <p className="hint">This is real patient data from the hospital: don’t screenshot or share it.</p>
                <pre className="sample-json">{JSON.stringify(result.preview, null, 2)}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
