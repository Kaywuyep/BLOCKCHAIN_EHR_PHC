'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestServer } = require('../testutil/testServer');
const { runDemoSeed } = require('./demoSeed');

test('the demo seed loads every scenario and a second run adds nothing', async () => {
  const s = await createTestServer();
  try {
    const ctx = {
      db: s.db, logger: { info() {}, warn() {}, error() {} }, ledgerPromise: Promise.resolve(s.ledger), fhirAdapter: s.fhirAdapter,
      providerRegistry: s.providerRegistry, hospitalRegistry: s.hospitalRegistry, userDirectory: s.userDirectory,
      identityStore: s.identityStore, referenceService: s.referenceService, listenerManager: s.listenerManager, inbox: s.inbox, port: 6000, cipher: s.cipher,
    };
    await runDemoSeed(ctx);
    const statuses = new Set(s.ledger.getGrantsByRequesterHospital('general-hospital-langtang').map((g) => g.status));
    for (const st of ['ACTIVE', 'PENDING', 'REVOKED', 'EXPIRED']) assert.ok(statuses.has(st), `missing ${st} grant`);
    assert.equal(s.ledger.getPendingBreakGlassReviews().length, 1);
    const bg = s.ledger.getPendingBreakGlassReviews()[0];
    assert.equal(bg.hospitalID, 'jos-university-teaching-hospital');
    assert.equal(bg.requesterHospitalID, 'general-hospital-langtang');
    assert.ok(bg.representativeHash);
    for (const g of s.ledger.grants.values()) assert.notEqual(g.hospitalID, g.requesterHospitalID, 'no own-hospital grants');
    assert.equal(s.hospitalRegistry.get('jos-university-teaching-hospital').integration, 'both');
    assert.equal(s.hospitalRegistry.get('plateau-specialist-hospital').integration, 'rest');
    const roles = new Set(s.userDirectory.list().flatMap((u) => u.roles));
    for (const r of ['patient', 'clinician', 'hospital_admin', 'system_admin', 'hl7_interface']) assert.ok(roles.has(r), `no ${r}`);

    const counts = () => ({
      bundles: s.db.prepare('SELECT COUNT(*) n FROM clinical_bundles').get().n,
      roster: s.db.prepare('SELECT COUNT(*) n FROM local_patient_index').get().n,
      users: s.db.prepare('SELECT COUNT(*) n FROM users').get().n,
      shots: s.db.prepare('SELECT COUNT(*) n FROM screen_capture_attempts').get().n,
      grants: s.ledger.grants.size,
    });
    const before = counts();
    await runDemoSeed(ctx);
    assert.deepEqual(counts(), before);
  } finally {
    await s.close();
  }
});
