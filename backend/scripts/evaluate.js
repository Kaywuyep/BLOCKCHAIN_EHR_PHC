#!/usr/bin/env node
'use strict';

/**
 * scripts/evaluate.js
 *
 * Produces the measurements reported in Chapter Five, against an already
 * running backend (either ledger mode). It drives two simulated hospitals,
 * Hospital A and Hospital B, entirely through their HL7 v2 ADT feeds over
 * MLLP, then exercises the evaluation criteria from Table 3.9:
 *
 *   1. HL7 v2 ADT ingestion (A01/A08/A03 + malformed messages), per hospital
 *   2. cross-facility access in BOTH directions (B->A and A->B): identity
 *      linkage, request, grant, authorisation latency, resolution
 *      accuracy, policy checks, revocation effectiveness
 *   3. break-glass access and post-hoc review
 *   4. audit integrity (tamper attempts via the peer CLI; Fabric mode only)
 *   5. offline queueing and reconciliation
 *   6. transaction batching: concurrency vs transactions per block vs
 *      per-action latency (Fabric mode only) -- the empirical Caction(b)
 *   7. the live cost-model summary
 *
 * Start the backend first, with MLLP listeners for hospital-a/hospital-b:
 *
 *   DEMO_SEED=off HOSPITAL_INGESTION_CONFIG=config/hospitalIngestion.ab.json \
 *   HL7_MLLP_ENABLED=true LEDGER_MODE=fabric PORT=4600 node src/server.js
 *
 * then:
 *
 *   node scripts/evaluate.js --base http://localhost:4600 --mllp-a 5101 \
 *     --mllp-b 5102 --patients 10 --out results.json [--fabric]
 *
 * --fabric enables the checks that need the Fabric network's `cli`
 * container (block heights, direct tamper attempts).
 */

const net = require('node:net');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// ── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const BASE = arg('base', 'http://localhost:4600');
const MLLP = { 'hospital-a': Number(arg('mllp-a', 5101)), 'hospital-b': Number(arg('mllp-b', 5102)) };
const N_PATIENTS = Number(arg('patients', 10));
const OUT = arg('out', null);
const FABRIC = args.includes('--fabric');
const RUN = randomUUID().slice(0, 6).toUpperCase();

// ── helpers ─────────────────────────────────────────────────────────────
const now = () => performance.now();

async function api(method, path, body) {
  const t0 = now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = now() - t0;
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, json, ms };
}

function stats(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const pct = (p) => v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const r = (x) => Math.round(x * 10) / 10;
  return { n: v.length, mean: r(mean), median: r(pct(50)), p95: r(pct(95)), min: r(v[0]), max: r(v[v.length - 1]) };
}

/** Sends one HL7 message over MLLP and returns { ackCode, ms }. */
function sendMllp(port, message) {
  return new Promise((resolve, reject) => {
    const t0 = now();
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buf = '';
    socket.setTimeout(10000);
    socket.on('connect', () => socket.write(`\x0b${message}\x1c\r`));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('\x1c')) {
        const ms = now() - t0;
        socket.end();
        const msa = buf.split(/\r|\n/).find((s) => s.replace('\x0b', '').startsWith('MSA'));
        resolve({ ackCode: msa ? msa.replace('\x0b', '').split('|')[1] : 'NONE', ms });
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('MLLP timeout'));
    });
    socket.on('error', reject);
  });
}

const FACILITY = { 'hospital-a': 'HOSPITALA', 'hospital-b': 'HOSPITALB' };
let controlSeq = 0;

function adt({ hospitalID, trigger, hospitalNumber, family, given, dob, sex, admit, discharge, includePid = true }) {
  controlSeq += 1;
  const ts = '20261105080000';
  const msh = `MSH|^~\\&|ADTAPP|${FACILITY[hospitalID]}|PATIENTCHAIN|${FACILITY[hospitalID]}|${ts}||ADT^${trigger}|${RUN}-${controlSeq}|P|2.5`;
  const evn = `EVN|${trigger}|${ts}`;
  const pid = `PID|1||${hospitalNumber}||${family}^${given}||${dob}|${sex}`;
  const pv1Fields = new Array(46).fill('');
  pv1Fields[0] = 'PV1';
  pv1Fields[1] = '1';
  pv1Fields[2] = 'I';
  pv1Fields[3] = 'WARD1^101^A';
  pv1Fields[7] = '4471^ADEYEMI^FOLA';
  pv1Fields[44] = admit || '20261105080000';
  pv1Fields[45] = discharge || '';
  const segs = [msh, evn];
  if (includePid) segs.push(pid);
  segs.push(pv1Fields.join('|'));
  return segs.join('\r') + '\r';
}

function cli(argsList) {
  return execFileSync('docker', ['exec', 'cli', 'peer', ...argsList], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function blockHeight() {
  const out = cli(['channel', 'getinfo', '-c', 'patientchainchannel']);
  return JSON.parse(out.slice(out.indexOf('{'))).height;
}

const FAMILIES = ['OKAFOR', 'BELLO', 'MUSA', 'DANLADI', 'GYANG', 'PAM', 'EZE', 'ADAMU', 'DAVOU', 'IBRAHIM', 'OLUWA', 'NNADI'];
const GIVENS = ['ADA', 'CHIDI', 'HAUWA', 'NANKAP', 'RINJI', 'TERNA', 'KEMI', 'YAKUBU', 'LONGJI', 'ZAINAB', 'TUNDE', 'NGOZI'];

// ── 1. HL7 ADT ingestion ───────────────────────────────────────────────
async function phaseHl7(patients) {
  const perHospital = {};
  for (const hospitalID of ['hospital-a', 'hospital-b']) {
    const rows = { sent: 0, AA: 0, AE: 0, other: 0, latencies: [], byTrigger: {} };
    const port = MLLP[hospitalID];
    for (const p of patients) {
      const hn = p.numbers[hospitalID];
      for (const trigger of ['A01', 'A08', 'A03']) {
        const msg = adt({
          hospitalID,
          trigger,
          hospitalNumber: hn,
          family: p.family,
          given: p.given,
          dob: p.dobHl7,
          sex: p.sex,
          discharge: trigger === 'A03' ? '20261106120000' : '',
        });
        const { ackCode, ms } = await sendMllp(port, msg);
        rows.sent += 1;
        rows[ackCode in rows ? ackCode : 'other'] += 1;
        rows.latencies.push(ms);
        rows.byTrigger[trigger] = (rows.byTrigger[trigger] || 0) + (ackCode === 'AA' ? 1 : 0);
      }
    }
    // Malformed: missing PID entirely, and a non-ADT message type.
    const bad1 = adt({ hospitalID, trigger: 'A01', hospitalNumber: 'X', family: 'X', given: 'X', dob: '19900101', sex: 'F', includePid: false });
    const bad2 = adt({ hospitalID, trigger: 'A01', hospitalNumber: 'X', family: 'X', given: 'X', dob: '19900101', sex: 'F' }).replace('ADT^A01', 'ORU^R01');
    const malformed = [];
    for (const m of [bad1, bad2]) {
      const { ackCode } = await sendMllp(port, m);
      malformed.push(ackCode);
    }
    const roster = await api('GET', `/api/patients/local-records/${hospitalID}`);
    const ingested = patients.filter((p) => roster.json.some((r) => r.hospitalNumber === p.numbers[hospitalID])).length;
    perHospital[hospitalID] = {
      messagesSent: rows.sent,
      acceptedAA: rows.AA,
      rejectedAE: rows.AE,
      otherAck: rows.other,
      acceptedByTrigger: rows.byTrigger,
      ackLatencyMs: stats(rows.latencies),
      malformedMessagesAck: malformed,
      patientsOnRoster: ingested,
      patientsExpected: patients.length,
    };
  }
  return perHospital;
}

// ── 2. cross-facility access, both directions ─────────────────────────
async function phaseCrossFacility(patients) {
  const providers = {
    // A Hospital B clinician who needs Hospital A's records, and vice versa.
    // Each is registered at their OWN hospital (homeOf): Cevruni only
    // mediates access between facilities, and hospital RBAC is checked at
    // the requesting clinician's hospital.
    'B->A': { providerID: `dr-hb-${RUN}`, recordsAt: 'hospital-a', homeOf: 'hospital-b' },
    'A->B': { providerID: `dr-ha-${RUN}`, recordsAt: 'hospital-b', homeOf: 'hospital-a' },
  };
  for (const p of Object.values(providers)) {
    await api('POST', '/api/providers/register', {
      providerID: p.providerID,
      hospitalID: p.homeOf,
      name: p.providerID,
      role: 'Physician',
      department: 'Referral',
    });
  }

  const sizes = { reference: [], grant: [], audit: [], fhirBundle: [] };
  const timings = { register: [], registerReference: [], linkLookup: [], linkConfirm: [], request: [], grant: [], authorisationLatency: [], resolve: [], revoke: [] };
  const directions = {};
  const accuracy = { checked: 0, correct: 0, mismatches: [] };

  for (const p of patients) {
    // Patient registers a DID at Hospital A, using the hospital number the
    // ADT feed already created there.
    const reg = await api('POST', '/api/patients/register', {
      patientDID: p.did,
      hospitalID: 'hospital-a',
      mrn: p.numbers['hospital-a'],
    });
    timings.register.push(reg.ms);
    if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.json)}`);

    // Patient-asserted linkage of Hospital B.
    const look = await api('POST', `/api/patients/${encodeURIComponent(p.did)}/link-facility`, {
      hospitalID: 'hospital-b',
      hospitalNumber: p.numbers['hospital-b'],
      dateOfBirth: p.dobIso,
    });
    timings.linkLookup.push(look.ms);
    if (look.status !== 200) throw new Error(`link lookup failed: ${JSON.stringify(look.json)}`);
    const conf = await api('POST', `/api/patients/${encodeURIComponent(p.did)}/confirm-link`, {
      hospitalID: 'hospital-b',
      hospitalNumber: p.numbers['hospital-b'],
    });
    timings.linkConfirm.push(conf.ms);

    // Each hospital's Reference Service registers an on-chain pointer for
    // the encounter its ADT feed created (FR3) -- metadata only.
    for (const hospitalID of ['hospital-a', 'hospital-b']) {
      const ref = await api('POST', `/api/patients/${encodeURIComponent(p.did)}/references`, {
        hospitalID,
        recordType: 'Encounter',
        date: '2026-11-05T08:00:00Z',
      });
      timings.registerReference.push(ref.ms);
      if (ref.status !== 201) throw new Error(`reference failed: ${JSON.stringify(ref.json)}`);
      sizes.reference.push(Buffer.byteLength(JSON.stringify(ref.json)));
    }
  }

  for (const [direction, prov] of Object.entries(providers)) {
    const d = { attempts: 0, resolvedOk: 0, revokedThenRefused: 0, revokeLeaks: 0 };
    for (const p of patients) {
      d.attempts += 1;
      const grantID = randomUUID();
      const req = await api('POST', '/api/access/request', {
        grantID,
        patientDID: p.did,
        providerID: prov.providerID,
        hospitalID: prov.recordsAt,
        requesterHospitalID: prov.homeOf,
        scope: ['Patient', 'Encounter'],
        purpose: 'Referral',
      });
      timings.request.push(req.ms);

      // Authorisation latency: from the patient pressing "approve" to the
      // receiving gateway first serving the record.
      const tGrant = now();
      const g = await api('POST', `/api/access/${grantID}/grant`, { durationMinutes: 30 });
      timings.grant.push(g.ms);
      let res;
      for (let i = 0; i < 50; i += 1) {
        res = await api('GET', `/api/records/resolve?grantID=${grantID}&hospitalID=${prov.recordsAt}&purpose=Referral&resourceTypes=Encounter`);
        if (res.status === 200) break;
      }
      timings.authorisationLatency.push(now() - tGrant);
      timings.resolve.push(res.ms);

      if (res.status === 200) {
        d.resolvedOk += 1;
        sizes.grant.push(Buffer.byteLength(JSON.stringify(res.json.grant)));
        sizes.fhirBundle.push(Buffer.byteLength(JSON.stringify(res.json.bundles)));
        const encounters = (res.json.bundles || []).flatMap((b) => (b.entry || [b]).map((e) => e.resource || e));
        const subjects = encounters.map((r) => r?.subject?.identifier?.value).filter(Boolean);
        accuracy.checked += 1;
        const expected = p.numbers[prov.recordsAt];
        if (subjects.length && subjects.every((s) => s === expected)) accuracy.correct += 1;
        else accuracy.mismatches.push({ did: p.did, expected, got: subjects });
      }

      const rv = await api('POST', `/api/access/${grantID}/revoke`, {});
      timings.revoke.push(rv.ms);
      const after = await api('GET', `/api/records/resolve?grantID=${grantID}&hospitalID=${prov.recordsAt}`);
      if (after.status === 403) d.revokedThenRefused += 1;
      else d.revokeLeaks += 1;
    }
    directions[direction] = { ...d, successRate: d.resolvedOk / d.attempts };
  }

  // Policy / negative checks, on the first patient.
  const p0 = patients[0];
  const neg = {};
  {
    const grantID = randomUUID();
    const prov = providers['B->A'];
    await api('POST', '/api/access/request', {
      grantID,
      patientDID: p0.did,
      providerID: prov.providerID,
      hospitalID: 'hospital-a',
      requesterHospitalID: prov.homeOf,
      scope: ['Encounter'],
      purpose: 'Referral',
    });
    await api('POST', `/api/access/${grantID}/grant`, { durationMinutes: 30 });
    neg.outOfScopeResourceType = (await api('GET', `/api/records/resolve?grantID=${grantID}&hospitalID=hospital-a&resourceTypes=MedicationRequest`)).status;
    neg.purposeMismatch = (await api('GET', `/api/records/resolve?grantID=${grantID}&hospitalID=hospital-a&purpose=Research`)).status;
    neg.wrongHospital = (await api('GET', `/api/records/resolve?grantID=${grantID}&hospitalID=hospital-b`)).status;
    await api('POST', `/api/access/${grantID}/revoke`, {});

    const g2 = randomUUID();
    await api('POST', '/api/access/request', { grantID: g2, patientDID: p0.did, providerID: `dr-unregistered-${RUN}`, hospitalID: 'hospital-a', requesterHospitalID: 'hospital-b' });
    await api('POST', `/api/access/${g2}/grant`, { durationMinutes: 30 });
    neg.unregisteredProvider = (await api('GET', `/api/records/resolve?grantID=${g2}&hospitalID=hospital-a`)).status;

    const g3 = randomUUID();
    await api('POST', '/api/access/request', { grantID: g3, patientDID: p0.did, providerID: prov.providerID, hospitalID: 'hospital-a', requesterHospitalID: prov.homeOf });
    neg.pendingNotYetGranted = (await api('GET', `/api/records/resolve?grantID=${g3}&hospitalID=hospital-a`)).status;

    // Identity linkage: wrong DOB and wrong number must look identical.
    const other = patients[1] || p0;
    const wrongDob = await api('POST', `/api/patients/${encodeURIComponent(other.did)}/link-facility`, {
      hospitalID: 'hospital-b',
      hospitalNumber: other.numbers['hospital-b'],
      dateOfBirth: '1901-01-01',
    });
    const wrongNum = await api('POST', `/api/patients/${encodeURIComponent(other.did)}/link-facility`, {
      hospitalID: 'hospital-b',
      hospitalNumber: 'HB-DOES-NOT-EXIST',
      dateOfBirth: other.dobIso,
    });
    neg.linkWrongDob = { status: wrongDob.status, body: wrongDob.json };
    neg.linkWrongNumber = { status: wrongNum.status, body: wrongNum.json };
    neg.linkResponsesIndistinguishable =
      wrongDob.status === wrongNum.status && JSON.stringify(wrongDob.json) === JSON.stringify(wrongNum.json);
  }

  const trail = (await api('GET', `/api/audit/patient/${encodeURIComponent(p0.did)}`)).json || [];
  for (const e of trail) sizes.audit.push(Buffer.byteLength(JSON.stringify(e)));
  const t = {};
  for (const [k, v] of Object.entries(timings)) t[k] = stats(v);
  const sz = {};
  for (const [k, v] of Object.entries(sizes)) sz[k] = stats(v);
  return { directions, accuracy, timingsMs: t, objectSizesBytes: sz, negativeChecks: neg };
}

// ── 3. break-glass ─────────────────────────────────────────────────────
async function phaseBreakGlass(patients) {
  const lat = [];
  const ids = [];
  for (const p of patients.slice(0, Math.min(5, patients.length))) {
    const r = await api('POST', '/api/access/break-glass', {
      patientDID: p.did,
      providerID: `dr-er-${RUN}`,
      hospitalID: 'hospital-a',
      requesterHospitalID: 'hospital-b',
      justification: 'Unconscious patient, emergency department',
    });
    lat.push(r.ms);
    ids.push({ grantID: r.json.grantID, did: p.did, status: r.json.status, reviewRequired: r.json.reviewRequired });
  }
  const pendingBefore = (await api('GET', '/api/access/break-glass/pending')).json.filter((g) => ids.some((i) => i.grantID === g.grantID)).length;
  for (const i of ids) await api('POST', `/api/access/${i.grantID}/review`, { reviewerID: `admin-${RUN}`, notes: 'Reviewed: justified' });
  const pendingAfter = (await api('GET', '/api/access/break-glass/pending')).json.filter((g) => ids.some((i) => i.grantID === g.grantID)).length;
  const trail = (await api('GET', `/api/audit/patient/${encodeURIComponent(ids[0].did)}`)).json;
  return {
    events: ids.length,
    allActiveImmediately: ids.every((i) => i.status === 'ACTIVE'),
    allFlaggedForReview: ids.every((i) => i.reviewRequired === true),
    pendingReviewBefore: pendingBefore,
    pendingReviewAfter: pendingAfter,
    auditHasBreakGlassEntry: trail.some((e) => e.eventType === 'BREAK_GLASS_ACCESS'),
    auditHasReviewEntry: trail.some((e) => e.eventType === 'BREAK_GLASS_REVIEWED'),
    latencyMs: stats(lat),
  };
}

// ── 4. audit integrity (Fabric) ───────────────────────────────────────
async function phaseAuditIntegrity(patient) {
  const before = (await api('GET', `/api/audit/patient/${encodeURIComponent(patient.did)}`)).json;
  const target = before[0];
  const ORDERER_CA = '/opt/gopath/src/github.com/hyperledger/fabric/peer/crypto/ordererOrganizations/patientchain.local/orderers/orderer.patientchain.local/tls/ca.crt';
  const PEERS = [
    '--peerAddresses', 'peer0.hospitala.patientchain.local:7051',
    '--tlsRootCertFiles', '/opt/gopath/src/github.com/hyperledger/fabric/peer/crypto/peerOrganizations/hospitala.patientchain.local/peers/peer0.hospitala.patientchain.local/tls/ca.crt',
    '--peerAddresses', 'peer0.hospitalb.patientchain.local:9051',
    '--tlsRootCertFiles', '/opt/gopath/src/github.com/hyperledger/fabric/peer/crypto/peerOrganizations/hospitalb.patientchain.local/peers/peer0.hospitalb.patientchain.local/tls/ca.crt',
  ];
  function invoke(fn, fnArgs) {
    try {
      cli([
        'chaincode', 'invoke', '-o', 'orderer.patientchain.local:7050', '--tls', '--cafile', ORDERER_CA,
        '-C', 'patientchainchannel', '-n', 'patientchain', ...PEERS, '--waitForEvent',
        '-c', JSON.stringify({ function: fn, Args: fnArgs }),
      ]);
      return { rejected: false };
    } catch (err) {
      const msg = String(err.stderr || err.message).split('\n').find((l) => l.includes('Error')) || 'error';
      return { rejected: true, message: msg.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 200) };
    }
  }
  const attempts = {
    deleteFunction: invoke('AuditLogContract:DeleteAuditEntry', [target.entryID]),
    updateFunction: invoke('AuditLogContract:UpdateAuditEntry', [target.entryID, 'tampered']),
    overwriteExistingEntry: invoke('AuditLogContract:WriteAuditEntry', [
      target.entryID, target.patientDID, 'RECORD_ACCESSED', 'attacker', 'hospital-a', 'tampered', '', 'false',
    ]),
  };
  const after = (await api('GET', `/api/audit/patient/${encodeURIComponent(patient.did)}`)).json;
  return {
    attempts,
    allRejected: Object.values(attempts).every((a) => a.rejected),
    entriesBefore: before.length,
    entriesAfter: after.length,
    trailUnchanged: JSON.stringify(before) === JSON.stringify(after),
  };
}

// ── 5. offline queue ───────────────────────────────────────────────────
async function phaseOffline(patients) {
  const prov = `dr-hb-${RUN}`;
  await api('POST', '/api/sync/connectivity', { connected: false });
  const queuedGrants = [];
  const tQueue = now();
  for (const p of patients.slice(0, Math.min(5, patients.length))) {
    const grantID = randomUUID();
    const r1 = await api('POST', '/api/access/request', { grantID, patientDID: p.did, providerID: prov, hospitalID: 'hospital-a' });
    const r2 = await api('POST', `/api/access/${grantID}/grant`, { durationMinutes: 30 });
    const r3 = await api('POST', `/api/access/${grantID}/revoke`, { patientDID: p.did, hospitalID: 'hospital-a', actorID: p.did });
    queuedGrants.push({ grantID, did: p.did, statuses: [r1.status, r2.status, r3.status] });
  }
  const queueMs = now() - tQueue;
  const tSync = now();
  const sync = await api('POST', '/api/sync/connectivity', { connected: true });
  const reconcileMs = now() - tSync;
  const results = sync.json.reconciled || [];

  const finalStates = [];
  let offlineAudit = 0;
  const auditIds = new Set();
  let duplicateAudit = 0;
  for (const q of queuedGrants) {
    const g = await api('GET', `/api/access/${q.grantID}`);
    finalStates.push(g.json?.status);
    const trail = (await api('GET', `/api/audit/patient/${encodeURIComponent(q.did)}`)).json || [];
    for (const e of trail) {
      if (auditIds.has(e.entryID)) duplicateAudit += 1;
      auditIds.add(e.entryID);
    }
    offlineAudit += trail.filter((e) => e.queuedOffline).length;
  }
  return {
    actionsQueued: queuedGrants.length * 3,
    allAcceptedAs202WhileOffline: queuedGrants.every((q) => q.statuses.every((s) => s === 202)),
    queueingTimeMs: Math.round(queueMs),
    reconciled: results.length,
    synced: results.filter((r) => r.status === 'SYNCED').length,
    failed: results.filter((r) => r.status === 'FAILED').length,
    reconcileTimeMs: Math.round(reconcileMs),
    finalGrantStates: finalStates,
    auditEntriesFlaggedQueuedOffline: offlineAudit,
    duplicateAuditEntries: duplicateAudit,
  };
}

// ── 6. batching (Fabric) ───────────────────────────────────────────────
async function phaseBatching() {
  const levels = [1, 2, 5, 10, 20, 50];
  const rows = [];
  for (const c of levels) {
    const h0 = blockHeight();
    const t0 = now();
    const results = await Promise.all(
      Array.from({ length: c }, () => api('POST', '/api/patients/register', { patientDID: `did:patientchain:batch-${RUN}-${randomUUID()}` }))
    );
    const wall = now() - t0;
    const h1 = blockHeight();
    const blocks = Math.max(1, h1 - h0);
    rows.push({
      concurrentSubmissions: c,
      succeeded: results.filter((r) => r.status === 201).length,
      blocksCut: h1 - h0,
      txPerBlock: Math.round((c / blocks) * 10) / 10,
      wallClockMs: Math.round(wall),
      meanLatencyPerRequestMs: Math.round(results.reduce((s, r) => s + r.ms, 0) / c),
      amortisedMsPerAction: Math.round((wall / c) * 10) / 10,
      throughputTps: Math.round((c / (wall / 1000)) * 100) / 100,
    });
  }
  return rows;
}

// ── main ───────────────────────────────────────────────────────────────
(async () => {
  const health = await api('GET', '/api/health');
  console.log(`backend ${BASE}: ledger=${health.json.ledgerMode}`);
  await api('POST', '/api/sync/connectivity', { connected: true });

  const patients = Array.from({ length: N_PATIENTS }, (_, i) => {
    const y = 1960 + ((i * 7) % 45);
    const m = String(1 + (i % 12)).padStart(2, '0');
    const d = String(1 + ((i * 3) % 28)).padStart(2, '0');
    return {
      did: `did:patientchain:eval-${RUN}-${i}`,
      family: FAMILIES[i % FAMILIES.length],
      given: GIVENS[(i * 5) % GIVENS.length],
      sex: i % 2 ? 'M' : 'F',
      dobHl7: `${y}${m}${d}`,
      dobIso: `${y}-${m}-${d}`,
      numbers: { 'hospital-a': `HA-${RUN}-${String(i).padStart(4, '0')}`, 'hospital-b': `HB-${RUN}-${String(i).padStart(4, '0')}` },
    };
  });

  const results = { run: RUN, startedAt: new Date().toISOString(), base: BASE, ledgerMode: health.json.ledgerMode, patients: N_PATIENTS };
  const step = async (name, fn) => {
    process.stdout.write(`- ${name} ... `);
    const t0 = now();
    results[name] = await fn();
    console.log(`done (${Math.round(now() - t0)} ms)`);
  };

  await step('hl7Ingestion', () => phaseHl7(patients));
  await step('crossFacility', () => phaseCrossFacility(patients));
  await step('breakGlass', () => phaseBreakGlass(patients));
  if (FABRIC) await step('auditIntegrity', () => phaseAuditIntegrity(patients[0]));
  await step('offlineSync', () => phaseOffline(patients));
  if (FABRIC) await step('batching', () => phaseBatching());
  await step('costSummary', async () => (await api('GET', '/api/cost/summary')).json);
  if (FABRIC) results.finalBlockHeight = blockHeight();
  results.finishedAt = new Date().toISOString();

  const text = JSON.stringify(results, null, 2);
  if (OUT) fs.writeFileSync(OUT, text);
  console.log(text);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
