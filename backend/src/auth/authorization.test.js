'use strict';

// End-to-end authorization tests: a real server in AUTH_MODE=local, real
// tokens, real routes. Each test is one rule from auth/policy.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestServer } = require('../testutil/testServer');

const H_A = 'hospital-a';
const H_B = 'hospital-b';

function client(baseUrl, token) {
  const call = (method) => async (path, body) => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { get: call('GET'), post: call('POST') };
}

/** A server with one patient, two clinicians, two hospital admins and a
 *  pending grant from the Hospital A clinician to the patient. */
async function world() {
  const server = await createTestServer({ authMode: 'local' });
  const as = async (identity) => client(server.baseUrl, await server.login(identity));
  const sysadmin = await as({ subject: 'root', role: 'system_admin' });
  const adminA = await as({ subject: 'admin-a', role: 'hospital_admin', hospitalID: H_A });
  const adminB = await as({ subject: 'admin-b', role: 'hospital_admin', hospitalID: H_B });
  const drA = await as({ subject: 'dr-a', role: 'clinician', hospitalID: H_A });
  const drB = await as({ subject: 'dr-b', role: 'clinician', hospitalID: H_B });
  const patient = await as({ subject: 'amina', role: 'patient' });
  const otherPatient = await as({ subject: 'bola', role: 'patient' });

  await adminA.post('/providers/register', { providerID: 'dr-a', hospitalID: H_A });
  await adminB.post('/providers/register', { providerID: 'dr-b', hospitalID: H_B });
  const registered = await patient.post('/patients/register', {});
  const did = registered.body.patient.patientDID;
  await otherPatient.post('/patients/register', {});
  const requested = await drA.post('/access/request', { patientDID: did, providerID: 'dr-a', hospitalID: H_A });

  return { server, sysadmin, adminA, adminB, drA, drB, patient, otherPatient, did, grantID: requested.body.grantID, anon: client(server.baseUrl) };
}

test('API calls without a token get 401; health and readiness stay public', async () => {
  const w = await world();
  try {
    assert.equal((await w.anon.get(`/patients/${w.did}`)).status, 401);
    assert.equal((await w.anon.get('/health')).status, 200);
    assert.equal((await w.anon.get('/ready')).status, 200);
  } finally {
    await w.server.close();
  }
});

test('a forged or tampered token is rejected', async () => {
  const w = await world();
  try {
    const token = await w.server.login({ subject: 'amina', role: 'patient' });
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.roles = ['system_admin'];
    const forged = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.');
    assert.equal((await client(w.server.baseUrl, forged).get('/hospitals/status')).status, 401);
  } finally {
    await w.server.close();
  }
});

test('registration binds the patient account to the minted DID, and a patient cannot claim another DID or attach a hospital number', async () => {
  const w = await world();
  try {
    const me = await w.patient.get('/auth/me');
    assert.equal(me.body.patientDID, w.did);
    // Registering again returns the same DID, not a new one.
    const again = await w.patient.post('/patients/register', {});
    assert.equal(again.body.patient.patientDID, w.did);
    const other = (await w.otherPatient.get('/auth/me')).body.patientDID;
    assert.equal((await w.patient.post('/patients/register', { patientDID: other })).status, 403);
    assert.equal((await w.otherPatient.post('/patients/register', { hospitalID: H_A, mrn: 'MRN-1' })).status, 403);
  } finally {
    await w.server.close();
  }
});

test('a clinician can only request access as themselves at their own hospital', async () => {
  const w = await world();
  try {
    assert.equal(w.grantID && typeof w.grantID, 'string');
    assert.equal((await w.drA.post('/access/request', { patientDID: w.did, providerID: 'dr-b', hospitalID: H_B })).status, 403);
    assert.equal((await w.drA.post('/access/request', { patientDID: w.did, providerID: 'dr-a', hospitalID: H_B })).status, 403);
    assert.equal((await w.patient.post('/access/request', { patientDID: w.did, providerID: 'dr-a', hospitalID: H_A })).status, 403);
  } finally {
    await w.server.close();
  }
});

test('only the patient who owns a grant can approve or revoke it', async () => {
  const w = await world();
  try {
    assert.equal((await w.otherPatient.post(`/access/${w.grantID}/grant`, { durationMinutes: 30 })).status, 403);
    assert.equal((await w.drA.post(`/access/${w.grantID}/grant`, { durationMinutes: 30 })).status, 403);
    assert.equal((await w.patient.post(`/access/${w.grantID}/grant`, { durationMinutes: 30 })).status, 200);
    assert.equal((await w.otherPatient.post(`/access/${w.grantID}/revoke`, {})).status, 403);
    assert.equal((await w.patient.post(`/access/${w.grantID}/revoke`, {})).status, 200);
  } finally {
    await w.server.close();
  }
});

test('records resolve only for the clinician named on the grant -- knowing the grant ID is not enough', async () => {
  const w = await world();
  try {
    w.server.fhirAdapter.registerLocalPatient(H_A, w.did, 'A-001');
    await w.patient.post(`/access/${w.grantID}/grant`, { durationMinutes: 30 });
    const path = `/records/resolve?grantID=${w.grantID}&hospitalID=${H_A}`;
    assert.equal((await w.drB.get(path)).status, 403);
    assert.equal((await w.adminA.get(path)).status, 403);
    assert.equal((await w.patient.get(path)).status, 403);
    assert.equal((await w.drA.get(path)).status, 200);
  } finally {
    await w.server.close();
  }
});

test('grant details are visible to its patient, its clinician and its hospital\'s admins only', async () => {
  const w = await world();
  try {
    for (const c of [w.patient, w.drA, w.adminA, w.sysadmin]) assert.equal((await c.get(`/access/${w.grantID}`)).status, 200);
    for (const c of [w.otherPatient, w.drB, w.adminB]) assert.equal((await c.get(`/access/${w.grantID}`)).status, 403);
  } finally {
    await w.server.close();
  }
});

test('audit trails: a patient sees their own, not someone else\'s', async () => {
  const w = await world();
  try {
    assert.equal((await w.patient.get(`/audit/patient/${w.did}`)).status, 200);
    assert.equal((await w.otherPatient.get(`/audit/patient/${w.did}`)).status, 403);
    assert.equal((await w.drA.get(`/audit/patient/${w.did}`)).status, 403);
  } finally {
    await w.server.close();
  }
});

test('break-glass: only the clinician themselves can invoke it, only their hospital\'s admin can review it, and the reviewer is the token identity', async () => {
  const w = await world();
  try {
    const body = { patientDID: w.did, providerID: 'dr-a', hospitalID: H_A, justification: 'unconscious in ER' };
    assert.equal((await w.drB.post('/access/break-glass', body)).status, 403);
    const bg = await w.drA.post('/access/break-glass', body);
    assert.equal(bg.status, 201);

    assert.equal((await w.adminB.get('/access/break-glass/pending')).body.length, 0);
    assert.equal((await w.adminA.get('/access/break-glass/pending')).body.length, 1);
    assert.equal((await w.adminB.post(`/access/${bg.body.grantID}/review`, { notes: 'ok' })).status, 403);
    const reviewed = await w.adminA.post(`/access/${bg.body.grantID}/review`, { reviewerID: 'someone-else', notes: 'justified' });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.reviewedBy || reviewed.body.reviewerID, 'admin-a');
  } finally {
    await w.server.close();
  }
});

test('hospital-scoped admin actions stay within the admin\'s own hospital', async () => {
  const w = await world();
  try {
    assert.equal((await w.adminB.post('/providers/register', { providerID: 'x', hospitalID: H_A })).status, 403);
    assert.equal((await w.adminB.get(`/patients/local-records/${H_A}`)).status, 403);
    assert.equal((await w.adminA.post(`/patients/local-records/${H_A}`, { hospitalNumber: 'A-9', name: 'N', dob: '2000-01-01' })).status, 201);
    assert.equal((await w.drA.post(`/patients/local-records/${H_A}`, { hospitalNumber: 'A-8', name: 'N', dob: '2000-01-01' })).status, 403);
    assert.equal((await w.sysadmin.get(`/patients/local-records/${H_A}`)).status, 200);
  } finally {
    await w.server.close();
  }
});

test('only a system admin may toggle simulated connectivity; patients cannot see admin dashboards', async () => {
  const w = await world();
  try {
    assert.equal((await w.adminA.post('/sync/connectivity', { connected: true })).status, 403);
    assert.equal((await w.sysadmin.post('/sync/connectivity', { connected: true })).status, 200);
    assert.equal((await w.patient.get('/cost/summary')).status, 403);
    assert.equal((await w.patient.get('/hospitals/status')).status, 403);
    assert.equal((await w.patient.get('/audit/events/recent')).status, 403);
  } finally {
    await w.server.close();
  }
});

test('an offline-queued grant approval by the wrong patient is rejected on replay', async () => {
  const w = await world();
  try {
    await w.sysadmin.post('/sync/connectivity', { connected: false });
    const queued = await w.otherPatient.post(`/access/${w.grantID}/grant`, { durationMinutes: 30 });
    assert.equal(queued.status, 202);
    const reconnect = await w.sysadmin.post('/sync/connectivity', { connected: true });
    assert.equal(reconnect.body.reconciled[0].status, 'REJECTED');
    assert.equal((await w.patient.get(`/access/${w.grantID}`)).body.status, 'PENDING');
  } finally {
    await w.server.close();
  }
});

test('HL7 submission requires that hospital\'s interface engine or admin', async () => {
  const w = await world();
  try {
    const engineA = client(w.server.baseUrl, await w.server.login({ subject: 'engine-a', role: 'hl7_interface', hospitalID: H_A }));
    const { adtA01Admit } = require('../services/hl7AdtListener.fixtures');
    const send = (c, hospital) =>
      fetch(`${w.server.baseUrl}/api/hl7/adt/${hospital}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain', ...(c ? { authorization: c } : {}) },
        body: adtA01Admit,
      });
    const tokenA = await w.server.login({ subject: 'engine-a', role: 'hl7_interface', hospitalID: H_A });
    assert.equal((await send(`Bearer ${tokenA}`, H_B)).status, 403);
    assert.equal((await send(undefined, H_A)).status, 401);
    assert.equal((await send(`Bearer ${tokenA}`, H_A)).status, 201);
    assert.ok(engineA);
  } finally {
    await w.server.close();
  }
});

test('local login is unavailable when auth is off, and login input is validated', async () => {
  const off = await createTestServer();
  try {
    assert.equal((await client(off.baseUrl).post('/auth/login', { subject: 'x', role: 'patient' })).status, 404);
  } finally {
    await off.close();
  }
  const local = await createTestServer({ authMode: 'local' });
  try {
    const c = client(local.baseUrl);
    assert.equal((await c.post('/auth/login', { subject: 'x', role: 'superhero' })).status, 400);
    assert.equal((await c.post('/auth/login', { subject: 'x', role: 'clinician' })).status, 400);
    assert.equal((await c.post('/auth/login', { subject: '<script>', role: 'patient' })).status, 400);
  } finally {
    await local.close();
  }
});
