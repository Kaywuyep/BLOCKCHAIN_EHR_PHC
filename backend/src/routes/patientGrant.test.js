'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');

// A standing share needs both hospitals in the patient's network: after
// registering at hospital-a, link Langtang and Wase too.
function linkMore(server, did) {
  for (const [h, n] of [['general-hospital-langtang', 'L-1'], ['general-hospital-wase', 'W-1']]) {
    server.fhirAdapter.addLocalPatientRecord(h, n, { name: 'Test Patient', dob: '1990-01-01' });
    server.fhirAdapter.registerLocalPatient(h, did, n);
  }
}

async function postJson(url, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('POST /api/access/patient-grant creates and immediately activates a grant (superuser/off mode)', async () => {
  const server = await createTestServer();
  try {
    // Register a patient first so the ledger knows them
    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });

    const res = await postJson(`${server.baseUrl}/api/access/patient-grant`, {
      hospitalID: 'HospitalA',
      durationMinutes: 60,
      purpose: 'Interoperability',
    });
    // In off mode, superuser doesn't have a patientDID so it should fail
    // (the endpoint requires req.user.patientDID)
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

test('POST /api/access/patient-grant requires hospitalID', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    // Register patient and bind identity
    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });
    server.identityStore.bind('amina', 'did:patientchain:p1');
    const token = await server.login({ subject: 'amina', role: 'patient' });

    const res = await postJson(`${server.baseUrl}/api/access/patient-grant`, {}, token);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('hospitalID'));
  } finally {
    await server.close();
  }
});

test('POST /api/access/patient-grant requires patient role', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    const token = await server.login({ subject: 'dr-musa', role: 'clinician', hospitalID: 'HospitalA' });
    const res = await postJson(`${server.baseUrl}/api/access/patient-grant`, {
      hospitalID: 'HospitalA',
    }, token);
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

test('POST /api/access/patient-grant requires the patient to have a registered DID', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    // Patient without a DID binding
    const token = await server.login({ subject: 'unregistered', role: 'patient' });
    const res = await postJson(`${server.baseUrl}/api/access/patient-grant`, {
      hospitalID: 'HospitalA', viewerHospitalID: 'HospitalB',
    }, token);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('Health ID'));
  } finally {
    await server.close();
  }
});

test('POST /api/access/patient-grant full flow: patient registers, then grants hospital access', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    // Step 1: Patient registers (gets a DID)
    const token = await server.login({ subject: 'amina', role: 'patient' });
    const regRes = await server.registerPatient(token);
    assert.equal(regRes.status, 201);
    const { patient } = await regRes.json();
    linkMore(server, patient.patientDID);

    // Re-login to get the updated session with patientDID bound
    const token2 = await server.login({ subject: 'amina', role: 'patient' });

    // Step 2: Patient grants hospital access
    const res = await postJson(`${server.baseUrl}/api/access/patient-grant`, {
      hospitalID: 'general-hospital-langtang',
      viewerHospitalID: 'hospital-a',
      durationMinutes: 1440,
      purpose: 'Interoperability',
    }, token2);
    assert.equal(res.status, 201);
    const grant = await res.json();
    assert.equal(grant.status, 'ACTIVE', 'patient-initiated grant should be immediately ACTIVE');
    assert.equal(grant.hospitalID, 'general-hospital-langtang');
    assert.equal(grant.patientDID, patient.patientDID);
    assert.equal(grant.purpose, 'Interoperability');
    assert.ok(grant.expiresAt, 'grant should have an expiry time');

    // Step 3: Grant should appear in the patient's grant list
    const listRes = await fetch(`${server.baseUrl}/api/access/patient/${encodeURIComponent(patient.patientDID)}`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    const grants = await listRes.json();
    assert.equal(grants.length, 1);
    assert.equal(grants[0].status, 'ACTIVE');

    // Step 4: Audit trail should have the grant event
    const auditRes = await fetch(`${server.baseUrl}/api/audit/patient/${encodeURIComponent(patient.patientDID)}`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    const audit = await auditRes.json();
    assert.ok(audit.some(e => e.eventType === 'PATIENT_GRANTED_HOSPITAL'), 'audit should contain PATIENT_GRANTED_HOSPITAL event');
  } finally {
    await server.close();
  }
});

test('POST /api/access/patient-grant defaults to 24 hours if durationMinutes is not specified', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    const token = await server.login({ subject: 'amina', role: 'patient' });
    linkMore(server, (await (await server.registerPatient(token)).json()).patient.patientDID);
    const token2 = await server.login({ subject: 'amina', role: 'patient' });

    const res = await postJson(`${server.baseUrl}/api/access/patient-grant`, {
      hospitalID: 'general-hospital-wase', viewerHospitalID: 'hospital-a',
    }, token2);
    assert.equal(res.status, 201);
    const grant = await res.json();
    assert.equal(grant.status, 'ACTIVE');

    // Check the expiry is roughly 24 hours from now
    const expiresAt = new Date(grant.expiresAt).getTime();
    const now = Date.now();
    const diffMinutes = (expiresAt - now) / 60000;
    assert.ok(diffMinutes > 1430 && diffMinutes < 1450, `expected ~1440 min, got ${Math.round(diffMinutes)}`);
  } finally {
    await server.close();
  }
});

test('patient can grant multiple hospitals and then revoke one', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    const token = await server.login({ subject: 'amina', role: 'patient' });
    linkMore(server, (await (await server.registerPatient(token)).json()).patient.patientDID);
    const token2 = await server.login({ subject: 'amina', role: 'patient' });

    // Grant two hospitals
    const g1 = await postJson(`${server.baseUrl}/api/access/patient-grant`, {
      hospitalID: 'general-hospital-langtang', viewerHospitalID: 'hospital-a',
    }, token2);
    assert.equal(g1.status, 201);
    const grant1 = await g1.json();

    const g2 = await postJson(`${server.baseUrl}/api/access/patient-grant`, {
      hospitalID: 'general-hospital-wase', viewerHospitalID: 'hospital-a',
    }, token2);
    assert.equal(g2.status, 201);

    // Verify both are active
    const meRes = await fetch(`${server.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    const me = await meRes.json();
    const listRes = await fetch(`${server.baseUrl}/api/access/patient/${encodeURIComponent(me.patientDID)}`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    const grants = await listRes.json();
    const active = grants.filter(g => g.status === 'ACTIVE');
    assert.equal(active.length, 2);

    // Revoke one
    const revokeRes = await postJson(`${server.baseUrl}/api/access/${grant1.grantID}/revoke`, {}, token2);
    assert.equal(revokeRes.status, 200);
    const revoked = await revokeRes.json();
    assert.equal(revoked.status, 'REVOKED');

    // Verify only one remains active
    const listRes2 = await fetch(`${server.baseUrl}/api/access/patient/${encodeURIComponent(me.patientDID)}`, {
      headers: { Authorization: `Bearer ${token2}` },
    });
    const grants2 = await listRes2.json();
    const active2 = grants2.filter(g => g.status === 'ACTIVE');
    assert.equal(active2.length, 1);
    assert.equal(active2[0].hospitalID, 'general-hospital-wase');
  } finally {
    await server.close();
  }
});
