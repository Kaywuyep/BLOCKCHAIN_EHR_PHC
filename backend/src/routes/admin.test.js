'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestServer } = require('../testutil/testServer');
const fixtures = require('../services/hl7AdtListener.fixtures');

function call(server, method, path, body, token) {
  return fetch(`${server.baseUrl}/api/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('system admin adds an HL7 hospital with its first admin; it appears in the directory', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    const sys = await server.login({ subject: 'root', role: 'system_admin' });
    const res = await call(server, 'POST', '/hospitals', {
      name: 'General Hospital Pankshin', location: 'Pankshin, Plateau State', type: 'General Hospital',
      integration: 'hl7', hl7: { mllpEnabled: true, mllpPort: 5101, httpEnabled: true },
      adminUser: { subject: 'admin-pankshin', displayName: 'Pankshin Admin' },
    }, sys);
    assert.equal(res.status, 201);
    const h = await res.json();
    assert.equal(h.hospitalID, 'general-hospital-pankshin');
    assert.equal(h.adminUser.roles[0], 'hospital_admin');
    assert.equal(h.hl7HttpEndpoint, '/api/hl7/adt/general-hospital-pankshin');

    const dir = await (await fetch(`${server.baseUrl}/api/hospitals/directory?q=pankshin`, { headers: { authorization: `Bearer ${sys}` } })).json();
    assert.equal(dir.length, 1);
    assert.equal(dir[0].hl7, undefined, 'directory must not expose integration settings');

    // The created admin can sign in only as hospital_admin of that hospital.
    const adminTok = await server.login({ subject: 'admin-pankshin', role: 'hospital_admin' });
    const me = await (await fetch(`${server.baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${adminTok}` } })).json();
    assert.equal(me.hospitalID, 'general-hospital-pankshin');
    await assert.rejects(server.login({ subject: 'admin-pankshin', role: 'system_admin' }));

    // MLLP port clash is refused.
    const clash = await call(server, 'POST', '/hospitals', { name: 'Clinic Two', integration: 'hl7', hl7: { mllpPort: 5101 } }, sys);
    assert.equal(clash.status, 400);
  } finally {
    await server.close();
  }
});

test('FHIR hospital: secret is required, stored encrypted and never returned', async () => {
  const server = await createTestServer();
  try {
    const base = { name: 'Bingham University Teaching Hospital', integration: 'both',
      fhir: { baseUrl: 'https://fhir.example.org/R4', tokenUrl: 'https://auth.example.org/token', clientId: 'cevruni', mrnIdentifierSystem: 'urn:bingham:mrn' },
      hl7: { mllpEnabled: false, httpEnabled: true } };
    assert.equal((await call(server, 'POST', '/hospitals', base)).status, 400);
    const res = await call(server, 'POST', '/hospitals', { ...base, fhir: { ...base.fhir, clientSecret: 's3cret' } });
    assert.equal(res.status, 201);
    const text = JSON.stringify(await res.json());
    assert.ok(!text.includes('s3cret'));
    assert.match(text, /"hasClientSecret":true/);
    // Editing without a secret keeps the stored one.
    const upd = await call(server, 'PUT', '/hospitals/bingham-university-teaching-hospital', { location: 'Jos' });
    assert.equal(upd.status, 200);
    assert.equal(server.hospitalRegistry.getInternal('bingham-university-teaching-hospital')._fhirSecret, 's3cret');
  } finally {
    await server.close();
  }
});

test('HL7 dry run extracts patient fields, honouring a custom field map', async () => {
  const server = await createTestServer();
  try {
    const ok = await (await call(server, 'POST', '/hospitals/test-hl7', { message: fixtures.adtA01Admit })).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.extracted.hospitalNumber, 'LAG-00231');
    assert.equal(ok.extracted.messageType, 'ADT^A01');
    const bad = await call(server, 'POST', '/hospitals/test-hl7', { message: fixtures.adtA01Admit, fieldMap: { hospitalNumber: 'nonsense' } });
    assert.equal(bad.status, 400);
  } finally {
    await server.close();
  }
});

test('deactivated hospital refuses HTTP ADT and leaves the directory', async () => {
  const server = await createTestServer();
  try {
    await call(server, 'POST', '/hospitals', { name: 'Test Clinic Bokkos', integration: 'hl7', hl7: { mllpEnabled: false, httpEnabled: true } });
    const send = () => fetch(`${server.baseUrl}/api/hl7/adt/test-clinic-bokkos`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: fixtures.adtA01Admit });
    assert.ok((await send()).status < 300);
    assert.equal((await call(server, 'POST', '/hospitals/test-clinic-bokkos/status', { status: 'inactive' })).status, 200);
    assert.equal((await send()).status, 403);
    const dir = await (await fetch(`${server.baseUrl}/api/hospitals/directory?q=bokkos`)).json();
    assert.equal(dir.length, 0);
  } finally {
    await server.close();
  }
});

test('users list shows every role; non-system-admins are refused; disabled users are blocked', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    server.providerRegistry.register({ providerID: 'dr-x', hospitalID: 'general-hospital-wase', name: 'Dr X' });
    const sys = await server.login({ subject: 'root', role: 'system_admin' });
    const pat = await server.login({ subject: 'amina', role: 'patient' });
    await fetch(`${server.baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${pat}` } });

    const users = await (await call(server, 'GET', '/users', null, sys)).json();
    const roles = Object.fromEntries(users.map((u) => [u.subject, u.roles]));
    assert.deepEqual(roles['dr-x'], ['clinician']);
    assert.deepEqual(roles.amina, ['patient']);
    assert.deepEqual(roles.root, ['system_admin']);
    assert.equal(users.find((u) => u.subject === 'dr-x').hospitalName, 'General Hospital Wase');

    assert.equal((await call(server, 'GET', '/users', null, pat)).status, 403);
    assert.equal((await call(server, 'POST', '/users/amina/status', { status: 'disabled' }, sys)).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${pat}` } })).status, 403);
    assert.equal((await call(server, 'POST', '/users/root/status', { status: 'disabled' }, sys)).status, 400);
  } finally {
    await server.close();
  }
});
