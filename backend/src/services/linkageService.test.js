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
  const result = svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dateOfBirth: '1990-04-12' });
  assert.deepEqual(result, { name: 'Adaeze Okafor' });
});

test('linkFacility throws the exact same generic error for an unknown hospital number as for a known number with the wrong DOB', () => {
  const svc = new LinkageService(seeded());

  let unknownNumberError;
  try {
    svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'NOT-A-NUMBER', { name: 'Adaeze Okafor', dateOfBirth: '1990-04-12' });
  } catch (err) {
    unknownNumberError = err.message;
  }

  let wrongDobError;
  try {
    svc.linkFacility('did:patientchain:p2', 'HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dateOfBirth: '2000-01-01' });
  } catch (err) {
    wrongDobError = err.message;
  }

  assert.equal(unknownNumberError, 'No matching record found');
  assert.equal(wrongDobError, 'No matching record found');
});

test('linkFacility never writes a link -- only confirmLink does', () => {
  const fhirAdapter = seeded();
  const svc = new LinkageService(fhirAdapter);
  svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dateOfBirth: '1990-04-12' });

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
  svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dateOfBirth: '1990-04-12' });

  const result = svc.confirmLink('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410');
  assert.equal(result.hospitalNumber, 'IBD-77410');

  const { mrn } = fhirAdapter.resolveRecord('HospitalB-Ibadan', 'did:patientchain:p1');
  assert.equal(mrn, 'IBD-77410');
});

test('confirmLink cannot be replayed a second time for the same lookup', () => {
  const svc = new LinkageService(seeded());
  svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dateOfBirth: '1990-04-12' });
  svc.confirmLink('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410');

  assert.throws(() => svc.confirmLink('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410'));
});

test('linkFacility rate-limits lookups per patient after maxAttempts', () => {
  const svc = new LinkageService(seeded(), { maxAttempts: 3 });

  for (let i = 0; i < 3; i++) {
    assert.throws(() => svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'WRONG', { name: 'Adaeze Okafor', dateOfBirth: '1990-01-01' }), /No matching record found/);
  }
  assert.throws(
    () => svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'WRONG', { name: 'Adaeze Okafor', dateOfBirth: '1990-01-01' }),
    /too many lookup attempts/
  );
});

test('rate limiting is per patient, not global', () => {
  const svc = new LinkageService(seeded(), { maxAttempts: 1 });
  svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dateOfBirth: '1990-04-12' });

  // p1 is now over its limit, but p2 must be unaffected.
  assert.throws(() => svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dateOfBirth: '1990-04-12' }), /too many lookup attempts/);
  assert.doesNotThrow(() => svc.linkFacility('did:patientchain:p2', 'HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dateOfBirth: '1990-04-12' }));
});

test('a confirmed match expires, so a match the patient answered "No" to cannot be confirmed later', () => {
  const svc = new LinkageService(seeded(), { pendingTtlMs: 1000 });
  const realNow = Date.now;
  try {
    svc.linkFacility('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dateOfBirth: '1990-04-12' });
    const t0 = realNow();
    Date.now = () => t0 + 1001;
    assert.throws(() => svc.confirmLink('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410'), /no confirmed match pending/);
    assert.equal(svc.consumePending('did:patientchain:p1', 'HospitalB-Ibadan', 'IBD-77410'), false);
  } finally {
    Date.now = realNow;
  }
});

test('name is required; date of birth is optional and checked only when both sides have one', () => {
  const fhirAdapter = seeded();
  fhirAdapter.addLocalPatientRecord('HospitalB-Ibadan', 'IBD-NODOB', { name: 'YUSUF, Amina Bello', dob: null });
  const svc = new LinkageService(fhirAdapter, { maxAttempts: 50 });
  const H = 'HospitalB-Ibadan';

  // Record without a date of birth: hospital number + name is enough.
  assert.equal(svc.linkFacility('did:x1', H, 'IBD-NODOB', { name: 'Amina Yusuf' }).name, 'YUSUF, Amina Bello');
  assert.doesNotThrow(() => svc.linkFacility('did:x2', H, 'IBD-NODOB', { name: 'amina yusuf', dateOfBirth: '1980-01-01' }));
  // Record with a date of birth: patient may leave it out, but a wrong one fails.
  assert.doesNotThrow(() => svc.linkFacility('did:x3', H, 'IBD-77410', { name: 'Okafor Adaeze' }));
  assert.throws(() => svc.linkFacility('did:x4', H, 'IBD-77410', { name: 'Adaeze Okafor', dateOfBirth: '1991-01-01' }), /No matching record found/);
  // Wrong or partial name fails with the same generic error.
  assert.throws(() => svc.linkFacility('did:x5', H, 'IBD-NODOB', { name: 'Amina Musa' }), /No matching record found/);
  assert.throws(() => svc.linkFacility('did:x6', H, 'IBD-NODOB', { name: 'Amina' }), /No matching record found/);
  // Name missing: refused.
  assert.throws(() => svc.linkFacility('did:x7', H, 'IBD-NODOB', { dateOfBirth: '1990-04-12' }), /name are all required/);
});
