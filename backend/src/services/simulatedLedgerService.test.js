'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SimulatedLedgerService } = require('./simulatedLedgerService');

// This module is the exact demo-mode stand-in for the Go chaincode --
// same operations, same state machine (see chaincode/accesscontrol_test.go
// for the on-chain equivalent of the grant-lifecycle tests below). Testing
// it here matters in its own right: LEDGER_MODE=simulated is what actually
// runs during day-to-day development and any defense given without a live
// Fabric network.

test('registerPatient rejects a duplicate DID and getPatient rejects an unknown one', () => {
  const ledger = new SimulatedLedgerService();
  ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
  assert.throws(() => ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk2' }), /already registered/);
  assert.throws(() => ledger.getPatient('did:missing'), /not found/);
});

test('registerRecordReference requires a registered patient and never accepts a clinical payload', () => {
  const ledger = new SimulatedLedgerService();
  assert.throws(
    () => ledger.registerRecordReference({ refID: 'r1', patientDID: 'did:unregistered', hospitalID: 'HospitalA', recordType: 'lab' }),
    /is not registered/
  );

  ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
  const ref = ledger.registerRecordReference({ refID: 'r1', patientDID: 'did:p1', hospitalID: 'HospitalA', recordType: 'lab' });
  // The only fields ever accepted describe metadata, not content.
  assert.deepEqual(Object.keys(ref).sort(), ['date', 'docType', 'hospitalID', 'patientDID', 'recordType', 'refID', 'registeredBy'].sort());
});

test('the standard grant lifecycle moves PENDING -> ACTIVE -> REVOKED', () => {
  const ledger = new SimulatedLedgerService();
  const requested = ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });
  assert.equal(requested.status, 'PENDING');

  const granted = ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 });
  assert.equal(granted.status, 'ACTIVE');
  assert.ok(granted.expiresAt);

  const revoked = ledger.revokeAccess({ grantID: 'g1' });
  assert.equal(revoked.status, 'REVOKED');
  assert.ok(revoked.revokedAt);
});

test('grantAccess refuses a grant that is not PENDING', () => {
  const ledger = new SimulatedLedgerService();
  ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });
  ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 });
  assert.throws(() => ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 }), /not in PENDING state/);
});

test('revokeAccess refuses a grant that is not ACTIVE', () => {
  const ledger = new SimulatedLedgerService();
  ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });
  assert.throws(() => ledger.revokeAccess({ grantID: 'g1' }), /not ACTIVE/);
});

test('checkAccess lazily expires a grant once its expiry has passed', () => {
  const ledger = new SimulatedLedgerService();
  ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });
  const granted = ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 });
  granted.expiresAt = new Date(Date.now() - 1000).toISOString(); // simulate the clock moving past expiry

  const checked = ledger.checkAccess({ grantID: 'g1' });
  assert.equal(checked.status, 'EXPIRED');
});

test('breakGlassAccess activates immediately, is flagged for mandatory review, and requires a justification', () => {
  const ledger = new SimulatedLedgerService();
  assert.throws(
    () => ledger.breakGlassAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA', justification: '  ' }),
    /justification is required/
  );

  const grant = ledger.breakGlassAccess({
    grantID: 'g2',
    patientDID: 'did:p1',
    providerID: 'prov-1',
    hospitalID: 'HospitalA',
    justification: 'Unconscious patient in ER',
  });
  assert.equal(grant.status, 'ACTIVE');
  assert.equal(grant.grantType, 'BREAK_GLASS');
  assert.equal(grant.reviewRequired, true);
  assert.equal(grant.reviewed, false);
});

test('reviewBreakGlass closes the review loop exactly once and rejects a standard grant', () => {
  const ledger = new SimulatedLedgerService();
  ledger.requestAccess({ grantID: 'standard-1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });
  assert.throws(() => ledger.reviewBreakGlass({ grantID: 'standard-1', reviewerID: 'admin-1' }), /not a break-glass grant/);

  ledger.breakGlassAccess({ grantID: 'bg-1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA', justification: 'Emergency' });
  const reviewed = ledger.reviewBreakGlass({ grantID: 'bg-1', reviewerID: 'admin-1', notes: 'Confirmed legitimate' });
  assert.equal(reviewed.reviewed, true);
  assert.throws(() => ledger.reviewBreakGlass({ grantID: 'bg-1', reviewerID: 'admin-2' }), /already been reviewed/);
});

test('getPendingBreakGlassReviews only lists unreviewed break-glass grants', () => {
  const ledger = new SimulatedLedgerService();
  ledger.breakGlassAccess({ grantID: 'bg-1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA', justification: 'Emergency' });
  ledger.breakGlassAccess({ grantID: 'bg-2', patientDID: 'did:p2', providerID: 'prov-2', hospitalID: 'HospitalB', justification: 'Emergency' });
  ledger.reviewBreakGlass({ grantID: 'bg-1', reviewerID: 'admin-1' });

  const pending = ledger.getPendingBreakGlassReviews();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].grantID, 'bg-2');
});

test('getGrantsForPatient only returns that patient\'s grants', () => {
  const ledger = new SimulatedLedgerService();
  ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });
  ledger.requestAccess({ grantID: 'g2', patientDID: 'did:p2', providerID: 'prov-2', hospitalID: 'HospitalB' });

  const grants = ledger.getGrantsForPatient('did:p1');
  assert.equal(grants.length, 1);
  assert.equal(grants[0].grantID, 'g1');
});

test('writeAuditEntry is append-only: a duplicate entryID is rejected', () => {
  const ledger = new SimulatedLedgerService();
  ledger.writeAuditEntry({ entryID: 'a1', patientDID: 'did:p1', eventType: 'GRANT_ISSUED', actorID: 'did:p1', hospitalID: 'HospitalA' });
  assert.throws(
    () => ledger.writeAuditEntry({ entryID: 'a1', patientDID: 'did:p1', eventType: 'GRANT_REVOKED', actorID: 'did:p1', hospitalID: 'HospitalA' }),
    /already exists/
  );
});

test('getAuditTrailForPatient returns only that patient\'s entries, oldest first', () => {
  const ledger = new SimulatedLedgerService();
  ledger.writeAuditEntry({ entryID: 'a1', patientDID: 'did:p1', eventType: 'GRANT_ISSUED', actorID: 'did:p1', hospitalID: 'HospitalA', clientTimestamp: '2025-01-01T00:00:00Z' });
  ledger.writeAuditEntry({ entryID: 'a2', patientDID: 'did:p1', eventType: 'GRANT_REVOKED', actorID: 'did:p1', hospitalID: 'HospitalA', clientTimestamp: '2025-01-02T00:00:00Z' });
  ledger.writeAuditEntry({ entryID: 'a3', patientDID: 'did:p2', eventType: 'GRANT_ISSUED', actorID: 'did:p2', hospitalID: 'HospitalB', clientTimestamp: '2025-01-01T00:00:00Z' });

  const trail = ledger.getAuditTrailForPatient('did:p1');
  assert.equal(trail.length, 2);
  assert.deepEqual(trail.map((e) => e.entryID), ['a1', 'a2']);
});

test('getCounters tracks each event category independently', () => {
  const ledger = new SimulatedLedgerService();
  ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
  ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });
  ledger.grantAccess({ grantID: 'g1', durationMinutes: 30 });
  ledger.writeAuditEntry({ patientDID: 'did:p1', eventType: 'GRANT_ISSUED', actorID: 'did:p1', hospitalID: 'HospitalA' });

  const counters = ledger.getCounters();
  assert.equal(counters.registration, 1);
  assert.equal(counters.grant, 2); // requestAccess + grantAccess each bump 'grant'
  assert.equal(counters.audit, 1);
  assert.equal(counters.reference, 0);
});

test('getRecentEvents returns the most recent events first', () => {
  const ledger = new SimulatedLedgerService();
  ledger.registerPatient({ patientDID: 'did:p1', publicKey: 'pk1' });
  ledger.requestAccess({ grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });

  const events = ledger.getRecentEvents(10);
  assert.equal(events[0].type, 'AccessRequested');
  assert.equal(events[1].type, 'PatientRegistered');
});
