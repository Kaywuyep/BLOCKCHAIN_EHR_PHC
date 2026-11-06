'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');

test('POST /api/patients/register mints a new DID when none is supplied', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/patients/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.patient.patientDID, /^did:patientchain:/);
  } finally {
    await server.close();
  }
});

test('POST /api/patients/register reuses an already-registered DID instead of minting a new one', async () => {
  const server = await createTestServer();
  try {
    const first = await fetch(`${server.baseUrl}/api/patients/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const firstBody = await first.json();

    const second = await fetch(`${server.baseUrl}/api/patients/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patientDID: firstBody.patient.patientDID }),
    });
    assert.equal(second.status, 201);
    const secondBody = await second.json();
    assert.equal(secondBody.patient.patientDID, firstBody.patient.patientDID);
  } finally {
    await server.close();
  }
});

test('POST /api/patients/register with a hospitalID also registers a local MRN via the FHIR adapter', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/patients/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalID: 'HospitalA-Lagos', mrn: 'LAG-00231' }),
    });
    const body = await res.json();
    assert.equal(body.localHospitalMrn, 'LAG-00231');
  } finally {
    await server.close();
  }
});

test('GET /api/patients/:did returns 404 for an unregistered DID and 200 for a registered one', async () => {
  const server = await createTestServer();
  try {
    const missing = await fetch(`${server.baseUrl}/api/patients/did:patientchain:nope`);
    assert.equal(missing.status, 404);

    const registered = server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });
    const found = await fetch(`${server.baseUrl}/api/patients/${registered.patientDID}`);
    assert.equal(found.status, 200);
    const body = await found.json();
    assert.equal(body.patientDID, 'did:patientchain:p1');
  } finally {
    await server.close();
  }
});

test('POST /api/patients/:did/references requires hospitalID and recordType, and never accepts a clinical body', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });

    const missingFields = await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/references`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missingFields.status, 400);

    const created = await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/references`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalID: 'HospitalA-Lagos', recordType: 'lab' }),
    });
    assert.equal(created.status, 201);
    const ref = await created.json();
    assert.equal(ref.recordType, 'lab');
    assert.ok(!('diagnosis' in ref) && !('fhirFields' in ref), 'a record reference must never carry clinical fields');
  } finally {
    await server.close();
  }
});

test('GET /api/patients/:did/references lists every reference registered for that patient', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });
    server.ledger.registerRecordReference({ refID: 'r1', patientDID: 'did:patientchain:p1', hospitalID: 'HospitalA-Lagos', recordType: 'lab' });
    server.ledger.registerRecordReference({ refID: 'r2', patientDID: 'did:patientchain:p1', hospitalID: 'HospitalB-Ibadan', recordType: 'encounter' });

    const res = await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/references`);
    const refs = await res.json();
    assert.equal(refs.length, 2);
  } finally {
    await server.close();
  }
});

// A hospital adding to its own pre-existing patient roster -- the entry
// point that makes real (non-seeded) facility-linkage testing possible.
test('POST /:hospitalID/local-records adds a roster entry a later link-facility lookup can match', async () => {
  const server = await createTestServer();
  try {
    const created = await fetch(`${server.baseUrl}/api/patients/local-records/HospitalB-Ibadan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalNumber: 'IBD-90210', name: 'Real Patient', dob: '1975-03-02' }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.deepEqual(createdBody, { hospitalNumber: 'IBD-90210', name: 'Real Patient', dob: '1975-03-02' });

    const listed = await fetch(`${server.baseUrl}/api/patients/local-records/HospitalB-Ibadan`);
    const list = await listed.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].hospitalNumber, 'IBD-90210');

    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });
    const lookup = await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/link-facility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalID: 'HospitalB-Ibadan', hospitalNumber: 'IBD-90210', dateOfBirth: '1975-03-02' }),
    });
    assert.equal(lookup.status, 200);
    const lookupBody = await lookup.json();
    assert.equal(lookupBody.name, 'Real Patient');
  } finally {
    await server.close();
  }
});

test('POST /:hospitalID/local-records requires hospitalNumber, name and dob', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/patients/local-records/HospitalA-Lagos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalNumber: 'X' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

// The patient-asserted facility-linkage flow (replaces the old MPI):
// POST /:did/link-facility looks a hospital number + DOB up against that
// hospital's own local patient index (fhirAdapter.js) and, on a match,
// returns just the name for a patient-facing confirmation -- it never
// links anything itself. POST /:did/confirm-link is the only thing that
// ever writes the DID <-> hospital-number mapping.
test('POST /:did/link-facility returns the matched name without linking anything yet', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });
    server.fhirAdapter.addLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dob: '1990-04-12' });

    const res = await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/link-facility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalID: 'HospitalB-Ibadan', hospitalNumber: 'IBD-77410', dateOfBirth: '1990-04-12' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'Adaeze Okafor');

    // Not linked yet -- resolveRecord must still fail for this DID.
    assert.throws(() => server.fhirAdapter.resolveRecord('HospitalB-Ibadan', 'did:patientchain:p1'));
  } finally {
    await server.close();
  }
});

test('POST /:did/link-facility returns the same generic error for a wrong hospital number as for a right number with the wrong DOB', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });
    server.fhirAdapter.addLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dob: '1990-04-12' });

    const wrongNumber = await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/link-facility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalID: 'HospitalB-Ibadan', hospitalNumber: 'NOPE-00000', dateOfBirth: '1990-04-12' }),
    });
    const wrongDob = await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/link-facility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalID: 'HospitalB-Ibadan', hospitalNumber: 'IBD-77410', dateOfBirth: '2000-01-01' }),
    });

    assert.equal(wrongNumber.status, 404);
    assert.equal(wrongDob.status, 404);
    const wrongNumberBody = await wrongNumber.json();
    const wrongDobBody = await wrongDob.json();
    assert.equal(wrongNumberBody.error, wrongDobBody.error, 'wrong number and wrong DOB must be indistinguishable');
  } finally {
    await server.close();
  }
});

test('POST /:did/confirm-link only succeeds after a matching link-facility lookup, and then links the DID', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });
    server.fhirAdapter.addLocalPatientRecord('HospitalB-Ibadan', 'IBD-77410', { name: 'Adaeze Okafor', dob: '1990-04-12' });

    const skipped = await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/confirm-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalID: 'HospitalB-Ibadan', hospitalNumber: 'IBD-77410' }),
    });
    assert.equal(skipped.status, 400, 'confirm-link must refuse a link that was never looked up and confirmed');

    await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/link-facility`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalID: 'HospitalB-Ibadan', hospitalNumber: 'IBD-77410', dateOfBirth: '1990-04-12' }),
    });

    const confirmed = await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/confirm-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hospitalID: 'HospitalB-Ibadan', hospitalNumber: 'IBD-77410' }),
    });
    assert.equal(confirmed.status, 201);

    const { mrn } = server.fhirAdapter.resolveRecord('HospitalB-Ibadan', 'did:patientchain:p1');
    assert.equal(mrn, 'IBD-77410');
  } finally {
    await server.close();
  }
});

test('POST /:did/link-facility rate-limits repeated lookups for the same patient', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });

    let last;
    for (let i = 0; i < 10; i++) {
      last = await fetch(`${server.baseUrl}/api/patients/did:patientchain:p1/link-facility`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hospitalID: 'HospitalB-Ibadan', hospitalNumber: 'GUESS', dateOfBirth: '1990-01-01' }),
      });
    }
    assert.equal(last.status, 429);
  } finally {
    await server.close();
  }
});
