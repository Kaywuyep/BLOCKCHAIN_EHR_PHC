'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../db/database');
const { FieldCipher } = require('../db/fieldCipher');
const { FhirAdapter } = require('./fhirAdapter');
const { Hl7Inbox } = require('./hl7Inbox');
const { buildMsh, buildPid, buildPv1, adtA01Admit, notHl7AtAll, oruResultNotAdt } = require('./hl7AdtListener.fixtures');

const silent = { log() {}, warn() {}, error() {} };

function setup(options = {}) {
  const db = openDatabase(':memory:');
  const cipher = FieldCipher.ephemeral();
  const fhirAdapter = new FhirAdapter({ db, cipher });
  const inbox = new Hl7Inbox({ db, cipher, fhirAdapter, log: silent, retryIntervalMs: 1000, ...options });
  return { db, cipher, fhirAdapter, inbox };
}

function adt(trigger, controlId, { hospitalNumber = 'H-1', pv1 = { patientClass: 'I', pointOfCare: 'WARD1' } } = {}) {
  return [
    buildMsh({ triggerEvent: trigger, controlId }),
    buildPid({ hospitalNumber, family: 'OKAFOR', given: 'ADAEZE', dob: '19900412', sex: 'F' }),
    ...(pv1 ? [buildPv1(pv1)] : []),
  ].join('\r');
}

test('a processed message is acknowledged AA and stored encrypted, never as plaintext', () => {
  const { db, inbox, fhirAdapter } = setup();
  const out = inbox.receive('hosp', adtA01Admit);
  assert.equal(out.ack, 'AA');
  assert.equal(out.status, 'PROCESSED');
  assert.ok(fhirAdapter.findLocalPatientRecord('hosp', 'LAG-00231'));
  const raw = JSON.stringify(db.prepare('SELECT * FROM hl7_messages').all());
  assert.ok(!raw.includes('OKAFOR'), 'raw HL7 must be encrypted at rest');
});

test('a resend with the same MSH-10 control ID is acknowledged but not applied twice', () => {
  const { inbox, fhirAdapter } = setup();
  const msg = adt('A01', 'CTRL-1');
  assert.equal(inbox.receive('hosp', msg).duplicate, undefined);
  const again = inbox.receive('hosp', msg);
  assert.equal(again.ack, 'AA');
  assert.equal(again.duplicate, true);
  fhirAdapter.registerLocalPatient('hosp', 'did:x', 'H-1');
  assert.equal(fhirAdapter.resolveRecord('hosp', 'did:x').bundles.length, 1);
});

test('the same control ID from two different hospitals is not a duplicate', () => {
  const { inbox } = setup();
  assert.equal(inbox.receive('hosp-a', adt('A01', 'SAME')).status, 'PROCESSED');
  assert.equal(inbox.receive('hosp-b', adt('A01', 'SAME')).status, 'PROCESSED');
});

test('unparseable and non-ADT messages are rejected with AR and kept for investigation', () => {
  const { inbox } = setup();
  assert.equal(inbox.receive('hosp', notHl7AtAll).ack, 'AR');
  assert.equal(inbox.receive('hosp', oruResultNotAdt).ack, 'AR');
  assert.equal(inbox.list({ status: 'REJECTED' }).length, 2);
});

test('A01, A02, A03, A04 and A08 are all ingested; A03 finishes the encounter', () => {
  const { inbox, fhirAdapter } = setup();
  const triggers = ['A01', 'A02', 'A03', 'A04', 'A08'];
  triggers.forEach((t, i) => {
    const pv1 = t === 'A03' ? { patientClass: 'I', dischargeDateTime: '20240120100000' } : { patientClass: t === 'A04' ? 'O' : 'I', pointOfCare: `WARD${i}` };
    assert.equal(inbox.receive('hosp', adt(t, `C-${t}`, { pv1 })).status, 'PROCESSED', t);
  });
  fhirAdapter.registerLocalPatient('hosp', 'did:x', 'H-1');
  const encounters = fhirAdapter.resolveRecord('hosp', 'did:x').bundles.map((b) => b.entry[0].resource);
  assert.equal(encounters.length, 5);
  assert.equal(encounters[2].status, 'finished');
  assert.equal(encounters[3].class.code, 'AMB');
});

test('a processing failure is retried with backoff, then dead-lettered, then replayable once fixed', () => {
  const { inbox, fhirAdapter } = setup({ maxAttempts: 2 });
  const original = fhirAdapter.addLocalPatientRecord.bind(fhirAdapter);
  fhirAdapter.addLocalPatientRecord = () => {
    throw new Error('disk full');
  };

  const first = inbox.receive('hosp', adt('A01', 'R-1'));
  assert.equal(first.ack, 'AA', 'stored durably, so the sender must not resend');
  assert.equal(first.status, 'FAILED');
  assert.equal(inbox.retryDue(new Date()).length, 0, 'backoff not yet elapsed');

  const later = new Date(Date.now() + 60_000);
  const second = inbox.retryDue(later);
  assert.equal(second[0].status, 'DEAD');
  assert.equal(inbox.stats().counts.DEAD, 1);

  fhirAdapter.addLocalPatientRecord = original;
  assert.equal(inbox.replay(first.id).status, 'PROCESSED');
  assert.equal(inbox.stats().counts.DEAD, 0);
  assert.throws(() => inbox.replay(first.id), /already processed/);
});

test('messages left RECEIVED by a crash are processed on recovery', () => {
  const { db, cipher, fhirAdapter } = setup();
  db.prepare(
    `INSERT INTO hl7_messages (id, hospital_id, control_id, message_type, raw_enc, status, attempts, received_at)
     VALUES ('m1', 'hosp', 'X1', 'ADT^A01', ?, 'RECEIVED', 0, ?)`
  ).run(cipher.encrypt(adt('A01', 'X1')), new Date().toISOString());
  const inbox = new Hl7Inbox({ db, cipher, fhirAdapter, log: silent });
  assert.equal(inbox.recover()[0].status, 'PROCESSED');
  assert.ok(fhirAdapter.findLocalPatientRecord('hosp', 'H-1'));
});

test('a hospital-specific fieldMap reads the hospital number from a different field', () => {
  const { inbox, fhirAdapter } = setup({ hospitalOptions: () => ({ fieldMap: { hospitalNumber: 'PID.2.1' } }) });
  const msg = [
    buildMsh({ triggerEvent: 'A04', controlId: 'F-1' }),
    'PID|1|ALT-555|IGNORED-3||BELLO^MUSA||19800101|M',
  ].join('\r');
  assert.equal(inbox.receive('hosp', msg).status, 'PROCESSED');
  assert.equal(fhirAdapter.findLocalPatientRecord('hosp', 'ALT-555').name, 'MUSA BELLO');
  assert.equal(fhirAdapter.findLocalPatientRecord('hosp', 'IGNORED-3'), null);
});

test('an invalid fieldMap is refused', () => {
  const { resolveFieldMap } = require('./hl7AdtListener');
  assert.throws(() => resolveFieldMap({ nope: 'PID.3.1' }), /unknown/);
  assert.throws(() => resolveFieldMap({ hospitalNumber: 'DROP TABLE' }), /invalid/);
});

test('list() and stats() never expose raw message text', () => {
  const { inbox } = setup();
  inbox.receive('hosp', adt('A01', 'L-1'));
  const listed = JSON.stringify(inbox.list());
  assert.ok(!listed.includes('OKAFOR'));
  assert.equal(inbox.stats().counts.PROCESSED, 1);
});
