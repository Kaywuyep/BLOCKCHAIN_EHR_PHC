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
