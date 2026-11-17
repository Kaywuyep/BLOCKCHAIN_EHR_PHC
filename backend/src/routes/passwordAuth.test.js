'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestServer } = require('../testutil/testServer');
const { fetchPractitioner } = require('../services/liveFhirClient');

// AUTH_MODE=password: patients sign up; the system admin creates hospitals
// (each with an admin account on a temporary password); hospital admins
// pull clinicians from their EMR by staff ID. Every account is recorded on
// the ledger before it is saved.

const H = 'test-teaching-hospital';

// A stand-in for the hospital EMR's Practitioner lookup.
function emrStub(staff) {
  return async (hospital, staffID) => {
    const s = staff[staffID];
    if (!s) throw new Error(`no staff member with the ID ${staffID} in the hospital's EMR`);
    return { staffID, practitionerId: `p-${staffID}`, ...s };
  };
}

async function setUp(staff = {}) {
  const server = await createTestServer({ authMode: 'password', fetchStaff: emrStub(staff) });
  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${server.baseUrl}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // empty body
    }
    return { status: res.status, body: json };
  };
  const login = (l, password) => api('POST', '/auth/login', { body: { login: l, password } });
  const onChain = (type) => server.ledger.audit && [...server.ledger.audit.values()].filter((e) => e.eventType === type);

  // First start: the system admin with a temporary password; change it.
  const first = await server.onboarding.bootstrapSystemAdmin();
  const t = await login(first.login, first.temporaryPassword);
  const changed = await api('POST', '/auth/password', { token: t.body.token, body: { currentPassword: first.temporaryPassword, newPassword: 'Admin-pass-2026' } });
  return { server, api, login, onChain, admin: changed.body.token, first };
}

async function createHospital(ctx) {
  return ctx.api('POST', '/admin/hospitals', {
    token: ctx.admin,
    body: {
      hospitalID: H,
      name: 'Test Teaching Hospital',
      integration: 'fhir',
      fhir: { baseUrl: 'http://127.0.0.1:9/fhir', authType: 'none', mrnIdentifierSystem: 'urn:test:mrn' },
    },
  });
}

test('a patient signs up with name, email and password, and the account is on the ledger', async () => {
  const ctx = await setUp();
  try {
    const res = await ctx.api('POST', '/auth/signup', { body: { fullName: 'Amina Yusuf', email: 'Amina@Example.com', password: 'kettle-blue-77' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.token);
    const me = await ctx.api('GET', '/auth/me', { token: res.body.token });
    assert.deepEqual(me.body.roles, ['patient']);
    assert.equal(me.body.displayName, 'Amina Yusuf');
    assert.equal(me.body.login, 'amina@example.com');
    assert.equal(me.body.patientDID, null, 'the DID comes later, at the first hospital');

    const entry = ctx.onChain('ACCOUNT_CREATED').find((e) => e.actorID === me.body.sub);
    assert.ok(entry, 'ACCOUNT_CREATED written to the ledger');
    assert.ok(!JSON.stringify(entry).includes('amina'), 'no name or email on-chain');

    const dup = await ctx.api('POST', '/auth/signup', { body: { fullName: 'Someone Else', email: 'amina@example.com', password: 'kettle-blue-88' } });
    assert.equal(dup.status, 409);
    const weak = await ctx.api('POST', '/auth/signup', { body: { fullName: 'Bob Okafor', email: 'bob@example.com', password: 'short1' } });
    assert.equal(weak.status, 400);
    const noSurname = await ctx.api('POST', '/auth/signup', { body: { fullName: 'Bob', email: 'bob@example.com', password: 'kettle-blue-77' } });
    assert.equal(noSurname.status, 400);

    assert.equal((await ctx.login('AMINA@example.com', 'kettle-blue-77')).status, 200);
    assert.equal((await ctx.login('amina@example.com', 'wrong-password-1')).status, 401);
  } finally {
    await ctx.server.close();
  }
});

test('five wrong passwords lock the account, and the lock is stored', async () => {
  const ctx = await setUp();
  try {
    await ctx.api('POST', '/auth/signup', { body: { fullName: 'Ibrahim Danladi', email: 'ib@example.com', password: 'river-stone-42' } });
    for (let i = 0; i < 4; i += 1) assert.equal((await ctx.login('ib@example.com', 'nope-nope-1')).status, 401);
    assert.equal((await ctx.login('ib@example.com', 'nope-nope-1')).status, 429);
    assert.equal((await ctx.login('ib@example.com', 'river-stone-42')).status, 429, 'locked even with the right password');
    const row = ctx.server.db.prepare("SELECT locked_until FROM credentials WHERE login = 'ib@example.com'").get();
    assert.ok(row.locked_until);
  } finally {
    await ctx.server.close();
  }
});

test('a temporary password allows nothing until it is changed', async () => {
  const ctx = await setUp();
  try {
    assert.ok(ctx.onChain('ACCOUNT_CREATED').some((e) => e.actorID === 'superadmin'));
    // The bootstrap password no longer works; the new one does.
    assert.equal((await ctx.login('superadmin', ctx.first.temporaryPassword)).status, 401);
    assert.equal((await ctx.login('superadmin', 'Admin-pass-2026')).status, 200);

    const reset = await ctx.api('POST', '/admin/users/superadmin/reset-password', { token: ctx.admin });
    assert.equal(reset.status, 200);
    const t = await ctx.login('superadmin', reset.body.temporaryPassword);
    assert.equal(t.body.mustChangePassword, true);
    const blocked = await ctx.api('GET', '/admin/hospitals', { token: t.body.token });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
    const me = await ctx.api('GET', '/auth/me', { token: t.body.token });
    assert.equal(me.body.mustChangePassword, true);
  } finally {
    await ctx.server.close();
  }
});

test('creating a hospital creates its admin account on a temporary password, both on the ledger', async () => {
  const ctx = await setUp();
  try {
    const res = await createHospital(ctx);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const acct = res.body.adminAccount;
    assert.equal(acct.login, `admin@${H}`);
    assert.match(acct.temporaryPassword, /^[A-Za-z2-9]{12}$/);
    assert.ok(ctx.onChain('HOSPITAL_REGISTERED').some((e) => e.hospitalID === H));
    assert.ok(ctx.onChain('ACCOUNT_CREATED').some((e) => e.actorID === `admin@${H}` && e.hospitalID === H));

    const t = await ctx.login(acct.login, acct.temporaryPassword);
    assert.equal(t.body.mustChangePassword, true);
    const ok = await ctx.api('POST', '/auth/password', { token: t.body.token, body: { currentPassword: acct.temporaryPassword, newPassword: 'Records-desk-9' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const overview = await ctx.api('GET', '/hospital-admin/overview', { token: ok.body.token });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.emrConnected, true);

    assert.equal((await createHospital(ctx)).status, 400, 'same hospital ID twice');
  } finally {
    await ctx.server.close();
  }
});

test('a hospital admin pulls a doctor from the EMR by staff ID; the EMR stays in charge', async () => {
  const staff = { 'JUTH-0042': { name: 'Dr. Ngozi Eze', role: 'Consultant Physician', department: 'Internal Medicine', active: true } };
  const ctx = await setUp(staff);
  try {
    const h = await createHospital(ctx);
    const t = await ctx.login(h.body.adminAccount.login, h.body.adminAccount.temporaryPassword);
    const ha = (await ctx.api('POST', '/auth/password', { token: t.body.token, body: { currentPassword: h.body.adminAccount.temporaryPassword, newPassword: 'Records-desk-9' } })).body.token;

    const preview = await ctx.api('POST', '/hospital-admin/clinicians/emr-lookup', { token: ha, body: { staffID: 'JUTH-0042' } });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.name, 'Dr. Ngozi Eze');
    assert.equal(preview.body.alreadyRegistered, false);
    assert.equal((await ctx.api('POST', '/hospital-admin/clinicians/emr-lookup', { token: ha, body: { staffID: 'NOPE-1' } })).status, 502);

    const added = await ctx.api('POST', '/hospital-admin/clinicians/from-emr', { token: ha, body: { staffID: 'JUTH-0042' } });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.provider.role, 'Consultant Physician');
    assert.equal(added.body.provider.source, 'emr');
    assert.equal(added.body.account.login, `juth-0042@${H}`);
    assert.ok(ctx.onChain('ACCOUNT_CREATED').some((e) => e.actorID === `juth-0042@${H}`));
    assert.equal((await ctx.api('POST', '/hospital-admin/clinicians/from-emr', { token: ha, body: { staffID: 'JUTH-0042' } })).status, 409);

    // Manual entry is refused for an EMR-connected hospital.
    const manual = await ctx.api('POST', '/hospital-admin/clinicians', { token: ha, body: { providerID: 'X-1', name: 'Typed In' } });
    assert.equal(manual.status, 400);

    // The doctor signs in, changes the temporary password and gets a clinician token.
    const d1 = await ctx.login(`JUTH-0042@${H}`, added.body.account.temporaryPassword);
    assert.equal(d1.status, 200);
    const d2 = await ctx.api('POST', '/auth/password', { token: d1.body.token, body: { currentPassword: added.body.account.temporaryPassword, newPassword: 'Doctor-pass-77' } });
    const me = await ctx.api('GET', '/auth/me', { token: d2.body.token });
    assert.deepEqual(me.body.roles, ['clinician']);
    assert.equal(me.body.providerID, 'JUTH-0042');
    assert.equal(me.body.hospitalID, H);

    // The EMR deactivates them: a re-sync applies it, on-chain, and sign-in stops.
    staff['JUTH-0042'].active = false;
    const sync = await ctx.api('POST', '/hospital-admin/clinicians/JUTH-0042/resync', { token: ha });
    assert.equal(sync.status, 200);
    assert.equal(sync.body.provider.status, 'INACTIVE');
    assert.ok(ctx.onChain('CLINICIAN_STATUS_CHANGED').some((e) => e.detail.includes('"to":"INACTIVE"')));
    assert.equal((await ctx.login(`juth-0042@${H}`, 'Doctor-pass-77')).status, 403);
    const reactivate = await ctx.api('POST', '/hospital-admin/clinicians', { token: ha, body: { providerID: 'JUTH-0042', status: 'ACTIVE' } });
    assert.equal(reactivate.status, 400, 'cannot re-activate against the EMR');

    // Back in the EMR: re-sync restores them.
    staff['JUTH-0042'].active = true;
    assert.equal((await ctx.api('POST', '/hospital-admin/clinicians/JUTH-0042/resync', { token: ha })).body.provider.status, 'ACTIVE');
    assert.equal((await ctx.login(`juth-0042@${H}`, 'Doctor-pass-77')).status, 200);

    // A doctor the EMR shows as inactive cannot be added.
    staff['JUTH-0099'] = { name: 'Dr. Gone', role: 'Physician', department: 'Surgery', active: false };
    assert.equal((await ctx.api('POST', '/hospital-admin/clinicians/from-emr', { token: ha, body: { staffID: 'JUTH-0099' } })).status, 400);
  } finally {
    await ctx.server.close();
  }
});

test('a signed-up patient creates their Health ID at their first hospital as before', async () => {
  const ctx = await setUp();
  try {
    await createHospital(ctx);
    const s = await ctx.api('POST', '/auth/signup', { body: { fullName: 'Fatima Musa', email: 'fatima@example.com', password: 'green-mango-31' } });
    const token = s.body.token;
    ctx.server.fhirAdapter.addLocalPatientRecord(H, 'TTH-1001', { name: 'Fatima Musa', dob: '1994-03-02' });
    const look = await ctx.api('POST', '/patients/register/lookup', { token, body: { hospitalID: H, hospitalNumber: 'TTH-1001', name: 'Fatima Musa', dateOfBirth: '1994-03-02' } });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    const reg = await ctx.api('POST', '/patients/register', { token, body: { firstFacility: { hospitalID: H, hospitalNumber: 'TTH-1001' } } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const me = await ctx.api('GET', '/auth/me', { token });
    assert.match(me.body.patientDID, /^did:patientchain:/);

    // A hospital record may have no date of birth; hospital number and name are required.
    const ha = ctx.server.accounts.issueTemporary(`admin@${H}`, `admin@${H}`);
    const t = await ctx.login(ha.login, ha.temporaryPassword);
    const adminToken = (await ctx.api('POST', '/auth/password', { token: t.body.token, body: { currentPassword: ha.temporaryPassword, newPassword: 'Records-desk-9' } })).body.token;
    const add = (body) => ctx.api('POST', `/patients/local-records/${H}`, { token: adminToken, body });
    assert.equal((await add({ hospitalNumber: 'TTH-2002', name: 'Usman Garba' })).status, 201);
    assert.equal((await add({ hospitalNumber: 'TTH-2003' })).status, 400, 'name required');
    assert.equal((await add({ name: 'No Number' })).status, 400, 'hospital number required');
    const s2 = await ctx.api('POST', '/auth/signup', { body: { fullName: 'Usman Garba', email: 'usman@example.com', password: 'sand-dune-4471' } });
    const noDob = await ctx.api('POST', '/patients/register/lookup', { token: s2.body.token, body: { hospitalID: H, hospitalNumber: 'TTH-2002', name: 'Garba Usman' } });
    assert.equal(noDob.status, 200, JSON.stringify(noDob.body));
    const noName = await ctx.api('POST', '/patients/register/lookup', { token: s2.body.token, body: { hospitalID: H, hospitalNumber: 'TTH-2002' } });
    assert.equal(noName.status, 400);
  } finally {
    await ctx.server.close();
  }
});

test('local login and sign-up endpoints do not exist in password mode, and vice versa', async () => {
  const ctx = await setUp();
  try {
    const old = await ctx.api('POST', '/auth/login', { body: { subject: 'superadmin', role: 'system_admin' } });
    assert.equal(old.status, 400, 'the passwordless login is gone');
  } finally {
    await ctx.server.close();
  }
  const local = await createTestServer({ authMode: 'local' });
  try {
    const res = await fetch(`${local.baseUrl}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.notEqual(res.status, 201, 'no self sign-up outside password mode');
  } finally {
    await local.close();
  }
});

test('fetchPractitioner reads name, role, department and active from a FHIR server', async () => {
  const fhir = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/fhir+json');
    if (url.pathname === '/fhir/Practitioner') {
      const id = url.searchParams.get('identifier');
      const entry = id === 'urn:staff|S-7'
        ? [{ resource: { resourceType: 'Practitioner', id: 'pr7', active: true, name: [{ prefix: ['Dr.'], given: ['Musa'], family: 'Bello' }] } }]
        : [];
      return res.end(JSON.stringify({ resourceType: 'Bundle', entry }));
    }
    if (url.pathname === '/fhir/PractitionerRole') {
      return res.end(JSON.stringify({
        resourceType: 'Bundle',
        entry: [
          { resource: { resourceType: 'PractitionerRole', active: false, practitioner: { reference: 'Practitioner/pr7' }, code: [{ text: 'Old role' }] } },
          { resource: { resourceType: 'PractitionerRole', active: true, practitioner: { reference: 'Practitioner/pr7' }, code: [{ coding: [{ display: 'Medical Officer' }] }], specialty: [{ text: 'Paediatrics' }] } },
        ],
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => fhir.listen(0, r));
  const hospital = {
    hospitalID: 'fhir-test',
    fhir: { baseUrl: `http://127.0.0.1:${fhir.address().port}/fhir`, authType: 'none', staffIdentifierSystem: 'urn:staff' },
  };
  try {
    const p = await fetchPractitioner(hospital, 'S-7');
    assert.deepEqual(
      { name: p.name, role: p.role, department: p.department, active: p.active },
      { name: 'Dr. Musa Bello', role: 'Medical Officer', department: 'Paediatrics', active: true }
    );
    await assert.rejects(fetchPractitioner(hospital, 'S-8'), /no staff member/);
  } finally {
    fhir.close();
  }
});
