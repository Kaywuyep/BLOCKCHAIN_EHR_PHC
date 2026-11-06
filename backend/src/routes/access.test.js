'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');

async function postJson(url, body) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('POST /api/access/request requires patientDID, providerID and hospitalID', async () => {
  const server = await createTestServer();
  try {
    const res = await postJson(`${server.baseUrl}/api/access/request`, { patientDID: 'did:p1' });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

test('the full grant lifecycle: request -> grant -> revoke, each visible via GET /api/access/:grantID', async () => {
  const server = await createTestServer();
  try {
    const requested = await postJson(`${server.baseUrl}/api/access/request`, {
      grantID: 'g1',
      patientDID: 'did:p1',
      providerID: 'prov-1',
      hospitalID: 'HospitalA-Lagos',
    });
    assert.equal(requested.status, 201);
    assert.equal((await requested.json()).status, 'PENDING');

    const granted = await postJson(`${server.baseUrl}/api/access/g1/grant`, { durationMinutes: 30 });
    assert.equal(granted.status, 200);
    assert.equal((await granted.json()).status, 'ACTIVE');

    const revoked = await postJson(`${server.baseUrl}/api/access/g1/revoke`, {});
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).status, 'REVOKED');

    const finalState = await fetch(`${server.baseUrl}/api/access/g1`);
    assert.equal((await finalState.json()).status, 'REVOKED');
  } finally {
    await server.close();
  }
});

test('GET /api/access/:grantID returns 404 for an unknown grant', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/access/does-not-exist`);
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

test('GET /api/access/patient/:did lists only that patient\'s grants', async () => {
  const server = await createTestServer();
  try {
    await postJson(`${server.baseUrl}/api/access/request`, { grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });
    await postJson(`${server.baseUrl}/api/access/request`, { grantID: 'g2', patientDID: 'did:p2', providerID: 'prov-2', hospitalID: 'HospitalB' });

    const res = await fetch(`${server.baseUrl}/api/access/patient/did:p1`);
    const grants = await res.json();
    assert.equal(grants.length, 1);
    assert.equal(grants[0].grantID, 'g1');
  } finally {
    await server.close();
  }
});

test('requests are queued instead of written to the ledger while offline, then a POST connectivity round trip is unaffected', async () => {
  const server = await createTestServer();
  try {
    server.offlineQueue.setConnected(false);

    const res = await postJson(`${server.baseUrl}/api/access/request`, {
      grantID: 'g1',
      patientDID: 'did:p1',
      providerID: 'prov-1',
      hospitalID: 'HospitalA',
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.queued, true);

    // Nothing should have reached the ledger yet.
    assert.throws(() => server.ledger.checkAccess({ grantID: 'g1' }), /not found/);

    // Reconnecting and reconciling replays the queued request onto the ledger.
    server.offlineQueue.setConnected(true);
    const results = await server.offlineQueue.reconcile(server.ledger);
    assert.equal(results[0].status, 'SYNCED');
    assert.equal(server.ledger.checkAccess({ grantID: 'g1' }).status, 'PENDING');
  } finally {
    await server.close();
  }
});

test('POST /api/access/break-glass requires a justification and activates immediately', async () => {
  const server = await createTestServer();
  try {
    const missingJustification = await postJson(`${server.baseUrl}/api/access/break-glass`, {
      patientDID: 'did:p1',
      providerID: 'prov-1',
      hospitalID: 'HospitalA',
    });
    assert.equal(missingJustification.status, 400);

    const res = await postJson(`${server.baseUrl}/api/access/break-glass`, {
      grantID: 'bg-1',
      patientDID: 'did:p1',
      providerID: 'prov-1',
      hospitalID: 'HospitalA',
      justification: 'Unconscious patient in ER',
    });
    assert.equal(res.status, 201);
    const grant = await res.json();
    assert.equal(grant.status, 'ACTIVE');
    assert.equal(grant.reviewRequired, true);

    // A break-glass access must leave an audit trail immediately, not only after review.
    const audit = server.ledger.getAuditTrailForPatient('did:p1');
    assert.ok(audit.some((e) => e.eventType === 'BREAK_GLASS_ACCESS'));
  } finally {
    await server.close();
  }
});

test('the break-glass review queue empties once a grant is reviewed', async () => {
  const server = await createTestServer();
  try {
    await postJson(`${server.baseUrl}/api/access/break-glass`, {
      grantID: 'bg-1',
      patientDID: 'did:p1',
      providerID: 'prov-1',
      hospitalID: 'HospitalA',
      justification: 'Emergency',
    });

    const pendingBefore = await fetch(`${server.baseUrl}/api/access/break-glass/pending`);
    assert.equal((await pendingBefore.json()).length, 1);

    const missingReviewer = await postJson(`${server.baseUrl}/api/access/bg-1/review`, {});
    assert.equal(missingReviewer.status, 400);

    const reviewed = await postJson(`${server.baseUrl}/api/access/bg-1/review`, { reviewerID: 'admin-1', notes: 'Confirmed legitimate' });
    assert.equal(reviewed.status, 200);

    const pendingAfter = await fetch(`${server.baseUrl}/api/access/break-glass/pending`);
    assert.equal((await pendingAfter.json()).length, 0);
  } finally {
    await server.close();
  }
});
