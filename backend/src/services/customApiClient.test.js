'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const customApi = require('./customApiClient');
const { HospitalRegistry, ValidationError } = require('./hospitalRegistry');

// A mock of a custom-built hospital API shaped like PSSH's:
// POST /api/auth/login {username,password} -> { data: "<jwt>" }; other calls
// need Authorization: Bearer <jwt>.
function mockServer() {
  let logins = 0;
  let token = 'tok-aaaaaaaaaa';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      const u = new URL(req.url, 'http://x');
      if (req.method === 'POST' && u.pathname === '/api/auth/login') {
        const b = JSON.parse(body || '{}');
        if (b.username !== 'cevruni' || b.password !== 'secret123') return send(401, { status: 'error', message: 'Invalid credentials' });
        logins += 1;
        return send(200, { status: 'success', data: token });
      }
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Access denied, No token provided' });
      const q = u.searchParams.get('search') || '';
      if (u.pathname === '/api/patients/get') {
        const rows = [
          { _id: 'p1', hospital_no: 'PSSH/001', firstname: 'Amina', lastname: 'Yusuf', dob: '1995-03-15T00:00:00Z' },
          { _id: 'p2', hospital_no: 'PSSH/0012', firstname: 'John', lastname: 'Dung', dob: null },
        ].filter((r) => r.hospital_no.includes(q));
        return send(200, { status: 'success', data: { docs: rows, total: rows.length } });
      }
      if (u.pathname === '/api/staffs/get') {
        const rows = [
          { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', staff_id: 'S-10', firstname: 'Grace', lastname: 'Pam', email: 'Grace@pssh.ng', designation: 'Doctor', is_active: true },
          { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', staff_id: 'S-11', firstname: 'Ali', lastname: 'Musa', email: 'ali@pssh.ng', designation: 'Nurse', is_active: false },
        ].filter((r) => !q || `${r.staff_id} ${r.firstname} ${r.lastname} ${r.email}`.toLowerCase().includes(q.toLowerCase()));
        return send(200, { status: 'success', data: rows });
      }
      return send(404, { status: 'error', message: 'Resource does not exist' });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}/api/`,
        logins: () => logins,
        rotate: () => (token = `tok-${Date.now()}bbbb`),
      })
    )
  );
}

function hospitalFor(base, extra = {}) {
  return {
    hospitalID: `pssh-${Math.random()}`,
    integration: 'rest',
    _emrSecret: 'secret123',
    customApi: {
      baseUrl: base,
      username: 'cevruni',
      loginPath: 'auth/login',
      loginBody: '{"username":"{username}","password":"{password}"}',
      tokenIn: 'bearer',
      patientSearchPath: 'patients/get?search={hospitalNumber}&currentPage=1&pageLimit=50',
      staffSearchPath: 'staffs/get?search={query}&currentPage=1&pageLimit=50',
      fieldMap: {},
      ...extra,
    },
  };
}

test('custom API: signs in, finds one patient by exact hospital number, joins names', async (t) => {
  const m = await mockServer();
  t.after(() => m.server.close());
  const h = hospitalFor(m.base);
  assert.deepEqual(await customApi.findPatient(h, 'PSSH/001'), { hospitalNumber: 'PSSH/001', name: 'Amina Yusuf', dob: '1995-03-15' });
  assert.equal(await customApi.findPatient(h, 'PSSH/00'), null); // partial matches are not a match
  assert.equal(m.logins(), 1); // token cached
});

test('custom API: staff search, exact fetch by ID, inactive staff', async (t) => {
  const m = await mockServer();
  t.after(() => m.server.close());
  const h = hospitalFor(m.base, { fieldMap: { staffId: 'staff_id' } });
  const { results } = await customApi.searchStaff(h, 'grace');
  assert.equal(results[0].name, 'Grace Pam');
  assert.equal(results[0].email, 'grace@pssh.ng');
  assert.equal(results[0].role, 'Doctor');
  const ali = await customApi.fetchStaff(h, 'S-11');
  assert.equal(ali.active, false);
  await assert.rejects(customApi.fetchStaff(h, 'S-99'), /no staff member/);
});

test('custom API: signs in again once when the token is rejected', async (t) => {
  const m = await mockServer();
  t.after(() => m.server.close());
  const h = hospitalFor(m.base);
  await customApi.findPatient(h, 'PSSH/001');
  m.rotate();
  assert.ok(await customApi.findPatient(h, 'PSSH/001'));
  assert.equal(m.logins(), 2);
});

test('custom API: wrong password is reported from the API message', async (t) => {
  const m = await mockServer();
  t.after(() => m.server.close());
  const h = { ...hospitalFor(m.base), _emrSecret: 'wrongpass' };
  const out = await customApi.testConnection(h, { hospitalNumber: 'PSSH/001' });
  assert.equal(out.ok, false);
  assert.match(out.steps[0].detail, /refused the sign-in \(HTTP 401: Invalid credentials\)/);
});

test('custom API: testConnection suggests a field map and shows samples', async (t) => {
  const m = await mockServer();
  t.after(() => m.server.close());
  const out = await customApi.testConnection(hospitalFor(m.base), { hospitalNumber: 'PSSH/001', staffID: 'Grace' });
  assert.equal(out.ok, true, JSON.stringify(out.steps));
  assert.equal(out.suggested.patientHospitalNumber, 'hospital_no');
  assert.equal(out.suggested.patientName, 'firstname + lastname');
  assert.equal(out.samples.patient.listPath, 'data.docs');
});

test('custom API: login body template fills values without building JSON by hand', () => {
  const body = customApi.fillTemplate({ data: { email: '{username}', pass: '{password}' } }, { username: 'a"b', password: 'p}{' });
  assert.deepEqual(body, { data: { email: 'a"b', pass: 'p}{' } });
  assert.equal(customApi.findToken({ data: 'abcdefghij' }), 'abcdefghij');
  assert.equal(customApi.findToken({ result: { jwt: 'x' } }, 'result.jwt'), 'x');
});

test('registry: custom API settings are validated, stored encrypted and kept on edit', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE hospitals (hospital_id TEXT PRIMARY KEY, name TEXT, location TEXT, type TEXT, integration TEXT,
    fhir_json TEXT, fhir_secret_enc TEXT, hl7_json TEXT, emr_json TEXT, emr_secret_enc TEXT, status TEXT,
    created_at TEXT, updated_at TEXT, created_by TEXT)`);
  const cipher = { encrypt: (s) => `enc:${s}`, decrypt: (s) => s.slice(4) };
  const reg = new HospitalRegistry({ db, cipher });
  const base = { name: 'Plateau Specialist', location: 'Jos', type: 'Specialist Hospital', integration: 'rest' };
  const api = { baseUrl: 'http://192.168.88.15/api', username: 'cevruni', password: 'secret123', patientSearchPath: 'patients/get?search={hospitalNumber}' };

  assert.throws(() => reg.create({ ...base, customApi: { ...api, patientSearchPath: 'patients/get' } }), ValidationError);
  assert.throws(() => reg.create({ ...base, customApi: { ...api, loginBody: '{bad' } }), /valid JSON/);

  const h = reg.create({ ...base, customApi: api });
  assert.equal(h.customApi.baseUrl, 'http://192.168.88.15/api/');
  assert.equal(h.customApi.hasPassword, true);
  assert.equal(h.customApi.password, undefined);
  assert.equal(h.smartclinic, null);
  assert.equal(reg.getInternal(h.hospitalID)._emrSecret, 'secret123');

  reg.update(h.hospitalID, { customApi: { ...api, password: '', staffSearchPath: 'staffs/get?search={query}' } });
  assert.equal(reg.getInternal(h.hospitalID)._emrSecret, 'secret123');
  assert.equal(reg.get(h.hospitalID).customApi.staffSearchPath, 'staffs/get?search={query}');

  // Push-only (no API address) still works.
  const push = reg.create({ ...base, name: 'Push Only Clinic', customApi: null });
  assert.equal(push.customApi, null);
});
