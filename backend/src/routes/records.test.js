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
