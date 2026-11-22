'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readRecords, cleanRecordSources, readSpec, RECORD_PRESETS } = require('./emrRecords');

// A fake hospital API shaped like PSSH. Its consultation list IGNORES the
// patient filter and returns everyone, as PSSH's does.
function fakeApi(calls = []) {
  return async (path, vars) => {
    calls.push({ path, vars });
    if (path.startsWith('visits/all/get')) {
      return { data: { docs: [
        { id: 10, patient_id: 223, department: 'O&G', professional: 'Gynaecologist', category: 'Outpatient', type: 'New visit', date_visit_start: '2026-11-03T11:05:45Z', status: 'Ended', staff: { fullname: 'Dr A' } },
        { id: 11, patient_id: 223, department: 'GOPD', date_visit_start: '2026-11-10T09:00:00Z', status: 'Ended' },
        { id: 99, patient_id: 500, department: 'Someone else' },
      ] } };
    }
    if (path === 'visits/prescriptions/{visitId}') {
      return { data: {
        tests: [{ id: `t${vars.visitId}`, patient_id: 223, test: { name: 'FBC' }, result: { value: 'Hb 11.2' }, result_status: 'Ready', date_requested: '2026-11-03T11:10:00Z' }],
        drugs: [{ id: `d${vars.visitId}`, patient_id: 223, drug: { name: 'Paracetamol' }, prescribed_strength: '500', strength: { name: 'mg' }, dosage_form: { name: 'Tablet' }, route: { name: 'PO' }, frequency: 'TDS', duration: 5, duration_unit: 'days', notes: '' }],
        investigations: [],
      } };
    }
    if (path.startsWith('consultations/histories')) {
      return { data: { docs: [{ id: 1, patient_id: 228, complaint_note: 'not this patient' }, { id: 2, patient_id: 223, complaint_note: 'headache' }, { id: 3, complaint_note: 'no patient field' }] } };
    }
    throw new Error(`unexpected path ${path}`);
  };
}

const sources = cleanRecordSources([
  ...RECORD_PRESETS.pssh.sources.filter((s) => ['Visits', 'Lab tests', 'Medications'].includes(s.label)),
  { label: 'Notes', resourceType: 'DocumentReference', path: 'consultations/histories/get/?filter={patientId}', patientField: 'patient_id', titleField: 'complaint_note' },
]);

test('records of other patients are always dropped, even when the API ignores its filter', async () => {
  const out = await readRecords({ sources, getJson: fakeApi(), patientId: '223', hospitalNumber: 'PSSH/000223' });
  const notes = out.resources.filter((r) => r.resourceType === 'DocumentReference');
  assert.deepEqual(notes.map((r) => r.description), ['headache']);
  assert.equal(out.sources.find((s) => s.label === 'Notes').dropped, 2); // other patient + no patient field
  assert.equal(out.resources.filter((r) => r.resourceType === 'Encounter').length, 2);
  assert.equal(out.sources.find((s) => s.label === 'Visits').dropped, 1);
});

test('per-visit sources are read once per visit (one call shared by tests and drugs), newest visit first', async () => {
  const calls = [];
  const out = await readRecords({ sources, getJson: fakeApi(calls), patientId: '223', hospitalNumber: 'PSSH/000223' });
  const perVisit = calls.filter((c) => c.path === 'visits/prescriptions/{visitId}');
  assert.deepEqual(perVisit.map((c) => c.vars.visitId), ['11', '10']);
  const meds = out.resources.filter((r) => r.resourceType === 'MedicationRequest');
  assert.equal(meds.length, 2);
  assert.equal(meds[0].medicationCodeableConcept.text, 'Paracetamol');
  assert.equal(meds[0].dosageInstruction[0].text, '500mg Tablet · PO · TDS for 5 days');
  const lab = out.resources.find((r) => r.resourceType === 'Observation');
  assert.equal(lab.code.text, 'FBC');
  assert.equal(lab.valueString, 'Hb 11.2');
  assert.equal(lab.status, 'Ready');
});

test('the grant scope limits what is read; visits are still read for per-visit sources', async () => {
  const calls = [];
  const out = await readRecords({ sources, getJson: fakeApi(calls), patientId: '223', types: ['MedicationRequest'] });
  assert.ok(calls.some((c) => c.path.startsWith('visits/all/get')));
  assert.ok(!calls.some((c) => c.path.startsWith('consultations/histories')));
  assert.deepEqual([...new Set(out.resources.map((r) => r.resourceType))], ['MedicationRequest']);
});

test('one failing source does not hide the others', async () => {
  const api = fakeApi();
  const out = await readRecords({
    sources,
    getJson: (p, v) => (p.startsWith('consultations') ? Promise.reject(new Error('HTTP 500')) : api(p, v)),
    patientId: '223',
  });
  const notes = out.sources.find((s) => s.label === 'Notes');
  assert.equal(notes.ok, false);
  assert.match(notes.error, /HTTP 500/);
  assert.ok(out.resources.some((r) => r.resourceType === 'MedicationRequest'));
});

test('templates drop segments whose fields are all empty', () => {
  assert.equal(readSpec({ a: 'X', c: 'Z' }, '{a} · {b} · {c}'), 'X · Z');
  assert.equal(readSpec({ a: 'None' }, '{a}'), undefined);
  assert.equal(readSpec({ f: { n: 'Ada' }, l: 'Bello' }, 'f.n + l'), 'Ada Bello');
});

test('record sources are checked: patient field required, visits source needed for {visitId}', () => {
  assert.throws(() => cleanRecordSources([{ label: 'X', resourceType: 'Observation', path: 'labs/{patientId}' }]), /patient ID/);
  assert.throws(() => cleanRecordSources([{ label: 'X', resourceType: 'Observation', path: 'labs/{visitId}', patientField: 'patient_id' }]), /Visits source/);
  assert.throws(() => cleanRecordSources([{ label: 'X', resourceType: 'Observation', path: 'labs/all', patientField: 'patient_id' }]), /must contain/);
  assert.throws(() => cleanRecordSources([{ label: 'X', resourceType: 'Observation', path: 'http://evil/{patientId}', patientField: 'patient_id' }]), /relative/);
  assert.equal(cleanRecordSources(RECORD_PRESETS.pssh.sources).length, 5);
});

test('full results: read when the record links one, shown only if the answer names this patient', async () => {
  const src = cleanRecordSources([
    { label: 'Visits', resourceType: 'Encounter', path: 'visits?p={patientId}', patientField: 'patient_id' },
    { label: 'Lab tests', resourceType: 'Observation', path: 'tests/{visitId}', listPath: 'data', patientField: 'patient_id', titleField: 'test.name', resultPath: 'results/{result_id}' },
  ]);
  const getJson = async (path) => {
    if (path.startsWith('visits')) return [{ id: 1, patient_id: 7 }];
    if (path === 'tests/{visitId}') {
      return { data: [
        { id: 10, patient_id: 7, test: { name: 'FBC' }, result_id: 100, price: '500.00' },
        { id: 11, patient_id: 7, test: { name: 'LFT' }, result_id: 101 },
        { id: 12, patient_id: 7, test: { name: 'U&E' }, result_id: 102 },
        { id: 13, patient_id: 7, test: { name: 'MP' }, result_id: null },
      ] };
    }
    if (path === 'results/100') {
      return { data: { patient_id: 7, verified_by: { fullname: 'Lab Sci' }, parameters: [
        { parameter: { name: 'Haemoglobin', unit: 'g/dL', range: '12-16' }, value: '11.2', flag: 'Low' },
        { parameter: { name: 'WBC', unit: 'x10^9/L', range: '4-11' }, value: '6.1' },
      ] } };
    }
    if (path === 'results/101') return { data: { patient_id: 8, parameters: [{ name: 'ALT', value: '40' }] } }; // another patient
    if (path === 'results/102') return { data: { parameters: [{ name: 'Na', value: '139' }] } }; // patient not named
    throw new Error(`unexpected ${path}`);
  };
  const out = await readRecords({ sources: src, getJson, patientId: '7' });
  const lab = Object.fromEntries(out.resources.filter((r) => r.resourceType === 'Observation').map((r) => [r.code.text, r]));
  assert.deepEqual(lab.FBC.result.rows[0], { name: 'Haemoglobin', value: '11.2', unit: 'g/dL', range: '12-16', flag: 'Low' });
  assert.equal(lab.FBC.valueString, 'Haemoglobin: 11.2 g/dL · WBC: 6.1 x10^9/L');
  assert.ok(lab.FBC.result.details.some((d) => d.value === 'Lab Sci'));
  assert.equal(lab.LFT.result, undefined);
  assert.equal(lab['U&E'].result, undefined);
  assert.equal(lab.MP.result, undefined);
  // "Show all details": readable fields, no prices or IDs.
  assert.ok(lab.FBC.details.some((d) => d.label === 'Test name' && d.value === 'FBC'));
  assert.ok(!lab.FBC.details.some((d) => /price|id$/i.test(d.label)));
});

test('details for doctors: one line per person, no staff numbers, no IDs or prices', () => {
  const { allDetails } = require('./emrRecords');
  const d = allDetails({
    id: 274, patient_id: 223, staff_id: 313, requester: 390, sample_received_by: 634, price: '1000',
    department: 'O&G',
    staff: { fullname: 'NISHE  JULIET NDELONG', firstname: 'NISHE', lastname: 'NDELONG', middlename: 'JULIET' },
    examiner: { firstname: 'Ada', lastname: 'Bello' },
  });
  assert.deepEqual(d, [
    { label: 'Department', value: 'O&G' },
    { label: 'Staff', value: 'NISHE JULIET NDELONG' },
    { label: 'Examiner', value: 'Ada Bello' },
  ]);
});

test('staff numbers in records are shown as names via the staff lookup; unknown numbers stay hidden', async () => {
  const sources = cleanRecordSources([
    { label: 'Visits', resourceType: 'Encounter', path: 'visits?p={patientId}', patientField: 'patient_id' },
    { label: 'Lab tests', resourceType: 'Observation', path: 'tests/{visitId}', listPath: 'data', patientField: 'patient_id', titleField: 'test.name' },
  ]);
  const calls = [];
  const getJson = async (path) => {
    calls.push(path);
    if (path.startsWith('visits')) return [{ id: 1, patient_id: 7 }];
    if (path === 'tests/{visitId}') return { data: [{ id: 10, patient_id: 7, test: { name: 'FBC' }, requester: 390, sample_received_by: 999 }, { id: 11, patient_id: 7, test: { name: 'MP' }, requester: 390 }] };
    if (path === 'staffs/390') return { data: { fullname: 'Dr  Grace Pam', firstname: 'Grace', password: 'hash-never-used' } };
    if (path === 'staffs/999') throw new Error('404');
    throw new Error(`unexpected ${path}`);
  };
  const out = await readRecords({ sources, getJson, patientId: '7', staffPath: 'staffs/{id}' });
  const lab = out.resources.filter((r) => r.resourceType === 'Observation');
  assert.deepEqual(lab[0].details.find((d) => d.label === 'Requester'), { label: 'Requester', value: 'Dr Grace Pam' });
  assert.ok(!lab[0].details.some((d) => /received/i.test(d.label)));
  assert.ok(!JSON.stringify(out).includes('hash-never-used'));
  assert.equal(calls.filter((c) => c === 'staffs/390').length, 1); // looked up once
});

test('SmartClinic-style nesting: inner lists checked on the outer record; results matched per request; diagnoses kept out of notes', async () => {
  assert.ok(cleanRecordSources(RECORD_PRESETS.smartclinic.sources).length >= 20); // the JUTH layout is valid
  const pick = (label) => RECORD_PRESETS.smartclinic.sources.find((x) => x.label === label);
  const sources = cleanRecordSources([
    pick('Consultation notes'),
    pick('Diagnoses'),
    { label: 'Diagnoses (coded)', resourceType: 'Condition', path: pick('Diagnoses').path, listPath: 'result[].confirmed_diagnosis', patientField: '_parent.patient._id', titleField: '{desc}{title}', detailField: 'ICD code {code}{theCode}', excludeFields: pick('Diagnoses (coded)').excludeFields },
    { label: 'Medications', resourceType: 'MedicationRequest', path: pick('Diagnoses').path, listPath: 'result[].pharmacy_requests[].drugs', patientField: '_parent.patient._id', titleField: 'drug.item_name', detailField: pick('Medications').detailField, whoField: '{_parent.raised_by.fname} {_parent.raised_by.lname}', excludeFields: 'drug' },
    pick('Lab tests'),
  ]);
  const consultations = { result: [
    { _id: 'c1', patient: { _id: 'P1' }, created_at: '2026-11-01T10:00:00Z', raised_by_name: 'Dr A', department_route: 'gopd', complaintII: 'headache', notes: 'rest', uncoded_diagnosis: ['Malaria'], confirmed_diagnosis: [{ title: 'Typhoid fever', theCode: '1A07', stemId: 'x' }],
      appointment: { _id: 'a1', service_name: 'Consultation' }, pharmacy_requests: [{ patient: { _id: 'P1' }, raised_by: { fname: 'Ada', lname: 'B' }, status: 'pending', drugs: [{ _id: 'd1', drug: { item_name: 'Artemether' }, prescription: '80mg', frequency: 'twice daily', duration: '3', duration_type: 'days', quantity: 6 }] }] },
    { _id: 'c9', patient: { _id: 'OTHER' }, uncoded_diagnosis: ['Not this patient'] },
  ] };
  const labs = { result: [{ _id: 'g1', patient: { _id: 'P1' }, appointment: { _id: 'a1' }, created_at: '2026-11-01T10:00:00Z', raised_by: { fname: 'Ada', lname: 'B' },
    requests: [{ _id: 'r1', test: { _id: 't1', service_name: 'FBC' }, status: 'pending' }, { _id: 'r2', test: { _id: 't2', service_name: 'MP' } }] }] };
  const getJson = async (path, vars) => {
    if (path.startsWith('consultation/')) return consultations;
    if (path.startsWith('lab/fetch-lab-requests')) return labs;
    if (path === 'lab/lab-results?appointment=a1') return { result: [{ request: 'r1', test: 't1', patient: { _id: 'P1' }, title: 'Haemoglobin', value: '12.1', unit: 'g/dL' }, { request: 'r2', test: 't2', patient: { _id: 'OTHER' }, title: 'MP', value: '+' }] };
    return { result: [], data: [] };
  };
  const out = await readRecords({ sources, getJson, patientId: 'P1', hospitalNumber: 'JR1' });
  const by = (label) => out.resources.filter((r) => r.meta.tag[0].display === label);
  assert.deepEqual(by('Diagnoses').map((r) => r.code.text), ['Malaria']); // other patient's dropped
  assert.equal(by('Diagnoses (coded)')[0].code.text, 'Typhoid fever');
  assert.deepEqual(by('Diagnoses (coded)')[0].details, [{ label: 'Title', value: 'Typhoid fever' }, { label: 'The code', value: '1A07' }]);
  const notes = by('Consultation notes')[0];
  assert.ok(!JSON.stringify(notes).includes('Malaria') && !JSON.stringify(notes).includes('Typhoid'));
  const med = by('Medications')[0];
  assert.equal(med.medicationCodeableConcept.text, 'Artemether');
  assert.equal(med.dosageInstruction[0].text, '80mg · twice daily for 3 days · Quantity 6');
  // deeper nesting keeps the link to the outer record
  assert.equal(med.requester.display, 'Ada B');
  const fbc = by('Lab tests').find((r) => r.code.text === 'FBC');
  assert.deepEqual(fbc.result.rows[0], { name: 'Haemoglobin', value: '12.1', unit: 'g/dL', range: undefined, flag: undefined });
  assert.equal(by('Lab tests').find((r) => r.code.text === 'MP').result, undefined); // result names another patient
});

test('three-level nesting checks the patient on the outermost record; name lookup within the answer; 404 = no records', async () => {
  const sources = cleanRecordSources([
    { label: 'Ward round diagnoses', resourceType: 'Condition', path: 'r/{patientId}', listPath: 'result.0.adm[].ward_round.notes[].provisional_diagnosis', patientField: '_parent._parent.patient', titleField: 'value' },
    { label: 'Medications', resourceType: 'MedicationRequest', path: 'r/{patientId}', listPath: 'result.0.rx[].drugs', patientField: '_parent.patient', joinField: 'drug', joinList: 'result.0.drug_details', titleField: '_join.item_name' },
    { label: 'Antenatal', resourceType: 'DocumentReference', path: 'anc/{patientId}', listPath: 'result', patientField: 'patient._id' },
  ]);
  const getJson = async (path) => {
    if (path === 'r/{patientId}') {
      return { result: [{
        adm: [{ patient: 'P1', ward_round: { notes: [{ provisional_diagnosis: ['Sepsis'] }] } }, { patient: 'P2', ward_round: { notes: [{ provisional_diagnosis: ['Other patient'] }] } }],
        rx: [{ patient: 'P1', drugs: [{ _id: 'x1', drug: 'D9' }] }],
        drug_details: [{ _id: 'D9', item_name: 'Ceftriaxone 1g' }],
      }] };
    }
    throw new Error('SmartClinic answered HTTP 404 for anc');
  };
  const out = await readRecords({ sources, getJson, patientId: 'P1' });
  assert.deepEqual(out.resources.filter((r) => r.resourceType === 'Condition').map((r) => r.code.text), ['Sepsis']);
  assert.equal(out.resources.find((r) => r.resourceType === 'MedicationRequest').medicationCodeableConcept.text, 'Ceftriaxone 1g');
  assert.deepEqual(out.sources.find((x) => x.label === 'Antenatal'), { label: 'Antenatal', ok: true, count: 0, dropped: 0 });
});

test('SmartClinic Medical History: every filled section shown in full (each entry), empty sections skipped; diagnoses only under Diagnoses', async () => {
  const all = cleanRecordSources(RECORD_PRESETS.smartclinic.sources);
  const sources = all.filter((s) => s.label.startsWith('Medical history:') || s.label === 'Discharge summaries' || s.label === 'Diagnoses (discharge)');
  const patient = { _id: 'P1', consultation_history: {
    medical_history: { previous_condition: [{ condition: 'Asthma', year: '2019', on_treatment: true }, { condition: 'Hypertension', year: '2021' }] },
    surgery_history: { previous_surgery: [{ surgery: 'Appendicectomy', date: '2015' }], drug_allergies: { is_true: [] } },
    social_history: { alcohol: { is_true: [] }, hard_drugs: [] }, // empty: skipped
    obstetrics_history: { gravida: '3', para: '2', previous_pregnancies: [{ outcome: 'Live birth', mode: 'SVD' }] },
    family_history: { hereditory_condition: ['Diabetes'] },
    psychiatric_history: { previous_diagnosis: 'Depression', admissions: '1' },
  } };
  const report = { result: [{ _id: 'P1', all_admission_records: [{ patient: 'P1', discharge_summary: { definitive_diagnosis: 'Pneumonia', status_on_discharge: 'Improved', staff_name: 'Dr C' } }] }] };
  const getJson = async (path) => (path.startsWith('records/patient/single') ? { result: patient } : report);
  const out = await readRecords({ sources, getJson, patientId: 'P1', hospitalNumber: 'H1' });
  const by = Object.fromEntries(out.resources.map((r) => [r.meta.tag[0].display, r]));
  assert.ok(!by['Medical history: Social history']); // nothing filled in
  const pmh = by['Medical history: Past medical history'];
  assert.equal(pmh.code.text, 'Past medical history');
  assert.deepEqual(pmh.details, [
    { label: 'Previous condition 1', value: 'Condition: Asthma; Year: 2019; On treatment: yes' },
    { label: 'Previous condition 2', value: 'Condition: Hypertension; Year: 2021' },
  ]);
  assert.deepEqual(by['Medical history: Previous surgical history'].details, [{ label: 'Previous surgery', value: 'Surgery: Appendicectomy; Date: 2015' }]);
  assert.ok(by['Medical history: Obstetric and gynae history'].details.some((d) => d.value === 'Outcome: Live birth; Mode: SVD'));
  assert.deepEqual(by['Medical history: Family history'].details, [{ label: 'Hereditory condition', value: 'Diabetes' }]);
  // Psychiatric history is a document: its diagnosis is not shown there...
  assert.ok(!JSON.stringify(by['Medical history: Psychiatric history']).includes('Depression'));
  // ...and the discharge diagnosis appears only under Diagnoses.
  assert.ok(!JSON.stringify(by['Discharge summaries']).includes('Pneumonia'));
  assert.equal(by['Diagnoses (discharge)'].code.text, 'Pneumonia');
});

test('SmartClinic radiology: requests by name and reports with findings, shown with the labs (DiagnosticReport); other patients dropped', async () => {
  const all = cleanRecordSources(RECORD_PRESETS.smartclinic.sources);
  const sources = all.filter((s) => s.label === 'Radiology requests' || s.label === 'Radiology reports');
  const getJson = async (path) => {
    if (path.startsWith('radiology/v2/fetch-requests')) {
      return { result: [
        { _id: 'g1', patient: { _id: 'P1' }, created_at: '2026-11-02T09:00:00Z', raised_by: { fname: 'Super', lname: 'Admin' }, requests: [{ _id: 'r1', status: 'pending', test: { service_name: 'CHEST X-RAY (ADULT)' }, result: null }] },
        { _id: 'g2', patient: { _id: 'OTHER' }, requests: [{ _id: 'r9', test: { service_name: 'Someone else' } }] },
      ] };
    }
    return { result: [{ hospital_number: 'H1', test: { service_name: 'ABDOMINAL USS' }, date_created: '2026-11-03T10:00:00Z', report: { type_of_film: 'Digital', addedField: [{ name: 'Impression', value: 'Normal study' }] } },
      { hospital_number: 'H2', test: { service_name: 'Not this patient' }, report: {} }] };
  };
  const out = await readRecords({ sources, getJson, patientId: 'P1', hospitalNumber: 'H1' });
  assert.deepEqual(out.resources.map((r) => [r.resourceType, r.code.text]), [['DiagnosticReport', 'CHEST X-RAY (ADULT)'], ['DiagnosticReport', 'ABDOMINAL USS']]);
  assert.equal(out.resources[0].performer[0].display, 'Super Admin');
  assert.deepEqual(out.resources[1].result.rows[0], { name: 'Impression', value: 'Normal study', unit: undefined, range: undefined, flag: undefined });
});

test('IDs are never shown when a name exists (else hidden); sub-tests become result rows with the range for the patient\'s sex; specimen shown', async () => {
  const sources = cleanRecordSources([RECORD_PRESETS.smartclinic.sources.find((s) => s.label === 'Lab tests')]);
  const HB = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const PCV = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const STAFF = 'cccccccccccccccccccccccc';
  const getJson = async (path) => {
    if (path.startsWith('lab/fetch-lab-requests')) {
      return { result: [{ _id: 'g1', patient: { _id: 'P1' }, appointment: { _id: 'a1' }, raised_by: { _id: STAFF, fname: 'Ada', lname: 'Obi' },
        requests: [
          { _id: 'r1', test: { _id: 't1', service_name: 'FBC', sub_tests: [{ _id: HB, service_name: 'Haemoglobin' }, { _id: PCV, service_name: 'PCV' }] } },
          { _id: 'r2', test: { _id: 't2', service_name: 'LFT', sub_tests: [{ _id: HB, service_name: 'Haemoglobin' }] } },
        ] }] };
    }
    return { result: [
      { request: 'r1', patient: { _id: 'P1' }, sex: 'Female', title: 'FBC', specimen_type: 'Whole blood', specimen_collected_by: STAFF, test: 't1',
        sub_tests: [{ _id: HB, service_name: 'Haemoglobin', value: '11.2', unit: 'g/dL', female_low_range: '12', female_high_range: '16', male_low_range: '13', male_high_range: '17' }, { _id: PCV, service_name: 'PCV', value: '34', unit: '%' }] },
      { request: 'r2', patient: { _id: 'P1' }, title: 'LFT', sub_tests: [HB, 'dddddddddddddddddddddddd'] }, // not resulted yet: IDs only
    ] };
  };
  const out = await readRecords({ sources, getJson, patientId: 'P1' });
  const fbc = out.resources.find((r) => r.code.text === 'FBC');
  assert.deepEqual(fbc.result.rows.map((x) => [x.name, x.value, x.unit, x.range]), [['Haemoglobin', '11.2', 'g/dL', '12–16'], ['PCV', '34', '%', undefined]]);
  assert.equal(fbc.specimen[0].display, 'Whole blood');
  assert.ok(fbc.result.details.some((d) => d.label === 'Specimen collected by' && d.value === 'Ada Obi'));
  assert.ok(!fbc.result.details.some((d) => d.label === 'Sub tests')); // already the rows
  const lft = out.resources.find((r) => r.code.text === 'LFT');
  assert.deepEqual(lft.result.details.find((d) => d.label === 'Sub tests'), { label: 'Sub tests', value: 'Haemoglobin' }); // unknown ID left out
  assert.ok(!/[0-9a-f]{24}/.test(JSON.stringify(out.resources.map((r) => [r.details, r.result]))));
});
