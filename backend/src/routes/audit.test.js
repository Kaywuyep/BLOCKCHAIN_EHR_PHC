'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');

test('GET /api/audit/patient/:did returns only that patient\'s audit trail', async () => {
  const server = await createTestServer();
  try {
    server.ledger.writeAuditEntry({ entryID: 'a1', patientDID: 'did:p1', eventType: 'GRANT_ISSUED', actorID: 'did:p1', hospitalID: 'HospitalA' });
    server.ledger.writeAuditEntry({ entryID: 'a2', patientDID: 'did:p2', eventType: 'GRANT_ISSUED', actorID: 'did:p2', hospitalID: 'HospitalB' });

    const res = await fetch(`${server.baseUrl}/api/audit/patient/did:p1`);
    assert.equal(res.status, 200);
    const entries = await res.json();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entryID, 'a1');
  } finally {
    await server.close();
  }
});

test('GET /api/audit/patient/:did returns an empty array for a patient with no history', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/audit/patient/did:nobody`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  } finally {
    await server.close();
  }
});

test('GET /api/audit/events/recent surfaces ledger events, most recent first', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
    server.ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });

    const res = await fetch(`${server.baseUrl}/api/audit/events/recent`);
    assert.equal(res.status, 200);
    const events = await res.json();
    assert.equal(events[0].type, 'AccessRequested');
  } finally {
    await server.close();
  }
});

test('GET /audit/me returns only the signed-in clinician\'s own ledger entries, newest first', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    const L = server.ledger;
    L.writeAuditEntry({ entryID: 'm1', patientDID: 'did:p1', eventType: 'RECORD_ACCESSED', actorID: 'dr-a', hospitalID: 'h1', clientTimestamp: '2026-11-01T10:00:00Z' });
    L.writeAuditEntry({ entryID: 'm2', patientDID: 'did:p2', eventType: 'BREAK_GLASS_ACCESS', actorID: 'dr-a', hospitalID: 'h1', clientTimestamp: '2026-11-02T10:00:00Z' });
    L.writeAuditEntry({ entryID: 'm3', patientDID: 'did:p1', eventType: 'RECORD_ACCESSED', actorID: 'dr-b', hospitalID: 'h1', clientTimestamp: '2026-11-03T10:00:00Z' });
    const get = async (token) => fetch(`${server.baseUrl}/api/audit/me`, { headers: { authorization: `Bearer ${token}` } });
    const drA = await server.login({ subject: 'dr-a', role: 'clinician', hospitalID: 'h1', providerID: 'dr-a' });
    const res = await get(drA);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).map((e) => e.entryID), ['m2', 'm1']);
    const patient = await server.login({ subject: 'p', role: 'patient' });
    assert.equal((await get(patient)).status, 403);
  } finally {
    await server.close();
  }
});
