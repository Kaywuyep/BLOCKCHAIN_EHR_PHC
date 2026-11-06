'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');

test('GET /api/sync/status reflects the queue\'s live connectivity and depth', async () => {
  const server = await createTestServer();
  try {
    const before = await (await fetch(`${server.baseUrl}/api/sync/status`)).json();
    assert.equal(before.connected, true);
    assert.equal(before.queuedCount, 0);

    server.offlineQueue.setConnected(false);
    server.offlineQueue.enqueue('REQUEST_ACCESS', { grantID: 'g1' });

    const after = await (await fetch(`${server.baseUrl}/api/sync/status`)).json();
    assert.equal(after.connected, false);
    assert.equal(after.queuedCount, 1);
  } finally {
    await server.close();
  }
});

test('POST /api/sync/connectivity {connected:false} takes the demo offline without reconciling', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/sync/connectivity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connected: false }),
    });
    const body = await res.json();
    assert.equal(body.connected, false);
    assert.deepEqual(body.reconciled, []);
    assert.equal(server.offlineQueue.isConnected(), false);
  } finally {
    await server.close();
  }
});

test('POST /api/sync/connectivity {connected:true} reconciles everything queued while offline', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
    server.offlineQueue.setConnected(false);
    server.offlineQueue.enqueue('REQUEST_ACCESS', { grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });

    const res = await fetch(`${server.baseUrl}/api/sync/connectivity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connected: true }),
    });
    const body = await res.json();
    assert.equal(body.connected, true);
    assert.equal(body.reconciled.length, 1);
    assert.equal(body.reconciled[0].status, 'SYNCED');
    assert.equal(server.ledger.checkAccess({ grantID: 'g1' }).status, 'PENDING');
  } finally {
    await server.close();
  }
});

test('GET /api/sync/queue lists every queue item regardless of status', async () => {
  const server = await createTestServer();
  try {
    server.offlineQueue.enqueue('REQUEST_ACCESS', { grantID: 'g1' });
    const res = await fetch(`${server.baseUrl}/api/sync/queue`);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].payload.grantID, 'g1');
  } finally {
    await server.close();
  }
});
