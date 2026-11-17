'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../db/database');
const { DiagnosisInsights } = require('../services/diagnosisInsights');
const { createTestServer } = require('../testutil/testServer');

// Insights: Access activity (from the ledger, counts only) and Diagnosis
// trends (ICD-10 catalogue + anonymous monthly counts, small cells
// suppressed, never linked to a patient).

function store() {
  return new DiagnosisInsights({ db: openDatabase(':memory:'), hashKey: 'test-key' });
}

test('the catalogue is seeded with ICD-10 and finds local names ("MP+", "htn")', () => {
  const d = store();
  assert.equal(d.search('mp+')[0].code, 'B54');
  assert.equal(d.search('htn')[0].code, 'I10');
  assert.equal(d.search('b50')[0].code.startsWith('B50'), true);
  assert.equal(d.search('Essential hypertension')[0].code, 'I10');
});

test('a missing diagnosis becomes LOCAL-0001, pending; an existing name returns the existing code', () => {
  const d = store();
  const a = d.addLocalTerm('Buruli ulcer', { createdBy: 'dr-x' });
  assert.equal(a.created, true);
  assert.equal(a.term.code, 'LOCAL-0001');
  assert.equal(a.term.status, 'pending');
  const again = d.addLocalTerm('buruli  ULCER');
  assert.equal(again.created, false);
  assert.equal(again.term.code, 'LOCAL-0001');
  assert.equal(d.addLocalTerm('typhoid').term.code, 'A01.0');
});

const DAY = 24 * 3600 * 1000;
const base = { viewerHospitalID: 'h-a', recordsHospitalID: 'h-b', role: 'Physician' };
const at = (iso) => new Date(iso);

test('same patient, same diagnosis: counted once per interval, across grants; the other clinician is not told', () => {
  const d = store();
  const t0 = at('2026-11-10T09:00:00Z');
  const first = d.tag({ ...base, codes: ['B54'], grantID: 'g1', patientDID: 'did:amina', clinicianID: 'dr-1', grantEndsAt: '2026-12-10T00:00:00Z', at: t0 });
  assert.equal(first.results[0].status, 'noted');

  // Same grant, two days later: refused as already noted, with the date it reopens.
  const again = d.tag({ ...base, codes: ['B54'], grantID: 'g1', patientDID: 'did:amina', clinicianID: 'dr-1', grantEndsAt: '2026-12-10T00:00:00Z', at: new Date(t0.getTime() + 2 * DAY) });
  assert.equal(again.results[0].status, 'already-noted');
  assert.equal(again.results[0].nextAt, new Date(t0.getTime() + 14 * DAY).toISOString());

  // Another clinician, another grant, same patient: noted for them, not counted, and they see plain "noted".
  const other = d.tag({ ...base, viewerHospitalID: 'h-c', codes: ['B54'], grantID: 'g2', patientDID: 'did:amina', clinicianID: 'dr-2', grantEndsAt: '2026-12-10T00:00:00Z', at: new Date(t0.getTime() + 3 * DAY) });
  assert.equal(other.results[0].status, 'noted');

  // A different patient counts.
  d.tag({ ...base, codes: ['B54'], grantID: 'g3', patientDID: 'did:ibrahim', clinicianID: 'dr-1', grantEndsAt: '2026-12-10T00:00:00Z', at: t0 });

  // After the interval, the same patient counts again (a new episode).
  d.tag({ ...base, codes: ['B54'], grantID: 'g1', patientDID: 'did:amina', clinicianID: 'dr-1', grantEndsAt: '2026-12-10T00:00:00Z', at: new Date(t0.getTime() + 15 * DAY) });

  const total = d.db.prepare("SELECT SUM(views) AS n FROM diagnosis_counts WHERE code = 'B54'").get().n;
  assert.equal(total, 3);
});

test('the system admin sets intervals: per code, or the default; chronic codes start at 30 days', () => {
  const d = store();
  assert.equal(d.intervalFor('I10'), 30);
  assert.equal(d.intervalFor('B54'), 14);
  d.setInterval('B54', 28);
  assert.equal(d.intervalFor('B54'), 28);
  d.setDefaultIntervalDays(7);
  assert.equal(d.intervalFor('A09'), 7);
  d.setInterval('B54', null);
  assert.equal(d.intervalFor('B54'), 7);
  assert.throws(() => d.setInterval('B54', 0), /whole number of days/);
  assert.throws(() => d.setDefaultIntervalDays(400), /whole number of days/);
});

test('the clinician sees what was noted on the grant and can undo their own tick the same day only', () => {
  const d = store();
  const t0 = at('2026-11-16T08:00:00Z');
  d.tag({ ...base, codes: ['B54', 'I10'], grantID: 'g1', patientDID: 'did:p', clinicianID: 'dr-1', grantEndsAt: '2026-12-16T00:00:00Z', at: t0 });
  const notes = d.notesForGrant({ grantID: 'g1', clinicianID: 'dr-1', now: t0 });
  assert.deepEqual(notes.map((n) => n.code).sort(), ['B54', 'I10']);
  assert.ok(notes.every((n) => n.byYou && n.canUndo));
  assert.equal(d.notesForGrant({ grantID: 'g1', clinicianID: 'dr-2', now: t0 })[0].canUndo, false);

  assert.throws(() => d.undo({ grantID: 'g1', code: 'B54', clinicianID: 'dr-2', now: t0 }), /your own/);
  d.undo({ grantID: 'g1', code: 'B54', clinicianID: 'dr-1', now: t0 });
  assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM diagnosis_counts WHERE code = 'B54'").get().n, 0);
  // Undone, so it can be ticked again straight away.
  assert.equal(d.tag({ ...base, codes: ['B54'], grantID: 'g1', patientDID: 'did:p', clinicianID: 'dr-1', grantEndsAt: '2026-12-16T00:00:00Z', at: t0 }).results[0].status, 'noted');
  // Next day: too late to undo.
  assert.throws(() => d.undo({ grantID: 'g1', code: 'I10', clinicianID: 'dr-1', now: new Date(t0.getTime() + DAY) }), /day it was made/);
});

test('links end with the grant and the episode; only anonymous counts remain', () => {
  const d = store();
  const t0 = at('2026-11-01T08:00:00Z');
  d.tag({ ...base, codes: ['B54'], grantID: 'g1', patientDID: 'did:p', clinicianID: 'dr-1', grantEndsAt: '2026-11-02T08:00:00Z', at: t0 });
  d.tag({ ...base, codes: ['I10'], grantID: 'g2', patientDID: 'did:q', clinicianID: 'dr-1', grantEndsAt: '2026-12-30T08:00:00Z', at: t0 });
  d.forgetGrant('g2');
  d.purge(new Date(t0.getTime() + 40 * DAY));
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM diagnosis_grant_notes').get().n, 0);
  assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM diagnosis_episodes').get().n, 0);
  assert.equal(d.db.prepare('SELECT SUM(views) AS n FROM diagnosis_counts').get().n, 2);
  const raw = JSON.stringify(d.db.prepare('SELECT * FROM diagnosis_counts').all());
  assert.equal(/g1|g2|did:|dr-1/.test(raw), false);
});

test('counts under 5 are suppressed in trends', () => {
  const d = store();
  for (let i = 0; i < 6; i += 1) d.tag({ ...base, codes: ['B54'], grantID: `g${i}`, patientDID: `did:${i}`, clinicianID: `dr-${i % 3}` });
  d.tag({ ...base, codes: ['I10'], grantID: 'g9', patientDID: 'did:9', clinicianID: 'dr-9' });
  const t = d.trends({});
  const malaria = t.diagnoses.find((x) => x.code === 'B54');
  assert.equal(malaria.views.value, 6);
  assert.equal(malaria.clinicians.suppressed, true);
  assert.equal(t.diagnoses.find((x) => x.code === 'I10').views.suppressed, true);
});

test('mapping a local term to ICD-10 moves its counts and teaches the catalogue its name', () => {
  const d = store();
  const { term } = d.addLocalTerm('Typhoid perforation');
  for (let i = 0; i < 5; i += 1) d.tag({ ...base, codes: [term.code], grantID: `g${i}`, patientDID: `did:${i}`, clinicianID: `dr-${i}` });
  assert.throws(() => d.mapTerm(term.code, { targetCode: 'K63.1' }), /give its ICD-10 name/);
  d.mapTerm(term.code, { targetCode: 'K63.1', newDisplay: 'Perforation of intestine (nontraumatic)', reviewedBy: 'hro' });
  const t = d.trends({});
  assert.equal(t.diagnoses.length, 1);
  assert.equal(t.diagnoses[0].code, 'K63.1');
  assert.equal(t.diagnoses[0].views.value, 5);
  assert.equal(d.search('typhoid perforation')[0].code, 'K63.1');
  assert.equal(d.pendingTerms().length, 0);
  // A tick sent with the old code lands on the new one.
  d.tag({ ...base, codes: [term.code], grantID: 'g-late', patientDID: 'did:late', clinicianID: 'dr-late' });
  assert.equal(d.trends({}).diagnoses[0].views.value, 6);
});

test('tagging needs the clinician holding the ACTIVE grant; insights are for system admins only', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    const H_A = 'general-hospital-langtang';
    const H_B = 'jos-university-teaching-hospital';
    server.providerRegistry.register({ providerID: 'dr-ade', hospitalID: H_B, role: 'Physician', status: 'ACTIVE' });
    server.ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
    server.ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'dr-ade', hospitalID: H_A, requesterHospitalID: H_B, purpose: 'Treatment' });

    const clin = await server.login({ subject: 'dr-ade', role: 'clinician', hospitalID: H_B, providerID: 'dr-ade' });
    const other = await server.login({ subject: 'dr-zed', role: 'clinician', hospitalID: H_B, providerID: 'dr-zed' });
    const sys = await server.login({ subject: 'root', role: 'system_admin' });
    const call = (path, token, body) =>
      fetch(`${server.baseUrl}/api${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
      });

    assert.equal((await call('/diagnoses/tags', clin, { grantID: 'g1', codes: ['B54'] })).status, 403, 'grant still PENDING');
    server.ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 });
    assert.equal((await call('/diagnoses/tags', other, { grantID: 'g1', codes: ['B54'] })).status, 403);
    const ok = await call('/diagnoses/tags', clin, { grantID: 'g1', codes: ['B54', 'I10'] });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.deepEqual(okBody.results.map((r) => r.status), ['noted', 'noted']);
    assert.equal(okBody.notes.length, 2);
    const again = await (await call('/diagnoses/tags', clin, { grantID: 'g1', codes: ['B54'] })).json();
    assert.equal(again.results[0].status, 'already-noted');
    const notes = await (await call('/diagnoses/notes?grantID=g1', clin)).json();
    assert.equal(notes.length, 2);
    assert.equal((await call('/diagnoses/notes?grantID=g1', other)).status, 403);
    const undo = await fetch(`${server.baseUrl}/api/diagnoses/tags/I10?grantID=g1`, { method: 'DELETE', headers: { authorization: `Bearer ${clin}` } });
    assert.equal(undo.status, 200);
    assert.equal((await undo.json()).notes.length, 1);

    // Revoking the grant deletes its notes at once.
    server.ledger.revokeAccess({ grantID: 'g1' });
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM diagnosis_grant_notes').get().n, 0);

    // Intervals are for system admins.
    const put = (path, token, body) => fetch(`${server.baseUrl}/api${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    assert.equal((await put('/insights/intervals/B54', clin, { days: 28 })).status, 403);
    assert.equal((await put('/insights/intervals/B54', sys, { days: 28 })).status, 200);
    assert.equal((await put('/insights/intervals/default', sys, { days: 0 })).status, 400);
    const iv = await (await call('/insights/intervals?q=malaria', sys)).json();
    assert.equal(iv.terms.find((t) => t.code === 'B54').effectiveIntervalDays, 28);

    const search = await (await call('/diagnoses/search?q=malaria', clin)).json();
    assert.equal(search[0].code, 'B54');

    assert.equal((await call('/insights/diagnoses', clin)).status, 403);
    const trends = await (await call('/insights/diagnoses', sys)).json();
    assert.equal(trends.totals.taggedViews, 1, 'one tick undone');

    const access = await call('/insights/access', sys);
    assert.equal(access.status, 200);
    const a = await access.json();
    assert.equal(a.totals.requests, 1);
    assert.equal(a.hospitalPairs[0].requesterHospitalID, H_B);
    assert.equal(JSON.stringify(a).includes('did:p1'), false, 'no patient identifiers in access insights');
  } finally {
    await server.close();
  }
});
