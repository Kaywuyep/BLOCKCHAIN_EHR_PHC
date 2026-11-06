'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');
const { adtA01Admit, adtA03Discharge, notHl7AtAll, oruResultNotAdt } = require('../services/hl7AdtListener.fixtures');

test('POST /api/hl7/adt/:hospitalID ingests a synthetic A01 admit and it shows up via the existing local-records route', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/hl7/adt/hospital-a`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: adtA01Admit,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.hospitalNumber, 'LAG-00231');
    assert.equal(body.encounterRecorded, true);

    // The convergence point the task asked for: the same
    // GET /local-records/:hospitalID route the Admin Dashboard's roster
    // panel and the REST/DB path both use sees the HL7-ingested patient,
    // with no idea it arrived over HL7 rather than a form submission.
    const rosterRes = await fetch(`${server.baseUrl}/api/patients/local-records/hospital-a`);
    const roster = await rosterRes.json();
    assert.equal(roster.length, 1);
    assert.equal(roster[0].hospitalNumber, 'LAG-00231');
    assert.equal(roster[0].name, 'ADAEZE N OKAFOR');
  } finally {
    await server.close();
  }
});

test('POST /api/hl7/adt/:hospitalID: the HL7-ingested encounter becomes visible through GET /records/resolve once the patient links a DID, exactly like a REST/DB-ingested one would', async () => {
  const server = await createTestServer();
  try {
    await fetch(`${server.baseUrl}/api/hl7/adt/hospital-a`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: adtA01Admit,
    });

    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });
    server.fhirAdapter.registerLocalPatient('hospital-a', 'did:patientchain:p1', 'LAG-00231');
    server.providerRegistry.register({ providerID: 'dr-x', hospitalID: 'hospital-a', status: 'ACTIVE' });
    server.ledger.requestAccess({ grantID: 'g1', patientDID: 'did:patientchain:p1', providerID: 'dr-x', hospitalID: 'hospital-a' });
    server.ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 });

    const resolveRes = await fetch(`${server.baseUrl}/api/records/resolve?grantID=g1&hospitalID=hospital-a`);
    assert.equal(resolveRes.status, 200);
    const resolved = await resolveRes.json();
    assert.equal(resolved.bundles.length, 1);
    assert.equal(resolved.bundles[0].entry[0].resource.resourceType, 'Encounter');
  } finally {
    await server.close();
  }
});

test('POST /api/hl7/adt/:hospitalID rejects unparseable HL7 with a 400 and a reason, not a 500', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/hl7/adt/hospital-a`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: notHl7AtAll,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.reason, /unparseable/);
  } finally {
    await server.close();
  }
});

test('POST /api/hl7/adt/:hospitalID rejects a well-formed non-ADT message (e.g. an ORU result) with a 400', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/hl7/adt/hospital-a`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: oruResultNotAdt,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally {
    await server.close();
  }
});

test('POST /api/hl7/adt/:hospitalID rejects an empty body with a 400', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/hl7/adt/hospital-a`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '',
    });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

test('POST /api/hl7/adt/:hospitalID keeps hospitals isolated: an admit at hospital-a never appears in hospital-b\'s roster', async () => {
  const server = await createTestServer();
  try {
    await fetch(`${server.baseUrl}/api/hl7/adt/hospital-a`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: adtA01Admit,
    });
    const otherHospitalRoster = await (await fetch(`${server.baseUrl}/api/patients/local-records/hospital-b`)).json();
    assert.deepEqual(otherHospitalRoster, []);
  } finally {
    await server.close();
  }
});

test('a repeat ADT event for the same patient (e.g. A01 then A03 discharge) appends a second encounter rather than replacing the first', async () => {
  const server = await createTestServer();
  try {
    await fetch(`${server.baseUrl}/api/hl7/adt/hospital-a`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: adtA01Admit,
    });
    await fetch(`${server.baseUrl}/api/hl7/adt/hospital-a`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: adtA03Discharge,
    });

    server.ledger.registerPatient({ patientDID: 'did:patientchain:p1', publicKey: 'pk1' });
    server.fhirAdapter.registerLocalPatient('hospital-a', 'did:patientchain:p1', 'LAG-00231');
    const { bundles } = server.fhirAdapter.resolveRecord('hospital-a', 'did:patientchain:p1');
    assert.equal(bundles.length, 2);
    assert.equal(bundles[0].entry[0].resource.status, 'in-progress');
    assert.equal(bundles[1].entry[0].resource.status, 'finished');
  } finally {
    await server.close();
  }
});
