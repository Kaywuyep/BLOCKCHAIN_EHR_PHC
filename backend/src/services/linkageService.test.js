'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FhirAdapter } = require('./fhirAdapter');
const { LinkageService } = require('./linkageService');

function seeded() {
  const fhirAdapter = new FhirAdapter();
  fhirAdapter.addLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dob: '1990-04-12' });
  return fhirAdapter;
}

test('linkFacility returns the matched name on a correct hospital number and DOB', () => {
  const svc = new LinkageService(seeded());
  const result = svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', '1990-04-12');
  assert.deepEqual(result, { name: 'Adaeze Okafor' });
});

test('linkFacility throws the exact same generic error for an unknown hospital number as for a known number with the wrong DOB', () => {
  const svc = new LinkageService(seeded());

  let unknownNumberError;
  try {
    svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'NOT-A-NUMBER', '1990-04-12');
  } catch (err) {
    unknownNumberError = err.message;
  }

  let wrongDobError;
  try {
    svc.linkFacility('did:patientchain:p2', 'HospitalB-Ibadan', 'IBD-77410', '2000-01-01');
  } catch (err) {
    wrongDobError = err.message;
  }

  assert.equal(unknownNumberError, 'No matching record found');
  assert.equal(wrongDobError, 'No matching record found');
});

test('linkFacility never writes a link -- only confirmLink does', () => {
  const fhirAdapter = seeded();
  const svc = new LinkageService(fhirAdapter);
  svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', '1990-04-12');

  assert.throws(() => fhirAdapter.resolveRecord('HospitalB-Ibadan', 'did:patientchain:p1'));
});

test('confirmLink refuses to link a hospital number that was never looked up and matched', () => {
  const svc = new LinkageService(seeded());
  assert.throws(
    () => svc.confirmLink('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410'),
    /no confirmed match pending/
  );
});

test('confirmLink links the DID after a successful linkFacility lookup, using the FHIR Adapter\'s own local mapping', () => {
  const fhirAdapter = seeded();
  const svc = new LinkageService(fhirAdapter);
  svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', '1990-04-12');

  const result = svc.confirmLink('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410');
  assert.equal(result.hospitalNumber, 'IBD-77410');

  const { mrn } = fhirAdapter.resolveRecord('HospitalB-Ibadan', 'did:patientchain:p1');
  assert.equal(mrn, 'IBD-77410');
});

test('confirmLink cannot be replayed a second time for the same lookup', () => {
  const svc = new LinkageService(seeded());
  svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', '1990-04-12');
  svc.confirmLink('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410');

  assert.throws(() => svc.confirmLink('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410'));
});

test('linkFacility rate-limits lookups per patient after maxAttempts', () => {
  const svc = new LinkageService(seeded(), { maxAttempts: 3 });

  for (let i = 0; i < 3; i++) {
    assert.throws(() => svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'WRONG', '1990-01-01'), /No matching record found/);
  }
  assert.throws(
    () => svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'WRONG', '1990-01-01'),
    /too many lookup attempts/
  );
});

test('rate limiting is per patient, not global', () => {
  const svc = new LinkageService(seeded(), { maxAttempts: 1 });
  svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', '1990-04-12');

  // p1 is now over its limit, but p2 must be unaffected.
  assert.throws(() => svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', '1990-04-12'), /too many lookup attempts/);
  assert.doesNotThrow(() => svc.linkFacility('did:patientchain:p2', 'HospitalB-Ibadan', 'IBD-77410', '1990-04-12'));
});
