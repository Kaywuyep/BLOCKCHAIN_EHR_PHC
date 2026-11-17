'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestServer } = require('../testutil/testServer');
const { normalize } = require('../services/emergencyCodes');

// Emergency code: a patient's 7-character code lets a clinician list the
// patient's hospitals and start break-glass when the family does not know a
// hospital number. Every use is on the patient's audit trail; wrong codes
// lock the clinician out.

const L = 'general-hospital-langtang';
const J = 'jos-university-teaching-hospital';

async function setUp() {
  const server = await createTestServer({ authMode: 'local' });
  const pat = await server.login({ subject: 'amina', role: 'patient' });
  const reg = await server.registerPatient(pat, { hospitalID: L, hospitalNumber: 'L-1', name: 'Amina Yusuf' });
  const did = reg.patientDID || reg.did || (await (await fetch(`${server.baseUrl}/api/auth/me`, { headers: { authorization: `Bearer ${pat}` } })).json()).patientDID;
  server.fhirAdapter.addLocalPatientRecord(J, 'J-1', { name: 'Amina Yusuf', dob: '1990-01-01' });
  server.fhirAdapter.registerLocalPatient(J, did, 'J-1');
  server.providerRegistry.register({ providerID: 'dr-bello', hospitalID: J, role: 'Physician', status: 'ACTIVE' });
  server.providerRegistry.register({ providerID: 'dr-musa', hospitalID: L, role: 'Physician', status: 'ACTIVE' });
  const pat2 = await server.login({ subject: 'amina', role: 'patient' });
  const bello = await server.login({ subject: 'dr-bello', role: 'clinician', hospitalID: J, providerID: 'dr-bello' });
  const call = (method, path, token, body) =>
    fetch(`${server.baseUrl}/api/access${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { server, did, pat: pat2, bello, call };
}

test('codes are 7 unambiguous characters and input is forgiving', () => {
  assert.equal(normalize('k7m 4qx9'), 'K7M4QX9');
  assert.equal(normalize('AMN-4K7O'), 'AMN4K70');
  assert.equal(normalize('ABC'), null);
});

test('the patient sees their code; a clinician lists hospitals and opens break-glass with it; all on the audit trail', async () => {
  const { server, did, pat, bello, call } = await setUp();
  try {
    const mine = await call('GET', `/emergency-code/${encodeURIComponent(did)}`, pat);
    assert.equal(mine.status, 200);
    const { code } = await mine.json();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{7}$/);
    assert.equal((await call('GET', `/emergency-code/${encodeURIComponent(did)}`, bello)).status, 403, 'only the patient sees it');

    const look = await call('POST', '/emergency-code/lookup', bello, { code: `${code.slice(0, 3)} ${code.slice(3).toLowerCase()}` });
    assert.equal(look.status, 200);
    const l = await look.json();
    assert.equal(l.patientName, 'Amina Yusuf');
    assert.deepEqual(l.hospitals.map((h) => h.hospitalID), [L]);
    assert.equal(JSON.stringify(l).includes(did), false, 'no Health ID returned');

    const bg = await call('POST', '/break-glass', bello, { emergencyCode: code, hospitalID: L, justification: 'Unconscious on arrival' });
    assert.equal(bg.status, 201);
    const trail = server.ledger.getAuditTrailForPatient(did).map((e) => e.eventType);
    assert.ok(trail.includes('EMERGENCY_CODE_USED'));
    assert.ok(trail.includes('BREAK_GLASS_ACCESS'));

    // A hospital outside the patient's network cannot be chosen.
    const bad = await call('POST', '/break-glass', bello, { emergencyCode: code, hospitalID: 'our-lady-of-apostles-hospital', justification: 'x' });
    assert.equal(bad.status, 409);

    // Replacing the code stops the old one.
    const fresh = await (await call('POST', `/emergency-code/${encodeURIComponent(did)}/regenerate`, pat)).json();
    assert.notEqual(fresh.code, code);
    assert.equal((await call('POST', '/emergency-code/lookup', bello, { code })).status, 404);
    assert.ok(server.ledger.getAuditTrailForPatient(did).some((e) => e.eventType === 'EMERGENCY_CODE_REPLACED'));
  } finally {
    await server.close();
  }
});

test('five wrong codes lock the clinician out, even for a right code', async () => {
  const { server, did, pat, bello, call } = await setUp();
  try {
    const { code } = await (await call('GET', `/emergency-code/${encodeURIComponent(did)}`, pat)).json();
    const wrong = code === 'ZZZZZZZ' ? 'YYYYYYY' : 'ZZZZZZZ';
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await call('POST', '/emergency-code/lookup', bello, { code: wrong })).status);
    assert.deepEqual(statuses, [404, 404, 404, 404, 429]);
    assert.equal((await call('POST', '/emergency-code/lookup', bello, { code })).status, 429);
    const patTok = await server.login({ subject: 'amina', role: 'patient' });
    assert.equal((await call('POST', '/emergency-code/lookup', patTok, { code })).status, 403, 'patients cannot look codes up');
  } finally {
    await server.close();
  }
});
