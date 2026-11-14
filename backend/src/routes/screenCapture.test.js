'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');

function post(server, body, token) {
  return fetch(`${server.baseUrl}/api/audit/screen-capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function list(server, token) {
  return fetch(`${server.baseUrl}/api/audit/screen-captures`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

test('a screenshot attempt is written to the ledger audit trail of the patient on screen', async () => {
  const server = await createTestServer();
  try {
    const res = await post(server, { method: 'print-screen', page: '/clinician/records?x=1', patientDID: 'did:p1' });
    assert.equal(res.status, 201);
    const attempt = await res.json();
    assert.equal(attempt.page, '/clinician/records');

    const trail = server.ledger.getAuditTrailForPatient('did:p1');
    assert.equal(trail.length, 1);
    assert.equal(trail[0].eventType, 'SCREEN_CAPTURE_ATTEMPT');
    assert.equal(trail[0].entryID, attempt.ledgerEntryID);
    assert.match(trail[0].detail, /method=print-screen; confidence=confirmed/);
  } finally {
    await server.close();
  }
});

test('screen-capture rejects unknown methods and confidence values', async () => {
  const server = await createTestServer();
  try {
    assert.equal((await post(server, { method: 'camera' })).status, 400);
    assert.equal((await post(server, { method: 'print', confidence: 'maybe' })).status, 400);
  } finally {
    await server.close();
  }
});

test('a patient attempt is filed under their own DID and actor, whatever the body says', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    const token = await server.login({ subject: 'amina', role: 'patient' });
    // Bind a DID to the patient by registering.
    const reg = await server.registerPatient(token, { body: { publicKey: 'pk-amina' } });
    assert.ok(reg.ok, `register failed: ${reg.status}`);
    const fresh = await server.login({ subject: 'amina', role: 'patient' });
    const me = await (await fetch(`${server.baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${fresh}` } })).json();
    assert.ok(me.patientDID);

    const res = await post(server, { method: 'mac-shortcut', confidence: 'suspected', patientDID: 'did:someone-else', actorID: 'spoof' }, fresh);
    assert.equal(res.status, 201);
    const attempt = await res.json();
    assert.equal(attempt.patientDID, me.patientDID);
    assert.equal(attempt.actorID, me.patientDID);
    assert.equal(server.ledger.getAuditTrailForPatient('did:someone-else').length, 0);
  } finally {
    await server.close();
  }
});

test('hospital admins list only their own hospital\'s attempts; patients cannot list', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    const drA = await server.login({ subject: 'dr-a', role: 'clinician', hospitalID: 'hospital-a' });
    const drB = await server.login({ subject: 'dr-b', role: 'clinician', hospitalID: 'hospital-b' });
    assert.equal((await post(server, { method: 'windows-snip', patientDID: 'did:p1' }, drA)).status, 201);
    assert.equal((await post(server, { method: 'print-screen' }, drB)).status, 201);

    const adminA = await server.login({ subject: 'admin-a', role: 'hospital_admin', hospitalID: 'hospital-a' });
    const rowsA = await (await list(server, adminA)).json();
    assert.equal(rowsA.length, 1);
    assert.equal(rowsA[0].actorID, 'dr-a');
    assert.equal(rowsA[0].hospitalID, 'hospital-a');

    const sys = await server.login({ subject: 'root', role: 'system_admin' });
    assert.equal((await (await list(server, sys)).json()).length, 2);

    const patient = await server.login({ subject: 'amina', role: 'patient' });
    assert.equal((await list(server, patient)).status, 403);
  } finally {
    await server.close();
  }
});

test('unauthenticated requests cannot log attempts in local auth mode', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    assert.equal((await post(server, { method: 'print-screen' })).status, 401);
  } finally {
    await server.close();
  }
});
