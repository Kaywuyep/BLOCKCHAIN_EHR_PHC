'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');

async function postJson(url, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('GET /api/patients/lookup-by-hospital-number returns patient DID and name for a linked patient', async () => {
  const server = await createTestServer();
  try {
    // Seed: roster entry + DID link
    server.fhirAdapter.addLocalPatientRecord('HospitalA', '536728', { name: 'Amina Yusuf', dob: '1995-03-15' });
    server.fhirAdapter.registerLocalPatient('HospitalA', 'did:patientchain:p1', '536728');

    const res = await fetch(`${server.baseUrl}/api/patients/lookup-by-hospital-number/HospitalA/536728`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.patientDID, 'did:patientchain:p1');
    assert.equal(body.hospitalNumber, '536728');
    assert.equal(body.name, 'Amina Yusuf');
    assert.equal(body.hospitalID, 'HospitalA');
  } finally {
    await server.close();
  }
});

test('GET /api/patients/lookup-by-hospital-number returns 404 for an unlinked hospital number', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/patients/lookup-by-hospital-number/HospitalA/999999`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error.includes('No patient'));
  } finally {
    await server.close();
  }
});

test('GET /api/patients/lookup-by-hospital-number is hospital-scoped: a number at hospital A does not resolve at hospital B', async () => {
  const server = await createTestServer();
  try {
    server.fhirAdapter.addLocalPatientRecord('HospitalA', '536728', { name: 'Amina Yusuf', dob: '1995-03-15' });
    server.fhirAdapter.registerLocalPatient('HospitalA', 'did:patientchain:p1', '536728');

    const res = await fetch(`${server.baseUrl}/api/patients/lookup-by-hospital-number/HospitalB/536728`);
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

test('lookup-by-hospital-number requires clinician/admin role (patients get 403)', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    server.fhirAdapter.addLocalPatientRecord('hospital-a', '536728', { name: 'Amina Yusuf', dob: '1995-03-15' });
    server.fhirAdapter.registerLocalPatient('hospital-a', 'did:patientchain:p1', '536728');

    const patientToken = await server.login({ subject: 'amina', role: 'patient' });
    const res = await fetch(`${server.baseUrl}/api/patients/lookup-by-hospital-number/hospital-a/536728`, {
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    assert.equal(res.status, 403, 'patients should not be able to look up other patients by hospital number');

    const clinicianToken = await server.login({ subject: 'dr-musa', role: 'clinician', hospitalID: 'hospital-a' });
    const res2 = await fetch(`${server.baseUrl}/api/patients/lookup-by-hospital-number/hospital-a/536728`, {
      headers: { Authorization: `Bearer ${clinicianToken}` },
    });
    assert.equal(res2.status, 200, 'clinicians should be able to look up patients');
  } finally {
    await server.close();
  }
});

test('full clinician flow: lookup patient by hospital number, request access, patient approves', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    // Setup: register patient, seed roster, link DID
    const patientToken = await server.login({ subject: 'amina', role: 'patient' });
    const regRes = await server.registerPatient(patientToken, { hospitalID: 'hospital-a', hospitalNumber: '536728', name: 'Amina Yusuf', dob: '1995-03-15' });
    const { patient } = await regRes.json();

    // Re-login to bind DID
    const patientToken2 = await server.login({ subject: 'amina', role: 'patient' });

    // Amina also has JUTH in her network (registration linked hospital-a).
    server.fhirAdapter.addLocalPatientRecord('juth', '10045321', { name: 'Amina Yusuf', dob: '1995-03-15' });
    server.fhirAdapter.registerLocalPatient('juth', patient.patientDID, '10045321');

    // Step 1: Clinician looks up patient by hospital number
    const clinicianToken = await server.login({ subject: 'dr-musa', role: 'clinician', hospitalID: 'hospital-a' });
    const lookupRes = await fetch(`${server.baseUrl}/api/patients/lookup-by-hospital-number/hospital-a/536728`, {
      headers: { Authorization: `Bearer ${clinicianToken}` },
    });
    assert.equal(lookupRes.status, 200);
    const lookup = await lookupRes.json();
    assert.equal(lookup.patientDID, patient.patientDID);
    assert.equal(lookup.name, 'Amina Yusuf');
    // The clinician sees which other hospitals are in her network (not her numbers there).
    assert.deepEqual(lookup.network, [{ hospitalID: 'juth' }]);

    // Step 2: Clinician requests access using the discovered DID
    const requestRes = await postJson(`${server.baseUrl}/api/access/request`, {
      patientDID: lookup.patientDID,
      providerID: 'dr-musa',
      hospitalID: 'juth',
      scope: ['Observation', 'MedicationRequest'],
      purpose: 'Treatment',
    }, clinicianToken);
    assert.equal(requestRes.status, 201);
    const grant = await requestRes.json();
    assert.equal(grant.status, 'PENDING');

    // Step 3: Patient sees the pending request
    const grantsRes = await fetch(`${server.baseUrl}/api/access/patient/${encodeURIComponent(patient.patientDID)}`, {
      headers: { Authorization: `Bearer ${patientToken2}` },
    });
    const grants = await grantsRes.json();
    assert.equal(grants.length, 1);
    assert.equal(grants[0].status, 'PENDING');
    assert.equal(grants[0].providerID, 'dr-musa');

    // Step 4: Patient approves
    const approveRes = await postJson(`${server.baseUrl}/api/access/${grant.grantID}/grant`, {
      durationMinutes: 30,
    }, patientToken2);
    assert.equal(approveRes.status, 200);
    const approved = await approveRes.json();
    assert.equal(approved.status, 'ACTIVE');
  } finally {
    await server.close();
  }
});
