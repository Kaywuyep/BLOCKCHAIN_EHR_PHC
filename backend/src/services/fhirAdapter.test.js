'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FhirAdapter } = require('./fhirAdapter');

test('registerLocalPatient assigns an MRN when none is supplied', () => {
  const adapter = new FhirAdapter();
  const mrn = adapter.registerLocalPatient('HospitalA-Lagos', 'did:patientchain:p1');
  assert.match(mrn, /^MRN-/);
});

test('registerLocalPatient uses a caller-supplied MRN when given', () => {
  const adapter = new FhirAdapter();
  const mrn = adapter.registerLocalPatient('HospitalA-Lagos', 'did:patientchain:p1', 'LAG-00231');
  assert.equal(mrn, 'LAG-00231');
});

test('the same patient DID resolves to independent MRNs at different hospitals', () => {
  // This is the whole point of Section 3.5.1's local DID -> MRN mapping:
  // hospitals never see or share each other's medical record numbers.
  const adapter = new FhirAdapter();
  const mrnA = adapter.registerLocalPatient('HospitalA-Lagos', 'did:patientchain:p1', 'LAG-00231');
  const mrnB = adapter.registerLocalPatient('HospitalB-Ibadan', 'did:patientchain:p1', 'IBD-77410');
  assert.notEqual(mrnA, mrnB);

  const resolvedA = adapter.resolveRecord('HospitalA-Lagos', 'did:patientchain:p1');
  const resolvedB = adapter.resolveRecord('HospitalB-Ibadan', 'did:patientchain:p1');
  assert.equal(resolvedA.mrn, 'LAG-00231');
  assert.equal(resolvedB.mrn, 'IBD-77410');
});

test('createClinicalRecord requires the patient to already be registered locally', () => {
  const adapter = new FhirAdapter();
  assert.throws(
    () => adapter.createClinicalRecord('HospitalA-Lagos', 'did:patientchain:unregistered', { recordType: 'lab', fhirFields: {} }),
    /has no local record/
  );
});

test('createClinicalRecord wraps the record in a FHIR Bundle with the right resourceType per recordType', () => {
  const adapter = new FhirAdapter();
  adapter.registerLocalPatient('HospitalA-Lagos', 'did:patientchain:p1', 'LAG-00231');

  const labBundle = adapter.createClinicalRecord('HospitalA-Lagos', 'did:patientchain:p1', {
    recordType: 'lab',
    fhirFields: { code: { text: 'Full Blood Count' } },
  });
  assert.equal(labBundle.resourceType, 'Bundle');
  assert.equal(labBundle.entry[0].resource.resourceType, 'Observation');

  const encounterBundle = adapter.createClinicalRecord('HospitalA-Lagos', 'did:patientchain:p1', {
    recordType: 'encounter',
    fhirFields: { class: 'AMB' },
  });
  assert.equal(encounterBundle.entry[0].resource.resourceType, 'Encounter');
});

test('resolveRecord returns every bundle created for that patient at that hospital, and nothing for another patient', () => {
  const adapter = new FhirAdapter();
  adapter.registerLocalPatient('HospitalA-Lagos', 'did:patientchain:p1', 'LAG-00231');
  adapter.registerLocalPatient('HospitalA-Lagos', 'did:patientchain:p2', 'LAG-00999');
  adapter.createClinicalRecord('HospitalA-Lagos', 'did:patientchain:p1', { recordType: 'lab', fhirFields: {} });
  adapter.createClinicalRecord('HospitalA-Lagos', 'did:patientchain:p1', { recordType: 'encounter', fhirFields: {} });

  const { bundles } = adapter.resolveRecord('HospitalA-Lagos', 'did:patientchain:p1');
  assert.equal(bundles.length, 2);

  const { bundles: p2Bundles } = adapter.resolveRecord('HospitalA-Lagos', 'did:patientchain:p2');
  assert.equal(p2Bundles.length, 0);
});

test('resolveRecord rejects a patient with no local index entry at that hospital', () => {
  const adapter = new FhirAdapter();
  assert.throws(() => adapter.resolveRecord('HospitalA-Lagos', 'did:patientchain:unregistered'), /no local patient index entry/);
});

test('addLocalPatientRecord + findLocalPatientRecord let a hospital number be looked up before any DID is linked', () => {
  const adapter = new FhirAdapter();
  adapter.addLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dob: '1990-04-12' });

  const found = adapter.findLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410');
  assert.deepEqual(found, { name: 'Adaeze Okafor', dob: '1990-04-12' });

  assert.equal(adapter.findLocalPatientRecord('HospitalB-Ibadan', 'NOT-A-NUMBER'), null);
  assert.equal(adapter.findLocalPatientRecord('HospitalA-Lagos', 'IBD-77410'), null, 'the local patient index is scoped per hospital');
});

test('the local patient index is independent of didToMrn -- a hospital number can be found without being linked to a DID', () => {
  const adapter = new FhirAdapter();
  adapter.addLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dob: '1990-04-12' });

  assert.ok(adapter.findLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410'));
  assert.throws(() => adapter.resolveRecord('HospitalB-Ibadan', 'did:patientchain:anyone'));
});

test('listLocalPatientRecords returns every roster entry for a hospital, scoped per hospital, empty for one with none', () => {
  const adapter = new FhirAdapter();
  adapter.addLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dob: '1990-04-12' });
  adapter.addLocalPatientRecord('HospitalB-Ibadan', 'IBD-00002', { name: 'Another Patient', dob: '1980-01-01' });
  adapter.addLocalPatientRecord('HospitalA-Lagos', 'LAG-00001', { name: 'Someone Else', dob: '2000-06-06' });

  const hospitalB = adapter.listLocalPatientRecords('HospitalB-Ibadan');
  assert.equal(hospitalB.length, 2);
  assert.ok(hospitalB.some((r) => r.hospitalNumber === 'IBD-77410' && r.name === 'Adaeze Okafor'));

  assert.deepEqual(adapter.listLocalPatientRecords('HospitalC-Unknown'), []);
});

test('addLocalPatientRecord preserves extra fields (e.g. a source FHIR resource) alongside name/dob', () => {
  const adapter = new FhirAdapter();
  const sourceResource = { resourceType: 'Patient', birthDate: '1990-04-12' };
  adapter.addLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410', {
    name: 'Adaeze Okafor',
    dob: '1990-04-12',
    sex: 'female',
    sourceResource,
  });

  const found = adapter.findLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410');
  assert.equal(found.sex, 'female');
  assert.deepEqual(found.sourceResource, sourceResource);
});

test('recordResourceByHospitalNumber stores a bundle keyed by hospital number, with no DID required', () => {
  const adapter = new FhirAdapter();
  const encounter = { resourceType: 'Encounter', id: 'enc-1', status: 'in-progress' };

  const bundle = adapter.recordResourceByHospitalNumber('HospitalB-Ibadan', 'IBD-77410', encounter);
  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.entry[0].resource, encounter);

  // Not linked to any DID yet -- resolveRecord must still refuse.
  assert.throws(() => adapter.resolveRecord('HospitalB-Ibadan', 'did:patientchain:anyone'));
});

test('a bundle written by recordResourceByHospitalNumber before any DID link is preserved once one is made, and becomes visible through resolveRecord', () => {
  const adapter = new FhirAdapter();
  const encounter = { resourceType: 'Encounter', id: 'enc-1', status: 'finished' };
  adapter.recordResourceByHospitalNumber('HospitalB-Ibadan', 'IBD-77410', encounter);

  // The patient links their DID to that same hospital number later --
  // registerLocalPatient must not wipe out what's already there.
  adapter.registerLocalPatient('HospitalB-Ibadan', 'did:patientchain:p1', 'IBD-77410');

  const { mrn, bundles } = adapter.resolveRecord('HospitalB-Ibadan', 'did:patientchain:p1');
  assert.equal(mrn, 'IBD-77410');
  assert.equal(bundles.length, 1);
  assert.deepEqual(bundles[0].entry[0].resource, encounter);
});

test('PHI is encrypted at rest and survives reopening the database with the same key', () => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const { openDatabase } = require('../db/database');
  const { FieldCipher } = require('../db/fieldCipher');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-fhir-'));
  const dbPath = path.join(dir, 'store.sqlite');
  const keySpec = `k1:${require('node:crypto').randomBytes(32).toString('base64')}`;

  const db1 = openDatabase(dbPath);
  const adapter1 = new FhirAdapter({ db: db1, cipher: FieldCipher.fromSpec(keySpec) });
  adapter1.addLocalPatientRecord('H1', 'N-1', { name: 'Amina Bello', dob: '1990-04-12' });
  adapter1.registerLocalPatient('H1', 'did:patientchain:x', 'N-1');
  adapter1.recordResourceByHospitalNumber('H1', 'N-1', { resourceType: 'Encounter', id: 'e1', note: 'malaria' });

  const rawRows = JSON.stringify(db1.prepare('SELECT * FROM local_patient_index').all()) +
    JSON.stringify(db1.prepare('SELECT * FROM clinical_bundles').all());
  assert.ok(!rawRows.includes('Amina'), 'patient name must not be stored in plaintext');
  assert.ok(!rawRows.includes('malaria'), 'clinical content must not be stored in plaintext');
  db1.close();

  const db2 = openDatabase(dbPath);
  const adapter2 = new FhirAdapter({ db: db2, cipher: FieldCipher.fromSpec(keySpec) });
  assert.equal(adapter2.findLocalPatientRecord('H1', 'N-1').name, 'Amina Bello');
  assert.equal(adapter2.resolveRecord('H1', 'did:patientchain:x').bundles[0].entry[0].resource.note, 'malaria');

  const wrongKey = new FhirAdapter({ db: db2, cipher: FieldCipher.ephemeral() });
  assert.throws(() => wrongKey.findLocalPatientRecord('H1', 'N-1'));
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
