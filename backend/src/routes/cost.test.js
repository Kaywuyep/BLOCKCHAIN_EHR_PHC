'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');
const { DEFAULT_PARAMS } = require('../services/costModel');

test('GET /api/cost/summary returns the full cost-model bundle using default params', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });

    const res = await fetch(`${server.baseUrl}/api/cost/summary`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.params.b, DEFAULT_PARAMS.b);
    assert.equal(body.counters.registration, 1);
    assert.ok(Array.isArray(body.actionCostCurve));
    assert.ok(typeof body.ledgerRate === 'number');
  } finally {
    await server.close();
  }
});

test('GET /api/cost/summary lets the caller override params via query string', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/cost/summary?b=25&Ce=1&Co=1&Cv=1`);
    const body = await res.json();
    assert.equal(body.params.b, 25);
    assert.equal(body.params.Ce, 1);
    assert.equal(body.params.k, DEFAULT_PARAMS.k, 'unspecified params should keep their default');
  } finally {
    await server.close();
  }
});
