'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createTestServer } = require('../testutil/testServer');
const sc = require('./smartClinicClient');

// A stand-in for SmartClinic's API (Primed E-Health), shaped like what its
// web app expects: POST staff/login { data: { username, password } } ->
// { token }, then ?token= on every call. Field names are deliberately
// SmartClinic-like and nested, so detection and mapping are exercised.
function fakeSmartClinic() {
  const state = { logins: 0, token: 'tok-1', staff: [
    { _id: 'a1', staff_id: 'JUTH/0042', fname: 'Ngozi', lname: 'Eze', designation: 'Consultant Physician', dept: { name: 'Internal Medicine' }, status: 'active' },
    { _id: 'a2', staff_id: 'JUTH/0099', fname: 'Musa', lname: 'Bello', designation: 'Medical Officer', dept: { name: 'Surgery' }, status: 'inactive' },
  ] };
  const patients = {
    'JUTH-12345': { _id: 'p1', hospital_number: 'JUTH-12345', firstname: 'Amina', middlename: 'Bello', surname: 'Yusuf', dob: '1995-03-15T00:00:00.000Z' },
    'JUTH-777': { _id: 'p2', hospital_number: 'JUTH-777', firstname: 'Usman', surname: 'Garba' },
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && u.pathname === '/v1/staff/login') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { data } = JSON.parse(body || '{}');
        state.logins += 1;
        if (data && data.username === 'cevruni' && data.password === 'right-pass') return send(200, { token: state.token, result: { fname: 'Cevruni' }, dept: { name: 'Records' } });
        return send(401, { error: true, message: 'Invalid username or password' });
      });
      return;
    }
    if (u.searchParams.get('token') !== state.token) return send(200, { error: true, message: 'Session expired, token invalid' });
    if (u.pathname === '/v1/patient/v2/search-Patient-By-HospitalNo') {
      const p = patients[u.searchParams.get('hospital_number')];
      return send(200, { error: false, result: p ? [p] : [] });
    }
    if (u.pathname === '/v1/staff/v2/staffs') {
      // Like SmartClinic: its own search over name (in stored order), email and staff number.
      const q = (u.searchParams.get('search') || '').toLowerCase();
      const hits = state.staff.filter((x) => !q || [`${x.fname} ${x.lname}`, x.firstName && `${x.firstName} ${x.lastName}`, x.email, x.staff_id].some((v) => v && String(v).toLowerCase().includes(q)));
      return send(200, { error: false, data: { docs: hits, total: hits.length } });
    }
    return send(404, { error: true, message: 'Invalid Route!' });
  });
  return { server, state };
}

async function start() {
  const f = fakeSmartClinic();
  await new Promise((r) => f.server.listen(0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${f.server.address().port}/v1/`;
  return f;
}

const hospitalFor = (base, extra = {}) => ({
  hospitalID: `sc-${Math.random()}`,
  integration: 'smartclinic',
  smartclinic: { baseUrl: base, username: 'cevruni', password: 'right-pass', fieldMap: {}, ...extra },
});

test('detects SmartClinic-style fields, finds patients and staff exactly, and re-logs in on an expired token', async () => {
  const f = await start();
  try {
    const h = hospitalFor(f.base);
    assert.deepEqual(await sc.findPatient(h, 'JUTH-12345'), { hospitalNumber: 'JUTH-12345', name: 'Amina Bello Yusuf', dob: '1995-03-15' });
    assert.deepEqual(await sc.findPatient(h, 'JUTH-777'), { hospitalNumber: 'JUTH-777', name: 'Usman Garba', dob: null });
    assert.equal(await sc.findPatient(h, 'NOPE'), null);

    const s = await sc.fetchStaff(h, 'juth/0042');
    assert.deepEqual({ name: s.name, role: s.role, department: s.department, active: s.active }, { name: 'Ngozi Eze', role: 'Consultant Physician', department: 'Internal Medicine', active: true });
    assert.equal((await sc.fetchStaff(h, 'JUTH/0099')).active, false);
    await assert.rejects(sc.fetchStaff(h, 'JUTH/0001'), /no staff member/);

    const before = f.state.logins;
    f.state.token = 'tok-2'; // SmartClinic expired our session
    assert.ok(await sc.findPatient(h, 'JUTH-777'));
    assert.equal(f.state.logins, before + 1, 'logged in again once');
  } finally {
    f.server.close();
  }
});

test('an explicit field map wins over detection', async () => {
  const f = await start();
  try {
    const h = hospitalFor(f.base, { fieldMap: { patientName: 'surname' } });
    assert.equal((await sc.findPatient(h, 'JUTH-12345')).name, 'Yusuf');
  } finally {
    f.server.close();
  }
});

test('Test connection reports each step, suggests a field map and shows sample field names', async () => {
  const f = await start();
  try {
    const ok = await sc.testConnection(hospitalFor(f.base), { hospitalNumber: 'JUTH-12345', staffID: 'JUTH/0042' });
    assert.equal(ok.ok, true, JSON.stringify(ok.steps));
    assert.equal(ok.suggested.patientHospitalNumber, 'hospital_number');
    assert.equal(ok.suggested.patientName, 'firstname + middlename + surname');
    assert.equal(ok.suggested.staffId, 'staff_id');
    assert.equal(ok.suggested.staffDepartment, 'dept');
    assert.equal(ok.suggested.staffList, 'data.docs');
    assert.ok(ok.samples.staff.fields.includes('dept.name'));

    const bad = await sc.testConnection(hospitalFor(f.base, { password: 'wrong' }), { hospitalNumber: 'JUTH-12345' });
    assert.equal(bad.ok, false);
    assert.match(bad.steps[0].detail, /refused the login.*Invalid username or password/);
  } finally {
    f.server.close();
  }
});

test('end to end: a SmartClinic hospital set up from the admin API; doctor pulled by staff ID; patient links with live data', async () => {
  const f = await start();
  const server = await createTestServer({ authMode: 'password' });
  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${server.baseUrl}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const login = (l, p) => api('POST', '/auth/login', { body: { login: l, password: p } });
  const settle = async (acct, next) => {
    const t = await login(acct.login, acct.temporaryPassword);
    return (await api('POST', '/auth/password', { token: t.body.token, body: { currentPassword: acct.temporaryPassword, newPassword: next } })).body.token;
  };
  try {
    const admin = await settle(await server.onboarding.bootstrapSystemAdmin(), 'Admin-pass-2026');
    const settings = { baseUrl: f.base, username: 'cevruni', password: 'right-pass' };

    const t = await api('POST', '/admin/hospitals/test-smartclinic', { token: admin, body: { ...settings, hospitalNumber: 'JUTH-12345', staffID: 'JUTH/0042' } });
    assert.equal(t.body.ok, true, JSON.stringify(t.body.steps));

    const h = await api('POST', '/admin/hospitals', { token: admin, body: { hospitalID: 'juth', name: 'Jos University Teaching Hospital', integration: 'smartclinic', smartclinic: settings } });
    assert.equal(h.status, 201, JSON.stringify(h.body));
    assert.equal(h.body.smartclinic.hasPassword, true);
    assert.equal(h.body.smartclinic.password, undefined, 'password never returned');
    // Saved hospital: a blank password in the test uses the stored one.
    const t2 = await api('POST', '/admin/hospitals/test-smartclinic', { token: admin, body: { hospitalID: 'juth', baseUrl: f.base, username: 'cevruni' } });
    assert.equal(t2.body.steps[0].ok, true);

    const ha = await settle(h.body.adminAccount, 'Records-desk-9');
    const added = await api('POST', '/hospital-admin/clinicians/from-emr', { token: ha, body: { staffID: 'JUTH/0042' } });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.provider.name, 'Ngozi Eze');
    assert.equal(added.body.provider.providerID, 'JUTH/0042', 'the hospital\'s own staff ID is kept');
    assert.equal(added.body.account.login, 'juth-0042@juth');
    // Re-sync and password reset work with a "/" in the ID (URL-encoded).
    assert.equal((await api('POST', `/hospital-admin/clinicians/${encodeURIComponent('JUTH/0042')}/resync`, { token: ha })).status, 200);
    const reset = await api('POST', `/hospital-admin/clinicians/${encodeURIComponent('JUTH/0042')}/reset-password`, { token: ha });
    assert.equal(reset.status, 200);
    const doc = await login('juth-0042@juth', reset.body.temporaryPassword);
    assert.equal(doc.status, 200);

    // Patient: nothing in the roster, yet the hospital number + name links,
    // because the record is read from SmartClinic at lookup time.
    const p = await api('POST', '/auth/signup', { body: { fullName: 'Amina Yusuf', email: 'amina@example.com', password: 'kettle-blue-77' } });
    assert.equal(server.fhirAdapter.findLocalPatientRecord('juth', 'JUTH-12345'), null);
    const look = await api('POST', '/patients/register/lookup', { token: p.body.token, body: { hospitalID: 'juth', hospitalNumber: 'JUTH-12345', name: 'Amina Yusuf' } });
    assert.equal(look.status, 200, JSON.stringify(look.body));
    assert.equal(look.body.name, 'Amina Bello Yusuf');
    const wrong = await api('POST', '/patients/register/lookup', { token: p.body.token, body: { hospitalID: 'juth', hospitalNumber: 'JUTH-12345', name: 'Fatima Musa' } });
    assert.equal(wrong.status, 404);
  } finally {
    await server.close();
    f.server.close();
  }
});

test('staff search by staff ID or name: exact ID first, any word order for names', async () => {
  const f = await start();
  try {
    f.state.staff.push({ _id: 'a4', staff_id: 'JUTH/0420', fname: 'Ngozi', lname: 'Okafor', designation: 'Nurse', dept: { name: 'Paediatrics' }, status: 'active' });
    const h = hospitalFor(f.base);
    const byId = (await sc.searchStaff(h, 'JUTH/0042')).results;
    assert.equal(byId[0].name, 'Ngozi Eze', 'exact ID first');
    assert.deepEqual((await sc.searchStaff(h, 'eze ngozi')).results.map((r) => r.staffID), ['JUTH/0042'], 'words in any order');
    assert.deepEqual((await sc.searchStaff(h, 'ngozi')).results.map((r) => r.name), ['Ngozi Eze', 'Ngozi Okafor']);
    assert.deepEqual((await sc.searchStaff(h, 'nobody')).results, []);
  } finally {
    f.server.close();
  }
});

test('hospital admin searches the EMR by name, then adds the person picked', async () => {
  const f = await start();
  const server = await createTestServer({ authMode: 'password' });
  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${server.baseUrl}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const settle = async (acct, next) => {
    const t = await api('POST', '/auth/login', { body: { login: acct.login, password: acct.temporaryPassword } });
    return (await api('POST', '/auth/password', { token: t.body.token, body: { currentPassword: acct.temporaryPassword, newPassword: next } })).body.token;
  };
  try {
    const admin = await settle(await server.onboarding.bootstrapSystemAdmin(), 'Admin-pass-2026');
    const h = await api('POST', '/admin/hospitals', { token: admin, body: { hospitalID: 'juth', name: 'JUTH', integration: 'smartclinic', smartclinic: { baseUrl: f.base, username: 'cevruni', password: 'right-pass' } } });
    const ha = await settle(h.body.adminAccount, 'Records-desk-9');
    const found = await api('POST', '/hospital-admin/clinicians/emr-search', { token: ha, body: { query: 'Ngozi Eze' } });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.equal(found.body.results.length, 1);
    assert.deepEqual({ id: found.body.results[0].staffID, usable: found.body.results[0].usable, already: found.body.results[0].alreadyRegistered }, { id: 'JUTH/0042', usable: true, already: false });
    assert.equal((await api('POST', '/hospital-admin/clinicians/from-emr', { token: ha, body: { staffID: found.body.results[0].staffID } })).status, 201);
    const again = await api('POST', '/hospital-admin/clinicians/emr-search', { token: ha, body: { query: 'eze' } });
    assert.equal(again.body.results[0].alreadyRegistered, true);
    assert.equal((await api('POST', '/hospital-admin/clinicians/emr-search', { token: ha, body: { query: 'x' } })).status, 400);
  } finally {
    await server.close();
    f.server.close();
  }
});

test('JUTH-style staff list (no staff ID column): identified by record ID, found by name or email, email is the username', async () => {
  const f = await start();
  // As JUTH saves staff: S/N, First Name, Last Name, Sex, Email, Phone, Designation.
  f.state.staff = [
    { _id: '6650a1f0c2b7e9a1d4f00009', sn: 9, firstName: 'Test Doctor', lastName: 'John', sex: 'Male', email: 'doctor.test@hospital.example', phone: '96548752', designation: 'Doctor' },
    { _id: '6650a1f0c2b7e9a1d4f00010', sn: 10, firstName: 'Amaka', lastName: 'Obi', sex: 'Female', email: 'aobi@hospital.example', phone: '80000000', designation: 'Nurse' },
  ];
  const server = await createTestServer({ authMode: 'password' });
  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${server.baseUrl}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const settle = async (acct, next) => {
    const t = await api('POST', '/auth/login', { body: { login: acct.login, password: acct.temporaryPassword } });
    return (await api('POST', '/auth/password', { token: t.body.token, body: { currentPassword: acct.temporaryPassword, newPassword: next } })).body.token;
  };
  try {
    const sug = await sc.testConnection(hospitalFor(f.base), { staffID: '6650a1f0c2b7e9a1d4f00009' });
    assert.equal(sug.suggested.staffId, '_id');
    assert.equal(sug.suggested.staffEmail, 'email');
    assert.equal(sug.suggested.staffName, 'firstName + lastName');
    assert.equal(sug.suggested.staffRole, 'designation');

    const admin = await settle(await server.onboarding.bootstrapSystemAdmin(), 'Admin-pass-2026');
    const h = await api('POST', '/admin/hospitals', { token: admin, body: { hospitalID: 'juth', name: 'JUTH', integration: 'smartclinic', smartclinic: { baseUrl: f.base, username: 'cevruni', password: 'right-pass' } } });
    const ha = await settle(h.body.adminAccount, 'Records-desk-9');

    const byName = await api('POST', '/hospital-admin/clinicians/emr-search', { token: ha, body: { query: 'test doctor' } });
    assert.equal(byName.body.results.length, 1);
    assert.equal(byName.body.results[0].email, 'doctor.test@hospital.example');
    const byEmail = await api('POST', '/hospital-admin/clinicians/emr-search', { token: ha, body: { query: 'aobi@hospital.example' } });
    assert.equal(byEmail.body.results[0].name, 'Amaka Obi');

    const added = await api('POST', '/hospital-admin/clinicians/from-emr', { token: ha, body: { staffID: byName.body.results[0].staffID } });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.provider.name, 'Test Doctor John');
    assert.equal(added.body.provider.role, 'Doctor');
    assert.equal(added.body.provider.department, 'General');
    assert.equal(added.body.account.login, 'doctor.test@hospital.example', 'email is the username');

    // Nothing on-chain carries the email.
    const chain = JSON.stringify([...server.ledger.audit.values()]);
    assert.ok(!chain.includes('doctor.test'), 'no email on-chain');

    const doc = await api('POST', '/auth/login', { body: { login: 'Doctor.Test@hospital.example', password: added.body.account.temporaryPassword } });
    assert.equal(doc.status, 200);
    assert.equal(doc.body.mustChangePassword, true);

    // Removed from SmartClinic -> Re-sync deactivates; sign-in stops.
    f.state.staff = f.state.staff.filter((x) => x.email !== 'doctor.test@hospital.example');
    const sync = await api('POST', `/hospital-admin/clinicians/${byName.body.results[0].staffID}/resync`, { token: ha });
    assert.equal(sync.body.provider.status, 'INACTIVE');
  } finally {
    await server.close();
    f.server.close();
  }
});

test('JUTH-sized staff list: 3,111 staff in pages of 50; search and add work for someone far down the list', async () => {
  // Shaped like JUTH's real answer: { error, message, pagination: { count, page, limit }, result: [...] },
  // "status" is on-duty availability, not employment.
  const staff = Array.from({ length: 3111 }, (_, i) => ({
    _id: `6650a1f0c2b7e9a1d4f${String(i).padStart(5, '0')}`,
    fname: `First${i}`, lname: `Last${i}`, email: `staff${i}@hospital.example`, designation: i % 3 ? 'Nurse' : 'Doctor',
    department: '64bd487c90167d10a077fef8', specialization: 'Internal Medicine', clinic: 'GOPD', status: i % 2 ? 'available' : 'unavailable',
  }));
  staff[2999] = { ...staff[2999], fname: 'Test Doctor', lname: 'John', email: 'doctor.test@hospital.example', designation: 'Doctor' };
  let calls = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (b) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    if (req.method === 'POST') { req.resume(); return req.on('end', () => send({ token: 't' })); }
    calls += 1;
    const q = (u.searchParams.get('search') || '').toLowerCase();
    const page = Number(u.searchParams.get('page') || 1);
    const limit = Number(u.searchParams.get('limit') || 50);
    const hits = staff.filter((s) => !q || `${s.fname} ${s.lname}`.toLowerCase().includes(q) || s.email.includes(q));
    send({ error: false, message: 'ok', pagination: { count: hits.length, page, limit }, result: hits.slice((page - 1) * limit, page * limit) });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // Saved with the old default path (first page only): it is upgraded automatically.
  const h = hospitalFor(`http://127.0.0.1:${server.address().port}/v1/`, { staffSearchPath: 'staff/v2/staffs' });
  try {
    const byName = (await sc.searchStaff(h, 'test doctor')).results;
    assert.equal(byName.length, 1);
    assert.deepEqual({ name: byName[0].name, email: byName[0].email, role: byName[0].role, dept: byName[0].department, active: byName[0].active },
      { name: 'Test Doctor John', email: 'doctor.test@hospital.example', role: 'Doctor', dept: 'Internal Medicine', active: true }, 'department reference ID skipped');
    assert.equal((await sc.searchStaff(h, 'doctor.test@hospital.example')).results[0].name, 'Test Doctor John');
    assert.equal((await sc.searchStaff(h, 'john test')).results[0].name, 'Test Doctor John', 'words in any order');
    // A broad word: everyone SmartClinic matched is listed (first 50), with the total.
    const broad = await sc.searchStaff(h, 'first1');
    assert.equal(broad.results.length, 50);
    assert.ok(broad.total > 50);

    // Picked from the list: found in one search with the email hint.
    calls = 0;
    assert.equal((await sc.fetchStaff(h, byName[0].staffID, { hints: ['doctor.test@hospital.example'] })).name, 'Test Doctor John');
    assert.ok(calls <= 2, `found quickly (${calls} calls)`);
    // No hint (e.g. old record): read page by page until found.
    calls = 0;
    assert.equal((await sc.fetchStaff(h, byName[0].staffID)).email, 'doctor.test@hospital.example');
    assert.ok(calls <= 8, `paged through (${calls} calls)`);
    await assert.rejects(sc.fetchStaff(h, '000000000000000000000000'), /no staff member/);
  } finally {
    server.close();
  }
});
