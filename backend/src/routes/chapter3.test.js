'use strict';

// Tests for the Chapter 3 requirements added in the November 2026 upgrade:
// record-type scope (FR4), provider-role restriction (FR4/3.4.7), patient-
// signed grants (3.4.1), batched approvals (3.4.4), event-driven updates
// (3.4.4), DID-after-linkage (FR1), point-of-care pointers (FR3), the
// custom REST ingestion path and live FHIR pull (3.4.8), 72-hour offline
// replay (NFR3) and the hospital admin view (NFR9).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createTestServer } = require('../testutil/testServer');
const fixtures = require('../services/hl7AdtListener.fixtures');

const H = 'hospital-a'; // the clinician's hospital
const HB = 'hospital-b'; // the hospital holding the records

function api(server, token) {
  const call = (method) => async (path, body) => {
    const res = await fetch(`${server.baseUrl}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };
  return { get: call('GET'), post: call('POST') };
}

function patientKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    sign: (msg) => crypto.sign('sha256', Buffer.from(msg), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'),
  };
}

/** Patient with a key pair and records at hospital-a; clinician dr-a (Physician). */
async function setup({ withKey = true } = {}) {
  const server = await createTestServer({ authMode: 'local' });
  const admin = api(server, await server.login({ subject: 'admin-a', role: 'hospital_admin', hospitalID: H }));
  await admin.post('/providers/register', { providerID: 'dr-a', hospitalID: H, name: 'Dr A', role: 'Physician' });
  const keys = patientKeys();
  let ptoken = await server.login({ subject: 'amina', role: 'patient' });
  const reg = await server.registerPatient(ptoken, { hospitalID: H, hospitalNumber: 'A-1', name: 'Amina Yusuf', dob: '1995-03-15', body: withKey ? { publicKey: keys.publicKey } : {} });
  const did = (await reg.json()).patient.patientDID;
  ptoken = await server.login({ subject: 'amina', role: 'patient' });
  const patient = api(server, ptoken);
  const dr = api(server, await server.login({ subject: 'dr-a', role: 'clinician', hospitalID: H }));
  // Hospital B is also in the patient's network, and holds one lab result
  // and one psychiatric diagnosis.
  server.fhirAdapter.addLocalPatientRecord(HB, 'B-1', { name: 'Amina Yusuf', dob: '1995-03-15' });
  server.fhirAdapter.registerLocalPatient(HB, did, 'B-1');
  server.fhirAdapter.recordResourceByHospitalNumber(HB, 'B-1', { resourceType: 'Observation', id: 'obs-1', status: 'final', code: { text: 'FBC' } });
  server.fhirAdapter.recordResourceByHospitalNumber(HB, 'B-1', { resourceType: 'Condition', id: 'cond-1', code: { text: 'Depression' } });
  return { server, admin, patient, dr, did, keys };
}

async function requestAndGrant(w, { scope, signed = true } = {}) {
  const req = await w.dr.post('/access/request', { patientDID: w.did, providerID: 'dr-a', hospitalID: HB, scope, purpose: 'Treatment' });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  const grantID = req.body.grantID;
  const g = await w.patient.post(`/access/${grantID}/grant`, { durationMinutes: 30, signature: signed ? w.keys.sign(`grant:${grantID}:30`) : undefined });
  return { grantID, grantRes: g };
}

test('FR1: a patient cannot create a Health ID before confirming a record at their first hospital', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    const p = api(server, await server.login({ subject: 'new', role: 'patient' }));
    assert.equal((await p.post('/patients/register', {})).status, 400);
    server.fhirAdapter.addLocalPatientRecord(H, 'N-1', { name: 'New Person', dob: '2000-02-02' });
    assert.equal((await p.post('/patients/register/lookup', { hospitalID: H, hospitalNumber: 'N-1', dateOfBirth: '1999-01-01' })).status, 404);
    // Skipping the lookup is refused.
    assert.equal((await p.post('/patients/register', { firstFacility: { hospitalID: H, hospitalNumber: 'N-1' } })).status, 400);
    const look = await p.post('/patients/register/lookup', { hospitalID: H, hospitalNumber: 'N-1', dateOfBirth: '2000-02-02' });
    assert.equal(look.body.name, 'New Person');
    const reg = await p.post('/patients/register', { firstFacility: { hospitalID: H, hospitalNumber: 'N-1' } });
    assert.equal(reg.status, 201);
    assert.equal(server.fhirAdapter.findDidByHospitalNumber(H, 'N-1'), reg.body.patient.patientDID);
  } finally {
    await server.close();
  }
});

test('FR4: the gateway returns only the record types the grant covers', async () => {
  const w = await setup();
  try {
    const { grantID } = await requestAndGrant(w, { scope: ['Observation'] });
    const r = await w.dr.get(`/records/resolve?grantID=${grantID}&hospitalID=${HB}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const types = r.body.bundles.flatMap((b) => b.entry.map((e) => e.resource.resourceType));
    assert.ok(types.includes('Observation'));
    assert.ok(!types.includes('Condition'), 'psychiatric diagnosis must be withheld from a lab-only grant');
    assert.equal(r.body.withheld, 1);
  } finally {
    await w.server.close();
  }
});

test('FR4 / 3.4.7: a grant is bound to the provider role; a role change blocks it', async () => {
  const w = await setup();
  try {
    const { grantID } = await requestAndGrant(w);
    const grant = (await w.patient.get(`/access/${grantID}`)).body;
    assert.equal(grant.providerRole, 'Physician');
    assert.equal((await w.dr.get(`/records/resolve?grantID=${grantID}&hospitalID=${HB}`)).status, 200);
    await w.admin.post('/providers/register', { providerID: 'dr-a', hospitalID: H, name: 'Dr A', role: 'Laboratory Scientist' });
    const r = await w.dr.get(`/records/resolve?grantID=${grantID}&hospitalID=${HB}`);
    assert.equal(r.status, 403);
    assert.match(r.body.error, /role restriction/);
  } finally {
    await w.server.close();
  }
});

test('3.4.1: a patient with a key must sign approvals and revocations', async () => {
  const w = await setup();
  try {
    const { grantID, grantRes } = await requestAndGrant(w, { signed: false });
    assert.equal(grantRes.status, 400);
    assert.match(grantRes.body.error, /signed/);
    const forged = await w.patient.post(`/access/${grantID}/grant`, { durationMinutes: 30, signature: w.keys.sign(`grant:${grantID}:9999`) });
    assert.equal(forged.status, 400);
    const ok = await w.patient.post(`/access/${grantID}/grant`, { durationMinutes: 30, signature: w.keys.sign(`grant:${grantID}:30`) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.patientSigned, true);
    assert.equal((await w.patient.post(`/access/${grantID}/revoke`, {})).status, 400);
    const rv = await w.patient.post(`/access/${grantID}/revoke`, { signature: w.keys.sign(`revoke:${grantID}`) });
    assert.equal(rv.status, 200);
    assert.equal(rv.body.revokeSigned, true);
  } finally {
    await w.server.close();
  }
});

test('3.4.4: several approvals go to the ledger as one transaction', async () => {
  const w = await setup();
  try {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await w.dr.post('/access/request', { patientDID: w.did, providerID: 'dr-a', hospitalID: HB })).body.grantID);
    }
    const before = w.server.ledger.getCounters().grant;
    const items = ids.map((grantID) => ({ grantID, durationMinutes: 15, signature: w.keys.sign(`grant:${grantID}:15`) }));
    const res = await w.patient.post('/access/batch-grant', { items });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.transactions, 1);
    assert.ok(res.body.grants.every((g) => g.status === 'ACTIVE'));
    assert.equal(w.server.ledger.getCounters().grant - before, 1, 'one ledger transaction for the whole batch');
    // All-or-nothing: one bad signature rejects the batch.
    const more = [];
    for (let i = 0; i < 2; i += 1) more.push((await w.dr.post('/access/request', { patientDID: w.did, providerID: 'dr-a', hospitalID: HB })).body.grantID);
    const bad = await w.patient.post('/access/batch-grant', {
      items: [
        { grantID: more[0], durationMinutes: 15, signature: w.keys.sign(`grant:${more[0]}:15`) },
        { grantID: more[1], durationMinutes: 15, signature: 'AAAA' },
      ],
    });
    assert.equal(bad.status, 400);
    assert.equal((await w.patient.get(`/access/${more[0]}`)).body.status, 'PENDING');
  } finally {
    await w.server.close();
  }
});

test('3.4.4: ledger events are pushed to the patient over SSE, not polled', async () => {
  const w = await setup();
  const ptoken = await w.server.login({ subject: 'amina', role: 'patient' });
  const controller = new AbortController();
  try {
    const res = await fetch(`${w.server.baseUrl}/api/events/stream`, { headers: { authorization: `Bearer ${ptoken}` }, signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    await w.dr.post('/access/request', { patientDID: w.did, providerID: 'dr-a', hospitalID: HB });
    let text = '';
    const deadline = Date.now() + 3000;
    while (!text.includes('AccessRequested') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
    }
    assert.match(text, /"type":"AccessRequested"/);
  } finally {
    controller.abort();
    await w.server.close();
  }
});

test('FR3: records arriving by HL7 for a linked patient get an on-chain pointer at the point of care', async () => {
  const w = await setup();
  try {
    // The fixture admits LAG-00231; link that number to a new patient first.
    const t = await w.server.login({ subject: 'okafor', role: 'patient' });
    await w.server.registerPatient(t, { hospitalID: H, hospitalNumber: 'LAG-00231', name: 'Adaeze Okafor', dob: '1990-04-12' });
    const did = w.server.fhirAdapter.findDidByHospitalNumber(H, 'LAG-00231');
    const before = w.server.ledger.getRecordReferencesForPatient(did).length;
    const atok = await w.server.login({ subject: 'admin-a', role: 'hospital_admin', hospitalID: H });
    const res = await fetch(`${w.server.baseUrl}/api/hl7/adt/${H}`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${atok}` }, body: fixtures.adtA01Admit });
    assert.ok(res.status < 300);
    await new Promise((r) => setTimeout(r, 50));
    const refs = w.server.ledger.getRecordReferencesForPatient(did);
    assert.equal(refs.length, before + 1);
    assert.equal(refs.at(-1).recordType, 'Encounter');
    // Linking registers pointers for records the hospital already held.
    assert.ok(w.server.ledger.getRecordReferencesForPatient(w.did).length >= 2);
  } finally {
    await w.server.close();
  }
});

test('3.4.8: custom REST ingestion validates FHIR R4 and needs the REST connection', async () => {
  const server = await createTestServer();
  try {
    const sys = api(server);
    await sys.post('/admin/hospitals', { hospitalID: 'rest-clinic', name: 'REST Clinic', integration: 'rest' });
    const bad = await sys.post('/ingest/rest-clinic', { hospitalNumber: 'R-1', patient: { name: 'X Y', dob: '2001-01-01' }, resources: [{ resourceType: 'Observation' }] });
    assert.equal(bad.status, 422);
    const ok = await sys.post('/ingest/rest-clinic', {
      hospitalNumber: 'R-1',
      patient: { name: 'X Y', dob: '2001-01-01' },
      resources: [
        { resourceType: 'DiagnosticReport', status: 'final', code: { text: 'Malaria RDT' } },
        { resourceType: 'DocumentReference', status: 'current', content: [{ attachment: { contentType: 'text/plain', data: 'aGk=' } }] },
        { resourceType: 'Practitioner', name: [{ text: 'Dr Z' }] },
      ],
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.stored.length, 2);
    assert.equal(server.fhirAdapter.findLocalPatientRecord('rest-clinic', 'R-1').name, 'X Y');
    // A hospital set up for HL7 cannot use this path.
    assert.equal((await sys.post(`/ingest/general-hospital-langtang`, { hospitalNumber: 'x', resources: [{ resourceType: 'Condition', code: { text: 'x' } }] })).status, 403);
  } finally {
    await server.close();
  }
});

test('3.4.8: FHIR-connected hospitals are queried live, only for granted types', async () => {
  const seen = [];
  const fhirServer = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/fhir+json');
    if (req.url.startsWith('/token')) return res.end(JSON.stringify({ access_token: 't', expires_in: 300 }));
    if (req.url.startsWith('/fhir/Patient')) return res.end(JSON.stringify({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: 'p9' } }] }));
    if (req.url.startsWith('/fhir/Observation')) {
      return res.end(JSON.stringify({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation', id: 'live-1', status: 'final', code: { text: 'Hb' }, subject: { reference: 'Patient/p9' } } }] }));
    }
    res.end(JSON.stringify({ resourceType: 'Bundle', entry: [] }));
  });
  await new Promise((r) => fhirServer.listen(0, r));
  const port = fhirServer.address().port;
  const w = await setup();
  try {
    const sys = api(w.server, await w.server.login({ subject: 'root', role: 'system_admin' }));
    await sys.post('/admin/hospitals', {
      hospitalID: 'fhir-hosp',
      name: 'FHIR Hospital',
      integration: 'fhir',
      fhir: { baseUrl: `http://127.0.0.1:${port}/fhir`, tokenUrl: `http://127.0.0.1:${port}/token`, clientId: 'c', clientSecret: 's', mrnIdentifierSystem: 'urn:mrn' },
    });
    w.server.fhirAdapter.addLocalPatientRecord('fhir-hosp', 'F-1', { name: 'Amina Yusuf', dob: '1995-03-15' });
    w.server.fhirAdapter.registerLocalPatient('fhir-hosp', w.did, 'F-1');
    const req = await w.dr.post('/access/request', { patientDID: w.did, providerID: 'dr-a', hospitalID: 'fhir-hosp', scope: ['Observation'] });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    const gid = req.body.grantID;
    await w.patient.post(`/access/${gid}/grant`, { durationMinutes: 30, signature: w.keys.sign(`grant:${gid}:30`) });
    const r = await w.dr.get(`/records/resolve?grantID=${gid}&hospitalID=fhir-hosp`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.liveSource.ok, true);
    const ids = r.body.bundles.flatMap((b) => b.entry.map((e) => e.resource.id));
    assert.ok(ids.includes('live-1'));
    assert.ok(seen.some((u) => u.includes('identifier=urn%3Amrn%7CF-1')));
    assert.ok(!seen.some((u) => u.startsWith('/fhir/Condition')), 'types outside the grant are never requested');
  } finally {
    await w.server.close();
    fhirServer.close();
  }
});

test('NFR3: an approval queued 72 hours ago replays in order, with its original time', async () => {
  const w = await setup();
  try {
    const sys = api(w.server, await w.server.login({ subject: 'root', role: 'system_admin' }));
    const ids = [];
    for (let i = 0; i < 2; i += 1) ids.push((await w.dr.post('/access/request', { patientDID: w.did, providerID: 'dr-a', hospitalID: HB })).body.grantID);
    await sys.post('/sync/connectivity', { connected: false });
    for (const id of ids) {
      const q = await w.patient.post(`/access/${id}/grant`, { durationMinutes: 30, signature: w.keys.sign(`grant:${id}:30`) });
      assert.equal(q.status, 202);
    }
    // Age the queue by 72 hours.
    const old = new Date(Date.now() - 72 * 3600 * 1000);
    w.server.offlineQueue.db.prepare('UPDATE queue SET created_at = ?, client_timestamp = ?').run(old.toISOString(), old.toISOString());
    const r = await sys.post('/sync/connectivity', { connected: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.reconciled.every((x) => x.status === 'SYNCED'), JSON.stringify(r.body.reconciled));
    for (const id of ids) assert.equal((await w.patient.get(`/access/${id}`)).body.status, 'ACTIVE');
    assert.equal(w.server.offlineQueue.getQueued().length, 0);
  } finally {
    await w.server.close();
  }
});

test('NFR9: both hospitals see who accessed which patient; break-glass needs both in the network', async () => {
  const w = await setup();
  try {
    const { grantID } = await requestAndGrant(w);
    await w.dr.get(`/records/resolve?grantID=${grantID}&hospitalID=${HB}`);
    // Emergency: Dr A at hospital-a uses the patient's hospital-b number.
    const bg = await w.dr.post('/access/break-glass', {
      hospitalID: HB, hospitalNumber: 'B-1', justification: 'unresponsive in A&E',
      representative: { name: 'Musa Yusuf', relationship: 'Husband', phone: '+234 803 000 0000' },
    });
    assert.equal(bg.status, 201, JSON.stringify(bg.body));
    assert.equal(bg.body.patientName, 'Amina Yusuf');
    assert.deepEqual(bg.body.scope, ['AllergyIntolerance', 'MedicationRequest', 'Condition', 'Encounter', 'Observation']);
    assert.equal(new Date(bg.body.expiresAt) - new Date(bg.body.grantedAt), 3600 * 1000);

    // Requesting hospital (A): its clinician's activity.
    const logA = (await w.admin.get('/hospital-admin/access-log')).body;
    assert.ok(logA.length >= 2);
    const access = logA.find((e) => e.eventType === 'RECORD_ACCESSED');
    assert.equal(access.actor.name, 'Dr A');
    assert.equal(access.patient.name, 'Amina Yusuf');
    assert.equal(access.direction, 'our-clinician');
    // Record-holding hospital (B): the same events, about its records.
    const adminB = api(w.server, await w.server.login({ subject: 'admin-b', role: 'hospital_admin', hospitalID: HB }));
    const logB = (await adminB.get('/hospital-admin/access-log')).body;
    assert.ok(logB.some((e) => e.breakGlass && e.direction === 'our-records'));
    assert.equal((await adminB.get('/access/break-glass/pending')).body.length, 1);
    assert.equal((await w.admin.get('/access/break-glass/pending')).body.length, 1);
    // Representative: off-chain, shown to the patient, hash verified.
    const det = (await w.patient.get(`/access/${bg.body.grantID}/emergency-details`)).body;
    assert.equal(det.representative.name, 'Musa Yusuf');
    assert.equal(det.representative.verified, true);
    const onChain = JSON.stringify(w.server.ledger.checkAccess({ grantID: bg.body.grantID }));
    assert.ok(!onChain.includes('Musa Yusuf'), 'no representative PII on-chain');
    assert.ok(!onChain.includes('unresponsive in A&E'), 'no free-text justification on-chain');
    assert.match(onChain, /"justification":"sha256:[0-9a-f]{64}"/);
    assert.equal(det.justification, 'unresponsive in A&E');
    assert.equal(det.justificationVerified, true);
    // Extend with a reason.
    assert.equal((await w.dr.post(`/access/${bg.body.grantID}/extend`, { minutes: 60 })).status, 400);
    const ext = await w.dr.post(`/access/${bg.body.grantID}/extend`, { minutes: 60, reason: 'still in theatre' });
    assert.equal(ext.status, 200, JSON.stringify(ext.body));
    assert.equal(ext.body.extensions.length, 1);
    assert.equal(ext.body.extensions[0].reason, 'still in theatre');
    assert.ok(!JSON.stringify(w.server.ledger.checkAccess({ grantID: bg.body.grantID })).includes('still in theatre'), 'extension reason off-chain');
    // Either hospital's admin may review.
    assert.equal((await adminB.post(`/access/${bg.body.grantID}/review`, { notes: 'justified' })).status, 200);

    // A third hospital sees nothing; patients are refused.
    const other = api(w.server, await w.server.login({ subject: 'admin-c', role: 'hospital_admin', hospitalID: 'hospital-c' }));
    assert.equal((await other.get('/hospital-admin/access-log')).body.length, 0);
    assert.equal((await w.patient.get('/hospital-admin/overview')).status, 403);

    // Own-hospital records are not Cevruni's business.
    assert.equal((await w.dr.post('/access/request', { patientDID: w.did, providerID: 'dr-a', hospitalID: H })).status, 400);
    assert.equal((await w.dr.post('/access/break-glass', { hospitalID: H, hospitalNumber: 'A-1', justification: 'x' })).status, 400);

    // Hospital admin registers a clinician.
    const reg = await w.admin.post('/hospital-admin/clinicians', { providerID: 'nurse-1', name: 'Nurse One', role: 'Nurse', department: 'ER' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.hospitalID, H);
  } finally {
    await w.server.close();
  }
});

test('break-glass is refused when the patient has not added the requesting hospital to their network', async () => {
  const w = await setup();
  try {
    // A clinician at hospital-c, which is not in the patient's network.
    const adminC = api(w.server, await w.server.login({ subject: 'admin-c', role: 'hospital_admin', hospitalID: 'hospital-c' }));
    await adminC.post('/providers/register', { providerID: 'dr-c', hospitalID: 'hospital-c', name: 'Dr C', role: 'Physician' });
    const drC = api(w.server, await w.server.login({ subject: 'dr-c', role: 'clinician', hospitalID: 'hospital-c' }));
    const r = await drC.post('/access/break-glass', { hospitalID: HB, hospitalNumber: 'B-1', justification: 'unresponsive' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not added/);
    // Unknown number: generic answer.
    assert.equal((await drC.post('/access/break-glass', { hospitalID: HB, hospitalNumber: 'nope', justification: 'x' })).status, 404);
    // Looking up another hospital's numbers directly is not allowed.
    assert.equal((await drC.get(`/patients/lookup-by-hospital-number/${HB}/B-1`)).status, 403);
  } finally {
    await w.server.close();
  }
});
