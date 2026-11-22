'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');

// GET /api/records/resolve is Figure 3 steps 4-6 / Figure 4 in full: an
// on-chain grant is necessary but never sufficient (Section 29, "never
// trust the frontend") -- it must also clear hospital-level RBAC
// (Section 16/35.1), purpose-of-use (Section 35.1) and scope (Section 8)
// before the FHIR Adapter is ever asked to resolve a record. Each test
// isolates one of those layers.

function setUpActiveGrant(server, overrides = {}) {
  server.ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
  server.fhirAdapter.registerLocalPatient('HospitalA-Lagos', 'did:p1', 'LAG-00231');
  server.fhirAdapter.createClinicalRecord('HospitalA-Lagos', 'did:p1', {
    recordType: 'lab',
    fhirFields: { code: { text: 'Full Blood Count' } },
  });
  server.providerRegistry.register({ providerID: 'dr-adeyemi', hospitalID: 'HospitalA-Lagos', status: 'ACTIVE' });

  server.ledger.requestAccess({
    grantID: 'g1',
    patientDID: 'did:p1',
    providerID: 'dr-adeyemi',
    hospitalID: 'HospitalA-Lagos',
    ...overrides,
  });
  return server.ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 });
}

test('GET /api/records/resolve requires grantID and hospitalID', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/records/resolve`);
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

test('a valid, active, RBAC-authorized grant resolves the FHIR bundle and writes a RECORD_ACCESSED audit entry', async () => {
  const server = await createTestServer();
  try {
    setUpActiveGrant(server);

    const res = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=HospitalA-Lagos`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bundles.length, 1);
    assert.equal(body.resolution.localMrn, 'LAG-00231');

    const audit = server.ledger.getAuditTrailForPatient('did:p1');
    assert.ok(audit.some((e) => e.eventType === 'RECORD_ACCESSED'));
  } finally {
    await server.close();
  }
});

test('a grant that is not ACTIVE (still PENDING) is refused with 403', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
    server.providerRegistry.register({ providerID: 'dr-adeyemi', hospitalID: 'HospitalA-Lagos', status: 'ACTIVE' });
    server.ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'dr-adeyemi', hospitalID: 'HospitalA-Lagos' });
    // Deliberately never granted -- still PENDING.

    const res = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=HospitalA-Lagos`);
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

test('a grant scoped to a different hospital is refused, even if it is ACTIVE', async () => {
  const server = await createTestServer();
  try {
    setUpActiveGrant(server);

    const res = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=HospitalB-Ibadan`);
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

test('a valid on-chain grant is still refused if the provider is not active staff at that hospital (Level-2 RBAC)', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
    server.fhirAdapter.registerLocalPatient('HospitalA-Lagos', 'did:p1', 'LAG-00231');
    // Deliberately not registering dr-adeyemi in providerRegistry --
    // the on-chain grant alone must not be sufficient (Section 29).
    server.ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'dr-adeyemi', hospitalID: 'HospitalA-Lagos' });
    server.ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 });

    const res = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=HospitalA-Lagos`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /hospital RBAC/);
  } finally {
    await server.close();
  }
});

test('a suspended provider fails Level-2 RBAC even though they were once registered', async () => {
  const server = await createTestServer();
  try {
    server.ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
    server.fhirAdapter.registerLocalPatient('HospitalA-Lagos', 'did:p1', 'LAG-00231');
    server.providerRegistry.register({ providerID: 'dr-adeyemi', hospitalID: 'HospitalA-Lagos', status: 'SUSPENDED' });
    server.ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'dr-adeyemi', hospitalID: 'HospitalA-Lagos' });
    server.ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 });

    const res = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=HospitalA-Lagos`);
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

test('a declared purpose that mismatches the grant\'s purpose is refused', async () => {
  const server = await createTestServer();
  try {
    setUpActiveGrant(server, { purpose: 'Treatment' });

    const res = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=HospitalA-Lagos&purpose=Research`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /purpose-of-use mismatch/);
  } finally {
    await server.close();
  }
});

test('a matching declared purpose is allowed through', async () => {
  const server = await createTestServer();
  try {
    setUpActiveGrant(server, { purpose: 'Treatment' });

    const res = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=HospitalA-Lagos&purpose=Treatment`);
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

test('a resourceType request outside the grant\'s recorded scope is refused', async () => {
  const server = await createTestServer();
  try {
    setUpActiveGrant(server, { scope: ['Observation'] });

    const res = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=HospitalA-Lagos&resourceTypes=MedicationRequest`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /outside the granted scope/);
  } finally {
    await server.close();
  }
});

test('a resourceType request inside the grant\'s recorded scope is allowed', async () => {
  const server = await createTestServer();
  try {
    setUpActiveGrant(server, { scope: ['Observation', 'MedicationRequest'] });

    const res = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=HospitalA-Lagos&resourceTypes=Observation`);
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

// Hospitals whose own API Cevruni reads (custom API / SmartClinic): records
// are read live at view time and never stored (user decision, 2026-11-18).
test('a custom-API hospital is read live at view time and nothing is stored in Cevruni', async () => {
  const http = require('node:http');
  const { RECORD_PRESETS } = require('../services/emrRecords');
  const emr = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (j) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.method === 'POST') return send({ data: 'token-1234567890' });
    if (u.pathname === '/api/patients/get') return send({ data: { docs: [{ id: 223, hospital_id: 'PSSH/000223', fullname: 'Test Patient' }] } });
    if (u.pathname === '/api/visits/all/get') return send({ data: { docs: [{ id: 274, patient_id: 223, department: 'O&G', date_visit_start: '2026-11-03T11:05:45Z' }] } });
    if (u.pathname === '/api/visits/prescriptions/274') return send({ data: { tests: [], drugs: [{ id: 1, patient_id: 223, drug: { name: 'Paracetamol' } }, { id: 2, patient_id: 999, drug: { name: 'Not this patient' } }], investigations: [] } });
    if (u.pathname === '/api/consultations/diagnoses/get/274') return send({ data: { diagnoses: [] } });
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => emr.listen(0, '127.0.0.1', r));
  const server = await createTestServer();
  try {
    server.hospitalRegistry.create({
      hospitalID: 'pssh-test', name: 'PSSH Test', location: 'Jos', type: 'Specialist Hospital', integration: 'rest',
      customApi: {
        baseUrl: `http://127.0.0.1:${emr.address().port}/api/`, username: 'u', password: 'secret123',
        patientSearchPath: 'patients/get?search={hospitalNumber}', recordSources: RECORD_PRESETS.pssh.sources, fieldMap: { patientId: 'id' },
      },
    });
    server.ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
    server.fhirAdapter.registerLocalPatient('pssh-test', 'did:p1', 'PSSH/000223');
    server.providerRegistry.register({ providerID: 'dr-adeyemi', hospitalID: 'pssh-test', status: 'ACTIVE' });
    server.ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'dr-adeyemi', hospitalID: 'pssh-test' });
    server.ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 });

    const res = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=pssh-test`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const resources = body.bundles.flatMap((b) => b.entry.map((e) => e.resource));
    assert.deepEqual(resources.filter((r) => r.resourceType === 'MedicationRequest').map((r) => r.medicationCodeableConcept.text), ['Paracetamol']);
    assert.equal(body.liveSource.ok, true);
    assert.equal(body.liveSource.kind, 'emr');
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM clinical_bundles').get().n, 0);
    const audit = server.ledger.getAuditTrailForPatient('did:p1');
    assert.ok(audit.some((e) => e.eventType === 'RECORD_ACCESSED' && /live hospital API ok/.test(e.detail)));
  } finally {
    await server.close();
    emr.close();
  }
});
